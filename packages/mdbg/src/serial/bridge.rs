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
//! runs an accept loop in a background thread. **Every client that connects is
//! served at the same time**, each on its own thread: an IDE panel and a CLI
//! session on the same port both receive every byte, and both can write to it.
//!
//! It used to serve one connection at a time, running it inline and only calling
//! `accept()` again once it had disconnected. A second client's connect still
//! succeeded — the kernel completes it into the listen backlog — so the client
//! looked attached, received nothing, and saw no error until the first one left.
//! Everything around it already expected more than one: `OpenPort` counts several
//! direct clients on one shared bridge, and [`PortHandle`] fans out to N clients.
//!
//! ## Per-connection lifecycle
//!
//! For each accepted TCP connection, on its own thread:
//!
//! 1. **Attach**: The TCP write-half is registered with [`PortHandle`] as a live
//!    client. `attach_client` seeds the ring buffer snapshot into the client's
//!    queue atomically with going live, so a client that connects late gets the
//!    history and then every live byte, in order, exactly once.
//!
//! 2. **TCP→serial thread**: A second thread reads from the TCP socket and
//!    calls [`PortHandle::write_to_port`]. That call holds the port's lock for a
//!    whole chunk, so input from several clients interleaves only between chunks
//!    — the same as funnel channels writing to one port.
//!
//! 3. **Teardown**: Whichever direction hits an error first calls
//!    `tcp.shutdown(Both)`, which unblocks the other direction's next I/O. The
//!    thread then calls [`PortHandle::detach_client`] and exits — the serial port
//!    stays open throughout, and the other clients are untouched.
//!
//! ## What does NOT happen here
//!
//! - The serial port is **never** opened or closed in this file. That is
//!   entirely [`PortHandle`]'s responsibility.
//! - There is **no** per-connection port reconfigure. Reconfigure happens via
//!   the control channel (`serial.open` with new params → `PortHandle::reconfigure`).

use std::collections::HashMap;
use std::io::Read;
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use crate::common::sync::MutexExt;
use crate::serial::port::PortHandle;

// ── TcpBridge ─────────────────────────────────────────────────────────────────

/// Owns the `TcpListener` for one serial port and runs the accept loop.
///
/// Created via [`TcpBridge::start`]. The accept loop runs in a background
/// thread and hands each connection to a thread of its own; dropping
/// `TcpBridge` stops the loop, force-closes every connection, and joins them.
pub struct TcpBridge {
    pub tcp_port: u16,
    shutdown: Arc<AtomicBool>,
    bind_addr: String,
    accept_thread: Option<JoinHandle<()>>,
    /// Every connection currently being served, by a bridge-local id: a clone of each
    /// socket, so [`TcpBridge::stop`] can force them closed. Without that, a client that
    /// never writes (a read-only monitor) leaves its thread parked in `read()` forever
    /// once the device has died, and joining it would stall whatever called `stop()` —
    /// the proxy's single-threaded event loop, in the disconnect case.
    live: Arc<Mutex<HashMap<u64, TcpStream>>>,
    /// Join handles for the per-connection threads. Finished ones are pruned whenever a
    /// new client arrives, so this does not grow with every connect and disconnect.
    conn_threads: Arc<Mutex<Vec<JoinHandle<()>>>>,
}

impl TcpBridge {
    /// Bind a `TcpListener` on `bind_addr:tcp_port` (use 0 for OS-assigned)
    /// and start the accept loop thread.
    ///
    /// Returns `Err` only if binding fails (port in use, permission denied).
    pub fn start(bind_addr: &str, tcp_port: u16, port_handle: Arc<PortHandle>) -> anyhow::Result<Self> {
        let listener = TcpListener::bind((bind_addr, tcp_port))
            .map_err(|e| anyhow::anyhow!("failed to bind TCP listener on {}:{}: {}", bind_addr, tcp_port, e))?;
        let actual_port = listener.local_addr()?.port();
        let shutdown = Arc::new(AtomicBool::new(false));
        let live: Arc<Mutex<HashMap<u64, TcpStream>>> = Arc::new(Mutex::new(HashMap::new()));
        let conn_threads: Arc<Mutex<Vec<JoinHandle<()>>>> = Arc::new(Mutex::new(Vec::new()));

        let accept_thread = {
            let shutdown = Arc::clone(&shutdown);
            let live = Arc::clone(&live);
            let conn_threads = Arc::clone(&conn_threads);
            std::thread::spawn(move || accept_loop(listener, port_handle, shutdown, live, conn_threads))
        };

        Ok(TcpBridge {
            tcp_port: actual_port,
            shutdown,
            bind_addr: bind_addr.to_string(),
            accept_thread: Some(accept_thread),
            live,
            conn_threads,
        })
    }

    /// Stop accepting, force-close every connection, and join all threads.
    ///
    /// Also called automatically on [`Drop`]. Idempotent.
    pub fn stop(&mut self) {
        // Order matters. The flag is set *before* taking `live`, and a connection is
        // registered under that same lock with the flag re-checked while holding it. So
        // every connection is either in the set below — and shut down here — or sees the
        // flag and closes itself. Otherwise one accepted in this very instant could escape
        // both, and the join at the end would hang on it.
        self.shutdown.store(true, Ordering::SeqCst);
        for tcp in self.live.lock_recover().values() {
            let _ = tcp.shutdown(Shutdown::Both);
        }
        // Unblock accept() with a self-connect — the accept loop will notice the flag and
        // return cleanly.
        let _ = TcpStream::connect((self.bind_addr.as_str(), self.tcp_port));
        if let Some(t) = self.accept_thread.take() {
            let _ = t.join();
        }
        // The accept loop has exited, so no connection thread can be added after this.
        let threads = std::mem::take(&mut *self.conn_threads.lock_recover());
        for t in threads {
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

fn accept_loop(
    listener: TcpListener,
    port_handle: Arc<PortHandle>,
    shutdown: Arc<AtomicBool>,
    live: Arc<Mutex<HashMap<u64, TcpStream>>>,
    conn_threads: Arc<Mutex<Vec<JoinHandle<()>>>>,
) {
    let path = port_handle.path.clone();
    let mut next_conn: u64 = 0;
    loop {
        let (tcp, peer) = match listener.accept() {
            Ok(accepted) => accepted,
            Err(e) => {
                if !shutdown.load(Ordering::SeqCst) {
                    log::warn!("[{path}] TCP accept error: {e}");
                }
                return;
            }
        };
        next_conn += 1;
        let conn = next_conn;

        // Register under the lock, re-checking the flag while holding it — see `stop()`.
        {
            let mut connected = live.lock_recover();
            if shutdown.load(Ordering::SeqCst) {
                // stop()'s self-connect, or a real client that lost the race with it.
                let _ = tcp.shutdown(Shutdown::Both);
                return;
            }
            match tcp.try_clone() {
                Ok(clone) => {
                    connected.insert(conn, clone);
                }
                Err(e) => {
                    // Untracked, stop() could not force it closed and joining it could hang,
                    // so refuse it rather than serve it.
                    log::warn!("[{path}] try_clone for shutdown tracking failed, refusing {peer}: {e}");
                    let _ = tcp.shutdown(Shutdown::Both);
                    continue;
                }
            }
            log::info!(
                "[{path}] TCP client connected from {peer} ({} connected)",
                connected.len()
            );
        }

        // Serve it on its own thread, so the loop is straight back in accept() for the next.
        let handle_for_conn = Arc::clone(&port_handle);
        let live_for_conn = Arc::clone(&live);
        let path_for_conn = path.clone();
        let spawned = std::thread::Builder::new()
            .name(format!("serial-bridge-{conn}"))
            .spawn(move || {
                handle_connection(tcp, handle_for_conn);
                let remaining = {
                    let mut connected = live_for_conn.lock_recover();
                    connected.remove(&conn);
                    connected.len()
                };
                log::info!("[{path_for_conn}] TCP client {peer} disconnected ({remaining} still connected)");
            });
        match spawned {
            Ok(thread) => {
                let mut threads = conn_threads.lock_recover();
                threads.retain(|t| !t.is_finished());
                threads.push(thread);
            }
            Err(e) => {
                log::warn!("[{path}] could not start a thread to serve {peer}: {e}");
                if let Some(tcp) = live.lock_recover().remove(&conn) {
                    let _ = tcp.shutdown(Shutdown::Both);
                }
            }
        }
    }
}

// ── per-connection handler ────────────────────────────────────────────────────

fn handle_connection(tcp: TcpStream, port_handle: Arc<PortHandle>) {
    let path = port_handle.path.clone();

    // ── Attach: register the TCP write-half as a live client ──────────────────
    //
    // `attach_client` seeds the ring snapshot into the client's queue atomically
    // with going live, so late-attach catch-up is exactly-once: the history and
    // all live bytes arrive in order, none lost between snapshot and attach, none
    // duplicated.
    let client_id = port_handle.next_client_id();
    let tcp_writer: Box<dyn std::io::Write + Send> =
        Box::new(tcp.try_clone().expect("try_clone of TcpStream should not fail"));
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
    // Joined so this connection's thread returns — and `TcpBridge::stop()` finishes
    // joining it — only once both directions are fully torn down.
    let _ = tcp_to_serial.join();

    // Explicit detach in case the writer wasn't already removed by retain().
    port_handle.detach_client(client_id);
    log::info!("[{path}] connection fully torn down");
}

/// Several direct clients on one port, against a real serial device: a pseudo-terminal pair.
/// `PortHandle` serves the pty's device through the same reader thread, fan-out and write path as
/// a USB serial port — only the open differs — and the test drives the other end as the firmware.
#[cfg(all(test, unix))]
mod multi_client_tests {
    use super::*;
    use crate::serial::port::{FlowControl, Parity, SerialParams, SerialTransport, StopBits};
    use serialport::SerialPort;
    use std::io::Write;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    fn params() -> SerialParams {
        SerialParams {
            path: None,
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

    /// The firmware's end of the line, and the port the bridge serves.
    fn fake_device() -> (serialport::TTYPort, Arc<PortHandle>) {
        let (mut firmware, device) = serialport::TTYPort::pair().expect("create a pty pair");
        firmware
            .set_timeout(Duration::from_millis(100))
            .expect("set pty read timeout");
        let path = device.name().expect("pty device has a path");
        // Serve the pair's own, already-raw device rather than reopening it by path:
        // `serialport` cannot open a pty on macOS (see `PortHandle::from_port`).
        let handle = PortHandle::from_port(path, params(), Box::new(device)).expect("serve the pty device");
        (firmware, Arc::new(handle))
    }

    fn connect(bridge: &TcpBridge) -> TcpStream {
        let s = TcpStream::connect(("127.0.0.1", bridge.tcp_port)).expect("connect to the bridge");
        s.set_read_timeout(Some(Duration::from_millis(100))).unwrap();
        s
    }

    fn wait_for(what: &str, mut ready: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !ready() {
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    /// Read until every needle has been seen, in any order, or fail at the deadline.
    fn read_until_all(r: &mut impl Read, needles: &[&[u8]], who: &str) {
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut seen = Vec::new();
        let mut buf = [0u8; 256];
        let has = |seen: &[u8], n: &[u8]| seen.windows(n.len()).any(|w| w == n);
        while !needles.iter().all(|n| has(&seen, n)) {
            assert!(
                Instant::now() < deadline,
                "{who} never received everything; got {:?}",
                String::from_utf8_lossy(&seen)
            );
            match r.read(&mut buf) {
                Ok(0) => panic!("{who} was closed; got {:?}", String::from_utf8_lossy(&seen)),
                Ok(n) => seen.extend_from_slice(&buf[..n]),
                Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {}
                Err(e) => panic!("{who}: read failed: {e}"),
            }
        }
    }

    /// Both clients are attached, both receive, and both can write — rather than the second
    /// sitting in the listen backlog, looking connected and hearing nothing. That is what a CLI
    /// session sharing an IDE panel's port used to get.
    #[test]
    fn every_direct_client_is_served_at_once() {
        let (mut firmware, handle) = fake_device();
        let mut bridge = TcpBridge::start("127.0.0.1", 0, Arc::clone(&handle)).expect("start the bridge");
        let mut a = connect(&bridge);
        let mut b = connect(&bridge);
        wait_for("both clients to be attached", || handle.client_count() == 2);

        firmware.write_all(b"printf from firmware\n").unwrap();
        read_until_all(&mut a, &[b"printf from firmware"], "client A");
        read_until_all(&mut b, &[b"printf from firmware"], "client B");

        a.write_all(b"typed-into-A\n").unwrap();
        b.write_all(b"typed-into-B\n").unwrap();
        read_until_all(&mut firmware, &[b"typed-into-A", b"typed-into-B"], "the device");

        bridge.stop();
        handle.close();
    }

    /// One client leaving must not take the others with it.
    #[test]
    fn a_client_leaving_does_not_disturb_the_others() {
        let (mut firmware, handle) = fake_device();
        let mut bridge = TcpBridge::start("127.0.0.1", 0, Arc::clone(&handle)).expect("start the bridge");
        let a = connect(&bridge);
        let mut b = connect(&bridge);
        wait_for("both clients to be attached", || handle.client_count() == 2);

        drop(a);
        wait_for("the departed client to be detached", || handle.client_count() == 1);

        firmware.write_all(b"still here\n").unwrap();
        read_until_all(&mut b, &[b"still here"], "the remaining client");

        bridge.stop();
        handle.close();
    }

    /// `stop()` must return with clients attached that never write — read-only monitors. Each
    /// of their threads is parked in `read()`, and only forcing the sockets closed frees it.
    #[test]
    fn stop_returns_with_several_silent_clients_attached() {
        let (_firmware, handle) = fake_device();
        let bridge = TcpBridge::start("127.0.0.1", 0, Arc::clone(&handle)).expect("start the bridge");
        let clients: Vec<TcpStream> = (0..3).map(|_| connect(&bridge)).collect();
        wait_for("all three clients to be attached", || handle.client_count() == 3);

        let (done_tx, done_rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut bridge = bridge;
            bridge.stop();
            let _ = done_tx.send(());
        });
        done_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("stop() hung with silent clients attached");

        for mut c in clients {
            c.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
            let mut buf = [0u8; 8];
            match c.read(&mut buf) {
                Ok(0) => {}
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::ConnectionAborted
                    ) => {}
                other => panic!("a client was left connected after stop(): {other:?}"),
            }
        }
        wait_for("every client to be detached from the port", || {
            handle.client_count() == 0
        });
        handle.close();
    }
}
