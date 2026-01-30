import { EventEmitter } from "events";
declare class PortRangeLock {
    private lockPaths;
    readonly ports: number[];
    constructor(lockPaths: string[], ports: number[]);
    release(): Promise<void>;
}
interface findFreePortsOptions {
    start?: number;
    consecutive?: boolean;
    avoid?: Set<number>;
}
export declare class TcpPortScanner {
    static readonly LoopbackAddr = "127.0.0.1";
    static readonly AllInterfaces = "0.0.0.0";
    static PortAllocated: EventEmitter;
    static AvoidPorts: Set<number>;
    static EmitAllocated(ports: number[]): void;
    static unlockPortsIfFree(ports: number[]): Promise<void>;
    /**
     * Checks to see if the port is in use by creating a server on that port. You should use the function
     * `isPortInUseEx()` if you want to do a more exhaustive check or a general purpose use for any host
     *
     * @param port port to use. Must be > 0 and <= 65535
     * @param host host ip address(es) to use. This should be an alias to a localhost. (Default: check both 127.0.0.1
     * and 0.0.0.0 covers all interfaces -- needed for macOS)
     * @param avoid if port is in this list, it is considered "in use"
     * @returns Promise that resolves to true if the port is in use, false otherwise
     */
    static isPortInUse(port: number, avoid: Set<number> | undefined, hosts?: string[]): Promise<boolean>;
    private static checkPortStatus;
    /**
     * Scan for free ports (no one listening) on the specified host.
     * Don't like the interface but trying to keep compatibility with `portastic.find()`. Unlike
     * `portastic` the default ports to retrieve is 1 and we also have the option of returning
     * consecutive ports
     *
     * Detail: While this function is async, promises are chained to find open ports recursively
     *
     * @param0
     * @param host Use any string that is a valid host name or ip address
     * @return a Promise with an array of ports or null when cb is used
     */
    static findFreePorts(numPorts: number, options?: findFreePortsOptions): Promise<number[]>;
}
export declare function findAvailablePortRange(count: number, preferredStart: number, consecutive: boolean, avoid: Set<number> | undefined): Promise<PortRangeLock>;
export {};
