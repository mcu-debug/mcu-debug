/*
 * Release driver for the mcu-debug monorepo.
 *
 *   node scripts/prepare-release.js <notes.md> [--publish] [--vsx-also] [--dryrun]
 *
 * Without --publish this only *prepares* a release: build, package, tag, and create the
 * GitHub release with both VSIX assets attached. With --publish it additionally pushes
 * both extensions to the VS Code Marketplace (and optionally Open VSX) first.
 *
 * Publishing to a marketplace CANNOT BE UNDONE. Use --dryrun to see every command that
 * would run, without running any of them.
 *
 * Ordering rules that matter (see docs-internal/Publishing.md):
 *  - mcu-debug-proxy publishes BEFORE mcu-debug. The main extension declares the proxy in
 *    extensionDependencies, and a dependency that does not yet exist in the marketplace
 *    makes the main extension uninstallable. Publishing the proxy first also keeps a first
 *    publish (the step most likely to trip Marketplace verification) off the main listing.
 *  - Marketplace publish happens BEFORE tagging, so a failed publish does not leave a tag
 *    and GitHub release pointing at a version that never shipped.
 *  - We publish the exact VSIX files that `npm run package` produced and that get attached
 *    to the GitHub release, via `vsce publish --packagePath`. Letting vsce rebuild would
 *    ship bits nobody tested.
 *
 * Tokens are passed through the environment (VSCE_PAT / OVSX_PAT), never on the command
 * line, so they cannot leak into --dryrun output or another user's `ps`.
 */

const { execSync, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

let isDryRun = false;

function log(msg) {
    console.log(`\n==> ${msg}`);
}

function warn(msg) {
    console.warn(`[WARN] ${msg}`);
}

function error(msg) {
    console.error(`\n[ERROR] ${msg}`);
    process.exit(1);
}

/** Read-only command whose output we need. Always runs, even in a dry run. */
function capture(cmd) {
    return execSync(cmd).toString().trim();
}

/**
 * A command with side effects. In a dry run it is printed and skipped.
 * `extraEnv` keeps secrets out of argv.
 */
function runCmd(args, extraEnv) {
    const printable = Array.isArray(args) ? args.join(" ") : args;
    if (isDryRun) {
        console.log(`[dryrun] ${printable}`);
        return;
    }
    console.log(`Running: ${printable}`);
    const [arg0, ...rest] = Array.isArray(args) ? args : ["sh", "-c", args];
    const res = spawnSync(arg0, rest, {
        stdio: "inherit",
        env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    });
    if (res.error) {
        error(`Failed to run '${printable}': ${res.error.message}`);
    }
    if (res.status !== 0) {
        error(`'${printable}' exited with code ${res.status}`);
    }
}

/**
 * Pull the section for `version` out of a Keep-a-Changelog style file: everything between the
 * `## [v<version>]` heading and the next `## ` heading. Returning the changelog text means the
 * GitHub release body and the Marketplace changelog tab cannot drift apart.
 */
function extractChangelogSection(changelogPath, version) {
    if (!fs.existsSync(changelogPath)) {
        return null;
    }
    const lines = fs.readFileSync(changelogPath, "utf8").split("\n");
    const headingRe = new RegExp(`^##\\s+\\[?v?${version.replace(/\./g, "\\.")}\\]?`);
    const start = lines.findIndex((l) => headingRe.test(l));
    if (start < 0) {
        return null;
    }
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((l) => /^##\s/.test(l));
    const body = (end < 0 ? rest : rest.slice(0, end)).join("\n").trim();
    return body || null;
}

function usage(code) {
    console.log("Usage: node scripts/prepare-release.js [path-to-release-notes.md] [options]");
    console.log("");
    console.log("  If no notes file is given, the section for the current version is taken from");
    console.log("  packages/mcu-debug/CHANGELOG.md.");
    console.log("");
    console.log("  --publish     Also publish both extensions to the VS Code Marketplace.");
    console.log("                Without this, only package + tag + GitHub release are done.");
    console.log("  --vsx-also    Additionally publish to Open VSX. Ignored for pre-releases.");
    console.log("  --dryrun      Print every mutating command instead of running it.");
    console.log("  -h, --help    Show this help.");
    console.log("");
    console.log("Environment (only needed with --publish):");
    console.log("  VSCE_MD       Personal Access Token for the VS Code Marketplace.");
    console.log("  OPEN_VSX_PAT  Personal Access Token for Open VSX (with --vsx-also).");
    process.exit(code);
}

function parseArgs() {
    const opts = { notesPath: null, doPublish: false, vsxAlso: false };
    for (const arg of process.argv.slice(2)) {
        switch (arg) {
            case "-h":
            case "--help":
                usage(0);
                break;
            case "--publish":
                opts.doPublish = true;
                break;
            case "--vsx-also":
                opts.vsxAlso = true;
                break;
            case "--dryrun":
            case "--dry-run":
                isDryRun = true;
                break;
            default:
                if (arg.startsWith("-")) {
                    console.error(`Unknown option '${arg}'`);
                    usage(1);
                }
                if (opts.notesPath) {
                    console.error(`Unexpected extra argument '${arg}'`);
                    usage(1);
                }
                opts.notesPath = arg;
        }
    }
    return opts;
}

/** Shared convention with package-extensions.sh: odd minor version means pre-release. */
function isPreRelease(version) {
    return parseInt(version.split(".")[1], 10) % 2 === 1;
}

function readVersion(pkgRelPath) {
    const pkgPath = path.join(__dirname, "..", pkgRelPath);
    if (!fs.existsSync(pkgPath)) {
        error(`Could not find ${pkgRelPath} at: ${pkgPath}`);
    }
    const version = JSON.parse(fs.readFileSync(pkgPath, "utf8")).version;
    if (!version) {
        error(`"version" property not found in ${pkgRelPath}`);
    }
    return version;
}

function main() {
    const opts = parseArgs();

    if (isDryRun) {
        console.log("*** DRY RUN — no command with side effects will be executed ***");
    }

    if (!fs.existsSync("packages/mcu-debug/package.json")) {
        error("packages/mcu-debug/package.json not found.\nYou must run this script from the root of the repository.");
    }

    let notesPath = null;
    let notesAreTemporary = false;
    if (opts.notesPath) {
        notesPath = path.resolve(opts.notesPath);
        if (!fs.existsSync(notesPath)) {
            error(`Release notes file not found: ${notesPath}`);
        }
        if (!fs.readFileSync(notesPath, "utf8").trim()) {
            error(`Release notes file is empty: ${notesPath}`);
        }
    }

    // A dry run is a rehearsal, so preconditions that the user is expected to satisfy later
    // (clean tree, pushed branch, unused tag) are reported but do not stop the preview. In a
    // real run they are hard errors.
    const precondition = (msg) => (isDryRun ? warn(`${msg} (would abort a real run)`) : error(msg));

    // Build first, then check the tree is clean. That order is deliberate: `npm run build`
    // runs version:sync, so building before the check catches un-committed version churn.
    // The build writes generated files into the repo, so a dry run skips it.
    log("Building (npm run build)...");
    if (isDryRun) {
        console.log("[dryrun] npm run build");
    } else {
        try {
            execSync("npm run build", { stdio: "inherit" });
        } catch (e) {
            error(`Build failed. Aborting release. ${e.message}`);
        }
    }

    log("Checking Git workspace status...");
    if (capture("git status --porcelain") !== "") {
        precondition("Your Git working directory is not clean. Please commit or stash all changes first.");
    }

    log("Fetching latest from remote repository...");
    runCmd(["git", "fetch", "origin"]);
    const currentBranch = capture("git branch --show-current");
    try {
        if (capture(`git diff HEAD..origin/${currentBranch}`) !== "") {
            precondition(`Your local branch is not in sync with origin/${currentBranch}. Please push or pull first.`);
        }
    } catch (e) {
        precondition(`Could not compare against origin/${currentBranch}: ${e.message}`);
    }

    // Both extensions must ship as a matched pair; sync-versions.js should guarantee this.
    const version = readVersion("packages/mcu-debug/package.json");
    const proxyVersion = readVersion("packages/mcu-debug-proxy/package.json");
    if (version !== proxyVersion) {
        error(`Version mismatch: mcu-debug is ${version} but mcu-debug-proxy is ${proxyVersion}.\nRun 'npm run version:sync' and commit the result.`);
    }

    const tag = `v${version}`;
    const preRelease = isPreRelease(version);
    log(`Preparing release for version: ${version} (${tag}) — ${preRelease ? "PRE-RELEASE" : "STABLE"}`);

    // The GitHub release body is assembled, not copied: this version's CHANGELOG section, a
    // standing pointer to the full changelog at this tag, and then anything from an explicit
    // notes file appended. The notes file adds to the release, it does not replace it -- that is
    // where "this build is to test the fix for #42, please try X" goes.
    const changelogPath = path.join(__dirname, "../packages/mcu-debug/CHANGELOG.md");
    const section = extractChangelogSection(changelogPath, version);
    if (!section) {
        precondition(`packages/mcu-debug/CHANGELOG.md has no "## [v${version}]" section.`);
    }
    const proxyChangelog = path.join(__dirname, "../packages/mcu-debug-proxy/CHANGELOG.md");
    if (!extractChangelogSection(proxyChangelog, version)) {
        precondition(`packages/mcu-debug-proxy/CHANGELOG.md has no "## [v${version}]" section.`);
    }

    const changelogUrl = `https://github.com/mcu-debug/mcu-debug/blob/${tag}/packages/mcu-debug/CHANGELOG.md`;
    const bodyParts = [];
    if (section) {
        bodyParts.push(section);
    }
    if (notesPath) {
        bodyParts.push(fs.readFileSync(notesPath, "utf8").trim());
    }
    bodyParts.push(`---\n\nSee the full [CHANGELOG.md](${changelogUrl}) for this release.`);
    const body = bodyParts.filter(Boolean).join("\n\n");

    notesPath = path.join(os.tmpdir(), `mcu-debug-release-notes-${version}.md`);
    fs.writeFileSync(notesPath, body + "\n");
    notesAreTemporary = true;
    console.log(`\nGitHub release body for ${tag}:\n---\n${body}\n---`);

    // A tag that already points at HEAD means this commit was released to GitHub earlier (a
    // `npm run release` test build) and we are now publishing that same build. Re-tagging and
    // re-creating the GitHub release would fail, so skip both and go straight to publishing.
    // A tag pointing at a *different* commit is a real conflict.
    let alreadyReleased = false;
    if (capture(`git tag -l ${tag}`) === tag) {
        const tagCommit = capture(`git rev-parse ${tag}^{commit}`);
        const headCommit = capture("git rev-parse HEAD");
        if (tagCommit === headCommit) {
            alreadyReleased = true;
            log(`Tag ${tag} already exists and points at HEAD — this commit was released to GitHub already.`);
            if (!opts.doPublish) {
                error(`Nothing to do: ${tag} is already released and --publish was not given.`);
            }
            console.log("Skipping tag and GitHub release; will publish this existing release to the marketplace.");
        } else {
            precondition(`Tag ${tag} already exists locally and points at ${tagCommit.slice(0, 8)}, not HEAD.`);
        }
    }
    if (!alreadyReleased) {
        try {
            if (capture(`git ls-remote --tags origin refs/tags/${tag}`) !== "") {
                precondition(`Tag ${tag} already exists on the remote repository.`);
            }
        } catch (e) {
            precondition(`Failed to check remote tags: ${e.message}`);
        }
    }

    // Token preflight happens before anything is published, so a missing PAT fails early
    // rather than after the proxy is already live and the main extension is not.
    let vscePat = "";
    let ovsxPat = "";
    if (opts.doPublish) {
        vscePat = process.env.VSCE_MD || "";
        if (!vscePat) {
            const msg = "Environment variable VSCE_MD not set. It must contain the VS Code Marketplace PAT.";
            if (isDryRun) {
                warn(`${msg} (publish would fail here)`);
            } else {
                error(msg);
            }
        }
        if (opts.vsxAlso && preRelease) {
            log("Note: skipping Open VSX — it has no pre-release channel.");
            opts.vsxAlso = false;
        }
        if (opts.vsxAlso) {
            ovsxPat = process.env.OPEN_VSX_PAT || "";
            if (!ovsxPat) {
                const msg = "Environment variable OPEN_VSX_PAT not set, required by --vsx-also.";
                if (isDryRun) {
                    warn(`${msg} (publish would fail here)`);
                } else {
                    error(msg);
                }
            }
        }
    }

    log("Packaging extensions (npm run package)...");
    runCmd(["npm", "run", "package"]);

    const distDir = path.join(__dirname, "../dist");
    const mainVsix = path.join(distDir, `mcu-debug-${version}.vsix`);
    const proxyVsix = path.join(distDir, `mcu-debug-proxy-${version}.vsix`);
    if (!fs.existsSync(mainVsix) || !fs.existsSync(proxyVsix)) {
        const msg = `Expected VSIX files were not found in: ${distDir}\n  - ${mainVsix}\n  - ${proxyVsix}`;
        if (isDryRun) {
            warn(`${msg}\n(expected in a dry run, since packaging was skipped)`);
        } else {
            error(msg);
        }
    } else {
        console.log(`✓ Verified VSIX assets exist:\n  - ${mainVsix}\n  - ${proxyVsix}`);
    }

    if (opts.doPublish) {
        // Proxy first. See the ordering rules in this file's header comment.
        for (const [name, vsix] of [["mcu-debug-proxy", proxyVsix], ["mcu-debug", mainVsix]]) {
            log(`Publishing ${name} to the VS Code Marketplace...`);
            // --skip-duplicate makes this loop resumable. Publishing two extensions is not
            // atomic: if the first succeeds and the second fails (a network timeout is enough),
            // re-running would otherwise abort on "version already exists" for the first one and
            // need manual surgery. With this, a re-run silently skips what already landed and
            // publishes what did not.
            const args = ["npx", "vsce", "publish", "--packagePath", vsix, "--skip-duplicate"];
            if (preRelease) {
                args.push("--pre-release");
            }
            runCmd(args, { VSCE_PAT: vscePat });
        }

        if (opts.vsxAlso) {
            for (const [name, vsix] of [["mcu-debug-proxy", proxyVsix], ["mcu-debug", mainVsix]]) {
                log(`Publishing ${name} to Open VSX...`);
                runCmd(["npx", "ovsx", "publish", vsix], { OVSX_PAT: ovsxPat });
            }
        }
    } else {
        log("Skipping marketplace publish (no --publish given).");
    }

    if (alreadyReleased) {
        log(`[SUCCESS] Published ${tag}. Tag and GitHub release were already in place.`);
        if (notesAreTemporary && !isDryRun) {
            try {
                fs.unlinkSync(notesPath);
            } catch (e) {
                // Best effort; it lives in the temp dir.
            }
        }
        return;
    }

    log(`Creating git tag ${tag}...`);
    runCmd(["git", "tag", "-a", tag, "-m", `Release ${tag}`]);
    log(`Pushing tag ${tag} to origin...`);
    runCmd(["git", "push", "origin", tag]);

    log("Checking for GitHub CLI (gh) tool...");
    let hasGh = false;
    try {
        execSync("which gh", { stdio: "ignore" });
        hasGh = true;
    } catch (e) {
        // gh not found
    }

    if (hasGh) {
        log(`Creating GitHub Release ${tag} using gh CLI...`);
        // Deliberately NOT mirroring the marketplace pre-release flag here. GitHub's
        // /releases/latest is defined as the newest *non*-prerelease release, and there is no
        // "latest pre-release" endpoint. Marking these as pre-release would freeze Latest at the
        // last unmarked release (v0.1.11) until an even-minor stable ships -- a stale answer that
        // looks like a correct one. Every release we publish is the current build; flip the flag
        // by hand on the release page for the occasional build that should not be.
        const ghArgs = ["gh", "release", "create", tag, mainVsix, proxyVsix, "--title", tag, "--notes-file", notesPath];
        runCmd(ghArgs);
        if (notesAreTemporary && !isDryRun) {
            try {
                fs.unlinkSync(notesPath);
            } catch (e) {
                // Best effort; it lives in the temp dir.
            }
        }
        log(`[SUCCESS] Release ${tag} complete.`);
    } else {
        console.log("\n======================================================================");
        console.log(`[NOTICE] Git tag ${tag} has been pushed to origin successfully.`);
        console.log("However, the GitHub CLI (gh) tool was not found on your PATH.");
        console.log("To automatically create the GitHub release and upload the VSIX assets next time:");
        console.log("  1. Install GitHub CLI: brew install gh");
        console.log("  2. Authenticate:       gh auth login");
        console.log("\nFor this release, you can create it manually on GitHub's Web UI:");
        console.log(`  https://github.com/mcu-debug/mcu-debug/releases/new?tag=${tag}`);
        console.log("And upload the following files from your local ./dist directory:");
        console.log(`  - dist/mcu-debug-${version}.vsix`);
        console.log(`  - dist/mcu-debug-proxy-${version}.vsix`);
        console.log("======================================================================");
    }
}

main();
