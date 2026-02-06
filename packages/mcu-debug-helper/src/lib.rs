// Crate root: declare modules and control visibility
pub mod elf_items;
pub mod get_assembly;
pub mod symbols;
pub mod utils;

// Re-export commonly used API from the library for binaries/tests
pub use get_assembly::get_disasm_from_objdump;
