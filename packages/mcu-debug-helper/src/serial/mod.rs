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

// Kept as a reference during the refactor; see uart-implementation-plan.md §1.
// Will be deleted at end of Phase 2 once feature parity is reached.
pub mod run_serial;

pub mod port;
pub mod ring;

#[cfg(target_os = "linux")]
pub mod enumerate_linux;
#[cfg(target_os = "macos")]
pub mod enumerate_macos;
#[cfg(target_os = "windows")]
pub mod enumerate_windows;

/// Uniform representation of an available serial port returned by all
/// platform-specific enumerators. `description` is informational only —
/// never used as an identity key. Port paths are the stable key.
pub struct AvailablePort {
    pub path: String,
    pub description: String,
    pub vid: Option<u16>,
    pub pid: Option<u16>,
}

/// List available serial ports on the current platform.
#[cfg(target_os = "linux")]
pub fn list_available() -> Vec<AvailablePort> {
    enumerate_linux::list()
}
#[cfg(target_os = "windows")]
pub fn list_available() -> Vec<AvailablePort> {
    enumerate_windows::list()
}
#[cfg(target_os = "macos")]
pub fn list_available() -> Vec<AvailablePort> {
    enumerate_macos::list()
}
#[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
pub fn list_available() -> Vec<AvailablePort> {
    Vec::new()
}
