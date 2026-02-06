/// Protocol message types and helpers for the helper ↔ DA communication.

use serde_json::json;

/// Request from main thread to disassembly worker.
#[derive(Debug)]
pub struct DisasmRequest {
    pub start: Option<u64>,
    pub count: usize,
    pub seq_id: u64,
}

/// Build a SymbolTableReady notification.
pub fn symbol_table_ready_notification(session_id: &str, version: &str) -> serde_json::Value {
    json!({
        "jsonrpc": "2.0",
        "method": "SymbolTableReady",
        "params": {
            "sessionId": session_id,
            "helperVersion": version
        }
    })
}

/// Build a DisassemblyReady notification.
pub fn disassembly_ready_notification(
    session_id: &str,
    version: &str,
    lines: usize,
) -> serde_json::Value {
    json!({
        "jsonrpc": "2.0",
        "method": "DisassemblyReady",
        "params": {
            "sessionId": session_id,
            "helperVersion": version,
            "lines": lines,
        }
    })
}

/// Parse a hex or decimal string to u64.
pub fn parse_hex_or_dec(s: &str) -> Option<u64> {
    if s.starts_with("0x") || s.starts_with("0X") {
        u64::from_str_radix(&s[2..], 16).ok()
    } else {
        s.parse::<u64>().ok()
    }
}
