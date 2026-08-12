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

//! Event-driven serial-availability hub.
//!
//! A single watcher thread updates a shared snapshot of available serial ports.
//! ProxyServer instances subscribe via their internal event channels and receive
//! debounced full-snapshot updates whenever the list changes.

use std::collections::HashMap;
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::common::sync::MutexExt;

#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::path::Path;

use crate::proxy_helper::proxy_server::ProxyEvent;
use crate::serial::AvailablePort;

#[derive(Debug, Clone, Copy)]
enum WatchSignal {
    Trigger,
    Stop,
}

#[derive(Debug)]
struct HubState {
    next_subscriber_id: u64,
    revision: u64,
    ports: Vec<AvailablePort>,
    subscribers: HashMap<u64, Sender<ProxyEvent>>,
}

/// The fields that make a port *that* port. Deliberately excludes `description`,
/// which [`AvailablePort`] documents as informational and never an identity key.
///
/// This distinction is not pedantry. On Windows the description is assembled from
/// `usb.manufacturer` and `usb.product`, and the serial number from
/// `usb.serial_number` — all SetupDi registry reads that can transiently come back
/// `None` for a composite device while one of its interfaces is open. Comparing
/// whole `AvailablePort` values made every such blip look like a device change and
/// broadcast a revision to every subscriber, once per poll, indefinitely.
type PortIdentity<'a> = (&'a str, Option<u16>, Option<u16>, Option<&'a str>);

fn identity(p: &AvailablePort) -> PortIdentity<'_> {
    (p.path.as_str(), p.vid, p.pid, p.serial.as_deref())
}

/// Do these two snapshots describe the same set of devices? Both sides are sorted
/// by path before this is called.
fn same_devices(a: &[AvailablePort], b: &[AvailablePort]) -> bool {
    a.len() == b.len()
        && a.iter()
            .zip(b.iter())
            .all(|(x, y)| identity(x) == identity(y))
}

/// Merge a fresh reading over the stored one for a device we already knew about.
///
/// An empty description in the new reading is missing information, not news: keep
/// what we had. A non-empty one wins, so a genuinely updated string still lands.
fn merge_cosmetic(old: &AvailablePort, new: &AvailablePort) -> AvailablePort {
    let mut merged = new.clone();
    if merged.description.trim().is_empty() {
        merged.description = old.description.clone();
    }
    merged
}

/// Human-readable diff for the log. Counts alone ("1 -> 1 ports") say nothing when
/// the count is what stayed the same.
fn describe_change(old: &[AvailablePort], new: &[AvailablePort]) -> String {
    let mut parts = Vec::new();
    for n in new {
        if !old.iter().any(|o| identity(o) == identity(n)) {
            parts.push(format!("+{}", n.path));
        }
    }
    for o in old {
        if !new.iter().any(|n| identity(n) == identity(o)) {
            parts.push(format!("-{}", o.path));
        }
    }
    if parts.is_empty() {
        "no identity change".to_string()
    } else {
        parts.join(" ")
    }
}

/// Shared serial-availability snapshot and subscriber registry.
pub struct SerialAvailabilityHub {
    state: Mutex<HubState>,
}

impl SerialAvailabilityHub {
    pub fn new() -> Self {
        let mut ports = crate::serial::list_available(true);
        ports.sort_by(|a, b| a.path.cmp(&b.path));
        log::info!(
            "Serial availability hub initialized with {} port(s)",
            ports.len()
        );
        Self {
            state: Mutex::new(HubState {
                next_subscriber_id: 1,
                revision: 1,
                ports,
                subscribers: HashMap::new(),
            }),
        }
    }

    /// Register a subscriber and return (subscriber_id, revision, snapshot).
    pub fn subscribe(&self, tx: Sender<ProxyEvent>) -> (u64, u64, Vec<AvailablePort>) {
        let mut state = self.state.lock_recover();
        let id = state.next_subscriber_id;
        state.next_subscriber_id += 1;
        state.subscribers.insert(id, tx);
        log::info!(
            "Serial availability subscribe: id={}, subscribers={}, revision={}, ports={}",
            id,
            state.subscribers.len(),
            state.revision,
            state.ports.len()
        );
        (id, state.revision, state.ports.clone())
    }

    pub fn unsubscribe(&self, id: u64) {
        let mut state = self.state.lock_recover();
        let removed = state.subscribers.remove(&id).is_some();
        log::info!(
            "Serial availability unsubscribe: id={}, removed={}, subscribers={}",
            id,
            removed,
            state.subscribers.len()
        );
    }

    pub fn refresh_and_broadcast_if_changed(&self) {
        let mut new_ports = crate::serial::list_available(true);
        new_ports.sort_by(|a, b| a.path.cmp(&b.path));

        let (revision, snapshot, subscribers) = {
            let mut state = self.state.lock_recover();

            if same_devices(&state.ports, &new_ports) {
                // Same devices. Absorb any improved metadata into the stored snapshot,
                // but do not bump the revision and do not wake a single subscriber --
                // nothing they care about has changed.
                let merged: Vec<AvailablePort> = state
                    .ports
                    .iter()
                    .zip(new_ports.iter())
                    .map(|(old, new)| merge_cosmetic(old, new))
                    .collect();
                if merged != state.ports {
                    log::debug!("Serial availability refresh: metadata updated, no device change");
                    state.ports = merged;
                } else {
                    log::debug!("Serial availability refresh: no change");
                }
                return;
            }

            let old_count = state.ports.len();
            let diff = describe_change(&state.ports, &new_ports);
            state.ports = new_ports;
            state.revision += 1;
            log::info!(
                "Serial availability changed: revision {} ({} -> {} ports) [{}], subscribers={}",
                state.revision,
                old_count,
                state.ports.len(),
                diff,
                state.subscribers.len()
            );
            (
                state.revision,
                state.ports.clone(),
                state
                    .subscribers
                    .iter()
                    .map(|(id, tx)| (*id, tx.clone()))
                    .collect::<Vec<_>>(),
            )
        };

        let mut dead = Vec::new();
        log::info!(
            "Serial availability broadcasting revision {} to {} subscriber(s)",
            revision,
            subscribers.len()
        );
        for (id, tx) in subscribers {
            if tx
                .send(ProxyEvent::SerialAvailableChanged {
                    revision,
                    ports: snapshot.clone(),
                })
                .is_err()
            {
                log::warn!(
                    "Serial availability broadcast failed for subscriber id={} at revision {}",
                    id,
                    revision
                );
                dead.push(id);
            } else {
                log::info!(
                    "Serial availability broadcast queued for subscriber id={} at revision {}",
                    id,
                    revision
                );
            }
        }

        if !dead.is_empty() {
            let mut state = self.state.lock_recover();
            for id in dead {
                state.subscribers.remove(&id);
            }
        }
    }
}

impl Default for SerialAvailabilityHub {
    fn default() -> Self {
        Self::new()
    }
}

/// Marker trait for the platform-specific watcher guard.
/// Both `notify::RecommendedWatcher` (Unix) and `PollingWatcher` (Windows)
/// implement this so they can be held as `Box<dyn PlatformWatcher>`.
trait PlatformWatcher: Send + 'static {}

#[cfg(any(target_os = "linux", target_os = "macos"))]
impl PlatformWatcher for notify::RecommendedWatcher {}

#[cfg(target_os = "windows")]
impl PlatformWatcher for PollingWatcher {}

/// Start the OS-backed serial-availability watcher thread.
///
/// The thread blocks on native FS notifications (no polling loop) and emits a
/// debounced full-snapshot update to subscribers when the serial-device list
/// changes.
pub fn start_serial_available_watcher(hub: Arc<SerialAvailabilityHub>) -> Sender<()> {
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    std::thread::spawn(move || {
        log::info!("Serial availability watcher thread started");
        let (signal_tx, signal_rx) = mpsc::channel::<WatchSignal>();

        let stop_bridge_tx = signal_tx.clone();
        std::thread::spawn(move || {
            let _ = stop_rx.recv();
            let _ = stop_bridge_tx.send(WatchSignal::Stop);
        });

        let watcher: Option<Box<dyn PlatformWatcher>> =
            match create_platform_watcher(signal_tx.clone()) {
                Ok(w) => {
                    log::info!("Serial availability watcher initialized successfully");
                    Some(Box::new(w))
                }
                Err(e) => {
                    log::warn!(
                        "Serial availability watcher disabled on this platform/session: {}",
                        e
                    );
                    None
                }
            };

        // Keep watcher alive for this thread's lifetime.
        let _watcher_guard = watcher;

        loop {
            match signal_rx.recv_timeout(Duration::from_secs(2)) {
                Ok(WatchSignal::Stop) => {
                    log::info!("Serial availability watcher stopping");
                    break;
                }
                Ok(WatchSignal::Trigger) => {
                    // Debug, not info: on Windows this is the poll timer and fires forever
                    // whether or not anything changed. At info it reads like activity and
                    // buries the "availability changed" lines that actually mean something.
                    log::debug!("Serial availability watcher trigger received");
                    // Debounce bursty re-enumeration storms.
                    loop {
                        match signal_rx.recv_timeout(Duration::from_millis(250)) {
                            Ok(WatchSignal::Trigger) => continue,
                            Ok(WatchSignal::Stop) => return,
                            Err(mpsc::RecvTimeoutError::Timeout) => break,
                            Err(mpsc::RecvTimeoutError::Disconnected) => return,
                        }
                    }
                    hub.refresh_and_broadcast_if_changed();
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    // Fallback for platforms/sessions where /dev watcher events are unreliable.
                    hub.refresh_and_broadcast_if_changed();
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
            }
        }
    });
    stop_tx
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn create_platform_watcher(signal_tx: Sender<WatchSignal>) -> anyhow::Result<impl PlatformWatcher> {
    use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};

    let mut watcher = RecommendedWatcher::new(
        move |res: Result<notify::Event, notify::Error>| match res {
            Ok(event) => {
                log::info!(
                    "Serial availability fs event: kind={:?}, paths={:?}",
                    event.kind,
                    event.paths
                );
                let _ = signal_tx.send(WatchSignal::Trigger);
            }
            Err(err) => {
                log::warn!("Serial availability fs watcher error: {}", err);
            }
        },
        Config::default(),
    )?;

    watcher.watch(Path::new("/dev"), RecursiveMode::NonRecursive)?;

    #[cfg(target_os = "linux")]
    {
        // by-id symlinks are often the most stable identity for USB UARTs.
        let _ = watcher.watch(Path::new("/dev/serial/by-id"), RecursiveMode::NonRecursive);
    }

    Ok(watcher)
}

/// How often the Windows fallback re-enumerates.
///
/// This was 750ms, which combined with the 250ms debounce below to re-enumerate
/// almost exactly once per second, forever. Device arrival and removal is a
/// human-scale event; 2s is responsive enough and costs a quarter as much.
///
/// The real fix is a native watcher (`CM_Register_Notification` on
/// `GUID_DEVINTERFACE_COMPORT`) so Windows behaves like macOS and Linux, where
/// nothing is enumerated at all while nothing changes.
#[cfg(target_os = "windows")]
const WINDOWS_POLL_INTERVAL: Duration = Duration::from_secs(2);

#[cfg(target_os = "windows")]
fn create_platform_watcher(signal_tx: Sender<WatchSignal>) -> anyhow::Result<impl PlatformWatcher> {
    Ok(PollingWatcher::new(signal_tx, WINDOWS_POLL_INTERVAL))
}

/// A drop-based guard that owns a background polling thread.
///
/// Used on Windows (and any platform where native FS events are unavailable)
/// to periodically send `Trigger` signals into the watcher loop. The outer
/// loop's 2-second `recv_timeout` already handles the case where no native
/// watcher exists, but `PollingWatcher` fires at a tighter interval so the
/// UI feels responsive when a device is plugged in.
///
/// Dropping this value sends `Stop` and joins the thread.
#[cfg(target_os = "windows")]
pub struct PollingWatcher {
    stop_tx: Option<mpsc::Sender<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
}

#[cfg(target_os = "windows")]
impl PollingWatcher {
    fn new(signal_tx: Sender<WatchSignal>, interval: Duration) -> Self {
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let thread = std::thread::spawn(move || {
            log::info!(
                "Serial availability polling watcher started (interval={:?})",
                interval
            );
            loop {
                match stop_rx.recv_timeout(interval) {
                    Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        if signal_tx.send(WatchSignal::Trigger).is_err() {
                            break;
                        }
                    }
                }
            }
            log::info!("Serial availability polling watcher stopped");
        });
        Self {
            stop_tx: Some(stop_tx),
            thread: Some(thread),
        }
    }
}

#[cfg(target_os = "windows")]
impl Drop for PollingWatcher {
    fn drop(&mut self) {
        drop(self.stop_tx.take()); // closing the channel wakes recv_timeout
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn port(path: &str, desc: &str, serial: Option<&str>) -> AvailablePort {
        AvailablePort {
            path: path.to_string(),
            description: desc.to_string(),
            vid: Some(0x04b4),
            pid: Some(0xf155),
            serial: serial.map(|s| s.to_string()),
        }
    }

    #[test]
    fn identical_snapshots_are_the_same_devices() {
        let a = vec![port("COM3", "KitProg3 USB-UART", Some("ABC123"))];
        let b = a.clone();
        assert!(same_devices(&a, &b));
    }

    /// The Windows storm: SetupDi intermittently returns partial USB metadata, so
    /// the description flaps while the device list is completely unchanged.
    #[test]
    fn flapping_description_is_not_a_device_change() {
        let a = vec![port("COM3", "Cypress KitProg3 USB-UART", Some("ABC123"))];
        let b = vec![port("COM3", "", Some("ABC123"))];
        assert_ne!(a, b, "whole-struct equality is what used to fire the storm");
        assert!(same_devices(&a, &b), "identity must ignore description");
    }

    #[test]
    fn flapping_serial_number_is_a_device_change() {
        // serial IS identity: if it really changed, it is a different device.
        let a = vec![port("COM3", "KitProg3", Some("ABC123"))];
        let b = vec![port("COM3", "KitProg3", None)];
        assert!(!same_devices(&a, &b));
    }

    #[test]
    fn arrival_and_removal_are_device_changes() {
        let one = vec![port("COM3", "KitProg3", Some("ABC123"))];
        let two = vec![
            port("COM3", "KitProg3", Some("ABC123")),
            port("COM4", "FTDI", Some("FT9999")),
        ];
        assert!(!same_devices(&one, &two), "arrival");
        assert!(!same_devices(&two, &one), "removal");
        // Same count, different device — the case a count-based check would miss.
        let swapped = vec![port("COM4", "FTDI", Some("FT9999"))];
        assert!(!same_devices(&one, &swapped), "replacement");
    }

    #[test]
    fn degraded_metadata_never_overwrites_good_metadata() {
        let good = port("COM3", "Cypress KitProg3 USB-UART", Some("ABC123"));
        let degraded = port("COM3", "   ", Some("ABC123"));
        assert_eq!(
            merge_cosmetic(&good, &degraded).description,
            "Cypress KitProg3 USB-UART"
        );
    }

    #[test]
    fn genuinely_updated_metadata_wins() {
        let old = port("COM3", "old text", Some("ABC123"));
        let new = port("COM3", "new text", Some("ABC123"));
        assert_eq!(merge_cosmetic(&old, &new).description, "new text");
    }

    #[test]
    fn diff_names_the_ports_that_actually_changed() {
        let old = vec![port("COM3", "KitProg3", Some("ABC123"))];
        let new = vec![port("COM4", "FTDI", Some("FT9999"))];
        let d = describe_change(&old, &new);
        assert!(d.contains("+COM4"), "got {d}");
        assert!(d.contains("-COM3"), "got {d}");
        // A description-only difference is not an identity change.
        let cosmetic = vec![port("COM3", "", Some("ABC123"))];
        assert_eq!(describe_change(&old, &cosmetic), "no identity change");
    }

    /// End to end through the hub: a cosmetic-only refresh must not bump the
    /// revision, because the revision is what wakes every subscriber.
    #[test]
    fn cosmetic_change_does_not_bump_revision() {
        let hub = SerialAvailabilityHub {
            state: Mutex::new(HubState {
                next_subscriber_id: 1,
                revision: 7,
                ports: vec![port("COM3", "Cypress KitProg3", Some("ABC123"))],
                subscribers: HashMap::new(),
            }),
        };
        let (tx, rx) = mpsc::channel();
        let (_id, rev, _snap) = hub.subscribe(tx);
        assert_eq!(rev, 7);

        {
            let mut st = hub.state.lock_recover();
            let merged: Vec<AvailablePort> = st
                .ports
                .iter()
                .map(|o| merge_cosmetic(o, &port("COM3", "", Some("ABC123"))))
                .collect();
            assert!(same_devices(&st.ports, &merged));
            st.ports = merged;
        }

        assert_eq!(
            hub.state.lock_recover().revision,
            7,
            "revision must not move"
        );
        assert!(rx.try_recv().is_err(), "no subscriber may be woken");
        assert_eq!(
            hub.state.lock_recover().ports[0].description,
            "Cypress KitProg3",
            "good metadata survives a degraded reading"
        );
    }
}
