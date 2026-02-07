/// Request parsing and dispatch for the main request loop.
use crate::helper_requests::*;
use crate::protocol::DisasmRequest;
use serde_json::Value;
use std::sync::mpsc::Sender;

/// Parse and dispatch requests from the DA based on the 'req' discriminant.
///
/// All requests have a 'req' field that identifies the request type. We peek at this
/// field, then deserialize into the appropriate typed struct.
pub fn dispatch_request(msg: &Value, req_tx: &Sender<DisasmRequest>) -> bool {
    // Peek at the 'req' discriminant to determine request type
    let req_type = msg
        .get("req")
        .and_then(|v| v.as_str())
        .or_else(|| msg.get("command").and_then(|v| v.as_str()));

    match req_type {
        Some("disasm") | Some("disassemble") => handle_disassemble_request(msg, req_tx),
        Some("globals") => handle_globals_request(msg),
        Some("statics") => handle_statics_request(msg),
        Some("symbolLookup") => handle_symbol_lookup_request(msg),
        _ => {
            eprintln!("Unknown request type: {:?}", req_type);
            false
        }
    }
}

/// Handle disassemble request - deserialize and forward to worker
fn handle_disassemble_request(msg: &Value, req_tx: &Sender<DisasmRequest>) -> bool {
    // Try to deserialize as our typed DisassembleRequest struct
    match serde_json::from_value::<DisassembleRequest>(msg.clone()) {
        Ok(typed_req) => {
            // Convert to internal DisasmRequest format for worker
            if let Some(internal_req) = convert_to_internal_disasm_request(&typed_req) {
                if req_tx.send(internal_req).is_err() {
                    eprintln!("Failed to send request to worker");
                    return false;
                }
                return true;
            }
            false
        }
        Err(e) => {
            eprintln!("Failed to parse DisassembleRequest: {}", e);
            false
        }
    }
}

/// Handle globals request - query global symbols
fn handle_globals_request(msg: &Value) -> bool {
    match serde_json::from_value::<GlobalsRequest>(msg.clone()) {
        Ok(_typed_req) => {
            // TODO: Implement globals query
            eprintln!("Globals request received but not yet implemented");
            true
        }
        Err(e) => {
            eprintln!("Failed to parse GlobalsRequest: {}", e);
            false
        }
    }
}

/// Handle statics request - query static symbols in a file
fn handle_statics_request(msg: &Value) -> bool {
    match serde_json::from_value::<StaticsRequest>(msg.clone()) {
        Ok(_typed_req) => {
            // TODO: Implement statics query
            eprintln!("Statics request received but not yet implemented");
            true
        }
        Err(e) => {
            eprintln!("Failed to parse StaticsRequest: {}", e);
            false
        }
    }
}

/// Handle symbol lookup request - by name or address
fn handle_symbol_lookup_request(msg: &Value) -> bool {
    // Try to parse as name lookup first
    if let Ok(_typed_req) = serde_json::from_value::<SymbolLookupNameRequest>(msg.clone()) {
        // TODO: Implement symbol lookup by name
        eprintln!("Symbol lookup by name received but not yet implemented");
        return true;
    }

    // Try to parse as address lookup
    if let Ok(_typed_req) = serde_json::from_value::<SymbolLookupAddressRequest>(msg.clone()) {
        // TODO: Implement symbol lookup by address
        eprintln!("Symbol lookup by address received but not yet implemented");
        return true;
    }

    eprintln!("Failed to parse SymbolLookupRequest");
    false
}

/// Convert from the typed DisassembleRequest to the internal DisasmRequest format
fn convert_to_internal_disasm_request(req: &DisassembleRequest) -> Option<DisasmRequest> {
    // Parse the hex memory reference
    let base_addr = parse_hex_address(&req.arguments.memoryReference)?;

    // Apply byte offset
    let mut start_addr = base_addr;
    if let Some(offset) = req.arguments.offset {
        start_addr = if offset < 0 {
            start_addr.checked_sub((-offset) as u64)?
        } else {
            start_addr.checked_add(offset as u64)?
        };
    }

    let instr_offset = req.arguments.instructionOffset.unwrap_or(0) as i64;
    let instr_count = req.arguments.instructionCount as u64;

    Some(DisasmRequest {
        memory_reference: base_addr,
        start_addr,
        instr_offset,
        instr_count,
        seq_id: req.seq,
    })
}

/// Parse hex address from string (supports "0x1234" or "1234" format)
fn parse_hex_address(input: &str) -> Option<u64> {
    let trimmed = input.trim();
    let hex_str = trimmed.strip_prefix("0x").unwrap_or(trimmed);
    u64::from_str_radix(hex_str, 16).ok()
}
