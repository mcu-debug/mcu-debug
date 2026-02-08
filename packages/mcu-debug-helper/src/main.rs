use anyhow::Result;
use clap::Parser;
use gimli::Reader;
use object::{Object, ObjectSection, ObjectSymbol};
use std::sync::{mpsc::channel, Arc};
use std::thread;
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

fn load_elf_info(path: &str) -> Result<ObjectInfo> {
    let file = fs::File::open(path)?;
    let mmap = unsafe { memmap2::Mmap::map(&file)? };
    let obj_file = object::File::parse(&*mmap)?;

    let mut info = ObjectInfo::new();

    eprintln!("Idx Name          Size      Address          Align");
    for (i, section) in obj_file.sections().enumerate() {
        eprintln!(
            "{:<3} {:<12} {:<8x} {:<16x} {:<5}",
            i,
            section.name().unwrap_or(""),
            section.size(),
            section.address(),
            section.align(),
        );
        if section.size() > 0 {
            info.memory_ranges.push(MemoryRegion::new(
                section.name().unwrap_or("").to_string(),
                section.address(),
                section.size(),
                section.align(),
            ));
        }
    }

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
            eprintln!(
                "Demangling symbol: {} | Kind: {:?} | Scope: {:?}",
                name, kind, scope,
            );
            let dname = demangle(Some(name.to_string()));
            info.elf_symbols.insert(Symbol {
                name: dname,
                address: symbol.address(),
                size: symbol.size(),
                kind,
                scope,
            });
            if (name == "_SEGGER_RTT" || name == "SEGGER_RTT") && is_data {
                info.rtt_symbol_address = Some(symbol.address());
                rtt_found_notification("local-session", &format!("0x{:x}", symbol.address()));
                eprintln!(
                    "Found RTT symbol '{}' at address 0x{:x}",
                    name,
                    symbol.address()
                );
            }
        }
    }

    // Load DWARF sections
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

    // Iterate over Compilation Units to process line info and symbols
    let mut units = dwarf.units();
    while let Some(header) = units.next()? {
        let unit = dwarf.unit(header)?;

        // Mapping from CU-local file index to Global File ID
        // Shared between line program processing and symbol extraction
        let mut file_map: std::collections::HashMap<u64, u32> = std::collections::HashMap::new();

        // Process line program if present
        if let Some(program) = unit.line_program.clone() {
            let _header = program.header();

            // Rows
            let mut rows = program.rows();
            while let Some((header, row)) = rows.next_row()? {
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

        // Process debug info entries for symbols (functions and variables)
        let mut entries = unit.entries();

        while let Some((_, entry)) = entries.next_dfs()? {
            match entry.tag() {
                // Handle functions (subprograms)
                gimli::DW_TAG_subprogram => {
                    // 1. Extract Symbol Name

                    // Try linkage_name first (Mangled)
                    let linkage_name_attr = entry
                        .attr_value(gimli::DW_AT_linkage_name)?
                        .or(entry.attr_value(gimli::DW_AT_MIPS_linkage_name)?);

                    let mut raw_name_opt: Option<String> = None;

                    if let Some(attr) = linkage_name_attr {
                        raw_name_opt = dwarf_attr_to_string(&dwarf, &unit, attr);
                    }

                    if raw_name_opt.is_none() {
                        if let Some(name_attr) = entry.attr_value(gimli::DW_AT_name)? {
                            raw_name_opt = dwarf_attr_to_string(&dwarf, &unit, name_attr);
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
                            continue;
                        } else {
                            // This symbol is not in the ELF symbol table, it may have been stripped, so we skip it
                            continue;
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
                }

                // Handle static/global variables
                gimli::DW_TAG_variable => {
                    // Extract variable name
                    let mut raw_name_opt: Option<String> = None;

                    // Try linkage_name first (for global variables)
                    let linkage_name_attr = entry
                        .attr_value(gimli::DW_AT_linkage_name)?
                        .or(entry.attr_value(gimli::DW_AT_MIPS_linkage_name)?);

                    if let Some(attr) = linkage_name_attr {
                        raw_name_opt = dwarf_attr_to_string(&dwarf, &unit, attr);
                    }

                    if raw_name_opt.is_none() {
                        if let Some(name_attr) = entry.attr_value(gimli::DW_AT_name)? {
                            raw_name_opt = dwarf_attr_to_string(&dwarf, &unit, name_attr);
                        }
                    }

                    let name = demangle(raw_name_opt);

                    // Extract address from DW_AT_location
                    let mut addr_opt = None;
                    if let Some(attr_value) = entry.attr_value(gimli::DW_AT_location)? {
                        if let gimli::AttributeValue::Exprloc(expr) = attr_value {
                            // Simple case: DW_OP_addr followed by an address
                            let mut eval = expr.evaluation(unit.encoding());
                            if let Ok(result) = eval.evaluate() {
                                if let gimli::EvaluationResult::Complete = result {
                                    let pieces = eval.result();
                                    if pieces.len() == 1 {
                                        if let gimli::Location::Address { address } =
                                            pieces[0].location
                                        {
                                            addr_opt = Some(address);
                                        }
                                    }
                                }
                            }
                        }
                    }

                    if let Some(addr) = addr_opt {
                        // Check if it exists in ELF symbols
                        if let Some(existing_sym) = info.elf_symbols.lookup(addr) {
                            // Use existing symbol info
                            let arc_sym = info.dwarf_symbols.insert(existing_sym.clone());
                            if (arc_sym.scope == SymbolScope::Global)
                                && (arc_sym.kind == SymbolType::Data)
                            {
                                info.static_file_mapping
                                    .insert(arc_sym.name.clone(), arc_sym);
                                eprintln!(
                                    "Found global variable '{}' at address 0x{:x} from DWARF",
                                    existing_sym.name, existing_sym.address
                                );
                            }
                        } else {
                            // Try to determine size from type information
                            // For now, use a default size (could be enhanced later)
                            info.dwarf_symbols.insert(Symbol {
                                name,
                                address: addr,
                                size: 0, // Size unknown without type info
                                kind: SymbolType::Data,
                                scope: SymbolScope::Global, // Could check DW_AT_external
                            });
                        }
                    }
                }

                _ => {}
            }
        }
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

    // Spawn disassembly worker immediately (loads objdump in parallel)
    let path_clone = path.clone();
    thread::spawn(move || {
        disasm_worker::run_disassembly_worker(&path_clone, req_rx, obj_info_rx);
    });

    // Load ELF info in parallel with worker's disassembly loading
    let mut obj_info_data = load_elf_info(&path)?;
    eprintln!("Loaded ELF info for: {}", path);
    obj_info_data.sort_globals_and_statics(); // Sort symbols once so clients don't have to sort repeatedly

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
    eprintln!("Sent SymbolTableReady notification");

    // Main request loop
    loop {
        match transport.read_message() {
            Ok(msg) => {
                eprintln!("Received request: {}", msg);
                if !request_handler::dispatch_request(&msg, &req_tx) {
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
