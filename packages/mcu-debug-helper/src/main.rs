use anyhow::Result;
use object::{Object, ObjectSection};
use std::{borrow::Cow, env, fs, rc::Rc};

fn main() -> Result<()> {
    // For prototyping, take the ELF path as an argument
    let args: Vec<String> = env::args().collect();
    if args.len() < 2 {
        println!("Usage: mcu-debug-helper <path_to_elf>");
        return Ok(());
    }

    let path = &args[1];
    let file_data = fs::read(path)?;
    let obj_file = object::File::parse(&*file_data)?;

    // Load DWARF sections
    let load_section =
        |id: gimli::SectionId| -> Result<gimli::EndianRcSlice<gimli::RunTimeEndian>> {
            let data = obj_file
                .section_by_name(id.name())
                .map(|s| s.uncompressed_data().unwrap_or_default())
                .unwrap_or_default();

            let data_rc: Rc<[u8]> = match data {
                Cow::Borrowed(b) => Rc::from(b),
                Cow::Owned(o) => Rc::from(o),
            };
            Ok(gimli::EndianRcSlice::new(
                data_rc,
                gimli::RunTimeEndian::Little,
            ))
        };

    let dwarf = gimli::Dwarf::load(&load_section)?;
    let debug_str = dwarf.debug_str;

    // Iterate over Compilation Units to find line info
    let mut units = dwarf.units();
    while let Some(header) = units.next()? {
        let unit = dwarf.unit(header)?;
        if let Some(program) = unit.line_program.clone() {
            let mut rows = program.rows();
            while let Some((_header, row)) = rows.next_row()? {
                // Here is your data for the RB-Tree/BTreeMap
                // row.address(), row.file(), row.line()
                if row.is_stmt() {
                    println!("Address: 0x{:x} -> Line: {:?}", row.address(), row.line());
                }
            }
        }
    }

    units = dwarf.units();
    while let Some(header) = units.next()? {
        // Parse the abbreviations and other information for this compilation unit.
        let unit = dwarf.unit(header)?;

        // Iterate over all of this compilation unit's entries.
        let mut entries = unit.entries();
        while let Some((_, entry)) = entries.next_dfs()? {
            // If we find an entry for a function, print it.
            if entry.tag() == gimli::DW_TAG_subprogram {
                let mut attrs = entry.attrs();
                while let Some(attr) = attrs.next().unwrap() {
                    println!("Attribute name = {:?}", attr.name());
                    println!("Attribute value = {:?}", gimli::Dwarf::attr_string(dwarf, unit, attr)  attr.value());
                }
            }
        }
    }

    Ok(())
}
