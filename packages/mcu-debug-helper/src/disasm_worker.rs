/// Disassembly worker thread - loads objdump output and serves requests.
use crate::elf_items::{LineInfoEntry, ObjectInfo};
use crate::get_assembly::{get_disasm_from_objdump, AssemblyLine, AssemblyListing};
use crate::helper_requests::{DisasmResponse, SerInstruction};
use crate::protocol::{disassembly_ready_notification, DisasmRequest};
use crate::transport;
use serde_json;
use std::collections::HashMap;
use std::sync::{mpsc::Receiver, Arc};
use std::time::Instant;

/// Run the disassembly worker: load objdump, wait for ObjectInfo, serve requests.
pub fn run_disassembly_worker(
    elf_path: &str,
    req_rx: Receiver<DisasmRequest>,
    obj_info_rx: Receiver<Arc<ObjectInfo>>,
) {
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
                disassembly_ready_notification("local-session", listing.lines.len() as u64);
            if let Err(e) = transport::write_json_locked(&notify) {
                eprintln!("Failed to write DisassemblyReady: {}", e);
            } else {
                eprintln!("Worker sent DisassemblyReady");
            }

            // Wait for ObjectInfo from main thread (blocks until available)
            eprintln!("Worker waiting for ObjectInfo...");
            let obj_info = match obj_info_rx.recv() {
                Ok(info) => {
                    eprintln!(
                        "Worker received ObjectInfo with {} memory regions",
                        info.memory_ranges.len()
                    );
                    // We have to take info from the FileTable and the addr-to-line mapping and add that to
                    // the disassembly instructions before we can serve requests.
                    for addr2line in &info.addr_to_line.entries {
                        let addr = addr2line.0;
                        let entry: &LineInfoEntry = &addr2line.1;
                        if let Some(line_info) = listing.get_line_by_addr(*addr) {
                            // For simplicity, we just take the first line info entry if there are multiple
                            let mut min = i32::MAX;
                            let mut max = i32::MIN;
                            for line in &entry.line {
                                let line_num = line.get() as i32;
                                if line_num < min {
                                    min = line_num;
                                }
                                if line_num > max {
                                    max = line_num;
                                }
                            }
                            line_info.set_source_info(entry.file_id as i32, min, -1, max, -1);
                        }
                    }
                    Some(info)
                }
                Err(_) => {
                    eprintln!("Warning: ObjectInfo channel closed before receiving data");
                    None
                }
            };

            // Serve disassemble requests from main thread
            // TODO: Use obj_info for symbol/line info enrichment
            serve_disassembly_requests(listing, req_rx, obj_info);
        }
        Err(e) => {
            eprintln!("Failed to load disassembly: {}", e);
        }
    }
}

/// Process incoming disassemble requests and send responses.
fn serve_disassembly_requests(
    listing: AssemblyListing,
    req_rx: Receiver<DisasmRequest>,
    obj_info_: Option<Arc<ObjectInfo>>,
) {
    // TODO: Use obj_info to enrich responses:
    // - obj_info.dwarf_symbols / elf_symbols for function names
    // - obj_info.addr_to_line for source line mapping
    // - obj_info.file_table for file paths

    while let Ok(req) = req_rx.recv() {
        eprintln!("Worker processing request: {:?}", req);
        let obj_info = obj_info_.as_ref();
        let global_file_table = obj_info.map(|info| &info.file_table);

        let before = if (req.instr_offset) < 0 {
            req.instr_offset.abs() as usize
        } else {
            0
        };

        let after = req.instr_count as usize - before as usize;
        let window = listing.get_window(req.start_addr, before, after);
        let mut func_table: HashMap<u32, String> = HashMap::new();
        let mut file_table: HashMap<u32, String> = HashMap::new();
        for instr in &window {
            let func_id = instr.function_id.get();
            let file_id = instr.file_id.get();
            if func_id >= 0 && func_table.get(&(func_id as u32)).is_none() {
                let function_name = listing.blocks[func_id as usize].name.clone();
                func_table.insert(func_id as u32, function_name);
            }
            if file_id >= 0 && file_table.get(&(file_id as u32)).is_none() {
                let file_name = global_file_table
                    .and_then(|ft| ft.get_by_id(file_id as u32))
                    .cloned()
                    .unwrap_or_else(|| format!("file_{}", file_id));
                file_table.insert(file_id as u32, file_name);
            }
        }
        let ser_instructions: Vec<SerInstruction> = window
            .iter()
            .map(|instr| SerInstruction::from_assembly_line(instr))
            .collect();
        let response = DisasmResponse::new(req.seq_id, file_table, func_table, ser_instructions);
        let response_json = serde_json::to_string(&response).unwrap();
        if let Err(e) = transport::write_json_locked(&serde_json::from_str(&response_json).unwrap())
        {
            eprintln!("Worker failed to write disasm response: {}", e);
        } else {
            eprintln!("Worker sent disasm response for seq_id {}", req.seq_id);
        }
    }
}

impl DisasmResponse {
    pub fn new(
        seq: u64,
        file_table: HashMap<u32, String>,
        func_table: HashMap<u32, String>,
        instructions: Vec<SerInstruction>,
    ) -> Self {
        Self {
            req: "disasm".to_string(),
            seq,
            file_table,
            func_table,
            instructions,
        }
    }
}

impl SerInstruction {
    pub fn from_assembly_line(instr: &AssemblyLine) -> Self {
        Self {
            a: format!("{:x}", instr.address),
            b: instr.bytes.clone(),
            i: instr.instruction.clone(),
            f: instr.function_id.get(),
            F: instr.file_id.get(),
            sl: instr.start_line.get(),
            el: instr.end_line.get(),
        }
    }
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
            -1,
        );
        let l2 = AssemblyLine::new(
            0x1002,
            "01 30".to_string(),
            "adds r0,r1".to_string(),
            " 1002: 01 30 adds r0,r1".to_string(),
            -1,
        );
        listing.insert_line(l1);
        listing.insert_line(l2);

        let s = DisasmResponse::new(
            42,
            HashMap::from([(1, "file1.c".to_string())]),
            HashMap::from([(2, "func1".to_string())]),
            vec![
                SerInstruction::from_assembly_line(&listing.lines[0]),
                SerInstruction::from_assembly_line(&listing.lines[1]),
            ],
        );
        let json_str = serde_json::to_string_pretty(&s).unwrap();
        println!("{}", json_str);
    }
}
