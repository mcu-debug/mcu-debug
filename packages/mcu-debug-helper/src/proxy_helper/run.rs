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

//! Entry point for the proxy-helper subcommand.
//! This will implement the Probe Agent that manages gdb-server processes
//! and speaks the Funnel Protocol over TCP.

use anyhow::Result;
use clap::Args;
use clap::ValueEnum;
use flexi_logger::{Age, Cleanup, Criterion, Duplicate, FileSpec, Logger, LoggerHandle, Naming};
use serde::Deserialize;
use serde::Serialize;
use std::{
    backtrace::Backtrace,
    io::Write,
    net::{Ipv4Addr, TcpListener},
    panic,
    path::PathBuf,
    sync::{mpsc, Once},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use crate::proxy_helper::proxy_server::ProxyServer;

#[derive(Clone, Copy, Debug, ValueEnum, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "proxy-protocol/")]
#[serde(rename_all = "camelCase")]
pub enum PortWaitMode {
    /// Existing behavior: proactively connect and keep forwarding stream open.
    ConnectHold,
    /// Probe with a connect attempt but do not hold the stream open.
    ConnectProbe,
    /// Non-invasive monitor mode (lsof/netstat) that reports readiness.
    Monitor,
}

#[derive(Args, Debug)]
pub struct ProxyArgs {
    /// Host to listen on (default: 127.0.0.1), alternatively specify `0.0.0.0` to listen on all interfaces
    #[arg(short = 'H', long = "host", default_value = "127.0.0.1")]
    pub host: String,

    /// TCP port to listen on (0 = auto-assign)
    #[arg(short = 'p', long = "port", default_value_t = 0)]
    pub port: u16,

    /// Authentication token for client connections
    #[arg(short = 't', long = "token", default_value = "adis-ababa")]
    pub token: String,

    /// If true, do not include the token in the discovery JSON output (for security through obscurity)
    #[arg(long = "no-token", default_value_t = false)]
    pub no_token: bool,

    /// Enable debug output
    #[arg(short = 'd', long = "debug", default_value_t = false)]
    pub debug: bool,

    /// Strategy to detect stream-port readiness
    #[arg(long = "port-wait-mode", value_enum, default_value_t = PortWaitMode::Monitor)]
    pub port_wait_mode: PortWaitMode,

    /// Also emit log lines to stderr (file logging is always enabled)
    #[arg(long = "log-stderr", default_value_t = false)]
    pub log_stderr: bool,

    /// Directory for proxy-helper log files
    #[arg(long = "log-dir")]
    pub log_dir: Option<String>,

    /// Enable stdin heartbeat watchdog. When set, the process exits if stdin
    /// closes (parent died) or no byte is received within 15 seconds.
    /// Pass this flag only when the parent will actively send heartbeats.
    /// Do NOT pass it for SSH-launched or daemon instances.
    #[arg(long = "heartbeat", default_value_t = false)]
    pub heartbeat: bool,
}

fn init_logging(args: &ProxyArgs) -> Option<LoggerHandle> {
    let log_dir = args.log_dir.clone().map(PathBuf::from).unwrap_or_else(|| {
        std::env::temp_dir()
            .join("mcu-debug-helper")
            .join("proxy-logs")
    });

    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let launch_id = format!("{}-{}", std::process::id(), ts);

    let logger = match Logger::try_with_env_or_str(if args.debug { "debug" } else { "info" }) {
        Ok(logger) => logger,
        Err(e) => {
            eprintln!("Logger configuration failed: {}", e);
            return None;
        }
    }
    .format(flexi_logger::detailed_format)
    .log_to_file(
        FileSpec::default()
            .directory(log_dir)
            .basename("proxy-helper")
            .discriminant(launch_id)
            .suffix("log"),
    )
    .rotate(
        Criterion::Age(Age::Day),
        Naming::Timestamps,
        Cleanup::KeepLogFiles(14),
    )
    .duplicate_to_stderr(if args.log_stderr {
        Duplicate::All
    } else {
        Duplicate::None
    });

    match logger.start() {
        Ok(handle) => Some(handle),
        Err(e) => {
            eprintln!(
                "Logger initialization failed, continuing without file logger: {}",
                e
            );
            None
        }
    }
}

fn install_panic_hook() {
    static PANIC_HOOK_INIT: Once = Once::new();

    PANIC_HOOK_INIT.call_once(|| {
        panic::set_hook(Box::new(|panic_info| {
            let thread = thread::current();
            let thread_name = thread.name().unwrap_or("<unnamed>");
            let payload = if let Some(s) = panic_info.payload().downcast_ref::<&str>() {
                (*s).to_string()
            } else if let Some(s) = panic_info.payload().downcast_ref::<String>() {
                s.clone()
            } else {
                "<non-string panic payload>".to_string()
            };
            let location = panic_info
                .location()
                .map(|loc| format!("{}:{}:{}", loc.file(), loc.line(), loc.column()))
                .unwrap_or_else(|| "<unknown>".to_string());
            let backtrace = Backtrace::force_capture();

            log::error!(
                "panic captured: thread={} id={:?} location={} payload={}\nbacktrace:\n{:?}",
                thread_name,
                thread.id(),
                location,
                payload,
                backtrace
            );
        }));
    });
}

pub fn run(args: ProxyArgs) -> Result<()> {
    let _log_handle = init_logging(&args);
    install_panic_hook();

    // Stdin heartbeat watchdog — only when explicitly requested via --heartbeat.
    // The extension that spawns us locally passes this flag and sends a '\n' every
    // 5 s. SSH-launched and daemon instances must NOT pass it (no heartbeat sender).
    if args.heartbeat {
        let (tx, rx) = mpsc::channel::<()>();
        thread::spawn(move || {
            use std::io::Read;
            let stdin = std::io::stdin();
            let mut buf = [0u8; 1];
            loop {
                match stdin.lock().read(&mut buf) {
                    Ok(n) if n > 0 => {
                        if tx.send(()).is_err() {
                            break;
                        }
                    }
                    _ => break, // EOF or error — tx drops, watcher sees Disconnected
                }
            }
        });
        thread::spawn(move || {
            const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(15);
            while rx.recv_timeout(HEARTBEAT_TIMEOUT).is_ok() {}
            log::info!("Stdin closed or heartbeat timeout — parent gone, exiting");
            std::process::exit(0);
        });
    }

    crate::common::debug::set_debug(args.debug);
    log::info!("Port wait mode: {:?}", args.port_wait_mode);
    log::info!(
        "Proxy helper startup: pid={}, host={}, port={}, log_stderr={}",
        std::process::id(),
        args.host,
        args.port,
        args.log_stderr
    );
    // 1. Bind TCP listener (port 0 for auto-assign)

    // TODO: Maybe allow Ipv6 in the future, but for now we can just require IPv4 for simplicity
    let host = match args.host.parse::<Ipv4Addr>() {
        Ok(ip) => ip,
        Err(e) => {
            log::error!("Invalid host IP address: {}", args.host);
            return Err(e.into());
        }
    };
    let listener = match TcpListener::bind((host, args.port)) {
        Ok(listener) => listener,
        Err(e) => {
            log::error!("Failed to bind to {}:{}", args.host, args.port);
            return Err(e.into());
        }
    };

    // Print Discovery JSON to stdout: {"status": "ready", "port": <actual_port>, "pid": <pid>} with an optional "token" field
    // If --no-token is not set, the client will parse this to discover the port and token to use for connecting to the Probe Agent.
    let out_token = if args.no_token {
        String::new()
    } else {
        format!(", \"token\": \"{}\"", args.token)
    };
    println!(
        "{{\"status\": \"ready\", \"port\": {}, \"pid\": {}{}}}",
        listener.local_addr()?.port(),
        std::process::id(),
        out_token
    );
    std::io::stdout().flush()?;

    if args.port == 0 {
        let local_port = listener.local_addr()?.port();
        log::info!("Probe Agent auto-assigned to port {}", local_port);
    } else {
        log::info!("Probe Agent listening on port {}", args.port);
    }

    // For cleanup later
    let mut client_threads = Vec::new();

    // Accept connection and run Funnel Protocol handler in a new thread
    // We generally don't have multiple clients when running inside a VSCode extension,
    // but we have a use case in multi-core debugging where each core needs its own proxy instance,
    // so we should be prepared to handle multiple connections gracefully (e.g. by rejecting
    // them with an error message). We don't need to know why we have multiple connections, we just
    // need to make sure we don't crash or do something weird if it happens.
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                // Spawn a new thread to handle each incoming connection
                let args_clone = ProxyArgs {
                    host: args.host.clone(),
                    port: args.port,
                    token: args.token.to_owned(),
                    debug: args.debug,
                    port_wait_mode: args.port_wait_mode,
                    log_stderr: args.log_stderr,
                    log_dir: args.log_dir.clone(),
                    no_token: args.no_token,
                    heartbeat: false, // watchdog already running on main thread; no second instance
                };
                let handle = thread::spawn(move || {
                    let mut new_client = ProxyServer::new(args_clone, stream);
                    new_client.message_loop().unwrap_or_else(|e| {
                        log::error!("Error in client message loop: {}", e);
                    });
                });
                client_threads.push(handle);
            }
            Err(e) => {
                log::error!("Connection failed: {}", e);
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn panic_in_thread_does_not_kill_process() {
        let temp = tempfile::tempdir().expect("failed to create temp dir");
        let args = ProxyArgs {
            host: "127.0.0.1".to_string(),
            port: 0,
            token: "test-token".to_string(),
            debug: true,
            port_wait_mode: PortWaitMode::ConnectHold,
            log_stderr: false,
            log_dir: Some(temp.path().to_string_lossy().to_string()),
            no_token: false,
            heartbeat: false,
        };

        let _log_handle = init_logging(&args);
        install_panic_hook();

        let join = std::thread::Builder::new()
            .name("panic-test-thread".to_string())
            .spawn(|| {
                panic!("intentional panic for logging test");
            })
            .expect("failed to spawn panic thread")
            .join();
        assert!(join.is_err());

        let ok = std::thread::spawn(|| 7usize)
            .join()
            .expect("non-panicking thread should complete");
        assert_eq!(ok, 7usize);
    }
}
