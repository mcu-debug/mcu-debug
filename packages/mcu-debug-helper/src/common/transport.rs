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

use serde_json::Value;
use std::error::Error;
use std::io::{self, BufRead, BufReader, BufWriter, Read, Write};
use std::net::{TcpListener, TcpStream};

pub trait Transport {
    fn read_message(&mut self) -> Result<Value, Box<dyn Error + Send + Sync>>;
    fn write_message(&mut self, msg: &Value) -> Result<(), Box<dyn Error + Send + Sync>>;
}

// Stdio-based transport (suitable for child-process JSON-RPC/DAP)
pub struct StdioTransport {
    reader: BufReader<io::Stdin>,
}

impl StdioTransport {
    pub fn new() -> Self {
        Self {
            reader: BufReader::new(io::stdin()),
        }
    }
}

impl Transport for StdioTransport {
    fn read_message(&mut self) -> Result<Value, Box<dyn Error + Send + Sync>> {
        // Read headers until an empty line
        let mut content_length: Option<usize> = None;
        loop {
            let mut header_line = String::new();
            let n = self.reader.read_line(&mut header_line)?;
            if n == 0 {
                return Err("EOF while reading header".into());
            }
            let header_trim = header_line.trim();
            if header_trim.is_empty() {
                break; // end of headers
            }
            if header_trim.to_lowercase().starts_with("content-length") {
                if let Some(idx) = header_trim.find(':') {
                    let num = header_trim[idx + 1..].trim();
                    content_length = Some(num.parse::<usize>()?);
                }
            }
            // ignore other headers
        }

        let len = content_length.ok_or("Missing Content-Length header")?;
        let mut buf = vec![0u8; len];
        self.reader.read_exact(&mut buf)?;
        let v: Value = serde_json::from_slice(&buf)?;
        Ok(v)
    }

    fn write_message(&mut self, msg: &Value) -> Result<(), Box<dyn Error + Send + Sync>> {
        // Use stdout's built-in locking for thread safety
        write_json_locked(msg)?;
        Ok(())
    }
}

// TCP-based transport (bind-and-accept or connect)
pub struct TcpTransport {
    reader: BufReader<TcpStream>,
    writer: BufWriter<TcpStream>,
}

impl TcpTransport {
    /// Connects to a server at `addr` (eg "127.0.0.1:9257")
    pub fn connect(addr: &str) -> Result<Self, Box<dyn Error>> {
        let stream = TcpStream::connect(addr)?;
        let reader = BufReader::new(stream.try_clone()?);
        let writer = BufWriter::new(stream);
        Ok(Self { reader, writer })
    }

    /// Bind to `addr`, accept a single connection and return a transport.
    pub fn listen_and_accept(addr: &str) -> Result<Self, Box<dyn Error>> {
        let listener = TcpListener::bind(addr)?;
        let (stream, _peer) = listener.accept()?;
        let reader = BufReader::new(stream.try_clone()?);
        let writer = BufWriter::new(stream);
        Ok(Self { reader, writer })
    }
}

impl Transport for TcpTransport {
    fn read_message(&mut self) -> Result<Value, Box<dyn Error + Send + Sync>> {
        let mut content_length: Option<usize> = None;
        loop {
            let mut header_line = String::new();
            let n = self.reader.read_line(&mut header_line)?;
            if n == 0 {
                return Err("EOF while reading header".into());
            }
            let header_trim = header_line.trim();
            if header_trim.is_empty() {
                break;
            }
            if header_trim.to_lowercase().starts_with("content-length") {
                if let Some(idx) = header_trim.find(':') {
                    let num = header_trim[idx + 1..].trim();
                    content_length = Some(num.parse::<usize>()?);
                }
            }
        }
        let len = content_length.ok_or("Missing Content-Length header")?;
        let mut buf = vec![0u8; len];
        self.reader.read_exact(&mut buf)?;
        let v: Value = serde_json::from_slice(&buf)?;
        Ok(v)
    }

    fn write_message(&mut self, msg: &Value) -> Result<(), Box<dyn Error + Send + Sync>> {
        // Use the helper to perform the locked write if needed. For TCP we don't
        // use the global stdout lock, so just serialize and write.
        let body = serde_json::to_vec(msg)?;
        write!(self.writer, "Content-Length: {}\r\n\r\n", body.len())?;
        self.writer.write_all(&body)?;
        self.writer.flush()?;
        Ok(())
    }
}

/// Helper to write a JSON `Value` to stdout using stdout's built-in lock.
///
/// Rust's `io::stdout().lock()` provides process-wide synchronization,
/// ensuring writes from different threads don't interleave. This function
/// serializes the message first, then acquires stdout's lock only for the
/// actual write (header + body + flush) to minimize the critical section.
pub fn write_json_locked(msg: &Value) -> Result<(), Box<dyn Error + Send + Sync>> {
    let body = serde_json::to_vec(msg)?;
    let stdout = io::stdout();
    let mut w = stdout.lock(); // Process-wide lock on stdout
    write!(w, "Content-Length: {}\r\n\r\n", body.len())?;
    w.write_all(&body)?;
    w.flush()?;
    Ok(())
}
