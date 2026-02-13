// Copyright (c) 2026 MCU-Debug Authors.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

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
