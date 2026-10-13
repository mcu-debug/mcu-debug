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

//! Bidirectional mux-stream transport over a platform socket.
//!
//! Wire format: newline-delimited tagged text, e.g.:
//!   `[GDB] target halted at 0x08001234\n`
//!   `[RTT#0] Hello World\n`
//!
//! The reader and writer are split into separate trait objects so the writer
//! can stay on the main/TUI thread while the reader runs in a background thread.

use crate::cockpit::sock_file::SockInfo;
use anyhow::Result;

/// Read half of the mux stream.
pub trait MuxReader: Send {
    /// Read the next newline-terminated line. Returns `None` on EOF (Node exited).
    fn read_line(&mut self) -> Result<Option<String>>;
}

/// Write half of the mux stream.
pub trait MuxWriter: Send {
    /// Send a line to the Node process. A trailing newline is added if absent.
    fn write_line(&mut self, line: &str) -> Result<()>;
}

// ── Stdio transport (piped ChildStdout / ChildStdin) ─────────────────────────

/// Wrap the piped stdout/stdin of a spawned Node child process.
/// This is the primary transport for `mcu-debug debug` (TUI mode).
pub fn from_child_stdio(
    stdout: std::process::ChildStdout,
    stderr: std::process::ChildStderr,
    stdin: std::process::ChildStdin,
) -> (Box<dyn MuxReader>, Box<dyn MuxReader>, Box<dyn MuxWriter>) {
    use std::io::{BufRead, BufReader, Write};

    struct StdoutReader(BufReader<std::process::ChildStdout>);
    struct StderrReader(BufReader<std::process::ChildStderr>);
    struct StdioWriter(std::process::ChildStdin);

    impl MuxReader for StdoutReader {
        fn read_line(&mut self) -> Result<Option<String>> {
            let mut line = String::new();
            let n = self.0.read_line(&mut line)?;
            if n == 0 {
                Ok(None)
            } else {
                Ok(Some(line))
            }
        }
    }
    impl MuxReader for StderrReader {
        fn read_line(&mut self) -> Result<Option<String>> {
            let mut line = String::new();
            let n = self.0.read_line(&mut line)?;
            if n == 0 {
                Ok(None)
            } else {
                Ok(Some(line))
            }
        }
    }

    impl MuxWriter for StdioWriter {
        fn write_line(&mut self, line: &str) -> Result<()> {
            self.0.write_all(line.as_bytes())?;
            if !line.ends_with('\n') {
                self.0.write_all(b"\n")?;
            }
            self.0.flush()?;
            Ok(())
        }
    }

    (
        Box::new(StdoutReader(BufReader::new(stdout))),
        Box::new(StderrReader(BufReader::new(stderr))),
        Box::new(StdioWriter(stdin)),
    )
}

// ── Unix domain socket transport (for `mcu-debug attach`) ────────────────────

/// Connect to the mux socket described by `info`.
/// Used when attaching to an already-running session via `.mcu-debug/socket.json`.
#[allow(dead_code)]
pub fn connect(info: &SockInfo) -> Result<(Box<dyn MuxReader>, Box<dyn MuxWriter>)> {
    #[cfg(unix)]
    if let Some(path) = &info.socket {
        return unix::connect(path);
    }

    #[cfg(windows)]
    if let Some(_path) = &info.pipe {
        // TODO: implement Windows named pipe transport (use tokio::net::windows::named_pipe
        // or std::fs::OpenOptions on \\.\pipe\... with FILE_FLAG_OVERLAPPED).
        anyhow::bail!("Windows named pipe transport is not yet implemented");
    }

    anyhow::bail!(
        "SockInfo for pid {} contains no supported socket path — socket={:?} pipe={:?}",
        info.pid,
        info.socket,
        info.pipe,
    )
}

#[cfg(unix)]
#[allow(dead_code)]
mod unix {
    use super::{MuxReader, MuxWriter};
    use anyhow::Result;
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::net::UnixStream;

    struct UnixMuxReader(BufReader<UnixStream>);
    struct UnixMuxWriter(UnixStream);

    impl MuxReader for UnixMuxReader {
        fn read_line(&mut self) -> Result<Option<String>> {
            let mut line = String::new();
            let n = self.0.read_line(&mut line)?;
            if n == 0 {
                Ok(None)
            } else {
                Ok(Some(line))
            }
        }
    }

    impl MuxWriter for UnixMuxWriter {
        fn write_line(&mut self, line: &str) -> Result<()> {
            self.0.write_all(line.as_bytes())?;
            if !line.ends_with('\n') {
                self.0.write_all(b"\n")?;
            }
            self.0.flush()?;
            Ok(())
        }
    }

    pub fn connect(path: &str) -> Result<(Box<dyn MuxReader>, Box<dyn MuxWriter>)> {
        let stream = UnixStream::connect(path)?;
        let writer_stream = stream.try_clone()?;
        Ok((
            Box::new(UnixMuxReader(BufReader::new(stream))),
            Box::new(UnixMuxWriter(writer_stream)),
        ))
    }
}
