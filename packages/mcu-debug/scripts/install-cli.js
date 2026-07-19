const path = require("path");
const os = require("os");
const fs = require("fs");
const readline = require("readline");
const { execSync } = require("child_process");

// 1. Verify Node.js Version
const nodeMajorVersion = parseInt(process.versions.node.split(".")[0], 10);
if (nodeMajorVersion < 22) {
    console.error(`Error: Node.js version is ${process.version}. Node.js >= 22 is required for mcu-debug CLI.`);
    process.exit(1);
}

const binDir = path.resolve(os.homedir(), ".mcu-debug", "bin");
const delimiter = process.platform === "win32" ? ";" : ":";
const pathEnv = process.env.PATH || "";
const isInPath = pathEnv.split(delimiter).some(p => {
    try {
        return path.resolve(p).toLowerCase() === binDir.toLowerCase();
    } catch {
        return false;
    }
});

if (isInPath) {
    console.log("====================================================");
    console.log("Success: ~/.mcu-debug/bin is already in your PATH!");
    console.log("You can run 'mcu-debug --version' to verify installation.");
    console.log("====================================================");
    process.exit(0);
}

console.log("====================================================");
console.log("         mcu-debug CLI Tools Installer");
console.log("====================================================");
console.log(`Wrapper scripts directory: ${binDir}\n`);

if (process.platform === "win32") {
    // Windows PATH configuration
    console.log("We will add the mcu-debug bin folder to your Windows User Environment variables.");
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    rl.question("Do you want to proceed? [y/N]: ", (answer) => {
        if (answer.toLowerCase() === "y") {
            try {
                const psGetCmd = `[Environment]::GetEnvironmentVariable("PATH", "User")`;
                const userPath = execSync(`powershell -NoProfile -Command "${psGetCmd}"`, { stdio: "pipe" }).toString().trim();
                
                if (!userPath.toLowerCase().includes(binDir.toLowerCase())) {
                    const separator = userPath.length > 0 && !userPath.endsWith(";") ? ";" : "";
                    const newPath = userPath + separator + binDir;
                    const psSetCmd = `[Environment]::SetEnvironmentVariable("PATH", "${newPath.replace(/"/g, '\\"')}", "User")`;
                    execSync(`powershell -NoProfile -Command "${psSetCmd}"`);
                    console.log("\n[SUCCESS] Added mcu-debug bin directory to your Windows User PATH!");
                    console.log("IMPORTANT: Please restart your terminal (or VS Code) for the PATH changes to take effect.\n");
                } else {
                    console.log("\nmcu-debug bin directory is already in your Windows User PATH!");
                }
            } catch (err) {
                console.error(`\nError updating User PATH: ${err.message}`);
                console.log(`Please manually add the following path to your environment variable PATH:\n  ${binDir}`);
            }
        } else {
            console.log(`\nSkipped. Please manually add the following path to your environment variable PATH:\n  ${binDir}`);
        }
        rl.close();
    });
} else {
    // macOS / Linux PATH configuration
    const shellPath = process.env.SHELL || "";
    let shellName = "bash";
    if (shellPath.includes("zsh")) {
        shellName = "zsh";
    } else if (shellPath.includes("bash")) {
        shellName = "bash";
    } else {
        shellName = "unknown";
    }

    if (shellName === "unknown") {
        console.log("Could not auto-detect shell type.");
        console.log("Please manually add the following line to your shell profile (~/.zshrc, ~/.bashrc, etc.):");
        console.log(`  export PATH="$HOME/.mcu-debug/bin:$PATH"\n`);
        process.exit(0);
    }

    const profilePath = shellName === "zsh" ? path.join(os.homedir(), ".zshrc") : path.join(os.homedir(), ".bashrc");
    const exportLine = `\n# mcu-debug CLI PATH configuration\nexport PATH="$HOME/.mcu-debug/bin:$PATH"\n`;

    console.log(`We will add mcu-debug to your PATH by appending to ${profilePath}`);
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    rl.question("Do you want to proceed? [y/N]: ", (answer) => {
        if (answer.toLowerCase() === "y") {
            try {
                fs.appendFileSync(profilePath, exportLine);
                console.log("\n[SUCCESS] Added export PATH configuration to " + profilePath);
                console.log("IMPORTANT: Please restart your terminal (or VS Code) for the PATH changes to take effect.\n");
            } catch (err) {
                console.error(`\nError appending to ${profilePath}: ${err.message}`);
                console.log(`Please manually add this line to your shell profile:\n  export PATH="$HOME/.mcu-debug/bin:$PATH"\n`);
            }
        } else {
            console.log(`\nSkipped. Please manually add this line to your shell profile:\n  export PATH="$HOME/.mcu-debug/bin:$PATH"\n`);
        }
        rl.close();
    });
}
