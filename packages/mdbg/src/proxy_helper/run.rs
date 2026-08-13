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
use flexi_logger::{Age, Cleanup, Criterion, Duplicate, FileSpec, Logger, LoggerHandle, Naming};
use std::{
    backtrace::Backtrace,
    net::{Ipv4Addr, TcpListener},
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
use crate::proxy_helper::listeners;
use crate::proxy_helper::proxy_server::SerialPortRegistry;
use crate::proxy_helper::serial_available::{start_serial_available_watcher, SerialAvailabilityHub};
use crate::proxy_helper::singleton;

// Clone so an accept loop can stamp out a per-connection copy from a template
// instead of rebuilding it field by field (which silently drifts when a field is
// added).
#[derive(Args, Debug, Clone)]
pub struct ProxyArgs {
    /// Address to listen on, in addition to loopback (which is always bound).
    ///
    /// `Option` rather than a defaulted `String` so we can tell "the caller asked for
    /// this address" from "the caller said nothing". That distinction is what lets a
    /// plain `mdbg proxy` reuse a running daemon untouched, while
    /// `mdbg proxy --host 172.28.240.1` asks that daemon to *widen* to that address.
    ///
    /// `0.0.0.0` listens on every interface and is bound alone (it already accepts
    /// loopback); it cannot be added to a running proxy.
    #[arg(short = 'H', long = "host")]
    pub host: Option<String>,

    /// TCP port to listen on (0 = auto-assign)
    #[arg(short = 'p', long = "port", default_value_t = 0)]
    pub port: u16,

    /// Authentication token for client connections.
    ///
    /// Omit it and a fresh random one is generated for this proxy and reported in the
    /// discovery line. There is deliberately **no fixed default**: a constant compiled
    /// into a public repository is a shared secret everybody already knows, and the
    /// proxy can now bind addresses reachable from off-box.
    ///
    /// `MDBG_PROXY_TOKEN` lets an operator set this without putting the secret on a
    /// command line (visible in `ps`) or in a `launch.json` under source control. The
    /// client reads the same variable, so one export configures both ends.
    #[arg(short = 't', long = "token", env = "MDBG_PROXY_TOKEN")]
    pub token: Option<String>,

    /// Enable debug output
    #[arg(short = 'd', long = "debug", default_value_t = false)]
    pub debug: bool,

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
    #[arg(long = "instance", env = "MDBG_PROXY_INSTANCE", default_value = "default")]
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
    /// With `--close-serial`, target every instance rather than just the resolved one.
    #[arg(long = "all", default_value_t = false)]
    pub all: bool,

    /// Client mode: force-close a serial port on the running proxy, whoever is using
    /// it, then exit. Pass a device path (`/dev/ttyUSB0`, `COM3`) or `all` for every
    /// open port. Combine with `--all` to do it on every instance.
    ///
    /// Normal `serial.close` is cooperative and per-client, so a wedged or crashed
    /// client can pin a device open; this is the way to take it back.
    #[arg(long = "close-serial", value_name = "PATH|all")]
    pub close_serial: Option<String>,

    /// Internal: marks the re-spawned, detached daemon so it runs the proxy
    /// instead of launching another daemon. Not for direct use.
    #[arg(long = "daemonized", hide = true, default_value_t = false)]
    pub daemonized: bool,
}

/// Shortest token we accept from an operator.
///
/// Not arbitrary: this token is the only thing standing between a proxy and anyone who
/// can reach it, and the proxy can now bind addresses that are reachable from off-box.
/// Sixteen characters is also what the extension's own generator produces, so the floor
/// costs nothing in the automated path.
const MIN_TOKEN_LEN: usize = 16;

/// 128 bits from the OS CSPRNG, hex-encoded.
fn generate_token() -> Result<String> {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes)
        .map_err(|e| anyhow::anyhow!("could not read OS entropy to generate a token: {e}"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// The token this proxy will accept: whatever was supplied, or a freshly minted one.
///
/// There is no fixed fallback. A constant compiled into a public repository is a secret
/// everybody already has, and it would be silently reused by every hand-started daemon —
/// exactly the lab-server case where the proxy is most likely to be reachable from
/// somewhere other than loopback.
fn resolve_token(supplied: Option<&str>) -> Result<String> {
    let Some(token) = supplied else {
        return generate_token();
    };
    let token = token.trim();
    if token.chars().count() < MIN_TOKEN_LEN {
        anyhow::bail!(
            "--token must be at least {MIN_TOKEN_LEN} characters (got {}). \
             Omit it entirely to have one generated, or set MDBG_PROXY_TOKEN.",
            token.chars().count()
        );
    }
    Ok(token.to_string())
}

fn init_logging(args: &ProxyArgs) -> Option<LoggerHandle> {
    let log_dir = args
        .log_dir
        .clone()
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("mcu-debug").join("proxy-logs"));

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
    .rotate(Criterion::Age(Age::Day), Naming::Timestamps, Cleanup::KeepLogFiles(14))
    .duplicate_to_stderr(if args.log_stderr {
        Duplicate::All
    } else {
        Duplicate::None
    });

    match logger.start() {
        Ok(handle) => Some(handle),
        Err(e) => {
            eprintln!("Logger initialization failed, continuing without file logger: {}", e);
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

/// Parse `--host`, defaulting to loopback when the caller said nothing.
///
/// Kept separate from the bind so the "no address requested" case is explicit at every
/// call site: a plain `mdbg proxy` must not look like a request to widen a running
/// daemon to `127.0.0.1`.
pub(crate) fn parse_host_arg(host: Option<&str>) -> Result<Ipv4Addr> {
    match host {
        None => Ok(Ipv4Addr::LOCALHOST),
        Some(h) => h
            .parse::<Ipv4Addr>()
            .with_context(|| format!("invalid host IP address: '{h}'")),
    }
}

/// Signal every accept loop to stop, then unblock each one by self-connecting so its
/// blocked `accept()` returns and the loop sees the flag and breaks. Used by the idle
/// monitor and by admin drain.
///
/// Every bound address must be woken, not just the published one: a widened listener
/// is parked in its own `accept()` and would otherwise keep the process alive.
pub(crate) fn trigger_graceful_shutdown(stop_flag: &AtomicBool, accept_set: &listeners::AcceptSet) {
    stop_flag.store(true, Ordering::SeqCst);
    accept_set.wake_all();
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
    if let Some(path) = &args.close_serial {
        return if args.all {
            close_serial_all(path)
        } else {
            close_serial_one(&args.instance, path)
        };
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
        closed: Vec::new(),
        hosts: Vec::new(),
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
        path: String::new(),
        host: String::new(),
    };
    match admin::query(&endpoint, &req) {
        Ok(resp) => print(&resp),
        Err(e) => print(&not_running(format!("proxy not reachable ({e:#})"))),
    }
}

/// One instance's answer to `--close-serial`.
#[derive(serde::Serialize)]
struct CloseSerialResult {
    instance: String,
    ok: bool,
    /// Paths actually closed on this instance.
    closed: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(serde::Serialize)]
struct CloseSerialReport {
    /// Instances that answered.
    count: usize,
    /// Total ports closed across all of them.
    closed: usize,
    results: Vec<CloseSerialResult>,
}

fn close_serial_request(endpoint: &singleton::Endpoint, path: &str) -> admin::AdminRequest {
    admin::AdminRequest {
        v: 1,
        cmd: "serialClose".to_string(),
        token: endpoint.token.clone(),
        graceful: false,
        version: String::new(),
        path: path.to_string(),
        host: String::new(),
    }
}

/// `--close-serial <path>` against the single resolved instance.
fn close_serial_one(instance_name: &str, path: &str) -> Result<()> {
    let instance = singleton::Instance::resolve(instance_name)?;
    let mut results = Vec::new();
    if let Ok(endpoint) = singleton::read_endpoint(&instance.endpoint_path) {
        let req = close_serial_request(&endpoint, path);
        match admin::query(&endpoint, &req) {
            Ok(resp) => results.push(CloseSerialResult {
                instance: instance.name.clone(),
                ok: resp.ok,
                closed: resp.closed,
                message: resp.message,
                error: resp.error,
            }),
            Err(e) => results.push(CloseSerialResult {
                instance: instance.name.clone(),
                ok: false,
                closed: Vec::new(),
                message: None,
                error: Some(format!("proxy not reachable ({e:#})")),
            }),
        }
    } else {
        // Not running means no port is held — the caller's goal already holds, so
        // this is reported rather than treated as a failure.
        results.push(CloseSerialResult {
            instance: instance.name.clone(),
            ok: true,
            closed: Vec::new(),
            message: Some(format!("no proxy running for instance '{}'", instance.name)),
            error: None,
        });
    }
    print_close_serial(results)
}

/// `--close-serial <path> --all`: every running instance. Same split as
/// `--shutdown` / `shutdown_all` — `--all` selects instances, and the *path*
/// (`"all"`) selects ports, so the two compose.
fn close_serial_all(path: &str) -> Result<()> {
    let mut results = Vec::new();
    for inst in singleton::list_instances()? {
        let endpoint = match singleton::read_endpoint(&inst.endpoint_path) {
            Ok(ep) => ep,
            Err(_) => continue, // no discovery anchor → not running
        };
        let req = close_serial_request(&endpoint, path);
        // Only report instances that answered — a dead proxy's stale endpoint holds
        // no serial port either.
        if let Ok(resp) = admin::query(&endpoint, &req) {
            results.push(CloseSerialResult {
                instance: inst.name,
                ok: resp.ok,
                closed: resp.closed,
                message: resp.message,
                error: resp.error,
            });
        }
    }
    print_close_serial(results)
}

fn print_close_serial(results: Vec<CloseSerialResult>) -> Result<()> {
    let report = CloseSerialReport {
        count: results.len(),
        closed: results.iter().map(|r| r.closed.len()).sum(),
        results,
    };
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
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
            path: String::new(),
            cmd: "status".to_string(),
            token: endpoint.token.clone(),
            graceful: true,
            version: String::new(),
            host: String::new(),
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
            path: String::new(),
            host: String::new(),
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

/// Ask a running proxy to also accept on `--host`, if one was requested and it is not
/// already served. Returns the daemon's resulting host list and any bind failure.
///
/// Never fatal. A proxy we could not widen is still a proxy the caller can use on
/// loopback, and only the caller knows whether the missing address was the point —
/// so the outcome is reported rather than acted on here.
fn widen_running_proxy(ep: &singleton::Endpoint, args: &ProxyArgs) -> (Vec<String>, Vec<singleton::BindError>) {
    let known = ep.host_list();
    let Some(requested) = args.host.as_deref() else {
        return (known, Vec::new()); // nothing asked for; leave the daemon alone
    };
    let fail = |msg: String| -> (Vec<String>, Vec<singleton::BindError>) {
        (
            ep.host_list(),
            vec![singleton::BindError {
                host: requested.to_string(),
                error: msg,
            }],
        )
    };
    let host = match parse_host_arg(Some(requested)) {
        Ok(h) => h,
        Err(e) => return fail(format!("{e:#}")),
    };
    // Loopback is always bound, and an address already served needs no request.
    if host.is_loopback() || known.iter().any(|h| h == requested) {
        return (known, Vec::new());
    }
    let req = admin::AdminRequest {
        v: 1,
        cmd: "widen".to_string(),
        token: ep.token.clone(),
        graceful: false,
        version: String::new(),
        path: String::new(),
        host: host.to_string(),
    };
    match admin::query(ep, &req) {
        Ok(resp) if resp.ok => (if resp.hosts.is_empty() { known } else { resp.hosts }, Vec::new()),
        Ok(resp) => fail(resp.error.unwrap_or_else(|| "widen refused".to_string())),
        Err(e) => fail(format!("proxy not reachable ({e:#})")),
    }
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
        // The running proxy's token, so a reusing client can authenticate to it.
        let token = Some(ep.token.as_str());

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
            // Reuse is also the widen path. Starting the proxy is a single idiom —
            // "run it and read the discovery line" — so asking for an address the
            // running daemon does not yet serve must work the same way, rather than
            // needing a separate command the caller has to know to issue.
            let (hosts, bind_errors) = widen_running_proxy(&ep, args);
            singleton::print_discovery(ep.port, ep.pid, token, &hosts, bind_errors);
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
            let (hosts, bind_errors) = widen_running_proxy(&ep, args);
            singleton::print_discovery(ep.port, ep.pid, token, &hosts, bind_errors);
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
    cmd.arg("proxy");
    // Forward --host only when the caller actually passed one, so the daemon sees the
    // same "was an address requested?" distinction this process saw.
    if let Some(host) = &args.host {
        cmd.arg("--host").arg(host);
    }
    cmd.arg("--port")
        .arg(args.port.to_string())
        .arg("--instance")
        .arg(&args.instance)
        .arg("--idle-timeout")
        .arg(args.idle_timeout.to_string())
        // The marker that tells the child it IS the daemon (don't re-launch).
        .arg("--daemonized");
    // Forward the resolved token so the daemon uses the same one this process settled
    // on -- including a freshly generated one, which the child could not reproduce.
    if let Some(token) = &args.token {
        cmd.arg("--token").arg(token);
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
        let res = std::io::BufReader::new(stdout).read_line(&mut line).map(|_| line);
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

pub fn run(mut args: ProxyArgs) -> Result<()> {
    // Resolve the token before anything else, so every later reader sees a concrete
    // value and the failure for a too-short one lands on the command line rather than
    // as a rejected connection later. The launcher resolves it too, then forwards the
    // result, so the daemon it spawns uses the same token rather than minting a second.
    args.token = Some(resolve_token(args.token.as_deref())?);
    let token = args.token.clone().expect("token resolved on the line above");

    // Client modes: query/command a running proxy and exit — do not start one.
    // Kept lightweight: no daemon logging setup.
    if args.status || args.shutdown || args.close_serial.is_some() {
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
    let requested_host = parse_host_arg(args.host.as_deref())?;

    // Loopback is always served; a specific requested address is served *as well*.
    // See `listeners::planned_bind_addrs` for why the wildcard is the exception.
    let plan = listeners::planned_bind_addrs(requested_host);

    // Bind the first address before the rest: with `--port 0` the OS assigns the port
    // here, and every other address must share that same number.
    let primary = plan[0];
    let listener = match TcpListener::bind((primary, args.port)) {
        Ok(listener) => listener,
        Err(e) => {
            log::error!("Failed to bind to {}:{}", primary, args.port);
            return Err(e.into());
        }
    };
    let local_port = listener.local_addr()?.port();

    // Additional addresses are best-effort. Failing to bind the WSL gateway must not
    // stop a proxy that is perfectly usable locally — but the caller has to be told,
    // because only it knows whether that address was the whole point. The report rides
    // out on the discovery line (see `print_discovery`).
    let mut pending: Vec<TcpListener> = vec![listener];
    let mut bind_errors: Vec<singleton::BindError> = Vec::new();
    for extra in &plan[1..] {
        match TcpListener::bind((*extra, local_port)) {
            Ok(l) => pending.push(l),
            Err(e) => {
                log::warn!("Failed to also bind {extra}:{local_port}: {e}");
                bind_errors.push(singleton::BindError {
                    host: extra.to_string(),
                    error: e.to_string(),
                });
            }
        }
    }
    let bound_hosts: Vec<String> = pending
        .iter()
        .filter_map(|l| l.local_addr().ok())
        .map(|a| a.ip().to_string())
        .collect();

    // Publish the discovery anchor now that we own the lock and have a port.
    let endpoint = singleton::Endpoint {
        v: 3,
        instance: instance.name.clone(),
        pid: std::process::id(),
        version: singleton::self_version(),
        port: local_port,
        // The address a client most likely wants to dial: what was asked for, if it
        // bound, else the primary. `hosts` below is the complete, authoritative list.
        bind_host: if bound_hosts.contains(&requested_host.to_string()) {
            requested_host.to_string()
        } else {
            primary.to_string()
        },
        hosts: bound_hosts.clone(),
        token: token.clone(),
        state: "active".to_string(),
        started_at_unix: singleton::Endpoint::now_unix(),
    };
    singleton::write_endpoint_atomic(&instance.endpoint_path, &endpoint)?;

    // Graceful-shutdown flag. The idle monitor (and, later, admin shutdown) set
    // it and self-connect; the accept loop polls it after each accept and breaks.
    let stop_flag = Arc::new(AtomicBool::new(false));

    // Every address we accept on. Starts as just the published one; widening for a
    // WSL/Docker guest adds to it without touching the original listener.
    let accept_set = Arc::new(listeners::AcceptSet::new());

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

    // Serial ports outlive individual ProxyServer connections — the registry is owned
    // here and cloned (Arc) into each connection's ProxyServer. It is created before
    // the admin context because admin reports on it (`--status`) and force-closes
    // through it (`--close-serial`).
    let serial_registry: SerialPortRegistry = Arc::new(Mutex::new(std::collections::HashMap::new()));

    // Shared context for admin (`--status` / `--shutdown` / `upgrade` /
    // `--close-serial`) connections.
    let admin_ctx = Arc::new(AdminContext {
        token: token.clone(),
        lifetime: Arc::clone(&lifetime),
        draining: Arc::clone(&draining),
        superseded: Arc::clone(&superseded),
        stop_flag: stop_flag.clone(),
        accept_set: Arc::clone(&accept_set),
        serial_registry: Arc::clone(&serial_registry),
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
        let accept_set_monitor = Arc::clone(&accept_set);
        let idle = Duration::from_secs(args.idle_timeout);
        let idle_timeout = args.idle_timeout;
        thread::spawn(move || {
            lifetime_monitor.wait_until_idle(idle);
            log::info!("Idle for {}s with no active sessions — shutting down", idle_timeout);
            trigger_graceful_shutdown(&stop_flag_monitor, &accept_set_monitor);
        });
    }

    log::info!(
        "Proxy helper startup: pid={}, host={}, port={}, log_stderr={}, stdin_watchdog={}",
        std::process::id(),
        bound_hosts.join(","),
        local_port,
        args.log_stderr,
        args.heartbeat
    );

    // Print Discovery JSON to stdout: {"status": "ready", "port": <actual_port>, "pid": <pid>} with an optional "token" field
    // If --no-token is not set, the client will parse this to discover the port and token to use for connecting to the Probe Agent.
    singleton::print_discovery(
        local_port,
        std::process::id(),
        Some(token.as_str()),
        &bound_hosts,
        std::mem::take(&mut bind_errors),
    );

    log::info!("Probe Agent listening on port {}", local_port);

    let serial_available_hub = Arc::new(SerialAvailabilityHub::new());
    let serial_available_watcher_stop = start_serial_available_watcher(Arc::clone(&serial_available_hub));

    // Everything a connection needs, independent of which address it arrived on.
    // Held by every accept loop, so widening later adds a listener without having to
    // thread any new state through.
    let accept_ctx = Arc::new(listeners::AcceptCtx {
        conn_args: ProxyArgs {
            // Watchdog already runs on the main thread; a child must not start another.
            heartbeat: false,
            // Admin-mode flags are for the CLI client, never for a served connection.
            status: false,
            shutdown: false,
            all: false,
            daemonized: true,
            ..args.clone()
        },
        stop_flag: Arc::clone(&stop_flag),
        draining: Arc::clone(&draining),
        lifetime: Arc::clone(&lifetime),
        admin_ctx: Arc::clone(&admin_ctx),
        serial_registry,
        serial_available_hub,
        client_threads: Mutex::new(Vec::new()),
    });

    // Hand the set the context that later listeners will need, so an admin `widen`
    // can start an accept loop without any of this being threaded through it.
    accept_set.set_ctx(&accept_ctx);

    // Start accepting on every address we bound. More can join this set later without
    // disturbing these — see `listeners` for why we add rather than rebind.
    for l in pending {
        accept_set.add(l, Arc::clone(&accept_ctx))?;
    }

    // Block until every accept loop has exited (global stop flag set + woken).
    accept_set.join_all();

    let client_threads = accept_ctx.take_client_threads();

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
    log::info!("Waiting for {} client thread(s) to finish", client_threads.len());
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

    /// Omitting `--token` must mint a fresh secret, never fall back to a constant.
    ///
    /// A default compiled into a public repository is a secret everybody already has,
    /// and it would be reused by every hand-started daemon — precisely the lab-server
    /// case where the proxy is most likely bound somewhere other than loopback.
    #[test]
    fn an_omitted_token_is_generated_and_unpredictable() {
        let a = resolve_token(None).expect("generation must succeed");
        let b = resolve_token(None).expect("generation must succeed");

        assert!(
            a.chars().count() >= MIN_TOKEN_LEN,
            "generated token is long enough: {a}"
        );
        assert_ne!(a, b, "each proxy must get its own token");
        assert!(
            a.chars().all(|c| c.is_ascii_alphanumeric()),
            "safe to pass as an argument: {a}"
        );
    }

    /// A short token is refused at startup, where the operator can see it, rather than
    /// becoming a connection that is rejected much later for reasons that look unrelated.
    #[test]
    fn a_short_token_is_refused_with_a_useful_message() {
        let err = resolve_token(Some("hunter2")).expect_err("must be refused");
        let msg = err.to_string();

        assert!(
            msg.contains(&MIN_TOKEN_LEN.to_string()),
            "states the requirement: {msg}"
        );
        assert!(msg.contains("MDBG_PROXY_TOKEN"), "points at the alternative: {msg}");
    }

    /// Whitespace is not length. A padded short token is still a short token.
    #[test]
    fn a_token_is_trimmed_before_it_is_measured() {
        assert!(resolve_token(Some("   short   ")).is_err());

        let ok = resolve_token(Some("  0123456789abcdef  ")).expect("long enough once trimmed");
        assert_eq!(ok, "0123456789abcdef", "stored without the padding");
    }

    /// Exactly at the boundary is acceptable -- and is what the extension generates, so
    /// tightening this further would break the automated path.
    #[test]
    fn a_token_of_exactly_the_minimum_length_is_accepted() {
        let token = "a".repeat(MIN_TOKEN_LEN);

        assert_eq!(resolve_token(Some(&token)).expect("accepted"), token);
    }

    #[test]
    fn panic_in_thread_does_not_kill_process() {
        let temp = tempfile::tempdir().expect("failed to create temp dir");
        let args = ProxyArgs {
            host: None,
            port: 0,
            token: Some("test-token-0123456789".to_string()),
            debug: true,
            log_stderr: false,
            log_dir: Some(temp.path().to_string_lossy().to_string()),
            heartbeat: false,
            instance: "default".to_string(),
            idle_timeout: 300,
            status: false,
            shutdown: false,
            all: false,
            close_serial: None,
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
