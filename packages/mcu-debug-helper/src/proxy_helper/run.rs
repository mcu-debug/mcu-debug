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

//! Entry point for the proxy-helper subcommand.
//! This will implement the Probe Agent that manages gdb-server processes
//! and speaks the Funnel Protocol over TCP.

use anyhow::Result;
use clap::Args;

#[derive(Args, Debug)]
pub struct ProxyArgs {
    /// TCP port to listen on (0 = auto-assign)
    #[arg(short = 'p', long = "port", default_value_t = 0)]
    pub port: u16,

    /// Authentication token for client connections
    #[arg(short = 't', long = "token")]
    pub token: Option<String>,

    /// Enable debug output
    #[arg(short = 'd', long = "debug", default_value_t = false)]
    pub debug: bool,
}

pub fn run(args: ProxyArgs) -> Result<()> {
    crate::common::debug::set_debug(args.debug);

    let port_display = if args.port == 0 { "auto".to_string() } else { args.port.to_string() };
    eprintln!("Probe Agent starting (port: {})...", port_display);

    // TODO: Phase 1 implementation
    // 1. Bind TCP listener (port 0 for auto-assign)
    // 2. Print Discovery JSON to stdout: {"status": "ready", "port": <actual_port>, "pid": <pid>}
    // 3. Accept connection and run Funnel Protocol handler
    // 4. Handle JSON-RPC control messages (initialize, startStream, streamStatus, heartbeat)
    // 5. Forward binary streams between client and local TCP ports

    eprintln!("Probe Agent: not yet implemented");
    Ok(())
}
