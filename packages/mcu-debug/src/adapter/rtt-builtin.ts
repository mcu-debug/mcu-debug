import * as net from "net";
import { GdbInstance } from "./gdb-mi/gdb-instance";
import { GDBDebugSession } from "./gdb-session";
import { LiveWatchMonitor } from "./live-watch-monitor";
import { MemoryRequests } from "./memory";
import { TargetInfo } from "./target-info";
import { GdbEventNames, Stderr, Stdout } from "./gdb-mi/mi-types";
import { parseAddress } from "../frontend/utils";
import { RTTConfiguration, RTTServerHelper } from "./servers/common";
import { EventEmitter } from "events";
import { DebugProtocol } from "@vscode/debugprotocol";
import { Decoder, DecoderSpec } from "@mcu-debug/shared";

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
    dispose(): void;
}

export class RttBufferManager extends EventEmitter {
    private gdbInstance: GdbInstance;
    private mainSession: GDBDebugSession;
    private memoryManager: MemoryRequests;
    private endianness: "little" | "big";
    private sessionStatus: "running" | "stopped" | "none" = "none";
    private rttBlockFound = false;
    private transport: RttTransport | null = null;
    private cbAddr: bigint = 0n; // Address of _SEGGER_RTT (RTT Control Block)
    private searchStr: string = "SEGGER RTT";
    private intervalMs = 100; // ms
    private measureThroughput = true;
    private throughputMonitor: ThroughputMonitor;

    // In the future, we may support multiple channels
    private numRdChannels: number = 0;
    private numWrChannels: number = 0;
    private channels: RttChannelConfig[] = [];
    private isBusyWriting: boolean = false;
    private config: RTTConfiguration | null = null;
    private disableRtt = false;
    private initialized = false;

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
        this.throughputMonitor = new ThroughputMonitor(this.mainSession);
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
            this.config = this.mainSession.args.pvtRttConfig;
            if (!this.config || !this.config.enabled) {
                throw new Error("RTT is not enabled in the configuration. This method should not have been called.");
            }
            this.intervalMs = this.config?.polling_interval ?? 100;
            if (this.intervalMs < 50) {
                // Something less than 50, allow it, but warn
                this.mainSession.handleMsg(Stderr, "Warning: RTT polling interval too low. Setting to minimum of 50 ms.\n");
            }

            this.cbAddr = parseAddress(this.config?.address || "0");
            if (this.cbAddr === 0n || this.cbAddr === BigInt(-1) || isNaN(Number(this.cbAddr))) {
                this.mainSession.handleMsg(Stderr, "ERROR: RTT Control Block address if invalid or not specified.\n");
                this.disableRtt = true;
            }
            this.searchStr = this.config?.searchId || this.searchStr;
            if (this.searchStr.length > 16) {
                this.mainSession.handleMsg(Stderr, "Warning: RTT search ID longer than 16 characters. It will be truncated.\n");
                this.searchStr = this.searchStr.substring(0, 16);
            }

            const channelNums: number[] = [];
            let maxChannel = -1;
            for (const decoder of this.config?.decoders || []) {
                if (typeof decoder.port === "number") {
                    channelNums.push(decoder.port);
                    maxChannel = Math.max(maxChannel, decoder.port);
                }
            }
            for (let ch = 0; ch <= maxChannel; ch++) {
                this.channels.push(new RttChannelConfig(ch));
                if (channelNums.indexOf(ch) >= 0) {
                    this.channels[ch].inUse = true;
                }
            }

            this.setTransport(transport);
            await transport.setPort(channelNums);
            this.initialized = true;
            this.startPoll();
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
        try {
            const updateWriteForChunk = async (chunk: Buffer) => {
                return new Promise<void>(async (resolve, reject) => {
                    this.transport?.onRttDataRead(channel, chunk);
                    if (this.measureThroughput) {
                        this.throughputMonitor.record(chunk);
                    }
                    // 4. Move the pointer to unblock FW
                    // We write back to the descriptor's RdOff location
                    const writeValue = rttDesc.rdOff + chunk.length;
                    rttDesc.rdOff = writeValue % rttDesc.size;
                    if (rttDesc.rdOff !== writeValue && writeValue > rttDesc.size) {
                        throw new Error(`RTT read pointer wrap-around logic error on channel ${channel}`);
                    }
                    // We don't worry about wrapping here because we don't do reads requests that go beyond buffer size
                    await this.memoryManager.writeWord(descAddr + 4n + BigInt(OFF_RDOFF), rttDesc.rdOff);
                    resolve();
                });
            };
            // 1. Calculate the start of this channel's descriptor
            // Control Block = ID (16) + MaxUp (4) + MaxDown (4) = 24 bytes header
            // Each descriptor is 24 bytes
            const descAddr = this.cbAddr + 24n + BigInt(channel) * 24n;
            const rttDesc: RttBufferDescriptor = await this.readBufferDesc(descAddr);
            if (rttDesc.wrOff === rttDesc.rdOff) return null; // Buffer empty

            let data: Buffer;
            let totalBytes;

            // 3. Circular Buffer Logic
            if (rttDesc.wrOff > rttDesc.rdOff) {
                // Linear: [....Rd----Wr....]
                const len = rttDesc.wrOff - rttDesc.rdOff;
                data = await this.memoryManager.readMemoryBytes(BigInt(rttDesc.bufAddr + rttDesc.rdOff), len, updateWriteForChunk);
                totalBytes = len;
            } else {
                // Wrapped: [---Wr....Rd----]
                const len1 = rttDesc.size - rttDesc.rdOff;
                const part1 = await this.memoryManager.readMemoryBytes(BigInt(rttDesc.bufAddr + rttDesc.rdOff), len1, updateWriteForChunk);

                const len2 = rttDesc.wrOff;
                const part2 = await this.memoryManager.readMemoryBytes(BigInt(rttDesc.bufAddr), len2, updateWriteForChunk);

                data = Buffer.concat([part1, part2]);
                totalBytes = len1 + len2;
            }

            /*
            // 4. Move the pointer to unblock FW
            // We write back to the descriptor's RdOff location
            await this.memoryManager.writeWord(descAddr + 4n + BigInt(OFF_RDOFF), rttDesc.wrOff);

            if (this.measureThroughput) {
                this.throughputMonitor.record(data);
            }
            
            if (data.length != totalBytes) {
                this.mainSession.handleMsg(Stderr, `Error: RTT read size mismatch on channel ${channel}. Expected ${totalBytes}, got ${data.length}\n`);
                throw new Error(`RTT read size mismatch on channel ${channel}. Expected ${totalBytes}, got ${data.length}`);
            }
                */
            return data;
        } catch (e) {
            this.mainSession.handleMsg(Stderr, `RTT Read error on channel ${channel}: ${e instanceof Error ? e.message : String(e)}\n`);
            throw e;
        }
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
            this.mainSession.handleMsg(Stderr, `RTT Write error on channel ${channel}: ${e instanceof Error ? e.message : String(e)}\n`);
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
        const descBuffer = await this.memoryManager.readMemoryBytes(descAddr + 4n, SIZEOF_RTT_BUFFER_DESC);
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
    private async startPoll() {
        if (this.disableRtt) {
            return;
        }
        let stop = false;
        if (this.sessionStatus === "stopped") {
            stop = true;
        }
        await this.doInnerPoll();
        if (!stop) {
            setTimeout(() => {
                this.startPoll();
            }, this.intervalMs);
        }
    }

    private async doInnerPoll() {
        try {
            if (this.disableRtt) {
                return;
            }
            if (!this.rttBlockFound) {
                await this.doSearch();
            } else {
                for (let ch = 0; ch < this.channels.length; ch++) {
                    const chInfo = this.channels[ch];
                    if (!chInfo) {
                        throw new Error(`RTT Channel info not found for channel ${ch}`);
                    }
                    if (chInfo.inUse !== true) {
                        continue;
                    }
                    if (ch < this.numWrChannels) {
                        // Also try to write pending data
                        await this.drainWriteBuffer(ch);
                    }
                    if (ch < this.numRdChannels) {
                        const data = await this.tryDrainFromDevice(ch);
                        /*
                        if (data && data.length > 0) {
                            this.transport?.onRttDataRead(ch, data);
                        }
                            */
                    }
                }
            }
        } catch (e) {
            // console.error("RTT Poll error:", e);
        }
    }

    onRunning() {
        this.sessionStatus = "running";
        if (this.initialized) {
            this.startPoll();
            this.throughputMonitor = new ThroughputMonitor(this.mainSession);
        }
    }

    onStopped() {
        this.sessionStatus = "stopped";
    }

    async doSearch(): Promise<void> {
        try {
            // Read the ID field (first 16 bytes)
            let buffer = await this.memoryManager.readMemoryBytes(this.cbAddr, 16);
            // const idString = idBuffer.toString("utf8").replace(/\0.*$/g, ""); // Trim at first null
            const idString = buffer.toString("utf8").replaceAll(/\0/g, ""); // Remove all null chars

            if (idString === this.searchStr) {
                this.rttBlockFound = true;
                this.mainSession.handleMsg(Stdout, `RTT Control Block found at 0x${this.cbAddr.toString(16)}. Search string: '${this.searchStr}'\n`);
                buffer = await this.memoryManager.readMemoryBytes(this.cbAddr + 16n, 8);
                this.numRdChannels = this.readUInt32(buffer, 0);
                this.numWrChannels = this.readUInt32(buffer, 4);
                if (this.numRdChannels > 16 || this.numWrChannels > 16) {
                    this.mainSession.handleMsg(Stderr, `Warning: RTT reported number of channels seems too high. Read: ${this.numRdChannels} read channels, ${this.numWrChannels} write channels.\n`);
                    throw new Error("Aborting RTT setup due to invalid number of channels.");
                    this.disableRtt = true;
                }
            }
        } catch (e) {
            if (!this.rttBlockFound) {
                this.mainSession.handleMsg(Stderr, `RTT Search error: ${e}\n`);
            } else {
                this.mainSession.handleMsg(Stderr, `Aborting: Could not read RTT Control Block: ${e}\n`);
                this.disableRtt = true;
            }
            throw e;
        }
    }

    dispose() {
        this.disableRtt = true;
        this.transport?.dispose();
    }
}

export class RttTcpServer extends EventEmitter implements RttTransport {
    private server: net.Server | null = null;
    private decoders: Map<number, Decoder | null> = new Map(); // RTT Channel => Decoder
    private rttChannelToSocket: Map<number, Set<net.Socket>> = new Map(); // RTT Channel => Set of Sockets(clients)
    private ports: Map<number, number> = new Map(); // RTT Channel => TCP Port
    private config: RTTConfiguration | null = null;

    constructor(private mainSession: GDBDebugSession) {
        super();
    }

    // Im the future, we may support multiple channels
    async setPort(channels: number[]): Promise<void> {
        this.config = this.mainSession.args.pvtRttConfig;
        if (!this.config || !this.config.enabled) {
            throw new Error("RTT configuration not found or not enabled. This method should not have been called.");
        }
        const helper = new RTTServerHelper();
        await helper.allocateRTTPorts(this.config, true);
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
        helper.emitConfigures(this.config, this);
        const host = this.config?.useBuiltinRTT?.hostName || "127.0.0.1";
        await this.start(host);
    }

    async start(host: string) {
        for (const [channel, port] of this.ports) {
            const preDecoder = this.config?.pre_decoder;
            const usePredecoder = (preDecoder && !preDecoder?.channels?.length) || (preDecoder?.channels && preDecoder.channels.indexOf(channel) >= 0);
            if (usePredecoder) {
                this.mainSession.handleMsg(Stdout, `Starting RTT TCP Server with pre-decoder on port ${host}:${port} for channel ${channel}\n`);
            } else {
                this.mainSession.handleMsg(Stdout, `Starting RTT TCP Server on port ${host}:${port} for channel ${channel}\n`);
            }
            let preDec: Decoder | null = null;
            if (usePredecoder && preDecoder) {
                for (const [ix, arg] of (preDecoder.args || []).entries()) {
                    preDecoder.args[ix] = arg.replace("${executable}", this.mainSession.args.executable || "unknown.elf");
                }
                try {
                    preDec = new Decoder(preDecoder as DecoderSpec);
                    await preDec.runProgram();
                    this.mainSession.handleMsg(Stdout, `RTT pre-decoder started for channel ${channel} using program: ${preDecoder.program} ${preDecoder.args?.join(" ")}\n`);
                } catch (e) {
                    this.mainSession.handleMsg(Stderr, `ERROR: Failed to start RTT pre-decoder: ${e instanceof Error ? e.message : String(e)}\n`);
                }
            }
            this.server = net.createServer((socket) => {
                // 1. Add new client
                this.rttChannelToSocket.get(channel)?.add(socket);
                this.mainSession.handleMsg(Stdout, `Client connected to RTT channel: ${channel}. Total clients: ${this.rttChannelToSocket.get(channel)?.size}`);
                this.emit("clientConnected", socket);

                // 2. Handle disconnection
                socket.on("close", () => {
                    this.rttChannelToSocket.get(channel)?.delete(socket);
                    this.mainSession.handleMsg(Stdout, `Client disconnected from RTT channel: ${channel}. Total clients: ${this.rttChannelToSocket.get(channel)?.size}`);
                });

                socket.on("data", (data: Buffer) => {
                    this.emit("dataToWrite", channel, data);
                });

                socket.on("error", (err) => {
                    this.mainSession.handleMsg(Stderr, `Socket error: ${err.message}`);
                    // 'close' will follow 'error', so deletion happens there
                });
            });

            if (preDec) {
                // Any data from pre-decoder is RTT data to broadcast
                preDec.on("stdout", (data: Buffer) => {
                    if (data && data.length > 0) {
                        this.broadcast(channel, data);
                    }
                });
                preDec.on("stderr", (data: Buffer) => {
                    this.mainSession.handleMsg(Stderr, `RTT Pre-decoder STDERR (channel ${channel}): ${data.toString()}`);
                });
                preDec.on("error", (err: Error) => {
                    this.mainSession.handleMsg(Stderr, `RTT Pre-decoder ERROR (channel ${channel}): ${err.message}`);
                });
            }

            this.decoders.set(channel, preDec);
            this.rttChannelToSocket.set(channel, new Set<net.Socket>());

            this.server.listen(port, host, () => {
                this.mainSession.handleMsg(Stdout, `RTT TCP Server listening on port ${host}:${port} for channel ${channel}\n`);
            });
        }
    }

    /**
     * Broadcast to all currently connected clients
     */
    private broadcast(rttCh: number, data: Buffer) {
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
        const preDecoder = this.decoders.get(rttCh);
        if (preDecoder) {
            preDecoder.writeStdin(data);
        } else {
            this.broadcast(rttCh, data);
        }
    }

    public dispose() {
        if (this.server) {
            for (const decoder of this.decoders.values()) {
                decoder?.dispose();
            }
            this.server.close();
            this.removeAllListeners();
        }
    }
}

export class ThroughputMonitor {
    private totalBytes = 0;
    private messageCount = 0;
    private startTime = Date.now();
    private lastReportTime = Date.now();

    constructor(private mainSession: GDBDebugSession) {}

    /** Call this inside your RTT poll logic when data arrives */
    public record(buffer: Buffer, msgCount: number = 1) {
        if (this.messageCount === 0) {
            this.startTime = Date.now();
            this.lastReportTime = this.startTime;
        }
        this.totalBytes += buffer.length;
        this.messageCount += msgCount;

        const now = Date.now();
        const delta = now - this.lastReportTime;

        // Report every 5 seconds
        if (delta > 5000) {
            this.report(delta);
            this.lastReportTime = now;
        }
    }

    public report(deltaMs: number) {
        const seconds = deltaMs / 1000;
        const bps = (this.totalBytes / seconds).toFixed(2);
        const msgPerSec = (this.messageCount / seconds).toFixed(1);
        const uptime = ((Date.now() - this.startTime) / 1000).toFixed(1);

        this.mainSession.handleMsg(Stdout, `[RTT Stats] Uptime: ${uptime}s | ${bps} Bytes/sec | ${msgPerSec} Msgs/sec`);

        // Reset counters for next window
        this.totalBytes = 0;
        this.messageCount = 0;
    }
}
