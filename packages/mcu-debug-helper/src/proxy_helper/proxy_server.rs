use anyhow::Result;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;

use anyhow::anyhow;
use std::collections::HashMap;
use std::env;
use std::fs;
use std::io;
use std::io::Read;
use std::io::Write;
use std::net::TcpListener;
use std::net::TcpStream;
use std::path::Path;
use std::path::PathBuf;
use std::process::Child;
use std::process::Command;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const CURRENT_VERSION: &str = "1.0.3";
static STREAM_MUTEX: Mutex<()> = Mutex::new(()); // Global mutex to synchronize access to the main stream for sending responses/events

use crate::common::tcpports::reserve_free_ports;
use crate::proxy_helper::port_monitor::wait_for_ports;
use crate::proxy_helper::run::PortWaitMode;
use crate::proxy_helper::run::ProxyArgs;

macro_rules! eprintln {
    ($($arg:tt)*) => {
        log::info!($($arg)*);
    };
}

pub fn send_to_stream(stream_id: u8, stream: &mut TcpStream, bytes: &[u8]) -> io::Result<()> {
    let _lock = STREAM_MUTEX.lock().expect("failed to acquire stream lock"); // Acquire the global mutex before sending
    let mut header = Vec::with_capacity(5);
    header.push(stream_id);
    header.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
    stream.write_all(&header)?;
    stream.write_all(bytes)?;
    stream.flush()?;
    Ok(())
}

fn read_and_forward<R: Read>(stream_id: u8, mut reader: R, tx: Sender<ProxyEvent>) {
    let mut buffer = [0; 4096]; // Larger buffer for performance
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => {
                // EOF
                tx.send(ProxyEvent::StreamClosed { stream_id }).ok();
                break;
            }
            Ok(n) => {
                let data = buffer[..n].to_vec();
                if tx.send(ProxyEvent::StreamData { stream_id, data }).is_err() {
                    break; // Main thread died
                }
            }
            Err(_) => {
                tx.send(ProxyEvent::StreamClosed { stream_id }).ok();
                break;
            }
        }
    }
}

// Unified event type for the main event loop. All background threads (control-stream
// reader, port waiters, stdout/stderr forwarders) send events through one channel so
// message_loop can block on recv() instead of polling + sleeping.
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
        ready_tx: Sender<()>, // One-shot ack from main loop after stream is registered in self.streams
        msg_seq: u64, // Sequence number of the original StartStream request that triggered this connection, used for sending the StreamStatus response
    },
    /// A port is ready for a connection, client can now connect to the forwarded port, but we won't forward data until they do
    PortReady { stream_id: u8, port: u16 },

    /// A port waiter failed to connect.
    PortFailed {
        stream_id: u8,
        port: u16,
        error: String,
        msg_seq: u64, // Sequence number of the original StartStream request that triggered this connection, used for sending the StreamStatus response
    },
    /// Data received from a forwarded stream (stdout, stderr, GDB RSP, …).
    StreamData { stream_id: u8, data: Vec<u8> },
    /// A forwarded stream closed.
    StreamClosed { stream_id: u8 },
}

#[derive(Debug, Serialize, Deserialize, ts_rs::TS)]
#[ts(type = "any", export, export_to = "proxy-protocol/")]
pub struct JsonValue(pub Value);

#[derive(Debug, Serialize, Deserialize, Hash, Eq, PartialEq, ts_rs::TS)]
#[ts(type = "any", export, export_to = "proxy-protocol/")]
#[repr(u8)]
pub enum StreamId {
    Control = 0, // Control stream for JSON-RPC messages (e.g. initialize, startStream, streamStatus, heartbeat). This is created on connection and always available.
    Stdout = 1, // Binary stream for forwarding the gdb-server process stdout. Created when the gdb-server process is launched and closed when it exits.
    Stderr = 2, // Separate stream for stderr of the gdb-server process. Created when the gdb-server process is launched and closed when it exits. This allows us to separate normal output from error messages, which can be useful for debugging and user feedback.
    GdbRsp = 3, // This is the only special stream. It carries the raw GDB Remote Serial Protocol bytes to/from the gdb-server.
    Other(u8), // This can be anything else. SWO, RTT, Tcl, or future extensions. The client and server can agree on the meaning of these stream IDs as needed. The proxy just forwards bytes without interpreting them.
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

/** These ports are allocated as a group, consecutively */
#[derive(Debug, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "proxy-protocol/")]
pub struct PortSet {
    /** Use it as starting port if possible. 0 means any available port, but still consecutive */
    start_port: u16,
    /** List of id strings to identify this port. Should be unique across the entire session */
    port_ids: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "proxy-protocol/")]
pub struct PortReserved {
    /** Actual port number of server     */
    port: u16,
    /** The stream-id used to connect to this port */
    stream_id: u8,
    /** String representation of the stream-id, as specified by the client */
    stream_id_str: String,
}

#[derive(Debug, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "proxy-protocol/")]
pub struct PortAllocatorSpec {
    /** List of all allocated port sets */
    all_ports: Vec<PortSet>,
}

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
        remote_launch_uid: String,
        /** Port wait mode for this session */
        port_wait_mode: Option<PortWaitMode>, // If specified, overrides the default port wait mode for this session. This allows the client to choose the strategy that works best for its environment and needs, without requiring different builds of the proxy helper.
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

    /** Get the status of a stream */
    #[serde(rename = "streamStatus")]
    StreamStatus { stream_id: u8 },

    /** Open the stream now that the port is ready */
    #[serde(rename = "startStream")]
    StartStream { stream_id: u8 },

    /** Duplicate an existing stream */
    #[serde(rename = "duplicateStream")]
    DuplicateStream { stream_id: u8 },

    /** Heartbeat message to keep the connection alive */
    #[serde(rename = "heartbeat")]
    Heartbeat,

    /** Sync a file to the remote server */
    #[serde(rename = "syncFile")]
    SyncFile {
        relative_path: String,
        content: Vec<u8>,
    },
}

#[derive(Debug, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "proxy-protocol/")]
pub struct ControlMessage {
    pub seq: u64,
    #[serde(flatten)]
    pub request: ControlRequest,
}

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
    /** Server has not started listening on the port */
    NotAvailable,
    /** Server is ready to accept connections */
    Ready,
    /** Server is currently connected */
    Connected,
    /** Server has closed the connection */
    Closed,
    /** Server has timed out */
    TimedOut,
}

#[derive(Debug, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "proxy-protocol/")]
pub enum ControlResponseData {
    /** Initialize response: Just a version string */
    #[serde(rename = "initialize")]
    Initialize {
        version: String,
        server_launch_uid: String,
    },
    /** AllocatePorts response: List of reserved ports. This is a flat list in the same order as what was requested */
    #[serde(rename = "allocatePorts")]
    AllocatePorts { ports: Vec<PortReserved> },
    /** StartGdbServer response: PID of the launched GDB server */
    #[serde(rename = "startGdbServer")]
    StartGdbServer { pid: u32 },
    /** StreamStatus response: Status of a specific stream */
    #[serde(rename = "streamStatus")]
    StreamStatus {
        stream_id: u8,
        status: StreamStatus,
        msg_seq: u64,
    },
    /** Heartbeat response: Acknowledgment of heartbeat */
    #[serde(rename = "heartbeat")]
    Heartbeat,
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
        send_to_stream(StreamId::Control.to_u8(), stream, &response_bytes)?;
        Ok(())
    }
}

/**
 * Responses are different from events as they represent the result of a request, while events are
 * notifications from the server
 * */
#[derive(Debug, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "proxy-protocol/")]
#[serde(tag = "event", content = "params")]
pub enum ProxyServerEvents {
    /** GDB server has been launched */
    #[serde(rename = "gdbServerLaunched")]
    GdbServerLaunched { pid: u32, port: u16 },
    /** GDB server has exited */
    #[serde(rename = "gdbServerExited")]
    GdbServerExited { pid: u32, exit_code: i32 },
    /** Stream has started */
    #[serde(rename = "streamReady")]
    StreamReady { stream_id: u8, port: u16 },
    /** Stream has started */
    #[serde(rename = "streamStarted")]
    StreamStarted { stream_id: u8, port: u16 },
    /** Stream has closed */
    #[serde(rename = "streamClosed")]
    StreamClosed { stream_id: u8 },
    /** Stream has timed out while waiting for connection */
    #[serde(rename = "streamTimedOut")]
    StreamTimedOut { stream_id: u8 },
}

impl ProxyServerEvents {
    pub fn send(&self, stream: &mut TcpStream) -> io::Result<()> {
        let event_bytes = serde_json::to_vec(self)?;
        send_to_stream(StreamId::Control.to_u8(), stream, &event_bytes)
    }
}

pub struct PortInfo {
    pub port: u16,
    pub stream_id: u8,
    stream: Option<TcpStream>, // Will be Some if the port is currently allocated and connected
}

pub struct PortInfoListner {
    pub port: u16,
    pub stream_id: u8,
    #[allow(dead_code)]
    listener: Option<TcpListener>, // Will be Some if the port is currently allocated and connected
}

pub struct ProxyServer {
    args: ProxyArgs,
    stream: TcpStream,
    process: Option<Child>,
    /** For each stream ID, maintain a separate TCP stream connected to the server */
    streams: HashMap<u8, PortInfo>,
    next_stream_id: u8, // Counter to assign unique stream IDs for new streams
    exit: bool,

    // We reserve/allocate these ports and wait until the gdb-server is launched
    reserved_ports: Vec<PortInfoListner>,

    // Unified event channel: every background thread (control-stream reader,
    // port waiters, stdout/stderr forwarders) sends ProxyEvent here.
    event_rx: Receiver<ProxyEvent>,
    event_tx: Sender<ProxyEvent>,

    server_launch_uid: String,

    session_port_wait_mode: PortWaitMode,
    monitor_stop_tx: Option<Sender<()>>,
}

impl ProxyServer {
    pub fn new(args: ProxyArgs, stream: TcpStream) -> Self {
        let (event_tx, event_rx) = channel();
        let session_port_wait_mode = args.port_wait_mode.clone();

        Self {
            args,
            stream,
            process: None,
            streams: HashMap::new(),
            exit: false,
            reserved_ports: Vec::new(),
            event_rx,
            event_tx,
            next_stream_id: 3,
            server_launch_uid: String::new(),
            session_port_wait_mode,
            monitor_stop_tx: None,
        }
    }

    fn stop_port_monitor(&mut self) {
        if let Some(tx) = self.monitor_stop_tx.take() {
            tx.send(()).ok();
        }
    }

    pub fn end_process(&mut self) {
        self.stop_port_monitor();
        if let Some(child) = &mut self.process {
            let _ = child.kill();
            let _ = child.wait();
            self.process = None;
        }
    }

    pub fn message_loop(&mut self) -> Result<()> {
        // Spawn a dedicated reader thread for the client connection so that the event
        // loop can block on event_rx.recv() and wake up instantly for *any* event
        // (incoming data, port connection, forwarded stream data) without ever blocking
        // on a stream read in the main thread.
        let control_stream = self.stream.try_clone()?;
        let event_tx = self.event_tx.clone();
        std::thread::spawn(move || {
            let mut reader = control_stream;
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => {
                        event_tx.send(ProxyEvent::IncomingClosed).ok();
                        break;
                    }
                    Ok(n) => {
                        if event_tx
                            .send(ProxyEvent::IncomingData(buf[..n].to_vec()))
                            .is_err()
                        {
                            break; // main thread exited
                        }
                    }
                    Err(e) => {
                        eprintln!("Control stream read error: {}", e);
                        event_tx.send(ProxyEvent::IncomingClosed).ok();
                        break;
                    }
                }
            }
        });

        let mut content_length: Option<u32> = None;
        let mut stream_id = 0u8;
        let mut all_bytes = Vec::new();

        loop {
            let event = match self.event_rx.recv() {
                Ok(e) => e,
                Err(_) => break, // all senders dropped
            };
            match event {
                ProxyEvent::IncomingClosed => {
                    eprintln!("Client connection closed");
                    self.end_process();
                    break;
                }
                ProxyEvent::IncomingData(bytes) => {
                    all_bytes.extend_from_slice(&bytes);
                    while !all_bytes.is_empty() {
                        if content_length.is_none() {
                            if all_bytes.len() >= 5 {
                                stream_id = all_bytes[0];
                                content_length =
                                    Some(u32::from_le_bytes(all_bytes[1..5].try_into().unwrap()));
                                all_bytes.drain(..5);
                            } else {
                                break; // wait for more bytes
                            }
                        } else if content_length.unwrap() as usize <= all_bytes.len() {
                            let msg_len = content_length.unwrap() as usize;
                            let msg = all_bytes[..msg_len].to_vec();
                            if stream_id == 0 {
                                // Control message (JSON)
                                let msg_str = String::from_utf8_lossy(&msg);
                                match serde_json::from_str::<ControlMessage>(&msg_str) {
                                    Ok(control_msg) => {
                                        self.handle_control_message(control_msg);
                                        if self.exit {
                                            eprintln!("Exiting message loop as requested by control message");
                                            return Ok(());
                                        }
                                    }
                                    Err(e) => {
                                        eprintln!("Failed to parse control message: {}", e);
                                    }
                                }
                            } else {
                                // Forward to the appropriate connected stream
                                match self.streams.get_mut(&stream_id) {
                                    Some(pinfo) => {
                                        if let Some(stream) = &mut pinfo.stream {
                                            if let Err(e) = stream.write_all(&msg) {
                                                eprintln!(
                                                    "Stream {} write failed: {}",
                                                    stream_id, e
                                                );
                                                // TODO: remove the stream, notify the DA
                                            }
                                        } else {
                                            eprintln!(
                                                "Stream {} is not currently connected",
                                                stream_id
                                            );
                                        }
                                    }
                                    None => {
                                        eprintln!(
                                            "Received message for unknown stream ID: {}",
                                            stream_id
                                        );
                                    }
                                }
                            }
                            all_bytes.drain(..msg_len);
                            content_length = None;
                        } else {
                            break; // wait for the rest of the message
                        }
                    }
                }
                ProxyEvent::PortConnected {
                    stream_id,
                    port,
                    stream,
                    ready_tx,
                    msg_seq,
                } => {
                    eprintln!("Port {} (stream {}) connected!", port, stream_id);
                    if let Some(pinfo) = self.streams.get_mut(&stream_id) {
                        pinfo.stream = Some(stream);
                    } else {
                        eprintln!("Internal Error: Received PortConnected for unknown stream_id {}, this should not happen", stream_id);
                        self.streams.insert(
                            stream_id,
                            PortInfo {
                                port,
                                stream_id,
                                stream: Some(stream),
                            },
                        );
                    }
                    // Unblock the waiter thread only after stream registration is visible
                    // in self.streams, so forwarding cannot start before this point.
                    ready_tx.send(()).ok();
                    if msg_seq != 0 {
                        let data = ControlResponseData::StreamStatus {
                            stream_id,
                            status: StreamStatus::Connected,
                            msg_seq,
                        };
                        ControlResponse::success(msg_seq, Some(data))
                            .send(&mut self.stream)
                            .unwrap_or_else(|e| {
                                eprintln!("Failed to send success response: {}", e);
                            });
                    } else {
                        let event = ProxyServerEvents::StreamStarted { stream_id, port };
                        let _ = event.send(&mut self.stream);
                    }
                }
                ProxyEvent::PortReady { stream_id, port } => {
                    eprintln!(
                        "Port {} (stream {}) is ready for connection!",
                        port, stream_id
                    );
                    self.streams.insert(
                        stream_id,
                        PortInfo {
                            port,
                            stream_id,
                            stream: None,
                        },
                    );
                    let event = ProxyServerEvents::StreamReady { stream_id, port };
                    let _ = event.send(&mut self.stream);
                }
                ProxyEvent::PortFailed {
                    stream_id,
                    port,
                    error,
                    msg_seq,
                } => {
                    if msg_seq != 0 {
                        ControlResponse::error(
                            msg_seq,
                            format!(
                                "Failed to connect to port {}, stream-id {}: {}",
                                port, stream_id, error
                            ),
                        )
                        .send(&mut self.stream)
                        .unwrap_or_else(|e| {
                            eprintln!("Failed to send error response: {}", e);
                        });
                    } else {
                        let event = ProxyServerEvents::StreamTimedOut { stream_id };
                        eprintln!("Port {} failed: {} for stream {}", port, error, stream_id);
                        let _ = event.send(&mut self.stream);
                    }
                }
                ProxyEvent::StreamData { stream_id, data } => {
                    send_to_stream(stream_id, &mut self.stream, &data).ok();
                }
                ProxyEvent::StreamClosed { stream_id } => {
                    eprintln!("Stream {} closed", stream_id);
                    self.streams.remove(&stream_id);
                    let event = ProxyServerEvents::StreamClosed { stream_id };
                    let _ = event.send(&mut self.stream);
                }
            }
        }
        self.end_process();
        Ok(())
    }

    fn handle_control_message(&mut self, msg: ControlMessage) {
        if msg.seq == 0 {
            ControlResponse::error(msg.seq, "Received control message with seq=0, which is reserved for server events. Ignoring.".to_string()).send(&mut self.stream).unwrap_or_else(|e| {
                eprintln!("Failed to send error response for invalid seq: {}", e);
            })  ;
            return;
        }
        match msg.request {
            ControlRequest::Initialize { .. } => {
                self.handle_initialize(&msg);
            }
            ControlRequest::AllocatePorts { .. } => {
                self.handle_allocate_ports(&msg);
            }
            ControlRequest::StartGdbServer { .. } => {
                eprintln!("Received StartGdbServer request");
                self.handle_start_gdb_server(&msg);
            }
            ControlRequest::StartStream { stream_id } => {
                eprintln!("Received StartStream request for stream_id {}", stream_id);
                self.handle_start_stream(stream_id, msg.seq);
            }
            ControlRequest::DuplicateStream { stream_id } => {
                eprintln!(
                    "Received DuplicateStream request for stream_id {}",
                    stream_id
                );
                self.handle_duplicate_stream(stream_id, msg.seq);
            }
            ControlRequest::EndSession => {
                eprintln!("Received EndSession request, closing connection");
                ControlResponse::success(msg.seq, None)
                    .send(&mut self.stream)
                    .unwrap_or_else(|e| {
                        eprintln!("Failed to send success response: {}", e);
                    });
                self.stream
                    .shutdown(std::net::Shutdown::Both)
                    .unwrap_or_else(|e| {
                        eprintln!("Failed to shutdown stream: {}", e);
                    });
                self.end_process();
                self.exit = true;
            }
            ControlRequest::Heartbeat => {
                eprintln!("Received Heartbeat request");
                ControlResponse::success(msg.seq, Some(ControlResponseData::Heartbeat))
                    .send(&mut self.stream)
                    .unwrap_or_else(|e| {
                        eprintln!("Failed to send heartbeat response: {}", e);
                    });
            }
            ControlRequest::StreamStatus { .. } => {
                let status = if let ControlRequest::StreamStatus { stream_id } = &msg.request {
                    if let Some(pinfo) = self.streams.get(stream_id) {
                        if pinfo.stream.is_some() {
                            StreamStatus::Connected
                        } else {
                            StreamStatus::Ready
                        }
                    } else {
                        StreamStatus::NotAvailable
                    }
                } else {
                    StreamStatus::NotAvailable
                };
                let data = ControlResponseData::StreamStatus {
                    stream_id: if let ControlRequest::StreamStatus { stream_id } = &msg.request {
                        *stream_id
                    } else {
                        0
                    },
                    status,
                    msg_seq: msg.seq,
                };
                ControlResponse::success(msg.seq, Some(data))
                    .send(&mut self.stream)
                    .unwrap_or_else(|e| {
                        eprintln!("Failed to send StreamStatus response: {}", e);
                    });
            }
            ControlRequest::SyncFile { .. } => {
                eprintln!("Received SyncFile request");
                self.handle_sync_file(&msg);
            }
        }
    }

    fn handle_initialize(&mut self, msg: &ControlMessage) {
        if let ControlRequest::Initialize {
            token,
            version,
            remote_launch_uid,
            port_wait_mode,
        } = &msg.request
        {
            eprintln!(
                "Received Initialize request with version {} and token {:?} and remote_launch_uid {:?} and port_wait_mode {:?}",
                version, token, remote_launch_uid, port_wait_mode
            );
            let mut err = false;
            let mut err_msg = String::new();
            if token != &self.args.token {
                err_msg = "Error: Received token does not match expected token".to_string();
                err = true;
            }
            if version != CURRENT_VERSION {
                err_msg = format!("Error: Unsupported version {}", version);
                err = true;
            }
            let dir = PathBuf::from(env::temp_dir())
                .join("mcu-proxy-server")
                .join(remote_launch_uid)
                .into_os_string()
                .into_string()
                .unwrap()
                .replace('\\', "/");
            if err != true {
                // Remove any stale files/dirs from previous runs with the same remote_launch_uid. This ensures a clean state
                // for each new session and prevents issues caused by leftover files.
                fs::remove_dir_all(&dir).ok(); // Ignore error, the directory might not exist
                match fs::create_dir_all(&dir) {
                    Ok(_) => {}
                    Err(e) => {
                        eprintln!("Failed to create directory {:?}: {}", dir, e);
                        err = true;
                        err_msg = format!("Failed to create directory {:?}: {}", dir, e);
                    }
                }
            }

            if err {
                err_msg = format!("Initialization failed, closing connection: {}", err_msg);
                eprintln!("{}", err_msg);
                // Optionally send an error response back to the client before closing
                self.stream
                    .shutdown(std::net::Shutdown::Both)
                    .unwrap_or_else(|e| {
                        eprintln!("Failed to shutdown stream: {}", e);
                    });
                ControlResponse::error(msg.seq, err_msg)
                    .send(&mut self.stream)
                    .unwrap_or_else(|e| {
                        eprintln!("Failed to send error response: {}", e);
                    });
                self.exit = true;
            } else {
                eprintln!("Initialization successful");
                self.server_launch_uid = dir.clone();
                if let Some(mode) = port_wait_mode {
                    self.session_port_wait_mode = *mode;
                }
                let data = ControlResponseData::Initialize {
                    version: CURRENT_VERSION.to_string(),
                    server_launch_uid: dir,
                };
                ControlResponse::success(msg.seq, Some(data))
                    .send(&mut self.stream)
                    .unwrap_or_else(|e| {
                        eprintln!("Failed to send success response: {}", e);
                    });
            }
        } else {
            eprintln!(
                "BUG: handle_initialize called with wrong request type: {:?}",
                msg.request
            );
            ControlResponse::error(msg.seq, "Internal error: wrong handler".to_string())
                .send(&mut self.stream)
                .ok();
        }
    }

    fn handle_allocate_ports(&mut self, msg: &ControlMessage) {
        if let ControlRequest::AllocatePorts { ports_spec } = &msg.request {
            let mut ret_vec: Vec<PortReserved> = Vec::new();
            eprintln!("Received AllocatePorts request with spec: {:?}", ports_spec);
            for port_set in &ports_spec.all_ports {
                eprintln!(
                    "PortSet: start_port={}, port_ids={:?}",
                    port_set.start_port, port_set.port_ids
                );
                let args = crate::common::tcpports::TcpPortFinderArgs {
                    consecutive: true,
                    count: port_set.port_ids.len() as u16,
                    start_port: port_set.start_port,
                };
                let ports = match reserve_free_ports(&args) {
                    Some(ports) => ports,
                    None => {
                        eprintln!(
                            "Failed to allocate requested ports for PortSet starting at {}",
                            port_set.start_port
                        );
                        ControlResponse::error(
                            msg.seq,
                            format!(
                                "Failed to allocate requested ports for PortSet starting at {}",
                                port_set.start_port
                            ),
                        )
                        .send(&mut self.stream)
                        .ok();
                        return;
                    }
                };
                let mut count = 0;
                for id_string in &port_set.port_ids {
                    let listener = ports[count].try_clone().ok(); // Clone the TcpListener to keep it alive while we wait for connections
                    let port = listener.as_ref().unwrap().local_addr().unwrap().port();
                    let tmp = PortInfoListner {
                        port: port,
                        stream_id: self.next_stream_id,
                        listener: listener, // Use the cloned listener
                    };
                    self.reserved_ports.push(tmp);
                    ret_vec.push(PortReserved {
                        port: port,
                        stream_id: self.next_stream_id,
                        stream_id_str: id_string.clone(),
                    });
                    self.next_stream_id += 1;
                    count += 1;
                }
            }
            let data = ControlResponseData::AllocatePorts { ports: ret_vec };
            ControlResponse::success(msg.seq, Some(data))
                .send(&mut self.stream)
                .unwrap_or_else(|e| {
                    eprintln!("Failed to send success response: {}", e);
                });
        } else {
            eprintln!(
                "BUG: handle_allocate_ports called with wrong request type: {:?}",
                msg.request
            );
            ControlResponse::error(msg.seq, "Internal error: wrong handler".to_string())
                .send(&mut self.stream)
                .ok();
        }
    }

    fn handle_start_gdb_server(&mut self, msg: &ControlMessage) {
        if let ControlRequest::StartGdbServer {
            config_args,
            server_path,
            server_args,
            server_env,
            server_regexes,
        } = &msg.request
        {
            self.stop_port_monitor();
            let _ = config_args;
            let _ = server_regexes;
            let ports: Vec<(u8, u16)> = self
                .reserved_ports
                .drain(..)
                .map(|plistner| {
                    // listener automatically dropped here when plistner goes out of scope
                    (plistner.stream_id, plistner.port)
                })
                .collect();
            let dir = self.server_launch_uid.clone();
            let child = match Command::new(server_path)
                .args(server_args)
                .envs(server_env.as_ref().unwrap_or(&HashMap::new()))
                .current_dir(dir)
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
            {
                Ok(child) => child,
                Err(e) => {
                    eprintln!("Failed to launch gdb-server: {}", e);
                    ControlResponse::error(msg.seq, format!("Failed to launch gdb-server: {}", e))
                        .send(&mut self.stream)
                        .ok();
                    self.exit = true;
                    return; // message_loop will see self.exit and shut down cleanly
                }
            };

            self.process = Some(child);

            // Stdout reader thread
            if let Some(stdout) = self.process.as_mut().unwrap().stdout.take() {
                let tx = self.event_tx.clone();
                std::thread::spawn(move || {
                    read_and_forward(StreamId::Stdout.to_u8(), stdout, tx);
                });
            }
            // Stderr reader thread
            if let Some(stderr) = self.process.as_mut().unwrap().stderr.take() {
                let tx = self.event_tx.clone();
                std::thread::spawn(move || {
                    read_and_forward(StreamId::Stderr.to_u8(), stderr, tx);
                });
            }

            match self.session_port_wait_mode {
                PortWaitMode::ConnectHold => {
                    self.spawn_port_waiters(ports, true, 0);
                }
                PortWaitMode::ConnectProbe => {
                    self.spawn_port_waiters(ports, false, 0);
                }
                PortWaitMode::Monitor => {
                    self.stop_port_monitor();
                    let (stop_tx, stop_rx) = channel();
                    self.monitor_stop_tx = Some(stop_tx);
                    if let Err(e) = wait_for_ports(ports, self.event_tx.clone(), stop_rx) {
                        eprintln!("Failed to start port monitor: {}", e);
                        self.monitor_stop_tx = None;
                    }
                }
            }

            let data = ControlResponseData::StartGdbServer {
                pid: self.process.as_ref().unwrap().id(),
            };
            ControlResponse::success(msg.seq, Some(data))
                .send(&mut self.stream)
                .unwrap_or_else(|e| {
                    eprintln!("Failed to send success response: {}", e);
                });
        } else {
            eprintln!(
                "BUG: handle_start_gdb_server called with wrong request type: {:?}",
                msg.request
            );
            ControlResponse::error(msg.seq, "Internal error: wrong handler".to_string())
                .send(&mut self.stream)
                .ok();
        }
    }

    fn spawn_port_waiters(&mut self, ports: Vec<(u8, u16)>, keep_open: bool, msg_seq: u64) {
        for (stream_id, port) in ports {
            let event_tx = self.event_tx.clone();

            std::thread::spawn(move || {
                let duration = if msg_seq != 0 {
                    Duration::from_millis(30) // Shorter timeout when opening on demand
                } else {
                    Duration::from_secs(10 * 60) // Longer timeout when we intend to forward the stream
                };
                match Self::wait_and_connect_sync(port, duration, keep_open) {
                    Ok(WaitPortResult::Ready(_)) => {
                        eprintln!("Port {} is ready for stream {}, but keep_open is false, not forwarding", port, stream_id);
                        // Notify main thread that the port is ready, even though we're not forwarding it
                        event_tx
                            .send(ProxyEvent::PortReady { stream_id, port })
                            .ok();
                    }
                    Ok(WaitPortResult::Stream(tcp_stream)) => {
                        eprintln!(
                            "Connected to stream_id {} port {}, starting forwarding",
                            stream_id, port
                        );

                        // Clone stream: one for reading (this thread), one for writing (main thread)
                        let read_stream = tcp_stream.try_clone().expect("Failed to clone stream");
                        let (ready_tx, ready_rx) = channel();
                        // Send the write-end to the main thread
                        if event_tx
                            .send(ProxyEvent::PortConnected {
                                stream_id,
                                port,
                                stream: tcp_stream,
                                ready_tx,
                                msg_seq,
                            })
                            .is_err()
                        {
                            eprintln!(
                                "Main loop is gone before stream {} registration, aborting forwarder",
                                stream_id
                            );
                            return;
                        }

                        // Wait until the main loop has inserted/updated self.streams for
                        // this stream_id before forwarding bytes into the funnel.
                        if ready_rx.recv_timeout(Duration::from_secs(2)).is_err() {
                            eprintln!(
                                "Timed out waiting for stream {} registration; not starting forwarder",
                                stream_id
                            );
                            return;
                        }

                        // Start forwarding TCP → Client in THIS thread
                        std::thread::sleep(Duration::from_millis(100)); // Small delay to ensure the proxy client thread has fully processed the PortConnected event and is ready to receive forwarded data
                        read_and_forward(stream_id, read_stream, event_tx);
                    }
                    Err(e) => {
                        event_tx
                            .send(ProxyEvent::PortFailed {
                                stream_id,
                                port,
                                error: e.to_string(),
                                msg_seq,
                            })
                            .ok();
                    }
                }
            });
        }
    }

    fn handle_start_stream(&mut self, stream_id: u8, msg_seq: u64) {
        if let Some(pinfo) = self.streams.get_mut(&stream_id) {
            if pinfo.stream.is_none() {
                let ports: Vec<(u8, u16)> = vec![(stream_id, pinfo.port)];
                self.spawn_port_waiters(ports, true, msg_seq);
            } else {
                eprintln!("Stream {} is already connected", stream_id);
            }
        } else {
            eprintln!(
                "Received StartStream for unknown stream_id {}, ignoring",
                stream_id
            );
        }
    }

    fn handle_duplicate_stream(&mut self, stream_id: u8, msg_seq: u64) {
        if let Some(pinfo) = self.streams.get_mut(&stream_id) {
            if pinfo.stream.is_some() {
                let port = pinfo.port;
                let cur_stream_id = self.next_stream_id;
                self.next_stream_id += 1;
                let tmp = PortInfoListner {
                    port: port,
                    stream_id: cur_stream_id,
                    listener: None,
                };
                // We don't need to save dynamically allocated ports in self.reserved_ports because we won't be waiting on
                // them before the gdb-server launches, but we can still push them there to keep track of them and for easier
                // cleanup on shutdown
                self.reserved_ports.push(tmp);
                self.streams.insert(
                    cur_stream_id,
                    PortInfo {
                        port,
                        stream_id: cur_stream_id,
                        stream: None,
                    },
                );
                self.spawn_port_waiters(vec![(cur_stream_id, port)], true, msg_seq);
            } else {
                eprintln!(
                    "Received DuplicateStream for stream_id {} which is not currently connected, ignoring",
                    stream_id
                );
            }
        } else {
            eprintln!(
                "Received DuplicateStream for unknown stream_id {}, ignoring",
                stream_id
            );
        }
    }

    fn wait_and_connect_sync(
        port: u16,
        timeout: Duration,
        keep_open: bool,
    ) -> Result<WaitPortResult> {
        eprintln!(
            "Waiting for connection on port {} with timeout {:?}",
            port, timeout
        );
        let deadline = Instant::now() + timeout;
        let mut interval: Duration = Duration::from_millis(100);
        let mut once = true;

        while once || Instant::now() < deadline {
            once = false;
            match TcpStream::connect(("127.0.0.1", port)) {
                Ok(stream) => {
                    if keep_open {
                        return Ok(WaitPortResult::Stream(stream));
                    } else {
                        stream.shutdown(std::net::Shutdown::Both).ok();
                        return Ok(WaitPortResult::Ready(true));
                    }
                }
                Err(_) => {
                    if !keep_open {
                        return Ok(WaitPortResult::Ready(false));
                    }
                    std::thread::sleep(interval);
                    interval = (interval * 2).min(Duration::from_millis(200));
                }
            }
        }
        eprintln!("Timeout waiting for port {}", port);
        Err(anyhow!("Timeout waiting for port {}", port))
    }

    fn handle_sync_file(&mut self, msg: &ControlMessage) {
        if let ControlRequest::SyncFile {
            relative_path,
            content,
        } = &msg.request
        {
            eprintln!("Received SyncFile request for path {}", relative_path);
            let full_path = PathBuf::from(self.server_launch_uid.clone()).join(relative_path);
            create_parent_dirs(full_path.to_str().unwrap());
            match fs::write(full_path.clone(), content) {
                Ok(_) => {
                    ControlResponse::success(msg.seq, None)
                        .send(&mut self.stream)
                        .unwrap_or_else(|e| {
                            eprintln!("Failed to send success response: {}", e);
                        });
                }
                Err(e) => {
                    let err_msg = format!(
                        "Failed to write file {} => {}: {}",
                        relative_path,
                        full_path.display(),
                        e
                    );
                    eprintln!("{}", err_msg);
                    ControlResponse::error(msg.seq, err_msg)
                        .send(&mut self.stream)
                        .unwrap_or_else(|e| {
                            eprintln!("Failed to send error response: {}", e);
                        });
                }
            }
        } else {
            eprintln!(
                "BUG: handle_sync_file called with wrong request type: {:?}",
                msg.request
            );
            ControlResponse::error(msg.seq, "Internal error: wrong handler".to_string())
                .send(&mut self.stream)
                .ok();
        }
    }
}

pub enum WaitPortResult {
    Stream(TcpStream),
    Ready(bool),
}

pub fn is_connected(stream: &TcpStream) -> bool {
    // Try to read 0 bytes to check the status
    let mut buf = [0; 0];
    match stream.peek(&mut buf) {
        // Use peek if available, or read
        Ok(_) => true,
        Err(e) if e.kind() == io::ErrorKind::WouldBlock => true, // Still connected
        Err(_) => false,                                         // Disconnected
    }
}

fn create_parent_dirs(file_path_str: &str) {
    let path = Path::new(file_path_str);

    // Get the parent directory path
    if let Some(parent_dir) = path.parent() {
        // Create all missing parent directories (equivalent to mkdir -p)
        fs::create_dir_all(parent_dir).ok();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::{channel, Receiver, Sender, TryRecvError};
    use std::thread;
    use ts_rs::{Config, TS};

    #[test]
    fn ensure_ts_exports() {
        let config = Config::from_env();
        StreamId::export(&config).unwrap();
        StreamStatus::export(&config).unwrap();
        ControlRequest::export(&config).unwrap();
        ControlMessage::export(&config).unwrap();
        PortWaitMode::export(&config).unwrap();
        ProxyServerEvents::export(&config).unwrap();
        ControlResponse::export(&config).unwrap();
        ControlResponseData::export(&config).unwrap();
        PortAllocatorSpec::export(&config).unwrap();
        PortReserved::export(&config).unwrap();
        PortSet::export(&config).unwrap();
        JsonValue::export(&config).unwrap();
    }

    static TEST_MUTEX: Mutex<()> = Mutex::new(()); // Don't really need a mutex for this simple test, but is there in case the tests get more complex in the future and need to synchronize access to the stream
    fn send_to_stream(stream_id: u8, stream: &mut TcpStream, bytes: &[u8]) -> io::Result<()> {
        let _lock = TEST_MUTEX.lock().expect("failed to acquire stream lock"); // Acquire the global mutex before sending
        let mut header = Vec::with_capacity(5);
        header.push(stream_id);
        header.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
        stream.write_all(&header)?;
        stream.write_all(bytes)?;
        stream.flush()?;
        Ok(())
    }

    fn read_from_stream(reader: &mut TcpStream, tx: Sender<String>) {
        let mut all_bytes: Vec<u8> = Vec::new();
        let mut buffer = [0; 4096];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => {
                    // EOF
                    break;
                }
                Ok(n) => {
                    let data = buffer[..n].to_vec();
                    all_bytes.extend_from_slice(&data);
                }
                Err(_) => {
                    break;
                }
            }
            while all_bytes.len() > 0 {
                if all_bytes.len() < 5 {
                    break; // Not enough data for header
                }
                let content_length =
                    u32::from_le_bytes(all_bytes[1..5].try_into().unwrap()) as usize;
                if all_bytes.len() < 5 + content_length {
                    break; // Wait for the full message
                }
                let stream_id = all_bytes[0];
                let msg_bytes = &all_bytes[5..5 + content_length];
                let msg_str = String::from_utf8_lossy(msg_bytes);
                eprintln!(
                    "Client received message: stream_id={}, content_length={}, content={}",
                    stream_id, content_length, msg_str
                );
                tx.send(msg_str.to_string()).unwrap();
                all_bytes.drain(..5 + content_length); // Remove the processed message
            }
        }
    }

    fn wait_for_message(rx: &Receiver<String>, timeout: Duration) -> Option<String> {
        let deadline = Instant::now() + timeout;
        loop {
            match rx.try_recv() {
                Ok(msg) => return Some(msg),
                Err(TryRecvError::Empty) => {
                    if Instant::now() >= deadline {
                        return None; // Timeout
                    }
                    std::thread::sleep(Duration::from_millis(10)); // Avoid busy waiting
                }
                Err(TryRecvError::Disconnected) => {
                    return None; // Channel closed
                }
            }
        }
    }

    /// Wait for server to be ready by attempting to connect with exponential backoff
    fn wait_for_server(addr: &str, timeout: Duration) -> io::Result<TcpStream> {
        let deadline = Instant::now() + timeout;
        let mut interval = Duration::from_millis(10);

        loop {
            match TcpStream::connect(addr) {
                Ok(stream) => return Ok(stream),
                Err(_e) => {
                    if Instant::now() >= deadline {
                        return Err(io::Error::new(
                            io::ErrorKind::TimedOut,
                            format!("Server at {} not ready within {:?}", addr, timeout),
                        ));
                    }
                    std::thread::sleep(interval);
                    interval = (interval * 2).min(Duration::from_millis(200)); // Exponential backoff, max 200ms
                }
            }
        }
    }

    #[test]
    fn test_proxy_server() {
        let tx: Sender<String>;
        let rx: Receiver<String>;
        (tx, rx) = channel();

        thread::spawn(|| {
            let args = ProxyArgs {
                host: "127.0.0.1".to_string(),
                port: 4567,
                token: "adis-ababa".to_string(),
                debug: false,
                port_wait_mode: PortWaitMode::ConnectHold,
                log_stderr: false,
                log_dir: None,
            };
            let _ = crate::proxy_helper::run::run(args);
        });

        // Wait for server to be ready by attempting connection with retry
        let client = wait_for_server("127.0.0.1:4567", Duration::from_secs(5))
            .expect("Server failed to start within 5 seconds");
        let mut seq: u64 = 1;
        let init_msg = ControlMessage {
            seq: seq,
            request: ControlRequest::Initialize {
                token: "adis-ababa".to_string(),
                version: CURRENT_VERSION.to_string(),
                remote_launch_uid: "test-uid".to_string(),
                port_wait_mode: None,
            },
        };
        seq += 1;
        let mut reader = client.try_clone().unwrap();
        let tx_clone = tx.clone();
        thread::spawn(move || {
            read_from_stream(&mut reader, tx_clone);
        });
        let msg_bytes = serde_json::to_vec(&init_msg).unwrap();
        send_to_stream(
            StreamId::Control.to_u8(),
            &mut client.try_clone().unwrap(),
            &msg_bytes,
        )
        .unwrap();
        let msg = wait_for_message(&rx, Duration::from_secs(5)).unwrap_or_else(|| {
            panic!("Did not receive any message from server within timeout");
        });
        let response: ControlResponse = serde_json::from_str(&msg).unwrap();
        assert!(response.success);
        if let Some(ControlResponseData::Initialize {
            version,
            server_launch_uid,
        }) = response.data
        {
            assert_eq!(version, CURRENT_VERSION);
            assert!(server_launch_uid.contains("test-uid"));
        } else {
            panic!("Expected Initialize response data");
        }

        let allc_ports_msg = ControlMessage {
            seq: seq,
            request: ControlRequest::AllocatePorts {
                ports_spec: PortAllocatorSpec {
                    all_ports: vec![PortSet {
                        start_port: 5000,
                        port_ids: vec!["test-port0".to_string(), "test-port1".to_string()],
                    }],
                },
            },
        };
        let msg_bytes = serde_json::to_vec(&allc_ports_msg).unwrap();
        send_to_stream(
            StreamId::Control.to_u8(),
            &mut client.try_clone().unwrap(),
            &msg_bytes,
        )
        .unwrap();
        let msg = wait_for_message(&rx, Duration::from_secs(5)).unwrap_or_else(|| {
            panic!("Did not receive any message from server within timeout");
        });
        let response: ControlResponse = serde_json::from_str(&msg).unwrap();
        assert!(response.success);
        if let Some(ControlResponseData::AllocatePorts { ports }) = response.data {
            assert_eq!(ports.len(), 2);
            assert_eq!(ports[0].stream_id, 3);
            assert_eq!(ports[0].stream_id_str, "test-port0");
            assert!(ports[0].port >= 5000);
            assert_eq!(ports[1].stream_id, 4);
            assert_eq!(ports[1].stream_id_str, "test-port1");
            assert!(ports[1].port >= 5000);
            assert!(ports[0].port != ports[1].port); // Should be different ports
        } else {
            panic!("Expected AllocatePorts response data");
        }
    }
}
