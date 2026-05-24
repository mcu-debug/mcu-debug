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
use std::io::IsTerminal;

use super::{spawn, transport, tui};

const MIN_NODE_MAJOR: u32 = 22; // Node v22+ is required for stable features we rely on (e.g. stable fetch API)

/// Check that `node` is on PATH and is at least v`MIN_NODE_MAJOR`.
fn check_node_version() -> Result<()> {
    let output = std::process::Command::new("node")
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
    /// Skip the TUI and stream the mux output directly to stdout.
    ///
    /// Use this flag when launching from an AI agent or CI pipeline that
    /// reads the tagged mux stream directly from stdout.
    #[arg(long)]
    pub no_tui: bool,

    /// Arguments forwarded verbatim to the Node CLI (e.g. `-- --config "Launch PSoC6"`).
    #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
    pub pass_through: Vec<String>,
}

pub fn run(args: DebugArgs) -> Result<()> {
    check_node_version()?;

    let cli_js = spawn::find_node_cli()
        .context("cannot locate mcu-debug-cli.js — build the Node package first (`npm run build` in packages/mcu-debug)")?;

    // Auto-detect headless mode: if stdout is not a TTY (piped, redirected,
    // or spawned by an AI agent) we behave as --no-tui automatically.
    // The flag remains useful as an explicit override when stdout IS a TTY.
    let headless = args.no_tui || !std::io::stdout().is_terminal();

    // Strip --no-tui from the forwarded args. With trailing_var_arg, if the
    // flag appears after any unknown argument it lands in pass_through instead
    // of being parsed as no_tui=true, and Node would error on an unknown flag.
    let node_args: Vec<String> = args
        .pass_through
        .into_iter()
        .filter(|a| a != "--no-tui")
        .collect();

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

    // TUI mode: spawn Node (it will create .mcu-debug.sock.json when ready),
    // wait for the socket file, connect, then hand off to the ratatui TUI.
    let mut child = spawn::spawn_node_cli_tui(&cli_js, &node_args)?;
    let stdin = child.stdin.take().expect("Failed to open stdin");
    let stdout = child.stdout.take().expect("Failed to open stdout");

    // Future `mcu-debug attach` path: connect via Unix socket instead of stdio.
    //   let sock_info = sock_file::wait_for_sock_file(SOCK_TIMEOUT)
    //       .context("node CLI did not create a socket file in time")?;
    //   let (reader, writer) = transport::connect(&sock_info)?;

    let (reader, writer) = transport::from_child_stdio(stdout, stdin);
    tui::run_tui(reader, writer)?;

    // TUI exited — give Node a moment to shut down gracefully, then kill it.
    // TODO: send a graceful shutdown command over the socket before closing
    //       (e.g. a `!!QUIT` meta-command once the protocol is defined).
    let _ = child.kill();
    let _ = child.wait();

    Ok(())
}
