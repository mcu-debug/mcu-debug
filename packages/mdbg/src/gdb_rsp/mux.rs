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

//! The multiplexer core: routing, ack accounting, the send gate, and the
//! forbidden-packet choke point.
//!
//! **Sans-IO on purpose.** `MuxCore` owns no socket, spawns no thread and reads
//! no clock beyond the instants it is handed. Bytes go in, [`Action`]s come out,
//! and the caller performs them. Every rule in `docs-internal/gdb-rsp.md` §4 is
//! therefore testable without a gdb-server, a TCP connection or a sleep — which
//! matters because the rules that are hardest to get right (ack accounting, reply
//! matching behind an open-ended `c`) are also the hardest to provoke on demand
//! against a real server.
//!
//! The threaded shell that owns the socket and drives this is a separate, thin
//! layer; it contains no protocol logic.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use super::caps::{RspCaps, ServerTier};
use super::frame::{encode_packet, AckMode, Frame, FrameKind, PacketCodec};
use super::packet::parse_stop_reply;
use super::state::{Direction, StateTracker, TargetState};
use super::trace::{Party, TraceEvent, TraceLevel};
use super::RspError;

/// Identifies an Agent-side consumer (RTT, profiler, trace drain).
pub type ConsumerId = u64;

/// Default requests in flight. **One**, not two.
///
/// §4.2.1: the servers are single-threaded and strictly serial, so a second
/// outstanding request does not keep the probe busier — it only removes loopback
/// latency, which is noise beside SWD time. And in ack mode a second packet
/// collides with the server's post-reply ack read. Raising this is a measured
/// optimisation, not a default.
pub const DEFAULT_DEPTH: usize = 1;

/// How many times to resend one of our packets after a `-` before giving up on
/// that request.
const MAX_RETRANSMITS: u8 = 3;

/// Who a request belongs to, so its reply can be routed back.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RspSource {
    /// The GDB client on this mux. Its bytes are forwarded verbatim, both ways.
    Gdb,
    /// One of our consumers.
    Agent(ConsumerId),
}

/// Something the caller must do. Ordering within a returned `Vec` is significant:
/// perform them in order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    /// Write these bytes to the gdb-server.
    ToServer(Vec<u8>),
    /// Write these bytes to the GDB client.
    ToGdb(Vec<u8>),
    /// An Agent request finished. The payload is the decoded reply.
    Completed {
        id: ConsumerId,
        seq: u64,
        result: Result<Vec<u8>, RspError>,
    },
    /// The target's run state changed.
    StateChanged(TargetState),
    /// GDB's `qSupported` exchange completed and we read the answer.
    CapsLearned,
    /// No-ack mode came into force. Emitted at the exact packet where it happens,
    /// because that is the byte boundary a codec must switch on.
    NoAckEngaged,
    /// One thing that happened on the wire, for the trace file.
    ///
    /// Emitted only when a trace level is set, so it costs nothing when off. It
    /// exists because **provenance is only knowable here**: by the time the shell
    /// sees `ToServer` bytes it cannot tell GDB's forwarded packet from one of ours,
    /// and the replies we consume never become a `ToGdb` at all. Those two are
    /// precisely the parties no other tool can show (`trace.rs`).
    Trace(TraceEvent),
    /// The channel cannot be trusted any further.
    Fatal(&'static str),
}

/// What kinds of reply a sent request can attract.
///
/// Needed because replies carry no request id (§3.8) and — crucially — do **not**
/// come back in send order once an open-ended `c` is outstanding. Matching is
/// therefore by what each pending request *could* be answered with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ReplyShape {
    /// A stop reply (`S`/`T`/`W`/`X`) can answer this.
    stop: bool,
    /// Something other than a stop reply can answer this (`OK`, `E xx`, data).
    other: bool,
    /// The reply may be arbitrarily delayed, or never come: a resume, whose stop
    /// reply arrives only when the target halts. Such a request must not consume
    /// the pipelining budget — a single `c` would otherwise block us for exactly
    /// the interval this design exists to work in — and must never be timed out.
    open_ended: bool,
}

/// One packet sent and not yet resolved.
#[derive(Debug, Clone)]
struct Pending {
    source: RspSource,
    /// Our own id. Not on the wire — RSP has no request ids (§3.8).
    seq: u64,
    /// The framed bytes as sent, kept only so a `-` can be answered by resending.
    sent: Vec<u8>,
    /// `None` for a packet that draws no reply at all (`R`, `k`). Such an entry
    /// exists only so the server's ack can be accounted for, and never matches a
    /// reply — if it did, it would steal one belonging to a later request.
    shape: Option<ReplyShape>,
    /// Still waiting for the server's `+` for this packet (ack mode only).
    awaiting_ack: bool,
    /// How many times we have resent it.
    retransmits: u8,
    deadline: Option<Instant>,
    /// When it went out, for the trace's round-trip figure. `None` for GDB's
    /// packets, whose latency GDB measures for itself.
    sent_at: Option<Instant>,
}

impl Pending {
    fn open_ended(&self) -> bool {
        self.shape.is_some_and(|s| s.open_ended)
    }
}

/// An Agent request that has not been sent yet.
#[derive(Debug, Clone)]
struct Queued {
    id: ConsumerId,
    seq: u64,
    payload: Vec<u8>,
    timeout: Option<Duration>,
}

/// The protocol core. See the module docs for why it has no I/O.
pub struct MuxCore {
    /// Decodes the client→server direction, for snooping only. Forwarding uses
    /// each frame's `raw`, never a re-encode.
    gdb_codec: PacketCodec,
    /// Decodes the server→client direction.
    server_codec: PacketCodec,
    /// Agent requests waiting for the send gate to open.
    queue: VecDeque<Queued>,
    /// Sent, awaiting reply, in send order.
    pending: VecDeque<Pending>,
    state: StateTracker,
    caps: RspCaps,
    caps_known: bool,
    tier: ServerTier,
    depth: usize,
    next_seq: u64,
    /// GDB asked for no-ack mode and we are waiting for the server's `OK` to
    /// switch. The switch must happen after that reply and not a packet earlier.
    no_ack_requested: bool,
    /// A stub `F` request is outstanding and GDB owes it a reply. Nothing of ours
    /// may go out in between.
    file_io_outstanding: bool,
    closed: bool,
    trace_level: TraceLevel,
}

impl MuxCore {
    pub fn new(tier: ServerTier) -> Self {
        Self {
            gdb_codec: PacketCodec::new(),
            server_codec: PacketCodec::new(),
            queue: VecDeque::new(),
            pending: VecDeque::new(),
            state: StateTracker::new(),
            caps: RspCaps::default(),
            caps_known: false,
            tier,
            depth: DEFAULT_DEPTH,
            next_seq: 1,
            no_ack_requested: false,
            file_io_outstanding: false,
            closed: false,
            trace_level: TraceLevel::Off,
        }
    }

    /// Set how much to emit as [`Action::Trace`]. `Off` (the default) emits none.
    pub fn set_trace_level(&mut self, level: TraceLevel) {
        self.trace_level = level;
    }

    pub fn trace_level(&self) -> TraceLevel {
        self.trace_level
    }

    /// Insert a `SRV>GDB` record before each action that forwards to GDB.
    ///
    /// Done as a pass over the finished list rather than at each of the nine
    /// `ToGdb` sites: one place to get right, and impossible to forget when a new
    /// forwarding path is added later.
    fn trace_to_gdb(&self, actions: Vec<Action>) -> Vec<Action> {
        if !self.trace_level.is_on() {
            return actions;
        }
        let mut out = Vec::with_capacity(actions.len() * 2);
        for action in actions {
            if let Action::ToGdb(bytes) = &action {
                let is_ack = bytes.len() == 1 && matches!(bytes[0], b'+' | b'-');
                if !is_ack || self.trace_level.includes_acks() {
                    out.extend(self.trace(Party::ServerToGdb, bytes, None));
                }
            }
            out.push(action);
        }
        out
    }

    /// Build a trace action when tracing is on, so callers stay one-liners and
    /// nothing is allocated when it is off.
    fn trace(&self, party: Party, raw: &[u8], detail: Option<String>) -> Option<Action> {
        if !self.trace_level.is_on() {
            return None;
        }
        Some(Action::Trace(match detail {
            Some(d) => TraceEvent::with_detail(party, raw.to_vec(), d),
            None => TraceEvent::new(party, raw.to_vec()),
        }))
    }

    /// Raise the pipelining depth.
    ///
    /// Refused unless no-ack mode is already in force: in ack mode a second
    /// outstanding packet lands where the server expects a `+`, which OpenOCD
    /// survives with a logged "GDB missing ack" and another server may not
    /// (§4.2.1).
    pub fn set_depth(&mut self, depth: usize) -> Result<(), RspError> {
        if depth > 1 && self.ack_mode() != AckMode::NoAck {
            return Err(RspError::Malformed("pipelining above depth 1 requires no-ack mode"));
        }
        self.depth = depth.max(1);
        Ok(())
    }

    pub fn depth(&self) -> usize {
        self.depth
    }

    pub fn state(&self) -> TargetState {
        self.state.state()
    }

    pub fn caps(&self) -> &RspCaps {
        &self.caps
    }

    pub fn tier(&self) -> ServerTier {
        self.tier
    }

    pub fn set_tier(&mut self, tier: ServerTier) {
        self.tier = tier;
    }

    pub fn ack_mode(&self) -> AckMode {
        self.server_codec.ack_mode()
    }

    /// Requests sent and not yet answered. Diagnostic.
    pub fn in_flight(&self) -> usize {
        self.pending.len()
    }

    /// Agent requests waiting for the gate. Diagnostic.
    pub fn queued(&self) -> usize {
        self.queue.len()
    }

    // ── Inbound: from the GDB client ──────────────────────────────────────────

    /// Bytes arriving from GDB.
    ///
    /// Forwarded **on frame boundaries**, using each frame's `raw`. That is still
    /// verbatim — concatenating every frame's `raw` reproduces the input exactly —
    /// but it guarantees we never inject one of our packets into the middle of a
    /// half-received GDB packet, which would corrupt both. The wait is only for
    /// the rest of a packet already in flight, so it costs microseconds on
    /// loopback and cannot reorder anything GDB sent.
    pub fn on_gdb_bytes(&mut self, bytes: &[u8]) -> Vec<Action> {
        let mut actions = Vec::new();
        self.gdb_codec.feed(bytes);
        while let Some(frame) = self.gdb_codec.next_frame() {
            // Snoop first, forward second: observing cannot change the bytes, and
            // this way the state model is current before anything else reacts.
            if let Some(new_state) = self.state.observe(Direction::ToServer, &frame) {
                actions.push(Action::StateChanged(new_state));
            }
            match frame.kind {
                FrameKind::Packet => {
                    if frame.payload == b"QStartNoAckMode" {
                        self.no_ack_requested = true;
                    }
                    let seq = self.take_seq();
                    let awaiting_ack = self.ack_mode() == AckMode::Acked;
                    let shape = classify_request(&frame.payload);
                    // A no-reply packet in no-ack mode leaves nothing to track at
                    // all; tracking it anyway would hold a slot for ever.
                    if shape.is_some() || awaiting_ack {
                        self.pending.push_back(Pending {
                            source: RspSource::Gdb,
                            seq,
                            sent: frame.raw.clone(),
                            shape,
                            awaiting_ack,
                            retransmits: 0,
                            // GDB manages its own timeouts, and a `c` legitimately
                            // has no deadline at all.
                            deadline: None,
                            sent_at: None,
                        });
                    }
                }
                FrameKind::Ack | FrameKind::Nack => {
                    // GDB acking a reply we forwarded to it. Passes straight
                    // through; the server is waiting for exactly this.
                }
                FrameKind::Interrupt => {
                    // Forwarded with everything else. It is not a packet, so it
                    // creates no pending entry.
                }
                _ => {}
            }
            // Acks are the bulk of the traffic by count and say nothing when
            // healthy, so they only appear at `All` — which is the level to use for
            // an ack-accounting problem.
            let is_ack = matches!(frame.kind, FrameKind::Ack | FrameKind::Nack);
            if !is_ack || self.trace_level.includes_acks() {
                actions.extend(self.trace(Party::GdbToServer, &frame.raw, None));
            }
            actions.push(Action::ToServer(frame.raw));
        }
        actions.extend(self.pump());
        actions
    }

    /// GDB's connection went away.
    pub fn gdb_disconnected(&mut self) -> Vec<Action> {
        self.state.gdb_disconnected();
        // Our own requests are still legitimate until the channel itself closes,
        // but anything of GDB's will never be answered or acked.
        self.pending.retain(|p| p.source != RspSource::Gdb);
        vec![Action::StateChanged(self.state.state())]
    }

    // ── Inbound: from the gdb-server ──────────────────────────────────────────

    /// Bytes arriving from the gdb-server.
    pub fn on_server_bytes(&mut self, bytes: &[u8]) -> Vec<Action> {
        let mut actions = Vec::new();
        self.server_codec.feed(bytes);
        while let Some(frame) = self.server_codec.next_frame() {
            match frame.kind {
                FrameKind::Ack | FrameKind::Nack => self.on_server_ack(&frame, &mut actions),
                FrameKind::Packet => self.on_server_packet(frame, &mut actions),
                // Notifications, console output and file-I/O are never replies:
                // they must not retire a pending request. All are GDB's to see.
                FrameKind::Notification => {
                    if let Some(new_state) = self.state.observe(Direction::FromServer, &frame) {
                        actions.push(Action::StateChanged(new_state));
                    }
                    actions.push(Action::ToGdb(frame.raw));
                }
                FrameKind::FileIo => {
                    // GDB owes the stub a reply; we must not interleave until it
                    // has sent one.
                    self.file_io_outstanding = true;
                    actions.push(Action::ToGdb(frame.raw));
                }
                FrameKind::ConsoleOutput => actions.push(Action::ToGdb(frame.raw)),
                FrameKind::Interrupt | FrameKind::Garbage => {
                    // Garbage from the server is GDB's problem too: it may nack and
                    // recover. Swallowing it would leave GDB waiting forever.
                    actions.push(Action::ToGdb(frame.raw));
                }
            }
        }
        actions.extend(self.pump());
        self.trace_to_gdb(actions)
    }

    /// A `+`/`-` from the server. Untagged, so it belongs to the earliest packet
    /// still awaiting one — which is knowable only because this core is the sole
    /// writer of the socket and therefore knows the exact send order (§4.3).
    fn on_server_ack(&mut self, frame: &Frame, actions: &mut Vec<Action>) {
        let is_nack = frame.kind == FrameKind::Nack;
        let Some(idx) = self.pending.iter().position(|p| p.awaiting_ack) else {
            // Nothing of ours was waiting for one, so it cannot be ours to
            // swallow. Forward it: GDB is the only other party on this socket, and
            // dropping an ack it was owed would stall it permanently. We swallow
            // only acks we can positively attribute to our own packets.
            actions.push(Action::ToGdb(frame.raw.clone()));
            return;
        };
        let source = self.pending[idx].source;
        if !is_nack {
            self.pending[idx].awaiting_ack = false;
            // A packet that draws no reply is finished the moment it is acked.
            if self.pending[idx].shape.is_none() {
                self.pending.remove(idx);
            }
            if source == RspSource::Gdb {
                // GDB counts acks for its own packets, so it must see this one.
                actions.push(Action::ToGdb(frame.raw.clone()));
            }
            // Ours: swallow it. Forwarding would hand GDB an ack it never earned.
            return;
        }
        // A `-`: the server wants the packet again.
        match source {
            RspSource::Gdb => {
                // GDB retransmits its own packets. Its resend arrives as a new
                // frame and gets its own pending entry, so the accounting stays
                // right without us modelling the retry.
                self.pending.remove(idx);
                actions.push(Action::ToGdb(frame.raw.clone()));
            }
            RspSource::Agent(id) => {
                let p = &mut self.pending[idx];
                p.retransmits += 1;
                if p.retransmits > MAX_RETRANSMITS {
                    let seq = p.seq;
                    self.pending.remove(idx);
                    actions.push(Action::Completed {
                        id,
                        seq,
                        result: Err(RspError::Malformed("gdb-server rejected the packet repeatedly")),
                    });
                } else {
                    actions.push(Action::ToServer(p.sent.clone()));
                }
            }
        }
    }

    fn on_server_packet(&mut self, frame: Frame, actions: &mut Vec<Action>) {
        // Observe **before** matching, and whether or not anything matches. A stop
        // reply is a fact about the target regardless of which request drew it, and
        // some are unsolicited: the target can halt on its own, or in response to a
        // `\x03` — which is not a packet and so has no pending entry to match.
        // Skipping the state update for unmatched replies left the run-state model
        // stuck at `Unknown`, which in turn left the send gate shut for the whole
        // session. Found by `nothing_is_sent_before_the_handshake_settles`.
        if let Some(new_state) = self.state.observe(Direction::FromServer, &frame) {
            actions.push(Action::StateChanged(new_state));
        }

        let Some(idx) = self.match_reply(&frame.payload) else {
            // A reply to nothing we know about. It cannot be ours, so GDB is the
            // only plausible owner; hand it over rather than dropping it.
            actions.push(Action::ToGdb(frame.raw));
            return;
        };
        let p = self.pending.remove(idx).expect("index came from match_reply");

        match p.source {
            RspSource::Gdb => {
                // GDB's reply. Verbatim, original bytes, run-length encoding and
                // escapes untouched (§2 invariant 5).
                let was_no_ack_request = self.no_ack_requested && frame.payload == b"OK";
                actions.push(Action::ToGdb(frame.raw));
                if was_no_ack_request {
                    // Switch exactly here: after this reply, before the next byte
                    // in either direction. A packet either side of this point and
                    // everything afterwards desynchronises.
                    self.no_ack_requested = false;
                    self.gdb_codec.set_ack_mode(AckMode::NoAck);
                    self.server_codec.set_ack_mode(AckMode::NoAck);
                    for pending in &mut self.pending {
                        pending.awaiting_ack = false;
                    }
                    actions.push(Action::NoAckEngaged);
                }
                // GDB's qSupported reply is where we learn the server's
                // capabilities — for free, without sending a probe of our own.
                if !self.caps_known && looks_like_q_supported_reply(&frame.payload) {
                    self.caps = RspCaps::parse_reply(&String::from_utf8_lossy(&frame.payload));
                    self.caps_known = true;
                    actions.push(Action::CapsLearned);
                }
                // GDB answering a file-I/O request clears the barrier. Its own
                // `F` reply travels the other way, so this is only the release of
                // the stub's side; the client half is handled in `on_gdb_bytes`
                // implicitly by the reply being just another packet.
                self.file_io_outstanding = false;
            }
            RspSource::Agent(id) => {
                // The direction no other tool can show: a reply that never reaches
                // GDB at all. Round-trip is measured here because this is the only
                // place both ends of it are known. `Instant::now()` is the one clock
                // read in the core, and only when tracing is on.
                let detail = match p.sent_at {
                    Some(at) => format!("c{id}/s{} rtt={:.3}ms", p.seq, at.elapsed().as_secs_f64() * 1000.0),
                    None => format!("c{id}/s{}", p.seq),
                };
                actions.extend(self.trace(Party::ServerToAgent, &frame.raw, Some(detail)));
                // Ours. Never reaches GDB. In ack mode the server is waiting for
                // an ack for this reply, and GDB will not send one because GDB
                // never saw it — so we must.
                if self.ack_mode() == AckMode::Acked {
                    actions.push(Action::ToServer(vec![b'+']));
                }
                actions.push(Action::Completed {
                    id,
                    seq: p.seq,
                    result: Ok(frame.payload),
                });
            }
        }
    }

    /// Decide which pending request a reply answers.
    ///
    /// **Not simply the head of the queue**, and this is the subtlest rule in the
    /// mux. While GDB has an open-ended `c` outstanding we send an `m` behind it,
    /// and the `m` reply comes back *first* — the `c` is answered only when the
    /// target halts, possibly minutes later. Strict FIFO matching would hand our
    /// memory data to GDB as its stop reply and hand the real stop reply to a
    /// consumer expecting bytes.
    ///
    /// So a reply goes to the **earliest pending request that could have produced
    /// it**:
    ///
    /// - a stop reply → the earliest request whose reply set includes stop replies
    ///   (a resume, or `?`, or `vAttach`/`vRun`);
    /// - anything else → the earliest request whose reply set includes non-stop
    ///   replies (everything except a bare resume).
    ///
    /// A two-way "is it a resume" split is *not* enough, which the tests caught:
    /// `?` is not a resume yet is answered by a stop reply, and `vAttach` may be
    /// answered either way. The classes are distinguishable because a stop reply's
    /// tag is uppercase (`S`/`T`/`W`/`X`) while hex memory data is lowercase, so
    /// no `m` reply can be mistaken for one.
    fn match_reply(&self, payload: &[u8]) -> Option<usize> {
        let is_stop = parse_stop_reply(payload).is_some();
        self.pending.iter().position(|p| match p.shape {
            Some(shape) => {
                if is_stop {
                    shape.stop
                } else {
                    shape.other
                }
            }
            // Ack-only entries never own a reply.
            None => false,
        })
    }

    // ── Outbound: the send gate ───────────────────────────────────────────────

    /// Queue an Agent request. Rejected here if the packet is one we may not send.
    pub fn submit(&mut self, id: ConsumerId, payload: Vec<u8>, timeout: Option<Duration>) -> Result<u64, RspError> {
        if self.closed {
            return Err(RspError::Closed);
        }
        if !self.tier.allows_anything() {
            return Err(RspError::Unsupported);
        }
        check_permitted(&payload)?;
        let seq = self.take_seq();
        self.queue.push_back(Queued {
            id,
            seq,
            payload,
            timeout,
        });
        Ok(seq)
    }

    /// Send whatever the gate now allows. Called after every inbound event; safe
    /// to call at any time.
    pub fn pump(&mut self) -> Vec<Action> {
        self.pump_at(Instant::now())
    }

    /// [`MuxCore::pump`] with an explicit clock, for tests and for callers that
    /// already have an `Instant` in hand.
    pub fn pump_at(&mut self, now: Instant) -> Vec<Action> {
        let mut actions = Vec::new();
        while self.may_send_agent_packet() {
            let Some(q) = self.queue.pop_front() else { break };
            let framed = encode_packet(&q.payload);
            self.pending.push_back(Pending {
                source: RspSource::Agent(q.id),
                seq: q.seq,
                sent: framed.clone(),
                // We are forbidden to send a resume, so nothing of ours can be
                // open-ended -- `check_permitted` is what guarantees that. `?` is
                // the one permitted packet answered by a stop reply.
                shape: Some(ReplyShape {
                    stop: q.payload.first() == Some(&b'?'),
                    other: q.payload.first() != Some(&b'?'),
                    open_ended: false,
                }),
                awaiting_ack: self.ack_mode() == AckMode::Acked,
                retransmits: 0,
                deadline: q.timeout.map(|t| now + t),
                sent_at: Some(now),
            });
            actions.extend(self.trace(Party::AgentToServer, &framed, Some(format!("c{}/s{}", q.id, q.seq))));
            actions.push(Action::ToServer(framed));
        }
        actions
    }

    /// The whole send policy, in one predicate (§4.2).
    fn may_send_agent_packet(&self) -> bool {
        !self.queue.is_empty() && self.agent_gate_open()
    }

    /// The send policy without "is there anything to send".
    ///
    /// Split out so a consumer can ask *before* spending a request. Everything below makes a
    /// submitted packet wait rather than fail, so a consumer that submits while the gate is shut
    /// gets a `Timeout` some seconds later — which for a poll loop is both slow and a misleading
    /// diagnosis. Asking first turns that into "not now", which is the truth.
    pub fn agent_gate_open(&self) -> bool {
        if self.closed {
            return false;
        }
        // §4.4: nothing of ours goes out until capabilities and ack mode have
        // settled and the target state is known. Costs nothing -- no consumer has
        // anything useful to do before the session is connected -- and removes a
        // whole class of startup race.
        if !self.handshake_settled() {
            return false;
        }
        // Invariant 2: GDB never waits on us. A half-received GDB packet counts:
        // injecting mid-packet would corrupt both.
        if self.gdb_codec.pending_len() > 0 {
            return false;
        }
        if self.pending.len() >= self.depth + self.open_ended_count() {
            return false;
        }
        // A stub `F` request must be answered by GDB before anything else.
        if self.file_io_outstanding {
            return false;
        }
        // And the one that decides whether this design works at all for a server.
        self.state().readable(self.tier.allows_while_running())
    }

    /// Requests whose reply may never come. They occupy a pending slot but must
    /// not consume the pipelining budget, or a single `c` would block us for as
    /// long as the program runs — which is precisely the interval we exist for.
    fn open_ended_count(&self) -> usize {
        self.pending.iter().filter(|p| p.open_ended()).count()
    }

    fn handshake_settled(&self) -> bool {
        // Ack mode is final once either no-ack is in force or the server never
        // offered it.
        let ack_settled = self.ack_mode() == AckMode::NoAck || (self.caps_known && !self.caps.no_ack_offered);
        self.caps_known && ack_settled && self.state() != TargetState::Unknown
    }

    // ── Timeouts and teardown ─────────────────────────────────────────────────

    /// Fail any of our requests whose deadline has passed. GDB's are never timed
    /// out here: an open-ended `c` has no deadline, and GDB runs its own.
    pub fn on_tick(&mut self, now: Instant) -> Vec<Action> {
        let mut actions = Vec::new();
        let mut i = 0;
        while i < self.pending.len() {
            let expired = self.pending[i].deadline.is_some_and(|d| now >= d);
            match (expired, self.pending[i].source) {
                (true, RspSource::Agent(id)) => {
                    let seq = self.pending[i].seq;
                    self.pending.remove(i);
                    actions.push(Action::Completed {
                        id,
                        seq,
                        result: Err(RspError::Timeout),
                    });
                }
                _ => i += 1,
            }
        }
        // A timed-out request freed a slot.
        actions.extend(self.pump_at(now));
        actions
    }

    /// The soonest deadline among our in-flight requests, so a driver can pick a
    /// wakeup instead of polling.
    pub fn next_deadline(&self) -> Option<Instant> {
        self.pending.iter().filter_map(|p| p.deadline).min()
    }

    /// The channel is gone. Fails everything outstanding so no consumer waits
    /// forever.
    pub fn close(&mut self, why: &'static str) -> Vec<Action> {
        self.closed = true;
        let mut actions = Vec::new();
        for p in self
            .pending
            .drain(..)
            .chain(std::mem::take(&mut self.queue).into_iter().map(|q| Pending {
                source: RspSource::Agent(q.id),
                seq: q.seq,
                sent: Vec::new(),
                shape: None,
                awaiting_ack: false,
                retransmits: 0,
                deadline: None,
                sent_at: None,
            }))
        {
            if let RspSource::Agent(id) = p.source {
                actions.push(Action::Completed {
                    id,
                    seq: p.seq,
                    result: Err(RspError::Closed),
                });
            }
        }
        actions.push(Action::Fatal(why));
        actions
    }

    fn take_seq(&mut self) -> u64 {
        let s = self.next_seq;
        self.next_seq += 1;
        s
    }
}

/// What replies a **client-to-server** packet can attract, or `None` when it
/// draws no reply at all.
///
/// `None` matters more than it looks: `R` (restart) and `k` (kill) are specified
/// to have no reply, so a pending entry for them would sit in the queue for ever
/// and — worse — could match a reply belonging to one of *our* requests, routing
/// target memory to GDB. Not tracking them is the safe choice; if such a packet
/// does draw a reply after all, `match_reply` finds no owner and the fallback
/// hands it to GDB, which is where it would have gone anyway.
fn classify_request(payload: &[u8]) -> Option<ReplyShape> {
    const RESUME: ReplyShape = ReplyShape {
        stop: true,
        other: false,
        open_ended: true,
    };
    /// `?`: always answered by a stop reply, but promptly -- the target's current
    /// state, not a wait for it to change. So it is not open-ended.
    const STOP_PROMPT: ReplyShape = ReplyShape {
        stop: true,
        other: false,
        open_ended: false,
    };
    /// `vAttach`/`vRun`: a stop reply if they halt, `OK` or `E nn` if they do not.
    /// Genuinely either, which is why a two-way split does not work.
    const STOP_OR_OTHER: ReplyShape = ReplyShape {
        stop: true,
        other: true,
        open_ended: false,
    };
    const ORDINARY: ReplyShape = ReplyShape {
        stop: false,
        other: true,
        open_ended: false,
    };

    let (&first, rest) = payload.split_first()?;
    Some(match first {
        b'c' | b's' if rest.iter().all(|b| b.is_ascii_hexdigit()) => RESUME,
        b'C' | b'S' if !rest.is_empty() => RESUME,
        b'?' => STOP_PROMPT,
        // No reply is specified for either of these.
        b'R' | b'k' => return None,
        b'v' => {
            if let Some(actions) = payload.strip_prefix(b"vCont;") {
                let resumes = actions
                    .split(|&b| b == b';')
                    .filter_map(|a| a.first())
                    .any(|&a| matches!(a, b'c' | b'C' | b's' | b'S'));
                if resumes {
                    RESUME
                } else {
                    ORDINARY
                }
            } else if payload.starts_with(b"vAttach") || payload.starts_with(b"vRun") {
                STOP_OR_OTHER
            } else {
                ORDINARY
            }
        }
        _ => ORDINARY,
    })
}

/// Does this reply look like the answer to `qSupported`?
///
/// Matched on content, because a reply carries no indication of its request. A
/// `qSupported` answer is a `;`-separated feature list, and `PacketSize=` is
/// present in every real one. A false negative costs us the capability data; a
/// false positive would overwrite it with nonsense, so the test is deliberately
/// narrow.
fn looks_like_q_supported_reply(payload: &[u8]) -> bool {
    payload.starts_with(b"PacketSize=") || payload.windows(12).any(|w| w == b";PacketSize=")
}

/// The forbidden-packet choke point (§4.5).
///
/// A **whitelist**, so a newly-added builder is denied until someone explicitly
/// allows it. That is the right default: the cost of wrongly denying is a
/// compile-and-test cycle, and the cost of wrongly allowing is a corrupted debug
/// session the user blames on the debugger.
pub fn check_permitted(payload: &[u8]) -> Result<(), RspError> {
    let Some(&first) = payload.first() else {
        return Err(RspError::Malformed("refusing to send an empty packet"));
    };
    match first {
        // Memory access: the primitive this whole design exists for.
        b'm' | b'M' | b'x' | b'X' => Ok(()),
        // Halt reason. Read-only, and how we learn the initial state.
        b'?' => Ok(()),
        // Register reads. Formally `Hg`-dependent, which we may not set, so these
        // read whatever GDB selected -- fine on a single-core MCU, and gated by
        // there being no builder for them yet (§4.5, deferred).
        b'g' | b'p' => Ok(()),
        // `qRcmd` (monitor) only. Every other `q`/`Q` either negotiates
        // connection state or is a windowed transfer GDB is midway through.
        b'q' if payload.starts_with(b"qRcmd,") => Ok(()),
        _ => Err(RspError::Malformed(forbidden_reason(payload))),
    }
}

/// Why a packet was refused. Static strings, and specific enough that a stack
/// trace is not needed to find the caller's mistake.
fn forbidden_reason(payload: &[u8]) -> &'static str {
    let first = payload.first().copied().unwrap_or(0);
    match first {
        b'c' | b'C' | b's' | b'S' | b'R' => "execution control belongs to GDB, never to the Agent",
        b'k' | b'D' => "the Agent may not kill or detach the session",
        b'Z' | b'z' => "breakpoints are per-core state owned by GDB",
        b'H' => "thread selection is connection state GDB depends on",
        b'G' | b'P' => "register writes are not permitted",
        b'v' => "vCont/vRun/vAttach/vKill are execution control; other v-packets are GDB's",
        b'Q' => "connection-mode packets (QNonStop, QStartNoAckMode) are GDB's to negotiate",
        b'q' => "only qRcmd is permitted; qSupported and qXfer are GDB's",
        0x03 => "an interrupt is not a packet and the Agent must never send one",
        _ => "packet is not on the Agent's permitted list",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gdb_rsp::caps::MemoryReadKind;
    use crate::gdb_rsp::packet;

    /// Frame a payload the way a peer would.
    fn p(payload: &[u8]) -> Vec<u8> {
        encode_packet(payload)
    }

    /// Collect every `ToServer` byte sequence from a set of actions.
    fn to_server(actions: &[Action]) -> Vec<Vec<u8>> {
        actions
            .iter()
            .filter_map(|a| match a {
                Action::ToServer(b) => Some(b.clone()),
                _ => None,
            })
            .collect()
    }

    fn to_gdb(actions: &[Action]) -> Vec<Vec<u8>> {
        actions
            .iter()
            .filter_map(|a| match a {
                Action::ToGdb(b) => Some(b.clone()),
                _ => None,
            })
            .collect()
    }

    fn completions(actions: &[Action]) -> Vec<(ConsumerId, Result<Vec<u8>, RspError>)> {
        actions
            .iter()
            .filter_map(|a| match a {
                Action::Completed { id, result, .. } => Some((*id, result.clone())),
                _ => None,
            })
            .collect()
    }

    const Q_SUPPORTED_REPLY: &[u8] = b"PacketSize=4000;QStartNoAckMode+;vContSupported+";

    /// Drive a mux through the startup handshake so the gate is open, exactly as
    /// a real session would: GDB negotiates, no-ack engages, target reports halted.
    fn handshaken(tier: ServerTier) -> MuxCore {
        let mut m = MuxCore::new(tier);
        m.on_gdb_bytes(&p(b"qSupported:multiprocess+"));
        m.on_server_bytes(&p(Q_SUPPORTED_REPLY));
        // GDB acks the reply.
        m.on_gdb_bytes(b"+");
        m.on_gdb_bytes(&p(b"QStartNoAckMode"));
        m.on_server_bytes(b"+");
        m.on_server_bytes(&p(b"OK"));
        m.on_gdb_bytes(&p(b"?"));
        m.on_server_bytes(&p(b"T05thread:01;"));
        m
    }

    // ── Verbatim forwarding (§2 invariant 1, design item 12) ──────────────────

    #[test]
    fn with_no_consumers_the_byte_streams_are_reproduced_exactly() {
        // The mux must be invisible when nothing of ours is attached. This is the
        // gate before any consumer work: if it does not hold, nothing else matters.
        let gdb_side: Vec<u8> = [
            &p(b"qSupported:multiprocess+")[..],
            b"+",
            &p(b"QStartNoAckMode"),
            &p(b"?"),
            &p(b"Hg0"),
            &p(b"m20000000,10"),
            b"\x03",
            &p(b"vCont;c"),
            &p(b"Z0,20000000,2"),
        ]
        .concat();
        let server_side: Vec<u8> = [
            b"+",
            &p(Q_SUPPORTED_REPLY)[..],
            b"+",
            &p(b"OK"),
            &p(b"T05thread:01;"),
            &p(b"OK"),
            &p(b"00112233445566778899aabbccddeeff"),
            &p(b"O48656c6c6f"),
            &p(b"T02"),
        ]
        .concat();

        let mut m = MuxCore::new(ServerTier::Full);
        let mut forwarded_to_server = Vec::new();
        let mut forwarded_to_gdb = Vec::new();
        // Feed both directions a byte at a time, interleaved, which is the worst
        // case for framing and ordering.
        let mut gi = 0;
        let mut si = 0;
        while gi < gdb_side.len() || si < server_side.len() {
            if gi < gdb_side.len() {
                let acts = m.on_gdb_bytes(&gdb_side[gi..gi + 1]);
                for b in to_server(&acts) {
                    forwarded_to_server.extend_from_slice(&b);
                }
                for b in to_gdb(&acts) {
                    forwarded_to_gdb.extend_from_slice(&b);
                }
                gi += 1;
            }
            if si < server_side.len() {
                let acts = m.on_server_bytes(&server_side[si..si + 1]);
                for b in to_server(&acts) {
                    forwarded_to_server.extend_from_slice(&b);
                }
                for b in to_gdb(&acts) {
                    forwarded_to_gdb.extend_from_slice(&b);
                }
                si += 1;
            }
        }
        assert_eq!(forwarded_to_server, gdb_side, "client->server stream altered");
        assert_eq!(forwarded_to_gdb, server_side, "server->client stream altered");
    }

    /// GDB's real opening sequence, transcribed from a captured OpenOCD session on a
    /// dual-core PSoC 6 (`rsp-trace-gdbPort1`, 2026-09-20). Kept verbatim rather than
    /// abbreviated, because the abbreviation is what the other tests already cover and it
    /// misses every interesting shape here:
    ///
    /// - GDB's actual `qSupported` is **190 bytes** with twelve features, not the 37-byte
    ///   one used elsewhere in this file.
    /// - `vMustReplyEmpty` and `qTStatus` are answered with an **empty packet**, `$#00` —
    ///   a `$` immediately followed by `#`, which is the one packet shape with no payload
    ///   at all. Split between the `$` and the `#` it is the likeliest single cause of a
    ///   handshake desync, and no other test contains one.
    /// - `qXfer:features:read` returns **kilobytes in one packet**, an order of magnitude
    ///   larger than anything else tested, and it arrives split across several reads.
    fn real_handshake() -> (Vec<u8>, Vec<u8>) {
        // A target description of the real size (~3.4 KB), built rather than pasted.
        let mut xml = String::from(
            "l<?xml version=\"1.0\"?>\n<!DOCTYPE target SYSTEM \"gdb-target.dtd\">\n             <target version=\"1.0\">\n<architecture>arm</architecture>\n             <feature name=\"org.gnu.gdb.arm.m-profile\">\n",
        );
        for n in 0..16 {
            xml.push_str(&format!(
                "<reg name=\"r{n}\" bitsize=\"32\" regnum=\"{n}\" save-restore=\"yes\"                  type=\"int\" group=\"general\"/>\n"
            ));
        }
        xml.push_str("</feature>\n</target>\n");

        let gdb_side: Vec<u8> = [
            &p(b"qSupported:multiprocess+;swbreak+;hwbreak+;qRelocInsn+;fork-events+;vfork-events+;                 exec-events+;vContSupported+;QThreadEvents+;QThreadOptions+;no-resumed+;memory-tagging+")[..],
            b"+", // still in ack mode: GDB acks each reply until no-ack engages
            &p(b"vCont?"),
            b"+",
            &p(b"vMustReplyEmpty"),
            b"+",
            &p(b"QStartNoAckMode"),
            b"+", // the stray ack: GDB acks the `OK` and only then stops acking
            &p(b"!"),
            &p(b"Hg0"),
            &p(b"qXfer:features:read:target.xml:0,1000"),
            &p(b"qTStatus"),
            &p(b"?"),
            &p(b"qXfer:threads:read::0,1000"),
            &p(b"qAttached"),
        ]
        .concat();

        let server_side: Vec<u8> = [
            b"+",
            &p(b"PacketSize=4000;qXfer:memory-map:read+;qXfer:features:read+;qXfer:threads:read+;                 QStartNoAckMode+;vContSupported+")[..],
            b"+",
            &p(b"vCont;c;C;s;S"),
            b"+",
            &p(b""), // vMustReplyEmpty -> $#00
            b"+",
            &p(b"OK"), // QStartNoAckMode
            &p(b"OK"), // !
            &p(b"OK"), // Hg0
            &p(xml.as_bytes()),
            &p(b""), // qTStatus -> $#00 again
            &p(b"T02thread:1;"),
            &p(b"l<?xml version=\"1.0\"?>\n<threads>\n<thread id=\"1\">Name: Current Execution</thread>\n</threads>\n"),
            &p(b"1"),
        ]
        .concat();

        (gdb_side, server_side)
    }

    /// Feed a captured session through `chunks` and require both directions to come out
    /// byte-identical. `label` names the chunking so a failure says which one broke it.
    fn assert_passthrough(gdb_side: &[u8], server_side: &[u8], chunks: &[usize], label: &str) {
        let mut m = MuxCore::new(ServerTier::Full);
        let mut to_srv = Vec::new();
        let mut to_gdb_out = Vec::new();
        let (mut gi, mut si, mut ci) = (0usize, 0usize, 0usize);
        while gi < gdb_side.len() || si < server_side.len() {
            let n = chunks[ci % chunks.len()].max(1);
            ci += 1;
            if gi < gdb_side.len() {
                let end = (gi + n).min(gdb_side.len());
                let acts = m.on_gdb_bytes(&gdb_side[gi..end]);
                for b in to_server(&acts) {
                    to_srv.extend_from_slice(&b);
                }
                for b in to_gdb(&acts) {
                    to_gdb_out.extend_from_slice(&b);
                }
                gi = end;
            }
            if si < server_side.len() {
                let end = (si + n).min(server_side.len());
                let acts = m.on_server_bytes(&server_side[si..end]);
                for b in to_server(&acts) {
                    to_srv.extend_from_slice(&b);
                }
                for b in to_gdb(&acts) {
                    to_gdb_out.extend_from_slice(&b);
                }
                si = end;
            }
        }
        assert_eq!(
            String::from_utf8_lossy(&to_srv),
            String::from_utf8_lossy(gdb_side),
            "client->server stream altered ({label})"
        );
        assert_eq!(
            String::from_utf8_lossy(&to_gdb_out),
            String::from_utf8_lossy(server_side),
            "server->client stream altered ({label})"
        );
    }

    #[test]
    fn a_real_captured_handshake_passes_through_under_any_chunking() {
        // Motivated by a one-off field failure: GDB rejected the `qSupported` exchange
        // once and could not be made to do it again. An intermittent fault at the first
        // packet is what a read-boundary bug looks like, so this pins the boundary
        // behaviour on the real bytes instead of on a shortened stand-in.
        let (gdb_side, server_side) = real_handshake();
        assert_passthrough(&gdb_side, &server_side, &[usize::MAX], "whole");
        assert_passthrough(&gdb_side, &server_side, &[1], "byte at a time");
        // Chunk sizes that land mid-trailer, mid-header and mid-payload in turn, plus
        // sizes near a real TCP segment.
        for chunks in [
            &[2usize][..],
            &[3],
            &[7],
            &[64],
            &[1460],
            &[1, 2, 3, 5, 8, 13, 21],
            &[511, 1, 513],
        ] {
            assert_passthrough(&gdb_side, &server_side, chunks, &format!("{chunks:?}"));
        }
        // And exhaustively, one split point at a time across the whole GDB stream.
        for split in 0..=gdb_side.len() {
            assert_passthrough(&gdb_side, &server_side, &[split.max(1)], &format!("split {split}"));
        }
    }

    #[test]
    fn an_empty_packet_survives_a_split_between_the_dollar_and_the_hash() {
        // `$#00` is what OpenOCD answers `vMustReplyEmpty` and `qTStatus` with, twice
        // during every handshake. It is the only packet with no payload, so it is the
        // only one where the codec moves straight from "header" to "trailer" -- and GDB
        // treats an unexpected reply to `vMustReplyEmpty` as a protocol failure, which is
        // exactly the class of message a handshake failure would produce.
        let empty = p(b"");
        assert_eq!(empty, b"$#00".to_vec(), "an empty packet is $ then # then 00");
        for split in 0..=empty.len() {
            let mut m = MuxCore::new(ServerTier::Full);
            m.on_gdb_bytes(&p(b"vMustReplyEmpty"));
            let mut got = Vec::new();
            for acts in [m.on_server_bytes(&empty[..split]), m.on_server_bytes(&empty[split..])] {
                for b in to_gdb(&acts) {
                    got.extend_from_slice(&b);
                }
            }
            assert_eq!(got, empty, "empty packet altered when split at {split}");
        }
    }

    #[test]
    fn run_length_encoded_replies_reach_gdb_unexpanded() {
        // Re-encoding is never correct: RLE and escaping are not uniquely
        // determined by the bytes they represent, so a round trip would change
        // the stream even when it decoded correctly.
        let mut m = MuxCore::new(ServerTier::Full);
        let rle: &[u8] = b"$0* #b0";
        let acts = m.on_server_bytes(rle);
        assert_eq!(to_gdb(&acts).concat(), rle);
    }

    // ── Routing (§4.1) ────────────────────────────────────────────────────────

    #[test]
    fn an_agent_reply_never_reaches_gdb() {
        let mut m = handshaken(ServerTier::Full);
        let acts = m
            .submit(7, packet::mem_read(0x2000_0000, 4, MemoryReadKind::Hex), None)
            .map(|_| m.pump());
        let sent = to_server(&acts.unwrap());
        assert_eq!(sent, vec![p(b"m20000000,4")]);

        let acts = m.on_server_bytes(&p(b"deadbeef"));
        assert!(to_gdb(&acts).is_empty(), "our reply leaked to GDB");
        assert_eq!(completions(&acts), vec![(7, Ok(b"deadbeef".to_vec()))]);
    }

    #[test]
    fn a_reply_to_gdbs_request_is_not_taken_by_a_consumer() {
        let mut m = handshaken(ServerTier::Full);
        m.on_gdb_bytes(&p(b"m20000000,4"));
        let acts = m.on_server_bytes(&p(b"deadbeef"));
        assert_eq!(to_gdb(&acts), vec![p(b"deadbeef")]);
        assert!(completions(&acts).is_empty());
    }

    #[test]
    fn our_reply_arrives_before_gdbs_open_ended_continue_completes() {
        // THE case the whole design depends on. GDB continues; the target runs for
        // a long time; we read memory meanwhile. Our reply comes back first, so
        // strict FIFO matching would hand it to GDB as its stop reply and hand the
        // real stop reply to us.
        let mut m = handshaken(ServerTier::Full);
        m.on_gdb_bytes(&p(b"vCont;c"));
        assert_eq!(m.state(), TargetState::Running);

        m.submit(1, packet::mem_read(0x2000_0000, 4, MemoryReadKind::Hex), None)
            .unwrap();
        let sent = to_server(&m.pump());
        assert_eq!(
            sent,
            vec![p(b"m20000000,4")],
            "gate blocked a read while running on a Full server"
        );

        // Our reply, while GDB's `c` is still outstanding.
        let acts = m.on_server_bytes(&p(b"aabbccdd"));
        assert_eq!(completions(&acts), vec![(1, Ok(b"aabbccdd".to_vec()))]);
        assert!(to_gdb(&acts).is_empty(), "our memory reply was sent to GDB");
        assert_eq!(
            m.state(),
            TargetState::Running,
            "a memory reply must not look like a stop"
        );

        // Much later, the target stops. That reply is GDB's.
        let acts = m.on_server_bytes(&p(b"T05thread:01;"));
        assert_eq!(to_gdb(&acts), vec![p(b"T05thread:01;")]);
        assert!(completions(&acts).is_empty());
        assert_eq!(m.state(), TargetState::Stopped);
    }

    #[test]
    fn an_open_ended_request_does_not_consume_the_pipelining_budget() {
        // Depth 1 with a `c` outstanding must still allow one of our reads, or a
        // single continue would block us for the entire run.
        let mut m = handshaken(ServerTier::Full);
        m.on_gdb_bytes(&p(b"vCont;c"));
        assert_eq!(m.in_flight(), 1);
        m.submit(1, packet::mem_read(0, 4, MemoryReadKind::Hex), None).unwrap();
        assert_eq!(to_server(&m.pump()).len(), 1);
        assert_eq!(m.in_flight(), 2);
        // But a second read is held: depth is 1.
        m.submit(1, packet::mem_read(4, 4, MemoryReadKind::Hex), None).unwrap();
        assert!(to_server(&m.pump()).is_empty());
        assert_eq!(m.queued(), 1);
    }

    #[test]
    fn console_output_during_a_continue_is_not_treated_as_a_reply() {
        let mut m = handshaken(ServerTier::Full);
        m.on_gdb_bytes(&p(b"vCont;c"));
        let before = m.in_flight();
        let acts = m.on_server_bytes(&p(b"O48656c6c6f"));
        assert_eq!(m.in_flight(), before, "an O packet retired a pending request");
        assert_eq!(to_gdb(&acts), vec![p(b"O48656c6c6f")]);
    }

    // ── Ack accounting (§4.3) ─────────────────────────────────────────────────

    #[test]
    fn the_servers_ack_for_our_packet_is_swallowed() {
        // Forwarding it would give GDB an ack it never earned, and GDB counts.
        let mut m = MuxCore::new(ServerTier::Full);
        // Handshake without engaging no-ack, so we stay in ack mode.
        m.on_gdb_bytes(&p(b"qSupported:"));
        m.on_server_bytes(&p(b"PacketSize=1000")); // no QStartNoAckMode offered
        m.on_gdb_bytes(&p(b"?"));
        m.on_server_bytes(&p(b"T05"));
        assert_eq!(m.ack_mode(), AckMode::Acked);

        m.submit(3, packet::mem_read(0, 4, MemoryReadKind::Hex), None).unwrap();
        m.pump();
        let acts = m.on_server_bytes(b"+");
        assert!(to_gdb(&acts).is_empty(), "the server's ack for our packet reached GDB");
    }

    #[test]
    fn the_servers_ack_for_gdbs_packet_is_forwarded() {
        let mut m = MuxCore::new(ServerTier::Full);
        m.on_gdb_bytes(&p(b"qSupported:"));
        let acts = m.on_server_bytes(b"+");
        assert_eq!(to_gdb(&acts), vec![b"+".to_vec()]);
    }

    #[test]
    fn we_ack_a_reply_that_was_ours_because_gdb_never_saw_it() {
        // The server is waiting for an ack for that reply and will retransmit
        // without one.
        let mut m = MuxCore::new(ServerTier::Full);
        m.on_gdb_bytes(&p(b"qSupported:"));
        m.on_server_bytes(&p(b"PacketSize=1000"));
        m.on_gdb_bytes(&p(b"?"));
        m.on_server_bytes(&p(b"T05"));
        m.submit(3, packet::mem_read(0, 4, MemoryReadKind::Hex), None).unwrap();
        m.pump();
        m.on_server_bytes(b"+");
        let acts = m.on_server_bytes(&p(b"aabbccdd"));
        assert!(
            to_server(&acts).contains(&b"+".to_vec()),
            "we did not ack a reply we consumed"
        );
    }

    #[test]
    fn no_ack_mode_engages_exactly_at_the_ok_that_answers_it() {
        let mut m = MuxCore::new(ServerTier::Full);
        m.on_gdb_bytes(&p(b"qSupported:"));
        m.on_server_bytes(&p(Q_SUPPORTED_REPLY));
        m.on_gdb_bytes(b"+");
        m.on_gdb_bytes(&p(b"QStartNoAckMode"));
        assert_eq!(m.ack_mode(), AckMode::Acked, "switched before the server agreed");
        m.on_server_bytes(b"+");
        assert_eq!(m.ack_mode(), AckMode::Acked, "switched on the ack rather than the OK");
        let acts = m.on_server_bytes(&p(b"OK"));
        assert_eq!(m.ack_mode(), AckMode::NoAck);
        assert!(acts.contains(&Action::NoAckEngaged));
        // And the OK still reaches GDB.
        assert_eq!(to_gdb(&acts), vec![p(b"OK")]);
    }

    #[test]
    fn the_one_stray_ack_after_no_ack_engages_is_forwarded_and_desynchronises_nothing() {
        // The real sequence, which a hand-written handshake is apt to omit:
        //   GDB  -> $QStartNoAckMode
        //   srv  -> +            (still in ack mode)
        //   srv  -> $OK          (server switches to no-ack here)
        //   GDB  -> +            (acks that OK -- GDB switches only AFTER this)
        // So exactly one `+` arrives once we already consider the link no-ack. It
        // must pass through to the server, which ignores it (OpenOCD logs it once at
        // debug and warns on any further one), and it must not be mistaken for an
        // ack belonging to some later packet.
        let mut m = MuxCore::new(ServerTier::Full);
        m.on_gdb_bytes(&p(b"qSupported:"));
        m.on_server_bytes(&p(Q_SUPPORTED_REPLY));
        m.on_gdb_bytes(b"+");
        m.on_gdb_bytes(&p(b"QStartNoAckMode"));
        m.on_server_bytes(b"+");
        let acts = m.on_server_bytes(&p(b"OK"));
        assert!(acts.contains(&Action::NoAckEngaged));
        assert_eq!(m.ack_mode(), AckMode::NoAck);

        // GDB's trailing ack for the OK. Forwarded verbatim, creates no pending entry.
        let before = m.in_flight();
        let acts = m.on_gdb_bytes(b"+");
        assert_eq!(to_server(&acts), vec![b"+".to_vec()], "the stray ack was not forwarded");
        assert_eq!(m.in_flight(), before, "the stray ack created a pending entry");

        // And the link still works: the next exchange must not be off by one.
        m.on_gdb_bytes(&p(b"?"));
        let acts = m.on_server_bytes(&p(b"T05"));
        assert_eq!(to_gdb(&acts), vec![p(b"T05")]);
        assert_eq!(m.state(), TargetState::Stopped);

        // Including one of ours, which is what would break if the stray ack had been
        // charged against a later packet.
        m.submit(1, packet::mem_read(0, 4, MemoryReadKind::Hex), None).unwrap();
        assert_eq!(to_server(&m.pump()), vec![p(b"m0,4")]);
        let acts = m.on_server_bytes(&p(b"deadbeef"));
        assert_eq!(completions(&acts), vec![(1, Ok(b"deadbeef".to_vec()))]);
    }

    #[test]
    fn in_no_ack_mode_we_neither_send_nor_expect_acks() {
        let mut m = handshaken(ServerTier::Full);
        assert_eq!(m.ack_mode(), AckMode::NoAck);
        m.submit(1, packet::mem_read(0, 4, MemoryReadKind::Hex), None).unwrap();
        m.pump();
        let acts = m.on_server_bytes(&p(b"aabbccdd"));
        assert!(
            !to_server(&acts).contains(&b"+".to_vec()),
            "sent an ack in no-ack mode; OpenOCD logs this as 'acknowledgment received, but no packet pending'"
        );
    }

    #[test]
    fn a_nack_for_our_packet_retransmits_then_gives_up() {
        let mut m = MuxCore::new(ServerTier::Full);
        m.on_gdb_bytes(&p(b"qSupported:"));
        m.on_server_bytes(&p(b"PacketSize=1000"));
        m.on_gdb_bytes(&p(b"?"));
        m.on_server_bytes(&p(b"T05"));
        m.submit(9, packet::mem_read(0, 4, MemoryReadKind::Hex), None).unwrap();
        m.pump();
        for _ in 0..MAX_RETRANSMITS {
            let acts = m.on_server_bytes(b"-");
            assert_eq!(to_server(&acts), vec![p(b"m0,4")], "did not resend on a nack");
            assert!(to_gdb(&acts).is_empty(), "our nack reached GDB");
        }
        let acts = m.on_server_bytes(b"-");
        assert!(matches!(
            completions(&acts).as_slice(),
            [(9, Err(RspError::Malformed(_)))]
        ));
    }

    #[test]
    fn a_nack_for_gdbs_packet_is_forwarded_for_gdb_to_handle() {
        let mut m = MuxCore::new(ServerTier::Full);
        m.on_gdb_bytes(&p(b"qSupported:"));
        let acts = m.on_server_bytes(b"-");
        assert_eq!(to_gdb(&acts), vec![b"-".to_vec()]);
    }

    // ── The send gate (§4.2, §4.4) ────────────────────────────────────────────

    #[test]
    fn nothing_is_sent_before_the_handshake_settles() {
        let mut m = MuxCore::new(ServerTier::Full);
        m.submit(1, packet::mem_read(0, 4, MemoryReadKind::Hex), None).unwrap();
        assert!(to_server(&m.pump()).is_empty(), "sent before capabilities were known");

        m.on_gdb_bytes(&p(b"qSupported:"));
        m.on_server_bytes(&p(Q_SUPPORTED_REPLY));
        // Caps known, but the server offered no-ack and it has not engaged, and
        // the target state is still unknown.
        assert!(to_server(&m.pump()).is_empty(), "sent before ack mode settled");

        m.on_gdb_bytes(&p(b"QStartNoAckMode"));
        m.on_server_bytes(b"+");
        m.on_server_bytes(&p(b"OK"));
        assert!(
            to_server(&m.pump()).is_empty(),
            "sent before the target state was known"
        );

        let acts = m.on_server_bytes(&p(b"T05"));
        assert_eq!(to_server(&acts), vec![p(b"m0,4")], "gate never opened");
    }

    #[test]
    fn nothing_is_sent_while_a_gdb_packet_is_half_received() {
        // Injecting between two halves of a GDB packet would corrupt both. This is
        // why forwarding happens on frame boundaries.
        let mut m = handshaken(ServerTier::Full);
        let gdb_pkt = p(b"m20000000,10");
        let split = gdb_pkt.len() / 2;
        m.on_gdb_bytes(&gdb_pkt[..split]);
        m.submit(1, packet::mem_read(0, 4, MemoryReadKind::Hex), None).unwrap();
        assert!(
            to_server(&m.pump()).is_empty(),
            "injected into a half-received GDB packet"
        );
        // Once GDB's packet is whole it is forwarded -- and ours still waits, because
        // GDB's request now occupies the depth-1 budget. A prompt request of GDB's
        // counts against the budget; only open-ended ones are exempt.
        let acts = m.on_gdb_bytes(&gdb_pkt[split..]);
        assert_eq!(to_server(&acts), vec![gdb_pkt], "GDB's packet must go out, and alone");
        assert_eq!(m.queued(), 1, "ours should still be waiting behind GDB's request");

        // GDB's reply frees the slot; ours goes out then.
        let acts = m.on_server_bytes(&p(b"00112233445566778899aabbccddeeff"));
        assert_eq!(to_server(&acts), vec![p(b"m0,4")]);
    }

    #[test]
    fn a_halted_only_server_blocks_reads_while_running() {
        let mut m = handshaken(ServerTier::HaltedOnly);
        m.submit(1, packet::mem_read(0, 4, MemoryReadKind::Hex), None).unwrap();
        // Halted: allowed.
        assert_eq!(to_server(&m.pump()), vec![p(b"m0,4")]);
        m.on_server_bytes(&p(b"aabbccdd"));

        m.on_gdb_bytes(&p(b"vCont;c"));
        m.submit(1, packet::mem_read(0, 4, MemoryReadKind::Hex), None).unwrap();
        assert!(
            to_server(&m.pump()).is_empty(),
            "read issued while running on a HaltedOnly server"
        );
        // And it is not lost -- it goes out when the target halts again.
        let acts = m.on_server_bytes(&p(b"T05"));
        assert_eq!(to_server(&acts), vec![p(b"m0,4")]);
    }

    #[test]
    fn an_unknown_tier_is_gated_as_halted_only() {
        let mut m = handshaken(ServerTier::Unknown);
        m.on_gdb_bytes(&p(b"vCont;c"));
        m.submit(1, packet::mem_read(0, 4, MemoryReadKind::Hex), None).unwrap();
        assert!(to_server(&m.pump()).is_empty());
    }

    #[test]
    fn an_unsupported_server_refuses_submissions_outright() {
        let mut m = handshaken(ServerTier::Unsupported);
        assert!(matches!(
            m.submit(1, packet::mem_read(0, 4, MemoryReadKind::Hex), None),
            Err(RspError::Unsupported)
        ));
    }

    #[test]
    fn nothing_is_sent_while_gdb_owes_the_stub_a_file_io_reply() {
        let mut m = handshaken(ServerTier::Full);
        m.on_gdb_bytes(&p(b"vCont;c"));
        m.on_server_bytes(&p(b"Fopen,1234/0,0,1b6"));
        m.submit(1, packet::mem_read(0, 4, MemoryReadKind::Hex), None).unwrap();
        assert!(
            to_server(&m.pump()).is_empty(),
            "injected between an F request and its reply"
        );
    }

    #[test]
    fn depth_above_one_requires_no_ack_mode() {
        let mut m = MuxCore::new(ServerTier::Full);
        assert_eq!(m.depth(), DEFAULT_DEPTH);
        assert_eq!(m.depth(), 1, "the default must be 1, per the §4.2.1 findings");
        assert!(m.set_depth(2).is_err(), "allowed pipelining in ack mode");

        let mut m = handshaken(ServerTier::Full);
        assert_eq!(m.ack_mode(), AckMode::NoAck);
        assert!(m.set_depth(2).is_ok());
        assert_eq!(m.depth(), 2);
    }

    #[test]
    fn depth_two_allows_a_second_outstanding_request() {
        let mut m = handshaken(ServerTier::Full);
        m.set_depth(2).unwrap();
        m.submit(1, packet::mem_read(0, 4, MemoryReadKind::Hex), None).unwrap();
        m.submit(1, packet::mem_read(4, 4, MemoryReadKind::Hex), None).unwrap();
        m.submit(1, packet::mem_read(8, 4, MemoryReadKind::Hex), None).unwrap();
        let sent = to_server(&m.pump());
        assert_eq!(sent, vec![p(b"m0,4"), p(b"m4,4")], "depth 2 should send exactly two");
        assert_eq!(m.queued(), 1);
    }

    #[test]
    fn replies_at_depth_two_complete_the_right_consumers_in_order() {
        let mut m = handshaken(ServerTier::Full);
        m.set_depth(2).unwrap();
        m.submit(11, packet::mem_read(0, 1, MemoryReadKind::Hex), None).unwrap();
        m.submit(22, packet::mem_read(1, 1, MemoryReadKind::Hex), None).unwrap();
        m.pump();
        let a = m.on_server_bytes(&p(b"aa"));
        assert_eq!(completions(&a), vec![(11, Ok(b"aa".to_vec()))]);
        let b = m.on_server_bytes(&p(b"bb"));
        assert_eq!(completions(&b), vec![(22, Ok(b"bb".to_vec()))]);
    }

    // ── Forbidden packets (§4.5) ──────────────────────────────────────────────

    #[test]
    fn permitted_packets_pass_the_choke_point() {
        for ok in [
            &b"m20000000,4"[..],
            b"M20000000,1:00",
            b"x20000000,4",
            b"X20000000,1:\x00",
            b"?",
            b"qRcmd,7265736574",
            b"g",
            b"p10",
        ] {
            assert!(
                check_permitted(ok).is_ok(),
                "should be permitted: {}",
                String::from_utf8_lossy(ok)
            );
        }
    }

    #[test]
    fn every_forbidden_packet_is_refused() {
        // The list from §4.5. A whitelist means anything not named here is also
        // refused, which is the point.
        for bad in [
            &b"c"[..],
            b"c20000000",
            b"C05",
            b"s",
            b"S05",
            b"vCont;c",
            b"vCont;s:1",
            b"vCont?",
            b"vRun;",
            b"vAttach;1",
            b"vKill;1",
            b"vCtrlC",
            b"R00",
            b"k",
            b"D",
            b"Z0,20000000,2",
            b"z0,20000000,2",
            b"Hg0",
            b"Hc-1",
            b"G0011",
            b"P10=00000000",
            b"QNonStop:1",
            b"QStartNoAckMode",
            b"qSupported:multiprocess+",
            b"qXfer:memory-map:read::0,100",
            b"",
        ] {
            assert!(
                check_permitted(bad).is_err(),
                "should be forbidden: {}",
                String::from_utf8_lossy(bad)
            );
        }
    }

    #[test]
    fn submit_rejects_a_forbidden_packet_before_it_can_be_queued() {
        let mut m = handshaken(ServerTier::Full);
        assert!(m.submit(1, b"c".to_vec(), None).is_err());
        assert_eq!(m.queued(), 0, "a forbidden packet was queued");
        assert!(to_server(&m.pump()).is_empty());
    }

    #[test]
    fn gdb_may_send_everything_we_may_not() {
        // The choke point constrains us, never GDB. Its packets are forwarded
        // untouched, including all the ones forbidden to us.
        let mut m = handshaken(ServerTier::Full);
        for pkt in [&b"Z0,20000000,2"[..], b"Hg0", b"G0011", b"QNonStop:1", b"k"] {
            let acts = m.on_gdb_bytes(&p(pkt));
            assert_eq!(
                to_server(&acts),
                vec![p(pkt)],
                "GDB's {:?} was not forwarded",
                String::from_utf8_lossy(pkt)
            );
        }
    }

    // ── Capabilities and state ────────────────────────────────────────────────

    #[test]
    fn capabilities_are_learned_from_gdbs_exchange_without_probing() {
        let mut m = MuxCore::new(ServerTier::Full);
        m.on_gdb_bytes(&p(b"qSupported:multiprocess+"));
        let acts = m.on_server_bytes(&p(Q_SUPPORTED_REPLY));
        assert!(acts.contains(&Action::CapsLearned));
        assert_eq!(m.caps().packet_size(), 0x4000);
        assert!(m.caps().no_ack_offered);
        // Nothing of ours went out to discover this.
        assert!(to_server(&acts).is_empty());
    }

    #[test]
    fn a_memory_reply_is_not_mistaken_for_a_capability_reply() {
        let mut m = handshaken(ServerTier::Full);
        let before = m.caps().packet_size();
        m.on_gdb_bytes(&p(b"m0,8"));
        m.on_server_bytes(&p(b"5061636b657453"));
        assert_eq!(m.caps().packet_size(), before, "caps overwritten by memory data");
    }

    #[test]
    fn state_changes_are_reported_once_each() {
        let mut m = handshaken(ServerTier::Full);
        let acts = m.on_gdb_bytes(&p(b"vCont;c"));
        assert!(acts.contains(&Action::StateChanged(TargetState::Running)));
        let acts = m.on_gdb_bytes(&p(b"m0,4"));
        assert!(!acts.iter().any(|a| matches!(a, Action::StateChanged(_))));
    }

    // ── Timeouts and teardown ─────────────────────────────────────────────────

    #[test]
    fn our_requests_time_out_and_free_their_slot() {
        let mut m = handshaken(ServerTier::Full);
        let t0 = Instant::now();
        m.submit(
            5,
            packet::mem_read(0, 4, MemoryReadKind::Hex),
            Some(Duration::from_millis(100)),
        )
        .unwrap();
        m.pump_at(t0);
        assert_eq!(m.in_flight(), 1);

        assert!(m.on_tick(t0 + Duration::from_millis(50)).is_empty(), "timed out early");
        let acts = m.on_tick(t0 + Duration::from_millis(150));
        assert_eq!(completions(&acts), vec![(5, Err(RspError::Timeout))]);
        assert_eq!(m.in_flight(), 0, "a timed-out request kept its slot");
    }

    #[test]
    fn gdbs_open_ended_continue_never_times_out() {
        // A `c` may legitimately have no reply for hours. Timing it out would
        // desynchronise us from GDB, which is still waiting.
        let mut m = handshaken(ServerTier::Full);
        m.on_gdb_bytes(&p(b"vCont;c"));
        let acts = m.on_tick(Instant::now() + Duration::from_secs(3600));
        assert!(completions(&acts).is_empty());
        assert_eq!(m.in_flight(), 1);
    }

    #[test]
    fn closing_fails_everything_outstanding_so_nobody_waits_forever() {
        let mut m = handshaken(ServerTier::Full);
        m.submit(1, packet::mem_read(0, 4, MemoryReadKind::Hex), None).unwrap();
        m.pump();
        m.submit(2, packet::mem_read(4, 4, MemoryReadKind::Hex), None).unwrap(); // still queued
        let acts = m.close("socket closed");
        let done = completions(&acts);
        assert_eq!(done.len(), 2, "not every consumer was told: {done:?}");
        assert!(done.iter().all(|(_, r)| matches!(r, Err(RspError::Closed))));
        assert!(acts.contains(&Action::Fatal("socket closed")));
        // And nothing more is accepted.
        assert!(matches!(m.submit(3, b"?".to_vec(), None), Err(RspError::Closed)));
    }

    #[test]
    fn gdb_disconnect_drops_gdbs_pending_work_but_not_ours() {
        let mut m = handshaken(ServerTier::Full);
        m.on_gdb_bytes(&p(b"vCont;c"));
        m.submit(1, packet::mem_read(0, 4, MemoryReadKind::Hex), None).unwrap();
        m.pump();
        assert_eq!(m.in_flight(), 2);
        m.gdb_disconnected();
        assert_eq!(m.in_flight(), 1, "GDB's pending request survived its disconnect");
        assert_eq!(m.state(), TargetState::Unknown);
        // Our reply still completes.
        let acts = m.on_server_bytes(&p(b"aabbccdd"));
        assert_eq!(completions(&acts), vec![(1, Ok(b"aabbccdd".to_vec()))]);
    }

    // ── Tracing (§ trace.rs) ──────────────────────────────────────────────────

    fn traced(actions: &[Action]) -> Vec<(Party, String)> {
        actions
            .iter()
            .filter_map(|a| match a {
                Action::Trace(e) => Some((e.party, String::from_utf8_lossy(&e.raw).to_string())),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn tracing_off_emits_nothing_at_all() {
        // Must cost nothing when off, including no allocation.
        let mut m = handshaken(ServerTier::Full);
        assert_eq!(m.trace_level(), TraceLevel::Off);
        let acts = m.on_gdb_bytes(&p(b"m0,4"));
        assert!(traced(&acts).is_empty());
        m.submit(1, packet::mem_read(0, 4, MemoryReadKind::Hex), None).unwrap();
        assert!(traced(&m.pump()).is_empty());
    }

    #[test]
    fn the_trace_shows_all_four_parties_including_the_two_no_other_tool_can() {
        // The claim trace.rs is built on. GDB continues; we read memory while the
        // target runs; our request and its reply are invisible to GDB's own
        // `set debug remote` and to OpenOCD's log, and must appear here.
        let mut m = handshaken(ServerTier::Full);
        m.set_trace_level(TraceLevel::Packets);

        let acts = m.on_gdb_bytes(&p(b"vCont;c"));
        assert_eq!(traced(&acts), vec![(Party::GdbToServer, "$vCont;c#a8".to_string())]);

        m.submit(7, packet::mem_read(0x2000_0000, 4, MemoryReadKind::Hex), None)
            .unwrap();
        let acts = m.pump();
        let t = traced(&acts);
        assert_eq!(t.len(), 1);
        assert_eq!(t[0].0, Party::AgentToServer);
        assert_eq!(t[0].1, "$m20000000,4#4f");
        // Consumer and seq are on the record, so a grep can follow one request.
        let detail = acts.iter().find_map(|a| match a {
            Action::Trace(e) => e.detail.clone(),
            _ => None,
        });
        // Consumer id asserted exactly; the seq is internal bookkeeping whose value
        // depends on how many packets the handshake happened to send.
        let detail = detail.unwrap();
        assert!(detail.starts_with("c7/s"), "{detail}");
        let seq = detail.strip_prefix("c7/s").unwrap().to_string();

        // Our reply: SRV>AGT, with a round-trip figure, and never forwarded.
        let acts = m.on_server_bytes(&p(b"deadbeef"));
        let t = traced(&acts);
        assert_eq!(t.len(), 1, "expected exactly one record, got {t:?}");
        assert_eq!(t[0].0, Party::ServerToAgent);
        let detail = acts
            .iter()
            .find_map(|a| match a {
                Action::Trace(e) => e.detail.clone(),
                _ => None,
            })
            .unwrap();
        assert!(
            detail.starts_with(&format!("c7/s{seq} rtt=")),
            "reply should name the same request and carry a round-trip figure: {detail}"
        );

        // And GDB's own stop reply, much later: SRV>GDB.
        let acts = m.on_server_bytes(&p(b"T05"));
        assert_eq!(traced(&acts), vec![(Party::ServerToGdb, "$T05#b9".to_string())]);
    }

    #[test]
    fn acks_are_traced_only_at_the_all_level() {
        // Acks dominate by count and say nothing when healthy -- but they are the
        // whole story for an ack-accounting bug, so `All` must include them.
        let mut m = MuxCore::new(ServerTier::Full);
        m.set_trace_level(TraceLevel::Packets);
        let acts = m.on_gdb_bytes(b"+");
        assert!(traced(&acts).is_empty(), "an ack was traced at the Packets level");

        m.set_trace_level(TraceLevel::All);
        let acts = m.on_gdb_bytes(b"+");
        assert_eq!(traced(&acts), vec![(Party::GdbToServer, "+".to_string())]);
    }

    #[test]
    fn a_forwarded_server_ack_is_traced_as_server_to_gdb() {
        let mut m = MuxCore::new(ServerTier::Full);
        m.set_trace_level(TraceLevel::All);
        m.on_gdb_bytes(&p(b"qSupported:"));
        let acts = m.on_server_bytes(b"+");
        assert!(
            traced(&acts).contains(&(Party::ServerToGdb, "+".to_string())),
            "{:?}",
            traced(&acts)
        );
    }

    #[test]
    fn a_trace_record_precedes_the_action_it_describes() {
        // So the file reads in wire order rather than lagging by one.
        let mut m = handshaken(ServerTier::Full);
        m.set_trace_level(TraceLevel::Packets);
        let acts = m.on_gdb_bytes(&p(b"m0,4"));
        let trace_at = acts.iter().position(|a| matches!(a, Action::Trace(_))).unwrap();
        let send_at = acts.iter().position(|a| matches!(a, Action::ToServer(_))).unwrap();
        assert!(trace_at < send_at, "trace came after the send: {acts:?}");
    }

    #[test]
    fn next_deadline_reports_the_soonest() {
        let mut m = handshaken(ServerTier::Full);
        m.set_depth(2).unwrap();
        let t0 = Instant::now();
        m.submit(
            1,
            packet::mem_read(0, 4, MemoryReadKind::Hex),
            Some(Duration::from_secs(5)),
        )
        .unwrap();
        m.submit(
            2,
            packet::mem_read(4, 4, MemoryReadKind::Hex),
            Some(Duration::from_secs(1)),
        )
        .unwrap();
        m.pump_at(t0);
        assert_eq!(m.next_deadline(), Some(t0 + Duration::from_secs(1)));
    }
}
