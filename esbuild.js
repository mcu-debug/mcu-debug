const esbuild = require("esbuild");

// Build main extension
esbuild.build({
    entryPoints: ["src/adapter/extension.ts"],
    bundle: true,
    outfile: "dist/mcu-debug/extension.js",
    external: ["vscode"],
    platform: "node",
    target: "node22",
});

// Build proxy extension
esbuild.build({
    entryPoints: ["src/proxy/extension.ts"],
    bundle: true,
    outfile: "dist/mcu-debug-proxy/extension.js",
    external: ["vscode"],
    platform: "node",
    target: "node22",
});
