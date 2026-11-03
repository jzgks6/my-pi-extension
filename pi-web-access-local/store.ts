import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { SPILL_DIR } from "./config.ts";

/**
 * Writes the full search payload to disk and returns the path. The tool result keeps only the
 * bounded markdown, so the raw response stays out of the context window.
 */
export function spill(payload: unknown, key: string): string | null {
	try {
		mkdirSync(SPILL_DIR, { recursive: true });
		const id = createHash("sha1").update(key).digest("hex").slice(0, 12);
		const path = join(SPILL_DIR, `${id}.json`);
		// 0600: spill files contain fetched page text and may hold internal or login-gated content.
		writeFileSync(path, JSON.stringify(payload), { mode: 0o600 });
		return path;
	} catch {
		return null;
	}
}

export interface PrunePolicy {
	maxAgeDays: number;
	maxFiles: number;
	maxBytes: number;
}

export interface PruneResult {
	removed: number;
	freedBytes: number;
	kept: number;
	keptBytes: number;
}

let lastPruneRun = 0;
const PRUNE_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Deletes spill files that are too old, then trims the rest by count and total size,
 * oldest first. Runs at most every 10 minutes per process and never throws.
 */
export async function pruneSpill(policy: PrunePolicy, directory: string = SPILL_DIR): Promise<PruneResult> {
	const empty: PruneResult = { removed: 0, freedBytes: 0, kept: 0, keptBytes: 0 };
	const now = Date.now();
	if (now - lastPruneRun < PRUNE_INTERVAL_MS) return empty;

	let names: string[];
	try {
		names = await readdir(directory);
	} catch {
		return empty;
	}
	lastPruneRun = now;

	const files: Array<{ path: string; mtimeMs: number; size: number }> = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const path = join(directory, name);
		try {
			const info = await stat(path);
			if (info.isFile()) files.push({ path, mtimeMs: info.mtimeMs, size: info.size });
		} catch {
			// A file that vanished meanwhile is already gone.
		}
	}
	files.sort((a, b) => a.mtimeMs - b.mtimeMs);

	const cutoff = now - Math.max(0, policy.maxAgeDays) * 86400000;
	const doomed: string[] = [];
	let removed = 0;
	let freedBytes = 0;
	const drop = (file: { path: string; size: number }) => {
		doomed.push(file.path);
		removed += 1;
		freedBytes += file.size;
	};

	const survivors: typeof files = [];
	for (const file of files) {
		if (policy.maxAgeDays > 0 && file.mtimeMs < cutoff) drop(file);
		else survivors.push(file);
	}

	// Keep the newest `maxFiles` entries.
	let kept = survivors;
	if (policy.maxFiles > 0 && survivors.length > policy.maxFiles) {
		const excess = survivors.length - policy.maxFiles;
		for (let i = 0; i < excess; i += 1) drop(survivors[i]);
		kept = survivors.slice(excess);
	}

	// Then the byte cap, oldest first.
	let keptBytes = kept.reduce((sum, file) => sum + file.size, 0);
	if (policy.maxBytes > 0 && keptBytes > policy.maxBytes) {
		let index = 0;
		while (index < kept.length && keptBytes > policy.maxBytes) {
			drop(kept[index]);
			keptBytes -= kept[index].size;
			index += 1;
		}
		kept = kept.slice(index);
	}

	if (doomed.length > 0) {
		await Promise.all(doomed.map(path => unlink(path).catch(() => undefined)));
	}
	return { removed, freedBytes, kept: kept.length, keptBytes };
}
