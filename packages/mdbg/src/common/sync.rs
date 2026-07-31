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

//! Poison-resilient locking.
//!
//! The Probe Agent is a singleton that serves many debug sessions from one
//! process (see `docs-internal/CLI-Proxy-Provisioning.md` §7.3). A thread that
//! panics while holding a `Mutex` shared across sessions *poisons* it, and the
//! usual `.lock().unwrap()` would then re-panic in **every other** session that
//! touches the lock — turning one session's fault into a cross-session cascade.
//!
//! [`MutexExt::lock_recover`] takes the guard from a poisoned lock instead of
//! panicking. This is sound for our shared state because every shared critical
//! section is short and holds no invariant a panic could leave half-updated
//! (audited); the worst case is observing bytes/state written up to the panic
//! point. Use `.lock_recover()` for shared `Mutex`es; the `clippy.toml`
//! `disallowed-methods` entry turns a raw `Mutex::lock()` into a lint so the
//! pattern cannot silently regress.

use std::sync::{Mutex, MutexGuard};

/// Extension on [`std::sync::Mutex`] that recovers from lock poisoning.
pub trait MutexExt<T: ?Sized> {
    /// Lock the mutex, recovering the guard if a previous holder panicked while
    /// holding it (poisoning). Never panics on poison.
    fn lock_recover(&self) -> MutexGuard<'_, T>;
}

impl<T: ?Sized> MutexExt<T> for Mutex<T> {
    #[allow(clippy::disallowed_methods)] // the single sanctioned `Mutex::lock` call
    fn lock_recover(&self) -> MutexGuard<'_, T> {
        self.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}
