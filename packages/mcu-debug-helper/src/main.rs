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
use clap::{Parser, Subcommand};

use mdbg::cockpit::run::DebugArgs;
use mdbg::da_helper::run::DaHelperArgs;
use mdbg::proxy_helper::run::ProxyArgs;

#[derive(Parser, Debug)]
#[command(
    author,
    version,
    about = "MCU Debug Helper — ELF analysis, probe agent, and TUI"
)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand, Debug)]
enum Commands {
    /// Launch a debug CLI session with an optional ratatui TUI (Terminal UI).
    #[command(name = "debug")]
    Debug(DebugArgs),

    /// Debug Adapter helper: ELF parsing, disassembly, and symbol lookup
    #[command(name = "da-helper")]
    DaHelper(DaHelperArgs),

    /// Probe Agent: remote gdb-server orchestration via the Funnel Protocol
    #[command(name = "proxy")]
    Proxy(ProxyArgs),
}

// Maps executable names to their implicit subcommand.
// Copies/symlinks of the binary with these names skip the subcommand argument,
// giving each process a distinct p_comm visible in ps/killall/Activity Monitor.
//   mcu-debug-cli       -> debug
//   mcu-debug-da-helper -> da-helper
//   mcu-debug-proxy     -> proxy
fn implicit_subcommand(exe_stem: &str) -> Option<&'static str> {
    match exe_stem {
        "mcu-debug-cli" => Some("debug"),
        "mcu-debug-da-helper" => Some("da-helper"),
        "mcu-debug-proxy" => Some("proxy"),
        _ => None,
    }
}

fn main() -> Result<()> {
    // argv[0] basename (works for both copies and symlinks).
    let mut args: Vec<String> = std::env::args().collect();
    let exe_stem = std::path::Path::new(&args[0])
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("");

    if let Some(sub) = implicit_subcommand(exe_stem) {
        // Inject the subcommand only when not already supplied explicitly.
        let has_sub = args.get(1).map_or(false, |a| {
            matches!(a.as_str(), "debug" | "da-helper" | "proxy")
        });
        if !has_sub {
            args.insert(1, sub.to_string());
        }
    }

    let cli = Cli::parse_from(&args);

    match cli.command {
        Commands::Debug(args) => mdbg::cockpit::run::run(args),
        Commands::DaHelper(args) => mdbg::da_helper::run::run(args),
        Commands::Proxy(args) => mdbg::proxy_helper::run::run(args),
    }
}
