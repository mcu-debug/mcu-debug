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

//! GDB Remote Serial Protocol engine.
//!
//! The Probe Agent multiplexes the single RSP connection to a gdb-server: GDB is
//! one client on it, and the Agent's own features (RTT, PC sampling, trace drain)
//! are others. See `docs-internal/gdb-rsp.md` for the design, the protocol facts
//! that constrain it, and the plan this is being built against.
//!
//! **This module is deliberately at crate level, not under `proxy_helper`.** The
//! non-proxy topology has no Probe Agent in the data path today (design §8), and
//! whichever way that is resolved, the engine has to be reachable from more than
//! one entry point.
//!
//! Layering, innermost first — each layer is usable and testable without the one
//! above it:
//!
//! 1. [`frame`] — byte stream ⇄ frames. Pure.
//! 2. `packet` — typed builders and parsers for the packets we care about.
//! 3. `caps` — what a `qSupported` exchange told us; per-server capability tier.
//! 4. `state` — target run-state model, driven by observed traffic.
//! 5. `mux` — owns the socket, routes replies, enforces what we may send.
//! 6. `consumer` — the `read_memory`/`write_memory` API its clients use.

pub mod caps;
pub mod channel;
pub mod chunk;
pub mod consumer;
pub mod frame;
pub mod mux;
pub mod packet;
pub mod probe;
pub mod state;
pub mod trace;

pub use caps::{drain_cap, drain_cap_for_server, MemoryReadKind, MemoryWriteKind, RspCaps, ServerTier};
pub use channel::{GdbSink, RspChannel};
pub use chunk::{plan_read, plan_write, Chunk, ReadAssembler, WriteAssembler};
pub use consumer::{Consumer, Endian};
pub use frame::{AckMode, Frame, FrameKind, PacketCodec};
pub use mux::{Action, ConsumerId, MuxCore, RspSource};
pub use packet::StopReply;
pub use state::{Direction, StateTracker, TargetState};
pub use trace::{Party, RspTrace, TraceEvent, TraceLevel};

/// Anything that can go wrong on an RSP channel.
///
/// The three failure modes are kept apart because callers act on them
/// differently, and collapsing them is how a recoverable situation turns into a
/// reported fault:
///
/// - [`RspError::Unsupported`] — the stub does not implement this packet (it
///   answered empty). Fall back to another encoding; nothing is wrong.
/// - [`RspError::Target`] — the stub understood and refused (`E xx`). The request
///   was bad, or that memory is not accessible. Report it to the consumer, keep
///   the channel.
/// - [`RspError::Malformed`] / [`RspError::Timeout`] / [`RspError::Closed`] — the
///   channel itself is in trouble. These are the ones that may justify tearing it
///   down.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RspError {
    /// The stub replied with an empty packet: it does not implement this request.
    Unsupported,
    /// `E xx`, or `E.<text>` from a stub advertising `error-message+`.
    Target(Option<u8>),
    /// A reply that cannot be interpreted. Carries a static reason rather than a
    /// formatted string so it stays cheap on a per-read path.
    Malformed(&'static str),
    /// The reply arrived but could not be accepted -- a bad checksum, or a payload the codec
    /// rejected -- so the request has no answer even though the server sent one.
    ///
    /// Separate from [`RspError::Malformed`] because it is worth *retrying*: a read is idempotent,
    /// and a server that mangles one reply may well answer a differently-sized request correctly.
    /// The ST-LINK gdb-server, for one, truncates a reply of exactly 1024 bytes, losing the last
    /// checksum digit to a NUL terminator -- so the same read asked for one byte shorter succeeds.
    ReplyRejected,
    /// No reply within the request's deadline.
    Timeout,
    /// The channel is gone.
    Closed,
}

impl std::fmt::Display for RspError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RspError::Unsupported => write!(f, "gdb-server does not support this packet"),
            RspError::Target(Some(code)) => write!(f, "gdb-server returned error E{code:02x}"),
            RspError::Target(None) => write!(f, "gdb-server returned an error"),
            RspError::Malformed(why) => write!(f, "malformed RSP reply: {why}"),
            RspError::ReplyRejected => write!(f, "the gdb-server's reply could not be accepted"),
            RspError::Timeout => write!(f, "timed out waiting for an RSP reply"),
            RspError::Closed => write!(f, "RSP channel is closed"),
        }
    }
}

impl std::error::Error for RspError {}
