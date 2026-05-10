const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const sharedPackageName = "@mcu-debug/shared";
const sharedDir = path.join(repoRoot, "packages", "shared");
const sharedPackageJson = JSON.parse(fs.readFileSync(path.join(sharedDir, "package.json"), "utf8"));
const exportsMap = sharedPackageJson.exports || {};
const sourceRoots = [path.join(repoRoot, "packages")];
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const ignoredDirs = new Set([".git", ".svelte-kit", "bin", "build", "coverage", "dist", "lib", "node_modules", "out", "resources", "target"]);

function walkFiles(dir, callback) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (!ignoredDirs.has(entry.name)) {
                walkFiles(path.join(dir, entry.name), callback);
            }
            continue;
        }
        const ext = path.extname(entry.name);
        if (sourceExtensions.has(ext)) {
            callback(path.join(dir, entry.name));
        }
    }
}

function toExportKey(specifier) {
    if (specifier === sharedPackageName) {
        return ".";
    }
    return `./${specifier.slice(sharedPackageName.length + 1)}`;
}

function findExportMatch(exportKey) {
    if (Object.prototype.hasOwnProperty.call(exportsMap, exportKey)) {
        return { pattern: exportKey, token: null, target: exportsMap[exportKey] };
    }

    for (const [pattern, target] of Object.entries(exportsMap)) {
        if (!pattern.includes("*")) {
            continue;
        }
        const [prefix, suffix] = pattern.split("*");
        if (exportKey.startsWith(prefix) && exportKey.endsWith(suffix)) {
            const token = exportKey.slice(prefix.length, exportKey.length - suffix.length);
            return { pattern, token, target };
        }
    }

    return null;
}

function materializeTarget(template, token) {
    if (typeof template !== "string") {
        return null;
    }
    const relativePath = token == null ? template : template.replaceAll("*", token);
    return path.join(sharedDir, relativePath);
}

function validateConditionTargets(label, specifier, token, target, failures) {
    if (typeof target === "string") {
        const outputPath = materializeTarget(target, token);
        if (!outputPath || !fs.existsSync(outputPath)) {
            failures.push(`${specifier}: missing ${label} target ${target}`);
        }
        return;
    }

    if (!target || typeof target !== "object") {
        failures.push(`${specifier}: invalid export target for ${label}`);
        return;
    }

    for (const [condition, value] of Object.entries(target)) {
        const outputPath = materializeTarget(value, token);
        if (!outputPath || !fs.existsSync(outputPath)) {
            failures.push(`${specifier}: missing ${condition} target ${value}`);
        }
    }
}

function collectSharedImportSpecifiers() {
    const specifiers = new Set();
    const matcher = /@mcu-debug\/shared(?:\/[^"'`\s)\]}]+)?/g;

    for (const root of sourceRoots) {
        walkFiles(root, (filePath) => {
            const contents = fs.readFileSync(filePath, "utf8");
            for (const match of contents.matchAll(matcher)) {
                specifiers.add(match[0]);
            }
        });
    }

    return Array.from(specifiers).sort();
}

function validateUsedSpecifiers(failures) {
    const specifiers = collectSharedImportSpecifiers();
    for (const specifier of specifiers) {
        const exportKey = toExportKey(specifier);
        const match = findExportMatch(exportKey);
        if (!match) {
            failures.push(`${specifier}: no matching export in packages/shared/package.json`);
            continue;
        }
        validateConditionTargets("used specifier", specifier, match.token, match.target, failures);
    }
    return specifiers.length;
}

function validateWildcardCoverage(failures) {
    for (const [pattern, target] of Object.entries(exportsMap)) {
        if (!pattern.includes("*")) {
            continue;
        }
        const prefix = pattern.slice(2, pattern.indexOf("*") - 1);
        const sourceDir = path.join(sharedDir, prefix);
        if (!fs.existsSync(sourceDir)) {
            failures.push(`${pattern}: source directory ${prefix} does not exist`);
            continue;
        }
        const files = fs.readdirSync(sourceDir).filter((name) => name.endsWith(".ts") && !name.endsWith(".d.ts"));
        if (files.length === 0) {
            failures.push(`${pattern}: no source files found in ${prefix}`);
            continue;
        }
        for (const fileName of files) {
            const token = path.basename(fileName, ".ts");
            const specifier = `${sharedPackageName}/${prefix}/${token}`;
            validateConditionTargets("wildcard coverage", specifier, token, target, failures);
        }
    }
}

function validateExactExports(failures) {
    for (const [exportKey, target] of Object.entries(exportsMap)) {
        if (exportKey.includes("*")) {
            continue;
        }
        const specifier = exportKey === "." ? sharedPackageName : `${sharedPackageName}/${exportKey.slice(2)}`;
        validateConditionTargets("exact export", specifier, null, target, failures);
    }
}

function main() {
    const failures = [];
    const usedSpecifierCount = validateUsedSpecifiers(failures);
    validateWildcardCoverage(failures);
    validateExactExports(failures);

    if (failures.length > 0) {
        console.error("Shared package export validation failed:");
        for (const failure of failures) {
            console.error(`- ${failure}`);
        }
        process.exit(1);
    }

    console.log(`Shared package export validation passed for ${usedSpecifierCount} import specifiers.`);
}

main();
