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

/**
 * The lowest ephemeral port on any platform we run on. Linux hands out 32768-60999
 * (`/proc/sys/net/ipv4/ip_local_port_range`); Windows and macOS use 49152-65535
 * (`netsh int ipv4 show dynamicport tcp`).
 *
 * Allocating in there means competing with the kernel for source ports, and on Windows it also
 * overlaps the blocks Hyper-V/WSL/Docker reserve -- which fail to bind with EACCES and show
 * nothing at all in netstat, because nothing is listening.
 */
const EphemeralPortStart = 32768;

/**
 * Default scan bases. All sit in 2000-3000: well above the privileged ports, well below every
 * ephemeral range, and clear of the registered ports this audience is most likely to be running
 * -- NFS (2049), ZooKeeper (2181), Docker (2375/2376), etcd (2379/2380).
 *
 * These are starting points, not reservations. The scanner walks upward from here, so a squatter
 * on any individual port costs at most a few extra binds.
 */
export const DefaultPortBase = {
    /** gdb-server ports (gdbPort/swoPort/tclPort/telnetPort/consolePort), up to 4 per core, consecutive. */
    gdbServer: 2000,
    /** RTT channel ports, whether served by the gdb-server or by our built-in RTT. Up to 16 channels. */
    rtt: 2200,
    /** GDBServerConsole -- the terminal the gdb-server's stdio is piped to. */
    gdbServerConsole: 2400,
    /** Local end of the `ssh -L` tunnel used by the LAB topology. */
    sshTunnel: 2410,
    /** The CLI's equivalent of the gdb-server console. */
    cliConsole: 2420,
    /** Fallback for callers that do not specify a start. */
    scanner: 2500,
    /** Hint sent to a remote Probe Agent, which allocates on its own machine by its own rules. */
    proxyRemote: 2600,
} as const;

/**
 * Do `127.0.0.1:P` and `0.0.0.0:P` behave as two independent endpoints on this machine?
 *
 * Windows and macOS say yes: two unrelated processes can each own one of them. That is why a
 * wildcard-only probe is worthless there -- on Windows it walks straight past anything WSL's
 * localhost forwarding (`wslrelay.exe`) has projected onto the loopback, and reports the port
 * free right up until the caller binds the loopback and gets EADDRINUSE.
 *
 * Linux says no: the wildcard conflicts with every specific address on the port, in both
 * directions. There, holding both from one process is impossible -- but it is also unnecessary,
 * because that same symmetry makes a single wildcard bind a complete test.
 *
 * This is measured rather than derived from `process.platform`, because the answer belongs to
 * the network stack we are actually running on -- WSL, containers and VMs all get this right
 * without us maintaining a table. Take an ephemeral port on the loopback, then see whether the
 * wildcard is still bindable underneath it.
 *
 * Worst case a transient failure makes us answer "no" when the truth is "yes"; that degrades us
 * to a wildcard-only claim, which is never *wrong*, only weaker. The reverse cannot happen: we
 * answer "yes" only after actually holding both at once.
 */
let hostsIndependentProbe: Promise<boolean> | undefined;

function hostsAreIndependent(): Promise<boolean> {
    if (!hostsIndependentProbe) {
        hostsIndependentProbe = (async () => {
            // Retry on distinct ephemeral ports: one unlucky collision on a stack that really is
            // independent would silently drop us back to a wildcard-only claim, which is the very
            // blind spot this exists to close. A single success proves independence; only a stack
            // that conflicts can fail every attempt.
            for (let attempt = 0; attempt < 3; attempt++) {
                const loopback = await tryListen(0, TcpPortScanner.LoopbackAddr);
                if (!loopback) {
                    continue;
                }
                const port = (loopback.address() as net.AddressInfo).port;
                const wildcard = await tryListen(port, TcpPortScanner.AllInterfaces);
                if (wildcard) {
                    await closeServer(wildcard);
                }
                await closeServer(loopback);
                if (wildcard) {
                    return true;
                }
            }
            return false;
        })();
    }
    return hostsIndependentProbe;
}

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

/**
 * The hosts we have to hold to consider a port truly ours.
 *
 * Where the two addresses are independent, both must be held -- a port is ours only if nobody
 * owns either half. The loopback comes first: it is the address every one of our callers
 * actually binds, and on Windows it is where WSL's forwarded ports live, so it rejects the
 * common case on the first bind.
 *
 * Where they conflict, the wildcard alone is the stronger test: it fails if *any* address on
 * that port is taken, including specific addresses on other interfaces.
 */
async function claimHosts(): Promise<string[]> {
    return (await hostsAreIndependent()) ? [TcpPortScanner.LoopbackAddr, TcpPortScanner.AllInterfaces] : [TcpPortScanner.AllInterfaces];
}

/**
 * Claim a single port. Returns the sockets holding it, or `null` if it could not be claimed.
 * Any host we cannot take means the port is not ours -- we never settle for a partial claim.
 */
async function claimPort(port: number, avoid: Set<number> | undefined): Promise<net.Server[] | null> {
    if (avoid?.has(port) || TcpPortScanner.AvoidPorts.has(port)) {
        return null;
    }
    const servers: net.Server[] = [];
    for (const host of await claimHosts()) {
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
        const lock = await findAvailablePortRange(numPorts, options.start ?? DefaultPortBase.scanner, options.consecutive ?? false, options.avoid);
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

    const start = Math.min(Math.max(preferredStart || DefaultPortBase.scanner, 1), MaxPort);
    // Never wander into the ephemeral range under our own steam. A caller that deliberately starts
    // inside it -- an explicit port from launch.json -- is taken at its word and may scan to the top.
    const ceiling = start >= EphemeralPortStart ? MaxPort : EphemeralPortStart - 1;
    let servers: net.Server[] = [];
    let ports: number[] = [];

    for (let port = start; port <= ceiling; port++) {
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
    throw new Error(`Could not find ${count} ${consecutive ? "consecutive " : ""}free ports in ${start}-${ceiling}`);
}
