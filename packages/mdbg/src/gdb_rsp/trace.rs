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

//! Packet-level RSP tracing, to its own file.
//!
//! GDB's `set debug remote` and OpenOCD's `gdb_log_*_packet()` are **endpoint**
//! traces: two directions, and each sees only its own half. The multiplexer is a
//! **relay with four parties**, and the two that matter most are invisible to both
//! of those tools:
//!
//! | Party     | Meaning                                                    |
//! | --------- | ---------------------------------------------------------- |
//! | `GDB>SRV` | forwarded from GDB — GDB's own trace shows this too        |
//! | `SRV>GDB` | forwarded to GDB — likewise                                |
//! | `AGT>SRV` | **injected by the Agent** — no other tool can show this    |
//! | `SRV>AGT` | **consumed by the Agent**, never forwarded — likewise      |
//!
//! Every party token is exactly seven characters, so columns line up and
//! `grep AGT` isolates the Agent's own traffic — which is the reason this exists.
//! The interleaving between `AGT>SRV` and an outstanding `GDB>SRV` continue is the
//! thing that cannot be seen any other way, and it is where the subtle bugs live.
//!
//! **Tracing must never add latency to RSP.** That is the one rule
//! `docs-internal/Stream-Flow-Control.md` sets for this stream, and a trace that
//! slows what it measures produces numbers nobody can trust. So records go to a
//! **bounded** queue drained by a dedicated writer thread; when the queue is full
//! they are **dropped and counted**, and the count is written into the file so the
//! gap is visible rather than silent. Lossy under pressure, never blocking.

use std::fmt::Write as _;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender, TrySendError};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Records buffered before new ones are dropped. Generous enough to absorb a burst
/// (a flash write is thousands of packets) without letting a stalled disk grow the
/// queue without bound.
const QUEUE_DEPTH: usize = 8192;

/// Longest packet body rendered in full. Binary `X` writes and bulk `m` replies
/// would otherwise dominate the file and bury the sequence being studied.
const MAX_RENDER: usize = 512;

/// How much to trace.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TraceLevel {
    #[default]
    Off,
    /// Every packet and notification, but not `+`/`-`.
    Packets,
    /// Packets plus acknowledgements. Noisy, and the level to use for an
    /// ack-accounting problem — which is the failure mode this protocol invites.
    All,
}

impl TraceLevel {
    fn as_u8(self) -> u8 {
        match self {
            TraceLevel::Off => 0,
            TraceLevel::Packets => 1,
            TraceLevel::All => 2,
        }
    }

    fn from_u8(v: u8) -> Self {
        match v {
            1 => TraceLevel::Packets,
            2 => TraceLevel::All,
            _ => TraceLevel::Off,
        }
    }

    /// Parse a `debugFlags` value. Unknown strings are `Off` rather than an error:
    /// a typo in a launch configuration should not fail the debug session.
    pub fn parse(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "packets" | "on" | "true" => TraceLevel::Packets,
            "all" => TraceLevel::All,
            _ => TraceLevel::Off,
        }
    }

    pub fn is_on(self) -> bool {
        self != TraceLevel::Off
    }

    /// Whether acknowledgements are included.
    pub fn includes_acks(self) -> bool {
        self == TraceLevel::All
    }
}

/// Which pair of parties a record belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Party {
    GdbToServer,
    ServerToGdb,
    AgentToServer,
    ServerToAgent,
}

impl Party {
    /// Fixed-width, ASCII, greppable. All four are seven characters.
    pub fn token(self) -> &'static str {
        match self {
            Party::GdbToServer => "GDB>SRV",
            Party::ServerToGdb => "SRV>GDB",
            Party::AgentToServer => "AGT>SRV",
            Party::ServerToAgent => "SRV>AGT",
        }
    }
}

/// One thing that happened on the wire.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TraceEvent {
    pub party: Party,
    /// Bytes exactly as they appeared on the wire, framing included. Raw rather
    /// than decoded because that is what the peer saw, and what GDB's and
    /// OpenOCD's traces show — so the three can be compared line for line.
    pub raw: Vec<u8>,
    /// Consumer and sequence for Agent traffic, round-trip time on its replies.
    pub detail: Option<String>,
}

impl TraceEvent {
    pub fn new(party: Party, raw: Vec<u8>) -> Self {
        Self {
            party,
            raw,
            detail: None,
        }
    }

    pub fn with_detail(party: Party, raw: Vec<u8>, detail: String) -> Self {
        Self {
            party,
            raw,
            detail: Some(detail),
        }
    }
}

/// A record plus the moment it was queued.
struct Stamped {
    at: Duration,
    event: TraceEvent,
}

/// Handle used to record events. Cheap to clone and safe to share.
#[derive(Clone)]
pub struct RspTrace {
    tx: SyncSender<Stamped>,
    /// Read by callers to skip building an event at all when tracing is off, and
    /// writable so a control request can toggle a live channel.
    level: Arc<AtomicU8>,
    dropped: Arc<AtomicU64>,
    start: Instant,
}

impl RspTrace {
    /// Open `path` and start the writer thread.
    ///
    /// `label` names the stream in the header (`gdbPort`, `gdbPort1`, …).
    pub fn to_file(path: &Path, label: &str, level: TraceLevel) -> std::io::Result<Self> {
        let file = File::create(path)?;
        Ok(Self::to_writer(Box::new(file), label, level))
    }

    /// As [`RspTrace::to_file`], against any sink. Used by the tests, and by any
    /// caller that already has somewhere to put the output.
    pub fn to_writer(sink: Box<dyn Write + Send>, label: &str, level: TraceLevel) -> Self {
        let (tx, rx) = sync_channel::<Stamped>(QUEUE_DEPTH);
        let dropped = Arc::new(AtomicU64::new(0));
        let header = format!(
            "# mdbg RSP trace  stream={label}  level={level:?}\n\
             # t = ms since trace start; bytes are raw, as on the wire\n\
             # GDB>SRV / SRV>GDB are forwarded; AGT>SRV / SRV>AGT are the Agent's own\n"
        );
        let writer_dropped = Arc::clone(&dropped);
        std::thread::Builder::new()
            .name(format!("rsp-trace-{label}"))
            .spawn(move || write_loop(sink, rx, header, writer_dropped))
            .expect("failed to spawn RSP trace writer");

        Self {
            tx,
            level: Arc::new(AtomicU8::new(level.as_u8())),
            dropped,
            start: Instant::now(),
        }
    }

    pub fn level(&self) -> TraceLevel {
        TraceLevel::from_u8(self.level.load(Ordering::Relaxed))
    }

    /// Change the level on a live channel, so a trace can be turned on while a
    /// session is already misbehaving rather than only on the next run.
    pub fn set_level(&self, level: TraceLevel) {
        self.level.store(level.as_u8(), Ordering::Relaxed);
    }

    /// Records dropped because the queue was full.
    pub fn dropped(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }

    /// Queue an event. **Never blocks**; drops and counts when full.
    pub fn record(&self, event: TraceEvent) {
        if !self.level().is_on() {
            return;
        }
        let stamped = Stamped {
            at: self.start.elapsed(),
            event,
        };
        // Stamped here rather than in the writer: under load the queue delay is
        // exactly the interval being investigated, so the timestamp has to be taken
        // where the event happened.
        match self.tx.try_send(stamped) {
            Ok(()) => {}
            Err(TrySendError::Full(_)) => {
                self.dropped.fetch_add(1, Ordering::Relaxed);
            }
            Err(TrySendError::Disconnected(_)) => {
                // Writer has gone; nothing to do and nothing worth reporting on a
                // diagnostic path.
            }
        }
    }
}

fn write_loop(sink: Box<dyn Write + Send>, rx: Receiver<Stamped>, header: String, dropped: Arc<AtomicU64>) {
    let mut out = BufWriter::new(sink);
    let _ = out.write_all(header.as_bytes());
    // Flushed at once: a trace that shows nothing until the first packet looks like
    // a trace that never started, and a session wedged during the handshake would
    // leave an empty file with no sign it was enabled.
    let _ = out.flush();
    let mut reported_drops = 0u64;
    let mut line = String::with_capacity(256);

    while let Ok(stamped) = rx.recv() {
        // Surface gaps before the record that follows them, so the file reads in
        // order and a missing stretch is never mistaken for silence on the wire.
        let now_dropped = dropped.load(Ordering::Relaxed);
        if now_dropped > reported_drops {
            let _ = writeln!(
                out,
                "   --- {} record(s) dropped (trace queue full) ---",
                now_dropped - reported_drops
            );
            reported_drops = now_dropped;
        }

        line.clear();
        format_line(&mut line, &stamped);
        if out.write_all(line.as_bytes()).is_err() {
            return;
        }
        // Flushed per record on purpose: a trace is most wanted when the session
        // has just wedged or crashed, and a buffered tail would be the part
        // explaining why. `BufWriter` still coalesces the small writes within one
        // line.
        if out.flush().is_err() {
            return;
        }
    }
    let _ = out.flush();
}

fn format_line(out: &mut String, stamped: &Stamped) {
    let ms = stamped.at.as_secs_f64() * 1000.0;
    let _ = write!(out, "{ms:11.3}  {}  ", stamped.event.party.token());
    render_bytes(out, &stamped.event.raw);
    if let Some(detail) = &stamped.event.detail {
        let _ = write!(out, "   {detail}");
    }
    if has_encoding(&stamped.event.raw) {
        // An RLE or escaped payload looks corrupt when shown raw, so say why.
        let _ = write!(out, "   (rle/esc)");
    }
    out.push('\n');
}

/// Printable ASCII verbatim, everything else as `\xNN`, truncated at
/// [`MAX_RENDER`] with the full length noted.
fn render_bytes(out: &mut String, raw: &[u8]) {
    // Head **and** tail when truncating. Showing only the head hid the one part of a long frame
    // that decides whether it is valid at all -- the `#` and its two checksum digits -- so a
    // rejected frame and an accepted one looked identical in the trace, and telling them apart
    // meant reasoning about code instead of reading the evidence.
    const TAIL: usize = 8;
    if raw.len() <= MAX_RENDER {
        render_run(out, raw);
        return;
    }
    let head = MAX_RENDER - TAIL;
    render_run(out, &raw[..head]);
    let _ = write!(out, "…(+{} bytes)…", raw.len() - head - TAIL);
    render_run(out, &raw[raw.len() - TAIL..]);
}

fn render_run(out: &mut String, raw: &[u8]) {
    for &b in raw {
        match b {
            0x20..=0x7e => out.push(b as char),
            b'\n' => out.push_str("\\n"),
            b'\r' => out.push_str("\\r"),
            b'\t' => out.push_str("\\t"),
            _ => {
                let _ = write!(out, "\\x{b:02x}");
            }
        }
    }
}

/// Whether a packet body carries run-length encoding or escapes, which make the
/// raw form misleading to read. Only looks between `$`/`%` and the final `#`, so a
/// `*` in a `qRcmd` text payload is not mistaken for a run.
fn has_encoding(raw: &[u8]) -> bool {
    if !matches!(raw.first(), Some(b'$') | Some(b'%')) {
        return false;
    }
    let body_end = raw.iter().rposition(|&b| b == b'#').unwrap_or(raw.len());
    raw.get(1..body_end)
        .map(|body| body.contains(&b'*') || body.contains(&b'}'))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::common::sync::MutexExt;
    use std::sync::Mutex;

    /// A sink the test can read back. `Arc<Mutex<Vec<u8>>>` behind a `Write`.
    #[derive(Clone)]
    struct Shared(Arc<Mutex<Vec<u8>>>);

    impl Write for Shared {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock_recover().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn rig(level: TraceLevel) -> (RspTrace, Shared) {
        let shared = Shared(Arc::new(Mutex::new(Vec::new())));
        let trace = RspTrace::to_writer(Box::new(shared.clone()), "gdbPort", level);
        (trace, shared)
    }

    /// Wait for the writer thread to catch up.
    fn text(shared: &Shared, expect_lines: usize) -> String {
        for _ in 0..400 {
            let s = String::from_utf8_lossy(&shared.0.lock_recover()).to_string();
            if s.lines().filter(|l| !l.starts_with('#')).count() >= expect_lines {
                return s;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        String::from_utf8_lossy(&shared.0.lock_recover()).to_string()
    }

    #[test]
    fn level_parsing_is_forgiving() {
        assert_eq!(TraceLevel::parse("packets"), TraceLevel::Packets);
        assert_eq!(TraceLevel::parse("All"), TraceLevel::All);
        assert_eq!(TraceLevel::parse("on"), TraceLevel::Packets);
        assert_eq!(TraceLevel::parse("off"), TraceLevel::Off);
        // A typo must not fail a debug session, so it degrades to Off.
        assert_eq!(TraceLevel::parse("pakcets"), TraceLevel::Off);
        assert_eq!(TraceLevel::parse(""), TraceLevel::Off);
        assert_eq!(TraceLevel::default(), TraceLevel::Off);
    }

    #[test]
    fn every_party_token_is_the_same_width_so_columns_align() {
        // The property that makes the file readable and `grep AGT` exact.
        for p in [
            Party::GdbToServer,
            Party::ServerToGdb,
            Party::AgentToServer,
            Party::ServerToAgent,
        ] {
            assert_eq!(p.token().len(), 7, "{p:?}");
            assert!(p.token().is_ascii());
        }
    }

    #[test]
    fn records_carry_party_and_raw_bytes() {
        let (trace, shared) = rig(TraceLevel::Packets);
        trace.record(TraceEvent::new(Party::GdbToServer, b"$m20000000,4#4f".to_vec()));
        trace.record(TraceEvent::with_detail(
            Party::AgentToServer,
            b"$m0,4#fd".to_vec(),
            "c1/s42".to_string(),
        ));
        let out = text(&shared, 2);
        assert!(out.contains("GDB>SRV  $m20000000,4#4f"), "{out}");
        assert!(out.contains("AGT>SRV  $m0,4#fd"), "{out}");
        assert!(out.contains("c1/s42"), "{out}");
    }

    #[test]
    fn the_header_names_the_stream_and_explains_the_parties() {
        let (_trace, shared) = rig(TraceLevel::All);
        // The header goes out before any record.
        for _ in 0..200 {
            let s = String::from_utf8_lossy(&shared.0.lock_recover()).to_string();
            if s.contains("mdbg RSP trace") {
                assert!(s.contains("stream=gdbPort"));
                assert!(s.contains("AGT>SRV"), "the header should explain the Agent parties");
                return;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        panic!("no header written");
    }

    #[test]
    fn nothing_is_recorded_when_off() {
        let (trace, shared) = rig(TraceLevel::Off);
        for _ in 0..100 {
            trace.record(TraceEvent::new(Party::GdbToServer, b"$m0,4#fd".to_vec()));
        }
        std::thread::sleep(Duration::from_millis(50));
        let out = String::from_utf8_lossy(&shared.0.lock_recover()).to_string();
        assert_eq!(out.lines().filter(|l| !l.starts_with('#')).count(), 0, "{out}");
    }

    #[test]
    fn level_can_be_raised_and_lowered_on_a_live_trace() {
        // So a trace can be switched on while a session is already misbehaving.
        let (trace, shared) = rig(TraceLevel::Off);
        trace.record(TraceEvent::new(Party::GdbToServer, b"$before#00".to_vec()));
        trace.set_level(TraceLevel::Packets);
        trace.record(TraceEvent::new(Party::GdbToServer, b"$after#00".to_vec()));
        trace.set_level(TraceLevel::Off);
        trace.record(TraceEvent::new(Party::GdbToServer, b"$later#00".to_vec()));

        let out = text(&shared, 1);
        assert!(out.contains("$after#00"), "{out}");
        assert!(!out.contains("$before#00"), "{out}");
        assert!(!out.contains("$later#00"), "{out}");
    }

    #[test]
    fn binary_payloads_are_escaped_not_dumped_raw() {
        let (trace, shared) = rig(TraceLevel::Packets);
        trace.record(TraceEvent::new(Party::AgentToServer, b"$X0,3:\x00\x01\xff#00".to_vec()));
        let out = text(&shared, 1);
        assert!(out.contains("\\x00\\x01\\xff"), "{out}");
        // And the printable framing survives so the line is still recognisable.
        assert!(out.contains("$X0,3:"), "{out}");
    }

    #[test]
    fn long_payloads_are_truncated_with_the_full_length_noted() {
        let (trace, shared) = rig(TraceLevel::Packets);
        let big = [b'a'; MAX_RENDER + 300];
        trace.record(TraceEvent::new(Party::ServerToGdb, big.to_vec()));
        let out = text(&shared, 1);
        assert!(out.contains("…(+300 bytes)"), "{out}");
        // One line, not a 800-byte wall.
        let body = out.lines().find(|l| l.contains("SRV>GDB")).unwrap();
        assert!(
            body.len() < MAX_RENDER + 120,
            "line was not truncated: {} chars",
            body.len()
        );
    }

    #[test]
    fn run_length_encoded_replies_are_flagged_because_raw_looks_corrupt() {
        let (trace, shared) = rig(TraceLevel::Packets);
        trace.record(TraceEvent::new(Party::ServerToGdb, b"$0* #b0".to_vec()));
        let out = text(&shared, 1);
        assert!(out.contains("(rle/esc)"), "{out}");
    }

    #[test]
    fn a_plain_packet_is_not_flagged_as_encoded() {
        let (trace, shared) = rig(TraceLevel::Packets);
        trace.record(TraceEvent::new(
            Party::GdbToServer,
            b"$qSupported:multiprocess+#f7".to_vec(),
        ));
        let out = text(&shared, 1);
        assert!(!out.contains("(rle/esc)"), "{out}");
    }

    #[test]
    fn a_star_in_the_checksum_region_is_not_mistaken_for_encoding() {
        // `has_encoding` must look only between the frame markers, or a monitor
        // command carrying `*` in its text would be flagged for ever.
        let (trace, shared) = rig(TraceLevel::Packets);
        trace.record(TraceEvent::new(Party::GdbToServer, b"+".to_vec()));
        let out = text(&shared, 1);
        assert!(!out.contains("(rle/esc)"), "{out}");
    }

    #[test]
    fn timestamps_are_monotonic_and_in_milliseconds() {
        let (trace, shared) = rig(TraceLevel::Packets);
        trace.record(TraceEvent::new(Party::GdbToServer, b"$a#00".to_vec()));
        std::thread::sleep(Duration::from_millis(20));
        trace.record(TraceEvent::new(Party::GdbToServer, b"$b#00".to_vec()));
        let out = text(&shared, 2);
        let stamps: Vec<f64> = out
            .lines()
            .filter(|l| !l.starts_with('#') && l.contains("GDB>SRV"))
            .map(|l| l.split_whitespace().next().unwrap().parse().unwrap())
            .collect();
        assert_eq!(stamps.len(), 2, "{out}");
        assert!(stamps[1] > stamps[0], "not monotonic: {stamps:?}");
        assert!(stamps[1] - stamps[0] >= 15.0, "gap looks wrong: {stamps:?}");
    }

    #[test]
    fn recording_never_blocks_even_with_no_reader_progress() {
        // The guarantee that matters: a trace must not add latency to RSP. The
        // writer here accepts bytes only very slowly, so the queue fills.
        struct Slow;
        impl Write for Slow {
            fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
                std::thread::sleep(Duration::from_millis(50));
                Ok(buf.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let trace = RspTrace::to_writer(Box::new(Slow), "slow", TraceLevel::All);
        let started = Instant::now();
        for _ in 0..QUEUE_DEPTH + 2_000 {
            trace.record(TraceEvent::new(Party::GdbToServer, b"$m0,4#fd".to_vec()));
        }
        let elapsed = started.elapsed();
        assert!(elapsed < Duration::from_secs(2), "record() blocked: {elapsed:?}");
        assert!(trace.dropped() > 0, "queue should have overflowed and counted drops");
    }

    #[test]
    fn dropped_records_are_reported_in_the_file_rather_than_hidden() {
        let (trace, shared) = rig(TraceLevel::All);
        // Fabricate a gap: the counter is what the writer reports from.
        trace.dropped.fetch_add(17, Ordering::Relaxed);
        trace.record(TraceEvent::new(Party::GdbToServer, b"$after-gap#00".to_vec()));
        let out = text(&shared, 2);
        assert!(out.contains("17 record(s) dropped"), "{out}");
        // The gap notice must precede the record that follows it.
        let gap_at = out.find("dropped").unwrap();
        let rec_at = out.find("$after-gap").unwrap();
        assert!(gap_at < rec_at, "gap notice came after the record:\n{out}");
    }

    #[test]
    fn includes_acks_only_at_the_all_level() {
        assert!(!TraceLevel::Packets.includes_acks());
        assert!(TraceLevel::All.includes_acks());
        assert!(!TraceLevel::Off.includes_acks());
    }
}

#[cfg(test)]
mod format_reference {
    use super::*;
    use crate::common::sync::MutexExt;
    use std::sync::Mutex;

    /// A representative trace, asserted for the property that makes it readable and
    /// doubling as the format reference. Run with `-- --nocapture` to see it.
    #[test]
    fn a_representative_trace_has_aligned_columns() {
        #[derive(Clone)]
        struct Cap(Arc<Mutex<Vec<u8>>>);
        impl Write for Cap {
            fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
                self.0.lock_recover().extend_from_slice(b);
                Ok(b.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let cap = Cap(Arc::new(Mutex::new(Vec::new())));
        let t = RspTrace::to_writer(Box::new(cap.clone()), "gdbPort", TraceLevel::All);

        let script: &[(Party, &[u8], Option<&str>)] = &[
            (Party::GdbToServer, b"$qSupported:multiprocess+;swbreak+#f7", None),
            (
                Party::ServerToGdb,
                b"$PacketSize=4000;QStartNoAckMode+;vContSupported+#02",
                None,
            ),
            (Party::GdbToServer, b"+", None),
            (Party::GdbToServer, b"$vCont;c#a8", None),
            (Party::AgentToServer, b"$m20000000,4#4f", Some("c1/s42")),
            (Party::ServerToAgent, b"$deadbeef#3c", Some("c1/s42 rtt=0.412ms")),
            (Party::ServerToGdb, b"$0* #b0", None),
            (Party::AgentToServer, b"$X20000010,3:\x00\x01\xff#00", Some("c1/s43")),
            (Party::ServerToGdb, b"$T05thread:01;#07", None),
        ];
        for (party, raw, detail) in script {
            let ev = match detail {
                Some(d) => TraceEvent::with_detail(*party, raw.to_vec(), (*d).to_string()),
                None => TraceEvent::new(*party, raw.to_vec()),
            };
            t.record(ev);
        }

        let mut text = String::new();
        for _ in 0..400 {
            text = String::from_utf8_lossy(&cap.0.lock_recover()).to_string();
            if text.lines().filter(|l| !l.starts_with('#')).count() >= script.len() {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        println!("\n{text}");

        // The property claimed in the module docs: every party token starts at the
        // same column, so the file scans vertically and `grep AGT` is exact.
        let offsets: Vec<usize> = text
            .lines()
            .filter(|l| !l.starts_with('#') && !l.trim().is_empty())
            .map(|l| {
                l.find('>')
                    .map(|i| i - 3)
                    .unwrap_or_else(|| panic!("no party token in line: {l:?}"))
            })
            .collect();
        assert_eq!(offsets.len(), script.len(), "wrong line count:\n{text}");
        assert!(
            offsets.windows(2).all(|w| w[0] == w[1]),
            "party tokens are not column-aligned: {offsets:?}\n{text}"
        );
    }
}
