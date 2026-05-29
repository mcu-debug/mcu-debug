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

import * as fs from "fs"
import { RTTConsoleDecoderOpts, TerminalInputMode, HrTimer } from "../adapter/servers/common";
import { AnsiHelpers } from "../common/ansi-helpers"
import { SocketIOSource } from "../common/swo/sources/socket";
import { createTerminalUniqueName, getUUidPrefixed, ManagedTabConsole } from "./views/ManagedTab";
import { TabKind } from "@mcu-debug/shared";
import { EventEmitter } from "stream";
import { BinaryFormatter, getBinaryEncoding, getTextEncoding } from "../common/binary-encoding";

export class IOTerminal extends EventEmitter {
    protected terminal: ManagedTabConsole | null = null;
    protected binaryFormatter: BinaryFormatter | null = null;
    private source: SocketIOSource | null = null;
    protected logFd: number = -1;
    private startOfNewLine = true;
    protected hrTimer: HrTimer = new HrTimer();

    constructor(
        public options: RTTConsoleDecoderOpts,
        src: SocketIOSource,
        private readonly kind: TabKind = "rtt",
    ) {
        super();
        this.createTerminal();
        this.sanitizeEncodings(this.options);
        this.connectToSource(src);
    }

    private connectToSource(src: SocketIOSource) {
        this.hrTimer = new HrTimer();
        this.binaryFormatter = new BinaryFormatter(this.terminal!, this.options.encoding, this.options.scale);
        if (src.connected) {
            this.terminal?.setState({ kind: "active" });
        } else {
            this.terminal?.setState({ kind: "inactive" });
        }
        src.once("disconnected", () => {
            this.onClose();
        });
        src.on("error", (e) => {
            const code: string = e.code;
            if (code === "ECONNRESET") {
                // Server closed the connection. We are done with this session
            } else if (code === "ECONNREFUSED") {
                // We expect 'ECONNREFUSED' if the server has not yet started after all the retries
                this.terminal?.send(AnsiHelpers.redFormat(`${e}\n.`));
            } else {
                this.terminal?.send(AnsiHelpers.redFormat(`${e}\n`));
            }
            this.onClose();
        });
        src.on("data", (data) => {
            this.onData(data);
        });

        if (src.connError) {
            this.source = src;
            this.terminal?.send(AnsiHelpers.redFormat(`${src.connError.message}\n`));
        } else if (src.connected) {
            this.source = src;
            this.openLogFile();
        } else {
            src.once("connected", () => {
                this.source = src;
                this.openLogFile();
                this.terminal?.setState({ kind: "active" });
            });
        }
    }

    private onClose() {
        this.source = null;
        if (!this.options.noclear && this.logFd >= 0) {
            this.closeLogFd(false);
        } else if (this.logFd >= 0 && !this.startOfNewLine) {
            this.writeLogFile(Buffer.from("\n"));
            this.startOfNewLine = true;
        }
        this.terminal?.send(AnsiHelpers.reset());
        this.terminal?.send(AnsiHelpers.redFormat(`RTT connection on TCP port ${this.options.tcpPort} ended. Waiting for next connection...`));
        this.terminal?.setState({ kind: "inactive" });
        this.terminal?.removeAllListeners();
        this.terminal = null;
    }

    private onData(data: Buffer) {
        try {
            if (this.options.type === "binary") {
                this.writeLogFile(data);
                this.binaryFormatter!.writeBinary(data);
            } else {
                this.writeNonBinary(data);
            }
        } catch (e) {
            this.terminal?.send(AnsiHelpers.redFormat(`Error writing data: ${e}\n`));
        }
    }

    private openLogFile() {
        if (this.logFd < 0 && this.options.logfile) {
            try {
                this.logFd = fs.openSync(this.options.logfile, "w");
            } catch (e: any) {
                const msg = `Could not open file ${this.options.logfile} for writing. ${e.toString()}`;
                console.error(msg);
                this.terminal?.send(AnsiHelpers.redFormat(`${msg}\n`));
            }
        } else if (this.logFd >= 0 && !this.options.logfile) {
            // It is already open but new connection does not want logging anymore
            this.closeLogFd(false);
        }
    }

    private writeLogFile(data: Buffer) {
        if (this.logFd >= 0) {
            fs.writeSync(this.logFd, data);
        }
    }

    private logToFd(msg: string) {
        if (this.logFd >= 0) {
            this.writeLogFile(Buffer.from(msg));
        }
    }

    private lastCharWasNl = true;
    private writeNonBinaryChunk(data: Buffer | string, ts: string) {
        if (!this.terminal) {
            // Writes after a terminal is closed
            return;
        }
        let strData = data.toString();
        if (strData.length === 0) {
            return;
        }
        if (!ts) {
            this.logToFd(strData);
            this.terminal.send(strData);
            return;
        }
        if (this.lastCharWasNl) {
            this.terminal.send(ts);
        }
        this.lastCharWasNl = strData.endsWith("\n");
        strData = strData.slice(0, strData.length - (this.lastCharWasNl ? 1 : 0));
        strData = strData.replace(/\n/g, "\n" + ts);
        if (this.lastCharWasNl) {
            strData += "\n";
        }
        this.logToFd(strData);
        this.terminal.send(strData);
    }

    private lastTime: bigint = BigInt(-1);
    private lastTimeStr: string = "";
    private writeNonBinary(buf: Buffer) {
        let start = 0;
        let time = "";
        if (this.options.timestamp) {
            const now = HrTimer.getNow();
            if (now !== this.lastTime) {
                this.lastTime = now;
                this.lastTimeStr = HrTimer.createDateTimestamp() + " ";
            }
            time = this.lastTimeStr;
        }

        for (let ix = 1; ix < buf.length; ix++) {
            if (buf[ix - 1] !== 0xff) {
                continue;
            }
            const chr = buf[ix];
            if ((chr >= 48 && chr <= 57) || (chr >= 65 && chr <= 90)) {
                if (ix >= 1) {
                    this.writeNonBinaryChunk(buf.slice(start, ix - 1), time);
                }
                this.writeNonBinaryChunk(`<switch to vTerm#${String.fromCharCode(chr)}>\n`, "");
                buf = buf.subarray(ix + 1);
                ix = 0;
                start = 0;
            }
        }
        if (buf.length > 0) {
            this.writeNonBinaryChunk(buf, time);
        }
    }

    protected createTerminal() {
        const baseName = this.createTermName(this.source, this.options, null);
        const uuid = getUUidPrefixed(this.kind.toUpperCase());
        const mode = (this.options.inputmode === TerminalInputMode.RAW) ? "raw" : "cooked";

        const [name, terminal, isNew] = createTerminalUniqueName<ManagedTabConsole>(baseName, (nm: string) => {
            const term = new ManagedTabConsole(uuid, nm, this.kind, "both", `Enter input for ${this.kind}`, mode);
            return term;
        });
        this.terminal = terminal;
        this.terminal.setInputMode(mode);
        this.terminal.setLabel(name);
        this.terminal.setState({ kind: this.source?.connected ? "active" : "inactive" });
        if (isNew) {
            this.terminal.setState({ kind: "inactive" });
        }
        this.terminal.on("close", this.terminalClosed.bind(this));
        this.terminal.on("data", (data) => {
            if (this.source?.connected) {
                this.source.write(data);
                if (this.logFd >= 0) {
                    this.writeLogFile(Buffer.from(data));
                }
            }
        });
    }

    protected createTermName(source: SocketIOSource | null, options: RTTConsoleDecoderOpts, existing: string | null): string {
        const suffix = options.type === "binary" ? `enc:${getBinaryEncoding(options.encoding)}` : options.type;
        const kindUpper = this.kind.toUpperCase();
        const orig = options.label || `${kindUpper} Ch:${options.port} ${suffix}`;
        return orig;
    }

    // User removed the tab from the UI
    protected terminalClosed() {
        this.emit("close");
        this.freeTerminal();
        this.dispose();
    }

    public sendData(str: string | Buffer) {
        if (this.source) {
            try {
                if ((typeof str === "string" || str instanceof String) && this.options.inputmode === TerminalInputMode.COOKED) {
                    str = Buffer.from(str as string, this.options.iencoding);
                }
                this.source.write(str.toString());
            } catch (e) {
                console.error(`RTTTerminal:sendData failed ${e}`);
            }
        }
    }

    private sanitizeEncodings(obj: RTTConsoleDecoderOpts) {
        obj.encoding = getBinaryEncoding(obj.encoding);
        obj.iencoding = getTextEncoding(obj.iencoding);
    }

    private closeLogFd(reopen: boolean) {
        if (this.logFd >= 0) {
            try {
                fs.closeSync(this.logFd);
            } catch (e) {
                this.terminal?.send(AnsiHelpers.redFormat(`Error: closing file ${e}\n`));
            }
            this.logFd = -1;
            this.startOfNewLine = true;
            if (reopen) {
                this.openLogFile();
            }
        }
    }

    private freeTerminal() {
        if (this.terminal) {
            this.terminal.setState({ kind: "inactive" });
            this.terminal.removeAllListeners();
            this.terminal = null;
        }
    }

    public dispose() {
        this.freeTerminal();
        this.closeLogFd(false);
    }
}
