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

//! What a `qSupported` exchange told us about the gdb-server, and what we are
//! therefore allowed to do.
//!
//! The multiplexer learns all of this by **watching GDB's own negotiation** —
//! we never send a `qSupported` of our own (`docs-internal/gdb-rsp.md` §4.5), so
//! this type is populated from an observed reply, not from a probe.

/// GDB's baseline when a stub advertises no `PacketSize`: `remote_packet_size =
/// 400 - 1` in `gdb/remote.c`. Deliberately small; almost every real stub
/// advertises something larger.
///
/// Historical note on why we stay conservative rather than exact: OpenOCD's limit
/// was 512 for years, and its buffer was actually one byte short of that — a
/// stub can be wrong about its own advertised size. Combined with the protocol
/// explicitly permitting short replies (see [`RspCaps::max_read_bytes`]), the
/// right posture is to ask for a sane amount and loop, not to compute a
/// byte-exact maximum and trust it.
pub const DEFAULT_PACKET_SIZE: usize = 399;

/// GDB's `MIN_MEMORY_PACKET_SIZE`. A stub advertising less than this gets
/// clamped up — at 20 bytes there is still room to write one byte, which is the
/// floor GDB guarantees itself.
pub const MIN_PACKET_SIZE: usize = 20;

/// Room reserved for a write packet's own header (`M<addr>,<len>:`) when sizing
/// a chunk. Generous: a 64-bit address and length in hex is at most 16 + 16
/// characters plus three punctuation bytes.
const WRITE_HEADER_RESERVE: usize = 40;

/// How this connection should read memory.
///
/// **Neither form guarantees the access size or alignment used on the target.**
/// The GDB manual says of both `m` and `x`, in identical words: "The stub need not
/// use any particular size or alignment when gathering data from memory for the
/// response; even if addr is word-aligned and length is a multiple of the word
/// size, the stub is free to use byte accesses, or not. For this reason, this
/// packet may not be suitable for accessing memory-mapped I/O devices."
///
/// That warning lands squarely on two of our planned consumers: `DWT_PCSR` and the
/// CoreSight trace registers are MMIO, and a 32-bit MMIO register read as four
/// byte accesses returns nonsense. RTT is unaffected — it reads ordinary SRAM.
/// See `docs-internal/gdb-rsp.md` §7: whether a given server actually issues
/// aligned word accesses for aligned word-sized requests is a per-server fact to
/// verify, and a monitor command may be the only guaranteed route for MMIO.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum MemoryReadKind {
    /// `m addr,len` — hex reply, two characters per byte. Universally implemented
    /// in practice, so this is the default: assuming `x` and being wrong costs a
    /// failed read, assuming `m` and being wrong costs only bandwidth.
    #[default]
    Hex,
    /// `x addr,len` — reply is `b` followed by escaped binary.
    ///
    /// **Only legal when the stub advertises `binary-upload+`.** The manual is
    /// unambiguous: "GDB will only use this packet if the stub reports the
    /// `binary-upload` feature is supported in its `qSupported` reply." So this is
    /// never a guess — [`RspCaps::memory_read_kind`] derives it from the feature
    /// bit and nothing else.
    Binary,
}

/// How this connection should write memory. Mirrors [`MemoryReadKind`]; `X` is
/// gated on the same `binary-upload` feature in practice.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum MemoryWriteKind {
    /// `M addr,len:<hex>`.
    #[default]
    Hex,
    /// `X addr,len:<escaped binary>`.
    Binary,
}

/// What Agent-side features this server can support.
///
/// Three values, not a yes/no blacklist: `HaltedOnly` is genuinely useful (flush
/// RTT on stop, read state on halt) and saying so beats appearing broken. See
/// `docs-internal/gdb-rsp.md` §7.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ServerTier {
    /// Answers state-free requests while the target runs. Everything works.
    Full,
    /// Answers only while halted. The send gate blocks while running.
    HaltedOnly,
    /// Mishandles interleaved packets, or breaks GDB's session. Agent-side
    /// features off entirely.
    Unsupported,
    /// Not yet determined for this server type.
    ///
    /// **Provisionally** treated as `HaltedOnly` by the send gate — the
    /// conservative reading, since a request issued while running is the one that
    /// can destabilise a session. Once the compatibility matrix
    /// (`docs-internal/gdb-rsp.md` §7, Phase 3 item 17) has measured five or so
    /// servers, the right default is whatever proves *common*: if nearly all of
    /// them answer while running, this pessimism costs features for no benefit.
    /// Revisiting it means changing [`ServerTier::allows_while_running`] and its
    /// test, and nothing else.
    #[default]
    Unknown,
}

impl ServerTier {
    /// Whether the send gate may issue a request while the target is running.
    pub fn allows_while_running(self) -> bool {
        self == ServerTier::Full
    }

    /// Whether Agent-side features may run at all.
    pub fn allows_anything(self) -> bool {
        !matches!(self, ServerTier::Unsupported)
    }

    /// The tier for a `servertype` from the launch configuration.
    ///
    /// Only what has actually been measured is claimed here. §7's matrix is filled in by
    /// `mdbg rsp-probe` (item 17a), and so far only **OpenOCD** has been run (item 17b): both
    /// critical cells came back YES, and its memory-read path has no halt gate in the source
    /// (§4.2.1). Everything else stays [`ServerTier::Unknown`], which the send gate reads as
    /// halted-only -- so an Agent-side feature on those servers works while the target is stopped
    /// and waits while it runs.
    ///
    /// **That is not a placeholder to be guessed at.** The question is narrower than "does this
    /// server read memory while the target runs": it is whether it does so *on the same connection
    /// GDB has a `c` outstanding on* (§12 q2). The debug adapter's own RTT reads while running on
    /// every one of these servers, but over a **second** connection, so it is evidence for the
    /// easier case and not for this one. `debugFlags.rspTier` is how to try the answer on a server
    /// before the matrix has it.
    pub fn from_server_type(server_type: &str) -> Self {
        match server_type.to_ascii_lowercase().as_str() {
            "openocd" => ServerTier::Full,
            // Measured on hardware with Agent-side RTT, which is the narrow question (§12 q2): reads
            // answered on the same connection GDB has a `vCont;c` outstanding on, for a minute or more
            // without a stall. ST-LINK 89 KB/s, J-Link 80 KB/s.
            //
            // probe-rs answers too, and is `Full` on capability -- but at ~20 ms per round trip
            // against OpenOCD's ~1.8 ms, so 6.2 KB/s where OpenOCD manages 66. The tier is about what
            // a server *permits*, not how fast it is, and gating on speed here would be the wrong
            // lever: a slow server should be slow, not silently featureless.
            "stlink" | "jlink" | "probe-rs" => ServerTier::Full,
            // Measured, and it is a firm no: pyOCD does not answer an `m` while the target runs --
            // it *queues* it and replies when the target next stops. Observed on hardware as five
            // consecutive two-second timeouts during a run, every one of them answered within a
            // millisecond of the halt that followed. So `HaltedOnly` rather than `Unknown`: the
            // behaviour is known, not merely unprobed.
            "pyocd" => ServerTier::HaltedOnly,
            _ => ServerTier::Unknown,
        }
    }

    /// Parse an explicit override from `debugFlags.rspTier`.
    ///
    /// `None` for anything unrecognised, including `"auto"`, so a typo in a launch configuration
    /// falls back to the measured default rather than failing the session.
    pub fn from_flag(text: &str) -> Option<Self> {
        match text.to_ascii_lowercase().as_str() {
            "full" => Some(ServerTier::Full),
            "haltedonly" | "halted-only" | "halted" => Some(ServerTier::HaltedOnly),
            "unsupported" | "off" => Some(ServerTier::Unsupported),
            _ => None,
        }
    }
}

/// The largest memory read to ask a given gdb-server for in one packet.
///
/// **Not derivable from `PacketSize`.** The manual is specific about what that field means -- "the
/// remote stub can accept packets up to at least bytes length. GDB will send packets up to this size
/// for bulk transfers, and will never send larger packets" -- so it bounds what the *stub receives*
/// and says nothing whatever about the size of reply it can produce. OpenOCD advertises
/// `PacketSize=4000` (hex: 16384 bytes) and has historically mishandled a request far below that. So
/// a read size is a measured per-server fact, which is what this is.
///
/// **The hazard is specific sizes, not "large", and it was seen on OpenOCD.** A hex `m` reply is
/// `$` then 2n hex digits then `#` and two more, i.e. **2n + 4** bytes -- so a stub whose reply
/// buffer is a power of two has no room for its
/// NUL terminator at exactly one request length per buffer size: n = 254, 510, 1022, 2046, 4094. The
/// observed case was a 510-byte read against ST's bundled OpenOCD, whose replies came back with the
/// last checksum digit replaced by NUL -- `…f4a0f#b\0` -- four times out of four. It is the same
/// family as the 512-byte memory-request bug OpenOCD carried for years, fixed upstream by this
/// project's author.
///
/// An earlier version of this comment pinned that failure on the **ST-LINK** gdb-server. That was a
/// misattribution: the run in question was OpenOCD from ST's installation, and ST-LINK has since been
/// measured serving replies of 3 KB and more without a single rejection. Keeping the note because the
/// hazard is real and the attribution is what was wrong.
///
/// [`crate::gdb_rsp::chunk::safe_read_len`] now keeps every request off those lengths, at the one
/// place a packet's length is chosen. Which also means the hazard is no longer reproducible through
/// the normal path -- reproducing it deliberately needs that guard bypassed.
///
/// A too-large value here is self-correcting and a too-small one is silent:
/// [`crate::gdb_rsp::RspError::ReplyRejected`] retries a refused read at half the size, so a server
/// that cannot manage the amount asked costs round trips and shows up as `errors ... (rejected N)` in
/// the RTT statistics. That asymmetry is the argument for measuring rather than guessing low for ever.
///
/// Worth knowing before tuning this: **the target's ring buffer binds first.** `defmt-rtt` defaults
/// to `BUF_SIZE = 1024`, so no drain can see more than 1023 bytes and any cap at or above that is
/// unreachable -- on a stock ring, 1000 and 4000 measure the same. The numbers below come from runs
/// with `DEFMT_RTT_BUFFER_SIZE = 4096`, where the cap is what binds.
pub fn drain_cap_for_server(server_type: &str) -> usize {
    match server_type.to_ascii_lowercase().as_str() {
        // Stays 500, and this is the server the poison-size failure was actually seen on. The
        // versions in the wild are whatever a vendor's IDE installer happens to ship -- a macOS
        // update replaced ST's bundled OpenOCD mid-benchmark, which is how little control there is
        // over which one runs. Raising this wants its own sweep against a known-recent build.
        "openocd" => 500,
        // 2000, measured on a 4096-byte ring: 87.6 KB/s at 500, 108.8 at 1000, **126.1 at 2000**,
        // 132.4 at 3000, 133.3 at 4000. Flat past 2000 (+5.0%, then +0.6%) while the reply a single
        // read produces keeps doubling, so 2000 is the knee. At 4000 a read replies in 8 KB, and
        // §4.2 invariant 2 is that GDB never waits on us -- at depth 1 its worst case is one of our
        // reads, so that is ~15 ms bought for 0.6%; 2000 costs GDB ~8 ms.
        //
        // Drains averaged 1545 bytes there, i.e. replies of ~3 KB, with `errors 0` throughout. So
        // whatever ST-LINK's reply limit is, it is comfortably past 3 KB.
        "stlink" => 2000,
        // 2000, and measured the same way: 114.0 KB/s at 1000 against **134.2 at 2000**, +18%, which
        // makes J-Link the fastest of the four. Drains averaged 1629 bytes -- replies of 3262 -- for
        // fifty seconds with `errors 0`.
        //
        // This replaces a wrong conclusion worth recording. A default-settings run showed 79 errors
        // in its first five seconds, which was read as J-Link refusing a reply somewhere in
        // 1788..4004 bytes, and the cap was dropped to 1000 on the strength of it. Splitting the
        // error counter by cause showed them as `invalid 79` -- failed *descriptor validation*,
        // nothing to do with reply size -- and the count is identical at cap 1000 and cap 2000. They
        // were a stale control block left in SRAM by the previous run, which `rttConfig.clearSearch`
        // now clears before the engine starts. One counter that could not name its own causes cost a
        // day and a 18% regression.
        "jlink" => 2000,
        // Left at 500: it permits everything and answers in ~20 ms, so bytes per drain are not what
        // limits it and there is nothing to gain by asking for more.
        "probe-rs" => 500,
        _ => 500,
    }
}

/// The drain size to use, given what the server advertised.
///
/// [`drain_cap_for_server`] is a *performance* choice measured per server; `PacketSize` is applied
/// here as a **ceiling**, and the distinction matters. That field says what the stub can *receive*
/// -- "GDB will send packets up to this size ... and will never send larger packets" -- so it is no
/// evidence at all about the size of reply a server can produce, and treating it as a target would
/// mean asking ST-LINK for 8184 bytes on the strength of a claim it never made.
///
/// As a ceiling it is sound and it is the only signal available: a stub advertising a *small*
/// `PacketSize` is telling us its buffers are small, and that is worth believing in the conservative
/// direction. The form is `PacketSize/2 - 8`, which leaves the reply 12 bytes short of the advertised
/// figure (`2n + 4 = PacketSize - 12`) and, as a side effect, can never land on a power of two when
/// `PacketSize` is one.
pub fn drain_cap(server_type: &str, packet_size: usize) -> usize {
    let preferred = drain_cap_for_server(server_type);
    let ceiling = (packet_size / 2).saturating_sub(8).max(1);
    preferred.min(ceiling)
}

/// Everything the `qSupported` exchange told us.
#[derive(Debug, Clone, Default)]
pub struct RspCaps {
    /// `PacketSize=<hex>`, if advertised. Use [`RspCaps::packet_size`] rather
    /// than this: it applies the default and the floor.
    ///
    /// **It counts payload only.** The GDB manual's `qSupported` section is
    /// explicit: "This is a limit on the data characters in the packet, **not**
    /// including the frame and checksum." So `$`, `#` and the two checksum digits
    /// are *outside* the budget, and no framing allowance needs subtracting — which
    /// is also why GDB's plain `PacketSize / 2` for a hex read is exact rather
    /// than approximate.
    advertised_packet_size: Option<usize>,
    /// `binary-upload+` — the `x` packet (and in practice `X`) is available.
    pub binary_upload: bool,
    /// `vContSupported+`.
    pub vcont_supported: bool,
    /// `QNonStop+`. Recorded for completeness; this design does not use non-stop
    /// mode (`docs-internal/gdb-rsp.md` §2).
    pub non_stop_supported: bool,
    /// `QStartNoAckMode+` — the stub *offers* no-ack mode. Whether it is in
    /// effect is connection state, tracked by the codec's [`super::AckMode`],
    /// not by this flag.
    pub no_ack_offered: bool,
    /// `multiprocess+`.
    pub multiprocess: bool,
    /// Every feature token verbatim, in the order the stub sent them, so a later
    /// need does not require changing this struct.
    pub raw: Vec<String>,
}

impl RspCaps {
    /// Parse a `qSupported` **reply** payload — the stub's answer, not GDB's
    /// request. Unknown features are kept in `raw` and otherwise ignored, which
    /// is what the protocol requires of any reader.
    pub fn parse_reply(payload: &str) -> Self {
        let mut caps = Self::default();
        for token in payload.split(';').filter(|t| !t.is_empty()) {
            caps.raw.push(token.to_string());
            if let Some((name, value)) = token.split_once('=') {
                if name == "PacketSize" {
                    // Hex, no `0x` prefix. A stub that sends something
                    // unparseable gets the default rather than a panic.
                    caps.advertised_packet_size = usize::from_str_radix(value, 16).ok();
                }
                continue;
            }
            // `name+` supported, `name-` not, `name?` maybe. Only `+` counts as
            // yes; `?` means "ask me", which for our read-only purposes is a no.
            let Some(name) = token.strip_suffix('+') else { continue };
            match name {
                "binary-upload" => caps.binary_upload = true,
                "vContSupported" => caps.vcont_supported = true,
                "QNonStop" => caps.non_stop_supported = true,
                "QStartNoAckMode" => caps.no_ack_offered = true,
                "multiprocess" => caps.multiprocess = true,
                _ => {}
            }
        }
        caps
    }

    /// Look up any feature by name, for things this struct has no field for.
    /// Returns the value for `name=value`, or an empty string for a bare
    /// `name+`. `None` when the feature was not mentioned or was negated.
    pub fn feature(&self, name: &str) -> Option<&str> {
        self.raw.iter().find_map(|token| {
            if let Some((n, v)) = token.split_once('=') {
                return (n == name).then_some(v);
            }
            token.strip_suffix('+').filter(|n| *n == name).map(|_| "")
        })
    }

    /// Whether `PacketSize` was actually advertised, as opposed to defaulted.
    /// Worth logging once per session: a stub that advertises nothing is being
    /// driven at 399 bytes and may be much faster than that.
    pub fn packet_size_was_advertised(&self) -> bool {
        self.advertised_packet_size.is_some()
    }

    /// Usable packet payload size: what the stub advertised, or GDB's default,
    /// clamped up to GDB's minimum.
    pub fn packet_size(&self) -> usize {
        self.advertised_packet_size
            .unwrap_or(DEFAULT_PACKET_SIZE)
            .max(MIN_PACKET_SIZE)
    }

    /// Largest number of target bytes to request in one read.
    ///
    /// Halved, matching `remote_read_bytes_1`'s `(buf_size / unit_size) / 2`. The
    /// halving exists because `m` answers in hex, two characters per byte; since
    /// `PacketSize` excludes framing, `2N <= PacketSize` is exact rather than
    /// approximate. GDB applies the same halving to `x` rather than tracking two
    /// limits, and so do we — safely conservative there, and one less thing to get
    /// wrong per server.
    ///
    /// **This is a chunk size, not a contract.** The protocol explicitly allows a
    /// short answer: "The reply may contain fewer addressable memory units than
    /// requested." So a reader must loop until it has what it asked for regardless,
    /// which is what makes exact arithmetic an optimisation rather than a
    /// correctness requirement — and is the reason a stub that lies about its own
    /// size (as OpenOCD's 512-that-was-really-511 did for years) cannot break us.
    pub fn max_read_bytes(&self) -> usize {
        (self.packet_size() / 2).max(1)
    }

    /// Largest number of target bytes to send in one write.
    ///
    /// Same halving as reads, after reserving room for the packet's own
    /// `M<addr>,<len>:` header — which a read does not have to carry in the same
    /// buffer as its data. Strictly more conservative than GDB, so the only
    /// consequence of the reserve being too generous is an extra chunk.
    pub fn max_write_bytes(&self) -> usize {
        (self.packet_size().saturating_sub(WRITE_HEADER_RESERVE) / 2).max(1)
    }

    pub fn memory_read_kind(&self) -> MemoryReadKind {
        if self.binary_upload {
            MemoryReadKind::Binary
        } else {
            MemoryReadKind::Hex
        }
    }

    pub fn memory_write_kind(&self) -> MemoryWriteKind {
        if self.binary_upload {
            MemoryWriteKind::Binary
        } else {
            MemoryWriteKind::Hex
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn only_a_measured_server_is_claimed_to_answer_while_running() {
        // The bug this exists to stop coming back: a mux started at `Unknown` reads as halted-only,
        // so an Agent-side feature on a running target waits for a gate that never opens. Silently.
        // A generously advertised PacketSize must not lower the measured per-server choice...
        assert_eq!(
            drain_cap("stlink", 0x4000),
            2000,
            "16 KB advertised must not override 2000"
        );
        // ...but a stingy one must, because that is the only direction the field is evidence in.
        assert_eq!(drain_cap("stlink", 1024), 1024 / 2 - 8);
        assert_eq!(drain_cap("openocd", 0x4000), 500, "OpenOCD's claim buys it nothing");
        // GDB's own no-advertisement default, which a stub predating the field leaves us with.
        assert_eq!(drain_cap("stlink", DEFAULT_PACKET_SIZE), DEFAULT_PACKET_SIZE / 2 - 8);
        // Never zero, whatever nonsense is advertised: a zero-length read is not a read.
        for ps in [0, 1, 2, 16, 20] {
            assert!(
                drain_cap("stlink", ps) >= 1,
                "PacketSize={ps} produced a zero-length read"
            );
        }
        // The ceiling's reply is 12 bytes under the advertised size, so it clears a power-of-two
        // buffer by construction rather than by luck.
        for bits in 9..=14 {
            let ps = 1usize << bits;
            assert_eq!(2 * (ps / 2 - 8) + 4, ps - 12);
        }
        for server in ["openocd", "stlink", "jlink", "probe-rs", "pyocd", "something-new"] {
            let n = drain_cap_for_server(server);
            let reply = 2 * n + 4;
            assert!(
                !reply.is_power_of_two(),
                "a drain of {n} for {server} produces a reply of exactly {reply} bytes, which is the \
                 one size a stub with a {reply}-byte buffer cannot terminate"
            );
            assert!((1..=4096).contains(&n), "{server}: {n} is not a sane read size");
        }
        assert_eq!(ServerTier::from_server_type("openocd"), ServerTier::Full);
        assert_eq!(ServerTier::from_server_type("OpenOCD"), ServerTier::Full);
        // Not yet measured *on the same connection GDB is running on*, which is the narrower
        // question (§12 q2). The adapter's own RTT reads while running on all of these, but over a
        // second connection, so it is not evidence for this case.
        assert_eq!(
            ServerTier::from_server_type("pyocd"),
            ServerTier::HaltedOnly,
            "measured: pyOCD queues our reads until the target stops"
        );
        for kind in ["stlink", "jlink", "probe-rs"] {
            assert_eq!(
                ServerTier::from_server_type(kind),
                ServerTier::Full,
                "measured on hardware: {kind}"
            );
        }
        for kind in ["external", "qemu", "bmp", "pe", "stutil", ""] {
            assert_eq!(ServerTier::from_server_type(kind), ServerTier::Unknown, "{kind}");
        }
        assert!(
            !ServerTier::Unknown.allows_while_running(),
            "which is what shuts the gate"
        );
        assert!(ServerTier::Full.allows_while_running());
    }

    #[test]
    fn a_tier_override_is_parsed_and_a_typo_falls_back() {
        assert_eq!(ServerTier::from_flag("full"), Some(ServerTier::Full));
        assert_eq!(ServerTier::from_flag("haltedOnly"), Some(ServerTier::HaltedOnly));
        assert_eq!(ServerTier::from_flag("unsupported"), Some(ServerTier::Unsupported));
        // `auto` and anything misspelled mean "use the measured default", not "fail the session".
        assert_eq!(ServerTier::from_flag("auto"), None);
        assert_eq!(ServerTier::from_flag("Fulll"), None);
        assert_eq!(ServerTier::from_flag(""), None);
    }

    use super::*;

    /// OpenOCD's reply, **captured verbatim** from its own
    /// `gdb_log_outgoing_packet()` debug output during a real session (PSoC 6 via
    /// KitProg3). `PacketSize=4000` is `GDB_BUFFER_SIZE` = 16384.
    ///
    /// Note what is **absent**: no `binary-upload+`, because OpenOCD does not
    /// implement the `x` packet at all — there is no `case 'x'` in its dispatch.
    /// Memory reads against OpenOCD are hex, two characters per target byte.
    const OPENOCD: &str = "PacketSize=4000;qXfer:memory-map:read+;qXfer:features:read+;\
                           qXfer:threads:read+;QStartNoAckMode+;vContSupported+";

    /// What GDB *asks* for, from the same capture. Kept as documentation of the
    /// other half of the exchange: note that `binary-upload` does not appear here,
    /// because it is a stub-only feature the server volunteers — GDB never
    /// requests it.
    const GDB_REQUEST: &str = "multiprocess+;swbreak+;hwbreak+;qRelocInsn+;fork-events+;\
                               vfork-events+;exec-events+;vContSupported+;QThreadEvents+;\
                               QThreadOptions+;no-resumed+;memory-tagging+";

    #[test]
    fn parses_openocds_reply() {
        let caps = RspCaps::parse_reply(OPENOCD);
        assert_eq!(caps.packet_size(), 16384);
        assert!(caps.packet_size_was_advertised());
        assert!(caps.vcont_supported);
        assert!(caps.no_ack_offered);
        assert!(!caps.non_stop_supported);
        assert!(!caps.multiprocess);
        // The one that matters for read sizing: OpenOCD has no `x`, so `m` it is.
        assert!(!caps.binary_upload);
        assert_eq!(caps.memory_read_kind(), MemoryReadKind::Hex);
        // 16384 / 2 -- and for a hex-only server the halving is exactly right
        // rather than merely conservative.
        assert_eq!(caps.max_read_bytes(), 8192);
    }

    #[test]
    fn gdbs_own_request_does_not_mention_binary_upload() {
        // `binary-upload` is a stub-only feature: the server volunteers it, GDB
        // never asks. Parsing GDB's request must therefore not conclude that `x`
        // is available -- and must not crash on a list of features we ignore.
        let caps = RspCaps::parse_reply(GDB_REQUEST);
        assert!(!caps.binary_upload);
        assert!(!caps.packet_size_was_advertised());
        assert!(caps.multiprocess, "should still parse the tokens it does know");
        assert!(caps.vcont_supported);
    }

    #[test]
    fn parses_a_reply_that_does_advertise_binary_upload() {
        // Not OpenOCD. Kept separate so the OpenOCD fixture stays honest.
        let caps = RspCaps::parse_reply("PacketSize=1000;QStartNoAckMode+;binary-upload+;multiprocess+");
        assert!(caps.binary_upload);
        assert!(caps.multiprocess);
        assert_eq!(caps.memory_read_kind(), MemoryReadKind::Binary);
        assert_eq!(caps.memory_write_kind(), MemoryWriteKind::Binary);
    }

    #[test]
    fn parses_a_minimal_reply() {
        // A stub may answer with nothing at all; everything must default safely.
        let caps = RspCaps::parse_reply("");
        assert!(!caps.packet_size_was_advertised());
        assert_eq!(caps.packet_size(), DEFAULT_PACKET_SIZE);
        assert!(!caps.binary_upload);
        // The important default: `m`, which every stub implements.
        assert_eq!(caps.memory_read_kind(), MemoryReadKind::Hex);
        assert_eq!(caps.memory_write_kind(), MemoryWriteKind::Hex);
    }

    #[test]
    fn parses_a_jlink_style_reply_without_binary_upload() {
        let caps = RspCaps::parse_reply("PacketSize=1000;qXfer:memory-map:read-;QStartNoAckMode+;swbreak+");
        assert_eq!(caps.packet_size(), 0x1000);
        assert!(!caps.binary_upload);
        assert_eq!(caps.memory_read_kind(), MemoryReadKind::Hex);
    }

    #[test]
    fn negated_and_maybe_features_are_not_treated_as_supported() {
        // `-` is an explicit no; `?` means "query me", which is not a yes.
        let caps = RspCaps::parse_reply("binary-upload-;QNonStop?;vContSupported+");
        assert!(!caps.binary_upload);
        assert!(!caps.non_stop_supported);
        assert!(caps.vcont_supported);
    }

    #[test]
    fn unknown_features_are_retained_verbatim() {
        let caps = RspCaps::parse_reply("PacketSize=100;some-future-thing+;another=42");
        assert!(caps.raw.contains(&"some-future-thing+".to_string()));
        assert_eq!(caps.feature("some-future-thing"), Some(""));
        assert_eq!(caps.feature("another"), Some("42"));
        assert_eq!(caps.feature("nonexistent"), None);
    }

    #[test]
    fn unparseable_packet_size_falls_back_to_the_default() {
        // Must not panic and must not end up with a nonsense size.
        let caps = RspCaps::parse_reply("PacketSize=notahexnumber;binary-upload+");
        assert_eq!(caps.packet_size(), DEFAULT_PACKET_SIZE);
        // Parsing continues past the bad token.
        assert!(caps.binary_upload);
    }

    #[test]
    fn tiny_advertised_packet_size_is_clamped_up() {
        let caps = RspCaps::parse_reply("PacketSize=4");
        assert_eq!(caps.packet_size(), MIN_PACKET_SIZE);
        // A read must still be for at least one byte.
        assert!(caps.max_read_bytes() >= 1);
        assert!(caps.max_write_bytes() >= 1);
    }

    #[test]
    fn read_budget_is_half_the_packet_size() {
        // The `/ 2` from remote_read_bytes_1. Getting this wrong means either
        // truncated replies or needlessly many round trips.
        let caps = RspCaps::parse_reply("PacketSize=1000");
        assert_eq!(caps.max_read_bytes(), 0x800);
    }

    #[test]
    fn write_budget_leaves_room_for_the_packet_header() {
        let caps = RspCaps::parse_reply("PacketSize=1000");
        assert!(
            caps.max_write_bytes() < caps.max_read_bytes(),
            "writes must reserve header room that reads do not"
        );
        assert_eq!(caps.max_write_bytes(), (0x1000 - WRITE_HEADER_RESERVE) / 2);
    }

    #[test]
    fn tier_gating() {
        assert!(ServerTier::Full.allows_while_running());
        assert!(!ServerTier::HaltedOnly.allows_while_running());
        // An undetermined server is treated as halted-only, not as Full: issuing
        // a request while running is the move that can destabilise a session.
        assert!(!ServerTier::Unknown.allows_while_running());
        assert!(ServerTier::Unknown.allows_anything());
        assert!(!ServerTier::Unsupported.allows_anything());
        assert!(!ServerTier::Unsupported.allows_while_running());
        // The default must be the conservative one.
        assert_eq!(ServerTier::default(), ServerTier::Unknown);
    }
}
