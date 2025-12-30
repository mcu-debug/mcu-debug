import * as os from "os";

const logFilePath = os.tmpdir() + "/mcu-debug-process-log.txt";
export function ServerConsoleLog(message: string) {
    try {
        const fs = require("fs");
        fs.appendFileSync(logFilePath, `[Mcu-debug-adapter] ${message}\n`);
    } catch (e) {
        // ignore
    }
    console.log(`[GDB-MI] ${message}`);
}
