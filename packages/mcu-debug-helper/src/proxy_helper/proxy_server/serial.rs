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

//! Serial-port transport types and `ProxyServer` handler methods for all
//! `serial.*` control requests.

use std::collections::HashMap;
use std::io::Write;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};

use crate::serial::bridge::TcpBridge;
use crate::serial::port::{PortErrorEvent, PortHandle, SerialParams, SerialTransport};
use crate::serial::AvailablePort;

use super::*;

// ── Transport-level types ─────────────────────────────────────────────────────

/// A [`Write`] implementation that frames serial bytes as Funnel protocol
/// packets on the existing proxy control connection, enabling serial-port
/// forwarding without a separate TCP listener or bridge.
pub struct FunnelWriter {
    pub(super) stream_id: u8,
    pub(super) event_tx: mpsc::Sender<ProxyEvent>,
}

impl Write for FunnelWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        // Queue serial bytes to the main proxy event loop so all outbound
        // framing and socket writes happen in one place.
        self.event_tx
            .send(ProxyEvent::StreamData {
                stream_id: self.stream_id,
                data: buf.to_vec(),
            })
            .map_err(|_| {
                std::io::Error::new(
                    std::io::ErrorKind::BrokenPipe,
                    "proxy event loop closed while writing funnel data",
                )
            })?;
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// How a serial port's data channel is exposed to the client.
pub enum SerialPortBacking {
    /// A separate TCP listener; client connects to the returned `tcp_port`.
    Direct(TcpBridge),
    /// Bytes are framed in the Funnel protocol on the existing control connection.
    /// `stream_id` is the dynamic stream ID returned to the client as `channel_id`.
    Funnel { stream_id: u8 },
}

/// Registry of open serial ports shared across all `ProxyServer` sessions in
/// one proxy process. Keyed by port path (e.g. `/dev/ttyUSB0` or `COM3`).
/// Dropping an entry closes the port and its transport.
pub type SerialPortRegistry = Arc<Mutex<HashMap<String, (Arc<PortHandle>, SerialPortBacking)>>>;

// ── Serial handlers on ProxyServer ───────────────────────────────────────────

impl ProxyServer {
    /// `serial.open` — open a port (or reconfigure it if already open) and start
    /// a transport channel. Idempotent per transport type. Returns an error if the
    /// port is already open with a *different* transport (close it first).
    pub(super) fn handle_serial_open(&mut self, seq: u64, params: SerialParams) {
        let path = match crate::serial::resolve_port(
            params.path.as_deref(),
            params.serial.as_deref(),
            params.vid.as_deref(),
            params.pid.as_deref(),
        ) {
            Ok(p) => p,
            Err(e) => {
                ControlResponse::error(seq, format!("serial.open failed: {e}"))
                    .send(&self.writer)
                    .unwrap_or_else(|e| {
                        eprintln!("Failed to send serial.open error: {e}");
                        self.exit = true;
                    });
                return;
            }
        };

        // Phase 1 (under registry lock): decide what to do and capture a PortHandle.
        // Direct-transport success is fully resolved here. Funnel returns a handle
        // so phase 2 can allocate the channel outside the lock (it writes to self.stream).
        enum Phase1Result {
            DirectReady(u16),
            FunnelHandle(Arc<PortHandle>),
            Error(anyhow::Error),
        }

        let phase1: Phase1Result = (|| {
            let mut reg = self.serial_registry.lock().unwrap();
            if let Some((handle, backing)) = reg.get(&path) {
                // Port already open — check transport consistency.
                match (&params.transport, backing) {
                    (SerialTransport::Direct, SerialPortBacking::Direct(bridge)) => {
                        if let Err(e) = handle.reconfigure(&params) {
                            return Phase1Result::Error(e);
                        }
                        Phase1Result::DirectReady(bridge.tcp_port)
                    }
                    (SerialTransport::Funnel, SerialPortBacking::Funnel { .. }) => {
                        if let Err(e) = handle.reconfigure(&params) {
                            return Phase1Result::Error(e);
                        }
                        // Allocate a new funnel channel (e.g. client reconnect).
                        Phase1Result::FunnelHandle(Arc::clone(handle))
                    }
                    _ => Phase1Result::Error(anyhow::anyhow!(
                        "port '{}' is already open with a different transport; close it first",
                        path
                    )),
                }
            } else {
                // New port — open the serial device.
                let new_handle = match PortHandle::open(path.clone(), params.clone()) {
                    Ok(h) => Arc::new(h),
                    Err(e) => return Phase1Result::Error(e),
                };
                match params.transport {
                    SerialTransport::Direct => {
                        let bridge = match TcpBridge::start("127.0.0.1", 0, Arc::clone(&new_handle))
                        {
                            Ok(b) => b,
                            Err(e) => return Phase1Result::Error(e),
                        };
                        let tcp_port = bridge.tcp_port;
                        reg.insert(
                            path.clone(),
                            (new_handle, SerialPortBacking::Direct(bridge)),
                        );
                        Phase1Result::DirectReady(tcp_port)
                    }
                    SerialTransport::Funnel => {
                        // Registry insertion happens in alloc_funnel_channel after
                        // successful allocation, so there is no placeholder to clean up
                        // on error.
                        Phase1Result::FunnelHandle(new_handle)
                    }
                }
            }
        })();

        // Phase 2: for funnel, allocate the channel outside the registry lock.
        let result: anyhow::Result<(Option<u16>, Option<u8>)> = match phase1 {
            Phase1Result::DirectReady(tcp_port) => Ok((Some(tcp_port), None)),
            Phase1Result::FunnelHandle(handle) => self
                .alloc_funnel_channel(&path, &handle)
                .map(|cid| (None, Some(cid))),
            Phase1Result::Error(e) => Err(e),
        };

        // Subscribe to fatal port errors (dead senders are pruned automatically).
        if result.is_ok() {
            let (err_tx, err_rx) = mpsc::channel::<PortErrorEvent>();
            {
                let reg = self.serial_registry.lock().unwrap();
                if let Some((handle, _)) = reg.get(&path) {
                    handle.subscribe_errors(err_tx);
                }
            }
            let proxy_tx = self.event_tx.clone();
            std::thread::spawn(move || {
                while let Ok(e) = err_rx.recv() {
                    if proxy_tx.send(ProxyEvent::SerialPortError(e)).is_err() {
                        break;
                    }
                }
            });
        }

        match result {
            Ok((tcp_port, channel_id)) => {
                let data = ControlResponseData::SerialOpen {
                    path,
                    tcp_port,
                    channel_id,
                };
                ControlResponse::success(seq, Some(data))
                    .send(&self.writer)
                    .unwrap_or_else(|e| {
                        eprintln!("Failed to send serial.open response: {}", e);
                        self.exit = true;
                    });
            }
            Err(e) => {
                ControlResponse::error(seq, format!("serial.open failed: {e}"))
                    .send(&self.writer)
                    .unwrap_or_else(|e| {
                        eprintln!("Failed to send serial.open error: {}", e);
                        self.exit = true;
                    });
            }
        }
    }

    /// Allocate a Funnel stream ID, send the ring snapshot for late-attach catch-up,
    /// attach a [`FunnelWriter`] to the port handle, register the inbound routing
    /// entry, and update (or insert) the registry backing.
    ///
    /// Caller **must not** hold the registry lock — this method takes the lock
    /// itself to update the backing, and also writes to `self.stream`.
    fn alloc_funnel_channel(&mut self, path: &str, handle: &Arc<PortHandle>) -> anyhow::Result<u8> {
        let channel_id = self.next_stream_id;
        self.next_stream_id += 1;

        // Late-attach catch-up: send ring snapshot as funnel frames.
        let snapshot = handle.snapshot();
        if !snapshot.is_empty() {
            self.writer
                .write_frame(channel_id, &snapshot)
                .map_err(|e| anyhow::anyhow!("funnel snapshot send failed: {e}"))?;
        }

        // Attach a FunnelWriter for the serial→client direction.
        let client_id = handle.next_client_id();
        handle.attach_client(
            client_id,
            Box::new(FunnelWriter {
                stream_id: channel_id,
                event_tx: self.event_tx.clone(),
            }),
        );

        // Register the client→serial routing entry for inbound funnel frames.
        self.serial_funnel_write.insert(
            channel_id,
            (Arc::clone(handle), client_id, path.to_string()),
        );

        // Update (or insert) the registry entry with the confirmed stream_id.
        self.serial_registry
            .lock()
            .unwrap()
            .entry(path.to_string())
            .and_modify(|(_, b)| {
                *b = SerialPortBacking::Funnel {
                    stream_id: channel_id,
                }
            })
            .or_insert_with(|| {
                (
                    Arc::clone(handle),
                    SerialPortBacking::Funnel {
                        stream_id: channel_id,
                    },
                )
            });

        Ok(channel_id)
    }

    /// `serial.close` — close a previously opened serial port.
    pub(super) fn handle_serial_close(&mut self, seq: u64, path: &str) {
        let removed = self.serial_registry.lock().unwrap().remove(path);
        if let Some((handle, backing)) = removed {
            // If funnel transport, detach the client writer and remove the routing entry.
            if let SerialPortBacking::Funnel { stream_id } = backing {
                if let Some((_, client_id, _)) = self.serial_funnel_write.remove(&stream_id) {
                    handle.detach_client(client_id);
                }
            }
            // For Direct, TcpBridge::drop handles the TCP listener and attached clients.
            ControlResponse::success(seq, Some(ControlResponseData::SerialClose))
                .send(&self.writer)
                .unwrap_or_else(|e| {
                    eprintln!("Failed to send serial.close response: {}", e);
                    self.exit = true;
                });
        } else {
            ControlResponse::error(seq, format!("serial.close: '{}' is not open", path))
                .send(&self.writer)
                .unwrap_or_else(|e| {
                    eprintln!("Failed to send serial.close error: {}", e);
                    self.exit = true;
                });
        }
    }

    /// `serial.listOpen` — return current config + transport info for every open port.
    pub(super) fn handle_serial_list_open(&mut self, seq: u64) {
        let reg = self.serial_registry.lock().unwrap();
        let ports: Vec<SerialPortInfo> = reg
            .values()
            .map(|(handle, backing)| {
                let (tcp_port, channel_id) = match backing {
                    SerialPortBacking::Direct(bridge) => (Some(bridge.tcp_port), None),
                    SerialPortBacking::Funnel { stream_id } => (None, Some(*stream_id)),
                };
                SerialPortInfo {
                    params: handle.params.lock().unwrap().clone(),
                    tcp_port,
                    channel_id,
                }
            })
            .collect();
        drop(reg);
        let data = ControlResponseData::SerialListOpen { ports };
        ControlResponse::success(seq, Some(data))
            .send(&self.writer)
            .unwrap_or_else(|e| {
                eprintln!("Failed to send serial.listOpen response: {}", e);
                self.exit = true;
            });
    }

    /// `serial.listAvailable` — enumerate physical ports on this machine.
    pub(super) fn handle_serial_list_available(&mut self, seq: u64) {
        let ports: Vec<AvailablePort> = crate::serial::list_available();
        let data = ControlResponseData::SerialListAvailable { ports };
        ControlResponse::success(seq, Some(data))
            .send(&self.writer)
            .unwrap_or_else(|e| {
                eprintln!("Failed to send serial.listAvailable response: {}", e);
                self.exit = true;
            });
    }

    /// `serial.isOpen` — pull-based status probe for a single port.
    pub(super) fn handle_serial_is_open(&mut self, seq: u64, path: &str) {
        let reg = self.serial_registry.lock().unwrap();
        let (open, tcp_port, channel_id, params) = if let Some((handle, backing)) = reg.get(path) {
            let p = handle.params.lock().unwrap().clone();
            let (tcp_port, channel_id) = match backing {
                SerialPortBacking::Direct(bridge) => (Some(bridge.tcp_port), None),
                SerialPortBacking::Funnel { stream_id } => (None, Some(*stream_id)),
            };
            (true, tcp_port, channel_id, Some(p))
        } else {
            (false, None, None, None)
        };
        drop(reg);
        let data = ControlResponseData::SerialIsOpen {
            open,
            tcp_port,
            channel_id,
            params,
        };
        ControlResponse::success(seq, Some(data))
            .send(&self.writer)
            .unwrap_or_else(|e| {
                eprintln!("Failed to send serial.isOpen response: {}", e);
                self.exit = true;
            });
    }

    /// `serial.subscribeAvailable` — subscribe this connection to debounced
    /// full-snapshot available-port updates.
    pub(super) fn handle_serial_subscribe_available(&mut self, seq: u64) {
        self.unsubscribe_serial_available();
        let (sub_id, revision, ports) = self.serial_available_hub.subscribe(self.event_tx.clone());
        self.serial_available_sub_id = Some(sub_id);
        eprintln!(
            "serial.subscribeAvailable registered: sub_id={}, thread={:?}",
            sub_id,
            std::thread::current().id()
        );

        ControlResponse::success(
            seq,
            Some(ControlResponseData::SerialSubscribeAvailable { revision }),
        )
        .send(&self.writer)
        .unwrap_or_else(|e| {
            eprintln!("Failed to send serial.subscribeAvailable response: {}", e);
            self.exit = true;
        });

        let port_count = ports.len();
        let event = ProxyServerEvents::SerialAvailableChanged { revision, ports };
        if let Err(e) = event.send(&self.writer) {
            eprintln!(
                "Failed to send initial serial.availableChanged event (revision {}, ports {}): {}",
                revision, port_count, e
            );
        } else {
            eprintln!(
                "Sent initial serial.availableChanged event (revision {}, ports {})",
                revision, port_count
            );
        }
    }

    /// `serial.unsubscribeAvailable` — stop available-port snapshot updates for
    /// this connection.
    pub(super) fn handle_serial_unsubscribe_available(&mut self, seq: u64) {
        self.unsubscribe_serial_available();
        ControlResponse::success(seq, Some(ControlResponseData::SerialUnsubscribeAvailable))
            .send(&self.writer)
            .unwrap_or_else(|e| {
                eprintln!("Failed to send serial.unsubscribeAvailable response: {}", e);
                self.exit = true;
            });
    }
}
