const fs = require("fs");
const path = require("path");
const process = require("process");

export function commandExists(commandName: string) {
    const envPath = process.env.PATH || "";
    // Split the PATH into individual directory paths, considering platform differences
    const pathDirs = envPath.split(path.delimiter);

    // Define executable extensions for Windows
    const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ".sh"] : [""];

    for (const dir of pathDirs) {
        for (const ext of extensions) {
            const fullPath = path.join(dir, commandName + ext);
            try {
                // Check if the file exists and is executable
                fs.accessSync(fullPath, fs.constants.F_OK | fs.constants.X_OK);
                return true; // Command found and is executable
            } catch (err) {
                // Command not found or not executable in this specific path/extension combination
                continue;
            }
        }
    }

    return false; // Command not found anywhere in the PATH
}
