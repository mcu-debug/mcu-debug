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
use std::time::{Duration, SystemTime, UNIX_EPOCH};

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
        Err(e) => {
            return Err(e).with_context(|| format!("could not read proxy base {}", base.display()))
        }
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
    /// `"active"` or `"draining"` (draining arrives in Phase D).
    pub state: String,
    /// Unix seconds when the proxy started (for `--status` uptime later).
    pub started_at_unix: u64,
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
    let mut parts = v
        .split(['.', '-', '+'])
        .filter_map(|s| s.parse::<u64>().ok());
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

/// This proxy's own version. Normally `CARGO_PKG_VERSION`; `MDBG_PROXY_VERSION`
/// overrides it (for exercising the upgrade/handover path, or forcing behavior).
pub fn self_version() -> String {
    std::env::var("MDBG_PROXY_VERSION").unwrap_or_else(|_| env!("CARGO_PKG_VERSION").to_string())
}

/// Read and parse `endpoint.json`.
pub fn read_endpoint(path: &std::path::Path) -> Result<Endpoint> {
    let bytes =
        std::fs::read(path).with_context(|| format!("could not read {}", path.display()))?;
    serde_json::from_slice(&bytes).with_context(|| format!("could not parse {}", path.display()))
}

/// Read `endpoint.json`, retrying briefly.
///
/// Covers the startup race where the owner holds the lock but has not written
/// `endpoint.json` yet (it deletes any stale file on acquire, then writes a
/// fresh one after binding — see [`write_endpoint_atomic`]).
pub fn read_endpoint_retry(path: &std::path::Path) -> Result<Endpoint> {
    for _ in 0..40 {
        if let Ok(ep) = read_endpoint(path) {
            return Ok(ep);
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    read_endpoint(path) // final attempt surfaces the real error
}

/// Write `endpoint.json` atomically (temp file + rename) so a concurrent reader
/// never observes a half-written file.
pub fn write_endpoint_atomic(path: &std::path::Path, ep: &Endpoint) -> Result<()> {
    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_vec_pretty(ep)?;
    std::fs::write(&tmp, &json).with_context(|| format!("could not write {}", tmp.display()))?;
    std::fs::rename(&tmp, path)
        .with_context(|| format!("could not rename {} -> {}", tmp.display(), path.display()))?;
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

pub fn print_discovery(
    port: u16,
    pid: u32,
    token: Option<&str>,
    hosts: &[String],
    bind_errors: Vec<BindError>,
) {
    let d = Discovery {
        status: "ready".to_string(),
        port,
        pid,
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
            let out_token = token
                .map(|t| format!(", \"token\": \"{t}\""))
                .unwrap_or_default();
            println!("{{\"status\": \"ready\", \"port\": {port}, \"pid\": {pid}{out_token}}}");
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
