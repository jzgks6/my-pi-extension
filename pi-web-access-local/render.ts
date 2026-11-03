import type { ExaResult } from "./exa.ts";

export interface RenderOptions {
	/** Per-result cap, measured in UTF-8 bytes (a CJK char counts 3, an ASCII char 1). */
	perResultChars: number;
	dedupeUrls: boolean;
	/** URLs whose text was delivered in an earlier tool call of this session. */
	earlierUrls: Set<string>;
	/** Hard cap for the whole tool result; 0 disables it. */
	maxTotalBytes?: number;
}

export interface RenderResult {
	text: string;
	/** URLs whose text appears in `text` and should be marked as delivered. */
	delivered: string[];
	omitted: number;
	bytes: number;
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

function tidy(text: string): string {
	return text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function bodyOf(item: ExaResult): string {
	const highlights = Array.isArray(item.highlights)
		? (item.highlights.filter(entry => typeof entry === "string" && entry.trim().length > 0) as string[])
		: [];
	const raw = highlights.length > 0 ? highlights.join(" ") : typeof item.text === "string" ? item.text : "";
	// Highlights are sentences; a full page text can be megabytes, so trim before the regexes.
	return tidy(raw.length > 8192 ? raw.slice(0, 8192) : raw);
}

/** Cuts to a UTF-8 byte budget without splitting a surrogate pair. */
const ELLIPSIS = " …";

function truncate(text: string, maxBytes: number): string {
	if (byteLength(text) <= maxBytes) return text;
	// Reserve room for the ellipsis so the result never exceeds the budget.
	const target = Math.max(0, maxBytes - byteLength(ELLIPSIS));
	let low = 0;
	let high = text.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (byteLength(text.slice(0, mid)) <= target) low = mid;
		else high = mid - 1;
	}
	return `${text.slice(0, low).trimEnd()}${ELLIPSIS}`;
}

function shortHost(url: string): string {
	try {
		return new URL(url).hostname;
	} catch {
		return "source";
	}
}

export interface QueryEntry {
	query: string;
	results: ExaResult[];
	error?: string;
}

function blockFor(index: number, item: ExaResult, repeated: boolean, options: RenderOptions): string {
	const title = item.title?.trim() || shortHost(item.url ?? "");
	const meta = typeof item.publishedDate === "string" && item.publishedDate.trim()
		? `\nPublished: ${item.publishedDate.slice(0, 10)}`
		: "";
	const head = `## ${index}. ${title}\nURL: ${item.url}${meta}`;
	if (repeated) {
		// The body was delivered before, but compaction may have dropped it, so point at the
		// recoverable copy instead of silently pretending the text is in context.
		return `${head}\n(shown earlier in this session; re-fetch with fetch_content only if you no longer have it)`;
	}
	const body = truncate(bodyOf(item), options.perResultChars);
	return body ? `${head}\n${body}` : head;
}

/**
 * Renders all queries under one byte budget.
 * Deduplication only suppresses text delivered in an *earlier* call: within a single call
 * each query keeps its own excerpts, and a query whose every URL was seen before is rendered
 * in full rather than reduced to a list of markers.
 */
export function renderAll(entries: QueryEntry[], options: RenderOptions): RenderResult {
	const maxBytes = options.maxTotalBytes ?? 0;
	// Reserve room for the trailing "omitted" note so the result never exceeds the budget.
	const limit = maxBytes > 0 ? Math.max(0, maxBytes - 160) : 0;
	const parts: string[] = [];
	const delivered: string[] = [];
	let used = 0;
	let omitted = 0;

	const push = (text: string): boolean => {
		const cost = byteLength(text) + 2;
		if (limit > 0 && used + cost > limit) return false;
		parts.push(text);
		used += cost;
		return true;
	};

	for (const entry of entries) {
		if (entry.error) {
			push(`### Query: ${entry.query}\nError: ${entry.error}`);
			continue;
		}
		const usable = entry.results.filter(item => item?.url);
		if (usable.length === 0) {
			push(`### Query: ${entry.query}\n(no results)`);
			continue;
		}
		const freshCount = usable.filter(item => !options.earlierUrls.has(item.url as string)).length;
		const rescue = options.dedupeUrls && freshCount === 0;

		push(`### Query: ${entry.query}`);

		let index = 0;
		for (const item of usable) {
			index += 1;
			const url = item.url as string;
			const repeated = options.dedupeUrls && !rescue && options.earlierUrls.has(url);
			const block = blockFor(index, item, repeated, options);
			if (!push(block)) {
				omitted += 1;
				continue;
			}
			if (!repeated) delivered.push(url);
		}
	}

	if (omitted > 0) {
		parts.push(`_(${omitted} more result(s) omitted to stay within the ${maxBytes}-byte result budget; the full JSON is in the spill file listed below.)_`);
	}

	const text = parts.filter(part => part.length > 0).join("\n\n");
	return { text, delivered, omitted, bytes: byteLength(text) };
}
