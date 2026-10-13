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

//! Target run-state model, driven entirely by observed traffic.
//!
//! This is the state the Agent gets **for free** by owning the socket. A gdb-server
//! reports a run/stop transition to the connection that **issued the resume** — not
//! to every connection, and not merely to the first one (`docs-internal/gdb-rsp.md`
//! §2 has the mechanism, read out of OpenOCD's source). Under the multiplexer the
//! resuming connection is GDB's, and we are on it, so this is the server's own view
//! rather than a reconstruction.
//!
//! The state is a property of the **core**, not of a connection (§3.10): one core
//! is running or halted, and every consumer and every GDB client attached to that
//! core shares the answer. Hence one tracker per multiplexer.

use super::frame::{Frame, FrameKind};
use super::packet::{parse_stop_reply, StopReply};

/// Where a frame was going.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    /// Client (GDB or us) to gdb-server.
    ToServer,
    /// gdb-server to client.
    FromServer,
}

/// What the target is doing.
///
/// Three values on purpose. There is no `Exited`: process exit barely exists on
/// an MCU, and for our purposes `W`/`X` mean the same thing as a dropped
/// connection — *do not read memory and do not assume you may*, which is exactly
/// what `Unknown` already means. Collapsing them keeps every consumer's check to
/// one comparison.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TargetState {
    /// Resumed and not yet reported stopped. Reads are legal only on a
    /// [`super::caps::ServerTier::Full`] server.
    Running,
    /// Halted. Reads are legal on any server that works at all.
    Stopped,
    /// Not yet known, or no longer knowable: before the first stop reply, after
    /// a `W`/`X`, or after GDB disconnects. **Never read in this state** — the
    /// point of a distinct value is that "not running" is not the same as "safe".
    #[default]
    Unknown,
}

impl TargetState {
    /// Whether a memory access is meaningful right now, given what the server
    /// allows while running.
    pub fn readable(self, allows_while_running: bool) -> bool {
        match self {
            TargetState::Stopped => true,
            TargetState::Running => allows_while_running,
            TargetState::Unknown => false,
        }
    }
}

/// Tracks [`TargetState`] from frames flowing in both directions.
///
/// Only *definite* signals move the state. A great many packets say nothing
/// about execution, and an `OK` cannot be interpreted without knowing which
/// request it answers — correlation the tracker deliberately does not attempt,
/// because guessing here would produce a state model that is wrong occasionally
/// rather than unknown honestly.
#[derive(Debug, Default)]
pub struct StateTracker {
    state: TargetState,
    /// Signal from the most recent stop reply, for diagnostics.
    last_signal: Option<u8>,
    /// A `\x03` was seen and no stop reply has arrived yet. The target is still
    /// running at this point: an interrupt is a *request*, and the halt is only
    /// real when the server says so.
    interrupt_pending: bool,
}

impl StateTracker {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn state(&self) -> TargetState {
        self.state
    }

    pub fn last_signal(&self) -> Option<u8> {
        self.last_signal
    }

    pub fn interrupt_pending(&self) -> bool {
        self.interrupt_pending
    }

    /// Feed one decoded frame. Returns the new state **only when it changed**, so
    /// a caller can publish transitions without diffing.
    pub fn observe(&mut self, dir: Direction, frame: &Frame) -> Option<TargetState> {
        let before = self.state;
        match (dir, frame.kind) {
            (Direction::ToServer, FrameKind::Interrupt) => {
                // Not a state change: the target runs until the server reports a halt.
                self.interrupt_pending = true;
            }
            (Direction::ToServer, FrameKind::Packet) => match classify_client(&frame.payload) {
                ClientEffect::Resume => {
                    self.state = TargetState::Running;
                    // `interrupt_pending` deliberately survives this. The manual is
                    // explicit (E.9 Interrupts): "Interrupts received while the program
                    // is stopped are queued and the program will be interrupted when it
                    // is resumed next time." A `\x03` that arrived while we were halted
                    // is an ordinary race -- GDB asking for a stop at the same moment a
                    // breakpoint hit -- and it is still owed a halt, which *this* resume
                    // will deliver almost immediately. Clearing it here would describe
                    // the run as open-ended when it is about to end at once. It cannot
                    // stick, because any halt clears it in `apply_stop_reply`.
                }
                ClientEffect::Invalidate => {
                    self.state = TargetState::Unknown;
                    self.last_signal = None;
                    self.interrupt_pending = false;
                }
                ClientEffect::None => {}
            },
            (Direction::FromServer, FrameKind::Packet) => self.apply_stop_reply(&frame.payload),
            (Direction::FromServer, FrameKind::Notification) => {
                // `%Stop:<stop reply>` in non-stop mode. We do not use non-stop,
                // but a server volunteering one still tells us something true.
                if let Some(inner) = frame.payload.strip_prefix(b"Stop:") {
                    self.apply_stop_reply(inner);
                }
            }
            // Console output and file-I/O arrive mid-transaction and mean the
            // target is alive, not that it stopped. Acks carry no information.
            _ => {}
        }
        (self.state != before).then_some(self.state)
    }

    /// GDB's RSP connection went away. Everything we knew is now stale: the
    /// server may be left running, halted, or with the target released entirely.
    pub fn gdb_disconnected(&mut self) {
        self.state = TargetState::Unknown;
        self.last_signal = None;
        self.interrupt_pending = false;
    }

    fn apply_stop_reply(&mut self, payload: &[u8]) {
        match parse_stop_reply(payload) {
            Some(StopReply::Signalled(sig)) => {
                self.state = TargetState::Stopped;
                self.last_signal = Some(sig);
                self.interrupt_pending = false;
            }
            Some(StopReply::Exited(_)) | Some(StopReply::Terminated(_)) => {
                // Gone. Not "stopped": there is nothing left to read.
                self.state = TargetState::Unknown;
                self.interrupt_pending = false;
            }
            // `N` means no threads are running in non-stop mode. It says nothing
            // about any particular core's halt state, so it changes nothing.
            Some(StopReply::NoResumedThreads) | None => {}
        }
    }
}

/// What a **client-to-server** packet does to our knowledge of the target.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ClientEffect {
    /// Execution resumed. The reply, whenever it comes, will be a stop reply.
    Resume,
    /// The session changed such that what we knew is no longer true, but the new
    /// truth is not implied by the packet either.
    ///
    /// `vAttach` is the case that matters: **attaching does not necessarily
    /// halt.** GDB can attach with or without a halt — halting is its default,
    /// but it is a choice, and mcu-debug deliberately does it both ways. So an
    /// attach tells us only that we no longer know. If it did halt, the stop
    /// reply that follows says so; if it did not, [`TargetState::Unknown`] is the
    /// honest answer until something else settles it.
    Invalidate,
    /// Says nothing about execution.
    None,
}

/// Classify a **client-to-server** payload.
///
/// Matched on exact packet shapes rather than a first-byte test, because several
/// resume letters are prefixes of packets that resume nothing.
///
/// `vCont` in particular has three distinct forms that are easy to conflate, and
/// only the last one resumes anything:
///
/// 1. `vContSupported+` — a feature token inside a **`qSupported` reply**,
///    meaning "I implement the `vCont` family at all". Never seen by this
///    function; [`super::caps`] handles it.
/// 2. `vCont?` — a **query** asking which *actions* are supported (continue,
///    step, and their with-signal variants). Separate from `vContSupported`.
///    OpenOCD answers `vCont;c;C;s;S`, which means "I support these four
///    actions" — a reply that is textually indistinguishable from a resume
///    command. What keeps that from corrupting the state model is the
///    [`Direction`] check in [`StateTracker::observe`], not anything here.
/// 3. `vCont;<action>[:<thread-id>]…` — the actual resume command, and the only
///    form that moves the target.
fn classify_client(payload: &[u8]) -> ClientEffect {
    let Some((&first, rest)) = payload.split_first() else {
        return ClientEffect::None;
    };
    match first {
        // `c`, `c<addr>`, `s`, `s<addr>` — bare or with a resume address.
        b'c' | b's' if rest.iter().all(|b| b.is_ascii_hexdigit()) => ClientEffect::Resume,
        // `C<sig>`, `S<sig>`, optionally `;<addr>`.
        b'C' | b'S' if !rest.is_empty() => ClientEffect::Resume,
        // `R<XX>` restart — the program is replaced and there is no reply, so the
        // new state is not knowable from the packet.
        b'R' => ClientEffect::Invalidate,
        // `k` kill, `D` detach — the session is over as far as we can tell.
        b'k' | b'D' => ClientEffect::Invalidate,
        b'v' => {
            if let Some(actions) = payload.strip_prefix(b"vCont;") {
                // `vCont;t` is a *stop* request in non-stop mode; `vCont;c`,
                // `;C`, `;s`, `;S` resume. Actions are `;`-separated and each may
                // carry `:<thread-id>`.
                let resumes = actions
                    .split(|&b| b == b';')
                    .filter_map(|a| a.first())
                    .any(|&a| matches!(a, b'c' | b'C' | b's' | b'S'));
                return if resumes {
                    ClientEffect::Resume
                } else {
                    ClientEffect::None
                };
            }
            // `vCtrlC` is deliberately `None` rather than an interrupt request. It is
            // the *non-stop* spelling of `\x03` (E.9: in non-stop mode GDB "sends a
            // regular packet ... instead of the single byte 0x03"), and we do not run
            // non-stop (§4.7). Handling it would be modelling a mode we have no way to
            // exercise; this comment is here so its absence reads as a decision.
            //
            // `vRun` restarts the program and `vAttach` attaches to one. Neither
            // implies a run state: both are answered by a stop reply when they
            // halt, and an attach need not halt at all. See `ClientEffect`.
            if payload.starts_with(b"vRun") || payload.starts_with(b"vAttach") || payload.starts_with(b"vKill") {
                return ClientEffect::Invalidate;
            }
            ClientEffect::None
        }
        _ => ClientEffect::None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gdb_rsp::frame::{FrameKind, PacketCodec};

    /// Build a frame the way the codec would, so tests exercise the same path
    /// the multiplexer will.
    fn frame_of(kind_start: u8, payload: &[u8]) -> Frame {
        let sum = payload.iter().fold(0u8, |a, &b| a.wrapping_add(b));
        let mut bytes = vec![kind_start];
        bytes.extend_from_slice(payload);
        bytes.push(b'#');
        bytes.extend_from_slice(format!("{sum:02x}").as_bytes());
        let mut codec = PacketCodec::new();
        codec.feed(&bytes);
        codec.next_frame().expect("a frame")
    }

    fn pkt(payload: &[u8]) -> Frame {
        frame_of(b'$', payload)
    }

    fn notif(payload: &[u8]) -> Frame {
        frame_of(b'%', payload)
    }

    fn interrupt() -> Frame {
        let mut codec = PacketCodec::new();
        codec.feed(&[0x03]);
        codec.next_frame().expect("a frame")
    }

    /// Run a scripted conversation and return the state after each step.
    fn run(script: &[(Direction, Frame)]) -> Vec<TargetState> {
        let mut t = StateTracker::new();
        script
            .iter()
            .map(|(dir, f)| {
                t.observe(*dir, f);
                t.state()
            })
            .collect()
    }

    use Direction::{FromServer as From_, ToServer as To};

    #[test]
    fn starts_unknown() {
        assert_eq!(StateTracker::new().state(), TargetState::Unknown);
        // And Unknown is the default, so a forgotten initialisation is safe.
        assert_eq!(TargetState::default(), TargetState::Unknown);
    }

    #[test]
    fn continue_then_stop() {
        let states = run(&[
            (To, pkt(b"c")),
            (From_, pkt(b"T05thread:01;")),
            (To, pkt(b"vCont;c")),
            (From_, pkt(b"S05")),
        ]);
        assert_eq!(
            states,
            vec![
                TargetState::Running,
                TargetState::Stopped,
                TargetState::Running,
                TargetState::Stopped,
            ]
        );
    }

    #[test]
    fn observe_reports_only_transitions() {
        let mut t = StateTracker::new();
        assert_eq!(t.observe(To, &pkt(b"c")), Some(TargetState::Running));
        // A second resume while already running is not a transition.
        assert_eq!(t.observe(To, &pkt(b"c")), None);
        assert_eq!(t.observe(From_, &pkt(b"S05")), Some(TargetState::Stopped));
        assert_eq!(t.observe(From_, &pkt(b"S05")), None);
    }

    #[test]
    fn console_output_during_a_continue_does_not_stop_the_target() {
        // This is the trap: `O` arrives between the resume and the real stop
        // reply. Treating it as a reply would report the target halted while it
        // is running, and RTT would stop polling exactly when there is data.
        let states = run(&[
            (To, pkt(b"c")),
            (From_, pkt(b"O48656c6c6f")),
            (From_, pkt(b"O0a")),
            (From_, pkt(b"T05")),
        ]);
        assert_eq!(
            states,
            vec![
                TargetState::Running,
                TargetState::Running,
                TargetState::Running,
                TargetState::Stopped,
            ]
        );
    }

    #[test]
    fn file_io_during_a_continue_does_not_stop_the_target() {
        let states = run(&[
            (To, pkt(b"c")),
            (From_, pkt(b"Fopen,1234/0,0,1b6")),
            (From_, pkt(b"T05")),
        ]);
        assert_eq!(
            states,
            vec![TargetState::Running, TargetState::Running, TargetState::Stopped]
        );
    }

    #[test]
    fn ok_replies_never_move_the_state() {
        // An `OK` cannot be interpreted without knowing its request, so it must
        // do nothing -- in either direction of the conversation.
        let states = run(&[(To, pkt(b"c")), (From_, pkt(b"OK")), (From_, pkt(b"OK"))]);
        assert_eq!(states, vec![TargetState::Running; 3]);
    }

    #[test]
    fn memory_traffic_never_moves_the_state() {
        let states = run(&[
            (To, pkt(b"c")),
            (To, pkt(b"m20000000,4")),
            (From_, pkt(b"deadbeef")),
            (To, pkt(b"M20000000,1:00")),
            (From_, pkt(b"OK")),
        ]);
        assert_eq!(states, vec![TargetState::Running; 5]);
    }

    #[test]
    fn an_interrupt_that_arrived_while_halted_survives_the_next_resume() {
        // E.9: "Interrupts received while the program is stopped are queued and the
        // program will be interrupted when it is resumed next time." The race is real --
        // GDB sends 0x03 just as a breakpoint hits -- so the resume that follows is not a
        // fresh open-ended run, and anything reading `interrupt_pending` to decide that
        // must still see the request.
        let mut t = StateTracker::new();
        t.observe(To, &pkt(b"c"));
        t.observe(From_, &pkt(b"T05"));
        assert_eq!(t.state(), TargetState::Stopped);

        t.observe(To, &interrupt());
        assert!(t.interrupt_pending(), "queued while stopped");
        assert_eq!(t.observe(To, &pkt(b"c")), Some(TargetState::Running));
        assert!(t.interrupt_pending(), "the queued interrupt is still owed a halt");

        // And the halt it produces clears it, so it cannot stick.
        t.observe(From_, &pkt(b"T02"));
        assert!(!t.interrupt_pending());
    }

    #[test]
    fn interrupt_is_a_request_not_a_halt() {
        let mut t = StateTracker::new();
        t.observe(To, &pkt(b"c"));
        assert_eq!(t.observe(To, &interrupt()), None, "no transition on 0x03");
        assert_eq!(t.state(), TargetState::Running);
        assert!(t.interrupt_pending());
        // The halt becomes real only when the server reports it.
        assert_eq!(t.observe(From_, &pkt(b"T02")), Some(TargetState::Stopped));
        assert!(!t.interrupt_pending());
        assert_eq!(t.last_signal(), Some(2));
    }

    #[test]
    fn exit_and_termination_are_unknown_not_stopped() {
        // There is nothing to read after these, so they must not look readable.
        for reply in [&b"W00"[..], b"X09"] {
            let mut t = StateTracker::new();
            t.observe(To, &pkt(b"c"));
            assert_eq!(
                t.observe(From_, &pkt(reply)),
                Some(TargetState::Unknown),
                "reply {reply:?}"
            );
            assert!(!t.state().readable(true));
        }
    }

    #[test]
    fn non_stop_notification_is_honoured() {
        let mut t = StateTracker::new();
        t.observe(To, &pkt(b"vCont;c"));
        assert_eq!(t.state(), TargetState::Running);
        let n = notif(b"Stop:T05thread:01;");
        assert_eq!(n.kind, FrameKind::Notification);
        assert_eq!(t.observe(From_, &n), Some(TargetState::Stopped));
    }

    #[test]
    fn n_reply_changes_nothing() {
        let mut t = StateTracker::new();
        t.observe(To, &pkt(b"vCont;c"));
        assert_eq!(t.observe(From_, &pkt(b"N")), None);
        assert_eq!(t.state(), TargetState::Running);
    }

    #[test]
    fn gdb_disconnect_invalidates_everything() {
        let mut t = StateTracker::new();
        t.observe(To, &pkt(b"c"));
        t.observe(From_, &pkt(b"T05"));
        assert_eq!(t.state(), TargetState::Stopped);
        t.gdb_disconnected();
        assert_eq!(t.state(), TargetState::Unknown);
        assert_eq!(t.last_signal(), None);
    }

    // ── Resume detection ──────────────────────────────────────────────────────

    #[test]
    fn resume_packets_are_recognised() {
        for p in [
            &b"c"[..],
            b"c20000000",
            b"s",
            b"s20000000",
            b"C05",
            b"S05",
            b"vCont;c",
            b"vCont;c:p1.-1",
            b"vCont;s:1",
            b"vCont;C05:1",
            b"vCont;t:1;c:2",
        ] {
            assert_eq!(
                classify_client(p),
                ClientEffect::Resume,
                "should resume: {}",
                String::from_utf8_lossy(p)
            );
        }
    }

    #[test]
    fn attach_does_not_imply_a_run_state() {
        // Attaching does NOT necessarily halt. GDB can attach either way, halting
        // is only its default, and mcu-debug does both. So `vAttach` must leave us
        // in Unknown -- claiming Running would be a guess, and claiming Stopped
        // would be the guess that lets a consumer read a running target on a
        // HaltedOnly server.
        for p in [
            &b"vAttach;1"[..],
            b"vRun;",
            b"vRun;2f62696e2f6c73",
            b"R00",
            b"k",
            b"D",
            b"vKill;1",
        ] {
            assert_eq!(
                classify_client(p),
                ClientEffect::Invalidate,
                "should invalidate: {}",
                String::from_utf8_lossy(p)
            );
        }
    }

    #[test]
    fn attach_from_a_known_state_returns_to_unknown() {
        let mut t = StateTracker::new();
        t.observe(To, &pkt(b"c"));
        t.observe(From_, &pkt(b"T05"));
        assert_eq!(t.state(), TargetState::Stopped);
        assert_eq!(t.last_signal(), Some(5));

        // A fresh attach makes the old verdict meaningless.
        assert_eq!(t.observe(To, &pkt(b"vAttach;1")), Some(TargetState::Unknown));
        assert_eq!(t.last_signal(), None);
        assert!(!t.state().readable(true));

        // If this attach did halt, the stop reply settles it.
        assert_eq!(t.observe(From_, &pkt(b"T05")), Some(TargetState::Stopped));
    }

    #[test]
    fn attach_without_halt_stays_unknown_until_something_says_otherwise() {
        // The no-halt case: nothing follows the attach that reveals the state, so
        // we must not drift into an assumption.
        let mut t = StateTracker::new();
        t.observe(To, &pkt(b"vAttach;1"));
        t.observe(From_, &pkt(b"OK"));
        t.observe(To, &pkt(b"qSupported:multiprocess+"));
        t.observe(To, &pkt(b"m20000000,4"));
        t.observe(From_, &pkt(b"deadbeef"));
        assert_eq!(t.state(), TargetState::Unknown);
    }

    #[test]
    fn vcont_query_is_not_a_resume() {
        // `vCont?` asks which vCont ACTIONS are supported -- a different thing
        // from the `vContSupported+` feature in a qSupported reply. Reading it as
        // a resume would mark the target running during GDB's startup handshake,
        // while it is in fact halted, and the send gate would then refuse every
        // read on a HaltedOnly server for the rest of the session.
        assert_eq!(classify_client(b"vCont?"), ClientEffect::None);
    }

    #[test]
    fn the_vcont_query_reply_does_not_resume_the_target() {
        // OpenOCD answers `vCont?` with `vCont;c;C;s;S` -- a LIST OF SUPPORTED
        // ACTIONS that is textually identical to a resume command. Only the
        // direction distinguishes them, so this asserts the direction check is
        // what is doing the work. If `observe` ever stopped discriminating, the
        // tracker would believe the target resumed during GDB's handshake.
        let mut t = StateTracker::new();
        let reply = pkt(b"vCont;c;C;s;S");
        assert_eq!(t.observe(From_, &reply), None);
        assert_eq!(t.state(), TargetState::Unknown);

        // And the same bytes in the other direction are a real resume.
        let mut t2 = StateTracker::new();
        assert_eq!(t2.observe(To, &pkt(b"vCont;c;C;s;S")), Some(TargetState::Running));
    }

    #[test]
    fn vcont_stop_only_is_not_a_resume() {
        // `vCont;t` on its own is a stop request in non-stop mode.
        assert_eq!(classify_client(b"vCont;t"), ClientEffect::None);
        assert_eq!(classify_client(b"vCont;t:1"), ClientEffect::None);
    }

    #[test]
    fn non_resume_packets_are_not_mistaken_for_resumes() {
        for p in [
            &b"qSupported:multiprocess+"[..], // starts with 'q', but contains 'S'
            b"qC",
            b"m20000000,4",
            b"M20000000,1:00",
            b"X100,1:\x00",
            b"x100,4",
            b"?",
            b"g",
            b"p10",
            b"Hg0",
            b"Z0,20000000,2",
            b"z0,20000000,2",
            b"k",
            b"D",
            b"QStartNoAckMode",
            b"vFile:open:2f,0,0",
            b"vMustReplyEmpty",
            b"",
            // `s`/`c` followed by non-hex is not a resume-with-address.
            b"stuff",
            b"cheese",
        ] {
            assert_ne!(
                classify_client(p),
                ClientEffect::Resume,
                "should not resume: {}",
                String::from_utf8_lossy(p)
            );
        }
    }

    // ── Readability gate ──────────────────────────────────────────────────────

    #[test]
    fn readability_depends_on_state_and_server_tier() {
        // Stopped is always readable; Unknown never is; Running depends on the
        // server. This is the whole contract the send gate consumes.
        assert!(TargetState::Stopped.readable(false));
        assert!(TargetState::Stopped.readable(true));
        assert!(TargetState::Running.readable(true));
        assert!(!TargetState::Running.readable(false));
        assert!(!TargetState::Unknown.readable(true));
        assert!(!TargetState::Unknown.readable(false));
    }
}
