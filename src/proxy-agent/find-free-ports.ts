import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as lockfile from "proper-lockfile";

export class PortRangeLock {
    constructor(
        private lockPaths: string[],
        public readonly ports: number[],
    ) {}

    async release(): Promise<void> {
        await Promise.all(this.lockPaths.map((p) => lockfile.unlock(p).catch(() => {})));
    }
}

async function tryReserveRange(start: number, count: number): Promise<PortRangeLock | null> {
    const lockPaths: string[] = [];
    const ports: number[] = [];

    try {
        for (let i = 0; i < count; i++) {
            const port = start + i;
            const lockPath = path.join(os.tmpdir(), `mcu-debug-port-${port}.lock`);

            // Ensure file exists
            if (!fs.existsSync(lockPath)) {
                fs.writeFileSync(lockPath, "");
            }

            // Try to lock (non-blocking)
            await lockfile.lock(lockPath, {
                retries: 0, // Fail immediately
                stale: 60000, // 60 second stale timeout
                realpath: false, // Don't resolve symlinks
                fs: {
                    // Custom FS options
                    retries: 0, // Don't retry FS operations
                },
            });

            lockPaths.push(lockPath);
            ports.push(port);
        }

        return new PortRangeLock(lockPaths, ports);
    } catch (err) {
        // Cleanup locks we got
        await Promise.all(lockPaths.map((p) => lockfile.unlock(p).catch(() => {})));
        return null;
    }
}

export async function findAvailablePortRange(count: number, preferredStart?: number): Promise<PortRangeLock> {
    if (preferredStart && preferredStart > 0) {
        const result = await tryReserveRange(preferredStart, count);
        if (result) return result;
    }

    for (let base = 3333; base < 10000; base += 10) {
        const result = await tryReserveRange(base, count);
        if (result) return result;
    }

    throw new Error(`Could not find ${count} consecutive free ports`);
}
