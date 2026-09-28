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

//! SEGGER RTT over target memory (`docs-internal/gdb-rsp.md` item 20).
//!
//! RTT is a ring buffer in the target's RAM plus a control block describing it. Reading it needs
//! nothing but memory access, which is why this module knows about [`TargetMemory`] and nothing
//! about RSP, the mux or the proxy. The port of `rtt-builtin.ts` onto the multiplexer is then just
//! a matter of handing it a [`crate::gdb_rsp::Consumer`].
//!
//! The layout, from `SEGGER_RTT.h` and matching what `rtt-builtin.ts` already reads:
//!
//! ```text
//! SEGGER_RTT_CB                         RING_BUFFER (24 bytes, 32-bit target)
//!   acID[16]            "SEGGER RTT"      sName         u32  (a pointer; not read)
//!   MaxNumUpBuffers     u32               pBuffer       u32
//!   MaxNumDownBuffers   u32               SizeOfBuffer  u32
//!   aUp[MaxNumUp]       RING_BUFFER[]     WrOff         u32  (target writes)
//!   aDown[MaxNumDown]   RING_BUFFER[]     RdOff         u32  (host writes)
//!                                         Flags         u32  (not read)
//! ```
//!
//! **The control block's address is given to us, not searched for.** `rttConfig.address: "auto"` is
//! resolved from the ELF's `_SEGGER_RTT` symbol by the debug adapter before anything here runs, and
//! `searchSize` is not used by the current implementation either. What looks like a search is really
//! a *readiness poll*: the firmware writes `acID` last, so the block is usable exactly when that
//! string appears at the address we were given.
//!
//! Pure planning is separated from I/O the same way [`crate::gdb_rsp::chunk`] separates them: all
//! the ring-buffer arithmetic is in [`plan_drain`], which is where a wrap-handling mistake would
//! do the most damage. Getting `RdOff` wrong by one byte desynchronises that channel for the rest
//! of the session -- every later read is offset, and the output is silently corrupt rather than
//! obviously broken -- so it is worth testing without a target in the way.

use crate::gdb_rsp::{Consumer, Endian, RspError};

/// `acID` is 16 bytes, and the search string is truncated to fit.
pub const ID_LEN: usize = 16;
/// `acID[16]` + `MaxNumUpBuffers` + `MaxNumDownBuffers`.
pub const CB_HEADER_LEN: usize = 24;
/// One `RING_BUFFER`.
pub const DESC_LEN: usize = 24;
/// Offset of the first field we read within a descriptor: `sName` is a pointer we never follow.
const DESC_SKIP: u64 = 4;
/// `pBuffer`, `SizeOfBuffer`, `WrOff`, `RdOff` -- four words, starting after `sName`. `Flags` is
/// not read, matching the TypeScript implementation.
const DESC_READ_LEN: usize = 16;
/// SEGGER's own maximum, and a sanity bound on a control block read mid-initialisation.
pub const MAX_CHANNELS: u32 = 16;

/// What can go wrong reading RTT.
///
/// [`RttError::NotReady`] is deliberately not an error condition: it is the normal state before the
/// firmware has initialised RTT, and the answer to it is to poll again rather than to report
/// anything. Keeping it separate from a real failure is what stops a session that starts before the
/// firmware does from filling the console with warnings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RttError {
    /// The control block is not initialised yet. Poll again.
    NotReady,
    /// Target memory could not be read or written.
    Memory(RspError),
    /// Something was read that cannot be a valid control block or descriptor.
    Invalid(String),
}

impl From<RspError> for RttError {
    fn from(e: RspError) -> Self {
        RttError::Memory(e)
    }
}

impl std::fmt::Display for RttError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RttError::NotReady => write!(f, "the RTT control block is not initialised yet"),
            RttError::Memory(e) => write!(f, "target memory access failed: {e:?}"),
            RttError::Invalid(why) => write!(f, "invalid RTT control block: {why}"),
        }
    }
}

/// Target memory, as RTT needs it.
///
/// A trait rather than a concrete [`Consumer`] so that the ring-buffer logic can be tested against
/// a plain byte array. Both implementations are blocking; callers are expected to be on their own
/// thread.
pub trait TargetMemory {
    fn read(&self, addr: u64, len: usize) -> Result<Vec<u8>, RspError>;
    fn write(&self, addr: u64, data: &[u8]) -> Result<(), RspError>;
}

impl TargetMemory for Consumer {
    fn read(&self, addr: u64, len: usize) -> Result<Vec<u8>, RspError> {
        self.read_memory(addr, len)
    }
    fn write(&self, addr: u64, data: &[u8]) -> Result<(), RspError> {
        self.write_memory(addr, data)
    }
}

/// A control block that has been found and validated.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ControlBlock {
    pub addr: u64,
    /// `MaxNumUpBuffers` — target to host, which is what a terminal displays.
    pub up_channels: u32,
    /// `MaxNumDownBuffers` — host to target, which is what a terminal's input goes to.
    pub down_channels: u32,
}

impl ControlBlock {
    /// Address of up channel `channel`'s descriptor.
    pub fn up_desc_addr(&self, channel: u32) -> u64 {
        self.addr + CB_HEADER_LEN as u64 + channel as u64 * DESC_LEN as u64
    }

    /// Address of down channel `channel`'s descriptor. The down descriptors follow *all* of the up
    /// descriptors, so this depends on `up_channels` rather than on how many are in use.
    pub fn down_desc_addr(&self, channel: u32) -> u64 {
        self.addr + CB_HEADER_LEN as u64 + (self.up_channels + channel) as u64 * DESC_LEN as u64
    }
}

/// One ring buffer's mutable state, as read from its descriptor.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RingBuffer {
    pub buf_addr: u64,
    pub size: u32,
    /// Written by the target.
    pub wr_off: u32,
    /// Written by us, to release space back to the target.
    pub rd_off: u32,
}

impl RingBuffer {
    /// Reject what cannot be a live buffer.
    ///
    /// Worth doing on every read, not just the first: a descriptor read while the firmware is
    /// initialising can return anything, and `wr_off - rd_off` on two garbage words is a read
    /// length of up to 4 GB. The TypeScript implementation has no such check, which is why a
    /// mistimed start can ask for an absurd amount of memory.
    pub fn validate(&self) -> Result<(), RttError> {
        if self.buf_addr == 0 || self.size == 0 {
            // Not a failure: the firmware has not allocated this channel yet.
            return Err(RttError::NotReady);
        }
        if self.wr_off >= self.size || self.rd_off >= self.size {
            return Err(RttError::Invalid(format!(
                "offsets outside the buffer: WrOff={}, RdOff={}, SizeOfBuffer={}",
                self.wr_off, self.rd_off, self.size
            )));
        }
        Ok(())
    }

    /// Bytes the target has written that we have not taken.
    pub fn available(&self) -> usize {
        if self.wr_off >= self.rd_off {
            (self.wr_off - self.rd_off) as usize
        } else {
            // Wrapped: to the end of the buffer, then from the start.
            (self.size - self.rd_off + self.wr_off) as usize
        }
    }

    pub fn is_empty(&self) -> bool {
        self.wr_off == self.rd_off
    }
}

/// One contiguous run to read: absolute address and length.
pub type Run = (u64, usize);

/// What a single drain should read, and what `RdOff` becomes afterwards.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DrainPlan {
    pub first: Run,
    /// Present only when the available data wraps past the end of the buffer.
    pub second: Option<Run>,
    /// `RdOff` once everything in this plan has been read. **Only write this after the reads have
    /// succeeded** — it is what tells the target the space is free, and writing it early loses
    /// data that is still in flight.
    pub new_rd_off: u32,
}

impl DrainPlan {
    pub fn len(&self) -> usize {
        self.first.1 + self.second.map_or(0, |(_, n)| n)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// Plan a drain of `rb`, taking at most `max_bytes` if given.
///
/// `Ok(None)` means the buffer is empty, which is the common case on a quiet channel and is not
/// worth a round trip to confirm twice.
///
/// A cap matters for a shared connection: without one, a channel that has filled a 64 KB buffer
/// produces a single read that holds the mux for as long as it takes, and GDB is waiting behind it
/// (§4.2 invariant 2). The TypeScript implementation has no cap — its 512-byte MI chunking is
/// incidental, not a policy.
pub fn plan_drain(rb: &RingBuffer, max_bytes: Option<usize>) -> Result<Option<DrainPlan>, RttError> {
    rb.validate()?;
    if rb.is_empty() {
        return Ok(None);
    }
    let want = match max_bytes {
        Some(cap) => rb.available().min(cap.max(1)),
        None => rb.available(),
    };

    if rb.wr_off > rb.rd_off {
        // Linear: [....Rd----Wr....]
        let n = want.min((rb.wr_off - rb.rd_off) as usize);
        Ok(Some(DrainPlan {
            first: (rb.buf_addr + rb.rd_off as u64, n),
            second: None,
            new_rd_off: rb.rd_off + n as u32,
        }))
    } else {
        // Wrapped: [---Wr....Rd----]. The tail first, then as much of the head as the cap allows.
        let tail = (rb.size - rb.rd_off) as usize;
        if want <= tail {
            let new_rd_off = rb.rd_off + want as u32;
            Ok(Some(DrainPlan {
                first: (rb.buf_addr + rb.rd_off as u64, want),
                second: None,
                // Landing exactly on the end of the buffer means offset 0, not `size`: an offset
                // equal to `size` is out of range and would fail `validate` on the next read.
                new_rd_off: if new_rd_off == rb.size { 0 } else { new_rd_off },
            }))
        } else {
            let head = want - tail;
            Ok(Some(DrainPlan {
                first: (rb.buf_addr + rb.rd_off as u64, tail),
                second: Some((rb.buf_addr, head)),
                new_rd_off: head as u32,
            }))
        }
    }
}

/// How a drain behaves. Both knobs exist because the right answer depends on the firmware.
#[derive(Debug, Clone, Copy)]
pub struct DrainOptions {
    /// Cap on one drain, so one channel cannot hold the shared connection indefinitely.
    pub max_bytes: Option<usize>,
    /// Advance `RdOff` after *each* run rather than once at the end.
    ///
    /// One write is one fewer round trip, and round trips are what RTT throughput is bound by. But
    /// `RdOff` is what releases space to the target, so with firmware that blocks when the buffer
    /// is full, writing it later keeps the target blocked longer. `rtt-builtin.ts` advances per
    /// chunk, so this defaults to the cheaper behaviour while leaving the other reachable.
    pub advance_after_each_run: bool,
}

impl Default for DrainOptions {
    fn default() -> Self {
        Self {
            max_bytes: Some(4096),
            advance_after_each_run: false,
        }
    }
}

/// Poll the control block until the firmware has initialised it.
///
/// Reads the header in **one** operation — the id and both channel counts are 24 contiguous bytes.
/// `rtt-builtin.ts` uses two reads, which costs an extra round trip on every poll until RTT starts.
pub fn find_control_block(
    mem: &dyn TargetMemory,
    addr: u64,
    search_id: &str,
    endian: Endian,
) -> Result<ControlBlock, RttError> {
    let header = mem.read(addr, CB_HEADER_LEN)?;
    let id = &header[..ID_LEN];
    // The firmware writes `acID` last, so anything else here means "not yet". Compared with the
    // NULs stripped, as the TypeScript does: the field is NUL-padded to 16 bytes.
    let found: String = id.iter().filter(|&&b| b != 0).map(|&b| b as char).collect();
    let wanted: String = search_id.chars().take(ID_LEN).collect();
    if found != wanted {
        return Err(RttError::NotReady);
    }
    let up = read_u32(&header[16..20], endian);
    let down = read_u32(&header[20..24], endian);
    if up == 0 || up > MAX_CHANNELS || down > MAX_CHANNELS {
        // The id matched but the counts did not, so this is a real problem rather than a timing
        // one: either the block is corrupt or it is not the layout we think it is.
        return Err(RttError::Invalid(format!(
            "{up} up channels and {down} down channels is not possible"
        )));
    }
    Ok(ControlBlock {
        addr,
        up_channels: up,
        down_channels: down,
    })
}

/// Read one descriptor's mutable state.
pub fn read_descriptor(mem: &dyn TargetMemory, desc_addr: u64, endian: Endian) -> Result<RingBuffer, RttError> {
    let bytes = mem.read(desc_addr + DESC_SKIP, DESC_READ_LEN)?;
    Ok(RingBuffer {
        buf_addr: read_u32(&bytes[0..4], endian) as u64,
        size: read_u32(&bytes[4..8], endian),
        wr_off: read_u32(&bytes[8..12], endian),
        rd_off: read_u32(&bytes[12..16], endian),
    })
}

/// Take whatever an up channel has for us, and release the space.
///
/// `Ok(None)` when there was nothing, which is the ordinary answer on a quiet channel.
pub fn drain_up_channel(
    mem: &dyn TargetMemory,
    cb: &ControlBlock,
    channel: u32,
    endian: Endian,
    opts: &DrainOptions,
) -> Result<Option<Vec<u8>>, RttError> {
    let desc_addr = cb.up_desc_addr(channel);
    let rb = read_descriptor(mem, desc_addr, endian)?;
    let Some(plan) = plan_drain(&rb, opts.max_bytes)? else {
        return Ok(None);
    };

    let rd_off_addr = desc_addr + DESC_SKIP + 12; // past pBuffer, SizeOfBuffer and WrOff
    let mut out = Vec::with_capacity(plan.len());

    let (addr, len) = plan.first;
    out.extend_from_slice(&mem.read(addr, len)?);
    if opts.advance_after_each_run {
        let after_first = (rb.rd_off + len as u32) % rb.size;
        write_u32(mem, rd_off_addr, after_first, endian)?;
    }

    if let Some((addr, len)) = plan.second {
        // A failure here leaves the tail already taken. `RdOff` is only advanced for what was
        // read, so the head is read again next time -- nothing is lost and nothing is duplicated,
        // which is the property the split exists to preserve.
        match mem.read(addr, len) {
            Ok(bytes) => out.extend_from_slice(&bytes),
            Err(e) => {
                if !opts.advance_after_each_run {
                    write_u32(mem, rd_off_addr, (rb.rd_off + plan.first.1 as u32) % rb.size, endian)?;
                }
                return Err(RttError::Memory(e));
            }
        }
    }

    write_u32(mem, rd_off_addr, plan.new_rd_off, endian)?;
    Ok(Some(out))
}

/// Space a down channel has for host-to-target data.
pub fn down_channel_space(rb: &RingBuffer) -> usize {
    // One byte is always left unused, or a full buffer would be indistinguishable from an empty
    // one: both have WrOff == RdOff. This is SEGGER's own convention, not a margin of ours.
    let used = if rb.wr_off >= rb.rd_off {
        (rb.wr_off - rb.rd_off) as usize
    } else {
        (rb.size - rb.rd_off + rb.wr_off) as usize
    };
    (rb.size as usize - 1).saturating_sub(used)
}

fn read_u32(bytes: &[u8], endian: Endian) -> u32 {
    let word = [bytes[0], bytes[1], bytes[2], bytes[3]];
    match endian {
        Endian::Little => u32::from_le_bytes(word),
        Endian::Big => u32::from_be_bytes(word),
    }
}

fn write_u32(mem: &dyn TargetMemory, addr: u64, value: u32, endian: Endian) -> Result<(), RttError> {
    let bytes = match endian {
        Endian::Little => value.to_le_bytes(),
        Endian::Big => value.to_be_bytes(),
    };
    mem.write(addr, &bytes)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::common::sync::MutexExt;
    use std::sync::Mutex;

    const CB_ADDR: u64 = 0x2000_0000;
    const BUF_ADDR: u64 = 0x2000_1000;
    const BUF_SIZE: u32 = 64;

    /// A target that is a byte array, so the ring-buffer arithmetic is checked against memory that
    /// behaves exactly like the real thing and nothing else.
    struct FakeTarget {
        base: u64,
        mem: Mutex<Vec<u8>>,
        /// Every read, so a test can assert how many round trips a drain cost.
        reads: Mutex<Vec<(u64, usize)>>,
        writes: Mutex<Vec<(u64, Vec<u8>)>>,
        fail_reads_at: Mutex<Option<u64>>,
    }

    impl FakeTarget {
        fn new() -> Self {
            Self {
                base: CB_ADDR,
                mem: Mutex::new(vec![0u8; 0x4000]),
                reads: Mutex::new(Vec::new()),
                writes: Mutex::new(Vec::new()),
                fail_reads_at: Mutex::new(None),
            }
        }

        fn put(&self, addr: u64, bytes: &[u8]) {
            let off = (addr - self.base) as usize;
            self.mem.lock_recover()[off..off + bytes.len()].copy_from_slice(bytes);
        }

        fn put_u32(&self, addr: u64, value: u32) {
            self.put(addr, &value.to_le_bytes());
        }

        /// A control block with one up and one down channel, and a 64-byte up buffer.
        fn with_control_block(self, id: &str, up: u32, down: u32) -> Self {
            let mut id_field = [0u8; ID_LEN];
            let bytes = id.as_bytes();
            id_field[..bytes.len()].copy_from_slice(bytes);
            self.put(CB_ADDR, &id_field);
            self.put_u32(CB_ADDR + 16, up);
            self.put_u32(CB_ADDR + 20, down);
            self
        }

        /// Fill up channel 0's descriptor and its buffer contents.
        fn with_up_channel(self, wr_off: u32, rd_off: u32, contents: &[u8]) -> Self {
            let desc = CB_ADDR + CB_HEADER_LEN as u64;
            self.put_u32(desc, 0xdead_beef); // sName, never followed
            self.put_u32(desc + 4, BUF_ADDR as u32);
            self.put_u32(desc + 8, BUF_SIZE);
            self.put_u32(desc + 12, wr_off);
            self.put_u32(desc + 16, rd_off);
            self.put(BUF_ADDR, contents);
            self
        }

        fn read_count(&self) -> usize {
            self.reads.lock_recover().len()
        }

        fn write_count(&self) -> usize {
            self.writes.lock_recover().len()
        }

        fn last_write(&self) -> (u64, Vec<u8>) {
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
        fn write(&self, addr: u64, data: &[u8]) -> Result<(), RspError> {
            self.writes.lock_recover().push((addr, data.to_vec()));
            self.put(addr, data);
            Ok(())
        }
    }

    fn rb(wr_off: u32, rd_off: u32) -> RingBuffer {
        RingBuffer {
            buf_addr: BUF_ADDR,
            size: BUF_SIZE,
            wr_off,
            rd_off,
        }
    }

    // ── The control block ─────────────────────────────────────────────────────

    #[test]
    fn an_uninitialised_control_block_is_not_ready_rather_than_broken() {
        // The firmware writes `acID` last, so this is the normal state for however long it takes
        // the target to reach `SEGGER_RTT_Init`. Reporting it as an error would fill the console
        // during every session that starts before the firmware does.
        let t = FakeTarget::new();
        assert_eq!(
            find_control_block(&t, CB_ADDR, "SEGGER RTT", Endian::Little),
            Err(RttError::NotReady)
        );
    }

    #[test]
    fn the_header_is_read_in_one_operation() {
        // The id and both channel counts are 24 contiguous bytes. Reading them separately costs an
        // extra round trip on every poll until RTT starts, and round trips are the whole budget.
        let t = FakeTarget::new().with_control_block("SEGGER RTT", 3, 3);
        let cb = find_control_block(&t, CB_ADDR, "SEGGER RTT", Endian::Little).unwrap();
        assert_eq!(cb.up_channels, 3);
        assert_eq!(cb.down_channels, 3);
        assert_eq!(t.read_count(), 1, "one read for id + both counts");
    }

    #[test]
    fn a_nul_padded_id_matches_the_search_string() {
        let t = FakeTarget::new().with_control_block("SEGGER RTT", 1, 1);
        assert!(find_control_block(&t, CB_ADDR, "SEGGER RTT", Endian::Little).is_ok());
    }

    #[test]
    fn an_impossible_channel_count_is_an_error_not_a_retry() {
        // The id matched, so this is not a timing problem: either the block is corrupt or it is a
        // layout we do not understand. Retrying for ever would hide both.
        let t = FakeTarget::new().with_control_block("SEGGER RTT", 99, 1);
        match find_control_block(&t, CB_ADDR, "SEGGER RTT", Endian::Little) {
            Err(RttError::Invalid(_)) => {}
            other => panic!("expected Invalid, got {other:?}"),
        }
    }

    #[test]
    fn descriptor_addresses_follow_seggers_layout() {
        let cb = ControlBlock {
            addr: CB_ADDR,
            up_channels: 3,
            down_channels: 3,
        };
        assert_eq!(cb.up_desc_addr(0), CB_ADDR + 24);
        assert_eq!(cb.up_desc_addr(2), CB_ADDR + 24 + 48);
        // Down descriptors follow *all* the up ones, however many are in use.
        assert_eq!(cb.down_desc_addr(0), CB_ADDR + 24 + 72);
        assert_eq!(cb.down_desc_addr(1), CB_ADDR + 24 + 96);
    }

    // ── Ring-buffer arithmetic ────────────────────────────────────────────────

    #[test]
    fn an_empty_buffer_needs_no_reads() {
        assert_eq!(plan_drain(&rb(10, 10), None).unwrap(), None);
    }

    #[test]
    fn a_linear_buffer_is_one_run() {
        let plan = plan_drain(&rb(30, 10), None).unwrap().unwrap();
        assert_eq!(plan.first, (BUF_ADDR + 10, 20));
        assert_eq!(plan.second, None);
        assert_eq!(plan.new_rd_off, 30);
    }

    #[test]
    fn a_wrapped_buffer_is_two_runs_tail_first() {
        // [---Wr....Rd----]: 14 bytes to the end of the buffer, then 10 from the start.
        let plan = plan_drain(&rb(10, 50), None).unwrap().unwrap();
        assert_eq!(plan.first, (BUF_ADDR + 50, 14));
        assert_eq!(plan.second, Some((BUF_ADDR, 10)));
        assert_eq!(plan.len(), 24);
        assert_eq!(plan.new_rd_off, 10);
    }

    #[test]
    fn a_cap_inside_the_tail_produces_one_run() {
        let plan = plan_drain(&rb(10, 50), Some(8)).unwrap().unwrap();
        assert_eq!(plan.first, (BUF_ADDR + 50, 8));
        assert_eq!(plan.second, None);
        assert_eq!(plan.new_rd_off, 58);
    }

    #[test]
    fn a_cap_landing_exactly_on_the_end_wraps_to_zero() {
        // The case that would otherwise set RdOff == size, which is out of range and would fail
        // validation on the very next read -- a session-ending bug from an off-by-one.
        let plan = plan_drain(&rb(10, 50), Some(14)).unwrap().unwrap();
        assert_eq!(plan.first, (BUF_ADDR + 50, 14));
        assert_eq!(plan.second, None);
        assert_eq!(plan.new_rd_off, 0, "offset 0, never 64");
    }

    #[test]
    fn a_cap_beyond_the_tail_splits() {
        let plan = plan_drain(&rb(10, 50), Some(20)).unwrap().unwrap();
        assert_eq!(plan.first, (BUF_ADDR + 50, 14));
        assert_eq!(plan.second, Some((BUF_ADDR, 6)));
        assert_eq!(plan.new_rd_off, 6);
    }

    #[test]
    fn available_counts_the_same_bytes_the_plan_reads() {
        // A drift between these two is how a ring buffer desynchronises, so they are checked
        // against each other across every offset pair rather than at a few chosen points.
        for wr in 0..BUF_SIZE {
            for rd in 0..BUF_SIZE {
                let b = rb(wr, rd);
                let plan = plan_drain(&b, None).unwrap();
                match plan {
                    None => assert_eq!(b.available(), 0, "empty at wr={wr} rd={rd}"),
                    Some(p) => {
                        assert_eq!(p.len(), b.available(), "length disagrees at wr={wr} rd={rd}");
                        assert_eq!(p.new_rd_off, wr, "a full drain must land on WrOff at wr={wr} rd={rd}");
                        assert!(p.new_rd_off < b.size, "RdOff must stay in range at wr={wr} rd={rd}");
                    }
                }
            }
        }
    }

    #[test]
    fn garbage_offsets_are_rejected_before_they_become_a_huge_read() {
        // A descriptor read while the firmware is initialising can return anything, and
        // `wr_off - rd_off` on two garbage words is a read length of up to 4 GB. The TypeScript
        // implementation has no such check.
        let mut b = rb(0xffff_ffff, 0);
        b.size = 1024;
        match plan_drain(&b, None) {
            Err(RttError::Invalid(_)) => {}
            other => panic!("expected Invalid, got {other:?}"),
        }
    }

    #[test]
    fn an_unallocated_buffer_is_not_ready_rather_than_invalid() {
        let mut b = rb(0, 0);
        b.buf_addr = 0;
        assert_eq!(plan_drain(&b, None), Err(RttError::NotReady));
    }

    // ── A whole drain ─────────────────────────────────────────────────────────

    #[test]
    fn a_linear_drain_costs_one_descriptor_read_one_data_read_and_one_write() {
        // Three round trips per cycle is the budget the port is trying to beat; this is what pins
        // it, so a change that adds a fourth shows up here rather than on hardware.
        let t = FakeTarget::new()
            .with_control_block("SEGGER RTT", 1, 1)
            .with_up_channel(5, 0, b"hello");
        let cb = find_control_block(&t, CB_ADDR, "SEGGER RTT", Endian::Little).unwrap();
        let before = (t.read_count(), t.write_count());

        let data = drain_up_channel(&t, &cb, 0, Endian::Little, &DrainOptions::default()).unwrap();
        assert_eq!(data.as_deref(), Some(&b"hello"[..]));
        assert_eq!(t.read_count() - before.0, 2, "descriptor + data");
        assert_eq!(t.write_count() - before.1, 1, "RdOff once");

        // And RdOff landed on WrOff, at the right address: past pBuffer, SizeOfBuffer and WrOff.
        let (addr, bytes) = t.last_write();
        assert_eq!(addr, cb.up_desc_addr(0) + 4 + 12);
        assert_eq!(bytes, 5u32.to_le_bytes().to_vec());
    }

    #[test]
    fn a_wrapped_drain_returns_the_tail_then_the_head_in_order() {
        // The bytes must come back in the order the target wrote them, which for a wrapped buffer
        // means the end of the array precedes the beginning of it.
        let mut contents = vec![0u8; BUF_SIZE as usize];
        contents[60..64].copy_from_slice(b"abcd"); // written first, at the tail
        contents[0..3].copy_from_slice(b"efg"); // then wrapped to the head
        let t = FakeTarget::new()
            .with_control_block("SEGGER RTT", 1, 1)
            .with_up_channel(3, 60, &contents);
        let cb = find_control_block(&t, CB_ADDR, "SEGGER RTT", Endian::Little).unwrap();

        let data = drain_up_channel(&t, &cb, 0, Endian::Little, &DrainOptions::default())
            .unwrap()
            .unwrap();
        assert_eq!(&data, b"abcdefg");
        assert_eq!(t.last_write().1, 3u32.to_le_bytes().to_vec());
    }

    #[test]
    fn a_quiet_channel_costs_one_read_and_no_write() {
        let t = FakeTarget::new()
            .with_control_block("SEGGER RTT", 1, 1)
            .with_up_channel(7, 7, b"");
        let cb = find_control_block(&t, CB_ADDR, "SEGGER RTT", Endian::Little).unwrap();
        let before = (t.read_count(), t.write_count());
        assert_eq!(
            drain_up_channel(&t, &cb, 0, Endian::Little, &DrainOptions::default()).unwrap(),
            None
        );
        assert_eq!(t.read_count() - before.0, 1, "just the descriptor");
        assert_eq!(t.write_count() - before.1, 0, "nothing to release");
    }

    #[test]
    fn advancing_after_each_run_costs_an_extra_write_on_a_wrap() {
        // The trade-off, made visible: one more round trip, in exchange for releasing the tail to
        // the target before the head has been read. Worth it only for firmware that blocks.
        let mut contents = vec![0u8; BUF_SIZE as usize];
        contents[60..64].copy_from_slice(b"abcd");
        contents[0..3].copy_from_slice(b"efg");
        let t = FakeTarget::new()
            .with_control_block("SEGGER RTT", 1, 1)
            .with_up_channel(3, 60, &contents);
        let cb = find_control_block(&t, CB_ADDR, "SEGGER RTT", Endian::Little).unwrap();
        let opts = DrainOptions {
            max_bytes: None,
            advance_after_each_run: true,
        };
        let data = drain_up_channel(&t, &cb, 0, Endian::Little, &opts).unwrap().unwrap();
        assert_eq!(&data, b"abcdefg");
        assert_eq!(t.write_count(), 2, "one per run");
    }

    #[test]
    fn a_failed_second_read_still_releases_what_was_taken() {
        // Nothing lost and nothing duplicated: the tail was read, so RdOff advances past it, and
        // the head is read again on the next cycle. Getting this wrong is what makes a ring buffer
        // silently repeat or skip output for the rest of the session.
        let mut contents = vec![0u8; BUF_SIZE as usize];
        contents[60..64].copy_from_slice(b"abcd");
        contents[0..3].copy_from_slice(b"efg");
        let t = FakeTarget::new()
            .with_control_block("SEGGER RTT", 1, 1)
            .with_up_channel(3, 60, &contents);
        let cb = find_control_block(&t, CB_ADDR, "SEGGER RTT", Endian::Little).unwrap();
        *t.fail_reads_at.lock_recover() = Some(BUF_ADDR); // the head read

        let err = drain_up_channel(&t, &cb, 0, Endian::Little, &DrainOptions::default()).unwrap_err();
        assert!(matches!(err, RttError::Memory(_)));
        // RdOff now points at the start of the buffer: the tail is consumed, the head is not.
        assert_eq!(t.last_write().1, 0u32.to_le_bytes().to_vec());
    }

    #[test]
    fn a_big_endian_target_is_read_correctly() {
        let t = FakeTarget::new();
        let mut id = [0u8; ID_LEN];
        id[..10].copy_from_slice(b"SEGGER RTT");
        t.put(CB_ADDR, &id);
        t.put(CB_ADDR + 16, &2u32.to_be_bytes());
        t.put(CB_ADDR + 20, &1u32.to_be_bytes());
        let cb = find_control_block(&t, CB_ADDR, "SEGGER RTT", Endian::Big).unwrap();
        assert_eq!((cb.up_channels, cb.down_channels), (2, 1));
    }

    #[test]
    fn a_down_channel_always_leaves_one_byte_unused() {
        // SEGGER's convention, not a margin of ours: a completely full buffer would have
        // WrOff == RdOff and be indistinguishable from an empty one.
        assert_eq!(down_channel_space(&rb(0, 0)), BUF_SIZE as usize - 1);
        assert_eq!(down_channel_space(&rb(10, 0)), BUF_SIZE as usize - 11);
        assert_eq!(down_channel_space(&rb(0, 1)), 0);
    }
}
