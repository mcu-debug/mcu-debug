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

//! Wire-protocol types: requests, responses, events, and the unified event enum.
//!
//! All types in this module are serialized to/from JSON and (where marked with
//! `ts_rs::TS`) generate TypeScript type definitions in the shared package.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io;
use std::net::TcpStream;

use crate::serial::port::{PortErrorEvent, SerialErrorKind, SerialParams};
use crate::serial::AvailablePort;

// ── Funnel event (unified event channel) ─────────────────────────────────────

/// Which session-owned background thread a [`ProxyEvent::SessionThreadExited`]
/// refers to. `message_loop` uses [`SessionThreadRole::is_fatal`] to decide
/// whether the thread's death ends the whole session or is merely noted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionThreadRole {
    /// Reads the client control socket. Fatal — without it the session is deaf.
    ControlReader,
    /// Forwards gdb-server stdout to the client.
    GdbStdout,
    /// Forwards gdb-server stderr to the client.
    GdbStderr,
    /// Waits for a gdb-server port to open, then forwards it.
    PortWaiter,
    /// Watches gdb-server ports for readiness.
    PortMonitor,
    /// Forwards fatal serial-port errors into the event loop.
    SerialErrorForwarder,
    /// Waits for the gdb-server child to exit on its own.
    GdbReaper,
}

impl SessionThreadRole {
    /// OS thread name, surfaced by the panic hook and in logs.
    pub fn thread_name(self) -> String {
        format!("session-{self:?}")
    }

    /// Whether this thread's exit should tear down the whole session.
    ///
    /// Only the control reader is fatal: a panic there would otherwise strand
    /// `message_loop` on `recv()` forever (the loop always holds a sender, so it
    /// never sees `Disconnected`). Every other role's death is local — the
    /// relevant stream/port is simply gone.
    pub fn is_fatal(self) -> bool {
        matches!(self, SessionThreadRole::ControlReader)
    }
}

/// Who reads the gdb-server socket for a stream, decided by the message loop and
/// sent back to the port waiter on its readiness channel.
///
/// The decision has to be made on the message-loop thread, because that is where
/// `stream_meta` lives — and it has to be *told* to the waiter, because the waiter is
/// already holding a read clone of the socket and would otherwise start reading it. Two
/// readers on one socket is not a slow path or a duplicate: each `read` takes whatever
/// arrived, so the two threads would split every packet between them at random.
///
/// Returning it on the existing handshake keeps one decision point instead of
/// classifying the stream again in the waiter thread from data it would have to be
/// handed anyway.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamForward {
    /// The waiter runs `read_and_forward` on its own read clone, as it always has.
    Direct,
    /// The RSP multiplexer owns this socket and runs its own reader thread. The
    /// waiter must drop its clone and exit without reading a single byte.
    MuxOwned,
}

/// Unified event type for the main event loop. All background threads
/// (control-stream reader, port waiters, stdout/stderr forwarders) send events
/// through one channel so `message_loop` can block on `recv()` instead of
/// polling + sleeping.
pub enum ProxyEvent {
    /// Raw bytes received from the client TCP connection, stamped when the reader
    /// thread queued them. The message loop is single-threaded, so the gap between
    /// this stamp and dispatch is time the request spent waiting behind other work
    /// — the one delay a handler cannot measure about itself.
    IncomingData(Vec<u8>, std::time::Instant),
    /// Client connection closed (EOF or error).
    IncomingClosed,
    /// A port waiter successfully connected to the gdb-server port.
    PortConnected {
        stream_id: u8,
        port: u16,
        stream: TcpStream,
        /// One-shot ack from main loop after stream is registered in `self.streams`,
        /// so forwarding cannot start before the write-end is registered. Its value
        /// also tells the waiter *whether* to forward — see [`StreamForward`].
        ready_tx: std::sync::mpsc::Sender<StreamForward>,
        /// Sequence number of the `StartStream`/`DuplicateStream` request that asked for
        /// this connection, used to address the `StreamStatus` response. Always a real
        /// seq — those handlers are the only source of this event.
        msg_seq: u64,
    },
    /// A port is ready; client can now connect to the forwarded port, but we won't
    /// forward data until they explicitly do so.
    PortReady { stream_id: u8, port: u16 },
    /// A port waiter failed to connect.
    PortFailed {
        stream_id: u8,
        port: u16,
        error: String,
        msg_seq: u64,
    },
    /// Data received from a forwarded stream (stdout, stderr, GDB RSP, …).
    StreamData { stream_id: u8, data: Vec<u8> },
    /// A forwarded stream closed.
    StreamClosed { stream_id: u8 },
    /// The gdb-server exited without us asking it to — crashed, was signalled, or
    /// returned on its own (openocd exits when no probe is found, for instance).
    ///
    /// `exit_code` follows the shell convention on Unix when the process was killed by
    /// a signal: `128 + signo`, so a segfault reports 139. `ExitStatus::code()` is
    /// `None` in that case, and the wire field is a plain `i32`.
    GdbServerExited { pid: u32, exit_code: i32 },
    /// A serial port's reader thread hit a fatal error.
    /// The port should be removed from the registry and the client notified.
    SerialPortError(PortErrorEvent),
    /// Full-snapshot update of available serial ports.
    SerialAvailableChanged { revision: u64, ports: Vec<AvailablePort> },
    /// A background thread wants an event forwarded to the client verbatim.
    ///
    /// The funnel writer belongs to the message loop, so a thread that has something to *say*
    /// rather than something to write hands it over here. Added for the RTT engine, whose
    /// `rttReady` can fire minutes after the request that started it, and general because every
    /// future Agent-side feature will have the same need.
    ServerEvent(ProxyServerEvents),
    /// A session-owned background thread exited — returned, errored, or panicked.
    /// Emitted by `spawn_session_thread` so the loop always learns of the death
    /// (even on panic) and can end the session for fatal roles or note the rest.
    SessionThreadExited { role: SessionThreadRole, panicked: bool },
}

// ── Misc shared types ─────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Hash, Eq, PartialEq, ts_rs::TS)]
#[ts(type = "any", export, export_to = "proxy-protocol/")]
#[repr(u8)]
pub enum StreamId {
    /// Control stream for JSON-RPC messages. Created on connection and always available.
    Control = 0,
    /// Binary stream for gdb-server stdout.
    Stdout = 1,
    /// Binary stream for gdb-server stderr.
    Stderr = 2,
    /// Raw GDB Remote Serial Protocol bytes to/from the gdb-server.
    GdbRsp = 3,
    /// Any other dynamic stream (SWO, RTT, serial-funnel, Tcl, …).
    Other(u8),
}

impl StreamId {
    pub fn to_u8(&self) -> u8 {
        match self {
            StreamId::Control => 0,
            StreamId::Stdout => 1,
            StreamId::Stderr => 2,
            StreamId::GdbRsp => 3,
            StreamId::Other(id) => *id,
        }
    }
}

/// Which GDB session a `GdbRsp` stream carries.
///
/// A core's gdb port takes one **controller** — the GDB that drives execution — and
/// any number of **secondaries** (the live-watch GDB today). The names describe the
/// *role*, not the order, which is the distinction that matters: a server reports a
/// halt only to the connection that asked for the resume, so only the controller has
/// a usable run-state model. See `docs-internal/gdb-rsp.md` §4.7.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamRole {
    /// The first GDB on this port — the one issuing `c`/`s`/`vCont`.
    Controller,
    /// An additional GDB on the same port, from `handle_duplicate_stream`.
    Secondary,
}

/// What a forwarded stream actually carries.
///
/// Classified **once**, when the port is allocated, from the `port_ids` name the
/// client supplied. Nothing downstream re-parses the string: the RSP multiplexer
/// needs to know which stream is a controller gdb connection, and
/// `docs-internal/Stream-Flow-Control.md` needs the same split for its throttling
/// policy (only `Stdout`/`Stderr` may ever be shed).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamKind {
    Control,
    Stdout,
    Stderr,
    /// A GDB Remote Serial Protocol connection for `core`.
    GdbRsp {
        core: u16,
        role: StreamRole,
    },
    Swo {
        core: u16,
    },
    /// One RTT channel served by the Agent's own engine. Never produced by
    /// [`StreamKind::classify`]: these streams are minted by `StartRtt`, not reserved through
    /// `AllocatePorts`, so there is no client-supplied name to classify.
    Rtt {
        channel: u32,
    },
    Tcl,
    Telnet,
    Console {
        core: u16,
    },
    /// Anything else, including the placeholder names some servers use to reserve
    /// consecutive ports (`gap1`, `gap2`).
    Other,
}

impl StreamKind {
    /// Classify from the client's stream name.
    ///
    /// The naming scheme is `createPortName()` in
    /// `packages/mcu-debug/src/adapter/servers/common.ts`: the base name for core 0
    /// and the base name plus the core number for cores 1 and up — so `gdbPort`,
    /// `gdbPort1`, `gdbPort2`. Matching the literal `gdbPort1` would miss core 0,
    /// which is nearly every session.
    ///
    /// Deliberately matched by **known prefix plus an all-digits remainder**, not by
    /// stripping trailing digits. ST-LINK reserves ports called `gap1` and `gap2`;
    /// digit-stripping would read those as base `gap` core 1, and worse, for core 1
    /// `createPortName` produces `gap11`. Requiring a known prefix sidesteps the
    /// whole question and leaves them `Other`, which is what they are.
    pub fn classify(name: &str) -> Self {
        // A controller until something says otherwise: `handle_duplicate_stream` is
        // the only thing that creates a secondary, and it overrides the role.
        if let Some(core) = core_suffix(name, "gdbPort") {
            return StreamKind::GdbRsp {
                core,
                role: StreamRole::Controller,
            };
        }
        if let Some(core) = core_suffix(name, "swoPort") {
            return StreamKind::Swo { core };
        }
        if let Some(core) = core_suffix(name, "consolePort") {
            return StreamKind::Console { core };
        }
        if core_suffix(name, "tclPort").is_some() {
            return StreamKind::Tcl;
        }
        if core_suffix(name, "telnetPort").is_some() {
            return StreamKind::Telnet;
        }
        StreamKind::Other
    }

    /// The core this stream belongs to, where that is meaningful.
    pub fn core(&self) -> Option<u16> {
        match self {
            StreamKind::GdbRsp { core, .. } | StreamKind::Swo { core } | StreamKind::Console { core } => Some(*core),
            _ => None,
        }
    }

    /// True for the one stream per core that the RSP multiplexer may attach to.
    pub fn is_rsp_controller(&self) -> bool {
        matches!(
            self,
            StreamKind::GdbRsp {
                role: StreamRole::Controller,
                ..
            }
        )
    }

    /// Whether output on this stream may be dropped under load
    /// (`docs-internal/Stream-Flow-Control.md`). Only diagnostic logging may.
    pub fn is_throttleable(&self) -> bool {
        matches!(self, StreamKind::Stdout | StreamKind::Stderr)
    }
}

/// `Some(core)` when `name` is `base` followed by nothing (core 0) or by a core
/// number. `None` for any other name, including `base` followed by non-digits.
fn core_suffix(name: &str, base: &str) -> Option<u16> {
    let rest = name.strip_prefix(base)?;
    if rest.is_empty() {
        return Some(0);
    }
    rest.parse().ok()
}

/// Agent-side debug switches that belong to **one session**, not to the proxy.
///
/// This distinction is the whole reason the type exists. A proxy is a shared daemon
/// serving several sessions and several clients at once, so a process-wide command-line
/// flag cannot express "trace *this* debug session" — turning tracing on would trace
/// everybody's, and turning the mux off would turn it off for someone else's session
/// mid-debug. These arrive on `initialize`, which is per connection and therefore per
/// session, and they override the corresponding `--rsp-*` defaults on the command line.
///
/// Only the flags the Agent can act on are on the wire. The rest of `debugFlags` —
/// `gdbTraces`, `timestamps` and friends — control the extension's own output and have no
/// meaning here, so the client maps across the two it needs rather than forwarding the
/// object wholesale. That also keeps this in the protocol's snake_case rather than
/// importing launch.json's camelCase into it.
#[derive(Debug, Clone, Default, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "proxy-protocol/")]
#[serde(default)]
pub struct SessionDebugFlags {
    /// RSP packet trace level for this session's muxed streams: `off`, `packets` or `all`.
    /// Unrecognised values mean `off` — a typo in a launch configuration must not fail the
    /// session. `None` defers to `--rsp-trace`.
    pub rsp_trace: Option<String>,
    /// Whether the RSP multiplexer owns this session's controller gdb streams. `None`
    /// defers to the proxy's own default (on, unless it was started `--no-rsp-mux`).
    pub rsp_mux: Option<bool>,
    /// Override what the Agent believes this gdb-server can do: `full`, `haltedOnly` or
    /// `unsupported`. `None`, or anything unrecognised, uses the measured default for the
    /// `servertype` (`RspCaps`/`ServerTier::from_server_type`).
    ///
    /// Exists because the compatibility matrix in §7 has one server measured and four to go, and
    /// without a way to say "try it" there is no way to measure the rest on real hardware.
    pub rsp_tier: Option<String>,
}

/// What the Agent needs to run RTT, from the client's `rttConfig`.
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "proxy-protocol/")]
pub struct RttStartConfig {
    /// Absolute address of `_SEGGER_RTT`, as a hex string (`"0x20000000"`).
    ///
    /// **Already resolved.** `rttConfig.address: "auto"` is turned into a number by the debug
    /// adapter from the ELF symbol table, which is the only side that has one -- so no symbol
    /// lookup happens in the Agent.
    pub cb_address: String,
    /// The id the firmware writes last, normally `"SEGGER RTT"`. Truncated to 16 bytes.
    pub search_id: String,
    /// True for a big-endian target. From `TargetInfo.endianness`, which only the adapter knows.
    pub big_endian: bool,
    /// Up channels (target to host) to drain.
    pub up_channels: Vec<u32>,
    /// Down channels (host to target) to accept input for.
    pub down_channels: Vec<u32>,
    /// How long to wait after a pass that moved nothing. The engine polls back to back while data
    /// is flowing, so this is an idle interval and not a rate limit.
    pub poll_interval_ms: Option<u32>,
    /// Cap on one channel's drain, so a full buffer cannot hold the shared RSP connection while
    /// GDB waits behind it.
    pub max_bytes_per_drain: Option<u32>,
    /// How often to send `rttStats`, or `None` for never.
    ///
    /// Asked for by the client rather than decided here, because the engine's counters are only half
    /// of a throughput measurement -- the consumer's own line is the other half, and the two are
    /// meaningless apart. So this rides the same per-decoder `stats` switch that turns that line on,
    /// and carries its interval, which is what keeps both describing the same window.
    pub stats_interval_ms: Option<u32>,
}

/// One RTT channel and the funnel stream its data arrives on.
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "proxy-protocol/")]
pub struct RttChannelStream {
    pub channel: u32,
    pub stream_id: u8,
}

// ── Port allocator types ──────────────────────────────────────────────────────

/// These ports are allocated as a group, consecutively
#[derive(Debug, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "proxy-protocol/")]
pub struct PortSet {
    /// Use it as starting port if possible. 0 means any available port, but still consecutive
    pub start_port: u16,
    /// List of id strings to identify this port. Should be unique across the entire session
    pub port_ids: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "proxy-protocol/")]
pub struct PortReserved {
    /// Actual port number of server
    pub port: u16,
    /// The stream-id used to connect to this port
    pub stream_id: u8,
    /// String representation of the stream-id, as specified by the client
    pub stream_id_str: String,
}

#[derive(Debug, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "proxy-protocol/")]
pub struct PortAllocatorSpec {
    /// List of all allocated port sets
    pub all_ports: Vec<PortSet>,
}

// ── Control requests ──────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "proxy-protocol/")]
#[serde(tag = "method", content = "params")]
pub enum ControlRequest {
    /** Initialize the proxy client with the given parameters. Must be the first request sent after establishing a connection. */
    #[serde(rename = "initialize")]
    Initialize {
        /** Token for authentication */
        token: String,
        /** SemVer string representing the version */
        version: String,
        /** Base directory unique-id of the remote launch dir for debugging */
        workspace_uid: String,
        /** Unique identifier for the session */
        session_uid: String,
        /**
         * Agent-side debug switches for this session, from `debugFlags` in the launch
         * configuration. Optional: a client that sends nothing gets the proxy's defaults.
         */
        #[serde(default)]
        debug_flags: Option<SessionDebugFlags>,
        /**
         * The launch configuration's `servertype` -- `openocd`, `jlink`, `pyocd`, ...
         *
         * The Agent cannot work this out for itself: it is given a path to an executable, not a
         * kind. It needs the kind because what an Agent-side feature may do depends on the server
         * (`docs-internal/gdb-rsp.md` §7), and reading that off `ServerTier::Unknown` for everyone
         * means those features never run while the target is running -- which is when most of them
         * are wanted.
         */
        #[serde(default)]
        server_type: Option<String>,
    },

    #[serde(rename = "allocatePorts")]
    AllocatePorts {
        /** Number of consecutive ports needed */
        ports_spec: PortAllocatorSpec,
    },

    #[serde(rename = "startGdbServer")]
    StartGdbServer {
        /** Path to the gdb-server executable on the host machine */
        server_path: String,
        /** Arguments to launch the gdb-server with */
        server_args: Vec<String>,
        /** Environment variables for the gdb-server process */
        server_env: Option<HashMap<String, String>>,
        /** CWD of the gdb-server process */
        server_cwd: Option<String>,
        /** Security file path for the gdb-server process */
        security_file: Option<String>,
    },

    #[serde(rename = "endSession")]
    EndSession,

    #[serde(rename = "streamStatus")]
    StreamStatus { stream_id: u8 },

    #[serde(rename = "startStream")]
    StartStream { stream_id: u8 },

    /// Run RTT in the Agent, on `stream_id`'s multiplexer.
    ///
    /// **No new data path comes with this.** Each up channel is given an ordinary funnel stream, so
    /// the bytes arrive as `StreamData` like any other stream and the client's existing decoders --
    /// terminals, graphs, the `pipe` decoder and its throughput stats -- work unchanged. Input for a
    /// down channel travels the other way on the same stream. Inventing a request per chunk would
    /// have duplicated the funnel for no gain.
    ///
    /// `stream_id` names the **controller gdb stream**, not an RTT stream: it is whose mux the
    /// engine reads target memory through.
    #[serde(rename = "startRtt")]
    StartRtt { stream_id: u8, config: RttStartConfig },

    /// Stop the Agent's RTT engine and dismantle its streams. A `StreamClosed` follows for each, so
    /// the client tears its listeners down the same way it does for any stream that ends.
    #[serde(rename = "stopRtt")]
    StopRtt,

    #[serde(rename = "duplicateStream")]
    DuplicateStream { stream_id: u8 },

    /// The client's local consumer for this stream has gone away.
    ///
    /// The Agent cannot see this for itself: a stream's consumer terminates on the *client* side, and
    /// the funnel carries no signal for it — which is why the Agent used to hold a connection to the
    /// gdb-server open for a consumer that had left, feeding a stream nobody would read and, for a
    /// duplicated gdb stream, holding a `-gdb-max-connections` slot for nothing.
    ///
    /// A duplicate is dismantled completely; the original stream keeps its port and becomes
    /// connectable again with `StartStream`. No `StreamClosed` event follows — the client asked for
    /// this and already knows.
    #[serde(rename = "closeStream")]
    CloseStream { stream_id: u8 },

    #[serde(rename = "heartbeat")]
    Heartbeat,

    #[serde(rename = "syncFile")]
    SyncFile { relative_path: String, content: Vec<u8> },

    /// Open (or reconfigure) a serial port. The `transport` field in `SerialParams`
    /// selects `direct` (TCP bridge) or `funnel` (multiplexed on this connection).
    #[serde(rename = "serial.open")]
    SerialOpen(SerialParams),

    #[serde(rename = "serial.close")]
    SerialClose { path: String },

    #[serde(rename = "serial.listOpen")]
    SerialListOpen,

    #[serde(rename = "serial.listAvailable")]
    SerialListAvailable,

    /// Pull-based status probe — consistent with the client-driven heartbeat model.
    #[serde(rename = "serial.isOpen")]
    SerialIsOpen { path: String },

    /// Subscribe this connection to debounced available-port snapshots.
    #[serde(rename = "serial.subscribeAvailable")]
    SerialSubscribeAvailable,

    /// Unsubscribe this connection from available-port snapshots.
    #[serde(rename = "serial.unsubscribeAvailable")]
    SerialUnsubscribeAvailable,
}

impl ControlRequest {
    /// The wire `method` name, for logging.
    ///
    /// Kept as an explicit match rather than derived from serde so that adding a
    /// request variant fails to compile until it is named here — a request that
    /// logs as "unknown" is worse than no log at all. These strings must match the
    /// `#[serde(rename = ...)]` attributes above.
    pub fn method_name(&self) -> &'static str {
        match self {
            ControlRequest::Initialize { .. } => "initialize",
            ControlRequest::AllocatePorts { .. } => "allocatePorts",
            ControlRequest::StartGdbServer { .. } => "startGdbServer",
            ControlRequest::EndSession => "endSession",
            ControlRequest::StreamStatus { .. } => "streamStatus",
            ControlRequest::StartStream { .. } => "startStream",
            ControlRequest::DuplicateStream { .. } => "duplicateStream",
            ControlRequest::CloseStream { .. } => "closeStream",
            ControlRequest::StartRtt { .. } => "startRtt",
            ControlRequest::StopRtt => "stopRtt",
            ControlRequest::Heartbeat => "heartbeat",
            ControlRequest::SyncFile { .. } => "syncFile",
            ControlRequest::SerialOpen(..) => "serial.open",
            ControlRequest::SerialClose { .. } => "serial.close",
            ControlRequest::SerialListOpen => "serial.listOpen",
            ControlRequest::SerialListAvailable => "serial.listAvailable",
            ControlRequest::SerialIsOpen { .. } => "serial.isOpen",
            ControlRequest::SerialSubscribeAvailable => "serial.subscribeAvailable",
            ControlRequest::SerialUnsubscribeAvailable => "serial.unsubscribeAvailable",
        }
    }
}

#[derive(Debug, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "proxy-protocol/")]
pub struct ControlMessage {
    pub seq: u64,
    #[serde(flatten)]
    pub request: ControlRequest,
}

// ── Control responses ─────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "proxy-protocol/")]
pub struct ControlResponse {
    /** Sequence number of the request this response corresponds to */
    pub seq: u64,
    /** Indicates whether the request was successful */
    pub success: bool,
    /** Error message if success is false */
    pub message: Option<String>,
    /** Optional response data for successful requests */
    pub data: Option<ControlResponseData>,
}

#[derive(Debug, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "proxy-protocol/")]
pub enum StreamStatus {
    NotAvailable,
    Ready,
    Connected,
    Closed,
    TimedOut,
}

/// One entry in a `serial.listOpen` response.
#[derive(Debug, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "proxy-protocol/")]
pub struct SerialPortInfo {
    /// Current configuration (includes the `transport` field).
    pub params: SerialParams,
    /// TCP port the direct bridge is listening on, if any direct client asked for one.
    pub tcp_port: Option<u16>,
    /// Funnel stream IDs attached to this port, ascending. Plural because transports
    /// are additive: a port can carry several funnel channels (one per client, plus
    /// one per reconnect) at the same time as a direct bridge.
    pub channel_ids: Vec<u8>,
}

#[derive(Debug, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "proxy-protocol/")]
pub enum ControlResponseData {
    #[serde(rename = "initialize")]
    Initialize {
        version: String,
        /// Which *build* of `version` is answering: short commit hash, plus `+dirty`.
        ///
        /// Reported on the connection the session will actually use, which makes it the strongest
        /// identity available -- stronger than the discovery anchor, which describes whichever
        /// daemon last wrote the file. `version` cannot answer "did my rebuild take effect",
        /// because every build between two releases shares it.
        build: String,
        /// The Agent process serving this session. A pid that has not changed across a rebuild is
        /// the signature of a daemon that never exited to pick it up.
        pid: u32,
        server_cwd: String,
    },

    #[serde(rename = "allocatePorts")]
    AllocatePorts { ports: Vec<PortReserved> },

    #[serde(rename = "startGdbServer")]
    StartGdbServer { pid: u32 },

    #[serde(rename = "streamStatus")]
    StreamStatus {
        stream_id: u8,
        status: StreamStatus,
        msg_seq: u64,
    },

    /// One entry per **up** channel, in the order they were requested. The client binds a local
    /// listener for each, exactly as it does for a gdb-server port, and its existing decoders
    /// connect to those -- which is why Agent-side RTT needs no new data path.
    #[serde(rename = "startRtt")]
    StartRtt { channels: Vec<RttChannelStream> },

    /// `stopRtt`: whether an engine was running to stop.
    #[serde(rename = "stopRtt")]
    StopRtt { was_running: bool },

    #[serde(rename = "heartbeat")]
    Heartbeat,

    /// `serial.open` response: transport-specific connection info.
    #[serde(rename = "serial.open")]
    SerialOpen {
        path: String,
        /// TCP port the direct bridge listens on (`transport == "direct"`).
        #[serde(skip_serializing_if = "Option::is_none")]
        tcp_port: Option<u16>,
        /// Funnel stream ID (`transport == "funnel"`).
        #[serde(skip_serializing_if = "Option::is_none")]
        channel_id: Option<u8>,
    },

    /// `serial.close` response: success=true is sufficient.
    #[serde(rename = "serial.close")]
    SerialClose,

    #[serde(rename = "serial.listOpen")]
    SerialListOpen { ports: Vec<SerialPortInfo> },

    #[serde(rename = "serial.listAvailable")]
    SerialListAvailable { ports: Vec<AvailablePort> },

    #[serde(rename = "serial.isOpen")]
    SerialIsOpen {
        open: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        tcp_port: Option<u16>,
        /// Funnel stream IDs on this port, ascending; empty when none are attached.
        channel_ids: Vec<u8>,
        #[serde(skip_serializing_if = "Option::is_none")]
        params: Option<SerialParams>,
    },

    #[serde(rename = "serial.subscribeAvailable")]
    SerialSubscribeAvailable { revision: u64 },

    #[serde(rename = "serial.unsubscribeAvailable")]
    SerialUnsubscribeAvailable,
}

impl ControlResponse {
    pub fn success(seq: u64, data: Option<ControlResponseData>) -> Self {
        Self {
            seq,
            success: true,
            message: None,
            data,
        }
    }

    pub fn error(seq: u64, message: String) -> Self {
        Self {
            seq,
            success: false,
            message: Some(message),
            data: None,
        }
    }

    pub fn send(&self, writer: &super::FrameWriter) -> io::Result<()> {
        eprintln!("Sending response: {:?}", self);
        let response_bytes = serde_json::to_vec(self)?;
        writer.write_frame(StreamId::Control.to_u8(), &response_bytes)?;
        Ok(())
    }
}

// ── Server-to-client async events ────────────────────────────────────────────

/**
 * Responses are different from events as they represent the result of a request, while events are
 * notifications from the server
 * */
#[derive(Debug, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "proxy-protocol/")]
#[serde(tag = "event", content = "params")]
pub enum ProxyServerEvents {
    #[serde(rename = "gdbServerLaunched")]
    GdbServerLaunched { pid: u32, port: u16 },

    #[serde(rename = "gdbServerExited")]
    GdbServerExited { pid: u32, exit_code: i32 },

    #[serde(rename = "streamReady")]
    StreamReady { stream_id: u8, port: u16 },

    #[serde(rename = "streamClosed")]
    StreamClosed { stream_id: u8 },

    #[serde(rename = "streamTimedOut")]
    StreamTimedOut { stream_id: u8 },

    /// A serial port encountered a fatal post-open error.
    /// The transport for this port closes immediately after this event.
    /// The server removes the port from its registry; call `serial.open` to re-open.
    #[serde(rename = "serial.portError")]
    SerialPortError {
        path: String,
        kind: SerialErrorKind,
        msg: String,
    },

    /// Debounced full snapshot of currently available serial ports.
    #[serde(rename = "serial.availableChanged")]
    SerialAvailableChanged { revision: u64, ports: Vec<AvailablePort> },

    /// The Agent's RTT engine found and validated the control block.
    ///
    /// `startRtt` answers as soon as the search has **begun**, because how long it takes is a
    /// property of the firmware and not of us: `defmt-rtt` and SEGGER's own implementation both
    /// initialise RTT lazily, so a session stopped at `main`, or at a breakpoint the user set before
    /// the first log call, has no control block at all yet. It can be under a millisecond or it can
    /// be minutes. This is the event that says data is about to flow.
    ///
    /// Not a success/failure pair: failing to find it is not a failure, it is waiting. The engine
    /// keeps looking, and `rttStopped` is what says it has given up.
    #[serde(rename = "rttReady")]
    RttReady {
        /// Where the control block was found, for confirming it against the ELF symbol.
        cb_address: String,
        /// What the block itself says, which may be fewer than the channels that were asked for --
        /// worth comparing, since a decoder naming a channel the firmware never allocated will
        /// simply never produce anything.
        up_channels: u32,
        down_channels: u32,
        /// How long the search ran, in milliseconds. Almost always the firmware rather than us.
        search_ms: u64,
    },

    /// The RTT engine's own counters, periodically.
    ///
    /// **Cumulative, not windowed**, and deliberately: the client keeps the previous sample and
    /// subtracts, so a dropped or delayed event costs accuracy in one window rather than losing the
    /// bytes from the running total.
    ///
    /// These exist because the only throughput figure the client can produce by itself is its
    /// consumer's `msgs/sec`, and a `msg` there is one TCP buffer, not one drain -- on a fast probe
    /// several drains arrive coalesced, so bytes-per-drain reads high and drains-per-second low, by
    /// an amount that varies per probe. The number that actually sets RTT throughput is **round
    /// trips**, and only the engine can count those.
    #[serde(rename = "rttStats")]
    RttStats {
        /// Bytes delivered to the client, and bytes written to down channels.
        bytes_up: u64,
        bytes_down: u64,
        /// Drains that moved at least one byte.
        drains: u64,
        /// Passes that found nothing. Climbing means the firmware had nothing for us, so throughput
        /// is its production rate rather than our cost.
        idle: u64,
        /// Passes skipped because the multiplexer would not let a packet out. Climbing means GDB's
        /// traffic on the shared connection, not the probe.
        gated: u64,
        /// Failed passes, and the split by cause -- one total cannot be acted on, because a
        /// descriptor that failed validation, a server that mangled a reply and a read that timed
        /// out are three unrelated problems. The Agent is the only side that still knows which.
        errors: u64,
        err_invalid: u64,
        err_rejected: u64,
        err_timeout: u64,
        err_other: u64,
        /// Memory reads and writes issued. Their sum is round trips.
        reads: u64,
        writes: u64,
        /// Milliseconds since the control block was found, which is when the counters started.
        elapsed_ms: u64,
    },

    /// The Agent's RTT engine has stopped and will produce nothing further, with the reason.
    ///
    /// Sent whether it was asked to stop or gave up on its own, so a client never has to infer the
    /// difference between "RTT ended" and "RTT went quiet".
    #[serde(rename = "rttStopped")]
    RttStopped { reason: String },
}

impl ProxyServerEvents {
    pub fn send(&self, writer: &super::FrameWriter) -> io::Result<()> {
        let event_bytes = serde_json::to_vec(self)?;
        writer.write_frame(StreamId::Control.to_u8(), &event_bytes)
    }
}

#[cfg(test)]
mod stream_kind_tests {
    use super::*;

    #[test]
    fn core_zero_has_no_suffix() {
        // `createPortName` suffixes only when procNum != 0, so core 0 is the bare
        // base name. Matching the literal `gdbPort1` would miss nearly every session.
        assert_eq!(
            StreamKind::classify("gdbPort"),
            StreamKind::GdbRsp {
                core: 0,
                role: StreamRole::Controller
            }
        );
        assert_eq!(StreamKind::classify("swoPort"), StreamKind::Swo { core: 0 });
        assert_eq!(StreamKind::classify("consolePort"), StreamKind::Console { core: 0 });
    }

    #[test]
    fn higher_cores_carry_their_number() {
        for core in 1u16..=4 {
            assert_eq!(
                StreamKind::classify(&format!("gdbPort{core}")),
                StreamKind::GdbRsp {
                    core,
                    role: StreamRole::Controller
                }
            );
            assert_eq!(
                StreamKind::classify(&format!("swoPort{core}")),
                StreamKind::Swo { core }
            );
        }
    }

    #[test]
    fn tcl_and_telnet_are_not_per_core() {
        assert_eq!(StreamKind::classify("tclPort"), StreamKind::Tcl);
        assert_eq!(StreamKind::classify("tclPort1"), StreamKind::Tcl);
        assert_eq!(StreamKind::classify("telnetPort"), StreamKind::Telnet);
    }

    #[test]
    fn stlinks_gap_placeholders_are_not_mistaken_for_cores() {
        // ST-LINK reserves ports named `gap1`/`gap2` purely to keep a block
        // consecutive. Stripping trailing digits would read `gap1` as base `gap`
        // core 1 -- and for core 1 `createPortName` produces `gap11`, which is
        // worse. Requiring a known prefix makes the question moot.
        for name in ["gap1", "gap2", "gap11", "gap21"] {
            assert_eq!(StreamKind::classify(name), StreamKind::Other, "{name}");
            assert!(StreamKind::classify(name).core().is_none());
            assert!(!StreamKind::classify(name).is_rsp_controller());
        }
    }

    #[test]
    fn a_known_prefix_followed_by_non_digits_is_not_a_match() {
        // Guards the prefix rule against a future name that merely starts the same.
        for name in ["gdbPortExtra", "gdbPort1a", "swoPortX", "gdbPortsomething"] {
            assert_eq!(StreamKind::classify(name), StreamKind::Other, "{name}");
        }
    }

    #[test]
    fn every_name_every_server_controller_asks_for_classifies() {
        // The union of `portsNeeded` across all server controllers in
        // `packages/mcu-debug/src/adapter/servers/`, for cores 0..2. Nothing may
        // panic, and every gdb port must come out as a controller RSP stream.
        let bases = [
            "gdbPort",     // all servers
            "swoPort",     // jlink, pemicro, probe-rs, pyocd, stlink, openocd
            "consolePort", // jlink, pemicro, probe-rs, pyocd
            "tclPort",     // openocd
            "telnetPort",  // openocd
            "gap1",        // stlink
            "gap2",        // stlink
        ];
        for core in 0u16..3 {
            for base in bases {
                let name = if core == 0 {
                    base.to_string()
                } else {
                    format!("{base}{core}")
                };
                let kind = StreamKind::classify(&name);
                if base == "gdbPort" {
                    assert!(kind.is_rsp_controller(), "{name} should be a controller RSP stream");
                    assert_eq!(kind.core(), Some(core), "{name}");
                } else {
                    assert!(!kind.is_rsp_controller(), "{name} must not be an RSP stream");
                }
            }
        }
    }

    #[test]
    fn only_a_controller_gdb_stream_may_host_the_mux() {
        let controller = StreamKind::GdbRsp {
            core: 0,
            role: StreamRole::Controller,
        };
        let secondary = StreamKind::GdbRsp {
            core: 0,
            role: StreamRole::Secondary,
        };
        assert!(controller.is_rsp_controller());
        // The live-watch GDB's stream. A mux here would never see a resume, so its
        // run-state model would never leave `Unknown` (gdb-rsp.md §4.7).
        assert!(!secondary.is_rsp_controller());
        assert!(!StreamKind::Swo { core: 0 }.is_rsp_controller());
        assert!(!StreamKind::Other.is_rsp_controller());
    }

    #[test]
    fn only_diagnostic_output_may_be_throttled() {
        // Stream-Flow-Control.md: dropping RSP corrupts the protocol; serial and SWO
        // are user-rate-controlled. Only the gdb-server's own logging firehoses.
        assert!(StreamKind::Stdout.is_throttleable());
        assert!(StreamKind::Stderr.is_throttleable());
        for kind in [
            StreamKind::Control,
            StreamKind::GdbRsp {
                core: 0,
                role: StreamRole::Controller,
            },
            StreamKind::Swo { core: 0 },
            StreamKind::Console { core: 0 },
            StreamKind::Tcl,
            StreamKind::Telnet,
            StreamKind::Other,
        ] {
            assert!(!kind.is_throttleable(), "{kind:?} must never be throttled");
        }
    }
}
