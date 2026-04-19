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

//! Serial port enumeration for Windows via `serialport::available_ports()`,
//! which wraps the SetupDi Win32 APIs (always present, no extra dependencies).

use super::AvailablePort;

/// Enumerate available serial ports using the Windows SetupDi APIs.
pub fn list() -> Vec<AvailablePort> {
    // TODO: implement (uart-implementation-plan.md Step 5)
    Vec::new()
}
