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

//! The threaded shell around [`MuxCore`]: owns the byte streams, runs the reader
//! and writer threads, and performs the [`Action`]s the core emits.
//!
//! **Deliberately thin, and deliberately free of protocol logic.** Every rule
//! about what may be sent, when, and where a reply belongs lives in `mux.rs` and is
//! tested there without threads or sockets. This file is plumbing: if a decision
//! appears to be needed here, it belongs in the core instead.
//!
//! Two abstractions keep this usable outside the proxy, which
//! `docs-internal/gdb-rsp.md` D6 requires:
//!
//! - **The GDB side is a [`GdbSink`].** The proxy implements it by emitting funnel
//!   frames; a local deployment implements it by writing to GDB's socket (§4.7.2).
//!   Neither type appears here, so `gdb_rsp` depends on nothing in `proxy_helper`.
//! - **The gdb-server side is a plain `Read` + `Write` pair.** A `TcpStream` and its
//!   `try_clone()` for every server in the matrix; it would equally be a serial
//!   port, which is the only thing a Black Magic Probe bridge would need (§7).

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::common::sync::MutexExt;

use super::caps::{RspCaps, ServerTier};
use super::mux::{Action, ConsumerId, MuxCore};
use super::state::TargetState;
use super::trace::RspTrace;
use super::RspError;

/// One-shot reply channel handed to a blocked [`RspChannel::request`] caller.
type ReplyTx = Sender<Result<Vec<u8>, RspError>>;

/// In-flight Agent requests, keyed by the core's seq.
type Waiters = HashMap<u64, ReplyTx>;

/// How long the writer thread waits for work before checking deadlines. Only an
/// upper bound on tick latency: a request with a nearer deadline shortens it.
const IDLE_TICK: Duration = Duration::from_millis(250);

/// Where GDB-destined bytes go, and how the owner learns of lifecycle events.
///
/// Implemented by whatever is carrying GDB's half of the conversation. Kept as a
/// trait so this module never names a proxy type, and so the funnel and
/// direct-TCP deployments of §4.7.2 are the same code with a different sink.
pub trait GdbSink: Send + Sync + 'static {
    /// Forward bytes to the GDB client, verbatim and in order.
    ///
    /// Called from the mux's reader thread. Must not block for long: it is in the
    /// path of every reply GDB is waiting for.
    fn to_gdb(&self, bytes: &[u8]) -> std::io::Result<()>;

    /// The target's run state changed. Default: ignore.
    fn state_changed(&self, _state: TargetState) {}

    /// Capabilities were learned from GDB's `qSupported` exchange. Default: ignore.
    fn caps_learned(&self, _caps: &RspCaps) {}

    /// The channel has ended and will do nothing further.
    fn closed(&self, why: &str);
}

/// A live multiplexed RSP channel to one gdb-server port.
///
/// Cheap to clone (`Arc` inside). Drop the last clone, or call
/// [`RspChannel::shutdown`], to stop the threads.
#[derive(Clone)]
pub struct RspChannel {
    inner: Arc<Inner>,
}

struct Inner {
    core: Mutex<MuxCore>,
    /// Bytes bound for the gdb-server. A channel rather than a direct write so
    /// that nothing — not a stalled server, not a full socket buffer — can block
    /// the proxy's message loop, which is single-threaded and shared.
    write_tx: Sender<Vec<u8>>,
    /// One-shot senders for in-flight Agent requests, keyed by the core's seq.
    waiters: Mutex<Waiters>,
    sink: Arc<dyn GdbSink>,
    /// Allocates consumer ids.
    next_consumer: Mutex<ConsumerId>,
    /// Packet trace, when one was attached. Held here rather than in the core so
    /// the core stays sans-IO: it *describes* what happened, this writes it down.
    trace: Option<RspTrace>,
    stopping: AtomicBool,
}

impl RspChannel {
    /// Take ownership of a gdb-server connection and start multiplexing.
    ///
    /// `reader` and `writer` are the two halves of the same connection — for TCP,
    /// a `TcpStream` and its `try_clone()`. Reads and writes use separate OS
    /// operations, so the halves need no lock between them.
    pub fn start<R, W>(reader: R, writer: W, sink: Arc<dyn GdbSink>, tier: ServerTier, label: String) -> Self
    where
        R: Read + Send + 'static,
        W: Write + Send + 'static,
    {
        Self::start_traced(reader, writer, sink, tier, label, None)
    }

    /// As [`RspChannel::start`], with a packet trace attached.
    pub fn start_traced<R, W>(
        reader: R,
        writer: W,
        sink: Arc<dyn GdbSink>,
        tier: ServerTier,
        label: String,
        trace: Option<RspTrace>,
    ) -> Self
    where
        R: Read + Send + 'static,
        W: Write + Send + 'static,
    {
        let (write_tx, write_rx) = channel::<Vec<u8>>();
        let inner = Arc::new(Inner {
            core: Mutex::new(MuxCore::new(tier)),
            write_tx,
            waiters: Mutex::new(Waiters::new()),
            sink,
            next_consumer: Mutex::new(1),
            trace,
            stopping: AtomicBool::new(false),
        });
        if let Some(t) = &inner.trace {
            inner.core.lock_recover().set_trace_level(t.level());
        }

        spawn_guarded(Arc::clone(&inner), format!("rsp-mux-read-{label}"), {
            let inner = Arc::clone(&inner);
            move || inner.read_loop(reader)
        });
        spawn_guarded(Arc::clone(&inner), format!("rsp-mux-write-{label}"), {
            let inner = Arc::clone(&inner);
            move || inner.write_loop(writer, write_rx)
        });

        Self { inner }
    }

    /// Bytes arriving from the GDB client.
    ///
    /// **Never blocks.** Decoding is cheap and in-memory, and everything the core
    /// wants sent is handed to the writer thread through a channel. Safe to call
    /// from the proxy's message loop, which is what this guarantee exists for.
    pub fn feed_from_gdb(&self, bytes: &[u8]) {
        let actions = {
            let mut core = self.inner.core.lock_recover();
            core.on_gdb_bytes(bytes)
        };
        self.inner.perform(actions);
    }

    /// The GDB client disconnected. Its outstanding work is dropped; ours is not.
    pub fn gdb_disconnected(&self) {
        let actions = {
            let mut core = self.inner.core.lock_recover();
            core.gdb_disconnected()
        };
        self.inner.perform(actions);
    }

    /// Reserve an id for a consumer. No registration and no teardown to match:
    /// consumers are in-process and session-scoped, so this is for routing replies
    /// and nothing else (§4.7.2).
    pub fn new_consumer(&self) -> ConsumerId {
        let mut n = self.inner.next_consumer.lock_recover();
        let id = *n;
        *n += 1;
        id
    }

    /// Send one packet and wait for its reply.
    ///
    /// `payload` is an unframed packet body, and is checked against the
    /// forbidden-packet whitelist before it is queued. Blocks the calling thread
    /// only — never the message loop, which does not call this.
    pub fn request(&self, id: ConsumerId, payload: Vec<u8>, timeout: Duration) -> Result<Vec<u8>, RspError> {
        let (tx, rx) = channel();
        let seq = {
            let mut core = self.inner.core.lock_recover();
            let seq = core.submit(id, payload, Some(timeout))?;
            // Register before pumping, or a reply that arrives immediately would
            // find no waiter.
            self.inner.waiters.lock_recover().insert(seq, tx);
            seq
        };
        let actions = {
            let mut core = self.inner.core.lock_recover();
            core.pump()
        };
        self.inner.perform(actions);

        // A little beyond the core's own deadline: the core is what enforces the
        // timeout, and this is only a backstop against its tick never running.
        match rx.recv_timeout(timeout + Duration::from_secs(1)) {
            Ok(result) => result,
            Err(_) => {
                self.inner.waiters.lock_recover().remove(&seq);
                Err(RspError::Timeout)
            }
        }
    }

    pub fn state(&self) -> TargetState {
        self.inner.core.lock_recover().state()
    }

    pub fn caps(&self) -> RspCaps {
        self.inner.core.lock_recover().caps().clone()
    }

    /// Would one of our own packets go out now, or wait in the queue? See [`Consumer::ready`].
    pub fn agent_gate_open(&self) -> bool {
        self.inner.core.lock_recover().agent_gate_open()
    }

    pub fn set_tier(&self, tier: ServerTier) {
        self.inner.core.lock_recover().set_tier(tier);
    }

    /// Raise pipelining depth. Refused outside no-ack mode (§4.2.1).
    pub fn set_depth(&self, depth: usize) -> Result<(), RspError> {
        self.inner.core.lock_recover().set_depth(depth)
    }

    /// Stop the threads and fail everything outstanding.
    pub fn shutdown(&self, why: &'static str) {
        self.inner.stop(why);
    }
}

impl Inner {
    /// Perform what the core asked for. The core lock must **not** be held: these
    /// touch channels and the sink, and holding it across them would serialise the
    /// reader against the message loop for no reason.
    fn perform(&self, actions: Vec<Action>) {
        for action in actions {
            match action {
                Action::ToServer(bytes) => {
                    // A failed send means the writer thread is gone. That must never
                    // be swallowed: silently dropping bytes leaves GDB waiting for a
                    // reply to a packet that was never sent, which is the hang this
                    // whole file is arranged to avoid. `stop` is idempotent, so if
                    // the writer already reported why, that reason stands.
                    if self.write_tx.send(bytes).is_err() {
                        self.stop("the RSP writer thread is gone");
                        return;
                    }
                }
                Action::ToGdb(bytes) => {
                    if let Err(e) = self.sink.to_gdb(&bytes) {
                        log::info!("RSP mux: forwarding to GDB failed: {e}");
                        self.stop("failed to forward to the GDB client");
                        return;
                    }
                }
                Action::Completed { seq, result, .. } => {
                    // A missing waiter is normal: the caller may have given up
                    // already. The reply is simply dropped.
                    if let Some(tx) = self.waiters.lock_recover().remove(&seq) {
                        let _ = tx.send(result);
                    }
                }
                Action::StateChanged(state) => self.sink.state_changed(state),
                Action::CapsLearned => {
                    let caps = self.core.lock_recover().caps().clone();
                    self.sink.caps_learned(&caps);
                }
                Action::NoAckEngaged => {
                    log::debug!("RSP mux: no-ack mode engaged");
                }
                Action::Trace(event) => {
                    // Straight to the trace writer, which never blocks: it drops and
                    // counts under pressure rather than adding latency to RSP.
                    if let Some(trace) = &self.trace {
                        trace.record(event);
                    }
                }
                Action::Fatal(why) => {
                    self.stop(why);
                    return;
                }
            }
        }
    }

    fn read_loop<R: Read>(&self, mut reader: R) {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    self.stop("gdb-server closed the connection");
                    return;
                }
                Ok(n) => {
                    let actions = {
                        let mut core = self.core.lock_recover();
                        core.on_server_bytes(&buf[..n])
                    };
                    self.perform(actions);
                    if self.stopping.load(Ordering::SeqCst) {
                        return;
                    }
                }
                Err(e) => {
                    if self.stopping.load(Ordering::SeqCst) {
                        return;
                    }
                    log::info!("RSP mux: read from gdb-server failed: {e}");
                    self.stop("read from the gdb-server failed");
                    return;
                }
            }
        }
    }

    /// Drains queued bytes to the gdb-server, and doubles as the core's clock.
    ///
    /// One thread for both because they interleave naturally: a wait for work is
    /// exactly the moment to notice a deadline, and the core's `on_tick` may in
    /// turn produce bytes to write.
    fn write_loop<W: Write>(&self, mut writer: W, rx: Receiver<Vec<u8>>) {
        loop {
            if self.stopping.load(Ordering::SeqCst) {
                return;
            }
            let wait = self.tick_delay();
            match rx.recv_timeout(wait) {
                Ok(bytes) => {
                    if let Err(e) = writer.write_all(&bytes).and_then(|()| writer.flush()) {
                        log::info!("RSP mux: write to gdb-server failed: {e}");
                        self.stop("write to the gdb-server failed");
                        return;
                    }
                }
                Err(RecvTimeoutError::Timeout) => {
                    let actions = {
                        let mut core = self.core.lock_recover();
                        core.on_tick(Instant::now())
                    };
                    self.perform(actions);
                }
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }
    }

    /// How long the writer may wait: until the nearest deadline, capped.
    fn tick_delay(&self) -> Duration {
        let next = self.core.lock_recover().next_deadline();
        match next {
            Some(at) => at.saturating_duration_since(Instant::now()).min(IDLE_TICK),
            None => IDLE_TICK,
        }
    }

    /// Idempotent teardown. Fails every outstanding request so no consumer waits
    /// for a reply that can never come.
    fn stop(&self, why: &str) {
        if self.stopping.swap(true, Ordering::SeqCst) {
            return;
        }
        let actions = {
            let mut core = self.core.lock_recover();
            core.close("channel stopped")
        };
        // Deliver completions directly: `perform` would recurse into `stop`, and
        // there is no point writing to a server we are finished with.
        for action in actions {
            if let Action::Completed { seq, result, .. } = action {
                if let Some(tx) = self.waiters.lock_recover().remove(&seq) {
                    let _ = tx.send(result);
                }
            }
        }
        // Anything registered but never given a seq by the core.
        for (_, tx) in self.waiters.lock_recover().drain() {
            let _ = tx.send(Err(RspError::Closed));
        }
        self.sink.closed(why);
    }
}

/// Spawn one of the channel's threads so that it **cannot die silently**.
///
/// The same discipline as `proxy_helper`'s `spawn_session_thread`, and for the same
/// reason: a thread that vanishes without telling anyone leaves a peer blocked for
/// ever. Here the peer is GDB, which sits waiting for a reply to a packet nothing
/// will ever answer — a hung debug session with no diagnosis, which is a worse
/// outcome than a reported failure.
///
/// On **any** exit — normal return, I/O error, or panic — [`Inner::stop`] runs. That
/// fires `GdbSink::closed` and fails every outstanding request. `stop` is
/// idempotent and keeps the *first* reason given, so a body that already diagnosed
/// its own failure ("gdb-server closed the connection") keeps that wording and the
/// wrapper's generic reason is discarded.
///
/// This is a parallel implementation rather than a reuse of `spawn_session_thread`,
/// which is `pub(super)` inside `proxy_helper::proxy_server`: calling it would make
/// `gdb_rsp` depend on the proxy and break D6. The pattern is shared; the code is
/// not.
///
/// `AssertUnwindSafe` is sound here because the state behind `Inner` is reached
/// through mutexes that recover from poisoning (`lock_recover`). A panic mid-frame
/// could leave `MuxCore` internally inconsistent, but `stop` closes it immediately
/// afterwards, so the window is one call wide and the alternative — cascading
/// panics across a session — is worse.
fn spawn_guarded<F>(inner: Arc<Inner>, name: String, body: F)
where
    F: FnOnce() + Send + 'static,
{
    let thread_name = name.clone();
    std::thread::Builder::new()
        .name(name)
        .spawn(move || {
            let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(body)).is_err();
            if panicked {
                // The panic hook has already logged the location and backtrace.
                log::error!("RSP mux thread {thread_name} panicked; tearing down the channel");
            }
            inner.stop(if panicked {
                "an RSP mux thread panicked"
            } else {
                "an RSP mux thread exited"
            });
        })
        .expect("failed to spawn RSP mux thread");
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gdb_rsp::frame::encode_packet;
    use crate::gdb_rsp::trace::TraceLevel;
    use std::io;
    use std::sync::mpsc::TryRecvError;

    /// A gdb-server stand-in: what we wrote to it, and what it will say back.
    struct FakeServer {
        to_client: Receiver<Vec<u8>>,
        from_client: Sender<Vec<u8>>,
    }

    struct FakeReader {
        rx: Receiver<Vec<u8>>,
        buf: Vec<u8>,
    }

    impl Read for FakeReader {
        fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
            while self.buf.is_empty() {
                match self.rx.recv() {
                    Ok(b) => self.buf = b,
                    // Channel closed: EOF, which the read loop treats as the server
                    // hanging up.
                    Err(_) => return Ok(0),
                }
            }
            let n = out.len().min(self.buf.len());
            out[..n].copy_from_slice(&self.buf[..n]);
            self.buf.drain(..n);
            Ok(n)
        }
    }

    struct FakeWriter(Sender<Vec<u8>>);

    impl Write for FakeWriter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.0
                .send(bytes.to_vec())
                .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "gone"))?;
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    /// Records everything the channel sent to GDB.
    struct RecordingSink {
        gdb: Mutex<Vec<u8>>,
        closed: Mutex<Option<String>>,
        states: Mutex<Vec<TargetState>>,
    }

    impl RecordingSink {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                gdb: Mutex::new(Vec::new()),
                closed: Mutex::new(None),
                states: Mutex::new(Vec::new()),
            })
        }
        fn gdb_bytes(&self) -> Vec<u8> {
            self.gdb.lock_recover().clone()
        }
    }

    impl GdbSink for RecordingSink {
        fn to_gdb(&self, bytes: &[u8]) -> io::Result<()> {
            self.gdb.lock_recover().extend_from_slice(bytes);
            Ok(())
        }
        fn state_changed(&self, state: TargetState) {
            self.states.lock_recover().push(state);
        }
        fn closed(&self, why: &str) {
            *self.closed.lock_recover() = Some(why.to_string());
        }
    }

    fn rig(tier: ServerTier) -> (RspChannel, FakeServer, Arc<RecordingSink>) {
        let (srv_out_tx, srv_out_rx) = channel(); // server -> channel
        let (srv_in_tx, srv_in_rx) = channel(); // channel -> server
        let sink = RecordingSink::new();
        let ch = RspChannel::start(
            FakeReader {
                rx: srv_out_rx,
                buf: Vec::new(),
            },
            FakeWriter(srv_in_tx),
            Arc::clone(&sink) as Arc<dyn GdbSink>,
            tier,
            "test".to_string(),
        );
        (
            ch,
            FakeServer {
                to_client: srv_in_rx,
                from_client: srv_out_tx,
            },
            sink,
        )
    }

    /// Wait for the server side to receive something, with a bounded spin so a
    /// failure is a failure rather than a hang.
    fn expect_from_channel(srv: &FakeServer) -> Vec<u8> {
        srv.to_client
            .recv_timeout(Duration::from_secs(2))
            .expect("channel sent nothing to the gdb-server")
    }

    /// Drive the startup handshake through the real threads.
    fn handshake(ch: &RspChannel, srv: &FakeServer, sink: &RecordingSink) {
        ch.feed_from_gdb(&encode_packet(b"qSupported:multiprocess+"));
        expect_from_channel(srv);
        srv.from_client
            .send(encode_packet(b"PacketSize=4000;QStartNoAckMode+"))
            .unwrap();
        ch.feed_from_gdb(b"+");
        expect_from_channel(srv);
        ch.feed_from_gdb(&encode_packet(b"QStartNoAckMode"));
        expect_from_channel(srv);
        srv.from_client.send(b"+".to_vec()).unwrap();
        srv.from_client.send(encode_packet(b"OK")).unwrap();
        // GDB acks that `OK` and only then switches to no-ack, so exactly one stray
        // `+` arrives after we already consider the link no-ack. Included here so
        // every channel test runs the sequence a real GDB produces rather than a
        // tidied-up one; see the mux test of the same name for the assertions.
        ch.feed_from_gdb(b"+");
        assert_eq!(
            expect_from_channel(srv),
            b"+".to_vec(),
            "the stray ack must be forwarded"
        );
        ch.feed_from_gdb(&encode_packet(b"?"));
        expect_from_channel(srv);
        srv.from_client.send(encode_packet(b"T05thread:01;")).unwrap();
        // Let the reader thread drain what we queued.
        //
        // Both halves are waited for, and the second is not redundant: `state()` is the mux's view,
        // updated as the stop reply is *parsed*, while forwarding it to GDB is a separate action
        // carried out afterwards. A test that samples `gdb_bytes()` on the strength of the state
        // alone can catch the stop reply still in flight -- which it did, about one run in five,
        // seeing 43 bytes where 60 were coming: the difference is exactly the 17 bytes of the framed stop reply.
        for _ in 0..200 {
            if ch.state() == TargetState::Stopped && sink.gdb_bytes().ends_with(&encode_packet(b"T05thread:01;")) {
                return;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        panic!("handshake did not settle; state is {:?}", ch.state());
    }

    #[test]
    fn gdb_bytes_are_forwarded_to_the_server_through_the_writer_thread() {
        let (ch, srv, _sink) = rig(ServerTier::Full);
        let pkt = encode_packet(b"qSupported:");
        ch.feed_from_gdb(&pkt);
        assert_eq!(expect_from_channel(&srv), pkt);
    }

    #[test]
    fn server_replies_reach_gdb_verbatim() {
        let (ch, srv, sink) = rig(ServerTier::Full);
        ch.feed_from_gdb(&encode_packet(b"qSupported:"));
        expect_from_channel(&srv);
        let reply = encode_packet(b"PacketSize=1000");
        srv.from_client.send(reply.clone()).unwrap();
        for _ in 0..200 {
            if sink.gdb_bytes() == reply {
                return;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(sink.gdb_bytes(), reply);
    }

    #[test]
    fn a_request_completes_through_the_real_threads() {
        let (ch, srv, sink) = rig(ServerTier::Full);
        handshake(&ch, &srv, &sink);

        let id = ch.new_consumer();
        let ch2 = ch.clone();
        let worker = std::thread::spawn(move || ch2.request(id, b"m20000000,4".to_vec(), Duration::from_secs(2)));

        assert_eq!(expect_from_channel(&srv), encode_packet(b"m20000000,4"));
        srv.from_client.send(encode_packet(b"deadbeef")).unwrap();
        assert_eq!(worker.join().unwrap().unwrap(), b"deadbeef".to_vec());
    }

    #[test]
    fn a_consumer_reply_is_not_forwarded_to_gdb() {
        let (ch, srv, sink) = rig(ServerTier::Full);
        handshake(&ch, &srv, &sink);
        let before = sink.gdb_bytes().len();

        let id = ch.new_consumer();
        let ch2 = ch.clone();
        let worker = std::thread::spawn(move || ch2.request(id, b"m0,4".to_vec(), Duration::from_secs(2)));
        expect_from_channel(&srv);
        srv.from_client.send(encode_packet(b"aabbccdd")).unwrap();
        worker.join().unwrap().unwrap();

        assert_eq!(sink.gdb_bytes().len(), before, "our reply leaked to GDB");
    }

    #[test]
    fn a_forbidden_packet_is_refused_without_reaching_the_server() {
        let (ch, srv, sink) = rig(ServerTier::Full);
        handshake(&ch, &srv, &sink);
        let id = ch.new_consumer();
        assert!(ch.request(id, b"c".to_vec(), Duration::from_millis(200)).is_err());
        assert!(
            matches!(srv.to_client.try_recv(), Err(TryRecvError::Empty)),
            "a forbidden packet was written to the gdb-server"
        );
    }

    #[test]
    fn a_request_times_out_rather_than_hanging_for_ever() {
        let (ch, srv, sink) = rig(ServerTier::Full);
        handshake(&ch, &srv, &sink);
        let id = ch.new_consumer();
        // Server never answers.
        let err = ch
            .request(id, b"m0,4".to_vec(), Duration::from_millis(150))
            .unwrap_err();
        assert_eq!(err, RspError::Timeout);
        // And the slot was freed, so the next request still goes out.
        expect_from_channel(&srv);
        let ch2 = ch.clone();
        let worker = std::thread::spawn(move || ch2.request(id, b"m4,4".to_vec(), Duration::from_secs(2)));
        assert_eq!(expect_from_channel(&srv), encode_packet(b"m4,4"));
        srv.from_client.send(encode_packet(b"11223344")).unwrap();
        assert!(worker.join().unwrap().is_ok());
    }

    #[test]
    fn the_server_hanging_up_fails_outstanding_requests_and_reports_once() {
        let (ch, srv, sink) = rig(ServerTier::Full);
        handshake(&ch, &srv, &sink);
        let id = ch.new_consumer();
        let ch2 = ch.clone();
        let worker = std::thread::spawn(move || ch2.request(id, b"m0,4".to_vec(), Duration::from_secs(5)));
        expect_from_channel(&srv);

        // Dropping the server's sender is EOF on the reader.
        drop(srv.from_client);
        assert_eq!(worker.join().unwrap().unwrap_err(), RspError::Closed);
        assert!(sink.closed.lock_recover().is_some(), "teardown was not reported");
    }

    /// A reader that hands over one real chunk and then blows up.
    ///
    /// It must return **non-zero** first: `Ok(0)` is EOF, which the read loop
    /// handles cleanly, and a reader that returned it would make the test below pass
    /// without ever provoking a panic.
    struct PanickingReader {
        served: bool,
    }

    impl Read for PanickingReader {
        fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
            if self.served {
                panic!("deliberate test panic in the RSP reader thread");
            }
            self.served = true;
            out[0] = b'+';
            Ok(1)
        }
    }

    #[test]
    fn a_panicking_reader_thread_tears_the_channel_down_instead_of_hanging_gdb() {
        // The failure this guard exists for. Without `catch_unwind` + `stop`, a
        // panicked reader leaves GDB waiting for a reply that will never come and
        // nobody is told -- a hung debug session with no diagnosis.
        let (_srv_out_tx, srv_out_rx) = channel::<Vec<u8>>();
        let (srv_in_tx, _srv_in_rx) = channel::<Vec<u8>>();
        let sink = RecordingSink::new();
        let ch = RspChannel::start(
            PanickingReader { served: false },
            FakeWriter(srv_in_tx),
            Arc::clone(&sink) as Arc<dyn GdbSink>,
            ServerTier::Full,
            "panic".to_string(),
        );
        drop(srv_out_rx);

        for _ in 0..400 {
            if sink.closed.lock_recover().is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        // Assert on the *reason*, not merely that something was reported. The EOF
        // path also reports, so a reader that returned `Ok(0)` would satisfy a
        // weaker assertion without the panic guard doing any work at all.
        let why = sink.closed.lock_recover().clone();
        assert_eq!(
            why.as_deref(),
            Some("an RSP mux thread panicked"),
            "teardown did not come from the panic guard"
        );

        // And the channel refuses new work rather than accepting it silently.
        let id = ch.new_consumer();
        assert_eq!(
            ch.request(id, b"m0,4".to_vec(), Duration::from_millis(200))
                .unwrap_err(),
            RspError::Closed
        );
    }

    #[test]
    fn an_outstanding_request_fails_when_a_thread_dies_unexpectedly() {
        let (ch, srv, sink) = rig(ServerTier::Full);
        handshake(&ch, &srv, &sink);
        let id = ch.new_consumer();
        let ch2 = ch.clone();
        let worker = std::thread::spawn(move || ch2.request(id, b"m0,4".to_vec(), Duration::from_secs(30)));
        expect_from_channel(&srv);

        // Simulate the writer half vanishing: dropping the server's reader makes
        // every subsequent write fail, which must be reported rather than swallowed.
        drop(srv.to_client);
        drop(srv.from_client);

        // The request must fail promptly -- well inside its own 30s timeout, which is
        // the point: teardown notifies rather than letting the deadline expire.
        let started = Instant::now();
        let err = worker.join().unwrap().unwrap_err();
        assert_eq!(err, RspError::Closed);
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "waited for the timeout instead of being told"
        );
        assert!(sink.closed.lock_recover().is_some());
    }

    #[test]
    fn the_trace_file_shows_a_real_interleaved_session() {
        // End to end through the actual threads: GDB continues, we read memory while
        // the target runs, the target halts. The resulting file must show all four
        // parties in wire order -- which is the whole point, since two of them are
        // invisible to GDB's own trace and to the server's log.
        let (srv_out_tx, srv_out_rx) = channel();
        let (srv_in_tx, srv_in_rx) = channel();
        let sink = RecordingSink::new();
        let traced = Arc::new(Mutex::new(Vec::<u8>::new()));

        struct Shared(Arc<Mutex<Vec<u8>>>);
        impl Write for Shared {
            fn write(&mut self, b: &[u8]) -> io::Result<usize> {
                self.0.lock_recover().extend_from_slice(b);
                Ok(b.len())
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }

        let trace = RspTrace::to_writer(Box::new(Shared(Arc::clone(&traced))), "gdbPort", TraceLevel::Packets);
        let ch = RspChannel::start_traced(
            FakeReader {
                rx: srv_out_rx,
                buf: Vec::new(),
            },
            FakeWriter(srv_in_tx),
            Arc::clone(&sink) as Arc<dyn GdbSink>,
            ServerTier::Full,
            "gdbPort".to_string(),
            Some(trace),
        );
        let srv = FakeServer {
            to_client: srv_in_rx,
            from_client: srv_out_tx,
        };
        handshake(&ch, &srv, &sink);

        ch.feed_from_gdb(&encode_packet(b"vCont;c"));
        expect_from_channel(&srv);

        let id = ch.new_consumer();
        let ch2 = ch.clone();
        let worker = std::thread::spawn(move || ch2.request(id, b"m20000000,4".to_vec(), Duration::from_secs(2)));
        expect_from_channel(&srv);
        srv.from_client.send(encode_packet(b"deadbeef")).unwrap();
        worker.join().unwrap().unwrap();
        srv.from_client.send(encode_packet(b"T05")).unwrap();

        // Let the trace writer catch up.
        let mut text = String::new();
        for _ in 0..400 {
            text = String::from_utf8_lossy(&traced.lock_recover()).to_string();
            if text.contains("SRV>GDB  $T05") {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }

        for token in ["GDB>SRV", "SRV>GDB", "AGT>SRV", "SRV>AGT"] {
            assert!(text.contains(token), "trace is missing {token}:\n{text}");
        }
        assert!(
            text.contains("AGT>SRV  $m20000000,4"),
            "injected read not traced:\n{text}"
        );
        assert!(
            text.contains("SRV>AGT  $deadbeef"),
            "consumed reply not traced:\n{text}"
        );
        // The consumed reply must NOT appear as having gone to GDB.
        assert!(
            !text.contains("SRV>GDB  $deadbeef"),
            "our reply was traced as going to GDB:\n{text}"
        );
        // `grep AGT` isolates the Agent's traffic: request and reply, nothing else.
        let agt: Vec<&str> = text
            .lines()
            .filter(|l| !l.starts_with('#') && l.contains("AGT"))
            .collect();
        assert_eq!(agt.len(), 2, "expected exactly the request and its reply:\n{agt:#?}");
    }

    #[test]
    fn shutdown_is_idempotent() {
        let (ch, srv, sink) = rig(ServerTier::Full);
        handshake(&ch, &srv, &sink);
        ch.shutdown("first");
        ch.shutdown("second");
        assert_eq!(sink.closed.lock_recover().as_deref(), Some("first"));
    }

    #[test]
    fn a_halted_only_server_holds_a_read_until_the_target_halts() {
        let (ch, srv, sink) = rig(ServerTier::HaltedOnly);
        handshake(&ch, &srv, &sink);
        // Target resumes.
        ch.feed_from_gdb(&encode_packet(b"vCont;c"));
        assert_eq!(expect_from_channel(&srv), encode_packet(b"vCont;c"));

        let id = ch.new_consumer();
        let ch2 = ch.clone();
        let worker = std::thread::spawn(move || ch2.request(id, b"m0,4".to_vec(), Duration::from_secs(5)));

        // Nothing should be sent while running on a HaltedOnly server.
        assert!(
            matches!(
                srv.to_client.recv_timeout(Duration::from_millis(200)),
                Err(RecvTimeoutError::Timeout)
            ),
            "read was issued while the target was running"
        );

        // Halt: the queued read is released.
        srv.from_client.send(encode_packet(b"T05")).unwrap();
        assert_eq!(expect_from_channel(&srv), encode_packet(b"m0,4"));
        srv.from_client.send(encode_packet(b"aabbccdd")).unwrap();
        assert_eq!(worker.join().unwrap().unwrap(), b"aabbccdd".to_vec());
    }

    #[test]
    fn feed_from_gdb_does_not_block_when_the_server_never_reads() {
        // The guarantee the proxy's message loop depends on. The writer thread owns
        // the socket, so a server that never drains cannot stall the caller.
        let (ch, srv, _sink) = rig(ServerTier::Full);
        // Never touch `srv.to_client`, so nothing is consumed.
        let start = Instant::now();
        for _ in 0..500 {
            ch.feed_from_gdb(&encode_packet(b"m0,4"));
        }
        assert!(
            start.elapsed() < Duration::from_secs(1),
            "feed_from_gdb blocked: {:?}",
            start.elapsed()
        );
        drop(srv);
    }
}
