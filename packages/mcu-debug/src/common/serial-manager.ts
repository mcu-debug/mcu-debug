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

import * as net from "net";
import { SerialParams } from "@mcu-debug/shared/serial-helper/SerialParams";
import { AvailablePort } from "@mcu-debug/shared/serial-helper/AvailablePort";
import { SerialPortInfo } from "@mcu-debug/shared/proxy-protocol/SerialPortInfo";
import { SerialErrorKind } from "@mcu-debug/shared/serial-helper/SerialErrorKind";
import { ConfigurationArguments, HostConfig, SerialConfig } from "../adapter/servers/common";
import { getProxyForSerialPorts } from "./proxy";
import { ControlMessage } from "@mcu-debug/shared/proxy-protocol/ControlMessage";
import { getHostAdapter, ISerialPortView } from "./host-adapter";

const PROXY_TIMOUT = 5000;

/**
 * Host a serial view connects to. Always loopback, and never the proxy's address.
 *
 * Both transports terminate at a loopback listener on *this* machine:
 *
 * - **Funnel** (remote proxies): the listener is ours — `ProxySerialTcpServer`,
 *   created a few lines below and bound to this address. The bytes reach the
 *   remote port through the control socket, not through this TCP connection.
 * - **Direct** (local proxies only): the listener is the proxy's `TcpBridge`,
 *   which binds `127.0.0.1` (see `proxy_server/serial.rs`). Direct is never
 *   selected for a remote proxy, so the bridge is always on this machine.
 *
 * The control connection's host is a separate question with a separate answer —
 * the proxy may be bound to `0.0.0.0` or reached over a WSL/vEthernet address —
 * and using it here connects the view to the wrong machine, or to nothing.
 */
const SERIAL_VIEW_HOST = "127.0.0.1";

interface ProxyConnectionInfo {
    host: string;
    port: number;
    token: string;
}

/**
 * Stable identity of a proxy connection. Manager-side maps that are keyed by
 * device path must be qualified by this, because the same path (e.g.
 * `/dev/ttyACM0`) can exist on more than one proxy at once (local + ssh
 * remote). Step 1 kept a single connection; from here on, keys are always
 * `(ProxyKey, path)` so adding more connections in Step 3 can't collide.
 */
export type ProxyKey = string;

/** Composite key for a port on a specific proxy. NUL never occurs in a device path. */
const KEY_SEP = "\u0000";
function compositeKey(proxyKey: ProxyKey, path: string): string {
    return `${proxyKey}${KEY_SEP}${path}`;
}

/**
 * An available port together with the proxy it was reported by. The same device
 * path can be served by more than one proxy (local + ssh remote), so the source
 * is what lets the picker disambiguate otherwise-identical paths.
 */
export interface SourcedPort {
    port: AvailablePort;
    proxyKey: ProxyKey;
    /** Human-readable source label for the picker (e.g. "local", "ssh:pi@lab"). */
    label: string;
}

/**
 * Resolves a hostConfig to a proxy endpoint (populating pvtProxy* fields).
 * Defaults to {@link getProxyForSerialPorts}; injectable so tests can point the
 * manager at fake proxies without going through the real launch machinery.
 */
export type ProxyResolver = (hostConfig: HostConfig | undefined) => Promise<HostConfig | null>;

/** Shared logging helpers so both the connection and its TCP servers log the same way. */
function serialLogInfo(message: string) {
    getHostAdapter().debugConsoleMessage(message);
}
function serialLogError(message: string) {
    getHostAdapter().debugConsoleError(message);
}

/**
 * The `serial.open` response: what *this* client got for the port it just opened.
 *
 * Distinct from `SerialPortInfo` (a `serial.listOpen` entry), which describes the
 * port's whole state on the proxy — including every other client's channel. Open
 * returns exactly one `channel_id` by construction; listOpen returns `channel_ids`,
 * plural, because transports are additive on the proxy side.
 *
 * These were previously conflated under `SerialPortInfo`, which is why reading the
 * path needed an `as any` cast: the two shapes carry it in different places.
 */
export interface SerialOpenInfo {
    path?: string;
    tcp_port?: number | null;
    /** The funnel channel allocated to this open, when transport is "funnel". */
    channel_id?: number | null;
}

/** Either shape can land in `openPorts[]` — open responses and listOpen entries. */
type OpenPortEntry = SerialOpenInfo | SerialPortInfo;

/**
 * Extract the resolved device path from either shape.
 *
 * `serial.open` responses carry `path` at the top level; `serial.listOpen` entries
 * carry it as `params.path`.
 */
function resolvedPath(info: OpenPortEntry): string | undefined {
    return (info as SerialOpenInfo).path || (info as SerialPortInfo).params?.path || undefined;
}

/** Human-readable description of a port selector for log messages. */
function portSel(p: SerialParams): string {
    if (p.path) { return p.path; }
    if (p.serial) { return `serial=${p.serial}`; }
    if (p.match) { return `match=${p.match}`; }
    if (p.vid || p.pid) { return `vid=${p.vid} pid=${p.pid}`; }
    return "<no selector>";
}

/**
 * Higher-level reactions a {@link ProxyConnection} hands back to its owner
 * (the {@link SerialPortManager}). The connection owns the wire; the manager
 * owns the views/config/reconnect policy, so wire-level events that require a
 * UI reaction are delegated here rather than reaching into the manager.
 */
interface ProxyConnectionDelegate {
    onPortError(conn: ProxyConnection, path: string, kind: SerialErrorKind, msg: string): void;
}

/**
 * A single connection to one proxy (Probe Agent). Owns everything that is
 * scoped to that one proxy: the socket, the request/response sequence space,
 * the funnel stream-id space (clientStreams), and this proxy's view of which
 * ports are available/open. Framing and heartbeat live here too.
 *
 * The {@link SerialPortManager} currently creates exactly one of these; the
 * multi-proxy work turns that into a registry of connections keyed by proxy
 * identity. Keeping all per-proxy state on this object is what makes that
 * possible without namespace collisions between proxies.
 */
export class ProxyConnection {
    private socket: net.Socket | null = null;
    private proxyInfo: ProxyConnectionInfo | null = null;
    private lastProxyInfo: string = "";
    private heartbeatTimer: NodeJS.Timeout | null = null;
    // Whether ports on this connection are bridged over the funnel (multiplexed
    // on the single control socket) vs a direct per-port TCP listener. Derived
    // in connect() from THIS proxy's resolved topology, not the workspace: a
    // local proxy is directly reachable (direct); a remote proxy (ssh tunnel /
    // reverse tunnel / wsl) is only reachable through the control socket (funnel).
    private isFunnelTransport: boolean = false;
    private clientStreams: Map<number, ProxySerialTcpServer> = new Map();
    private nextSeq: number = 1;
    private pendingPromises: Map<number, { resolve: (value: any) => void; reject: (reason?: any) => void }> = new Map();
    private availablePorts: AvailablePort[] = [];
    private openPorts: OpenPortEntry[] = [];
    private pendingAvailableSnapshotResolvers: Array<() => void> = [];
    /**
     * Funnel bytes that arrived before their stream was registered.
     *
     * The proxy allocates the channel and starts replaying the port's ring buffer as soon
     * as `serial.open` is handled -- so the first bytes can share a TCP segment with the
     * response itself. Registration happens several microtasks later, once the response
     * has propagated back through openSerialPort to the view. Dropping what lands in that
     * window discards exactly the buffered history the proxy keeps to solve the "boot
     * banner lost" problem, so it is held here until the stream appears.
     */
    private earlyStreamData: Map<number, { chunks: Buffer[]; bytes: number }> = new Map();

    constructor(public readonly key: ProxyKey, private delegate: ProxyConnectionDelegate, public label: string = key) { }

    public logInfo(message: string) {
        serialLogInfo(message);
    }
    public logError(message: string) {
        serialLogError(message);
    }

    private destroySocket() {
        if (this.socket) {
            this.socket.destroy();
            this.socket = null;
            this.proxyInfo = null;
        }
    }

    public connect(hostConfig: HostConfig): Promise<boolean> {
        // Transport is a property of THIS proxy's topology, not the workspace: a
        // local proxy is directly reachable; any remote proxy must funnel over
        // the single control socket.
        this.isFunnelTransport = hostConfig.pvtNetworkMode !== "local";
        const newProxyInfo = JSON.stringify(hostConfig);
        if (this.lastProxyInfo === newProxyInfo && this.socket && !this.socket.destroyed) {
            return Promise.resolve(true);
        }
        this.lastProxyInfo = newProxyInfo;
        const host = hostConfig.pvtProxyHost || "127.0.0.1";
        const port = hostConfig.pvtProxyPort || -3;
        const token = hostConfig.token || hostConfig.pvtProxyToken || "";
        if (this.socket && !this.socket.destroyed) {
            if (this.socket.remoteAddress === host && this.socket.remotePort === port && this.proxyInfo?.token === token) {
                return Promise.resolve(true);
            }
            this.destroySocket();
        }
        return new Promise((resolve) => {
            this.logInfo(`Attempting to connect to proxy on ${host}:${port}...`);
            const socket = new net.Socket();
            socket.on("data", (data: Buffer) => {
                this.handleProxyData(data);
            });
            socket.on("close", () => {
                this.logInfo("Proxy connection closed");
                this.stopHeartbeat();
                this.destroySocket();
            });
            socket.once("connect", async () => {
                this.logInfo(`Successfully connected to proxy on ${host}:${port}`);
                this.socket = socket;
                this.proxyInfo = { host: host, port: port, token };
                await this.subscribeToSerialAvailability();
                // TODO: See if we need a heartbeat and what its frequency should be
                // this.startHeartbeat();
                resolve(true);
            });
            socket.once("error", (e) => {
                this.logError(`Error connecting to proxy on ${host}:${port} - ${e.message}`);
                socket.destroy();
                resolve(false);
            });
            socket.connect(port, host);
        });
    }

    private resolvePendingAvailableSnapshots() {
        if (this.pendingAvailableSnapshotResolvers.length === 0) {
            return;
        }
        const resolvers = this.pendingAvailableSnapshotResolvers.splice(0);
        for (const resolve of resolvers) {
            resolve();
        }
    }

    private async waitForAvailableSnapshot(timeoutMs: number = PROXY_TIMOUT): Promise<void> {
        if (this.availablePorts.length > 0) {
            return;
        }
        await new Promise<void>((resolve) => {
            let resolved = false;
            const onSnapshot = () => {
                if (resolved) {
                    return;
                }
                resolved = true;
                clearTimeout(timer);
                resolve();
            };
            const timer = setTimeout(onSnapshot, timeoutMs);
            this.pendingAvailableSnapshotResolvers.push(onSnapshot);
        });
    }

    private async subscribeToSerialAvailability(): Promise<void> {
        const controlMsg: ControlMessage = {
            seq: this.nextSeq++,
            method: "serial.subscribeAvailable",
        };
        try {
            await this.sendControlCommand(controlMsg, PROXY_TIMOUT);
            await this.waitForAvailableSnapshot(PROXY_TIMOUT);
        } catch (err) {
            this.logInfo(`serial.subscribeAvailable failed or timed out; falling back to on-demand list: ${err}`);
        }
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
            // Slow-poll fallback: refresh available ports in case a subscription event was missed.
            // this.getSerialPrortsList(true).then(ports => {
            //     console.log(`Heartbeat serial ports refresh: ${ports?.length} ports currently available`);
            // }).catch(() => { });
        }, 30_000);
    }

    /**
     * Send a control command and wait for the proxy's response.
     *
     * The timeout belongs here rather than in a wrapper around the call, for two reasons. It can
     * name the command that hung -- and it can drop the entry from `pendingPromises`. An outer
     * timeout racing this promise abandons that entry forever, which against a wedged proxy makes
     * the 30s heartbeat an unbounded leak.
     *
     * @param useTimeout milliseconds to wait. <= 0 waits indefinitely, until a response or dispose().
     */
    private sendControlCommand(cmd: ControlMessage, useTimeout: number = PROXY_TIMOUT): Promise<any> {
        if (!this.socket) {
            this.logError("Proxy socket is not connected");
            return Promise.reject(new Error(`Proxy socket is not connected ('${cmd.method}' seq ${cmd.seq})`));
        }

        return new Promise((resolve, reject) => {
            let timer: NodeJS.Timeout | undefined;
            // Log the send, and report the round trip on settle. Without the send time
            // a response log tells you when the answer arrived but not how long it took,
            // and the two sides' clocks cannot be assumed to agree.
            const sentAt = Date.now();
            // Heartbeats repeat forever and say nothing when healthy; logging them here
            // would bury the requests worth reading. A failing one still logs its timeout.
            const routine = cmd.method === "heartbeat";
            if (!routine) {
                this.logInfo(`Sending request: seq ${cmd.seq} '${cmd.method}'`);
            }
            // Every exit goes through here, so the map entry and the timer are released exactly
            // once regardless of who wins the race -- response, timeout, or dispose().
            //
            // This is also the single place a request's outcome is logged. The response
            // handler used to log its own line, which meant every request produced two
            // entries saying the same thing -- and that line could not see a timeout or a
            // dropped socket, because neither goes through it.
            const settle = (ok: boolean, done: (arg?: any) => void, arg?: any) => {
                if (timer) {
                    clearTimeout(timer);
                    timer = undefined;
                }
                this.pendingPromises.delete(cmd.seq);
                if (!routine) {
                    const outcome = ok ? "ok" : `error: ${arg?.message ?? arg}`;
                    this.logInfo(`Settled request: seq ${cmd.seq} '${cmd.method}' ${outcome} after ${Date.now() - sentAt}ms`);
                }
                done(arg);
            };

            this.pendingPromises.set(cmd.seq, {
                resolve: (value: any) => settle(true, resolve, value),
                reject: (reason: any) => settle(false, reject, reason),
            });

            if (useTimeout > 0) {
                timer = setTimeout(() => {
                    // Only an actual timeout is reported as one. An error returned by the
                    // proxy settles with the proxy's own message instead.
                    const msg = `Proxy command '${cmd.method}' (seq ${cmd.seq}) timed out after ${useTimeout}ms`;
                    this.logError(msg);
                    settle(false, reject, new Error(msg));
                }, useTimeout);
                timer.unref();
            }

            try {
                this.sendCommandBytes(0, Buffer.from(JSON.stringify(cmd), "utf-8"));
            } catch (e) {
                settle(false, reject, e);
            }
        });
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
                /*
                if (stream_id <= 2) {
                    this.serverSession.writeToConsole(payload);
                    return;
                }
                */
                const server = this.clientStreams.get(stream_id);
                if (server) {
                    server.dataFromServer(payload, stream_id);
                } else {
                    this.bufferEarlyStreamData(stream_id, payload);
                }
                return;
            }
            const payloadStr = payload.toString("utf-8");
            const msg = JSON.parse(payloadStr);
            if (msg.event) {
                const event = msg.event;
                switch (event) {
                    case "serial.portError": {
                        const errMsg = msg.params?.msg || "Unknown error";
                        const errKind = msg.params?.kind || "unknown";
                        this.logError(`Received serial port error from proxy: (kind: ${errKind}) msg: ${errMsg} for port ${msg.params.path}`);
                        this.delegate.onPortError(this, msg.params.path, errKind, errMsg);
                        break;
                    }
                    case "serial.availableChanged": {
                        const ports = msg.params?.ports;
                        if (Array.isArray(ports)) {
                            this.availablePorts = ports as AvailablePort[];
                            //
                            // Uncommenting the following line cause the OUTPUT channel to erase everything before this line and
                            // the channel completely stops working for any further output. Tried to debug with AI for hours and we
                            // could not figure out why. The line itself is harmless and works fine in other places, but for some
                            // reason it causes the channel to break when used here.
                            //
                            // this.logInfo(`Received serial.availableChanged: revision=${msg.params?.revision}, ports=${ports.length}`);
                            this.resolvePendingAvailableSnapshots();
                        }
                        break;
                    }
                    default:
                        this.logError(`Received unknown event from proxy: ${event}`);
                }
            } else if (msg.seq && this.pendingPromises.has(msg.seq)) {
                const { resolve, reject } = this.pendingPromises.get(msg.seq)!;
                this.pendingPromises.delete(msg.seq);
                // Outcome is logged once, by settle() in sendControlCommand -- it sees this
                // path plus timeouts and dropped sockets, which never reach here.
                if (msg.success) {
                    resolve(msg.data);
                } else {
                    reject(new Error(msg.message || "Unknown error from proxy"));
                }
            } else {
                this.logError(`Received response with unknown seq: ${msg.seq}`);
            }
        } catch (err) {
            this.logError(`Error handling proxy message: ${err}`);
        }
    }

    private stopHeartbeat() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }

    public async getOpenSerialProrts(): Promise<SerialPortInfo[]> {
        try {
            const controlMsg: ControlMessage = {
                seq: this.nextSeq++,
                method: "serial.listOpen",
            };
            const openPorts = await this.sendControlCommand(controlMsg, PROXY_TIMOUT);
            this.logInfo(`Open serial ports: ${JSON.stringify(openPorts)}`);
            // Narrower than the openPorts[] union: a listOpen reply is always
            // SerialPortInfo entries, so callers of this method get the precise type.
            const ports: SerialPortInfo[] = openPorts && openPorts["serial.listOpen"] ? openPorts["serial.listOpen"].ports : [];
            this.openPorts = ports;
            return ports;
        } catch (err) {
            this.logError(`Failed to get serial ports list: ${err}`);
            this.openPorts = [];
            return [];
        }
    }

    public getSerialPortInfo(path: string): OpenPortEntry | null {
        for (const port of this.openPorts) {
            if (resolvedPath(port) === path) {
                return port;
            }
        }
        return null;
    }

    public async getSerialPrortsList(silent: boolean = false): Promise<AvailablePort[]> {
        try {
            const controlMsg: ControlMessage = {
                seq: this.nextSeq++,
                method: "serial.listAvailable",
            };
            const availPorts = await this.sendControlCommand(controlMsg, PROXY_TIMOUT);
            if (!silent) {
                this.logInfo(`Available serial ports: ${JSON.stringify(availPorts)}`);
            }
            this.availablePorts = availPorts && availPorts["serial.listAvailable"] ? availPorts["serial.listAvailable"].ports : [];
            return this.availablePorts;
        } catch (err) {
            if (!silent) {
                this.logError(`Failed to get serial ports list: ${err}`);
            }
            this.availablePorts = [];
            this.openPorts = [];
            return [];
        }
    }

    public async openSerialPort(serialParams: SerialParams, silent: boolean = false): Promise<SerialOpenInfo | null> {
        try {
            serialParams.transport = this.isFunnelTransport ? "funnel" : "direct";   // Default to proxy transport for remote workspaces and direct transport for local workspaces. The proxy will handle the transport details on its side.
            const controlMsg: ControlMessage = {
                seq: this.nextSeq++,
                method: "serial.open",
                params: serialParams,
            };
            const result = await this.sendControlCommand(controlMsg, PROXY_TIMOUT);
            const openInfo = (result && result["serial.open"] ? result["serial.open"] : null) as SerialOpenInfo | null;
            if (!openInfo) {
                return null;
            }
            const openPath = resolvedPath(openInfo);
            if (openPath) {
                let updated = false;
                for (let ix = 0; ix < this.openPorts.length; ix++) {
                    if (resolvedPath(this.openPorts[ix]) === openPath) {
                        this.openPorts[ix] = openInfo;
                        updated = true;
                        break;
                    }
                }
                if (!updated) {
                    this.openPorts.push(openInfo);
                }
            }
            return openInfo;
        } catch (err) {
            if (!silent) {
                const sel = portSel(serialParams);
                this.logError(`Failed to open serial port ${sel}: ${err}`);
            }
            return null;
        }
    }

    public getCurrentSerialPorts(): AvailablePort[] {
        return this.availablePorts;
    }

    public getCurrentOpenSerialPorts(): OpenPortEntry[] {
        return this.openPorts;
    }

    /** Whether this proxy currently reports `path` among its available ports. */
    public isPortAvailable(path: string): boolean {
        const lCasePath = path.toLowerCase();
        return this.availablePorts.some((p) => p.path.toLowerCase() === lCasePath);
    }

    /**
     * Get-or-create the funnel TCP server for a port's channel. The stream-id
     * space is owned by this connection, so the map of servers lives here.
     */
    /** Cap per stream, matching the proxy's own ring so we hold what it would replay. */
    private static readonly MaxEarlyStreamBytes = 1024 * 1024;

    private bufferEarlyStreamData(stream_id: number, payload: Buffer) {
        let held = this.earlyStreamData.get(stream_id);
        if (!held) {
            held = { chunks: [], bytes: 0 };
            this.earlyStreamData.set(stream_id, held);
        }
        if (held.bytes + payload.length > ProxyConnection.MaxEarlyStreamBytes) {
            // A stream that never registers must not grow without bound. Report once,
            // when the cap is first crossed.
            if (held.bytes <= ProxyConnection.MaxEarlyStreamBytes) {
                this.logError(`Discarding data for unregistered stream_id ${stream_id}: exceeded ${ProxyConnection.MaxEarlyStreamBytes} bytes`);
            }
            held.bytes = ProxyConnection.MaxEarlyStreamBytes + 1;
            return;
        }
        held.chunks.push(payload);
        held.bytes += payload.length;
    }

    public ensureStreamServer(host: string, path: string, channel_id: number): ProxySerialTcpServer {
        let server = this.clientStreams.get(channel_id);
        if (server) {
            server.setChannelId(channel_id);
        } else {
            server = new ProxySerialTcpServer(host, path, channel_id, this);
            this.clientStreams.set(channel_id, server);
        }
        // Hand over anything that arrived before this stream existed, in arrival order and
        // ahead of any live byte, so the history the proxy replayed is not reordered.
        const held = this.earlyStreamData.get(channel_id);
        if (held) {
            this.earlyStreamData.delete(channel_id);
            this.logInfo(`Delivering ${held.bytes} byte(s) buffered for stream_id ${channel_id} before it was registered`);
            for (const chunk of held.chunks) {
                server.dataFromServer(chunk, channel_id);
            }
        }
        return server;
    }

    /**
     * Close a port on the proxy side and drop this connection's bookkeeping for
     * it (open-port entry and funnel stream server). The manager handles the
     * view/config/reconnect side; this is only the wire teardown.
     */
    public closePort(path: string, skipSerialClose: boolean = false) {
        const portInfo = this.getSerialPortInfo(path);
        if (!portInfo) {
            return;
        }
        if (!skipSerialClose) {
            const controlMsg: ControlMessage = {
                seq: this.nextSeq++,
                method: "serial.close",
                params: { path },
            };
            this.sendControlCommand(controlMsg).catch((err) => {
                this.logError(`Failed to close serial port ${path}: ${err}`);
            });
        }
        this.openPorts = this.openPorts.filter((p) => resolvedPath(p) !== path);
        for (const [stream_id, server] of this.clientStreams.entries()) {
            if (server.getPort() === portInfo.tcp_port) {
                server.dataFromServer(Buffer.from(""), stream_id);   // Send an empty message to trigger any cleanup on the server side
                this.clientStreams.delete(stream_id);
                break;
            }
        }
    }

    /**
     * Tear this connection down completely: stop the heartbeat, close the
     * control socket and every funnel TCP server, and fail any in-flight
     * requests/waiters. After dispose() the object must not be reused. This is
     * the only thing that clears the heartbeat interval, so a manager holding a
     * connection must dispose it rather than just dropping the reference.
     */
    public dispose() {
        this.stopHeartbeat();
        for (const server of this.clientStreams.values()) {
            server.close();
        }
        this.clientStreams.clear();
        this.earlyStreamData.clear();
        this.destroySocket();
        for (const { reject } of this.pendingPromises.values()) {
            reject(new Error("Proxy connection disposed"));
        }
        this.pendingPromises.clear();
        this.resolvePendingAvailableSnapshots();
    }
}

export class SerialPortManager implements ProxyConnectionDelegate {
    static instance: SerialPortManager | null = null;

    // Registry of live proxy connections, keyed by proxy endpoint identity
    // (host:port). A single debug session uses exactly one proxy, but the
    // manager spans sessions and standalone commands, so several connections
    // can be live at once (e.g. the local proxy plus one or more ssh-remote
    // proxies). Connections are created lazily and are NEVER torn down to serve
    // a different endpoint — doing so was the core bug of the old single-socket
    // design, where opening a port on proxy B killed all of proxy A's ports.
    private connections: Map<ProxyKey, ProxyConnection> = new Map();

    // Keyed by compositeKey(proxyKey, path) — NOT bare path. The same device
    // path can be served by more than one proxy, so the owning connection must
    // qualify every entry.
    private serialPortViews: Map<string, ISerialPortView> = new Map();
    private serialPortConfigs: Map<string, SerialParams> = new Map();
    private reconnectTimers: Map<string, NodeJS.Timeout> = new Map();

    constructor(private resolveProxy: ProxyResolver = getProxyForSerialPorts) {
        SerialPortManager.instance = this;
    }

    /**
     * Stable identity of a proxy from its resolved endpoint. Two hostConfigs
     * that resolve to the same host:port are the same proxy and share one
     * connection; different endpoints get independent connections. A proxy that
     * restarts under the same host:port keeps its key — {@link ProxyConnection.connect}
     * handles a changed token/port by reconnecting in place.
     */
    private proxyKeyFor(hostConfig: HostConfig): ProxyKey {
        const host = hostConfig.pvtProxyHost || "127.0.0.1";
        const port = hostConfig.pvtProxyPort || -2;
        return `${host}:${port}`;
    }

    /** Get the connection for a resolved hostConfig, creating it on first use. */
    private getOrCreateConnection(hostConfig: HostConfig): ProxyConnection {
        const key = this.proxyKeyFor(hostConfig);
        let conn = this.connections.get(key);
        if (!conn) {
            conn = new ProxyConnection(key, this, this.proxyLabelFor(hostConfig));
            this.connections.set(key, conn);
        }
        return conn;
    }

    /** Human-readable source label for a proxy, used to tag ports in the picker. */
    private proxyLabelFor(hostConfig: HostConfig): string {
        if (hostConfig.sshHost) {
            return `ssh:${hostConfig.sshHost}`;
        }
        if (hostConfig.pvtNetworkMode === "local" || hostConfig.type === "local") {
            return "local";
        }
        if (hostConfig.pvtNetworkMode) {
            return hostConfig.pvtNetworkMode;
        }
        return this.proxyKeyFor(hostConfig);
    }

    /**
     * Every available port across all live connections, each tagged with its
     * source proxy. Lists are kept fresh per-connection by the availability
     * subscription, so this just flattens the current snapshots.
     */
    public getAllAvailablePorts(): SourcedPort[] {
        const out: SourcedPort[] = [];
        for (const conn of this.connections.values()) {
            for (const port of conn.getCurrentSerialPorts()) {
                out.push({ port, proxyKey: conn.key, label: conn.label });
            }
        }
        return out;
    }

    /** Composite map key for a port on a specific connection. */
    private ckey(conn: ProxyConnection, path: string): string {
        return compositeKey(conn.key, path);
    }

    public logInfo(message: string) {
        serialLogInfo(message);
    }
    public logError(message: string) {
        serialLogError(message);
    }

    // --- ProxyConnectionDelegate ---
    public onPortError(conn: ProxyConnection, portPath: string, kind: SerialErrorKind, msg: string) {
        const view = this.serialPortViews.get(this.ckey(conn, portPath));
        if (kind === "disconnected" && view) {
            // The helper may already have torn down serial state; drop manager-side state and recreate.
            view.notifyDisconnected(msg);
            this.removeSerialPortTab(conn, portPath, true, true);
            this.scheduleReconnect(conn, portPath);
        } else {
            this.removeSerialPortTab(conn, portPath);
        }
    }

    private scheduleReconnect(conn: ProxyConnection, portPath: string, delayMs: number = 3000) {
        const key = this.ckey(conn, portPath);
        if (this.reconnectTimers.has(key)) {
            return;
        }
        const timer = setTimeout(() => {
            this.reconnectTimers.delete(key);
            this.attemptReconnect(conn, portPath);
        }, delayMs);
        this.reconnectTimers.set(key, timer);
    }

    private async attemptReconnect(conn: ProxyConnection, portPath: string): Promise<void> {
        const reconnectConfig = this.serialPortConfigs.get(this.ckey(conn, portPath));
        if (!reconnectConfig) {
            return;
        }
        if (!conn.isPortAvailable(portPath)) {
            // Port is not in the available list yet; reschedule and wait for it to reappear.
            this.scheduleReconnect(conn, portPath, 3000);
            return;
        }
        try {
            const result = await conn.openSerialPort({ ...reconnectConfig }, true);
            if (result) {
                const configPath = reconnectConfig.path;
                const actualPath: string = resolvedPath(result) || configPath || '';
                const reconnectViewConfig: SerialParams = {
                    ...reconnectConfig,
                    path: actualPath,
                };
                if (actualPath !== configPath) {
                    this.serialPortConfigs.delete(this.ckey(conn, configPath ?? ''));
                }
                await this.createOrUpdateViewWithSerialInfo(conn, result, reconnectViewConfig, false);
                return;
            }
        } catch {
            // fall through to retry
        }
        this.scheduleReconnect(conn, portPath, 3000);
    }

    public async listAvailablePortsCmd(noDisplay?: boolean): Promise<AvailablePort[]> {
        // Ensure the default (local/auto) connection for this workspace is up, so
        // a standalone list works even with no debug session running. Failure to
        // resolve/connect is non-fatal here: we still aggregate whatever other
        // connections active debug sessions have already established.
        const tmpHostConfig: HostConfig = {
            type: getHostAdapter().getRemoteName() ? "auto" : "local",
            enabled: true,
        }
        const resolvedHostConfig = await this.resolveProxy(tmpHostConfig);
        if (resolvedHostConfig && resolvedHostConfig.pvtProxyPort && resolvedHostConfig.pvtProxyPort > 0) {
            const conn = this.getOrCreateConnection(resolvedHostConfig);
            if (!(await conn.connect(resolvedHostConfig))) {
                this.logError(`Failed to connect to proxy for serial ports.`);
                return [];
            }
        } else {
            this.logError(`Failed to resolve proxy configuration for serial ports.`);
            return [];
        }

        // Aggregate across every live connection (local + any remotes) so the
        // picker shows all reachable ports, each tagged with its source proxy.
        const sourced = this.getAllAvailablePorts();
        if (noDisplay) {
            return sourced.map((s) => s.port);
        }

        const items = sourced.map((s) => {
            const p = s.port;
            const desc = p.description ? `${s.label} · ${p.description}` : s.label;
            return {
                label: p.path,
                description: desc,
                detail: `VID: ${p.vid !== null ? p.vid.toString(16).padStart(4, '0') : 'N/A'} PID: ${p.pid !== null ? p.pid.toString(16).padStart(4, '0') : 'N/A'}`,
            };
        });
        getHostAdapter().showQuickPick(items, {
            title: 'Available Serial Ports',
            placeHolder: 'Serial ports found across connected probe hosts',
        });

        return sourced.map((s) => s.port);
    }

    private cleanupSerialConfig(args: ConfigurationArguments) {
        const serialConfig = args.serialConfig as any as SerialConfig | undefined;
        const ports: SerialParams[] = [];
        if (serialConfig?.enabled && ports && ports.length > 0) {
            for (const portConfig of ports) {
                if (!portConfig.path && !portConfig.serial && !portConfig.vid && !portConfig.pid && !portConfig.match) {
                    this.logError(`Invalid serial port configuration: ${JSON.stringify(portConfig)}. Each port must have at least one of path/serial/vid/pid/match. This port configuration will be ignored.`);
                } else {
                    ports.push(portConfig);
                }
            }
            serialConfig.ports = ports;
        }
        if (!serialConfig || !serialConfig.enabled || !serialConfig.ports || serialConfig.ports.length === 0) {
            if (serialConfig) {
                delete args.serialConfig;
            }
            return;
        }
    }

    public async createSerialPorts(args: ConfigurationArguments): Promise<void> {
        this.cleanupSerialConfig(args);
        if (!args.serialConfig || !args.serialConfig.enabled || !args.serialConfig.ports || args.serialConfig.ports.length === 0) {
            return;
        }
        // One debug session uses exactly one proxy (that proxy may host several
        // sub-sessions in the multi-core case), so all of this session's ports
        // are opened on a single connection resolved from the session's
        // hostConfig. The manager keeps that connection in its registry, so a
        // second session pointing at a different remote gets its own connection
        // instead of tearing this one down.
        const rawHostConfig = typeof args?.hostConfig === "boolean"
            ? (args.hostConfig ? { enabled: true, type: "auto" as const } : undefined)
            : args?.hostConfig;
        const tmpHostConfig: HostConfig = rawHostConfig || {
            type: getHostAdapter().getRemoteName() ? "auto" : "local",
            enabled: true,
        };
        const resolvedHostConfig = await this.resolveProxy(tmpHostConfig);
        if (!resolvedHostConfig || !resolvedHostConfig.pvtProxyPort || resolvedHostConfig.pvtProxyPort <= 0) {
            this.logError(`Failed to resolve proxy configuration for serial ports. Serial ports will not be available.`);
            return;
        }
        const conn = this.getOrCreateConnection(resolvedHostConfig);
        const initDone = await conn.connect(resolvedHostConfig);
        if (!initDone) {
            this.logError(`Failed to connect to proxy for serial ports. Serial ports will not be available.`);
            return;
        }
        const serialConfig = args.serialConfig;
        for (const portConfig of serialConfig.ports) {
            try {
                const pInfo = await conn.openSerialPort(portConfig);
                if (!pInfo) {
                    const sel = portSel(portConfig);
                    this.logError(`Failed to open serial port ${sel}`);
                    continue;
                }
                // TODO: Remove following debug stuff
                const pInfoStr = JSON.stringify(pInfo);
                const configStr = JSON.stringify(portConfig);
                this.logInfo(`Serial port ${configStr} opened successfully on proxy ${pInfoStr}`);
                await this.createOrUpdateViewWithSerialInfo(conn, pInfo, portConfig, true);
            } catch (e: any) {
                const sel = JSON.stringify(portConfig);
                this.logError(`Failed to open serial port ${sel}: ${e.message}`);
            }
        }
    }

    /**
     * Create or update a view with the given serial port information.
     * @param pInfo - Return value of `openSerialPort()`
     * @param portConfig - Configuration of the serial port originally specification from launch.json
     * @param isNew - Whether this is a fresh open (vs. a reconnect)
     */
    private async createOrUpdateViewWithSerialInfo(conn: ProxyConnection, pInfo: SerialOpenInfo, portConfig: SerialParams, isNew: boolean = false): Promise<void> {
        const log_file = portConfig.log_file;
        const input_mode = portConfig.input_mode;
        const actualPath: string = resolvedPath(pInfo) || portConfig.path || '';
        const key = this.ckey(conn, actualPath);
        this.serialPortConfigs.set(key, { ...portConfig, path: actualPath });
        let tcpPort = pInfo.tcp_port || 0;
        if (pInfo.channel_id && !pInfo.tcp_port) {
            const server = conn.ensureStreamServer(SERIAL_VIEW_HOST, actualPath, pInfo.channel_id);
            // listen() is asynchronous. Reading getPort() here used to return 0 every time,
            // so the guard below rejected a port whose listener was about to come up one
            // tick later -- the view was never created and the log said "no TCP port
            // assigned" immediately before "listening on 127.0.0.1:<port>".
            tcpPort = (await server.whenReady()) || 0;
        }
        if (tcpPort <= 0) {
            this.logError(`Serial port ${actualPath} has no TCP port assigned; cannot create view.`);
            return;
        }
        let view = this.serialPortViews.get(key);
        const host = SERIAL_VIEW_HOST;
        if (view) {
            view.setTcpPort(tcpPort);
            view.setLogFile(log_file ?? undefined);
            view.setInputMode(input_mode ?? undefined);
        } else {
            view = getHostAdapter().createSerialPortView(actualPath, { ...portConfig, path: actualPath }, isNew, tcpPort);
            this.serialPortViews.set(key, view);
            view.emitter.on("close", () => {
                this.removeSerialPortTab(conn, actualPath);
            });
        }
        if (isNew) {
            view.notifyConnected(`Serial port ${actualPath} opened successfully on initial launch on tcp port ${host}:${tcpPort}`);
        } else {
            view.notifyReconnected();
        }
    }

    public getSerialPortTab(path: string): ISerialPortView | null {
        // No connection context here (unused externally today). Match on the
        // path component of the composite key so it works across connections.
        const suffix = `${KEY_SEP}${path}`;
        for (const [key, view] of this.serialPortViews) {
            if (key.endsWith(suffix)) {
                return view;
            }
        }
        return null;
    }

    public removeSerialPortTab(conn: ProxyConnection, path: string, skipSerialClose: boolean = false, keepConfig: boolean = false) {
        const key = this.ckey(conn, path);
        const timer = this.reconnectTimers.get(key);
        if (timer) {
            clearTimeout(timer);
            this.reconnectTimers.delete(key);
        }
        if (!keepConfig) {
            this.serialPortConfigs.delete(key);
        }
        if (this.serialPortViews.get(key)) {
            this.serialPortViews.delete(key);
        }
        // Now that the view is removed, we can also close the serial port on the proxy side if it's still open. This is
        // important to free up resources on the proxy side and also to allow the user to reopen the same port later.
        conn.closePort(path, skipSerialClose);
    }

    /**
     * Tear down all connections and pending reconnect timers. Not wired into a
     * session lifecycle yet (proxies persist across sessions by design), but the
     * primitive exists so tests — and any future reset — can release sockets and
     * the per-connection heartbeat intervals.
     */
    public dispose() {
        for (const timer of this.reconnectTimers.values()) {
            clearTimeout(timer);
        }
        this.reconnectTimers.clear();
        for (const conn of this.connections.values()) {
            conn.dispose();
        }
        this.connections.clear();
    }

    public static Dispose() {
        if (SerialPortManager.instance) {
            SerialPortManager.instance.dispose();
            SerialPortManager.instance = null;
        }
    }
}

/**
 * Represents an active connection to a serial port on the proxy side, including the TCP server that the proxy helper creates for it and the socket
 * connection to that server. The owning {@link ProxyConnection} keeps track of these and routes data between the terminal and the socket.
 *
 * For non remote ports, the proxy server is already listening on a TCP port and we just need to connect to it and forward data. For remote ports, the proxy server creates a new TCP server for each port and reports the port number back to us, so we need to create a new socket connection for each port and manage those separately.
 */
export class ProxySerialTcpServer {
    private server: net.Server;
    private address: net.AddressInfo | null = null;
    private socket: net.Socket | null = null;
    /**
     * Bytes waiting for a client to connect to this listener.
     *
     * Held as Buffers, never a string. This is a byte pipe: what the far end does with
     * the bytes -- a UTF-8 terminal, latin1, or a binary decoder such as defmt-print --
     * is its business, and decoding here destroys the data before it can get there.
     *
     * `msgBuffer += data.toString()` was lossy three ways. Any byte that is not valid
     * UTF-8 became U+FFFD, irreversibly. A multi-byte character split across two TCP
     * chunks decoded to two replacement characters even when the text was perfectly
     * valid -- chunk boundaries are wherever TCP happened to segment. And `.length` on
     * a string counts UTF-16 code units, so neither the cap nor the trim below was
     * measured in bytes, and the trim could cut a surrogate pair in half.
     */
    private pending: Buffer[] = [];
    private pendingBytes = 0;
    /** Drop oldest above this; a console wants the most recent bytes, not the first. */
    private static readonly MaxPendingBytes = 100 * 1024;
    private static readonly KeepPendingBytes = 50 * 1024;
    /** Resolves with the bound port. `listen()` is async: getPort() reads 0 until it fires. */
    private readonly ready: Promise<number>;
    private markReady!: (port: number) => void;
    constructor(private host: string, private portPath: string, private stream_id: number, private conn: ProxyConnection) {
        this.ready = new Promise<number>((resolve) => {
            this.markReady = resolve;
        });
        this.server = net.createServer((socket) => {
            this.conn.logInfo(`Client connected to TCP server for serial port ${portPath} (stream_id ${stream_id})`);
            if (this.socket) {
                this.conn.logError(`A client is already connected to TCP server for serial port ${portPath} (stream_id ${stream_id}). Closing previous connection.`);
                this.socket.destroy();
            }
            this.socket = socket;
            if (this.pendingBytes > 0) {
                socket.write(Buffer.concat(this.pending, this.pendingBytes));
                this.pending = [];
                this.pendingBytes = 0;
            }
            socket.on("data", (data: Buffer) => {
                this.dataFromTerminal(data);
            });
            socket.on("error", (err) => {
                this.conn.logError(`Error on TCP server for serial port ${portPath} (stream_id ${stream_id}): ${err.message}`);
            });
            socket.on("close", () => {
                this.conn.logInfo(`Client disconnected from TCP server for serial port ${portPath} (stream_id ${stream_id})`);
            });
        });
        this.server.listen(0, this.host, () => {
            const address = this.server.address();
            if (address && typeof address === "object") {
                this.address = address;
                this.conn.logInfo(`TCP server for serial port ${portPath} (stream_id ${stream_id}) listening on ${this.address.address}:${this.address.port}`);
            }
            this.markReady(this.address?.port ?? 0);
        });
        this.server.on("error", (err) => {
            this.conn.logError(`TCP server for serial port ${portPath} (stream_id ${stream_id}) failed: ${err.message}`);
            this.markReady(0); // never leave a caller awaiting a port that will not arrive
        });
    }

    setChannelId(channel_id: number) {
        this.stream_id = channel_id;
    }

    getAddress(): net.AddressInfo | null {
        return this.address;
    }

    getPort(): number {
        return this.address ? this.address.port : 0;
    }

    /** Await the bound port. Resolves 0 if the listener failed to bind. */
    whenReady(): Promise<number> {
        return this.ready;
    }

    /** Close the local TCP listener and any connected client. */
    close() {
        if (this.socket) {
            this.socket.destroy();
            this.socket = null;
        }
        this.server.close();
    }

    dataFromTerminal(data: Buffer) {
        this.conn.sendCommandBytes(this.stream_id, data);
    }

    dataFromServer(data: Buffer, stream_id: number) {
        if (this.socket && !this.socket.destroyed) {
            this.socket.write(data);
        } else if (data.length > 0) {
            this.pending.push(data);
            this.pendingBytes += data.length;
            if (this.pendingBytes > ProxySerialTcpServer.MaxPendingBytes) {
                this.conn.logError(`Message buffer overflow for serial port ${this.portPath} (stream_id ${stream_id})`);
                // Drop whole chunks from the front rather than slicing bytes: cheaper, and
                // it cannot leave a partial chunk behind.
                while (this.pendingBytes > ProxySerialTcpServer.KeepPendingBytes && this.pending.length > 1) {
                    this.pendingBytes -= this.pending.shift()!.length;
                }
            }
        }
    }
}
