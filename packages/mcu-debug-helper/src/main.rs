use anyhow::Result;
use gimli::Reader;
use object::{Object, ObjectSection};
use std::{
    borrow::Cow,
    env, fs,
    num::{NonZero, NonZeroU64},
    rc::Rc,
};

mod utils;
use utils::canonicalize_path;

struct FileTable {
    // Map from file index to file path
    files_by_id: std::collections::BTreeMap<u32, String>,
    id_by_file: std::collections::BTreeMap<String, u32>,
}

impl FileTable {
    fn new() -> Self {
        Self {
            files_by_id: std::collections::BTreeMap::new(),
            id_by_file: std::collections::BTreeMap::new(),
        }
    }
    fn add_file(&mut self, id: u32, path: String) {
        let path = canonicalize_path(&path);
        self.files_by_id.insert(id, path.clone());
        self.id_by_file.insert(path, id);
    }

    fn get_by_id(&self, id: u32) -> Option<&String> {
        self.files_by_id.get(&id)
    }

    fn get_by_path(&self, path: &str) -> Option<u32> {
        let id = self.id_by_file.get(path);
        if id.is_some() {
            return id.copied();
        }
        let canon_path = canonicalize_path(path);
        self.id_by_file.get(&canon_path).copied()
    }
}

struct LineInfoEntry {
    file_id: u32,
    line: Vec<NonZero<u64>>, // A single address may map to multiple lines
}

impl LineInfoEntry {
    fn new(file_id: u32, line: NonZero<u64>) -> Self {
        Self {
            file_id,
            line: vec![line],
        }
    }
    fn add_line(&mut self, line: &NonZero<u64>) {
        self.line.push(*line);
    }
}

struct AddrtoLineInfo {
    entries: Box<std::collections::BTreeMap<u32, LineInfoEntry>>,
}

impl AddrtoLineInfo {
    fn new() -> Self {
        Self {
            entries: Box::new(std::collections::BTreeMap::new()),
        }
    }
    fn add_entry(&mut self, address: u64, file_id: u32, line: NonZero<u64>) {
        let ent = Box::new(LineInfoEntry::new(file_id, line));
        self.entries.insert(address as u32, *ent);
    }
    fn get_entry(&self, address: u64) -> Option<&LineInfoEntry> {
        self.entries.get(&(address as u32))
    }

    fn append_or_insert(&mut self, address: u64, file_id: u32, line: NonZeroU64) {
        self.entries
            .entry(address as u32)
            .and_modify(|entry| entry.add_line(&line))
            .or_insert_with(|| LineInfoEntry::new(file_id, line));
    }
}

fn main() -> Result<()> {
    // For prototyping, take the ELF path as an argument
    let args: Vec<String> = env::args().collect();
    if args.len() < 2 {
        println!("Usage: mcu-debug-helper <path_to_elf>");
        return Ok(());
    }

    let path = &args[1];
    let file_data = fs::read(path)?;
    let obj_file = object::File::parse(&*file_data)?;
    let mut addr_to_line = Box::new(AddrtoLineInfo::new());

    // Load DWARF sections
    let load_section =
        |id: gimli::SectionId| -> Result<gimli::EndianRcSlice<gimli::RunTimeEndian>> {
            let data = obj_file
                .section_by_name(id.name())
                .map(|s| s.uncompressed_data().unwrap_or_default())
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

    let dwarf = gimli::Dwarf::load(&load_section)?;
    //let debug_str = dwarf.debug_str;

    // Iterate over Compilation Units to find line info
    let mut units = dwarf.units();
    while let Some(header) = units.next()? {
        let unit = dwarf.unit(header)?;
        if let Some(program) = unit.line_program.clone() {
            let mut rows = program.rows();
            while let Some((_header, row)) = rows.next_row()? {
                // Here is your data for the RB-Tree/BTreeMap
                // row.address(), row.file(), row.line()
                if row.is_stmt() {
                    match row.line() {
                        Some(line) => {
                            println!("Address: 0x{:x} -> Line: {:?}", row.address(), line);
                            addr_to_line.append_or_insert(row.address(), 0, line);
                        }
                        None => {
                            // Line information is missing (0), often compiler generated code.
                            // We choose to skip it or valid line 0 handling could be added here.
                        }
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
                let mut name = "unknown".to_string();
                if let Some(name_attr) = entry.attr_value(gimli::DW_AT_name)? {
                    if let Ok(s) = dwarf.attr_string(&unit, name_attr) {
                        if let Ok(str_val) = s.to_string_lossy() {
                            name = str_val.to_string();
                        }
                    }
                }

                // 2. Extract Address Range
                // low_pc is usually an absolute address
                let mut low = 0;
                if let Some(gimli::AttributeValue::Addr(addr)) =
                    entry.attr_value(gimli::DW_AT_low_pc)?
                {
                    low = addr;
                }

                // high_pc can be an address OR an offset (length)
                let mut high = 0;
                if let Some(high_attr) = entry.attr_value(gimli::DW_AT_high_pc)? {
                    match high_attr {
                        gimli::AttributeValue::Addr(addr) => high = addr, // Absolute address
                        gimli::AttributeValue::Udata(size) => high = low + size, // Offset
                        _ => {}
                    }
                }

                if low != 0 && high != 0 {
                    println!("Function: {} [0x{:x} - 0x{:x}]", name, low, high);
                }
            }
        }
    }
    Ok(())
}
