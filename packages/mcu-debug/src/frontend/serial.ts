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
import * as vscode from "vscode";
import * as path from "path";
import { SerialParams } from "@mcu-debug/shared/serial-helper/SerialParams";
import { AvailablePort } from "@mcu-debug/shared/serial-helper/AvailablePort";
import { SerialPortInfo } from "@mcu-debug/shared/proxy-protocol/SerialPortInfo";
import { SerialErrorKind } from "@mcu-debug/shared/serial-helper/SerialErrorKind";
import { awaitWithTimeout, ConfigurationArguments, HostConfig, SerialConfig, TerminalInputMode } from "../adapter/servers/common";
import { EventEmitter } from "stream";
import { MCUDebugChannel } from "../dbgmsgs";
import { getProxyForSerialPorts } from "./proxy";
import { ControlMessage } from "@mcu-debug/shared/proxy-protocol/ControlMessage";
import { setExtensionPath } from "./proxy";
import { getUUid, ManagedTab } from "./views/ManagedTab";
import { CockpitPanel } from "./views/CockpitPanel";
import { TabKind } from "@mcu-debug/shared/lib/cockpit-protocol";

const PROXY_TIMOUT = 5000;

interface SerialPortMap {
    path: string;
    tcp_port: number;
}

type SerialPortMapList = SerialPortMap[];

interface ProxyConnectionInfo {
    host: string;
    port: number;
    token: string;
}

export class SerialPortManager {
    static instance: SerialPortManager | null = null;
    private socket: net.Socket | null = null;
    private proxyInfo: ProxyConnectionInfo | null = null;
    private heartbeatTimer: NodeJS.Timeout | null = null;
    private isFunnelTransport: boolean = false;
    private clientStreams: Map<number, ProxySerialTcpServer> = new Map();
    private nextSeq: number = 1;
    private pendingPromises: Map<number, { resolve: (value: any) => void; reject: (reason?: any) => void }> = new Map();
    private availablePorts: AvailablePort[] = [];
    private openPorts: SerialPortInfo[] = [];
    private serialPortViews: Map<string, SerialPortView> = new Map();
    private serialPortConfigs: Map<string, SerialParams> = new Map();
    private reconnectTimers: Map<string, NodeJS.Timeout> = new Map();
    private pendingAvailableSnapshotResolvers: Array<() => void> = [];

    constructor(private context: vscode.ExtensionContext) {
        SerialPortManager.instance = this;
        setExtensionPath(context.extensionPath);
    }

    public logInfo(message: string) {
        MCUDebugChannel.debugMessage(message);
    }
    public logError(message: string) {
        MCUDebugChannel.debugMessage(`ERROR: ${message}`);
        vscode.window.showErrorMessage(message);
    }

    /** Human-readable description of a port selector for log messages. */
    private static portSel(p: SerialParams): string {
        if (p.path) { return p.path; }
        if (p.serial) { return `serial=${p.serial}`; }
        if (p.vid || p.pid) { return `vid=${p.vid ?? '?'} pid=${p.pid ?? '?'}`; }
        return '(no selector)';
    }

    /**
     * Extract the resolved device path from a SerialPortInfo.
     *
     * `serial.open` responses have shape { path, tcp_port, channel_id } at the
     * top level, while `serial.listOpen` entries have { params.path, ... }.
     * Both shapes live in openPorts[], so we check both.
     */
    private static resolvedPath(info: SerialPortInfo): string | undefined {
        return (info as any).path || info.params?.path || undefined;
    }

    private destroySocket() {
        if (this.socket) {
            this.socket.destroy();
            this.socket = null;
            this.proxyInfo = null;
        }
    }

    private lastProxyInfo: string = ""
    private connectToProxy(hostConfig: HostConfig): Promise<boolean> {
        const newProxyInfo = JSON.stringify(hostConfig);
        if (this.lastProxyInfo === newProxyInfo && this.socket && !this.socket.destroyed) {
            return Promise.resolve(true);
        }
        this.lastProxyInfo = newProxyInfo;
        const host = hostConfig.pvtProxyHost || "127.0.0.1";
        const port = hostConfig.pvtProxyPort || 4567;
        const token = hostConfig.token || hostConfig.pvtProxyToken || "adis-ababa";
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
                this.destroySocket()
            });
            socket.once("connect", async () => {
                this.logInfo(`Successfully connected to proxy on ${host}:${port}`);
                this.socket = socket;
                this.proxyInfo = { host: host, port: port, token };
                await this.subscribeToSerialAvailability();
                this.startHeartbeat();
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
            await awaitWithTimeout(this.sendControlCommand(controlMsg), PROXY_TIMOUT);
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
                let server = this.clientStreams.get(stream_id);
                if (server) {
                    server.dataFromServer(payload, stream_id);
                } else {
                    this.logError(`Received data for unknown stream_id ${stream_id}`);
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
                        this.handlePortError(msg.params.path, errKind, errMsg);
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
                this.logInfo(`Received response for seq ${msg.seq}: ${msg.success ? "ok" : `error: ${msg.message}`}`);
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

    private handlePortError(portPath: string, kind: SerialErrorKind, msg: string) {
        const view = this.serialPortViews.get(portPath);
        if (kind === "disconnected" && view) {
            // The helper may already have torn down serial state; drop manager-side state and recreate.
            view.notifyDisconnected(msg);
            this.removeSerialPortTab(portPath, true, true);
            this.scheduleReconnect(portPath);
        } else {
            this.removeSerialPortTab(portPath);
        }
    }

    private scheduleReconnect(portPath: string, delayMs: number = 3000) {
        if (this.reconnectTimers.has(portPath)) {
            return;
        }
        const timer = setTimeout(() => {
            this.reconnectTimers.delete(portPath);
            this.attemptReconnect(portPath);
        }, delayMs);
        this.reconnectTimers.set(portPath, timer);
    }

    private async attemptReconnect(portPath: string): Promise<void> {
        const reconnectConfig = this.serialPortConfigs.get(portPath);
        if (!reconnectConfig) {
            return;
        }
        const lCasePath = portPath.toLowerCase();
        const isAvailable = this.availablePorts.some((p) => p.path.toLowerCase() === lCasePath);
        if (!isAvailable) {
            // Port is not in the available list yet; reschedule and wait for it to reappear.
            this.scheduleReconnect(portPath, 3000);
            return;
        }
        try {
            const result = await this.openSerialPort({ ...reconnectConfig }, true);
            if (result) {
                const configPath = reconnectConfig.path;
                const actualPath: string = SerialPortManager.resolvedPath(result) || configPath || '';
                const reconnectViewConfig: SerialParams = {
                    ...reconnectConfig,
                    path: actualPath,
                };
                if (actualPath !== configPath) {
                    this.serialPortConfigs.delete(configPath ?? '');
                }
                this.createOrUpdateViewWithSerialInfo(result, reconnectViewConfig, false);
                const view = this.serialPortViews.get(actualPath);
                if (!view) {
                    return;
                }
                return;
            }
        } catch {
            // fall through to retry
        }
        this.scheduleReconnect(portPath, 3000);
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
            const openPorts = await awaitWithTimeout(this.sendControlCommand(controlMsg), PROXY_TIMOUT);
            this.logInfo(`Open serial ports: ${JSON.stringify(openPorts)}`);
            this.openPorts = openPorts && openPorts["serial.listOpen"] ? openPorts["serial.listOpen"].ports : [];
            return this.openPorts;
        } catch (err) {
            this.logError(`Failed to get serial ports list: ${err}`);
            this.openPorts = [];
            return [];
        }
    }

    public getSerialPortInfo(path: string): SerialPortInfo | null {
        for (const port of this.openPorts) {
            if (SerialPortManager.resolvedPath(port) === path) {
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
            const availPorts = await awaitWithTimeout(this.sendControlCommand(controlMsg), PROXY_TIMOUT);
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

    public async listAvailablePortsCmd(noDisplay?: boolean): Promise<AvailablePort[]> {
        const tmpHostConfig: HostConfig = {
            type: vscode.env.remoteName ? "auto" : "local",
            enabled: true,
        }
        const resolvedHostConfig = await getProxyForSerialPorts(tmpHostConfig);
        if (!resolvedHostConfig) {
            this.logError(`Failed to resolve proxy configuration for serial ports. Serial ports will not be available.`);
            return [];
        }
        const initDone = await this.connectToProxy(resolvedHostConfig);
        if (!initDone) {
            this.logError(`Failed to connect to proxy for serial ports. Serial ports will not be available.`);
            return [];
        }
        const ports = this.getCurrentSerialPorts();
        if (noDisplay) {
            return ports;
        }

        const items = [];
        for (const p of ports) {
            items.push({
                label: p.path,
                description: p.description ?? '',
                detail: `VID: ${p.vid !== null ? p.vid.toString(16).padStart(4, '0') : 'N/A'} PID: ${p.pid !== null ? p.pid.toString(16).padStart(4, '0') : 'N/A'}`,
            });
        }
        vscode.window.showQuickPick(items, {
            title: 'Available Serial Ports',
            canPickMany: false,
            matchOnDescription: true,
            matchOnDetail: true,
            placeHolder: 'Serial ports found on the probe host',
        });

        return ports;
    }

    public async openSerialPort(serialParams: SerialParams, silent: boolean = false): Promise<SerialPortInfo | null> {
        try {
            serialParams.transport = this.isFunnelTransport ? "funnel" : "direct";   // Default to proxy transport for remote workspaces and direct transport for local workspaces. The proxy will handle the transport details on its side.
            const controlMsg: ControlMessage = {
                seq: this.nextSeq++,
                method: "serial.open",
                params: serialParams,
            };
            const result = await awaitWithTimeout(this.sendControlCommand(controlMsg), PROXY_TIMOUT);
            const openInfo = (result && result["serial.open"] ? result["serial.open"] : null) as SerialPortInfo | null;
            if (!openInfo) {
                return null;
            }
            const openPath = SerialPortManager.resolvedPath(openInfo);
            if (openPath) {
                let updated = false;
                for (let ix = 0; ix < this.openPorts.length; ix++) {
                    if (SerialPortManager.resolvedPath(this.openPorts[ix]) === openPath) {
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
                const sel = SerialPortManager.portSel(serialParams);
                this.logError(`Failed to open serial port ${sel}: ${err}`);
            }
            return null;
        }
    }

    public getCurrentSerialPorts(): AvailablePort[] {
        return this.availablePorts;
    }

    public getCurrentOpenSerialPorts(): SerialPortInfo[] {
        return this.openPorts;
    }

    private cleanupSerialConfig(args: ConfigurationArguments) {
        const serialConfig = args.serialConfig as any as SerialConfig | undefined;
        const ports: SerialParams[] = [];
        if (serialConfig?.enabled && ports && ports.length > 0) {
            for (const portConfig of ports) {
                if (!portConfig.path && !portConfig.serial && !portConfig.vid && !portConfig.pid) {
                    this.logError(`Invalid serial port configuration: ${JSON.stringify(portConfig)}. Each port must have at least one of path/serial/vid/pid. This port configuration will be ignored.`);
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
        if (!args.serialConfig) {
            return;
        }
        // TODO: We have a problem here. In the regular ssh case, we can have both a remote serial ports and
        // local serial ports. But we have only one proxy connection that can be used to open remote serial ports.
        // If we open a local serial port first, it will use the proxy connection and work fine. But then when we
        // try to open a remote serial port, it will also try to use the same proxy connection, which will fail because
        // the local serial port is already using it. On the other hand, if we open the remote serial port first, it will
        // use the proxy connection and work fine, but then when we try to open a local serial port, it will also try to
        // use the same proxy connection, which will fail because the remote serial port is already using it. So we need to
        // open all remote serial ports first, and then open all local serial ports. This is not ideal, but it's a limitation
        // of the current design of the proxy connection. We should consider redesigning the proxy connection in the future
        // to allow multiple concurrent connections for different purposes (e.g. one for remote serial ports, one for local
        // serial ports, etc.). For now, we will just open all remote serial ports first, and then open all local serial ports.

        // In fact, it is possible that we can have MULTIPLE remote serial ports if the user is experimenting with various ssh
        // configs. One launch.json config may point to one remote host and another launch.json config may point to another
        // remote host. Or the user may switch between ssh and devcontainer remotes.
        //
        // This is generally not a problem for debug sessions because we will allow only one proxy per session (multi-core may
        // violate this assumption but we will deal with that separately), but for serial ports, we want to be able to support multiple

        // We could support, only in the case of pure ssh, one ssh remote and one local max. Everything else, the workspace type
        // dictates what we do and there can only be one type of remote. So we can just check the workspace type and if it's ssh,
        // we can allow both local and remote serial ports, but if it's devcontainer or wsl, we can only allow one type of serial port.
        // This is not ideal, but it's a reasonable compromise given the limitations of the current proxy design.
        const tmpHostConfig: HostConfig | undefined = args?.hostConfig || {
            type: vscode.env.remoteName ? "auto" : "local",
            enabled: true,
        }
        this.isFunnelTransport = (tmpHostConfig.type === "ssh" || vscode.env.remoteName !== undefined);
        const resolvedHostConfig = await getProxyForSerialPorts(tmpHostConfig);
        if (!resolvedHostConfig) {
            this.logError(`Failed to resolve proxy configuration for serial ports. Serial ports will not be available.`);
            return;
        }
        const initDone = await this.connectToProxy(resolvedHostConfig);
        if (!initDone) {
            this.logError(`Failed to connect to proxy for serial ports. Serial ports will not be available.`);
            return;
        }
        this.availablePorts = this.getCurrentSerialPorts();
        const serialConfig = args.serialConfig;
        for (const portConfig of serialConfig.ports) {
            try {
                const pInfo = await this.openSerialPort(portConfig) as SerialPortInfo | null;
                if (!pInfo) {
                    const sel = SerialPortManager.portSel(portConfig);
                    this.logError(`Failed to open serial port ${sel}`);
                    continue;
                }
                this.createOrUpdateViewWithSerialInfo(pInfo, portConfig, true);
            } catch (e: any) {
                const sel = portConfig.path ?? portConfig.serial ?? `vid=${portConfig.vid} pid=${portConfig.pid}`;
                this.logError(`Failed to open serial port ${sel}: ${e.message}`);
            }
        }
    }

    /**
     * Create or update a view with the given serial port information.
     * @param pInfo - Return value of `openSerialPort()`
     * @param portConfig - Configuration of the serial port originally specification from launch.json
     * @param log_file - Path to the log file
     * @param input_mode - Input mode for the serial port
     */
    private createOrUpdateViewWithSerialInfo(pInfo: SerialPortInfo, portConfig: SerialParams, isNew: boolean = false) {
        const log_file = portConfig.log_file;
        const input_mode = portConfig.input_mode;
        const actualPath: string = SerialPortManager.resolvedPath(pInfo) || portConfig.path || '';
        this.serialPortConfigs.set(actualPath, { ...portConfig, path: actualPath });
        let server: ProxySerialTcpServer | undefined;
        if (pInfo.channel_id) {
            server = this.clientStreams.get(pInfo.channel_id);
            if (server) {
                server.setChannelId(pInfo.channel_id);
            } else {
                server = new ProxySerialTcpServer("127.0.0.1", actualPath, pInfo.channel_id, this);
                this.clientStreams.set(pInfo.channel_id, server);
            }
        }
        const tcpPort = pInfo.tcp_port || server?.getPort() || 0;
        let view = this.serialPortViews.get(actualPath);
        if (view) {
            view.setTcpPort(tcpPort);
            view.setLogFile(log_file ?? undefined);
            view.setInputMode(input_mode ?? undefined);
        } else {
            view = SerialPortView.createOrGetTab(actualPath, { ...portConfig, path: actualPath }, isNew, tcpPort);
            this.serialPortViews.set(actualPath, view);
            view.emitter.on("close", () => {
                this.removeSerialPortTab(actualPath);
            });
        }
        if (isNew) {
            view.notifyConnected(`Serial port ${actualPath} opened successfully on initial launch`);
        } else {
            view.notifyReconnected();
        }
    }

    public getSerialPortTab(path: string): SerialPortView | null {
        return this.serialPortViews.get(path) || null;
    }

    public removeSerialPortTab(path: string, skipSerialClose: boolean = false, keepConfig: boolean = false) {
        const timer = this.reconnectTimers.get(path);
        if (timer) {
            clearTimeout(timer);
            this.reconnectTimers.delete(path);
        }
        if (!keepConfig) {
            this.serialPortConfigs.delete(path);
        }
        const view = this.serialPortViews.get(path);
        if (view) {
            this.serialPortViews.delete(path);
        }
        // Now that the view is removed, we can also close the serial port on the proxy side if it's still open. This is important to free up resources on the proxy side and also to allow the user to reopen the same port later if they want to.
        const portInfo = this.getSerialPortInfo(path);
        if (portInfo) {
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
            this.openPorts = this.openPorts.filter((p) => SerialPortManager.resolvedPath(p) !== path);
            for (const [stream_id, server] of this.clientStreams.entries()) {
                if (server.getPort() === portInfo?.tcp_port) {
                    server.dataFromServer(Buffer.from(""), stream_id);   // Send an empty message to trigger any cleanup on the server side
                    this.clientStreams.delete(stream_id);
                    break;
                }
            }
        }
    }
}

class SerialPortView extends ManagedTab {
    public emitter = new EventEmitter();
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
            `serial-${getUUid('serial')}`,
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
        this.send(`\r\n\x1b[32m[${this.device} connected] ${reason}\x1b[0m\r\n`);
        this.setState({ kind: "active" });
    }

    public notifyDisconnected(reason: string) {
        this.destroySocket();
        this.send(`\r\n\x1b[33m[${this.device} disconnected: ${reason} — retrying...]\x1b[0m\r\n`);
        this.setState({ kind: "inactive" });
    }

    public notifyReconnected() {
        this.send(`\r\n\x1b[32m[${this.device} reconnected]\x1b[0m\r\n`);
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
                vscode.window.showErrorMessage(`Failed to create log file stream for ${log_file}`);
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

/**
 * Represents an active connection to a serial port on the proxy side, including the TCP server that the proxy helper creates for it and the socket
 * connection to that server. The SerialPortManager keeps track of these and routes data between the terminal and the socket.
 * 
 * For non remote ports, the proxy server is already listening on a TCP port and we just need to connect to it and forward data. For remote ports, the proxy server creates a new TCP server for each port and reports the port number back to us, so we need to create a new socket connection for each port and manage those separately.
 */
export class ProxySerialTcpServer {
    private server: net.Server;
    private address: net.AddressInfo | null = null;
    private socket: net.Socket | null = null;
    private msgBuffer: string = "";
    constructor(private host: string, private portPath: string, private stream_id: number, private manager: SerialPortManager) {
        this.server = net.createServer((socket) => {
            this.manager.logInfo(`Client connected to TCP server for serial port ${portPath} (stream_id ${stream_id})`);
            if (this.socket) {
                this.manager.logError(`A client is already connected to TCP server for serial port ${portPath} (stream_id ${stream_id}). Closing previous connection.`);
                this.socket.destroy();
            }
            this.socket = socket;
            if (this.msgBuffer.length > 0) {
                socket.write(this.msgBuffer);
                this.msgBuffer = "";
            }
            socket.on("data", (data: Buffer) => {
                this.dataFromTerminal(data);
            });
            socket.on("error", (err) => {
                this.manager.logError(`Error on TCP server for serial port ${portPath} (stream_id ${stream_id}): ${err.message}`);
            });
            socket.on("close", () => {
                this.manager.logInfo(`Client disconnected from TCP server for serial port ${portPath} (stream_id ${stream_id})`);
            });
        });
        this.server.listen(0, this.host, () => {
            const address = this.server.address();
            if (address && typeof address === "object") {
                this.address = address;
                this.manager.logInfo(`TCP server for serial port ${portPath} (stream_id ${stream_id}) listening on ${this.address.address}:${this.address.port}`);
            }
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

    dataFromTerminal(data: Buffer) {
        this.manager.sendCommandBytes(this.stream_id, data);
    }

    dataFromServer(data: Buffer, stream_id: number) {
        if (this.socket && !this.socket.destroyed) {
            this.socket.write(data);
        } else {
            this.msgBuffer += data.toString();
            if (this.msgBuffer.length > 100 * 1024  /* 100KB */) {
                this.manager.logError(`Message buffer overflow for serial port ${this.portPath} (stream_id ${stream_id})`);
                this.msgBuffer = this.msgBuffer.slice(this.msgBuffer.length - 50 * 1024);   // Keep only the last 50KB to avoid unbounded growth
            }
        }
    }
}
