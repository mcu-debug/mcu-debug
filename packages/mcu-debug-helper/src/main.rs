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

use mcu_debug_helper::da_helper::run::DaHelperArgs;
use mcu_debug_helper::proxy_helper::run::ProxyArgs;

#[derive(Parser, Debug)]
#[command(author, version, about = "MCU Debug Helper — ELF analysis and remote probe agent")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand, Debug)]
enum Commands {
    /// Debug Adapter helper: ELF parsing, disassembly, and symbol lookup
    #[command(name = "da-helper")]
    DaHelper(DaHelperArgs),

    /// Probe Agent: remote gdb-server orchestration via the Funnel Protocol
    #[command(name = "proxy")]
    Proxy(ProxyArgs),
}

fn main() -> Result<()> {
    let cli = Cli::parse();

    match cli.command {
        Commands::DaHelper(args) => mcu_debug_helper::da_helper::run::run(args),
        Commands::Proxy(args) => mcu_debug_helper::proxy_helper::run::run(args),
    }
}
