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

use object::{Object, SymbolKind, SymbolScope};

pub fn get_all_globals(obj_file: &object::File) -> Vec<GlobalSymbol> {
    obj_file
        .symbols()
        .filter(|s| {
            s.kind() == SymbolKind::Data && s.scope() == SymbolScope::Dynamic || s.is_global()
        })
        .map(|s| GlobalSymbol {
            name: s.name().unwrap_or("").to_string(),
            addr: s.address(),
            size: s.size(),
        })
        .collect()
}

// During ingestion, build this map:
// BTreeMap<CanonicalFilePath, Vec<Symbol>>
pub fn get_statics_for_file(&self, file_path: &str) -> Vec<StaticSymbol> {
    self.file_statics_map
        .get(file_path)
        .cloned()
        .unwrap_or_default()
}

pub fn find_symbol_by_name(&self, name: &str) -> Option<u64> {
    // Exact match for symbols like _SEGGER_RTT
    self.name_to_addr_map.get(name).copied()
}
// Partial match for symbols like _SEGGER_RTT_*
