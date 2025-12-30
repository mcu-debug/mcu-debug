const esbuild = require("esbuild");
const pkg = require("./package.json");

const dependencies = Object.keys(pkg.dependencies || {});
const peerDependencies = Object.keys(pkg.peerDependencies || {});
const external = [...dependencies, ...peerDependencies];

const watch = process.argv.includes("--watch");

const commonOptions = {
    entryPoints: ["src/index.ts"],
    bundle: true,
    minify: true,
    sourcemap: true,
    external,
    logLevel: "info",
};

async function build() {
    const ctxCjs = await esbuild.context({
        ...commonOptions,
        format: "cjs",
        outfile: "lib/index.js",
        platform: "node",
    });

    const ctxEsm = await esbuild.context({
        ...commonOptions,
        format: "esm",
        outfile: "lib/index.mjs",
        platform: "node",
    });

    if (watch) {
        await Promise.all([ctxCjs.watch(), ctxEsm.watch()]);
        console.log("Watching for changes...");
    } else {
        await Promise.all([ctxCjs.rebuild(), ctxEsm.rebuild()]);
        await Promise.all([ctxCjs.dispose(), ctxEsm.dispose()]);
        console.log("Build complete.");
    }
}

build().catch(() => process.exit(1));
