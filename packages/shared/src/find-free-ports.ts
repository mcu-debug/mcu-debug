import * as net from "net";
import { EventEmitter } from "events";

/**
 * Port reservation strategy
 * -------------------------
 * A port is claimed by *holding a listening socket on it*. Binding is simultaneously the
 * check and the claim, so there is no window between "we saw it was free" and "we took it".
 * The OS is the arbiter, which means the claim is honoured by every process on the machine,
 * cannot go stale, and is released automatically if this process dies.
 *
 * This replaces an earlier scheme based on `proper-lockfile`. That one created a sentinel file
 * per port under the temp directory, which (a) leaked those files forever, and (b) was
 * pathologically slow on Windows because every candidate port cost two binds plus a file
 * creation, a realpath, an mkdir and a stat -- and creating files in %TEMP% is exactly what
 * real-time virus scanning stalls on.
 *
 * The one thing a socket cannot do is stay held for the lifetime of the debug session, because
 * the gdb-server needs to bind the port itself. Callers must therefore call
 * `TcpPortScanner.releaseHeldPorts()` once they are done allocating and before they spawn
 * anything. The ports stay in `TcpPortScanner.AvoidPorts` after release, and the frontend
 * feeds them back to sibling sessions via `pvtAvoidPorts`, so they are not handed out twice.
 */

interface findFreePortsOptions {
    start?: number;
    consecutive?: boolean;
    avoid?: Set<number>;
}

const MaxPort = 65535;
const DefaultStartPort = 30000;

/**
 * BSD-derived stacks (macOS) let a process bind a specific address even when another process
 * holds the wildcard address on the same port, so there we have to hold both to have a real
 * claim. On Linux and Windows the wildcard bind already covers every address -- and a second
 * bind from this very process would fail with EADDRINUSE against ourselves.
 */
const claimNeedsAllHosts = process.platform === "darwin";

/**
 * Try to take a listening socket on `port` for `host`. Resolves with the server on success, or
 * `null` if the port is unavailable for any reason -- EADDRINUSE (someone has it), EACCES
 * (Windows Hyper-V/WSL excluded port range, or a privileged port), EADDRNOTAVAIL, etc. There is
 * no listen error that means "this port is usable", so every failure is simply "not available".
 */
function tryListen(port: number, host: string): Promise<net.Server | null> {
    return new Promise((resolve) => {
        const server = net.createServer((c) => c.destroy()); // Nobody should ever connect to a reservation
        const onError = () => {
            server.removeAllListeners();
            resolve(null);
        };
        server.once("error", onError);
        server.listen(port, host, () => {
            server.removeListener("error", onError);
            server.on("error", () => {}); // A late error must not become an unhandled exception
            server.unref(); // A reservation must never be the reason this process stays alive
            resolve(server);
        });
    });
}

function closeServer(server: net.Server): Promise<void> {
    return new Promise((resolve) => server.close(() => resolve()));
}

function closeServers(servers: net.Server[]): Promise<void[]> {
    return Promise.all(servers.map(closeServer));
}

/** The hosts we have to hold to consider a port truly ours. */
function claimHosts(): string[] {
    return claimNeedsAllHosts ? [TcpPortScanner.AllInterfaces, TcpPortScanner.LoopbackAddr] : [TcpPortScanner.AllInterfaces];
}

/**
 * Claim a single port. Returns the sockets holding it, or `null` if it could not be claimed.
 * The wildcard address is bound first because on macOS the more specific bind is the one that
 * is allowed to follow a wildcard bind, not the other way around.
 */
async function claimPort(port: number, avoid: Set<number> | undefined): Promise<net.Server[] | null> {
    if (avoid?.has(port) || TcpPortScanner.AvoidPorts.has(port)) {
        return null;
    }
    const servers: net.Server[] = [];
    for (const host of claimHosts()) {
        const server = await tryListen(port, host);
        if (!server) {
            await closeServers(servers);
            return null;
        }
        servers.push(server);
    }
    return servers;
}

/**
 * A claim on a set of ports, held open by listening sockets. Release is idempotent.
 */
class PortRangeLock {
    private released = false;

    constructor(
        private servers: net.Server[],
        public readonly ports: number[],
    ) {}

    public async release(): Promise<void> {
        if (this.released) {
            return;
        }
        this.released = true;
        const servers = this.servers;
        this.servers = [];
        await closeServers(servers);
    }
}

const heldLocks: PortRangeLock[] = [];

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
     * Release every port reservation this process is currently holding, so the ports can be
     * bound by whoever we allocated them for (gdb-server, RTT terminals, ...). Call this once
     * all allocation is finished and before anything is spawned.
     *
     * The ports remain in `AvoidPorts`, so this process will not hand them out again.
     */
    public static async releaseHeldPorts(): Promise<void> {
        const locks = heldLocks.splice(0, heldLocks.length);
        await Promise.all(locks.map((lock) => lock.release().catch(() => {})));
    }

    /**
     * Release the reservations whose ports are all contained in `ports`. Retained for the
     * session-teardown path; by then `releaseHeldPorts()` has normally already run, in which
     * case this is a no-op.
     */
    public static async unlockPortsIfFree(ports: number[]): Promise<void> {
        const wanted = new Set(ports);
        const releasing: Promise<void>[] = [];
        for (let i = heldLocks.length - 1; i >= 0; i--) {
            const lock = heldLocks[i];
            if (lock.ports.every((p) => wanted.has(p))) {
                heldLocks.splice(i, 1);
                releasing.push(lock.release().catch(() => {}));
            }
        }
        await Promise.all(releasing);
    }

    /**
     * Checks to see if the port is in use by creating a server on that port and closing it again.
     * This only probes -- it does not reserve. Use `findFreePorts()` when you intend to use the
     * port, so that the check and the claim are a single atomic step.
     *
     * @param port port to use. Must be > 0 and <= 65535
     * @param avoid if port is in this list, it is considered "in use"
     * @param hosts host ip address(es) to use. These should be aliases of localhost. (Default: check both
     * 127.0.0.1 and 0.0.0.0 -- covers all interfaces, needed for macOS)
     * @returns Promise that resolves to true if the port is unusable for any reason. It never rejects:
     * a port we cannot bind is a port we cannot use, whatever the errno says.
     */
    public static async isPortInUse(port: number, avoid: Set<number> | undefined, hosts?: string[]): Promise<boolean> {
        if (avoid && avoid.has(port)) {
            return true;
        }

        const hostsToCheck = hosts && hosts.length ? hosts : [TcpPortScanner.LoopbackAddr, TcpPortScanner.AllInterfaces];
        for (const h of hostsToCheck) {
            const server = await tryListen(port, h);
            if (!server) {
                return true;
            }
            await closeServer(server);
        }

        return false;
    }

    /**
     * Scan for free ports on the localhost and reserve them by holding a listening socket on each.
     * The reservation is held until `releaseHeldPorts()` (or `unlockPortsIfFree()`) is called, which
     * the caller must do before the ports are handed to the process that will actually bind them.
     *
     * Ports in `TcpPortScanner.AvoidPorts` and in `options.avoid` are skipped.
     *
     * @return a Promise with an array of ports
     */
    public static async findFreePorts(numPorts: number, options: findFreePortsOptions = {}): Promise<number[]> {
        const lock = await findAvailablePortRange(numPorts, options.start ?? DefaultStartPort, options.consecutive ?? false, options.avoid);
        heldLocks.push(lock);
        TcpPortScanner.EmitAllocated(lock.ports);
        return lock.ports;
    }
}

/**
 * Walk upwards from `preferredStart` claiming ports until we have `count` of them. This is a
 * single pass: no port is ever probed twice, and no valid window is skipped. In consecutive mode
 * a port we cannot claim breaks the run, so we give back what we are holding and start a fresh
 * run at the next port.
 *
 * The returned lock owns live sockets -- the caller is responsible for releasing it.
 */
export async function findAvailablePortRange(count: number, preferredStart: number, consecutive: boolean, avoid: Set<number> | undefined): Promise<PortRangeLock> {
    if (count <= 0) {
        return new PortRangeLock([], []);
    }

    const start = Math.min(Math.max(preferredStart || DefaultStartPort, 1), MaxPort);
    let servers: net.Server[] = [];
    let ports: number[] = [];

    for (let port = start; port <= MaxPort; port++) {
        const claimed = await claimPort(port, avoid);
        if (claimed) {
            servers.push(...claimed);
            ports.push(port);
            if (ports.length === count) {
                return new PortRangeLock(servers, ports);
            }
        } else if (consecutive && ports.length > 0) {
            await closeServers(servers);
            servers = [];
            ports = [];
        }
    }

    await closeServers(servers);
    throw new Error(`Could not find ${count} ${consecutive ? "consecutive " : ""}free ports starting at ${start}`);
}
