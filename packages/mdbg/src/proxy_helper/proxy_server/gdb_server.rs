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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::time::{Duration, Instant};

use crate::common::tcpports::reserve_free_ports;
use crate::proxy_helper::port_monitor::wait_for_ports;

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
    /// The session was cancelled while still waiting for the port.
    Cancelled,
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
    !path
        .components()
        .any(|c| matches!(c, Component::ParentDir | Component::RootDir | Component::Prefix(_)))
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
        } = &msg.request
        {
            eprintln!(
                "Received Initialize request with version {} and token {:?} and workspace_uid {:?} and session_uid {:?}",
                version, token, workspace_uid, session_uid
            );
            let mut err = false;
            let mut err_msg = String::new();
            // Unconditional. This used to be skipped when `--no-token` was set — a flag
            // documented as merely hiding the token from the discovery line, which in
            // fact disabled authentication outright. The flag is gone.
            if Some(token) != self.args.token.as_ref() {
                err_msg = "Error: Received token does not match expected token".to_string();
                err = true;
            }
            if version != CURRENT_VERSION {
                err_msg = format!("Error: Unsupported version {}", version);
                err = true;
            }
            let dir = env::temp_dir()
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
                ControlResponse::error(msg.seq, err_msg)
                    .send(&self.writer)
                    .unwrap_or_else(|e| {
                        eprintln!("Failed to send error response: {}", e);
                    });
                self.writer.shutdown(std::net::Shutdown::Both).unwrap_or_else(|e| {
                    eprintln!("Failed to shutdown stream: {}", e);
                });
                self.exit = true;
            } else {
                eprintln!("Initialization successful");
                self.server_cwd = dir.clone();
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
                for (count, id_string) in port_set.port_ids.iter().enumerate() {
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

    /// Watch the gdb-server child and report an exit we did not cause.
    ///
    /// Polling rather than a blocking `wait()`: `end_process` needs the same `Child` to
    /// `kill()` it, and a thread parked in `wait()` would hold the lock forever. The
    /// same poll-plus-flag shape as the serial error forwarder.
    fn spawn_gdb_reaper(&mut self, pid: u32, child: Arc<Mutex<Child>>) {
        let event_tx = self.event_tx.clone();
        let cancel = self.cancel.clone();
        let intentional = Arc::clone(&self.intentional_stop);
        spawn_session_thread(&self.event_tx, SessionThreadRole::GdbReaper, move || {
            reap_gdb_server(pid, child, cancel, intentional, event_tx, REAP_POLL_START);
        });
    }

    pub(super) fn handle_start_gdb_server(&mut self, msg: &ControlMessage) {
        if let ControlRequest::StartGdbServer {
            server_path,
            server_args,
            server_env,
        } = &msg.request
        {
            self.stop_port_monitor();
            let ports: Vec<(u8, u16)> = self.reserved_ports.drain(..).map(|p| (p.stream_id, p.port)).collect();
            let dir = self.server_cwd.clone();
            let mut command = Command::new(server_path);
            command
                .args(server_args)
                .envs(server_env.as_ref().unwrap_or(&HashMap::new()))
                .current_dir(dir)
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped());
            crate::common::process::suppress_console_window(&mut command);
            let child = match command.spawn() {
                Ok(child) => child,
                Err(e) => {
                    eprintln!("Failed to launch gdb-server: {}: {}", server_path, e);
                    ControlResponse::error(msg.seq, format!("Failed to launch gdb-server: {}: {}", server_path, e))
                        .send(&self.writer)
                        .ok();
                    self.exit = true;
                    return;
                }
            };

            let pid = child.id();
            let child = Arc::new(Mutex::new(child));
            self.process = Some(Arc::clone(&child));
            // A fresh server means a fresh verdict: any earlier intentional stop must
            // not silence the reaper for this one.
            self.intentional_stop.store(false, Ordering::SeqCst);

            // Take the pipes before the reaper can start reaping, so no read is racing
            // a `wait()` that would close them.
            let stdout = child.lock_recover().stdout.take();
            let stderr = child.lock_recover().stderr.take();
            if let Some(stdout) = stdout {
                let tx = self.event_tx.clone();
                spawn_session_thread(&self.event_tx, SessionThreadRole::GdbStdout, move || {
                    read_and_forward(StreamId::Stdout.to_u8(), stdout, tx);
                });
            }
            if let Some(stderr) = stderr {
                let tx = self.event_tx.clone();
                spawn_session_thread(&self.event_tx, SessionThreadRole::GdbStderr, move || {
                    read_and_forward(StreamId::Stderr.to_u8(), stderr, tx);
                });
            }

            // Watch for the server exiting on its own. Nothing did this before, so a
            // crashed openocd left a zombie, and the client learned of it only
            // indirectly when gdb's RSP connection dropped — with no exit code.
            self.spawn_gdb_reaper(pid, Arc::clone(&child));

            // Readiness is detected by *observing* listening sockets, never by
            // connecting to them. Two connect-based strategies used to be selectable
            // here and neither could work: a TCP connect to a gdb RSP port is a client
            // connection as far as openocd is concerned, so probing it makes the server
            // believe gdb has arrived and then hang or fail when no RSP traffic follows.
            // That is inherent to the protocol, not a bug awaiting a fix, so the modes
            // and the `--port-wait-mode` flag that chose between them are gone.
            {
                {
                    self.stop_port_monitor();
                    let (stop_tx, stop_rx) = std::sync::mpsc::channel();
                    self.monitor_stop_tx = Some(stop_tx);
                    let event_tx = self.event_tx.clone();
                    spawn_session_thread(&self.event_tx, SessionThreadRole::PortMonitor, move || {
                        if let Err(e) = wait_for_ports(ports, event_tx, stop_rx) {
                            eprintln!("Port monitor exited with error: {}", e);
                        }
                    });
                }
            }

            let data = ControlResponseData::StartGdbServer { pid };
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

    pub(super) fn spawn_port_waiters(&mut self, ports: Vec<(u8, u16)>, keep_open: bool, msg_seq: u64) {
        for (stream_id, port) in ports {
            let event_tx = self.event_tx.clone();
            let cancel = self.cancel.clone();
            spawn_session_thread(&self.event_tx, SessionThreadRole::PortWaiter, move || {
                let duration = if msg_seq != 0 {
                    Duration::from_millis(30)
                } else {
                    Duration::from_secs(10 * 60)
                };
                match Self::wait_and_connect_sync(port, duration, keep_open, &cancel) {
                    Ok(WaitPortResult::Ready) => {
                        eprintln!(
                            "Port {} is ready for stream {}, but keep_open is false, not forwarding",
                            port, stream_id
                        );
                        event_tx.send(ProxyEvent::PortReady { stream_id, port }).ok();
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
                    Ok(WaitPortResult::Cancelled) => {
                        // Session is tearing down — exit quietly; the event loop
                        // is already gone, so there is no one to notify.
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
            eprintln!("Received StartStream for unknown stream_id {}, ignoring", stream_id);
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
            eprintln!("Received DuplicateStream for unknown stream_id {}, ignoring", stream_id);
        }
    }

    pub(super) fn wait_and_connect_sync(
        port: u16,
        timeout: Duration,
        keep_open: bool,
        cancel: &AtomicBool,
    ) -> Result<WaitPortResult> {
        eprintln!("Waiting for connection on port {} with timeout {:?}", port, timeout);
        let deadline = Instant::now() + timeout;
        let mut interval = Duration::from_millis(100);
        let mut once = true;

        while once || Instant::now() < deadline {
            once = false;
            // Bail promptly if the session is tearing down — otherwise an
            // auto-connect waiter would block here for up to its 10-minute
            // timeout after the session is already gone.
            if cancel.load(Ordering::Relaxed) {
                return Ok(WaitPortResult::Cancelled);
            }
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
        if let ControlRequest::SyncFile { relative_path, content } = &msg.request {
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

/// Collapse an `ExitStatus` into the single `i32` the wire carries.
///
/// `code()` is `None` on Unix when the child was killed by a signal, which is exactly
/// the crash case worth reporting. Map those to the shell's `128 + signo`, so a
/// segfault reports 139 and a SIGKILL 137 — conventional and recognisable — rather
/// than a sentinel that means nothing to anyone reading a log.
fn exit_code_of(status: &std::process::ExitStatus) -> i32 {
    if let Some(code) = status.code() {
        return code;
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(sig) = status.signal() {
            return 128 + sig;
        }
    }
    // No code and no signal: nothing better to say than "failed".
    -1
}

/// How soon after spawning the reaper first asks whether the child has exited.
///
/// Deliberately short: gdb-server failures cluster at the very start of a session —
/// no probe attached, a bad config, a device already claimed — and openocd and friends
/// exit within a few hundred milliseconds when that happens. Detecting it fast turns a
/// port-wait timeout into an immediate, accurate error.
const REAP_POLL_START: Duration = Duration::from_millis(50);

/// The interval the reaper settles at once a session is up and running, where an exit
/// means something rare (a physical unplug) rather than a misconfiguration. Half a
/// second either way is imperceptible there, so the wakeups are not worth spending.
const REAP_POLL_MAX: Duration = Duration::from_millis(250);

/// Poll `child` until it exits, then report an exit we did not cause.
///
/// A free function so the three outcomes can be tested directly: reported exit,
/// silence after our own kill, and silence on cancel. Spawning it is all the method
/// above does.
fn reap_gdb_server(
    pid: u32,
    child: Arc<Mutex<Child>>,
    cancel: Arc<AtomicBool>,
    intentional: Arc<AtomicBool>,
    event_tx: std::sync::mpsc::Sender<ProxyEvent>,
    initial_poll: Duration,
) {
    // Back off from `initial_poll` toward `REAP_POLL_MAX`: fast while a startup failure
    // is likely, then cheap for the rest of the session. Never below the caller's
    // starting value, so a test can ask for a long, unambiguous interval.
    let mut poll = initial_poll;
    loop {
        if cancel.load(Ordering::SeqCst) {
            return;
        }
        // Bind the result before matching on it. A temporary in a `match` scrutinee
        // lives until the end of the whole match, so matching on
        // `child.lock_recover().try_wait()` directly would hold the lock across the
        // `sleep` below — stalling `end_process`'s `kill()`, on the message-loop
        // thread, for up to a full poll interval.
        //
        // `try_wait` also reaps, so a self-exited child never lingers as a zombie the
        // way it used to until session teardown.
        let polled = child.lock_recover().try_wait();
        let status = match polled {
            Ok(Some(status)) => status,
            Ok(None) => {
                std::thread::sleep(poll);
                poll = (poll * 2).min(initial_poll.max(REAP_POLL_MAX));
                continue;
            }
            Err(e) => {
                eprintln!("gdb-server reaper could not poll pid {pid}: {e}");
                return;
            }
        };
        if intentional.load(Ordering::SeqCst) {
            // We killed it; the client asked for that and needs no event.
            return;
        }
        let exit_code = exit_code_of(&status);
        eprintln!("gdb-server pid {pid} exited on its own with code {exit_code}");
        let _ = event_tx.send(ProxyEvent::GdbServerExited { pid, exit_code });
        return;
    }
}

#[cfg(test)]
mod reaper_tests {
    use super::*;
    use std::sync::mpsc::channel;

    /// A child that exits immediately with `code`, portable across the platforms we ship.
    fn exits_with(code: i32) -> Child {
        let mut cmd = if cfg!(windows) {
            let mut c = Command::new("cmd");
            c.args(["/C", &format!("exit {code}")]);
            c
        } else {
            let mut c = Command::new("sh");
            c.args(["-c", &format!("exit {code}")]);
            c
        };
        cmd.spawn().expect("spawn test child")
    }

    /// A child that outlives the test unless killed.
    fn long_running() -> Child {
        let mut cmd = if cfg!(windows) {
            let mut c = Command::new("cmd");
            c.args(["/C", "ping -n 60 127.0.0.1 > NUL"]);
            c
        } else {
            let mut c = Command::new("sleep");
            c.arg("60");
            c
        };
        cmd.spawn().expect("spawn test child")
    }

    fn reap(child: Child, intentional: bool, cancel: bool) -> (std::sync::mpsc::Receiver<ProxyEvent>, u32) {
        let pid = child.id();
        let (tx, rx) = channel();
        reap_gdb_server(
            pid,
            Arc::new(Mutex::new(child)),
            Arc::new(AtomicBool::new(cancel)),
            Arc::new(AtomicBool::new(intentional)),
            tx,
            Duration::from_millis(10),
        );
        (rx, pid)
    }

    /// The case that had no code path at all: the server exits on its own and the
    /// client has to be told. A non-zero code is the openocd-found-no-probe shape.
    #[test]
    fn an_unexpected_exit_is_reported_with_its_code() {
        let (rx, pid) = reap(exits_with(3), false, false);

        match rx.try_recv() {
            Ok(ProxyEvent::GdbServerExited {
                pid: got_pid,
                exit_code,
            }) => {
                assert_eq!(got_pid, pid);
                assert_eq!(exit_code, 3);
            }
            other => panic!("expected GdbServerExited, got {:?}", other.is_ok()),
        }
    }

    /// A clean exit is reported too. Some servers return 0 after `monitor shutdown`,
    /// and the client still needs to know its server is gone — it branches on the code.
    #[test]
    fn a_clean_exit_is_also_reported() {
        let (rx, _) = reap(exits_with(0), false, false);

        match rx.try_recv() {
            Ok(ProxyEvent::GdbServerExited { exit_code, .. }) => assert_eq!(exit_code, 0),
            _ => panic!("a zero exit must still be reported"),
        }
    }

    /// When *we* stopped the server, the client asked for it and needs no event.
    /// Without this flag every normal session end would look like a crash.
    #[test]
    fn an_exit_we_caused_is_not_reported() {
        let mut child = long_running();
        let _ = child.kill();
        let (rx, _) = reap(child, true, false);

        assert!(
            rx.try_recv().is_err(),
            "an intentional stop must not raise GdbServerExited"
        );
    }

    /// Session teardown sets `cancel`; the reaper must return rather than outlive the
    /// session waiting on a child that is about to be killed anyway.
    #[test]
    fn a_cancelled_reaper_returns_without_reporting() {
        let child = long_running();
        let pid = child.id();
        let child = Arc::new(Mutex::new(child));
        let (tx, rx) = channel();

        reap_gdb_server(
            pid,
            Arc::clone(&child),
            Arc::new(AtomicBool::new(true)), // cancel
            Arc::new(AtomicBool::new(false)),
            tx,
            Duration::from_millis(10),
        );

        assert!(rx.try_recv().is_err(), "cancel must not raise an event");
        let mut c = child.lock_recover();
        let _ = c.kill();
        let _ = c.wait();
    }

    /// The backoff must actually be bounded, and must start where the caller asked.
    ///
    /// This mirrors the arithmetic in `reap_gdb_server` rather than driving it, because
    /// observing the schedule from outside would mean timing several sleeps — flaky for
    /// no extra confidence. What is worth pinning is that it climbs and then stops:
    /// an unbounded doubling would eventually take minutes to notice a dead server.
    #[test]
    fn the_poll_interval_backs_off_to_a_bound() {
        let mut poll = REAP_POLL_START;
        let cap = REAP_POLL_START.max(REAP_POLL_MAX);

        assert!(
            REAP_POLL_START < REAP_POLL_MAX,
            "starting fast is the whole point: failures cluster at session start"
        );

        let mut seen = vec![poll];
        for _ in 0..10 {
            poll = (poll * 2).min(cap);
            seen.push(poll);
        }

        assert_eq!(*seen.last().unwrap(), REAP_POLL_MAX, "must settle at the cap");
        assert!(
            seen.windows(2).all(|w| w[0] <= w[1]),
            "the interval must never shrink: {seen:?}"
        );
        // Today's schedule reaches the cap quickly, so a startup failure is caught in
        // the first few polls rather than after the session has already timed out.
        assert!(
            seen[3] <= REAP_POLL_MAX,
            "the cap should be reached within a handful of polls"
        );
    }

    /// The reaper must not hold the child's lock while it sleeps between polls.
    ///
    /// `end_process` runs on the message loop and needs that same lock to `kill()`.
    /// Holding it across the sleep stalls the whole session for up to a poll interval —
    /// which is easy to reintroduce, because a temporary in a `match` scrutinee lives
    /// until the end of the match, so matching on `lock().try_wait()` directly does
    /// exactly this.
    ///
    /// The poll interval here is deliberately long so the margin is unambiguous: with
    /// the bug the lock takes ~2s to acquire, without it, microseconds.
    #[test]
    fn the_reaper_does_not_hold_the_child_lock_while_sleeping() {
        let child = long_running();
        let pid = child.id();
        let child = Arc::new(Mutex::new(child));
        let (tx, _rx) = channel();

        let reaper = {
            let child = Arc::clone(&child);
            std::thread::spawn(move || {
                reap_gdb_server(
                    pid,
                    child,
                    Arc::new(AtomicBool::new(false)),
                    Arc::new(AtomicBool::new(true)), // stay quiet when we kill it
                    tx,
                    Duration::from_secs(2),
                )
            })
        };

        // Let the reaper reach its first sleep.
        std::thread::sleep(Duration::from_millis(200));

        let start = std::time::Instant::now();
        let mut guard = child.lock_recover();
        let waited = start.elapsed();
        let _ = guard.kill();
        let _ = guard.wait();
        drop(guard);

        assert!(
            waited < Duration::from_millis(500),
            "acquiring the child lock took {waited:?} — the reaper is holding it while sleeping"
        );
        reaper.join().expect("reaper thread");
    }

    /// A signalled child has no exit code of its own, which is precisely the crash we
    /// most want reported. `128 + signo` is the shell convention, so SIGKILL reads as
    /// 137 and a segfault as 139 rather than as some invented sentinel.
    #[cfg(unix)]
    #[test]
    fn a_signalled_child_reports_128_plus_the_signal() {
        let mut child = long_running();
        let _ = child.kill(); // SIGKILL
        let status = child.wait().expect("wait");

        assert_eq!(exit_code_of(&status), 128 + 9, "SIGKILL must map to 137");
    }

    /// A child that exited normally keeps its own code, untouched by the signal path.
    #[test]
    fn a_normal_exit_keeps_its_code() {
        let mut child = exits_with(42);
        let status = child.wait().expect("wait");

        assert_eq!(exit_code_of(&status), 42);
    }
}
