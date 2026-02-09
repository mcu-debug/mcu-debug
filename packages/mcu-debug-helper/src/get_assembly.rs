use regex::Regex;
use std::cell::Cell;
use std::error::Error;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::rc::Rc;

/// We use objdump to get assembly with addresses but no source info.
/// This module helps parse that assembly output and creates a linear list as well
/// as a map of address to assembly lines for quick lookup.
///
/// Our main client is VSCode's "disassembly" view, which needs to show assembly
/// for a given address range. and that range may not align with function boundaries
/// or other logical divisions in the assembly output. It may also need to go backwards
/// or forwards from a given address.
///
/// When the Debug Adapter requests disassembly for a given address range, we return an
/// array of AssemblyLine structs, each containing the address, bytes, instruction text,
/// in a very compact format suitable for display. The Debug Adapter can then format
/// and present that data as needed.
///

#[derive(Debug)]
pub struct AssemblyLine {
    pub address: u64,
    pub bytes: String,
    pub instruction: String,
    pub raw_line: String, // For debugging, may be useful to have the original line from objdump, for now
    pub offset_in_function: u32, // Offset in bytes from the start of the function, for display purposes. Cell allows us to set this after the fact when we identify function boundaries.

    // These are all optional, -1 means not available
    // Use Cell for interior mutability - allows updating these fields even when behind Rc
    pub function_id: Cell<i32>,
    pub file_id: Cell<i32>,
    pub start_line: Cell<i32>,
    pub start_column: Cell<i32>,
    pub end_line: Cell<i32>,
    pub end_column: Cell<i32>,
}

pub struct AssemblyBlock {
    pub name: String,
    pub id: i32,
    pub start_address: u64,
    pub lines: Vec<Rc<AssemblyLine>>,
}

impl AssemblyBlock {
    pub fn new(name: String, start_address: u64, id: i32) -> Self {
        Self {
            name,
            start_address,
            id,
            lines: Vec::new(),
        }
    }
    pub fn line_count(&self) -> u32 {
        self.lines.len() as u32
    }
}

impl AssemblyLine {
    pub fn new(
        address: u64,
        bytes: String,
        instruction: String,
        raw_line: String,
        function_id: i32,
        offset_in_function: u32,
    ) -> Self {
        Self {
            address,
            bytes,
            instruction,
            raw_line,
            function_id: Cell::new(function_id),
            offset_in_function: offset_in_function,
            file_id: Cell::new(-1),
            start_line: Cell::new(-1),
            start_column: Cell::new(-1),
            end_line: Cell::new(-1),
            end_column: Cell::new(-1),
        }
    }

    pub fn set_source_info(
        &self, // Now takes &self instead of &mut self!
        file_id: i32,
        start_line: i32,
        start_column: i32,
        end_line: i32,
        end_column: i32,
    ) {
        self.file_id.set(file_id);
        self.start_line.set(start_line);
        self.start_column.set(start_column);
        self.end_line.set(end_line);
        self.end_column.set(end_column);
    }

    pub fn clone(&self) -> Self {
        Self {
            address: self.address,
            bytes: self.bytes.clone(),
            instruction: self.instruction.clone(),
            raw_line: self.raw_line.clone(),
            function_id: Cell::new(self.function_id.get()),
            file_id: Cell::new(self.file_id.get()),
            start_line: Cell::new(self.start_line.get()),
            start_column: Cell::new(self.start_column.get()),
            end_line: Cell::new(self.end_line.get()),
            end_column: Cell::new(self.end_column.get()),
            offset_in_function: self.offset_in_function,
        }
    }

    pub fn format_bytes(&self) -> String {
        let offset_str = if self.function_id.get() > 0 {
            format!(
                " <{}+0x{:x}>",
                self.function_id.get(),
                self.offset_in_function
            )
        } else {
            String::new()
        };
        format!(
            "{:x}:{}\t{}\t{}",
            self.address, offset_str, self.bytes, self.instruction
        )
    }
}

pub struct AssemblyListing {
    pub lines: Vec<Rc<AssemblyLine>>,
    pub addr_map: std::collections::BTreeMap<u64, usize>, // address to index in lines
    pub blocks: Vec<AssemblyBlock>,
}

impl Default for AssemblyListing {
    fn default() -> Self {
        Self::new()
    }
}

impl AssemblyListing {
    pub fn new() -> Self {
        Self {
            lines: Vec::new(),
            addr_map: std::collections::BTreeMap::new(),
            blocks: Vec::new(),
        }
    }

    pub fn insert_line(&mut self, line: AssemblyLine) {
        let rc_line = Rc::new(line);
        self.addr_map.insert(rc_line.address, self.lines.len());
        self.lines.push(rc_line);
    }

    pub fn get_line_by_addr(&self, address: u64) -> Option<&AssemblyLine> {
        if let Some(&index) = self.addr_map.get(&address) {
            return self.lines.get(index).map(|rc_line| rc_line.as_ref());
        }
        None
    }

    /// The "Magic" lookup: find N instructions before or after a target address.
    /// Returns owned values since filler instructions may be synthesized.
    pub fn get_window(&self, target_addr: u64, before: usize, after: usize) -> Vec<AssemblyLine> {
        let mut result: Vec<AssemblyLine> = Vec::with_capacity(before + after + 1);
        let dummy_instr = AssemblyLine::new(
            0,
            String::new(),
            String::from("<invalid instr>"),
            String::new(),
            -1,
            0,
        );

        // 1. Find the instruction at or immediately before the target_addr
        // range(..=target_addr) gives us everything up to the target, .next_back() is the closest
        if let Some((&start_addr, _)) = self.addr_map.range(..=target_addr).next_back() {
            if before > 0 {
                // 2. Grab the 'before' instructions
                // We take all instructions up to start_addr, reverse them, take 'before' + 1 (the current one)
                let before_indices: Vec<_> = self
                    .addr_map
                    .range(..=start_addr)
                    .rev()
                    .take(before + 1)
                    .map(|(_, inst)| inst.clone())
                    .collect();
                let mut before_instrs: Vec<AssemblyLine> = before_indices
                    .iter()
                    .map(|ix| {
                        self.lines
                            .get(*ix)
                            .expect("index from addr_map should always be valid in lines vector")
                            .as_ref()
                            .clone()
                    })
                    .collect();
                let mut tmp_addr = before_instrs[0].address;
                while before_instrs.len() < before + 1 {
                    // pad with dummy instructions if we don't have enough
                    let mut tmp = dummy_instr.clone();
                    tmp.address = tmp_addr - 2; // arbitrary address. TODO: Use minimum instruction size for the architecture to calculate a more realistic address
                    before_instrs.push(tmp);
                    tmp_addr -= 2;
                }

                // Reverse them back to chronological order
                result.extend(before_instrs.into_iter().rev());
            }

            if after > 0 {
                // 3. Grab the 'after' instructions
                let after_instrs = self
                    .addr_map
                    .range((start_addr + 1)..)
                    .take(after)
                    .map(|(_, inst)| inst.clone());
                let mut after_instrs: Vec<AssemblyLine> = after_instrs
                    .map(|ix| {
                        self.lines
                            .get(ix)
                            .expect("index from addr_map should always be valid in lines vector")
                            .as_ref()
                            .clone()
                    })
                    .collect();
                let mut tmp_addr = after_instrs[after_instrs.len() - 1].address;
                while after_instrs.len() < after {
                    // pad with dummy instructions if we don't have enough
                    let mut tmp = dummy_instr.clone();
                    tmp.address = tmp_addr + 2; // arbitrary address. TODO: Use minimum instruction size for the architecture to calculate a more realistic address
                    after_instrs.push(tmp);
                    tmp_addr += 2;
                }

                result.extend(after_instrs);
            }
        }
        result
    }
}

pub fn get_disasm_from_objdump(arg: &str) -> Result<AssemblyListing, Box<dyn Error>> {
    // Spawn objdump and stream its stdout to avoid allocating the whole output
    let mut child = Command::new("arm-none-eabi-objdump")
        .args(["-Cd", arg])
        .stdout(Stdio::piped())
        .spawn()?;

    let stdout = child
        .stdout
        .take()
        .ok_or("Failed to capture objdump stdout")?;

    let mut reader = BufReader::with_capacity(64 * 1024, stdout);
    let mut buf: Vec<u8> = Vec::with_capacity(8 * 1024);

    let mut listing = AssemblyListing::new();
    let mut current_block = AssemblyBlock::new(String::new(), 0, -1);
    let re_hex_start = Regex::new(r"^[0-9a-f]+").unwrap(); // Yes, only look for lowercase hex

    let mut count = 0;
    loop {
        buf.clear();
        let n = reader.read_until(b'\n', &mut buf)?;
        if n == 0 {
            break; // EOF
        }

        // strip trailing CR/LF
        while buf
            .last()
            .map(|b| *b == b'\n' || *b == b'\r')
            .unwrap_or(false)
        {
            buf.pop();
        }

        if buf.is_empty() {
            // An empty line indicates end of a block
            if current_block.line_count() > 0 {
                listing.blocks.push(current_block);
            }
            current_block = AssemblyBlock::new(String::new(), 0, -1);
            continue;
        }

        let line = String::from_utf8_lossy(&buf).trim().to_string();
        let raw_line: &str = line.as_ref();
        if !re_hex_start.is_match(raw_line) || !raw_line.contains(':') {
            continue;
        }

        let mut words = raw_line.split("\t").collect::<Vec<&str>>();
        if (words.len() == 1) && raw_line.ends_with(">:") {
            let parts: Vec<&str> = raw_line.split_whitespace().collect();
            if parts.len() < 2 {
                continue;
            }
            let name = parts[1]
                .trim_start_matches('<')
                .trim_end_matches(">:")
                .trim_end_matches('>');
            let address = u64::from_str_radix(parts[0].trim_end_matches(':'), 16).unwrap_or(0);
            if current_block.line_count() > 0 {
                // Maybe we should also push if the block has a name? For now we require at least one instruction to push
                // a block, but objdump can emit empty blocks for labels and such.
                listing.blocks.push(current_block);
            }
            current_block =
                AssemblyBlock::new(name.to_string(), address, listing.blocks.len() as i32);
            continue;
        }

        words = words.into_iter().map(|w| w.trim()).collect::<Vec<&str>>();
        if words.len() < 3 {
            continue;
        }

        let address = u64::from_str_radix(words[0].trim_end_matches(':'), 16).unwrap_or(0);
        let mut bytes = words[1].to_string();
        bytes.retain(|c| !c.is_whitespace());
        let instruction = words[2..].join("\t").to_string();

        if address < current_block.start_address {
            // This shouldn't happen in well-formed objdump output, but if it does, we can treat it as a new block. Log it for debugging.
            eprintln!(
                "Offset in function: address: 0x{:X}, current block start: 0x{:X}",
                address, current_block.start_address
            );
            // New block without a header - push the old block and start a new one with an empty name
            if current_block.line_count() > 0 {
                listing.blocks.push(current_block);
            }
            current_block = AssemblyBlock::new(String::new(), address, listing.blocks.len() as i32);
            continue;
        }
        let rc_line = Rc::new(AssemblyLine::new(
            address,
            bytes,
            instruction,
            raw_line.to_string(),
            current_block.id,
            (address - current_block.start_address) as u32,
        ));
        listing.addr_map.insert(address, listing.lines.len());
        listing.lines.push(rc_line.clone());
        current_block.lines.push(rc_line.clone());
        if count < 1000 {
            // Debug print first 1000 lines
            let tmp = rc_line.format_bytes();
            eprintln!("{}", tmp);
        }
        count += 1;
    }

    // ensure child finishes
    let _status = child.wait()?;

    if current_block.line_count() > 0 {
        listing.blocks.push(current_block);
    }

    Ok(listing)
}
