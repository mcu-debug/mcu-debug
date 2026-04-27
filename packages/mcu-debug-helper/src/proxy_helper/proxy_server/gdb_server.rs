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

//! `ProxyServer` handler methods for GDB-server lifecycle, stream management,
//! session initialization, port allocation, and file sync.

use anyhow::{anyhow, Result};
use std::collections::HashMap;
use std::env;
use std::fs;
use std::io::Read;
use std::net::TcpStream;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::mpsc::Sender;
use std::time::{Duration, Instant};

use crate::common::tcpports::reserve_free_ports;
use crate::proxy_helper::port_monitor::wait_for_ports;
use crate::proxy_helper::run::PortWaitMode;

use super::*;

// ── Free helpers (used only within this module) ───────────────────────────────

/// Read from `reader` in a loop and send each chunk to `tx` as a `StreamData`
/// event. Sends `StreamClosed` on EOF or error.
fn read_and_forward<R: Read>(stream_id: u8, mut reader: R, tx: Sender<ProxyEvent>) {
    let mut buffer = [0; 4096];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => {
                tx.send(ProxyEvent::StreamClosed { stream_id }).ok();
                break;
            }
            Ok(n) => {
                let data = buffer[..n].to_vec();
                if tx.send(ProxyEvent::StreamData { stream_id, data }).is_err() {
                    break;
                }
            }
            Err(_) => {
                tx.send(ProxyEvent::StreamClosed { stream_id }).ok();
                break;
            }
        }
    }
}

/// Return value from [`ProxyServer::wait_and_connect_sync`].
pub enum WaitPortResult {
    /// A live TCP stream (when `keep_open == true`).
    Stream(TcpStream),
    /// Port responded to a probe connection (`keep_open == false`).
    Ready,
}

/// Validate that `relative_path` is a safe relative path for the `syncFile`
/// operation: no absolute component, no `..`, and must have a file name.
fn is_safe_relative_sync_path(relative_path: &str) -> bool {
    if relative_path.is_empty() {
        return false;
    }
    let path = Path::new(relative_path);
    if path.is_absolute() || path.file_name().is_none() {
        return false;
    }
    !path.components().any(|c| {
        matches!(
            c,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    })
}

fn create_parent_dirs(file_path_str: &str) {
    if let Some(parent) = Path::new(file_path_str).parent() {
        fs::create_dir_all(parent).ok();
    }
}

// ── Handler methods on ProxyServer ────────────────────────────────────────────

impl ProxyServer {
    pub(super) fn handle_initialize(&mut self, msg: &ControlMessage) {
        if let ControlRequest::Initialize {
            token,
            version,
            workspace_uid,
            session_uid,
            port_wait_mode,
        } = &msg.request
        {
            eprintln!(
                "Received Initialize request with version {} and token {:?} and workspace_uid {:?} and session_uid {:?} and port_wait_mode {:?}",
                version, token, workspace_uid, session_uid, port_wait_mode
            );
            let mut err = false;
            let mut err_msg = String::new();
            if !self.args.no_token {
                if token != &self.args.token {
                    err_msg = "Error: Received token does not match expected token".to_string();
                    err = true;
                }
            }
            if version != CURRENT_VERSION {
                err_msg = format!("Error: Unsupported version {}", version);
                err = true;
            }
            let dir = PathBuf::from(env::temp_dir())
                .join("mcu-proxy-server")
                .join(workspace_uid)
                .join(session_uid)
                .into_os_string()
                .into_string()
                .unwrap()
                .replace('\\', "/");
            if !err {
                fs::remove_dir_all(&dir).ok();
                match fs::create_dir_all(&dir) {
                    Ok(_) => {}
                    Err(e) => {
                        eprintln!("Failed to create directory {:?}: {}", dir, e);
                        err = true;
                        err_msg = format!("Failed to create directory {:?}: {}", dir, e);
                    }
                }
            }

            if err {
                err_msg = format!("Initialization failed, closing connection: {}", err_msg);
                eprintln!("{}", err_msg);
                self.writer
                    .shutdown(std::net::Shutdown::Both)
                    .unwrap_or_else(|e| {
                        eprintln!("Failed to shutdown stream: {}", e);
                    });
                ControlResponse::error(msg.seq, err_msg)
                    .send(&self.writer)
                    .unwrap_or_else(|e| {
                        eprintln!("Failed to send error response: {}", e);
                    });
                self.exit = true;
            } else {
                eprintln!("Initialization successful");
                self.server_cwd = dir.clone();
                if let Some(mode) = port_wait_mode {
                    self.session_port_wait_mode = *mode;
                }
                let data = ControlResponseData::Initialize {
                    version: CURRENT_VERSION.to_string(),
                    server_cwd: dir,
                };
                ControlResponse::success(msg.seq, Some(data))
                    .send(&self.writer)
                    .unwrap_or_else(|e| {
                        eprintln!("Failed to send success response: {}", e);
                        self.exit = true;
                    });
            }
        } else {
            eprintln!(
                "BUG: handle_initialize called with wrong request type: {:?}",
                msg.request
            );
            ControlResponse::error(msg.seq, "Internal error: wrong handler".to_string())
                .send(&self.writer)
                .ok();
        }
    }

    pub(super) fn handle_allocate_ports(&mut self, msg: &ControlMessage) {
        if let ControlRequest::AllocatePorts { ports_spec } = &msg.request {
            let mut ret_vec: Vec<PortReserved> = Vec::new();
            eprintln!("Received AllocatePorts request with spec: {:?}", ports_spec);
            for port_set in &ports_spec.all_ports {
                eprintln!(
                    "PortSet: start_port={}, port_ids={:?}",
                    port_set.start_port, port_set.port_ids
                );
                let args = crate::common::tcpports::TcpPortFinderArgs {
                    consecutive: true,
                    count: port_set.port_ids.len() as u16,
                    start_port: port_set.start_port,
                };
                let ports = match reserve_free_ports(&args) {
                    Some(ports) => ports,
                    None => {
                        eprintln!(
                            "Failed to allocate requested ports for PortSet starting at {}",
                            port_set.start_port
                        );
                        ControlResponse::error(
                            msg.seq,
                            format!(
                                "Failed to allocate requested ports for PortSet starting at {}",
                                port_set.start_port
                            ),
                        )
                        .send(&self.writer)
                        .ok();
                        return;
                    }
                };
                let mut count = 0;
                for id_string in &port_set.port_ids {
                    let listener = ports[count].try_clone().ok();
                    let port = listener.as_ref().unwrap().local_addr().unwrap().port();
                    self.reserved_ports.push(PortInfoListner {
                        port,
                        stream_id: self.next_stream_id,
                        listener,
                    });
                    ret_vec.push(PortReserved {
                        port,
                        stream_id: self.next_stream_id,
                        stream_id_str: id_string.clone(),
                    });
                    self.next_stream_id += 1;
                    count += 1;
                }
            }
            let data = ControlResponseData::AllocatePorts { ports: ret_vec };
            ControlResponse::success(msg.seq, Some(data))
                .send(&self.writer)
                .unwrap_or_else(|e| {
                    eprintln!("Failed to send success response: {}", e);
                    self.exit = true;
                });
        } else {
            eprintln!(
                "BUG: handle_allocate_ports called with wrong request type: {:?}",
                msg.request
            );
            ControlResponse::error(msg.seq, "Internal error: wrong handler".to_string())
                .send(&self.writer)
                .ok();
        }
    }

    pub(super) fn handle_start_gdb_server(&mut self, msg: &ControlMessage) {
        if let ControlRequest::StartGdbServer {
            config_args,
            server_path,
            server_args,
            server_env,
            server_regexes,
        } = &msg.request
        {
            self.stop_port_monitor();
            let _ = config_args;
            let _ = server_regexes;
            let ports: Vec<(u8, u16)> = self
                .reserved_ports
                .drain(..)
                .map(|p| (p.stream_id, p.port))
                .collect();
            let dir = self.server_cwd.clone();
            let child = match Command::new(server_path)
                .args(server_args)
                .envs(server_env.as_ref().unwrap_or(&HashMap::new()))
                .current_dir(dir)
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
            {
                Ok(child) => child,
                Err(e) => {
                    eprintln!("Failed to launch gdb-server: {}", e);
                    ControlResponse::error(msg.seq, format!("Failed to launch gdb-server: {}", e))
                        .send(&self.writer)
                        .ok();
                    self.exit = true;
                    return;
                }
            };

            self.process = Some(child);

            if let Some(stdout) = self.process.as_mut().unwrap().stdout.take() {
                let tx = self.event_tx.clone();
                std::thread::spawn(move || {
                    read_and_forward(StreamId::Stdout.to_u8(), stdout, tx);
                });
            }
            if let Some(stderr) = self.process.as_mut().unwrap().stderr.take() {
                let tx = self.event_tx.clone();
                std::thread::spawn(move || {
                    read_and_forward(StreamId::Stderr.to_u8(), stderr, tx);
                });
            }

            match self.session_port_wait_mode {
                PortWaitMode::ConnectHold => {
                    self.spawn_port_waiters(ports, true, 0);
                }
                PortWaitMode::ConnectProbe => {
                    self.spawn_port_waiters(ports, false, 0);
                }
                PortWaitMode::Monitor => {
                    self.stop_port_monitor();
                    let (stop_tx, stop_rx) = std::sync::mpsc::channel();
                    self.monitor_stop_tx = Some(stop_tx);
                    let event_tx = self.event_tx.clone();
                    std::thread::spawn(move || {
                        if let Err(e) = wait_for_ports(ports, event_tx, stop_rx) {
                            eprintln!("Port monitor exited with error: {}", e);
                        }
                    });
                }
            }

            let data = ControlResponseData::StartGdbServer {
                pid: self.process.as_ref().unwrap().id(),
            };
            ControlResponse::success(msg.seq, Some(data))
                .send(&self.writer)
                .unwrap_or_else(|e| {
                    eprintln!("Failed to send success response: {}", e);
                    self.exit = true;
                });
        } else {
            eprintln!(
                "BUG: handle_start_gdb_server called with wrong request type: {:?}",
                msg.request
            );
            ControlResponse::error(msg.seq, "Internal error: wrong handler".to_string())
                .send(&self.writer)
                .ok();
        }
    }

    pub(super) fn spawn_port_waiters(
        &mut self,
        ports: Vec<(u8, u16)>,
        keep_open: bool,
        msg_seq: u64,
    ) {
        for (stream_id, port) in ports {
            let event_tx = self.event_tx.clone();
            std::thread::spawn(move || {
                let duration = if msg_seq != 0 {
                    Duration::from_millis(30)
                } else {
                    Duration::from_secs(10 * 60)
                };
                match Self::wait_and_connect_sync(port, duration, keep_open) {
                    Ok(WaitPortResult::Ready) => {
                        eprintln!(
                            "Port {} is ready for stream {}, but keep_open is false, not forwarding",
                            port, stream_id
                        );
                        event_tx
                            .send(ProxyEvent::PortReady { stream_id, port })
                            .ok();
                    }
                    Ok(WaitPortResult::Stream(tcp_stream)) => {
                        eprintln!(
                            "Connected to stream_id {} port {}, starting forwarding",
                            stream_id, port
                        );
                        let read_stream = tcp_stream.try_clone().expect("Failed to clone stream");
                        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
                        if event_tx
                            .send(ProxyEvent::PortConnected {
                                stream_id,
                                port,
                                stream: tcp_stream,
                                ready_tx,
                                msg_seq,
                            })
                            .is_err()
                        {
                            eprintln!(
                                "Main loop is gone before stream {} registration, aborting forwarder",
                                stream_id
                            );
                            return;
                        }
                        if ready_rx.recv_timeout(Duration::from_secs(2)).is_err() {
                            eprintln!(
                                "Timed out waiting for stream {} registration; not starting forwarder",
                                stream_id
                            );
                            return;
                        }
                        // Small delay to ensure the proxy client thread has fully processed
                        // the PortConnected event before we start forwarding data.
                        std::thread::sleep(Duration::from_millis(100));
                        read_and_forward(stream_id, read_stream, event_tx);
                    }
                    Err(e) => {
                        event_tx
                            .send(ProxyEvent::PortFailed {
                                stream_id,
                                port,
                                error: e.to_string(),
                                msg_seq,
                            })
                            .ok();
                    }
                }
            });
        }
    }

    pub(super) fn handle_start_stream(&mut self, stream_id: u8, msg_seq: u64) {
        if let Some(pinfo) = self.streams.get_mut(&stream_id) {
            if pinfo.stream.is_none() {
                let ports = vec![(stream_id, pinfo.port)];
                self.spawn_port_waiters(ports, true, msg_seq);
            } else {
                eprintln!("Stream {} is already connected", stream_id);
            }
        } else {
            eprintln!(
                "Received StartStream for unknown stream_id {}, ignoring",
                stream_id
            );
        }
    }

    pub(super) fn handle_duplicate_stream(&mut self, stream_id: u8, msg_seq: u64) {
        if let Some(pinfo) = self.streams.get_mut(&stream_id) {
            if pinfo.stream.is_some() {
                let port = pinfo.port;
                let cur_stream_id = self.next_stream_id;
                self.next_stream_id += 1;
                self.reserved_ports.push(PortInfoListner {
                    port,
                    stream_id: cur_stream_id,
                    listener: None,
                });
                self.streams.insert(
                    cur_stream_id,
                    PortInfo {
                        port,
                        stream_id: cur_stream_id,
                        stream: None,
                    },
                );
                self.spawn_port_waiters(vec![(cur_stream_id, port)], true, msg_seq);
            } else {
                eprintln!(
                    "Received DuplicateStream for stream_id {} which is not currently connected, ignoring",
                    stream_id
                );
            }
        } else {
            eprintln!(
                "Received DuplicateStream for unknown stream_id {}, ignoring",
                stream_id
            );
        }
    }

    pub(super) fn wait_and_connect_sync(
        port: u16,
        timeout: Duration,
        keep_open: bool,
    ) -> Result<WaitPortResult> {
        eprintln!(
            "Waiting for connection on port {} with timeout {:?}",
            port, timeout
        );
        let deadline = Instant::now() + timeout;
        let mut interval = Duration::from_millis(100);
        let mut once = true;

        while once || Instant::now() < deadline {
            once = false;
            match TcpStream::connect(("127.0.0.1", port)) {
                Ok(stream) => {
                    if keep_open {
                        return Ok(WaitPortResult::Stream(stream));
                    } else {
                        stream.shutdown(std::net::Shutdown::Both).ok();
                        return Ok(WaitPortResult::Ready);
                    }
                }
                Err(_) => {
                    if !keep_open {
                        return Ok(WaitPortResult::Ready);
                    }
                    std::thread::sleep(interval);
                    interval = (interval * 2).min(Duration::from_millis(200));
                }
            }
        }
        eprintln!("Timeout waiting for port {}", port);
        Err(anyhow!("Timeout waiting for port {}", port))
    }

    pub(super) fn handle_sync_file(&mut self, msg: &ControlMessage) {
        if let ControlRequest::SyncFile {
            relative_path,
            content,
        } = &msg.request
        {
            if !is_safe_relative_sync_path(relative_path) {
                let err_msg = format!(
                    "Invalid sync path '{}': must be a safe relative file path under session root",
                    relative_path
                );
                eprintln!("{}", err_msg);
                ControlResponse::error(msg.seq, err_msg)
                    .send(&self.writer)
                    .unwrap_or_else(|e| {
                        eprintln!("Failed to send error response: {}", e);
                        self.exit = true;
                    });
                return;
            }
            let full_path = PathBuf::from(self.server_cwd.clone()).join(relative_path);
            eprintln!(
                "Received SyncFile request for path {} ==> {}, size: {} bytes",
                relative_path,
                full_path.display(),
                content.len()
            );
            create_parent_dirs(full_path.to_str().unwrap());
            match fs::write(full_path.clone(), content) {
                Ok(_) => {
                    ControlResponse::success(msg.seq, None)
                        .send(&self.writer)
                        .unwrap_or_else(|e| {
                            eprintln!("Failed to send success response: {}", e);
                            self.exit = true;
                        });
                }
                Err(e) => {
                    let err_msg = format!(
                        "Failed to write file {} => {}: {}",
                        relative_path,
                        full_path.display(),
                        e
                    );
                    eprintln!("{}", err_msg);
                    ControlResponse::error(msg.seq, err_msg)
                        .send(&self.writer)
                        .unwrap_or_else(|e| {
                            eprintln!("Failed to send error response: {}", e);
                            self.exit = true;
                        });
                }
            }
        } else {
            eprintln!(
                "BUG: handle_sync_file called with wrong request type: {:?}",
                msg.request
            );
            ControlResponse::error(msg.seq, "Internal error: wrong handler".to_string())
                .send(&self.writer)
                .ok();
        }
    }
}
