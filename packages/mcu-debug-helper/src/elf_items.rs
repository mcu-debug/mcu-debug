use std::num::{NonZero, NonZeroU64};

use crate::utils::canonicalize_path;

pub struct FileTable {
    // Map from file index to file path
    files_by_id: std::collections::BTreeMap<u32, String>,
    id_by_file: std::collections::BTreeMap<String, u32>,
    next_id: u32,
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
    file_id: u32,
    line: Vec<NonZero<u64>>, // A single address may map to multiple lines
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
    entries: std::collections::BTreeMap<u64, LineInfoEntry>,
}

impl AddrtoLineInfo {
    pub fn new() -> Self {
        Self {
            entries: std::collections::BTreeMap::new(),
        }
    }
    pub fn add_entry(&mut self, address: u64, file_id: u32, line: NonZero<u64>) {
        let ent = LineInfoEntry::new(file_id, line);
        self.entries.insert(address as u64, ent);
    }
    pub fn get_entry(&self, address: u64) -> Option<&LineInfoEntry> {
        self.entries.get(&(address as u64))
    }

    pub fn append_or_insert(&mut self, address: u64, file_id: u32, line: NonZeroU64) {
        self.entries
            .entry(address as u64)
            .and_modify(|entry| entry.add_line(&line))
            .or_insert_with(|| LineInfoEntry::new(file_id, line));
    }
}
