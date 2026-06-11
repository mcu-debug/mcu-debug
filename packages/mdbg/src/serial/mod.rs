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

pub mod bridge;
pub mod cmd;
pub mod port;
pub mod ring;

#[cfg(target_os = "linux")]
pub mod enumerate_linux;
#[cfg(target_os = "macos")]
pub mod enumerate_macos;
#[cfg(target_os = "windows")]
pub mod enumerate_windows;

/// Uniform representation of an available serial port returned by all
/// platform-specific enumerators. `description` is informational only —
/// never used as an identity key. Port paths are the stable key.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "serial-helper/")]
pub struct AvailablePort {
    pub path: String,
    pub description: String,
    pub vid: Option<u16>,
    pub pid: Option<u16>,
    pub serial: Option<String>,
}

/// Resolve a port selector to a concrete device path.
///
/// Priority for matching: `serial` → `vid`/`pid` → `path` glob → `desc`
/// substring. A plain (non-glob) `path` with no other filters is returned
/// immediately without enumerating hardware. Returns an error if nothing
/// matches or if the selector is ambiguous (multiple ports matched).
///
/// `desc` is matched case-insensitively as a substring of the port description.
/// `filter_callout` — when `true`, macOS `/dev/tty.*` callout variants are
/// excluded from enumeration (see [`list_available`]). Has no effect on other
/// platforms, or when an exact (non-glob) `path` is supplied.
pub fn resolve_port(
    path: Option<&str>,
    serial: Option<&str>,
    vid: Option<&str>,
    pid: Option<&str>,
    desc: Option<&str>,
    filter_callout: bool,
) -> anyhow::Result<String> {
    fn is_glob(s: &str) -> bool {
        s.contains('*') || s.contains('?') || s.contains('[')
    }
    fn parse_u16(s: &str) -> Option<u16> {
        let s = s.trim();
        if let Some(hex) = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
            u16::from_str_radix(hex, 16).ok()
        } else {
            s.parse().ok()
        }
    }

    // Fast path: plain path with no additional filters — skip enumeration entirely.
    if let Some(p) = path {
        if !is_glob(p) && serial.is_none() && vid.is_none() && pid.is_none() && desc.is_none() {
            return Ok(p.to_string());
        }
    }

    if path.is_none() && serial.is_none() && vid.is_none() && pid.is_none() && desc.is_none() {
        anyhow::bail!("no port selector specified — provide path, serial, vid/pid, or --match");
    }

    let want_vid = vid.and_then(parse_u16);
    let want_pid = pid.and_then(parse_u16);
    let path_re: Option<regex::Regex> = path.filter(|p| is_glob(p)).map(|p| {
        let mut re = String::from("^");
        for c in p.chars() {
            match c {
                '*' => re.push_str(".*"),
                '?' => re.push('.'),
                c if r".+()[]{}^$|\".contains(c) => {
                    re.push('\\');
                    re.push(c);
                }
                c => re.push(c),
            }
        }
        re.push('$');
        regex::Regex::new(&re).expect("valid glob-derived regex")
    });

    let ports = list_available(filter_callout);
    let matched: Vec<&AvailablePort> = ports
        .iter()
        .filter(|p| {
            if let Some(s) = serial {
                if p.serial.as_deref() != Some(s) {
                    return false;
                }
            }
            if let Some(v) = want_vid {
                if p.vid != Some(v) {
                    return false;
                }
            }
            if let Some(pid_val) = want_pid {
                if p.pid != Some(pid_val) {
                    return false;
                }
            }
            if let Some(re) = &path_re {
                if !re.is_match(&p.path) {
                    return false;
                }
            } else if let Some(plain) = path {
                if !is_glob(plain) && p.path.to_lowercase() != plain.to_lowercase() {
                    return false;
                }
            }
            if let Some(d) = desc {
                if !p.description.to_lowercase().contains(&d.to_lowercase()) {
                    return false;
                }
            }
            true
        })
        .collect();

    match matched.len() {
        0 => anyhow::bail!(
            "no serial port matched selector (path={:?} serial={:?} vid={:?} pid={:?} match={:?})",
            path,
            serial,
            vid,
            pid,
            desc
        ),
        1 => Ok(matched[0].path.clone()),
        n => anyhow::bail!(
            "{n} serial ports matched selector — be more specific: {}",
            matched
                .iter()
                .map(|p| p.path.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        ),
    }
}

/// List available serial ports on the current platform.
///
/// When `filter_callout` is `true`, macOS `/dev/tty.*` callout variants are
/// excluded — each USB-serial device appears as both `/dev/cu.*` (call-up,
/// opens without waiting for carrier-detect) and `/dev/tty.*` (blocks until
/// carrier-detect). For outgoing connections to microcontrollers the `cu`
/// variant is always correct. On Linux and Windows `filter_callout` is ignored.
pub fn list_available(filter_callout: bool) -> Vec<AvailablePort> {
    let ports = list_all();
    if filter_callout && cfg!(target_os = "macos") {
        ports.into_iter().filter(|p| !p.path.starts_with("/dev/tty.")).collect()
    } else {
        ports
    }
}

fn list_all() -> Vec<AvailablePort> {
    #[cfg(target_os = "linux")]
    { enumerate_linux::list() }
    #[cfg(target_os = "windows")]
    { enumerate_windows::list() }
    #[cfg(target_os = "macos")]
    { enumerate_macos::list() }
    #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
    { Vec::new() }
}
