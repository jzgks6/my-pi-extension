import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const CONFIG_PATH = join(homedir(), ".pi", "agent", "web-search.json");
/** Extension-local overrides; keeps this tool's settings out of pi-web-access's config file. */
export const LOCAL_CONFIG_PATH = join(dirname(fileURLToPath(import.meta.url)), "config.json");
export const SPILL_DIR = join(tmpdir(), "pi-web-access-cache");

export type Workflow = "none" | "auto-summary";

export interface Config {
	exaApiKey: string | undefined;
	exaBaseUrl: string;
	numResults: number;
	perResultChars: number;
	dedupeUrls: boolean;
	timeoutMs: number;
	keepAliveMs: number;
	warmup: boolean;
	defaultWorkflow: Workflow;
	spillFull: boolean;
	spillMaxAgeDays: number;
	spillMaxFiles: number;
	spillMaxBytes: number;
	summaryTimeoutMs: number;
	summaryMaxChars: number;
	summaryMaxTokens: number;
	summaryModel: string | undefined;
	maxTotalChars: number;
	fetchMaxChars: number;
	fetchMaxBytes: number;
	fetchMaxPdfBytes: number;
	fetchTimeoutMs: number;
	fetchCaFile: string | undefined;
	fetchInsecure: boolean;
}

const DEFAULTS = {
	numResults: 5,
	perResultChars: 1200,
	dedupeUrls: true,
	timeoutMs: 8000,
	keepAliveMs: 60000,
	warmup: true,
	spillFull: true,
	spillMaxAgeDays: 7,
	spillMaxFiles: 200,
	spillMaxBytes: 200 << 20,
	summaryTimeoutMs: 20000,
	summaryMaxChars: 8000,
	summaryMaxTokens: 2000,
	maxTotalChars: 8000,
	fetchMaxChars: 20000,
	fetchMaxBytes: 8 << 20,
	fetchMaxPdfBytes: 24 << 20,
	fetchTimeoutMs: 20000,
} as const;

let cached: { key: string; value: Config } | null = null;

function num(value: unknown, fallback: number, min = 1): number {
	return typeof value === "number" && Number.isFinite(value) && value >= min ? value : fallback;
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readObject(path: string): Record<string, unknown> {
	if (!existsSync(path)) return {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

function mtimeOf(path: string): number {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return 0;
	}
}

/**
 * Settings come from three layers: built-in defaults, then the `local` block of
 * ~/.pi/agent/web-search.json, then this extension's own config.json (highest priority).
 * Both files are re-parsed when their mtime changes, so /reload is not needed for tweaks.
 */
export function loadConfig(): Config {
	const key = `${mtimeOf(CONFIG_PATH)}|${mtimeOf(LOCAL_CONFIG_PATH)}`;
	if (cached && cached.key === key) return cached.value;

	const shared = readObject(CONFIG_PATH);
	const sharedLocal = shared.local && typeof shared.local === "object" ? (shared.local as Record<string, unknown>) : {};
	const local: Record<string, unknown> = { ...sharedLocal, ...readObject(LOCAL_CONFIG_PATH) };
	const workflow = str(local.defaultWorkflow);

	const value: Config = {
		// Local config first, then the legacy pi-web-access file, then EXA_API_KEY.
		exaApiKey: str(local.exaApiKey) ?? str(shared.exaApiKey),
		exaBaseUrl: (str(local.exaBaseUrl) ?? str(shared.exaBaseUrl) ?? "https://api.exa.ai").replace(/\/+$/, ""),
		// The tool schema caps numResults at 20, but config.json is not schema-checked.
		numResults: Math.min(num(local.numResults, DEFAULTS.numResults), 20),
		perResultChars: Math.min(num(local.perResultChars, DEFAULTS.perResultChars, 200), 4000),
		dedupeUrls: typeof local.dedupeUrls === "boolean" ? local.dedupeUrls : DEFAULTS.dedupeUrls,
		timeoutMs: num(local.timeoutMs, DEFAULTS.timeoutMs, 1000),
		keepAliveMs: num(local.keepAliveMs, DEFAULTS.keepAliveMs, 1000),
		warmup: typeof local.warmup === "boolean" ? local.warmup : DEFAULTS.warmup,
		defaultWorkflow: workflow === "auto-summary" ? "auto-summary" : "none",
		spillFull: typeof local.spillFull === "boolean" ? local.spillFull : DEFAULTS.spillFull,
		spillMaxAgeDays: num(local.spillMaxAgeDays, DEFAULTS.spillMaxAgeDays, 0),
		spillMaxFiles: num(local.spillMaxFiles, DEFAULTS.spillMaxFiles, 0),
		spillMaxBytes: num(local.spillMaxBytes, DEFAULTS.spillMaxBytes, 0),
		summaryTimeoutMs: num(local.summaryTimeoutMs, DEFAULTS.summaryTimeoutMs, 1000),
		summaryMaxChars: num(local.summaryMaxChars, DEFAULTS.summaryMaxChars, 1000),
		summaryMaxTokens: num(local.summaryMaxTokens, DEFAULTS.summaryMaxTokens, 64),
		summaryModel: str(local.summaryModel),
		maxTotalChars: num(local.maxTotalChars, DEFAULTS.maxTotalChars, 1000),
		fetchMaxChars: num(local.fetchMaxChars, DEFAULTS.fetchMaxChars, 500),
		fetchMaxBytes: num(local.fetchMaxBytes, DEFAULTS.fetchMaxBytes, 64 * 1024),
		fetchMaxPdfBytes: num(local.fetchMaxPdfBytes, DEFAULTS.fetchMaxPdfBytes, 256 * 1024),
		fetchTimeoutMs: num(local.fetchTimeoutMs, DEFAULTS.fetchTimeoutMs, 1000),
		fetchCaFile: str(local.fetchCaFile),
		fetchInsecure: local.fetchInsecure === true,
	};

	cached = { key, value };
	return value;
}

export function apiKey(config: Config): string | null {
	return config.exaApiKey ?? str(process.env.EXA_API_KEY) ?? null;
}
