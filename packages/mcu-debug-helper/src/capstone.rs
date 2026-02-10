use capstone::prelude::*;

pub struct Disassembler {
    cs: Capstone,
}

impl Disassembler {
    pub fn new() -> Result<Self, capstone::Error> {
        // For Cortex-M, we use ARM + Thumb mode
        let cs = Capstone::new()
            .arm()
            .mode(arch::arm::Mode::Thumb)
            .extra_mode([arch::arm::ExtraMode::V8].iter().copied())
            .detail(true) // Required for getting instruction sizes/registers
            .build()?;

        Ok(Self { cs })
    }

    /// Disassembles a block of memory
    pub fn disassemble_block(
        &self,
        code: &[u8],
        address: u64,
    ) -> Result<Vec<InstructionData>, capstone::Error> {
        let insns = self.cs.disasm_all(code, address)?;

        let mut results = Vec::with_capacity(insns.len());
        for i in insns.iter() {
            results.push(InstructionData {
                address: i.address(),
                size: i.bytes().len() as u8,
                mnemonic: i.mnemonic().unwrap_or("").to_string(),
                op_str: i.op_str().unwrap_or("").to_string(),
                bytes: i.bytes().to_vec(),
            });
        }

        Ok(results)
    }
}

#[derive(Debug, Clone)]
pub struct InstructionData {
    pub address: u64,
    pub size: u8,
    pub mnemonic: String,
    pub op_str: String,
    pub bytes: Vec<u8>,
}
