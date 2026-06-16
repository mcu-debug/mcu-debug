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
use clap::Args;
use std::{io::IsTerminal, path::PathBuf};

use super::{spawn, transport, tui};

const MIN_NODE_MAJOR: u32 = 22; // Node v22+ is required for stable features we rely on (e.g. stable fetch API)

pub fn get_node_program() -> String {
    match std::env::var("MCU_DEBUG_NODE") {
        Ok(val) => {
            let path = PathBuf::from(val);
            match path.canonicalize() {
                Ok(canonical_path) if canonical_path.exists() => {
                    canonical_path.to_string_lossy().to_string()
                }
                _ => "node".to_string(), // Fallback to "node" if the provided path is invalid
            }
        }
        Err(_) => "node".to_string(), // Default to "node" if the environment variable is not set
    }
}

/// Check that `node` is on PATH and is at least v`MIN_NODE_MAJOR`.
fn check_node_version() -> Result<()> {
    let node_program = get_node_program();
    let output = std::process::Command::new(node_program)
        .arg("--version")
        .output()
        .with_context(|| format!("node is not installed or not on PATH — install Node.js v{MIN_NODE_MAJOR}+ from https://nodejs.org"))?;

    // `node --version` prints "v20.11.0\n"
    let raw = String::from_utf8_lossy(&output.stdout);
    let version_str = raw.trim().trim_start_matches('v');

    let major: u32 = version_str
        .split('.')
        .next()
        .and_then(|s| s.parse().ok())
        .context(format!(
            "could not parse Node version from {:?}",
            raw.trim()
        ))?;

    if major < MIN_NODE_MAJOR {
        anyhow::bail!(
            "Node.js v{major} is too old — mcu-debug requires v{MIN_NODE_MAJOR} or newer \
             (found {raw_trimmed})",
            raw_trimmed = raw.trim(),
        );
    }

    Ok(())
}

#[derive(Args, Debug)]
pub struct DebugArgs {
    /// Debug configuration to use.  Accepts a config name from launch.json, a
    /// zero-based index into the configurations array, or a glob pattern that
    /// matches exactly one configuration name.
    #[arg(short = 'c', long = "config")]
    pub config: Option<String>,

    /// Path to the launch.json file.
    #[arg(short = 'j', long = "json", default_value = ".vscode/launch.json")]
    pub json: String,

    /// Path to a custom settings JSON file.
    #[arg(
        short = 's',
        long = "settings",
        default_value = "mcu-debug-settings.json"
    )]
    pub settings: String,

    /// Log file path.  When omitted, logs are written to $CWD/.mcu-debug/cli.log.
    #[arg(short = 'l', long = "log-file")]
    pub log_file: Option<String>,

    /// Enable debug mode — more verbose logging.
    #[arg(short = 'd', long = "debug")]
    pub debug: bool,

    /// Wait for a DAP client to connect before starting the debug session.
    #[arg(long = "wait-for-client")]
    pub wait_for_client: bool,

    /// Dump the configuration and exit.
    #[arg(long = "dump-config")]
    pub dump_config: bool,

    /// Skip the TUI and stream the mux output directly to stdout.
    ///
    /// Use this flag when launching from an AI agent or CI pipeline that
    /// reads the tagged mux stream directly from stdout.
    #[arg(long)]
    pub no_tui: bool,
}

pub fn run(args: DebugArgs) -> Result<()> {
    check_node_version()?;

    let cli_js = spawn::find_node_cli()
        .context("cannot locate mcu-debug-cli.js — build the Node package first (`npm run build` in packages/mcu-debug)")?;

    // Auto-detect headless mode: if stdout is not a TTY (piped, redirected,
    // or spawned by an AI agent) we behave as --no-tui automatically.
    // The flag remains useful as an explicit override when stdout IS a TTY.
    let headless = args.no_tui || !std::io::stdout().is_terminal();

    // Build the args to forward to the Node CLI from the parsed Rust fields.
    let mut node_args: Vec<String> = Vec::new();
    if let Some(ref config) = args.config {
        node_args.extend_from_slice(&["--config".to_string(), config.clone()]);
    }
    node_args.extend_from_slice(&["--json".to_string(), args.json.clone()]);
    node_args.extend_from_slice(&["--settings".to_string(), args.settings.clone()]);
    if let Some(ref log_file) = args.log_file {
        node_args.extend_from_slice(&["--log-file".to_string(), log_file.clone()]);
    }
    if args.debug {
        node_args.push("--debug".to_string());
    }
    if args.wait_for_client {
        node_args.push("--wait-for-client".to_string());
    }
    if args.dump_config {
        node_args.push("--dump-config".to_string());
    }

    if headless {
        // Headless mode: Node inherits our stdio. The mux stream goes directly
        // to stdout for the AI or CI caller. We just wait for Node to finish.
        let mut child = spawn::spawn_node_cli_headless(&cli_js, &node_args)?;
        let status = child.wait()?;
        if !status.success() {
            anyhow::bail!("mcu-debug-cli.js exited with {status}");
        }
        return Ok(());
    }

    // TUI mode: spawn Node (it will create .mcu-debug/socket.json when ready),
    // wait for the socket file, connect, then hand off to the ratatui TUI.
    let mut child = spawn::spawn_node_cli_tui(&cli_js, &node_args)?;
    let stdin = child.stdin.take().expect("Failed to open stdin");
    let stdout = child.stdout.take().expect("Failed to open stdout");
    let stderr = child.stderr.take().expect("Failed to open stderr");

    // Future `mcu-debug attach` path: connect via Unix socket instead of stdio.
    //   let sock_info = sock_file::wait_for_sock_file(SOCK_TIMEOUT)
    //       .context("node CLI did not create a socket file in time")?;
    //   let (reader, writer) = transport::connect(&sock_info)?;

    let (out_reader, err_reader, writer) = transport::from_child_stdio(stdout, stderr, stdin);
    tui::run_tui(out_reader, err_reader, writer)?;

    // TUI exited — give Node a moment to shut down gracefully, then kill it.
    // TODO: send a graceful shutdown command over the socket before closing
    //       (e.g. a `!!QUIT` meta-command once the protocol is defined).
    let _ = child.kill();
    let _ = child.wait();

    Ok(())
}
