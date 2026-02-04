#[derive(Debug, Clone, serde::Serialize)]
pub struct Instruction {
    pub address: u64,
    pub bytes: String,
    pub text: String,        // e.g., "mov r0, r1"
    pub function_name: Option<String>,
    pub file_id: u32,
    pub line: u32,
}
