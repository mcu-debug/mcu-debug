import * as vscode from "vscode";
import * as os from "os";
import { ConfigurationArguments } from "../adapter/servers/common";
import { TelemetryReporter } from "@vscode/extension-telemetry";

const connectionString = `InstrumentationKey=56912e93-2136-4034-9fb1-043896fd5921;IngestionEndpoint=https://eastus-8.in.applicationinsights.azure.com/;LiveEndpoint=https://eastus.livediagnostics.monitor.azure.com/;ApplicationId=f2843fc4-40ab-4fcc-8ad4-b4c818a8030e`;
let reporter: TelemetryReporter;

export function activateTelemetry(context: vscode.ExtensionContext) {
    // create telemetry reporter on extension activation
    const pkg = context.extension.packageJSON;
    const commonProperties: vscode.TelemetryLoggerOptions = {
        additionalCommonProperties: {
            extensionId: pkg.name || "mcu-debug",
            extensionVersion: pkg.version || "unknown",
            vscodeVersion: vscode.version,
            platform: os.platform(),
            platformRelease: os.release(),
            nodeVersion: process.versions.node,
        },
    };
    reporter = new TelemetryReporter(connectionString, undefined, commonProperties);
    context.subscriptions.push(reporter);
}

export function sendEvent(event: string, options: { [key: string]: string } = {}) {
    reporter.sendTelemetryEvent(event, options);
}

const sessionStarts: { [id: string]: Date } = {};
export function beginSession(id: string, opts: ConfigurationArguments) {
    const props: any = {};

    props.id = id;
    props.servertype = opts.servertype || "unknown";
    if (opts.chainedConfigurations?.enabled) {
        props.chained = opts.chainedConfigurations.enabled ? "true" : "false";
    }
    props.rtos = opts.rtos ?? "none";
    props.device = opts.device ?? "unknown";

    if (opts.swoConfig.enabled) {
        props.SWO = "Used";
    }
    if (opts.rttConfig.enabled) {
        props.RTT = "Used";
    }
    if (opts.graphConfig.length > 0) {
        props.Graphing = "Used";
    }
    reporter.sendTelemetryEvent("session-started", props);
    sessionStarts[id] = new Date();
}

export function endSession(id: string) {
    const startTime = sessionStarts[id];
    if (startTime) {
        const endTime = new Date();
        const time = (endTime.getTime() - startTime.getTime()) / 1000;
        const props: any = {};
        props.id = id;
        props.duration = time.toString();
        delete sessionStarts[id];
        reporter.sendTelemetryEvent("session-ended", props);
    }
}
