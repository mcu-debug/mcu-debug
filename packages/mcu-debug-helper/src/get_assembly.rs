use regex::Regex;
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

pub struct AssemblyLine {
    pub address: u64,
    pub bytes: String,
    pub instruction: String,
    pub raw_line: String,
}

pub struct AssemblyBlock {
    pub name: String,
    pub start_address: u64,
    pub lines: Vec<Rc<AssemblyLine>>,
}

impl AssemblyBlock {
    pub fn new(name: String, start_address: u64) -> Self {
        Self {
            name,
            start_address,
            lines: Vec::new(),
        }
    }
    pub fn line_count(&self) -> u32 {
        self.lines.len() as u32
    }
}

impl AssemblyLine {
    pub fn new(address: u64, bytes: String, instruction: String, raw_line: String) -> Self {
        Self {
            address,
            bytes,
            instruction,
            raw_line,
        }
    }

    pub fn format_bytes(&self) -> String {
        return format!("{:X}:{}:{}", self.address, self.bytes, self.instruction);
    }
}

pub struct AssemblyListing {
    pub lines: Vec<Rc<AssemblyLine>>,
    pub addr_map: std::collections::BTreeMap<u64, usize>, // address to index in lines
    pub blocks: Vec<AssemblyBlock>,
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
}

pub fn get_disasm_from_objdump(arg: &str) -> Result<AssemblyListing, Box<dyn Error>> {
    // Spawn objdump and stream its stdout to avoid allocating the whole output
    let mut child = Command::new("arm-none-eabi-objdump")
        .args(&["-Cd", arg])
        .stdout(Stdio::piped())
        .spawn()?;

    let stdout = child
        .stdout
        .take()
        .ok_or("Failed to capture objdump stdout")?;

    let mut reader = BufReader::with_capacity(64 * 1024, stdout);
    let mut buf: Vec<u8> = Vec::with_capacity(8 * 1024);

    let mut listing = AssemblyListing::new();
    let mut current_block = AssemblyBlock::new(String::new(), 0);
    let re_hex_start = Regex::new(r"^[0-9a-fA-F]").unwrap();

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

        let line = String::from_utf8_lossy(&buf);
        let s: &str = line.as_ref();
        if !re_hex_start.is_match(s) || !s.contains(':') {
            continue;
        }

        let words: Vec<&str> = s.split_whitespace().collect();
        if words.len() < 2 {
            continue;
        }

        if s.ends_with(">:") {
            let name = words[1]
                .trim_start_matches('<')
                .trim_end_matches(">:")
                .trim_end_matches('>');
            let addr = u64::from_str_radix(words[0].trim_end_matches(':'), 16).unwrap_or(0);
            if current_block.line_count() > 0 {
                listing.blocks.push(current_block);
            }
            current_block = AssemblyBlock::new(name.to_string(), addr);
            continue;
        }

        if words.len() < 3 {
            continue;
        }

        let addr = u64::from_str_radix(words[0].trim_end_matches(':'), 16).unwrap_or(0);
        let bytes = words[1].to_string();
        let instr_text = words[2].to_string() + "\t" + &words[3..].join(" ");

        let rc_line = Rc::new(AssemblyLine::new(addr, bytes, instr_text, s.to_string()));
        listing.addr_map.insert(addr, listing.lines.len());
        listing.lines.push(rc_line.clone());
        current_block.lines.push(rc_line.clone());
        if (count < 1000) {
            // Debug print first 1000 lines
            let tmp = rc_line.format_bytes();
            println!("{}", tmp);
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
