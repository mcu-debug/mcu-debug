use std::collections::BTreeMap;

pub struct InstructionDb {
    // Key is the start address
    pub map: BTreeMap<u64, Instruction>,
}

impl InstructionDb {
    pub fn new() -> Self {
        Self { map: BTreeMap::new() }
    }

    /// The "Magic" lookup: find N instructions before or after a target address
    pub fn get_window(&self, target_addr: u64, before: usize, after: usize) -> Vec<Instruction> {
        let mut result = Vec::with_capacity(before + after + 1);

        // 1. Find the instruction at or immediately before the target_addr
        // range(..=target_addr) gives us everything up to the target, .next_back() is the closest
        if let Some((&start_addr, _)) = self.map.range(..=target_addr).next_back() {
            
            // 2. Grab the 'before' instructions
            // We take all instructions up to start_addr, reverse them, take 'before' + 1 (the current one)
            let before_instrs: Vec<_> = self.map
                .range(..=start_addr)
                .rev()
                .take(before + 1)
                .map(|(_, inst)| inst.clone())
                .collect();
            
            // Reverse them back to chronological order
            result.extend(before_instrs.into_iter().rev());

            // 3. Grab the 'after' instructions
            let after_instrs = self.map
                .range((start_addr + 1)..)
                .take(after)
                .map(|(_, inst)| inst.clone());
            
            result.extend(after_instrs);
        }

        result
    }
}
