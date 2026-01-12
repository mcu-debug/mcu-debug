const child_process = require("child_process");
const gitStatus = child_process.execSync("git status --short").toString().trim();
const commitHash = child_process.execSync("git rev-parse --short HEAD").toString().trim() + (gitStatus === "" ? "" : "+dirty");

function updateCommitHash() {
    const fs = require("fs");
    const path = require("path");
    const outFilePath = path.join(__dirname, "../src", "commit-hash.ts");
    const inFilePath = path.join(__dirname, "..", "package.json");
    const packageJson = JSON.parse(fs.readFileSync(inFilePath, "utf8"));
    const version = packageJson.version;
    let fileContent = `// This file is auto-generated. Do not edit manually.
export const gitCommitHash = '${commitHash}';
`;
    fileContent += `export const pkgJsonVersion = '${version}';\n`;
    if (fs.existsSync(outFilePath)) {
        const existingContent = fs.readFileSync(outFilePath, "utf8");
        if (existingContent === fileContent) {
            return; // No change needed
        }
    }
    console.log(`Updating commit hash to: ${commitHash}`);
    fs.writeFileSync(outFilePath, fileContent, "utf8");
}

updateCommitHash();
