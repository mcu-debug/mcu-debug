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

//! Use-bounded proxy lifetime (Tier 1, Phase B).
//!
//! The singleton proxy stays alive as long as something needs it. Each "reason
//! to stay alive" is a **ref**, held as an RAII [`Ref`] guard:
//!
//! - one per live client **session** (dropped when the session's thread ends);
//! - one **window keep-alive** while `--heartbeat` pings arrive (dropped when
//!   the launching window closes).
//!
//! When refs reach zero, an idle timer starts. If nothing re-acquires before it
//! fires, the proxy shuts down — so it outlives any single window (a CLI session
//! keeps it up) yet never lingers idle forever. See
//! `docs-internal/Singleton-Tier1-Plan.md` §4.

use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use crate::common::sync::MutexExt;

/// Shared ref counter with an idle-wait. Create with [`Lifetime::new`], hand out
/// [`Ref`]s with [`Lifetime::acquire`], and run [`Lifetime::wait_until_idle`] on
/// a dedicated thread to learn when it's time to shut down.
pub struct Lifetime {
    refs: Mutex<usize>,
    changed: Condvar,
}

impl Lifetime {
    pub fn new() -> Arc<Lifetime> {
        Arc::new(Lifetime {
            refs: Mutex::new(0),
            changed: Condvar::new(),
        })
    }

    /// Acquire a ref. The proxy will not idle-exit until the returned guard drops.
    pub fn acquire(self: &Arc<Self>) -> Ref {
        *self.refs.lock_recover() += 1;
        self.changed.notify_all();
        Ref {
            lifetime: Arc::clone(self),
        }
    }

    fn release(&self) {
        {
            let mut n = self.refs.lock_recover();
            *n = n.saturating_sub(1);
        }
        self.changed.notify_all();
    }

    /// Current number of held refs (active sessions + window keep-alive).
    pub fn count(&self) -> usize {
        *self.refs.lock_recover()
    }

    /// Block until refs have been at zero for the full `idle` window, then
    /// return (meaning: time to shut down). Any acquire during the window
    /// re-arms the timer. A zero `idle` still waits for refs to *reach* zero
    /// first — so `wait_until_idle(Duration::ZERO)` means "return as soon as the
    /// last ref drops", which is exactly what graceful drain wants.
    pub fn wait_until_idle(&self, idle: Duration) {
        let mut n = self.refs.lock_recover();
        loop {
            // Wait for the count to reach zero.
            while *n > 0 {
                n = self
                    .changed
                    .wait(n)
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
            }
            // Zero: wait out the idle window. A notify (new ref, or a 0→…→0
            // churn) wakes us early; only a full timeout with refs still zero
            // means shut down.
            let (guard, timeout) = self
                .changed
                .wait_timeout(n, idle)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            n = guard;
            if *n == 0 && timeout.timed_out() {
                return;
            }
        }
    }
}

/// A reason the proxy should stay alive. Drop it to release the reason.
pub struct Ref {
    lifetime: Arc<Lifetime>,
}

impl Drop for Ref {
    fn drop(&mut self) {
        self.lifetime.release();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn idle_fires_when_no_refs_are_held() {
        let lt = Lifetime::new();
        let start = Instant::now();
        lt.wait_until_idle(Duration::from_millis(150));
        assert!(
            start.elapsed() >= Duration::from_millis(140),
            "should have waited out the idle window"
        );
    }

    #[test]
    fn a_held_ref_delays_idle_until_it_drops() {
        let lt = Lifetime::new();
        let held = lt.acquire();

        // Drop the ref after 200 ms from another thread.
        let dropper = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(200));
            drop(held);
        });

        let start = Instant::now();
        lt.wait_until_idle(Duration::from_millis(100));
        // Idle window (100 ms) only starts after the ref drops at ~200 ms, so
        // we must not return before ~300 ms.
        assert!(
            start.elapsed() >= Duration::from_millis(280),
            "idle timer must not start while a ref is held (elapsed {:?})",
            start.elapsed()
        );
        dropper.join().unwrap();
    }

    #[test]
    fn re_acquiring_during_the_window_re_arms_the_timer() {
        let lt = Lifetime::new();
        let lt2 = Arc::clone(&lt);

        // At ~80 ms (inside the first 150 ms idle window) briefly acquire+drop a
        // ref, which should re-arm the full window.
        let bumper = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(80));
            let r = lt2.acquire();
            drop(r);
        });

        let start = Instant::now();
        lt.wait_until_idle(Duration::from_millis(150));
        // First window would have fired at ~150 ms; the bump at 80 ms re-arms it
        // to ~80 + 150 = ~230 ms.
        assert!(
            start.elapsed() >= Duration::from_millis(210),
            "activity should re-arm the idle window (elapsed {:?})",
            start.elapsed()
        );
        bumper.join().unwrap();
    }
}
