const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
    name: "esbuild-problem-matcher",

    setup(build) {
        build.onStart(() => {
            console.log("[watch] build started");
        });
        build.onEnd((result) => {
            result.errors.forEach(({ text, location }) => {
                console.error(`✘ [ERROR] ${text}`);
                if (location == null) return;
                console.error(`    ${location.file}:${location.line}:${location.column}:`);
            });
            console.log("[watch] build finished");
        });
    },
};

async function main() {
    const commonOptions = {
        bundle: true,
        format: "cjs",
        minify: production,
        sourcemap: true,
        sourcesContent: false,
        platform: "node",
        external: ["vscode"],
        logLevel: "warning",
        plugins: [esbuildProblemMatcherPlugin],
    };

    const ctxMain = await esbuild.context({
        ...commonOptions,
        entryPoints: ["src/frontend/extension.ts"],
        outfile: "dist/extension.js",
    });

    const ctxAdapter = await esbuild.context({
        ...commonOptions,
        entryPoints: ["src/adapter/main.ts"],
        outfile: "dist/adapter.js",
    });

    if (watch) {
        await Promise.all([ctxMain.watch(), ctxAdapter.watch()]);
    } else {
        await Promise.all([ctxMain.rebuild(), ctxAdapter.rebuild()]);
        await Promise.all([ctxMain.dispose(), ctxAdapter.dispose()]);
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
