import * as net from "net";
import * as fs from "fs";
import * as path from "path";
import { GDBDebugSession } from "./gdb-session";
import { GDBServerSession, getEnvFromConfig } from "./server-session";
import { canonicalizePath, ConfigurationArguments, TcpPortDef, TcpPortDefMap } from "./servers/common";
import { existsSync } from "fs";
import { DebugHelper } from "./helper";
import { Stderr, Stdout } from "./gdb-mi/mi-types";
import { ChildProcess, spawn } from "child_process";
import { ControlMessage } from "@mcu-debug/shared/proxy-protocol/ControlMessage";
import { PortReserved } from "@mcu-debug/shared/proxy-protocol/PortReserved";
import { PortSet } from "@mcu-debug/shared/proxy-protocol/PortSet";
import { PortAllocatorSpec } from "@mcu-debug/shared/proxy-protocol/PortAllocatorSpec";
import { EventEmitter } from "stream";
import * as crypto from "crypto";
import { glob, GlobOptions } from "glob";

type StreamStatus = "starting" | "running" | "ready" | "timedOut" | "closed";

export class PortReservedInfo {
    constructor(
        public port: number,
        public stream_id: number,
        public stream_id_str: string,
        public status: StreamStatus = "starting",
    ) {}
}

export class ProxyClient extends EventEmitter {
    private pendingPromises: Map<number, { resolve: (value: any) => void; reject: (reason?: any) => void }> = new Map();
    private timeout = 20 * 1000; // 20 seconds
    private nextSeq: number = 1;
    private args: ConfigurationArguments;
    private proxyProcess: ChildProcess | null = null;
    private socket: net.Socket | null = null;
    private clientStreams: Map<number, RemoteStream> = new Map();
    constructor(
        public session: GDBDebugSession,
        public serverSession: GDBServerSession,
    ) {
        super();
        this.args = session.args;
    }

    async start(): Promise<boolean> {
        this.args = this.session.args;
        if (!this.args.hostConfig) {
            return false;
        }
        const remoteHost = this.args.hostConfig.pvtProxyHost || "127.0.0.1";
        const remotePort = this.args.hostConfig.pvtProxyPort || 4567;
        const token = this.args.hostConfig.token || this.args.hostConfig.pvtProxyToken || "adis-ababa";
        try {
            if (!(await this.connectToProxy(remoteHost, remotePort))) {
                if (this.args.hostConfig.type === "local") {
                    await this.startProxy(remoteHost, remotePort);
                    await new Promise((resolve) => setTimeout(resolve, 1000));
                    if (!(await this.connectToProxy(remoteHost, remotePort))) {
                        this.session.handleMsg(Stderr, `Failed to connect to proxy on ${remoteHost}:${remotePort}`);
                        return false;
                    } else {
                        this.session.handleMsg(Stdout, `Connected to proxy on ${remoteHost}:${remotePort}`);
                    }
                } else {
                    this.session.handleMsg(Stderr, `Failed to connect to proxy on ${remoteHost}:${remotePort}. Please ensure the proxy is running.`);
                    return false;
                }
            }
        } catch (err) {
            this.session.handleMsg(Stderr, `Failed to connect to proxy. Please ensure the proxy is running and accessible. ${err}`);
            return false;
        }
        try {
            let cwd = canonicalizePath(this.args.cwd || process.cwd());
            let cdir = crypto.createHash("sha256").update(cwd).digest("hex");
            cdir = cdir.length > 16 ? cdir.substring(0, 16) : cdir;
            const cmd: ControlMessage = {
                seq: this.nextSeq++,
                method: "initialize",
                params: {
                    token: token,
                    version: "1.0.3",
                    remote_launch_uid: cdir,
                },
            };
            await this.awaitWithTimeout(this.sendControlCommand(cmd), this.timeout);
            this.session.handleMsg(Stdout, `Proxy session initialized`);
            await this.syncFiles(cwd);
            return true;
        } catch (err) {
            this.session.handleMsg(Stderr, `Failed to initialize proxy session: ${err}`);
            return false;
        }
    }

    private async syncFiles(cwd: string) {
        const syncFiles = this.session.args.hostConfig?.syncFiles || [];
        for (const file of syncFiles) {
            const localPattern = file.local;
            if (!localPattern) {
                continue;
            }
            const remotePath = file.remote ? canonicalizePath(file.remote) : "";
            try {
                const files = await this.findFiles(cwd, localPattern);
                for (const f of files) {
                    try {
                        const content = Buffer.from(fs.readFileSync(f)).toJSON().data as Array<number>;
                        const rPath = remotePath ? remotePath + "/" + path.basename(f) : canonicalizePath(f);
                        const cmd: ControlMessage = {
                            seq: this.nextSeq++,
                            method: "syncFile",
                            params: {
                                relative_path: rPath,
                                content: content,
                            },
                        };
                        await this.awaitWithTimeout(this.sendControlCommand(cmd), this.timeout).catch((err) => {
                            this.session.handleMsg(Stderr, `Failed to sync file ${f} to ${remotePath}: ${err}`);
                        });
                    } catch (err) {
                        this.session.handleMsg(Stderr, `Failed to read file for syncing: ${f}, error: ${err}`);
                    }
                }
            } catch (err) {
                this.session.handleMsg(Stderr, `Failed to find files for syncing with pattern ${localPattern}: ${err}`);
            }
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
            this.session.handleMsg(Stderr, `Failed to find files with pattern ${globPattern} in ${cwd}: ${error}`);
            return [];
        }
    }

    private sendControlCommand(cmd: ControlMessage): Promise<any> {
        if (!this.socket) {
            this.session.handleMsg(Stderr, "Proxy socket is not connected");
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
            this.session.handleMsg(Stderr, "Proxy socket is not connected");
            return;
        }
        const header = Buffer.alloc(5);
        header.writeUInt8(stream_id, 0);
        header.writeUInt32LE(data.length, 1);
        this.socket.write(Buffer.concat([header, data]));
    }

    async stop(): Promise<void> {
        const cmd: ControlMessage = {
            seq: this.nextSeq++,
            method: "endSession",
        };
        try {
            await this.awaitWithTimeout(this.sendControlCommand(cmd), this.timeout);
        } catch (err) {
            this.session.handleMsg(Stderr, `Failed to end proxy session: ${err}`);
        }
        this.socket?.end();
        this.socket = null;
        for (const [stream_id, stream] of this.clientStreams) {
            stream.close();
        }
        this.clientStreams.clear();
        if (this.proxyProcess) {
            this.proxyProcess.kill();
            this.proxyProcess = null;
        }
    }

    private async startProxy(host: string, port: number): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const helper = new DebugHelper(this.session);
            const path = helper.getHelperExecPath();
            if (!path || !existsSync(path)) {
                this.session.handleMsg(Stderr, `Proxy helper executable not found at ${path}`);
                reject(new Error("Proxy helper executable not found"));
                return;
            }
            try {
                const args = ["proxy", "--host", host, "--port", port.toString()];
                this.session.handleMsg(Stdout, `Starting proxy helper with command: ${path} ${args.join(" ")}`);
                const proxyProcess = spawn(path, args, {
                    // detached: true,
                    // stdio: "ignore",
                });
                proxyProcess.stdout?.on("data", (data) => {
                    this.session.handleMsg(Stdout, `Proxy stdout: ${data.toString()}`);
                });
                proxyProcess.stderr?.on("data", (data) => {
                    this.session.handleMsg(Stderr, `Proxy stderr: ${data.toString()}`);
                });
                proxyProcess.on("spawn", () => {
                    this.session.handleMsg(Stdout, `Proxy helper started on ${host}:${port}`);
                    this.proxyProcess = proxyProcess;
                    resolve();
                });
                proxyProcess.on("error", (err) => {
                    this.session.handleMsg(Stderr, `Failed to start proxy helper: ${err}`);
                    reject(err);
                });
                proxyProcess.unref();
            } catch (err) {
                this.session.handleMsg(Stderr, `Failed to start proxy helper: ${err}`);
                reject(err);
            }
        });
    }

    private connectToProxy(host: string, port: number): Promise<boolean> {
        return new Promise((resolve, reject) => {
            const socket = new net.Socket();
            socket.once("connect", () => {
                this.socket = socket;
                resolve(true);
            });
            socket.once("error", (e) => {
                this.session.handleMsg(Stderr, `Error connecting to proxy on ${host}:${port} - ${e.message}`);
                resolve(false);
            });
            socket.connect(port, host);
            socket.on("data", (data: Buffer) => {
                this.handleProxyData(data);
            });
            socket.on("close", () => {
                this.session.handleMsg(Stdout, "Proxy connection closed");
                this.socket = null;
            });
        });
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
                const ret = (await this.awaitWithTimeout(this.sendControlCommand(cmd), this.timeout)) as any;
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
                this.session.handleMsg(Stderr, `Failed to allocate ports: ${err}`);
                reject(err);
            }
        });
    }

    launchServer(executable: string, args: string[], serverCwd: string, regexes: RegExp[]): Promise<void> {
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
        return this.awaitWithTimeout(this.sendControlCommand(cmd), this.timeout);
    }

    private msgBuffer: Buffer = Buffer.alloc(0);
    private handleProxyData(data: Buffer) {
        this.msgBuffer = Buffer.concat([this.msgBuffer, data]);
        while (this.msgBuffer.length >= 5) {
            const stream_id = this.msgBuffer.readUInt8(0);
            const length = this.msgBuffer.readUInt32LE(1);
            if (this.msgBuffer.length < 5 + length) {
                // Wait for the full message to arrive
                break;
            }
            const payload = this.msgBuffer.slice(5, 5 + length);
            this.handleProxyMessage(stream_id, payload);
            this.msgBuffer = this.msgBuffer.slice(5 + length);
        }
    }

    private handleProxyMessage(stream_id: number, payload: Buffer) {
        try {
            if (stream_id !== 0) {
                if (stream_id <= 2) {
                    this.serverSession.writeToConsole(payload);
                    return;
                }
                const stream = this.clientStreams.get(stream_id);
                if (stream) {
                    stream.dataFromServer(payload);
                } else {
                    this.session.handleMsg(Stderr, `Received data for unknown stream_id ${stream_id}`);
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
                        this.session.handleMsg(Stdout, `Stream ${msg.params.stream_id} is ready on remote port ${msg.params.port}`);
                        this.handleStreamReady(msg.params.stream_id, msg.params.port, true);
                        break;
                    case "streamClosed":
                        this.handleStreamClosed(msg.params.stream_id);
                        break;
                    default:
                        this.session.handleMsg(Stderr, `Received unknown proxy event: ${msg.event}`);
                }
                // This is an event message from the proxy, handle it accordingly
            } else if (msg.seq && this.pendingPromises.has(msg.seq)) {
                const { resolve, reject } = this.pendingPromises.get(msg.seq)!;
                this.pendingPromises.delete(msg.seq);
                this.session.handleMsg(Stdout, `Received response for seq ${msg.seq}: ${JSON.stringify(msg)}`);
                if (msg.success) {
                    resolve(msg.data);
                } else {
                    reject(new Error(msg.error || "Unknown error from proxy"));
                }
            } else {
                this.session.handleMsg(Stderr, `Received response with unknown seq: ${msg.seq}`);
            }
        } catch (err) {
            this.session.handleMsg(Stderr, `Failed to parse proxy message: ${err}`);
        }
    }

    private handleGdbServerLaunched(pid: any, port: any) {
        this.emit("gdbServerLaunched", { pid, port });
    }

    private handleGdbServerExited(pid: any, exit_code: any) {
        this.emit("gdbServerExited", { pid, exit_code });
    }

    private async handleStreamReady(stream_id: any, port: any, isStarted: boolean) {
        const portReserved = this.streamIdToPortInfo.get(stream_id);
        if (!portReserved) {
            this.session.handleMsg(Stderr, `Received streamReady event for unknown stream_id ${stream_id}`);
            return;
        }
        const portDef = this.clientPorts[portReserved.stream_id_str];
        if (!portDef) {
            this.session.handleMsg(Stderr, `No local port mapping found for stream ${portReserved.stream_id_str}`);
            return;
        }
        const stream_name = portReserved.stream_id_str;
        try {
            portReserved.status = isStarted ? "running" : "ready";
            /*
            if (!portReserved.stream_id_str.startsWith("gdb")) {
                // If this is not a gdb stream we open right away. For geb streams, if we open right away we will
                // miss the initial handshake between the gdb-server and gdb. So, we wait until gdb connects to the stream
                await this.startStream(stream_id);
            }
                */
            const remoteStream = new RemoteStream(this, portDef, portReserved);
            await remoteStream.initialize();
            this.clientStreams.set(stream_id, remoteStream);
        } catch (err) {
            this.session.handleMsg(Stderr, `Failed to create remote stream for stream_id ${stream_id}, stream_name ${stream_name}: ${err}`);
        }
    }

    public async startStream(stream_id: number): Promise<void> {
        const portReserved = this.streamIdToPortInfo.get(stream_id);
        if (!portReserved) {
            throw new Error(`Attempted to open unknown stream_id ${stream_id}`);
        }
        const stream_name = portReserved.stream_id_str;
        this.session.handleMsg(Stdout, `Starting stream ${stream_name} (stream_id ${stream_id})`);
        const startStreamCmd: ControlMessage = {
            seq: this.nextSeq++,
            method: "startStream",
            params: {
                stream_id: stream_id,
            },
        };
        const ret = await this.awaitWithTimeout(this.sendControlCommand(startStreamCmd), this.timeout);
        if (!ret || !ret.streamStatus || ret.streamStatus.status !== "Connected") {
            throw new Error(`Failed to start stream for stream_id ${stream_id}, stream_name ${stream_name}`);
        }
        portReserved.status = "running";
    }

    private handleStreamClosed(stream_id: any) {
        const stream = this.clientStreams.get(stream_id);
        if (stream) {
            this.session.handleMsg(Stdout, `Closing stream ${stream_id}`);
            stream.close();
            this.clientStreams.delete(stream_id);
        }
    }

    awaitWithTimeout<T>(p: Promise<T>, timeout: number): Promise<T> {
        // A promise that rejects after 'timeout' milliseconds
        const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => {
                reject(new Error(`Execution timeout of ${timeout}ms reached`));
            }, timeout);
        });

        // Race the original promise against the timeout promise
        return Promise.race([p, timeoutPromise]);
    }
}

export class RemoteStream {
    private fromServerBuffer: Buffer = Buffer.alloc(0);
    private toServerBuffer: Buffer = Buffer.alloc(0);
    private server: net.Server | null = null;
    private clientConnections: Array<net.Socket> = [];
    constructor(
        private proxyManager: ProxyClient,
        private portDef: TcpPortDef,
        private pInfo: PortReservedInfo,
    ) {}

    public async initialize() {
        this.server = net
            .createServer((socket) => {
                this.clientConnections.push(socket);
                if (this.pInfo.status !== "running") {
                    // this was deferred because gdb-streams need to wait for handshake or else the gdb-server
                    // might reject the connection. For non-gdb streams we can just start right away
                    this.startStream(); // Force opening the stream
                }
                if (this.fromServerBuffer.length > 0) {
                    this.dataFromServer(this.fromServerBuffer);
                }
                socket.on("data", (data: Buffer) => {
                    this.dataFromClent(data);
                });
                socket.on("close", () => {
                    this.clientConnections = this.clientConnections.filter((s) => s !== socket);
                });
                socket.on("error", (e) => {
                    this.clientConnections = this.clientConnections.filter((s) => s !== socket);
                    throw new Error(`Error on client socket for ${this.pInfo.stream_id_str}, ${e}`);
                });
            })
            .on("listening", () => {
                this.portDef.remotePort = this.pInfo.port;
                this.proxyManager.session.handleMsg(
                    Stdout,
                    `Local server for stream ${this.pInfo.stream_id_str} is listening on port ${this.portDef.localPort}, forwarding to remote port ${this.pInfo.port}`,
                );
                this.proxyManager.emit("streamStarted", this.portDef);
            })
            .listen(this.portDef.localPort);
    }

    dataFromServer(data: Buffer) {
        const toStr = data.toString();
        this.proxyManager.session.handleMsg(Stdout, `==> Received data from proxy for stream ${this.pInfo.stream_id_str} (stream_id ${this.pInfo.stream_id}): '${toStr}'`);
        // Should we buffer this if there are no clients connected? For now we just drop it, but maybe we should
        // buffer it and send it when a client connects?
        if (this.clientConnections.length === 0 || this.pInfo.status !== "running") {
            this.proxyManager.session.handleMsg(
                Stdout,
                `Buffering data from proxy for stream ${this.pInfo.stream_id_str} (stream_id ${this.pInfo.stream_id}) because there are no clients connected or stream is not running, data: '${toStr}'`,
            );
            this.fromServerBuffer = Buffer.concat([this.fromServerBuffer, data]);
        } else {
            this.proxyManager.session.handleMsg(
                Stdout,
                `Forwarding data from proxy for stream ${this.pInfo.stream_id_str} (stream_id ${this.pInfo.stream_id}) to ${this.clientConnections.length} client(s)`,
            );
            for (const client of this.clientConnections) {
                client.write(data);
            }
            this.fromServerBuffer = Buffer.alloc(0);
        }
    }

    dataFromClent(data: Buffer) {
        if (this.pInfo.status !== "running") {
            const toStr = data.toString();
            this.proxyManager.session.handleMsg(
                Stdout,
                `<== Buffering data to proxy for stream ${this.pInfo.stream_id_str} (stream_id ${this.pInfo.stream_id}) because the stream is not running, data: '${toStr}'`,
            );
            this.toServerBuffer = Buffer.concat([this.toServerBuffer, data]);
            return;
        }
        this.proxyManager.sendCommandBytes(this.pInfo.stream_id, data);
    }

    private startStream() {
        this.proxyManager
            .startStream(this.pInfo.stream_id)
            .then(() => {
                if (this.pInfo.status !== "running") {
                    throw new Error(`Stream ${this.pInfo.stream_id_str} is not running after startStream command`);
                }
                if (this.toServerBuffer.length > 0) {
                    this.proxyManager.sendCommandBytes(this.pInfo.stream_id, this.toServerBuffer);
                    this.toServerBuffer = Buffer.alloc(0);
                }
                if (this.fromServerBuffer.length > 0) {
                    this.dataFromServer(this.fromServerBuffer);
                }
            })
            .catch((err) => {
                this.server?.close();
                this.server = null;
                this.proxyManager.session.handleMsg(Stderr, `Failed to start stream for stream_id ${this.pInfo.stream_id}, stream_name ${this.pInfo.stream_id_str}: ${err}`);
            });
    }

    close() {
        if (this.server) {
            this.clientConnections.forEach((s) => s.destroy());
            this.clientConnections = [];
            this.server?.close();
            this.server = null;
        }
    }
}
