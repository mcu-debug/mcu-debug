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

//! Bounded, thread-safe ring buffer for serial port received data.
//!
//! One [`RingBuffer`] instance lives per open serial port. The always-on reader
//! thread calls [`RingBuffer::push`] continuously; a client that attaches is sent
//! recent history before live streaming begins ("late-attach catch-up"). See
//! `uart-management.md §6`.
//!
//! Capacity is fixed at [`CAPACITY`] (1 MB). When the buffer is full, new
//! bytes silently overwrite the oldest — "you snooze, you lose."
//!
//! ## Replay by age
//!
//! Capacity alone is the wrong bound for catch-up. A quiet port holds hours of output in
//! 1 MB, and a client that joined an hour later used to be handed all of it. So the ring also
//! records *when* bytes arrived, and [`RingBuffer::snapshot_since`] replays only what arrived
//! after a cutoff. Nothing is discarded early; older bytes are simply left out of the replay.
//!
//! Arrival times are kept per group of pushes, not per byte: a group spans at most
//! [`GROUP_SPAN`]. A group is replayed whole if any of it is recent, so a cutoff is honoured to
//! within that span and always errs towards replaying slightly more — never towards dropping a
//! recent byte.

use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::common::sync::MutexExt;

/// Ring buffer capacity: 1 MB.
pub const CAPACITY: usize = 1024 * 1024;

/// Longest span of arrival times recorded under one group. Coarse on purpose: replay windows
/// are tens of seconds, and a record per push would cost more than the bytes it describes.
pub const GROUP_SPAN: Duration = Duration::from_secs(1);

/// Most arrival-time groups kept. At one per active [`GROUP_SPAN`] that is over an hour of
/// continuous trickle; past it the oldest groups are dropped, and their bytes — older than any
/// sensible window — are no longer replayed by age. Bounds the bookkeeping to a few hundred
/// kilobytes however the port is used.
const MAX_GROUPS: usize = 4096;

/// Arrival times for the run of bytes starting at absolute offset `start` (see
/// [`RingInner::total`]). The run ends where the next group starts.
struct Group {
    start: u64,
    first: Instant,
    /// The latest arrival in this group. Replay is decided on this, not on `first`: a group from
    /// an hour ago followed by silence must not be treated as covering the silence.
    last: Instant,
}

struct RingInner {
    data: Box<[u8]>,
    /// Index of the next byte to write (wraps mod `data.len()`).
    write_pos: usize,
    /// Number of valid (readable) bytes, capped at `data.len()`.
    filled: usize,
    /// Bytes ever pushed. Gives every byte a stable absolute offset, so arrival records stay
    /// valid while the ring wraps: the bytes still held are offsets `total - filled .. total`.
    total: u64,
    /// Arrival-time groups, oldest first, covering every byte still held (until capped).
    groups: VecDeque<Group>,
}

impl RingInner {
    /// Absolute offset of the oldest byte still held.
    fn oldest_held(&self) -> u64 {
        self.total - self.filled as u64
    }

    /// The newest `len` bytes held, oldest first. `len` is clamped to what is held.
    fn tail(&self, len: usize) -> Vec<u8> {
        let cap = self.data.len();
        let len = len.min(self.filled);
        if len == 0 {
            return Vec::new();
        }
        // The first byte to return sits `len` slots behind the write position. When returning
        // everything and the buffer is full, that is the write position itself.
        let start = (self.write_pos + cap - len) % cap;
        let mut out = Vec::with_capacity(len);
        if start + len <= cap {
            out.extend_from_slice(&self.data[start..start + len]);
        } else {
            out.extend_from_slice(&self.data[start..]);
            out.extend_from_slice(&self.data[..len - (cap - start)]);
        }
        out
    }

    /// Record that the bytes from absolute offset `start` arrived at `now`, then forget what can
    /// no longer matter. Called after `total` and `filled` have been updated.
    fn record_arrival(&mut self, start: u64, now: Instant) {
        match self.groups.back_mut() {
            Some(group) if now.saturating_duration_since(group.first) < GROUP_SPAN => group.last = now,
            _ => self.groups.push_back(Group {
                start,
                first: now,
                last: now,
            }),
        }
        // A group whose successor starts at or before the oldest held byte describes only
        // overwritten bytes.
        let oldest_held = self.oldest_held();
        while self.groups.len() >= 2 && self.groups[1].start <= oldest_held {
            self.groups.pop_front();
        }
        while self.groups.len() > MAX_GROUPS {
            self.groups.pop_front();
        }
    }
}

/// Bounded, thread-safe ring buffer. Safe to share across threads via
/// `Arc<RingBuffer>` — every method takes `&self`.
pub struct RingBuffer {
    inner: Mutex<RingInner>,
}

impl RingBuffer {
    /// Create a new, empty ring buffer with [`CAPACITY`] bytes of storage.
    pub fn new() -> Self {
        RingBuffer {
            inner: Mutex::new(RingInner {
                data: vec![0u8; CAPACITY].into_boxed_slice(),
                write_pos: 0,
                filled: 0,
                total: 0,
                groups: VecDeque::new(),
            }),
        }
    }

    /// Append `bytes` to the ring, overwriting the oldest bytes when full, and note when they
    /// arrived.
    ///
    /// If `bytes.len() >= CAPACITY`, only the last `CAPACITY` bytes are kept.
    pub fn push(&self, bytes: &[u8]) {
        self.push_at(bytes, Instant::now());
    }

    /// [`RingBuffer::push`] with an explicit arrival time, so tests can place bytes in time.
    fn push_at(&self, bytes: &[u8], now: Instant) {
        if bytes.is_empty() {
            return;
        }
        let mut g = self.inner.lock_recover();
        let cap = g.data.len();
        let pushed = bytes.len();
        let start = g.total;

        // If the incoming slice is at least as large as the buffer, only the
        // last `cap` bytes fit. Reset to a clean full state and fall through.
        let bytes = if pushed >= cap {
            g.write_pos = 0;
            g.filled = cap;
            &bytes[pushed - cap..]
        } else {
            bytes
        };

        let n = bytes.len(); // after possible truncation
        let wp = g.write_pos;
        let tail = cap - wp; // contiguous space from write_pos to end of backing array
        if n <= tail {
            g.data[wp..wp + n].copy_from_slice(bytes);
        } else {
            g.data[wp..].copy_from_slice(&bytes[..tail]);
            g.data[..n - tail].copy_from_slice(&bytes[tail..]);
        }
        g.write_pos = (wp + n) % cap;
        g.filled = (g.filled + n).min(cap);
        // Advance by everything pushed, truncated or not: offsets are positions in the stream.
        g.total = start + pushed as u64;
        g.record_arrival(start, now);
    }

    /// Return a snapshot of all valid bytes in FIFO order (oldest first).
    ///
    /// The returned `Vec` is a copy; callers may hold it indefinitely without
    /// blocking subsequent `push` calls.
    pub fn snapshot(&self) -> Vec<u8> {
        let g = self.inner.lock_recover();
        g.tail(g.filled)
    }

    /// Bytes that arrived at or after `cutoff`, oldest first.
    ///
    /// A group of pushes is replayed whole if any of it arrived at or after `cutoff`, so up to
    /// [`GROUP_SPAN`] of earlier bytes can come along with it. Bytes older than every retained
    /// group are never replayed (see [`MAX_GROUPS`]).
    pub fn snapshot_since(&self, cutoff: Instant) -> Vec<u8> {
        let g = self.inner.lock_recover();
        // Groups are in arrival order, so the first recent one starts the replay and every
        // later one is recent too.
        let Some(first_recent) = g.groups.iter().find(|group| group.last >= cutoff) else {
            return Vec::new();
        };
        let from = first_recent.start.max(g.oldest_held());
        g.tail((g.total - from) as usize)
    }

    /// Bytes that arrived within the last `window`, oldest first. A zero window replays nothing;
    /// a window reaching back further than the clock can express replays everything held.
    pub fn snapshot_recent(&self, window: Duration) -> Vec<u8> {
        if window.is_zero() {
            return Vec::new();
        }
        match Instant::now().checked_sub(window) {
            Some(cutoff) => self.snapshot_since(cutoff),
            None => self.snapshot(),
        }
    }

    /// Number of valid bytes currently in the ring (0..=`CAPACITY`).
    pub fn len(&self) -> usize {
        self.inner.lock_recover().filled
    }

    pub fn is_empty(&self) -> bool {
        self.inner.lock_recover().filled == 0
    }

    #[cfg(test)]
    fn group_count(&self) -> usize {
        self.inner.lock_recover().groups.len()
    }
}

impl Default for RingBuffer {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::thread;

    #[test]
    fn empty_snapshot() {
        let rb = RingBuffer::new();
        assert!(rb.is_empty());
        assert_eq!(rb.len(), 0);
        assert_eq!(rb.snapshot(), Vec::<u8>::new());
    }

    #[test]
    fn simple_push_snapshot() {
        let rb = RingBuffer::new();
        rb.push(b"hello");
        assert_eq!(rb.len(), 5);
        assert_eq!(rb.snapshot(), b"hello");
    }

    #[test]
    fn multiple_pushes_fifo_order() {
        let rb = RingBuffer::new();
        rb.push(b"abc");
        rb.push(b"def");
        assert_eq!(rb.snapshot(), b"abcdef");
        assert_eq!(rb.len(), 6);
    }

    #[test]
    fn fill_exactly() {
        let rb = RingBuffer::new();
        let data = vec![0x55u8; CAPACITY];
        rb.push(&data);
        assert_eq!(rb.len(), CAPACITY);
        let snap = rb.snapshot();
        assert_eq!(snap.len(), CAPACITY);
        assert!(snap.iter().all(|&b| b == 0x55));
    }

    /// Push more than CAPACITY — oldest bytes are overwritten.
    #[test]
    fn wrap_overwrites_oldest() {
        let rb = RingBuffer::new();
        // Fill the buffer completely with 0xAA.
        rb.push(&vec![0xAAu8; CAPACITY]);
        assert_eq!(rb.len(), CAPACITY);

        // Push 4 more bytes — overwrites the 4 oldest 0xAA bytes.
        rb.push(b"TAIL");
        let snap = rb.snapshot();
        assert_eq!(snap.len(), CAPACITY);
        // Last 4 bytes must be the newly pushed data.
        assert_eq!(&snap[CAPACITY - 4..], b"TAIL");
        // Remaining bytes are still 0xAA.
        assert!(snap[..CAPACITY - 4].iter().all(|&b| b == 0xAA));
    }

    /// Push a slice larger than CAPACITY — only the last CAPACITY bytes survive.
    #[test]
    fn push_larger_than_capacity() {
        let rb = RingBuffer::new();
        let oversized = vec![0xBBu8; CAPACITY + 100];
        rb.push(&oversized);
        assert_eq!(rb.len(), CAPACITY);
        // All bytes must be 0xBB (the tail of the oversized slice).
        assert!(rb.snapshot().iter().all(|&b| b == 0xBB));
    }

    /// Snapshot correctness after a write that wraps around the backing array.
    #[test]
    fn snapshot_correctness_after_wrap() {
        let rb = RingBuffer::new();
        // Push CAPACITY - 3 bytes of 0xFF.
        rb.push(&vec![0xFFu8; CAPACITY - 3]);
        // Push 6 bytes: 3 go to the end of the array, 3 wrap to the front.
        rb.push(b"ABCDEF");

        let snap = rb.snapshot();
        assert_eq!(snap.len(), CAPACITY);
        // Last 6 bytes are the new data, in order.
        assert_eq!(&snap[CAPACITY - 6..], b"ABCDEF");
        // The 3 bytes immediately before them are 0xFF (survived the overwrite).
        assert_eq!(&snap[CAPACITY - 9..CAPACITY - 6], &[0xFF, 0xFF, 0xFF]);
        // Everything before that is also 0xFF.
        assert!(snap[..CAPACITY - 9].iter().all(|&b| b == 0xFF));
    }

    /// No panics or data corruption under concurrent push and snapshot.
    #[test]
    fn concurrent_push_snapshot() {
        let rb = Arc::new(RingBuffer::new());
        let rb_writer = Arc::clone(&rb);

        // Writer pushes 512 × 4096 = 2 MB of 0x42 bytes.
        let writer = thread::spawn(move || {
            let chunk = vec![0x42u8; 4096];
            for _ in 0..512 {
                rb_writer.push(&chunk);
            }
        });

        // Meanwhile, take snapshots and verify structural invariants.
        for _ in 0..20 {
            let snap = rb.snapshot();
            assert!(snap.len() <= CAPACITY, "snapshot exceeded CAPACITY");
            // Every byte must be 0x42 — no other value was ever pushed.
            for &b in &snap {
                assert_eq!(b, 0x42, "snapshot contained unexpected byte");
            }
        }

        writer.join().unwrap();

        // After the writer finishes, the buffer must be full and all 0x42.
        assert_eq!(rb.len(), CAPACITY);
        assert!(rb.snapshot().iter().all(|&b| b == 0x42));
    }

    // ── Replay by age ─────────────────────────────────────────────────────────

    fn at(base: Instant, secs: u64) -> Instant {
        base + Duration::from_secs(secs)
    }

    /// The complaint that motivated this: a client joining an hour later was handed everything
    /// since the port opened. Only recent output is replayed — and nothing was discarded.
    #[test]
    fn replay_leaves_out_output_older_than_the_cutoff() {
        let rb = RingBuffer::new();
        let t0 = Instant::now();
        rb.push_at(b"an hour ago\n", t0);
        rb.push_at(b"just now\n", at(t0, 3600));
        assert_eq!(rb.snapshot_since(at(t0, 3600 - 60)), b"just now\n");
        assert_eq!(
            rb.snapshot(),
            b"an hour ago\njust now\n",
            "older output is left out, not lost"
        );
    }

    /// A group is judged by its latest arrival. Old output followed by a long silence must not be
    /// read as covering the silence and dragged back into a recent replay.
    #[test]
    fn a_silence_after_old_output_does_not_pull_it_back_in() {
        let rb = RingBuffer::new();
        let t0 = Instant::now();
        rb.push_at(b"boot ", t0);
        rb.push_at(b"banner\n", t0 + Duration::from_millis(500)); // same group as "boot "
        rb.push_at(b"heartbeat\n", at(t0, 7200));
        assert_eq!(rb.snapshot_since(at(t0, 7200 - 10)), b"heartbeat\n");
    }

    /// A group with any recent byte is replayed whole: the cutoff errs towards more, never less.
    #[test]
    fn a_group_straddling_the_cutoff_is_replayed_whole() {
        let rb = RingBuffer::new();
        let t0 = Instant::now();
        rb.push_at(b"early ", t0);
        rb.push_at(b"late\n", t0 + Duration::from_millis(800)); // within GROUP_SPAN of "early "
        assert_eq!(rb.snapshot_since(t0 + Duration::from_millis(500)), b"early late\n");
    }

    #[test]
    fn a_window_longer_than_the_history_replays_everything() {
        let rb = RingBuffer::new();
        rb.push(b"abc");
        rb.push(b"def");
        assert_eq!(rb.snapshot_recent(Duration::from_secs(3600)), b"abcdef");
    }

    #[test]
    fn a_zero_window_replays_nothing() {
        let rb = RingBuffer::new();
        rb.push(b"abc");
        assert!(rb.snapshot_recent(Duration::ZERO).is_empty());
    }

    /// After a wrap, replay never reaches past what the ring still holds, and returns the right bytes.
    #[test]
    fn replay_is_clamped_to_what_the_ring_still_holds() {
        let rb = RingBuffer::new();
        let t0 = Instant::now();
        rb.push_at(&vec![0xAAu8; CAPACITY - 2], t0);
        rb.push_at(b"WXYZ", t0 + Duration::from_millis(100)); // same group; wraps over two 0xAA bytes
        let replay = rb.snapshot_since(t0);
        assert_eq!(replay.len(), CAPACITY);
        assert_eq!(&replay[CAPACITY - 4..], b"WXYZ");
        assert!(replay[..CAPACITY - 4].iter().all(|&b| b == 0xAA));
    }

    /// Records for overwritten bytes are forgotten, so they track what the ring holds rather than
    /// growing with every push.
    #[test]
    fn records_are_forgotten_once_their_bytes_are_overwritten() {
        let rb = RingBuffer::new();
        let t0 = Instant::now();
        // Three groups, each half the ring: the first one's bytes are entirely overwritten.
        for i in 0..3u64 {
            rb.push_at(&vec![i as u8; CAPACITY / 2], at(t0, 2 * i));
        }
        assert_eq!(rb.group_count(), 2, "the fully overwritten group is dropped");
        let replay = rb.snapshot_since(at(t0, 3));
        assert_eq!(replay.len(), CAPACITY / 2);
        assert!(replay.iter().all(|&b| b == 2), "only the newest group is recent");
    }

    /// Bookkeeping is bounded however the port is used, and the newest records are the ones kept.
    #[test]
    fn the_number_of_records_is_capped() {
        let rb = RingBuffer::new();
        let t0 = Instant::now();
        let pushes = MAX_GROUPS as u64 + 100;
        for i in 0..pushes {
            rb.push_at(b"x", at(t0, 2 * i)); // two seconds apart: a new group every time
        }
        assert_eq!(rb.group_count(), MAX_GROUPS);
        assert_eq!(rb.snapshot_since(at(t0, 2 * (pushes - 1))), b"x");
    }
}
