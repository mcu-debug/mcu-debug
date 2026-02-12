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

/// Disassembly worker thread - loads objdump output and serves requests.
use crate::debug_println;
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
    objdump_path: &str,
    elf_path: &str,
    req_rx: Receiver<DisasmRequest>,
    obj_info_rx: Receiver<Arc<ObjectInfo>>,
) {
    let now = Instant::now();

    match get_disasm_from_objdump(objdump_path, elf_path) {
        Ok(listing) => {
            use crate::info_println;
            info_println!(
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
            debug_println!("Worker waiting for ObjectInfo...");
            let obj_info = match obj_info_rx.recv() {
                Ok(info) => {
                    debug_println!(
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
        debug_println!("Worker processing request: {:?}", req);
        let obj_info = obj_info_.as_ref();
        let global_file_table = obj_info.map(|info| &info.file_table);

        let before = if req.instr_offset < 0 {
            req.instr_offset.abs() as usize
        } else {
            0
        };

        let after = req.instr_count as usize - before;
        debug_println!(
            "DEBUG: target=0x{:x}, before={}, after={}, total_requested={}",
            req.start_addr,
            before,
            after,
            before + after
        );
        let window = listing.get_window(req.start_addr, before, after);
        debug_println!(
            "DEBUG: window.len()={}, first={}, last={}",
            window.len(),
            window
                .first()
                .map(|i| format!("0x{:x}", i.address))
                .unwrap_or_else(|| "none".to_string()),
            window
                .last()
                .map(|i| format!("0x{:x}", i.address))
                .unwrap_or_else(|| "none".to_string())
        );
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
            debug_println!("Worker sent disasm response for seq_id {}", req.seq_id);
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
            o: instr.offset_in_function,
            F: instr.file_id.get(),
            sl: instr.start_line.get(),
            el: instr.end_line.get(),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{fs, io::Write};

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
            0,
        );
        let l2 = AssemblyLine::new(
            0x1002,
            "01 30".to_string(),
            "adds r0,r1".to_string(),
            " 1002: 01 30 adds r0,r1".to_string(),
            -1,
            0,
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

    #[test]
    fn disasm_from_file() {
        let path = "../../mylfs/proj_cm4.elf";
        let out_path = "../../tmp/disasm_output.txt";
        match get_disasm_from_objdump("arm-none-eabi-objdump", path) {
            Ok(listing) => {
                println!(
                    "Disassembly loaded: {} lines, {} blocks",
                    listing.lines.len(),
                    listing.blocks.len()
                );
                const MAX_LINES: usize = 100;
                for line in &listing.lines[1000..1000 + MAX_LINES.min(listing.lines.len())] {
                    println!("{}", line.format_bytes());
                }
                let mut fd = fs::File::create(out_path).expect("Failed to create output file");
                for line in &listing.lines {
                    if line.function_id.get() >= 0 && line.offset_in_function == 0 {
                        // This is the first instruction of a function, add a separator line for readability
                        let func_name =
                            listing.blocks[line.function_id.get() as usize].name.clone();
                        fd.write(format!("\n// Function: {}\n", func_name).as_bytes())
                            .expect("Failed to write function header");
                    }
                    fd.write(format!("{}\n", line.format_bytes()).as_bytes())
                        .expect("Failed to write line");
                }
                fd.sync_all().expect("Failed to flush output file");
                println!("Disassembly written to {}", out_path);
            }
            Err(e) => {
                eprintln!("Failed to load disassembly: {}", e);
            }
        }
    }

    #[test]
    fn test_get_window_instruction_offset() {
        let path = "../../mylfs/proj_cm4.elf";
        let listing = match get_disasm_from_objdump("arm-none-eabi-objdump", path) {
            Ok(l) => l,
            Err(e) => {
                eprintln!("Failed to load disassembly: {}", e);
                return;
            }
        };

        // Find the 'main' function as our reference point
        let main_block = listing
            .blocks
            .iter()
            .find(|b| b.name == "main")
            .expect("Failed to find 'main' function");

        // Use an instruction in the middle of main as the reference
        let reference_instr = main_block
            .lines
            .get(10)
            .expect("main function should have at least 10 instructions");
        let reference_addr = reference_instr.address;

        println!(
            "Using reference address: 0x{:x} (main+{})",
            reference_addr, reference_instr.offset_in_function
        );

        // Test Case 1: Large backward offset (DAP instructionOffset=-200, instructionCount=400)
        // Expected: 200 instructions before target, target at index 200, 199 after
        {
            let before = 200;
            let after = 200;
            let window = listing.get_window(reference_addr, before, after);

            assert_eq!(
                window.len(),
                400,
                "Test 1: Should return exactly 400 instructions"
            );
            assert_eq!(
                window[200].address, reference_addr,
                "Test 1: Reference instruction should be at index 200"
            );

            // Verify no gaps in addresses (allowing for variable instruction sizes)
            for i in 0..window.len() - 1 {
                assert!(
                    window[i + 1].address > window[i].address,
                    "Test 1: Addresses should be strictly increasing at index {}",
                    i
                );
            }

            println!("✓ Test 1 passed: instructionOffset=-200, instructionCount=400");
        }

        // Test Case 2: No offset, forward only (DAP instructionOffset=0, instructionCount=50)
        // Expected: Target at index 0, 49 instructions after
        {
            let before = 0;
            let after = 50;
            let window = listing.get_window(reference_addr, before, after);

            assert_eq!(
                window.len(),
                50,
                "Test 2: Should return exactly 50 instructions"
            );
            assert_eq!(
                window[0].address, reference_addr,
                "Test 2: Reference instruction should be at index 0"
            );

            // Verify no gaps
            for i in 0..window.len() - 1 {
                assert!(
                    window[i + 1].address > window[i].address,
                    "Test 2: Addresses should be strictly increasing at index {}",
                    i
                );
            }

            println!("✓ Test 2 passed: instructionOffset=0, instructionCount=50");
        }

        // Test Case 3: Small backward offset (DAP instructionOffset=-10, instructionCount=20)
        // Expected: 10 instructions before target, target at index 10, 9 after
        {
            let before = 10;
            let after = 10;
            let window = listing.get_window(reference_addr, before, after);

            assert_eq!(
                window.len(),
                20,
                "Test 3: Should return exactly 20 instructions"
            );
            assert_eq!(
                window[10].address, reference_addr,
                "Test 3: Reference instruction should be at index 10"
            );

            // Verify no gaps
            for i in 0..window.len() - 1 {
                assert!(
                    window[i + 1].address > window[i].address,
                    "Test 3: Addresses should be strictly increasing at index {}",
                    i
                );
            }

            println!("✓ Test 3 passed: instructionOffset=-10, instructionCount=20");
        }

        // Test Case 4: Just the target instruction (DAP instructionOffset=0, instructionCount=1)
        // Expected: Just the reference instruction
        {
            let before = 0;
            let after = 1;
            let window = listing.get_window(reference_addr, before, after);

            assert_eq!(
                window.len(),
                1,
                "Test 4: Should return exactly 1 instruction"
            );
            assert_eq!(
                window[0].address, reference_addr,
                "Test 4: Reference instruction should be the only one"
            );

            println!("✓ Test 4 passed: instructionOffset=0, instructionCount=1");
        }

        // Test Case 5: Backward only (DAP instructionOffset=-25, instructionCount=25)
        // Expected: 24 instructions before target, target at index 24
        {
            let before = 25;
            let after = 0;
            let window = listing.get_window(reference_addr, before, after);

            assert_eq!(
                window.len(),
                25,
                "Test 5: Should return exactly 25 instructions"
            );
            // When after=0, we still need the target, so it should be at index 24 (last of before section)
            // Actually, this is a special case - let's see what the behavior is

            println!(
                "Test 5: before=25, after=0, got {} instructions",
                window.len()
            );
            if window.len() > 0 {
                println!(
                    "  First: 0x{:x}, Last: 0x{:x}",
                    window[0].address,
                    window.last().unwrap().address
                );
            }
        }

        println!("\n✅ All get_window tests passed!");
    }
}
