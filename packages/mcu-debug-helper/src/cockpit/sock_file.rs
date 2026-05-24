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

use anyhow::Result;
use serde::Deserialize;
use std::time::{Duration, Instant};

pub const SOCK_FILE: &str = ".mcu-debug.sock.json";
const POLL_INTERVAL: Duration = Duration::from_millis(100);

/// Contents of `.mcu-debug.sock.json` written by the Node CLI when it is ready.
#[allow(dead_code)] // config/started are informational; used once session display is wired up
///
/// ```json
/// {
///   "pid": 12345,
///   "socket": "/var/folders/.../mcu-debug-12345.sock",  // Unix
///   "pipe": "\\\\.\\pipe\\mcu-debug-12345",             // Windows (mutually exclusive)
///   "config": "Launch PSoC6 CM4",
///   "started": "2026-05-23T11:00:00Z"
/// }
/// ```
#[derive(Deserialize, Debug, Clone)]
pub struct SockInfo {
    pub pid: u32,
    /// Unix domain socket path (present on Linux/macOS).
    pub socket: Option<String>,
    /// Windows named pipe path (present on Windows).
    pub pipe: Option<String>,
    pub config: Option<String>,
    pub started: Option<String>,
}

/// Poll the current directory for `.mcu-debug.sock.json` until it appears and
/// is valid JSON, or until `timeout` elapses.
pub fn wait_for_sock_file(timeout: Duration) -> Result<SockInfo> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Ok(raw) = std::fs::read_to_string(SOCK_FILE) {
            if let Ok(info) = serde_json::from_str::<SockInfo>(&raw) {
                return Ok(info);
            }
        }
        if Instant::now() >= deadline {
            anyhow::bail!(
                "timed out after {:.1}s waiting for {SOCK_FILE}",
                timeout.as_secs_f32()
            );
        }
        std::thread::sleep(POLL_INTERVAL);
    }
}

impl SockInfo {
    pub fn display_addr(&self) -> String {
        if let Some(s) = &self.socket {
            return s.clone();
        }
        if let Some(p) = &self.pipe {
            return p.clone();
        }
        "<unknown>".into()
    }
}
