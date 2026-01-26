import * as net from "net";
import { GdbInstance } from "./gdb-mi/gdb-instance";
import { GDBDebugSession } from "./gdb-session";
import { LiveWatchMonitor } from "./live-watch-monitor";
import { MemoryRequests } from "./memory";
import { TargetInfo } from "./target-info";
import { GdbEventNames, Stderr, Stdout } from "./gdb-mi/mi-types";
import { parseAddress } from "../frontend/utils";
import { RTTServerHelper } from "./servers/common";
import { EventEmitter } from "events";
import { DebugProtocol } from "@vscode/debugprotocol";

/**
 * RTT Up/Down-Buffer Descriptor Offsets (32-bit)
 * Relative to the start of the specific buffer descriptor
 */
const OFF_NAME = 0; // char*
// For the following offsets, we subtract 4 bytes because we read starting after the name pointer
const OFF_BUF = 4 - 4; // void*
const OFF_SIZE = 8 - 4; // uint32_t
const OFF_WROFF = 12 - 4; // uint32_t (Target writes)
const OFF_RDOFF = 16 - 4; // uint32_t (Host writes)
const OFF_FLAGS = 20 - 4; // uint32_t       // We ignore flags for now

const SIZEOF_RTT_BUFFER_DESC = 16; // Total size of one buffer descriptor, after name pointer, and ignore flags

export interface RttBufferDescriptor {
    // nameAddr: number;
    bufAddr: number;
    size: number;
    wrOff: number;
    rdOff: number;
    // flags: number;
}

class RttChannelConfig {
    name?: string;
    rttChannel: number;
    inUse: boolean;
    pendingWrites: Buffer[];
    wrBuffer: Buffer;
    rdStartAddr: bigint;
    wrStartAddr: bigint;

    constructor(rttChannel: number) {
        this.rttChannel = rttChannel;
        this.inUse = false;
        this.pendingWrites = [];
        this.wrBuffer = Buffer.alloc(0);
        this.rdStartAddr = 0n;
        this.wrStartAddr = 0n;
    }
}

export interface RttTransport extends EventEmitter {
    onRttDataRead(channel: number, data: Buffer): void;
    setPort(channels: number[]): Promise<void>;
}

export class RttBufferManager extends EventEmitter {
    private gdbInstance: GdbInstance;
    private mainSession: GDBDebugSession;
    private memoryManager: MemoryRequests;
    private endianness: "little" | "big";
    private pollingTimer: NodeJS.Timeout | null = null;
    private sessionStatus: "running" | "stopped" | "none" = "none";
    private rttBlockFound = false;
    private transport: RttTransport | null = null;
    private cbAddr: bigint = 0n; // Address of _SEGGER_RTT (RTT Control Block)
    private searchStr: string = "SEGGER RTT";
    private ready = false;
    private intervalMs = 100; // ms

    // In the future, we may support multiple channels
    private numRdChannels: number = 0;
    private numWrChannels: number = 0;
    private channels: RttChannelConfig[] = [];
    private isBusyWriting: boolean = false;

    /**
     * @param cbAddr The absolute address of _SEGGER_RTT
     * @param channel Index of the channel (0 for Terminal)
     */
    constructor(private liveWatchMonitor: LiveWatchMonitor) {
        super();
        this.gdbInstance = liveWatchMonitor.gdbInstance;
        this.mainSession = liveWatchMonitor.mainSession;
        this.memoryManager = new MemoryRequests(this.mainSession, this.gdbInstance);
        this.endianness = TargetInfo.Instance?.endianness || "little";

        this.mainSession.gdbInstance.on(GdbEventNames.Stopped, this.onStopped.bind(this));
        this.mainSession.gdbInstance.on(GdbEventNames.Running, this.onRunning.bind(this));
    }

    private setTransport(transport: RttTransport) {
        this.transport = transport;
        this.transport.on("dataToWrite", async (channel: number, data: Buffer) => {
            try {
                await this.writeToChannel(channel, data);
            } catch (e) {
                this.mainSession.handleMsg(Stderr, `ERROR: Failed to write RTT data: ${e instanceof Error ? e.message : String(e)}\n`);
            }
        });
    }

    async start(transport: RttTransport) {
        try {
            this.setTransport(transport);
            this.cbAddr = parseAddress(this.mainSession.args.rttConfig?.address || "0");
            if (this.cbAddr === 0n || this.cbAddr === BigInt(-1) || isNaN(Number(this.cbAddr))) {
                this.mainSession.handleMsg(Stderr, "ERROR: RTT Control Block address if invalid or not specified.\n");
                return;
            }
            this.searchStr = this.mainSession.args.rttConfig?.searchId || this.searchStr;
            if (this.searchStr.length > 16) {
                this.mainSession.handleMsg(Stderr, "Warning: RTT search ID longer than 16 characters. It will be truncated.\n");
                this.searchStr = this.searchStr.substring(0, 16);
            }

            const channels: number[] = [];
            let maxChannel = -1;
            for (const decoder of this.mainSession.args.rttConfig?.decoders || []) {
                if (typeof decoder.port === "number") {
                    channels.push(decoder.port);
                    maxChannel = Math.max(maxChannel, decoder.port);
                }
            }
            for (let ch = 0; ch <= maxChannel; ch++) {
                this.channels.push(new RttChannelConfig(ch));
                if (channels.indexOf(ch) >= 0) {
                    this.channels[ch].inUse = true;
                }
            }

            await transport.setPort(channels);
            if (!this.pollingTimer) {
                const interval = this.mainSession.args.rttConfig?.useBuiltinRTT?.pollingIntervalMs ?? 100;
                if (interval < 50) {
                    // Something less than 50, allow it, but warn
                    this.mainSession.handleMsg(Stderr, "Warning: RTT polling interval too low. Setting to minimum of 50 ms.\n");
                }
                this.intervalMs = interval;
                this.startPoll(interval);
            }
            this.ready = true;
        } catch (e) {
            this.mainSession.handleMsg(Stderr, `ERROR: Failed to set RTT port(s): ${e instanceof Error ? e.message : String(e)}\n`);
        }
    }

    private readUInt32(buffer: Buffer, offset: number): number {
        if (this.endianness === "little") {
            return buffer.readUInt32LE(offset);
        } else {
            return buffer.readUInt32BE(offset);
        }
    }

    /**
     * Logic to drain the buffer and move the pointers.
     */
    public async tryDrainFromDevice(channel: number): Promise<Buffer | null> {
        // 1. Calculate the start of this channel's descriptor
        // Control Block = ID (16) + MaxUp (4) + MaxDown (4) = 24 bytes header
        // Each descriptor is 24 bytes
        const descAddr = this.cbAddr + 24n + BigInt(channel) * 24n;
        const rttDesc: RttBufferDescriptor = await this.readBufferDesc(descAddr);
        if (rttDesc.wrOff === rttDesc.rdOff) return null; // Buffer empty

        let data: Buffer;

        // 3. Circular Buffer Logic
        if (rttDesc.wrOff > rttDesc.rdOff) {
            // Linear: [....Rd----Wr....]
            const len = rttDesc.wrOff - rttDesc.rdOff;
            const [part] = await this.memoryManager.readMemoryBytes(BigInt(rttDesc.bufAddr + rttDesc.rdOff), len);
            data = part;
        } else {
            // Wrapped: [---Wr....Rd----]
            const len1 = rttDesc.size - rttDesc.rdOff;
            const [part1] = await this.memoryManager.readMemoryBytes(BigInt(rttDesc.bufAddr + rttDesc.rdOff), len1);

            const len2 = rttDesc.wrOff;
            const [part2] = await this.memoryManager.readMemoryBytes(BigInt(rttDesc.bufAddr), len2);

            data = Buffer.concat([part1, part2]);
        }

        // 4. Move the pointer to unblock FW
        // We write back to the descriptor's RdOff location
        await this.memoryManager.writeWord(descAddr + 4n + BigInt(OFF_RDOFF), rttDesc.wrOff);

        return data;
    }

    public async writeToChannel(channel: number, data: Buffer): Promise<void> {
        if (!this.rttBlockFound) {
            throw new Error("RTT Control Block not found. Cannot write data.");
        }
        const chInfo = this.channels[channel];
        if (data.length === 0 && chInfo.wrBuffer.length === 0) {
            return;
        }

        chInfo.pendingWrites.push(data);
        if (this.isBusyWriting) {
            // Queue the data for later writing
            return;
        }
        this.isBusyWriting = true;
        chInfo.wrBuffer = Buffer.concat([...chInfo.pendingWrites, chInfo.wrBuffer]);
        chInfo.pendingWrites = [];
        try {
            await this.drainWriteBuffer(chInfo.rttChannel);
        } catch (e) {
            throw e;
        } finally {
            this.isBusyWriting = false;
        }
    }

    private async drainWriteBuffer(channel: number): Promise<void> {
        const chInfo = this.channels[channel];
        // 1. Calculate the start of this channel's descriptor
        // Control Block = ID (16) + MaxUp (4) + MaxDown (4) = 24 bytes header
        // Each descriptor is 24 bytes
        const descAddr = this.cbAddr + 24n + BigInt(this.numRdChannels) * 24n + BigInt(channel) * 24n;
        const rttDesc: RttBufferDescriptor = await this.readBufferDesc(descAddr);

        // Try to write as much as possible
        while (chInfo.wrBuffer.length > 0) {
            let spaceAvailable: number;
            if (rttDesc.rdOff <= rttDesc.wrOff) {
                // Free space is from wrOff to end, plus from start to rdOff - 1
                spaceAvailable = rttDesc.size - rttDesc.wrOff + (rttDesc.rdOff > 0 ? rttDesc.rdOff - 1 : 0);
            } else {
                // Free space is from wrOff to rdOff - 1
                spaceAvailable = rttDesc.rdOff - rttDesc.wrOff - 1;
            }

            if (spaceAvailable === 0) {
                // No space available, exit the loop. Catch next time.
                break;
            }

            const bytesToWrite = Math.min(spaceAvailable, chInfo.wrBuffer.length);

            // Write in a single chunk if possible
            if (rttDesc.wrOff + bytesToWrite <= rttDesc.size) {
                // Single chunk write
                const chunk = chInfo.wrBuffer.subarray(0, bytesToWrite);
                await this.memoryManager.writeMemoryBytes(BigInt(rttDesc.bufAddr + rttDesc.wrOff), chunk);
            } else {
                // Wrapped write
                const firstPartSize = rttDesc.size - rttDesc.wrOff;
                const firstPart = chInfo.wrBuffer.subarray(0, firstPartSize);
                await this.memoryManager.writeMemoryBytes(BigInt(rttDesc.bufAddr + rttDesc.wrOff), firstPart);

                const secondPartSize = bytesToWrite - firstPartSize;
                const secondPart = chInfo.wrBuffer.subarray(firstPartSize, firstPartSize + secondPartSize);
                await this.memoryManager.writeMemoryBytes(BigInt(rttDesc.bufAddr), secondPart);
            }

            // Update wrOff
            let newWrOff = rttDesc.wrOff + bytesToWrite;
            if (newWrOff >= rttDesc.size) {
                newWrOff -= rttDesc.size;
            }
            await this.memoryManager.writeWord(descAddr + 4n + BigInt(OFF_WROFF), newWrOff);

            // Remove written data from buffer
            chInfo.wrBuffer = chInfo.wrBuffer.subarray(bytesToWrite);
        }
    }

    private async readBufferDesc(descAddr: bigint): Promise<RttBufferDescriptor> {
        const [descBuffer, _] = await this.memoryManager.readMemoryBytes(descAddr + 4n, SIZEOF_RTT_BUFFER_DESC);
        const rttDesc: RttBufferDescriptor = {
            bufAddr: this.readUInt32(descBuffer, OFF_BUF),
            size: this.readUInt32(descBuffer, OFF_SIZE),
            wrOff: this.readUInt32(descBuffer, OFF_WROFF),
            rdOff: this.readUInt32(descBuffer, OFF_RDOFF),
            // flags: this.readUInt32(descBuffer, OFF_FLAGS),
        };
        return rttDesc;
    }

    // Start polling at regular intervals. We are either polling to find the RTT block, or to drain it.
    private startPoll(intervalMs: number) {
        this.pollingTimer = setInterval(async () => {
            try {
                if (this.liveWatchMonitor.enabled() === false) {
                    return;
                }
                let data: Buffer | null;
                const save = this.gdbInstance.debugFlags.gdbTraces;
                this.gdbInstance.debugFlags.gdbTraces = false; // Suppress gdb traces during polling
                if (!this.rttBlockFound) {
                    await this.doSearch();
                } else {
                    for (let ch = 0; ch < this.channels.length; ch++) {
                        const chInfo = this.channels[ch];
                        if (chInfo.inUse !== true) {
                            continue;
                        }
                        if (ch < this.numWrChannels) {
                            // Also try to write pending data
                            await this.drainWriteBuffer(ch);
                        }
                        if (ch < this.numRdChannels) {
                            const data = await this.tryDrainFromDevice(ch);
                            if (data && data.length > 0) {
                                this.transport?.onRttDataRead(ch, data);
                            }
                            if (this.sessionStatus === "stopped" && data === null) {
                                // If this session is no longer running, and there's no more data, stop polling
                                // Everything has been drained
                                clearInterval(this.pollingTimer!);
                                this.pollingTimer = null;
                            }
                        }
                    }
                }
            } catch (e) {
                this.gdbInstance.debugFlags.gdbTraces = true;
                // console.error("RTT Poll error:", e);
            }
        }, intervalMs);
    }

    onRunning() {
        this.sessionStatus = "running";
        if (!this.pollingTimer) {
            this.startPoll(this.intervalMs);
        }
    }

    onStopped() {
        this.sessionStatus = "stopped";
    }

    async doSearch(): Promise<void> {
        try {
            // Read the ID field (first 16 bytes)
            let [buffer] = await this.memoryManager.readMemoryBytes(this.cbAddr, 16);
            // const idString = idBuffer.toString("utf8").replace(/\0.*$/g, ""); // Trim at first null
            const idString = buffer.toString("utf8").replaceAll(/\0/g, ""); // Remove all null chars

            if (idString === this.searchStr) {
                this.rttBlockFound = true;
                this.mainSession.handleMsg(Stdout, `RTT Control Block found at 0x${this.cbAddr.toString(16)}. Search string: ${this.searchStr}\n`);
            }
            [buffer] = await this.memoryManager.readMemoryBytes(this.cbAddr + 16n, 8);
            this.numRdChannels = this.readUInt32(buffer, 0);
            this.numWrChannels = this.readUInt32(buffer, 4);
            for (let ch = 0; ch < this.numRdChannels; ch++) {
                if (this.channels[ch].inUse !== true) {
                    continue;
                }
                if (ch >= this.numRdChannels) {
                    this.mainSession.handleMsg(Stderr, `Warning: Configured RTT read channel ${ch} exceeds number of available up-channels ${this.numRdChannels}.\n`);
                }
                if (ch >= this.numWrChannels) {
                    this.mainSession.handleMsg(Stderr, `Warning: Configured RTT write channel ${ch} exceeds number of available down-channels ${this.numWrChannels}.\n`);
                }
            }
        } catch (e) {
            // console.error("RTT Search error:", e);
        }
    }
}

export class RttTcpServer extends EventEmitter implements RttTransport {
    private server: net.Server | null = null;
    private rttChannelToSocket: Map<number, Set<net.Socket>> = new Map(); // RTT Channel => Set of Sockets(clients)
    private ports: Map<number, number> = new Map(); // RTT Channel => TCP Port

    constructor(private mainSession: GDBDebugSession) {
        super();
    }

    // Im the future, we may support multiple channels
    async setPort(channels: number[]): Promise<void> {
        const helper = new RTTServerHelper();
        await helper.allocateRTTPorts(this.mainSession.args.rttConfig, true);
        for (const channel of channels) {
            const portStr = helper.rttLocalPortMap[channel];
            if (!portStr) {
                throw new Error(`No local port allocated for RTT channel ${channel}`);
            }
            const portNum = parseInt(portStr, 10);
            if (isNaN(portNum) || portNum <= 0 || portNum > 65535) {
                throw new Error(`Invalid port number allocated for RTT channel ${channel}: ${portStr}`);
            }
            this.ports.set(channel, portNum);
        }
        helper.emitConfigures(this.mainSession.args.rttConfig, this);
        const host = this.mainSession.args.rttConfig?.useBuiltinRTT?.hostName || "127.0.0.1";
        await this.start(host);
    }

    async start(host: string) {
        for (const [channel, port] of this.ports) {
            this.server = net.createServer((socket) => {
                // 1. Add new client
                this.rttChannelToSocket.get(channel)?.add(socket);
                this.mainSession.handleMsg(Stdout, `Client connected. Total clients: ${this.rttChannelToSocket.get(channel)?.size}`);
                this.emit("clientConnected", socket);

                // 2. Handle disconnection
                socket.on("close", () => {
                    this.rttChannelToSocket.get(channel)?.delete(socket);
                    this.mainSession.handleMsg(Stdout, `Client disconnected. Total clients: ${this.rttChannelToSocket.get(channel)?.size}`);
                });

                socket.on("data", (data: Buffer) => {
                    this.emit("dataToWrite", channel, data);
                });

                socket.on("error", (err) => {
                    this.mainSession.handleMsg(Stderr, `Socket error: ${err.message}`);
                    // 'close' will follow 'error', so deletion happens there
                });
            });
            this.rttChannelToSocket.set(channel, new Set<net.Socket>());

            this.server.listen(port, host, () => {
                this.mainSession.handleMsg(Stdout, `RTT TCP Server listening on port ${host}:${port}`);
            });
        }
    }

    /**
     * Broadcast to all currently connected clients
     */
    public broadcast(rttCh: number, data: Buffer) {
        for (const socket of this.rttChannelToSocket.get(rttCh) ?? []) {
            // Check if the socket is actually writable before sending
            if (socket.writable) {
                socket.write(data);
            }
        }
    }

    public onRttDataRead(rttCh: number, data: Buffer | null): void {
        if (!data || data.length === 0) {
            return;
        }
        this.broadcast(rttCh, data);
    }

    public dispose() {
        this.server?.close();
    }
}
