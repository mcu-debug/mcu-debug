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

//! The RTT poll loop, on its own thread.
//!
//! This is the piece the port exists for, and the reason is not that threads are faster. In the
//! TypeScript implementation the poll loop shares one event loop and one GDB command queue with
//! everything else in the debug adapter, so the only lever it has is *how long to sleep*: a
//! `setTimeout` of 1 ms is not waste, it is the mechanism by which the DAP requests, live watch and
//! the MI traffic get a turn. Removing it — running back to back, or with `setImmediate` — hangs the
//! adapter, because an unbounded stream of RTT memory reads starves the shared GDB queue and every
//! user-facing request waits behind it.
//!
//! Here, yielding and rationing are separate concerns. This thread may spin as fast as the
//! round trips allow, because [`crate::gdb_rsp::MuxCore`]'s send gate is what rations the shared
//! connection: at depth 1 only one of our packets is ever in flight, GDB's own frames are never
//! gated at all, and invariant 2 is "GDB never waits on us" (§4.2). [`DrainOptions::max_bytes`] is
//! the second half of it — a bound on how long one channel's drain can hold the connection.
//!
//! What it still must not do is spin on an *idle* channel: a descriptor read is SWD traffic
//! competing with GDB whether or not it returns data. So the loop polls again immediately when the
//! last pass moved bytes, and sleeps otherwise.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::common::sync::MutexExt;
use crate::gdb_rsp::{Endian, RspError};

use super::{
    drain_up_channel, fill_down_channel, find_control_block, ControlBlock, DrainOptions, RttError, TargetMemory,
};

/// Where drained RTT bytes go, and how the engine reports on itself.
///
/// Shaped like [`crate::gdb_rsp::GdbSink`] and for the same reason: it keeps this module unaware of
/// the funnel, the proxy and the debug adapter, so the engine can be driven by a test that is just
/// a byte array and a counter.
pub trait RttSink: Send + Sync + 'static {
    /// Bytes from an up channel, in the order the target wrote them.
    fn on_data(&self, channel: u32, data: &[u8]);
    /// The control block was found and validated. Fires once per engine.
    ///
    /// `took` is how long the search ran. Reported because the interval between "RTT is starting"
    /// and "data is flowing" is otherwise unaccountable from outside, and it is usually the firmware
    /// rather than us -- a session stopped at `main` has no control block until the target runs.
    fn on_ready(&self, _cb: &ControlBlock, _took: Duration) {}
    /// Something went wrong. Called on the transition into a fault, not once per failed poll.
    fn on_error(&self, _err: &RttError) {}
    /// Still looking for the control block after a grace period, with the reason.
    ///
    /// Reported once, and not an error: waiting is the normal state before the firmware initialises
    /// RTT. It exists because the two reasons for waiting -- a shut send gate and a control block
    /// that is not there yet -- are indistinguishable from outside, and telling them apart by
    /// reading code is a poor use of anyone's afternoon.
    fn waiting(&self, _why: &str) {}

    /// Counters so far, whenever [`RttConfig::stats_interval`] asks for them.
    ///
    /// `since` is measured from the control block being found, so it covers exactly the period the
    /// counters do. Reported rather than only logged at shutdown because the interesting question
    /// -- whether a slow server is costing us round trips, or the gate is shut, or the firmware
    /// simply has nothing for us -- is answered by watching these move, and a session that has
    /// ended is too late to ask.
    fn progress(&self, _stats: &RttStats, _since: Duration) {}

    /// The engine has stopped and will do nothing further.
    fn closed(&self, _why: &str) {}
}

/// Everything the engine needs to know, decided by the caller.
#[derive(Debug, Clone)]
pub struct RttConfig {
    /// Absolute address of `_SEGGER_RTT`. **Already resolved** — `address: "auto"` is turned into a
    /// number by the debug adapter from the ELF symbol table, so no symbol lookup happens here.
    pub cb_addr: u64,
    pub search_id: String,
    pub endian: Endian,
    /// Up channels to drain, in the order they are polled.
    pub up_channels: Vec<u32>,
    /// Down channels available for [`RttEngine::send`].
    pub down_channels: Vec<u32>,
    /// How long to wait after a pass that moved nothing.
    pub idle_interval: Duration,
    /// How long to wait between looks for the control block, **before** it has been found.
    ///
    /// Much lazier than `idle_interval`, and deliberately so. The firmware may not initialise RTT
    /// until well after the session starts -- `defmt-rtt` does it on the first write, so a session
    /// stopped at `main` has no control block yet -- and until then every look is a round trip on
    /// the connection GDB is using for its own startup. The servers are strictly serial (§4.2.1),
    /// so looking at the drain interval spends GDB's setup time on a question whose answer cannot
    /// change until the target runs. Nothing is lost by asking less often: the buffer is where the
    /// data waits, not the wire.
    pub search_interval: Duration,
    /// How long to wait when the mux gate is shut. Shorter than `idle_interval`: the gate opens on
    /// GDB finishing a packet, which is soon, and there is nothing to be gained by missing it.
    pub gate_interval: Duration,
    /// Give up looking for the control block after this. `None` retries for ever, which is what
    /// `rtt-builtin.ts` does — `rttConfig.rtt_start_retry` is OpenOCD's tcl `rtt start` dance and
    /// has nothing to do with this.
    pub search_timeout: Option<Duration>,
    pub drain: DrainOptions,
    /// Consecutive failed passes before giving up. Without a bound, a target that has been reset
    /// out from under us produces one error per pass for the rest of the session.
    pub max_consecutive_errors: u32,
    /// How often to call [`RttSink::progress`]. `None` reports only at shutdown.
    pub stats_interval: Option<Duration>,
}

impl Default for RttConfig {
    fn default() -> Self {
        Self {
            cb_addr: 0,
            search_id: "SEGGER RTT".to_string(),
            endian: Endian::Little,
            up_channels: vec![0],
            down_channels: vec![0],
            idle_interval: Duration::from_millis(1),
            search_interval: Duration::from_millis(100),
            gate_interval: Duration::from_micros(200),
            search_timeout: None,
            drain: DrainOptions::default(),
            max_consecutive_errors: 100,
            stats_interval: None,
        }
    }
}

/// Counters for comparing this against the TypeScript implementation.
///
/// `passes` is the number the port is really about: throughput is bytes per pass times passes per
/// second, and it is passes per second that the round-trip cost sets.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RttStats {
    pub bytes_up: u64,
    pub bytes_down: u64,
    /// Loop iterations that moved at least one byte.
    pub passes: u64,
    /// Iterations that found nothing and slept.
    pub idle_passes: u64,
    /// Iterations skipped because the mux gate was shut.
    pub gated_passes: u64,
    pub errors: u64,
    /// Memory reads issued, and writes. Their sum is **round trips**, which is the budget RTT
    /// throughput is made of.
    ///
    /// Counted here because it cannot be recovered from outside. The only throughput figure the
    /// funnel side can produce is the consumer's `msgs/sec`, and a `msg` there is one TCP buffer:
    /// on a fast probe two drains routinely arrive as one, so bytes-per-msg reads high and
    /// passes-per-second reads low, by an amount that varies per probe. That made a server
    /// comparison built on those two numbers meaningless -- see `docs-internal/rtt-benchmarks.md`.
    pub reads: u64,
    pub writes: u64,
}

struct Inner {
    stop: AtomicBool,
    stop_reason: Mutex<Option<&'static str>>,
    /// Bytes waiting for each down channel. A queue rather than a blocking write: the firmware may
    /// not be reading, and this thread must not be the one that waits for it.
    pending: Mutex<HashMap<u32, Vec<u8>>>,
    stats: Mutex<RttStats>,
    sink: Arc<dyn RttSink>,
}

/// A running RTT engine. Dropping the handle does **not** stop it; call [`RttEngine::shutdown`].
#[derive(Clone)]
pub struct RttEngine {
    inner: Arc<Inner>,
}

impl RttEngine {
    /// Start polling on a new thread.
    ///
    /// `mem` is normally a [`crate::gdb_rsp::Consumer`], and the engine will not touch it until
    /// `mem.ready()` says a request would actually go out.
    pub fn start(mem: Arc<dyn TargetMemory>, sink: Arc<dyn RttSink>, config: RttConfig) -> Self {
        let inner = Arc::new(Inner {
            stop: AtomicBool::new(false),
            stop_reason: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            stats: Mutex::new(RttStats::default()),
            sink,
        });
        let engine = Self {
            inner: Arc::clone(&inner),
        };
        std::thread::Builder::new()
            .name("rtt-poll".to_string())
            .spawn(move || run(mem, inner, config))
            .expect("spawn the RTT poll thread");
        engine
    }

    /// Queue bytes for a down channel. Returns how many were accepted.
    ///
    /// Accepted into a queue, not written: the write happens on the poll thread, because the target
    /// may have no space and whoever typed this must not wait for it. `limit` bounds the queue so a
    /// firmware that never reads its input cannot grow it without end.
    pub fn send(&self, channel: u32, data: &[u8], limit: usize) -> usize {
        let mut pending = self.inner.pending.lock_recover();
        let queue = pending.entry(channel).or_default();
        let room = limit.saturating_sub(queue.len());
        let n = room.min(data.len());
        queue.extend_from_slice(&data[..n]);
        n
    }

    pub fn stats(&self) -> RttStats {
        self.inner.stats.lock_recover().clone()
    }

    pub fn is_running(&self) -> bool {
        !self.inner.stop.load(Ordering::SeqCst)
    }

    pub fn shutdown(&self, why: &'static str) {
        if !self.inner.stop.swap(true, Ordering::SeqCst) {
            *self.inner.stop_reason.lock_recover() = Some(why);
        }
    }
}

/// Wait, but notice a shutdown promptly rather than sleeping through it.
///
/// Named for what it does: it sleeps in short slices and checks the stop flag between them, so a
/// teardown is seen within one slice however long the wait was asked to be.
fn nap_with_one_eye_open(inner: &Inner, total: Duration) {
    const SLICE: Duration = Duration::from_millis(5);
    let deadline = Instant::now() + total;
    while Instant::now() < deadline {
        if inner.stop.load(Ordering::SeqCst) {
            return;
        }
        std::thread::sleep(SLICE.min(deadline - Instant::now()));
    }
}

/// Wraps the real memory to count round trips.
///
/// A decorator rather than counters threaded through [`super::drain_up_channel`], so that the
/// ring-buffer code stays testable against a plain byte array and knows nothing about statistics.
struct Counted {
    mem: Arc<dyn TargetMemory>,
    inner: Arc<Inner>,
}

impl TargetMemory for Counted {
    fn read(&self, addr: u64, len: usize) -> Result<Vec<u8>, RspError> {
        self.inner.stats.lock_recover().reads += 1;
        self.mem.read(addr, len)
    }
    fn write(&self, addr: u64, data: &[u8]) -> Result<(), RspError> {
        self.inner.stats.lock_recover().writes += 1;
        self.mem.write(addr, data)
    }
    fn ready(&self) -> bool {
        // Deliberately not counted: it takes a lock, not a round trip.
        self.mem.ready()
    }
}

fn run(mem: Arc<dyn TargetMemory>, inner: Arc<Inner>, config: RttConfig) {
    let counted = Counted {
        mem,
        inner: Arc::clone(&inner),
    };
    let mem: &dyn TargetMemory = &counted;
    let began = Instant::now();
    let Some(cb) = search(mem, &inner, &config) else {
        let why = inner
            .stop_reason
            .lock_recover()
            .unwrap_or("the RTT control block was never found");
        inner.sink.closed(why);
        return;
    };
    inner.sink.on_ready(&cb, began.elapsed());

    let ready_at = Instant::now();
    let mut last_report = ready_at;
    let mut consecutive_errors = 0u32;
    while !inner.stop.load(Ordering::SeqCst) {
        if let Some(every) = config.stats_interval {
            if last_report.elapsed() >= every {
                last_report = Instant::now();
                let snapshot = inner.stats.lock_recover().clone();
                inner.sink.progress(&snapshot, ready_at.elapsed());
            }
        }
        if !mem.ready() {
            inner.stats.lock_recover().gated_passes += 1;
            nap_with_one_eye_open(&inner, config.gate_interval);
            continue;
        }
        match one_pass(mem, &inner, &config, &cb) {
            Ok(0) => {
                consecutive_errors = 0;
                inner.stats.lock_recover().idle_passes += 1;
                nap_with_one_eye_open(&inner, config.idle_interval);
            }
            Ok(_) => {
                consecutive_errors = 0;
                inner.stats.lock_recover().passes += 1;
                // Straight round again: there was data last time, so there is probably data now,
                // and the gate is what decides whether we may ask.
            }
            Err(e) => {
                inner.stats.lock_recover().errors += 1;
                consecutive_errors += 1;
                // Reported on the way into a fault only. A target that has been reset produces the
                // same failure every pass, and one line per pass is not a diagnostic.
                if consecutive_errors == 1 {
                    inner.sink.on_error(&e);
                }
                if consecutive_errors >= config.max_consecutive_errors {
                    inner.sink.closed("too many consecutive RTT failures");
                    inner.stop.store(true, Ordering::SeqCst);
                    return;
                }
                nap_with_one_eye_open(&inner, config.idle_interval);
            }
        }
    }
    let why = inner.stop_reason.lock_recover().unwrap_or("the RTT engine was stopped");
    inner.sink.closed(why);
}

/// Poll for the control block until the firmware has initialised it.
///
/// `None` means we gave up or were stopped. Not finding it is the normal state for as long as it
/// takes the target to reach `SEGGER_RTT_Init`, so it is not reported.
fn search(mem: &dyn TargetMemory, inner: &Inner, config: &RttConfig) -> Option<ControlBlock> {
    let started = Instant::now();
    // Say *why* we are still waiting, once, after a grace period.
    //
    // Both ways of waiting here are silent and look identical from outside: a shut send gate and a
    // control block the firmware has not written yet. That cost a debugging session to tell apart,
    // which is a diagnostic this should have produced itself. The grace period keeps it out of the
    // way of the ordinary case, where the firmware reaches `SEGGER_RTT_Init` in milliseconds.
    let mut explained = false;
    while !inner.stop.load(Ordering::SeqCst) {
        if !explained && started.elapsed() > Duration::from_secs(3) {
            explained = true;
            let gate = mem.ready();
            inner.sink.waiting(if gate {
                "the control block has not been written yet -- the firmware may not have reached SEGGER_RTT_Init, or the address may be wrong"
            } else {
                "our packets are not allowed out: either the gdb handshake has not settled, or this gdb-server is not known to answer while the target runs (see debugFlags.rspTier)"
            });
        }
        if !mem.ready() {
            // Counted here as well as in the main loop: `gated_passes` means "we wanted to ask and
            // could not", and the search is exactly when a session is most likely to be gated --
            // the handshake has not settled, so the gate is shut by definition (§4.4).
            inner.stats.lock_recover().gated_passes += 1;
            nap_with_one_eye_open(inner, config.gate_interval);
            continue;
        }
        match find_control_block(mem, config.cb_addr, &config.search_id, config.endian) {
            Ok(cb) => return Some(cb),
            Err(RttError::NotReady) => {
                if let Some(limit) = config.search_timeout {
                    if started.elapsed() >= limit {
                        inner.sink.on_error(&RttError::NotReady);
                        return None;
                    }
                }
                nap_with_one_eye_open(inner, config.search_interval);
            }
            Err(e) => {
                // `Invalid` or a memory failure: the id matched and the rest did not, or the target
                // is unreachable. Neither improves by asking again in a millisecond.
                inner.sink.on_error(&e);
                return None;
            }
        }
    }
    None
}

/// One pass over every channel. Returns the bytes moved in either direction.
fn one_pass(mem: &dyn TargetMemory, inner: &Inner, config: &RttConfig, cb: &ControlBlock) -> Result<usize, RttError> {
    let mut moved = 0usize;

    // Down channels first: whoever typed is waiting, and an up channel that has data will still
    // have it a round trip later.
    for &channel in &config.down_channels {
        let data = {
            let pending = inner.pending.lock_recover();
            match pending.get(&channel) {
                Some(q) if !q.is_empty() => q.clone(),
                _ => continue,
            }
        };
        // The lock is released across the write: it is several round trips, and `send` is called
        // from whichever thread owns the terminal.
        match fill_down_channel(mem, cb, channel, &data, config.endian) {
            Ok(0) => {}
            Ok(n) => {
                let mut pending = inner.pending.lock_recover();
                if let Some(q) = pending.get_mut(&channel) {
                    // Drain from the front by exactly what went, rather than replacing the queue:
                    // `send` may have appended while the write was in flight.
                    q.drain(..n.min(q.len()));
                }
                inner.stats.lock_recover().bytes_down += n as u64;
                moved += n;
            }
            // A channel the firmware has not allocated is not a failure; there is simply nowhere
            // to put this yet.
            Err(RttError::NotReady) => {}
            Err(e) => return Err(e),
        }
    }

    for &channel in &config.up_channels {
        match drain_up_channel(mem, cb, channel, config.endian, &config.drain) {
            Ok(Some(data)) if !data.is_empty() => {
                inner.stats.lock_recover().bytes_up += data.len() as u64;
                moved += data.len();
                inner.sink.on_data(channel, &data);
            }
            Ok(_) => {}
            Err(RttError::NotReady) => {}
            Err(e) => return Err(e),
        }
    }
    Ok(moved)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rtt::fake::{FakeTarget, BUF_SIZE, CB_ADDR};
    use crate::rtt::RspError;

    /// Collects everything the engine reports, so a test can assert on the whole lifecycle.
    #[derive(Default)]
    struct Recorder {
        data: Mutex<Vec<(u32, Vec<u8>)>>,
        ready: Mutex<Vec<ControlBlock>>,
        errors: Mutex<Vec<String>>,
        closed: Mutex<Option<String>>,
    }

    impl RttSink for Recorder {
        fn on_data(&self, channel: u32, data: &[u8]) {
            self.data.lock_recover().push((channel, data.to_vec()));
        }
        fn on_ready(&self, cb: &ControlBlock, _took: Duration) {
            self.ready.lock_recover().push(*cb);
        }
        fn on_error(&self, err: &RttError) {
            self.errors.lock_recover().push(err.to_string());
        }
        fn closed(&self, why: &str) {
            *self.closed.lock_recover() = Some(why.to_string());
        }
    }

    impl Recorder {
        fn bytes(&self) -> Vec<u8> {
            self.data.lock_recover().iter().flat_map(|(_, d)| d.clone()).collect()
        }
    }

    fn config() -> RttConfig {
        RttConfig {
            cb_addr: CB_ADDR,
            up_channels: vec![0],
            down_channels: vec![],
            // Short enough that a test does not wait on it, long enough not to be a busy loop.
            idle_interval: Duration::from_millis(1),
            search_interval: Duration::from_millis(1),
            ..Default::default()
        }
    }

    fn wait_for(pred: impl Fn() -> bool, what: &str) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !pred() {
            assert!(Instant::now() < deadline, "timed out waiting for: {what}");
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    #[test]
    fn data_already_in_the_buffer_is_delivered_and_the_block_reported_ready() {
        let target = Arc::new(
            FakeTarget::new()
                .with_control_block("SEGGER RTT", 1, 1)
                .with_up_channel(5, 0, b"hello"),
        );
        let rec = Arc::new(Recorder::default());
        let engine = RttEngine::start(target, Arc::clone(&rec) as Arc<dyn RttSink>, config());

        wait_for(|| !rec.data.lock_recover().is_empty(), "the first data");
        assert_eq!(rec.bytes(), b"hello".to_vec());
        assert_eq!(rec.ready.lock_recover().len(), 1, "ready fires once");
        assert!(engine.stats().bytes_up >= 5);

        engine.shutdown("test over");
        wait_for(|| rec.closed.lock_recover().is_some(), "the close report");
        assert_eq!(rec.closed.lock_recover().as_deref(), Some("test over"));
    }

    #[test]
    fn the_engine_waits_for_the_firmware_rather_than_reporting_an_error() {
        // The control block appears only once the firmware reaches SEGGER_RTT_Init, which may be
        // long after the session starts. Until then the engine must be silent.
        let target = Arc::new(FakeTarget::new());
        let rec = Arc::new(Recorder::default());
        let engine = RttEngine::start(
            Arc::clone(&target) as Arc<dyn TargetMemory>,
            Arc::clone(&rec) as Arc<dyn RttSink>,
            config(),
        );

        std::thread::sleep(Duration::from_millis(50));
        assert!(rec.ready.lock_recover().is_empty(), "nothing found yet");
        assert!(rec.errors.lock_recover().is_empty(), "and nothing reported");

        // Now let the firmware initialise, exactly as it does: the id last.
        target.put_u32(CB_ADDR + 16, 1);
        target.put_u32(CB_ADDR + 20, 1);
        let desc = CB_ADDR + super::super::CB_HEADER_LEN as u64;
        target.put_u32(desc + 4, crate::rtt::fake::BUF_ADDR as u32);
        target.put_u32(desc + 8, BUF_SIZE);
        target.put_u32(desc + 12, 3); // WrOff
        target.put_u32(desc + 16, 0); // RdOff
        target.put(crate::rtt::fake::BUF_ADDR, b"abc");
        let mut id = [0u8; super::super::ID_LEN];
        id[..10].copy_from_slice(b"SEGGER RTT");
        target.put(CB_ADDR, &id);

        wait_for(|| !rec.data.lock_recover().is_empty(), "data after initialisation");
        assert_eq!(rec.bytes(), b"abc".to_vec());
        engine.shutdown("test over");
    }

    #[test]
    fn a_search_timeout_gives_up_and_says_so() {
        let target = Arc::new(FakeTarget::new());
        let rec = Arc::new(Recorder::default());
        let cfg = RttConfig {
            search_timeout: Some(Duration::from_millis(20)),
            ..config()
        };
        let _engine = RttEngine::start(target, Arc::clone(&rec) as Arc<dyn RttSink>, cfg);
        wait_for(|| rec.closed.lock_recover().is_some(), "giving up");
        assert!(rec.closed.lock_recover().as_deref().unwrap().contains("never found"));
    }

    #[test]
    fn a_shut_gate_is_waited_for_rather_than_spent_on_a_timeout() {
        // The whole reason `TargetMemory::ready` exists. With the gate shut nothing may be asked,
        // and the engine must neither read nor report a fault.
        let target = Arc::new(
            FakeTarget::new()
                .with_control_block("SEGGER RTT", 1, 1)
                .with_up_channel(5, 0, b"hello"),
        );
        target.set_ready(false);
        let rec = Arc::new(Recorder::default());
        let engine = RttEngine::start(
            Arc::clone(&target) as Arc<dyn TargetMemory>,
            Arc::clone(&rec) as Arc<dyn RttSink>,
            config(),
        );

        std::thread::sleep(Duration::from_millis(40));
        assert_eq!(target.read_count(), 0, "not one read while the gate is shut");
        assert!(engine.stats().gated_passes > 0, "and it noticed");

        target.set_ready(true);
        wait_for(|| !rec.data.lock_recover().is_empty(), "data once the gate opens");
        engine.shutdown("test over");
    }

    #[test]
    fn a_quiet_channel_sleeps_instead_of_spinning() {
        // A descriptor read is SWD traffic competing with GDB whether or not it returns anything,
        // so an idle channel must not be polled flat out.
        let target = Arc::new(
            FakeTarget::new()
                .with_control_block("SEGGER RTT", 1, 1)
                .with_up_channel(0, 0, b""),
        );
        let rec = Arc::new(Recorder::default());
        let cfg = RttConfig {
            idle_interval: Duration::from_millis(20),
            ..config()
        };
        let engine = RttEngine::start(
            Arc::clone(&target) as Arc<dyn TargetMemory>,
            Arc::clone(&rec) as Arc<dyn RttSink>,
            cfg,
        );

        std::thread::sleep(Duration::from_millis(100));
        engine.shutdown("test over");
        // ~5 descriptor reads at 20ms, plus the one that found the block. Generous bound: the point
        // is that it is not hundreds.
        assert!(
            target.read_count() < 30,
            "polled {} times in 100ms",
            target.read_count()
        );
        assert!(engine.stats().idle_passes > 0);
    }

    #[test]
    fn queued_input_reaches_the_down_channel_and_is_dequeued_by_what_went() {
        let target = Arc::new(
            FakeTarget::new()
                .with_control_block("SEGGER RTT", 1, 1)
                .with_up_channel(0, 0, b"")
                .with_down_channel(0, 0),
        );
        let rec = Arc::new(Recorder::default());
        let cfg = RttConfig {
            down_channels: vec![0],
            ..config()
        };
        let engine = RttEngine::start(
            Arc::clone(&target) as Arc<dyn TargetMemory>,
            Arc::clone(&rec) as Arc<dyn RttSink>,
            cfg,
        );
        wait_for(|| !rec.ready.lock_recover().is_empty(), "the block");

        assert_eq!(engine.send(0, b"go\n", 1024), 3);
        wait_for(|| engine.stats().bytes_down >= 3, "the write");
        engine.shutdown("test over");

        // The bytes landed at the start of the down buffer and WrOff advanced to match.
        let cb = rec.ready.lock_recover()[0];
        let wr_off_addr = cb.down_desc_addr(0) + 4 + 8;
        assert_eq!(target.read_u32_at(wr_off_addr), 3);
        assert_eq!(target.bytes_at(crate::rtt::fake::DOWN_BUF_ADDR, 3), b"go\n".to_vec());
    }

    #[test]
    fn a_full_down_channel_keeps_the_remainder_queued() {
        // The firmware is not reading its input. This must not block the poll thread and must not
        // lose the bytes that did not fit.
        //
        // An *empty* down buffer, which holds size - 1 bytes: WrOff == RdOff is how the target
        // recognises empty, so one byte is never usable. (An earlier version of this test set
        // RdOff = 1 with WrOff = 0, which describes a buffer 63/64 *full* -- the opposite setup,
        // with no space at all, so nothing was ever written.)
        let target = Arc::new(
            FakeTarget::new()
                .with_control_block("SEGGER RTT", 1, 1)
                .with_up_channel(0, 0, b"")
                .with_down_channel(0, 0),
        );
        let rec = Arc::new(Recorder::default());
        let cfg = RttConfig {
            down_channels: vec![0],
            ..config()
        };
        let engine = RttEngine::start(
            Arc::clone(&target) as Arc<dyn TargetMemory>,
            Arc::clone(&rec) as Arc<dyn RttSink>,
            cfg,
        );
        wait_for(|| !rec.ready.lock_recover().is_empty(), "the block");

        let offered = engine.send(0, &vec![b'x'; BUF_SIZE as usize * 2], 4096);
        assert_eq!(offered, BUF_SIZE as usize * 2, "all of it is queued");
        wait_for(|| engine.stats().bytes_down > 0, "a partial write");
        // The fake target never advances RdOff, so nothing further can ever fit. The count
        // settling is what shows the remainder stayed queued rather than being written or dropped.
        std::thread::sleep(Duration::from_millis(30));
        engine.shutdown("test over");

        let wrote = engine.stats().bytes_down as usize;
        assert_eq!(wrote, BUF_SIZE as usize - 1, "exactly what fit, once");
    }

    #[test]
    fn the_send_queue_is_bounded() {
        let target = Arc::new(FakeTarget::new());
        let rec = Arc::new(Recorder::default());
        let engine = RttEngine::start(target, rec as Arc<dyn RttSink>, config());
        assert_eq!(engine.send(0, &[b'a'; 100], 40), 40, "accept up to the limit");
        assert_eq!(engine.send(0, &[b'a'; 100], 40), 0, "and no more");
        engine.shutdown("test over");
    }

    #[test]
    fn a_persistent_failure_is_reported_once_and_then_gives_up() {
        // A target reset out from under us fails the same way every pass. One line per pass is not
        // a diagnostic, and retrying for ever is not a lifecycle.
        let target = Arc::new(
            FakeTarget::new()
                .with_control_block("SEGGER RTT", 1, 1)
                .with_up_channel(5, 0, b"hello"),
        );
        let rec = Arc::new(Recorder::default());
        let cfg = RttConfig {
            max_consecutive_errors: 3,
            idle_interval: Duration::from_millis(1),
            ..config()
        };
        let engine = RttEngine::start(
            Arc::clone(&target) as Arc<dyn TargetMemory>,
            Arc::clone(&rec) as Arc<dyn RttSink>,
            cfg,
        );
        wait_for(|| !rec.ready.lock_recover().is_empty(), "the block");

        // Fail the descriptor read from here on.
        *target.fail_reads_at.lock_recover() = Some(CB_ADDR + super::super::CB_HEADER_LEN as u64 + 4);
        wait_for(|| rec.closed.lock_recover().is_some(), "giving up");
        assert_eq!(rec.errors.lock_recover().len(), 1, "reported once, not once per pass");
        assert!(rec.closed.lock_recover().as_deref().unwrap().contains("consecutive"));
        assert!(!engine.is_running());
    }

    #[test]
    fn a_wrapped_buffer_arrives_in_write_order() {
        let mut contents = vec![0u8; BUF_SIZE as usize];
        contents[60..64].copy_from_slice(b"abcd");
        contents[0..3].copy_from_slice(b"efg");
        let target = Arc::new(
            FakeTarget::new()
                .with_control_block("SEGGER RTT", 1, 1)
                .with_up_channel(3, 60, &contents),
        );
        let rec = Arc::new(Recorder::default());
        let engine = RttEngine::start(target, Arc::clone(&rec) as Arc<dyn RttSink>, config());
        wait_for(|| rec.bytes().len() >= 7, "both runs");
        assert_eq!(&rec.bytes()[..7], b"abcdefg");
        engine.shutdown("test over");
    }

    #[test]
    fn a_control_block_that_is_zeroed_and_comes_back_is_tolerated_without_a_word() {
        // What a target reset looks like, and the reason no reset handling is needed.
        //
        // The engine caches almost nothing: only the control block's address and its channel
        // counts, both of which are properties of the *image*, not of a run. The ring buffer's
        // descriptor -- `pBuffer`, `SizeOfBuffer`, `WrOff`, `RdOff` -- is re-read on every single
        // pass, so there is no stale pointer for a reset to invalidate.
        //
        // Which RTT implementation the firmware uses decides what a reset even does. `defmt-rtt`
        // and `rtt-target` place the control block in an uninit section, so it survives intact and
        // polling simply continues. SEGGER's own `SEGGER_RTT.c` leaves `_SEGGER_RTT` in `.bss`,
        // which C startup zeroes before `SEGGER_RTT_Init` runs again -- and that window is what
        // this test is. A zeroed descriptor is `NotReady`, not a fault: the pass moves nothing,
        // nothing is reported, and the channel resumes when the firmware has re-initialised it.
        let target = Arc::new(
            FakeTarget::new()
                .with_control_block("SEGGER RTT", 1, 1)
                .with_up_channel(5, 0, b"hello"),
        );
        let rec = Arc::new(Recorder::default());
        let engine = RttEngine::start(
            Arc::clone(&target) as Arc<dyn TargetMemory>,
            Arc::clone(&rec) as Arc<dyn RttSink>,
            RttConfig {
                idle_interval: Duration::from_millis(1),
                ..config()
            },
        );
        wait_for(|| !rec.data.lock_recover().is_empty(), "the first data");

        // C startup zeroes `.bss`: pBuffer, SizeOfBuffer, WrOff and RdOff all go to 0.
        let desc = CB_ADDR + super::super::CB_HEADER_LEN as u64;
        for off in [4u64, 8, 12, 16] {
            target.put_u32(desc + off, 0);
        }
        std::thread::sleep(Duration::from_millis(40));
        assert!(
            rec.errors.lock_recover().is_empty(),
            "a zeroed control block is not a fault: {:?}",
            rec.errors.lock_recover()
        );
        assert!(rec.closed.lock_recover().is_none(), "and must not end the engine");
        assert!(engine.is_running());

        // `SEGGER_RTT_Init` runs again. Offsets start from zero, which is exactly the state the
        // engine would have inferred anyway, because it never cached them.
        target.put_u32(desc + 4, crate::rtt::fake::BUF_ADDR as u32);
        target.put_u32(desc + 8, BUF_SIZE);
        target.put(crate::rtt::fake::BUF_ADDR, b"again");
        target.put_u32(desc + 12, 5); // WrOff
        target.put_u32(desc + 16, 0); // RdOff

        wait_for(|| rec.bytes().ends_with(b"again"), "data after re-initialisation");
        assert!(rec.errors.lock_recover().is_empty(), "still nothing to report");
        engine.shutdown("test over");
    }

    #[test]
    fn a_memory_failure_during_the_search_is_reported_and_stops() {
        struct DeadTarget;
        impl TargetMemory for DeadTarget {
            fn read(&self, _addr: u64, _len: usize) -> Result<Vec<u8>, RspError> {
                Err(RspError::Timeout)
            }
            fn write(&self, _addr: u64, _data: &[u8]) -> Result<(), RspError> {
                Err(RspError::Timeout)
            }
        }
        let rec = Arc::new(Recorder::default());
        let _engine = RttEngine::start(Arc::new(DeadTarget), Arc::clone(&rec) as Arc<dyn RttSink>, config());
        wait_for(|| rec.closed.lock_recover().is_some(), "the close report");
        assert_eq!(rec.errors.lock_recover().len(), 1);
    }
}
