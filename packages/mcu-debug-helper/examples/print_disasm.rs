use mcu_debug_helper::get_assembly::AssemblyLine;
use mcu_debug_helper::get_assembly::AssemblyListing;
use mcu_debug_helper::helper_requests::DisasmResponse;
use mcu_debug_helper::helper_requests::SerInstruction;
use std::collections::HashMap;

fn main() {
    let mut listing = AssemblyListing::new();
    let l1 = AssemblyLine::new(
        0x1000,
        "00 20".to_string(),
        "movs r0,#0".to_string(),
        " 1000: 00 20 movs r0,#0".to_string(),
        -1,
        0,
    );
    let l2 = AssemblyLine::new(
        0x1002,
        "01 30".to_string(),
        "adds r0,r1".to_string(),
        " 1002: 01 30 adds r0,r1".to_string(),
        -1,
        0,
    );
    listing.insert_line(l1);
    listing.insert_line(l2);

    let s = DisasmResponse::new(
        42,
        HashMap::from([(1, "file1.c".to_string())]),
        HashMap::from([(2, "func1".to_string())]),
        vec![
            SerInstruction::from_assembly_line(&listing.lines[0]),
            SerInstruction::from_assembly_line(&listing.lines[1]),
        ],
    );
    eprintln!("{}", serde_json::to_string_pretty(&s).unwrap());
}
