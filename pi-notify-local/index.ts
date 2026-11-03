import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { FocusTracker } from "./focus.js";
import { notify } from "./notifier.js";

/**
 * pi-notify-local — desktop notifications for two events only:
 *
 * 1. the agent is idle and waiting for your input (`agent_settled`),
 * 2. a permission prompt is about to be shown (`permissions:ui_prompt`).
 *
 * Delivery is an OSC 777 escape sequence on stdout, which Ghostty turns into a
 * real notification: no subprocess, no AppleScript, and nothing left behind in
 * Notification Center (Ghostty clears it when the surface regains focus).
 */

// The IDLE notification has no body line, and neither has a permission prompt
// whose payload carries no tool name.
const DEFAULT_INACTIVITY_SECS = 30;

interface NotifyConfig {
  readonly enabled?: boolean;
  /** Unfocused fallback for terminals that do not report focus. */
  readonly unfocusedActivityThresholdSecs?: number;
}

const SETTINGS_PATH = join(getAgentDir(), "settings.json");

function loadConfig(): Required<NotifyConfig> {
  let raw: NotifyConfig = {};
  if (existsSync(SETTINGS_PATH)) {
    try {
      const parsed = JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as {
        piNotify?: NotifyConfig;
      };
      raw = parsed.piNotify ?? {};
    } catch {
      // A malformed settings.json must not break the agent.
    }
  }
  return {
    enabled: raw.enabled ?? true,
    unfocusedActivityThresholdSecs: Math.max(
      0,
      raw.unfocusedActivityThresholdSecs ?? DEFAULT_INACTIVITY_SECS,
    ),
  };
}

/** The tool the prompt is about, e.g. "bash" (the payload's `surface`). */
function permissionBody(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) return "";
  const { surface } = payload as { readonly surface?: unknown };
  return typeof surface === "string" ? surface.trim() : "";
}

export default function piNotifyExtension(pi: ExtensionAPI): void {
  const config = loadConfig();
  const focus = new FocusTracker();
  const thresholdMs = config.unfocusedActivityThresholdSecs * 1000;
  let hasUI = false;

  /**
   * The single notification path. Alerts fire only while the terminal is
   * unfocused: if you are looking at pi you do not need to be told what it is
   * doing, and Ghostty drops anything posted while its surface is focused.
   */
  function post(title: string, body: string): void {
    if (!config.enabled || !hasUI) return;
    if (!focus.isUnfocused(thresholdMs)) return;
    notify(title, body);
  }

  pi.on("session_start", (_event, ctx) => {
    hasUI = ctx.hasUI;
    focus.register(ctx.mode, ctx.ui);
  });

  pi.on("session_shutdown", () => {
    hasUI = false;
    focus.stop();
  });

  // pi will not continue on its own: no retry, no compaction retry, no queued
  // follow-ups left. (`agent_end` fires earlier, per run, and would lie.)
  pi.on("agent_settled", () => {
    post("IDLE", "");
  });

  // Emitted by @gotgenes/pi-permission-system right before its prompt mounts.
  pi.events.on("permissions:ui_prompt", (payload) => {
    post("Needs Approval", permissionBody(payload));
  });
}
