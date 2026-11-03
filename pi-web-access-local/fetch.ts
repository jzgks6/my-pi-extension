import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import * as tls from "node:tls";
import { fileURLToPath } from "node:url";
import { Agent, fetch as undiciFetch } from "undici";
import type { Config } from "./config.ts";

export interface FetchResult {
	url: string;
	title: string;
	content: string;
	format: "markdown" | "text";
	status: number;
	truncated: boolean;
}

const USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const MIN_USEFUL_CHARS = 200;
const MAX_PDF_PAGES = 300;
const PDF_MAX_IMAGE_PIXELS = 16_777_216;
const ERROR_SAMPLE_BYTES = 4096;

let pool: { agent: Agent; key: string } | null = null;

/** Node's bundled roots; passing `ca` to a TLS agent replaces them, so they must be re-added. */
function defaultRoots(): string[] {
	const store = tls as unknown as { getCACertificates?: (kind?: string) => string[]; rootCertificates?: string[] };
	if (typeof store.getCACertificates === "function") {
		try {
			return store.getCACertificates("default");
		} catch {
			// Fall through to the older API.
		}
	}
	return store.rootCertificates ?? [];
}

/** Extra roots from ca/*.pem plus an optional configured file, so a local TLS proxy is honored. */
function extraRoots(config: Config): string[] {
	const roots: string[] = [];
	const caDir = join(dirname(fileURLToPath(import.meta.url)), "ca");
	try {
		if (existsSync(caDir)) {
			for (const entry of readdirSync(caDir)) {
				if (!entry.endsWith(".pem") && !entry.endsWith(".crt")) continue;
				roots.push(readFileSync(join(caDir, entry), "utf-8"));
			}
		}
	} catch {
		// A broken ca/ directory must not break fetching.
	}
	if (config.fetchCaFile) {
		try {
			roots.push(readFileSync(config.fetchCaFile, "utf-8"));
		} catch {
			// Ignore an unreadable configured CA file.
		}
	}
	return roots;
}

function agentFor(config: Config): Agent {
	const extras = extraRoots(config);
	const roots = [...defaultRoots(), ...extras];
	// Key on content, not length: a rotated certificate of equal length must rebuild the pool.
	const key = `${config.fetchInsecure}|${extras.join("|").length}|${extras.map(root => root.slice(0, 64)).join(",")}`;
	if (!pool || pool.key !== key) {
		void pool?.agent.close().catch(() => undefined);
		pool = {
			key,
			agent: new Agent({
				connections: 8,
				keepAliveTimeout: 30_000,
				keepAliveMaxTimeout: 120_000,
				headersTimeout: config.fetchTimeoutMs,
				bodyTimeout: config.fetchTimeoutMs,
				connect: {
					// Cross-border handshakes that exceed this are almost always blocked, not slow.
					timeout: Math.min(6_000, config.fetchTimeoutMs),
					...(roots.length > 0 ? { ca: roots } : {}),
					...(config.fetchInsecure ? { rejectUnauthorized: false } : {}),
				},
			}),
		};
	}
	return pool.agent;
}

function describeFetchError(err: unknown): string {
	const cause = (err as { cause?: { code?: string; message?: string } } | undefined)?.cause;
	const code = cause?.code ?? cause?.message ?? "";
	if (code === "SELF_SIGNED_CERT_IN_CHAIN" || /self.signed|unable to (get|verify)/i.test(code)) {
		return "TLS chain is signed by a local CA that Node does not trust. Put that CA in the extension's ca/ directory or set local.fetchCaFile.";
	}
	return code ? `${(err as Error).message ?? "fetch failed"} (${code})` : ((err as Error)?.message ?? String(err));
}

function isDefuddleNoise(args: unknown[]): boolean {
	const prefix = args[0];
	return prefix === "Defuddle" || (typeof prefix === "string" && /^Defuddle(?:\s|:)/.test(prefix));
}

async function withDefuddle(html: string, url: string): Promise<{ title: string; content: string } | null> {
	const { Defuddle } = await import("defuddle/node");
	const { parseHTML } = await import("linkedom");
	const { document } = parseHTML(html);
	Object.defineProperty(document, "location", { value: new URL(url), configurable: true });

	// Defuddle reports a processing failure through console.error instead of throwing.
	const original = console.error;
	console.error = (...args: unknown[]) => {
		if (isDefuddleNoise(args)) return;
		original(...(args as Parameters<typeof console.error>));
	};
	let pending: ReturnType<typeof Defuddle>;
	try {
		pending = Defuddle(document as unknown as Document, url, { markdown: true, useAsync: false });
	} finally {
		console.error = original;
	}
	const result = await pending;
	return typeof result?.content === "string" ? { title: result.title ?? "", content: result.content } : null;
}

async function withReadability(html: string): Promise<{ title: string; content: string } | null> {
	const { Readability } = await import("@mozilla/readability");
	const { parseHTML } = await import("linkedom");
	const { document } = parseHTML(html);
	const article = new Readability(document as unknown as Document).parse();
	if (!article?.content) return null;
	const TurndownService = (await import("turndown")).default;
	const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
	return { title: article.title ?? "", content: turndown.turndown(article.content) };
}

/** Reads a response with a hard byte cap, counting decompressed bytes so a gzip bomb is caught. */
async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
	const declared = Number(response.headers.get("content-length") ?? "0");
	if (Number.isFinite(declared) && declared > maxBytes) {
		await response.body?.cancel().catch(() => undefined);
		throw new Error(`response declares ${declared} bytes, over the ${maxBytes}-byte cap`);
	}
	if (!response.body) return new Uint8Array();
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
		total += chunk.byteLength;
		if (total > maxBytes) {
			await response.body.cancel().catch(() => undefined);
			throw new Error(`response exceeded the ${maxBytes}-byte cap; download aborted`);
		}
		chunks.push(Buffer.from(chunk));
	}
	return new Uint8Array(Buffer.concat(chunks));
}

/** `Response.text()` is always UTF-8; Chinese sites still serve GBK, so decode explicitly. */
function decodeBody(bytes: Uint8Array, contentType: string): string {
	const head = Buffer.from(bytes.subarray(0, 2048)).toString("latin1");
	const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
	const fromMeta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
	for (const candidate of [fromHeader, fromMeta, "utf-8"]) {
		if (!candidate) continue;
		try {
			return new TextDecoder(candidate.toLowerCase()).decode(bytes);
		} catch {
			// Unknown label: fall through to the next candidate.
		}
	}
	return Buffer.from(bytes).toString("utf8");
}

async function pdfToText(bytes: Uint8Array): Promise<string> {
	const { extractText, getDocumentProxy } = await import("unpdf");
	const pdf = await getDocumentProxy(bytes, { maxImageSize: PDF_MAX_IMAGE_PIXELS });
	try {
		const pages = (pdf as unknown as { numPages?: number }).numPages ?? 0;
		if (pages > MAX_PDF_PAGES) throw new Error(`PDF has ${pages} pages (limit ${MAX_PDF_PAGES})`);
		const { text } = await extractText(pdf, { mergePages: true });
		return Array.isArray(text) ? text.join("\n\n") : String(text ?? "");
	} finally {
		await (pdf as unknown as { destroy?: () => Promise<void> }).destroy?.().catch(() => undefined);
	}
}

function safeDecode(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

function looksLikeHtml(contentType: string, body: string): boolean {
	if (/html/i.test(contentType)) return true;
	if (contentType && !/^\s*$/.test(contentType)) return false;
	return /^\s*<(!doctype|html)/i.test(body.slice(0, 400));
}

/**
 * Fetches a URL and converts it to markdown locally (Defuddle, then Readability).
 * Runs on the machine, so it reaches pages Exa cannot crawl and keeps heading/code/table structure.
 */
export async function fetchPage(url: string, config: Config, signal?: AbortSignal): Promise<FetchResult> {
	let target: URL;
	try {
		target = new URL(url);
	} catch {
		throw new Error(`Not a valid URL: ${url}`);
	}
	if (target.protocol !== "http:" && target.protocol !== "https:") {
		throw new Error(`Unsupported protocol ${target.protocol} (only http/https)`);
	}

	const timeout = AbortSignal.timeout(config.fetchTimeoutMs);
	let response: Awaited<ReturnType<typeof undiciFetch>>;
	try {
		response = await undiciFetch(target, {
			dispatcher: agentFor(config),
			headers: {
				"user-agent": USER_AGENT,
				accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7",
				"accept-language": "en-US,en;q=0.9,zh-CN;q=0.8",
			},
			redirect: "follow",
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		});
	} catch (err) {
		throw new Error(`${url}: ${describeFetchError(err)}`);
	}

	const contentType = response.headers.get("content-type") ?? "";
	if (!response.ok) {
		const sample = await readCapped(response, ERROR_SAMPLE_BYTES).catch(() => new Uint8Array());
		const text = decodeBody(sample, contentType).slice(0, 160).replace(/\s+/g, " ");
		throw new Error(`HTTP ${response.status} for ${url}${text ? `: ${text}` : ""}`);
	}

	const isPdf = /pdf/i.test(contentType) || /\.pdf$/i.test(target.pathname);
	if (isPdf) {
		const bytes = await readCapped(response, config.fetchMaxPdfBytes);
		const text = await pdfToText(bytes);
		if (!text.trim()) throw new Error(`PDF had no extractable text: ${url}`);
		const content = text.trim();
		const truncated = content.length > config.fetchMaxChars;
		return {
			url: response.url || url,
			title: safeDecode(target.pathname.split("/").pop() ?? ""),
			content: truncated ? content.slice(0, config.fetchMaxChars) : content,
			format: "text",
			status: response.status,
			truncated,
		};
	}

	const bytes = await readCapped(response, config.fetchMaxBytes);
	const body = decodeBody(bytes, contentType);

	if (!looksLikeHtml(contentType, body)) {
		const text = body.trim();
		const truncated = text.length > config.fetchMaxChars;
		return {
			url: response.url || url,
			title: "",
			content: truncated ? text.slice(0, config.fetchMaxChars) : text,
			format: "text",
			status: response.status,
			truncated,
		};
	}

	let extracted = await withDefuddle(body, response.url || url).catch(() => null);
	if (!extracted || extracted.content.trim().length < MIN_USEFUL_CHARS) {
		const fallback = await withReadability(body).catch(() => null);
		if (fallback && fallback.content.trim().length > (extracted?.content.trim().length ?? 0)) extracted = fallback;
	}
	if (!extracted || extracted.content.trim().length === 0) {
		throw new Error(`Could not extract readable content from ${url} (JS-rendered or blocked?)`);
	}

	const content = extracted.content.trim();
	const truncated = content.length > config.fetchMaxChars;
	return {
		url: response.url || url,
		title: extracted.title.trim(),
		content: truncated ? content.slice(0, config.fetchMaxChars) : content,
		format: "markdown",
		status: response.status,
		truncated,
	};
}
