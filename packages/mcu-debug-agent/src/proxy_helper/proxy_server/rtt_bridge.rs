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

//! Joins [`crate::rtt`]'s engine to this session's funnel (`docs-internal/gdb-rsp.md` item 20).
//!
//! The same seam as [`super::rsp_mux`] and for the same reason: all of the RTT protocol lives in
//! `crate::rtt`, which knows nothing about the proxy, and all of the stream bookkeeping lives in
//! `mod.rs`, which knows nothing about RTT.
//!
//! **Each up channel becomes an ordinary funnel stream.** That is the whole integration decision,
//! and it is what makes this small: the bytes arrive at the client as `StreamData` exactly as a
//! gdb-server port's do, so the client binds a local listener per channel and its existing
//! decoders -- terminals, graphs, the `pipe` decoder and its throughput statistics -- work with no
//! change at all. A parity measurement is then a matter of flipping one flag in the same session
//! and comparing two numbers produced by the same code.
//!
//! RTT streams are deliberately **not** put in `ProxyServer::streams`. That map is "stream id to a
//! TCP connection to the gdb-server", and an RTT channel has neither a server port nor a socket;
//! a `PortInfo` for one would have to lie about both, and `release_stream` and `StreamStatus` would
//! then report that lie. They live in `rtt_streams` instead, consulted before `streams` in the
//! message loop -- the same shape as `rsp_channels`.

use std::collections::HashMap;
use std::sync::mpsc::Sender;
use std::sync::Arc;
use std::time::Duration;

use crate::gdb_rsp::{Consumer, Endian};
use crate::rtt::{ControlBlock, DrainOptions, RttConfig, RttEngine, RttError, RttSink, RttStats, TargetMemory};

use super::*;

/// How long one of our memory requests may take before it is a failure rather than a slow probe.
///
/// Generous: a `HaltedOnly` server with GDB mid-transaction can legitimately make us wait, and
/// `Consumer::ready()` is what keeps us from asking at a bad moment in the first place.
const RTT_REQUEST_TIMEOUT: Duration = Duration::from_millis(2000);

/// Bytes a down channel may hold while the firmware is not reading it.
///
/// Bounded so a target that never drains its input cannot grow this without end. A terminal's worth
/// of typing is orders of magnitude less.
const DOWN_QUEUE_LIMIT: usize = 64 * 1024;

/// Default polling interval for the RTT poll thread.
///
/// Setting this too low can cause excessive bus traffic and impact MCU performance.
/// Don't forget to update definition.js if you change this value.
const DEFAULT_POLLING_INTERVAL_MS: u32 = 50;

/// The engine's output, expressed as funnel frames.
///
/// Sends on the session's event channel rather than writing the funnel directly, so the write
/// happens on the message-loop thread. The poll thread must not be the one blocked on a slow
/// client -- it is the thread holding the RSP connection's turn.
struct FunnelRttSink {
    /// RTT channel to the stream id its data goes out on.
    streams: HashMap<u32, u8>,
    event_tx: Sender<ProxyEvent>,
}

impl FunnelRttSink {
    /// Hand an event to the message loop to write.
    ///
    /// Never written from here directly: this runs on the poll thread, and the funnel writer is the
    /// message loop's. A failed send means the loop is gone, which means the session is over.
    fn report(&self, event: ProxyServerEvents) {
        if self.event_tx.send(ProxyEvent::ServerEvent(event)).is_err() {
            log::warn!("RTT: the proxy message loop is gone; an RTT event was dropped");
        }
    }
}

impl RttSink for FunnelRttSink {
    fn on_data(&self, channel: u32, data: &[u8]) {
        let Some(&stream_id) = self.streams.get(&channel) else {
            // A channel we were not asked to serve. The engine only drains what it was configured
            // with, so this cannot happen without a bug -- worth saying so rather than dropping it.
            log::warn!("RTT: no stream for channel {channel}; {} bytes dropped", data.len());
            return;
        };
        if self
            .event_tx
            .send(ProxyEvent::StreamData {
                stream_id,
                data: data.to_vec(),
            })
            .is_err()
        {
            // The loop is gone, so the session is over. Nothing to report it to.
            log::warn!("RTT: the proxy message loop is gone; stopping delivery on channel {channel}");
        }
    }

    fn on_ready(&self, cb: &ControlBlock, took: Duration) {
        log::info!(
            "RTT: control block at {:#x} with {} up and {} down channels, found after {:.1}s",
            cb.addr,
            cb.up_channels,
            cb.down_channels,
            took.as_secs_f64()
        );
        self.report(ProxyServerEvents::RttReady {
            cb_address: format!("{:#x}", cb.addr),
            up_channels: cb.up_channels,
            down_channels: cb.down_channels,
            search_ms: took.as_millis() as u64,
        });
    }

    fn on_error(&self, err: &RttError) {
        // Once per fault, not once per failed poll -- the engine guarantees that.
        log::warn!("RTT: {err}");
    }

    fn waiting(&self, why: &str) {
        log::warn!("RTT: still waiting for the control block -- {why}");
    }

    /// The engine's counters, on to the client.
    ///
    /// Sent as an event rather than only logged, because the Agent's stderr is dropped unless a
    /// host-side debug flag happens to be on -- and throughput measurement is a feature, not debug
    /// noise. Cumulative, so the client subtracts consecutive samples to get a window; doing that
    /// arithmetic on both sides would be two implementations of one subtraction.
    fn progress(&self, stats: &RttStats, since: Duration) {
        self.report(ProxyServerEvents::RttStats {
            bytes_up: stats.bytes_up,
            bytes_down: stats.bytes_down,
            drains: stats.passes,
            idle: stats.idle_passes,
            gated: stats.gated_passes,
            errors: stats.errors,
            err_invalid: stats.err_invalid,
            err_rejected: stats.err_rejected,
            err_timeout: stats.err_timeout,
            err_target: stats.err_target,
            err_other: stats.err_other,
            reads: stats.reads,
            writes: stats.writes,
            elapsed_ms: since.as_millis() as u64,
        });
    }

    fn closed(&self, why: &str) {
        log::info!("RTT: engine stopped -- {why}");
        self.report(ProxyServerEvents::RttStopped {
            reason: why.to_string(),
        });
    }
}

impl ProxyServer {
    /// Start the Agent's RTT engine on `stream_id`'s multiplexer.
    pub(super) fn handle_start_rtt(&mut self, stream_id: u8, config: RttStartConfig, msg_seq: u64) {
        if self.rtt_engine.is_some() {
            ControlResponse::error(msg_seq, "RTT is already running for this session".to_string())
                .send(&self.writer)
                .ok();
            return;
        }
        // The one hard prerequisite, and worth refusing rather than ignoring: the engine reads target
        // memory through a `Consumer` on this stream's mux. A session with `rspMux` false has nothing
        // for it to run on.
        let Some(rsp) = self.rsp_channels.get(&stream_id) else {
            // Say *which* way it is missing. This used to blame `debugFlags.rspMux` for every case,
            // which sent a real multi-core bug chasing a flag that could not have helped: on a 2-core
            // target with `targetProcessor: 1` the client named core 0's stream, which is allocated
            // but never connected, while the mux sat on core 1's. Three distinguishable states, and
            // only one of them is about the flag.
            let why = match self.stream_meta.get(&stream_id) {
                None => format!("stream {stream_id} was never registered with this proxy"),
                Some(meta) if !meta.kind.is_rsp_controller() => format!(
                    "stream {stream_id} ('{}') is not a controller gdb connection, so it has no multiplexer to read through",
                    meta.name
                ),
                Some(meta) if !self.streams.contains_key(&stream_id) => format!(
                    "stream {stream_id} ('{}') is a controller gdb connection that nothing has connected to, so there is no multiplexer on it yet. On a multi-core target the connected core is the one named by `targetProcessor`",
                    meta.name
                ),
                Some(meta) => format!(
                    "stream {stream_id} ('{}') is connected but not multiplexed; Agent-side RTT needs debugFlags.rspMux",
                    meta.name
                ),
            };
            ControlResponse::error(msg_seq, format!("cannot start Agent-side RTT: {why}"))
                .send(&self.writer)
                .ok();
            return;
        };
        let cb_addr = match parse_hex_address(&config.cb_address) {
            Some(a) => a,
            None => {
                ControlResponse::error(
                    msg_seq,
                    format!("'{}' is not a usable control block address", config.cb_address),
                )
                .send(&self.writer)
                .ok();
                return;
            }
        };
        if config.up_channels.is_empty() {
            ControlResponse::error(msg_seq, "no RTT up channels were requested".to_string())
                .send(&self.writer)
                .ok();
            return;
        }

        let endian = if config.big_endian { Endian::Big } else { Endian::Little };
        let rsp_caps = rsp.caps();
        let consumer = Consumer::new(rsp, RTT_REQUEST_TIMEOUT).with_endian(endian);

        // One stream per up channel, minted here and reported back. Down channels travel inbound on
        // the stream of the same number where there is one, so they need no id of their own.
        let mut channels = Vec::new();
        let mut by_channel = HashMap::new();
        for &channel in &config.up_channels {
            let sid = self.next_stream_id;
            self.next_stream_id += 1;
            self.stream_meta.insert(
                sid,
                StreamMeta {
                    name: format!("rttChannel{channel}"),
                    kind: StreamKind::Rtt { channel },
                    duplicate_of: None,
                },
            );
            self.rtt_streams.insert(sid, channel);
            by_channel.insert(channel, sid);
            channels.push(RttChannelStream {
                channel,
                stream_id: sid,
            });
        }

        let sink = Arc::new(FunnelRttSink {
            streams: by_channel,
            event_tx: self.event_tx.clone(),
        });
        let engine = RttEngine::start(
            Arc::new(consumer) as Arc<dyn TargetMemory>,
            sink,
            RttConfig {
                cb_addr,
                search_id: config.search_id.clone(),
                endian,
                up_channels: config.up_channels.clone(),
                down_channels: config.down_channels.clone(),
                idle_interval: Duration::from_millis(
                    config.poll_interval_ms.unwrap_or(DEFAULT_POLLING_INTERVAL_MS).max(1) as u64,
                ),
                drain: DrainOptions {
                    // The client's value when it sent one -- that is `debugFlags.rttDrainBytes`, a
                    // measurement knob rather than a user setting -- otherwise this server's measured
                    // default. Per-server because the limit is a property of the server's reply
                    // buffer and cannot be read off `PacketSize`; see `caps::drain_cap_for_server`.
                    max_bytes: Some(match config.max_bytes_per_drain {
                        Some(n) if n >= 1 => n as usize,
                        _ => crate::gdb_rsp::drain_cap(
                            self.server_type.as_deref().unwrap_or(""),
                            // Observed from GDB's own negotiation, never probed for (§4.5), and used
                            // only as a ceiling -- see `drain_cap`.
                            rsp_caps.packet_size(),
                        ),
                    }),
                    ..DrainOptions::default()
                },
                // The client's interval, taken from the decoder that asked for statistics, so the
                // engine's line and the consumer's describe the same window and can be read against
                // each other. `None` when nobody asked, and then nothing is sent at all.
                stats_interval: config
                    .stats_interval_ms
                    .map(|ms| Duration::from_millis(ms.max(1) as u64)),
                ..RttConfig::default()
            },
        );
        log::info!(
            "RTT: engine started on stream {} for channels {:?} (cb {:#x})",
            stream_id,
            config.up_channels,
            cb_addr
        );
        self.rtt_engine = Some(engine);

        ControlResponse::success(msg_seq, Some(ControlResponseData::StartRtt { channels }))
            .send(&self.writer)
            .ok();
    }

    /// Stop the engine and dismantle its streams.
    pub(super) fn handle_stop_rtt(&mut self, msg_seq: u64) {
        let was_running = self.stop_rtt_engine("the client asked");
        ControlResponse::success(msg_seq, Some(ControlResponseData::StopRtt { was_running }))
            .send(&self.writer)
            .ok();
    }

    /// Shut the engine down and tell the client each of its streams has ended.
    ///
    /// Also called on session teardown, which is why it is safe with no engine running.
    pub(super) fn stop_rtt_engine(&mut self, why: &'static str) -> bool {
        let had = self.rtt_engine.take();
        if let Some(engine) = &had {
            let stats = engine.stats();
            // Worth a line: these are the numbers a parity comparison is made of, and a session that
            // has ended is exactly when they are final.
            log::info!(
                "RTT: stopping ({why}) -- {} bytes up, {} down, {} drains, {} idle, {} gated, {} errors, \
                 {} reads + {} writes = {} round trips",
                stats.bytes_up,
                stats.bytes_down,
                stats.passes,
                stats.idle_passes,
                stats.gated_passes,
                stats.errors,
                stats.reads,
                stats.writes,
                stats.reads + stats.writes
            );
            engine.shutdown(why);
        }
        let ids: Vec<u8> = self.rtt_streams.keys().copied().collect();
        for sid in ids {
            self.rtt_streams.remove(&sid);
            self.stream_meta.remove(&sid);
            // The client's listener for this channel is torn down the same way it would be for any
            // stream that ends, so nothing special is needed on that side.
            ProxyServerEvents::StreamClosed { stream_id: sid }
                .send(&self.writer)
                .ok();
        }
        had.is_some()
    }

    /// Inbound bytes for an RTT stream: input for that channel's down buffer.
    ///
    /// Queued rather than written. The write happens on the poll thread, because the firmware may
    /// have no space and the message loop must not be what waits for it.
    pub(super) fn feed_rtt_down(&self, channel: u32, data: &[u8]) {
        let Some(engine) = &self.rtt_engine else {
            log::info!("RTT: input for channel {channel} arrived with no engine running; dropped");
            return;
        };
        let accepted = engine.send(channel, data, DOWN_QUEUE_LIMIT);
        if accepted < data.len() {
            // Not an error worth failing the session over: the target is not reading its input and
            // the queue is full. Saying so is better than losing the bytes silently.
            log::info!(
                "RTT: down channel {channel} is backed up; dropped {} of {} bytes",
                data.len() - accepted,
                data.len()
            );
        }
    }
}

/// Parse `"0x20000000"`, or a bare decimal, into an address.
///
/// Its own function so the failure is reported to the client rather than becoming a silent 0 -- an
/// address of 0 would make the engine poll address 0 for ever, looking exactly like firmware that
/// never initialises RTT.
fn parse_hex_address(text: &str) -> Option<u64> {
    let trimmed = text.trim();
    let value = match trimmed.strip_prefix("0x").or_else(|| trimmed.strip_prefix("0X")) {
        Some(hex) => u64::from_str_radix(hex, 16).ok()?,
        None => trimmed.parse::<u64>().ok()?,
    };
    (value != 0).then_some(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_address_is_accepted_in_either_form_and_zero_is_refused() {
        assert_eq!(parse_hex_address("0x20000000"), Some(0x2000_0000));
        assert_eq!(parse_hex_address("0X20000000"), Some(0x2000_0000));
        assert_eq!(parse_hex_address("  0x2000abcd  "), Some(0x2000_abcd));
        assert_eq!(parse_hex_address("536870912"), Some(0x2000_0000));
        // Zero and nonsense are both refused, because both would otherwise become a poll of
        // address 0 that looks indistinguishable from firmware that never starts RTT.
        assert_eq!(parse_hex_address("0x0"), None);
        assert_eq!(parse_hex_address("0"), None);
        assert_eq!(parse_hex_address("auto"), None);
        assert_eq!(parse_hex_address(""), None);
    }

    #[test]
    fn the_sink_turns_channel_data_into_a_funnel_frame_for_that_channel() {
        let (tx, rx) = std::sync::mpsc::channel();
        let sink = FunnelRttSink {
            streams: HashMap::from([(0, 7), (1, 8)]),
            event_tx: tx,
        };
        sink.on_data(1, b"hello");
        match rx.recv_timeout(Duration::from_secs(2)) {
            Ok(ProxyEvent::StreamData { stream_id, data }) => {
                assert_eq!(stream_id, 8, "channel 1 goes out on its own stream");
                assert_eq!(data, b"hello".to_vec());
            }
            other => panic!("expected StreamData, got ok={}", other.is_ok()),
        }
    }

    #[test]
    fn data_for_an_unserved_channel_is_reported_rather_than_delivered_to_the_wrong_stream() {
        let (tx, rx) = std::sync::mpsc::channel();
        let sink = FunnelRttSink {
            streams: HashMap::from([(0, 7)]),
            event_tx: tx,
        };
        sink.on_data(3, b"hello");
        assert!(
            rx.recv_timeout(Duration::from_millis(100)).is_err(),
            "nothing may be sent"
        );
    }
}
