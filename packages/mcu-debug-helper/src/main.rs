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

use anyhow::Result;
use clap::Parser;
use gimli::Reader;
use object::{Object, ObjectSection, ObjectSymbol};
use std::process::exit;
use std::sync::{mpsc::channel, Arc};
use std::thread;
use std::time::{Duration, Instant};
use std::{borrow::Cow, fs, rc::Rc};

use mcu_debug_helper::disasm_worker;
use mcu_debug_helper::elf_items::ObjectInfo;
use mcu_debug_helper::memory::MemoryRegion;
use mcu_debug_helper::protocol::{self, rtt_found_notification};
use mcu_debug_helper::request_handler;
use mcu_debug_helper::symbols::{Symbol, SymbolScope, SymbolType};
use mcu_debug_helper::transport::{StdioTransport, Transport};

/// Helper to extract a string from a DWARF attribute value
fn dwarf_attr_to_string(
    dwarf: &gimli::Dwarf<gimli::EndianRcSlice<gimli::RunTimeEndian>>,
    unit: &gimli::Unit<gimli::EndianRcSlice<gimli::RunTimeEndian>>,
    attr: gimli::AttributeValue<gimli::EndianRcSlice<gimli::RunTimeEndian>>,
) -> Option<String> {
    dwarf
        .attr_string(unit, attr)
        .ok()
        .and_then(|d_s| d_s.to_string_lossy().ok().map(|cow| cow.to_string()))
}

/// Statistics for processing DWARF compilation units
struct ProcessingStats {
    total_line_rows: usize,
    total_line_time: Duration,
    total_entries: usize,
    total_entries_time: Duration,
    total_subprograms: usize,
    total_subprogram_time: Duration,
    total_variables: usize,
    total_variable_time: Duration,
    local_or_global: usize,
}

impl ProcessingStats {
    fn new() -> Self {
        Self {
            total_line_rows: 0,
            total_line_time: Duration::from_secs(0),
            total_entries: 0,
            total_entries_time: Duration::from_secs(0),
            total_subprograms: 0,
            total_subprogram_time: Duration::from_secs(0),
            total_variables: 0,
            total_variable_time: Duration::from_secs(0),
            local_or_global: 0,
        }
    }
}

/// Process a single DWARF debug info entry (subprogram or variable)
fn process_dwarf_entry(
    entry: &gimli::DebuggingInformationEntry<gimli::EndianRcSlice<gimli::RunTimeEndian>>,
    dwarf: &gimli::Dwarf<gimli::EndianRcSlice<gimli::RunTimeEndian>>,
    unit: &gimli::Unit<gimli::EndianRcSlice<gimli::RunTimeEndian>>,
    info: &mut ObjectInfo,
    stats: &mut ProcessingStats,
) -> Result<()> {
    match entry.tag() {
        // Handle functions (subprograms)
        gimli::DW_TAG_subprogram => {
            let subprogram_start = Instant::now();
            stats.total_subprograms += 1;
            // 1. Extract Symbol Name

            // Try linkage_name first (Mangled)
            let linkage_name_attr = entry
                .attr_value(gimli::DW_AT_linkage_name)?
                .or(entry.attr_value(gimli::DW_AT_MIPS_linkage_name)?);

            let mut raw_name_opt: Option<String> = None;

            if let Some(attr) = linkage_name_attr {
                raw_name_opt = dwarf_attr_to_string(dwarf, unit, attr);
            }

            if raw_name_opt.is_none() {
                if let Some(name_attr) = entry.attr_value(gimli::DW_AT_name)? {
                    raw_name_opt = dwarf_attr_to_string(dwarf, unit, name_attr);
                }
            }

            let name = demangle(raw_name_opt);

            // 2. Extract Address Range
            let mut low_opt = None;
            if let Some(gimli::AttributeValue::Addr(addr)) =
                entry.attr_value(gimli::DW_AT_low_pc)?
            {
                low_opt = Some(addr);
            }

            // We now have a start address and a name. See if it exists in the elf symbols
            if let Some(low) = low_opt {
                if let Some(existing_sym) = info.elf_symbols.lookup(low) {
                    // Use existing symbol info
                    info.dwarf_symbols.insert(existing_sym.clone());
                    stats.total_subprogram_time += subprogram_start.elapsed();
                    return Ok(());
                } else {
                    // This symbol is not in the ELF symbol table, it may have been stripped, so we skip it
                    stats.total_subprogram_time += subprogram_start.elapsed();
                    return Ok(());
                }
            }

            let mut high_opt = None;
            if let Some(high_attr) = entry.attr_value(gimli::DW_AT_high_pc)? {
                match high_attr {
                    gimli::AttributeValue::Addr(addr) => high_opt = Some(addr), // Absolute address
                    gimli::AttributeValue::Udata(size) => {
                        if let Some(low) = low_opt {
                            high_opt = Some(low + size);
                        }
                    }
                    _ => {}
                }
            }

            if let (Some(low), Some(high)) = (low_opt, high_opt) {
                let size = high.saturating_sub(low);

                if size > 0 {
                    // eprintln!("Function: {} [0x{:x} - 0x{:x})", name, low, high);

                    info.dwarf_symbols.insert(Symbol {
                        name,
                        address: low,
                        size,
                        kind: SymbolType::Function,
                        scope: SymbolScope::Global,
                    });
                }
            }
            stats.total_subprogram_time += subprogram_start.elapsed();
        }

        // Handle static/global variables
        gimli::DW_TAG_variable => {
            let variable_start = Instant::now();
            stats.total_variables += 1;
            // Extract variable name
            let mut raw_name_opt: Option<String> = None;

            // Try linkage_name first (for global variables)
            let linkage_name_attr = entry
                .attr_value(gimli::DW_AT_linkage_name)?
                .or(entry.attr_value(gimli::DW_AT_MIPS_linkage_name)?);

            if let Some(attr) = linkage_name_attr {
                raw_name_opt = dwarf_attr_to_string(dwarf, unit, attr);
            }

            if raw_name_opt.is_none() {
                if let Some(name_attr) = entry.attr_value(gimli::DW_AT_name)? {
                    raw_name_opt = dwarf_attr_to_string(dwarf, unit, name_attr);
                }
            }

            let name = demangle(raw_name_opt);

            // Lookup by name in ELF symbols (avoids expensive DWARF expression evaluation)
            if let Some(existing_sym) = info.elf_symbols.get_by_name(&name) {
                let arc_sym = info.dwarf_symbols.insert(existing_sym.clone());
                if arc_sym.kind == SymbolType::Data {
                    if arc_sym.scope == SymbolScope::Static {
                        info.static_file_mapping
                            .insert(arc_sym.name.clone(), arc_sym);
                        stats.local_or_global += 1;
                    } else if arc_sym.scope == SymbolScope::Global {
                        info.global_symbols.push(arc_sym);
                        stats.local_or_global += 1;
                    } else {
                        eprintln!(
                            "Warning: DWARF variable '{}' found but ELF symbol has unknown scope. Please report this issue.",
                            name
                        );
                    }
                } else {
                    eprintln!(
                        "Warning: DWARF variable '{}' found but ELF symbol is not data. Please report this issue.",
                        name
                    );
                }
            } else {
                // This variable is not in the ELF symbol table, it may have been stripped, so we skip it
                // These were probably optimized out anyway
            }
            stats.total_variable_time += variable_start.elapsed();
        }

        _ => {}
    }
    Ok(())
}

fn load_elf_info(path: &str, transport: &mut impl Transport, timing: bool) -> Result<ObjectInfo> {
    let start = Instant::now();
    let file_result = fs::File::open(path);
    let file = match file_result {
        Ok(f) => f,
        Err(e) => {
            eprintln!("Error opening ELF file '{}': {}", path, e);
            exit(1);
        }
    };
    let mmap = unsafe { memmap2::Mmap::map(&file)? };
    let obj_file = object::File::parse(&*mmap)?;
    if timing {
        eprintln!("  ⏱️  File open + mmap + parse: {:.2?}", start.elapsed());
    }

    let mut info = ObjectInfo::new();

    let step = Instant::now();
    // eprintln!("Idx Name          Size      Address          Align");
    for (_i, section) in obj_file.sections().enumerate() {
        // eprintln!(
        //     "{:<3} {:<12} {:<8x} {:<16x} {:<5}",
        //     i,
        //     section.name().unwrap_or(""),
        //     section.size(),
        //     section.address(),
        //     section.align(),
        // );
        if section.size() > 0 {
            info.memory_ranges.push(MemoryRegion::new(
                section.name().unwrap_or("").to_string(),
                section.address(),
                section.size(),
                section.align(),
            ));
        }
    }
    if timing {
        eprintln!("  ⏱️  Process sections: {:.2?}", step.elapsed());
    }

    let step = Instant::now();
    for symbol in obj_file.symbols() {
        if let Ok(name) = symbol.name() {
            let kind = if symbol.kind() == object::SymbolKind::Text {
                SymbolType::Function
            } else if symbol.kind() == object::SymbolKind::Data {
                SymbolType::Data
            } else {
                continue;
            };
            let scope: SymbolScope = if symbol.is_global() {
                SymbolScope::Global
            } else if symbol.is_local() {
                SymbolScope::Static
            } else {
                SymbolScope::Unknown
            };
            let is_data = kind == SymbolType::Data;
            let dname = demangle(Some(name.to_string()));
            info.elf_symbols.insert(Symbol {
                name: dname.clone(),
                address: symbol.address(),
                size: symbol.size(),
                kind,
                scope,
            });
            if (dname == "_SEGGER_RTT" || dname == "SEGGER_RTT") && is_data {
                info.rtt_symbol_address = Some(symbol.address());
                let notify =
                    rtt_found_notification("local-session", &format!("0x{:x}", symbol.address()));
                transport
                    .write_message(&notify)
                    .map_err(|e| anyhow::anyhow!("{}", e))?;
                eprintln!(
                    "Found RTT symbol '{}' at address 0x{:x}",
                    dname,
                    symbol.address()
                );
            }
        }
    }
    if timing {
        eprintln!("  ⏱️  Process ELF symbols: {:.2?}", step.elapsed());
    }

    // Load DWARF sections
    let step = Instant::now();
    let load_section =
        |id: gimli::SectionId| -> Result<gimli::EndianRcSlice<gimli::RunTimeEndian>> {
            let data = obj_file
                .section_by_name(id.name())
                .map(|s| {
                    use object::ObjectSection;
                    s.uncompressed_data().unwrap_or_default()
                })
                .unwrap_or_default();

            let data_rc: Rc<[u8]> = match data {
                Cow::Borrowed(b) => Rc::from(b),
                Cow::Owned(o) => Rc::from(o),
            };
            Ok(gimli::EndianRcSlice::new(
                data_rc,
                gimli::RunTimeEndian::Little,
            ))
        };

    // If DWARF loading fails, we might still want to return symbols if possible,
    // but for now we propagate the error.
    let dwarf = gimli::Dwarf::load(&load_section)?;
    if timing {
        eprintln!("  ⏱️  Load DWARF sections: {:.2?}", step.elapsed());
    }

    // Iterate over Compilation Units to process line info and symbols
    let step = Instant::now();
    let mut units = dwarf.units();
    let mut unit_count = 0;
    let mut stats = ProcessingStats::new();
    while let Some(header) = units.next()? {
        unit_count += 1;
        let unit = dwarf.unit(header)?;

        // Mapping from CU-local file index to Global File ID
        // Shared between line program processing and symbol extraction
        let mut file_map: std::collections::HashMap<u64, u32> = std::collections::HashMap::new();

        // Process line program if present
        let line_start = Instant::now();
        if let Some(program) = unit.line_program.clone() {
            let _header = program.header();

            // Rows
            let mut rows = program.rows();
            while let Some((header, row)) = rows.next_row()? {
                stats.total_line_rows += 1;
                if row.is_stmt() {
                    if let Some(line) = row.line() {
                        let local_file_idx = row.file_index();

                        // Resolve file path lazy-ish
                        let global_id = *file_map.entry(local_file_idx).or_insert_with(|| {
                            if let Some(fe) = header.file(local_file_idx) {
                                let mut p = String::new();
                                let dir_idx = fe.directory_index();

                                // Get directory path
                                if let Some(dir_attr) = header.directory(dir_idx) {
                                    if let Some(dir_str) =
                                        dwarf_attr_to_string(&dwarf, &unit, dir_attr)
                                    {
                                        p.push_str(&dir_str);
                                        p.push('/');
                                    }
                                }

                                // Get file name
                                if let Some(file_str) =
                                    dwarf_attr_to_string(&dwarf, &unit, fe.path_name())
                                {
                                    p.push_str(&file_str);
                                }

                                info.file_table.intern(p)
                            } else {
                                0 // Unknown
                            }
                        });

                        info.addr_to_line
                            .append_or_insert(row.address(), global_id, line);
                    }
                }
            }
        }
        stats.total_line_time += line_start.elapsed();

        // Process debug info entries for symbols (functions and variables)
        // Find first top-level entry (subprogram or variable), then iterate siblings
        let entries_start = Instant::now();
        let mut entries = unit.entries();

        // Find first subprogram or variable (top-level entry)
        let mut first_entry_found = false;
        while let Some((_, entry)) = entries.next_dfs()? {
            match entry.tag() {
                gimli::DW_TAG_subprogram | gimli::DW_TAG_variable => {
                    // Process this first entry
                    stats.total_entries += 1;
                    process_dwarf_entry(entry, &dwarf, &unit, &mut info, &mut stats)?;
                    first_entry_found = true;
                    break;
                }
                _ => {}
            }
        }

        // Process remaining siblings if we found a first entry
        if first_entry_found {
            while let Some(entry) = entries.next_sibling()? {
                stats.total_entries += 1;
                process_dwarf_entry(entry, &dwarf, &unit, &mut info, &mut stats)?;
            }
        }
        stats.total_entries_time += entries_start.elapsed();
    }
    if timing {
        eprintln!(
            "  ⏱️  Process {} compilation units: {:.2?}",
            unit_count,
            step.elapsed()
        );
        eprintln!(
            "    ├─ Line programs ({} rows): {:.2?}",
            stats.total_line_rows, stats.total_line_time
        );
        eprintln!(
            "    └─ Debug entries ({} entries): {:.2?}",
            stats.total_entries, stats.total_entries_time
        );
        eprintln!(
            "       ├─ Subprograms ({} funcs): {:.2?}",
            stats.total_subprograms, stats.total_subprogram_time
        );
        eprintln!(
            "       └─ Variables ({} vars): {:.2?} (locals or globals: {})",
            stats.total_variables, stats.total_variable_time, stats.local_or_global
        );
        eprintln!("  ⏱️  TOTAL load_elf_info: {:.2?}", start.elapsed());
    }

    Ok(info)
}

fn demangle(raw_name_opt: Option<String>) -> String {
    let mut name = "unknown".to_string();
    if let Some(raw_name) = raw_name_opt {
        // DEMANGLE
        // 1. Try Rust
        let rust_demangled = rustc_demangle::demangle(&raw_name).to_string();
        if rust_demangled != raw_name {
            name = rust_demangled;
        } else {
            // 2. Try C++
            name = raw_name.clone(); // Default to raw
            if let Ok(sym) = cpp_demangle::Symbol::new(raw_name.as_bytes()) {
                // cpp_demangle 0.5.1 does not take options in demangle() directly
                if let Ok(d) = sym.demangle() {
                    name = d;
                }
            }
        }
    }
    name
}

#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
struct Args {
    /// Enable RTT search and reporting (experimental)
    #[arg(short = 'r', long = "rtt-search", default_value_t = false)]
    rtt_search: bool,

    #[arg(
        short = 'o',
        long = "objdump-path",
        default_value = "arm-none-eabi-objdump"
    )]
    objdump_path: String,

    /// Enable detailed timing measurements for performance profiling
    #[arg(long = "timing", default_value_t = false)]
    timing: bool,

    /// Path(s) to ELF file(s) to analyze
    #[arg(required = true, num_args = 1..)]
    elf_files: Vec<String>,
}

fn main() -> Result<()> {
    let args = Args::parse();

    /*
        let args_vec: Vec<String> = env::args().collect();
        if args_vec.len() < 2 {
            eprintln!("Usage: mcu-debug-helper <path_to_elf>");
            return Ok(());
        }
        let path = args_vec[1].clone();
    */
    // TODO: Support multiple ELF files - for now just use the first one
    let path = args.elf_files[0].clone();

    // Setup transport (uses stdout's built-in locking)
    let mut transport = StdioTransport::new();

    // Create channels: request dispatch + ObjectInfo delivery to worker
    let (req_tx, req_rx) = channel();
    let (obj_info_tx, obj_info_rx) = channel();
    let now = Instant::now();

    // Spawn disassembly worker immediately (loads objdump in parallel)
    let path_clone = path.clone();
    let objdump_path_clone = args.objdump_path.clone();
    thread::spawn(move || {
        disasm_worker::run_disassembly_worker(
            &objdump_path_clone,
            &path_clone,
            req_rx,
            obj_info_rx,
        );
    });
    if args.timing {
        eprintln!("Started reading ${} (elapsed: {:.2?})", path, now.elapsed());
    }
    // Load ELF info in parallel with worker's disassembly loading
    let mut obj_info_data = load_elf_info(&path, &mut transport, args.timing)?;
    if args.timing {
        eprintln!(
            "Loaded ELF info for: {} (elapsed: {:.2?})",
            path,
            now.elapsed()
        );
    }

    let sort_start = Instant::now();
    obj_info_data.sort_globals_and_statics(); // Sort symbols once so clients don't have to sort repeatedly
    if args.timing {
        eprintln!(
            "  ⏱️  Sort globals and statics: {:.2?}",
            sort_start.elapsed()
        );
    }

    let obj_info = Arc::new(obj_info_data); // Now immutable and shareable across threads

    // Send ObjectInfo to worker (Arc makes it cheap to send)
    if obj_info_tx.send(Arc::clone(&obj_info)).is_err() {
        eprintln!("Warning: Worker exited before receiving ObjectInfo");
    }

    // Notify DA that symbol table is ready
    let notify = protocol::symbol_table_ready_notification("local-session", "0.1.0");
    transport
        .write_message(&notify)
        .map_err(|e| anyhow::anyhow!("{}", e))?;
    eprintln!(
        "Sent SymbolTableReady notification to DA (elapsed: {:.2?})",
        now.elapsed()
    );

    // Main request loop
    loop {
        match transport.read_message() {
            Ok(msg) => {
                eprintln!("Received request: {}", msg);
                if !request_handler::dispatch_request(&msg, &req_tx, Arc::clone(&obj_info)) {
                    eprintln!("Unknown request type: {}", msg);
                }
            }
            Err(e) => {
                eprintln!("Transport read error or EOF: {}", e);
                break;
            }
        }
    }

    Ok(())
}
