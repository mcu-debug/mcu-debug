// Telemetry core — deliberately free of any `vscode` import so it can be shared by both the
// VS Code extension and the command-line tool. The extension side (reporting.ts) sends events
// to PostHog; the CLI side (telemetry-cli.ts) parks them in ~/.mcu-debug/telemetry.json for the
// extension to flush later. Everything here must degrade to a no-op rather than ever throwing —
// telemetry must never disrupt debugging.

import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { ConfigurationArguments } from "../adapter/servers/common";

// ---------------------------------------------------------------------------
// PostHog project configuration
//
// POSTHOG_API_KEY is a PostHog *project API key* (starts with `phc_`). It is a public,
// write-only ingestion key that is meant to ship in client code — it cannot read any data
// back out, so committing it is expected and safe. Find it in PostHog under
// Settings -> Project -> "Project API Key". Either paste it below or set MCU_DEBUG_POSTHOG_KEY.
// ---------------------------------------------------------------------------
export const POSTHOG_API_KEY = process.env.MCU_DEBUG_POSTHOG_KEY || "phc_knho3tncgpr5S5sSqzpJ9znjq9wfdJPwG9GbLUHnofX2";
// Optional separate key for development builds (a PostHog "environment"). Leave empty until you
// create one; when empty, dev builds fall back to the main key and are still distinguishable via
// the `environment` property the extension attaches.
export const POSTHOG_API_KEY_DEV = process.env.MCU_DEBUG_POSTHOG_KEY_DEV || "";
// US cloud: https://us.i.posthog.com   EU cloud: https://eu.i.posthog.com
export const POSTHOG_HOST = process.env.MCU_DEBUG_POSTHOG_HOST || "https://us.i.posthog.com";

/** Pick the ingestion key: the dev key in development builds when one is configured, else prod. */
export function resolvePostHogKey(isDev: boolean): string {
    return isDev && POSTHOG_API_KEY_DEV ? POSTHOG_API_KEY_DEV : POSTHOG_API_KEY;
}

// The CLI has no vscode.ExtensionMode, so main.ts sets this env var when it detects a dev checkout
// (isDevVersion()). Telemetry reads it to tag CLI events `development`, kept apart from the
// extension's own dev detection so each side is the authority on its own runs.
export const CLI_DEV_ENV = "MCU_DEBUG_DEV";
export function cliIsDev(): boolean {
    return process.env[CLI_DEV_ENV] === "1";
}

export interface TelemetryEvent {
    event: string;
    distinctId: string;
    timestamp: string; // ISO 8601
    properties: Record<string, any>;
}

function keyLooksConfigured(key: string): boolean {
    return /^phc_/.test(key) && !key.includes("REPLACE_WITH");
}

/** POST a batch of events to PostHog. Never throws; silently drops on any failure. */
export async function postEventsToPostHog(events: TelemetryEvent[], apiKey: string = POSTHOG_API_KEY): Promise<void> {
    if (!events.length || !keyLooksConfigured(apiKey) || typeof fetch !== "function") {
        return;
    }
    const body = {
        api_key: apiKey,
        batch: events.map((e) => ({
            event: e.event,
            distinct_id: e.distinctId,
            timestamp: e.timestamp,
            properties: { ...e.properties, $lib: "mcu-debug" },
        })),
    };
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        await fetch(`${POSTHOG_HOST.replace(/\/+$/, "")}/batch/`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            signal: controller.signal,
        }).finally(() => clearTimeout(timer));
    } catch {
        // Telemetry is best-effort. Drop the batch on network error, timeout, etc.
    }
}

// ---------------------------------------------------------------------------
// Launch origin — how the session was started.
//
// All CLI paths converge on the same main.ts/cli-driver.ts, so the launcher that spawns the CLI
// stamps this (private, undocumented) env var; an unstamped process is a plain terminal. Values
// are validated against a fixed allow-list so a stray or user-set value never lands in telemetry
// as free text. The Rust TUI (spawn.rs) and the VS Code cockpit (ai-cockpit.ts) set it.
// ---------------------------------------------------------------------------
export const LAUNCH_ORIGIN_ENV = "MCU_DEBUG_LAUNCH_ORIGIN";
const KNOWN_CLI_ORIGINS = new Set(["tui", "headless", "vscode-panel"]);

/** The CLI's launch origin, defaulting to "terminal" when unstamped or unrecognized. */
export function resolveLaunchOrigin(): string {
    const v = process.env[LAUNCH_ORIGIN_ENV];
    return v && KNOWN_CLI_ORIGINS.has(v) ? v : "terminal";
}

// ---------------------------------------------------------------------------
// Event shaping: record the *shape* of a configuration, never its content.
// No file paths, no host names, no tokens, no device/chip identifier.
// ---------------------------------------------------------------------------
export function buildSessionProps(origin: string, cfg: ConfigurationArguments): Record<string, any> {
    const props: Record<string, any> = {};
    props.origin = origin;
    props.servertype = cfg.servertype || "unknown";
    props.rtos = cfg.rtos ?? "none";

    if (cfg.chainedConfigurations?.enabled) props.multicore = true;
    if (cfg.swoConfig?.enabled) props.swo = true;
    if (cfg.rttConfig?.enabled) props.rtt = true;
    if (cfg.pvtRttConfig || cfg.rttConfig?.useBuiltinRTT?.enabled) props.builtinRtt = true;
    if (cfg.graphConfig && cfg.graphConfig.length > 0) props.graphing = true;
    if (cfg.serialConfig?.enabled) props.serial = true;
    if (cfg.liveWatch?.enabled) props.liveWatch = true;

    // Remote-probe usage: record only whether it is on and which flavor ("auto"/"ssh").
    // Never the host, port, token, or any address.
    const hc = cfg.hostConfig;
    if (hc === true || (hc && hc !== null && typeof hc === "object" && (hc as any).enabled !== false)) {
        props.remoteProbe = (hc as any).type || "auto";
    }

    // NOTE: `device`/chip is intentionally NOT recorded.
    return props;
}

// ---------------------------------------------------------------------------
// CLI offline queue: ~/.mcu-debug/telemetry.json
// The CLI has no access to the VS Code telemetry setting or a PostHog connection, so it appends
// events here. The extension flushes and clears the file on activation (honoring opt-out first).
// ---------------------------------------------------------------------------
const MAX_QUEUED_EVENTS = 500;

export function homeTelemetryDir(): string {
    return path.join(os.homedir(), ".mcu-debug");
}
export function queueFilePath(): string {
    return path.join(homeTelemetryDir(), "telemetry.json");
}
function anonIdFilePath(): string {
    return path.join(homeTelemetryDir(), "telemetry-id");
}

/** CLI-side opt-out: the community `DO_NOT_TRACK` standard plus our own override. */
export function cliTelemetryDisabled(): boolean {
    const dnt = process.env.DO_NOT_TRACK;
    if (dnt && dnt !== "0" && dnt.toLowerCase() !== "false") return true;
    const v = (process.env.MCU_DEBUG_TELEMETRY || "").toLowerCase();
    return v === "0" || v === "off" || v === "false" || v === "no";
}

/** A stable, random, non-reversible id for CLI-only users, persisted next to the queue. */
export function cliAnonId(): string {
    try {
        const f = anonIdFilePath();
        if (fs.existsSync(f)) {
            const s = fs.readFileSync(f, "utf8").trim();
            if (s) return s;
        }
        const id = randomUUID();
        fs.mkdirSync(homeTelemetryDir(), { recursive: true });
        fs.writeFileSync(f, id, "utf8");
        return id;
    } catch {
        return "cli-anon";
    }
}

export function enqueueEvent(ev: TelemetryEvent): void {
    try {
        fs.mkdirSync(homeTelemetryDir(), { recursive: true });
        const f = queueFilePath();
        let arr: TelemetryEvent[] = [];
        try {
            const parsed = JSON.parse(fs.readFileSync(f, "utf8"));
            if (Array.isArray(parsed)) arr = parsed;
        } catch {
            arr = [];
        }
        arr.push(ev);
        if (arr.length > MAX_QUEUED_EVENTS) arr = arr.slice(-MAX_QUEUED_EVENTS);
        fs.writeFileSync(f, JSON.stringify(arr), "utf8");
    } catch {
        // ignore — never let a telemetry write break the CLI
    }
}

/** Read and remove the queue file, returning whatever events it held. */
export function drainQueue(): TelemetryEvent[] {
    try {
        const f = queueFilePath();
        if (!fs.existsSync(f)) return [];
        const raw = fs.readFileSync(f, "utf8");
        fs.rmSync(f, { force: true });
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr : [];
    } catch {
        return [];
    }
}

/** Delete the queue without sending — used when the user has opted out. */
export function discardQueue(): void {
    try {
        fs.rmSync(queueFilePath(), { force: true });
    } catch {
        // ignore
    }
}
