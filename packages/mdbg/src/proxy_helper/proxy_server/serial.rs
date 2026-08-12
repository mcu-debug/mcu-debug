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
use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::common::sync::MutexExt;
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

/// One open serial port and every transport currently attached to it.
///
/// Transports are not exclusive. `PortHandle` already fans out to N clients through
/// `attach_client`, which takes any `Write` — a `TcpStream` for direct, a
/// [`FunnelWriter`] for funnel — and its reader thread cannot tell them apart. The
/// old model stored a single backing per port and rejected a second transport as a
/// conflict, but the exclusivity was bookkeeping, not a property of the data path.
///
/// It was also wrong for funnel alone: re-opening a funnel port deliberately
/// allocates a *new* channel (client reconnect), and the single-backing entry
/// overwrote the previous `stream_id`. Closing then detached only the most recent
/// client and left the others attached and receiving — with their `Arc<PortHandle>`
/// clones keeping the device open, so the port never actually closed.
pub struct OpenPort {
    pub handle: Arc<PortHandle>,
    /// The direct-transport bridge, if a client has asked for one. At most one per
    /// port: it is a TCP listener, and a second would be another door to the same
    /// room. Additional direct clients are served by the same bridge.
    pub direct: Option<TcpBridge>,
    /// How many sessions asked for direct transport on this port. The bridge is
    /// shared, so it can only be torn down once the last of them has closed —
    /// counting is the only way to know when that is.
    pub direct_refs: usize,
    /// Funnel channels on this port: `stream_id` -> `PortHandle` client id. Many,
    /// because every funnel client — and every reconnect — gets its own channel.
    pub funnel: HashMap<u8, u64>,
}

impl OpenPort {
    fn new(handle: Arc<PortHandle>) -> Self {
        OpenPort {
            handle,
            direct: None,
            direct_refs: 0,
            funnel: HashMap::new(),
        }
    }

    /// No client is using this port any more, so the device can be released.
    pub fn is_idle(&self) -> bool {
        port_is_idle(self.direct_refs, &self.funnel)
    }

    /// Port for direct clients to connect to, if a bridge is up.
    fn tcp_port(&self) -> Option<u16> {
        self.direct.as_ref().map(|b| b.tcp_port)
    }

    /// Funnel stream IDs, in a stable order so responses do not shuffle between calls.
    fn channel_ids(&self) -> Vec<u8> {
        sorted_channel_ids(&self.funnel)
    }
}

/// Whether a port with these counts has any client left.
///
/// Free function rather than only a method so it is testable: building an `OpenPort`
/// needs an `Arc<PortHandle>`, which needs a real serial device.
fn port_is_idle(direct_refs: usize, funnel: &HashMap<u8, u64>) -> bool {
    direct_refs == 0 && funnel.is_empty()
}

/// Ascending stream IDs from a port's funnel map.
///
/// Free function rather than only a method so it is testable: building an `OpenPort`
/// needs an `Arc<PortHandle>`, which needs a real serial device.
fn sorted_channel_ids(funnel: &HashMap<u8, u64>) -> Vec<u8> {
    let mut ids: Vec<u8> = funnel.keys().copied().collect();
    ids.sort_unstable();
    ids
}

/// Registry of open serial ports shared across all `ProxyServer` sessions in
/// one proxy process. Keyed by port path (e.g. `/dev/ttyUSB0` or `COM3`).
/// Dropping an entry closes the port and every transport attached to it.
pub type SerialPortRegistry = Arc<Mutex<HashMap<String, OpenPort>>>;

/// Force-close serial ports regardless of who is using them.
///
/// This is the operator escape hatch behind `mdbg proxy --close-serial`. Normal
/// `serial.close` is cooperative and per-client, so a wedged or crashed-but-not-yet
/// reaped client can pin a device open indefinitely; nothing else can take it.
///
/// `path` selects one port, or [`CLOSE_ALL_SERIAL`] for every open port. Returns the
/// paths actually closed.
///
/// Sessions still holding routing entries for these ports are *not* notified. They do
/// not need to be: their `serial_funnel_write` entries are weak, so removing the
/// registry entry here really does release the device, and each session drops its own
/// stale entry the next time a client writes to it.
pub fn force_close_serial(registry: &SerialPortRegistry, path: &str) -> Vec<String> {
    // Take the entries out under the lock, then do the expensive teardown outside it:
    // dropping an `OpenPort` joins the TCP bridge's accept thread and closes the
    // device, and holding the registry lock through that would stall every session.
    let retired: Vec<(String, OpenPort)> = {
        let mut reg = registry.lock_recover();
        if path == CLOSE_ALL_SERIAL {
            reg.drain().collect()
        } else {
            reg.remove_entry(path).into_iter().collect()
        }
    };

    let mut closed = Vec::with_capacity(retired.len());
    for (path, open) in retired {
        // Detach every client first so their writers stop being handed bytes, rather
        // than letting them discover the closure through a write error.
        for client_id in open.funnel.values() {
            open.handle.detach_client(*client_id);
        }
        log::info!(
            "Force-closed serial port '{}' ({} funnel channel(s), {} direct ref(s))",
            path,
            open.funnel.len(),
            open.direct_refs
        );
        closed.push(path);
        drop(open);
    }
    closed.sort();
    closed
}

/// Sentinel `path` for [`force_close_serial`] meaning "every open port".
///
/// A magic value rather than the existing `--all` flag, which already means "every
/// proxy *instance*" for `--shutdown`. Keeping them separate lets the two compose:
/// `--close-serial all --all` is every port on every instance.
pub const CLOSE_ALL_SERIAL: &str = "all";

/// Snapshot of one open port for `--status`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SerialStatus {
    pub path: String,
    /// TCP port of the direct bridge, if one is up.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tcp_port: Option<u16>,
    /// Sessions holding a direct reference.
    pub direct_refs: usize,
    /// Funnel channels attached.
    pub channels: usize,
    /// Total attached client sinks, across both transports. Larger than `channels`
    /// when direct clients are connected to the bridge.
    pub clients: usize,
}

/// Open-port snapshot for `--status`, sorted by path so output is stable.
pub fn serial_status(registry: &SerialPortRegistry) -> Vec<SerialStatus> {
    let mut ports: Vec<SerialStatus> = registry
        .lock_recover()
        .iter()
        .map(|(path, open)| SerialStatus {
            path: path.clone(),
            tcp_port: open.tcp_port(),
            direct_refs: open.direct_refs,
            channels: open.funnel.len(),
            clients: open.handle.client_count(),
        })
        .collect();
    ports.sort_by(|a, b| a.path.cmp(&b.path));
    ports
}

/// Outcome of a session releasing its hold on a port.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Released {
    /// This session had nothing open on that path.
    NothingHeld,
    /// Released, but other clients are still using the port.
    StillOpen,
    /// This was the last client — the device was closed.
    PortClosed,
}

// ── Serial handlers on ProxyServer ───────────────────────────────────────────

impl ProxyServer {
    /// `serial.open` — open a port (or reconfigure it if already open) and attach a
    /// transport channel.
    ///
    /// Transports are additive: a port already carrying funnel channels will happily
    /// take a direct bridge as well, and vice versa. Direct is idempotent (all direct
    /// clients share one bridge); funnel allocates a fresh channel per call, so a
    /// reconnecting client gets its own.
    pub(super) fn handle_serial_open(&mut self, seq: u64, params: SerialParams) {
        // This runs on the single-threaded message loop, so anything slow here stalls
        // every other control request behind it. Phase timings are recorded so a stall
        // can be attributed rather than guessed at; see the summary at the end.
        let t_start = std::time::Instant::now();
        let t_resolved = std::cell::Cell::new(Duration::ZERO);
        let t_locked = std::cell::Cell::new(Duration::ZERO);
        let t_reconfigured = std::cell::Cell::new(Duration::ZERO);
        let was_already_open = std::cell::Cell::new(false);

        let path = match crate::serial::resolve_port(
            params.path.as_deref(),
            params.serial.as_deref(),
            params.vid.as_deref(),
            params.pid.as_deref(),
            params.r#match.as_deref(),
            true,
        ) {
            Ok(p) => p,
            Err(e) => {
                // Time this path too: a resolve that is both slow *and* failing would
                // otherwise be invisible, and it is a prime suspect for a stalled loop.
                let elapsed = t_start.elapsed();
                if elapsed >= Duration::from_millis(250) {
                    log::warn!(
                        "serial.open SLOW: seq {} failed to resolve after {:?}",
                        seq,
                        elapsed
                    );
                }
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

        t_resolved.set(t_start.elapsed());

        // Whether this session already holds a direct reference on this path. Read
        // before taking the registry lock so the closure below borrows only the
        // registry field. A session takes at most one reference per path no matter
        // how many times it re-opens.
        let session_holds_direct = self.serial_direct_paths.contains(&path);

        let phase1: Phase1Result = (|| {
            let mut reg = self.serial_registry.lock_recover();
            t_locked.set(t_start.elapsed());
            if let Some(open) = reg.get_mut(&path) {
                was_already_open.set(true);

                // A second client brings its own line settings, and `reconfigure`
                // applies them to the one shared device — so an IDE session at 115200
                // and a CLI monitor at 9600 will fight over the UART. This is not
                // blocked, because re-opening with new settings is exactly how the UI
                // changes baud rate on a live port and there is no way to tell the two
                // apart here. It is logged instead: the symptom is garbled output in
                // the *other* client, which is otherwise very hard to attribute.
                if open.handle.settings_differ(&params) {
                    let attached = open.handle.client_count();
                    if attached > 0 {
                        log::warn!(
                            "serial.open: reconfiguring '{}' while {} client(s) are attached — their line settings change too",
                            path,
                            attached
                        );
                    }
                }
                if let Err(e) = open.handle.reconfigure(&params) {
                    return Phase1Result::Error(e);
                }
                t_reconfigured.set(t_start.elapsed());

                // Transports are additive. Whichever one this client asked for is
                // attached alongside whatever is already there.
                match params.transport {
                    SerialTransport::Direct => {
                        let tcp_port = match open.tcp_port() {
                            // A bridge is already listening — direct clients share it.
                            Some(tcp_port) => tcp_port,
                            None => {
                                let bridge = match TcpBridge::start(
                                    "127.0.0.1",
                                    0,
                                    Arc::clone(&open.handle),
                                ) {
                                    Ok(b) => b,
                                    Err(e) => return Phase1Result::Error(e),
                                };
                                let tcp_port = bridge.tcp_port;
                                open.direct = Some(bridge);
                                tcp_port
                            }
                        };
                        if !session_holds_direct {
                            open.direct_refs += 1;
                        }
                        Phase1Result::DirectReady(tcp_port)
                    }
                    // Every funnel open gets its own channel, including a reconnect.
                    SerialTransport::Funnel => Phase1Result::FunnelHandle(Arc::clone(&open.handle)),
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
                        let mut open = OpenPort::new(new_handle);
                        open.direct = Some(bridge);
                        open.direct_refs = 1;
                        reg.insert(path.clone(), open);
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
            Phase1Result::DirectReady(tcp_port) => {
                // Record the reference the registry just counted, so this session's
                // close (or teardown) releases exactly the one it took.
                self.serial_direct_paths.insert(path.clone());
                Ok((Some(tcp_port), None))
            }
            Phase1Result::FunnelHandle(handle) => self
                .alloc_funnel_channel(&path, &handle)
                .map(|cid| (None, Some(cid))),
            Phase1Result::Error(e) => Err(e),
        };

        // Attribute the elapsed time to a phase. Each figure is cumulative from entry,
        // so the phase that owns a stall is the one with the large step before it. A
        // zero for lock/reconfigure means that phase was never reached.
        let total = t_start.elapsed();
        let timings = format!(
            "seq {} '{}' total={:?} (resolve={:?} lock=+{:?} reconfigure=+{:?} phase2=+{:?})",
            seq,
            path,
            total,
            t_resolved.get(),
            t_locked.get().saturating_sub(t_resolved.get()),
            t_reconfigured.get().saturating_sub(t_locked.get()),
            total.saturating_sub(t_reconfigured.get().max(t_locked.get())),
        );
        // A first open legitimately costs hundreds of milliseconds: the device is
        // opened, a second handle taken for reconfiguration, and the TCP bridge started.
        // A re-open of an already-open port should be almost free -- it looks the port
        // up and returns the existing tcp_port. Holding both to the same threshold would
        // either cry wolf on every session start or stay silent on a real regression.
        let budget = if was_already_open.get() {
            Duration::from_millis(100)
        } else {
            Duration::from_millis(2000)
        };
        if total >= budget {
            log::warn!(
                "serial.open SLOW ({} budget {:?}): {}",
                if was_already_open.get() {
                    "re-open"
                } else {
                    "first open"
                },
                budget,
                timings
            );
        } else {
            log::debug!("serial.open timing: {}", timings);
        }

        // Subscribe to fatal port errors — once per path per session. Without
        // this guard, every reconfigure of an already-open port (e.g. a UI
        // baud-rate change) would spawn another forwarder thread and push
        // another dead-forever `Sender` into the port's `error_subs`.
        if result.is_ok() && self.serial_error_subs.insert(path.clone()) {
            let (err_tx, err_rx) = mpsc::channel::<PortErrorEvent>();
            {
                let reg = self.serial_registry.lock_recover();
                if let Some(open) = reg.get(&path) {
                    open.handle.subscribe_errors(err_tx);
                }
            }
            let proxy_tx = self.event_tx.clone();
            let cancel = self.cancel.clone();
            spawn_session_thread(
                &self.event_tx,
                SessionThreadRole::SerialErrorForwarder,
                move || {
                    // `recv_timeout` (not `recv`) so the thread also polls the
                    // cancel flag and exits promptly on teardown, instead of
                    // blocking forever on an `err_tx` that lives in the shared,
                    // longer-lived `PortHandle`.
                    loop {
                        match err_rx.recv_timeout(Duration::from_millis(250)) {
                            Ok(e) => {
                                if proxy_tx.send(ProxyEvent::SerialPortError(e)).is_err() {
                                    break;
                                }
                            }
                            Err(mpsc::RecvTimeoutError::Timeout) => {
                                if cancel.load(Ordering::Relaxed) {
                                    break;
                                }
                            }
                            Err(mpsc::RecvTimeoutError::Disconnected) => break,
                        }
                    }
                },
            );
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

    /// Allocate a Funnel stream ID, attach a [`FunnelWriter`] to the port handle
    /// (which seeds the ring snapshot for late-attach catch-up), register the
    /// inbound routing entry, and update (or insert) the registry backing.
    ///
    /// Caller **must not** hold the registry lock — this method takes the lock
    /// itself to update the backing.
    fn alloc_funnel_channel(&mut self, path: &str, handle: &Arc<PortHandle>) -> anyhow::Result<u8> {
        let channel_id = self.next_stream_id;
        self.next_stream_id += 1;

        // Attach a FunnelWriter for the serial→client direction. `attach_client`
        // seeds the ring snapshot into the client's queue atomically with going
        // live, so late-attach catch-up is exactly-once — the snapshot and all
        // live bytes reach the client in order through this one FunnelWriter, with
        // none lost or duplicated. (No separate snapshot frame is sent here.)
        let client_id = handle.next_client_id();
        handle.attach_client(
            client_id,
            Box::new(FunnelWriter {
                stream_id: channel_id,
                event_tx: self.event_tx.clone(),
            }),
        );

        // Register the client→serial routing entry for inbound funnel frames. Weak, so
        // this entry never keeps the device alive past the registry's ownership.
        self.serial_funnel_write.insert(
            channel_id,
            (Arc::downgrade(handle), client_id, path.to_string()),
        );

        // Record the channel. This *adds* to the port's channel set rather than
        // replacing it: the previous version overwrote a single stored `stream_id`, so
        // a second funnel client made the first invisible to close and to listOpen.
        self.serial_registry
            .lock_recover()
            .entry(path.to_string())
            .or_insert_with(|| OpenPort::new(Arc::clone(handle)))
            .funnel
            .insert(channel_id, client_id);

        Ok(channel_id)
    }

    /// `serial.close` — release **this session's** hold on a port.
    ///
    /// Closing is per-client, not per-port. A session detaches its own funnel channels
    /// and drops its direct reference; other sessions keep running untouched. The
    /// device itself is closed only when the last client of any kind lets go.
    ///
    /// This used to evict the port for everyone, which was both too blunt (one window
    /// closing killed another's live view) and unreachable as advice — the protocol
    /// has no way to name "my" transport, so a client told to "close it first" could
    /// only close it for all.
    pub(super) fn handle_serial_close(&mut self, seq: u64, path: &str) {
        match self.release_serial_port(path) {
            Released::NothingHeld => {
                ControlResponse::error(
                    seq,
                    format!("serial.close: '{path}' is not open by this session"),
                )
                .send(&self.writer)
                .unwrap_or_else(|e| {
                    eprintln!("Failed to send serial.close error: {e}");
                    self.exit = true;
                });
            }
            _ => {
                ControlResponse::success(seq, Some(ControlResponseData::SerialClose))
                    .send(&self.writer)
                    .unwrap_or_else(|e| {
                        eprintln!("Failed to send serial.close response: {e}");
                        self.exit = true;
                    });
            }
        }
    }

    /// Release every serial port this session holds. Called from `Drop`, so a session
    /// that ends — cleanly, or by panicking — does not strand its clients on the
    /// shared `PortHandle`.
    pub(super) fn release_all_serial_ports(&mut self) {
        // Collect first: `release_serial_port` mutates both maps as it goes.
        let mut paths: std::collections::HashSet<String> = self.serial_direct_paths.clone();
        for (_, _, path) in self.serial_funnel_write.values() {
            paths.insert(path.clone());
        }
        for path in paths {
            if matches!(self.release_serial_port(&path), Released::PortClosed) {
                log::info!("Session teardown closed serial port '{path}' (last client)");
            }
        }
    }

    /// What releasing a session's hold on a port did.
    ///
    /// The caller needs the distinction: nothing held is a client error on an explicit
    /// close, but is unremarkable during teardown.
    fn release_serial_port(&mut self, path: &str) -> Released {
        // This session's funnel channels on this path. Other sessions' channels live
        // in *their* `serial_funnel_write`, so they are untouched by construction.
        let my_channels: Vec<u8> = self
            .serial_funnel_write
            .iter()
            .filter(|(_, (_, _, p))| p == path)
            .map(|(stream_id, _)| *stream_id)
            .collect();
        let had_direct = self.serial_direct_paths.remove(path);

        if my_channels.is_empty() && !had_direct {
            return Released::NothingHeld;
        }

        // Anything whose Drop does real work (joining the bridge's accept thread,
        // closing the device) is moved out here and dropped after the registry lock is
        // released — dropping it inline would stall every other session's serial
        // request behind a thread join.
        let mut retired_bridge: Option<TcpBridge> = None;
        let mut retired_port: Option<OpenPort> = None;

        {
            let mut reg = self.serial_registry.lock_recover();
            if let Some(open) = reg.get_mut(path) {
                for stream_id in &my_channels {
                    if let Some((weak, client_id, _)) = self.serial_funnel_write.remove(stream_id) {
                        // A dead weak reference just means the port is already gone;
                        // there is nothing left to detach from.
                        if let Some(handle) = weak.upgrade() {
                            handle.detach_client(client_id);
                        }
                    }
                    open.funnel.remove(stream_id);
                }
                if had_direct {
                    open.direct_refs = open.direct_refs.saturating_sub(1);
                    if open.direct_refs == 0 {
                        // No session wants direct any more; the shared listener goes.
                        retired_bridge = open.direct.take();
                    }
                }
                if open.is_idle() {
                    retired_port = reg.remove(path);
                }
            } else {
                // The port is gone from under us (a fatal port error removed it).
                // Still drop our routing entries so nothing keeps the handle alive.
                for stream_id in &my_channels {
                    self.serial_funnel_write.remove(stream_id);
                }
            }
        }

        let closed = retired_port.is_some();
        // Explicit, so the ordering above is not lost to a later refactor.
        drop(retired_bridge);
        drop(retired_port);

        if closed {
            // The next open of this path gets a brand new PortHandle, so this session
            // must be allowed to resubscribe to its errors.
            self.serial_error_subs.remove(path);
            Released::PortClosed
        } else {
            Released::StillOpen
        }
    }

    /// `serial.listOpen` — return current config + transport info for every open port.
    pub(super) fn handle_serial_list_open(&mut self, seq: u64) {
        let reg = self.serial_registry.lock_recover();
        let ports: Vec<SerialPortInfo> = reg
            .values()
            .map(|open| SerialPortInfo {
                params: open.handle.params.lock_recover().clone(),
                tcp_port: open.tcp_port(),
                channel_ids: open.channel_ids(),
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
        let ports: Vec<AvailablePort> = crate::serial::list_available(true);
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
        let reg = self.serial_registry.lock_recover();
        let (is_open, tcp_port, channel_ids, params) = if let Some(open) = reg.get(path) {
            let p = open.handle.params.lock_recover().clone();
            (true, open.tcp_port(), open.channel_ids(), Some(p))
        } else {
            (false, None, Vec::new(), None)
        };
        drop(reg);
        let data = ControlResponseData::SerialIsOpen {
            open: is_open,
            tcp_port,
            channel_ids,
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

#[cfg(test)]
mod tests {
    use super::*;

    /// `serial.listOpen` and `serial.isOpen` document their channel list as ascending.
    /// `HashMap` iteration order is deliberately unspecified (and randomized per
    /// process), so without the sort the same port would report its channels in a
    /// different order on consecutive calls and a client diffing the two would see
    /// phantom changes.
    #[test]
    fn channel_ids_are_reported_in_ascending_order() {
        let mut funnel: HashMap<u8, u64> = HashMap::new();
        // Inserted out of order, and stream ids are not contiguous: a port picks up
        // channels as clients arrive and lets them go as clients leave.
        for (stream_id, client_id) in [(9u8, 40u64), (2, 10), (7, 30), (4, 20)] {
            funnel.insert(stream_id, client_id);
        }

        assert_eq!(sorted_channel_ids(&funnel), vec![2, 4, 7, 9]);
    }

    #[test]
    fn a_port_with_no_funnel_clients_reports_no_channels() {
        // The direct-only case: a port can be open with a TCP bridge and zero funnel
        // channels, which must serialize as an empty list rather than being absent.
        assert!(sorted_channel_ids(&HashMap::new()).is_empty());
    }

    /// Force-close on an empty registry must be a benign no-op, not an error.
    ///
    /// `--close-serial <path>` asks for the port to end up closed. If nothing matches,
    /// the caller's goal already holds, so this reports "closed nothing" rather than
    /// failing — otherwise every script would have to special-case the benign outcome.
    #[test]
    fn force_closing_an_unknown_port_closes_nothing() {
        let registry: SerialPortRegistry = Arc::new(Mutex::new(HashMap::new()));

        assert!(force_close_serial(&registry, "/dev/nonexistent").is_empty());
        // The "all" sentinel on an empty registry is equally uneventful.
        assert!(force_close_serial(&registry, CLOSE_ALL_SERIAL).is_empty());
        assert!(serial_status(&registry).is_empty());
    }

    /// The `all` sentinel must be a distinct value from any plausible device path, so
    /// that selecting every port can never be confused with selecting one.
    #[test]
    fn the_close_all_sentinel_is_not_a_device_path() {
        assert_eq!(CLOSE_ALL_SERIAL, "all");
        // Real paths are absolute on unix and COM<n> on Windows; neither collides.
        for path in ["/dev/ttyUSB0", "/dev/tty.usbmodem1234", "COM3", "COM12"] {
            assert_ne!(path, CLOSE_ALL_SERIAL);
        }
    }

    /// The release arithmetic, exercised without a device.
    ///
    /// `is_idle` is what decides whether a `serial.close` merely detaches one client or
    /// actually releases the hardware, so the boundary cases matter: a port must not be
    /// declared idle while *either* kind of client remains, and must be declared idle
    /// the moment the last one of either kind goes.
    ///
    /// This mirrors the field manipulation in `release_serial_port` rather than calling
    /// it, because that method needs a `ProxyServer` and an `Arc<PortHandle>` — and a
    /// `PortHandle` needs a real serial device.
    #[test]
    fn a_port_is_idle_only_when_both_kinds_of_client_are_gone() {
        let idle = port_is_idle;
        let mut funnel: HashMap<u8, u64> = HashMap::new();

        // Two sessions on direct, one on funnel.
        let mut direct_refs = 2usize;
        funnel.insert(5, 100);
        assert!(!idle(direct_refs, &funnel));

        // The funnel client leaves: direct sessions still hold the port.
        funnel.remove(&5);
        assert!(!idle(direct_refs, &funnel), "direct refs still outstanding");

        // One direct session closes. The bridge is shared, so it must survive.
        direct_refs = direct_refs.saturating_sub(1);
        assert!(!idle(direct_refs, &funnel), "one direct session remains");

        // The last one closes — now the device can go.
        direct_refs = direct_refs.saturating_sub(1);
        assert!(idle(direct_refs, &funnel));

        // Releasing more times than were taken must not wrap around to a huge count,
        // which would pin the port open forever.
        direct_refs = direct_refs.saturating_sub(1);
        assert_eq!(direct_refs, 0);
        assert!(idle(direct_refs, &funnel));
    }
}
