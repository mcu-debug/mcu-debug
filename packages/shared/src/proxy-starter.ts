import { execSync, spawn } from "child_process";
import { ProxyLaunchPolicy, ProxyLaunchResults } from "./proxy-network";

let WINDOWS_HOST_HOME = ""; // Windows host home, Windows form (e.g. C:\Users\me)

const NONCE = generateNonce();
function generateNonce(length: number = 16): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let result = "";
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

const LAUNCH_TIMEOUT_MS = 20_000;

/**
 * Launch-or-reuse the singleton proxy on the Windows host from a WSL guest.
 *
 * `mdbg proxy` self-daemonizes: the process we run is a short-lived *foreground
 * launcher* that re-spawns a detached daemon, forwards the daemon's discovery
 * line to its stdout, and exits — whether it becomes the owner or reuses a
 * running proxy. Because the foreground always exits quickly, we can simply run
 * it through cmd.exe interop and read the forwarded discovery line from stdout.
 *
 * This is why there's no `start /b`, no `endpoint.json` polling, and no
 * stale-file / lockfile guessing here: the discovery line is produced by the
 * daemon *after* its real lock check, so it is always fresh, and the detached
 * daemon survives on its own.
 */
export async function startOrReuseProxyServerOnWslHost(proxyPolicy: ProxyLaunchPolicy): Promise<ProxyLaunchResults> {
    // Windows host home (Windows form) — only needed for the .cmd path we hand to
    // cmd.exe. `2>/dev/null` drops the harmless "UNC paths are not supported"
    // warning cmd.exe prints from a WSL cwd.
    if (!WINDOWS_HOST_HOME) {
        try {
            WINDOWS_HOST_HOME = execSync("cmd.exe /D /C 'echo %USERPROFILE%' 2>/dev/null", { encoding: "utf8" }).trim();
        } catch (err) {
            throw new Error(`Failed to get Windows home directory from WSL: ${err}`);
        }
    }

    const instance = process.env["MDBG_PROXY_INSTANCE"] || "default";
    const proxyCmd = `${WINDOWS_HOST_HOME}\\.mcu-debug\\bin\\mcu-debug.cmd`;

    // We pass args as an array and let the WSL interop apply Windows quoting — do
    // NOT hand-quote proxyCmd (that would double-quote and break cmd if the
    // username contains a space). Pass --instance explicitly: WSL env vars do NOT
    // cross to Windows processes, so the proxy would otherwise default to
    // "default".
    const args = ["/D", "/C", proxyCmd, "proxy", "--instance", instance, "--token", NONCE];
    if (proxyPolicy?.bindHost) {
        args.push("--host", proxyPolicy.bindHost);
    }
    if (proxyPolicy?.fixedPort) {
        args.push("--port", proxyPolicy.fixedPort.toString());
    }

    return new Promise<ProxyLaunchResults>((resolve, reject) => {
        const child = spawn("cmd.exe", args, { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        let settled = false;

        const timer = setTimeout(() => {
            if (!settled) {
                settled = true;
                child.kill();
                reject(new Error(`Timed out launching proxy 'cmd.exe ${args.join(" ")}'. stderr=<${stderr}>`));
            }
        }, LAUNCH_TIMEOUT_MS);

        child.on("error", (err) => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                reject(new Error(`Failed to run 'cmd.exe ${args.join(" ")}': ${err}`));
            }
        });
        child.stdout?.on("data", (d) => {
            stdout += d.toString();
        });
        child.stderr?.on("data", (d) => {
            stderr += d.toString();
        });

        // The foreground launcher prints exactly one discovery JSON line and
        // exits, so parse on exit.
        child.on("exit", (code) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            const line = stdout
                .split(/\r?\n/)
                .map((s) => s.trim())
                .find((s) => s.startsWith("{"));
            if (!line) {
                reject(new Error(`Proxy did not report readiness (exit ${code}). stdout=<${stdout}> stderr=<${stderr}>`));
                return;
            }
            try {
                const discovery = JSON.parse(line);
                resolve({
                    policy: proxyPolicy,
                    consoleMessages: [],
                    consoleErrors: [],
                    serverPort: discovery.port,
                    // The token the RUNNING proxy reports — on reuse this is the
                    // first launcher's token, not our NONCE.
                    token: discovery.token ?? NONCE,
                });
            } catch (err) {
                reject(new Error(`Bad discovery JSON '${line}': ${err}`));
            }
        });
    });
}
