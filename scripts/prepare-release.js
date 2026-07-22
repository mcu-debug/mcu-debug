const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

function log(msg) {
    console.log(`\n==> ${msg}`);
}

function error(msg) {
    console.error(`\n[ERROR] ${msg}`);
    process.exit(1);
}

function runCmd(cmd) {
    console.log(`Running: ${cmd}`);
    return execSync(cmd, { stdio: "inherit" });
}

function main() {
    // 1. Verify release notes file argument
    const args = process.argv.slice(2);
    if (args.length !== 1) {
        error("Usage: node scripts/prepare-release.js <path-to-release-notes.md>");
    }

    const notesPath = path.resolve(args[0]);
    if (!fs.existsSync(notesPath)) {
        error(`Release notes file not found: ${notesPath}`);
    }

    const notesContent = fs.readFileSync(notesPath, "utf8").trim();
    if (!notesContent) {
        error(`Release notes file is empty: ${notesPath}`);
    }

    // 2. Git workspace checks
    log("Checking Git workspace status...");
    const status = execSync("git status --porcelain").toString().trim();
    if (status !== "") {
        error("Your Git working directory is not clean. Please commit or stash all changes first.");
    }

    // Fetch and check sync with remote
    log("Fetching latest from remote repository...");
    runCmd("git fetch origin");
    const currentBranch = execSync("git branch --show-current").toString().trim();
    const diff = execSync(`git diff HEAD..origin/${currentBranch}`).toString().trim();
    if (diff !== "") {
        error(`Your local branch is not in sync with origin/${currentBranch}. Please push or pull first.`);
    }

    // 3. Extract version and verify tag
    const pkgPath = path.join(__dirname, "../packages/mcu-debug/package.json");
    if (!fs.existsSync(pkgPath)) {
        error(`Could not find packages/mcu-debug/package.json at: ${pkgPath}`);
    }
    const version = JSON.parse(fs.readFileSync(pkgPath, "utf8")).version;
    const tag = `v${version}`;
    log(`Preparing release for version: ${version} (${tag})`);

    // Verify tag does not exist locally
    try {
        const localTag = execSync(`git tag -l ${tag}`).toString().trim();
        if (localTag === tag) {
            error(`Tag ${tag} already exists locally.`);
        }
    } catch (e) {
        // Ignore check errors
    }

    // Verify tag does not exist remotely
    try {
        const remoteTagCheck = execSync(`git ls-remote --tags origin refs/tags/${tag}`).toString().trim();
        if (remoteTagCheck !== "") {
            error(`Tag ${tag} already exists on the remote repository.`);
        }
    } catch (e) {
        error(`Failed to check remote tags: ${e.message}`);
    }

    // 4. Compile and Package Extensions
    log("Packaging extensions (running npm run package)...");
    try {
        execSync("npm run package", { stdio: "inherit" });
    } catch (e) {
        error(`npm run package failed: ${e.message}`);
    }

    // Verify VSIX outputs exist
    const distDir = path.join(__dirname, "../dist");
    const vsix1 = path.join(distDir, `mcu-debug-${version}.vsix`);
    const vsix2 = path.join(distDir, `mcu-debug-proxy-${version}.vsix`);

    if (!fs.existsSync(vsix1) || !fs.existsSync(vsix2)) {
        error(`Packaging completed but expected VSIX files were not found in: ${distDir}`);
    }
    console.log(`✓ Verified VSIX assets exist:\n  - ${vsix1}\n  - ${vsix2}`);

    // 5. Git Tagging and Push
    log(`Creating git tag ${tag}...`);
    try {
        execSync(`git tag -a ${tag} -m "Release ${tag}"`, { stdio: "inherit" });
        log(`Pushing tag ${tag} to origin...`);
        execSync(`git push origin ${tag}`, { stdio: "inherit" });
    } catch (e) {
        error(`Failed to tag or push to git: ${e.message}`);
    }

    // 6. GitHub Release Creation
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
        try {
            const ghCmd = `gh release create ${tag} "${vsix1}" "${vsix2}" --title "${tag}" --notes-file "${notesPath}"`;
            console.log(`Running: ${ghCmd}`);
            execSync(ghCmd, { stdio: "inherit" });
            log(`[SUCCESS] GitHub Release ${tag} created and VSIX files uploaded successfully!`);
        } catch (e) {
            error(`Failed to create GitHub Release using gh CLI: ${e.message}`);
        }
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
