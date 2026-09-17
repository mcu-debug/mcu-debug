import * as vscode from "vscode";
import type { ConfigurationArguments } from "../adapter/servers/common";
import {
    buildSessionProps,
    discardQueue,
    drainQueue,
    postEventsToPostHog,
    resolvePostHogKey,
    TelemetryEvent,
} from "./telemetry-core";

// A vscode.TelemetrySender that ships events to PostHog. We route everything through
// vscode.env.createTelemetryLogger so we inherit two things for free:
//   1. The global `telemetry.telemetryLevel` opt-out (this sender is simply never called when
//      the user has telemetry off), and
//   2. Automatic scrubbing of common PII (paths, emails, tokens) and common properties
//      (extension version, VS Code version, OS/platform).
class PostHogSender implements vscode.TelemetrySender {
    private buffer: TelemetryEvent[] = [];
    private timer: ReturnType<typeof setTimeout> | undefined;

    constructor(private readonly distinctId: () => string, private readonly apiKey: string) {}

    sendEventData(eventName: string, data?: Record<string, any>): void {
        // createTelemetryLogger prefixes the extension id: "publisher.name/eventName".
        const event = eventName.includes("/") ? eventName.slice(eventName.indexOf("/") + 1) : eventName;
        this.buffer.push({
            event,
            distinctId: this.distinctId(),
            timestamp: new Date().toISOString(),
            properties: data ?? {},
        });
        this.schedule();
    }

    sendErrorData(error: Error, data?: Record<string, any>): void {
        this.buffer.push({
            event: "error",
            distinctId: this.distinctId(),
            timestamp: new Date().toISOString(),
            properties: { ...(data ?? {}), name: error.name, message: error.message },
        });
        this.schedule();
    }

    private schedule(): void {
        if (this.timer) return;
        this.timer = setTimeout(() => void this.flush(), 10_000);
    }

    async flush(): Promise<void> {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        const batch = this.buffer;
        this.buffer = [];
        await postEventsToPostHog(batch, this.apiKey);
    }
}

export class Reporting {
    private static logger: vscode.TelemetryLogger | undefined;
    private static sender: PostHogSender | undefined;
    private static apiKey = "";
    private static environment = "production";
    private static sessionStarts: { [id: string]: Date } = {};

    static activateTelemetry(context: vscode.ExtensionContext) {
        const pkg = context.extension.packageJSON;
        const machineId = vscode.env.machineId; // anonymized, non-reversible, stable per install
        const isDev = context.extensionMode === vscode.ExtensionMode.Development;

        // Development builds route to the dev key when one is configured; either way events are
        // tagged `environment` so your own F5 testing can be filtered out of real usage stats.
        Reporting.apiKey = resolvePostHogKey(isDev);
        Reporting.environment = isDev ? "development" : "production";
        Reporting.sender = new PostHogSender(() => machineId, Reporting.apiKey);
        Reporting.logger = vscode.env.createTelemetryLogger(Reporting.sender, {
            additionalCommonProperties: {
                remote: vscode.env.remoteName ?? "local",
                uiKind: vscode.UIKind[vscode.env.uiKind],
                appHost: vscode.env.appHost,
                mode: "vscode",
                environment: Reporting.environment,
                extension: context.extension.id, // "publisher.name" — lets 4 extensions share one project
                extensionVersion: pkg.version || "unknown",
            },
        });
        context.subscriptions.push(Reporting.logger);
        // Best-effort flush of the in-memory buffer when the extension deactivates.
        context.subscriptions.push({ dispose: () => void Reporting.sender?.flush() });

        // Flush anything the command-line tool parked while the extension wasn't running.
        void Reporting.flushCliQueue(machineId);

        // Tell the user, once, that telemetry is on and how to turn it off.
        void Reporting.maybeShowFirstRunNotice(context);
    }

    private static readonly NOTICE_SHOWN_KEY = "mcu-debug.telemetryNoticeShown";
    private static readonly TELEMETRY_DOC_URL =
        "https://github.com/mcu-debug/mcu-debug/blob/main/packages/mcu-debug/TELEMETRY.md";

    /** One-time, non-modal heads-up that telemetry is active, with quick links to details/opt-out. */
    private static async maybeShowFirstRunNotice(context: vscode.ExtensionContext): Promise<void> {
        if (context.globalState.get<boolean>(Reporting.NOTICE_SHOWN_KEY)) return;
        // Don't nag people who already have telemetry off; if they enable it later they'll see it then.
        if (!Reporting.enabled()) return;
        // Mark shown up front so an ignored dialog never nags twice.
        await context.globalState.update(Reporting.NOTICE_SHOWN_KEY, true);

        const details = "What's collected";
        const disable = "Disable";
        const choice = await vscode.window.showInformationMessage(
            "MCU-Debug sends anonymous usage telemetry (which features and GDB-server types are used) to help guide development. No source, file paths, device names, or personal data are collected.",
            details,
            disable,
        );
        if (choice === details) {
            void vscode.env.openExternal(vscode.Uri.parse(Reporting.TELEMETRY_DOC_URL));
        } else if (choice === disable) {
            await vscode.workspace
                .getConfiguration("mcu-debug")
                .update("enableTelemetry", false, vscode.ConfigurationTarget.Global);
        }
    }

    /** Our extension-specific opt-out, on top of the global setting the logger already honors. */
    private static enabled(): boolean {
        return (
            vscode.env.isTelemetryEnabled &&
            vscode.workspace.getConfiguration("mcu-debug").get<boolean>("enableTelemetry", true)
        );
    }

    private static async flushCliQueue(machineId: string): Promise<void> {
        // Opted out (globally or via our setting)? Don't send — and don't hoard: drop the queue.
        if (!Reporting.enabled()) {
            discardQueue();
            return;
        }
        const events = drainQueue();
        if (!events.length) return;
        // CLI events carry their own anon id. Re-home them to this machine's id so a person who
        // uses both the CLI and the extension counts as one user, not two. Tag them with the
        // flushing extension's environment so single-key filtering treats them like everything else.
        const rehomed = events.map((e) => ({
            ...e,
            distinctId: machineId,
            // The CLI already tagged its own environment; only fill it in if somehow missing.
            properties: { ...e.properties, environment: e.properties.environment ?? Reporting.environment },
        }));
        await postEventsToPostHog(rehomed, Reporting.apiKey);
    }

    static sendEvent(event: string, options: { [key: string]: any } = {}) {
        if (!Reporting.enabled()) return;
        Reporting.logger?.logUsage(event, options);
    }

    static beginSession(id: string, opts: ConfigurationArguments) {
        Reporting.sessionStarts[id] = new Date();
        if (!Reporting.enabled()) return;
        Reporting.logger?.logUsage("session-started", { id, ...buildSessionProps("vscode-debug", opts) });
    }

    static endSession(id: string) {
        const startTime = Reporting.sessionStarts[id];
        if (!startTime) return;
        delete Reporting.sessionStarts[id];
        if (!Reporting.enabled()) return;
        const durationSec = Math.round((Date.now() - startTime.getTime()) / 1000);
        Reporting.logger?.logUsage("session-ended", { id, durationSec });
    }
}
