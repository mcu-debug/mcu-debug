"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.TcpPortScanner = void 0;
exports.findAvailablePortRange = findAvailablePortRange;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const net = __importStar(require("net"));
const lockfile = __importStar(require("proper-lockfile"));
const events_1 = require("events");
class PortRangeLock {
    lockPaths;
    ports;
    constructor(lockPaths, ports) {
        this.lockPaths = lockPaths;
        this.ports = ports;
    }
    async release() {
        await Promise.all(this.lockPaths.map((p) => lockfile.unlock(p).catch(() => { })));
    }
}
const allLockFiles = [];
class TcpPortScanner {
    static LoopbackAddr = "127.0.0.1";
    static AllInterfaces = "0.0.0.0";
    static PortAllocated = new events_1.EventEmitter();
    // Anything allocated using findFreePorts() is added into this set. Never cleared but clients can feel free to clear
    // findFreePorts() will avoid these ports
    static AvoidPorts = new Set();
    static EmitAllocated(ports) {
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
    static async isPortInUse(port, avoid, hosts) {
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
    static checkPortStatus(port, host) {
        return new Promise((resolve, reject) => {
            const server = net.createServer(() => {
                // We should not get here
            });
            server.once("error", (err) => {
                if (err.code === "EADDRINUSE") {
                    // Port is in use on the specified host
                    resolve(true);
                }
                else {
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
    static findFreePorts(numPorts, options = {}) {
        return new Promise((resolve, reject) => {
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
exports.TcpPortScanner = TcpPortScanner;
async function tryReserveRange(start, count, consecutive = false, avoid) {
    const ports = [];
    const lockPaths = [];
    const releaseLocks = [];
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
                }
                else {
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
            }
            catch (e) {
                if (consecutive) {
                    throw e;
                }
                // If not consecutive, just treat this port as unavailable and continue
                continue;
            }
        }
        return new PortRangeLock(lockPaths, ports);
    }
    catch (err) {
        // Cleanup locks we got
        try {
            await Promise.all(releaseLocks.map((r) => r().catch(() => { })));
        }
        catch (e) {
            console.error(`Error releasing port locks: ${e.toString()}`);
        }
        return null;
    }
}
async function findAvailablePortRange(count, preferredStart, consecutive, avoid) {
    for (let base = preferredStart ?? 30000; base < 65535; base += 10) {
        const result = await tryReserveRange(base, count, consecutive, avoid);
        if (result)
            return result;
    }
    throw new Error(`Could not find ${count} consecutive free ports`);
}
process.on("exit", async () => {
    for (const lock of allLockFiles) {
        try {
            await lock.release();
        }
        catch {
            // Ignore
        }
    }
});
