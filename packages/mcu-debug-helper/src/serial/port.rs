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
//! - **Reader thread**: Continuously reads from the serial device. Pushes bytes
//!   into the ring buffer and forwards to all attached client writers. Exits
//!   when `shutdown` flag is set or on an unrecoverable I/O error.
//! - **Caller thread(s)**: Call [`PortHandle::reconfigure`], [`PortHandle::attach_client`],
//!   [`PortHandle::detach_client`], [`PortHandle::snapshot`], and [`PortHandle::close`].
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
//! Callers should call [`PortHandle::snapshot`] before [`PortHandle::attach_client`]
//! to get buffered history, then stream live. There is a small (nanosecond-scale)
//! race window between the two calls during which a handful of bytes may be
//! pushed by the reader thread without being sent to the new client. For a
//! UART terminal this is acceptable.

use std::collections::HashMap;
use std::io::Write;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};
use std::thread::JoinHandle;
use std::time::Duration;

use anyhow::{Context as _, Result};

use crate::serial::ring::RingBuffer;
use crate::serial::run_serial::{FlowControl, Parity, StopBits};

// ── OpenParams ───────────────────────────────────────────────────────────────

/// Parameters to open or reconfigure a serial port.
///
/// Reuses [`StopBits`], [`Parity`], and [`FlowControl`] from `run_serial`
/// (they carry the `From` impls into `serialport` types). These will move to
/// a shared location when `run_serial.rs` is deleted in Step 8b.
#[derive(Debug, Clone)]
pub struct OpenParams {
    pub path: String,
    pub baud_rate: u32,
    pub data_bits: u8,
    pub stop_bits: StopBits,
    pub parity: Parity,
    pub flow_control: FlowControl,
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
    params: &OpenParams,
    read_timeout: Duration,
) -> Result<Box<dyn serialport::SerialPort>> {
    serialport::new(&params.path, params.baud_rate)
        .data_bits(data_bits_to_serial(params.data_bits))
        .stop_bits(params.stop_bits.into())
        .parity(params.parity.into())
        .flow_control(params.flow_control.into())
        .timeout(read_timeout)
        .open()
        .with_context(|| format!("failed to open serial port '{}'", params.path))
}

/// Apply all reconfigurable settings to an already-open serial port.
fn apply_params(port: &mut Box<dyn serialport::SerialPort>, params: &OpenParams) -> Result<()> {
    port.set_baud_rate(params.baud_rate)
        .context("set_baud_rate")?;
    port.set_data_bits(data_bits_to_serial(params.data_bits))
        .context("set_data_bits")?;
    port.set_stop_bits(params.stop_bits.into())
        .context("set_stop_bits")?;
    port.set_parity(params.parity.into())
        .context("set_parity")?;
    port.set_flow_control(params.flow_control.into())
        .context("set_flow_control")?;
    Ok(())
}

// ── Shared (reader ↔ handle) ─────────────────────────────────────────────────

/// State shared between the [`PortHandle`] on the caller side and the reader thread.
struct Shared {
    ring: RingBuffer,
    /// Active client writers. Keyed by caller-assigned ID (see [`PortHandle::next_client_id`]).
    /// The reader thread locks this to forward bytes; callers lock it to add/remove writers.
    clients: Mutex<HashMap<u64, Box<dyn Write + Send>>>,
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
    /// Clone kept for in-place reconfigure. Shares the fd with the reader thread.
    config_port: Mutex<Box<dyn serialport::SerialPort>>,
    shared: Arc<Shared>,
    shutdown: Arc<AtomicBool>,
    reader_thread: Mutex<Option<JoinHandle<()>>>,
    next_id: AtomicU64,
}

impl PortHandle {
    /// Open the serial device and start the always-on reader thread.
    ///
    /// Returns `Err` if the device cannot be opened (not found, permission
    /// denied, bad params). The error is suitable for returning directly as a
    /// `serial.open` response error.
    pub fn open(params: OpenParams) -> Result<Self> {
        // Short read timeout so the reader thread can notice the shutdown flag
        // promptly even when no serial data is arriving.
        let read_timeout = Duration::from_millis(100);

        // Open twice: reader_port goes to the thread; config_port stays here.
        let reader_port = open_port(&params, read_timeout)?;
        let config_port = reader_port
            .try_clone()
            .with_context(|| format!("failed to clone serial port '{}'", params.path))?;

        let shared = Arc::new(Shared {
            ring: RingBuffer::new(),
            clients: Mutex::new(HashMap::new()),
        });
        let shutdown = Arc::new(AtomicBool::new(false));

        let reader_thread = Self::spawn_reader(
            params.path.clone(),
            reader_port,
            Arc::clone(&shared),
            Arc::clone(&shutdown),
        );

        Ok(PortHandle {
            path: params.path,
            config_port: Mutex::new(config_port),
            shared,
            shutdown,
            reader_thread: Mutex::new(Some(reader_thread)),
            next_id: AtomicU64::new(1),
        })
    }

    /// Reconfigure the port in place (no close/reopen, attached clients stay connected).
    ///
    /// The new settings take effect on the reader thread's very next read because
    /// both `config_port` and the reader's clone share the same underlying fd.
    pub fn reconfigure(&self, params: &OpenParams) -> Result<()> {
        let mut port = self.config_port.lock().unwrap();
        apply_params(&mut port, params)
            .with_context(|| format!("reconfigure failed for '{}'", self.path))
    }

    /// Allocate a fresh client ID. The caller passes this to [`attach_client`]
    /// and [`detach_client`].
    pub fn next_client_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    /// Register `writer` to receive live serial bytes going forward.
    ///
    /// Call [`snapshot`] first to get buffered history, write it to the
    /// same destination, then call this to start receiving live data.
    /// See the module-level note about the acceptable race window.
    pub fn attach_client(&self, id: u64, writer: Box<dyn Write + Send>) {
        self.shared.clients.lock().unwrap().insert(id, writer);
    }

    /// Remove a previously registered client writer.
    ///
    /// Silently does nothing if `id` is not found (already removed by the
    /// reader thread after a write failure, or double-detach).
    pub fn detach_client(&self, id: u64) {
        self.shared.clients.lock().unwrap().remove(&id);
    }

    /// Return a copy of all buffered bytes in FIFO order (oldest first).
    ///
    /// Call this before [`attach_client`] to implement late-attach catch-up.
    pub fn snapshot(&self) -> Vec<u8> {
        self.shared.ring.snapshot()
    }

    /// Stop the reader thread and release the serial device.
    ///
    /// This is also called automatically on [`Drop`]. Calling `close` explicitly
    /// lets callers check for join errors; `Drop` silently discards them.
    pub fn close(&self) {
        self.shutdown.store(true, Ordering::Relaxed);
        if let Some(t) = self.reader_thread.lock().unwrap().take() {
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
    ) -> JoinHandle<()> {
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                if shutdown.load(Ordering::Relaxed) {
                    break;
                }
                match reader_port.read(&mut buf) {
                    Ok(0) => {
                        // EOF — unusual for a serial port; treat as unrecoverable.
                        log::warn!("[{path}] serial port returned EOF");
                        break;
                    }
                    Ok(n) => {
                        let bytes = &buf[..n];

                        // 1. Push into ring (late-attach catch-up).
                        shared.ring.push(bytes);

                        // 2. Forward to all live clients; remove any whose write fails
                        //    (TCP disconnect). `retain` drops the writer on removal,
                        //    which closes the TcpStream clone.
                        let mut clients = shared.clients.lock().unwrap();
                        clients.retain(|_id, writer| writer.write_all(bytes).is_ok());
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
                        // TODO Step 9: emit `serial.event` port_error to control channel.
                        break;
                    }
                }
            }
            log::info!("[{path}] reader thread exiting");
            // reader_port drops here → one fd reference released.
        })
    }
}

impl Drop for PortHandle {
    fn drop(&mut self) {
        self.close();
        // config_port Mutex drops here → second (last) fd reference released.
    }
}
