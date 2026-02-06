use mcu_debug_helper::{InstructionDb, canonicalize_path};
use std::path::PathBuf;

#[test]
fn test_elf_ingestion_and_lookups() {
    // 1. Point to a real ELF in your repo
    let mut elf_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    elf_path.push("../../test-assets/sample.elf"); // Adjust to your path

    // 2. Run your ingestion logic (Symbols + DWARF + objdump)
    let mut db = InstructionDb::new();
    db.ingest(&elf_path).expect("Failed to ingest ELF");

    // 3. API Test: Find specific Global
    let rtt_addr = db.find_symbol_by_name("_SEGGER_RTT");
    assert!(rtt_addr.is_some(), "Could not find _SEGGER_RTT");
    eprintln!("Found RTT at: 0x{:x}", rtt_addr.unwrap());

    // 4. API Test: Find Statics for a file
    let test_file = canonicalize_path("./src/main.c");
    let statics = db.get_statics_for_file(&test_file);
    assert!(!statics.is_empty(), "No statics found for {}", test_file);

    // 5. API Test: Disassembly Window
    let window = db.get_window(rtt_addr.unwrap(), 5, 5);
    assert_eq!(window.len(), 11);
}
