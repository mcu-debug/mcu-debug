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

use crate::common::sync::MutexExt;
use crate::proxy_helper::run::{PortWaitMode, ProxyArgs};
use crate::proxy_helper::serial_available::SerialAvailabilityHub;
use crate::serial::port::PortHandle;
use anyhow::Result;
use std::collections::HashMap;
use std::io;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::Child;
use std::sync::atomic::{AtomicBool, Ordering};
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
pub use serial::{
    force_close_serial, serial_status, FunnelWriter, OpenPort, SerialPortRegistry, SerialStatus,
    CLOSE_ALL_SERIAL,
};

/// Spawn a session-owned background thread that can never die silently.
///
/// The body runs under `catch_unwind`; on **any** exit — normal return, error,
/// or panic — a [`ProxyEvent::SessionThreadExited`] is sent to the event loop.
/// This closes the one hole the singleton Agent can't tolerate: a panicking
/// session thread stranding `message_loop` blocked on `recv()` (the loop always
/// holds a sender, so it would otherwise never wake). See `SessionThreadRole`.
///
/// The panic hook ([`crate::proxy_helper::run`]) has already logged the
/// file/line/backtrace by the time control returns here.
pub(super) fn spawn_session_thread<F>(
    event_tx: &Sender<ProxyEvent>,
    role: SessionThreadRole,
    body: F,
) where
    F: FnOnce() + Send + 'static,
{
    let exit_tx = event_tx.clone();
    std::thread::Builder::new()
        .name(role.thread_name())
        .spawn(move || {
            let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(body)).is_err();
            // Best-effort: if the loop is already gone, this send simply fails.
            let _ = exit_tx.send(ProxyEvent::SessionThreadExited { role, panicked });
        })
        .expect("failed to spawn session thread");
}

#[cfg(test)]
mod tests;

pub const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");

// ── FrameWriter ───────────────────────────────────────────────────────────────

/// Locked writer for the Funnel-protocol client socket.
///
/// All writes to the client `TcpStream` go through this type. The internal
/// `Mutex` ensures that the 5-byte header and the payload are written
/// atomically, regardless of which thread is writing.
///
/// `FrameWriter` is cheaply `Clone`able (it clones the `Arc`, not the socket).
/// Pass a clone to any background thread that needs to write; the same lock
/// will be acquired on every call, preventing interleaving.
#[derive(Clone)]
pub struct FrameWriter {
    stream: Arc<Mutex<TcpStream>>,
}

impl FrameWriter {
    pub fn new(stream: TcpStream) -> Self {
        // Bound how long a write can block the message loop.  If the client is
        // not consuming data (e.g. a stalled VS Code window), writes to the
        // OS send buffer would otherwise block indefinitely and starve
        // `event_rx.recv()`.  Five seconds is generous for a loopback or
        // LAN connection; treat a timeout as a broken connection.
        stream
            .set_write_timeout(Some(std::time::Duration::from_secs(5)))
            .ok();
        Self {
            stream: Arc::new(Mutex::new(stream)),
        }
    }

    /// Write `bytes` as a single Funnel-protocol frame with the given `stream_id`.
    /// Acquires the internal lock for the duration so header + payload are atomic.
    pub fn write_frame(&self, stream_id: u8, bytes: &[u8]) -> io::Result<()> {
        let mut s = self.stream.lock_recover();
        let mut header = Vec::with_capacity(5);
        header.push(stream_id);
        header.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
        s.write_all(&header)?;
        s.write_all(bytes)?;
        s.flush()?;
        Ok(())
    }

    /// Clone the raw `TcpStream` for use as a **read-only** reader in a
    /// background thread. The clone does not go through the write lock because
    /// reads and writes use separate OS-level operations on the same fd.
    pub fn try_clone_stream(&self) -> io::Result<TcpStream> {
        self.stream.lock_recover().try_clone()
    }

    /// Shut down the underlying socket.
    pub fn shutdown(&self, how: std::net::Shutdown) -> io::Result<()> {
        self.stream.lock_recover().shutdown(how)
    }

    /// Return `true` if the peer is still connected (non-blocking 0-byte peek).
    pub fn is_connected(&self) -> bool {
        let s = self.stream.lock_recover();
        let mut buf = [0u8; 0];
        s.peek(&mut buf).is_ok()
    }
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
    writer: FrameWriter,
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
    ///
    /// The handle is **weak** on purpose. The registry is the sole owner of an open
    /// port; if these were strong references, a session's routing entry would keep the
    /// device open after the registry let go — which is exactly what made an
    /// admin-level force-close impossible to implement. A dead weak reference means
    /// the port was closed underneath us, and the entry is dropped on first use.
    serial_funnel_write: HashMap<u8, (std::sync::Weak<PortHandle>, u64, String)>,
    serial_available_hub: Arc<SerialAvailabilityHub>,
    serial_available_sub_id: Option<u64>,
    /// Paths this session already has a `PortErrorEvent` forwarder thread
    /// running for. Prevents `handle_serial_open` from spawning a duplicate
    /// thread + subscription on every reconfigure of an already-open port.
    /// Cleared whenever the underlying `PortHandle` goes away (explicit
    /// close or a fatal port error) so a fresh open resubscribes.
    serial_error_subs: std::collections::HashSet<String>,
    /// Paths this session opened with `transport: "direct"`.
    ///
    /// The TCP bridge is shared by every direct client on a port, so it cannot be
    /// torn down when any one of them closes. This set is the session's share of
    /// that ownership: it holds at most one reference per path, matched by
    /// `OpenPort::direct_refs`, and the bridge goes away when the last session
    /// releases it.
    serial_direct_paths: std::collections::HashSet<String>,
    /// Set by [`ProxyServer::cancel`] on teardown. Polled by the session's
    /// background threads that block on something other than the gdb-server
    /// child (port waiters mid-connect, the serial error forwarder) so they stop
    /// promptly instead of lingering.
    cancel: Arc<AtomicBool>,
}

impl Drop for ProxyServer {
    /// Last-resort cleanup: kill the gdb-server if it is still running when the
    /// `ProxyServer` is dropped — covers panics, early returns, and any path that
    /// bypasses the normal `end_process()` call.
    fn drop(&mut self) {
        self.cancel();
        self.unsubscribe_serial_available();
        // Release this session's serial clients. Without this, a session that ended
        // — cleanly or by crashing — left its funnel writers attached to the shared
        // `PortHandle` and its `Arc` clones holding the device open. That is why a
        // port, once opened, never went away for the life of the proxy.
        self.release_all_serial_ports();
        self.end_process();
    }
}

impl ProxyServer {
    pub fn new(
        args: ProxyArgs,
        stream: TcpStream,
        serial_registry: SerialPortRegistry,
        serial_available_hub: Arc<SerialAvailabilityHub>,
    ) -> Self {
        let (event_tx, event_rx) = channel();
        let session_port_wait_mode = args.port_wait_mode;
        Self {
            args,
            writer: FrameWriter::new(stream),
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
            serial_available_hub,
            serial_available_sub_id: None,
            serial_error_subs: std::collections::HashSet::new(),
            serial_direct_paths: std::collections::HashSet::new(),
            cancel: Arc::new(AtomicBool::new(false)),
        }
    }

    pub(super) fn unsubscribe_serial_available(&mut self) {
        if let Some(sub_id) = self.serial_available_sub_id.take() {
            self.serial_available_hub.unsubscribe(sub_id);
        }
    }

    pub(super) fn stop_port_monitor(&mut self) {
        if let Some(tx) = self.monitor_stop_tx.take() {
            tx.send(()).ok();
        }
    }

    /// Prompt session teardown for threads that block on something *other* than
    /// the gdb-server child (which [`end_process`](Self::end_process) already
    /// reaps, unblocking the stdout/stderr forwarders). Sets the cancel flag the
    /// port waiters and serial error forwarder poll, and shuts down the control
    /// socket so the reader's blocked `read` returns at once.
    ///
    /// Called only from `Drop` — **never** from `end_process`, because the
    /// `EndSession` path calls `end_process` and then still needs the control
    /// socket alive to send its success response.
    pub(super) fn cancel(&self) {
        self.cancel.store(true, Ordering::SeqCst);
        // Affects every clone of the underlying socket, so the control reader's
        // blocked `read` on its own clone returns immediately.
        let _ = self.writer.shutdown(std::net::Shutdown::Both);
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
        let control_stream = self.writer.try_clone_stream()?;
        let event_tx = self.event_tx.clone();
        spawn_session_thread(
            &self.event_tx,
            SessionThreadRole::ControlReader,
            move || {
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
                                .send(ProxyEvent::IncomingData(
                                    buf[..n].to_vec(),
                                    std::time::Instant::now(),
                                ))
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
            },
        );

        let mut content_length: Option<u32> = None;
        let mut stream_id = 0u8;
        let mut all_bytes: Vec<u8> = Vec::new();

        // Macro to write to the client socket from within the event loop.
        // Breaks out of the loop on any error (broken pipe, timed-out write, …)
        // so we stop silently dropping frames when the client is gone.
        macro_rules! send_or_break {
            ($expr:expr) => {
                if let Err(e) = $expr {
                    eprintln!("Client socket write failed, closing session: {}", e);
                    break;
                }
            };
        }

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
                ProxyEvent::SessionThreadExited { role, panicked } => {
                    if panicked {
                        eprintln!("Session thread {role:?} panicked (see log)");
                    }
                    if role.is_fatal() {
                        eprintln!("Fatal session thread {role:?} exited — ending session");
                        self.end_process();
                        break;
                    }
                    // Non-fatal: the thread's own clean-exit event (StreamClosed,
                    // PortFailed, …) already handled teardown, or on a panic there
                    // is nothing further to unwind for this role. Noted only.
                }
                ProxyEvent::IncomingData(bytes, queued_at) => {
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
                                        // Control frames only -- stream data (stream_id != 0) is
                                        // serial/gdb traffic and is deliberately not logged per
                                        // packet; at that volume the logging would cost more than
                                        // the forwarding and would perturb what it measures.
                                        let queued = queued_at.elapsed();
                                        // Heartbeats are the one control message that repeats
                                        // forever and says nothing when healthy. At info they
                                        // would bury the requests worth reading; a slow or
                                        // failing one still surfaces through the checks below.
                                        let routine =
                                            control_msg.request.method_name() == "heartbeat";
                                        let level = if routine {
                                            log::Level::Debug
                                        } else {
                                            log::Level::Info
                                        };
                                        log::log!(
                                            level,
                                            "Received request: seq {} '{}' ({} bytes, queued {:?})",
                                            control_msg.seq,
                                            control_msg.request.method_name(),
                                            msg_len,
                                            queued,
                                        );
                                        if queued >= std::time::Duration::from_millis(250) {
                                            log::warn!(
                                                "Message loop was busy: seq {} '{}' waited {:?} before dispatch",
                                                control_msg.seq,
                                                control_msg.request.method_name(),
                                                queued,
                                            );
                                        }
                                        let started = std::time::Instant::now();
                                        let seq = control_msg.seq;
                                        let method = control_msg.request.method_name();
                                        self.handle_control_message(control_msg);
                                        let took = started.elapsed();
                                        log::log!(
                                            if routine
                                                && took < std::time::Duration::from_millis(250)
                                            {
                                                log::Level::Debug
                                            } else {
                                                log::Level::Info
                                            },
                                            "Handled request: seq {} '{}' in {:?}",
                                            seq,
                                            method,
                                            took,
                                        );
                                        if self.exit {
                                            eprintln!("Exiting message loop as requested by control message");
                                            return Ok(());
                                        }
                                    }
                                    Err(e) => {
                                        eprintln!("Failed to parse control message: {}", e);
                                        // Reply with an error keyed by the request's seq so the
                                        // client fails fast with an actionable message instead of
                                        // blocking until its own request timeout. `seq` is a
                                        // top-level field on ControlMessage (the method/params are
                                        // `#[serde(flatten)]`ed), so it still parses even when the
                                        // variant does not — e.g. an enum value with the wrong case.
                                        #[derive(serde::Deserialize)]
                                        struct SeqOnly {
                                            seq: u64,
                                        }
                                        match serde_json::from_str::<SeqOnly>(&msg_str) {
                                            Ok(SeqOnly { seq }) => {
                                                ControlResponse::error(
                                                    seq,
                                                    format!("failed to parse control request: {e}"),
                                                )
                                                .send(&self.writer)
                                                .unwrap_or_else(|send_err| {
                                                    eprintln!(
                                                        "Failed to send parse-error response: {}",
                                                        send_err
                                                    );
                                                });
                                            }
                                            Err(_) => {
                                                // No usable seq to correlate a reply — the client
                                                // will fall back to its own timeout for this one.
                                                eprintln!(
                                                    "Unparseable control message had no usable seq; no error reply sent"
                                                );
                                            }
                                        }
                                    }
                                }
                            } else {
                                // Non-zero stream ID: check serial funnel channels first.
                                if let Some((weak, _, _)) =
                                    self.serial_funnel_write.get(&stream_id)
                                {
                                    // Route incoming bytes from client to the serial port.
                                    // Upgrading can fail: the port may have been closed
                                    // by an admin force-close (or a fatal port error)
                                    // while this client was still writing to it.
                                    match weak.upgrade() {
                                        Some(handle) => {
                                            if let Err(e) = handle.write_to_port(&msg) {
                                                eprintln!(
                                                    "Serial funnel write to port failed for stream {}: {}",
                                                    stream_id, e
                                                );
                                            }
                                        }
                                        None => {
                                            eprintln!(
                                                "Serial funnel stream {} refers to a closed port; dropping its routing entry",
                                                stream_id
                                            );
                                            self.serial_funnel_write.remove(&stream_id);
                                        }
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
                    // Same write-timeout policy as the client socket: bound how
                    // long a stalled gdb-server can hold up the message loop.
                    stream
                        .set_write_timeout(Some(std::time::Duration::from_secs(5)))
                        .ok();
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
                        send_or_break!(
                            ControlResponse::success(msg_seq, Some(data)).send(&self.writer)
                        );
                    } else {
                        let event = ProxyServerEvents::StreamStarted { stream_id, port };
                        send_or_break!(event.send(&self.writer));
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
                    send_or_break!(event.send(&self.writer));
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
                        .send(&self.writer)
                        .unwrap_or_else(|e| {
                            eprintln!("Failed to send error response: {}", e);
                        });
                    } else {
                        let event = ProxyServerEvents::StreamTimedOut { stream_id };
                        eprintln!("Port {} failed: {} for stream {}", port, error, stream_id);
                        send_or_break!(event.send(&self.writer));
                    }
                }
                ProxyEvent::StreamData { stream_id, data } => {
                    send_or_break!(self.writer.write_frame(stream_id, &data));
                }
                ProxyEvent::StreamClosed { stream_id } => {
                    eprintln!("Stream {} closed", stream_id);
                    self.streams.remove(&stream_id);
                    let event = ProxyServerEvents::StreamClosed { stream_id };
                    send_or_break!(event.send(&self.writer));
                }
                ProxyEvent::SerialPortError(err) => {
                    // Port died — remove from registry (drops the backing and fd),
                    // then notify the client so it can update its UI.
                    let removed = self.serial_registry.lock_recover().remove(&err.path);
                    if let Some(open) = removed {
                        // Drop the inbound routing for every channel on this port, not
                        // just the most recent one — a stale entry would keep an
                        // `Arc<PortHandle>` alive for a device that is already gone.
                        for stream_id in open.funnel.keys() {
                            self.serial_funnel_write.remove(stream_id);
                        }
                    }
                    // The port is gone, so this session no longer holds a direct
                    // reference to it. Leaving it set would make a later close look
                    // like it still had something to release.
                    self.serial_direct_paths.remove(&err.path);
                    // Allow a future successful open of this path to resubscribe —
                    // the PortHandle it would subscribe to is a brand new instance.
                    self.serial_error_subs.remove(&err.path);
                    let event = ProxyServerEvents::SerialPortError {
                        path: err.path,
                        kind: err.kind,
                        msg: err.msg,
                    };
                    send_or_break!(event.send(&self.writer));
                }
                ProxyEvent::SerialAvailableChanged { revision, ports } => {
                    let port_count = ports.len();
                    let sub_id = self.serial_available_sub_id;
                    eprintln!(
                        "Dequeued serial.availableChanged proxy event (revision {}, ports {}, sub_id={:?}, thread={:?})",
                        revision,
                        port_count,
                        sub_id,
                        std::thread::current().id()
                    );
                    let event = ProxyServerEvents::SerialAvailableChanged { revision, ports };
                    send_or_break!(event.send(&self.writer));
                    eprintln!(
                        "Sent serial.availableChanged event (revision {}, ports {})",
                        revision, port_count
                    );
                }
            }
        }
        self.unsubscribe_serial_available();
        self.end_process();
        Ok(())
    }

    fn handle_control_message(&mut self, msg: ControlMessage) {
        if msg.seq == 0 {
            ControlResponse::error(
                msg.seq,
                "Received control message with seq=0, which is reserved for server events. Ignoring.".to_string(),
            )
            .send(&self.writer)
            .unwrap_or_else(|e| {
                eprintln!("Failed to send error response for invalid seq: {}", e);
                self.exit = true;
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
                    .send(&self.writer)
                    .unwrap_or_else(|e| {
                        eprintln!("Failed to send success response: {}", e);
                    });
                self.writer
                    .shutdown(std::net::Shutdown::Both)
                    .unwrap_or_else(|e| {
                        eprintln!("Failed to shutdown stream: {}", e);
                    });
                self.exit = true;
            }
            ControlRequest::Heartbeat => {
                ControlResponse::success(msg.seq, Some(ControlResponseData::Heartbeat))
                    .send(&self.writer)
                    .unwrap_or_else(|e| {
                        eprintln!("Failed to send heartbeat response: {}", e);
                        self.exit = true;
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
                    .send(&self.writer)
                    .unwrap_or_else(|e| {
                        eprintln!("Failed to send StreamStatus response: {}", e);
                        self.exit = true;
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
            ControlRequest::SerialSubscribeAvailable => {
                self.handle_serial_subscribe_available(msg.seq);
            }
            ControlRequest::SerialUnsubscribeAvailable => {
                self.handle_serial_unsubscribe_available(msg.seq);
            }
        }
    }
}
