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

//! `mcu-debug-agent rsp-probe` — fill in the per-server capability matrix by asking the server.
//!
//! This answers the questions `docs-internal/gdb-rsp.md` §7 leaves open, and one of
//! them **cannot be answered with GDB at all**: whether the server replies to `m`
//! while a `c` is still outstanding on the same connection. GDB refuses to send
//! anything while the target runs — that client-side rule is the very thing the
//! multiplexer exists to sidestep — so no arrangement of two GDB processes can test
//! it. A raw RSP speaker can.
//!
//! **This is a diagnostic, not the multiplexer.** It deliberately does what the mux
//! is forbidden to do: it resumes and halts the target, because having a `c`
//! outstanding is the whole point of the interesting test. It therefore:
//!
//! - needs the gdb port to itself, or at least a free connection slot;
//! - interrupts and restores the run state it found, but a target that was running
//!   free will be halted briefly;
//! - reuses `frame.rs` and `packet.rs` (the codec and builders, which carry no
//!   policy) and **not** `MuxCore`, whose whole job is to refuse these packets.

use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};

use super::caps::MemoryReadKind;
use super::caps::RspCaps;
use super::frame::{encode_packet, AckMode, Frame, FrameKind, PacketCodec};
use super::packet;

/// Default wait for a reply before calling it silence. Generous: a first read over
/// SWD on a slow clock can take a while, and a false "no reply" would be the most
/// misleading result this tool could produce. Raise it with `--timeout` for a slow
/// target; the tests shorten it so the suite does not sit on real timeouts.
pub const DEFAULT_REPLY_TIMEOUT: Duration = Duration::from_millis(2500);

/// What a single question came back as.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    Yes(String),
    No(String),
    /// The question could not be asked — a prerequisite failed.
    Skipped(String),
}

impl Verdict {
    fn mark(&self) -> &'static str {
        match self {
            Verdict::Yes(_) => "YES",
            Verdict::No(_) => "no",
            Verdict::Skipped(_) => "  ?",
        }
    }

    fn note(&self) -> &str {
        match self {
            Verdict::Yes(s) | Verdict::No(s) | Verdict::Skipped(s) => s,
        }
    }
}

/// The filled-in matrix column for one server.
#[derive(Debug, Default)]
pub struct Report {
    pub target: String,
    pub q_supported: Option<String>,
    pub caps: RspCaps,
    pub rows: Vec<(&'static str, Verdict)>,
}

impl Report {
    fn add(&mut self, question: &'static str, verdict: Verdict) {
        self.rows.push((question, verdict));
    }

    /// Render for pasting into §7's table.
    pub fn render(&self) -> String {
        let mut out = String::new();
        out.push_str(&format!("\nRSP capability probe — {}\n", self.target));
        out.push_str(&"=".repeat(64));
        out.push('\n');
        if let Some(q) = &self.q_supported {
            out.push_str(&format!("qSupported reply:\n  {q}\n\n"));
        }
        out.push_str(&format!(
            "  PacketSize          {} ({})\n",
            self.caps.packet_size(),
            if self.caps.packet_size_was_advertised() {
                "advertised"
            } else {
                "defaulted — stub advertised none"
            }
        ));
        out.push_str(&format!("  max read per packet {} bytes\n", self.caps.max_read_bytes()));
        out.push_str(&format!("  binary-upload (x)   {}\n", yn(self.caps.binary_upload)));
        out.push_str(&format!("  vContSupported      {}\n", yn(self.caps.vcont_supported)));
        out.push_str(&format!("  QNonStop            {}\n", yn(self.caps.non_stop_supported)));
        out.push_str(&format!("  QStartNoAckMode     {}\n", yn(self.caps.no_ack_offered)));
        out.push_str(&format!("  multiprocess        {}\n\n", yn(self.caps.multiprocess)));
        for (q, v) in &self.rows {
            out.push_str(&format!("  [{}] {q}\n", v.mark()));
            if !v.note().is_empty() {
                out.push_str(&format!("        {}\n", v.note()));
            }
        }
        out.push('\n');
        out
    }
}

fn yn(b: bool) -> &'static str {
    if b {
        "yes"
    } else {
        "no"
    }
}

/// A raw RSP connection. Unlike `MuxCore` this will send anything asked of it.
struct RawRsp {
    stream: TcpStream,
    codec: PacketCodec,
    label: String,
    verbose: bool,
    reply_timeout: Duration,
}

impl RawRsp {
    fn connect<A: ToSocketAddrs>(addr: A, label: &str, opts: &ProbeOptions) -> Result<Self> {
        let stream = TcpStream::connect(addr).context("connecting to the gdb port")?;
        stream.set_read_timeout(Some(opts.reply_timeout))?;
        stream.set_nodelay(true).ok();
        Ok(Self {
            stream,
            codec: PacketCodec::new(),
            label: label.to_string(),
            verbose: opts.verbose,
            reply_timeout: opts.reply_timeout,
        })
    }

    fn reply_timeout(&self) -> Duration {
        self.reply_timeout
    }

    /// Wait for a halt, which can legitimately take much longer than one reply.
    fn halt_timeout(&self) -> Duration {
        self.reply_timeout * 2
    }

    fn log(&self, dir: &str, bytes: &[u8]) {
        if self.verbose {
            let text: String = bytes
                .iter()
                .map(|&b| {
                    if (0x20..=0x7e).contains(&b) {
                        (b as char).to_string()
                    } else {
                        format!("\\x{b:02x}")
                    }
                })
                .collect();
            eprintln!("  [{}] {dir} {text}", self.label);
        }
    }

    fn send_raw(&mut self, bytes: &[u8]) -> Result<()> {
        self.log("-->", bytes);
        self.stream.write_all(bytes)?;
        self.stream.flush()?;
        Ok(())
    }

    fn send_packet(&mut self, payload: &[u8]) -> Result<()> {
        let framed = encode_packet(payload);
        self.send_raw(&framed)
    }

    /// Next frame, or `None` on timeout. Acks are returned like anything else so a
    /// caller can account for them explicitly.
    fn next_frame(&mut self, deadline: Duration) -> Result<Option<Frame>> {
        let until = Instant::now() + deadline;
        loop {
            if let Some(frame) = self.codec.next_frame() {
                self.log("<--", &frame.raw);
                return Ok(Some(frame));
            }
            if Instant::now() >= until {
                return Ok(None);
            }
            let mut buf = [0u8; 4096];
            self.stream.set_read_timeout(Some(Duration::from_millis(100)))?;
            match self.stream.read(&mut buf) {
                Ok(0) => return Err(anyhow!("gdb-server closed the connection")),
                Ok(n) => self.codec.feed(&buf[..n]),
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock || e.kind() == std::io::ErrorKind::TimedOut => {}
                Err(e) => return Err(e.into()),
            }
        }
    }

    /// Next frame that is a reply, acking it if required and skipping `O`/`F`/`%`.
    fn next_reply(&mut self, deadline: Duration) -> Result<Option<Frame>> {
        let until = Instant::now() + deadline;
        while Instant::now() < until {
            let remaining = until.saturating_duration_since(Instant::now());
            match self.next_frame(remaining)? {
                None => return Ok(None),
                Some(frame) => match frame.kind {
                    FrameKind::Packet => {
                        if self.codec.ack_mode() == AckMode::Acked {
                            self.send_raw(b"+")?;
                        }
                        return Ok(Some(frame));
                    }
                    // Console output and file-I/O arrive mid-transaction; they are
                    // not the reply. Ack and keep waiting.
                    FrameKind::ConsoleOutput | FrameKind::FileIo | FrameKind::Notification => {
                        if self.codec.ack_mode() == AckMode::Acked {
                            self.send_raw(b"+")?;
                        }
                    }
                    FrameKind::Ack | FrameKind::Nack | FrameKind::Interrupt | FrameKind::Garbage => {}
                },
            }
        }
        Ok(None)
    }

    fn request(&mut self, payload: &[u8], deadline: Duration) -> Result<Option<Vec<u8>>> {
        self.send_packet(payload)?;
        Ok(self.next_reply(deadline)?.map(|f| f.payload))
    }
}

/// What to probe.
pub struct ProbeOptions {
    pub host: String,
    pub port: u16,
    /// How long to wait for any one reply.
    pub reply_timeout: Duration,
    /// Address read during the tests. Defaults to the Cortex-M ROM table base,
    /// which is readable on every ARM target and has no side effects.
    pub addr: u64,
    pub verbose: bool,
    /// Skip the tests that resume the target.
    pub no_resume: bool,
}

impl Default for ProbeOptions {
    fn default() -> Self {
        Self {
            host: "127.0.0.1".to_string(),
            port: 3333,
            reply_timeout: DEFAULT_REPLY_TIMEOUT,
            // ROM table / SCS base: present on any Cortex-M, read-only, no side
            // effects. Unlike DWT_PCSR, reading it cannot perturb anything.
            addr: 0xE000_0000,
            verbose: false,
            no_resume: false,
        }
    }
}

/// Run every question and return the filled report.
pub fn run(opts: &ProbeOptions) -> Result<Report> {
    let addr = format!("{}:{}", opts.host, opts.port);
    let mut report = Report {
        target: addr.clone(),
        ..Default::default()
    };

    let mut c1 = RawRsp::connect(&addr, "conn1", opts)?;

    // ── Capabilities ──────────────────────────────────────────────────────────
    let q = c1
        .request(
            b"qSupported:multiprocess+;swbreak+;hwbreak+;vContSupported+",
            c1.reply_timeout(),
        )?
        .ok_or_else(|| anyhow!("no reply to qSupported — is this a gdb port?"))?;
    let q_text = String::from_utf8_lossy(&q).to_string();
    report.caps = RspCaps::parse_reply(&q_text);
    report.q_supported = Some(q_text);

    // ── No-ack mode ───────────────────────────────────────────────────────────
    if report.caps.no_ack_offered {
        match c1.request(b"QStartNoAckMode", c1.reply_timeout())? {
            Some(r) if r == b"OK" => {
                c1.codec.set_ack_mode(AckMode::NoAck);
                report.add("QStartNoAckMode honoured", Verdict::Yes(String::new()));
            }
            other => report.add(
                "QStartNoAckMode honoured",
                Verdict::No(format!("advertised it but answered {:?}", render(other.as_deref()))),
            ),
        }
    } else {
        report.add("QStartNoAckMode honoured", Verdict::Skipped("not advertised".into()));
    }

    // ── Initial state ─────────────────────────────────────────────────────────
    let halt_reason = c1.request(&packet::halt_reason(), c1.reply_timeout())?;
    let was_running = match &halt_reason {
        Some(p) => packet::parse_stop_reply(p).is_none(),
        None => true,
    };
    report.add(
        "answers `?` with a stop reply",
        match &halt_reason {
            Some(p) if packet::parse_stop_reply(p).is_some() => Verdict::Yes(format!("`{}`", render(Some(p)))),
            Some(p) => Verdict::No(format!("answered `{}`", render(Some(p)))),
            None => Verdict::No("no reply".into()),
        },
    );

    // ── Baseline read while halted ────────────────────────────────────────────
    let read = packet::mem_read(opts.addr, 4, MemoryReadKind::Hex);
    let baseline = c1.request(&read, c1.reply_timeout())?;
    let baseline_ok = baseline
        .as_deref()
        .map(|p| packet::parse_mem_read_reply(p, MemoryReadKind::Hex).is_ok())
        .unwrap_or(false);
    report.add(
        "answers `m` while halted (baseline)",
        if baseline_ok {
            Verdict::Yes(format!("at {:#x}", opts.addr))
        } else {
            Verdict::No(format!(
                "reply was `{}` — try --addr with something readable",
                render(baseline.as_deref())
            ))
        },
    );

    // ── `x` packet ────────────────────────────────────────────────────────────
    if report.caps.binary_upload {
        let xr = c1.request(
            &packet::mem_read(opts.addr, 4, MemoryReadKind::Binary),
            c1.reply_timeout(),
        )?;
        report.add(
            "`x` (binary read) works as advertised",
            match xr.as_deref() {
                Some(p) if packet::parse_mem_read_reply(p, MemoryReadKind::Binary).is_ok() => {
                    Verdict::Yes(String::new())
                }
                Some(b"") => Verdict::No("advertised binary-upload but answered empty".into()),
                other => Verdict::No(format!("reply was `{}`", render(other))),
            },
        );
    } else {
        report.add(
            "`x` (binary read) works as advertised",
            Verdict::Skipped("no binary-upload".into()),
        );
    }

    // ── Pipelining, in no-ack mode only ───────────────────────────────────────
    if c1.codec.ack_mode() == AckMode::NoAck && baseline_ok {
        c1.send_packet(&read)?;
        c1.send_packet(&packet::mem_read(opts.addr + 4, 4, MemoryReadKind::Hex))?;
        let a = c1.next_reply(c1.reply_timeout())?;
        let b = c1.next_reply(c1.reply_timeout())?;
        report.add(
            "tolerates 2 outstanding requests (no-ack)",
            if a.is_some() && b.is_some() {
                Verdict::Yes("both replies arrived".into())
            } else {
                Verdict::No(format!("got {} of 2 replies", a.is_some() as u8 + b.is_some() as u8))
            },
        );
    } else {
        report.add(
            "tolerates 2 outstanding requests (no-ack)",
            Verdict::Skipped("needs no-ack mode and a working baseline read".into()),
        );
    }

    // ── A second connection ───────────────────────────────────────────────────
    let mut c2 = match RawRsp::connect(&addr, "conn2", opts) {
        Ok(mut c2) => {
            let q2 = c2.request(b"qSupported:multiprocess+", opts.reply_timeout)?;
            if q2.is_some() {
                report.add(
                    "accepts a second connection",
                    Verdict::Yes("and answers qSupported on it".into()),
                );
                Some(c2)
            } else {
                report.add(
                    "accepts a second connection",
                    Verdict::No("socket opened but the server never answered on it".into()),
                );
                None
            }
        }
        Err(e) => {
            report.add("accepts a second connection", Verdict::No(format!("{e}")));
            None
        }
    };

    // ── The tests that need the target running ────────────────────────────────
    if opts.no_resume {
        for q in [
            "answers `m` while a `c` is outstanding  ** THE ONE THAT MATTERS **",
            "conn2 is told about a resume issued on conn1",
        ] {
            report.add(q, Verdict::Skipped("--no-resume".into()));
        }
    } else if !baseline_ok {
        for q in [
            "answers `m` while a `c` is outstanding  ** THE ONE THAT MATTERS **",
            "conn2 is told about a resume issued on conn1",
        ] {
            report.add(
                q,
                Verdict::Skipped("baseline read failed; would not be meaningful".into()),
            );
        }
    } else {
        // Resume. Deliberately do NOT wait for the stop reply: having a `c`
        // outstanding is the state under test.
        c1.send_packet(b"vCont;c")?;

        // Give the server a moment to actually start the target.
        std::thread::sleep(Duration::from_millis(200));

        let started = Instant::now();
        c1.send_packet(&read)?;
        let during = c1.next_reply(c1.reply_timeout())?.map(|f| f.payload);
        let elapsed = started.elapsed();
        let ok = during
            .as_deref()
            .map(|p| packet::parse_mem_read_reply(p, MemoryReadKind::Hex).is_ok())
            .unwrap_or(false);
        report.add(
            "answers `m` while a `c` is outstanding  ** THE ONE THAT MATTERS **",
            if ok {
                Verdict::Yes(format!(
                    "replied in {:.1}ms — the mux design holds here",
                    elapsed.as_secs_f64() * 1000.0
                ))
            } else {
                match during.as_deref() {
                    Some(p) => Verdict::No(format!("answered `{}` — halted-only at best", render(Some(p)))),
                    None => Verdict::No("silence — the server ignores requests while running".into()),
                }
            },
        );

        // While still running, does connection 2 hear anything about it?
        if let Some(c2) = c2.as_mut() {
            // Drain whatever conn2 has had so far, then halt from conn1 and watch.
            while c2.next_frame(Duration::from_millis(50))?.is_some() {}
            c1.send_raw(&[0x03])?;
            let seen = c2.next_frame(c1.halt_timeout())?;
            report.add(
                "conn2 is told about a resume issued on conn1",
                match &seen {
                    Some(f) if packet::parse_stop_reply(&f.payload).is_some() => Verdict::Yes(format!(
                        "saw `{}` — §2's asymmetry does NOT hold here",
                        render(Some(&f.payload))
                    )),
                    Some(f) => Verdict::No(format!("saw only `{}`", render(Some(&f.payload)))),
                    None => Verdict::No(
                        "silence — expected under BOTH explanations, so this row alone proves nothing; \
                         see the conn2-resume row below"
                            .into(),
                    ),
                },
            );
        } else {
            report.add(
                "conn2 is told about a resume issued on conn1",
                Verdict::Skipped("no second connection".into()),
            );
            c1.send_raw(&[0x03])?;
        }

        // Drain conn1's stop reply so the target is left halted and settled.
        let _ = c1.next_reply(c1.halt_timeout())?;

        // ── The decisive test: does a resume issued on the SECOND connection get
        // its reply THERE? ─────────────────────────────────────────────────────
        //
        // This is what distinguishes the two possible explanations of the
        // live-watch observation, and the previous test cannot:
        //
        //   behavioural — a connection is told about a resume *it* issued. OpenOCD
        //                 works this way: `gdb_frontend_halted` gates on that
        //                 connection's own `frontend_state == TARGET_RUNNING`.
        //   positional  — only the first connection is ever told anything.
        //
        // Both predict silence when conn1 resumes and conn2 listens. They disagree
        // here: behavioural says YES, positional says NO.
        if let Some(c2) = c2.as_mut() {
            while c2.next_frame(Duration::from_millis(50))?.is_some() {}
            c2.send_packet(b"vCont;c")?;
            std::thread::sleep(Duration::from_millis(200));
            c2.send_raw(&[0x03])?;
            let own = c2.next_reply(c2.halt_timeout())?;
            report.add(
                "a resume issued on conn2 is answered on conn2",
                match own.as_ref() {
                    Some(f) if packet::parse_stop_reply(&f.payload).is_some() => Verdict::Yes(format!(
                        "saw `{}` — the asymmetry is BEHAVIOURAL (told about your own resume), not positional",
                        render(Some(&f.payload))
                    )),
                    Some(f) => Verdict::No(format!("saw only `{}`", render(Some(&f.payload)))),
                    None => Verdict::No(
                        "silence — the asymmetry really is POSITIONAL: only conn1 is ever told, whoever resumed".into(),
                    ),
                },
            );
            // Leave it halted regardless.
            let _ = c1.request(&packet::halt_reason(), c1.reply_timeout())?;
        } else {
            report.add(
                "a resume issued on conn2 is answered on conn2",
                Verdict::Skipped("no second connection".into()),
            );
        }
        if was_running {
            report.add(
                "NOTE: target was running when probed",
                Verdict::Skipped("it has been left halted — resume it yourself if that matters".into()),
            );
        }
    }

    Ok(report)
}

fn render(payload: Option<&[u8]>) -> String {
    match payload {
        None => "<no reply>".to_string(),
        Some(p) => p
            .iter()
            .take(60)
            .map(|&b| {
                if (0x20..=0x7e).contains(&b) {
                    (b as char).to_string()
                } else {
                    format!("\\x{b:02x}")
                }
            })
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    /// A fake gdb-server, scripted with (expected-request-prefix, reply) pairs.
    /// Anything unmatched gets an empty reply, which is RSP for "unsupported".
    fn fake_server(
        script: Vec<(&'static str, &'static str)>,
        answer_while_running: bool,
    ) -> (u16, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            // Serve both connections the probe may open.
            for conn in listener.incoming().take(2) {
                let Ok(mut sock) = conn else { continue };
                let script = script.clone();
                std::thread::spawn(move || {
                    let mut codec = PacketCodec::new();
                    // Per-connection, exactly like OpenOCD's `frontend_state`: this
                    // connection is only told about a resume it issued itself.
                    let mut running = false;
                    let mut buf = [0u8; 4096];
                    loop {
                        let Ok(n) = sock.read(&mut buf) else { return };
                        if n == 0 {
                            return;
                        }
                        codec.feed(&buf[..n]);
                        while let Some(frame) = codec.next_frame() {
                            match frame.kind {
                                FrameKind::Interrupt => {
                                    running = false;
                                    let _ = sock.write_all(&encode_packet(b"T02"));
                                }
                                FrameKind::Packet => {
                                    let p = String::from_utf8_lossy(&frame.payload).to_string();
                                    if codec.ack_mode() == AckMode::Acked {
                                        let _ = sock.write_all(b"+");
                                    }
                                    if p.starts_with("vCont;c") || p == "c" {
                                        running = true;
                                        continue; // no reply until it stops
                                    }
                                    if p == "QStartNoAckMode" {
                                        let _ = sock.write_all(&encode_packet(b"OK"));
                                        codec.set_ack_mode(AckMode::NoAck);
                                        continue;
                                    }
                                    if running && p.starts_with('m') && !answer_while_running {
                                        continue; // deliberate silence
                                    }
                                    let reply = script
                                        .iter()
                                        .find(|(pre, _)| p.starts_with(pre))
                                        .map(|(_, r)| *r)
                                        .unwrap_or("");
                                    let _ = sock.write_all(&encode_packet(reply.as_bytes()));
                                }
                                _ => {}
                            }
                        }
                    }
                });
            }
        });
        (port, handle)
    }

    fn openocd_like() -> Vec<(&'static str, &'static str)> {
        vec![
            ("qSupported", "PacketSize=4000;QStartNoAckMode+;vContSupported+"),
            ("?", "T05thread:01;"),
            ("m", "deadbeef"),
        ]
    }

    #[test]
    fn a_server_that_answers_while_running_is_reported_as_such() {
        let (port, _h) = fake_server(openocd_like(), true);
        let report = run(&ProbeOptions {
            port,
            reply_timeout: Duration::from_millis(150),
            ..Default::default()
        })
        .unwrap();
        let row = report
            .rows
            .iter()
            .find(|(q, _)| q.contains("THE ONE THAT MATTERS"))
            .expect("the critical question must always be asked");
        assert!(matches!(row.1, Verdict::Yes(_)), "{:?}\n{}", row.1, report.render());
    }

    #[test]
    fn a_server_that_ignores_requests_while_running_is_reported_as_no() {
        // The result that would sink the design, so it must be detected and not
        // mistaken for a timeout in our own code.
        let (port, _h) = fake_server(openocd_like(), false);
        let report = run(&ProbeOptions {
            port,
            reply_timeout: Duration::from_millis(150),
            ..Default::default()
        })
        .unwrap();
        let row = report
            .rows
            .iter()
            .find(|(q, _)| q.contains("THE ONE THAT MATTERS"))
            .unwrap();
        match &row.1 {
            Verdict::No(note) => assert!(note.contains("silence"), "{note}"),
            other => panic!("expected No, got {other:?}\n{}", report.render()),
        }
    }

    #[test]
    fn capabilities_are_read_from_the_q_supported_reply() {
        let (port, _h) = fake_server(openocd_like(), true);
        let report = run(&ProbeOptions {
            port,
            reply_timeout: Duration::from_millis(150),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(report.caps.packet_size(), 0x4000);
        assert!(report.caps.no_ack_offered);
        assert!(!report.caps.binary_upload);
        assert!(report.q_supported.as_deref().unwrap().contains("PacketSize=4000"));
    }

    #[test]
    fn no_resume_skips_the_tests_that_move_the_target() {
        let (port, _h) = fake_server(openocd_like(), true);
        let report = run(&ProbeOptions {
            port,
            no_resume: true,
            reply_timeout: Duration::from_millis(150),
            ..Default::default()
        })
        .unwrap();
        let row = report
            .rows
            .iter()
            .find(|(q, _)| q.contains("THE ONE THAT MATTERS"))
            .unwrap();
        assert!(matches!(row.1, Verdict::Skipped(_)), "{:?}", row.1);
    }

    #[test]
    fn the_behavioural_asymmetry_is_detected_on_the_decisive_row() {
        // The fake models OpenOCD: per-connection `frontend_state`, so a connection
        // is answered about a resume it issued itself. That must come out as YES on
        // the decisive row and `no` on the conn1-resumes row -- the pair is what
        // tells behavioural apart from positional.
        let (port, _h) = fake_server(openocd_like(), true);
        let report = run(&ProbeOptions {
            port,
            reply_timeout: Duration::from_millis(200),
            ..Default::default()
        })
        .unwrap();
        let own = report
            .rows
            .iter()
            .find(|(q, _)| q.contains("conn2 is answered on conn2"))
            .expect("the decisive question must always be asked");
        assert!(
            matches!(own.1, Verdict::Yes(_)),
            "expected the behavioural verdict, got {:?}\n{}",
            own.1,
            report.render()
        );
        let cross = report
            .rows
            .iter()
            .find(|(q, _)| q.contains("resume issued on conn1"))
            .unwrap();
        assert!(matches!(cross.1, Verdict::No(_)), "{:?}", cross.1);
    }

    #[test]
    fn the_report_renders_every_question_it_asked() {
        let (port, _h) = fake_server(openocd_like(), true);
        let report = run(&ProbeOptions {
            port,
            reply_timeout: Duration::from_millis(150),
            ..Default::default()
        })
        .unwrap();
        let text = report.render();
        for (q, _) in &report.rows {
            assert!(text.contains(q), "report omitted {q:?}:\n{text}");
        }
        assert!(text.contains("PacketSize"));
    }

    #[test]
    fn connecting_to_something_that_is_not_a_gdb_port_fails_clearly() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        // Accept and say nothing.
        std::thread::spawn(move || {
            let _c = listener.incoming().next();
            std::thread::sleep(Duration::from_secs(5));
        });
        let err = run(&ProbeOptions {
            port,
            reply_timeout: Duration::from_millis(150),
            ..Default::default()
        })
        .unwrap_err();
        assert!(err.to_string().contains("qSupported"), "{err}");
    }
}

// ── CLI ──────────────────────────────────────────────────────────────────────

/// `mcu-debug-agent rsp-probe` arguments.
#[derive(Debug, clap::Parser)]
pub struct RspProbeArgs {
    /// Host the gdb-server is listening on.
    #[arg(long, default_value = "127.0.0.1")]
    pub host: String,

    /// The gdb-server's gdb port (OpenOCD 3333, J-Link 2331, …).
    #[arg(long, short)]
    pub port: u16,

    /// Address read during the tests. The default is the Cortex-M SCS/ROM base,
    /// which is readable on any ARM target and has no read side effects — unlike
    /// `DWT_PCSR`. Override for a non-ARM target.
    #[arg(long, value_parser = parse_hex_arg, default_value = "0xE0000000")]
    pub addr: u64,

    /// Milliseconds to wait for any single reply. Raise for a slow target.
    #[arg(long, default_value_t = 2500)]
    pub timeout: u64,

    /// Skip the tests that resume the target. Leaves the target untouched, at the
    /// cost of the one question no other tool can answer.
    #[arg(long)]
    pub no_resume: bool,

    /// Log every packet in both directions.
    #[arg(long, short)]
    pub verbose: bool,
}

fn parse_hex_arg(s: &str) -> Result<u64, String> {
    let t = s.trim_start_matches("0x").trim_start_matches("0X");
    u64::from_str_radix(t, 16).map_err(|e| format!("not a hex address: {e}"))
}

/// Entry point for the subcommand.
pub fn run_cli(args: RspProbeArgs) -> Result<()> {
    let opts = ProbeOptions {
        host: args.host,
        port: args.port,
        addr: args.addr,
        reply_timeout: Duration::from_millis(args.timeout),
        verbose: args.verbose,
        no_resume: args.no_resume,
    };
    if !opts.no_resume {
        eprintln!(
            "rsp-probe: this DOES resume and halt the target — it is the only way to test\n\
             whether the server answers while running. Use --no-resume to skip those tests.\n"
        );
    }
    let report = run(&opts)?;
    print!("{}", report.render());
    println!(
        "Paste the results into docs-internal/gdb-rsp.md §7 (\"The matrix to fill in\").\n\
         The row marked ** THE ONE THAT MATTERS ** decides this server's tier:\n\
         YES => Full, no => HaltedOnly at best.\n"
    );
    Ok(())
}
