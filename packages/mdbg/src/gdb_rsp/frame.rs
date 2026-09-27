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

//! Incremental RSP frame decoder.
//!
//! Pure: no I/O, no threads, no clock. Feed it bytes as they arrive from a socket
//! in whatever sizes the socket gives them, and pull whole [`Frame`]s out.
//!
//! Every frame carries both the **raw** bytes exactly as received and the
//! **decoded** payload. The multiplexer forwards `raw` to GDB verbatim and reads
//! `decoded` for its own purposes; see `docs-internal/gdb-rsp.md` §2 invariant 5.
//! Re-encoding a payload is never correct, because run-length encoding and
//! escaping are not uniquely determined by the bytes they represent.

use std::borrow::Cow;

/// Escape character inside packet data. The byte after it is `b ^ ESCAPE_XOR`.
const ESCAPE: u8 = b'}';
const ESCAPE_XOR: u8 = 0x20;

/// Run-length marker. `<char>*<count>` where the repeat count is
/// `count_byte - RLE_BIAS` *additional* copies of `<char>`.
const RLE_MARKER: u8 = b'*';

/// `repeat = c - ' ' + 3` in GDB's `read_frame()`, i.e. `c - 29`.
const RLE_BIAS: u8 = 29;

/// GDB accepts any repeat count in `1..=255` and rejects nothing else, so we
/// match it rather than enforcing the *encoder's* `3..=97`-with-holes rule.
/// Being stricter than GDB buys nothing and risks rejecting valid traffic.
const RLE_MAX_REPEAT: usize = 255;

/// Bare Ctrl-C. Not a packet: GDB sends it outside framing to interrupt a
/// running target, and it can arrive at any point, including between the `$`
/// and `#` of nothing at all.
pub const INTERRUPT: u8 = 0x03;

/// What a decoded frame is. The distinction matters because only `Packet`
/// (and `ErrorReply`, which is a packet) can retire a pending request — an `O`,
/// an `F` or a notification arriving mid-transaction must not be mistaken for
/// the reply we are waiting on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameKind {
    /// A normal request or reply.
    Packet,
    /// `%<name>:<data>` — asynchronous notification, never a reply, never acked.
    Notification,
    /// Console output (`O` followed by hex). Can arrive during a `c`.
    ConsoleOutput,
    /// File-I/O request (`F<call>,...`) from the stub. Needs a reply from the
    /// *client*, so it blocks injection until answered.
    FileIo,
    Ack,
    Nack,
    /// Bare `0x03`.
    Interrupt,
    /// Checksum mismatch, a malformed run-length count, or bytes discarded
    /// while hunting for a `$`. The caller decides whether to nack or ignore.
    Garbage,
}

/// One frame lifted out of the byte stream.
#[derive(Debug, Clone)]
pub struct Frame {
    pub kind: FrameKind,
    /// Exactly the bytes this frame occupied in the stream, framing included
    /// (`$`, `#`, the two checksum digits, escapes and run-length markers).
    /// This is what gets forwarded. Never rebuild it from `payload`.
    pub raw: Vec<u8>,
    /// Unescaped, run-length-expanded packet data — framing and checksum
    /// stripped. Empty for `Ack`, `Nack` and `Interrupt`.
    pub payload: Vec<u8>,
}

impl Frame {
    /// The payload as a string, for the many packets that are ASCII.
    /// Lossy on purpose: a malformed packet should be inspectable, not fatal.
    pub fn payload_str(&self) -> Cow<'_, str> {
        String::from_utf8_lossy(&self.payload)
    }

    /// True when this frame can complete an outstanding request.
    pub fn is_reply(&self) -> bool {
        self.kind == FrameKind::Packet
    }
}

/// Whether acknowledgements are in play. Flipped by the multiplexer at the
/// exact byte where GDB's `QStartNoAckMode` is answered `OK`; see
/// `docs-internal/gdb-rsp.md` §4.3. Getting the switch point wrong
/// desynchronises everything after it, which is why this is explicit state
/// rather than something inferred per frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum AckMode {
    /// Every packet is followed by `+` or `-`. The state a connection opens in.
    #[default]
    Acked,
    /// No acknowledgements in either direction.
    NoAck,
}

/// Incremental decoder over one direction of one connection.
///
/// Two of these make a full picture of a socket: one for each direction. They
/// are independent except for [`AckMode`], which the multiplexer must flip on
/// both at the same point in the conversation.
#[derive(Debug, Default)]
pub struct PacketCodec {
    /// Unconsumed bytes. A frame is only removed once it is complete, so a
    /// packet split across any number of reads is reassembled here.
    buf: Vec<u8>,
    ack_mode: AckMode,
}

impl PacketCodec {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_ack_mode(ack_mode: AckMode) -> Self {
        Self {
            buf: Vec::new(),
            ack_mode,
        }
    }

    pub fn ack_mode(&self) -> AckMode {
        self.ack_mode
    }

    /// Switch acknowledgement mode. The caller is responsible for doing this at
    /// the right point in the stream — after the `OK` that answers
    /// `QStartNoAckMode` has been decoded, and before the next byte is fed.
    pub fn set_ack_mode(&mut self, mode: AckMode) {
        self.ack_mode = mode;
    }

    /// Bytes held but not yet forming a complete frame. Diagnostic only; a
    /// non-zero value that never drains means the peer sent a partial packet.
    pub fn pending_len(&self) -> usize {
        self.buf.len()
    }

    /// Append freshly-read bytes. Never blocks, never fails: bytes that cannot
    /// be interpreted come back out as [`FrameKind::Garbage`] rather than an
    /// error, because a decoder that can refuse input has no way to resynchronise.
    pub fn feed(&mut self, bytes: &[u8]) {
        self.buf.extend_from_slice(bytes);
    }

    /// Pull the next complete frame, or `None` when more bytes are needed.
    ///
    /// Call in a loop until it returns `None`: one `feed` can yield any number
    /// of frames, including zero.
    pub fn next_frame(&mut self) -> Option<Frame> {
        let &first = self.buf.first()?;
        match first {
            // Acks are decoded in **either** mode, deliberately. Tightening this to
            // reject them in no-ack mode would look like a correctness improvement
            // and would break a real sequence: when GDB's `QStartNoAckMode` is
            // answered `OK`, GDB acks that `OK` — it was still in ack mode when it
            // sent the request — and only then switches. So exactly one `+` arrives
            // after no-ack has engaged. OpenOCD handles the endpoint side of this
            // with a tri-state `noack_mode` (0, 1 = expect one stray, 2 = warn);
            // we are a relay, so we simply decode it and let it through.
            b'+' => Some(self.take_single(FrameKind::Ack)),
            b'-' => Some(self.take_single(FrameKind::Nack)),
            INTERRUPT => Some(self.take_single(FrameKind::Interrupt)),
            b'$' | b'%' => match self.try_take_packet(first) {
                PacketScan::Frame(frame) => Some(frame),
                PacketScan::NeedMore => None,
            },
            // Junk between frames. GDB's own reader warns and discards, and so do
            // we -- but we surface it, because a stream producing junk is a bug
            // worth seeing rather than silently tolerating.
            _ => Some(self.take_single(FrameKind::Garbage)),
        }
    }

    fn take_single(&mut self, kind: FrameKind) -> Frame {
        let raw = vec![self.buf.remove(0)];
        Frame {
            kind,
            raw,
            payload: Vec::new(),
        }
    }

    /// Scan for a complete `$...#cc` or `%...#cc`.
    ///
    /// The checksum is computed over the bytes **as received**, before escape and
    /// run-length decoding -- GDB's `read_frame()` adds `*` and the count byte to
    /// its running sum, so expanding first would give the wrong sum for any
    /// payload containing a run.
    fn try_take_packet(&mut self, start: u8) -> PacketScan {
        // Locate the '#' that ends the payload. '#' cannot appear unescaped inside
        // payload data -- not by convention but structurally, because the framing
        // layer terminates there -- so the first one is the terminator.
        //
        // An unescaped '$' before it means the stream is out of step. GDB's
        // read_frame() logs "Saw new packet start in middle of old one" and
        // restarts framing at the new '$'; we do the same, reporting the skipped
        // bytes as garbage. Resynchronising on the next plausible packet start
        // recovers far better than consuming through a '#' that may belong to a
        // later, valid packet.
        let restart = self.buf.iter().skip(1).position(|&b| b == b'$').map(|i| i + 1);
        let hash = self.buf.iter().position(|&b| b == b'#');
        let hash = match (hash, restart) {
            (Some(h), Some(r)) if r < h => return PacketScan::Frame(self.take_raw(r, FrameKind::Garbage, Vec::new())),
            (Some(h), _) => h,
            // No '#' yet. If a restart is already visible there is no point
            // waiting for a terminator that will never come for this frame.
            (None, Some(r)) => return PacketScan::Frame(self.take_raw(r, FrameKind::Garbage, Vec::new())),
            (None, None) => return PacketScan::NeedMore,
        };
        // Two checksum digits must follow it.
        if self.buf.len() < hash + 3 {
            return PacketScan::NeedMore;
        }

        let total = hash + 3;
        let body = &self.buf[1..hash];
        let stated = match (hex_val(self.buf[hash + 1]), hex_val(self.buf[hash + 2])) {
            (Some(hi), Some(lo)) => (hi << 4) | lo,
            // Non-hex where the checksum belongs: the framing is broken, not the
            // data. Consume the lot as garbage rather than trying to guess.
            _ => return PacketScan::Frame(self.take_raw(total, FrameKind::Garbage, Vec::new())),
        };
        let computed = body.iter().fold(0u8, |acc, &b| acc.wrapping_add(b));
        if computed != stated {
            return PacketScan::Frame(self.take_raw(total, FrameKind::Garbage, Vec::new()));
        }

        let payload = match decode_payload(body) {
            Some(p) => p,
            None => return PacketScan::Frame(self.take_raw(total, FrameKind::Garbage, Vec::new())),
        };
        let kind = classify(start, &payload);
        PacketScan::Frame(self.take_raw(total, kind, payload))
    }

    fn take_raw(&mut self, len: usize, kind: FrameKind, payload: Vec<u8>) -> Frame {
        let raw: Vec<u8> = self.buf.drain(..len).collect();
        Frame { kind, raw, payload }
    }
}

/// A packet scan either produced a frame -- valid or garbage, the bytes are
/// consumed either way -- or needs more input. There is deliberately no third
/// "consumed but invalid" case: the caller treats a garbage frame exactly like
/// any other, which is what keeps resynchronisation from needing special paths.
enum PacketScan {
    Frame(Frame),
    NeedMore,
}

/// Which flavour of packet this is, from its first byte and payload.
///
/// `O` is console output only when it carries something; a bare `OK` is an
/// ordinary reply and must not be mistaken for output, which is why this checks
/// the whole prefix rather than just `payload[0] == b'O'`.
fn classify(start: u8, payload: &[u8]) -> FrameKind {
    if start == b'%' {
        return FrameKind::Notification;
    }
    match payload.first() {
        Some(b'O') if payload.len() > 1 && payload != b"OK" => FrameKind::ConsoleOutput,
        Some(b'F') if payload.len() > 1 => FrameKind::FileIo,
        _ => FrameKind::Packet,
    }
}

/// Undo escaping and run-length encoding. `None` if the data is malformed
/// (trailing escape, or a run with no preceding character).
fn decode_payload(body: &[u8]) -> Option<Vec<u8>> {
    // The common case has neither escapes nor runs; skip the work entirely.
    if !body.contains(&ESCAPE) && !body.contains(&RLE_MARKER) {
        return Some(body.to_vec());
    }

    let mut out = Vec::with_capacity(body.len());
    let mut i = 0;
    while i < body.len() {
        match body[i] {
            ESCAPE => {
                // A trailing escape means the sender truncated mid-escape. The
                // checksum matched, so this is a malformed payload rather than a
                // short read, and there is nothing sensible to produce.
                let next = *body.get(i + 1)?;
                out.push(next ^ ESCAPE_XOR);
                i += 2;
            }
            RLE_MARKER => {
                let count = *body.get(i + 1)?;
                // GDB requires a character to repeat and a count in 1..=255.
                let repeat = count.checked_sub(RLE_BIAS)? as usize;
                if repeat == 0 || repeat > RLE_MAX_REPEAT || out.is_empty() {
                    return None;
                }
                // `repeat` is the number of ADDITIONAL copies: the literal is
                // already in `out`. See gdb/remote.c read_frame().
                let last = *out.last()?;
                out.extend(std::iter::repeat_n(last, repeat));
                i += 2;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    Some(out)
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// Wrap `payload` as a complete packet: `$<escaped>#<cc>`.
///
/// Escapes but never run-length encodes — RLE is a stub-to-client optimisation
/// and we are never the stub. Used only for packets the Agent originates; GDB's
/// bytes are forwarded as received and never pass through here.
pub fn encode_packet(payload: &[u8]) -> Vec<u8> {
    let mut body = Vec::with_capacity(payload.len());
    for &b in payload {
        if b == b'#' || b == b'$' || b == ESCAPE || b == RLE_MARKER {
            body.push(ESCAPE);
            body.push(b ^ ESCAPE_XOR);
        } else {
            body.push(b);
        }
    }
    let sum = body.iter().fold(0u8, |acc, &b| acc.wrapping_add(b));
    let mut out = Vec::with_capacity(body.len() + 4);
    out.push(b'$');
    out.extend_from_slice(&body);
    out.push(b'#');
    out.extend_from_slice(format!("{sum:02x}").as_bytes());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Decode everything `input` contains, in one feed.
    fn frames(input: &[u8]) -> Vec<Frame> {
        let mut codec = PacketCodec::new();
        codec.feed(input);
        let mut out = Vec::new();
        while let Some(f) = codec.next_frame() {
            out.push(f);
        }
        out
    }

    fn payloads(input: &[u8]) -> Vec<Vec<u8>> {
        frames(input).into_iter().map(|f| f.payload).collect()
    }

    fn kinds(input: &[u8]) -> Vec<FrameKind> {
        frames(input).into_iter().map(|f| f.kind).collect()
    }

    #[test]
    fn decodes_a_simple_packet() {
        let fs = frames(b"$OK#9a");
        assert_eq!(fs.len(), 1);
        assert_eq!(fs[0].kind, FrameKind::Packet);
        assert_eq!(fs[0].payload, b"OK");
        // raw is the whole frame, framing included.
        assert_eq!(fs[0].raw, b"$OK#9a");
    }

    #[test]
    fn checksum_is_case_insensitive() {
        assert_eq!(kinds(b"$OK#9A"), vec![FrameKind::Packet]);
    }

    #[test]
    fn bad_checksum_is_garbage_and_consumes_the_frame() {
        // A wrong checksum must not leave the bytes in the buffer, or the decoder
        // would re-scan them forever.
        let fs = frames(b"$OK#00$OK#9a");
        assert_eq!(
            fs.iter().map(|f| f.kind).collect::<Vec<_>>(),
            vec![FrameKind::Garbage, FrameKind::Packet]
        );
        assert_eq!(fs[0].raw, b"$OK#00");
    }

    #[test]
    fn non_hex_checksum_is_garbage() {
        assert_eq!(kinds(b"$OK#zz"), vec![FrameKind::Garbage]);
    }

    #[test]
    fn acks_nacks_and_interrupt() {
        assert_eq!(
            kinds(b"+-\x03"),
            vec![FrameKind::Ack, FrameKind::Nack, FrameKind::Interrupt]
        );
    }

    #[test]
    fn interrupt_between_packets_is_its_own_frame() {
        // GDB can send 0x03 at any moment; it must not disturb the frames around it.
        assert_eq!(
            kinds(b"$OK#9a\x03$OK#9a"),
            vec![FrameKind::Packet, FrameKind::Interrupt, FrameKind::Packet]
        );
    }

    #[test]
    fn an_0x03_inside_a_packet_is_data_and_not_an_interrupt() {
        // E.9 Interrupts is explicit about this: "When a 0x03 byte is transmitted as part
        // of a packet, it is considered to be packet data and does not represent an
        // interrupt. E.g., an 'X' packet, used for binary downloads, may include an
        // unescaped 0x03 as part of its packet." Treating it as an interrupt would split
        // the packet in two and hand the gdb-server a halt request it was never sent.
        //
        // It holds structurally rather than by a special case: `0x03` is only examined as
        // the *first* byte of the buffer, and once a `$` has been seen the scan runs to the
        // terminating `#`. Locked down here because the structure is what could change.
        let body: &[u8] = b"X20000000,2:\x03\x03";
        let sum = body.iter().fold(0u8, |a, &b| a.wrapping_add(b));
        let mut raw = vec![b'$'];
        raw.extend_from_slice(body);
        raw.push(b'#');
        raw.extend_from_slice(format!("{:02x}", sum).as_bytes());

        let mut c = PacketCodec::new();
        c.feed(&raw);
        let frame = c.next_frame().expect("one packet");
        assert_eq!(frame.kind, FrameKind::Packet);
        assert_eq!(frame.payload, body, "the 0x03 bytes stay in the payload");
        assert_eq!(frame.raw, raw, "and the bytes forwarded are the bytes received");
        assert!(c.next_frame().is_none(), "nothing left over");
    }

    #[test]
    fn junk_between_frames_surfaces_as_garbage() {
        assert_eq!(kinds(b"x$OK#9a"), vec![FrameKind::Garbage, FrameKind::Packet]);
    }

    #[test]
    fn ack_then_packet_is_two_frames() {
        assert_eq!(kinds(b"+$OK#9a"), vec![FrameKind::Ack, FrameKind::Packet]);
    }

    // ── Escaping ──────────────────────────────────────────────────────────────

    #[test]
    fn unescapes_the_four_escapable_bytes() {
        for &b in b"#$}*" {
            let encoded = encode_packet(&[b]);
            let fs = frames(&encoded);
            assert_eq!(fs.len(), 1, "byte {b:#04x} produced {} frames", fs.len());
            assert_eq!(fs[0].payload, vec![b], "byte {b:#04x} round-trip");
        }
    }

    #[test]
    fn escape_round_trips_arbitrary_binary() {
        let data: Vec<u8> = (0u8..=255).collect();
        let encoded = encode_packet(&data);
        assert_eq!(payloads(&encoded), vec![data]);
    }

    #[test]
    fn trailing_escape_is_garbage() {
        // '}' as the last payload byte: checksum can still match, so this is a
        // malformed payload rather than a short read.
        let body = b"}";
        let sum = body.iter().fold(0u8, |a, &b| a.wrapping_add(b));
        let raw = format!("${}#{:02x}", String::from_utf8_lossy(body), sum);
        assert_eq!(kinds(raw.as_bytes()), vec![FrameKind::Garbage]);
    }

    // ── Run-length encoding ───────────────────────────────────────────────────

    /// Build a packet whose body is used verbatim (no escaping), so tests can
    /// hand-craft run-length sequences the encoder would never emit.
    fn raw_packet(body: &[u8]) -> Vec<u8> {
        let sum = body.iter().fold(0u8, |a, &b| a.wrapping_add(b));
        let mut out = vec![b'$'];
        out.extend_from_slice(body);
        out.push(b'#');
        out.extend_from_slice(format!("{sum:02x}").as_bytes());
        out
    }

    #[test]
    fn rle_count_is_additional_copies_not_total() {
        // The finding from gdb/remote.c: `repeat = c - 29` MORE copies, on top of
        // the literal already emitted. `0* ` is therefore FOUR zeros, not three.
        // This is the off-by-one that would silently corrupt every long read.
        assert_eq!(payloads(&raw_packet(b"0* ")), vec![b"0000".to_vec()]);
    }

    #[test]
    fn rle_minimum_and_maximum_counts() {
        // Lowest count GDB accepts is 1 (byte 30), though an encoder should not
        // emit below 3. We match GDB's leniency rather than the encoder's rule.
        assert_eq!(payloads(&raw_packet(b"a*\x1e")), vec![b"aa".to_vec()]);
        // Highest printable count byte, 126 => 97 additional copies.
        let expanded = payloads(&raw_packet(b"a*~"));
        assert_eq!(expanded[0].len(), 98);
        assert!(expanded[0].iter().all(|&b| b == b'a'));
    }

    #[test]
    fn rle_accepts_plus_and_minus_as_count_bytes() {
        // '+' and '-' are excluded by the spec, making counts 14 and 16
        // unencodable. But they are ordinary bytes between '$' and '#', so a
        // decoder can accept them -- and being stricter than GDB buys nothing.
        for (count_byte, additional) in [(b'+', 14usize), (b'-', 16)] {
            let body = [b'z', RLE_MARKER, count_byte];
            let out = payloads(&raw_packet(&body));
            assert_eq!(out[0].len(), additional + 1, "count byte {count_byte:?}");
        }
    }

    #[test]
    fn hash_and_dollar_cannot_be_rle_count_bytes_at_all() {
        // Counts 6 and 7 are not merely forbidden, they are STRUCTURALLY
        // IMPOSSIBLE: framing terminates at '#' and resynchronises at '$' before
        // the payload decoder ever sees them. GDB's read_frame() behaves the same
        // way. So no decoder, however lenient, can accept these -- which is the
        // real reason the spec excludes them.
        // Framing ends at the '#' the encoder meant as a count, so the payload is
        // a bare "z*" -- an unterminated run. Never a valid packet, whatever
        // trailing bytes the rest of the stream leaves behind.
        let fs = kinds(&raw_packet(b"z*#"));
        assert_eq!(fs[0], FrameKind::Garbage);
        assert!(!fs.contains(&FrameKind::Packet), "got {fs:?}");
        // '$' mid-packet: bytes up to it are garbage, then framing restarts and
        // the following valid packet decodes normally.
        let fs = frames(b"$z*$OK#9a");
        assert_eq!(
            fs.iter().map(|f| f.kind).collect::<Vec<_>>(),
            vec![FrameKind::Garbage, FrameKind::Packet]
        );
        assert_eq!(fs[0].raw, b"$z*");
        assert_eq!(fs[1].payload, b"OK");
    }

    #[test]
    fn resynchronises_on_a_new_packet_start() {
        // A truncated packet followed by a good one: we must not lose the good one
        // by waiting forever for the truncated one's terminator.
        let fs = frames(b"$trunc$OK#9a");
        assert_eq!(
            fs.iter().map(|f| f.kind).collect::<Vec<_>>(),
            vec![FrameKind::Garbage, FrameKind::Packet]
        );
        assert_eq!(fs[1].payload, b"OK");
    }

    #[test]
    fn rle_with_no_preceding_character_is_garbage() {
        // GDB requires `bc > 0`: a '*' cannot open a payload.
        assert_eq!(kinds(&raw_packet(b"* ")), vec![FrameKind::Garbage]);
    }

    #[test]
    fn rle_count_below_bias_is_garbage() {
        // count byte 29 => repeat 0; 28 would underflow.
        assert_eq!(kinds(&raw_packet(b"a*\x1d")), vec![FrameKind::Garbage]);
        assert_eq!(kinds(&raw_packet(b"a*\x1c")), vec![FrameKind::Garbage]);
    }

    #[test]
    fn checksum_covers_encoded_not_expanded_bytes() {
        // `raw_packet` sums the un-expanded body. If the verifier expanded first
        // it would compute a different sum and call this garbage. Guards the
        // read_frame() finding that `csum += c` includes '*' and the count.
        let pkt = raw_packet(b"0* ");
        assert_eq!(kinds(&pkt), vec![FrameKind::Packet]);
    }

    #[test]
    fn rle_and_escapes_in_one_payload() {
        // '}' '\x03' unescapes to 0x23 ('#'), then a run of three more.
        let body = [b'}', b'#' ^ ESCAPE_XOR, RLE_MARKER, b' '];
        assert_eq!(payloads(&raw_packet(&body)), vec![b"####".to_vec()]);
    }

    // ── Classification ────────────────────────────────────────────────────────

    #[test]
    fn notification_is_not_a_reply() {
        let fs = frames(&raw_packet_pct(b"Stop:T05thread:01;"));
        assert_eq!(fs[0].kind, FrameKind::Notification);
        assert!(!fs[0].is_reply());
    }

    fn raw_packet_pct(body: &[u8]) -> Vec<u8> {
        let sum = body.iter().fold(0u8, |a, &b| a.wrapping_add(b));
        let mut out = vec![b'%'];
        out.extend_from_slice(body);
        out.push(b'#');
        out.extend_from_slice(format!("{sum:02x}").as_bytes());
        out
    }

    #[test]
    fn console_output_is_not_a_reply_but_ok_is() {
        let out = frames(&raw_packet(b"O48656c6c6f"));
        assert_eq!(out[0].kind, FrameKind::ConsoleOutput);
        assert!(!out[0].is_reply());
        // "OK" must not be swallowed as console output -- it is the commonest
        // reply in the protocol.
        let ok = frames(&raw_packet(b"OK"));
        assert_eq!(ok[0].kind, FrameKind::Packet);
        assert!(ok[0].is_reply());
        // A bare "O" is a reply too (it is not output with no data).
        assert_eq!(kinds(&raw_packet(b"O")), vec![FrameKind::Packet]);
    }

    #[test]
    fn file_io_request_is_its_own_kind() {
        let fs = frames(&raw_packet(b"Fopen,1234/0,0,1b6"));
        assert_eq!(fs[0].kind, FrameKind::FileIo);
        assert!(!fs[0].is_reply());
    }

    #[test]
    fn error_reply_is_an_ordinary_reply() {
        assert_eq!(kinds(&raw_packet(b"E01")), vec![FrameKind::Packet]);
    }

    // ── Chunk-boundary behaviour ──────────────────────────────────────────────

    /// Feed `input` one byte at a time; the frames must be identical to feeding
    /// it whole. This is the property that matters most: a socket read can split
    /// anywhere, including inside an escape pair or a run-length pair.
    fn assert_split_invariant(input: &[u8]) {
        let whole = frames(input);
        let mut codec = PacketCodec::new();
        let mut got = Vec::new();
        for &b in input {
            codec.feed(&[b]);
            while let Some(f) = codec.next_frame() {
                got.push(f);
            }
        }
        assert_eq!(got.len(), whole.len(), "frame count differs for {input:?}");
        for (a, b) in got.iter().zip(whole.iter()) {
            assert_eq!(a.kind, b.kind, "kind differs for {input:?}");
            assert_eq!(a.raw, b.raw, "raw differs for {input:?}");
            assert_eq!(a.payload, b.payload, "payload differs for {input:?}");
        }
    }

    #[test]
    fn byte_at_a_time_matches_all_at_once() {
        for case in [
            &b"$OK#9a"[..],
            b"+$OK#9a-",
            b"$qSupported:multiprocess+;swbreak+#f7",
            b"\x03$OK#9a",
            b"$OK#00$OK#9a",
        ] {
            assert_split_invariant(case);
        }
        assert_split_invariant(&raw_packet(b"0* "));
        assert_split_invariant(&encode_packet(&(0u8..=255).collect::<Vec<u8>>()));
    }

    /// Exhaustively split at every possible single point, which is where an
    /// escape pair or an RLE pair gets cut in half.
    #[test]
    fn every_single_split_point_matches() {
        let cases: Vec<Vec<u8>> = vec![
            encode_packet(b"}*#$"),
            raw_packet(b"0* a*~"),
            raw_packet(b"O48656c6c6f"),
            b"+$T0505:00000000;#00".to_vec(),
        ];
        for case in cases {
            let whole = frames(&case);
            for split in 0..=case.len() {
                let mut codec = PacketCodec::new();
                let mut got = Vec::new();
                codec.feed(&case[..split]);
                while let Some(f) = codec.next_frame() {
                    got.push(f);
                }
                codec.feed(&case[split..]);
                while let Some(f) = codec.next_frame() {
                    got.push(f);
                }
                assert_eq!(
                    got.iter().map(|f| f.raw.clone()).collect::<Vec<_>>(),
                    whole.iter().map(|f| f.raw.clone()).collect::<Vec<_>>(),
                    "split at {split} of {case:?}"
                );
                assert_eq!(
                    got.iter().map(|f| f.payload.clone()).collect::<Vec<_>>(),
                    whole.iter().map(|f| f.payload.clone()).collect::<Vec<_>>(),
                    "split at {split} of {case:?}"
                );
            }
        }
    }

    #[test]
    fn partial_packet_yields_nothing_and_is_retained() {
        let mut codec = PacketCodec::new();
        codec.feed(b"$OK#9");
        assert!(codec.next_frame().is_none());
        assert_eq!(codec.pending_len(), 5);
        codec.feed(b"a");
        assert_eq!(codec.next_frame().map(|f| f.payload), Some(b"OK".to_vec()));
        assert_eq!(codec.pending_len(), 0);
    }

    #[test]
    fn empty_payload_packet() {
        // An empty reply is meaningful: it means "packet not supported".
        let fs = frames(b"$#00");
        assert_eq!(fs.len(), 1);
        assert_eq!(fs[0].kind, FrameKind::Packet);
        assert!(fs[0].payload.is_empty());
    }

    // ── Ack mode ──────────────────────────────────────────────────────────────

    #[test]
    fn ack_mode_starts_acked_and_switches_on_request() {
        let mut codec = PacketCodec::new();
        assert_eq!(codec.ack_mode(), AckMode::Acked);
        codec.set_ack_mode(AckMode::NoAck);
        assert_eq!(codec.ack_mode(), AckMode::NoAck);
    }

    #[test]
    fn frames_decode_identically_in_either_ack_mode() {
        // Ack mode changes what the *multiplexer* must do with Ack frames, not how
        // bytes are framed. Decoding must not depend on it, or a mis-timed switch
        // would corrupt payloads as well as ack accounting.
        let input = b"+$OK#9a";
        let mut acked = PacketCodec::with_ack_mode(AckMode::Acked);
        let mut noack = PacketCodec::with_ack_mode(AckMode::NoAck);
        acked.feed(input);
        noack.feed(input);
        let mut a = Vec::new();
        let mut b = Vec::new();
        while let Some(f) = acked.next_frame() {
            a.push((f.kind, f.payload));
        }
        while let Some(f) = noack.next_frame() {
            b.push((f.kind, f.payload));
        }
        assert_eq!(a, b);
    }

    // ── Encoder ───────────────────────────────────────────────────────────────

    #[test]
    fn encode_packet_produces_a_decodable_frame() {
        for payload in [&b"qSupported:xmlRegisters=arm"[..], b"m20000000,4", b"", b"X0,1:\x00"] {
            let encoded = encode_packet(payload);
            assert_eq!(payloads(&encoded), vec![payload.to_vec()], "payload {payload:?}");
        }
    }

    #[test]
    fn encode_packet_never_emits_run_length_encoding() {
        // We are never the stub, so we never RLE. A long run must appear literally.
        let encoded = encode_packet(&[b'0'; 64]);
        assert!(!encoded[1..encoded.len() - 3].contains(&RLE_MARKER));
    }
}
