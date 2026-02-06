use std::rc::Rc;

#[derive(Debug, Clone, PartialEq)]
pub enum SymbolType {
    Function,
    Data,
    Unknown,
}

#[derive(Debug, Clone, PartialEq)]
pub enum SymbolScope {
    Global,
    Static,
    Unknown,
}

#[derive(Debug, Clone)]
pub struct Symbol {
    pub name: String,
    pub address: u64,
    pub size: u64,
    pub kind: SymbolType,
    pub scope: SymbolScope,
}

pub struct SymbolTable {
    // Map start_addr -> Symbol
    // BTreeMap in Rust is implemented as a B-Tree (conceptually almost identical to RB-Tree for this purpose)
    // It allows O(log n) lookups and range queries.
    symbolsByAddr: std::collections::BTreeMap<u64, Rc<Symbol>>,
    symbolsByName: std::collections::HashMap<String, Rc<Symbol>>,
}

impl SymbolTable {
    pub fn new() -> Self {
        Self {
            symbolsByAddr: std::collections::BTreeMap::new(),
            symbolsByName: std::collections::HashMap::new(),
        }
    }

    pub fn insert(&mut self, symbol: Symbol) {
        // If there are duplicate start addresses, this overwrites.
        // DWARF can have alias symbols; you might want to handle that differently if needed.
        let rc_symbol = Rc::new(symbol);
        let name = rc_symbol.name.clone();

        self.symbolsByAddr
            .insert(rc_symbol.address, rc_symbol.clone());
        self.symbolsByName.insert(name, rc_symbol);
    }

    /// Find the symbol that contains the given address
    pub fn lookup(&self, address: u64) -> Option<&Symbol> {
        // range(..=address) gives us an iterator of all keys <= address.
        // next_back() gives us the largest key <= address (i.e., the closest start address to our left).
        if let Some((&start_addr, symbol)) = self.symbolsByAddr.range(..=address).next_back() {
            // Check if our address falls within the symbols size (start + size)
            // handle size=0 case? (markers)
            if symbol.size > 0 && address < start_addr + symbol.size {
                return Some(symbol.as_ref());
            }
            // If size is 0 (marker symbol), it only matches exact address
            if symbol.size == 0 && address == start_addr {
                return Some(symbol.as_ref());
            }
        }
        None
    }

    /// Find all symbols that overlap with the given range [start, end)
    pub fn lookup_range(&self, start: u64, end: u64) -> Vec<&Symbol> {
        let mut result = Vec::new();

        // 1. Check for a symbol that started *before* our range but extends into it
        if let Some(prev) = self.lookup(start) {
            result.push(prev);
        }

        // 2. Iterate over all symbols that start inside our range
        for (_, symbol) in self.symbolsByAddr.range(start..end) {
            // Avoid duplicates if `lookup` already caught the first one (rare with strict starts, but safe to check)
            if result.last().map(|s| s.address) != Some(symbol.address) {
                result.push(symbol.as_ref());
            }
        }

        result
    }

    pub fn get_by_name(&self, name: &str) -> Option<&Symbol> {
        self.symbolsByName.get(name).map(|s| s.as_ref())
    }
    pub fn has_symbol_by_name(&self, name: &str) -> bool {
        self.symbolsByName.contains_key(name)
    }
    pub fn has_symbol_by_addr(&self, addr: u64) -> bool {
        self.symbolsByAddr.contains_key(&addr)
    }
}
