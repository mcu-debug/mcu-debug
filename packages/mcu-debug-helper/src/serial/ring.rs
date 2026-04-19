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
//! thread calls [`RingBuffer::push`] continuously; TCP clients call
//! [`RingBuffer::snapshot`] on connect to receive buffered history before live
//! streaming begins ("late-attach catch-up"). See `uart-management.md §6`.
//!
//! Capacity is fixed at [`CAPACITY`] (1 MB). When the buffer is full, new
//! bytes silently overwrite the oldest — "you snooze, you lose."

use std::sync::Mutex;

/// Ring buffer capacity: 1 MB.
pub const CAPACITY: usize = 1024 * 1024;

struct RingInner {
    data: Box<[u8]>,
    /// Index of the next byte to write (wraps mod `data.len()`).
    write_pos: usize,
    /// Number of valid (readable) bytes, capped at `data.len()`.
    filled: usize,
}

/// Bounded, thread-safe ring buffer. Safe to share across threads via
/// `Arc<RingBuffer>` — both `push` and `snapshot` take `&self`.
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
            }),
        }
    }

    /// Append `bytes` to the ring, overwriting the oldest bytes when full.
    ///
    /// If `bytes.len() >= CAPACITY`, only the last `CAPACITY` bytes are kept.
    pub fn push(&self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        let mut g = self.inner.lock().unwrap();
        let cap = g.data.len();
        let n = bytes.len();

        // If the incoming slice is at least as large as the buffer, only the
        // last `cap` bytes fit. Reset to a clean full state and fall through.
        let bytes = if n >= cap {
            g.write_pos = 0;
            g.filled = cap;
            &bytes[n - cap..]
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
    }

    /// Return a snapshot of all valid bytes in FIFO order (oldest first).
    ///
    /// The returned `Vec` is a copy; callers may hold it indefinitely without
    /// blocking subsequent `push` calls.
    pub fn snapshot(&self) -> Vec<u8> {
        let g = self.inner.lock().unwrap();
        let cap = g.data.len();
        let filled = g.filled;
        if filled == 0 {
            return Vec::new();
        }
        // The oldest byte lives at:
        //   (write_pos + cap - filled) % cap
        // When the buffer is not yet full: write_pos == filled, so start == 0.
        // When the buffer is full: start == write_pos (the next slot to overwrite).
        let start = (g.write_pos + cap - filled) % cap;
        let mut out = Vec::with_capacity(filled);
        if start + filled <= cap {
            out.extend_from_slice(&g.data[start..start + filled]);
        } else {
            out.extend_from_slice(&g.data[start..]);
            out.extend_from_slice(&g.data[..filled - (cap - start)]);
        }
        out
    }

    /// Number of valid bytes currently in the ring (0..=`CAPACITY`).
    pub fn len(&self) -> usize {
        self.inner.lock().unwrap().filled
    }

    pub fn is_empty(&self) -> bool {
        self.inner.lock().unwrap().filled == 0
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
}
