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

use anyhow::Context as _;
use clap::Args;
use std::io::{Read, Write};

// We take one argument that is a json file that describes a set of serial communication parameters (port, baud rate,
// etc) and the messages to send. This is to test the serial communication logic in isolation from the rest of the
// extension. Each SerialParams struct instance contains a tcp_port number to use (default 0 for OS assigned).
//
// Example JSON:
// [
//   {
//     "path": "/dev/ttyUSB0",
//     "tcp_port": 0,
//     "baud_rate": 115200,
//     "data_bits": 8,
//     "stop_bits": "one",
//     "parity": "none",
//     "flow_control": "none"
//   }
// ]
#[derive(Debug, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "serial-helper/")]
pub struct SerialParams {
    /// Serial device path. Required. E.g. `/dev/ttyUSB0`, `/dev/tty.usbserial-*`, `COM3`.
    pub path: String,

    /// TCP port the bridge listens on. 0 = OS-assigned (reported back on stdout). Default: 0.
    #[serde(default)]
    pub tcp_port: u16,

    /// Baud rate in bits per second. Default: 115200.
    #[serde(default = "default_baud_rate")]
    pub baud_rate: u32,

    /// Number of data bits per frame (5–8). Default: 8.
    #[serde(default = "default_data_bits")]
    pub data_bits: u8,

    /// Number of stop bits. "one" | "one_point_five" | "two". Default: "one".
    #[serde(default = "default_stop_bits")]
    pub stop_bits: StopBits,

    /// Parity checking. "none" | "odd" | "even". Default: "none".
    #[serde(default = "default_parity")]
    pub parity: Parity,

    /// Flow control mode. "none" | "software" (XON/XOFF) | "hardware" (RTS/CTS). Default: "none".
    #[serde(default = "default_flow_control")]
    pub flow_control: FlowControl,
}

/// Stop-bit count — mirrors `serialport::StopBits` but is JSON-serializable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "serial-helper/")]
pub enum StopBits {
    One,
    OnePointFive,
    Two,
}

/// Parity mode — mirrors `serialport::Parity` but is JSON-serializable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "serial-helper/")]
pub enum Parity {
    None,
    Odd,
    Even,
}

/// Flow control mode — mirrors `serialport::FlowControl` but is JSON-serializable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "serial-helper/")]
pub enum FlowControl {
    None,
    Software,
    Hardware,
}

fn default_baud_rate() -> u32 {
    115200
}
fn default_data_bits() -> u8 {
    8
}
fn default_stop_bits() -> StopBits {
    StopBits::One
}
fn default_parity() -> Parity {
    Parity::None
}
fn default_flow_control() -> FlowControl {
    FlowControl::None
}

impl From<StopBits> for serialport::StopBits {
    fn from(s: StopBits) -> Self {
        match s {
            StopBits::One => serialport::StopBits::One,
            StopBits::OnePointFive => serialport::StopBits::One, // serialport crate has no 1.5; fall back to 1
            StopBits::Two => serialport::StopBits::Two,
        }
    }
}

impl From<Parity> for serialport::Parity {
    fn from(p: Parity) -> Self {
        match p {
            Parity::None => serialport::Parity::None,
            Parity::Odd => serialport::Parity::Odd,
            Parity::Even => serialport::Parity::Even,
        }
    }
}

impl From<FlowControl> for serialport::FlowControl {
    fn from(f: FlowControl) -> Self {
        match f {
            FlowControl::None => serialport::FlowControl::None,
            FlowControl::Software => serialport::FlowControl::Software,
            FlowControl::Hardware => serialport::FlowControl::Hardware,
        }
    }
}

#[derive(Args, Debug)]
pub struct SerialArgs {
    #[arg(short = 'j', long = "json-file", required = true)]
    pub json: String,

    /// Host to listen on (default: 127.0.0.1), alternatively specify `0.0.0.0` to listen on all interfaces
    #[arg(short = 'b', long = "bind-to", default_value = "127.0.0.1")]
    pub bind_to: String,

    /// timeout in seconds for serial operations (default: 0 for no timeout)
    #[arg(short = 't', long = "timeout", default_value_t = 0)]
    pub timeout_secs: u64,
}

fn data_bits_from_u8(n: u8) -> serialport::DataBits {
    match n {
        5 => serialport::DataBits::Five,
        6 => serialport::DataBits::Six,
        7 => serialport::DataBits::Seven,
        _ => serialport::DataBits::Eight,
    }
}

/// Listens on `listener` forever, accepting one TCP connection at a time and bridging it to the
/// serial port described by `param`. When the connection closes (either direction), the serial
/// port is also closed and the thread loops back to `accept()`, ready for the next client.
///
/// The listener lives for the lifetime of the process. The only shutdown signal is stdin EOF,
/// which causes `process::exit(0)` in the main thread.
///
/// For each accepted connection a second thread (Thread A) handles TCP→serial while the current
/// thread (Thread B) handles serial→TCP. Shutdown coordination: whichever direction hits an error
/// first calls `tcp.shutdown(Both)`, which unblocks the other direction's next read or write.
fn bridge_port(listener: std::net::TcpListener, param: SerialParams, timeout_secs: u64) {
    let path = param.path.clone();

    // Use a short read timeout on the serial port so Thread B can notice a TCP disconnect
    // promptly even when no serial data is arriving. If the user set a non-zero timeout,
    // honour it; otherwise use 100 ms as the poll tick.
    let serial_timeout = if timeout_secs > 0 {
        std::time::Duration::from_secs(timeout_secs)
    } else {
        std::time::Duration::from_millis(100)
    };

    loop {
        // ── Wait for a client ────────────────────────────────────────────────
        let (tcp, addr) = match listener.accept() {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[{path}] accept error: {e}");
                // Listener is broken — nothing we can do; exit the loop.
                return;
            }
        };
        eprintln!("[{path}] accepted connection from {addr}");

        // ── Open serial port ─────────────────────────────────────────────────
        let serial = match serialport::new(&path, param.baud_rate)
            .data_bits(data_bits_from_u8(param.data_bits))
            .stop_bits(param.stop_bits.into())
            .parity(param.parity.into())
            .flow_control(param.flow_control.into())
            .timeout(serial_timeout)
            .open()
        {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[{path}] failed to open serial port: {e}");
                let _ = tcp.shutdown(std::net::Shutdown::Both);
                // Serial device may not be present yet — loop back and wait for the next client.
                continue;
            }
        };

        // ── Clone handles so each direction thread owns independent read+write ends ──
        // try_clone() shares the underlying fd; shutdown() on any clone affects the whole socket.
        let mut tcp_a = match tcp.try_clone() {
            Ok(t) => t,
            Err(e) => {
                eprintln!("[{path}] failed to clone TCP stream: {e}");
                let _ = tcp.shutdown(std::net::Shutdown::Both);
                continue;
            }
        };
        let mut serial_a = match serial.try_clone() {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[{path}] failed to clone serial port: {e}");
                let _ = tcp.shutdown(std::net::Shutdown::Both);
                continue;
            }
        };
        let mut tcp_b = tcp;
        let mut serial_b = serial;
        let path_a = path.clone();

        // ── Thread A: TCP → serial ────────────────────────────────────────────
        let thread_a = std::thread::spawn(move || {
            let mut buf = [0u8; 1024];
            loop {
                match tcp_a.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if serial_a.write_all(&buf[..n]).is_err() {
                            break;
                        }
                    }
                }
            }
            // Signal Thread B to stop.
            let _ = tcp_a.shutdown(std::net::Shutdown::Both);
            eprintln!("[{path_a}] TCP→serial direction closed");
        });

        // ── Thread B (this thread): serial → TCP ──────────────────────────────
        let mut buf = [0u8; 1024];
        loop {
            match serial_b.read(&mut buf) {
                Err(e)
                    if e.kind() == std::io::ErrorKind::TimedOut
                        || e.kind() == std::io::ErrorKind::WouldBlock =>
                {
                    // Normal serial poll tick — no data yet. Loop back and retry.
                    // If Thread A already shut down the TCP socket, the next write_all will fail.
                    continue;
                }
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if tcp_b.write_all(&buf[..n]).is_err() {
                        break;
                    }
                }
            }
        }
        let _ = tcp_b.shutdown(std::net::Shutdown::Both);
        eprintln!("[{path}] serial→TCP direction closed");

        // Wait for Thread A to finish before closing the serial port (dropped at end of loop).
        let _ = thread_a.join();
        eprintln!("[{path}] connection closed; waiting for next client");
        // serial_b and serial_a (via thread_a) are both dropped here — port is released.
    }
}

pub fn run_serial(args: SerialArgs) -> anyhow::Result<()> {
    // 1. Parse JSON file into a list of SerialParams
    let json_str = std::fs::read_to_string(&args.json)
        .with_context(|| format!("failed to read '{}'", args.json))?;
    let params: Vec<SerialParams> = serde_json::from_str(&json_str)
        .with_context(|| format!("failed to parse '{}' as serial params", args.json))?;

    if params.is_empty() {
        eprintln!("no serial parameters found in '{}'", args.json);
        std::process::exit(0);
    }

    // 2. Set up TCP listeners on params.tcp_port (or OS assigned if 0). First we allocate all the ports,
    //then print out the assigned port numbers as json [{path:<path>, port:<port>}], then start accepting connections
    // in separate threads. This way the caller can know which ports to connect to before we start accepting.
    //This way the caller can know which ports to connect to before we start accepting.
    let mut listeners = Vec::new();
    let mut port_mappings = Vec::new();
    for param in params {
        let listener = std::net::TcpListener::bind((args.bind_to.as_str(), param.tcp_port))?;
        let local_port = listener.local_addr()?.port();
        port_mappings.push((param.path.clone(), local_port, param));
        listeners.push(listener);
    }
    // Print out the port mappings as JSON to stdout so the caller can read them and know which ports to connect to
    let output = serde_json::to_string(
        &port_mappings
            .iter()
            .map(|(path, port, _)| {
                serde_json::json!({
                    "path": path,
                    "tcp_port": port,
                })
            })
            .collect::<Vec<_>>(),
    )?;
    println!("{}", output);

    // 3. Spawn one accept+bridge thread per serial port.
    // Each thread: accepts one TCP connection, opens the serial port, then splits into
    // two directions (TCP→serial and serial→TCP) with a second inner thread.
    let timeout_secs = args.timeout_secs;
    for (listener, (_, _, param)) in listeners.into_iter().zip(port_mappings.into_iter()) {
        std::thread::spawn(move || {
            bridge_port(listener, param, timeout_secs);
        });
    }

    // 4. Park the main thread until the parent closes stdin — that is the shutdown signal.
    //    The OS will close all TCP sockets and serial fds on exit.
    let mut buf = [0u8; 1];
    loop {
        match std::io::stdin().read(&mut buf) {
            Ok(0) | Err(_) => break, // EOF or pipe broken
            _ => {}
        }
    }
    std::process::exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;
    use ts_rs::{Config, TS};

    #[test]
    fn ensure_ts_exports() {
        let config = Config::from_env();
        SerialParams::export(&config).unwrap();
        StopBits::export(&config).unwrap();
        Parity::export(&config).unwrap();
        FlowControl::export(&config).unwrap();
    }
}
