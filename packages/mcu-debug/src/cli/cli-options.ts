// Copyright (c) 2026 MCU-Debug Authors.
// SPDX-License-Identifier: Apache-2.0
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { Command } from "commander";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { version } = require("../../package.json") as { version: string };

export interface CliArgs {
    config: string;
    json: string;
    help?: boolean;
    version?: boolean;
    settings?: string;
    logFile?: string;
    debug?: boolean;
    dumpConfig?: boolean;
    showServerOutput?: boolean;
    waitForClient?: boolean;
    // Deliberately spelled without a hyphen. Commander treats a `--no-` prefix as negation, so
    // `--no-stdin` would define an option called `stdin` that defaults to true — the inverse of
    // what the name suggests every time you read it.
    nostdin?: boolean;
    script?: string;
    batch?: boolean;
}

const program = new Command();

program
    .option(
        "-c, --config <string>",
        "Debug configuration to use. Can be the name of a configuration in launch.json, the index of the configuration in launch.json, or a glob pattern to match the name of the configuration in launch.json",
    )
    .option("-j, --json <string>", "launch.json file to use", ".vscode/launch.json")
    .option("-s, --settings <string>", "Use custom settings JSON file", ".vscode/settings.json")
    .option("-l, --log-file <string>", "Log file path. Default path is $TMPDIR/mcu-debug-logs/<pid>.log", "")
    .option("-d, --debug", "Enable debug mode - more verbose logging")
    .option("--dump-config", "Dump the configuration and exit")
    .option("--show-server-output", "Show server output in the console")
    .option("--wait-for-client", "Wait for a client to connect before starting the debug session")
    .option("--nostdin", "Never read stdin; drive the session over the socket instead. Required when backgrounding the process from an interactive shell. Implies --wait-for-client")
    .option("-r, --script <string>", "script file to execute after startup as though commands were entered on stdin")
    .option(
        "--batch",
        "Run commands like gdb -batch: one at a time, each execution command (continue, step, ...) waiting until the target stops again (a trailing '&' does not wait), stopping at the first failure. Commands come from --script if given, otherwise stdin; the session exits when they run out",
    )
    .version(version, "-V, --version", "Show version information")
    .helpOption("-h, --help", "Show this help message")
    .parse(process.argv);

export const cliArgs = program.opts<CliArgs>();

// --nostdin means the socket is the only way in, so waiting for a client is not optional:
// without it the session would start, run unattended, and accept commands from nobody.
if (cliArgs.nostdin) {
    cliArgs.waitForClient = true;
}

export function printHelp() {
    console.log(program.helpInformation());
}
