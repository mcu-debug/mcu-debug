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

/// Commands that can list listening TCP sockets, in preference order per platform.
///
/// Readiness is detected by *observing* listening sockets rather than connecting to
/// them: a TCP connect to a gdb RSP port is indistinguishable from gdb arriving, and
/// openocd will wait for protocol traffic that never comes. Every entry here must be
/// non-invasive for the same reason.
///
/// `ss` leads on Linux because iproute2 is present on far more systems than `lsof` —
/// minimal server images and containers routinely ship without the latter.
const MACOS_PROG_ARGS: &[&[&str]] = &[&["lsof", "-iTCP", "-nP", "-sTCP:LISTEN"]];
const LINUX_PROG_ARGS: &[&[&str]] = &[
    &["ss", "-ltnH"],
    &["lsof", "-iTCP", "-nP", "-sTCP:LISTEN"],
    &["netstat", "-ltn"],
];
const WIN_PROG_ARGS: &[&[&str]] = &[&["netstat", "-ano"]];

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
        // Must be LISTEN state and carry `:<port>` as a *whole* port number. A plain
        // substring test matches ":2000" inside ":20000", so a listener on 20000 would
        // report port 2000 ready and the client would connect to a server that is not
        // there yet.
        line.contains("LISTEN") && contains_listening_port(line, port)
    }
}

/// Does `line` mention `:<port>` where the number ends there rather than continuing?
///
/// Shared by the `ss`, `lsof` and `netstat` output formats on unix — they differ in
/// layout but all render the local endpoint as `<addr>:<port>`.
fn contains_listening_port(line: &str, port: u16) -> bool {
    let needle = format!(":{port}");
    let mut rest = line;
    while let Some(idx) = rest.find(&needle) {
        let after = &rest[idx + needle.len()..];
        if !after.starts_with(|c: char| c.is_ascii_digit()) {
            return true;
        }
        rest = &rest[idx + needle.len()..];
    }
    false
}

/// Candidate commands for this platform, most preferred first.
fn port_waiter_candidates() -> &'static [&'static [&'static str]] {
    if cfg!(target_os = "macos") {
        MACOS_PROG_ARGS
    } else if cfg!(target_os = "linux") {
        LINUX_PROG_ARGS
    } else if cfg!(target_os = "windows") {
        WIN_PROG_ARGS
    } else {
        &[]
    }
}

/// The first candidate that actually runs on this machine.
///
/// Probing once up front means a missing utility is reported as itself, naming what to
/// install. Previously the loop simply `break`ed when the command could not be executed,
/// so no port was ever reported ready and the session hung until it timed out — a
/// symptom that says nothing about the cause.
fn get_port_waiter_command() -> std::io::Result<(String, Vec<String>)> {
    let candidates = port_waiter_candidates();
    for cand in candidates {
        let (prog, args) = (cand[0], &cand[1..]);
        let mut command = std::process::Command::new(prog);
        command.args(args);
        crate::common::process::suppress_console_window(&mut command);
        if command.output().is_ok() {
            eprintln!("Port monitor using '{}' to detect listening ports", prog);
            return Ok((prog.to_string(), args.iter().map(|s| s.to_string()).collect()));
        }
    }
    let names: Vec<&str> = candidates.iter().map(|c| c[0]).collect();
    Err(std::io::Error::new(
        std::io::ErrorKind::NotFound,
        format!(
            "no usable tool to detect listening ports (tried: {}). \
             mcu-debug needs one of these to tell when the gdb-server is ready; \
             probing the port by connecting to it is not an option, because that is \
             indistinguishable from gdb connecting and makes the server hang. \
             Install one of them (on Linux, iproute2 provides `ss`).",
            if names.is_empty() {
                "none — unsupported platform".to_string()
            } else {
                names.join(", ")
            }
        ),
    ))
}

pub fn wait_for_ports(ports: Vec<(u8, u16)>, tx: Sender<ProxyEvent>, stop_rx: Receiver<()>) -> std::io::Result<()> {
    // Resolved on this thread so a missing utility fails the caller loudly rather than
    // dying quietly inside the monitor thread.
    let (prog, args) = get_port_waiter_command()?;
    std::thread::spawn(move || {
        let mut port_map =
            HashMap::<u16, u8>::from_iter(ports.iter().cloned().map(|(stream_id, port)| (port, stream_id)));
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

            let mut command = std::process::Command::new(&prog);
            command.args(&args);
            crate::common::process::suppress_console_window(&mut command);
            let output = command.output().map_err(|e| {
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
                let found = stdout.lines().any(|line| is_port_listening_line(line, *port));
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Real output shapes from each tool we accept, so a parser change cannot silently
    /// stop recognising one of them.
    #[cfg(not(target_os = "windows"))]
    #[test]
    fn recognises_every_supported_output_format() {
        let lines = [
            // ss -ltnH
            "LISTEN 0      4096         0.0.0.0:2000       0.0.0.0:*",
            // lsof -iTCP -nP -sTCP:LISTEN
            "openocd  4242 hdm    7u  IPv4 0x1234      0t0  TCP 127.0.0.1:2000 (LISTEN)",
            // netstat -ltn
            "tcp        0      0 0.0.0.0:2000            0.0.0.0:*               LISTEN",
        ];
        for line in lines {
            assert!(is_port_listening_line(line, 2000), "should match: {line}");
        }
    }

    /// The bug this guards: a substring test matches ":2000" inside ":20000", so a
    /// listener on an unrelated high port would report the gdb port ready and the client
    /// would connect to a server that has not started listening yet.
    #[cfg(not(target_os = "windows"))]
    #[test]
    fn a_longer_port_number_is_not_a_prefix_match() {
        let line = "LISTEN 0      4096         0.0.0.0:20000      0.0.0.0:*";

        assert!(!is_port_listening_line(line, 2000), "20000 must not match 2000");
        assert!(is_port_listening_line(line, 20000), "but 20000 matches itself");
    }

    /// A socket in any other state is not ready to be connected to.
    #[cfg(not(target_os = "windows"))]
    #[test]
    fn only_listening_sockets_count() {
        let established = "ESTAB  0      0            127.0.0.1:2000     127.0.0.1:54321";

        assert!(!is_port_listening_line(established, 2000));
    }

    /// Windows rows are positional, so the port lives in a known column.
    #[cfg(target_os = "windows")]
    #[test]
    fn windows_netstat_rows_are_matched_by_column() {
        assert!(is_port_listening_line(
            "  TCP    0.0.0.0:2000           0.0.0.0:0              LISTENING       1234",
            2000
        ));
        assert!(!is_port_listening_line(
            "  TCP    0.0.0.0:20000          0.0.0.0:0              LISTENING       1234",
            2000
        ));
        assert!(!is_port_listening_line(
            "  TCP    127.0.0.1:2000         127.0.0.1:54321        ESTABLISHED     1234",
            2000
        ));
    }

    /// This machine must have one of the tools. If it does not, every session would hang
    /// waiting for a port that is never reported ready — so the failure has to name
    /// itself rather than being discovered as a timeout.
    #[test]
    fn a_port_waiter_command_is_available_on_this_platform() {
        let cmd = get_port_waiter_command();

        assert!(
            cmd.is_ok(),
            "no listening-port tool found: {}",
            cmd.err().map(|e| e.to_string()).unwrap_or_default()
        );
    }
}
