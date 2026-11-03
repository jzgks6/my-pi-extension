import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { apiKey, loadConfig, type Config, type Workflow } from "./config.ts";
import { searchExa, warmup, type SearchParams } from "./exa.ts";
import { fetchPage } from "./fetch.ts";
import { renderAll, type QueryEntry } from "./render.ts";
import { pruneSpill, spill } from "./store.ts";
import { summarize } from "./summary.ts";

/**
 * Tool names match the npm pi-web-access package, so prompts and codemode scripts keep working.
 * Do not load both extensions at once: nothing defines which same-named tool wins.
 */
const TOOL_PREFIX = "";
const MAX_CONCURRENCY = 3;

interface Timings {
	query: string;
	ms: number;
	results: number;
	error?: string;
}

function normalizeQueries(params: Record<string, unknown>): string[] {
	const list: string[] = [];
	if (Array.isArray(params.queries)) {
		for (const value of params.queries) {
			if (typeof value === "string" && value.trim()) list.push(value.trim());
		}
	}
	if (typeof params.query === "string" && params.query.trim()) list.push(params.query.trim());
	return [...new Set(list)];
}

function searchDetails(config: Config, extra: Record<string, unknown> = {}) {
	return {
		queries: [],
		totalMs: 0,
		workflow: config.defaultWorkflow,
		summaryModel: null,
		summaryError: null,
		summaryMs: null,
		perResultChars: config.perResultChars,
		maxTotalChars: config.maxTotalChars,
		spilled: [],
		...extra,
	};
}

export default function (pi: ExtensionAPI) {
	/** URLs whose body reached the model in an earlier call of this session. */
	const deliveredEarlier = new Set<string>();
	const resetDedup = () => deliveredEarlier.clear();

	pi.on("session_start", async () => {
		resetDedup();
		const config = loadConfig();
		if (config.warmup) void warmup(config);
		// Spill files never used to be cleaned up; trim them once per session.
		if (config.spillFull) {
			void pruneSpill({
				maxAgeDays: config.spillMaxAgeDays,
				maxFiles: config.spillMaxFiles,
				maxBytes: config.spillMaxBytes,
			}).catch(() => undefined);
		}
	});
	// Compaction or a branch switch removes that text from the context, so the URL is
	// no longer "already shown" as far as the model can tell.
	pi.on("session_compact", async () => resetDedup());
	pi.on("session_tree", async () => resetDedup());

	const searchError = (config: Config, text: string) => ({
		content: [{ type: "text" as const, text }],
		isError: true,
		details: searchDetails(config),
	});

	pi.registerTool({
		name: `${TOOL_PREFIX}web_search`,
		label: "Web Search (local)",
		promptSnippet: "Search the web through Exa (fast tier); 2-4 varied queries per call.",
		description:
			"Search the web for sources or answers. Prefer queries:[...] with 2-4 varied angles. " +
			"Each result is trimmed to a short excerpt; the full JSON response path is reported in details. " +
			"workflow auto-summary condenses the results with the configured summary model.",
		parameters: Type.Object({
			query: Type.Optional(Type.String()),
			queries: Type.Optional(
				Type.Array(Type.String(), { description: "Run concurrently (up to 3 at a time)", maxItems: 6 }),
			),
			numResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Default 5" })),
			recencyFilter: Type.Optional(
				Type.Union([Type.Literal("day"), Type.Literal("week"), Type.Literal("month"), Type.Literal("year")]),
			),
			domainFilter: Type.Optional(Type.Array(Type.String(), { description: "Prefix - to exclude" })),
			category: Type.Optional(Type.String({ description: "Exa category, e.g. news" })),
			workflow: Type.Optional(
				Type.Union([Type.Literal("none"), Type.Literal("auto-summary")], {
					description: "none returns raw excerpts; auto-summary condenses them with the configured model",
				}),
			),
		}),

		async execute(_callId: string, params: any, signal?: AbortSignal, _onUpdate?: any, ctx?: any) {
			const config = loadConfig();
			const queries = normalizeQueries(params);
			if (queries.length === 0) return searchError(config, "Error: provide 'query' or 'queries'.");
			if (!apiKey(config)) {
				return searchError(config, "Error: no Exa API key. Set exaApiKey in ~/.pi/agent/web-search.json or EXA_API_KEY.");
			}

			const searchParams: SearchParams = {
				numResults: typeof params.numResults === "number" ? params.numResults : undefined,
				recencyFilter: typeof params.recencyFilter === "string" ? params.recencyFilter : undefined,
				domainFilter: Array.isArray(params.domainFilter)
					? params.domainFilter.filter((entry: unknown) => typeof entry === "string")
					: undefined,
				category: typeof params.category === "string" ? params.category : undefined,
			};

			const startedAt = Date.now();
			const entries: QueryEntry[] = new Array(queries.length);
			const timings: Timings[] = new Array(queries.length);
			const spilled: string[] = [];
			let next = 0;

			const runOne = async (index: number) => {
				const query = queries[index];
				const queryStarted = Date.now();
				try {
					const results = await searchExa(query, searchParams, config, signal);
					entries[index] = { query, results };
					timings[index] = { query, ms: Date.now() - queryStarted, results: results.length };
					if (config.spillFull) {
						const path = spill(
							{ query, params: searchParams, fetchedAt: new Date().toISOString(), results },
							`${query}|${JSON.stringify(searchParams)}|${queryStarted}`,
						);
						if (path) spilled.push(path);
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					if (signal?.aborted) throw err;
					entries[index] = { query, results: [], error: message };
					timings[index] = { query, ms: Date.now() - queryStarted, results: 0, error: message };
				}
			};

			const workers = Array.from({ length: Math.min(MAX_CONCURRENCY, queries.length) }, async () => {
				while (true) {
					const index = next;
					next += 1;
					if (index >= queries.length) return;
					await runOne(index);
				}
			});
			await Promise.all(workers);

			const totalMs = Date.now() - startedAt;
			const rendered = renderAll(entries, {
				perResultChars: config.perResultChars,
				dedupeUrls: config.dedupeUrls,
				earlierUrls: deliveredEarlier,
				maxTotalBytes: config.maxTotalChars,
			});

			const requested = params.workflow === "none" || params.workflow === "auto-summary"
				? (params.workflow as Workflow)
				: config.defaultWorkflow;

			let text = rendered.text;
			let summaryModel: string | null = null;
			let summaryError: string | null = null;
			let summaryMs: number | null = null;

			if (requested === "auto-summary" && !entries.every(entry => entry.error)) {
				// The summary model needs less text than the reader: 800 bytes per result keeps
				// prefill small, and this render uses its own dedup state.
				const summaryInput = renderAll(entries, {
					perResultChars: Math.min(config.perResultChars, 800),
					dedupeUrls: config.dedupeUrls,
					earlierUrls: new Set<string>(),
					maxTotalBytes: config.summaryMaxChars,
				});
				const summaryStarted = Date.now();
				const outcome = await summarize(summaryInput.text, ctx, config, signal).catch((err: unknown) => ({
					ok: false as const,
					reason: err instanceof Error ? err.message : String(err),
					attempts: 0,
				}));
				summaryMs = Date.now() - summaryStarted;
				if (outcome.ok) {
					summaryModel = outcome.model;
					text = `${outcome.text}\n\n_Raw excerpts omitted; summarized by ${outcome.model}._`;
					// The raw excerpts never reached the model, so nothing is marked as delivered.
				} else {
					summaryError = outcome.reason;
					text = `${rendered.text}\n\n_auto-summary failed: ${outcome.reason}. Raw excerpts shown._`;
					for (const url of rendered.delivered) deliveredEarlier.add(url);
				}
			} else {
				for (const url of rendered.delivered) deliveredEarlier.add(url);
			}

			if (spilled.length > 0) {
				text = `${text}\n\nFull result JSON: ${spilled.join(", ")}`;
			}

			return {
				content: [{ type: "text" as const, text }],
				isError: entries.every(entry => entry.error !== undefined),
				details: searchDetails(config, {
					queries: timings,
					totalMs,
					workflow: requested,
					summaryModel,
					summaryError,
					summaryMs,
					spilled,
					omitted: rendered.omitted,
					resultBytes: rendered.bytes,
					dedupedUrls: rendered.delivered.length === 0 ? deliveredEarlier.size : 0,
				}),
			};
		},
	});

	pi.registerTool({
		name: `${TOOL_PREFIX}fetch_content`,
		label: "Fetch Content (local)",
		promptSnippet: "Fetch URLs and convert them to markdown on this machine (no JavaScript rendering).",
		description:
			"Fetch URLs and convert them to markdown on this machine (Defuddle, then Readability). " +
			"Unlike a hosted extractor this reaches intranet or login-gated pages, but cannot render JavaScript.",
		parameters: Type.Object({
			url: Type.Optional(Type.String()),
			urls: Type.Optional(Type.Array(Type.String(), { description: "Up to 5 URLs, fetched 3 at a time", maxItems: 5 })),
			maxChars: Type.Optional(Type.Integer({ minimum: 500, description: "Per-page cap; default 20000" })),
		}),

		async execute(_callId: string, params: any, signal?: AbortSignal) {
			const config = loadConfig();
			const requested: string[] = [];
			if (typeof params.url === "string" && params.url.trim()) requested.push(params.url.trim());
			if (Array.isArray(params.urls)) {
				for (const value of params.urls) if (typeof value === "string" && value.trim()) requested.push(value.trim());
			}
			const urls = [...new Set(requested)].slice(0, 5);
			const details = { fetches: [] as Array<{ url: string; ms: number; chars?: number; error?: string }>, spilled: [] as string[], maxChars: 0 };
			if (urls.length === 0) {
				return { content: [{ type: "text" as const, text: "Error: provide 'url' or 'urls'." }], isError: true, details };
			}

			const cap = typeof params.maxChars === "number" ? params.maxChars : config.fetchMaxChars;
			details.maxChars = cap;
			const blocks: string[] = new Array(urls.length);
			const timings = details.fetches;
			timings.length = urls.length;
			let next = 0;

			const worker = async () => {
				while (true) {
					const index = next;
					next += 1;
					if (index >= urls.length) return;
					const url = urls[index];
					const startedAt = Date.now();
					try {
						const page = await fetchPage(url, config, signal);
						const body = page.content.length > cap ? page.content.slice(0, cap) : page.content;
						const cut = body.length < page.content.length;
						blocks[index] = `### ${page.title || page.url}\nURL: ${url}${page.title ? `\nCanonical: ${page.url}` : ""}\n\n${body}`;
						timings[index] = { url, ms: Date.now() - startedAt, chars: page.content.length };
						if (cut && config.spillFull) {
							const path = spill({ url, title: page.title, format: page.format, content: page.content }, `${url}|${startedAt}`);
							if (path) {
								details.spilled.push(path);
								blocks[index] += `\n\n_(truncated at ${body.length} of ${page.content.length} chars; full text: ${path})_`;
							}
						}
					} catch (err) {
						const message = err instanceof Error ? err.message : String(err);
						if (signal?.aborted) throw err;
						blocks[index] = `### ${url}\nError: ${message}`;
						timings[index] = { url, ms: Date.now() - startedAt, error: message };
					}
				}
			};
			await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENCY, urls.length) }, worker));

			return {
				content: [{ type: "text" as const, text: blocks.join("\n\n") }],
				isError: timings.every(entry => entry?.error !== undefined),
				details,
			};
		},
	});
}
