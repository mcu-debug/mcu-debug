import fs from "fs";
import { execSync } from "child_process";

function execSyncWithEcho(command, options = {}) {
    console.log(`Executing command: ${command}`);
    execSync(command, options);
}

if (fs.existsSync("./dist")) {
    console.log("Artifacts directory exists.");
} else {
    console.error("Artifacts directory does not exist.");
    process.exit(1);
}

const pkgVersion = JSON.parse(fs.readFileSync("./packages/mcu-debug/package.json", "utf-8")).version;
console.log(`Package version: ${pkgVersion}`);
execSyncWithEcho(`code --install-extension dist/mcu-debug-${pkgVersion}.vsix --install-extension=dist/mcu-debug-proxy-${pkgVersion}.vsix`);
const args = process.argv.slice(2);
execSyncWithEcho(`code ${args.join(" ")}`);
