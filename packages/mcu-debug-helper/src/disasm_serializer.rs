use serde_json::json;
use serde_json::Value;

use crate::get_assembly::AssemblyListing;

/// Serialize `AssemblyListing` into a compact JSON message.
/// Format:
/// {
///   "t": "disasm_chunk",
///   "id": <seq id>,
///   "start": "0x...",
///   "final": bool,
///   "lines": [ [addr_hex, bytes, instr], ... ]
/// }
pub fn serialize_compact_disasm(
    listing: &AssemblyListing,
    seq_id: u64,
    final_chunk: bool,
) -> Value {
    let mut lines: Vec<Value> = Vec::with_capacity(listing.lines.len());
    for rc_line in &listing.lines {
        // Address as hex string for JS safe handling
        let addr_hex = format!("0x{:x}", rc_line.address);
        let bytes = rc_line.bytes.clone();
        let instr = rc_line.instruction.clone();
        lines.push(json!([addr_hex, bytes, instr]));
    }

    let start = listing
        .lines
        .first()
        .map(|l| format!("0x{:x}", l.address))
        .unwrap_or_else(|| "0x0".to_string());

    json!({
        "t": "disasm_chunk",
        "id": seq_id,
        "start": start,
        "final": final_chunk,
        "lines": Value::Array(lines),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::get_assembly::{AssemblyLine, AssemblyListing};

    #[test]
    fn serialize_compact_basic() {
        let mut listing = AssemblyListing::new();
        // create two lines
        let l1 = AssemblyLine::new(
            0x1000,
            "00 20".to_string(),
            "movs r0,#0".to_string(),
            " 1000: 00 20 movs r0,#0".to_string(),
        );
        let l2 = AssemblyLine::new(
            0x1002,
            "01 30".to_string(),
            "adds r0,r1".to_string(),
            " 1002: 01 30 adds r0,r1".to_string(),
        );
        listing.insert_line(l1);
        listing.insert_line(l2);

        let v = serialize_compact_disasm(&listing, 7, true);
        assert_eq!(v["t"], "disasm_chunk");
        assert_eq!(v["id"], 7);
        assert_eq!(v["final"], true);
        let lines = v["lines"].as_array().expect("lines array");
        assert_eq!(lines.len(), 2);
        let first = lines[0].as_array().expect("line array");
        assert_eq!(first.len(), 3);
        assert!(first[0].as_str().unwrap().starts_with("0x"));
    }
}
