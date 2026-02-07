use std::sync::Arc;

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
    symbols_by_addr: std::collections::BTreeMap<u64, Arc<Symbol>>,
    symbols_by_name: std::collections::HashMap<String, Arc<Symbol>>,
}

impl Default for SymbolTable {
    fn default() -> Self {
        Self::new()
    }
}

impl SymbolTable {
    pub fn new() -> Self {
        Self {
            symbols_by_addr: std::collections::BTreeMap::new(),
            symbols_by_name: std::collections::HashMap::new(),
        }
    }

    pub fn insert(&mut self, symbol: Symbol) {
        // If there are duplicate start addresses, this overwrites.
        // DWARF can have alias symbols; you might want to handle that differently if needed.
        let arc_symbol = Arc::new(symbol);
        let name = arc_symbol.name.clone();

        self.symbols_by_addr
            .insert(arc_symbol.address, arc_symbol.clone());
        self.symbols_by_name.insert(name, arc_symbol);
    }

    /// Find the symbol that contains the given address
    pub fn lookup(&self, address: u64) -> Option<&Symbol> {
        // range(..=address) gives us an iterator of all keys <= address.
        // next_back() gives us the largest key <= address (i.e., the closest start address to our left).
        if let Some((&start_addr, symbol)) = self.symbols_by_addr.range(..=address).next_back() {
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
        for (_, symbol) in self.symbols_by_addr.range(start..end) {
            // Avoid duplicates if `lookup` already caught the first one (rare with strict starts, but safe to check)
            if result.last().map(|s| s.address) != Some(symbol.address) {
                result.push(symbol.as_ref());
            }
        }

        result
    }

    pub fn get_by_name(&self, name: &str) -> Option<&Symbol> {
        self.symbols_by_name.get(name).map(|s| s.as_ref())
    }
    pub fn has_symbol_by_name(&self, name: &str) -> bool {
        self.symbols_by_name.contains_key(name)
    }
    pub fn has_symbol_by_addr(&self, addr: u64) -> bool {
        self.symbols_by_addr.contains_key(&addr)
    }
}
