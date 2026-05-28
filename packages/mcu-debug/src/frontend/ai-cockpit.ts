// Copyright (c) 2026 MCU-Debug Authors.
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
// SPDX-License-Identifier: Apache-2.0

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as ChildProcess from "child_process";
import { CockpitPanel } from "./views/CockpitPanel";
import { magentaWrite } from "../common/ansi-helpers";
import { logger } from "../common/logger";
import { ConfigurationArguments } from "../adapter/servers/common";
import { ManagedTab } from "./views/ManagedTab";
import { CockpitToolbarAction, TabKind, TabState } from "@mcu-debug/shared";
import { CLIConfigLoader, ConfigLoaderArgs } from "../cli/config-loader";
import winston from "winston";
import { Writable } from "stream";
import { CLI_SESSION_TYPES, CLISessionType, getHostAdapter } from "../common/host-adapter";
import JSONC from "jsonc-simple-parser";

/**
 * TODO: Task list for AI Cockpit:
 * 
 * Button bar with debug controls:
 * 1. Create a button bar that has the same debug buttons as the VS Code debug toolbar (continue, step over, step into, step out, pause,
 *    stop, restart, reset). The reset button is an extra button for us. These buttons are for humans. AI will not use them but can send
 *    equivalent commands via the socket connection.
 * 2. The state of the buttons (enabled/disabled) will be determined based on the state of the debug session and the AI's analysis
 *    of the program state. This tab's logic will deternine the state of each button
 * 3. In addition to the buttons, there should be a dropdown to select the launch/attach configuration for the debug session.
 *    Not for AI. For humans. Since we are watching files, we need a way to refresh the list of launch/attach configurations.
 *    See: enumerateLaunchConfigurations() - there is a TODO in there. When refreshing the list of configs, currently selected
 *    config should remain selected if it is still available. If the currently selected config is no longer available, select the first config
 * 3b. Need a way to determine currently selected launch/attach configuration for the session.
 * 4. All button actions are determined by this tab's logic. The UI just sends the user interactions (button clicks, dropdown selection) to this tab, and this tab decides what to do with them.
 * 5. We are currently displaying session status in the tab label. We want to move that to the end after the dropdown.
 * 
 * History of commands and program state:
 * 1. The tab will maintain a history of all commands sent to the debug adapter.
 * 2. Users should be able to use the up/down buttons to select items in history and/or edit them.
 * 3. The history will also be visible to the user in the UI, allowing them to see the sequence of interactions and the resulting program state changes.
 * 4. The tab can provide a way for the user to export this history for further analysis or sharing with others.
 * 
 * Cockpit <-> AI interaction:
 * There is none. AI interacts directly with the debug adapter via the socket connection. The cockpit panel is just a UI for
 * humans to interact with the AI and see the history of commands and program state changes. The cockpit panel can also provide
 * some additional context or information to the user based on the AI's analysis, but it does not mediate the interaction between the AI and the debug adapter.
 * 
 * The debug adapter how ever, echoes back all commands AI sends and there are two special notices we get from the debug adapter
 * 1. !!AI-COMMAND: <command> - This is what AI sent to the debug adapter. We just display it
 *     when the debug adapter receives a command from the AI. This allows us to identify which commands in the history were sent by the AI.
 * 2. !!AI-REQUEST: <string> - This is an instruction from the AI for the human to perform. Note that we have three sections
 *    in the cockpit panel. This goes into the middle section and is intended as instructions for the human to perform in the physical world.
 *    For example, "Press the reset button on your device". The user can then perform the action and report back to the AI with the results.
 *    This allows the AI to interact with the physical world and get feedback from the user, which can be crucial for debugging hardware issues.
 * 3. !!AI-REQUEST-CLEAR - This is AI asking us the clear the instruction section
 * 4. We need a way for user to report back to the AI after performing the instructed action. We can do this by allowing the user to enter a
 *    response in the input box and then sending that response back to the debug adapter with a special prefix (e.g. !!AI-RESPONSE: <string>).
 *    The debug adapter can then relay that response back to the AI for further analysis.
 * 
 * I am worried about #4 above. It was not in the `docs-internal/AI-Angle.md` design doc but I think it is necessary for the AI to be able
 * to interact with the physical world and get feedback from the user. Otherwise, the AI would be operating in a vacuum and would not be able
 * to effectively debug hardware issues. My problem is when to allow this. If it is like a chat session, you can't send a command until you
 * have received a response for the previous command. We need to get some advice here.
 */

/**
 * Here is the implementation of the AI Cockpit, which is a feature that allows users to interact with an AI
 * assistant within the MCU Debug cockpit panel. The AI Cockpit provides a way for AI to control the debugger and
 * interact with the user. It make autonomous debugging possible, where the AI can analyze the program state, set
 * breakpoints, step through code. It can also instruct users to perform actions in the physical world, such as
 * pressing buttons on the device, and then report back the results to the AI for further analysis.
 */

/**
 * Architectural overview:
 * 
 * - The AI Cockpit is implemented as a singleton class that manages the AI assistant and its interactions with the user and the debugger.
 * - The user of the AI can start a debug session (via Command Palette or a button in the UI) which will initialize the AI
 *   assistant and open the cockpit panel if it's not already open.
 * - The user or AI selects the launch/attach configuration for the debug session, which is then used to start the debugger
 *   and establish communication channels.
 * - The backend is the mcu-debug-cli process, which runs the debug adapter and provides output from gdb, gdb-servers, RTT UARTs
 *   all muxed into one stream. The AI Cockpit can parse this stream to understand the program state and the results of commands.
 *
 * Step1: Determine the launch/attach configuration for the debug session
 * 
 * Step2: Run it though the config resolver in this extension to get a post-resolve configuration. This will also start/setup any
 * remote proxy servers that may be needed for the session (e.g. WSL NAT proxy, remote-ssh port forwarding, etc.) and update the
 * config with the connection details. One details: we remove the the console server port from the config since the cockpit will
 * connect to that directly and we don't want the debug adapter to also connect to it.
 * 
 * Step3: Start the debug session with the resolved config using the cli driver. This will launch the mcu-debug-cli process and
 * establish the communication channels. The CLI driver will additionally refine the configuration and start the debug session. We now
 * perform the same role as the Rust debug subcommand does as a TUI. Exvcept, here we render in our own cockpit panel and we have an
 * AI assistant that can parse the output and interact with the user.
 */

export class AICockpit extends ManagedTab {
    private static _instance: AICockpit | null = null;
    private static readonly AI_REQUEST_PREFIX = "!!AI-REQUEST:";
    private static readonly AI_REQUEST_CLEAR = "!!AI-REQUEST-CLEAR";
    kind: TabKind = "cockpit";
    direction: "rx" | "tx" | "both" | undefined = "both";
    private readonly fsPattern = "**/launch.json";
    private process: ChildProcess.ChildProcessWithoutNullStreams | null = null;
    private logger: winston.Logger | null = null;
    private loggerWriter: Writable | null = null;
    private addedToCockpitPanel = false;
    private firstErrorOfSession = true;
    private launchConfigCache: { [name: string]: vscode.DebugConfiguration } = {};
    private selectedConfigName: string | null = null;
    private sessionState: CLISessionType = "not-started";
    private stdoutPending = "";
    private stderrPending = "";

    private constructor(private context: vscode.ExtensionContext) {
        // Private constructor to enforce singleton pattern
        super("ai-cockpit", "AI Cockpit", "Enter any GDB command or special commands status/reset/restart/pause/continue/exit", "cooked");
        this.logger = this.createLogger();
        this.enumerateLaunchConfigurations().then(configs => {
            this.launchConfigCache = configs;
        });
        this.setInactive();
        this.setupDocWatcher();
        this.addToCockpitPanel();
    }

    public static getInstance(context: vscode.ExtensionContext): AICockpit {
        if (!AICockpit._instance) {
            AICockpit._instance = new AICockpit(context);
        }
        return AICockpit._instance;
    }

    private addToCockpitPanel(): void {
        if (!this.addedToCockpitPanel) {
            const panel = CockpitPanel.instance;
            if (panel) {
                panel.addTab(this);
                this.addedToCockpitPanel = true;
                this.postCockpitUiState();
            } else {
                logger?.error("Failed to add AI Cockpit tab to the cockpit panel.");
                return;
            }
        }
    }

    public async startDebugSession(configName?: string) {
        if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
            return {};
        }
        // Prepare for new session, clear old content
        this.clear();
        this.firstErrorOfSession = false;

        const root = vscode.workspace.workspaceFolders[0];
        let config = this.selectLaunchConfiguration(configName) as ConfigurationArguments | undefined;
        if (!config) {
            return;
        }
        this.selectedConfigName = config.name ?? this.selectedConfigName;
        this.postCockpitUiState();
        // (config as any).startedFromAICockpit = true;
        const configLoaderArgs: ConfigLoaderArgs = {
            json: "", // We are passing a parsed config already, so this a no-op
            config: config.name,
            configParsed: config,
            builtins: CLIConfigLoader.gatherBuiltins(root.uri.fsPath),
        };
        const configLoader = new CLIConfigLoader(this.logger!, false);
        try {
            /**
             * We resolve using the CLIConfigLoader which is the same code path used by the CLI. This ensures that any config
             * transformations or remote server setups are consistent between the CLI and the AI Cockpit. However the resution
             * of settings and builtins occur in the context of this VSCode Extension, so any variables that depend on the environment
             * (e.g. ${workspaceFolder}, ${env:VAR}, etc.) will be resolved based on the extension's context. This means that if there
             * are any variables that need to be resolved based on the debug adapter's environment, we may need to add support for that
             * in the future. For now, we assume that all necessary variables can be resolved in the extension's context.
             * 
             * As a bonus, the host config will also be resolved and a proxy server started if needed, so the config returned from the loader
             * will be marked as resolved and ready to use by the CLI driver without any additional setup.
             */
            config = await configLoader.loadConfiguration(configLoaderArgs);
        } catch (error) {
            const err = `Failed to load configuration: ${error}`;
            this.logger?.error(err);
            return;
        }
        if (!config) {
            // Errors should have been logged already
            return;
        }
        // Remove the console server port from the config since the cockpit will connect to that directly and we don't want the debug adapter to also connect to it.
        delete (config as any).gdbServerConsolePort;

        this.clear();
        const jsonFile = path.join(os.tmpdir(), `mcu-debug-ai-cockpit-${process.pid}.json`).replace(/\\/g, "/");
        try {
            const launchJson: any = {
                configurations: [config]
            };
            fs.writeFileSync(jsonFile, JSON.stringify(launchJson, null, 2));
        } catch (error) {
            const err = `Failed to write AI Cockpit config file: ${error}`;
            this.logger?.error(err);
            magentaWrite(`Failed to write AI Cockpit config file: ${error}\n`, (str) => this.logger?.error(str));
            return;
        }

        if (!this.checkNodeInstalled()) {
            magentaWrite(`Node.js version 22 or higher is required to run the AI Cockpit. Please install or update Node.js and make sure it's in your PATH.\n`, (str) => this.logger?.error(str));
            return;
        }

        this.sessionState = "starting";
        this.postCockpitUiState();
        this.launchDebugCLI(jsonFile, root);
    }

    private isNodeInstalled = false;
    private launchDebugCLI(jsonFile: string, root: vscode.WorkspaceFolder) {
        const cmd = "node";
        const jsFile = path.join(this.context.extensionPath, "dist/mcu-debug-cli.js").replace(/\\/g, "/");
        const args = [jsFile, "--config", "0", "--json", jsonFile];
        magentaWrite(`Starting AI Cockpit debug session with command: ${cmd} ${args.join(" ")}\n`, (str) => this.logger?.info(str));
        this.process = ChildProcess.spawn(cmd, args, {
            cwd: root.uri.fsPath,
            env: process.env,
            stdio: "pipe"
        });
        this.process.on("spawn", () => {
            this.setState({ kind: 'active' });
            this.postCockpitUiState();
        });
        this.process.stdout.on("data", (data) => {
            const str = data.toString();
            this.stdoutPending = this.handleProcessChunk(str, this.stdoutPending, false);
        });
        this.process.stderr.on("data", (data) => {
            const str = data.toString();
            this.stderrPending = this.handleProcessChunk(str, this.stderrPending, true);
        });
        this.process.on("close", (code) => {
            this.process = null;
            this.sessionState = "terminated";
            this.setInactive();
            this.send(`Debug session ended with code ${code}\n`);
            this.postCockpitUiState();
        });
        this.process.on("error", (err) => {
            this.process = null;
            this.sessionState = "not-started";
            this.setInactive();
            this.logger?.error(`Failed to start debug session: ${err}`);
            this.postCockpitUiState();
        });
    }

    setInactive() {
        this.setState({ kind: 'inactive' });
        this.setLabel(`AI Cockpit`);
        this.postCockpitUiState();
    }

    override onWebviewReady(): void {
        this.postCockpitUiState();
    }

    override onCockpitToolbarAction(action: CockpitToolbarAction): void {
        this.handleToolbarAction(action);
    }

    override onCockpitConfigSelect(configName: string): void {
        if (!this.launchConfigCache[configName]) {
            return;
        }
        this.selectedConfigName = configName;
        this.postCockpitUiState();
    }

    onUserInput(text: string): void {
        if (this.process && this.process.stdin.writable) {
            this.process.stdin.write(text + "\n");
        }
    }

    private checkNodeInstalled(): boolean {
        try {
            if (this.isNodeInstalled) {
                return true;
            }
            const result = ChildProcess.spawnSync("node", ["-v"], { encoding: "utf-8" });
            if (result.error) {
                this.logger?.error(`Node.js is required to run the AI Cockpit, but it is not installed or not found in PATH. ${result.error}`);
                return false;
            }
            const version = result.stdout.trim();
            // We need version 22 or higher
            const majorVersion = parseInt(version.replace(/^v/, '').split('.')[0], 10);
            if (isNaN(majorVersion) || majorVersion < 22) {
                this.logger?.error(`Node.js version 22 or higher is required to run the AI Cockpit. Detected version: ${version}`);
                return false;
            }
            this.isNodeInstalled = true;
            return true;
        } catch (error) {
            this.logger?.error(`Failed to check Node.js version: ${error}`);
            return false;
        }
    }

    private createLogger() {
        this.loggerWriter = new Writable({
            write: (chunk, encoding, callback) => {
                // Convert chunk to string and push to our array
                if (this.firstErrorOfSession) {
                    const instance = CockpitPanel.instance;
                    instance?.activateTab(this.tabId);
                }
                this.firstErrorOfSession = false;
                const str = chunk.toString();
                getHostAdapter().debugMessage(str);
                this.send(str);
                callback();
            }
        });
        this.logger = winston.createLogger({
            level: 'info',
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.timestamp(),
                winston.format.printf(({ timestamp, level, message }) => `${timestamp} ${level}: [ai-cockpit] ${message}`)
            ),
            transports: [
                new winston.transports.Stream({ stream: this.loggerWriter })
            ]
        });
        return this.logger;
    }

    private parseSessionStatus(str: string): CLISessionType | null {
        const [, rawStatus = ""] = str.trim().split(":", 2);
        const status = rawStatus.trim();
        return CLI_SESSION_TYPES.includes(status as CLISessionType) ? status as CLISessionType : null;
    }

    private handleProcessChunk(chunk: string, pending: string, isStderr: boolean): string {
        const combined = pending + chunk;
        const lines = combined.split(/\r?\n/);
        const trailing = lines.pop() ?? "";

        for (const line of lines) {
            this.handleProcessLine(line, isStderr);
        }

        return trailing;
    }

    private handleProcessLine(line: string, isStderr: boolean): void {
        if (line.startsWith(AICockpit.AI_REQUEST_PREFIX)) {
            const text = line.slice(AICockpit.AI_REQUEST_PREFIX.length).trim();
            CockpitPanel.instance?.postToWebview({ type: "ai-request", tabId: this.tabId, text });
            return;
        }
        if (line.trim() === AICockpit.AI_REQUEST_CLEAR) {
            CockpitPanel.instance?.postToWebview({ type: "ai-request-clear", tabId: this.tabId });
            return;
        }
        if (isStderr && /^status: [a-z-]+/i.test(line)) {
            const status = this.parseSessionStatus(line);
            if (status && status !== this.sessionState) {
                this.sessionState = status;
                if (status === "terminated") {
                    this.setInactive();
                }
                this.postCockpitUiState();
            }
            return;
        }

        this.send(line + "\n");
    }

    private handleToolbarAction(action: CockpitToolbarAction): void {
        this.logger?.info(`Cockpit toolbar action requested: ${action}`);
        switch (action) {
            case "continue":
                if (this.sessionState === "not-started" || this.sessionState === "terminated") {
                    this.startDebugSession(this.selectedConfigName ?? undefined);
                } else if (this.sessionState === "paused") {
                    this.onUserInput("continue");
                }
                break;
            case "pause":
                if (this.sessionState === "running") {
                    this.onUserInput("pause");
                }
                break;
            case "step-over":
                if (this.sessionState === "paused") {
                    this.onUserInput("next");
                }
                break;
            case "step-into":
                if (this.sessionState === "paused") {
                    this.onUserInput("step");
                }
                break;
            case "step-out":
                if (this.sessionState === "paused") {
                    this.onUserInput("finish");
                }
                break;
            case "restart":
                if (this.process) {
                    this.onUserInput("restart");
                }
                break;
            case "reset":
                if (this.process) {
                    this.onUserInput("reset");
                }
                break;
            case "stop":
                if (this.process) {
                    this.onUserInput("exit");
                }
                break;
        }
    }

    private getButtonEnabledState(): Record<CockpitToolbarAction, boolean> {
        const hasProcess = !!this.process;
        switch (this.sessionState) {
            case "paused":
                return {
                    "continue": hasProcess,
                    "pause": false,
                    "step-over": hasProcess,
                    "step-into": hasProcess,
                    "step-out": hasProcess,
                    "restart": hasProcess,
                    "reset": hasProcess,
                    "stop": hasProcess,
                };
            case "running":
            case "starting":
            case "initialized":
                return {
                    "continue": false,
                    "pause": hasProcess,
                    "step-over": false,
                    "step-into": false,
                    "step-out": false,
                    "restart": hasProcess,
                    "reset": hasProcess,
                    "stop": hasProcess,
                };
            case "terminated":
            case "not-started":
            default:
                return {
                    "continue": true,  // This is a run/continue button
                    "pause": false,
                    "step-over": false,
                    "step-into": false,
                    "step-out": false,
                    "restart": false,
                    "reset": false,
                    "stop": false,
                };
        }
    }

    private postCockpitUiState(): void {
        CockpitPanel.instance?.postToWebview({
            type: "cockpit-ui-state",
            tabId: this.tabId,
            state: {
                availableConfigs: Object.keys(this.launchConfigCache),
                selectedConfig: this.selectedConfigName,
                statusText: this.sessionState,
                buttonEnabled: this.getButtonEnabledState(),
            },
        });
    }

    private selectLaunchConfiguration(configName?: string): vscode.DebugConfiguration | undefined {
        let config: any = undefined;
        const configs = this.launchConfigCache;
        if (!configs || Object.keys(configs).length === 0) {
            const err = "No launch configurations of type 'mcu-debug' found.";
            this.logger?.error(err);
            return undefined;
        }
        configName = configName?.trim();
        if (configName) {
            config = configs[configName];
            if (!config) {
                for (const key in configs) {
                    if (key.toLowerCase() === configName.toLowerCase()) {
                        config = configs[key];
                        break;
                    }
                }
            }
            if (!config) {
                const err = `Launch configuration "${configName}" not found.`;
                this.logger?.error(err);
                return undefined;
            }
        }
        if (!config) {
            // Lets do a quick pick from the available configs if there are more than 1
            const configNames = Object.keys(configs);
            if (configNames.length === 0) {
                const err = "No launch configurations of type 'mcu-debug' found.";
                this.logger?.error(err);
                return undefined;
            } else if (configNames.length === 1) {
                config = configs[configNames[0]];
            } else {
                vscode.window.showQuickPick(configNames, { placeHolder: "Select a launch configuration for the AI Cockpit debug session" })
                    .then((selected) => {
                        if (selected) {
                            this.startDebugSession(selected);
                        }
                    });
                return undefined;
            }
        }
        this.selectedConfigName = config.name ?? this.selectedConfigName;
        return config;
    }

    private async enumerateLaunchConfigurations(): Promise<{ [key: string]: any; }> {
        if (!vscode.workspace.workspaceFolders) {
            return {};
        }
        const launchConfigs: { [key: string]: vscode.DebugConfiguration } = {};
        for (const folder of vscode.workspace.workspaceFolders) {
            const launchJsonPath = path.join(folder.uri.fsPath, ".vscode", "launch.json");
            if (!fs.existsSync(launchJsonPath)) {
                continue;
            }
            try {
                const data = fs.readFileSync(launchJsonPath);
                const configJSON = JSONC.parse(data.toString());
                for (const config of configJSON.configurations || []) {
                    if (config.type === "mcu-debug") {
                        const key = config.name?.trim() || "";
                        if (key) {
                            launchConfigs[key] = config; // Also add without folder prefix for convenience, but this means if there are duplicate config names across folders the last one wins. We can improve this later if needed.   
                        }
                    }
                }
            } catch (error) {
                // Ignore errors, just means no launch.json or malformed launch.json in this folder
                continue;
            }
        }
        // We need to determine is the new launchConfigs are different from the cached one to see if the dropdown list of
        // configs in the cockpit panel needs to be updated.
        const oldConfigNames = Object.keys(this.launchConfigCache);
        const newConfigNames = Object.keys(launchConfigs);
        const areConfigsDifferent = oldConfigNames.length !== newConfigNames.length ||
            oldConfigNames.some(name => !launchConfigs[name]) ||
            newConfigNames.some(name => !this.launchConfigCache[name]);
        if (!this.selectedConfigName || !launchConfigs[this.selectedConfigName]) {
            this.selectedConfigName = newConfigNames[0] ?? null;
        }
        if (areConfigsDifferent) {
            this.postCockpitUiState();
        }

        this.launchConfigCache = launchConfigs; // Cache the configs for later use when user selects from quick pick
        this.postCockpitUiState();
        return launchConfigs;
    }

    private watcher: vscode.FileSystemWatcher | null = null;
    async setupDocWatcher() {
        if (vscode.workspace.workspaceFolders === undefined || vscode.workspace.workspaceFolders.length === 0) {
            return; // No workspace
        }
        if (this.watcher) {
            return; // Already watching or no workspace
        }

        const root = vscode.workspace.workspaceFolders[0];
        const pattern = new vscode.RelativePattern(root, this.fsPattern);
        this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
        this.watcher.onDidCreate((uri) => this.onDocChanged(uri, "created"));
        this.watcher.onDidChange((uri) => this.onDocChanged(uri, "changed"));
        this.watcher.onDidDelete((uri) => this.onDocChanged(uri, "deleted"));
    }

    private timer: NodeJS.Timeout | null = null;
    private onDocChanged(uri: vscode.Uri, changeType: "created" | "changed" | "deleted") {
        if (this.timer) {
            clearTimeout(this.timer);
        }
        this.timer = setTimeout(() => {
            this.enumerateLaunchConfigurations()
            // If the changed file is the one we are currently using for the debug session, we may want to reload it and update the session. For now, we just log it.
        }, 1000); // Debounce to avoid multiple events in quick succession
    }
}
