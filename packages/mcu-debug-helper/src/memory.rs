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

use serde_json::{json, Value};

pub struct MemoryRegion {
    pub name: String,
    pub start: u64,
    pub size: u64,
    pub align: u64,
}

impl MemoryRegion {
    pub fn new(name: String, start: u64, size: u64, align: u64) -> Self {
        Self {
            name,
            start,
            size,
            align,
        }
    }

    pub fn contains(&self, addr: u64) -> bool {
        addr >= self.start && addr < self.start + self.size
    }

    pub fn end(&self) -> u64 {
        self.start + self.size
    }

    pub fn to_json(&self) -> Value {
        json!({
            "name": self.name,
            "start": format!("0x{:x}", self.start),
            "size": format!("0x{:x}", self.size),
            "align": format!("0x{:x}", self.align),
        })
    }

    pub fn clip_region(&self, low_addr: u64, high_addr: u64) -> Option<MemoryRegion> {
        let new_start = self.start.max(low_addr);
        let new_end = self.end().min(high_addr);
        if new_start < new_end {
            Some(MemoryRegion::new(
                self.name.clone(),
                new_start,
                new_end - new_start,
                self.align,
            ))
        } else {
            None
        }
    }
}
