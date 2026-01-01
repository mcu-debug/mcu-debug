import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as net from "net";
import * as lockfile from "proper-lockfile";
import { EventEmitter } from "events";

class PortRangeLock {
    constructor(
        private lockPaths: string[],
        public readonly ports: number[],
    ) {}

    async release(): Promise<void> {
        await Promise.all(this.lockPaths.map((p) => lockfile.unlock(p).catch(() => {})));
    }
}

interface findFreePortsOptions {
    start?: number;
    consecutive?: boolean;
    avoid?: Set<number>;
}

const allLockFiles: PortRangeLock[] = [];

export class TcpPortScanner {
    public static readonly LoopbackAddr = "127.0.0.1";
    public static readonly AllInterfaces = "0.0.0.0";

    public static PortAllocated: EventEmitter = new EventEmitter();
    // Anything allocated using findFreePorts() is added into this set. Never cleared but clients can feel free to clear
    // findFreePorts() will avoid these ports
    public static AvoidPorts: Set<number> = new Set<number>();

    public static EmitAllocated(ports: number[]) {
        if (ports && ports.length) {
            for (const p of ports) {
                TcpPortScanner.AvoidPorts.add(p);
            }
            TcpPortScanner.PortAllocated.emit("allocated", ports);
        }
    }

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
    public static async isPortInUse(port: number, avoid: Set<number> | undefined, hosts?: string[]): Promise<boolean> {
        if (avoid && avoid.has(port)) {
            return true;
        }

        // If a specific host is requested, check only that.
        // Otherwise, check both 127.0.0.1 and 0.0.0.0 to be safe across platforms (e.g. macOS vs Linux)
        const hostsToCheck = hosts && hosts.length ? hosts : [TcpPortScanner.LoopbackAddr, TcpPortScanner.AllInterfaces];

        for (const h of hostsToCheck) {
            const inUse = await TcpPortScanner.checkPortStatus(port, h);
            if (inUse) {
                return true;
            }
        }

        return false;
    }

    private static checkPortStatus(port: number, host: string): Promise<boolean> {
        return new Promise((resolve, reject) => {
            const server = net.createServer(() => {
                // We should not get here
            });

            server.once("error", (err: { code?: string }) => {
                if (err.code === "EADDRINUSE") {
                    // Port is in use on the specified host
                    resolve(true);
                } else {
                    // Other error (e.g., permission denied)
                    reject(err);
                }
            });

            server.once("close", () => {
                resolve(false);
            });

            server.listen(port, host, () => {
                server.close();
            });
        });
    }

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
    public static findFreePorts(numPorts: number, options: findFreePortsOptions = {}): Promise<number[]> {
        return new Promise<number[]>((resolve, reject) => {
            findAvailablePortRange(numPorts, options.start ?? 30000, options.consecutive ?? false, options.avoid)
                .then((lock) => {
                    allLockFiles.push(lock);
                    resolve(lock.ports);
                })
                .catch((err) => {
                    reject(err);
                });
        });
    }
}

async function tryReserveRange(start: number, count: number, consecutive = false, avoid: Set<number> | undefined): Promise<PortRangeLock | null> {
    const ports: number[] = [];
    const lockPaths: string[] = [];
    const releaseLocks: (() => Promise<void>)[] = [];

    try {
        for (let i = 0; ports.length < count; i++) {
            const port = start + i;
            if (port > 65535) {
                throw new Error("Out of ports");
            }

            const lockPath = path.join(os.tmpdir(), `mcu-debug-port-${port}.lock`);

            const inUse = await TcpPortScanner.isPortInUse(port, avoid);
            if (inUse) {
                if (consecutive) {
                    throw new Error(`Port ${port} is already in use`);
                } else {
                    continue;
                }
            }

            try {
                // Ensure file exists
                if (!fs.existsSync(lockPath)) {
                    fs.writeFileSync(lockPath, "");
                }

                const release = await lockfile.lock(lockPath, { stale: 30000 });

                lockPaths.push(lockPath);
                releaseLocks.push(release);
                ports.push(port);
            } catch (e) {
                if (consecutive) {
                    throw e;
                }
                // If not consecutive, just treat this port as unavailable and continue
                continue;
            }
        }

        return new PortRangeLock(lockPaths, ports);
    } catch (err) {
        // Cleanup locks we got
        try {
            await Promise.all(releaseLocks.map((r) => r().catch(() => {})));
        } catch (e: any) {
            console.error(`Error releasing port locks: ${e.toString()}`);
        }
        return null;
    }
}

export async function findAvailablePortRange(count: number, preferredStart: number, consecutive: boolean, avoid: Set<number> | undefined): Promise<PortRangeLock> {
    for (let base = preferredStart ?? 30000; base < 65535; base += 10) {
        const result = await tryReserveRange(base, count, consecutive, avoid);
        if (result) return result;
    }

    throw new Error(`Could not find ${count} consecutive free ports`);
}

process.on("exit", async () => {
    for (const lock of allLockFiles) {
        try {
            await lock.release();
        } catch {
            // Ignore
        }
    }
});
