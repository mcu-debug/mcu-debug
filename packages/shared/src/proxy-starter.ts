import { execSync, spawn, spawnSync } from "child_process";
import { openRemoteUri, ProxyLaunchPolicy, ProxyLaunchResults } from "./proxy-network";
import { commandExists } from "./command-exists";
import * as fs from "fs";
import * as os from "os";

export interface ProvisioningResults {
    resultsFile: string;
    error?: string;
    result?: any;
}

export interface ProxyProvisionRequest {
    v: number; // version of the protocol
    api: string; // the command to execute on the proxy server
    authority: string; // the authority of the proxy server (e.g. dev-container+<hash>, ssh-remote+host, etc.)
    args?: any[]; // arguments to pass to the command
    resultsFile: string; // the file to write the results to
}

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

const LAUNCH_TIMEOUT_MS = 15_000;

export function fmtBindErrors(obj: any): string[] | null {
    const errs = obj?.bind_errors;
    if (!errs || !Array.isArray(errs) || errs.length === 0) {
        return null;
    }
    return errs.map((e: any) => JSON.stringify(e));
}

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

    return new Promise<ProxyLaunchResults>((resolve, reject) => {
        const child = spawn("cmd.exe", args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
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

        // Resolve as soon as the discovery line shows up on stdout — do NOT wait
        // for the child to exit. `child` here is `cmd.exe`, launched via WSL's
        // Windows interop; its exit status has to be relayed back across that
        // boundary and can lag well behind the data actually being written to
        // the pipe, so gating on "exit" risks timing out even though the proxy
        // is already up and the discovery line already arrived.
        child.stdout?.on("data", (d) => {
            stdout += d.toString();
            if (settled) {
                return;
            }
            const line = stdout
                .split(/\r?\n/)
                .map((s) => s.trim())
                .find((s) => s.startsWith("{"));
            if (!line) {
                return;
            }
            try {
                const discovery = JSON.parse(line);
                settled = true;
                clearTimeout(timer);
                const ret: ProxyLaunchResults = {
                    policy: proxyPolicy,
                    consoleMessages: [],
                    consoleErrors: [],
                    serverPort: discovery.port,
                    hosts: discovery.hosts ?? [],
                    bindErrors: fmtBindErrors(discovery),
                    // The token the RUNNING proxy reports — on reuse this is the
                    // first launcher's token, not our NONCE.
                    token: discovery.token ?? NONCE,
                };
                resolve(ret);
            } catch {
                // Partial JSON — wait for more stdout.
            }
        });
        child.stderr?.on("data", (d) => {
            stderr += d.toString();
        });

        // If the launcher dies before ever printing a discovery line, surface
        // that as a failure instead of waiting out the full timeout.
        child.on("exit", (code) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            reject(new Error(`Proxy did not report readiness (exit ${code}). stdout=<${stdout}> stderr=<${stderr}>`));
        });
    });
}

/**
 * This is for use in the CLI adapter to execute a command on the proxy server from a WSL/docker/ssh client
 * We use the vscode command line to open a url and when that is processed by the url handler in the extension,
 * it will execute the command on the main extension and return the result in a temporary file. The idea is
 * that since we cannot use the vscode apis directly from the CLI, we can use the extension to do it for us.
 * This is useful when the client file system is not visible to the UI extension. The round trip can be slow,
 * but there is no other way to do it. The command is executed in the extension and the result is returned in a temporary file.
 * 
 * @param command a normal vscode command of the form "mcu-debug-proxy.*" that is implemented by the proxy server
 * @param logger an object with an error method for logging errors
 * @param args arguments to pass to the proxy server command
 * @returns a promise that resolves to the result of the command, or null if there was an error
 */

type ProxyCommandLogger = {
    error: (msg: string) => void;
};

export function startProxyServerFromWsl(proxyPolicy: ProxyLaunchPolicy, logger: ProxyCommandLogger = console): ProxyLaunchResults | null {
    const MDBG_PROXY_INSTANCE = process.env["MDBG_PROXY_INSTANCE"] || "default";
    const command = `%USERPROFILE%\\.mcu-debug\\bin\\mcu-debug.cmd`;
    const args = ["/D", "/C", `${command} proxy --instance ${MDBG_PROXY_INSTANCE} --token ${NONCE}`];
    if (proxyPolicy?.bindHost) {
        args.push("--host", proxyPolicy.bindHost);
    }
    try {
        const result = spawnSync("cmd.exe", args, { stdio: "pipe", windowsHide: true, encoding: "utf8" });
        const discovery = JSON.parse(result.stdout);
        if (!discovery || !discovery.port || typeof discovery.port !== "number") {
            logger.error(`Failed to start proxy server from WSL: ${result.stderr}`);
            return null;
        }
        const bindErrors = fmtBindErrors(discovery);
        if (bindErrors && bindErrors.length > 0) {
            logger.error(`Proxy server reported bind errors: ${bindErrors.join("\t\n")}`);
            return null;
        }
        const ret: ProxyLaunchResults = {
            policy: proxyPolicy,
            consoleMessages: [],
            consoleErrors: [result.stderr],
            serverPort: discovery.port,
            hosts: discovery.hosts ?? [],
            bindErrors: null,
            token: discovery.token ?? NONCE,
        };
        return ret;
    } catch (err) {
        logger.error(`Failed to start proxy server from WSL: ${err}`);
        return null;
    }
}

export function proxyServerCommand<T>(command: string, logger: ProxyCommandLogger = console, ...args_: unknown[]): Promise<T | null> {
    return new Promise((resolve) => {
        let resolved = false;
        const useExternalUriMethod = true; // set to false to use the old method of spawning code.exe with --open-url
        const prefix = "mcu-debug-proxy.";
        if (!command.startsWith(prefix)) {
            logger.error(`Invalid proxy command: ${command}`);
            resolve(null);
            return;
        }
        if (!useExternalUriMethod) {
            if (!commandExists("code")) {
                logger.error("VS Code command 'code' not found.");
                resolve(null);
                return;
            }
        }
        let timer: NodeJS.Timeout | undefined = setTimeout(() => {
            if (!resolved) {
                resolved = true;
                logger.error(`'open url ${url.toString()}' timed out after ${LAUNCH_TIMEOUT_MS}ms`);
                resolve(null);
            }
        }, LAUNCH_TIMEOUT_MS);
        const clear = () => {
            if (timer) {
                clearTimeout(timer);
                timer = undefined;
            }
        };

        const cmd = command.replace(prefix, "");
        const nonce = (Math.random() + Math.random()).toString(36).substring(2, 15).padEnd(16, '0');
        const params: ProxyProvisionRequest = {
            v: 1,
            api: cmd,
            authority: createAuthority(),
            args: args_,
            resultsFile: os.tmpdir() + `/mcu-debug-${nonce}.json`,      // nonce embedded in filename to avoid collisions
        };
        const url = new URL(`vscode://mcu-debug.mcu-debug/provision`);
        // Serialize the whole request as ONE JSON param. Handing the typed object
        // straight to URLSearchParams would String()-coerce every value — turning
        // `v: 1` into "1" and, worse, the `args` array into "[object Object]".
        // JSON round-trips every field with its real type.
        url.search = new URLSearchParams({ req: JSON.stringify(params) }).toString();
        try { fs.unlinkSync(params.resultsFile); } catch { }

        if (!useExternalUriMethod) {
            // --open-url does not work in WSL or Docker containers, so we spawn the VS Code CLI
            // to open the URL instead. The extension will handle the URL and write the results
            // to a temporary file. Also, code may not be installed in the PATH
            const spawnArgs = ["--open-url", url.toString()];
            const child = spawn("code", spawnArgs, { stdio: "inherit", windowsHide: true });
            child.on("error", (err) => {
                resolved = true;
                clear();
                logger.error(`Failed to run 'code ${spawnArgs.join(" ")}': ${err}`);
                resolve(null);
            });
            // Don't gate the results-file poll on the child's "exit" event: `code`
            // resolves on Windows via WSL interop, and that exit status has to be
            // relayed back across the interop boundary — it can lag well behind the
            // actual work (the URL handler runs inside the already-running VS Code
            // instance, independent of this short-lived `code` CLI invocation), so
            // waiting for it risks timing out even after the extension has already
            // written the results file. Poll for the results file immediately and
            // independently; only treat a nonzero exit as an early failure signal.
            child.on("exit", (code) => {
                if (code !== 0 && !resolved) {
                    resolved = true;
                    clear();
                    logger.error(`'code ${spawnArgs.join(" ")}' exited with code ${code}`);
                    resolve(null);
                }
            });
        } else {
            try {
                openRemoteUri(url.toString());
            } catch (error) {
                resolved = true;
                clear();
                logger.error(`Failed to open remote URI: ${error instanceof Error ? error.message : String(error)}`);
                resolve(null);
            }
        }

        (async () => {
            while (!resolved) {
                if (!fs.existsSync(params.resultsFile)) {
                    await new Promise(resolve => setTimeout(resolve, 500));
                    continue
                }
                if (resolved) {
                    return;
                }
                clear();
                resolved = true;
                try {
                    const content = fs.readFileSync(params.resultsFile, "utf8");
                    // TODO: uncomment following after testing
                    // fs.unlinkSync(params.resultsFile);
                    const result = JSON.parse(content) as ProvisioningResults;
                    if (result.resultsFile !== params.resultsFile) {
                        logger.error(`Results file mismatch: expected ${params.resultsFile}, got ${result.resultsFile}`);
                        resolve(null);
                        return;
                    }
                    if (result.error) {
                        logger.error(`Error from proxy server: ${result.error}`);
                        resolve(null);
                        return;
                    }
                    resolve(result.result);
                } catch (error) {
                    logger.error(`Failed to read results file: ${error instanceof Error ? error.message : String(error)}`);
                    resolve(null);
                }
            }
        })();
    });
}

export function createAuthority(): string {
    const osType = process.env["WSL_DISTRO_NAME"] || os.type();
    const user = os.userInfo().username || "unknown-user";
    const host = os.hostname() || "unknown-host";
    return `cli-proxy-${osType}-${user}-${host}`;
}


// Launch (or reuse) the singleton proxy and read its discovery line. `mdbg proxy`
// self-daemonizes: the process we spawn is a short-lived foreground launcher that
// re-spawns a detached daemon, forwards its discovery line to stdout, and exits.
// The daemon (owner) survives on its own; we never own or manage it.
export function startProxyServerWithPolicy(
    proxyPolicy: ProxyLaunchPolicy, proxyPath: string, STARTUP_TIMEOUT_MS: number): Promise<ProxyLaunchResults> {
    return new Promise<ProxyLaunchResults>((resolve, reject) => {
        const messages: string[] = [];
        const errors: string[] = [];
        // Always OS-assigned. Pinning the port was only ever for a WSL-firewall corner
        // case; that is now served by starting the agent yourself and pointing
        // `hostConfig.proxy` at it, which needs no launch-side option.
        const port = 0;
        let resolved = false;
        let ready = false;

        // Resolve with a failure sentinel (serverPort: -1) so a caller can tell
        // "could not launch/reuse" without the promise rejecting.
        const resolveFailure = () => {
            if (!resolved) {
                resolved = true;
                resolve({
                    policy: proxyPolicy!,
                    consoleMessages: messages,
                    consoleErrors: errors,
                    serverPort: -1,
                    token: NONCE,
                    bindErrors: null,
                    hosts: [],
                });
            }
        };

        messages.push(`Starting proxy server with policy: ${JSON.stringify(proxyPolicy)}`);
        // No --heartbeat: the singleton manages its own lifetime (session refs +
        // idle-timeout). `--token` is used only if WE become the owner; on reuse
        // the running proxy keeps its own token and reports it in the discovery.
        const args = ["proxy", "--host", proxyPolicy!.bindHost, "--port", port.toString(), "--token", NONCE];
        // This spawned process is the SHORT-LIVED foreground launcher. `mdbg proxy`
        // re-spawns a detached daemon itself, forwards the daemon's discovery line
        // to this process's stdout, and exits (owner OR reuse — both exit now).
        // So we do NOT need detached / unref here — survival is the daemon's job.
        // We just read the forwarded discovery line. windowsHide IS still needed,
        // though: it's unrelated to lifetime — without it, Windows pops a console
        // window for this console-subsystem child since the extension host has
        // none of its own to attach it to.
        const proxyProcess = spawn(proxyPath, args, {
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
        });

        proxyProcess.on("error", (err) => {
            errors.push(`Failed to start proxy server: ${err}`);
            resolveFailure();
        });

        proxyProcess.on("exit", (code, signal) => {
            messages.push(`Proxy launcher exited with code ${code} and signal ${signal}`);
            if (!ready) {
                // Exited before we saw the discovery line → the daemon could
                // neither start nor reuse. Surface it; no watchdog restart.
                errors.push(`Proxy launcher exited before ready (code ${code}, signal ${signal})`);
                resolveFailure();
            }
            // If ready: the foreground launcher has done its job and exits — the
            // detached daemon keeps running. Nothing to do.
        });

        let stdoutData = "";
        proxyProcess.stdout?.on("data", (data) => {
            const msg = data.toString();
            messages.push(`Proxy server stdout: ${msg}`);
            stdoutData += msg;
            try {
                const json = JSON.parse(stdoutData);
                if (json.status === "ready") {
                    ready = true;
                    resolved = true;
                    const baseResults: ProxyLaunchResults = {
                        policy: proxyPolicy!,
                        consoleMessages: messages,
                        consoleErrors: errors,
                        serverPort: json.port,
                        // Use the token the RUNNING proxy reports — on reuse this
                        // is the first launcher's token, not our nonce.
                        token: json.token ?? NONCE,
                        hosts: json.hosts ?? [],
                        bindErrors: fmtBindErrors(json),
                    };
                    resolve(baseResults);
                }
            } catch {
                // Partial JSON — wait for more stdout.
            }
        });
        proxyProcess.stderr?.on("data", (data) => {
            const msg = data.toString();
            messages.push(`Proxy server stderr: ${msg}`);
        });

        setTimeout(() => {
            if (!ready) {
                errors.push(`Proxy server did not become ready within ${STARTUP_TIMEOUT_MS / 1000}s`);
                try {
                    proxyProcess.kill();
                } catch {
                    // ignore — it may have already exited
                }
                resolveFailure();
            }
        }, STARTUP_TIMEOUT_MS);
    });
}

export function setDevelopmentModeEnvVars() {
    process.env["MDBG_PROXY_INSTANCE"] = "dev"; // signal to the proxy that it is running in dev mode
    process.env["MDBG_PROXY_IDLE_TIMEOUT"] = "0"; // 0 is do not exit on idle, for dev mode only
}
