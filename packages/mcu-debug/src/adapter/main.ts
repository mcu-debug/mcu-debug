import { ServerConsoleLog } from "./server-console-log";
import { GDBDebugSession } from "./gdb-session";

process.on("uncaughtException", (err) => {
    const msg = err && err.stack ? err.stack : err.message ? err.message : "unknown error";
    console.error(": Caught exception:", msg);
    ServerConsoleLog("Caught exception: " + msg);
    process.exit(1); // The process is in an unreliable state, so exit is recommended
});

process.on("unhandledRejection", (reason: any, promise: Promise<any>) => {
    const msg = ": Unhandled Rejection: reason: " + reason.toString() + " promise: " + promise.toString();
    console.error(msg);
    ServerConsoleLog(msg);
});

try {
    GDBDebugSession.run(GDBDebugSession);
} catch (error: any) {
    console.error(": Error occurred while running GDBDebugSession:", error);
    ServerConsoleLog(": Caught exception: " + error.toString());
    throw error;
}
