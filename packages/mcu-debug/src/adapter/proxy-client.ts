import * as net from "net";
import * as fs from "fs";
import * as path from "path";
import { GDBDebugSession } from "./gdb-session";
import { GDBServerSession, getEnvFromConfig } from "./server-session";
import { canonicalizePath, ConfigurationArguments, TcpPortDef, TcpPortDefMap, awaitWithTimeout } from "./servers/common";
import { Stderr, Stdout } from "./gdb-mi/mi-types";
import { ControlMessage } from "@mcu-debug/shared/proxy-protocol/ControlMessage";
import { PortReserved } from "@mcu-debug/shared/proxy-protocol/PortReserved";
import { PortSet } from "@mcu-debug/shared/proxy-protocol/PortSet";
import { PortAllocatorSpec } from "@mcu-debug/shared/proxy-protocol/PortAllocatorSpec";
import { EventEmitter } from "stream";
import * as crypto from "crypto";
import { glob, GlobOptions } from "glob";
import { isUnsafeRelativeSyncPath, resolveSyncRelativePathForFile } from "./sync-files-utils";

type StreamStatus = "starting" | "connected" | "ready" | "timedOut" | "closed";

const traceTraffic = false;

export class PortReservedInfo {
    constructor(
        public port: number,
        public stream_id: number,
        public stream_id_str: string,
        public status: StreamStatus = "starting",
    ) { }
}

export class ProxyClient extends EventEmitter {
    private endingSession: boolean = false;
    private pendingPromises: Map<number, { resolve: (value: any) => void; reject: (reason?: any) => void }> = new Map();
    private timeout = 20 * 1000; // 20 seconds
    private nextSeq: number = 1;
    private args: ConfigurationArguments;
    private socket: net.Socket | null = null;
    private clientStreams: Map<number, RemoteServer> = new Map();
    private heartbeatTimer: NodeJS.Timeout | null = null;
    private cwd: string = process.cwd();
    constructor(
        public session: GDBDebugSession,
        public serverSession: GDBServerSession,
    ) {
        super();
        this.args = session.args;
    }

    public logDebug(message: string) {
        if (this.session.args.debugFlags.anyFlags) {
            this.session.handleMsg(Stdout, `[proxy-client] ${message}`);
        }
    }

    public logInfo(message: string) {
        this.session.handleMsg(Stdout, `[proxy-client] ${message}`);
    }

    public logError(message: string) {
        this.session.handleMsg(Stderr, `[proxy-client] ${message}`);
    }

    async start(): Promise<boolean> {
        this.args = this.session.args;
        if (!this.args.hostConfig) {
            return false;
        }
        const networkMode = this.args.hostConfig.pvtNetworkMode || this.args.hostConfig.type;
        const remoteHost = this.args.hostConfig.pvtProxyHost || "127.0.0.1";
        const remotePort = this.args.hostConfig.pvtProxyPort || 4567;
        const token = this.args.hostConfig.token || this.args.hostConfig.pvtProxyToken || "adis-ababa";
        this.logInfo(`Starting proxy client with network mode: ${networkMode}, remote host: ${remoteHost}, remote port: ${remotePort}, token: ${token}`);
        try {
            if (!(await this.connectToProxy(remoteHost, remotePort))) {
                this.logError(`Failed to connect to proxy on ${remoteHost}:${remotePort} (network mode: ${networkMode}). Please ensure the proxy is running.`);
                return false;
            }
        } catch (err) {
            this.logError(`Failed to connect to proxy (network mode: ${networkMode}). Please ensure the proxy is running and accessible. ${err}`);
            return false;
        }
        try {
            let cwd = canonicalizePath(this.args.cwd || process.cwd());
            let cdir = crypto.createHash("sha256").update(cwd).digest("hex");
            cdir = cdir.length > 16 ? cdir.substring(0, 16) : cdir;
            let sdir = crypto.createHash("sha256").update(this.args.name).digest("hex");
            sdir = sdir.length > 16 ? sdir.substring(0, 16) : sdir;
            const cmd: ControlMessage = {
                seq: this.nextSeq++,
                method: "initialize",
                params: {
                    token: token,
                    version: "1.0.3",
                    workspace_uid: cdir,
                    session_uid: sdir,
                    port_wait_mode: "monitor",
                },
            };
            await awaitWithTimeout(this.sendControlCommand(cmd), this.timeout);
            this.logDebug(`Proxy session initialized`);
            this.cwd = cwd;
            return true;
        } catch (err) {
            this.logError(`Failed to initialize proxy session: ${err}`);
            return false;
        }
    }

    /**
     * Sync files listed in hostConfig.syncFiles.
     *
     * Each entry has the shape:
     *   { local: string, remote?: string }
     *
     * local:
     * - A glob pattern (resolved from launch/attach configuration "cwd"), or
     * - A direct file path (absolute or relative).
     *
     * remote:
     * - Optional destination path on the remote side.
     * - Always interpreted relative to the proxy session root directory on the server.
     * - Must be a safe relative path (no absolute paths, no ".." traversal).
     *
     * Destination behavior:
     * - If a matched local file is inside this.cwd:
     *   - Preserve its path relative to this.cwd.
     *   - If remote is provided, prepend remote as a base directory.
     * - If a matched local file is outside this.cwd:
     *   - If remote is provided and only one file is matched, remote is treated as the exact destination file path.
     *   - If remote is provided and multiple files are matched, remote is treated as a directory and each basename is appended.
     *   - If remote is omitted, fall back to the local basename at session root.
     *
     * Notes:
     * - Paths sent to the server always use forward slashes for cross-platform consistency.
     * - The server creates parent directories under the session root as needed.
     * - There are limits on the number (20) and size (100 KB) of files that can be synced to prevent abuse and performance issues.
     */
    private async syncFiles() {
        const cwd = this.cwd;
        const syncFiles = this.session.args.hostConfig?.syncFiles || [];
        let counter = 0;
        const maxFiles = 20; // Limit the number of files to sync to prevent abuse and performance issues
        let hitMaxFiles = false;
        let hadSyncFailures = false;
        const maxFileSize = 10 * 1024 * 1024; // 10 MB limit for syncing files, we don't want to accidentally try to sync huge files
        for (const file of syncFiles) {
            if (hitMaxFiles) {
                break;
            }
            const localPattern = file.local;
            if (!localPattern) {
                continue;
            }
            const remotePath = file.remote ? canonicalizePath(file.remote, false) : "";
            if (remotePath && (path.isAbsolute(remotePath) || isUnsafeRelativeSyncPath(remotePath))) {
                this.logError(`Security violation: Remote path for syncing files must be a relative path. Skipping sync for pattern ${localPattern} with remote path ${remotePath}`);
                hadSyncFailures = true;
                continue;
            }
            try {
                const directPath = path.isAbsolute(localPattern) ? localPattern : path.resolve(cwd, localPattern);
                const files = fs.existsSync(directPath) ? [directPath] : await this.findFiles(cwd, localPattern);
                const remoteMustBeDir = files.length > 1;
                for (const f of files) {
                    if (counter >= maxFiles) {
                        this.logError(`Reached maximum number of files to sync (${maxFiles}). Skipping remaining files.`);
                        hadSyncFailures = true;
                        hitMaxFiles = true;
                        break;
                    }
                    counter++;
                    try {
                        const localFilePath = path.isAbsolute(f) ? f : path.resolve(cwd, f);
                        const stats = fs.statSync(localFilePath);
                        if (stats.isDirectory()) {
                            this.logError(`Path ${f} is a directory, skipping. Syncing directories is not supported yet`);
                            hadSyncFailures = true;
                            continue;
                        }
                        if (stats.size > maxFileSize) {
                            // 10 MB limit for syncing files, we don't want to accidentally try to sync huge files
                            this.logError(`File ${f} is too large to sync (${stats.size} bytes), skipping`);
                            hadSyncFailures = true;
                            continue;
                        }
                        const content = Buffer.from(fs.readFileSync(localFilePath)).toJSON().data as Array<number>;

                        const rPath = resolveSyncRelativePathForFile(cwd, localFilePath, remotePath || "", remoteMustBeDir);
                        if (!rPath) {
                            this.logError(`Security violation or potential bug: Destination path for syncing files must be a relative path. Skipping sync for file ${f}`);
                            hadSyncFailures = true;
                            continue;
                        }
                        const cmd: ControlMessage = {
                            seq: this.nextSeq++,
                            method: "syncFile",
                            params: {
                                relative_path: rPath,
                                content: content,
                            },
                        };
                        this.logDebug(`Syncing file ${f} to remote path ${rPath} with size ${content.length} bytes`);
                        await awaitWithTimeout(this.sendControlCommand(cmd), this.timeout).catch((err) => {
                            hadSyncFailures = true;
                            this.logError(`Failed to sync file ${f} to ${remotePath}: ${err}`);
                        });
                    } catch (err) {
                        hadSyncFailures = true;
                        this.logError(`Failed to read file for syncing: ${f}, error: ${err}`);
                    }
                }
            } catch (err) {
                hadSyncFailures = true;
                this.logError(`Failed to find files for syncing with pattern ${localPattern}: ${err}`);
            }
        }

        if (hadSyncFailures) {
            throw new Error("hostConfig.syncFiles failed");
        }
    }

    private async findFiles(cwd: string, globPattern: string): Promise<string[]> {
        try {
            const options: GlobOptions = {
                cwd: cwd,
                nodir: true,
                absolute: false,
                follow: false,
            };
            const files = (await glob(globPattern, options)) as string[];
            return files;
        } catch (error) {
            this.logError(`Failed to find files with pattern ${globPattern} in ${cwd}: ${error}`);
            return [];
        }
    }

    private sendControlCommand(cmd: ControlMessage): Promise<any> {
        if (!this.socket) {
            this.logError("Proxy socket is not connected");
            return Promise.reject(new Error("Proxy socket is not connected"));
        }
        const msg = JSON.stringify(cmd);
        const buffer = Buffer.from(msg, "utf-8");
        this.sendCommandBytes(0, buffer);
        const ret = new Promise((resolve, reject) => {
            this.pendingPromises.set(cmd.seq, { resolve, reject });
        });
        return ret;
    }

    public sendCommandBytes(stream_id: number, data: Buffer) {
        if (!this.socket) {
            this.logError("Proxy socket is not connected");
            return;
        }
        const header = Buffer.alloc(5);
        header.writeUInt8(stream_id, 0);
        header.writeUInt32LE(data.length, 1);
        this.socket.write(Buffer.concat([header, data]));
    }

    async stop(): Promise<void> {
        this.endingSession = true;
        this.stopHeartbeat();
        if (this.socket) {
            // Only send endSession if the socket is still connected — mirrors the non-proxy
            // pattern of checking exitCode before killing the local gdb-server process.
            // If the socket is already gone, the remote gdb-server has already exited.
            const cmd: ControlMessage = {
                seq: this.nextSeq++,
                method: "endSession",
            };
            try {
                await awaitWithTimeout(this.sendControlCommand(cmd), this.timeout);
            } catch (err) {
                this.logError(`Failed to end proxy session: ${err}`);
            }
            // Half-close our write side, then wait for the Rust proxy to close the
            // connection from its side. The Rust proxy kills the gdb-server process
            // asynchronously after sending the endSession response; if we immediately
            // tear down the forwarding streams, the sudden stream closures race with
            // (and can preempt) that kill. Waiting for the socket close event ensures
            // the Rust side has finished cleanup before we destroy local streams.
            // A 2-second fallback covers the case where Rust never closes the socket.
            if (this.socket) {
                const sock = this.socket;
                await new Promise<void>((resolve) => {
                    const timer = setTimeout(() => {
                        sock.destroy();
                        resolve();
                    }, 2000);
                    sock.once("close", () => {
                        clearTimeout(timer);
                        resolve();
                    });
                    sock.end();
                });
            }
        }
        this.socket = null;
        for (const [stream_id, stream] of this.clientStreams) {
            stream.close();
        }
        this.clientStreams.clear();
    }

    private connectToProxy(host: string, port: number): Promise<boolean> {
        return new Promise((resolve) => {
            this.logInfo(`Attempting to connect to proxy on ${host}:${port}...`);
            const socket = new net.Socket();
            socket.once("connect", () => {
                this.logInfo(`Successfully connected to proxy on ${host}:${port}`);
                this.socket = socket;
                resolve(true);
            });
            socket.once("error", (e) => {
                this.logError(`Error connecting to proxy on ${host}:${port} - ${e.message}`);
                socket.destroy();
                resolve(false);
            });
            /*
            socket.once("timeout", () => {
                socket.destroy();
                resolve(false);
            });
            socket.setTimeout(1000);
            */
            socket.connect(port, host);
            socket.on("data", (data: Buffer) => {
                this.handleProxyData(data);
            });
            socket.on("close", () => {
                this.logInfo("Proxy connection closed");
                this.stopHeartbeat();
                this.socket = null;
            });
        });
    }

    private async waitForProxyReady(host: string, port: number, timeoutMs: number, retryDelayMs: number): Promise<boolean> {
        const deadline = Date.now() + timeoutMs;
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs * 2));
        while (true) {
            if (await this.connectToProxy(host, port)) {
                return true;
            }
            if (Date.now() > deadline) {
                return false;
            }
            await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        }
        return false;
    }

    private streamStrToPortInfo: Map<string, PortReservedInfo> = new Map();
    private streamIdToPortInfo: Map<number, PortReservedInfo> = new Map();
    // clientPorts is a map of a port id string to an actual port on the local machine. The proxy will map these
    // to the ports on the remote machine and handle the forwarding
    private clientPorts: TcpPortDefMap = {};
    allocatePorts(ports: TcpPortDefMap): Promise<TcpPortDefMap> {
        return new Promise<TcpPortDefMap>(async (resolve, reject) => {
            this.clientPorts = ports;
            const portList = Object.keys(ports);
            const portSet: PortSet = {
                start_port: 37000, // Just a random high port, proxy will find the actual free ports
                port_ids: portList,
            };
            const portspec: PortAllocatorSpec = {
                all_ports: [portSet],
            };
            const cmd: ControlMessage = {
                seq: this.nextSeq++,
                method: "allocatePorts",
                params: {
                    ports_spec: portspec,
                },
            };
            try {
                const ret = (await awaitWithTimeout(this.sendControlCommand(cmd), this.timeout)) as any;
                const ports = ret?.allocatePorts?.ports;
                for (const p of ports || []) {
                    const port = p as PortReserved;
                    const portRef = this.clientPorts[port.stream_id_str];
                    if (portRef) {
                        portRef.remotePort = port.port;
                    }
                    const portInfo = new PortReservedInfo(port.port, port.stream_id, port.stream_id_str, "starting");
                    this.streamStrToPortInfo.set(port.stream_id_str, portInfo);
                    this.streamIdToPortInfo.set(port.stream_id, portInfo);
                }
                resolve(this.clientPorts);
            } catch (err) {
                this.logError(`Failed to allocate ports: ${err}`);
                reject(err);
            }
        });
    }

    async launchServer(executable: string, args: string[], serverCwd: string, regexes: RegExp[]): Promise<void> {
        this.startHeartbeat();
        await this.syncFiles();
        const cmd: ControlMessage = {
            seq: this.nextSeq++,
            method: "startGdbServer",
            params: {
                config_args: this.session.args,
                server_path: executable,
                server_args: args,
                server_env: getEnvFromConfig(this.session.args),
                // server_cwd: serverCwd,
                server_regexes: regexes.map((r) => r.source),
            },
        };
        return awaitWithTimeout(this.sendControlCommand(cmd), this.timeout);
    }

    private msgBuffer: Buffer = Buffer.alloc(0);
    private proxyBufferBusy: boolean = false;
    private async handleProxyData(data: Buffer) {
        this.msgBuffer = Buffer.concat([this.msgBuffer, data]);
        if (this.proxyBufferBusy) {
            return;
        }
        this.proxyBufferBusy = true;
        while (this.msgBuffer.length >= 5) {
            const stream_id = this.msgBuffer.readUInt8(0);
            const length = this.msgBuffer.readUInt32LE(1);
            if (this.msgBuffer.length < 5 + length) {
                // Wait for the full message to arrive
                break;
            }
            const payload = this.msgBuffer.subarray(5, 5 + length);
            await this.msgPromise;
            this.handleProxyMessage(stream_id, payload);
            this.msgBuffer = this.msgBuffer.subarray(5 + length);
        }
        this.proxyBufferBusy = false;
    }

    private msgPromise = Promise.resolve();
    private handleProxyMessage(stream_id: number, payload: Buffer) {
        this.msgPromise = new Promise((resolve) => {
            this.handleProxyMessageInternal(stream_id, payload);
            resolve();
        });
    }

    private handleProxyMessageInternal(stream_id: number, payload: Buffer) {
        try {
            if (stream_id !== 0) {
                if (stream_id <= 2) {
                    this.serverSession.writeToConsole(payload);
                    return;
                }
                let stream = this.clientStreams.get(stream_id);
                if (stream) {
                    stream.dataFromServer(payload, stream_id);
                } else {
                    this.logError(`Received data for unknown stream_id ${stream_id}`);
                }
                return;
            }
            const msg = JSON.parse(payload.toString("utf-8"));
            if (msg.event) {
                switch (msg.event) {
                    case "gdbServerLaunched":
                        this.handleGdbServerLaunched(msg.params.pid, msg.params.port);
                        break;
                    case "gdbServerExited":
                        this.handleGdbServerExited(msg.params.pid, msg.params.exit_code);
                        break;
                    case "streamReady":
                        this.handleStreamReady(msg.params.stream_id, msg.params.port, false);
                        break;
                    case "streamStarted":
                        // This is just informational, we will actually start the stream when gdb connects to it or right away for non-gdb streams
                        this.logDebug(`Stream ${msg.params.stream_id} is ready on remote port ${msg.params.port}`);
                        this.handleStreamReady(msg.params.stream_id, msg.params.port, true);
                        break;
                    case "streamClosed":
                        this.handleStreamClosed(msg.params.stream_id);
                        break;
                    default:
                        this.logError(`Received unknown proxy event: ${msg.event}`);
                }
                // This is an event message from the proxy, handle it accordingly
            } else if (msg.seq && this.pendingPromises.has(msg.seq)) {
                const { resolve, reject } = this.pendingPromises.get(msg.seq)!;
                this.pendingPromises.delete(msg.seq);
                this.logDebug(`Received response for seq ${msg.seq}: ${JSON.stringify(msg)}`);
                if (msg.success) {
                    resolve(msg.data);
                } else {
                    reject(new Error(msg.error || "Unknown error from proxy"));
                }
            } else {
                this.logError(`Received response with unknown seq: ${msg.seq}`);
            }
        } catch (err) {
            this.logError(`Failed to parse proxy message: ${err}`);
        }
    }

    private handleGdbServerLaunched(pid: any, port: any) {
        this.emit("gdbServerLaunched", { pid, port });
    }

    private handleGdbServerExited(pid: any, exit_code: any) {
        this.emit("gdbServerExited", { pid, exit_code });
    }

    private startHeartbeat() {
        if (this.heartbeatTimer) {
            return;
        }
        this.heartbeatTimer = setInterval(() => {
            const cmd: ControlMessage = {
                seq: this.nextSeq++,
                method: "heartbeat",
            };
            this.sendControlCommand(cmd).catch((err) => {
                this.logError(`Heartbeat failed: ${err}`);
            });
        }, 30_000);
    }

    private stopHeartbeat() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }

    private async handleStreamReady(stream_id: any, port: any, isStarted: boolean) {
        const portReserved = this.streamIdToPortInfo.get(stream_id);
        if (!portReserved) {
            this.logError(`Received streamReady event for unknown stream_id ${stream_id}`);
            return;
        }
        const portDef = this.clientPorts[portReserved.stream_id_str];
        if (!portDef) {
            this.logError(`No local port mapping found for stream ${portReserved.stream_id_str}`);
            return;
        }
        const stream_name = portReserved.stream_id_str;
        try {
            portReserved.status = isStarted ? "connected" : "ready";
            const remoteStream = new RemoteServer(this, portDef, portReserved);
            await remoteStream.initialize();
            this.clientStreams.set(stream_id, remoteStream);
        } catch (err) {
            this.logError(`Failed to create remote stream for stream_id ${stream_id}, stream_name ${stream_name}: ${err}`);
        }
    }

    // Have a map by request id for stream duplication requests as these are dynamically created
    private pendingStreamStarts: Map<number, PortReservedInfo> = new Map();
    public async startStream(stream_id: number, method: "startStream" | "duplicateStream", streamObj: RemoteStream): Promise<number> {
        const isDuplicate = method === "duplicateStream";
        const remoteServer = this.clientStreams.get(stream_id);
        let portReserved = this.streamIdToPortInfo.get(stream_id);
        if (!portReserved || !remoteServer) {
            throw new Error(`Attempted to open/duplicate unknown stream_id ${stream_id}`);
        }
        const curSeq = this.nextSeq++;
        if (isDuplicate) {
            portReserved = new PortReservedInfo(portReserved.port, -1, portReserved.stream_id_str, "starting");
            this.pendingStreamStarts.set(curSeq, portReserved);
        }
        const stream_name = portReserved.stream_id_str;
        this.logDebug(`${isDuplicate ? "Duplicating" : "Starting"} stream ${stream_name} (stream_id ${stream_id})`);
        const startStreamCmd: ControlMessage = {
            seq: curSeq,
            method: method,
            params: {
                stream_id: stream_id,
            },
        };
        if (isDuplicate) {
            this.pendingStreamStarts.set(curSeq, portReserved);
        }
        try {
            const ret = await awaitWithTimeout(this.sendControlCommand(startStreamCmd), this.timeout);
            if (!ret || !ret.streamStatus || ret.streamStatus.status !== "Connected") {
                throw new Error(`Failed to start stream for stream_id ${stream_id}, stream_name ${stream_name}`);
            }
            if (isDuplicate) {
                this.pendingStreamStarts.delete(curSeq);
                portReserved.stream_id = ret.streamStatus.stream_id; // This is the new stream id for the duplicated stream
                this.streamIdToPortInfo.set(portReserved.stream_id, portReserved);
                this.clientStreams.set(portReserved.stream_id, remoteServer!);
                this.logDebug(`Duplicate stream_id ${stream_id} command succeeded for stream ${stream_name} (stream_id ${portReserved.stream_id})`);
            }
            streamObj.setStreamId(portReserved.stream_id);
            portReserved.status = "connected";
            return portReserved.stream_id;
        } catch (err) {
            if (isDuplicate) {
                this.pendingStreamStarts.delete(curSeq);
            }
            this.logError(`Failed to ${isDuplicate ? "duplicate" : "start"} stream for stream_id ${stream_id}, stream_name ${stream_name}: ${err}`);
            throw err;
        }
    }

    private handleStreamClosed(stream_id: any) {
        const stream = this.clientStreams.get(stream_id);
        if (stream) {
            this.logDebug(`Closing stream ${stream_id}`);
            stream.close();
            this.clientStreams.delete(stream_id);
        }
    }
}

export class RemoteServer {
    private endingSession: boolean = false;
    private server: net.Server | null = null;
    private sockets: Array<RemoteStream> = [];
    private socketsByStreamId: Map<number, RemoteStream> = new Map();
    constructor(
        private proxyManager: ProxyClient,
        public portDef: TcpPortDef,
        public pInfo: PortReservedInfo,
    ) { }

    public async initialize() {
        const cleanupSocket = (socket: net.Socket) => {
            this.sockets = this.sockets.filter((s) => s.socket !== socket);
            this.socketsByStreamId.forEach((s, stream_id) => {
                if (s.socket === socket) {
                    this.socketsByStreamId.delete(stream_id);
                }
            });
        };
        this.server = net
            .createServer(async (socket) => {
                socket.on("close", () => {
                    cleanupSocket(socket);
                });
                socket.on("error", (e) => {
                    cleanupSocket(socket);
                    if (!this.endingSession) {
                        this.proxyManager.logError(`Error on client socket for ${this.pInfo.stream_id_str}: ${e.message}`);
                        throw new Error(`Error on client socket for ${this.pInfo.stream_id_str}, ${e}`);
                    }
                });

                const useStreamId = -1; // If this is the first connection, we can use the actual stream id, otherwise we have to wait for the proxy to assign a new stream id for this connection
                if (this.socketsByStreamId.get(useStreamId)) {
                    // Is it possible that two new clients are connecting at the same time before the proxy has a chance to assign stream ids?
                    // It is unlikely, but we should still handle it. To handle it fully, we would need to buffer data from the server for unique
                    // ids until the proxy assigns a stream id for the new connection. For now, we reject the second connection if it
                    // arrives before the first one is fully established. Data from the socket can be buffered by the RemoteStream object until
                    // the stream id is assigned, so we won't lose any data from the first connection.
                    this.proxyManager.logError(`Internal: received new connection for stream ${this.pInfo.stream_id_str}, but stream_id ${useStreamId} is already in use`);
                    socket.end();
                    return;
                }

                const stream: RemoteStream = new RemoteStream(this.proxyManager, this, useStreamId, socket);
                this.sockets.push(stream);
                this.socketsByStreamId.set(useStreamId, stream);
                let success = false;
                try {
                    if (this.sockets.length === 1 && this.pInfo.status === "connected") {
                        // Proxy has already started this stream (e.g. from streamStarted event).
                        // Avoid an extra control-plane round trip so strict gdb-servers can receive
                        // the initial ACK path immediately.
                        stream.setStreamId(this.pInfo.stream_id);
                        success = true;
                    } else if (this.sockets.length > 1) {
                        success = await this.duplicateStream(stream);
                    } else {
                        success = await this.startStream(stream);
                    }
                } catch (err) {
                    this.proxyManager.logError(`Failed to start stream for stream_id ${this.pInfo.stream_id}, stream_name ${this.pInfo.stream_id_str}: ${err}`);
                }
                if (!success) {
                    socket.end();
                    return;
                }
            })
            .on("listening", () => {
                this.portDef.remotePort = this.pInfo.port;
                this.proxyManager.logDebug(`Local server for stream ${this.pInfo.stream_id_str} is listening on port ${this.portDef.localPort}, forwarding to remote port ${this.pInfo.port}`);
                this.proxyManager.emit("streamStarted", this.portDef);
            })
            .listen(this.portDef.localPort);
    }

    private startStream(stream: RemoteStream, method: "startStream" | "duplicateStream" = "startStream"): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            this.proxyManager
                .startStream(this.pInfo.stream_id, method, stream)
                .then((stream_id) => {
                    if (this.pInfo.status !== "connected") {
                        throw new Error(`Stream ${this.pInfo.stream_id_str} is not connected after ${method} command`);
                    }
                    resolve(true);
                })
                .catch((err) => {
                    this.proxyManager.logError(`Failed to ${method} for stream_id ${this.pInfo.stream_id}, stream_name ${this.pInfo.stream_id_str}: ${err}`);
                    resolve(false);
                });
        });
    }

    private duplicateStream(stream: RemoteStream): Promise<boolean> {
        return this.startStream(stream, "duplicateStream");
    }

    public dataFromServer(data: Buffer, stream_id: number) {
        const stream = this.socketsByStreamId.get(stream_id) || this.socketsByStreamId.get(-1);
        if (stream) {
            stream.dataFromServer(data);
        } else {
            this.proxyManager.logError(`Received data from server for unknown stream_id ${stream_id}`);
        }
    }

    public resetStreamId(new_stream_id: number, stream: RemoteStream) {
        if (new_stream_id === stream.stream_id) {
            return;
        }
        if (this.socketsByStreamId.has(new_stream_id)) {
            this.proxyManager.logError(`Attempting to set stream_id to ${new_stream_id} for stream that already has stream_id ${this.socketsByStreamId.get(new_stream_id)?.stream_id}`);
            return;
        }
        this.socketsByStreamId.delete(stream.stream_id);
        stream.stream_id = new_stream_id;
        this.socketsByStreamId.set(new_stream_id, stream);
    }

    close() {
        this.endingSession = true;
        if (this.server) {
            this.sockets.forEach((s) => s.socket.destroy());
            this.sockets = [];
            this.socketsByStreamId.clear();
            this.server?.close();
            this.server = null;
        }
    }
}

export class RemoteStream {
    private fromServerBuffer: Buffer = Buffer.alloc(0);
    private toServerBuffer: Buffer = Buffer.alloc(0);
    private streamLocalName: string;
    private streamRemoteName: string;

    constructor(
        private proxyManager: ProxyClient,
        private server: RemoteServer,
        public stream_id: number,
        public socket: net.Socket,
    ) {
        this.streamLocalName = `stream_name ${this.server.pInfo.stream_id_str} (stream_id ${this.stream_id}), local port ${this.server.portDef.localPort}`;
        this.streamRemoteName = `remote stream_id ${this.stream_id}, remote port ${this.server.portDef.remotePort}`;
        this.initialize();
    }

    initialize() {
        this.socket.on("data", (data: Buffer) => {
            this.dataFromClent(data);
        });
        if (this.stream_id >= 0) {
            this.initStreamId(this.stream_id);
        }
    }

    setStreamId(stream_id: number) {
        if (this.stream_id === stream_id) {
            return;
        }
        if (this.stream_id >= 0) {
            this.proxyManager.logError(`Attempting to set stream_id to ${stream_id} for stream that already has stream_id ${this.stream_id}`);
        }
        if (this.stream_id < 0) {
            this.server.resetStreamId(stream_id, this);
            this.proxyManager.logDebug(`Stream ${this.streamLocalName} is now connected to proxy as ${this.streamRemoteName}`);
        }
        this.initStreamId(stream_id);
    }

    private initStreamId(stream_id: number) {
        this.stream_id = stream_id;
        this.streamLocalName = `stream_name ${this.server.pInfo.stream_id_str} (stream_id ${this.stream_id}), local port ${this.server.portDef.localPort}`;
        this.streamRemoteName = `remote stream_id ${this.stream_id}, remote port ${this.server.portDef.remotePort}`;
        this.proxyManager.logDebug(`Stream ${this.streamLocalName} is now connected to proxy as ${this.streamRemoteName}`);
        if (this.toServerBuffer.length > 0) {
            this.dataFromClent(this.toServerBuffer);
        }
        if (this.fromServerBuffer.length > 0) {
            // When does this happen? We buffer data from the server when the stream is not connected, but if the stream is not connected,
            // how do we get data from the server? Maybe the stream can be in a state where it is not fully connected but can still
            // receive data?
            this.dataFromServer(this.fromServerBuffer);
        }
    }

    dataFromServer(data: Buffer) {
        const toStr = data.toString();
        if (traceTraffic) {
            this.proxyManager.logDebug(`==> Received data from proxy for stream ${this.streamLocalName}: '${toStr}'`);
        }
        if (this.stream_id < 0) {
            // This should be rare, but if it happens, buffer data from the server until the
            // stream is connected. This should be rare or never happen because we only set stream_id
            // after the stream is connected, but we want to be safe and not lose any data from the server
            if (traceTraffic) {
                this.proxyManager.logDebug(`Buffering data from proxy for stream ${this.streamLocalName} because there are no clients connected or stream is not running, data: '${toStr}'`);
            }
            this.fromServerBuffer = Buffer.concat([this.fromServerBuffer, data]);
        } else {
            if (traceTraffic) {
                this.proxyManager.logDebug(`Forwarding data from proxy for stream ${this.streamLocalName} to ${this.streamRemoteName}`);
            }
            this.socket.write(data);
            this.fromServerBuffer = Buffer.alloc(0);
        }
    }

    dataFromClent(data: Buffer) {
        if (this.stream_id < 0) {
            if (traceTraffic) {
                const toStr = data.toString();
                this.proxyManager.logDebug(`<== Buffering data to proxy for stream ${this.streamLocalName} because the stream is not connected, data: '${toStr}'`);
            }
            this.toServerBuffer = Buffer.concat([this.toServerBuffer, data]);
            return;
        }
        this.proxyManager.sendCommandBytes(this.stream_id, data);
    }
}
