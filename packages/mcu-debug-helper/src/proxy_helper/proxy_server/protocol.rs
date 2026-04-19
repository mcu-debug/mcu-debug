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
use serde_json::Value;
use std::collections::HashMap;
use std::io;
use std::net::TcpStream;

use crate::proxy_helper::run::PortWaitMode;
use crate::serial::port::{PortErrorEvent, SerialErrorKind, SerialParams};
use crate::serial::AvailablePort;

// ── Funnel event (unified event channel) ─────────────────────────────────────

/// Unified event type for the main event loop. All background threads
/// (control-stream reader, port waiters, stdout/stderr forwarders) send events
/// through one channel so `message_loop` can block on `recv()` instead of
/// polling + sleeping.
pub enum ProxyEvent {
    /// Raw bytes received from the client TCP connection.
    IncomingData(Vec<u8>),
    /// Client connection closed (EOF or error).
    IncomingClosed,
    /// A port waiter successfully connected to the gdb-server port.
    PortConnected {
        stream_id: u8,
        port: u16,
        stream: TcpStream,
        /// One-shot ack from main loop after stream is registered in `self.streams`,
        /// so forwarding cannot start before the write-end is registered.
        ready_tx: std::sync::mpsc::Sender<()>,
        /// Sequence number of the original `StartStream` request; used for sending
        /// the `StreamStatus` response (0 = unsolicited / auto-connect).
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
    /// A serial port's reader thread hit a fatal error.
    /// The port should be removed from the registry and the client notified.
    SerialPortError(PortErrorEvent),
}

// ── Misc shared types ─────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, ts_rs::TS)]
#[ts(type = "any", export, export_to = "proxy-protocol/")]
pub struct JsonValue(pub Value);

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
        /** Port wait mode for this session */
        port_wait_mode: Option<PortWaitMode>,
    },

    #[serde(rename = "allocatePorts")]
    AllocatePorts {
        /** Number of consecutive ports needed */
        ports_spec: PortAllocatorSpec,
    },

    #[serde(rename = "startGdbServer")]
    StartGdbServer {
        /** Launch configuration arguments */
        config_args: JsonValue,
        /** Path to the gdb-server executable on the host machine */
        server_path: String,
        /** Arguments to launch the gdb-server with */
        server_args: Vec<String>,
        /** Environment variables for the gdb-server process */
        server_env: Option<HashMap<String, String>>,
        /** Required: Regex patterns to identify the gdb-server process from its output (e.g. "Listening on port (\d+)"), used for auto-detecting the port if not specified in server_args */
        server_regexes: Vec<String>,
    },

    #[serde(rename = "endSession")]
    EndSession,

    #[serde(rename = "streamStatus")]
    StreamStatus { stream_id: u8 },

    #[serde(rename = "startStream")]
    StartStream { stream_id: u8 },

    #[serde(rename = "duplicateStream")]
    DuplicateStream { stream_id: u8 },

    #[serde(rename = "heartbeat")]
    Heartbeat,

    #[serde(rename = "syncFile")]
    SyncFile {
        relative_path: String,
        content: Vec<u8>,
    },

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
    /// TCP port the direct bridge is listening on (`transport == "direct"`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tcp_port: Option<u16>,
    /// Funnel stream ID assigned to this port (`transport == "funnel"`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<u8>,
}

#[derive(Debug, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "proxy-protocol/")]
pub enum ControlResponseData {
    #[serde(rename = "initialize")]
    Initialize { version: String, server_cwd: String },

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
        #[serde(skip_serializing_if = "Option::is_none")]
        channel_id: Option<u8>,
        #[serde(skip_serializing_if = "Option::is_none")]
        params: Option<SerialParams>,
    },
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

    pub fn send(&self, stream: &mut TcpStream) -> io::Result<()> {
        eprintln!("Sending response: {:?}", self);
        let response_bytes = serde_json::to_vec(self)?;
        super::send_to_stream(StreamId::Control.to_u8(), stream, &response_bytes)?;
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

    #[serde(rename = "streamStarted")]
    StreamStarted { stream_id: u8, port: u16 },

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
}

impl ProxyServerEvents {
    pub fn send(&self, stream: &mut TcpStream) -> io::Result<()> {
        let event_bytes = serde_json::to_vec(self)?;
        super::send_to_stream(StreamId::Control.to_u8(), stream, &event_bytes)
    }
}
