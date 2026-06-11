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

use std::sync::Arc;

use anyhow::Result;
use clap::{ArgGroup, Args, Subcommand};

use crate::serial::bridge::TcpBridge;
use crate::serial::port::{FlowControl, Parity, PortHandle, SerialParams, SerialTransport, StopBits};
use crate::serial::{list_available, resolve_port};

#[derive(Args, Debug)]
pub struct SerialArgs {
    /// Show all ports, including macOS /dev/tty.* callout variants (normally filtered).
    #[arg(long, global = true)]
    pub all: bool,

    #[command(subcommand)]
    pub command: SerialCommand,
}

#[derive(Subcommand, Debug)]
pub enum SerialCommand {
    /// List available serial ports.
    #[command(name = "list")]
    List,
    /// Open a serial port and bridge it over TCP.
    #[command(name = "serve")]
    Serve(ServeArgs),
}

#[derive(Args, Debug)]
#[command(group(ArgGroup::new("selector").required(true)))]
pub struct ServeArgs {
    /// Device path, optionally a glob (e.g. /dev/ttyUSB0, /dev/ttyACM*).
    #[arg(long, group = "selector")]
    pub path: Option<String>,

    /// USB vendor:product ID pair, hex or decimal (e.g. 0403:6001 or 0x0403:0x6001).
    #[arg(long, group = "selector", value_name = "VID:PID")]
    pub vidpid: Option<String>,

    /// USB serial number (exact match).
    #[arg(long, group = "selector")]
    pub serial: Option<String>,

    /// Case-insensitive substring match on port description (e.g. "FTDI").
    #[arg(long = "match", group = "selector", value_name = "TEXT")]
    pub desc: Option<String>,

    /// TCP port to listen on (0 = OS-assigned).
    #[arg(long, default_value = "4242")]
    pub tcp_port: u16,

    /// Serial baud rate.
    #[arg(long, default_value = "115200")]
    pub baud: u32,
}

pub fn run(args: SerialArgs) -> Result<()> {
    let filter = !args.all;
    match args.command {
        SerialCommand::List => run_list(filter),
        SerialCommand::Serve(serve) => run_serve(serve, filter),
    }
}

fn run_list(filter: bool) -> Result<()> {
    let ports = list_available(filter);
    if ports.is_empty() {
        println!("No serial ports found.");
        return Ok(());
    }

    let path_w = ports.iter().map(|p| p.path.len()).max().unwrap_or(4).max(4);
    let desc_w = ports
        .iter()
        .map(|p| p.description.len())
        .max()
        .unwrap_or(11)
        .max(11);

    println!(
        "{:<path_w$}  {:<desc_w$}  VID    PID    SERIAL",
        "PATH",
        "DESCRIPTION",
        path_w = path_w,
        desc_w = desc_w,
    );
    println!("{}", "-".repeat(path_w + desc_w + 30));
    for p in &ports {
        println!(
            "{:<path_w$}  {:<desc_w$}  {:5}  {:5}  {}",
            p.path,
            p.description,
            p.vid.map(|v| format!("{:04x}", v)).unwrap_or_default(),
            p.pid.map(|v| format!("{:04x}", v)).unwrap_or_default(),
            p.serial.as_deref().unwrap_or(""),
            path_w = path_w,
            desc_w = desc_w,
        );
    }
    Ok(())
}

fn run_serve(args: ServeArgs, filter: bool) -> Result<()> {
    let (vid_opt, pid_opt) = if let Some(ref vp) = args.vidpid {
        let (v, p) = split_vidpid(vp)?;
        (Some(v), Some(p))
    } else {
        (None, None)
    };

    let resolved = resolve_port(
        args.path.as_deref(),
        args.serial.as_deref(),
        vid_opt.as_deref(),
        pid_opt.as_deref(),
        args.desc.as_deref(),
        filter,
    )?;

    let params = SerialParams {
        path: Some(resolved.clone()),
        serial: None,
        vid: None,
        pid: None,
        baud_rate: args.baud,
        data_bits: 8,
        stop_bits: StopBits::One,
        parity: Parity::None,
        flow_control: FlowControl::None,
        transport: SerialTransport::default(),
        log_file: None,
        input_mode: None,
        label: None,
    };

    println!("Opening {}", resolved);
    let handle = Arc::new(PortHandle::open(resolved, params)?);
    let bridge = TcpBridge::start("127.0.0.1", args.tcp_port, Arc::clone(&handle))?;
    println!("Bridging on TCP port {} — press Ctrl+C to stop.", bridge.tcp_port);

    // Block until the process is killed (Ctrl+C / SIGINT).
    let (_stop_tx, stop_rx) = std::sync::mpsc::channel::<()>();
    let _ = stop_rx.recv();
    Ok(())
}

fn split_vidpid(s: &str) -> Result<(String, String)> {
    match s.split_once(':') {
        Some((v, p)) => Ok((v.trim().to_string(), p.trim().to_string())),
        None => anyhow::bail!("--vidpid must be VID:PID (e.g. 0403:6001), got {:?}", s),
    }
}
