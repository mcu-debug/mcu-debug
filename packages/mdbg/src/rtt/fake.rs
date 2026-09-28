// Copyright (c) 2026 MCU-Debug Authors.
// SPDX-License-Identifier: Apache-2.0

//! A target that is a byte array, for testing the RTT engine without a probe.
//!
//! Lives in its own file rather than inside one test module because both the ring-buffer tests and
//! the engine's own tests need it, and a second copy of a fake target is a second thing that can
//! disagree with the real layout.

use super::*;
use crate::common::sync::MutexExt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

pub const CB_ADDR: u64 = 0x2000_0000;
pub const BUF_ADDR: u64 = 0x2000_1000;
/// The down channel's buffer, deliberately a different address from the up channel's: a test that
/// confused the two would otherwise still pass.
pub const DOWN_BUF_ADDR: u64 = 0x2000_2000;
pub const BUF_SIZE: u32 = 64;

/// A target that is a byte array, so the ring-buffer arithmetic is checked against memory that
/// behaves exactly like the real thing and nothing else.
pub struct FakeTarget {
    base: u64,
    mem: Mutex<Vec<u8>>,
    /// Every read, so a test can assert how many round trips a drain cost.
    reads: Mutex<Vec<(u64, usize)>>,
    writes: Mutex<Vec<(u64, Vec<u8>)>>,
    pub fail_reads_at: Mutex<Option<u64>>,
    /// Stands in for the mux's send gate, so a test can hold the engine off without a real channel.
    ready: AtomicBool,
}

impl Default for FakeTarget {
    fn default() -> Self {
        Self::new()
    }
}

impl FakeTarget {
    pub fn new() -> Self {
        Self {
            base: CB_ADDR,
            mem: Mutex::new(vec![0u8; 0x4000]),
            reads: Mutex::new(Vec::new()),
            writes: Mutex::new(Vec::new()),
            fail_reads_at: Mutex::new(None),
            ready: AtomicBool::new(true),
        }
    }

    /// Open or shut the stand-in for the send gate.
    pub fn set_ready(&self, ready: bool) {
        self.ready.store(ready, Ordering::SeqCst);
    }

    pub fn put(&self, addr: u64, bytes: &[u8]) {
        let off = (addr - self.base) as usize;
        self.mem.lock_recover()[off..off + bytes.len()].copy_from_slice(bytes);
    }

    pub fn put_u32(&self, addr: u64, value: u32) {
        self.put(addr, &value.to_le_bytes());
    }

    /// A control block with one up and one down channel, and a 64-byte up buffer.
    pub fn with_control_block(self, id: &str, up: u32, down: u32) -> Self {
        let mut id_field = [0u8; ID_LEN];
        let bytes = id.as_bytes();
        id_field[..bytes.len()].copy_from_slice(bytes);
        self.put(CB_ADDR, &id_field);
        self.put_u32(CB_ADDR + 16, up);
        self.put_u32(CB_ADDR + 20, down);
        self
    }

    /// Fill up channel 0's descriptor and its buffer contents.
    pub fn with_up_channel(self, wr_off: u32, rd_off: u32, contents: &[u8]) -> Self {
        let desc = CB_ADDR + CB_HEADER_LEN as u64;
        self.put_u32(desc, 0xdead_beef); // sName, never followed
        self.put_u32(desc + 4, BUF_ADDR as u32);
        self.put_u32(desc + 8, BUF_SIZE);
        self.put_u32(desc + 12, wr_off);
        self.put_u32(desc + 16, rd_off);
        self.put(BUF_ADDR, contents);
        self
    }

    /// Fill down channel `channel`'s descriptor. `rd_off` is the target's read pointer, so a
    /// non-zero value is how a test says "the firmware has consumed some of its input".
    pub fn with_down_channel(self, channel: u32, rd_off: u32) -> Self {
        let up_channels = u32::from_le_bytes(self.bytes_at(CB_ADDR + 16, 4).try_into().unwrap());
        let desc = CB_ADDR + CB_HEADER_LEN as u64 + (up_channels + channel) as u64 * DESC_LEN as u64;
        self.put_u32(desc, 0xdead_beef); // sName
        self.put_u32(desc + 4, DOWN_BUF_ADDR as u32);
        self.put_u32(desc + 8, BUF_SIZE);
        self.put_u32(desc + 12, 0); // WrOff -- ours to move
        self.put_u32(desc + 16, rd_off);
        self
    }

    pub fn bytes_at(&self, addr: u64, len: usize) -> Vec<u8> {
        let off = (addr - self.base) as usize;
        self.mem.lock_recover()[off..off + len].to_vec()
    }

    pub fn read_u32_at(&self, addr: u64) -> u32 {
        u32::from_le_bytes(self.bytes_at(addr, 4).try_into().unwrap())
    }

    pub fn read_count(&self) -> usize {
        self.reads.lock_recover().len()
    }

    pub fn write_count(&self) -> usize {
        self.writes.lock_recover().len()
    }

    pub fn last_write(&self) -> (u64, Vec<u8>) {
        self.writes.lock_recover().last().cloned().expect("a write")
    }
}

impl TargetMemory for FakeTarget {
    fn read(&self, addr: u64, len: usize) -> Result<Vec<u8>, RspError> {
        self.reads.lock_recover().push((addr, len));
        if Some(addr) == *self.fail_reads_at.lock_recover() {
            return Err(RspError::Target(Some(5)));
        }
        let off = (addr - self.base) as usize;
        Ok(self.mem.lock_recover()[off..off + len].to_vec())
    }
    fn ready(&self) -> bool {
        self.ready.load(Ordering::SeqCst)
    }
    fn write(&self, addr: u64, data: &[u8]) -> Result<(), RspError> {
        self.writes.lock_recover().push((addr, data.to_vec()));
        self.put(addr, data);
        Ok(())
    }
}
