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
use crate::serial::port::{
    FlowControl, Parity, PortHandle, SerialParams, SerialTransport, StopBits,
};
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

    /// Data bits (5, 6, 7, or 8).
    #[arg(long, default_value = "8")]
    pub data_bits: u8,

    /// Stop bits (1 or 2).
    #[arg(long, default_value = "1")]
    pub stop_bits: u8,

    /// Parity (none, even, or odd).
    #[arg(long, default_value = "none")]
    pub parity: String,

    /// Flow control (none, software, or hardware).
    #[arg(long, default_value = "none")]
    pub flow_control: String,

    /// On disconnect, keep waiting and re-bridge when the device reappears
    /// instead of exiting. Without this flag, the process exits (non-zero)
    /// on the first fatal port error — one shot per invocation.
    #[arg(long)]
    pub persist: bool,
}

// ── stdout status protocol ───────────────────────────────────────────────────

/// One JSON object per line on stdout, so a launching client can track this
/// command's state without a side-channel. Mirrors the daemon's
/// `serial.portError` event shape (`SerialErrorKind`) for a single schema
/// across both entry points.
#[derive(serde::Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum ServeStatus<'a> {
    /// The device is open and bridged; TCP clients may connect to `tcp_port`.
    Listening { path: &'a str, tcp_port: u16 },
    /// The device is not currently available; retrying (only with `--persist`).
    Waiting { msg: String },
    /// A fatal port error occurred; the bridge for `path` has been torn down.
    Error {
        path: &'a str,
        kind: crate::serial::port::SerialErrorKind,
        msg: &'a str,
    },
}

fn emit_status(status: &ServeStatus) {
    match serde_json::to_string(status) {
        Ok(line) => println!("{line}"),
        Err(e) => eprintln!("failed to serialize status line: {e}"),
    }
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

/// Poll interval while `--persist` is waiting for the device to (re)appear.
const RETRY_INTERVAL: std::time::Duration = std::time::Duration::from_millis(1000);

fn run_serve(args: ServeArgs, filter: bool) -> Result<()> {
    let (vid_opt, pid_opt) = if let Some(ref vp) = args.vidpid {
        let (v, p) = split_vidpid(vp)?;
        (Some(v), Some(p))
    } else {
        (None, None)
    };

    let stop_bits = match args.stop_bits {
        1 => StopBits::One,
        2 => StopBits::Two,
        _ => anyhow::bail!("Invalid stop bits: {}", args.stop_bits),
    };
    let parity = match args.parity.to_lowercase().as_str() {
        "none" => Parity::None,
        "even" => Parity::Even,
        "odd" => Parity::Odd,
        _ => anyhow::bail!("Invalid parity: {}", args.parity),
    };
    let flow_control = match args.flow_control.to_lowercase().as_str() {
        "none" => FlowControl::None,
        "software" => FlowControl::Software,
        "hardware" => FlowControl::Hardware,
        _ => anyhow::bail!("Invalid flow control: {}", args.flow_control),
    };

    loop {
        let (resolved, handle) = open_with_retry(
            &args,
            vid_opt.as_deref(),
            pid_opt.as_deref(),
            filter,
            stop_bits,
            parity,
            flow_control,
        )?;

        let bridge = TcpBridge::start("127.0.0.1", args.tcp_port, Arc::clone(&handle))?;
        emit_status(&ServeStatus::Listening {
            path: &resolved,
            tcp_port: bridge.tcp_port,
        });

        // Block until the port dies (fatal disconnect/IO error). Nothing else
        // drops `handle`'s error_subs sender while we hold this Arc alongside
        // the bridge's, so `recv()` only returns once that actually happens.
        let (err_tx, err_rx) = std::sync::mpsc::channel();
        handle.subscribe_errors(err_tx);
        let err = err_rx.recv();

        // Tear down explicitly (rather than waiting on scope-end drop) so the
        // TCP port is released before we potentially try to rebind it below.
        drop(bridge);
        drop(handle);

        if let Ok(e) = err {
            emit_status(&ServeStatus::Error {
                path: &e.path,
                kind: e.kind,
                msg: &e.msg,
            });
        }

        if !args.persist {
            std::process::exit(1);
        }
        // else: loop back around and wait for the device to reappear.
    }
}

/// Resolve and open the device, retrying on failure only when `persist` is
/// set on `args`. Emits a single `Waiting` status line per outage (not once
/// per poll) so stdout doesn't get spammed while the device is absent.
fn open_with_retry(
    args: &ServeArgs,
    vid_opt: Option<&str>,
    pid_opt: Option<&str>,
    filter: bool,
    stop_bits: StopBits,
    parity: Parity,
    flow_control: FlowControl,
) -> Result<(String, Arc<PortHandle>)> {
    let mut waiting_announced = false;
    loop {
        let resolved = match resolve_port(
            args.path.as_deref(),
            args.serial.as_deref(),
            vid_opt,
            pid_opt,
            args.desc.as_deref(),
            filter,
        ) {
            Ok(p) => p,
            Err(e) => {
                if !args.persist {
                    return Err(e);
                }
                if !waiting_announced {
                    emit_status(&ServeStatus::Waiting { msg: e.to_string() });
                    waiting_announced = true;
                }
                std::thread::sleep(RETRY_INTERVAL);
                continue;
            }
        };

        let params = SerialParams {
            path: Some(resolved.clone()),
            description: None,
            serial: None,
            vid: None,
            pid: None,
            baud_rate: args.baud,
            data_bits: args.data_bits,
            stop_bits,
            parity,
            flow_control,
            transport: SerialTransport::default(),
            log_file: None,
            input_mode: None,
            label: None,
        };

        match PortHandle::open(resolved.clone(), params) {
            Ok(h) => return Ok((resolved, Arc::new(h))),
            Err(e) => {
                if !args.persist {
                    return Err(e);
                }
                if !waiting_announced {
                    emit_status(&ServeStatus::Waiting { msg: e.to_string() });
                    waiting_announced = true;
                }
                std::thread::sleep(RETRY_INTERVAL);
            }
        }
    }
}

fn split_vidpid(s: &str) -> Result<(String, String)> {
    match s.split_once(':') {
        Some((v, p)) => Ok((v.trim().to_string(), p.trim().to_string())),
        None => anyhow::bail!("--vidpid must be VID:PID (e.g. 0403:6001), got {:?}", s),
    }
}
