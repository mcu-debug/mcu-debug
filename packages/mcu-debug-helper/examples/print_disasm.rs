use mcu_debug_helper::disasm_serializer::serialize_compact_disasm;
use mcu_debug_helper::get_assembly::AssemblyLine;
use mcu_debug_helper::get_assembly::AssemblyListing;

fn main() {
    let mut listing = AssemblyListing::new();
    let l1 = AssemblyLine::new(
        0x1000,
        "00 20".to_string(),
        "movs r0,#0".to_string(),
        " 1000: 00 20 movs r0,#0".to_string(),
    );
    let l2 = AssemblyLine::new(
        0x1002,
        "01 30".to_string(),
        "adds r0,r1".to_string(),
        " 1002: 01 30 adds r0,r1".to_string(),
    );
    listing.insert_line(l1);
    listing.insert_line(l2);

    let v = serialize_compact_disasm(&listing, 1, true);
    eprintln!("{}", serde_json::to_string_pretty(&v).unwrap());
}
