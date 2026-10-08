// Copyright (c) 2026 MCU-Debug Authors.
// SPDX-License-Identifier: Apache-2.0
//
// One Windows-shaped configuration through every substitution entry point.
//
// On Windows VS Code resolves `${workspaceFolder}` to a backslash path before the debug adapter sees
// the config, so nearly every real config arrives full of backslashes. Each text-level substitution
// pass we had -- stringify the config, substitute, re-parse -- broke on exactly that, one entry point at
// a time: `\d` in a regex became an invalid JSON escape, `C:\tools` grew a tab, and VS Code launches with
// env/envFile were refused. Substitution now works on parsed values only (`mapConfigStrings`). This
// fixture pins that for all of them at once; it is pure string handling, so Linux CI catches it.

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { substituteEnvVarsInConfig } from "../adapter/servers/common";
import { CliAdapter } from "../cli/cli-adapter";
import { CLIConfigLoader } from "../cli/cli-config-loader";
import { setHostAdapter } from "../common/host-adapter";

// As VS Code resolves it on Windows -- backslashes, a `\n` and a `\t` that must not become control
// characters, and quotes that must not end a JSON string.
const WORKSPACE = 'C:\\Users\\me\\new\\tests\\"proj"';
const SDK = "D:\\sdk\\tools";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subst-win-"));
const envFile = path.join(dir, ".env");
fs.writeFileSync(envFile, `SDK=${SDK}\n`); // unquoted: backslashes are literal in an envFile
const settingsFile = path.join(dir, "settings.json");
// A setting resolves `${config:...}` only against *earlier* settings files, so this one is a plain path.
fs.writeFileSync(settingsFile, JSON.stringify({ "tools.svd": "C:\\tools\\new\\chip.svd" }));

/** The launch config as written by the user. `${workspaceFolder}` is still a reference here. */
function authored() {
    return {
        name: "fixture",
        type: "mcu-debug",
        request: "launch",
        cwd: "${workspaceFolder}",
        executable: "${workspaceFolder}\\build\\app.elf",
        overrideGDBServerStartedRegex: "Listening on port \\d+ for gdb connection",
        // `env` values resolve against the process environment only (envFile is read after them),
        // so each source is referenced directly.
        env: { TOOLS: "C:\\tools\\bin" },
        envFile,
        serverpath: "${env:SDK}\\openocd.exe",
        serverArgs: ["-c", 'echo "${workspaceFolder}"', "${env:TOOLS}"],
    };
}

/** Every value must come out exactly like this, whichever entry point produced it. */
function assertIntact(cfg: any) {
    assert.equal(cfg.cwd, WORKSPACE);
    assert.equal(cfg.executable, `${WORKSPACE}\\build\\app.elf`);
    assert.equal(cfg.overrideGDBServerStartedRegex, "Listening on port \\d+ for gdb connection");
    assert.equal(cfg.serverpath, `${SDK}\\openocd.exe`);
    assert.deepEqual(cfg.serverArgs, ["-c", `echo "${WORKSPACE}"`, "C:\\tools\\bin"]);
}

test("DA: env/envFile substitution on a config VS Code has already resolved", () => {
    // VS Code substitutes `${workspaceFolder}` itself; the DA then does `${env:...}`.
    const fromVsCode = JSON.parse(JSON.stringify(authored()).replaceAll("${workspaceFolder}", WORKSPACE.replaceAll("\\", "\\\\").replaceAll('"', '\\"')));
    const errors: string[] = [];
    const out = substituteEnvVarsInConfig(fromVsCode, (m) => errors.push(m));
    assert.deepEqual(errors, []);
    assertIntact(out);
});

test("CLI: settings file, then launch.json built-ins, ${config:...} and env/envFile", () => {
    // The real wiring: the CLI adapter loads the settings file and is the host adapter the loader asks.
    const adapter = new CliAdapter({ json: "", config: "", settings: settingsFile });
    assert.equal(adapter.getSettings()["tools.svd"], "C:\\tools\\new\\chip.svd", "settings-file substitution");
    setHostAdapter(adapter as any);

    const quiet = { warn() {}, info() {}, error() {}, debug() {} } as any;
    const loader = new CLIConfigLoader({ config: "fixture" }, quiet, false);
    const config = { ...authored(), svdFile: "${config:tools.svd}" };
    const out = (loader as any).processVarSubstitutions({ json: "launch.json", config: "fixture", builtins: { workspaceFolder: WORKSPACE } }, config);

    assertIntact(out);
    assert.equal(out.svdFile, "C:\\tools\\new\\chip.svd");
});
