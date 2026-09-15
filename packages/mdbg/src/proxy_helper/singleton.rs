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

//! Singleton identity for `mdbg proxy` (Tier 1, Phase A).
//!
//! One proxy runs per `(user, instance)`. Identity lives in a per-instance
//! state directory under the user's home:
//!
//! ```text
//! ~/.mcu-debug/proxy/<instance>/
//! ├── proxy.lock     # advisory lock; the OS releases it on process death,
//! │                  # so a live proxy ⇔ the lock is held (no stale-lock problem)
//! └── endpoint.json  # the discovery anchor: how to reach the running proxy
//! ```
//!
//! The **file** (`endpoint.json`) is the stable identity, not the port — the
//! port is OS-assigned (`--port 0`) and changes across restarts/upgrades.
//!
//! See `docs-internal/Singleton-Tier1-Plan.md`.

use std::io::Write;
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

/// A resolved per-instance state directory and the paths within it.
pub struct Instance {
    pub name: String,
    pub dir: PathBuf,
    pub lock_path: PathBuf,
    pub endpoint_path: PathBuf,
}

impl Instance {
    /// Resolve the state dir for `name` under `~/.mcu-debug/proxy/<name>/`.
    ///
    /// `name` must be a single path segment (no separators, no `..`) so it can
    /// never escape the proxy directory.
    pub fn resolve(name: &str) -> Result<Instance> {
        if name.is_empty() || name.contains(['/', '\\']) || name == ".." || name == "." {
            bail!("invalid proxy instance name: {name:?}");
        }
        let dir = proxy_base()?.join(name);
        Ok(Instance {
            name: name.to_string(),
            lock_path: dir.join("proxy.lock"),
            endpoint_path: dir.join("endpoint.json"),
            dir,
        })
    }

    /// Create the state directory (and parents) if missing.
    pub fn ensure_dir(&self) -> Result<()> {
        std::fs::create_dir_all(&self.dir)
            .with_context(|| format!("could not create proxy state dir {}", self.dir.display()))
    }
}

/// The base directory holding every per-instance state dir: `MDBG_PROXY_STATE_DIR`
/// if set, else `~/.mcu-debug/proxy`. Instance dirs live directly under it.
pub fn proxy_base() -> Result<PathBuf> {
    // Overridden in containers where $HOME isn't writable, tests, and custom
    // deployments.
    Ok(match std::env::var_os("MDBG_PROXY_STATE_DIR") {
        Some(p) => PathBuf::from(p),
        None => dirs::home_dir()
            .context("could not determine the home directory")?
            .join(".mcu-debug")
            .join("proxy"),
    })
}

/// Every instance that currently has a state directory under the proxy base,
/// sorted by name. A directory existing does NOT imply a live proxy — it may
/// hold a stale `endpoint.json` from a crashed process, so callers must check
/// liveness (e.g. by querying the endpoint). Empty when the base doesn't exist.
pub fn list_instances() -> Result<Vec<Instance>> {
    let base = proxy_base()?;
    let entries = match std::fs::read_dir(&base) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e).with_context(|| format!("could not read proxy base {}", base.display())),
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            if let Some(name) = entry.file_name().to_str() {
                if let Ok(inst) = Instance::resolve(name) {
                    out.push(inst);
                }
            }
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// `Endpoint::state` for a proxy serving its instance.
pub const STATE_ACTIVE: &str = "active";
/// `Endpoint::state` for a proxy that is handing its instance over or shutting down. Written
/// by `admin.rs` and read back by `acquire_or_reuse`, so the spelling lives in one place.
pub const STATE_DRAINING: &str = "draining";

/// The discovery anchor written by the proxy that owns the lock.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Endpoint {
    /// Schema version.
    pub v: u32,
    pub instance: String,
    pub pid: u32,
    /// semver of the running proxy binary (`CARGO_PKG_VERSION`).
    pub version: String,
    /// Port the funnel/control listener is bound to.
    pub port: u16,
    /// Address the listener is actually bound to (e.g. `127.0.0.1`, `0.0.0.0`, or a
    /// specific interface address).
    ///
    /// This is a *bind* address, not necessarily a *connect* address -- `0.0.0.0` is a
    /// wildcard and is never a valid destination. A client maps this through its own
    /// topology to decide what to dial; see `bindHost` vs `proxyHostForDA` in
    /// `shared/src/proxy-network.ts`.
    ///
    /// What discovery could not previously answer is the question that matters: is this
    /// proxy reachable at all from off-loopback? Without it a client had no choice but to
    /// assume `127.0.0.1`, which silently fails for a WSL NAT or Docker guest.
    #[serde(default = "default_bind_host")]
    pub bind_host: String,
    /// **Every** address the listener currently accepts on, `bind_host` included.
    ///
    /// `bind_host` names the address this proxy was started with and never changes;
    /// this list grows when a later caller widens the proxy for a WSL/Docker guest
    /// (see `listeners::AcceptSet`). A client that needs to know whether some
    /// specific address is reachable must consult this, not `bind_host`.
    ///
    /// Defaults to `[bind_host]` so a v1/v2 record still parses.
    #[serde(default)]
    pub hosts: Vec<String>,
    /// Connection token (Tier-1 shared token; replaced by minted tokens later).
    #[serde(default)]
    pub token: String,
    /// [`STATE_ACTIVE`] or [`STATE_DRAINING`].
    pub state: String,
    /// Unix seconds when the proxy started (for `--status` uptime later).
    pub started_at_unix: u64,
    /// The executable this proxy is running, stamped at its startup. Lets a later launch
    /// tell "same version, same binary" from "same version, binary replaced since" — the
    /// difference between a legitimate reuse and serving stale code. `default` so a
    /// record written before this field still parses; see [`decide_handover`] for how an
    /// empty stamp is read.
    #[serde(default)]
    pub exe: ExeStamp,
}

impl Endpoint {
    pub fn now_unix() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    }
}

/// Parse a `major.minor.patch` version into a tuple, ignoring any pre-release /
/// build suffix (`-alpha`, `+meta`). Missing components are 0.
/// Records written before `bind_host` existed came from proxies that bound loopback
/// unless explicitly launched with `--host`. Loopback is the safe assumption: it
/// under-promises reachability, so a client widens rather than failing to connect.
impl Endpoint {
    /// Every address this proxy accepts on.
    ///
    /// Falls back to `[bind_host]` for a v1/v2 record, which predates the list — those
    /// proxies bound exactly one address, so the fallback is exact rather than a guess.
    pub fn host_list(&self) -> Vec<String> {
        if self.hosts.is_empty() {
            vec![self.bind_host.clone()]
        } else {
            self.hosts.clone()
        }
    }
}

fn default_bind_host() -> String {
    "127.0.0.1".to_string()
}

fn version_tuple(v: &str) -> (u64, u64, u64) {
    let mut parts = v.split(['.', '-', '+']).filter_map(|s| s.parse::<u64>().ok());
    (
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
    )
}

/// True when version `a` is strictly newer than `b` (semver-ish, suffix-ignoring).
pub fn is_newer(a: &str, b: &str) -> bool {
    version_tuple(a) > version_tuple(b)
}

/// What `--status` reports about the executable a running proxy is serving from.
///
/// The daemon answers this itself rather than leaving the caller to compare numbers,
/// because only the daemon knows what it started with, and it is the one process
/// guaranteed to be on the same filesystem as the file in question.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "proxy-protocol/")]
pub struct ExeStatus {
    /// Path this proxy was launched from.
    pub path: String,
    /// The file's mtime when this proxy started, in epoch milliseconds, and the same
    /// value rendered in local time.
    pub started_with_mtime_ms: Option<u64>,
    pub started_with_mtime: String,
    /// What is at `path` right now. Differs from the above once the binary has been
    /// replaced -- which is normal and expected during a build or a reinstall.
    pub on_disk_mtime_ms: Option<u64>,
    pub on_disk_mtime: String,
    /// The question worth asking: **is this proxy serving code that is no longer on
    /// disk?** True after a rebuild or a same-version reinstall, until the next launch
    /// hands over to the replacement (see [`decide_handover`]). `false` when either
    /// mtime is unknown -- absent evidence is not evidence.
    pub replaced_since_start: bool,
}

impl ExeStatus {
    /// Build a report by stat-ing `stamp.path` now and comparing with what it held at
    /// startup. Cheap: one `stat` per status query.
    pub fn describe(stamp: &ExeStamp) -> ExeStatus {
        let on_disk_mtime_ms = if stamp.path.is_empty() {
            None
        } else {
            std::fs::metadata(&stamp.path)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
        };
        ExeStatus {
            path: stamp.path.clone(),
            started_with_mtime_ms: stamp.mtime_ms,
            started_with_mtime: format_epoch_ms(stamp.mtime_ms),
            on_disk_mtime_ms,
            on_disk_mtime: format_epoch_ms(on_disk_mtime_ms),
            replaced_since_start: match (stamp.mtime_ms, on_disk_mtime_ms) {
                (Some(started), Some(now)) => now != started,
                _ => false,
            },
        }
    }
}

/// Which executable a proxy is running, and how old that file was when it started.
///
/// The mtime **must** be taken at startup and then never re-read, because the file it
/// describes can be replaced underneath a running daemon. Both ways of replacing it
/// swap the inode rather than writing into it (`scripts/build-binaries.sh copy_artifact`
/// does `mv` deliberately; VS Code extracts an extension into a fresh directory), so
/// stat-ing the path later reports the *replacement* and says nothing about the code
/// actually executing. On Linux it is worse than useless: `current_exe()` resolves
/// `/proc/self/exe` to the inode, so after a swap the running daemon's own path reads
/// back as `…/mdbg (deleted)` and the stat fails outright.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExeStamp {
    /// Absolute path this proxy was launched from. Empty when it could not be determined.
    #[serde(default)]
    pub path: String,
    /// The file's mtime when this proxy started, in **milliseconds** since the Unix epoch.
    ///
    /// Milliseconds rather than nanoseconds so the number stays exactly representable as
    /// a JSON double -- nanos since 1970 are ~1.7e18, well past 2^53, and any JavaScript
    /// reader of `endpoint.json` would silently round them. Millisecond resolution is far
    /// finer than the question being asked ("was this file replaced?").
    ///
    /// `None` when the stat failed, which is treated as "no evidence" rather than "old".
    #[serde(default)]
    pub mtime_ms: Option<u64>,
}

/// Format epoch milliseconds as a local-time string, or `""` for `None`.
///
/// `mtime_ms` is plain Unix epoch milliseconds, so consumers can do this themselves
/// (`new Date(ms)`, `date -r $((ms/1000))`). This exists because `--status` is read by
/// people, and a bare 13-digit number is not something anyone eyeballs.
pub fn format_epoch_ms(ms: Option<u64>) -> String {
    let Some(ms) = ms else {
        return String::new();
    };
    match chrono::DateTime::from_timestamp_millis(ms as i64) {
        Some(dt) => dt.with_timezone(&chrono::Local).format("%Y-%m-%d %H:%M:%S").to_string(),
        None => String::new(),
    }
}

/// Stat our own executable. Call once, at startup -- see [`ExeStamp`].
pub fn exe_stamp() -> ExeStamp {
    let Ok(path) = std::env::current_exe() else {
        return ExeStamp::default();
    };
    let mtime_ms = std::fs::metadata(&path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64);
    ExeStamp {
        path: path.to_string_lossy().into_owned(),
        mtime_ms,
    }
}

/// What a launching proxy should do about the proxy already holding the instance lock.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Handover {
    /// Leave the running proxy alone and use it as it is.
    Reuse,
    /// The running proxy is strictly older by version — the Phase D handover.
    UpgradeByVersion,
    /// Same version, but our executable is a *newer file at the same path*: the binary
    /// was replaced in place, so the running daemon is executing code that no longer
    /// exists on disk.
    UpgradeByExe,
}

/// Decide whether `challenger` should supersede `running`.
///
/// Both ends run this: the launching proxy to decide whether to ask, and the running
/// proxy to decide whether to agree. Same inputs, same answer — a challenger cannot talk
/// its way past a rule the incumbent applies for itself.
///
/// The version comparison is the original rule and still decides most cases. What it
/// cannot see is the case that actually dominates in practice: **installing the same
/// version on top of itself**. A release happens once; a test build gets carried to half
/// a dozen machines and reinstalled repeatedly, each time leaving a daemon whose version
/// is identical and whose code is stale. `is_newer` says "not newer", the daemon is
/// reused, and the debugging happens against the previous binary with nothing to show for
/// it. The exe stamp is what distinguishes that from a legitimate reuse.
///
/// `auto_upgrade` gates only the *question*, never the answer: a daemon agrees to step
/// down on the evidence regardless of how it was itself started. Gating the answer too
/// would mean a daemon launched by a plain window could never be replaced, which is the
/// hole the whole mechanism exists to close.
pub fn decide_handover(
    challenger_version: &str,
    challenger_exe: &ExeStamp,
    running_version: &str,
    running_exe: &ExeStamp,
    auto_upgrade: bool,
) -> Handover {
    if is_newer(challenger_version, running_version) {
        return Handover::UpgradeByVersion;
    }
    // Downgrade guard: an older binary never evicts a newer running one, whatever its
    // file dates say. Rebuilding an old checkout produces a new file with old code.
    if is_newer(running_version, challenger_version) {
        return Handover::Reuse;
    }
    if !auto_upgrade {
        return Handover::Reuse;
    }
    // No mtime of our own is no evidence, and the burden is on the challenger.
    let Some(mine) = challenger_exe.mtime_ms else {
        return Handover::Reuse;
    };
    // A record with neither path nor mtime predates this field entirely, so the daemon
    // that wrote it cannot be compared with — and is by definition running code from
    // before the current install. Supersede it once; its successor records a stamp, so
    // this branch fires at most once per daemon rather than on every launch.
    if running_exe.path.is_empty() && running_exe.mtime_ms.is_none() {
        return Handover::UpgradeByExe;
    }
    // Different paths make the mtimes incomparable, not merely inconvenient: a freshly
    // installed extension can easily hold an older file than a dev build. Versions being
    // equal, a differing path means two separate installs, and neither is "newer".
    if running_exe.path != challenger_exe.path {
        return Handover::Reuse;
    }
    match running_exe.mtime_ms {
        Some(theirs) if mine > theirs => Handover::UpgradeByExe,
        // Equal is the common case (same file, second window) and must reuse. An absent
        // mtime *with* a known path means that daemon tried to stat and failed; treating
        // that as "old" would hand over on every single launch, so it reuses instead.
        _ => Handover::Reuse,
    }
}

/// Whether this launch may ask a same-version daemon to step down.
///
/// Defaults to **on**, and `MDBG_PROXY_AUTO_UPGRADE=0` turns it off. On by default
/// because the alternative is a variable you have to remember to set on every machine
/// you test on — the same failure mode as remembering to kill the daemon by hand, with
/// the same silent symptom. The two outcomes are also nowhere near equally bad: not
/// upgrading means debugging against code you did not build, while upgrading
/// unnecessarily costs a graceful drain in which live sessions finish where they are.
pub fn auto_upgrade_enabled() -> bool {
    match std::env::var("MDBG_PROXY_AUTO_UPGRADE") {
        Ok(v) => !matches!(v.trim().to_ascii_lowercase().as_str(), "0" | "false" | "no" | "off"),
        Err(_) => true,
    }
}

/// This proxy's own version. Normally `CARGO_PKG_VERSION`; `MDBG_PROXY_VERSION`
/// overrides it (for exercising the upgrade/handover path, or forcing behavior).
pub fn self_version() -> String {
    std::env::var("MDBG_PROXY_VERSION").unwrap_or_else(|_| env!("CARGO_PKG_VERSION").to_string())
}

/// Read and parse `endpoint.json`.
pub fn read_endpoint(path: &std::path::Path) -> Result<Endpoint> {
    let bytes = std::fs::read(path).with_context(|| format!("could not read {}", path.display()))?;
    serde_json::from_slice(&bytes).with_context(|| format!("could not parse {}", path.display()))
}

/// What a launch found holding the instance lock.
#[derive(Debug)]
pub enum Holder {
    /// A proxy serving the instance, with its published record: reuse it or ask it to hand over.
    Active(Endpoint),
    /// A proxy on its way out — draining, superseded, or already gone — and the lock is now
    /// free. Its record must never be handed out. `pid` is the departing proxy's, when it
    /// published a record before leaving.
    Leaving { pid: Option<u32> },
}

/// Another proxy holds the instance lock; wait until it is clear which kind of holder it is.
///
/// "Read `endpoint.json`" is the wrong question on its own, because a held lock does not mean a
/// usable record exists. There are two windows where the two disagree:
///
/// - **Starting:** a new proxy takes the lock *before* it publishes its record (it removes any
///   stale file on acquire and writes a fresh one after binding). Wait for the record.
/// - **Leaving:** a draining proxy marks its record [`STATE_DRAINING`], stops accepting, and only
///   then releases the lock — and on shutdown it removes the record first. Reusing that record
///   hands out a proxy that refuses the connection; waiting for the record means waiting for a
///   file nobody will write. Wait for the lock instead.
///
/// So watch both: return [`Holder::Active`] the moment a non-draining record appears, or
/// [`Holder::Leaving`] the moment the lock frees. The lock is only ever *probed* here — no guard
/// escapes — so the caller still takes it once, for real.
pub fn await_holder(
    lock: &mut fd_lock::RwLock<std::fs::File>,
    endpoint_path: &std::path::Path,
    patience: Duration,
) -> Result<Holder> {
    let deadline = Instant::now() + patience;
    let mut last_seen: Option<Endpoint> = None;
    loop {
        match read_endpoint(endpoint_path) {
            Ok(ep) if ep.state != STATE_DRAINING => return Ok(Holder::Active(ep)),
            Ok(ep) => last_seen = Some(ep),
            Err(_) => {} // not published yet, or already removed on the way out
        }
        // Probe only: the guard is a temporary dropped at the end of the condition.
        if lock.try_write().is_ok() {
            return Ok(Holder::Leaving {
                pid: last_seen.map(|ep| ep.pid),
            });
        }
        if Instant::now() >= deadline {
            match last_seen {
                // The draining proxy is still serving a session and holding the lock — the
                // pre-fix behaviour, which an older binary still running would show.
                Some(ep) => bail!(
                    "the instance is held by proxy pid {}, which is draining but has not released it after {}s — \
                     it is still serving a session. Close that client, or kill {}",
                    ep.pid,
                    patience.as_secs(),
                    ep.pid
                ),
                None => bail!(
                    "the instance lock is held but no proxy published {} within {}s",
                    endpoint_path.display(),
                    patience.as_secs()
                ),
            }
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Write `endpoint.json` atomically (temp file + rename) so a concurrent reader
/// never observes a half-written file.
pub fn write_endpoint_atomic(path: &std::path::Path, ep: &Endpoint) -> Result<()> {
    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_vec_pretty(ep)?;
    std::fs::write(&tmp, &json).with_context(|| format!("could not write {}", tmp.display()))?;
    std::fs::rename(&tmp, path).with_context(|| format!("could not rename {} -> {}", tmp.display(), path.display()))?;
    Ok(())
}

/// Print the discovery JSON the launcher parses from stdout. Identical shape
/// whether we started a fresh proxy or are reusing an existing one, so the
/// caller does not care which happened.
///
/// `{"status": "ready", "port": <port>, "pid": <pid>[, "token": "<token>"]}`
/// One requested-but-unbindable address, reported alongside a successful discovery.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct BindError {
    pub host: String,
    pub error: String,
}

/// The single line of JSON `mdbg proxy` prints on stdout before exiting.
///
/// This is the **only** channel back to the caller that survives. The launcher always
/// exits after printing, so every TS launch path ignores the exit code once this line
/// has been seen (`proxy-starter.ts`) — a non-zero exit afterwards is indistinguishable
/// from normal completion. Anything the caller must react to therefore belongs here.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Discovery {
    pub status: String,
    pub port: u16,
    pub pid: u32,
    /// semver of the proxy the caller will actually be talking to.
    ///
    /// Not necessarily *this* binary's version: on the reuse path we print the endpoint of an
    /// already-running proxy, which may be older or newer than us. The caller has to match
    /// whatever is answering, so this reports that, not `CARGO_PKG_VERSION`.
    ///
    /// `default` so a discovery line from a proxy predating this field still parses as empty
    /// rather than failing outright — an unknown version is something a caller can reason
    /// about, a parse error is not.
    #[serde(default)]
    pub version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    /// Every address the proxy accepts on. The caller compares what it asked for
    /// against this to decide whether its topology is actually served.
    pub hosts: Vec<String>,
    /// Addresses that were requested but could not be bound. Present *with* a
    /// `"ready"` status: the proxy is usable, just not everywhere it was asked to be,
    /// and only the caller knows whether the missing one mattered.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub bind_errors: Vec<BindError>,
}

/// `version` is the version of the proxy at `port` — see [`Discovery::version`]. Callers on the
/// reuse path must pass the running proxy's version, not their own.
pub fn print_discovery(
    port: u16,
    pid: u32,
    version: &str,
    token: Option<&str>,
    hosts: &[String],
    bind_errors: Vec<BindError>,
) {
    let d = Discovery {
        status: "ready".to_string(),
        port,
        pid,
        version: version.to_string(),
        token: token.map(|t| t.to_string()),
        hosts: hosts.to_vec(),
        bind_errors,
    };
    match serde_json::to_string(&d) {
        Ok(line) => println!("{line}"),
        // Fall back to the minimal hand-built line rather than printing nothing —
        // a caller with no discovery line at all cannot proceed.
        Err(e) => {
            log::error!("failed to serialize discovery: {e}");
            let out_token = token.map(|t| format!(", \"token\": \"{t}\"")).unwrap_or_default();
            println!(
                "{{\"status\": \"ready\", \"port\": {port}, \"pid\": {pid}, \"version\": \"{version}\"{out_token}}}"
            );
        }
    }
    let _ = std::io::stdout().flush();
}

#[cfg(test)]
mod tests {
    use super::is_newer;

    #[test]
    fn version_ordering() {
        assert!(is_newer("0.2.0", "0.1.9"));
        assert!(is_newer("0.1.10", "0.1.9"));
        assert!(is_newer("1.0.0", "0.9.9"));
        assert!(!is_newer("0.1.9", "0.1.9")); // equal is not newer
        assert!(!is_newer("0.1.8", "0.1.9"));
    }

    #[test]
    fn suffixes_are_ignored() {
        // Pre-release / build metadata is stripped: same numeric tuple → not newer.
        assert!(!is_newer("0.1.9-rc1", "0.1.9"));
        assert!(!is_newer("0.1.9+build5", "0.1.9"));
    }
}

#[cfg(test)]
mod discovery_version_tests {
    use super::*;

    fn sample(version: &str) -> Discovery {
        Discovery {
            status: "ready".to_string(),
            port: 5689,
            pid: 42,
            version: version.to_string(),
            token: Some("deadbeef".to_string()),
            hosts: vec!["127.0.0.1".to_string()],
            bind_errors: Vec::new(),
        }
    }

    /// The whole point of the field: a client reading the line can tell what it is talking to
    /// without connecting first.
    #[test]
    fn version_is_serialized() {
        let line = serde_json::to_string(&sample("0.1.11")).unwrap();
        assert!(line.contains(r#""version":"0.1.11""#), "missing version in {line}");
    }

    /// A discovery line from a proxy that predates the field must still parse. Those exist in
    /// the wild the moment anyone runs an older self-installed agent, which is exactly the
    /// configuration this field was added to diagnose — failing to parse would replace a clear
    /// version error with an opaque one.
    #[test]
    fn line_without_version_still_parses() {
        let old = r#"{"status":"ready","port":5689,"pid":42,"token":"deadbeef","hosts":["127.0.0.1"]}"#;
        let d: Discovery = serde_json::from_str(old).expect("must tolerate a missing version");
        assert_eq!(d.version, "");
        assert_eq!(d.port, 5689);
    }

    #[test]
    fn round_trips() {
        let line = serde_json::to_string(&sample("1.2.3")).unwrap();
        let back: Discovery = serde_json::from_str(&line).unwrap();
        assert_eq!(back.version, "1.2.3");
        assert_eq!(back.token.as_deref(), Some("deadbeef"));
    }
}

#[cfg(test)]
mod endpoint_bind_host_tests {
    use super::*;

    /// A record written before `bind_host` existed must still parse. Those proxies bound
    /// loopback, and loopback is also the safe default: it under-promises reachability, so
    /// a client widens rather than silently failing to connect.
    #[test]
    fn v1_record_without_bind_host_defaults_to_loopback() {
        let v1 = r#"{"v":1,"instance":"default","pid":42,"version":"0.1.9",
                     "port":5000,"token":"t","state":"active","started_at_unix":1}"#;
        let ep: Endpoint = serde_json::from_str(v1).expect("v1 record must still parse");
        assert_eq!(ep.bind_host, "127.0.0.1");
        assert_eq!(ep.port, 5000);
    }

    #[test]
    fn bind_host_round_trips() {
        for host in ["127.0.0.1", "0.0.0.0", "172.24.80.1"] {
            let ep = Endpoint {
                v: 3,
                instance: "default".to_string(),
                pid: 1,
                version: "0.1.9".to_string(),
                port: 5000,
                bind_host: host.to_string(),
                hosts: vec!["127.0.0.1".to_string(), host.to_string()],
                token: "t".to_string(),
                state: "active".to_string(),
                started_at_unix: 1,
                exe: Default::default(),
            };
            let text = serde_json::to_string(&ep).unwrap();
            let back: Endpoint = serde_json::from_str(&text).unwrap();
            assert_eq!(back.bind_host, host);
            assert!(back.hosts.contains(&host.to_string()));
        }
    }

    /// A wildcard bind is reachable off-loopback; a loopback bind is not. This is the
    /// question a client actually needs discovery to answer.
    #[test]
    fn loopback_bind_is_distinguishable_from_wildcard() {
        let loopback: Endpoint = serde_json::from_str(
            r#"{"v":2,"instance":"d","pid":1,"version":"0.1.9","port":1,
                "bind_host":"127.0.0.1","token":"t","state":"active","started_at_unix":1}"#,
        )
        .unwrap();
        let wildcard: Endpoint = serde_json::from_str(
            r#"{"v":2,"instance":"d","pid":1,"version":"0.1.9","port":1,
                "bind_host":"0.0.0.0","token":"t","state":"active","started_at_unix":1}"#,
        )
        .unwrap();
        assert_eq!(loopback.bind_host, "127.0.0.1");
        assert_ne!(wildcard.bind_host, loopback.bind_host);
    }
}

/// The same-version handover rule, which is the one that fires most often in practice:
/// a test build carried to several machines and reinstalled over itself, or a dev
/// rebuild, leaves a daemon whose version is identical and whose code is stale.
#[cfg(test)]
mod handover_tests {
    use super::*;

    fn stamp(path: &str, mtime_ms: Option<u64>) -> ExeStamp {
        ExeStamp {
            path: path.to_string(),
            mtime_ms,
        }
    }

    /// Unchanged behaviour: version still decides whenever the versions differ, and it
    /// outranks the file dates in both directions.
    #[test]
    fn version_still_decides_when_versions_differ() {
        let old = stamp("/x/mdbg", Some(1_000));
        let new = stamp("/x/mdbg", Some(2_000));
        assert_eq!(
            decide_handover("0.1.17", &new, "0.1.16", &old, true),
            Handover::UpgradeByVersion
        );
        // Downgrade guard: rebuilding an old checkout yields a NEW file with OLD code,
        // and must not evict the newer running proxy.
        assert_eq!(decide_handover("0.1.15", &new, "0.1.16", &old, true), Handover::Reuse);
    }

    #[test]
    fn same_version_newer_file_at_same_path_supersedes() {
        let running = stamp("/ext/mcu-debug-proxy-0.1.16/bin/mdbg", Some(1_000));
        let reinstalled = stamp("/ext/mcu-debug-proxy-0.1.16/bin/mdbg", Some(2_000));
        assert_eq!(
            decide_handover("0.1.16", &reinstalled, "0.1.16", &running, true),
            Handover::UpgradeByExe
        );
    }

    /// The ordinary case a second window hits: same binary, nothing to do. Getting this
    /// wrong would turn every window open into a daemon churn.
    #[test]
    fn same_version_same_file_reuses() {
        let e = stamp("/x/mdbg", Some(1_000));
        assert_eq!(decide_handover("0.1.16", &e, "0.1.16", &e, true), Handover::Reuse);
    }

    #[test]
    fn older_file_never_supersedes() {
        let running = stamp("/x/mdbg", Some(2_000));
        let mine = stamp("/x/mdbg", Some(1_000));
        assert_eq!(
            decide_handover("0.1.16", &mine, "0.1.16", &running, true),
            Handover::Reuse
        );
    }

    /// Two different installs of the same version: the mtimes describe different files
    /// and comparing them is meaningless, so neither is "newer".
    #[test]
    fn different_paths_are_not_comparable() {
        let running = stamp("/opt/mdbg", Some(1_000));
        let mine = stamp("/home/me/build/mdbg", Some(2_000));
        assert_eq!(
            decide_handover("0.1.16", &mine, "0.1.16", &running, true),
            Handover::Reuse
        );
    }

    /// A daemon predating the stamp (neither path nor mtime) is superseded once, so the
    /// feature works on the first install rather than the second. Its successor records a
    /// stamp, which is what keeps this from firing on every subsequent launch.
    #[test]
    fn a_daemon_with_no_stamp_is_superseded_once() {
        let pre_feature = ExeStamp::default();
        let mine = stamp("/x/mdbg", Some(2_000));
        assert_eq!(
            decide_handover("0.1.16", &mine, "0.1.16", &pre_feature, true),
            Handover::UpgradeByExe
        );
        // ...and once it has a stamp of its own, an identical launch reuses it.
        let successor = stamp("/x/mdbg", Some(2_000));
        assert_eq!(
            decide_handover("0.1.16", &mine, "0.1.16", &successor, true),
            Handover::Reuse
        );
    }

    /// A known path with no mtime means that daemon tried to stat itself and failed.
    /// Treating that as "old" would hand over on *every* launch, so it reuses — the one
    /// case where absent evidence must not be read as absent-therefore-old.
    #[test]
    fn a_failed_stat_on_the_running_side_does_not_loop() {
        let cannot_stat = stamp("/x/mdbg", None);
        let mine = stamp("/x/mdbg", Some(2_000));
        assert_eq!(
            decide_handover("0.1.16", &mine, "0.1.16", &cannot_stat, true),
            Handover::Reuse
        );
    }

    /// No mtime of our own is no evidence, and the burden is on the challenger.
    #[test]
    fn a_challenger_that_cannot_stat_itself_reuses() {
        let running = stamp("/x/mdbg", Some(1_000));
        let mine = stamp("/x/mdbg", None);
        assert_eq!(
            decide_handover("0.1.16", &mine, "0.1.16", &running, true),
            Handover::Reuse
        );
    }

    /// `MDBG_PROXY_AUTO_UPGRADE=0` suppresses the exe rule only — a genuine version
    /// upgrade still happens, because that was never opt-in.
    #[test]
    fn opting_out_suppresses_only_the_exe_rule() {
        let running = stamp("/x/mdbg", Some(1_000));
        let mine = stamp("/x/mdbg", Some(2_000));
        assert_eq!(
            decide_handover("0.1.16", &mine, "0.1.16", &running, false),
            Handover::Reuse
        );
        assert_eq!(
            decide_handover("0.1.17", &mine, "0.1.16", &running, false),
            Handover::UpgradeByVersion
        );
    }

    /// An endpoint.json written before `exe` existed must still parse, or an upgrade
    /// would fail at the worst possible moment: against the very daemon it must replace.
    #[test]
    fn an_endpoint_record_without_an_exe_field_still_parses() {
        let json = r#"{
            "v": 3, "instance": "default", "pid": 42, "version": "0.1.15",
            "port": 51234, "bind_host": "127.0.0.1", "hosts": ["127.0.0.1"],
            "token": "abc", "state": "active", "started_at_unix": 1
        }"#;
        let ep: Endpoint = serde_json::from_str(json).expect("a pre-exe record must parse");
        assert_eq!(ep.exe, ExeStamp::default());
        assert_eq!(
            decide_handover("0.1.15", &stamp("/x/mdbg", Some(9)), &ep.version, &ep.exe, true),
            Handover::UpgradeByExe
        );
    }

    /// The published stamp is what the next launch compares against, so it has to
    /// survive a round trip through the file — and stay a plain JSON number a
    /// JavaScript reader can hold exactly (milliseconds, not nanoseconds).
    #[test]
    fn the_stamp_round_trips_as_an_exact_json_number() {
        let e = stamp("/x/mdbg", Some(1_757_700_093_000));
        let json = serde_json::to_string(&e).expect("serialize");
        assert!(json.contains("1757700093000"), "no exponent or rounding: {json}");
        assert_eq!(serde_json::from_str::<ExeStamp>(&json).expect("deserialize"), e);
        assert!(
            (1_757_700_093_000f64 as u64) == 1_757_700_093_000,
            "milliseconds stay exact as a double; nanoseconds would not"
        );
    }

    /// Stamping ourselves must work in the test binary too — if `current_exe()` or the
    /// stat fails everywhere, the whole mechanism silently degrades to Reuse.
    #[test]
    fn stamping_our_own_executable_yields_a_path_and_an_mtime() {
        let e = exe_stamp();
        assert!(!e.path.is_empty(), "current_exe() should resolve");
        assert!(e.mtime_ms.is_some(), "the test binary should be stat-able");
    }
}

/// What `--status` reports about the executable, which is the operator-facing half of
/// the handover rule: it answers "is this daemon serving code that is still on disk?"
#[cfg(test)]
mod exe_status_tests {
    use super::*;

    #[test]
    fn epoch_ms_is_plain_unix_time_and_formats() {
        // Unix epoch milliseconds, so any consumer can do this itself.
        let formatted = format_epoch_ms(Some(0));
        assert!(
            formatted.starts_with("1969-12-31") || formatted.starts_with("1970-01-01"),
            "epoch 0 renders as the epoch in some timezone, got {formatted}"
        );
        assert_eq!(format_epoch_ms(None), "", "unknown renders empty, never as 1970");
    }

    #[test]
    fn an_untouched_binary_does_not_read_as_replaced() {
        let me = exe_stamp();
        let status = ExeStatus::describe(&me);
        assert_eq!(status.path, me.path);
        assert_eq!(status.started_with_mtime_ms, me.mtime_ms);
        assert_eq!(status.on_disk_mtime_ms, me.mtime_ms, "nothing replaced it mid-test");
        assert!(!status.replaced_since_start);
        assert!(!status.started_with_mtime.is_empty(), "a known mtime must render");
    }

    #[test]
    fn a_replaced_binary_reads_as_replaced() {
        let dir = std::env::temp_dir().join(format!("mdbg-exe-status-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("mkdir");
        let file = dir.join("mdbg");
        std::fs::write(&file, b"v1").expect("write");
        let started = ExeStamp {
            path: file.to_string_lossy().into_owned(),
            mtime_ms: Some(1_000),
        };
        let status = ExeStatus::describe(&started);
        assert!(
            status.replaced_since_start,
            "the file on disk has a real mtime, not the 1000 we claim to have started with"
        );
        assert!(status.on_disk_mtime_ms.unwrap() > 1_000);
        assert!(!status.on_disk_mtime.is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Absent evidence must not be reported as "replaced" — an unknown mtime or a path we
    /// cannot stat is a gap in the report, not a finding.
    #[test]
    fn unknown_mtimes_never_claim_a_replacement() {
        let no_path = ExeStamp::default();
        assert!(!ExeStatus::describe(&no_path).replaced_since_start);

        let missing_file = ExeStamp {
            path: "/nonexistent/mdbg".to_string(),
            mtime_ms: Some(1_000),
        };
        let s = ExeStatus::describe(&missing_file);
        assert_eq!(s.on_disk_mtime_ms, None);
        assert!(!s.replaced_since_start, "could not stat is not the same as replaced");
    }

    /// A status reply from a proxy that predates the field must still parse, because that
    /// is precisely what a mid-handover query hits.
    #[test]
    fn a_status_reply_without_an_exe_field_still_parses() {
        let json = r#"{
            "pid": 1, "version": "0.1.15", "port": 1, "instance": "default",
            "state": "active", "active_refs": 0, "uptime_secs": 5
        }"#;
        let info: crate::proxy_helper::admin::StatusInfo =
            serde_json::from_str(json).expect("a pre-exe status reply must parse");
        assert_eq!(info.exe, ExeStatus::default());
        assert!(!info.exe.replaced_since_start);
    }
}

/// Pins `await_holder` against the two windows in which a held lock and a usable record
/// disagree. Each test holds the instance lock from a second thread through its own open
/// file description. `fd-lock` uses `flock` on Unix, which contends across descriptions even
/// within one process — and every test asserts that before trusting its result, so a
/// platform where it did not would fail loudly rather than pass vacuously.
#[cfg(test)]
mod holder_tests {
    use super::*;
    use std::path::Path;
    use std::sync::mpsc;
    use std::thread;

    fn open_lock(path: &Path) -> fd_lock::RwLock<std::fs::File> {
        fd_lock::RwLock::new(
            std::fs::OpenOptions::new()
                .create(true)
                .read(true)
                .write(true)
                .truncate(false)
                .open(path)
                .expect("open lock file"),
        )
    }

    fn record(pid: u32, state: &str) -> Endpoint {
        Endpoint {
            v: 3,
            instance: "test".into(),
            pid,
            version: "0.1.16".into(),
            port: 5000,
            bind_host: "127.0.0.1".into(),
            hosts: vec!["127.0.0.1".into()],
            token: "t".into(),
            state: state.into(),
            started_at_unix: 1,
            exe: ExeStamp::default(),
        }
    }

    struct Dirs {
        _tmp: tempfile::TempDir,
        lock: PathBuf,
        endpoint: PathBuf,
    }

    fn dirs() -> Dirs {
        let tmp = tempfile::tempdir().expect("tempdir");
        Dirs {
            lock: tmp.path().join("proxy.lock"),
            endpoint: tmp.path().join("endpoint.json"),
            _tmp: tmp,
        }
    }

    /// Hold the instance lock on another thread for exactly as long as `script` runs.
    fn while_holding(lock_path: &Path, script: impl FnOnce() + Send + 'static) -> thread::JoinHandle<()> {
        let lock_path = lock_path.to_path_buf();
        let (held_tx, held_rx) = mpsc::channel();
        let handle = thread::spawn(move || {
            let mut lock = open_lock(&lock_path);
            let _guard = lock.write().expect("holder takes the lock");
            held_tx.send(()).expect("signal held");
            script();
        });
        held_rx.recv().expect("holder took the lock");
        handle
    }

    /// Our own view of the lock, after proving it really is blocked by the holder.
    fn contender(lock_path: &Path) -> fd_lock::RwLock<std::fs::File> {
        let mut mine = open_lock(lock_path);
        assert!(
            mine.try_write().is_err(),
            "the holder's lock must block a second description in this process, or these tests prove nothing"
        );
        mine
    }

    #[test]
    fn an_active_record_is_used_while_the_lock_is_held() {
        let d = dirs();
        write_endpoint_atomic(&d.endpoint, &record(111, STATE_ACTIVE)).unwrap();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let holder = while_holding(&d.lock, move || {
            let _ = release_rx.recv();
        });
        let mut mine = contender(&d.lock);
        match await_holder(&mut mine, &d.endpoint, Duration::from_secs(5)).unwrap() {
            Holder::Active(ep) => assert_eq!(ep.pid, 111),
            other => panic!("expected the live owner, got {other:?}"),
        }
        release_tx.send(()).unwrap();
        holder.join().unwrap();
    }

    /// A record marked draining is never handed out, however long it stays on disk; the launch
    /// waits for the lock instead, and learns which proxy it was waiting on.
    #[test]
    fn a_draining_record_is_waited_out_until_the_lock_frees() {
        let d = dirs();
        write_endpoint_atomic(&d.endpoint, &record(222, STATE_DRAINING)).unwrap();
        let holder = while_holding(&d.lock, || thread::sleep(Duration::from_millis(400)));
        let mut mine = contender(&d.lock);
        let started = Instant::now();
        match await_holder(&mut mine, &d.endpoint, Duration::from_secs(5)).unwrap() {
            Holder::Leaving { pid } => assert_eq!(pid, Some(222), "the departing proxy is named"),
            other => panic!("a draining record must not be handed out, got {other:?}"),
        }
        assert!(
            started.elapsed() >= Duration::from_millis(300),
            "returned before the lock was released"
        );
        holder.join().unwrap();
    }

    /// The shutdown gap: the record is already removed while the lock is still held. The old
    /// retry read spent its budget on a file nobody would ever write, then failed the launch.
    #[test]
    fn a_removed_record_with_the_lock_still_held_waits_for_the_lock() {
        let d = dirs(); // no endpoint.json at all
        let holder = while_holding(&d.lock, || thread::sleep(Duration::from_millis(400)));
        let mut mine = contender(&d.lock);
        let started = Instant::now();
        match await_holder(&mut mine, &d.endpoint, Duration::from_secs(5)).unwrap() {
            Holder::Leaving { pid } => assert_eq!(pid, None),
            other => panic!("expected to take over once the lock freed, got {other:?}"),
        }
        assert!(
            started.elapsed() >= Duration::from_millis(300),
            "returned before the lock was released"
        );
        holder.join().unwrap();
    }

    /// The startup gap, which the old retry read existed for: the lock is taken before the record
    /// is published. Wait for the record rather than treating the owner as gone.
    #[test]
    fn a_starting_proxy_is_waited_for_until_it_publishes() {
        let d = dirs();
        let endpoint = d.endpoint.clone();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let holder = while_holding(&d.lock, move || {
            thread::sleep(Duration::from_millis(300));
            write_endpoint_atomic(&endpoint, &record(333, STATE_ACTIVE)).unwrap();
            let _ = release_rx.recv();
        });
        let mut mine = contender(&d.lock);
        match await_holder(&mut mine, &d.endpoint, Duration::from_secs(5)).unwrap() {
            Holder::Active(ep) => assert_eq!(ep.pid, 333),
            other => panic!("expected the proxy once it published, got {other:?}"),
        }
        release_tx.send(()).unwrap();
        holder.join().unwrap();
    }

    /// A draining proxy that never lets go — which an older binary still running would do —
    /// fails with its pid named, rather than hanging or being handed out.
    #[test]
    fn a_draining_holder_that_never_leaves_times_out_naming_its_pid() {
        let d = dirs();
        write_endpoint_atomic(&d.endpoint, &record(444, STATE_DRAINING)).unwrap();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let holder = while_holding(&d.lock, move || {
            let _ = release_rx.recv();
        });
        let mut mine = contender(&d.lock);
        let err = await_holder(&mut mine, &d.endpoint, Duration::from_millis(300)).expect_err("must time out");
        let msg = format!("{err:#}");
        assert!(msg.contains("444"), "the message names the pid to act on: {msg}");
        release_tx.send(()).unwrap();
        holder.join().unwrap();
    }
}
