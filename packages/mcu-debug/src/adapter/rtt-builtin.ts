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

export interface RttTransport extends EventEmitter {
    onRttDataRead(data: Buffer): void;
    setPort(channel: number): Promise<void>;
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

    // In the future, we may support multiple channels
    private rdChannel: number = 0;
    private wrChannel: number = 0;
    private numRdChannels: number = 0;
    private numWrChannels: number = 0;
    private wrBuffer: Buffer = Buffer.alloc(0);
    private isBusyWriting: boolean = false;
    private pendingWrites: Buffer[] = [];

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
        this.transport.on("dataToWrite", async (data: Buffer, channel?: number) => {
            try {
                await this.writeToChannel(data);
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

            let foundChannel = false;
            for (const decoder of this.mainSession.args.rttConfig?.decoders || []) {
                if (typeof decoder.port === "number") {
                    if (foundChannel && decoder.port !== this.rdChannel) {
                        this.mainSession.handleMsg(Stderr, `Warning: Multiple RTT decoders with port numbers found. Using the first one: ${this.rdChannel}\n`);
                        continue;
                    }
                    this.rdChannel = decoder.port;
                    this.wrChannel = decoder.port;
                    foundChannel = true;
                }
            }

            await transport.setPort(this.rdChannel);
            if (!this.pollingTimer) {
                this.startPoll(100);
            }
        } catch (e) {
            this.mainSession.handleMsg(Stderr, `ERROR: Failed to set RTT consumer port: ${e instanceof Error ? e.message : String(e)}\n`);
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
    public async tryDrainFromDevice(): Promise<Buffer | null> {
        // 1. Calculate the start of this channel's descriptor
        // Control Block = ID (16) + MaxUp (4) + MaxDown (4) = 24 bytes header
        // Each descriptor is 24 bytes
        const descAddr = this.cbAddr + 24n + BigInt(this.rdChannel) * 24n;

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
        await this.memoryManager.writeWord(descAddr + BigInt(OFF_RDOFF), rttDesc.wrOff);

        return data;
    }

    public async writeToChannel(data: Buffer): Promise<void> {
        if (!this.rttBlockFound) {
            throw new Error("RTT Control Block not found. Cannot write data.");
        }
        if (data.length === 0 && this.wrBuffer.length === 0) {
            return;
        }

        this.pendingWrites.push(data);
        if (this.isBusyWriting) {
            // Queue the data for later writing
            return;
        }
        this.isBusyWriting = true;
        this.wrBuffer = Buffer.concat([...this.pendingWrites, this.wrBuffer]);
        this.pendingWrites = [];
        try {
            await this.drainWriteBuffer();
        } catch (e) {
            throw e;
        } finally {
            this.isBusyWriting = false;
        }
    }

    private async drainWriteBuffer(): Promise<void> {
        // 1. Calculate the start of this channel's descriptor
        // Control Block = ID (16) + MaxUp (4) + MaxDown (4) = 24 bytes header
        // Each descriptor is 24 bytes
        const descAddr = this.cbAddr + 24n + BigInt(this.numRdChannels) * 24n + BigInt(this.wrChannel) * 24n;

        const rttDesc: RttBufferDescriptor = await this.readBufferDesc(descAddr);

        // Try to write as much as possible
        while (this.wrBuffer.length > 0) {
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

            const bytesToWrite = Math.min(spaceAvailable, this.wrBuffer.length);

            // Write in a single chunk if possible
            if (rttDesc.wrOff + bytesToWrite <= rttDesc.size) {
                // Single chunk write
                const chunk = this.wrBuffer.subarray(0, bytesToWrite);
                await this.memoryManager.writeMemoryBytes(BigInt(rttDesc.bufAddr + rttDesc.wrOff), chunk);
            } else {
                // Wrapped write
                const firstPartSize = rttDesc.size - rttDesc.wrOff;
                const firstPart = this.wrBuffer.subarray(0, firstPartSize);
                await this.memoryManager.writeMemoryBytes(BigInt(rttDesc.bufAddr + rttDesc.wrOff), firstPart);

                const secondPartSize = bytesToWrite - firstPartSize;
                const secondPart = this.wrBuffer.subarray(firstPartSize, firstPartSize + secondPartSize);
                await this.memoryManager.writeMemoryBytes(BigInt(rttDesc.bufAddr), secondPart);
            }

            // Update wrOff
            let newWrOff = rttDesc.wrOff + bytesToWrite;
            if (newWrOff >= rttDesc.size) {
                newWrOff -= rttDesc.size;
            }
            await this.memoryManager.writeWord(descAddr + BigInt(OFF_WROFF), newWrOff);

            // Remove written data from buffer
            this.wrBuffer = this.wrBuffer.subarray(bytesToWrite);
        }
    }

    private async readBufferDesc(descAddr: bigint) {
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
                if (this.rttBlockFound) {
                    data = await this.tryDrainFromDevice();
                    await this.drainWriteBuffer();
                } else {
                    await this.doSearch();
                    data = null;
                }
                if (data && data.length > 0) {
                    this.transport?.onRttDataRead(data);
                }
                if (this.sessionStatus === "stopped" && data === null) {
                    // If this session is no longer running, and there's no more data, stop polling
                    // Everything has been drained
                    clearInterval(this.pollingTimer!);
                    this.pollingTimer = null;
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
            this.startPoll(50);
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
            [buffer] = await this.memoryManager.readMemoryBytes(this.cbAddr, 8);
            this.numRdChannels = this.readUInt32(buffer, 0);
            this.numWrChannels = this.readUInt32(buffer, 4);
            if (this.rdChannel >= this.numRdChannels) {
                this.mainSession.handleMsg(Stderr, `ERROR: Configured RTT read channel ${this.rdChannel} exceeds number of available up-channels ${this.numRdChannels}.\n`);
            }
            if (this.wrChannel >= this.numWrChannels) {
                this.mainSession.handleMsg(Stderr, `ERROR: Configured RTT write channel ${this.wrChannel} exceeds number of available down-channels ${this.numWrChannels}.\n`);
            }
        } catch (e) {
            // console.error("RTT Search error:", e);
        }
    }
}

export class RttTcpServer extends EventEmitter implements RttTransport {
    private server: net.Server | null = null;
    private clients: Set<net.Socket> = new Set();
    private port: number = 19021; // Default RTT port

    constructor(private mainSession: GDBDebugSession) {
        super();
    }

    // Im the future, we may support multiple channels
    async setPort(channel: number): Promise<void> {
        const helper = new RTTServerHelper();
        await helper.allocateRTTPorts(this.mainSession.args.rttConfig, true);
        const portStr = helper.rttLocalPortMap[channel];
        if (!portStr) {
            throw new Error(`No local port allocated for RTT channel ${channel}`);
        }
        const portNum = parseInt(portStr, 10);
        if (isNaN(portNum) || portNum <= 0 || portNum > 65535) {
            throw new Error(`Invalid port number allocated for RTT channel ${channel}: ${portStr}`);
        }
        this.port = portNum;
        helper.emitConfigures(this.mainSession.args.rttConfig, this);
        await this.start();
    }

    async start() {
        this.server = net.createServer((socket) => {
            // 1. Add new client
            this.clients.add(socket);
            this.mainSession.handleMsg(Stdout, `Client connected. Total clients: ${this.clients.size}`);
            this.emit("clientConnected", socket);

            // 2. Handle disconnection
            socket.on("close", () => {
                this.clients.delete(socket);
                this.mainSession.handleMsg(Stdout, `Client disconnected. Total clients: ${this.clients.size}`);
            });

            socket.on("data", (data: Buffer) => {
                this.emit("dataToWrite", data);
            });

            socket.on("error", (err) => {
                this.mainSession.handleMsg(Stderr, `Socket error: ${err.message}`);
                // 'close' will follow 'error', so deletion happens there
            });
        });

        this.server.listen(this.port, "127.0.0.1", () => {
            this.mainSession.handleMsg(Stdout, `RTT TCP Server listening on port ${this.port}`);
        });
    }

    /**
     * Broadcast to all currently connected clients
     */
    public broadcast(data: Buffer) {
        for (const socket of this.clients) {
            // Check if the socket is actually writable before sending
            if (socket.writable) {
                socket.write(data);
            }
        }
    }

    public onRttDataRead(data: Buffer | null): void {
        if (!data || data.length === 0) {
            return;
        }
        this.broadcast(data);
    }

    public dispose() {
        this.server?.close();
    }
}
