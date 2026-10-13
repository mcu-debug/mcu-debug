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

//! Splitting a logical memory access into packets, and reassembling the answers.
//!
//! **This lives on the Agent side, not in the clients.** Consumers — whether Rust
//! code in this binary or TypeScript across the funnel — ask for an address and a
//! length and get bytes back. They do not need to know `PacketSize`, whether the
//! server implements `x`, or that a stub may answer with fewer bytes than it was
//! asked for. Two reasons that is the right place for it:
//!
//! 1. **Only the Agent knows the answer.** `PacketSize` comes from the
//!    `qSupported` exchange, which the multiplexer observes. A TypeScript client
//!    has historically had no way to find out, and so chunks every memory request
//!    at a blind 512 bytes regardless of what the server could have handled. That
//!    number came from OpenOCD's old limit; OpenOCD has advertised 16384 for years.
//! 2. **It protects the whole system from one careless client.** A consumer that
//!    asks for a megabyte gets a megabyte, in as many packets as it takes, rather
//!    than a broken session.
//!
//! [`MuxCore`](super::mux::MuxCore) itself stays deliberately simple: it knows
//! nothing about splitting requests or coalescing replies, and holds no state for
//! either. It routes single packets. This module is the layer above.

use super::caps::{MemoryReadKind, MemoryWriteKind, RspCaps};
use super::packet;
use super::RspError;

/// One packet's worth of a larger access.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chunk {
    /// Target address this chunk starts at.
    pub addr: u64,
    /// Bytes this chunk covers.
    pub len: usize,
    /// The RSP payload to send, ready for the choke point and the framing layer.
    pub payload: Vec<u8>,
}

/// Smallest reply a power-of-two buffer is plausible for. Below this the rule would fire on absurd
/// sizes (a reply of 8 bytes) for no benefit; OpenOCD's historical buffer was 512, so that is the floor.
const SMALLEST_PLAUSIBLE_REPLY: usize = 512;

/// Never ask for a length whose hex reply lands *exactly* on a power of two.
///
/// A hex `m` reply is `$` + 2n + `#` + 2 = **2n + 4** bytes. A stub whose reply buffer is a power of
/// two therefore has no room for its NUL terminator at exactly one request length per buffer size --
/// n = 254, 510, 1022, 2046, 4094, 8190 -- and what comes back is a reply with its last checksum
/// digit overwritten. Measured on the ST-LINK gdb-server at n = 510, which failed four times out of
/// four; OpenOCD carried a bug of the same family at 512.
///
/// Keeping the *default* drain below the smallest of them was the first fix, and it was incomplete:
/// a read length is `min(remaining, budget)`, so it lands wherever the caller's data happens to end.
/// An RTT ring of 1024 bytes reaches `available == 1022` routinely, and then asks for exactly that.
/// Guarding here -- at the one place a packet's length is chosen -- covers every caller instead, and
/// costs a single byte on the one length in each thousand that would have failed.
///
/// One byte less, never more: `n - 1` cannot itself be poison, since consecutive replies differ by 2
/// and only one of them can be a power of two.
pub fn safe_read_len(n: usize) -> usize {
    let reply = 2 * n + 4;
    if reply >= SMALLEST_PLAUSIBLE_REPLY && reply.is_power_of_two() {
        n - 1
    } else {
        n
    }
}

/// Plan the packets for a read of `len` bytes at `addr`.
///
/// Splits at [`RspCaps::max_read_bytes`]. A zero-length read plans nothing rather
/// than emitting a degenerate `m addr,0`, which stubs answer inconsistently.
pub fn plan_read(caps: &RspCaps, addr: u64, len: usize) -> Vec<Chunk> {
    let kind = caps.memory_read_kind();
    let budget = caps.max_read_bytes();
    let mut chunks = Vec::new();
    let mut offset = 0usize;
    while offset < len {
        let this = safe_read_len((len - offset).min(budget));
        let a = addr.wrapping_add(offset as u64);
        chunks.push(Chunk {
            addr: a,
            len: this,
            payload: packet::mem_read(a, this, kind),
        });
        offset += this;
    }
    chunks
}

/// Plan the packets for writing `data` at `addr`.
pub fn plan_write(caps: &RspCaps, addr: u64, data: &[u8]) -> Vec<Chunk> {
    let kind = caps.memory_write_kind();
    let budget = caps.max_write_bytes();
    let mut chunks = Vec::new();
    let mut offset = 0usize;
    while offset < data.len() {
        let this = (data.len() - offset).min(budget);
        let a = addr.wrapping_add(offset as u64);
        chunks.push(Chunk {
            addr: a,
            len: this,
            payload: packet::mem_write(a, &data[offset..offset + this], kind),
        });
        offset += this;
    }
    chunks
}

/// Accumulates the replies to a planned read.
///
/// Handles the case the protocol explicitly permits and that a naive reader gets
/// wrong: **"the reply may contain fewer addressable memory units than
/// requested."** A short answer is not an error and not the end — it advances the
/// cursor by what arrived and asks again from there. Only a *zero-length* answer is
/// treated as a dead end, because retrying it would spin forever.
#[derive(Debug)]
pub struct ReadAssembler {
    kind: MemoryReadKind,
    /// Where the next packet should start.
    cursor: u64,
    /// Bytes still wanted.
    remaining: usize,
    budget: usize,
    out: Vec<u8>,
}

impl ReadAssembler {
    pub fn new(caps: &RspCaps, addr: u64, len: usize) -> Self {
        Self {
            kind: caps.memory_read_kind(),
            cursor: addr,
            remaining: len,
            budget: caps.max_read_bytes(),
            out: Vec::with_capacity(len),
        }
    }

    /// The next packet to send, or `None` when the read is complete.
    pub fn next_request(&self) -> Option<Vec<u8>> {
        (self.remaining > 0)
            .then(|| packet::mem_read(self.cursor, safe_read_len(self.remaining.min(self.budget)), self.kind))
    }

    /// Feed the reply to the packet [`ReadAssembler::next_request`] produced.
    ///
    /// `Ok(true)` when the read is finished and [`ReadAssembler::finish`] may be
    /// called; `Ok(false)` when more packets are needed.
    pub fn accept(&mut self, payload: &[u8]) -> Result<bool, RspError> {
        let bytes = packet::parse_mem_read_reply(payload, self.kind)?;
        if bytes.is_empty() {
            // Asking again would loop for ever. A stub that answers a non-zero
            // request with zero bytes is refusing without saying so.
            return Err(RspError::Malformed("gdb-server returned no data for a non-empty read"));
        }
        // A stub may return more than asked for only by being broken; trust our own
        // bookkeeping over its generosity rather than overrunning the caller's
        // expectation.
        let take = bytes.len().min(self.remaining);
        self.out.extend_from_slice(&bytes[..take]);
        self.cursor = self.cursor.wrapping_add(take as u64);
        self.remaining -= take;
        Ok(self.remaining == 0)
    }

    /// Ask for less per packet from here on, and report whether that was possible.
    ///
    /// For a reply the server sent but mangled ([`RspError::ReplyRejected`]). A read is idempotent,
    /// so asking again is safe -- and asking for a *different length* is what actually helps, because
    /// the fault can be a property of the reply's size rather than of the memory: the ST-LINK
    /// gdb-server truncates a reply of exactly 1024 bytes, losing its last checksum digit to a NUL
    /// terminator, so the identical read one byte shorter succeeds.
    ///
    /// Halves rather than decrements. One byte less would step off that particular boundary, but a
    /// server with a different boundary would then be probed one byte at a time; halving finds any
    /// workable size in a few attempts and cannot loop.
    ///
    /// Measured from **what the next request would actually ask for**, not from the budget ceiling.
    /// Those are usually different: a 510-byte read against an advertised `PacketSize` of 16384 has a
    /// budget of 8192, so halving the budget would leave `remaining.min(budget)` at 510 and resend
    /// the identical request -- a retry that cannot possibly behave differently.
    pub fn shrink_budget(&mut self) -> bool {
        // The *guarded* length, because that is what actually went on the wire -- this function's
        // whole point is to measure from the request rather than the ceiling, and `safe_read_len` is
        // now part of what the request is.
        let asking = safe_read_len(self.remaining.min(self.budget));
        if asking <= 1 {
            return false;
        }
        self.budget = asking / 2;
        true
    }

    /// Bytes gathered so far. Useful on error: a partial read is often still worth
    /// something to a consumer that can say so.
    pub fn collected(&self) -> &[u8] {
        &self.out
    }

    pub fn finish(self) -> Vec<u8> {
        self.out
    }
}

/// Accumulates the replies to a planned write. Simpler than reads: every reply is
/// `OK` or an error, and there is no short-write concept in the protocol.
#[derive(Debug)]
pub struct WriteAssembler {
    kind: MemoryWriteKind,
    cursor: u64,
    remaining: Vec<u8>,
    budget: usize,
}

impl WriteAssembler {
    pub fn new(caps: &RspCaps, addr: u64, data: &[u8]) -> Self {
        Self {
            kind: caps.memory_write_kind(),
            cursor: addr,
            remaining: data.to_vec(),
            budget: caps.max_write_bytes(),
        }
    }

    pub fn next_request(&self) -> Option<Vec<u8>> {
        if self.remaining.is_empty() {
            return None;
        }
        let n = self.remaining.len().min(self.budget);
        Some(packet::mem_write(self.cursor, &self.remaining[..n], self.kind))
    }

    /// `Ok(true)` when the write is complete.
    pub fn accept(&mut self, payload: &[u8]) -> Result<bool, RspError> {
        packet::parse_write_reply(payload)?;
        let n = self.remaining.len().min(self.budget);
        self.remaining.drain(..n);
        self.cursor = self.cursor.wrapping_add(n as u64);
        Ok(self.remaining.is_empty())
    }

    /// Bytes not yet written. Non-empty after an error tells a consumer exactly how
    /// far the write got, which matters when the target is now half-updated.
    pub fn remaining(&self) -> usize {
        self.remaining.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn caps(reply: &str) -> RspCaps {
        RspCaps::parse_reply(reply)
    }

    /// OpenOCD: 16384 payload, hex only.
    fn openocd() -> RspCaps {
        caps("PacketSize=4000;QStartNoAckMode+;vContSupported+")
    }

    /// A small stub that does support `x`.
    fn small_binary() -> RspCaps {
        caps("PacketSize=100;binary-upload+")
    }

    // ── Planning ──────────────────────────────────────────────────────────────

    #[test]
    fn a_read_within_budget_is_one_packet() {
        let c = plan_read(&openocd(), 0x2000_0000, 64);
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].payload, b"m20000000,40");
    }

    #[test]
    fn a_large_read_splits_at_half_the_packet_size() {
        // 16384 payload => 8192 bytes per read, because hex doubles.
        let caps = openocd();
        assert_eq!(caps.max_read_bytes(), 8192);
        let c = plan_read(&caps, 0x2000_0000, 20_000);
        assert_eq!(c.len(), 3);
        assert_eq!((c[0].addr, c[0].len), (0x2000_0000, 8192));
        assert_eq!((c[1].addr, c[1].len), (0x2000_2000, 8192));
        assert_eq!((c[2].addr, c[2].len), (0x2000_4000, 20_000 - 16_384));
        // Contiguous and complete -- the property that actually matters.
        assert_eq!(c.iter().map(|k| k.len).sum::<usize>(), 20_000);
        for w in c.windows(2) {
            assert_eq!(w[0].addr + w[0].len as u64, w[1].addr);
        }
    }

    #[test]
    fn a_zero_length_read_plans_nothing() {
        // `m addr,0` is answered inconsistently across stubs; better never to ask.
        assert!(plan_read(&openocd(), 0x2000_0000, 0).is_empty());
        assert!(plan_write(&openocd(), 0x2000_0000, &[]).is_empty());
    }

    #[test]
    fn planning_uses_x_only_when_binary_upload_is_advertised() {
        // The manual: "GDB will only use this packet if the stub reports the
        // binary-upload feature". Never a guess.
        assert!(plan_read(&openocd(), 0, 4)[0].payload.starts_with(b"m"));
        assert!(plan_read(&small_binary(), 0, 4)[0].payload.starts_with(b"x"));
        assert!(plan_write(&openocd(), 0, &[1])[0].payload.starts_with(b"M"));
        assert!(plan_write(&small_binary(), 0, &[1])[0].payload.starts_with(b"X"));
    }

    #[test]
    fn a_default_packet_size_still_produces_a_workable_plan() {
        // No PacketSize advertised: GDB's 399 baseline, so ~199 bytes a read.
        let c = plan_read(&caps(""), 0, 1000);
        assert_eq!(c.iter().map(|k| k.len).sum::<usize>(), 1000);
        assert!(c.iter().all(|k| k.len <= 199 && k.len > 0));
    }

    #[test]
    fn a_tiny_advertised_packet_size_still_makes_progress() {
        // Clamped to MIN_PACKET_SIZE, so chunks are small but never zero -- a zero
        // budget would loop for ever.
        let c = plan_read(&caps("PacketSize=1"), 0, 50);
        assert!(c.iter().all(|k| k.len > 0));
        assert_eq!(c.iter().map(|k| k.len).sum::<usize>(), 50);
    }

    #[test]
    fn writes_reserve_header_room_so_chunks_are_smaller_than_reads() {
        let caps = openocd();
        let w = plan_write(&caps, 0, &vec![0u8; 20_000]);
        assert!(w[0].len < caps.max_read_bytes());
        assert_eq!(w.iter().map(|k| k.len).sum::<usize>(), 20_000);
    }

    // ── Read assembly, including short replies ────────────────────────────────

    #[test]
    fn a_read_completes_in_one_exchange_when_the_stub_is_generous() {
        let mut a = ReadAssembler::new(&openocd(), 0x2000_0000, 4);
        assert_eq!(a.next_request().unwrap(), b"m20000000,4");
        assert!(a.accept(b"deadbeef").unwrap());
        assert_eq!(a.finish(), vec![0xde, 0xad, 0xbe, 0xef]);
    }

    #[test]
    fn a_short_reply_is_not_an_error_and_the_read_resumes_where_it_stopped() {
        // "The reply may contain fewer addressable memory units than requested."
        // A reader that treats this as failure breaks against a stub that is
        // behaving perfectly legally -- and this is exactly the shape of the old
        // OpenOCD off-by-one, where the last byte of a full-size request was lost.
        let mut a = ReadAssembler::new(&openocd(), 0x2000_0000, 8);
        assert_eq!(a.next_request().unwrap(), b"m20000000,8");
        // Stub answers with only 3 of the 8 bytes.
        assert!(!a.accept(b"aabbcc").unwrap());
        // Next request must resume at +3 and ask for the remaining 5.
        assert_eq!(a.next_request().unwrap(), b"m20000003,5");
        assert!(a.accept(b"ddeeff0011").unwrap());
        assert_eq!(a.finish(), vec![0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x00, 0x11]);
    }

    #[test]
    fn many_short_replies_still_converge() {
        let mut a = ReadAssembler::new(&openocd(), 0x1000, 5);
        let mut guard = 0;
        while a.next_request().is_some() {
            guard += 1;
            assert!(guard < 20, "did not converge");
            // One byte at a time, the worst legal behaviour.
            if a.accept(b"7f").unwrap() {
                break;
            }
        }
        assert_eq!(a.finish(), vec![0x7f; 5]);
    }

    #[test]
    fn a_zero_length_reply_is_an_error_rather_than_an_infinite_loop() {
        let mut a = ReadAssembler::new(&openocd(), 0x1000, 4);
        // An empty *packet* means "unsupported"; this is a well-formed reply that
        // simply carries nothing, which is a stub refusing without saying so.
        assert!(matches!(a.accept(b""), Err(RspError::Unsupported)));
    }

    #[test]
    fn an_over_long_reply_does_not_overrun_the_callers_request() {
        // A stub answering with more than it was asked for is broken; trust our
        // own bookkeeping rather than its generosity.
        let mut a = ReadAssembler::new(&openocd(), 0x1000, 2);
        assert!(a.accept(b"aabbccdd").unwrap());
        assert_eq!(a.finish(), vec![0xaa, 0xbb]);
    }

    #[test]
    fn a_target_error_mid_read_surfaces_with_the_partial_data_intact() {
        let mut a = ReadAssembler::new(&openocd(), 0x1000, 8);
        a.accept(b"aabbcc").unwrap();
        let err = a.accept(b"E01").unwrap_err();
        assert!(matches!(err, RspError::Target(Some(1))));
        // What we did get is still available -- often worth reporting.
        assert_eq!(a.collected(), &[0xaa, 0xbb, 0xcc]);
    }

    #[test]
    fn binary_reads_are_assembled_through_the_b_marker() {
        let mut a = ReadAssembler::new(&small_binary(), 0x1000, 4);
        assert_eq!(a.next_request().unwrap(), b"x1000,4");
        assert!(a.accept(b"b\x01\x02\x03\x04").unwrap());
        assert_eq!(a.finish(), vec![1, 2, 3, 4]);
    }

    #[test]
    fn a_read_spanning_several_chunks_reassembles_in_order() {
        let caps = caps("PacketSize=8"); // clamped to 20 => 10 bytes a read
        let mut a = ReadAssembler::new(&caps, 0x100, 25);
        let mut sent = Vec::new();
        let mut value = 0u8;
        while let Some(req) = a.next_request() {
            sent.push(String::from_utf8_lossy(&req).to_string());
            let n: usize = {
                let s = String::from_utf8_lossy(&req);
                usize::from_str_radix(s.rsplit(',').next().unwrap(), 16).unwrap()
            };
            let hex: String = (0..n)
                .map(|_| {
                    value += 1;
                    format!("{value:02x}")
                })
                .collect();
            if a.accept(hex.as_bytes()).unwrap() {
                break;
            }
        }
        assert_eq!(sent, vec!["m100,a", "m10a,a", "m114,5"]);
        assert_eq!(a.finish(), (1u8..=25).collect::<Vec<u8>>());
    }

    // ── Write assembly ────────────────────────────────────────────────────────

    #[test]
    fn a_write_completes_and_reports_progress_on_failure() {
        // NOTE: PacketSize is HEX. 0x40 = 64 payload bytes, leaving (64-40)/2 = 12
        // bytes a write after the header reserve. Writing "64" here would mean 100.
        let caps = caps("PacketSize=40");
        let data: Vec<u8> = (0u8..30).collect();
        let mut w = WriteAssembler::new(&caps, 0x2000_0000, &data);
        assert_eq!(w.remaining(), 30);

        let first = w.next_request().unwrap();
        assert!(first.starts_with(b"M20000000,"));
        assert!(w.accept(b"OK").is_ok());
        let after_first = w.remaining();
        assert!(after_first < 30 && after_first > 0);

        // Second chunk is refused by the target.
        let err = w.accept(b"E0e").unwrap_err();
        assert!(matches!(err, RspError::Target(Some(14))));
        // The caller can tell exactly how far it got -- the target is half-updated
        // and that is worth reporting rather than hiding.
        assert_eq!(w.remaining(), after_first);
    }

    #[test]
    fn a_write_converges_over_several_chunks() {
        let caps = openocd();
        let data: Vec<u8> = (0..5000).map(|i| (i % 251) as u8).collect();
        let mut w = WriteAssembler::new(&caps, 0x0800_0000, &data);
        let mut guard = 0;
        while w.next_request().is_some() {
            guard += 1;
            assert!(guard < 100);
            if w.accept(b"OK").unwrap() {
                break;
            }
        }
        assert_eq!(w.remaining(), 0);
    }

    #[test]
    fn planned_chunks_and_the_assembler_agree_when_nothing_is_short() {
        // Two routes to the same packets: `plan_read` for a caller that wants the
        // whole schedule up front, the assembler for one that goes step by step.
        // They must not drift.
        let caps = openocd();
        let planned = plan_read(&caps, 0x2000_0000, 20_000);
        let mut a = ReadAssembler::new(&caps, 0x2000_0000, 20_000);
        for chunk in &planned {
            assert_eq!(a.next_request().unwrap(), chunk.payload);
            let hex = "00".repeat(chunk.len);
            a.accept(hex.as_bytes()).unwrap();
        }
        assert!(a.next_request().is_none());
    }
}

#[cfg(test)]
mod poison_size_tests {
    use super::*;

    /// The sizes measured to fail, and the reason they are a family rather than one bad number.
    #[test]
    fn every_power_of_two_reply_is_avoided() {
        for bits in 9..=14 {
            let poison = ((1usize << bits) - 4) / 2;
            assert_eq!(
                safe_read_len(poison),
                poison - 1,
                "a read of {poison} replies in exactly {} bytes",
                1usize << bits
            );
        }
        // 510 is the one observed on hardware: four failures out of four on the ST-LINK gdb-server.
        assert_eq!(safe_read_len(510), 509);
    }

    #[test]
    fn a_guarded_length_is_never_itself_poison() {
        // Consecutive replies differ by 2, so only one of any adjacent pair can be a power of two --
        // which is what makes a single decrement sufficient rather than a loop.
        for n in 1..20_000usize {
            let safe = safe_read_len(n);
            let reply = 2 * safe + 4;
            assert!(
                !(reply >= SMALLEST_PLAUSIBLE_REPLY && reply.is_power_of_two()),
                "safe_read_len({n}) = {safe} still replies in {reply}"
            );
        }
    }

    #[test]
    fn ordinary_lengths_are_untouched() {
        // The cost has to be a single byte on a single length per buffer size, or this would distort
        // every measurement taken through it.
        for n in [1, 2, 100, 500, 511, 509, 1000, 1023, 2000, 4096] {
            assert_eq!(safe_read_len(n), n, "{n} is not poison and must not be altered");
        }
    }

    #[test]
    fn absurdly_small_replies_are_left_alone() {
        // 2n + 4 is a power of two at n = 2, 6, 14, 30 ... A stub with a 32-byte reply buffer is not
        // a thing, and shaving those would fire the rule constantly for no benefit. The floor is 512
        // because that is the smallest buffer actually seen in the wild -- OpenOCD's.
        for n in [2, 6, 14, 30, 62, 126] {
            assert_eq!(safe_read_len(n), n, "{n} is below the plausible-buffer floor");
        }
        assert_eq!(
            safe_read_len(254),
            253,
            "but 254 -> 512 is real: that was OpenOCD's buffer"
        );
    }
}
