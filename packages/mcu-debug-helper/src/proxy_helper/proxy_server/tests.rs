use super::*;
use crate::serial::port::{
    FlowControl, Parity, SerialErrorKind, SerialParams, SerialTransport, StopBits,
};
use crate::serial::AvailablePort;
use std::sync::mpsc::{channel, Receiver, Sender, TryRecvError};
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
    PortWaitMode::export(&config).unwrap();
    ProxyServerEvents::export(&config).unwrap();
    ControlResponse::export(&config).unwrap();
    ControlResponseData::export(&config).unwrap();
    PortAllocatorSpec::export(&config).unwrap();
    PortReserved::export(&config).unwrap();
    PortSet::export(&config).unwrap();
    JsonValue::export(&config).unwrap();
    SerialPortInfo::export(&config).unwrap();
    // Serial types (exported to serial-helper/)
    SerialParams::export(&config).unwrap();
    StopBits::export(&config).unwrap();
    Parity::export(&config).unwrap();
    FlowControl::export(&config).unwrap();
    SerialTransport::export(&config).unwrap();
    AvailablePort::export(&config).unwrap();
    SerialErrorKind::export(&config).unwrap();
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

    thread::spawn(|| {
        let args = ProxyArgs {
            host: "127.0.0.1".to_string(),
            port: 4567,
            token: "adis-ababa".to_string(),
            debug: false,
            port_wait_mode: PortWaitMode::ConnectHold,
            log_stderr: false,
            log_dir: None,
            no_token: false,
            heartbeat: false,
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
            workspace_uid: "test-uid".to_string(),
            session_uid: "test-session-uid".to_string(),
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
        server_cwd,
    }) = response.data
    {
        assert_eq!(version, CURRENT_VERSION);
        assert!(server_cwd.contains("test-uid"));
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
