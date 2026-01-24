import * as net from "net";
interface WaitForCallbacks {
    starting: (params: {
        host: string;
        port: number;
    }) => void;
    setup: (socket: net.Socket) => void;
    tryConnect?: () => void;
    connected: (socket: net.Socket) => void;
    timeout: () => void;
}
export interface ReturnObject {
    open: boolean;
    socket?: net.Socket;
    ipVersion?: number;
}
export interface WaitForPortArgs {
    protocol: "tcp" | "http";
    host: string;
    port: number;
    callbacks: WaitForCallbacks;
    path?: string;
    interval?: number;
    timeout?: number;
    waitForDns?: boolean;
}
export declare class WaitForPort {
    private params;
    IPv6enabled: boolean;
    constructor(params: WaitForPortArgs);
    private returnedSocket;
    private createConnectionWithTimeout;
    private checkHttp;
    private tryConnect;
    waitPort(): Promise<ReturnObject>;
}
export {};
