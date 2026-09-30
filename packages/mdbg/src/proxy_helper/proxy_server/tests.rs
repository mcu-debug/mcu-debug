use super::*;
use crate::common::sync::MutexExt;
use crate::serial::port::{FlowControl, Parity, SerialErrorKind, SerialParams, SerialTransport, StopBits};
use crate::serial::AvailablePort;
use std::sync::mpsc::{channel, Receiver, Sender, TryRecvError};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use ts_rs::{Config, TS};

#[test]
fn ensure_ts_exports() {
    let config = Config::from_env();
    StreamId::export(&config).unwrap();
    StreamStatus::export(&config).unwrap();
    ControlRequest::export(&config).unwrap();
    ControlMessage::export(&config).unwrap();
    ProxyServerEvents::export(&config).unwrap();
    ControlResponse::export(&config).unwrap();
    ControlResponseData::export(&config).unwrap();
    // Agent-side RTT: the request payload and the stream ids it hands back. Not reachable from
    // `ControlRequest` alone for ts-rs -- a nested struct needs its own export.
    RttStartConfig::export(&config).unwrap();
    RttChannelStream::export(&config).unwrap();
    PortAllocatorSpec::export(&config).unwrap();
    PortReserved::export(&config).unwrap();
    PortSet::export(&config).unwrap();
    SerialPortInfo::export(&config).unwrap();
    // Serial types (exported to serial-helper/)
    SerialParams::export(&config).unwrap();
    StopBits::export(&config).unwrap();
    Parity::export(&config).unwrap();
    FlowControl::export(&config).unwrap();
    SerialTransport::export(&config).unwrap();
    AvailablePort::export(&config).unwrap();
    SerialErrorKind::export(&config).unwrap();
    // Admin channel: the `--status` report, which the extensions parse (see
    // `mcu-debug-proxy.proxyStatus`). The funnel protocol above was exported from the
    // start; the admin channel had no TS consumer until that command existed.
    crate::proxy_helper::run::StatusReport::export(&config).unwrap();
    crate::proxy_helper::admin::StatusInfo::export(&config).unwrap();
    crate::proxy_helper::singleton::ExeStatus::export(&config).unwrap();
    SerialStatus::export(&config).unwrap();
}

/// `StreamConn` replaced an `Option<TcpStream>` whose `is_some()` meant "connected".
/// These pin the two things the three former call sites actually needed, and the one that
/// is new: a muxed stream is connected *and* hands out no socket.
#[test]
fn a_muxed_stream_is_connected_but_offers_nothing_to_write_to() {
    let mut muxed = StreamConn::Muxed;
    assert!(muxed.is_connected(), "a muxed stream must still report as connected");
    assert!(
        muxed.direct_mut().is_none(),
        "a muxed stream must not expose a writable socket -- the mux owns it"
    );

    let mut idle = StreamConn::Idle;
    assert!(!idle.is_connected());
    assert!(idle.direct_mut().is_none());
}

static TEST_MUTEX: Mutex<()> = Mutex::new(()); // Don't really need a mutex for this simple test, but is there in case the tests get more complex in the future and need to synchronize access to the stream
fn send_to_stream(stream_id: u8, stream: &mut TcpStream, bytes: &[u8]) -> io::Result<()> {
    let _lock = TEST_MUTEX.lock_recover(); // Serialize test senders; recovers if a prior test panicked holding it
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
        while !all_bytes.is_empty() {
            if all_bytes.len() < 5 {
                break; // Not enough data for header
            }
            let content_length = u32::from_le_bytes(all_bytes[1..5].try_into().unwrap()) as usize;
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

    // Keep the singleton state dir (lock + endpoint.json) out of the real home
    // directory during tests — point it at a throwaway temp path instead.
    let state_dir = std::env::temp_dir().join(format!("mdbg-test-proxy-{}", std::process::id()));
    std::env::set_var("MDBG_PROXY_STATE_DIR", &state_dir);

    thread::spawn(|| {
        let args = ProxyArgs {
            host: None,
            port: 4567,
            token: Some("adis-ababa-0123456789".to_string()),
            debug: false,
            log_stderr: false,
            log_dir: None,
            heartbeat: false,
            // Distinct instance so the test never touches (or is blocked by) a
            // real `default` proxy running on the dev machine.
            instance: "test-proxy-server".to_string(),
            idle_timeout: 0, // no idle monitor during the test
            status: false,
            shutdown: false,
            all: false,
            close_serial: None,
            no_rsp_mux: false,
            rsp_trace: "off".to_string(),
            daemonized: true, // run the proxy in-process; don't re-spawn a daemon
        };
        let _ = crate::proxy_helper::run::run(args);
    });

    // Wait for server to be ready by attempting connection with retry
    let client =
        wait_for_server("127.0.0.1:4567", Duration::from_secs(5)).expect("Server failed to start within 5 seconds");
    let mut seq: u64 = 1;
    let init_msg = ControlMessage {
        seq,
        request: ControlRequest::Initialize {
            token: "adis-ababa-0123456789".to_string(),
            version: CURRENT_VERSION.to_string(),
            workspace_uid: "test-uid".to_string(),
            session_uid: "test-session-uid".to_string(),
            // A client that sends nothing gets the proxy's defaults, which is the path
            // most worth having covered: it is what any client predating these flags does.
            debug_flags: None,
            server_type: None,
        },
    };
    seq += 1;
    let mut reader = client.try_clone().unwrap();
    let tx_clone = tx.clone();
    thread::spawn(move || {
        read_from_stream(&mut reader, tx_clone);
    });
    let msg_bytes = serde_json::to_vec(&init_msg).unwrap();
    send_to_stream(StreamId::Control.to_u8(), &mut client.try_clone().unwrap(), &msg_bytes).unwrap();
    let msg = wait_for_message(&rx, Duration::from_secs(5)).unwrap_or_else(|| {
        panic!("Did not receive any message from server within timeout");
    });
    let response: ControlResponse = serde_json::from_str(&msg).unwrap();
    assert!(response.success);
    if let Some(ControlResponseData::Initialize {
        version,
        build,
        pid,
        server_cwd,
    }) = response.data
    {
        assert_eq!(version, CURRENT_VERSION);
        assert!(server_cwd.contains("test-uid"));
        // Identity of the process actually answering, so a client can tell a rebuild that took
        // effect from a daemon that never exited. `build` is a git hash or "unknown"; either way
        // it must not be empty, because an empty string is what a peer predating the field sends.
        assert!(!build.is_empty(), "the Agent must name its build");
        assert_eq!(pid, std::process::id());
    } else {
        panic!("Expected Initialize response data");
    }

    let allc_ports_msg = ControlMessage {
        seq,
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
    send_to_stream(StreamId::Control.to_u8(), &mut client.try_clone().unwrap(), &msg_bytes).unwrap();
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
