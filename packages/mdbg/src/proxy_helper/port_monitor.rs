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

// For each platform we want to run a system command to wait for the ports to be open. This is needed because
// the gdb-server if we want to do it in a non-invasive way (i.e. without connecting to it ourselves or creating
// a serveron the port). For some gdb servers, we may be only allowed on connection and may not allow a reconnection
// if we disconnect. Also, gdb-servers may timeout if we open on the server side and there is no client connection.
// We want to note the fact that the connection is open but not actually connect until the real client connects to
// the proxy server.
use std::sync::mpsc::Receiver;
use std::sync::mpsc::Sender;

use std::time::Duration;

use std::collections::HashMap;

use crate::proxy_helper::proxy_server::ProxyEvent;

macro_rules! eprintln {
    ($($arg:tt)*) => {
        log::info!($($arg)*);
    };
}

const MACOS_PROG_ARGS: &[&str] = &["lsof", "-iTCP", "-nP", "-sTCP:LISTEN"];
const LINUX_PROG_ARGS: &[&str] = &["lsof", "-iTCP", "-nP", "-sTCP:LISTEN"];
const WIN_PROG_ARGS: &[&str] = &["netstat", "-ano"];

fn is_port_listening_line(line: &str, port: u16) -> bool {
    if cfg!(target_os = "windows") {
        // netstat -ano (Windows) rows look like:
        // TCP    0.0.0.0:5000      0.0.0.0:0      LISTENING       1234
        // TCP    [::]:5000         [::]:0         LISTENING       1234
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 4 {
            return false;
        }
        if !parts[0].eq_ignore_ascii_case("tcp") {
            return false;
        }
        if !parts[3].eq_ignore_ascii_case("listening") {
            return false;
        }
        let local_addr = parts[1];
        let local_port_str = match local_addr.rsplit(':').next() {
            Some(v) => v,
            None => return false,
        };
        match local_port_str.parse::<u16>() {
            Ok(local_port) => local_port == port,
            Err(_) => false,
        }
    } else {
        line.contains(&format!(":{}", port)) && line.contains("LISTEN")
    }
}

fn get_port_waiter_command() -> (String, Vec<String>) {
    if cfg!(target_os = "macos") {
        (
            MACOS_PROG_ARGS[0].to_string(),
            MACOS_PROG_ARGS[1..].iter().map(|s| s.to_string()).collect(),
        )
    } else if cfg!(target_os = "linux") {
        (
            LINUX_PROG_ARGS[0].to_string(),
            LINUX_PROG_ARGS[1..].iter().map(|s| s.to_string()).collect(),
        )
    } else if cfg!(target_os = "windows") {
        (
            WIN_PROG_ARGS[0].to_string(),
            WIN_PROG_ARGS[1..].iter().map(|s| s.to_string()).collect(),
        )
    } else {
        panic!("Unsupported platform");
    }
}

pub fn wait_for_ports(
    ports: Vec<(u8, u16)>,
    tx: Sender<ProxyEvent>,
    stop_rx: Receiver<()>,
) -> std::io::Result<()> {
    std::thread::spawn(move || {
        let (prog, args) = get_port_waiter_command();
        let mut port_map = HashMap::<u16, u8>::from_iter(
            ports
                .iter()
                .cloned()
                .map(|(stream_id, port)| (port, stream_id)),
        );
        let start = std::time::Instant::now();
        let quick_interval = 200;
        let mut interval = Duration::from_millis(quick_interval);
        while !port_map.is_empty() {
            match stop_rx.try_recv() {
                Ok(_) => {
                    eprintln!("Port monitor received stop signal; exiting thread");
                    return;
                }
                Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                    eprintln!("Port monitor stop channel disconnected; exiting thread");
                    return;
                }
                Err(std::sync::mpsc::TryRecvError::Empty) => {}
            }

            let output = std::process::Command::new(&prog)
                .args(&args)
                .output()
                .map_err(|e| {
                    eprintln!("Failed to execute port waiter command '{}': {}", prog, e);
                    e
                });
            let output = match output {
                Ok(output) => output,
                Err(_) => break,
            };
            if !output.status.success() {
                eprintln!(
                    "Port waiter command failed with status {}: {}",
                    output.status,
                    String::from_utf8_lossy(&output.stderr)
                );
                break;
            }
            let stdout = String::from_utf8_lossy(&output.stdout);
            let mut ready_ports = Vec::<u16>::new();

            for (port, stream_id) in &port_map {
                let found = stdout
                    .lines()
                    .any(|line| is_port_listening_line(line, *port));
                if found {
                    if tx
                        .send(ProxyEvent::PortReady {
                            stream_id: *stream_id,
                            port: *port,
                        })
                        .is_err()
                    {
                        eprintln!("Port monitor receiver dropped; exiting thread");
                        return;
                    }
                    ready_ports.push(*port);
                }
            }

            for port in ready_ports {
                port_map.remove(&port);
            }

            let elapsed = start.elapsed().as_millis();
            let last_interval = interval;
            if elapsed >= 20 * 60 * 1000 {
                // After 20 minutes, switch to a 5 minute interval as we may be waiting forever...but just in case
                interval = Duration::from_secs(5 * 60);
                if interval != last_interval {
                    eprintln!(
                        "Still waiting for ports to be ready after 20 minutes, check interval {:?}s",
                        interval.as_secs()
                    );
                }
            } else if elapsed >= 5 * 60 * 1000 {
                // After 5 minutes, switch to a 30 second interval as we may be waiting forever...but just in case
                interval = Duration::from_secs(30);
                if interval != last_interval {
                    eprintln!(
                        "Still waiting for ports to be ready after 5 minutes, check interval {:?}s",
                        interval.as_secs()
                    );
                }
            } else if elapsed >= 10 * 1000 {
                // After 10 seconds, switch to a fixed 1 second interval to avoid spamming the system with lsof/netstat calls
                interval = Duration::from_secs(1);
                if interval != last_interval {
                    eprintln!(
                    "Still waiting for ports to be ready after 10 seconds, check interval {:?}s",
                        interval.as_secs()
                    );
                }
            }
            match stop_rx.recv_timeout(interval) {
                Ok(_) => {
                    eprintln!("Port monitor received stop signal; exiting thread");
                    return;
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    eprintln!("Port monitor stop channel disconnected; exiting thread");
                    return;
                }
            }
        }
    });
    Ok(())
}
