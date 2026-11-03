import * as https from "node:https";
import type { Config } from "./config.ts";
import { apiKey } from "./config.ts";

export interface ExaResult {
	title?: string;
	url?: string;
	publishedDate?: string;
	author?: string;
	text?: string;
	highlights?: unknown;
}

export interface SearchParams {
	numResults?: number;
	recencyFilter?: string;
	domainFilter?: string[];
	category?: string;
}

let keptAgent: { agent: https.Agent; keepAliveMs: number } | null = null;

/** One module-level agent so every search reuses the same warm sockets. */
function agentFor(keepAliveMs: number): https.Agent {
	if (keptAgent && keptAgent.keepAliveMs === keepAliveMs) return keptAgent.agent;
	const previous = keptAgent?.agent ?? null;
	keptAgent = {
		keepAliveMs,
		agent: new https.Agent({ keepAlive: true, maxSockets: 8, keepAliveMsecs: keepAliveMs }),
	};
	if (previous) {
		// Drain instead of destroy: in-flight requests on the old pool must not be torn down.
		const drain = () => {
			if (Object.values(previous.sockets).every(list => !list || list.length === 0)) previous.destroy();
			else setTimeout(drain, 2000).unref?.();
		};
		drain();
	}
	return keptAgent.agent;
}

interface RawResponse {
	status: number;
	body: string;
}

interface RequestInit {
	method: string;
	headers: Record<string, string>;
	body?: string;
	timeoutMs: number;
	keepAliveMs: number;
	signal?: AbortSignal;
}

function codedError(message: string, code: string): NodeJS.ErrnoException {
	const error = new Error(message) as NodeJS.ErrnoException;
	error.code = code;
	return error;
}

function once(url: string, init: RequestInit): Promise<RawResponse> {
	return new Promise((resolve, reject) => {
		// A listener added to an already-aborted signal never fires, so the request
		// would be sent (and billed) even though the caller cancelled.
		if (init.signal?.aborted) {
			reject(codedError("aborted", "ABORT_ERR"));
			return;
		}

		const target = new URL(url);
		let settled = false;
		let timer: NodeJS.Timeout | undefined;

		const finish = (complete: () => void) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			init.signal?.removeEventListener("abort", onAbort);
			complete();
		};

		const req = https.request(
			{
				method: init.method,
				hostname: target.hostname,
				port: target.port || 443,
				path: target.pathname + target.search,
				headers: init.body === undefined
					? init.headers
					: { ...init.headers, "content-length": String(Buffer.byteLength(init.body)) },
				agent: agentFor(init.keepAliveMs),
				// IPv6 handshakes to this API measured unstable; IPv4 is more predictable.
				family: 4,
			},
			res => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk: Buffer) => chunks.push(chunk));
				res.on("error", err => finish(() => reject(err)));
				res.on("end", () => finish(() => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") })));
			},
		);

		const onAbort = () => finish(() => req.destroy(codedError("aborted", "ABORT_ERR")));

		timer = setTimeout(() => {
			const error = codedError(`request timed out after ${init.timeoutMs}ms`, "ETIMEDOUT");
			finish(() => reject(error));
			req.destroy(error);
		}, init.timeoutMs);

		init.signal?.addEventListener("abort", onAbort, { once: true });
		req.on("error", err => finish(() => reject(err)));
		req.on("close", () => finish(() => reject(new Error("premature close: no response event"))));
		if (init.body !== undefined) req.write(init.body);
		req.end();
	});
}

function retryable(err: unknown): boolean {
	const code = (err as NodeJS.ErrnoException | undefined)?.code ?? "";
	const message = err instanceof Error ? err.message : String(err);
	if (code === "ABORT_ERR" || message === "aborted") return false;
	if (["ECONNRESET", "ETIMEDOUT", "EPIPE", "ECONNREFUSED", "EPROTO", "EAI_AGAIN", "UND_ERR_SOCKET"].includes(code)) return true;
	// "ETIMEDOUT" (the synthetic message) contains "timedout", not "timeout".
	if (/timed out|timedout|timeout|socket hang up|premature close/i.test(message)) return true;
	const status = (err as { status?: unknown } | undefined)?.status;
	return typeof status === "number" && status >= 500 && status !== 501;
}

function recencyToStartDate(filter: string): string | null {
	const days: Record<string, number> = { day: 1, week: 7, month: 30, year: 365 };
	const offset = days[filter];
	return offset ? new Date(Date.now() - offset * 86400000).toISOString() : null;
}

function domainArgs(domainFilter: string[] | undefined): Record<string, string[]> {
	if (!domainFilter?.length) return {};
	const include = domainFilter.filter(d => !d.startsWith("-") && d.trim()).map(d => d.trim());
	const exclude = domainFilter.filter(d => d.startsWith("-")).map(d => d.slice(1).trim()).filter(Boolean);
	return {
		...(include.length ? { includeDomains: include } : {}),
		...(exclude.length ? { excludeDomains: exclude } : {}),
	};
}

function buildArgs(query: string, params: SearchParams, config: Config): Record<string, unknown> {
	const start = params.recencyFilter ? recencyToStartDate(params.recencyFilter) : null;
	return {
		query,
		type: "fast",
		numResults: params.numResults ?? config.numResults,
		...domainArgs(params.domainFilter),
		...(params.category ? { category: params.category } : {}),
		...(start ? { startPublishedDate: start } : {}),
		// Server-side highlight limits are accepted but ignored by the API (measured),
		// so the response size is bounded client-side in render.ts instead.
		contents: { highlights: true },
	};
}

function parseBody(body: string): ExaResult[] {
	const data: unknown = JSON.parse(body);
	const results = (data as { results?: unknown }).results;
	return Array.isArray(results) ? (results as ExaResult[]) : [];
}

export async function searchExa(
	query: string,
	params: SearchParams,
	config: Config,
	signal?: AbortSignal,
): Promise<ExaResult[]> {
	const key = apiKey(config);
	if (!key) throw new Error("No Exa API key: set exaApiKey in ~/.pi/agent/web-search.json or EXA_API_KEY");

	const url = `${config.exaBaseUrl}/search`;
	const body = JSON.stringify(buildArgs(query, params, config));
	const headers = {
		"x-api-key": key,
		"Content-Type": "application/json",
		"x-exa-integration": "pi-web-access-local",
	};

	const attempt = async (): Promise<ExaResult[]> => {
		const response = await once(url, {
			method: "POST",
			headers,
			body,
			timeoutMs: config.timeoutMs,
			keepAliveMs: config.keepAliveMs,
			signal,
		});
		if (response.status < 200 || response.status >= 300) {
			const error = new Error(`Exa API ${response.status}: ${response.body.slice(0, 300)}`) as Error & { status: number };
			error.status = response.status;
			throw error;
		}
		return parseBody(response.body);
	};

	try {
		return await attempt();
	} catch (err) {
		if (signal?.aborted || !retryable(err)) throw err;
		await new Promise(resolve => setTimeout(resolve, 200));
		if (signal?.aborted) throw err;
		return await attempt();
	}
}

/** Fire-and-forget TLS/TCP warmup so the first real search skips the handshake. */
export async function warmup(config: Config): Promise<void> {
	if (!apiKey(config)) return;
	try {
		await once(`${config.exaBaseUrl}/`, {
			method: "HEAD",
			headers: { "x-api-key": apiKey(config) ?? "" },
			timeoutMs: 5000,
			keepAliveMs: config.keepAliveMs,
		});
	} catch {
		// Warmup is best-effort; a failure must not affect the session.
	}
}
