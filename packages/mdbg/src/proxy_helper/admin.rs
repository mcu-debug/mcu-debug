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

//! Admin control channel (Tier 1, Phase C).
//!
//! Proxy-global operations — `status`, `shutdown` — travel over the **same**
//! listener as sessions. A newly accepted connection is discriminated by its
//! first byte: a funnel session's first frame is a control message on stream 0
//! (first byte `0x00`); an admin request is a single line of JSON (first byte
//! `{`). See `discriminate` and `run.rs`'s accept loop.
//!
//! Wire format: one line of JSON in, one line of JSON out, then close.

use std::io::{Read, Write};
use std::net::{Shutdown, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

use crate::proxy_helper::lifetime::Lifetime;
use crate::proxy_helper::singleton::{self, Endpoint};

/// How a freshly accepted connection should be handled.
pub enum Kind {
    /// Funnel session (first byte `0x00`).
    Session,
    /// Admin request (first byte `{`).
    Admin,
    /// Neither — silent client, timeout, or junk. Close it.
    Unknown,
}

/// Peek (non-destructively) at the first byte to classify the connection.
/// Uses a read timeout so a client that connects but sends nothing can't stall
/// the handling thread forever.
pub fn discriminate(stream: &TcpStream) -> Kind {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let mut b = [0u8; 1];
    let kind = match stream.peek(&mut b) {
        Ok(1) if b[0] == 0x00 => Kind::Session,
        Ok(1) if b[0] == b'{' => Kind::Admin,
        _ => Kind::Unknown,
    };
    // Restore blocking reads for the session path (peek doesn't consume, so the
    // funnel stream is intact).
    let _ = stream.set_read_timeout(None);
    kind
}

// ── Wire types ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdminRequest {
    pub v: u32,
    /// `"status"` | `"shutdown"` | `"upgrade"`.
    pub cmd: String,
    #[serde(default)]
    pub token: String,
    /// For `shutdown`: drain (wait for sessions) vs. … (Phase C only drains).
    #[serde(default)]
    pub graceful: bool,
    /// For `upgrade`: the requesting (newer) proxy's version. The running proxy
    /// steps down only if this is strictly newer than its own.
    #[serde(default)]
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatusInfo {
    pub pid: u32,
    pub version: String,
    pub port: u16,
    pub instance: String,
    pub state: String,
    /// Active refs = live sessions + (window keep-alive, if `--heartbeat`).
    pub active_refs: usize,
    pub uptime_secs: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdminResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<StatusInfo>,
    /// Human-readable note (e.g. "draining: 2 active session(s)").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl AdminResponse {
    fn err(msg: impl Into<String>) -> Self {
        AdminResponse {
            ok: false,
            error: Some(msg.into()),
            status: None,
            message: None,
        }
    }
}

// ── Line-JSON framing ─────────────────────────────────────────────────────────

/// Read a single `\n`-terminated line without over-reading past it (so the
/// funnel stream is never disturbed if we misclassify).
fn read_line(stream: &mut TcpStream) -> Result<String> {
    let mut buf = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        match stream.read(&mut byte)? {
            0 => break,
            _ => {
                if byte[0] == b'\n' {
                    break;
                }
                buf.push(byte[0]);
                if buf.len() > 64 * 1024 {
                    bail!("admin request line too long");
                }
            }
        }
    }
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

fn write_line(stream: &mut TcpStream, resp: &AdminResponse) -> Result<()> {
    let mut s = serde_json::to_string(resp)?;
    s.push('\n');
    stream.write_all(s.as_bytes())?;
    stream.flush()?;
    Ok(())
}

// ── Server side ───────────────────────────────────────────────────────────────

/// Agent-global state the admin handler needs. One is built in `run()` and
/// shared (via `Arc`) with every admin connection.
pub struct AdminContext {
    pub token: String,
    pub lifetime: Arc<Lifetime>,
    pub draining: Arc<AtomicBool>,
    /// Set on `upgrade`: this proxy has handed its identity to a newer one, so on
    /// exit it must release the lock early and NOT delete `endpoint.json` (the
    /// successor owns it).
    pub superseded: Arc<AtomicBool>,
    pub stop_flag: Arc<AtomicBool>,
    /// Needed to wake every blocked `accept()` on shutdown, not just the published
    /// address. This is an `Arc` cycle (an accept loop holds this context, which holds
    /// the set) but a self-limiting one: the accept threads exit during shutdown, which
    /// drops their closures and breaks it.
    pub accept_set: Arc<crate::proxy_helper::listeners::AcceptSet>,
    pub local_port: u16,
    pub endpoint_path: PathBuf,
    pub pid: u32,
    pub version: String,
    pub instance: String,
    pub started_at_unix: u64,
}

/// Handle one admin connection: read the request line, act, reply, close.
pub fn handle(mut stream: TcpStream, ctx: &Arc<AdminContext>) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let resp = match read_line(&mut stream).and_then(|l| {
        serde_json::from_str::<AdminRequest>(l.trim()).context("invalid admin request JSON")
    }) {
        Ok(req) if req.token != ctx.token => AdminResponse::err("bad token"),
        Ok(req) => dispatch(&req, ctx),
        Err(e) => AdminResponse::err(format!("{e:#}")),
    };
    let _ = write_line(&mut stream, &resp);
    let _ = stream.shutdown(Shutdown::Both);
}

fn dispatch(req: &AdminRequest, ctx: &Arc<AdminContext>) -> AdminResponse {
    match req.cmd.as_str() {
        "status" => AdminResponse {
            ok: true,
            error: None,
            message: None,
            status: Some(StatusInfo {
                pid: ctx.pid,
                version: ctx.version.clone(),
                port: ctx.local_port,
                instance: ctx.instance.clone(),
                state: if ctx.draining.load(Ordering::SeqCst) {
                    "draining".into()
                } else {
                    "active".into()
                },
                active_refs: ctx.lifetime.count(),
                uptime_secs: Endpoint::now_unix().saturating_sub(ctx.started_at_unix),
            }),
        },
        "shutdown" => begin_drain(ctx),
        "upgrade" => begin_upgrade(req, ctx),
        other => AdminResponse::err(format!("unknown admin cmd: {other}")),
    }
}

/// Hand off to a newer proxy: stop accepting immediately (so the lock is
/// released for the successor at once), keep serving existing sessions to
/// completion, and do not delete `endpoint.json` on exit. Idempotent.
fn begin_upgrade(req: &AdminRequest, ctx: &Arc<AdminContext>) -> AdminResponse {
    if !singleton::is_newer(&req.version, &ctx.version) {
        return AdminResponse::err(format!(
            "requester v{} is not newer than running v{}",
            req.version, ctx.version
        ));
    }
    let active = ctx.lifetime.count();
    if !ctx.superseded.swap(true, Ordering::SeqCst) {
        ctx.draining.store(true, Ordering::SeqCst);
        if let Ok(mut ep) = singleton::read_endpoint(&ctx.endpoint_path) {
            ep.state = "draining".into();
            let _ = singleton::write_endpoint_atomic(&ctx.endpoint_path, &ep);
        }
        // Break the accept loop NOW so run() releases the lock immediately; the
        // successor is waiting to acquire it. Existing sessions keep running.
        log::info!(
            "Superseded by v{} — releasing identity; {active} session(s) will finish here",
            req.version
        );
        crate::proxy_helper::run::trigger_graceful_shutdown(&ctx.stop_flag, &ctx.accept_set);
    }
    AdminResponse {
        ok: true,
        error: None,
        status: None,
        message: Some(format!(
            "superseded: releasing lock; {active} session(s) finish on the old proxy"
        )),
    }
}

/// Enter drain: stop accepting new sessions, mark the endpoint `draining`, and
/// exit once the last session ends. Idempotent.
fn begin_drain(ctx: &Arc<AdminContext>) -> AdminResponse {
    let active = ctx.lifetime.count();

    if !ctx.draining.swap(true, Ordering::SeqCst) {
        // First drain request: publish the state and start the drain monitor.
        if let Ok(mut ep) = singleton::read_endpoint(&ctx.endpoint_path) {
            ep.state = "draining".into();
            let _ = singleton::write_endpoint_atomic(&ctx.endpoint_path, &ep);
        }
        let ctx = Arc::clone(ctx);
        std::thread::spawn(move || {
            // Zero window → return as soon as the last ref drops.
            ctx.lifetime.wait_until_idle(Duration::ZERO);
            log::info!("Drain complete — no active sessions; shutting down");
            crate::proxy_helper::run::trigger_graceful_shutdown(&ctx.stop_flag, &ctx.accept_set);
        });
    }

    AdminResponse {
        ok: true,
        error: None,
        status: None,
        message: Some(format!(
            "draining: {active} active session(s); will exit when they finish"
        )),
    }
}

// ── Client side (invoked by `mdbg proxy --status` / `--shutdown`) ─────────────

/// Ask the running (older) proxy to step down in favor of our newer version.
/// Returns once it has acknowledged (it releases its lock right after).
pub fn request_upgrade(endpoint: &Endpoint, my_version: &str) -> Result<AdminResponse> {
    let req = AdminRequest {
        v: 1,
        cmd: "upgrade".into(),
        token: endpoint.token.clone(),
        graceful: true,
        version: my_version.into(),
    };
    let resp = query(endpoint, &req)?;
    if !resp.ok {
        bail!(
            "running proxy refused handover: {}",
            resp.error.unwrap_or_default()
        );
    }
    Ok(resp)
}

/// Send an admin request to the running proxy for `endpoint` and return its reply.
pub fn query(endpoint: &Endpoint, req: &AdminRequest) -> Result<AdminResponse> {
    let mut stream = TcpStream::connect(("127.0.0.1", endpoint.port))
        .with_context(|| format!("could not connect to proxy on port {}", endpoint.port))?;
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    let mut line = serde_json::to_string(req)?;
    line.push('\n');
    stream.write_all(line.as_bytes())?;
    stream.flush()?;
    let reply = read_line(&mut stream)?;
    serde_json::from_str(reply.trim()).context("invalid admin reply JSON")
}
