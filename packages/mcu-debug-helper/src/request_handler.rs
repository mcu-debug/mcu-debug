/// Request parsing and dispatch for the main request loop.

use crate::protocol::{parse_hex_or_dec, DisasmRequest};
use serde_json::Value;
use std::sync::mpsc::Sender;

/// Parse and dispatch a disassemble request from the DA.
///
/// Supports both helper-style JSON-RPC and DAP-style forwarded requests.
pub fn dispatch_request(msg: &Value, req_tx: &Sender<DisasmRequest>) -> bool {
    // Try helper-style: { "method": "disassemble", "params": { start, count }, "id": N }
    if let Some(method) = msg.get("method").and_then(|v| v.as_str()) {
        if method.to_lowercase().contains("disassemble") {
            if let Some(req) = parse_helper_style(msg) {
                if req_tx.send(req).is_err() {
                    eprintln!("Failed to send request to worker");
                }
                return true;
            }
        }
    }

    // Try DAP-style: { "command": "disassemble", "arguments": {...}, "seq": N }
    if let Some(cmd) = msg.get("command").and_then(|v| v.as_str()) {
        if cmd.eq_ignore_ascii_case("disassemble") {
            if let Some(req) = parse_dap_style(msg) {
                if req_tx.send(req).is_err() {
                    eprintln!("Failed to send request to worker");
                }
                return true;
            }
        }
    }

    false
}

/// Parse helper-style disassemble request.
fn parse_helper_style(msg: &Value) -> Option<DisasmRequest> {
    let params = msg.get("params")?;
    let start_addr = params
        .get("start")
        .and_then(|v| v.as_str())
        .and_then(parse_hex_or_dec);
    let count = params
        .get("count")
        .and_then(|v| v.as_u64())
        .unwrap_or(400) as usize;
    let seq_id = msg.get("id").and_then(|v| v.as_u64()).unwrap_or(1);

    Some(DisasmRequest {
        start: start_addr,
        count,
        seq_id,
    })
}

/// Parse DAP-style forwarded disassemble request.
fn parse_dap_style(msg: &Value) -> Option<DisasmRequest> {
    let args = msg.get("arguments")?;

    // Try "start" or "memoryReference"
    let start_addr = args
        .get("start")
        .and_then(|v| v.as_str())
        .and_then(parse_hex_or_dec)
        .or_else(|| {
            args.get("memoryReference")
                .and_then(|v| v.as_str())
                .and_then(parse_hex_or_dec)
        });

    let count = args
        .get("instructionCount")
        .and_then(|v| v.as_u64())
        .unwrap_or(400) as usize;

    let seq_id = msg.get("seq").and_then(|v| v.as_u64()).unwrap_or(1);

    Some(DisasmRequest {
        start: start_addr,
        count,
        seq_id,
    })
}
