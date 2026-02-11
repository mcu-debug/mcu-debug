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

// Crate root: declare modules and control visibility
pub mod disasm_worker;
pub mod elf_items;
pub mod get_assembly;
pub mod helper_requests;
pub mod memory;
pub mod protocol;
pub mod request_handler;
pub mod symbols;
pub mod transport;
pub mod utils;

// Re-export commonly used API from the library for binaries/tests
pub use elf_items::ObjectInfo;
pub use get_assembly::get_disasm_from_objdump;
