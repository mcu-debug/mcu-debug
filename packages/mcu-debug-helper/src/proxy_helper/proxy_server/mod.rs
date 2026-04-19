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

//! Proxy server core: struct definition, lifecycle, message loop, dispatch,
//! and shared utilities used by the child modules.

use crate::proxy_helper::run::{PortWaitMode, ProxyArgs};
use crate::serial::port::PortHandle;
use anyhow::Result;
use std::collections::HashMap;
use std::io;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::Child;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};

// IMPORTANT: The `eprintln!` macro override MUST be declared before all `mod`
// statements so that child modules see the redefinition when they `use super::*`.
macro_rules! eprintln {
    ($($arg:tt)*) => {
        log::info!($($arg)*);
    };
}

pub mod protocol;
pub use protocol::*;

mod gdb_server;
mod serial;
pub use serial::{FunnelWriter, SerialPortBacking, SerialPortRegistry};

#[cfg(test)]
mod tests;

// ── Global send mutex ─────────────────────────────────────────────────────────

/// Global mutex to serialise all writes to the control TcpStream so that
/// concurrent threads (port waiters, stdout/stderr forwarders, serial funnel
/// writers) do not interleave Funnel frames.
static STREAM_MUTEX: Mutex<()> = Mutex::new(());

pub const CURRENT_VERSION: &str = "1.0.3";

// ── Low-level framing utility ─────────────────────────────────────────────────

/// Write `bytes` as a single Funnel-protocol frame with the given `stream_id`.
/// Uses [`STREAM_MUTEX`] to guarantee that frames from concurrent writers are
/// never interleaved on the wire.
pub fn send_to_stream(stream_id: u8, stream: &mut TcpStream, bytes: &[u8]) -> io::Result<()> {
    let _lock = STREAM_MUTEX.lock().expect("failed to acquire stream lock");
    let mut header = Vec::with_capacity(5);
    header.push(stream_id);
    header.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
    stream.write_all(&header)?;
    stream.write_all(bytes)?;
    stream.flush()?;
    Ok(())
}

// ── Stream bookkeeping ────────────────────────────────────────────────────────

pub struct PortInfo {
    pub port: u16,
    pub stream_id: u8,
    /// `Some` when the port is currently connected and data is being forwarded.
    stream: Option<TcpStream>,
}

pub struct PortInfoListner {
    pub port: u16,
    pub stream_id: u8,
    #[allow(dead_code)]
    listener: Option<TcpListener>,
}

// ── ProxyServer ───────────────────────────────────────────────────────────────

pub struct ProxyServer {
    args: ProxyArgs,
    stream: TcpStream,
    process: Option<Child>,
    /// Per-stream TCP connections to the gdb-server.
    streams: HashMap<u8, PortInfo>,
    /// Counter for assigning unique dynamic stream IDs (starts at 3; 0–2 are reserved).
    next_stream_id: u8,
    exit: bool,
    /// Ports reserved via `AllocatePorts` but not yet handed to the gdb-server process.
    reserved_ports: Vec<PortInfoListner>,
    /// Unified event channel: every background thread sends `ProxyEvent` here.
    event_rx: Receiver<ProxyEvent>,
    event_tx: Sender<ProxyEvent>,
    server_cwd: String,
    session_port_wait_mode: PortWaitMode,
    monitor_stop_tx: Option<Sender<()>>,
    serial_registry: SerialPortRegistry,
    /// Stream-ID → (port_handle, client_id, path) for inbound funnel frames.
    /// Provides O(1) routing without acquiring the registry lock on every byte.
    serial_funnel_write: HashMap<u8, (Arc<PortHandle>, u64, String)>,
}

impl Drop for ProxyServer {
    /// Last-resort cleanup: kill the gdb-server if it is still running when the
    /// `ProxyServer` is dropped — covers panics, early returns, and any path that
    /// bypasses the normal `end_process()` call.
    fn drop(&mut self) {
        self.end_process();
    }
}

impl ProxyServer {
    pub fn new(args: ProxyArgs, stream: TcpStream, serial_registry: SerialPortRegistry) -> Self {
        let (event_tx, event_rx) = channel();
        let session_port_wait_mode = args.port_wait_mode.clone();
        Self {
            args,
            stream,
            process: None,
            streams: HashMap::new(),
            exit: false,
            reserved_ports: Vec::new(),
            event_rx,
            event_tx,
            next_stream_id: 3,
            server_cwd: String::new(),
            session_port_wait_mode,
            monitor_stop_tx: None,
            serial_registry,
            serial_funnel_write: HashMap::new(),
        }
    }

    pub(super) fn stop_port_monitor(&mut self) {
        if let Some(tx) = self.monitor_stop_tx.take() {
            tx.send(()).ok();
        }
    }

    pub fn end_process(&mut self) {
        self.stop_port_monitor();
        if let Some(child) = &mut self.process {
            let _ = child.kill();
            let _ = child.wait();
            self.process = None;
        }
    }

    pub fn message_loop(&mut self) -> Result<()> {
        // Spawn a dedicated reader thread for the client connection so that the event
        // loop can block on event_rx.recv() and wake up instantly for *any* event
        // (incoming data, port connection, forwarded stream data) without ever blocking
        // on a stream read in the main thread.
        let control_stream = self.stream.try_clone()?;
        let event_tx = self.event_tx.clone();
        std::thread::spawn(move || {
            let mut reader = control_stream;
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => {
                        event_tx.send(ProxyEvent::IncomingClosed).ok();
                        break;
                    }
                    Ok(n) => {
                        if event_tx
                            .send(ProxyEvent::IncomingData(buf[..n].to_vec()))
                            .is_err()
                        {
                            break; // main thread exited
                        }
                    }
                    Err(e) => {
                        eprintln!("Control stream read error: {}", e);
                        event_tx.send(ProxyEvent::IncomingClosed).ok();
                        break;
                    }
                }
            }
        });

        let mut content_length: Option<u32> = None;
        let mut stream_id = 0u8;
        let mut all_bytes: Vec<u8> = Vec::new();

        loop {
            let event = match self.event_rx.recv() {
                Ok(e) => e,
                Err(_) => break, // all senders dropped
            };
            match event {
                ProxyEvent::IncomingClosed => {
                    eprintln!("Client connection closed");
                    self.end_process();
                    break;
                }
                ProxyEvent::IncomingData(bytes) => {
                    all_bytes.extend_from_slice(&bytes);
                    while !all_bytes.is_empty() {
                        if content_length.is_none() {
                            if all_bytes.len() >= 5 {
                                stream_id = all_bytes[0];
                                content_length =
                                    Some(u32::from_le_bytes(all_bytes[1..5].try_into().unwrap()));
                                all_bytes.drain(..5);
                            } else {
                                break; // wait for more bytes
                            }
                        } else if content_length.unwrap() as usize <= all_bytes.len() {
                            let msg_len = content_length.unwrap() as usize;
                            let msg = all_bytes[..msg_len].to_vec();
                            if stream_id == 0 {
                                // Control message (JSON)
                                let msg_str = String::from_utf8_lossy(&msg);
                                match serde_json::from_str::<ControlMessage>(&msg_str) {
                                    Ok(control_msg) => {
                                        self.handle_control_message(control_msg);
                                        if self.exit {
                                            eprintln!("Exiting message loop as requested by control message");
                                            return Ok(());
                                        }
                                    }
                                    Err(e) => {
                                        eprintln!("Failed to parse control message: {}", e);
                                    }
                                }
                            } else {
                                // Non-zero stream ID: check serial funnel channels first.
                                if let Some((handle, _, _)) =
                                    self.serial_funnel_write.get(&stream_id)
                                {
                                    // Route incoming bytes from client to the serial port.
                                    if let Err(e) = handle.write_to_port(&msg) {
                                        eprintln!(
                                            "Serial funnel write to port failed for stream {}: {}",
                                            stream_id, e
                                        );
                                    }
                                } else {
                                    // Forward to the appropriate connected stream.
                                    match self.streams.get_mut(&stream_id) {
                                        Some(pinfo) => {
                                            if let Some(stream) = &mut pinfo.stream {
                                                if let Err(e) = stream.write_all(&msg) {
                                                    eprintln!(
                                                        "Stream {} write failed: {}",
                                                        stream_id, e
                                                    );
                                                }
                                            } else {
                                                eprintln!(
                                                    "Stream {} is not currently connected",
                                                    stream_id
                                                );
                                            }
                                        }
                                        None => {
                                            eprintln!(
                                                "Received message for unknown stream ID: {}",
                                                stream_id
                                            );
                                        }
                                    }
                                }
                            }
                            all_bytes.drain(..msg_len);
                            content_length = None;
                        } else {
                            break; // wait for the rest of the message
                        }
                    }
                }
                ProxyEvent::PortConnected {
                    stream_id,
                    port,
                    stream,
                    ready_tx,
                    msg_seq,
                } => {
                    eprintln!("Port {} (stream {}) connected!", port, stream_id);
                    if let Some(pinfo) = self.streams.get_mut(&stream_id) {
                        pinfo.stream = Some(stream);
                    } else {
                        eprintln!(
                            "Internal Error: Received PortConnected for unknown stream_id {}",
                            stream_id
                        );
                        self.streams.insert(
                            stream_id,
                            PortInfo {
                                port,
                                stream_id,
                                stream: Some(stream),
                            },
                        );
                    }
                    // Unblock the waiter thread only after stream registration so that
                    // forwarding cannot start before self.streams is updated.
                    ready_tx.send(()).ok();
                    if msg_seq != 0 {
                        let data = ControlResponseData::StreamStatus {
                            stream_id,
                            status: StreamStatus::Connected,
                            msg_seq,
                        };
                        ControlResponse::success(msg_seq, Some(data))
                            .send(&mut self.stream)
                            .unwrap_or_else(|e| {
                                eprintln!("Failed to send success response: {}", e);
                            });
                    } else {
                        let event = ProxyServerEvents::StreamStarted { stream_id, port };
                        let _ = event.send(&mut self.stream);
                    }
                }
                ProxyEvent::PortReady { stream_id, port } => {
                    eprintln!(
                        "Port {} (stream {}) is ready for connection!",
                        port, stream_id
                    );
                    self.streams.insert(
                        stream_id,
                        PortInfo {
                            port,
                            stream_id,
                            stream: None,
                        },
                    );
                    let event = ProxyServerEvents::StreamReady { stream_id, port };
                    let _ = event.send(&mut self.stream);
                }
                ProxyEvent::PortFailed {
                    stream_id,
                    port,
                    error,
                    msg_seq,
                } => {
                    if msg_seq != 0 {
                        ControlResponse::error(
                            msg_seq,
                            format!(
                                "Failed to connect to port {}, stream-id {}: {}",
                                port, stream_id, error
                            ),
                        )
                        .send(&mut self.stream)
                        .unwrap_or_else(|e| {
                            eprintln!("Failed to send error response: {}", e);
                        });
                    } else {
                        let event = ProxyServerEvents::StreamTimedOut { stream_id };
                        eprintln!("Port {} failed: {} for stream {}", port, error, stream_id);
                        let _ = event.send(&mut self.stream);
                    }
                }
                ProxyEvent::StreamData { stream_id, data } => {
                    send_to_stream(stream_id, &mut self.stream, &data).ok();
                }
                ProxyEvent::StreamClosed { stream_id } => {
                    eprintln!("Stream {} closed", stream_id);
                    self.streams.remove(&stream_id);
                    let event = ProxyServerEvents::StreamClosed { stream_id };
                    let _ = event.send(&mut self.stream);
                }
                ProxyEvent::SerialPortError(err) => {
                    // Port died — remove from registry (drops the backing and fd),
                    // then notify the client so it can update its UI.
                    let removed = self.serial_registry.lock().unwrap().remove(&err.path);
                    if let Some((_, SerialPortBacking::Funnel { stream_id })) = removed {
                        self.serial_funnel_write.remove(&stream_id);
                    }
                    let event = ProxyServerEvents::SerialPortError {
                        path: err.path,
                        kind: err.kind,
                        msg: err.msg,
                    };
                    let _ = event.send(&mut self.stream);
                }
            }
        }
        self.end_process();
        Ok(())
    }

    fn handle_control_message(&mut self, msg: ControlMessage) {
        if msg.seq == 0 {
            ControlResponse::error(
                msg.seq,
                "Received control message with seq=0, which is reserved for server events. Ignoring.".to_string(),
            )
            .send(&mut self.stream)
            .unwrap_or_else(|e| {
                eprintln!("Failed to send error response for invalid seq: {}", e);
            });
            return;
        }
        match msg.request {
            ControlRequest::Initialize { .. } => {
                self.handle_initialize(&msg);
            }
            ControlRequest::AllocatePorts { .. } => {
                self.handle_allocate_ports(&msg);
            }
            ControlRequest::StartGdbServer { .. } => {
                eprintln!("Received StartGdbServer request");
                self.handle_start_gdb_server(&msg);
            }
            ControlRequest::StartStream { stream_id } => {
                eprintln!("Received StartStream request for stream_id {}", stream_id);
                self.handle_start_stream(stream_id, msg.seq);
            }
            ControlRequest::DuplicateStream { stream_id } => {
                eprintln!(
                    "Received DuplicateStream request for stream_id {}",
                    stream_id
                );
                self.handle_duplicate_stream(stream_id, msg.seq);
            }
            ControlRequest::EndSession => {
                eprintln!("Received EndSession request, closing connection");
                // Kill the gdb-server first (blocking wait) so it is already gone
                // by the time the success response reaches the TypeScript side.
                self.end_process();
                ControlResponse::success(msg.seq, None)
                    .send(&mut self.stream)
                    .unwrap_or_else(|e| {
                        eprintln!("Failed to send success response: {}", e);
                    });
                self.stream
                    .shutdown(std::net::Shutdown::Both)
                    .unwrap_or_else(|e| {
                        eprintln!("Failed to shutdown stream: {}", e);
                    });
                self.exit = true;
            }
            ControlRequest::Heartbeat => {
                ControlResponse::success(msg.seq, Some(ControlResponseData::Heartbeat))
                    .send(&mut self.stream)
                    .unwrap_or_else(|e| {
                        eprintln!("Failed to send heartbeat response: {}", e);
                    });
            }
            ControlRequest::StreamStatus { .. } => {
                let status = if let ControlRequest::StreamStatus { stream_id } = &msg.request {
                    if let Some(pinfo) = self.streams.get(stream_id) {
                        if pinfo.stream.is_some() {
                            StreamStatus::Connected
                        } else {
                            StreamStatus::Ready
                        }
                    } else {
                        StreamStatus::NotAvailable
                    }
                } else {
                    StreamStatus::NotAvailable
                };
                let data = ControlResponseData::StreamStatus {
                    stream_id: if let ControlRequest::StreamStatus { stream_id } = &msg.request {
                        *stream_id
                    } else {
                        0
                    },
                    status,
                    msg_seq: msg.seq,
                };
                ControlResponse::success(msg.seq, Some(data))
                    .send(&mut self.stream)
                    .unwrap_or_else(|e| {
                        eprintln!("Failed to send StreamStatus response: {}", e);
                    });
            }
            ControlRequest::SyncFile { .. } => {
                self.handle_sync_file(&msg);
            }
            ControlRequest::SerialOpen(params) => {
                self.handle_serial_open(msg.seq, params);
            }
            ControlRequest::SerialClose { path } => {
                self.handle_serial_close(msg.seq, &path.clone());
            }
            ControlRequest::SerialListOpen => {
                self.handle_serial_list_open(msg.seq);
            }
            ControlRequest::SerialListAvailable => {
                self.handle_serial_list_available(msg.seq);
            }
            ControlRequest::SerialIsOpen { path } => {
                self.handle_serial_is_open(msg.seq, &path.clone());
            }
        }
    }
}

// ── Misc public utilities ─────────────────────────────────────────────────────

/// Check whether a `TcpStream` peer is still connected by peeking 0 bytes.
pub fn is_connected(stream: &TcpStream) -> bool {
    let mut buf = [0u8; 0];
    matches!(stream.peek(&mut buf), Ok(_))
}
