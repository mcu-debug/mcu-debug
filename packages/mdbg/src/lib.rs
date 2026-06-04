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

// Crate root: organized into three sub-modules
pub mod cockpit;
pub mod common;
pub mod da_helper;
pub mod proxy_helper;
pub mod serial;

// Re-export commonly used API from the library for binaries/tests
pub use da_helper::elf_items::ObjectInfo;
pub use da_helper::get_assembly::get_disasm_from_objdump;

// Re-export common modules at crate level for backward compatibility
pub use common::debug;
pub use common::transport;
pub use common::utils;
