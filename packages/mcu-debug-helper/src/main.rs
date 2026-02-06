use anyhow::Result;
use gimli::Reader;
use object::{Object, ObjectSection, ObjectSymbol};
use std::sync::mpsc::channel;
use std::thread;
use std::{borrow::Cow, env, fs, rc::Rc};

use mcu_debug_helper::disasm_worker;
use mcu_debug_helper::elf_items::{AddrtoLineInfo, FileTable};
use mcu_debug_helper::memory::MemoryRegion;
use mcu_debug_helper::protocol;
use mcu_debug_helper::request_handler;
use mcu_debug_helper::symbols::{Symbol, SymbolScope, SymbolTable, SymbolType};
use mcu_debug_helper::transport::{StdioTransport, Transport};

/// Encapsulates all debug information loaded from an ELF/DWARF object file.
/// Keeps both ELF and DWARF symbol tables for cross-checking during development.
pub struct ObjectInfo {
    /// Line number information from DWARF debug info
    pub addr_to_line: AddrtoLineInfo,
    /// Symbol table extracted from DWARF debug info (functions, variables, etc.)
    pub dwarf_symbols: SymbolTable,
    /// File table mapping file IDs to paths from DWARF
    pub file_table: FileTable,
    /// Memory regions/sections from ELF (e.g., .text, .data, .bss)
    pub memory_ranges: Vec<MemoryRegion>,
    /// Symbol table extracted from ELF symbol table (for cross-checking)
    pub elf_symbols: SymbolTable,
}

impl ObjectInfo {
    fn new() -> Self {
        Self {
            addr_to_line: AddrtoLineInfo::new(),
            dwarf_symbols: SymbolTable::new(),
            file_table: FileTable::new(),
            memory_ranges: Vec::new(),
            elf_symbols: SymbolTable::new(),
        }
    }
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

    // Iterate over Compilation Units to find line info
    let mut units = dwarf.units();
    while let Some(header) = units.next()? {
        let unit = dwarf.unit(header)?;
        if let Some(program) = unit.line_program.clone() {
            // Mapping from CU-local file index to Global File ID
            let mut file_map: std::collections::HashMap<u64, u32> =
                std::collections::HashMap::new();

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
                                if let Some(dir_attr) = header.directory(dir_idx) {
                                    if let Ok(d_s) = dwarf.attr_string(&unit, dir_attr) {
                                        if let Ok(s) = d_s.to_string_lossy() {
                                            p.push_str(&s);
                                            p.push('/');
                                        }
                                    }
                                }

                                if let Ok(n_s) = dwarf.attr_string(&unit, fe.path_name()) {
                                    if let Ok(s) = n_s.to_string_lossy() {
                                        p.push_str(&s);
                                    }
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
    }

    units = dwarf.units();
    while let Some(header) = units.next()? {
        let unit = dwarf.unit(header)?;
        let mut entries = unit.entries();
        while let Some((_, entry)) = entries.next_dfs()? {
            // Find functions (subprograms)
            if entry.tag() == gimli::DW_TAG_subprogram {
                // 1. Extract Symbol Name

                // Try linkage_name first (Mangled)
                let linkage_name_attr = entry
                    .attr_value(gimli::DW_AT_linkage_name)?
                    .or(entry.attr_value(gimli::DW_AT_MIPS_linkage_name)?);

                let mut raw_name_opt: Option<String> = None;

                if let Some(attr) = linkage_name_attr {
                    if let Ok(s) = dwarf.attr_string(&unit, attr) {
                        if let Ok(sl) = s.to_string_lossy() {
                            raw_name_opt = Some(sl.to_string());
                        }
                    }
                }

                if raw_name_opt.is_none() {
                    if let Some(name_attr) = entry.attr_value(gimli::DW_AT_name)? {
                        if let Ok(s) = dwarf.attr_string(&unit, name_attr) {
                            if let Ok(sl) = s.to_string_lossy() {
                                raw_name_opt = Some(sl.to_string());
                            }
                        }
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

fn main() -> Result<()> {
    let args: Vec<String> = env::args().collect();
    if args.len() < 2 {
        eprintln!("Usage: mcu-debug-helper <path_to_elf>");
        return Ok(());
    }
    let path = args[1].clone();

    // Setup transport (uses stdout's built-in locking)
    let mut transport = StdioTransport::new();

    // Spawn disassembly worker (long-running; doesn't block main)
    let (req_tx, req_rx) = channel();
    let path_clone = path.clone();
    thread::spawn(move || {
        disasm_worker::run_disassembly_worker(&path_clone, req_rx);
    });

    // Load ELF info (symbols, DWARF) - fast compared to disassembly
    let _obj_info = load_elf_info(&path)?;
    eprintln!("Loaded ELF info for: {}", path);

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
