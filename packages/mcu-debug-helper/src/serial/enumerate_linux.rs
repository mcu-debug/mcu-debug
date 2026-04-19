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

//! Serial port enumeration for Linux via a pure-sysfs walk.
//!
//! Does **not** use libudev. Filters phantom `ttyS*` entries (driver-declared
//! but no real hardware) by checking that the device chains back to a real bus
//! (USB, PCI, platform). USB devices are annotated with VID/PID/manufacturer/
//! product from sysfs ancestry.
//!
//! See `uart-management.md §4` ("Linux sysfs walker algorithm") for the full
//! algorithm description.

use super::AvailablePort;

/// Walk `/sys/class/tty/`, filter phantoms, and return real serial ports.
pub fn list() -> Vec<AvailablePort> {
    // TODO: implement sysfs walk (uart-implementation-plan.md Step 5)
    Vec::new()
}
