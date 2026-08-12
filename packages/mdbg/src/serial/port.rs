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

//! Per-port serial handle.
//!
//! One [`PortHandle`] per open serial port. The port is opened once and held
//! open for the program lifetime — independent of whether any TCP client is
//! attached. This is what fixes the "boot banner lost" problem.
//!
//! ## Thread model
//!
//! - **Reader thread**: Continuously reads from the serial device. Under the
//!   `clients` lock it pushes bytes into the ring buffer and fans them out to
//!   each attached client's bounded queue. Exits when the `shutdown` flag is set
//!   or on an unrecoverable I/O error.
//! - **Caller thread(s)**: Call [`PortHandle::reconfigure`], [`PortHandle::attach_client`],
//!   [`PortHandle::detach_client`], and [`PortHandle::close`].
//!
//! ## Reconfigure
//!
//! [`PortHandle::reconfigure`] calls the individual `set_*` methods on a
//! `try_clone()` of the port. Since both clones share the same file descriptor,
//! the change takes effect immediately on the reader thread's next read, with
//! no restart and no disconnect of attached clients.
//!
//! ## Late-attach catch-up
//!
//! [`PortHandle::attach_client`] seeds the ring snapshot into the new client's
//! queue as its first item, atomically with going live — both the seed and the
//! reader's push+fan-out happen under the `clients` lock. Catch-up is therefore
//! **exactly-once**: every buffered and live byte reaches the client, in order,
//! with none lost between snapshot and attach and none duplicated.

use std::collections::HashMap;
use std::io::Write;
use std::sync::mpsc::{sync_channel, Sender, SyncSender, TrySendError};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};
use std::thread::JoinHandle;
use std::time::Duration;

use anyhow::{Context as _, Result};

use crate::common::sync::MutexExt;
use crate::serial::ring::RingBuffer;

// ── Serial error types ───────────────────────────────────────────────────────

/// Classification of a post-open fatal serial error.
///
/// Sent as part of a `serial.portError` async event. Client code branches on
/// this value; `msg` in [`PortErrorEvent`] is human-readable only.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "serial-helper/")]
pub enum SerialErrorKind {
    /// Device was physically removed (USB-serial unplugged, cable pulled).
    Disconnected,
    /// Generic I/O failure (hardware error, cable issue).
    IoError,
    /// Permission revoked after open (unusual, but possible).
    PermissionLost,
    /// Configured read timeout exceeded in a context where it is fatal.
    Timeout,
}

/// Payload carried by the reader-thread error channel to interested [`ProxyServer`] sessions.
///
/// One of these is sent when the reader thread exits due to an unrecoverable error.
/// [`ProxyServer`] converts it into a `serial.portError` async event on the control stream.
#[derive(Debug, Clone)]
pub struct PortErrorEvent {
    pub path: String,
    pub kind: SerialErrorKind,
    pub msg: String,
}

// ── Serial parameter types ────────────────────────────────────────────────────

/// Stop-bit count — mirrors `serialport::StopBits` but is JSON-serializable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "serial-helper/")]
pub enum StopBits {
    One,
    /// Note: the `serialport` crate has no 1.5 stop bits; falls back to `One`.
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

impl From<StopBits> for serialport::StopBits {
    fn from(s: StopBits) -> Self {
        match s {
            StopBits::One => serialport::StopBits::One,
            StopBits::OnePointFive => serialport::StopBits::One,
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

/// Transport channel the client uses to receive serial bytes.
///
/// Supplied in `serial.open` requests. Returned in `serial.listOpen` and
/// `serial.isOpen` responses to describe how the port is currently connected.
#[derive(Default, Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "serial-helper/")]
pub enum SerialTransport {
    /// Server opens a TCP listener; client connects to the returned `tcp_port`.
    #[default]
    Direct,
    /// Bytes are framed in the Funnel protocol on the existing proxy control
    /// connection; client demuxes the returned `channel_id` stream.
    Funnel,
}

// ── SerialParams ─────────────────────────────────────────────────────────────

/// Parameters to open or reconfigure a serial port.
///
/// Specify the device via `path` (direct path or glob), `serial` (USB serial
/// number), or `vid`/`pid` (USB vendor/product IDs in hex, e.g. `"0x0483"`).
/// `serial` is the most stable identifier in lab environments with multiple
/// boards. All baud/framing fields default to 115200 8N1 no flow control.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "serial-helper/")]
pub struct SerialParams {
    /// Direct device path or glob (e.g. `/dev/ttyUSB0`, `/dev/tty.usbserial-*`, `COM3`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// Case-insensitive substring matched against a port's enumerated `description`
    /// (e.g. `"STM32 STLink"`). A *selector*, not a label.
    ///
    /// Named `match` rather than `description` because the two were previously the same
    /// word for opposite roles: this is a pattern the caller supplies to choose a port,
    /// while [`AvailablePort::description`] is text the OS reports about a port it found.
    /// `r#match` is the raw identifier for the `match` keyword; the wire name is plain
    /// `match`.
    #[serde(rename = "match", default, skip_serializing_if = "Option::is_none")]
    pub r#match: Option<String>,
    /// USB serial number. Stable across reconnects and reboots.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub serial: Option<String>,
    /// USB vendor ID in hex (e.g. `"0x0483"`). Used with `pid` when `serial` is unavailable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vid: Option<String>,
    /// USB product ID in hex (e.g. `"0x374b"`). Used with `vid` when `serial` is unavailable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<String>,
    #[serde(default = "default_baud_rate")]
    pub baud_rate: u32,
    #[serde(default = "default_data_bits")]
    pub data_bits: u8,
    #[serde(default = "default_stop_bits")]
    pub stop_bits: StopBits,
    #[serde(default = "default_parity")]
    pub parity: Parity,
    #[serde(default = "default_flow_control")]
    pub flow_control: FlowControl,
    /// Transport used to open this port. Defaults to `direct` so that existing
    /// callers that do not set this field get the original TCP-bridge behaviour.
    #[serde(default)]
    pub transport: SerialTransport,
    /// Optional frontend-only serial logging path. Kept in schema so generated
    /// TypeScript stays in sync with UI usage.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub log_file: Option<String>,
    /// Optional frontend-only terminal input mode hint.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_mode: Option<String>,
    /// Optional frontend-only label for the serial port. Kept in schema so generated
    /// TypeScript stays in sync with UI usage.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
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

// ── helpers ──────────────────────────────────────────────────────────────────

fn data_bits_to_serial(n: u8) -> serialport::DataBits {
    match n {
        5 => serialport::DataBits::Five,
        6 => serialport::DataBits::Six,
        7 => serialport::DataBits::Seven,
        _ => serialport::DataBits::Eight,
    }
}

/// Open a serial port with the given parameters and read timeout.
fn open_port(
    path: &str,
    params: &SerialParams,
    read_timeout: Duration,
) -> Result<Box<dyn serialport::SerialPort>> {
    serialport::new(path, params.baud_rate)
        .data_bits(data_bits_to_serial(params.data_bits))
        .stop_bits(params.stop_bits.into())
        .parity(params.parity.into())
        .flow_control(params.flow_control.into())
        .timeout(read_timeout)
        .open()
        .with_context(|| format!("failed to open serial port '{}'", path))
}

/// The subset of [`SerialParams`] that is actually programmed into the UART. The
/// rest (`label`, `log_file`, transport, selectors) never reaches the driver, so a
/// change to any of them must not trigger the expensive work below.
fn line_settings_equal(a: &SerialParams, b: &SerialParams) -> bool {
    a.baud_rate == b.baud_rate
        && a.data_bits == b.data_bits
        && a.stop_bits == b.stop_bits
        && a.parity == b.parity
        && a.flow_control == b.flow_control
}

/// Reprogram only the line settings that differ from `current`.
///
/// Each setter is a `GetCommState`+`SetCommState` pair on Windows, and on a USB CDC
/// device — especially a composite one like KitProg3, where the CDC function shares
/// the USB pipe with debug traffic — each pair round-trips to the device. All five
/// setters measured 3.37s on real hardware, on the single-threaded message loop.
/// Only settings that genuinely changed are worth that.
///
/// A freshly opened port is configured by the `serialport` builder in [`open_port`],
/// not here, so there is always a known current state to compare against.
fn apply_params(
    port: &mut Box<dyn serialport::SerialPort>,
    params: &SerialParams,
    current: &SerialParams,
) -> Result<()> {
    if current.baud_rate != params.baud_rate {
        port.set_baud_rate(params.baud_rate)
            .context("set_baud_rate")?;
    }
    if current.data_bits != params.data_bits {
        port.set_data_bits(data_bits_to_serial(params.data_bits))
            .context("set_data_bits")?;
    }
    if current.stop_bits != params.stop_bits {
        port.set_stop_bits(params.stop_bits.into())
            .context("set_stop_bits")?;
    }
    if current.parity != params.parity {
        port.set_parity(params.parity.into())
            .context("set_parity")?;
    }
    if current.flow_control != params.flow_control {
        port.set_flow_control(params.flow_control.into())
            .context("set_flow_control")?;
    }
    Ok(())
}

// ── Shared (reader ↔ handle) ─────────────────────────────────────────────────

/// Max serial chunks buffered per attached client before it is considered too
/// slow and disconnected. Bounds memory so one stalled client cannot grow the
/// process heap without limit — the reader broadcast is `try_send`, never a
/// blocking send (see `docs-internal/CLI-Proxy-Provisioning.md` §7.3, R6).
/// Chunks are <= the reader's 4 KiB read buffer, so this caps at ~1 MiB/client.
const CLIENT_QUEUE_DEPTH: usize = 256;

/// One attached client's delivery path.
///
/// The reader thread pushes bytes into `tx` (a **bounded, non-blocking**
/// channel) while holding the shared `clients` lock only briefly. A dedicated
/// `drain` thread owns the real `Box<dyn Write>` (a TCP socket) and performs the
/// **blocking** write off that lock, so one slow client cannot stall delivery to
/// the other sessions attached to the same physical port (§7.3, R3).
struct ClientSink {
    tx: SyncSender<Vec<u8>>,
    /// Drain-thread handle. Joined on explicit detach; simply dropped (detached)
    /// when the reader removes a slow/dead client, since that thread is already
    /// exiting and the reader must never block on a join.
    drain: Option<JoinHandle<()>>,
}

/// State shared between the [`PortHandle`] on the caller side and the reader thread.
struct Shared {
    ring: RingBuffer,
    /// Active clients keyed by caller-assigned ID (see [`PortHandle::next_client_id`]).
    /// The reader thread locks this only to `try_send` into each client's queue;
    /// callers lock it to add/remove clients. The blocking socket write happens
    /// in each client's own drain thread, never under this lock.
    clients: Mutex<HashMap<u64, ClientSink>>,
}

// ── PortHandle ────────────────────────────────────────────────────────────────

/// Per-port handle. Holds the serial device open for the program lifetime.
///
/// Construct with [`PortHandle::open`]. Cheaply clonable via [`Arc`] — wrap in
/// `Arc<PortHandle>` when sharing across `ProxyServer` sessions (Step 8).
///
/// Dropping a `PortHandle` sets the shutdown flag and joins the reader thread,
/// releasing the serial file descriptor cleanly.
pub struct PortHandle {
    pub path: String,
    /// The parameters this port was last opened/reconfigured with.
    pub params: Mutex<SerialParams>,
    /// Clone kept for in-place reconfigure. Shares the fd with the reader thread.
    config_port: Mutex<Box<dyn serialport::SerialPort>>,
    shared: Arc<Shared>,
    shutdown: Arc<AtomicBool>,
    reader_thread: Mutex<Option<JoinHandle<()>>>,
    next_id: AtomicU64,
    /// Subscribers notified when the reader thread hits a fatal error.
    /// Each `ProxyServer` session that opens this port registers a sender here.
    /// Dead senders (closed receiver) are pruned automatically on the next error.
    error_subs: Arc<Mutex<Vec<Sender<PortErrorEvent>>>>,
}

impl PortHandle {
    /// Open the serial device and start the always-on reader thread.
    ///
    /// `path` must be a resolved, concrete device path (no glob). Call
    /// [`crate::serial::resolve_port`] first to turn selector fields into a path.
    ///
    /// Returns `Err` if the device cannot be opened (not found, permission
    /// denied, bad params). The error is suitable for returning directly as a
    /// `serial.open` response error.
    pub fn open(path: String, params: SerialParams) -> Result<Self> {
        // Short read timeout so the reader thread can notice the shutdown flag
        // promptly even when no serial data is arriving.
        let read_timeout = Duration::from_millis(100);

        // Open twice: reader_port goes to the thread; config_port stays here.
        let reader_port = open_port(&path, &params, read_timeout)?;
        let config_port = reader_port
            .try_clone()
            .with_context(|| format!("failed to clone serial port '{}'", path))?;

        let shared = Arc::new(Shared {
            ring: RingBuffer::new(),
            clients: Mutex::new(HashMap::new()),
        });
        let shutdown = Arc::new(AtomicBool::new(false));
        let error_subs: Arc<Mutex<Vec<Sender<PortErrorEvent>>>> = Arc::new(Mutex::new(Vec::new()));

        let reader_thread = Self::spawn_reader(
            path.clone(),
            reader_port,
            Arc::clone(&shared),
            Arc::clone(&shutdown),
            Arc::clone(&error_subs),
        );

        Ok(PortHandle {
            path: path.clone(),
            params: Mutex::new(params),
            config_port: Mutex::new(config_port),
            shared,
            shutdown,
            reader_thread: Mutex::new(Some(reader_thread)),
            next_id: AtomicU64::new(1),
            error_subs,
        })
    }

    /// Reconfigure the port in place (no close/reopen, attached clients stay connected).
    ///
    /// The new settings take effect on the reader thread's very next read because
    /// both `config_port` and the reader's clone share the same underlying fd.
    pub fn reconfigure(&self, params: &SerialParams) -> Result<()> {
        // A re-open of an already-open port arrives here with the same settings it
        // was opened with, and this is called from the single-threaded message loop.
        // Reprogramming a UART to the values it already holds cost 3.37s of blocked
        // loop on real hardware, so an unchanged request must do no I/O at all.
        {
            let current = self.params.lock_recover();
            if line_settings_equal(&current, params) {
                drop(current);
                *self.params.lock_recover() = params.clone();
                return Ok(());
            }
        }

        let mut port = self.config_port.lock_recover();
        let current = self.params.lock_recover().clone();
        apply_params(&mut port, params, &current)
            .with_context(|| format!("reconfigure failed for '{}'", self.path))?;
        drop(port);
        *self.params.lock_recover() = params.clone();
        Ok(())
    }

    /// Allocate a fresh client ID. The caller passes this to [`attach_client`]
    /// and [`detach_client`].
    pub fn next_client_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    /// How many clients are currently attached, across every transport.
    ///
    /// Used to warn when one client's `serial.open` is about to reprogram a device
    /// that others are already reading — see `handle_serial_open`.
    pub fn client_count(&self) -> usize {
        self.shared.clients.lock_recover().len()
    }

    /// Whether `params` would actually change the line settings, i.e. whether a
    /// [`reconfigure`](Self::reconfigure) with it would touch the device.
    pub fn settings_differ(&self, params: &SerialParams) -> bool {
        !line_settings_equal(&self.params.lock_recover(), params)
    }

    /// Attach a client to receive serial bytes, seeded with buffered history.
    ///
    /// The ring snapshot is placed as the **first** item in the client's queue,
    /// atomically with going live: the snapshot is taken and the client inserted
    /// while holding the `clients` lock — the very lock the reader holds for its
    /// push+fan-out. So no live byte can slip into the queue ahead of the seeded
    /// history, and none is lost in between. Catch-up is exactly-once and in
    /// order. The caller does **not** pre-send history — `writer` receives
    /// history then live data through this one path.
    pub fn attach_client(&self, id: u64, mut writer: Box<dyn Write + Send>) {
        // Bounded queue + dedicated drain thread: the reader never blocks on this
        // client's socket, and a client that falls `CLIENT_QUEUE_DEPTH` chunks
        // behind is disconnected (by the reader) rather than growing memory.
        let (tx, rx) = sync_channel::<Vec<u8>>(CLIENT_QUEUE_DEPTH);
        let drain = std::thread::Builder::new()
            .name(format!("serial-drain-{id}"))
            .spawn(move || {
                // Own the writer here; the blocking socket write is off the
                // shared `clients` lock. Exit when `tx` is dropped (detach or a
                // slow-client disconnect) or the write fails (client gone).
                while let Ok(chunk) = rx.recv() {
                    if writer.write_all(&chunk).is_err() {
                        break;
                    }
                }
            })
            .expect("spawn serial drain thread");

        // Hold `clients` (blocking the reader's push+fan-out) while we snapshot
        // and insert, so the seeded history precedes any live byte and nothing
        // is missed in the gap. The sink is not yet in the map, so this first
        // send into its fresh CLIENT_QUEUE_DEPTH-slot channel cannot be `Full`.
        let mut clients = self.shared.clients.lock_recover();
        let history = self.shared.ring.snapshot();
        if !history.is_empty() {
            let _ = tx.try_send(history);
        }
        clients.insert(
            id,
            ClientSink {
                tx,
                drain: Some(drain),
            },
        );
    }

    /// Remove a previously registered client.
    ///
    /// Silently does nothing if `id` is not found (already removed by the
    /// reader thread after a write failure/slow disconnect, or double-detach).
    pub fn detach_client(&self, id: u64) {
        // Take the sink out under the lock, then release the lock *before*
        // joining so a stalled drain thread can't hold up other sessions.
        let removed = self.shared.clients.lock_recover().remove(&id);
        if let Some(sink) = removed {
            drop(sink.tx); // unblock the drain thread's recv()
            if let Some(handle) = sink.drain {
                let _ = handle.join();
            }
        }
    }

    /// Write bytes from a TCP client into the serial port (TCP → serial direction).
    ///
    /// Uses `config_port`, which shares the fd with the reader thread's clone.
    /// Multiple callers are safe because `config_port` is behind a `Mutex`.
    pub fn write_to_port(&self, bytes: &[u8]) -> Result<()> {
        self.config_port
            .lock_recover()
            .write_all(bytes)
            .with_context(|| format!("write to serial port '{}' failed", self.path))
    }

    /// Register a sender to receive fatal port errors from the reader thread.
    ///
    /// Each [`ProxyServer`] session that opens or adopts this port calls this
    /// once. When the reader thread hits an unrecoverable error it sends a
    /// [`PortErrorEvent`] to all registered subscribers and prunes dead ones.
    pub fn subscribe_errors(&self, tx: Sender<PortErrorEvent>) {
        self.error_subs.lock_recover().push(tx);
    }

    /// Stop the reader thread and release the serial device.
    ///
    /// This is also called automatically on [`Drop`]. Calling `close` explicitly
    /// lets callers check for join errors; `Drop` silently discards them.
    pub fn close(&self) {
        self.shutdown.store(true, Ordering::Relaxed);
        if let Some(t) = self.reader_thread.lock_recover().take() {
            let _ = t.join();
        }
        // config_port drops when PortHandle is dropped, closing the last fd reference.
    }

    // ── private ───────────────────────────────────────────────────────────────

    fn spawn_reader(
        path: String,
        mut reader_port: Box<dyn serialport::SerialPort>,
        shared: Arc<Shared>,
        shutdown: Arc<AtomicBool>,
        error_subs: Arc<Mutex<Vec<Sender<PortErrorEvent>>>>,
    ) -> JoinHandle<()> {
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                if shutdown.load(Ordering::Relaxed) {
                    break;
                }
                match reader_port.read(&mut buf) {
                    Ok(0) => {
                        // EOF — unusual for a serial port; treat as device removed.
                        log::warn!("[{path}] serial port returned EOF");
                        notify_error(
                            &error_subs,
                            PortErrorEvent {
                                path: path.clone(),
                                kind: SerialErrorKind::Disconnected,
                                msg: "EOF on serial port (device disconnected?)".to_string(),
                            },
                        );
                        break;
                    }
                    Ok(n) => {
                        let bytes = &buf[..n];

                        // Push into the ring AND fan out to every client's queue as
                        // one step under the `clients` lock. A client attaching
                        // concurrently seeds its queue from the ring under this same
                        // lock (see `attach_client`), so making push+fan-out atomic
                        // is what guarantees every byte lands in exactly one of
                        // {seeded snapshot, live queue} — never lost, never dup'd.
                        //
                        // `try_send` only — never a blocking write — so the lock is
                        // held briefly and no slow client stalls the others. Drop a
                        // client whose queue is full (too slow) or whose drain thread
                        // has exited (write failed); both mean "gone". Dropping the
                        // `ClientSink` closes `tx`, so its drain thread and socket
                        // clone wind down on their own.
                        let mut clients = shared.clients.lock_recover();
                        shared.ring.push(bytes);
                        clients.retain(|_id, sink| {
                            !matches!(
                                sink.tx.try_send(bytes.to_vec()),
                                Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_))
                            )
                        });
                    }
                    Err(e)
                        if e.kind() == std::io::ErrorKind::TimedOut
                            || e.kind() == std::io::ErrorKind::WouldBlock =>
                    {
                        // Normal poll tick — no data yet. Loop and check shutdown.
                        continue;
                    }
                    Err(e) => {
                        log::warn!("[{path}] serial read error: {e}");
                        notify_error(
                            &error_subs,
                            PortErrorEvent {
                                path: path.clone(),
                                kind: classify_io_error(&e),
                                msg: e.to_string(),
                            },
                        );
                        break;
                    }
                }
            }
            log::info!("[{path}] reader thread exiting");
            // reader_port drops here → one fd reference released.
        })
    }
}

// ── reader-thread helpers ────────────────────────────────────────────────────

/// Classify a `std::io::Error` from a serial read into a [`SerialErrorKind`].
fn classify_io_error(e: &std::io::Error) -> SerialErrorKind {
    match e.kind() {
        std::io::ErrorKind::BrokenPipe
        | std::io::ErrorKind::NotConnected
        | std::io::ErrorKind::ConnectionReset
        | std::io::ErrorKind::ConnectionAborted => SerialErrorKind::Disconnected,
        std::io::ErrorKind::PermissionDenied => SerialErrorKind::PermissionLost,
        std::io::ErrorKind::TimedOut => SerialErrorKind::Timeout,
        _ => SerialErrorKind::IoError,
    }
}

/// Send `event` to all registered subscribers, pruning any whose channel has closed.
fn notify_error(subs: &Mutex<Vec<Sender<PortErrorEvent>>>, event: PortErrorEvent) {
    let mut guard = subs.lock_recover();
    guard.retain(|tx| tx.send(event.clone()).is_ok());
}

impl Drop for PortHandle {
    fn drop(&mut self) {
        self.close();
        // config_port Mutex drops here → second (last) fd reference released.
    }
}

#[cfg(test)]
mod line_settings_tests {
    use super::*;

    fn params() -> SerialParams {
        SerialParams {
            path: Some("COM3".into()),
            r#match: None,
            serial: None,
            vid: None,
            pid: None,
            baud_rate: 115200,
            data_bits: 8,
            stop_bits: StopBits::One,
            parity: Parity::None,
            flow_control: FlowControl::None,
            transport: SerialTransport::default(),
            log_file: None,
            input_mode: None,
            label: None,
        }
    }

    /// The re-open case: an already-open port is asked to open again with the very
    /// same settings. Reprogramming the UART there cost 3.37s of blocked message
    /// loop, so this must be recognised as a no-op.
    #[test]
    fn identical_params_need_no_reprogramming() {
        assert!(line_settings_equal(&params(), &params()));
    }

    #[test]
    fn each_line_setting_is_detected() {
        let base = params();

        let mut p = params();
        p.baud_rate = 9600;
        assert!(!line_settings_equal(&base, &p), "baud_rate");

        let mut p = params();
        p.data_bits = 7;
        assert!(!line_settings_equal(&base, &p), "data_bits");

        let mut p = params();
        p.stop_bits = StopBits::Two;
        assert!(!line_settings_equal(&base, &p), "stop_bits");

        let mut p = params();
        p.parity = Parity::Even;
        assert!(!line_settings_equal(&base, &p), "parity");

        let mut p = params();
        p.flow_control = FlowControl::Hardware;
        assert!(!line_settings_equal(&base, &p), "flow_control");
    }

    /// Fields that never reach the driver must not trigger device I/O.
    #[test]
    fn non_line_fields_do_not_force_reprogramming() {
        let base = params();

        let mut p = params();
        p.label = Some("my board".into());
        assert!(line_settings_equal(&base, &p), "label");

        let mut p = params();
        p.log_file = Some("/tmp/serial.log".into());
        assert!(line_settings_equal(&base, &p), "log_file");

        let mut p = params();
        p.r#match = Some("kitprog3".into());
        assert!(line_settings_equal(&base, &p), "match/selector");

        let mut p = params();
        p.input_mode = Some("raw".into());
        assert!(line_settings_equal(&base, &p), "input_mode");
    }
}
