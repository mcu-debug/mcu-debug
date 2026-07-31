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
        if name.is_empty()
            || name.contains(['/', '\\'])
            || name == ".."
            || name == "."
        {
            bail!("invalid proxy instance name: {name:?}");
        }
        // Base is `~/.mcu-debug/proxy` by default; `MDBG_PROXY_STATE_DIR`
        // overrides it (containers where $HOME isn't writable, tests, custom
        // deployments).
        let base = match std::env::var_os("MDBG_PROXY_STATE_DIR") {
            Some(p) => PathBuf::from(p),
            None => dirs::home_dir()
                .context("could not determine the home directory")?
                .join(".mcu-debug")
                .join("proxy"),
        };
        let dir = base.join(name);
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

/// The discovery anchor written by the proxy that owns the lock.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Endpoint {
    /// Schema version.
    pub v: u32,
    pub instance: String,
    pub pid: u32,
    /// semver of the running proxy binary (`CARGO_PKG_VERSION`).
    pub version: String,
    /// Loopback port the funnel/control listener is bound to.
    pub port: u16,
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

/// This proxy's own version. Normally `CARGO_PKG_VERSION`; `MDBG_PROXY_VERSION`
/// overrides it (for exercising the upgrade/handover path, or forcing behavior).
pub fn self_version() -> String {
    std::env::var("MDBG_PROXY_VERSION").unwrap_or_else(|_| env!("CARGO_PKG_VERSION").to_string())
}

/// Read and parse `endpoint.json`.
pub fn read_endpoint(path: &std::path::Path) -> Result<Endpoint> {
    let bytes = std::fs::read(path)
        .with_context(|| format!("could not read {}", path.display()))?;
    serde_json::from_slice(&bytes)
        .with_context(|| format!("could not parse {}", path.display()))
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
    std::fs::write(&tmp, &json)
        .with_context(|| format!("could not write {}", tmp.display()))?;
    std::fs::rename(&tmp, path)
        .with_context(|| format!("could not rename {} -> {}", tmp.display(), path.display()))?;
    Ok(())
}

/// Print the discovery JSON the launcher parses from stdout. Identical shape
/// whether we started a fresh proxy or are reusing an existing one, so the
/// caller does not care which happened.
///
/// `{"status": "ready", "port": <port>, "pid": <pid>[, "token": "<token>"]}`
pub fn print_discovery(port: u16, pid: u32, token: Option<&str>) {
    let out_token = token
        .map(|t| format!(", \"token\": \"{t}\""))
        .unwrap_or_default();
    println!("{{\"status\": \"ready\", \"port\": {port}, \"pid\": {pid}{out_token}}}");
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
