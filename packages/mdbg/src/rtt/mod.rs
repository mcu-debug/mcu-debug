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

pub mod engine;
#[cfg(test)]
pub mod fake;

pub use engine::{RttConfig, RttEngine, RttSink, RttStats};

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
            // `{e}`, not `{e:?}`. `RspError` has a Display that names the fault -- "gdb-server
            // returned error E01" -- and the Debug form replaced it with `Target(Some(1))`. That is
            // the text a field failure was reported as, and it reached the user via a log line that
            // was the only record of why RTT had stopped.
            RttError::Memory(e) => write!(f, "target memory access failed: {e}"),
            RttError::Invalid(why) => write!(f, "invalid RTT control block: {why}"),
        }
    }
}

/// Target memory, as RTT needs it.
///
/// A trait rather than a concrete [`Consumer`] so that the ring-buffer logic can be tested against
/// a plain byte array. Both implementations are blocking; callers are expected to be on their own
/// thread.
pub trait TargetMemory: Send + Sync {
    fn read(&self, addr: u64, len: usize) -> Result<Vec<u8>, RspError>;
    fn write(&self, addr: u64, data: &[u8]) -> Result<(), RspError>;

    /// Would a request go out now, or wait? The engine polls this before spending one, so a shut
    /// gate costs a lock rather than a timeout. Default `true` for a memory that has no gate.
    fn ready(&self) -> bool {
        true
    }
}

impl TargetMemory for Consumer {
    fn read(&self, addr: u64, len: usize) -> Result<Vec<u8>, RspError> {
        self.read_memory(addr, len)
    }
    fn write(&self, addr: u64, data: &[u8]) -> Result<(), RspError> {
        self.write_memory(addr, data)
    }
    fn ready(&self) -> bool {
        Consumer::ready(self)
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

/// What a single fill of a down channel should write, and what `WrOff` becomes afterwards.
///
/// The mirror of [`DrainPlan`], and the roles of the two offsets swap with it: on a down channel
/// **we** write `WrOff` and the target writes `RdOff`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FillPlan {
    pub first: Run,
    /// Present only when the free space wraps past the end of the buffer.
    pub second: Option<Run>,
    /// `WrOff` once everything in this plan has been written. Only write it **after** the data, or
    /// the target may consume bytes that are not there yet.
    pub new_wr_off: u32,
    /// How many of the caller's bytes this plan places. May be fewer than offered.
    pub consumed: usize,
}

/// Plan writing up to `len` bytes into a down channel.
///
/// `Ok(None)` when the buffer is full, which is ordinary when the firmware is not reading its input
/// channel — so it must not be an error.
pub fn plan_fill(rb: &RingBuffer, len: usize) -> Result<Option<FillPlan>, RttError> {
    rb.validate()?;
    let space = down_channel_space(rb);
    let n = space.min(len);
    if n == 0 {
        return Ok(None);
    }
    let to_end = (rb.size - rb.wr_off) as usize;
    let new_wr_off = ((rb.wr_off as usize + n) % rb.size as usize) as u32;
    if n <= to_end {
        Ok(Some(FillPlan {
            first: (rb.buf_addr + rb.wr_off as u64, n),
            second: None,
            new_wr_off,
            consumed: n,
        }))
    } else {
        Ok(Some(FillPlan {
            first: (rb.buf_addr + rb.wr_off as u64, to_end),
            second: Some((rb.buf_addr, n - to_end)),
            new_wr_off,
            consumed: n,
        }))
    }
}

/// Write as much of `data` as fits into a down channel, returning how much went.
///
/// Partial by design: the caller keeps the remainder and offers it again next cycle. Looping here
/// until everything fits would block this thread on firmware that is not reading its input.
pub fn fill_down_channel(
    mem: &dyn TargetMemory,
    cb: &ControlBlock,
    channel: u32,
    data: &[u8],
    endian: Endian,
) -> Result<usize, RttError> {
    if data.is_empty() {
        return Ok(0);
    }
    // **A channel the firmware did not allocate has no descriptor, and the arithmetic does not
    // know that.** `down_desc_addr` is `cb + 24 + (up_channels + channel) * 24`, which for a
    // firmware reporting 0 down channels lands immediately after the up descriptors -- and that is
    // where `pBuffer` points. So the read returns *ring buffer contents*, which are then read as
    // `SizeOfBuffer`/`WrOff`/`RdOff`.
    //
    // Found on hardware, and it looked like anything but this: a handful of unusable control blocks
    // per session, with byte-identical garbage across runs because the ring held a deterministic
    // counter pattern. `WrOff = 0x7F790103` turned out to be the firmware's own `03 01 NN 7f`.
    // "1 up and 0 down channels" is the ordinary case -- `defmt-rtt` reports exactly that -- so this
    // is not an edge.
    //
    // `NotReady` rather than an error: the firmware may allocate it later, and a caller offering
    // input for a channel that does not exist is not a failure, just nowhere to put it.
    if channel >= cb.down_channels {
        return Err(RttError::NotReady);
    }
    let desc_addr = cb.down_desc_addr(channel);
    let rb = read_descriptor(mem, desc_addr, endian)?;
    let Some(plan) = plan_fill(&rb, data.len())? else {
        return Ok(0);
    };

    let (addr, len) = plan.first;
    mem.write(addr, &data[..len])?;
    if let Some((addr2, len2)) = plan.second {
        mem.write(addr2, &data[len..len + len2])?;
    }
    // `WrOff` last: it is what makes the bytes visible to the target.
    let wr_off_addr = desc_addr + DESC_SKIP + 8; // past pBuffer and SizeOfBuffer
    write_u32(mem, wr_off_addr, plan.new_wr_off, endian)?;
    Ok(plan.consumed)
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

/// Default cap on one drain, chosen to stay clear of gdb-server reply-buffer boundaries.
///
/// A hex `m` reply is `$` + 2n + `#` + 2 = **2n + 4** bytes on the wire, so a read of n bytes lands
/// on 1024 exactly when n = 510. The ST-LINK gdb-server truncates a reply of exactly 1024 bytes,
/// losing its last checksum digit to a NUL terminator, and 510-byte reads therefore fail every time
/// on it. OpenOCD had a 512-byte memory-request bug of the same family, fixed upstream. The pattern
/// generalises: the sizes to fear are those where `2n + 4` is a power of two -- n = 510, 1022, 2046.
///
/// 500 is below the smallest of them with room to spare, and costs little: RTT drains average a few
/// hundred bytes, so most are unaffected, and a larger one becomes two reads rather than one.
///
/// This is a floor of caution, not a limit anyone is stuck with -- `rttConfig` can raise it per
/// session, and [`crate::gdb_rsp::RspError::ReplyRejected`] retries a rejected read at half the size
/// regardless, which is what covers a server whose boundary is somewhere else.
pub const SAFE_DRAIN_BYTES: usize = 500;

impl Default for DrainOptions {
    fn default() -> Self {
        Self {
            max_bytes: Some(SAFE_DRAIN_BYTES),
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
    // As in `fill_down_channel`: a channel beyond what the control block declares has no descriptor,
    // and the address arithmetic would read whatever follows the array -- for the last up channel,
    // the ring buffer itself.
    if channel >= cb.up_channels {
        return Err(RttError::NotReady);
    }
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
    use super::fake::{FakeTarget, BUF_ADDR, BUF_SIZE, CB_ADDR};
    use super::*;
    use crate::common::sync::MutexExt;

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
    fn the_default_cap_avoids_every_power_of_two_reply_size() {
        // A hex `m` reply is 2n + 4 bytes. The sizes that bite are the ones where that is a power of
        // two, because a server whose reply buffer is that size has no room for its NUL terminator.
        for bits in 10..=14 {
            let poison = ((1usize << bits) - 4) / 2;
            assert!(
                SAFE_DRAIN_BYTES < poison,
                "a drain of {SAFE_DRAIN_BYTES} must stay below the {poison}-byte read whose reply is exactly {} bytes",
                1usize << bits
            );
        }
        // And the smallest of them is the one actually observed on hardware.
        assert_eq!((1024 - 4) / 2, 510);
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

    // ── Filling a down channel ────────────────────────────────────────────────

    #[test]
    fn a_fill_into_an_empty_buffer_is_one_run_leaving_one_byte_spare() {
        let plan = plan_fill(&rb(0, 0), 1000).unwrap().unwrap();
        assert_eq!(plan.first, (BUF_ADDR, BUF_SIZE as usize - 1));
        assert_eq!(plan.second, None);
        assert_eq!(plan.consumed, BUF_SIZE as usize - 1);
        assert_eq!(plan.new_wr_off, BUF_SIZE - 1);
    }

    #[test]
    fn a_fill_that_runs_off_the_end_wraps_to_the_start() {
        // The branch the engine tests do not reach, because a first write starts at offset 0.
        // WrOff 60 with RdOff 10 leaves 4 bytes to the end and 9 more at the front.
        let plan = plan_fill(&rb(60, 10), 100).unwrap().unwrap();
        assert_eq!(plan.first, (BUF_ADDR + 60, 4));
        assert_eq!(plan.second, Some((BUF_ADDR, 9)));
        assert_eq!(plan.consumed, 13);
        assert_eq!(plan.new_wr_off, 9);
    }

    #[test]
    fn a_fill_smaller_than_the_space_takes_only_what_was_offered() {
        let plan = plan_fill(&rb(10, 0), 5).unwrap().unwrap();
        assert_eq!(plan.first, (BUF_ADDR + 10, 5));
        assert_eq!(plan.second, None);
        assert_eq!(plan.consumed, 5);
        assert_eq!(plan.new_wr_off, 15);
    }

    #[test]
    fn a_fill_landing_exactly_on_the_end_sets_wroff_to_zero() {
        // Same off-by-one as the drain side: an offset equal to `size` is out of range.
        let plan = plan_fill(&rb(60, 20), 4).unwrap().unwrap();
        assert_eq!(plan.first, (BUF_ADDR + 60, 4));
        assert_eq!(plan.second, None);
        assert_eq!(plan.new_wr_off, 0, "offset 0, never 64");
    }

    #[test]
    fn a_full_buffer_plans_nothing_rather_than_failing() {
        // Ordinary whenever the firmware is not reading its input channel.
        assert_eq!(plan_fill(&rb(63, 0), 10).unwrap(), None);
        assert_eq!(plan_fill(&rb(0, 1), 10).unwrap(), None);
    }

    #[test]
    fn a_fill_never_lets_wroff_catch_rdoff() {
        // The invariant the whole one-byte reservation exists for: if WrOff ever equals RdOff the
        // target reads the buffer as *empty* and discards everything in it. Checked across every
        // offset pair rather than at chosen points, because one bad pair loses a whole buffer.
        for wr in 0..BUF_SIZE {
            for rd in 0..BUF_SIZE {
                let b = rb(wr, rd);
                if let Some(plan) = plan_fill(&b, 1000).unwrap() {
                    assert_ne!(plan.new_wr_off, rd, "WrOff caught RdOff at wr={wr} rd={rd}");
                    assert!(plan.new_wr_off < b.size, "WrOff out of range at wr={wr} rd={rd}");
                    assert_eq!(
                        plan.consumed,
                        down_channel_space(&b),
                        "took the wrong amount at wr={wr} rd={rd}"
                    );
                }
            }
        }
    }

    #[test]
    fn a_wrapped_fill_writes_the_callers_bytes_in_order() {
        let t = FakeTarget::new()
            .with_control_block("SEGGER RTT", 1, 1)
            .with_up_channel(0, 0, b"")
            .with_down_channel(0, 10);
        let cb = find_control_block(&t, CB_ADDR, "SEGGER RTT", Endian::Little).unwrap();
        // Put WrOff near the end so the write has to split.
        let desc = cb.down_desc_addr(0);
        t.put_u32(desc + 4 + 8, 60);

        let n = fill_down_channel(&t, &cb, 0, b"ABCDEFGHI", Endian::Little).unwrap();
        assert_eq!(n, 9);
        assert_eq!(t.bytes_at(super::fake::DOWN_BUF_ADDR + 60, 4), b"ABCD".to_vec());
        assert_eq!(t.bytes_at(super::fake::DOWN_BUF_ADDR, 5), b"EFGHI".to_vec());
        assert_eq!(t.read_u32_at(desc + 4 + 8), 5, "WrOff wrapped to 5");
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
    fn a_channel_the_firmware_never_allocated_is_not_read_at_all() {
        // The bug this exists for, found on hardware and mis-diagnosed three times on the way.
        //
        // `defmt-rtt` reports "1 up and 0 down channels", which is the ordinary case. The client
        // asked for down channel 0 anyway, on the belief that a channel the firmware had not
        // allocated would be skipped. Nothing skipped it: `down_desc_addr(0)` is
        // `cb + 24 + (up_channels + 0) * 24`, which lands immediately past the up descriptors --
        // exactly where `pBuffer` points. So the "descriptor" read returned **ring buffer bytes**,
        // and `WrOff` came back as 0x7F790103, which is the firmware's own `03 01 NN 7f` payload.
        //
        // The tell was that the garbage was byte-identical across runs: a race cannot do that, a
        // deterministic counter in the ring can.
        let t = FakeTarget::new()
            .with_control_block("SEGGER RTT", 1, 0) // one up channel, NO down channels
            .with_up_channel(0, 0, b"");
        let cb = find_control_block(&t, CB_ADDR, "SEGGER RTT", Endian::Little).unwrap();
        assert_eq!(cb.down_channels, 0);
        let before = t.read_count();

        // Offering input for a channel that does not exist is not a failure -- there is simply
        // nowhere to put it, and the firmware may allocate it later.
        assert_eq!(
            fill_down_channel(&t, &cb, 0, b"hello", Endian::Little),
            Err(RttError::NotReady)
        );
        assert_eq!(
            t.read_count(),
            before,
            "it must not read a descriptor that does not exist"
        );

        // And nothing may be written either: `WrOff` for a non-existent channel is somebody's data.
        assert_eq!(t.write_count(), 0);
    }

    #[test]
    fn an_up_channel_beyond_the_control_blocks_count_is_not_read_either() {
        // Same arithmetic, same hazard: the last up channel's descriptor is followed by the ring.
        let t = FakeTarget::new()
            .with_control_block("SEGGER RTT", 1, 1)
            .with_up_channel(0, 0, b"");
        let cb = find_control_block(&t, CB_ADDR, "SEGGER RTT", Endian::Little).unwrap();
        let before = t.read_count();
        assert_eq!(
            drain_up_channel(&t, &cb, 1, Endian::Little, &DrainOptions::default()),
            Err(RttError::NotReady)
        );
        assert_eq!(
            t.read_count(),
            before,
            "channel 1 does not exist; do not go looking for it"
        );
    }

    #[test]
    fn no_read_ever_lands_past_the_descriptor_array() {
        // The property rather than the instance: whatever a caller asks for, every address we read
        // has to be inside the control block, a descriptor, or a channel's own buffer. The original
        // failure was a read at `cb + 0x34` on a block whose descriptors end at `cb + 0x2f`.
        let t = FakeTarget::new()
            .with_control_block("SEGGER RTT", 1, 0)
            .with_up_channel(0, 5, b"hello");
        let cb = find_control_block(&t, CB_ADDR, "SEGGER RTT", Endian::Little).unwrap();
        let _ = drain_up_channel(&t, &cb, 0, Endian::Little, &DrainOptions::default());
        let _ = fill_down_channel(&t, &cb, 0, b"x", Endian::Little);
        let _ = drain_up_channel(&t, &cb, 7, Endian::Little, &DrainOptions::default());

        let descriptors_end =
            CB_ADDR + CB_HEADER_LEN as u64 + (cb.up_channels + cb.down_channels) as u64 * DESC_LEN as u64;
        for (addr, len) in t.reads() {
            let in_control_block = addr >= CB_ADDR && addr + len as u64 <= descriptors_end;
            let in_buffer = addr >= BUF_ADDR && addr + len as u64 <= BUF_ADDR + BUF_SIZE as u64;
            assert!(
                in_control_block || in_buffer,
                "read of {len} bytes at {addr:#x} is neither control block (..{descriptors_end:#x}) nor buffer"
            );
        }
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
