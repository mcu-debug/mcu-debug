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

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

// Helper request and response types for the helper ↔ DA communication. These are the internal representation of
// requests forwarded from DAP and responses we send back to the DA, before any translation to/from DAP format.
// For all the structs, we represent 64-bit numbers as hex strings in the JSON to avoid issues with JavaScript
// number precision. The helper will parse these hex strings into u64 internally, and when sending responses
// back to the DA, it will convert any u64 addresses back into hex strings.

/**
 * DisassembleArguments represents the arguments for a disassemble request. This is designed to  mirror
 * the DAP DisassembleArguments and should be kept in sync with it. The main difference is that we represent
 * the memoryReference as a hex string, and we use i32 for offsets and counts to allow negative values.
 */
#[derive(Serialize, Deserialize, Debug, ts_rs::TS)]
#[ts(export, export_to = "../../../shared/dasm-helper/")]
#[allow(non_snake_case)]
pub struct DisassembleArguments {
    /** Memory reference to the base location containing the instructions to disassemble. */
    pub memoryReference: String,
    /** Offset (in bytes) to be applied to the reference location before disassembling. Can be negative. */
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offset: Option<i32>,
    /** Offset (in instructions) to be applied after the byte offset (if any) before disassembling. Can be negative. */
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instructionOffset: Option<i32>,
    /** Number of instructions to disassemble starting at the specified location and offset.
        An adapter must return exactly this number of instructions - any unavailable instructions should be replaced with an implementation-defined 'invalid instruction' value.
    */
    pub instructionCount: i32,
    /** If true, the adapter should attempt to resolve memory addresses and other values to symbolic names. */
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolveSymbols: Option<bool>,
}

#[derive(Serialize, Deserialize, Debug, ts_rs::TS)]
#[ts(export, export_to = "../../../shared/dasm-helper/")]
#[allow(non_snake_case)]
pub struct DisassembleRequest {
    pub req: String, // e.g. "disasm"
    pub seq: u64,
    pub arguments: DisassembleArguments,
}

#[derive(Serialize, Deserialize, Debug, ts_rs::TS)]
#[ts(export, export_to = "../../../shared/dasm-helper/")]
#[allow(non_snake_case)]
pub struct GlobalsRequest {
    pub req: String, // e.g. "globals"
    pub seq: u64,
}

#[derive(Serialize, Deserialize, Debug, ts_rs::TS)]
#[ts(export, export_to = "../../../shared/dasm-helper/")]
#[allow(non_snake_case)]
pub struct GlobalsResponse {
    pub req: String, // e.g. "globals"
    pub seq: u64,
    pub globals: Vec<(String, String)>, // (name, address)
}

#[derive(Serialize, Deserialize, Debug, ts_rs::TS)]
#[ts(export, export_to = "../../../shared/dasm-helper/")]
#[allow(non_snake_case)]
pub struct StaticsRequest {
    pub req: String, // e.g. "statics"
    pub seq: u64,
    pub file_name: String,
}

#[derive(Serialize, Deserialize, Debug, ts_rs::TS)]
#[ts(export, export_to = "../../../shared/dasm-helper/")]
#[allow(non_snake_case)]
pub struct StaticsResponse {
    pub req: String, // e.g. "statics"
    pub seq: u64,
    pub statics: Vec<(String, String)>, // (name, address)
}

#[derive(Serialize, Deserialize, Debug, ts_rs::TS)]
#[ts(export, export_to = "../../../shared/dasm-helper/")]
#[allow(non_snake_case)]
pub struct SymbolLookupNameRequest {
    pub req: String, // e.g. "symbolLookup"
    pub seq: u64,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_name: Option<String>, // Optional file name to disambiguate symbols with the same name in different files
}

#[derive(Serialize, Deserialize, Debug, ts_rs::TS)]
#[ts(export, export_to = "../../../shared/dasm-helper/")]
#[allow(non_snake_case)]
pub struct SymbolLookupAddressRequest {
    pub req: String, // e.g. "symbolLookup"
    pub seq: u64,
    pub address: String,
}

#[derive(Serialize, Deserialize, Debug, ts_rs::TS)]
#[ts(export, export_to = "../../../shared/dasm-helper/")]
#[allow(non_snake_case)]
pub struct SymbolLookupResponse {
    pub req: String, // e.g. "symbolLookup"
    pub seq: u64,
    pub symbols: Vec<(String, String)>, // (name, address)
}

/**
 * The SerInstruction is intentionally compact and uses short field names to minimize
 * the size of the JSON response for disassembly requests, which can be quite large.
 */
#[derive(Serialize, Deserialize, Debug, ts_rs::TS)]
#[ts(export, export_to = "../../../shared/dasm-helper/")]
#[allow(non_snake_case)]
pub struct SerInstruction {
    pub a: String,
    pub b: String,
    pub i: String,

    // These are all optional, -1 means not available
    // Use Cell for interior mutability - allows updating these fields even when behind Rc
    pub f: i32, // function_id
    pub o: u32, // offset in function
    pub F: i32, // file_id
    pub sl: i32,
    pub el: i32,
}

/**
 * DisasmResponse is the response to a disassembly request, containing the disassembled instructions and
 * any relevant symbol information. It is designed to be compact for efficient transmission.
 *
 * There are two hashmaps for file and function names. They are actually global id's so they may look random
 * but they allow us to avoid sending the same file and function names repeatedly for every instruction, which
 * can save a lot of space in the response. These hashmaps come with every response so the client is not
 * expected to cache them across responses, but they may contain overlapping information with previous responses.
 * The client can choose to cache them if it wants, but it should not rely on them being the same across responses.
 */

#[derive(Serialize, Deserialize, Debug, ts_rs::TS)]
#[ts(export, export_to = "../../../shared/dasm-helper/")]
pub struct DisasmResponse {
    pub req: String, // e.g. "disasm"
    pub seq: u64,
    pub file_table: HashMap<u32, String>,
    pub func_table: HashMap<u32, String>,
    pub instructions: Vec<SerInstruction>, // (addr_hex, bytes, instr)
}

/**
 * Events generated by the helper process and sent to the DA.
 * Uses internally-tagged enum serialization so each variant has a 'type' field.
 * In TypeScript, this becomes a discriminated union for type-safe event handling.
 */
#[derive(Serialize, Deserialize, Debug, ts_rs::TS)]
#[ts(export, export_to = "../../../shared/dasm-helper/")]
#[serde(tag = "type")]
#[allow(non_snake_case)]
pub enum HelperEvent {
    /// Symbol table has been loaded and is ready for queries
    SymbolTableReady { session_id: String, version: String },

    /// Disassembly has been loaded and cached, ready to serve requests
    DisassemblyReady {
        session_id: String,
        instruction_count: u64,
    },

    /// RTT control block found at address
    RTTFound {
        session_id: String,
        address: String, // hex address
    },

    /// Progress update for long-running operations
    Progress {
        session_id: String,
        operation: String, // e.g. "Loading symbols", "Parsing disassembly"
        #[serde(skip_serializing_if = "Option::is_none")]
        percentage: Option<u32>, // 0-100, None if indeterminate
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },

    /// Output message for debug console
    Output {
        session_id: String,
        category: String, // "stdout", "stderr", "console", "telemetry"
        message: String,
    },

    /// Error message
    Error {
        session_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        code: Option<String>,
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        details: Option<String>,
    },

    /// Diagnostic/log message (typically only shown if verbose logging enabled)
    Log {
        session_id: String,
        level: String, // "trace", "debug", "info", "warn", "error"
        message: String,
    },
}

#[cfg(test)]
mod tests {
    /// This test ensures that ts_rs exports are generated.
    /// The actual TS file generation happens during test compilation,
    /// not test execution, so this test doesn't need to do anything.
    #[test]
    fn ensure_ts_exports() {
        // ts_rs generates the TypeScript files during compilation when the
        // derive macro is expanded. This test just ensures the module compiles.
    }
}
