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

/// Protocol message types and helpers for the helper ↔ DA communication.
use crate::da_helper::helper_requests::HelperEvent;
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
        "args": event
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

pub fn rtt_found_notification(session_id: &str, address: &str) -> Value {
    let event = HelperEvent::RTTFound {
        session_id: session_id.to_string(),
        address: address.to_string(),
    };
    wrap_event_as_notification(&event)
}
