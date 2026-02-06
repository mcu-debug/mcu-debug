/// Disassembly worker thread - loads objdump output and serves requests.
use crate::disasm_serializer::serialize_compact_disasm;
use crate::get_assembly::{get_disasm_from_objdump, AssemblyLine, AssemblyListing};
use crate::protocol::{disassembly_ready_notification, DisasmRequest};
use crate::transport;
use std::sync::mpsc::Receiver;
use std::time::Instant;

/// Run the disassembly worker: load objdump, notify ready, serve requests via channel.
pub fn run_disassembly_worker(elf_path: &str, req_rx: Receiver<DisasmRequest>) {
    let now = Instant::now();

    match get_disasm_from_objdump(elf_path) {
        Ok(listing) => {
            eprintln!(
                "Disassembly loaded: {} lines, {} blocks in {:.2?}",
                listing.lines.len(),
                listing.blocks.len(),
                now.elapsed()
            );

            // Send DisassemblyReady notification
            let notify =
                disassembly_ready_notification("local-session", "0.1.0", listing.lines.len());
            if let Err(e) = transport::write_json_locked(&notify) {
                eprintln!("Failed to write DisassemblyReady: {}", e);
            } else {
                eprintln!("Worker sent DisassemblyReady");
            }

            // Serve disassemble requests from main thread
            serve_disassembly_requests(listing, req_rx);
        }
        Err(e) => {
            eprintln!("Failed to load disassembly: {}", e);
        }
    }
}

/// Process incoming disassemble requests and send responses.
fn serve_disassembly_requests(listing: AssemblyListing, req_rx: Receiver<DisasmRequest>) {
    while let Ok(req) = req_rx.recv() {
        eprintln!("Worker processing request: {:?}", req);

        // Find start index in listing
        let start_index = if let Some(sa) = req.start {
            match listing.addr_map.range(sa..).next() {
                Some((_, &idx)) => idx,
                None => listing.lines.len(),
            }
        } else {
            0
        };

        let end_index = std::cmp::min(start_index + req.count, listing.lines.len());

        // Build sub-listing for requested range
        let mut sub_listing = AssemblyListing::new();
        for i in start_index..end_index {
            let rc_line = listing.lines[i].as_ref();
            let ln = AssemblyLine::new(
                rc_line.address,
                rc_line.bytes.clone(),
                rc_line.instruction.clone(),
                String::new(),
            );
            sub_listing.insert_line(ln);
        }

        // Serialize and send compact chunk
        let chunk = serialize_compact_disasm(&sub_listing, req.seq_id, true);
        if let Err(e) = transport::write_json_locked(&chunk) {
            eprintln!("Worker failed to write disasm chunk: {}", e);
        }
    }
}
