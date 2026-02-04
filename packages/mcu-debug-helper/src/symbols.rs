use object::{Object, SymbolKind};

// Inside your ingestion logic
if let Some(symbol_table) = obj_file.symbol_table() {
    for symbol in symbol_table.symbols() {
        // We only care about functions and data for the Disasm/Static server
        if symbol.kind() == SymbolKind::Text || symbol.kind() == SymbolKind::Data {
            let name = symbol.name().unwrap_or("unknown");
            let addr = symbol.address();
            let size = symbol.size();
            
            // Push these into your RB-Tree / BTreeMap
            // You can now do O(log N) lookups for "Which function am I in?"
        }
    }
}
