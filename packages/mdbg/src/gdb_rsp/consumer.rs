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

//! What the Agent's own features see of an RSP channel (`docs-internal/gdb-rsp.md` item 11b).
//!
//! RTT, PC sampling and a trace drain all want the same two operations — read this memory, write
//! that memory — and none of them should have to know about packet sizes, `m` versus `x`, short
//! replies or reply routing. This is the layer that knows, and it is deliberately the *only*
//! thing above [`RspChannel`] that features are expected to use.
//!
//! **There is no attach or detach** (§4.7.2). An earlier draft of the design had consumers
//! registering and unregistering, copied in shape from `serial/port.rs`. That was wrong for this
//! case: a serial port outlives the sessions that use it, so its clients have to be tracked,
//! whereas these consumers are in-process and last exactly as long as the channel. A
//! [`ConsumerId`] for routing replies is the whole of what is needed, and it is handed out by
//! [`RspChannel::new_consumer`].
//!
//! Every call **blocks the calling thread** and none of them blocks the proxy's message loop,
//! which is the property that makes this safe to use from a poll loop of its own. See
//! [`RspChannel::request`].

use std::time::Duration;

use crate::gdb_rsp::{ConsumerId, ReadAssembler, RspChannel, RspError, TargetState, WriteAssembler};

/// Byte order of the target's words.
///
/// Only needed by the word-sized helpers; [`Consumer::read_memory`] is a byte stream and has no
/// opinion. Cortex-M is little-endian in all but name, but the RTT control block is target-endian
/// and the TypeScript implementation already carries the distinction (`TargetInfo.endianness`), so
/// dropping it here would be losing information we have.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Endian {
    #[default]
    Little,
    Big,
}

/// One of the Agent's features, on one channel.
///
/// Cheap to create and cheap to clone: it is an id, a timeout and a channel handle.
#[derive(Clone)]
pub struct Consumer {
    channel: RspChannel,
    id: ConsumerId,
    timeout: Duration,
    endian: Endian,
}

impl Consumer {
    /// Allocate an id on `channel` and return a handle that uses it.
    pub fn new(channel: &RspChannel, timeout: Duration) -> Self {
        Self {
            id: channel.new_consumer(),
            channel: channel.clone(),
            timeout,
            endian: Endian::Little,
        }
    }

    pub fn with_endian(mut self, endian: Endian) -> Self {
        self.endian = endian;
        self
    }

    pub fn id(&self) -> ConsumerId {
        self.id
    }

    pub fn timeout(&self) -> Duration {
        self.timeout
    }

    pub fn state(&self) -> TargetState {
        self.channel.state()
    }

    /// Would a request go out now, or would it sit in the queue?
    ///
    /// Worth asking in a poll loop. A request submitted while the gate is shut is not refused, it
    /// *waits* — for the handshake, for GDB to finish a packet, or for a target that this server
    /// will not read while it runs (§4.2, §7) — and then fails with [`RspError::Timeout`] seconds
    /// later. That is slow, and it reports a stall as a fault. Checking first costs one lock.
    ///
    /// It is not a guarantee: the gate can shut between this call and the next request. It is a
    /// way to skip a poll cheaply, not a lock.
    pub fn ready(&self) -> bool {
        self.channel.agent_gate_open()
    }

    /// Read `len` bytes from `addr`.
    ///
    /// Split across as many packets as the server's `PacketSize` requires, and resumed correctly
    /// when the stub answers with fewer bytes than asked for — which is legal, and which
    /// [`ReadAssembler`] exists to handle.
    pub fn read_memory(&self, addr: u64, len: usize) -> Result<Vec<u8>, RspError> {
        let (data, err) = self.read_memory_partial(addr, len);
        match err {
            Some(e) => Err(e),
            None => Ok(data),
        }
    }

    /// As [`Consumer::read_memory`], but keeping what arrived before the failure.
    ///
    /// For most callers a partial read is worthless and [`Consumer::read_memory`] is the one to
    /// use: RTT, in particular, must not consume half a ring buffer, because advancing the read
    /// pointer by what it got would desynchronise the channel for the rest of the session. This
    /// exists for the caller that can say "I got this far", which is a better diagnostic than a
    /// bare error when a read spans a region that stops being mapped part way through.
    pub fn read_memory_partial(&self, addr: u64, len: usize) -> (Vec<u8>, Option<RspError>) {
        // Re-read the capabilities on every call rather than caching them at construction. They
        // are learned from GDB's own `qSupported` exchange (§4.4), which may not have happened
        // when this consumer was created -- and a consumer built too early would otherwise chunk
        // to the 400-byte default for the rest of the session.
        let caps = self.channel.caps();
        let mut asm = ReadAssembler::new(&caps, addr, len);
        // Retries are only ever spent on a reply the server *sent* and mangled, never on silence or
        // on a target error. Bounded, and each one halves the request, so the worst case is a handful
        // of packets rather than a loop.
        let mut shrinks_left = 4u8;
        while let Some(request) = asm.next_request() {
            let reply = match self.channel.request(self.id, request, self.timeout) {
                Ok(reply) => reply,
                // The reply arrived and could not be used. A read is idempotent, so ask again -- and
                // ask for less, because the fault may be a property of the reply's *size*. Without
                // this the same length is requested for ever and the channel stalls on data it can
                // never collect.
                Err(RspError::ReplyRejected) if shrinks_left > 0 && asm.shrink_budget() => {
                    shrinks_left -= 1;
                    continue;
                }
                Err(e) => return (asm.collected().to_vec(), Some(e)),
            };
            if let Err(e) = asm.accept(&reply) {
                return (asm.collected().to_vec(), Some(e));
            }
        }
        (asm.finish(), None)
    }

    /// Write `data` to `addr`.
    pub fn write_memory(&self, addr: u64, data: &[u8]) -> Result<(), RspError> {
        match self.write_memory_partial(addr, data).1 {
            Some(e) => Err(e),
            None => Ok(()),
        }
    }

    /// As [`Consumer::write_memory`], also reporting how many bytes did land.
    ///
    /// A failed write leaves the target half-updated, and how far it got is not recoverable by
    /// reading back -- the written bytes may be identical to what was there. A caller that is
    /// updating a pointer or a flag needs to know, which is why this is not simply discarded.
    pub fn write_memory_partial(&self, addr: u64, data: &[u8]) -> (usize, Option<RspError>) {
        let caps = self.channel.caps();
        let mut asm = WriteAssembler::new(&caps, addr, data);
        while let Some(request) = asm.next_request() {
            let reply = match self.channel.request(self.id, request, self.timeout) {
                Ok(reply) => reply,
                Err(e) => return (data.len() - asm.remaining(), Some(e)),
            };
            if let Err(e) = asm.accept(&reply) {
                return (data.len() - asm.remaining(), Some(e));
            }
        }
        (data.len(), None)
    }

    /// Read one 32-bit word, in the target's byte order.
    pub fn read_u32(&self, addr: u64) -> Result<u32, RspError> {
        let bytes = self.read_memory(addr, 4)?;
        let word: [u8; 4] = bytes
            .try_into()
            // `read_memory` returns exactly what was asked for or an error, so this cannot fire;
            // it is here so that a future change to that contract shows up as an error rather
            // than as a silently wrong word.
            .map_err(|_| RspError::Malformed("short reply for a 32-bit read"))?;
        Ok(match self.endian {
            Endian::Little => u32::from_le_bytes(word),
            Endian::Big => u32::from_be_bytes(word),
        })
    }

    /// Write one 32-bit word, in the target's byte order.
    pub fn write_u32(&self, addr: u64, value: u32) -> Result<(), RspError> {
        let bytes = match self.endian {
            Endian::Little => value.to_le_bytes(),
            Endian::Big => value.to_be_bytes(),
        };
        self.write_memory(addr, &bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::common::sync::MutexExt;
    use crate::gdb_rsp::frame::encode_packet;
    use crate::gdb_rsp::RspCaps;
    use crate::gdb_rsp::{GdbSink, ServerTier};
    use std::io::{self, Read, Write};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc::{channel, Receiver, Sender};
    use std::sync::{Arc, Mutex};

    /// A gdb-server that answers from a script, so a test states the wire exchange it expects.
    ///
    /// Reads block until the writer side has something, which is what makes this usable as the
    /// reader half of a channel: the real one blocks on a socket.
    struct ScriptedServer {
        /// Requests the channel sent, in order.
        seen: Arc<Mutex<Vec<Vec<u8>>>>,
        /// Replies to hand back, in order. A `None` entry means "say nothing", to test a timeout.
        replies: Arc<Mutex<Vec<Option<Vec<u8>>>>>,
        to_channel: Sender<Vec<u8>>,
        /// False until the handshake is done. GDB's own packets reach this server too, and while
        /// it was answering them from the script the first two script entries were consumed by
        /// `qSupported` and `?` -- so every test timed out waiting for a reply that had already
        /// been spent.
        armed: Arc<AtomicBool>,
    }

    struct ServerReader {
        rx: Receiver<Vec<u8>>,
        buf: Vec<u8>,
    }

    impl Read for ServerReader {
        fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
            while self.buf.is_empty() {
                match self.rx.recv() {
                    Ok(bytes) => self.buf = bytes,
                    Err(_) => return Ok(0), // the test is over
                }
            }
            let n = out.len().min(self.buf.len());
            out[..n].copy_from_slice(&self.buf[..n]);
            self.buf.drain(..n);
            Ok(n)
        }
    }

    impl Write for ScriptedServer {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            // The channel writes whole framed packets, so one write is one request.
            self.seen.lock_recover().push(bytes.to_vec());
            if !self.armed.load(Ordering::SeqCst) {
                return Ok(bytes.len()); // handshake: the test injects those replies itself
            }
            let next = {
                let mut r = self.replies.lock_recover();
                if r.is_empty() {
                    None
                } else {
                    r.remove(0)
                }
            };
            // An exhausted script and an explicit `None` both mean "say nothing", which is how
            // a timeout is tested.
            if let Some(reply) = next {
                let _ = self.to_channel.send(encode_packet(&reply));
            }
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    struct NullSink;
    impl GdbSink for NullSink {
        fn to_gdb(&self, _bytes: &[u8]) -> io::Result<()> {
            Ok(())
        }
        fn closed(&self, _why: &str) {}
    }

    /// A channel whose server answers `replies` in order, already past the handshake.
    fn scripted(replies: Vec<Option<Vec<u8>>>) -> (RspChannel, Arc<Mutex<Vec<Vec<u8>>>>) {
        let (tx, rx) = channel();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let armed = Arc::new(AtomicBool::new(false));
        let server = ScriptedServer {
            seen: Arc::clone(&seen),
            replies: Arc::new(Mutex::new(replies)),
            to_channel: tx.clone(),
            armed: Arc::clone(&armed),
        };
        let reader = ServerReader { rx, buf: Vec::new() };
        let ch = RspChannel::start(reader, server, Arc::new(NullSink), ServerTier::Full, "test".into());

        // Drive the handshake from the GDB side, because that is where it comes from: the mux
        // learns the capabilities, the ack mode and the run state by watching GDB's own traffic
        // (§4.4), and the send gate stays shut until all three are settled. Advertising
        // `QStartNoAckMode` and then not completing the switch is *not* settled -- `handshake_settled`
        // waits for either no-ack in force or no-ack never offered -- so the negotiation is played
        // out in full, which is also the mode a real session ends up in.
        //
        // `PacketSize=100` is 0x100 = 256 bytes, so 128 bytes per `m` reply: small enough that the
        // chunking below is exercised rather than assumed.
        ch.feed_from_gdb(&encode_packet(b"qSupported:multiprocess+"));
        tx.send(encode_packet(b"PacketSize=100;QStartNoAckMode+")).unwrap();
        ch.feed_from_gdb(&encode_packet(b"QStartNoAckMode"));
        tx.send(encode_packet(b"OK")).unwrap();
        ch.feed_from_gdb(&encode_packet(b"?"));
        tx.send(encode_packet(b"T05")).unwrap();

        // Wait for **both** the gate and the server having seen all three of GDB's packets, which
        // are not the same event. The replies above are injected straight into the reader thread,
        // while the requests travel out through the writer thread -- so the gate can open while
        // GDB's packets are still queued for the server. Arming at that moment let those queued
        // writes pop entries from the test's reply script, desynchronising everything after it.
        // Rare when this test runs alone; reliable under a loaded parallel run.
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !ch.agent_gate_open() || seen.lock_recover().len() < 3 {
            assert!(
                std::time::Instant::now() < deadline,
                "the handshake never settled: state={:?}, gate={}, requests seen={}",
                ch.state(),
                ch.agent_gate_open(),
                seen.lock_recover().len()
            );
            std::thread::sleep(Duration::from_millis(2));
        }
        seen.lock_recover().clear(); // GDB's own packets are not what these tests assert on
        armed.store(true, Ordering::SeqCst);
        (ch, seen)
    }

    fn consumer(ch: &RspChannel) -> Consumer {
        Consumer::new(ch, Duration::from_secs(2))
    }

    /// The payload of each request the server saw, framing stripped.
    fn requests(seen: &Arc<Mutex<Vec<Vec<u8>>>>) -> Vec<String> {
        seen.lock_recover()
            .iter()
            .map(|raw| String::from_utf8_lossy(&raw[1..raw.len() - 3]).to_string())
            .collect()
    }

    #[test]
    fn a_read_that_fits_in_one_packet_is_one_packet() {
        let (ch, seen) = scripted(vec![Some(b"deadbeef".to_vec())]);
        let c = consumer(&ch);
        assert_eq!(c.read_memory(0x2000_0000, 4).unwrap(), vec![0xde, 0xad, 0xbe, 0xef]);
        assert_eq!(requests(&seen), vec!["m20000000,4"]);
        ch.shutdown("test over");
    }

    #[test]
    fn a_read_larger_than_packetsize_is_split_and_reassembled() {
        // PacketSize=0x100 means 128 bytes per `m` reply (two hex digits per byte), so 200 bytes
        // is two packets. The caller must not have to know that.
        let first = "aa".repeat(128);
        let second = "bb".repeat(72);
        let (ch, seen) = scripted(vec![Some(first.into_bytes()), Some(second.into_bytes())]);
        let c = consumer(&ch);
        let data = c.read_memory(0x1000, 200).unwrap();
        assert_eq!(data.len(), 200);
        assert!(data[..128].iter().all(|&b| b == 0xaa));
        assert!(data[128..].iter().all(|&b| b == 0xbb));
        assert_eq!(requests(&seen), vec!["m1000,80", "m1080,48"]);
        ch.shutdown("test over");
    }

    #[test]
    fn a_short_reply_is_resumed_from_where_the_stub_stopped() {
        // Legal per the manual: "the reply may contain fewer addressable memory units than
        // requested". Asked for 8, given 2, so the rest is asked for again from 0x1002.
        let (ch, seen) = scripted(vec![Some(b"1122".to_vec()), Some(b"3344556677889900".to_vec())]);
        let c = consumer(&ch);
        let data = c.read_memory(0x1000, 8).unwrap();
        assert_eq!(data, vec![0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88]);
        assert_eq!(requests(&seen), vec!["m1000,8", "m1002,6"]);
        ch.shutdown("test over");
    }

    #[test]
    fn a_target_error_is_reported_rather_than_returned_as_short_data() {
        let (ch, _seen) = scripted(vec![Some(b"E0e".to_vec())]);
        let c = consumer(&ch);
        match c.read_memory(0x2000_0000, 4) {
            Err(RspError::Target(code)) => assert_eq!(code, Some(0x0e)),
            other => panic!("expected a target error, got {other:?}"),
        }
        ch.shutdown("test over");
    }

    #[test]
    fn a_mangled_reply_is_retried_with_a_smaller_request() {
        // The ST-LINK gdb-server truncates a reply of exactly 1024 bytes, losing its final checksum
        // digit to a NUL terminator, so a 510-byte read fails every time while 509 or 511 succeed.
        // Asking again at the same length would stall the channel on data it can never collect, so
        // the point of shrinking is that the next attempt is a *different size*.
        //
        // `next_request` yields the unframed payload; framing happens when it is sent.
        let (ch, _seen) = scripted(vec![]);
        // PacketSize 0x100 gives a 128-byte budget for a hex read.
        let mut asm = ReadAssembler::new(&ch.caps(), 0x1000, 200);
        assert_eq!(asm.next_request().unwrap(), b"m1000,80".to_vec());
        assert!(asm.shrink_budget(), "128 can be halved");
        assert_eq!(
            asm.next_request().unwrap(),
            b"m1000,40".to_vec(),
            "asks for half as much, from the same address"
        );
        ch.shutdown("test over");
    }

    #[test]
    fn shrinking_is_measured_from_the_request_not_the_budget_ceiling() {
        // The case that actually happens, and that an earlier version of this got wrong. RTT reads a
        // few hundred bytes while `PacketSize` allows 8192, so the budget sits far above the request:
        // halving the *budget* leaves `remaining.min(budget)` unchanged and resends the identical
        // packet -- which, for a fault that depends on the reply's size, is no retry at all.
        let caps = RspCaps::parse_reply("PacketSize=4000");
        assert_eq!(caps.max_read_bytes(), 8192, "budget far above the read below");
        let mut asm = ReadAssembler::new(&caps, 0x2000_0103, 510);
        assert_eq!(asm.next_request().unwrap(), b"m20000103,1fe".to_vec());
        assert!(asm.shrink_budget());
        assert_eq!(
            asm.next_request().unwrap(),
            b"m20000103,ff".to_vec(),
            "255 bytes, not 510 again"
        );
    }

    #[test]
    fn shrinking_stops_at_one_byte_rather_than_reaching_zero() {
        // A zero-length request would ask for nothing and be answered with nothing, which
        // `ReadAssembler::accept` treats as a stub refusing without saying so -- trading a stall for
        // an error loop.
        let (ch, _seen) = scripted(vec![]);
        let mut asm = ReadAssembler::new(&ch.caps(), 0x1000, 4096);
        let mut shrinks = 0;
        while asm.shrink_budget() {
            shrinks += 1;
            assert!(shrinks < 64, "shrinking must terminate");
        }
        assert_eq!(asm.next_request().unwrap(), b"m1000,1".to_vec(), "never below one byte");
        ch.shutdown("test over");
    }

    #[test]
    fn a_partial_read_keeps_what_arrived() {
        // First chunk fine, second refused. `read_memory` must fail -- half a ring buffer is
        // worse than none -- but the bytes are available to a caller that wants to say how far
        // it got.
        let first = "cc".repeat(128);
        let (ch, _seen) = scripted(vec![Some(first.into_bytes()), Some(b"E05".to_vec())]);
        let c = consumer(&ch);
        let (data, err) = c.read_memory_partial(0x1000, 200);
        assert_eq!(data.len(), 128);
        assert!(matches!(err, Some(RspError::Target(_))));
        ch.shutdown("test over");
    }

    #[test]
    fn a_zero_length_read_sends_nothing() {
        let (ch, seen) = scripted(vec![]);
        let c = consumer(&ch);
        assert_eq!(c.read_memory(0x1000, 0).unwrap(), Vec::<u8>::new());
        assert_eq!(
            requests(&seen),
            Vec::<String>::new(),
            "no packet may go out for no bytes"
        );
        ch.shutdown("test over");
    }

    #[test]
    fn a_write_is_split_and_reports_how_far_it_got_on_failure() {
        // Binary writes are not negotiated here, so `M` is used: PacketSize=0x100 with two hex
        // digits per byte plus the header leaves well under 128 bytes per packet.
        let (ch, seen) = scripted(vec![Some(b"OK".to_vec()), Some(b"E02".to_vec())]);
        let c = consumer(&ch);
        let (written, err) = c.write_memory_partial(0x2000_0000, &[0x5a; 200]);
        assert!(matches!(err, Some(RspError::Target(_))));
        assert!(written > 0 && written < 200, "expected a partial write, got {written}");
        assert_eq!(requests(&seen).len(), 2);
        ch.shutdown("test over");
    }

    #[test]
    fn a_word_is_read_in_the_targets_byte_order() {
        let (ch, _seen) = scripted(vec![Some(b"78563412".to_vec())]);
        let c = consumer(&ch);
        assert_eq!(c.read_u32(0x1000).unwrap(), 0x1234_5678);
        ch.shutdown("test over");

        let (ch2, _s2) = scripted(vec![Some(b"12345678".to_vec())]);
        let c2 = consumer(&ch2).with_endian(Endian::Big);
        assert_eq!(c2.read_u32(0x1000).unwrap(), 0x1234_5678);
        ch2.shutdown("test over");
    }

    #[test]
    fn a_word_is_written_in_the_targets_byte_order() {
        let (ch, seen) = scripted(vec![Some(b"OK".to_vec())]);
        consumer(&ch).write_u32(0x1000, 0x1234_5678).unwrap();
        assert_eq!(requests(&seen), vec!["M1000,4:78563412"]);
        ch.shutdown("test over");
    }

    #[test]
    fn the_gate_is_reported_shut_before_the_handshake_settles() {
        // The reason `ready()` exists: submitting here would wait for the timeout and then report
        // a stall as a fault. Nothing drives the handshake, so the gate stays shut.
        let (tx, rx) = channel();
        let server = ScriptedServer {
            seen: Arc::new(Mutex::new(Vec::new())),
            replies: Arc::new(Mutex::new(Vec::new())),
            to_channel: tx,
            armed: Arc::new(AtomicBool::new(false)),
        };
        let reader = ServerReader { rx, buf: Vec::new() };
        let ch = RspChannel::start(reader, server, Arc::new(NullSink), ServerTier::Full, "test".into());
        let c = consumer(&ch);
        assert!(!c.ready(), "capabilities are unknown and the run state is Unknown");
        ch.shutdown("test over");
    }

    #[test]
    fn a_read_while_the_target_runs_is_refused_by_a_halted_only_server() {
        // §7: a server that will not answer while the target runs has to be asked at a moment
        // when it will. The gate is the thing that knows, and `ready()` is how a poll loop finds
        // out without spending a timeout on it.
        let (ch, _seen) = scripted(vec![]);
        ch.set_tier(ServerTier::HaltedOnly);
        let c = consumer(&ch);
        assert!(c.ready(), "the scripted handshake left the target stopped");
        ch.feed_from_gdb(&encode_packet(b"vCont;c"));
        assert!(!c.ready(), "a resume must shut the gate for a halted-only server");
        ch.shutdown("test over");
    }
}
