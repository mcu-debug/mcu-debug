const fs = require("fs");
const path = require("path");

if (!fs.existsSync(".vscodeignore")) {
    console.error("Error: .vscodeignore file not found.");
    process.exit(1);
}
const baseIgnore = fs.readFileSync(".vscodeignore", "utf8");
const binDir = path.join(__dirname, "..", "bin");
if (!fs.existsSync(binDir)) {
    console.error("Error: bin/ directory not found. Run `npm run build:server` first.");
    process.exit(1);
}

fs.mkdirSync(path.join(__dirname, "..", "out"), { recursive: true });
// Find all platform binaries
const platforms = fs.readdirSync(binDir).filter((f) => fs.statSync(path.join(binDir, f)).isDirectory());

for (const target of ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win32-x64"]) {
    // Exclude all platforms except target
    const excludes = platforms
        .filter((p) => p !== target)
        .flatMap((p) => {
            const platformDir = path.join(binDir, p);
            return fs.readdirSync(platformDir).map((f) => `bin/${p}/${f}`);
        });

    // Write combined ignore file
    const outputPath = `out/ignore-file.${target}`;
    fs.writeFileSync(outputPath, baseIgnore + "\n" + excludes.join("\n") + "\n");
    console.log(`Generated ${outputPath} (excluded ${excludes.length} files)`);
}
console.log("\n✅ All platform-specific ignore files generated successfully!");
