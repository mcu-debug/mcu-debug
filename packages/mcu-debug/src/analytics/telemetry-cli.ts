// CLI-side telemetry. The command-line debugger cannot reach PostHog directly (no VS Code
// setting to honor, no expectation of network access), so it appends events to
// ~/.mcu-debug/telemetry.json. The next time the VS Code extension activates it flushes that
// queue — after re-checking opt-out. A CLI-only user's events therefore never leave the machine.

import type { ConfigurationArguments } from "../adapter/servers/common";
import {
    buildSessionProps,
    cliAnonId,
    cliIsDev,
    cliTelemetryDisabled,
    enqueueEvent,
    resolveLaunchOrigin,
    TelemetryEvent,
} from "./telemetry-core";

const sessionStarts: Record<string, number> = {};

function makeEvent(event: string, properties: Record<string, any>): TelemetryEvent {
    return {
        event,
        distinctId: cliAnonId(),
        timestamp: new Date().toISOString(),
        // Stamp environment here so a dev CLI run stays `development` even when a production
        // extension later flushes the queue (the flusher only fills it in when absent).
        properties: { ...properties, mode: "cli", environment: cliIsDev() ? "development" : "production" },
    };
}

export class CliTelemetry {
    static beginSession(id: string, cfg: ConfigurationArguments): void {
        if (cliTelemetryDisabled()) return;
        sessionStarts[id] = Date.now();
        enqueueEvent(makeEvent("session-started", buildSessionProps(resolveLaunchOrigin(), cfg)));
    }

    static endSession(id: string): void {
        const start = sessionStarts[id];
        if (start === undefined) return; // never begun, or already ended
        delete sessionStarts[id];
        if (cliTelemetryDisabled()) return;
        enqueueEvent(makeEvent("session-ended", { durationSec: Math.round((Date.now() - start) / 1000) }));
    }

    static sendEvent(event: string, properties: Record<string, any> = {}): void {
        if (cliTelemetryDisabled()) return;
        enqueueEvent(makeEvent(event, properties));
    }
}
