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

//! TCP bridge for `direct` transport.
//!
//! Each open serial port that uses `direct` transport has one [`TcpBridge`].
//! The bridge binds a `TcpListener` once (port assigned at that point) and
//! runs an accept loop in a background thread.
//!
//! ## Per-connection lifecycle
//!
//! For each accepted TCP connection:
//!
//! 1. **Drain**: The ring buffer snapshot is written to the TCP socket first.
//!    Any data the firmware emitted before this client connected is delivered
//!    in order, immediately. This is the "late-attach catch-up" mechanism.
//!
//! 2. **Attach**: The TCP write-half is registered with [`PortHandle`] as a
//!    live client. From this point the reader thread forwards new serial bytes
//!    directly.
//!
//! 3. **TCP→serial thread**: A second thread reads from the TCP socket and
//!    calls [`PortHandle::write_to_port`]. This handles the other direction
//!    (user typing into the terminal, GDB MI output, etc.).
//!
//! 4. **Teardown**: Whichever direction hits an error first calls
//!    `tcp.shutdown(Both)`, which unblocks the other direction's next I/O.
//!    The bridge then calls [`PortHandle::detach_client`] and loops back to
//!    `accept()` — the serial port stays open throughout.
//!
//! ## What does NOT happen here
//!
//! - The serial port is **never** opened or closed in this file. That is
//!   entirely [`PortHandle`]'s responsibility.
//! - There is **no** per-connection port reconfigure. Reconfigure happens via
//!   the control channel (`serial.open` with new params → `PortHandle::reconfigure`).

use std::io::Read;
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::serial::port::PortHandle;

// ── TcpBridge ─────────────────────────────────────────────────────────────────

/// Owns the `TcpListener` for one serial port and runs the accept loop.
///
/// Created via [`TcpBridge::start`]. The accept loop runs in a background
/// thread; dropping `TcpBridge` signals the thread to stop by setting the
/// shutdown flag and closing the listener (via `self_connect` trick that
/// unblocks `accept()`).
pub struct TcpBridge {
    pub tcp_port: u16,
    shutdown: Arc<AtomicBool>,
    bind_addr: String,
    accept_thread: Option<std::thread::JoinHandle<()>>,
}

impl TcpBridge {
    /// Bind a `TcpListener` on `bind_addr:tcp_port` (use 0 for OS-assigned)
    /// and start the accept loop thread.
    ///
    /// Returns `Err` only if binding fails (port in use, permission denied).
    pub fn start(
        bind_addr: &str,
        tcp_port: u16,
        port_handle: Arc<PortHandle>,
    ) -> anyhow::Result<Self> {
        let listener = TcpListener::bind((bind_addr, tcp_port)).map_err(|e| {
            anyhow::anyhow!(
                "failed to bind TCP listener on {}:{}: {}",
                bind_addr,
                tcp_port,
                e
            )
        })?;
        let actual_port = listener.local_addr()?.port();
        let shutdown = Arc::new(AtomicBool::new(false));

        let shutdown_clone = Arc::clone(&shutdown);
        let bind_addr_owned = bind_addr.to_string();
        let accept_thread = std::thread::spawn(move || {
            accept_loop(listener, port_handle, shutdown_clone);
        });

        Ok(TcpBridge {
            tcp_port: actual_port,
            shutdown,
            bind_addr: bind_addr_owned,
            accept_thread: Some(accept_thread),
        })
    }

    /// Signal the accept loop to stop and join the thread.
    ///
    /// Also called automatically on [`Drop`].
    pub fn stop(&mut self) {
        self.shutdown.store(true, Ordering::Relaxed);
        // Unblock accept() with a self-connect — the accept loop will
        // notice the shutdown flag and return cleanly.
        let _ = TcpStream::connect((self.bind_addr.as_str(), self.tcp_port));
        if let Some(t) = self.accept_thread.take() {
            let _ = t.join();
        }
    }
}

impl Drop for TcpBridge {
    fn drop(&mut self) {
        self.stop();
    }
}

// ── accept loop ───────────────────────────────────────────────────────────────

fn accept_loop(listener: TcpListener, port_handle: Arc<PortHandle>, shutdown: Arc<AtomicBool>) {
    let path = port_handle.path.clone();
    loop {
        match listener.accept() {
            Err(e) => {
                if !shutdown.load(Ordering::Relaxed) {
                    log::warn!("[{path}] TCP accept error: {e}");
                }
                return;
            }
            Ok((tcp, peer)) => {
                if shutdown.load(Ordering::Relaxed) {
                    // Self-connect from stop() — discard and exit.
                    let _ = tcp.shutdown(Shutdown::Both);
                    return;
                }
                log::info!("[{path}] TCP client connected from {peer}");
                handle_connection(tcp, Arc::clone(&port_handle));
                log::info!("[{path}] TCP client {peer} disconnected; waiting for next");
            }
        }
    }
}

// ── per-connection handler ────────────────────────────────────────────────────

fn handle_connection(tcp: TcpStream, port_handle: Arc<PortHandle>) {
    let path = port_handle.path.clone();

    // ── 1. Drain: send ring snapshot before attaching as live client ──────────
    //
    // Snapshot → write → attach is not atomic, so a few bytes emitted by the
    // reader thread between snapshot() and attach_client() may be missed.
    // This is acceptable for a UART terminal — see port.rs module doc.
    {
        let history = port_handle.snapshot();
        if !history.is_empty() {
            use std::io::Write;
            if let Err(e) = (&tcp).write_all(&history) {
                log::warn!("[{path}] failed to drain ring to new client: {e}");
                let _ = tcp.shutdown(Shutdown::Both);
                return;
            }
        }
    }

    // ── 2. Attach: register TCP write-half as a live client ───────────────────
    let client_id = port_handle.next_client_id();
    let tcp_writer: Box<dyn std::io::Write + Send> = Box::new(
        tcp.try_clone()
            .expect("try_clone of TcpStream should not fail"),
    );
    port_handle.attach_client(client_id, tcp_writer);

    // ── 3. TCP → serial thread ────────────────────────────────────────────────
    //
    // Reads from the TCP socket and writes to the serial port.
    // On any error, shuts down the socket — which causes the reader thread's
    // next write_all (→ the client writer we just registered) to fail,
    // which triggers retain() to remove the client. No explicit detach needed
    // from this thread.
    let tcp_reader = match tcp.try_clone() {
        Ok(t) => t,
        Err(e) => {
            log::warn!("[{path}] try_clone for TCP→serial thread failed: {e}");
            port_handle.detach_client(client_id);
            let _ = tcp.shutdown(Shutdown::Both);
            return;
        }
    };
    let port_handle_writer = Arc::clone(&port_handle);
    let path_writer = path.clone();
    let tcp_for_shutdown = tcp.try_clone().ok();

    let tcp_to_serial = std::thread::spawn(move || {
        let mut buf = [0u8; 1024];
        let mut reader = tcp_reader;
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if port_handle_writer.write_to_port(&buf[..n]).is_err() {
                        break;
                    }
                }
            }
        }
        // Shut down the socket so the serial→TCP direction (via the registered
        // client writer) also terminates on its next write attempt.
        if let Some(s) = tcp_for_shutdown {
            let _ = s.shutdown(Shutdown::Both);
        }
        log::info!("[{path_writer}] TCP→serial direction closed");
    });

    // ── 4. Wait for the TCP→serial thread ─────────────────────────────────────
    //
    // The serial→TCP direction is handled by the reader thread in port.rs via
    // the registered client writer. When the TCP socket shuts down, the next
    // write_all on that writer will fail and retain() will remove the client.
    //
    // We join tcp_to_serial here so the accept loop doesn't run the next
    // accept() until this connection is fully torn down.
    let _ = tcp_to_serial.join();

    // Explicit detach in case the writer wasn't already removed by retain().
    port_handle.detach_client(client_id);
    log::info!("[{path}] connection fully torn down");
}
