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

use std::num::{NonZero, NonZeroU64};
use std::sync::Arc;

use crate::utils::CanonicalPath;
use crate::{symbols::Symbol, utils::canonicalize_path};

pub struct FileTable {
    // Map from file index to file path
    files_by_id: std::collections::BTreeMap<u32, String>,
    id_by_file: std::collections::BTreeMap<String, u32>,
    next_id: u32,
}

impl Default for FileTable {
    fn default() -> Self {
        Self::new()
    }
}

impl FileTable {
    pub fn new() -> Self {
        Self {
            files_by_id: std::collections::BTreeMap::new(),
            id_by_file: std::collections::BTreeMap::new(),
            next_id: 1,
        }
    }

    //
    pub fn intern(&mut self, path: String) -> u32 {
        let fp = canonicalize_path(&path);
        if let Some(&id) = self.id_by_file.get(&fp) {
            return id;
        }
        let id = self.next_id;
        self.next_id += 1;
        self.files_by_id.insert(id, fp.clone());
        self.id_by_file.insert(fp, id);
        id
    }

    pub fn get_by_id(&self, id: u32) -> Option<&String> {
        self.files_by_id.get(&id)
    }

    pub fn get_by_path(&self, path: &str) -> Option<u32> {
        let id = self.id_by_file.get(path);
        if id.is_some() {
            return id.copied();
        }
        let canon_path = canonicalize_path(path);
        self.id_by_file.get(&canon_path).copied()
    }
}

pub struct LineInfoEntry {
    pub file_id: u32,
    pub line: Vec<NonZero<u64>>, // A single address may map to multiple lines
}

impl LineInfoEntry {
    pub fn new(file_id: u32, line: NonZero<u64>) -> Self {
        Self {
            file_id,
            line: vec![line],
        }
    }
    pub fn add_line(&mut self, line: &NonZero<u64>) {
        self.line.push(*line);
    }
}

pub struct AddrtoLineInfo {
    pub entries: std::collections::BTreeMap<u64, LineInfoEntry>,
}

impl Default for AddrtoLineInfo {
    fn default() -> Self {
        Self::new()
    }
}

impl AddrtoLineInfo {
    pub fn new() -> Self {
        Self {
            entries: std::collections::BTreeMap::new(),
        }
    }
    pub fn add_entry(&mut self, address: u64, file_id: u32, line: NonZero<u64>) {
        let ent = LineInfoEntry::new(file_id, line);
        self.entries.insert(address, ent);
    }
    pub fn get_entry(&self, address: u64) -> Option<&LineInfoEntry> {
        self.entries.get(&{ address })
    }

    pub fn append_or_insert(&mut self, address: u64, file_id: u32, line: NonZeroU64) {
        self.entries
            .entry(address)
            .and_modify(|entry| entry.add_line(&line))
            .or_insert_with(|| LineInfoEntry::new(file_id, line));
    }
}

pub struct StaticFileMapping {
    pub file_map: std::collections::HashMap<CanonicalPath, Vec<Arc<Symbol>>>,
}

impl StaticFileMapping {
    pub fn new() -> Self {
        Self {
            file_map: std::collections::HashMap::new(),
        }
    }
    pub fn insert(&mut self, file_path: &CanonicalPath, symbol: Arc<Symbol>) {
        if let Some(existing) = self.file_map.get_mut(file_path) {
            existing.push(symbol);
            return;
        }
        self.file_map.insert(file_path.clone(), vec![symbol]);
    }

    pub fn sort_symbols(&mut self) {
        for symbols in self.file_map.values_mut() {
            symbols.sort_by_key(|s| s.name.clone());
        }
    }

    pub fn get_statics_for_file(&self, file_path: &CanonicalPath) -> Vec<Arc<Symbol>> {
        self.file_map
            .get(file_path)
            .cloned()
            .unwrap_or_else(Vec::new)
    }
}

/// Encapsulates all debug information loaded from an ELF/DWARF object file.
/// Keeps both ELF and DWARF symbol tables for cross-checking during development.
pub struct ObjectInfo {
    /// Line number information from DWARF debug info
    pub addr_to_line: AddrtoLineInfo,
    /// Symbol table extracted from DWARF debug info (functions, variables, etc.)
    pub dwarf_symbols: crate::symbols::SymbolTable,
    /// File table mapping file IDs to paths from DWARF
    pub file_table: FileTable,
    /// Memory regions/sections from ELF (e.g., .text, .data, .bss)
    pub memory_ranges: Vec<crate::memory::MemoryRegion>,
    /// Symbol table extracted from ELF symbol table (for cross-checking)
    pub elf_symbols: crate::symbols::SymbolTable,
    /// Static file to symbols mapping for quick lookup of which symbols are defined in which files
    /// This will be called quite frequently in some use cases
    pub static_file_mapping: StaticFileMapping,

    pub global_symbols: Vec<Arc<Symbol>>, // List of global symbols for quick access

    pub rtt_symbol_address: Option<u64>, // Address of RTT control block if found
}

impl ObjectInfo {
    pub fn new() -> Self {
        Self {
            addr_to_line: AddrtoLineInfo::new(),
            dwarf_symbols: crate::symbols::SymbolTable::new(),
            file_table: FileTable::new(),
            memory_ranges: Vec::new(),
            elf_symbols: crate::symbols::SymbolTable::new(),
            static_file_mapping: StaticFileMapping::new(),
            global_symbols: Vec::new(),
            rtt_symbol_address: None,
        }
    }

    pub fn sort_globals_and_statics(&mut self) {
        self.global_symbols.sort_by_key(|s| s.name.clone());
        self.static_file_mapping.sort_symbols();
    }
}
