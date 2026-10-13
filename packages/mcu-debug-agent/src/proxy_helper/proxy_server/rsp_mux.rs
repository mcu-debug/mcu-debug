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

//! Joins [`crate::gdb_rsp`]'s multiplexer to this session's funnel.
//!
//! All of the protocol lives in `gdb_rsp`, which knows nothing about the proxy; all of
//! the proxy's stream bookkeeping lives in `mod.rs`, which knows nothing about RSP.
//! This file is the seam, and is deliberately the only place that names both
//! (`docs-internal/gdb-rsp.md` §4.6, D6).
//!
//! What it replaces, for the one stream it applies to:
//!
//! | Direction     | Before                                     | With the mux                          |
//! | ------------- | ------------------------------------------ | ------------------------------------- |
//! | server → GDB  | `read_and_forward` on the waiter thread     | the mux's reader thread → [`FunnelGdbSink`] |
//! | GDB → server  | `pinfo.stream.write_all` in `message_loop`  | `feed_from_gdb` → the mux's writer thread   |
//!
//! Both still end at the same funnel frame and the same socket, so with no consumers
//! attached the bytes GDB and the gdb-server see are unchanged — which is exactly what
//! design item 15 has to confirm on hardware.

use std::io;
use std::net::TcpStream;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::Sender;
use std::sync::Arc;

use crate::gdb_rsp::{GdbSink, RspCaps, RspChannel, RspTrace, ServerTier, TargetState, TraceLevel};

use super::*;

/// Distinguishes trace files within one proxy process.
///
/// The pid alone is not enough: a proxy serves many sessions, and stream ids restart at
/// 3 in each one, so two concurrent sessions would otherwise write their `gdbPort`
/// traces to the same file and interleave into nonsense.
static TRACE_SEQ: AtomicU64 = AtomicU64::new(1);

/// The mux's GDB side, expressed as funnel frames.
///
/// The bytes and the events are exactly what `read_and_forward` produced for this
/// stream before the mux existed — same `StreamData` for data, same `StreamClosed` at
/// the end — so nothing downstream of the message loop can tell the difference.
pub(super) struct FunnelGdbSink {
    stream_id: u8,
    /// A clone of the session's event channel. Sending is how the message loop learns
    /// of anything at all, and it is what makes the funnel write happen on the
    /// message-loop thread rather than on the mux's reader thread.
    event_tx: Sender<ProxyEvent>,
}

impl GdbSink for FunnelGdbSink {
    fn to_gdb(&self, bytes: &[u8]) -> io::Result<()> {
        self.event_tx
            .send(ProxyEvent::StreamData {
                stream_id: self.stream_id,
                data: bytes.to_vec(),
            })
            // The loop is gone, so the session is over. Reported as an error rather
            // than ignored: the channel treats a failed forward as fatal and tears
            // itself down, which is the correct end for a session with no message loop.
            .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "the proxy message loop is gone"))
    }

    fn state_changed(&self, state: TargetState) {
        // Debug, not info: on a stepping session this fires several times a second.
        // Publishing it to interested parties is design item 16; until then the log is
        // how we check the state model against a real session.
        log::debug!("RSP mux stream {}: target is {:?}", self.stream_id, state);
    }

    fn caps_learned(&self, caps: &RspCaps) {
        // Once per session, and the single most useful line for diagnosing anything
        // that follows -- chunk sizes, `x` vs `m`, whether no-ack was even offered.
        log::info!(
            "RSP mux stream {}: PacketSize={} (advertised: {}), read kind {:?}, write kind {:?}",
            self.stream_id,
            caps.packet_size(),
            caps.packet_size_was_advertised(),
            caps.memory_read_kind(),
            caps.memory_write_kind(),
        );
    }

    fn closed(&self, why: &str) {
        eprintln!("RSP mux stream {} closed: {}", self.stream_id, why);
        // The same event `read_and_forward` sent on EOF or error. The message loop
        // drops the stream and tells the client, as it always did.
        self.event_tx
            .send(ProxyEvent::StreamClosed {
                stream_id: self.stream_id,
            })
            .ok();
    }
}

/// Put a multiplexer on `server`, an already-connected socket to the gdb-server.
///
/// Split out from [`ProxyServer::maybe_start_rsp_mux`] so it can be tested against a
/// real socket pair without a session, a control channel or a message loop.
///
/// **Two fresh clones, and the caller then surrenders the original.** The mux needs a
/// reader and a writer half, and reads and writes are separate OS operations so the halves
/// need no lock between them. `message_loop` drops its own descriptor once this returns and
/// records [`StreamConn::Muxed`], which carries no socket: the invariant that nothing else
/// writes to this connection is then enforced by the type rather than by lookup order. Two
/// descriptors per stream, the same as before the mux existed.
///
/// Socket options survive this, because they belong to the socket and not to the
/// descriptor. That includes the 5 s write timeout `message_loop` set, and it is
/// deliberately left in place: it is one fewer difference from the code this replaces, and
/// a gdb-server that has not accepted a write in five seconds is one worth reporting rather
/// than waiting on.
pub(super) fn start_channel(
    stream_id: u8,
    server: &TcpStream,
    label: &str,
    tier: ServerTier,
    trace: Option<RspTrace>,
    event_tx: Sender<ProxyEvent>,
) -> io::Result<RspChannel> {
    let reader = server.try_clone()?;
    let writer = server.try_clone()?;
    let sink = Arc::new(FunnelGdbSink { stream_id, event_tx });
    Ok(RspChannel::start_traced(
        reader,
        writer,
        sink as Arc<dyn GdbSink>,
        tier,
        label.to_string(),
        trace,
    ))
}

impl ProxyServer {
    /// Decide who reads this newly connected stream, and start a mux if it is the one.
    ///
    /// **Called before the message loop tells the client the stream is connected**, which
    /// is what makes GDB's first packet safe. GDB does not retry its first transaction and
    /// `set remotetimeout` does not cover it, so anything not ready by then is a failed
    /// session, not a slow one. The client holds GDB's opening bytes until the proxy
    /// confirms the connection (`RemoteStream.toServerBuffer`, `proxy-client.ts`), and that
    /// confirmation — the `StreamStatus: Connected` response — is sent after this returns.
    ///
    /// It cannot usefully happen any earlier than this. `PortReady` — the event before it —
    /// is raised by watching for a listening socket and deliberately never connects to it: a
    /// TCP connect to an RSP port is indistinguishable from GDB arriving, so the server fires
    /// its attach events and then waits for traffic that is not coming (see the note in
    /// `handle_start_gdb_server`, and the `--port-wait-mode` flag that was removed over it).
    /// There is no server socket to hand a mux until the connect on this path.
    ///
    /// It must not happen any later either: after the stream is in `self.streams` but before
    /// the mux is in `rsp_channels`, `message_loop` would write GDB's bytes straight to the
    /// socket and the mux would then take over mid-packet.
    ///
    /// Takes the socket by reference and clones it, rather than taking ownership: the caller
    /// still needs it for the `StreamForward::Direct` case, and deciding that here would
    /// mean handing a `TcpStream` back out through the return value.
    ///
    /// **Only a core's controller `GdbRsp` stream is muxed** (§4.7). A secondary — the
    /// live-watch GDB from `handle_duplicate_stream` — is never sent a stop reply by the
    /// server and never issues a resume, so a mux there could not maintain a run-state
    /// model at all. It keeps `read_and_forward`, untouched.
    pub(super) fn maybe_start_rsp_mux(&mut self, stream_id: u8, server: &TcpStream) -> StreamForward {
        let Some(meta) = self.stream_meta.get(&stream_id) else {
            // Streams the client never named through `AllocatePorts`. Nothing to
            // classify, so nothing to mux.
            return StreamForward::Direct;
        };
        if !meta.kind.is_rsp_controller() {
            return StreamForward::Direct;
        }
        // A stream is removed from `streams` when it closes, so a reconnect on the same
        // id is possible in principle. Retire the old channel rather than letting its
        // threads live on with a handle nobody holds: two muxes on one stream id is a
        // state no amount of reading the code afterwards would explain.
        if let Some(stale) = self.rsp_channels.remove(&stream_id) {
            eprintln!("Stream {} already had an RSP mux; retiring it", stream_id);
            stale.shutdown("the stream was replaced");
        }
        // The session's own answer wins; the command line only sets this proxy's default,
        // because one proxy serves many sessions and cannot have one opinion for all of them.
        let enabled = self.debug_flags.rsp_mux.unwrap_or(!self.args.no_rsp_mux);
        if !enabled {
            let why = if self.debug_flags.rsp_mux == Some(false) {
                "debugFlags.rspMux is false for this session"
            } else {
                "this proxy was started --no-rsp-mux"
            };
            eprintln!(
                "Stream {} ('{}') is a controller gdb stream, but {}; forwarding directly",
                stream_id, meta.name, why
            );
            return StreamForward::Direct;
        }
        // `classify` only accepts `gdbPort` plus digits, so the name is already safe in
        // a file name; there is deliberately no sanitiser to keep in step with it.
        let label = meta.name.clone();
        let trace = self.open_rsp_trace(&label);
        // The tier decides whether **our own** packets may go out while the target is running;
        // GDB's are never gated. It used to be hardcoded `Unknown`, which the gate reads as
        // halted-only, and the comment here said that cost nothing because item 14 attached no
        // consumers. It stopped costing nothing the moment one existed: Agent-side RTT on a running
        // target sat waiting for a gate that never opened, silently, because a running target is
        // exactly when RTT has data.
        //
        // So it comes from the `servertype` now, with an explicit override for measuring a server
        // the matrix has not reached (§7, item 17c).
        let tier = self
            .debug_flags
            .rsp_tier
            .as_deref()
            .and_then(ServerTier::from_flag)
            .unwrap_or_else(|| {
                self.server_type
                    .as_deref()
                    .map(ServerTier::from_server_type)
                    .unwrap_or_default()
            });
        eprintln!("Stream {} ('{}') server tier: {:?}", stream_id, label, tier);
        match start_channel(stream_id, server, &label, tier, trace, self.event_tx.clone()) {
            Ok(channel) => {
                eprintln!("RSP mux now owns stream {} ('{}')", stream_id, label);
                self.rsp_channels.insert(stream_id, channel);
                StreamForward::MuxOwned
            }
            Err(e) => {
                // Duplicating a connected socket essentially cannot fail, but if it
                // does, a working session without a mux beats a dead one with it.
                eprintln!(
                    "Could not clone the gdb-server socket for stream {} ({}); forwarding directly instead",
                    stream_id, e
                );
                StreamForward::Direct
            }
        }
    }

    /// Open this stream's trace file, if tracing is on at all.
    ///
    /// A failure to open is logged and ignored: a trace is a diagnostic, and refusing
    /// to debug because the diagnostic could not be written would be the wrong trade.
    fn open_rsp_trace(&self, label: &str) -> Option<RspTrace> {
        // `debugFlags.rspTrace` for this session, else this proxy's `--rsp-trace` default.
        let level = TraceLevel::parse(
            self.debug_flags
                .rsp_trace
                .as_deref()
                .unwrap_or(self.args.rsp_trace.as_str()),
        );
        if !level.is_on() {
            return None;
        }
        let dir = crate::proxy_helper::run::resolve_log_dir(&self.args);
        if let Err(e) = std::fs::create_dir_all(&dir) {
            eprintln!("Could not create {} for the RSP trace: {}", dir.display(), e);
            return None;
        }
        let path = dir.join(format!(
            "rsp-trace-{label}-{}-{}.txt",
            std::process::id(),
            TRACE_SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        match RspTrace::to_file(&path, label, level) {
            Ok(trace) => {
                // Info, and with the full path: a trace nobody can find is no use, and
                // this is the only place the name is decided.
                eprintln!("RSP trace ({:?}) for '{}': {}", level, label, path.display());
                Some(trace)
            }
            Err(e) => {
                eprintln!("Could not open {} for the RSP trace: {}", path.display(), e);
                None
            }
        }
    }

    /// Stop multiplexing `stream_id`, if it was.
    ///
    /// Called when the stream closes. Removing before shutting down matters: the
    /// channel's teardown calls `GdbSink::closed`, which sends another `StreamClosed`,
    /// and the entry must already be gone when that arrives.
    /// Retire the mux on `stream_id`, if it had one.
    ///
    /// `StreamEnd::ClientLeft` is the one case where the mux is told that GDB itself went
    /// away, and that call is not decoration. `gdb_disconnected` drops GDB's outstanding
    /// requests and keeps **ours**: without it the core would be carrying entries for
    /// replies that can never arrive, and any of our own in-flight requests would be
    /// indistinguishable from them. It is also the only notification available for it --
    /// GDB closing its socket to the *client* is invisible on the wire we read
    /// (`docs-internal/gdb-rsp.md` §3.11), which is why the transport has to say so.
    ///
    /// The shutdown that follows makes this thin today, because no Agent consumers are
    /// attached yet (item 14 attached none). It stops being thin the moment they are, and
    /// the ordering -- tell it, then stop it -- is what makes that a one-line change rather
    /// than a redesign.
    pub(super) fn stop_rsp_mux(&mut self, stream_id: u8, end: StreamEnd) {
        if let Some(channel) = self.rsp_channels.remove(&stream_id) {
            if end == StreamEnd::ClientLeft {
                channel.gdb_disconnected();
            }
            channel.shutdown("the stream closed");
        }
    }

    /// Stop every mux this session owns, on teardown.
    ///
    /// The channels would notice on their own — killing the gdb-server makes their
    /// reads return EOF — but "would notice eventually" is not a lifecycle. This makes
    /// it prompt and independent of how the server died.
    pub(super) fn stop_all_rsp_muxes(&self) {
        for (stream_id, channel) in &self.rsp_channels {
            log::debug!("Shutting down the RSP mux on stream {stream_id}");
            channel.shutdown("the session is ending");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gdb_rsp::frame::encode_packet;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc::{channel, Receiver, RecvTimeoutError};
    use std::time::Duration;

    /// A gdb-server that is a real socket, so the clone-the-stream arrangement in
    /// `start_channel` is exercised rather than stubbed. Returns the socket the proxy
    /// would have been handed, plus the server's own end.
    fn socket_pair() -> (TcpStream, TcpStream) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().unwrap();
        let joiner = std::thread::spawn(move || listener.accept().expect("accept").0);
        let client = TcpStream::connect(addr).expect("connect");
        let server = joiner.join().expect("accept thread");
        (client, server)
    }

    /// Pull the next `StreamData` for `stream_id`, failing rather than hanging.
    fn next_data(rx: &Receiver<ProxyEvent>, stream_id: u8) -> Vec<u8> {
        loop {
            match rx.recv_timeout(Duration::from_secs(2)) {
                Ok(ProxyEvent::StreamData { stream_id: id, data }) if id == stream_id => return data,
                Ok(_) => continue,
                Err(e) => panic!("no StreamData for stream {stream_id}: {e:?}"),
            }
        }
    }

    fn read_some(sock: &mut TcpStream) -> Vec<u8> {
        sock.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        let mut buf = [0u8; 4096];
        let n = sock.read(&mut buf).expect("gdb-server side read");
        buf[..n].to_vec()
    }

    #[test]
    fn the_sink_turns_server_bytes_into_a_funnel_frame_for_that_stream() {
        let (tx, rx) = channel();
        let sink = FunnelGdbSink {
            stream_id: 7,
            event_tx: tx,
        };
        sink.to_gdb(b"$OK#9a").unwrap();
        assert_eq!(next_data(&rx, 7), b"$OK#9a".to_vec());
    }

    #[test]
    fn the_sink_reports_the_end_as_a_closed_stream() {
        let (tx, rx) = channel();
        let sink = FunnelGdbSink {
            stream_id: 9,
            event_tx: tx,
        };
        sink.closed("because");
        match rx.recv_timeout(Duration::from_secs(2)) {
            Ok(ProxyEvent::StreamClosed { stream_id }) => assert_eq!(stream_id, 9),
            other => panic!("expected StreamClosed, got {:?}", other.is_ok()),
        }
    }

    #[test]
    fn a_dead_message_loop_is_an_error_rather_than_a_silent_drop() {
        // The channel treats a failed forward as fatal. If this returned `Ok`, GDB's
        // replies would vanish one at a time with nobody told -- the hang the sink's
        // error path exists to prevent.
        let (tx, rx) = channel();
        let sink = FunnelGdbSink {
            stream_id: 3,
            event_tx: tx,
        };
        drop(rx);
        assert!(sink.to_gdb(b"$OK#9a").is_err());
    }

    #[test]
    fn both_directions_pass_through_a_real_socket_byte_for_byte() {
        // The end-to-end shape of item 14 without a message loop: GDB's bytes reach the
        // gdb-server through the mux's writer thread, and the server's reply comes back
        // as a funnel frame on the event channel. With no consumers attached, neither
        // side may see anything it would not have seen from `read_and_forward`.
        let (proxy_side, mut server_side) = socket_pair();
        let (tx, rx) = channel();
        let channel = start_channel(5, &proxy_side, "gdbPort", ServerTier::Unknown, None, tx).expect("start");

        let request = encode_packet(b"qSupported:multiprocess+");
        channel.feed_from_gdb(&request);
        assert_eq!(read_some(&mut server_side), request);

        let reply = encode_packet(b"PacketSize=4000;QStartNoAckMode+");
        server_side.write_all(&reply).unwrap();
        assert_eq!(next_data(&rx, 5), reply);

        channel.shutdown("test over");
    }

    #[test]
    fn a_packet_split_across_two_writes_arrives_whole_and_unreordered() {
        // GDB's packets do arrive in pieces, and the mux forwards on frame boundaries.
        // The guarantee being checked is that the boundary only delays -- what reaches
        // the gdb-server is the same bytes in the same order, never a packet with our
        // own traffic spliced into the middle of it.
        let (proxy_side, mut server_side) = socket_pair();
        let (tx, _rx) = channel();
        let channel = start_channel(5, &proxy_side, "gdbPort", ServerTier::Unknown, None, tx).expect("start");

        let whole = encode_packet(b"m20000000,10");
        let (head, tail) = whole.split_at(5);
        channel.feed_from_gdb(head);
        channel.feed_from_gdb(tail);

        // Read until the whole packet is there: it may cross TCP segments.
        let mut got = Vec::new();
        while got.len() < whole.len() {
            got.extend_from_slice(&read_some(&mut server_side));
        }
        assert_eq!(got, whole);

        channel.shutdown("test over");
    }

    #[test]
    fn the_connection_survives_the_message_loop_dropping_its_own_descriptor() {
        // The OS property this design rests on. `message_loop` surrenders its `TcpStream`
        // as soon as the mux takes over, so that `StreamConn::Muxed` can hold no socket
        // and the compiler can rule out a stray write. That is only safe because a
        // `try_clone` is a second descriptor onto the same connection: closing one does
        // not close the connection while another is open. If that were wrong, handing the
        // socket to the mux would tear down the gdb-server connection immediately.
        let (proxy_side, mut server_side) = socket_pair();
        let (tx, rx) = channel();
        let channel = start_channel(6, &proxy_side, "gdbPort", ServerTier::Unknown, None, tx).expect("start");

        drop(proxy_side);

        let request = encode_packet(b"qSupported:");
        channel.feed_from_gdb(&request);
        assert_eq!(read_some(&mut server_side), request, "writing died with the descriptor");

        let reply = encode_packet(b"PacketSize=1000");
        server_side.write_all(&reply).unwrap();
        assert_eq!(next_data(&rx, 6), reply, "reading died with the descriptor");

        channel.shutdown("test over");
    }

    #[test]
    fn the_server_hanging_up_closes_the_stream() {
        // `read_and_forward` sent `StreamClosed` on EOF; so must the mux, or a session
        // whose gdb-server dropped the connection would never be cleaned up.
        let (proxy_side, server_side) = socket_pair();
        let (tx, rx) = channel();
        let channel = start_channel(4, &proxy_side, "gdbPort", ServerTier::Unknown, None, tx).expect("start");
        drop(server_side);

        loop {
            match rx.recv_timeout(Duration::from_secs(2)) {
                Ok(ProxyEvent::StreamClosed { stream_id }) => {
                    assert_eq!(stream_id, 4);
                    break;
                }
                Ok(_) => continue,
                Err(RecvTimeoutError::Timeout) => panic!("EOF did not produce StreamClosed"),
                Err(e) => panic!("{e:?}"),
            }
        }
        channel.shutdown("test over");
    }
}
