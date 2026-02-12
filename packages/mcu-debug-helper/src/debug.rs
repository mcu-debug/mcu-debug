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

/// Global debug flag settings
use std::sync::OnceLock;

static DEBUG_ENABLED: OnceLock<bool> = OnceLock::new();

/// Initialize the debug flag. Must be called once at startup.
pub fn set_debug(enabled: bool) {
    DEBUG_ENABLED.set(enabled).ok();
}

/// Check if debug mode is enabled
pub fn is_debug() -> bool {
    *DEBUG_ENABLED.get().unwrap_or(&false)
}

/// Print debug message if debug mode is enabled
#[macro_export]
macro_rules! debug_println {
    ($($arg:tt)*) => {
        if $crate::debug::is_debug() {
            eprintln!($($arg)*);
        }
    };
}

/// Print debug message always (for important diagnostics)
#[macro_export]
macro_rules! info_println {
    ($($arg:tt)*) => {
        eprintln!($($arg)*);
    };
}
