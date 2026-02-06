// Crate root: declare modules and control visibility
pub mod disasm_serializer;
pub mod disasm_worker;
pub mod elf_items;
pub mod get_assembly;
pub mod protocol;
pub mod request_handler;
pub mod symbols;
pub mod transport;
pub mod utils;

// Re-export commonly used API from the library for binaries/tests
pub use get_assembly::get_disasm_from_objdump;
