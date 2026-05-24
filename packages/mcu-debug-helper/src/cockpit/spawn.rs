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

use anyhow::{Context, Result};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};

/// Locate the Node CLI JS file relative to the current executable.
///
/// Search order (first match wins):
/// 1. Debug build: `<exe_dir>/../../../packages/mcu-debug/dist/mcu-debug-cli.js`
///    (i.e. `target/debug/` → monorepo root → package)
/// 2. Release / installed: `<exe_dir>/../../dist/mcu-debug-cli.js`
pub fn find_node_cli() -> Option<PathBuf> {
    let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();

    let debug_path = exe_dir.join("../dist/mcu-debug-cli.js");
    if debug_path.exists() {
        return debug_path.canonicalize().ok();
    }

    let release_path = exe_dir.join("../../dist/mcu-debug-cli.js");
    if release_path.exists() {
        return release_path.canonicalize().ok();
    }

    None
}

/// Spawn the Node CLI process in TUI mode.
///
/// Node owns the debug session and will create `.mcu-debug.sock.json` in the
/// current directory when ready. The TUI reads the mux stream from that socket,
/// so Node's stdout is left null. stderr is inherited for visibility of errors.
pub fn spawn_node_cli_tui(cli_js: &PathBuf, extra_args: &[String]) -> Result<Child> {
    Command::new("node")
        .arg(cli_js)
        .args(extra_args)
        .stdin(Stdio::null())
        .stdout(Stdio::null()) // TUI reads from Unix socket, not stdout
        .stderr(Stdio::inherit())
        .spawn()
        .with_context(|| format!("failed to spawn node {}", cli_js.display()))
}

/// Spawn the Node CLI process in headless (no-TUI) mode.
///
/// Node's stdout is the mux stream; it is inherited so the caller (or an AI
/// agent reading our stdout) receives the tagged stream directly.
pub fn spawn_node_cli_headless(cli_js: &PathBuf, extra_args: &[String]) -> Result<Child> {
    Command::new("node")
        .arg(cli_js)
        .args(extra_args)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .with_context(|| format!("failed to spawn node {}", cli_js.display()))
}
