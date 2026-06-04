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
use std::path::Path;
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

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

/// Shared serial-availability snapshot and subscriber registry.
pub struct SerialAvailabilityHub {
    state: Mutex<HubState>,
}

impl SerialAvailabilityHub {
    pub fn new() -> Self {
        let mut ports = crate::serial::list_available();
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
        let mut state = self.state.lock().unwrap();
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
        let mut state = self.state.lock().unwrap();
        let removed = state.subscribers.remove(&id).is_some();
        log::info!(
            "Serial availability unsubscribe: id={}, removed={}, subscribers={}",
            id,
            removed,
            state.subscribers.len()
        );
    }

    pub fn refresh_and_broadcast_if_changed(&self) {
        let mut new_ports = crate::serial::list_available();
        new_ports.sort_by(|a, b| a.path.cmp(&b.path));

        let (revision, snapshot, subscribers) = {
            let mut state = self.state.lock().unwrap();
            if state.ports == new_ports {
                log::debug!("Serial availability refresh: no change");
                return;
            }
            let old_count = state.ports.len();
            state.ports = new_ports;
            state.revision += 1;
            log::info!(
                "Serial availability changed: revision {} ({} -> {} ports), subscribers={}",
                state.revision,
                old_count,
                state.ports.len(),
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
            let mut state = self.state.lock().unwrap();
            for id in dead {
                state.subscribers.remove(&id);
            }
        }
    }
}

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

        let watcher = match create_platform_watcher(signal_tx.clone()) {
            Ok(w) => {
                log::info!("Serial availability watcher initialized successfully");
                Some(w)
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
                    log::info!("Serial availability watcher trigger received");
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
fn create_platform_watcher(
    signal_tx: Sender<WatchSignal>,
) -> anyhow::Result<notify::RecommendedWatcher> {
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

#[cfg(target_os = "windows")]
fn create_platform_watcher(
    _signal_tx: Sender<WatchSignal>,
) -> anyhow::Result<notify::RecommendedWatcher> {
    anyhow::bail!(
        "Windows serial hotplug watcher is not implemented yet in proxy-helper (CM_Register_Notification backend pending)"
    )
}
