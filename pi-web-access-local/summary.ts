import type { Config } from "./config.ts";

interface StreamLike {
	result?: () => Promise<unknown>;
}

interface ModelRegistryLike {
	streamSimple?: (model: unknown, context: unknown, options: unknown) => StreamLike | Promise<unknown>;
	complete?: (model: unknown, context: unknown, options: unknown) => Promise<unknown>;
	find?: (provider: string, id: string) => unknown;
}

export interface SummaryContextLike {
	model?: unknown;
	modelRegistry?: ModelRegistryLike;
	sessionManager?: { getSessionId?: () => string };
}

export type SummaryOutcome =
	| { ok: true; text: string; model: string; attempts: number }
	| { ok: false; reason: string; attempts: number };

interface Attempt {
	maxTokens: number;
	label: string;
}

function buildPrompt(resultsText: string): string {
	return [
		"Summarize these web search results for a coding assistant. Use only what is below; never invent sources or claims.",
		"",
		"Hard limits on your reply:",
		"- At most 100 words total, at most 4 bullets.",
		"- No preamble, no restating the question, no headings like \"Summary\".",
		"- Quote at most 10 words verbatim.",
		"- Last line must be: Sources: <up to 3 bare URLs>",
		"- If the evidence is weak or conflicting, say so inside the last bullet.",
		"",
		"<search_results>",
		resultsText,
		"</search_results>",
	].join("\n");
}

function textOf(response: unknown): string {
	const content = (response as { content?: unknown } | null)?.content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: string; text: string } =>
			typeof (part as { type?: unknown })?.type === "string" && typeof (part as { text?: unknown })?.text === "string",
		)
		.filter(part => part.type === "text")
		.map(part => part.text)
		.join("\n")
		.trim();
}

function partKinds(response: unknown): string {
	const content = (response as { content?: unknown } | null)?.content;
	if (!Array.isArray(content)) return "none";
	return content.map(part => (typeof (part as { type?: unknown })?.type === "string" ? (part as { type: string }).type : "?")).join(", ") || "none";
}

function outputTokens(response: unknown): number | null {
	const usage = (response as { usage?: { outputTokens?: unknown; output_tokens?: unknown } } | null)?.usage;
	const value = usage?.outputTokens ?? usage?.output_tokens;
	return typeof value === "number" ? value : null;
}

function labelOf(model: unknown): string {
	const record = model as { provider?: unknown; id?: unknown } | null;
	if (typeof record?.provider === "string" && typeof record?.id === "string") return `${record.provider}/${record.id}`;
	return "session model";
}

function reasonOf(err: unknown): string {
	const message = err instanceof Error ? err.message : String(err);
	if (/\babort/i.test(message)) return "aborted";
	if (/timeout|timed out/i.test(message)) return "timed out";
	return message.slice(0, 200);
}

/**
 * The summarizer model is always the configured one, never the session model:
 * a thinking model as the main model would otherwise silently degrade every summary.
 */
function pickModel(ctx: SummaryContextLike, config: Config): { model?: unknown; label?: string; reason?: string } {
	const spec = config.summaryModel?.trim();
	if (!spec) return { reason: "local.summaryModel is not configured in pi-web-access-local/config.json" };
	const slash = spec.indexOf("/");
	if (slash <= 0) return { reason: `local.summaryModel "${spec}" must be "provider/modelId"` };
	const registry = ctx.modelRegistry;
	if (!registry?.find) return { reason: "ctx.modelRegistry.find is unavailable in this pi build" };

	const provider = spec.slice(0, slash);
	const id = spec.slice(slash + 1);
	try {
		const found = registry.find(provider, id);
		if (found) return { model: found, label: `${labelOf(found)} (configured)` };
	} catch (err) {
		return { reason: `local.summaryModel "${spec}" lookup failed: ${reasonOf(err)}` };
	}
	return { reason: `local.summaryModel "${spec}" was not found in the registry` };
}

/** Summarizes the rendered results with the session model. Every failure is reported, never swallowed. */
export async function summarize(
	resultsText: string,
	ctx: SummaryContextLike | undefined,
	config: Config,
	signal?: AbortSignal,
): Promise<SummaryOutcome> {
	if (!ctx) return { ok: false, reason: "no extension context", attempts: 0 };
	const registry = ctx.modelRegistry;
	if (!registry) return { ok: false, reason: "ctx.modelRegistry missing", attempts: 0 };
	const picked = pickModel(ctx, config);
	if (!picked.model || !picked.label) return { ok: false, reason: picked.reason ?? "no summary model", attempts: 0 };
	const model = picked.model;

	const input = resultsText.length > config.summaryMaxChars
		? `${resultsText.slice(0, config.summaryMaxChars)}\n\n[truncated]`
		: resultsText;
	const userMessage = {
		role: "user" as const,
		content: [{ type: "text" as const, text: buildPrompt(input) }],
		timestamp: Date.now(),
	};
	// The budget is split, not shared: a single 20s deadline meant a slow primary
	// left the retry with an already-aborted signal, so it never even sent.
	const deadline = Date.now() + config.summaryTimeoutMs;
	const budgetFor = (index: number): number => {
		const remaining = deadline - Date.now();
		if (index === 0) return Math.max(800, Math.round(remaining * 0.6));
		return Math.max(300, remaining);
	};
	const sessionId = (() => {
		try {
			return ctx.sessionManager?.getSessionId?.();
		} catch {
			return undefined;
		}
	})();
	const modelLabel = picked.label;

	// A thinking model can spend the whole budget on reasoning and emit no text part,
	// so the first attempt stays small and a second one gets room for thinking + answer.
	const attempts: Attempt[] = [
		{ maxTokens: config.summaryMaxTokens, label: "primary" },
		{ maxTokens: Math.max(config.summaryMaxTokens * 4, 8000), label: "retry with a larger token budget" },
	];

	const failures: string[] = [];
	let index = 0;

	for (const attempt of attempts) {
		index += 1;
		if (signal?.aborted) {
			failures.push("caller aborted");
			break;
		}
		const remaining = deadline - Date.now();
		if (remaining <= 300) {
			failures.push(`${attempt.label}: skipped, no time left in the ${config.summaryTimeoutMs}ms budget`);
			break;
		}
		const budget = budgetFor(index - 1);
		const attemptTimeout = AbortSignal.timeout(budget);
		const attemptSignal = signal ? AbortSignal.any([signal, attemptTimeout]) : attemptTimeout;
		const options = {
			cacheRetention: "none" as const,
			reasoning: "off" as const,
			maxTokens: attempt.maxTokens,
			signal: attemptSignal,
			...(sessionId ? { sessionId } : {}),
		};

		try {
			let response: unknown;
			if (typeof registry.streamSimple === "function") {
				const stream = registry.streamSimple(model, { messages: [userMessage] }, options);
				const settled = await stream;
				response = typeof (settled as StreamLike)?.result === "function"
					? await (settled as StreamLike).result!()
					: settled;
			} else if (typeof registry.complete === "function") {
				response = await registry.complete(model, { messages: [userMessage] }, options);
			} else {
				return { ok: false, reason: "modelRegistry has neither streamSimple nor complete", attempts: index };
			}

			const stopReason = (response as { stopReason?: unknown } | null)?.stopReason;
			if (stopReason === "error") {
				// Provider failures resolve as an error message, not a rejection.
				const raw = (response as { errorMessage?: unknown } | null)?.errorMessage;
				const detail = typeof raw === "string" && raw.trim() ? raw.trim().slice(0, 200) : "provider error (no message)";
				failures.push(`${attempt.label}: ${detail}`);
				if (/auth|unauthor|not configured|401|403|404|unknown provider|invalid (api )?key|does not exist/i.test(detail)) break;
				continue;
			}
			if (stopReason === "aborted") {
				failures.push(`${attempt.label}: aborted after ${budget}ms`);
				continue;
			}

			const text = textOf(response);
			if (text) return { ok: true, text, model: modelLabel, attempts: index };

			const kinds = partKinds(response);
			const used = outputTokens(response);
			const usage = used === null ? "" : `, ${used}/${attempt.maxTokens} output tokens`;
			failures.push(`${attempt.label}: no text (parts: ${kinds}${usage})`);
		} catch (err) {
			const why = reasonOf(err);
			failures.push(`${attempt.label}: ${why === "aborted" || why === "timed out" ? `${why} after ${budget}ms` : why}`);
		}
	}

	return { ok: false, reason: `${failures.join("; ")} (model: ${modelLabel})`, attempts: index };
}
