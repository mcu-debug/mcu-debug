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

//! Typed builders and parsers for the packets the Agent cares about.
//!
//! Builders produce **payloads**, not framed packets — [`super::frame::encode_packet`]
//! does the framing, and keeping the two apart means the forbidden-packet choke
//! point (`docs-internal/gdb-rsp.md` §4.5) can inspect a payload before anything
//! is committed to the wire.
//!
//! Only the packets we are permitted to send have builders here. There is
//! deliberately no `continue`, `step`, `Z`, `z`, `Hg` or `QStartNoAckMode`
//! builder: execution control and connection state belong to GDB, and the
//! cheapest way to honour that is to have no way to express it.

use super::caps::{MemoryReadKind, MemoryWriteKind};
use super::RspError;

// ── Builders ─────────────────────────────────────────────────────────────────

/// `m addr,len` or `x addr,len`.
pub fn mem_read(addr: u64, len: usize, kind: MemoryReadKind) -> Vec<u8> {
    let tag = match kind {
        MemoryReadKind::Hex => 'm',
        MemoryReadKind::Binary => 'x',
    };
    format!("{tag}{addr:x},{len:x}").into_bytes()
}

/// `M addr,len:<hex>` or `X addr,len:<raw binary>`.
///
/// For the binary form the data is appended **unescaped**: escaping is the
/// framing layer's job, and doing it here as well would double-escape.
pub fn mem_write(addr: u64, data: &[u8], kind: MemoryWriteKind) -> Vec<u8> {
    let tag = match kind {
        MemoryWriteKind::Hex => 'M',
        MemoryWriteKind::Binary => 'X',
    };
    let mut out = format!("{tag}{addr:x},{:x}:", data.len()).into_bytes();
    match kind {
        MemoryWriteKind::Hex => out.extend_from_slice(hex_encode(data).as_bytes()),
        MemoryWriteKind::Binary => out.extend_from_slice(data),
    }
    out
}

/// `?` — why is the target stopped. The one query we send at attach time to
/// learn the initial state; it does not change anything.
pub fn halt_reason() -> Vec<u8> {
    b"?".to_vec()
}

/// `qRcmd,<hex>` — a `monitor` command. Allowed but reviewed per command: the
/// server-specific text can do anything the server's command set can do, so the
/// restraint here is on callers, not on the encoding.
pub fn monitor(command: &str) -> Vec<u8> {
    format!("qRcmd,{}", hex_encode(command.as_bytes())).into_bytes()
}

// ── Reply parsing ────────────────────────────────────────────────────────────

/// An `E xx` error reply, if that is what this payload is.
///
/// Also recognises the `E.<text>` form that stubs advertising `error-message+`
/// may send, in which case there is no numeric code.
pub fn parse_error(payload: &[u8]) -> Option<Option<u8>> {
    let rest = payload.strip_prefix(b"E")?;
    if let Some(text) = rest.strip_prefix(b".") {
        // Textual error. Non-empty check keeps a literal "E." from looking like
        // a real message.
        return (!text.is_empty()).then_some(None);
    }
    if rest.len() == 2 {
        return Some(hex_pair(rest[0], rest[1]));
    }
    None
}

/// Decode the reply to an `m` or `x` request into raw target bytes.
///
/// The `x` form's leading `b` marker is required: GDB's `remote_read_bytes_1`
/// treats its absence as an I/O error, and so do we. An **empty** reply means
/// the stub does not implement the packet at all — that is
/// [`RspError::Unsupported`] rather than a failure, so a caller can fall back to
/// `m` instead of reporting a broken target.
pub fn parse_mem_read_reply(payload: &[u8], kind: MemoryReadKind) -> Result<Vec<u8>, RspError> {
    if payload.is_empty() {
        return Err(RspError::Unsupported);
    }
    if let Some(code) = parse_error(payload) {
        return Err(RspError::Target(code));
    }
    match kind {
        MemoryReadKind::Hex => hex_decode(payload).ok_or(RspError::Malformed("non-hex in m reply")),
        MemoryReadKind::Binary => {
            let data = payload
                .strip_prefix(b"b")
                .ok_or(RspError::Malformed("x reply missing 'b' marker"))?;
            // Already unescaped by the codec: `Frame::payload` is the decoded
            // form, so there is nothing left to undo here.
            Ok(data.to_vec())
        }
    }
}

/// `OK`, the commonest reply in the protocol.
pub fn is_ok(payload: &[u8]) -> bool {
    payload == b"OK"
}

/// Confirm a write succeeded. `OK` is success; `E xx` is the target refusing.
pub fn parse_write_reply(payload: &[u8]) -> Result<(), RspError> {
    if payload.is_empty() {
        return Err(RspError::Unsupported);
    }
    if let Some(code) = parse_error(payload) {
        return Err(RspError::Target(code));
    }
    if is_ok(payload) {
        Ok(())
    } else {
        Err(RspError::Malformed("unexpected reply to a memory write"))
    }
}

/// A stop reply, in the detail we need: enough to drive the run-state model and
/// no more. Register values and thread ids in a `T` packet are GDB's business.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopReply {
    /// `S AA` or `T AA…` — the target halted with signal `AA`.
    Signalled(u8),
    /// `W AA…` — the process exited with that status.
    Exited(u8),
    /// `X AA…` — the process terminated with that signal.
    Terminated(u8),
    /// `N` — non-stop mode, no threads left running. Not a halt of anything in
    /// particular, so it must not be read as one.
    NoResumedThreads,
}

/// Parse a stop reply. `None` when this payload is not one — including for `O`
/// and `F`, which can arrive between a resume and its real stop reply and which
/// a caller must not mistake for the reply it is waiting on.
pub fn parse_stop_reply(payload: &[u8]) -> Option<StopReply> {
    let (&tag, rest) = payload.split_first()?;
    match tag {
        // `T` carries `AA` then `;`-separated key:value pairs; only the signal
        // matters here.
        b'S' | b'T' => hex_pair_at(rest, 0).map(StopReply::Signalled),
        b'W' => hex_pair_at(rest, 0).map(StopReply::Exited),
        b'X' => hex_pair_at(rest, 0).map(StopReply::Terminated),
        // `N` takes no payload; anything after it is someone else's packet.
        b'N' if rest.is_empty() => Some(StopReply::NoResumedThreads),
        _ => None,
    }
}

// ── Hex helpers ──────────────────────────────────────────────────────────────

/// Lowercase hex, two characters per byte. RSP is case-insensitive on input but
/// conventionally lowercase on output.
pub fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        s.push(hex_digit(b >> 4));
        s.push(hex_digit(b & 0x0f));
    }
    s
}

/// Decode an even-length run of hex digits. `None` on odd length or a non-hex
/// character — a partially decoded memory read is worse than none.
pub fn hex_decode(hex: &[u8]) -> Option<Vec<u8>> {
    if !hex.len().is_multiple_of(2) {
        return None;
    }
    let mut out = Vec::with_capacity(hex.len() / 2);
    for pair in hex.chunks(2) {
        out.push(hex_pair(pair[0], pair[1])?);
    }
    Some(out)
}

/// Parse a hex integer, as RSP writes addresses and lengths: minimal digits, no
/// `0x`, either case.
pub fn parse_hex_u64(s: &[u8]) -> Option<u64> {
    if s.is_empty() {
        return None;
    }
    let mut v: u64 = 0;
    for &b in s {
        v = v.checked_mul(16)?.checked_add(hex_val(b)? as u64)?;
    }
    Some(v)
}

fn hex_digit(nibble: u8) -> char {
    char::from_digit(nibble as u32, 16).unwrap_or('0')
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn hex_pair(hi: u8, lo: u8) -> Option<u8> {
    Some((hex_val(hi)? << 4) | hex_val(lo)?)
}

fn hex_pair_at(s: &[u8], at: usize) -> Option<u8> {
    hex_pair(*s.get(at)?, *s.get(at + 1)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gdb_rsp::frame::{encode_packet, FrameKind, PacketCodec};

    fn decode_one(bytes: &[u8]) -> (FrameKind, Vec<u8>) {
        let mut codec = PacketCodec::new();
        codec.feed(bytes);
        let f = codec.next_frame().expect("a frame");
        assert!(codec.next_frame().is_none(), "expected exactly one frame");
        (f.kind, f.payload)
    }

    // ── Builders ──────────────────────────────────────────────────────────────

    #[test]
    fn mem_read_uses_hex_address_and_length() {
        assert_eq!(mem_read(0x2000_0000, 4, MemoryReadKind::Hex), b"m20000000,4");
        assert_eq!(mem_read(0x2000_0000, 4, MemoryReadKind::Binary), b"x20000000,4");
        // Length is hex too, which is easy to get wrong: 16 is "10", not "16".
        assert_eq!(mem_read(0, 16, MemoryReadKind::Hex), b"m0,10");
        assert_eq!(mem_read(0xe000_101c, 0x100, MemoryReadKind::Hex), b"me000101c,100");
    }

    #[test]
    fn mem_write_hex_form() {
        assert_eq!(
            mem_write(0x2000_0000, &[0xde, 0xad], MemoryWriteKind::Hex),
            b"M20000000,2:dead"
        );
    }

    #[test]
    fn mem_write_binary_form_leaves_escaping_to_the_framing_layer() {
        // `#` here must appear raw in the payload; encode_packet escapes it.
        let payload = mem_write(0x100, b"#", MemoryWriteKind::Binary);
        assert_eq!(payload, b"X100,1:#");
        // Round-tripping through the framing layer must give the payload back
        // unchanged -- i.e. exactly one level of escaping was applied.
        let (kind, decoded) = decode_one(&encode_packet(&payload));
        assert_eq!(kind, FrameKind::Packet);
        assert_eq!(decoded, payload);
    }

    #[test]
    fn binary_write_round_trips_every_byte_value() {
        let data: Vec<u8> = (0u8..=255).collect();
        let payload = mem_write(0, &data, MemoryWriteKind::Binary);
        let (_, decoded) = decode_one(&encode_packet(&payload));
        assert_eq!(decoded, payload);
        // And the data portion survives intact.
        let colon = decoded.iter().position(|&b| b == b':').unwrap();
        assert_eq!(&decoded[colon + 1..], &data[..]);
    }

    #[test]
    fn monitor_command_is_hex_encoded() {
        assert_eq!(monitor("reset"), b"qRcmd,7265736574");
    }

    #[test]
    fn halt_reason_is_a_bare_question_mark() {
        assert_eq!(halt_reason(), b"?");
    }

    // ── Error replies ─────────────────────────────────────────────────────────

    #[test]
    fn parses_numeric_and_textual_errors() {
        assert_eq!(parse_error(b"E01"), Some(Some(1)));
        assert_eq!(parse_error(b"Eff"), Some(Some(255)));
        assert_eq!(parse_error(b"E.no such address"), Some(None));
        // Not errors.
        assert_eq!(parse_error(b"OK"), None);
        assert_eq!(parse_error(b"E"), None);
        assert_eq!(parse_error(b"E."), None);
        // `E` followed by something that is not a two-digit code is not an error
        // reply -- it could be the start of hex memory data.
        assert_eq!(parse_error(b"E123"), None);
    }

    // ── Memory read replies ───────────────────────────────────────────────────

    #[test]
    fn hex_read_reply_decodes() {
        assert_eq!(
            parse_mem_read_reply(b"deadbeef", MemoryReadKind::Hex).unwrap(),
            vec![0xde, 0xad, 0xbe, 0xef]
        );
    }

    #[test]
    fn binary_read_reply_requires_the_b_marker() {
        assert_eq!(
            parse_mem_read_reply(b"b\x01\x02", MemoryReadKind::Binary).unwrap(),
            vec![1, 2]
        );
        // Missing marker is an I/O error in GDB, and must not be silently read as
        // data -- that would shift every byte.
        assert!(matches!(
            parse_mem_read_reply(b"\x01\x02", MemoryReadKind::Binary),
            Err(RspError::Malformed(_))
        ));
    }

    #[test]
    fn empty_reply_means_unsupported_not_broken() {
        // The distinction matters: it is the signal to fall back from `x` to `m`.
        assert!(matches!(
            parse_mem_read_reply(b"", MemoryReadKind::Binary),
            Err(RspError::Unsupported)
        ));
        assert!(matches!(
            parse_mem_read_reply(b"", MemoryReadKind::Hex),
            Err(RspError::Unsupported)
        ));
    }

    #[test]
    fn target_error_on_a_read_is_reported_as_such() {
        assert!(matches!(
            parse_mem_read_reply(b"E01", MemoryReadKind::Hex),
            Err(RspError::Target(Some(1)))
        ));
    }

    #[test]
    fn odd_length_hex_reply_is_malformed() {
        assert!(matches!(
            parse_mem_read_reply(b"abc", MemoryReadKind::Hex),
            Err(RspError::Malformed(_))
        ));
    }

    #[test]
    fn write_replies() {
        assert!(parse_write_reply(b"OK").is_ok());
        assert!(matches!(parse_write_reply(b"E0e"), Err(RspError::Target(Some(14)))));
        assert!(matches!(parse_write_reply(b""), Err(RspError::Unsupported)));
        assert!(matches!(parse_write_reply(b"garbage"), Err(RspError::Malformed(_))));
    }

    // ── Stop replies ──────────────────────────────────────────────────────────

    #[test]
    fn stop_reply_forms() {
        assert_eq!(parse_stop_reply(b"S05"), Some(StopReply::Signalled(5)));
        assert_eq!(parse_stop_reply(b"T05thread:01;"), Some(StopReply::Signalled(5)));
        assert_eq!(
            parse_stop_reply(b"T0511:0000;thread:p1.1;"),
            Some(StopReply::Signalled(5))
        );
        assert_eq!(parse_stop_reply(b"W00"), Some(StopReply::Exited(0)));
        assert_eq!(parse_stop_reply(b"X09"), Some(StopReply::Terminated(9)));
        assert_eq!(parse_stop_reply(b"N"), Some(StopReply::NoResumedThreads));
    }

    #[test]
    fn non_stop_replies_are_rejected() {
        // These three are the dangerous ones: `O` and `F` arrive mid-transaction
        // and `OK` is the commonest reply of all. Mistaking any of them for a
        // stop reply would corrupt the run-state model.
        assert_eq!(parse_stop_reply(b"OK"), None);
        assert_eq!(parse_stop_reply(b"O48656c6c6f"), None);
        assert_eq!(parse_stop_reply(b"Fopen,1234/0,0,1b6"), None);
        assert_eq!(parse_stop_reply(b""), None);
        // Truncated signal.
        assert_eq!(parse_stop_reply(b"S0"), None);
        assert_eq!(parse_stop_reply(b"S"), None);
        // `N` with a payload is not an `N`.
        assert_eq!(parse_stop_reply(b"Nxyz"), None);
    }

    // ── Hex helpers ───────────────────────────────────────────────────────────

    #[test]
    fn hex_round_trip() {
        let data: Vec<u8> = (0u8..=255).collect();
        let encoded = hex_encode(&data);
        assert_eq!(hex_decode(encoded.as_bytes()).unwrap(), data);
    }

    #[test]
    fn hex_decode_is_case_insensitive_but_length_strict() {
        assert_eq!(hex_decode(b"DEadBEef").unwrap(), vec![0xde, 0xad, 0xbe, 0xef]);
        assert!(hex_decode(b"abc").is_none());
        assert!(hex_decode(b"zz").is_none());
        assert_eq!(hex_decode(b"").unwrap(), Vec::<u8>::new());
    }

    #[test]
    fn hex_u64_parsing() {
        assert_eq!(parse_hex_u64(b"20000000"), Some(0x2000_0000));
        assert_eq!(parse_hex_u64(b"ffffffffffffffff"), Some(u64::MAX));
        assert_eq!(parse_hex_u64(b"0"), Some(0));
        assert_eq!(parse_hex_u64(b""), None);
        assert_eq!(parse_hex_u64(b"xyz"), None);
        // Overflow must not wrap silently into a plausible address.
        assert_eq!(parse_hex_u64(b"fffffffffffffffff"), None);
    }
}
