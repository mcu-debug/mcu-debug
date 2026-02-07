/// Protocol message types and helpers for the helper ↔ DA communication.
use crate::helper_requests::HelperEvent;
use serde_json::{json, Value};

/// Request from main thread to disassembly worker. This is our internal representation of a disassemble request,
/// parsed from DAP-style forwarded requests.
#[derive(Debug)]
pub struct DisasmRequest {
    // memory_reference is used to correlate with known good address. For example a current PC or an
    // instruction address from a breakpoint, or something we returned as a valid instruction address
    // in a previous response.
    pub memory_reference: u64,
    pub start_addr: u64, // This the the memory_reference plus/minus any byte offset
    pub instr_offset: i64,
    pub instr_count: u64,
    pub seq_id: u64,
}

/// Wrap an event in a JSON-RPC notification envelope for sending to the DA.
pub fn wrap_event_as_notification(event: &HelperEvent) -> Value {
    json!({
        "jsonrpc": "2.0",
        "method": "HelperEvent",
        "params": event
    })
}

/// Build a SymbolTableReady event notification.
pub fn symbol_table_ready_notification(session_id: &str, version: &str) -> Value {
    let event = HelperEvent::SymbolTableReady {
        session_id: session_id.to_string(),
        version: version.to_string(),
    };
    wrap_event_as_notification(&event)
}

/// Build a DisassemblyReady event notification.
pub fn disassembly_ready_notification(session_id: &str, instruction_count: u64) -> Value {
    let event = HelperEvent::DisassemblyReady {
        session_id: session_id.to_string(),
        instruction_count,
    };
    wrap_event_as_notification(&event)
}
