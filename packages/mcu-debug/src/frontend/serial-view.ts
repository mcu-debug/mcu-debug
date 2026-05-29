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

import * as fs from "fs";
import * as net from "net";
import * as path from "path";
import { SerialParams } from "@mcu-debug/shared/serial-helper/SerialParams";
import { TerminalInputMode } from "../adapter/servers/common";
import { EventEmitter } from "stream";
import { MCUDebugChannel } from "./dbgmsgs";
import { getHostAdapter, ISerialPortView } from "../common/host-adapter";
import { getUUidPrefixed, ManagedTab } from "./views/ManagedTab";
import { CockpitPanel } from "./views/CockpitPanel";
import type { TabKind } from "@mcu-debug/shared";
import { AnsiHelpers } from "../common/ansi-helpers";

export class SerialPortView extends ManagedTab implements ISerialPortView {
    public readonly emitter = new EventEmitter();
    private socket: net.Socket | null = null;
    private logFileStream: fs.WriteStream | null = null;
    readonly kind: TabKind = "uart";
    readonly direction = "both";

    static createOrGetTab(device: string, serialConfig: SerialParams, doClear: boolean = false, tcpPort: number = 0): SerialPortView {
        const baseName = path.basename(device);
        const existing = CockpitPanel.instance?.findTabByLabel(baseName) as unknown as SerialPortView | null;
        if (existing) {
            // If a tab with the same name already exists, we will reuse it for the new serial port. This allows us to preserve the terminal buffer and other state in the tab, which can be useful for debugging purposes. We will just clear the buffer and reset the options to match the new serial port configuration.
            if (doClear) {
                existing.clear();
            }
            existing.serialConfig = serialConfig;
            existing.setLogFile(serialConfig.log_file ?? undefined);
            existing.setInputMode(serialConfig.input_mode ?? undefined);
            existing.setState({ kind: "active" });
            return existing;
        } else {
            return new SerialPortView(device, serialConfig, doClear, tcpPort);
        }
    }

    constructor(private device: string, public serialConfig: SerialParams, doClear: boolean = false, private tcpPort: number = 0) {
        const baseName = path.basename(device);
        super(
            `serial-${getUUidPrefixed('serial')}`,
            baseName,
            "Enter input for serial port " + device,
            serialConfig.input_mode === "raw" ? "raw" : "cooked",
        );
        if (this.tcpPort) {
            this.restartSocket();
        }
        if (this.serialConfig.log_file) {
            this.setLogFile(this.serialConfig.log_file);
        }
        CockpitPanel.instance?.addTab(this);
    }

    onUserInput(text: string) {
        const outgoing = this.inputMode === "raw" ? text : `${text}\r\n`;
        if (!outgoing) {
            return;
        }
        if (this.socket) {
            super.onUserInput(outgoing);
            this.socket.write(outgoing);
        }
        if (this.logFileStream) {
            this.logFileStream.write(outgoing);
        }
    }

    onUserClose(): void {
        MCUDebugChannel.debugMessage(`Terminal for serial port ${this.device} closed`);
        this.destroySocket();
        this.emitter.emit("close");
    }

    public notifyConnected(reason: string) {
        this.send(AnsiHelpers.greenFormat(`[${this.device} connected] ${reason}\r\n`));
        this.setState({ kind: "active" });
    }

    public notifyDisconnected(reason: string) {
        this.destroySocket();
        this.send(AnsiHelpers.yellowFormat(`[${this.device} disconnected: ${reason} — retrying...]\r\n`));
        this.setState({ kind: "inactive" });
    }

    public notifyReconnected() {
        this.send(AnsiHelpers.greenFormat(`[${this.device} reconnected]\r\n`));
        this.setState({ kind: "active" });
    }

    setTcpPort(port: number) {
        if (this.tcpPort === port && this.socket && !this.socket.destroyed) {
            return;
        }
        this.tcpPort = port;
        this.restartSocket();
    }

    private destroySocket() {
        if (this.socket) {
            this.socket.destroy();
            this.socket = null;
        }
    }

    private destroyLogFile() {
        if (this.serialConfig.log_file) {
            this.logFileStream?.end(() => {
                MCUDebugChannel.debugMessage(`Closed log file stream for ${this.serialConfig.log_file}`);
            });
            this.logFileStream = null;
        }
    }

    public setLogFile(log_file: string | undefined) {
        if (this.serialConfig.log_file === log_file) {
            return;
        }
        this.serialConfig.log_file = log_file || "";
        this.destroyLogFile();
        if (log_file) {
            this.logFileStream = fs.createWriteStream(log_file, { flags: "a" });
            if (!this.logFileStream) {
                MCUDebugChannel.debugMessage(`Failed to create log file stream for ${log_file}`);
                getHostAdapter().showError(`Failed to create log file stream for ${log_file}`);
            }
        }
    }

    public setInputMode(input_mode: string | undefined) {
        const mode = input_mode === "raw" ? TerminalInputMode.RAW : TerminalInputMode.COOKED;
        if (this.inputMode === (mode === TerminalInputMode.RAW ? "raw" : "cooked")) {
            return;
        }
        super.setInputMode(mode === TerminalInputMode.RAW ? "raw" : "cooked");
    }

    restartSocket() {
        this.destroySocket();
        // The helper will create a TCP server for this serial port and report the port number back to us. Once we have the port number, we can connect to it.
        const socket = new net.Socket();
        socket.connect(this.tcpPort, "127.0.0.1");
        socket.on("connect", () => {
            MCUDebugChannel.debugMessage(`Connected to serial port ${this.device} at 127.0.0.1:${this.tcpPort}`);
            this.socket = socket;
        });
        socket.on("data", (data) => {
            this.send(data.toString());
            if (this.logFileStream) {
                this.logFileStream.write(data);
            }
        });
        socket.on("error", (err) => {
            MCUDebugChannel.debugMessage(`Error on serial port ${this.device} connection: ${err.message}`);
            this.destroySocket();
            this.notifyDisconnected(err.message);
        });
        socket.on("close", () => {
            MCUDebugChannel.debugMessage(`Connection to serial port ${this.device} closed`);
            this.destroySocket();
            this.notifyDisconnected("Connection closed");
        });
    }
}
