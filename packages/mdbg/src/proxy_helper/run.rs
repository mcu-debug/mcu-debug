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

//! Entry point for the proxy-helper subcommand.
//! This will implement the Probe Agent that manages gdb-server processes
//! and speaks the Funnel Protocol over TCP.

use anyhow::{Context, Result};
use clap::Args;
use clap::ValueEnum;
use flexi_logger::{Age, Cleanup, Criterion, Duplicate, FileSpec, Logger, LoggerHandle, Naming};
use serde::Deserialize;
use serde::Serialize;
use std::{
    backtrace::Backtrace,
    net::{Ipv4Addr, TcpListener, TcpStream},
    panic,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex, Once,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use crate::proxy_helper::admin::{self, AdminContext};
use crate::proxy_helper::lifetime::Lifetime;
use crate::proxy_helper::proxy_server::{ProxyServer, SerialPortRegistry};
use crate::proxy_helper::serial_available::{
    start_serial_available_watcher, SerialAvailabilityHub,
};
use crate::proxy_helper::singleton;

#[derive(Clone, Copy, Debug, ValueEnum, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "proxy-protocol/")]
#[serde(rename_all = "camelCase")]
pub enum PortWaitMode {
    /// Existing behavior: proactively connect and keep forwarding stream open.
    ConnectHold,
    /// Probe with a connect attempt but do not hold the stream open.
    ConnectProbe,
    /// Non-invasive monitor mode (lsof/netstat) that reports readiness.
    Monitor,
}

#[derive(Args, Debug)]
pub struct ProxyArgs {
    /// Host to listen on (default: 127.0.0.1), alternatively specify `0.0.0.0` to listen on all interfaces
    #[arg(short = 'H', long = "host", default_value = "127.0.0.1")]
    pub host: String,

    /// TCP port to listen on (0 = auto-assign)
    #[arg(short = 'p', long = "port", default_value_t = 0)]
    pub port: u16,

    /// Authentication token for client connections
    #[arg(short = 't', long = "token", default_value = "adis-ababa")]
    pub token: String,

    /// If true, do not include the token in the discovery JSON output (for security through obscurity)
    #[arg(long = "no-token", default_value_t = false)]
    pub no_token: bool,

    /// Enable debug output
    #[arg(short = 'd', long = "debug", default_value_t = false)]
    pub debug: bool,

    /// Strategy to detect stream-port readiness
    #[arg(long = "port-wait-mode", value_enum, default_value_t = PortWaitMode::Monitor)]
    pub port_wait_mode: PortWaitMode,

    /// Also emit log lines to stderr (file logging is always enabled)
    #[arg(long = "log-stderr", default_value_t = false)]
    pub log_stderr: bool,

    /// Directory for proxy-helper log files
    #[arg(long = "log-dir")]
    pub log_dir: Option<String>,

    /// Enable stdin heartbeat watchdog. When set, the process exits if stdin
    /// closes (parent died) or no byte is received within 15 seconds.
    /// Pass this flag only when the parent will actively send heartbeats.
    /// Do NOT pass it for SSH-launched or daemon instances.
    #[arg(long = "heartbeat", default_value_t = false)]
    pub heartbeat: bool,

    /// Singleton instance name. One proxy runs per (user, instance); a distinct
    /// name (e.g. `dev`) runs an isolated proxy that never collides with the
    /// default one — handy when debugging `mdbg` itself.
    #[arg(
        long = "instance",
        env = "MDBG_PROXY_INSTANCE",
        default_value = "default"
    )]
    pub instance: String,

    /// Seconds with no active session (and no `--heartbeat` window keep-alive)
    /// before the proxy self-exits. 0 disables idle shutdown (run until killed
    /// or explicitly stopped) — use it for a persistent lab/SSH daemon.
    #[arg(long = "idle-timeout", env = "MDBG_PROXY_IDLE_TIMEOUT", default_value_t = 5*60*60)]
    pub idle_timeout: u64,

    /// Client mode: query the running proxy for this instance and print its
    /// status as JSON, then exit (does not start a proxy).
    #[arg(long = "status", default_value_t = false)]
    pub status: bool,

    /// Client mode: ask the running proxy for this instance to shut down
    /// gracefully (stop accepting, exit when active sessions finish), then exit.
    #[arg(long = "shutdown", default_value_t = false)]
    pub shutdown: bool,

    /// With `--shutdown`, drain EVERY running instance instead of just the one
    /// resolved from `--instance`. No effect on `--status` (already all-inclusive).
    #[arg(long = "all", default_value_t = false)]
    pub all: bool,

    /// Internal: marks the re-spawned, detached daemon so it runs the proxy
    /// instead of launching another daemon. Not for direct use.
    #[arg(long = "daemonized", hide = true, default_value_t = false)]
    pub daemonized: bool,
}

fn init_logging(args: &ProxyArgs) -> Option<LoggerHandle> {
    let log_dir = args
        .log_dir
        .clone()
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("mdbg").join("proxy-logs"));

    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let launch_id = format!("{}-{}", std::process::id(), ts);

    let logger = match Logger::try_with_env_or_str(if args.debug { "debug" } else { "info" }) {
        Ok(logger) => logger,
        Err(e) => {
            eprintln!("Logger configuration failed: {}", e);
            return None;
        }
    }
    .format(flexi_logger::detailed_format)
    .log_to_file(
        FileSpec::default()
            .directory(log_dir)
            .basename("proxy-helper")
            .discriminant(launch_id)
            .suffix("log"),
    )
    .rotate(
        Criterion::Age(Age::Day),
        Naming::Timestamps,
        Cleanup::KeepLogFiles(14),
    )
    .duplicate_to_stderr(if args.log_stderr {
        Duplicate::All
    } else {
        Duplicate::None
    });

    match logger.start() {
        Ok(handle) => Some(handle),
        Err(e) => {
            eprintln!(
                "Logger initialization failed, continuing without file logger: {}",
                e
            );
            None
        }
    }
}

fn install_panic_hook() {
    static PANIC_HOOK_INIT: Once = Once::new();

    PANIC_HOOK_INIT.call_once(|| {
        panic::set_hook(Box::new(|panic_info| {
            let thread = thread::current();
            let thread_name = thread.name().unwrap_or("<unnamed>");
            let payload = if let Some(s) = panic_info.payload().downcast_ref::<&str>() {
                (*s).to_string()
            } else if let Some(s) = panic_info.payload().downcast_ref::<String>() {
                s.clone()
            } else {
                "<non-string panic payload>".to_string()
            };
            let location = panic_info
                .location()
                .map(|loc| format!("{}:{}:{}", loc.file(), loc.line(), loc.column()))
                .unwrap_or_else(|| "<unknown>".to_string());
            let backtrace = Backtrace::force_capture();

            log::error!(
                "panic captured: thread={} id={:?} location={} payload={}\nbacktrace:\n{:?}",
                thread_name,
                thread.id(),
                location,
                payload,
                backtrace
            );
        }));
    });
}

/// Signal the accept loop to stop, then unblock it by self-connecting so the
/// blocked `accept()` returns and the loop sees the flag and breaks. Used by the
/// idle monitor and by admin drain.
pub(crate) fn trigger_graceful_shutdown(stop_flag: &AtomicBool, local_port: u16) {
    stop_flag.store(true, Ordering::SeqCst);
    let addr = format!("127.0.0.1:{local_port}");
    if let Err(e) = TcpStream::connect(&addr) {
        log::warn!(
            "Self-connect to {addr} failed during shutdown: {e} — accept loop may not unblock immediately"
        );
    }
}

/// Client mode for `--status` / `--shutdown`: locate the running proxy for this
/// instance, send it an admin request, and print the reply as JSON. Never starts
/// a proxy. A missing/unreachable endpoint is reported as `{ok:false,...}`, not
/// an error, so scripts get a stable JSON shape.
fn run_admin_client(args: &ProxyArgs) -> Result<()> {
    // `--status` is instance-agnostic: it surveys every running instance so you
    // never have to remember which instance name you used. `--shutdown` targets
    // the single resolved instance unless `--all` fans out to every instance.
    if args.status {
        return print_status_all();
    }
    if args.shutdown && args.all {
        return shutdown_all();
    }

    let instance = singleton::Instance::resolve(&args.instance)?;
    let print = |resp: &admin::AdminResponse| -> Result<()> {
        println!("{}", serde_json::to_string_pretty(resp)?);
        Ok(())
    };
    let not_running = |msg: String| admin::AdminResponse {
        ok: false,
        error: Some(msg),
        status: None,
        message: None,
    };

    let endpoint = match singleton::read_endpoint(&instance.endpoint_path) {
        Ok(ep) => ep,
        Err(_) => {
            return print(&not_running(format!(
                "no proxy running for instance '{}'",
                instance.name
            )));
        }
    };
    let req = admin::AdminRequest {
        v: 1,
        cmd: "shutdown".to_string(),
        token: endpoint.token.clone(),
        graceful: true,
        version: String::new(),
    };
    match admin::query(&endpoint, &req) {
        Ok(resp) => print(&resp),
        Err(e) => print(&not_running(format!("proxy not reachable ({e:#})"))),
    }
}

/// `--status` output: every running instance, with a `count` (which replaces the
/// old boolean `ok` — a per-instance concept that had no meaning across many).
#[derive(serde::Serialize)]
struct StatusReport {
    /// Number of instances that answered a status query (i.e. are actually running).
    count: usize,
    instances: Vec<admin::StatusInfo>,
}

/// Enumerate every instance dir, query the ones that are alive, and print them
/// all as one report. Stale endpoint files (crashed proxies) refuse the
/// connection immediately and are skipped, so the list reflects reality.
fn print_status_all() -> Result<()> {
    let mut instances = Vec::new();
    for inst in singleton::list_instances()? {
        let endpoint = match singleton::read_endpoint(&inst.endpoint_path) {
            Ok(ep) => ep,
            Err(_) => continue, // no discovery anchor → not running
        };
        let req = admin::AdminRequest {
            v: 1,
            cmd: "status".to_string(),
            token: endpoint.token.clone(),
            graceful: true,
            version: String::new(),
        };
        if let Ok(resp) = admin::query(&endpoint, &req) {
            if let Some(status) = resp.status {
                instances.push(status);
            }
        }
    }
    let report = StatusReport {
        count: instances.len(),
        instances,
    };
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

/// One instance's graceful-shutdown outcome in a `--shutdown --all` report.
#[derive(serde::Serialize)]
struct ShutdownResult {
    instance: String,
    /// Whether the running proxy accepted the drain request.
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

/// `--shutdown --all` output: one entry per instance we asked to drain.
#[derive(serde::Serialize)]
struct ShutdownReport {
    /// Number of running instances a drain request was sent to.
    count: usize,
    results: Vec<ShutdownResult>,
}

/// Ask every running instance to drain (graceful shutdown). Like `--status`,
/// this is best-effort per instance: a stale endpoint from a dead proxy refuses
/// fast and is skipped (nothing to shut down). The drain is graceful — each
/// proxy stops accepting and exits once its active sessions finish.
fn shutdown_all() -> Result<()> {
    let mut results = Vec::new();
    for inst in singleton::list_instances()? {
        let endpoint = match singleton::read_endpoint(&inst.endpoint_path) {
            Ok(ep) => ep,
            Err(_) => continue, // no discovery anchor → not running
        };
        let req = admin::AdminRequest {
            v: 1,
            cmd: "shutdown".to_string(),
            token: endpoint.token.clone(),
            graceful: true,
            version: String::new(),
        };
        // Only report instances that actually answered — a dead proxy's stale
        // endpoint refuses the connection and needs no shutdown.
        if let Ok(resp) = admin::query(&endpoint, &req) {
            results.push(ShutdownResult {
                instance: inst.name,
                ok: resp.ok,
                message: resp.message,
                error: resp.error,
            });
        }
    }
    let report = ShutdownReport {
        count: results.len(),
        results,
    };
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

/// Acquire the per-(user, instance) singleton lock, or defer to a running proxy.
///
/// Returns `Ok(Some(guard))` when we own the instance (caller runs as the
/// singleton), or `Ok(None)` when a running proxy was reused (discovery JSON is
/// printed here; caller should just return). If a strictly-newer binary is
/// launched, it asks the running proxy to step down and then takes over.
///
/// (A free function so the successful guard is returned by value — this keeps the
/// initial attempt's borrow of `proxy_lock` from overlapping the upgrade-retry.)
fn acquire_or_reuse<'a>(
    proxy_lock: &'a mut fd_lock::RwLock<std::fs::File>,
    instance: &singleton::Instance,
    args: &ProxyArgs,
    mine: &str,
) -> Result<Option<fd_lock::RwLockWriteGuard<'a, std::fs::File>>> {
    // Probe *without* holding the guard (the temporary guard drops at the end of
    // this statement), so the decision below doesn't pin the `proxy_lock` borrow
    // across the acquire-loop (NLL problem case #3).
    let held_by_other = proxy_lock.try_write().is_err();

    if held_by_other {
        let ep = singleton::read_endpoint_retry(&instance.endpoint_path)?;
        let token = if args.no_token {
            None
        } else {
            Some(ep.token.as_str())
        };

        if !singleton::is_newer(mine, &ep.version) {
            // Same or older → reuse the running proxy.
            if singleton::is_newer(&ep.version, mine) {
                log::warn!(
                    "A newer proxy v{} is already running for '{}'; using it",
                    ep.version,
                    instance.name
                );
            }
            log::info!(
                "Reusing existing proxy for '{}' (pid {}, port {})",
                instance.name,
                ep.pid,
                ep.port
            );
            singleton::print_discovery(ep.port, ep.pid, token);
            return Ok(None);
        }

        // We are newer → ask the running proxy to step down, then take over its
        // identity (Phase D drain-and-replace). Fall through to the acquire loop.
        log::info!(
            "Newer proxy v{mine} > running v{} for '{}' — requesting handover",
            ep.version,
            instance.name
        );
        if let Err(e) = admin::request_upgrade(&ep, mine) {
            log::warn!("Handover request failed: {e:#}; reusing the existing proxy");
            singleton::print_discovery(ep.port, ep.pid, token);
            return Ok(None);
        }
    }

    // Wait until the lock is free (probe-only — a guard returned from inside the
    // loop would trip NLL problem case #3), covering both the momentary free-race
    // after the probe and the upgrade handoff window. Then acquire once for real.
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while proxy_lock.try_write().is_err() {
        if std::time::Instant::now() >= deadline {
            anyhow::bail!("could not acquire the instance lock (another proxy won the race?)");
        }
        thread::sleep(Duration::from_millis(100));
    }
    match proxy_lock.try_write() {
        Ok(g) => {
            let _ = std::fs::remove_file(&instance.endpoint_path);
            Ok(Some(g))
        }
        Err(_) => anyhow::bail!("lost the instance-lock race after waiting"),
    }
}

/// Re-spawn ourselves as a detached daemon and forward its one discovery line.
///
/// The trick that makes "detached, but I can still read its output" work: we
/// create a pipe and hand the daemon the write-end as its **stdout** (an
/// inherited handle). File/handle inheritance is *independent* of session /
/// console detachment — so the daemon can be fully detached (its own session on
/// Unix, no console on Windows) and still write its discovery JSON to the pipe
/// we read here. We read exactly one line (the daemon holds the pipe open on the
/// owner path, so we must not wait for EOF), forward it, and exit.
fn run_foreground_launcher(args: &ProxyArgs) -> Result<()> {
    use std::io::{BufRead, Write};

    let exe = std::env::current_exe().context("could not determine own executable path")?;
    let mut cmd = std::process::Command::new(exe);
    cmd.arg("proxy")
        .arg("--host")
        .arg(&args.host)
        .arg("--port")
        .arg(args.port.to_string())
        .arg("--token")
        .arg(&args.token)
        .arg("--instance")
        .arg(&args.instance)
        .arg("--idle-timeout")
        .arg(args.idle_timeout.to_string())
        .arg("--port-wait-mode")
        .arg(
            args.port_wait_mode
                .to_possible_value()
                .expect("port-wait-mode has a value name")
                .get_name(),
        )
        // The marker that tells the child it IS the daemon (don't re-launch).
        .arg("--daemonized");
    if args.no_token {
        cmd.arg("--no-token");
    }
    if args.debug {
        cmd.arg("--debug");
    }
    if args.log_stderr {
        cmd.arg("--log-stderr");
    }
    if let Some(dir) = &args.log_dir {
        cmd.arg("--log-dir").arg(dir);
    }
    // (Deliberately do NOT forward --heartbeat: the daemon is independent of this
    // transient launcher's stdin.)

    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::piped()); // the discovery line comes back here
    cmd.stderr(std::process::Stdio::null()); // the daemon logs to its file
    detach_process(&mut cmd);

    let mut child = cmd.spawn().context("failed to spawn the proxy daemon")?;
    let stdout = child.stdout.take().context("daemon stdout pipe missing")?;

    // Read exactly one line on a helper thread with a timeout — on the owner path
    // the daemon keeps the pipe open after printing, so a blocking read-to-EOF
    // would hang.
    let (tx, rx) = mpsc::channel::<std::io::Result<String>>();
    thread::spawn(move || {
        let mut line = String::new();
        let res = std::io::BufReader::new(stdout)
            .read_line(&mut line)
            .map(|_| line);
        let _ = tx.send(res);
    });

    let discovery = match rx.recv_timeout(Duration::from_secs(15)) {
        Ok(Ok(line)) if !line.trim().is_empty() => line.trim().to_string(),
        Ok(Ok(_)) => anyhow::bail!("proxy daemon closed its output without reporting readiness"),
        Ok(Err(e)) => anyhow::bail!("failed to read proxy daemon output: {e}"),
        Err(_) => anyhow::bail!("timed out waiting for the proxy daemon to report readiness"),
    };

    // Forward the daemon's fresh discovery to our own stdout for the launcher.
    println!("{discovery}");
    std::io::stdout().flush().ok();
    // Do NOT wait for the child: on the owner path it runs indefinitely. Dropping
    // the `Child` handle neither signals nor kills the process.
    Ok(())
}

/// Configure `cmd` so the spawned daemon detaches from this launcher (its own
/// session on Unix; no console + own process group on Windows).
#[cfg(unix)]
fn detach_process(cmd: &mut std::process::Command) {
    use std::os::unix::process::CommandExt;
    // SAFETY: `setsid` is async-signal-safe and runs in the forked child before
    // exec. A new session detaches the daemon from the controlling terminal, so a
    // terminal close / SIGHUP won't take it down.
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

#[cfg(windows)]
fn detach_process(cmd: &mut std::process::Command) {
    use std::os::windows::process::CommandExt;
    // DETACHED_PROCESS: run without a console (a background service, not a
    // terminal app). CREATE_NEW_PROCESS_GROUP: independent of the launcher's
    // Ctrl-C/Ctrl-Break group. Handle inheritance (the stdout pipe) is unaffected
    // by these flags.
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
}

pub fn run(args: ProxyArgs) -> Result<()> {
    // Client modes: query/command a running proxy and exit — do not start one.
    // Kept lightweight: no daemon logging setup.
    if args.status || args.shutdown {
        return run_admin_client(&args);
    }

    // Foreground launcher: re-spawn ourselves as a detached, windowless daemon,
    // forward its single discovery line to our stdout, and exit. The daemon
    // (`--daemonized`) does the real acquire-or-reuse + run. The launcher thus
    // gets a FRESH discovery line — printed by the daemon *after* its real lock
    // check — with no stale-file race, while the owner keeps running
    // independently past this launcher.
    if !args.daemonized {
        return run_foreground_launcher(&args);
    }

    // ── We are the daemon from here ─────────────────────────────────────────
    let _log_handle = init_logging(&args);
    install_panic_hook();
    crate::common::debug::set_debug(args.debug);

    // ── Singleton identity (Tier 1, Phase A) ────────────────────────────────
    // Acquire the per-(user, instance) advisory lock. If another proxy for this
    // instance already holds it, that proxy is alive (the OS releases the lock
    // on process death) — so reuse it: print its discovery JSON and exit, so the
    // launcher gets connection details whether we started fresh or found one.
    let instance = singleton::Instance::resolve(&args.instance)?;
    instance.ensure_dir()?;
    let lock_file = std::fs::OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false) // it's a lock file — never clobber its contents
        .open(&instance.lock_path)
        .with_context(|| format!("could not open {}", instance.lock_path.display()))?;
    let mut proxy_lock = fd_lock::RwLock::new(lock_file);
    let mine = singleton::self_version();

    // Acquire the instance lock, or reuse / take over a running proxy. `None`
    // means we reused an existing proxy (discovery JSON already printed) and
    // should just exit. Held for the process lifetime — except on an upgrade
    // handover, where it's released early (see `superseded` near the end), so
    // it's an `Option` we can `take()`.
    let mut lock_guard = match acquire_or_reuse(&mut proxy_lock, &instance, &args, &mine)? {
        Some(guard) => Some(guard),
        None => return Ok(()),
    };

    // TODO: Maybe allow Ipv6 in the future, but for now we can just require IPv4 for simplicity
    let host = match args.host.parse::<Ipv4Addr>() {
        Ok(ip) => ip,
        Err(e) => {
            log::error!("Invalid host IP address: {}", args.host);
            return Err(e.into());
        }
    };
    let listener = match TcpListener::bind((host, args.port)) {
        Ok(listener) => listener,
        Err(e) => {
            log::error!("Failed to bind to {}:{}", args.host, args.port);
            return Err(e.into());
        }
    };
    let local_port = listener.local_addr()?.port();

    // Publish the discovery anchor now that we own the lock and have a port.
    let endpoint = singleton::Endpoint {
        v: 1,
        instance: instance.name.clone(),
        pid: std::process::id(),
        version: singleton::self_version(),
        port: local_port,
        token: args.token.clone(),
        state: "active".to_string(),
        started_at_unix: singleton::Endpoint::now_unix(),
    };
    singleton::write_endpoint_atomic(&instance.endpoint_path, &endpoint)?;

    // Graceful-shutdown flag. The idle monitor (and, later, admin shutdown) set
    // it and self-connect; the accept loop polls it after each accept and breaks.
    let stop_flag = Arc::new(AtomicBool::new(false));

    // Use-bounded lifetime: the proxy stays alive while any ref is held — one per
    // live session, plus a "window keep-alive" ref while --heartbeat pings arrive
    // (Phase B). When all refs drop, the idle monitor exits after --idle-timeout.
    let lifetime = Lifetime::new();

    // Draining flag (Phase C): set on admin `shutdown` — the accept loop then
    // refuses new sessions and the proxy exits when the last session ends.
    let draining = Arc::new(AtomicBool::new(false));

    // Superseded flag (Phase D): set on admin `upgrade` — this proxy handed its
    // identity to a newer one and must release the lock early without deleting
    // endpoint.json on exit.
    let superseded = Arc::new(AtomicBool::new(false));

    // Shared context for admin (`--status` / `--shutdown` / `upgrade`) connections.
    let admin_ctx = Arc::new(AdminContext {
        token: args.token.clone(),
        lifetime: Arc::clone(&lifetime),
        draining: Arc::clone(&draining),
        superseded: Arc::clone(&superseded),
        stop_flag: stop_flag.clone(),
        local_port,
        endpoint_path: instance.endpoint_path.clone(),
        pid: std::process::id(),
        version: singleton::self_version(),
        instance: instance.name.clone(),
        started_at_unix: endpoint.started_at_unix,
    });

    // Stdin heartbeat watchdog — only when explicitly requested via --heartbeat.
    // The extension that spawns us locally passes this flag and sends a '\n' every
    // 5 s. SSH-launched and daemon instances must NOT pass it (no heartbeat sender).
    // NOTE: Ctrl-C (SIGINT) on a manually-launched instance still terminates the
    // process without running Drop, which can orphan openocd/gdb-server children.
    // A future improvement: use the `ctrlc` crate to install a SIGINT handler that
    // sets stop_flag + self-connects instead of using the default signal termination.
    if args.heartbeat {
        let (tx, rx) = mpsc::channel::<()>();
        thread::spawn(move || {
            use std::io::Read;
            let stdin = std::io::stdin();
            let mut buf = [0u8; 1];
            loop {
                match stdin.lock().read(&mut buf) {
                    Ok(n) if n > 0 => {
                        if tx.send(()).is_err() {
                            break;
                        }
                    }
                    _ => break, // EOF or error — tx drops, watcher sees Disconnected
                }
            }
        });
        // Hold a window keep-alive ref while heartbeats arrive. Losing the
        // heartbeat (window closed) now only drops this ref — it no longer kills
        // the proxy directly. If sessions are still running, the proxy lives on;
        // otherwise the idle monitor exits it after --idle-timeout.
        let window_ref = lifetime.acquire();
        thread::spawn(move || {
            let _window_ref = window_ref;
            const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(15);
            // Loop until the channel is closed (EOF on stdin) or times out (no heartbeat).
            while rx.recv_timeout(HEARTBEAT_TIMEOUT).is_ok() {}
            log::info!("Heartbeat lost (window closed) — dropping window keep-alive ref");
            // _window_ref drops here → lifetime decremented.
        });
    }

    // Idle monitor: when all refs are gone for --idle-timeout, self-exit. Skip
    // entirely when idle_timeout == 0 (persistent daemon).
    if args.idle_timeout > 0 {
        let lifetime_monitor = Arc::clone(&lifetime);
        let stop_flag_monitor = stop_flag.clone();
        let idle = Duration::from_secs(args.idle_timeout);
        thread::spawn(move || {
            lifetime_monitor.wait_until_idle(idle);
            log::info!(
                "Idle for {}s with no active sessions — shutting down",
                args.idle_timeout
            );
            trigger_graceful_shutdown(&stop_flag_monitor, local_port);
        });
    }

    log::info!("Port wait mode: {:?}", args.port_wait_mode);
    log::info!(
        "Proxy helper startup: pid={}, host={}, port={}, log_stderr={}, stdin_watchdog={}",
        std::process::id(),
        args.host,
        local_port,
        args.log_stderr,
        args.heartbeat
    );

    // Print Discovery JSON to stdout: {"status": "ready", "port": <actual_port>, "pid": <pid>} with an optional "token" field
    // If --no-token is not set, the client will parse this to discover the port and token to use for connecting to the Probe Agent.
    singleton::print_discovery(
        local_port,
        std::process::id(),
        if args.no_token {
            None
        } else {
            Some(args.token.as_str())
        },
    );

    log::info!("Probe Agent listening on port {}", local_port);

    // For cleanup later
    let mut client_threads = Vec::new();

    // Serial ports outlive individual ProxyServer connections — the registry lives
    // here in the accept loop and is cloned (Arc) into each connection's ProxyServer.
    let serial_registry: SerialPortRegistry =
        Arc::new(Mutex::new(std::collections::HashMap::new()));
    let serial_available_hub = Arc::new(SerialAvailabilityHub::new());
    let serial_available_watcher_stop =
        start_serial_available_watcher(Arc::clone(&serial_available_hub));

    // Accept connection and run Funnel Protocol handler in a new thread
    // We generally don't have multiple clients when running inside a VSCode extension,
    // but we have a use case in multi-core debugging where each core needs its own proxy instance,
    // so we should be prepared to handle multiple connections gracefully (e.g. by rejecting
    // them with an error message). We don't need to know why we have multiple connections, we just
    // need to make sure we don't crash or do something weird if it happens.
    for stream in listener.incoming() {
        // Graceful-shutdown check: the heartbeat watcher sets this flag then sends a
        // self-connection to unblock accept(). When we see it, drop the stream and stop.
        if stop_flag.load(Ordering::SeqCst) {
            log::info!("Graceful shutdown requested — exiting accept loop");
            break;
        }
        match stream {
            Ok(stream) => {
                // Draining (admin shutdown): refuse new connections; existing
                // sessions run to completion, then the proxy exits.
                if draining.load(Ordering::SeqCst) {
                    log::info!("Draining — refusing new connection");
                    let _ = stream.shutdown(std::net::Shutdown::Both);
                    continue;
                }
                let args_clone = ProxyArgs {
                    host: args.host.clone(),
                    port: args.port,
                    token: args.token.to_owned(),
                    debug: args.debug,
                    port_wait_mode: args.port_wait_mode,
                    log_stderr: args.log_stderr,
                    log_dir: args.log_dir.clone(),
                    no_token: args.no_token,
                    heartbeat: false, // watchdog already running on main thread; no second instance
                    instance: args.instance.clone(),
                    idle_timeout: args.idle_timeout,
                    status: false,
                    shutdown: false,
                    all: false,
                    daemonized: true,
                };
                let registry_clone = Arc::clone(&serial_registry);
                let serial_available_hub_clone = Arc::clone(&serial_available_hub);
                let lifetime_conn = Arc::clone(&lifetime);
                let admin_ctx_conn = Arc::clone(&admin_ctx);
                let handle = thread::spawn(move || match admin::discriminate(&stream) {
                    admin::Kind::Session => {
                        // Session ref held for the session's lifetime; its drop
                        // (session end) may arm the idle timer.
                        let _session_ref = lifetime_conn.acquire();
                        let mut new_client = ProxyServer::new(
                            args_clone,
                            stream,
                            registry_clone,
                            serial_available_hub_clone,
                        );
                        new_client.message_loop().unwrap_or_else(|e| {
                            log::error!("Error in client message loop: {}", e);
                        });
                    }
                    admin::Kind::Admin => admin::handle(stream, &admin_ctx_conn),
                    admin::Kind::Unknown => {
                        log::warn!("Unrecognized connection (no session/admin prefix) — closing");
                        let _ = stream.shutdown(std::net::Shutdown::Both);
                    }
                });
                client_threads.push(handle);
            }
            Err(e) => {
                if stop_flag.load(Ordering::SeqCst) {
                    // Expected error from the self-connect wakeup; ignore it.
                    log::info!(
                        "Graceful shutdown: ignoring accept error during shutdown: {}",
                        e
                    );
                    break;
                }
                log::error!("Connection failed: {}", e);
            }
        }
    }

    // Upgrade handover: if a newer proxy superseded us, release the lock NOW (so
    // it can bind) and leave endpoint.json alone (the successor owns it). We then
    // serve our existing sessions to completion, headless.
    let was_superseded = superseded.load(Ordering::SeqCst);
    if was_superseded {
        drop(lock_guard.take());
        log::info!(
            "Handed off identity; serving {} existing session(s) to completion",
            client_threads.len()
        );
    }

    // Wait for all client handler threads so their ProxyServer instances are fully dropped
    // (killing any still-running gdb-server/openocd children) before we return.
    log::info!(
        "Waiting for {} client thread(s) to finish",
        client_threads.len()
    );
    for handle in client_threads {
        handle.join().ok();
    }
    let _ = serial_available_watcher_stop.send(());

    // Best-effort: remove the discovery anchor — unless a successor now owns it.
    // The advisory lock auto-releases when `lock_guard` drops on return (if not
    // already released above).
    if !was_superseded {
        let _ = std::fs::remove_file(&instance.endpoint_path);
    }
    log::info!("All client threads finished — proxy exiting cleanly");

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn panic_in_thread_does_not_kill_process() {
        let temp = tempfile::tempdir().expect("failed to create temp dir");
        let args = ProxyArgs {
            host: "127.0.0.1".to_string(),
            port: 0,
            token: "test-token".to_string(),
            debug: true,
            port_wait_mode: PortWaitMode::ConnectHold,
            log_stderr: false,
            log_dir: Some(temp.path().to_string_lossy().to_string()),
            no_token: false,
            heartbeat: false,
            instance: "default".to_string(),
            idle_timeout: 300,
            status: false,
            shutdown: false,
            all: false,
            daemonized: false,
        };

        let _log_handle = init_logging(&args);
        install_panic_hook();

        let join = std::thread::Builder::new()
            .name("panic-test-thread".to_string())
            .spawn(|| {
                panic!("intentional panic for logging test");
            })
            .expect("failed to spawn panic thread")
            .join();
        assert!(join.is_err());

        let ok = std::thread::spawn(|| 7usize)
            .join()
            .expect("non-panicking thread should complete");
        assert_eq!(ok, 7usize);
    }
}
