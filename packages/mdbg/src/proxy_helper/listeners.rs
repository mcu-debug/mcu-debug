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

//! Accepting on more than one address at a time.
//!
//! The proxy is a singleton, and it used to bind exactly one address for its whole
//! life. That was a dead end: a proxy that came up on `127.0.0.1` could not later be
//! reached by a WSL or Docker guest, and the only recourse was killing it — taking
//! every live debug session with it.
//!
//! The fix is to *add* a listener, not to rebind. Rebinding means close-then-bind,
//! which leaves the port unowned for a moment; lose that race (the Windows ephemeral
//! range is crowded — see the `wslrelay.exe` notes in `find-free-ports.ts`) and the
//! proxy ends up with no listener at all while `endpoint.json` still advertises the
//! port. Adding has no such window: the original listener is never released, so the
//! published port stays valid no matter what happens to the new one.
//!
//! This works because two distinct *specific* addresses may share a port on every
//! platform we target. Only the wildcard conflicts with a specific address, and only
//! on Linux. So a widened address must be a concrete interface address (the WSL
//! gateway IP), never `0.0.0.0` — which is what we want anyway, since the wildcard
//! exposes the proxy far more broadly than the one guest that asked for it.
//!
//! Narrowing is equally cheap. Accepted connections are independent of the listener
//! that produced them — they are separate kernel objects, keyed by their own 4-tuple —
//! so dropping a listener stops *new* connections on that address and disturbs nothing
//! already running.

use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::thread;
use std::time::Duration;

use crate::common::sync::MutexExt;
use crate::proxy_helper::admin::{self, AdminContext};
use crate::proxy_helper::lifetime::Lifetime;
use crate::proxy_helper::proxy_server::{ProxyServer, SerialPortRegistry};
use crate::proxy_helper::run::ProxyArgs;
use crate::proxy_helper::serial_available::SerialAvailabilityHub;

/// Everything an accept loop needs to service a connection. One instance is shared
/// (by `Arc`) across every listener, so a connection is handled identically no matter
/// which address it arrived on.
/// `pub` for the same reason as [`AcceptSet`]: it is reachable through `AcceptSet::add`.
pub struct AcceptCtx {
    /// Template for the per-connection `ProxyArgs`. Already normalized for a child
    /// connection (`heartbeat: false`, `daemonized: true`, no admin-mode flags), so
    /// accept sites can clone it rather than rebuild it field by field.
    pub conn_args: ProxyArgs,
    /// Global graceful shutdown: every accept loop exits when this is set.
    pub stop_flag: Arc<AtomicBool>,
    /// Admin `shutdown`: refuse new sessions, let existing ones finish.
    pub draining: Arc<AtomicBool>,
    pub lifetime: Arc<Lifetime>,
    pub admin_ctx: Arc<AdminContext>,
    pub serial_registry: SerialPortRegistry,
    pub serial_available_hub: Arc<SerialAvailabilityHub>,
    /// Handles for in-flight connection threads. Shared because any listener can add
    /// to it; the main thread drains and joins it during shutdown so every
    /// `ProxyServer` is dropped (killing its gdb-server children) before we exit.
    pub client_threads: Mutex<Vec<thread::JoinHandle<()>>>,
}

impl AcceptCtx {
    /// Park a connection thread handle for the shutdown join.
    fn track(&self, handle: thread::JoinHandle<()>) {
        self.client_threads.lock_recover().push(handle);
    }

    /// Take every tracked handle, leaving the registry empty.
    pub fn take_client_threads(&self) -> Vec<thread::JoinHandle<()>> {
        std::mem::take(&mut *self.client_threads.lock_recover())
    }
}

/// One listener the proxy is currently accepting on.
struct Bound {
    /// Per-listener stop flag, so a widened address can be withdrawn without
    /// disturbing loopback. The global `stop_flag` stops all of them at once.
    /// Only `remove` reads it — see the note there about dead-code warnings.
    #[allow(dead_code)]
    stop: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
}

/// The set of addresses this proxy accepts on, keyed by address.
///
/// Shutdown has to wake *every* blocked `accept()`, not just loopback's, which is why
/// the addresses are registered here rather than being implied by a single port.
/// `pub` rather than `pub(crate)` only because `AdminContext` is public and holds one.
#[derive(Default)]
pub struct AcceptSet {
    bound: Mutex<HashMap<SocketAddr, Bound>>,
    /// Context handed to accept loops started *after* startup (the widen path).
    ///
    /// `Weak` breaks what would otherwise be a cycle: an `AcceptCtx` holds the
    /// `AdminContext`, which holds this set. `run()` owns the only strong reference for
    /// as long as the proxy is alive, so upgrading here fails only during teardown.
    ctx: Mutex<Option<std::sync::Weak<AcceptCtx>>>,
}

impl AcceptSet {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record the context later listeners should use. Called once, from `run()`, as
    /// soon as the context exists.
    pub fn set_ctx(&self, ctx: &Arc<AcceptCtx>) {
        *self.ctx.lock_recover() = Some(Arc::downgrade(ctx));
    }

    /// Addresses currently being accepted on, for `--status` and for waking.
    pub fn addrs(&self) -> Vec<SocketAddr> {
        self.bound.lock_recover().keys().copied().collect()
    }

    pub fn contains(&self, addr: &SocketAddr) -> bool {
        self.bound.lock_recover().contains_key(addr)
    }

    /// The IPv4 addresses being accepted on, as strings, ascending. For `--status`
    /// and for the `hosts` list published in discovery and `endpoint.json`.
    pub fn hosts(&self) -> Vec<String> {
        let mut hosts: Vec<String> = self.addrs().into_iter().map(|a| a.ip().to_string()).collect();
        hosts.sort();
        hosts.dedup();
        hosts
    }

    /// Bind `host` on `port` and start accepting on it, leaving every existing
    /// listener untouched.
    ///
    /// This is the widen path: a proxy that came up on loopback can be made reachable
    /// by a WSL/Docker guest without a restart, so live debug sessions survive.
    /// Already-bound is success — the caller asked for the address to be served, and
    /// it is.
    pub fn widen(&self, host: Ipv4Addr, port: u16) -> Result<SocketAddr, String> {
        is_widenable(host)?;
        let addr = SocketAddr::new(host.into(), port);
        if self.contains(&addr) {
            return Ok(addr);
        }
        let ctx = self
            .ctx
            .lock_recover()
            .as_ref()
            .and_then(|w| w.upgrade())
            .ok_or_else(|| "proxy is shutting down".to_string())?;
        let listener = TcpListener::bind(addr).map_err(|e| format!("could not bind {addr}: {e}"))?;
        self.add(listener, ctx)
            .map_err(|e| format!("could not accept on {addr}: {e}"))
    }

    /// Stop accepting on `host`. The inverse of [`widen`](Self::widen).
    pub fn narrow(&self, host: Ipv4Addr, port: u16) -> Result<bool, String> {
        if host.is_loopback() {
            return Err("refusing to stop accepting on loopback".to_string());
        }
        Ok(self.remove(&SocketAddr::new(host.into(), port)))
    }

    /// Start accepting on `listener` in its own thread. Returns the bound address.
    ///
    /// Re-registering an address already in the set is a caller bug rather than a
    /// runtime condition — the kernel would have refused the duplicate bind — so it
    /// is reported as an error and the listener is dropped.
    pub fn add(&self, listener: TcpListener, ctx: Arc<AcceptCtx>) -> std::io::Result<SocketAddr> {
        let addr = listener.local_addr()?;
        let stop = Arc::new(AtomicBool::new(false));
        let stop_thread = Arc::clone(&stop);
        let mut guard = self.bound.lock_recover();
        if guard.contains_key(&addr) {
            return Err(std::io::Error::other(format!("already accepting on {addr}")));
        }
        let thread = thread::Builder::new()
            .name(format!("accept-{addr}"))
            .spawn(move || accept_loop(listener, ctx, stop_thread))?;
        guard.insert(
            addr,
            Bound {
                stop,
                thread: Some(thread),
            },
        );
        log::info!("Accepting on {addr}");
        Ok(addr)
    }

    /// Stop accepting on `addr` and wait for its thread to finish.
    ///
    /// Live sessions that arrived on this address keep running — only the door closes.
    /// Returns false if the address was not in the set.
    ///
    /// Refuses to remove the last listener: a proxy with no way in is worse than one
    /// bound too widely, and `endpoint.json` would still advertise the port.
    pub fn remove(&self, addr: &SocketAddr) -> bool {
        let mut entry = {
            let mut guard = self.bound.lock_recover();
            if guard.len() <= 1 {
                log::warn!("Refusing to stop accepting on {addr}: it is the only listener");
                return false;
            }
            match guard.remove(addr) {
                Some(e) => e,
                None => return false,
            }
        };
        entry.stop.store(true, Ordering::SeqCst);
        // The loop is parked in accept(); it only re-checks the flag after a
        // connection arrives, so give it one.
        wake(addr);
        if let Some(t) = entry.thread.take() {
            if let Err(e) = t.join() {
                log::warn!("accept thread for {addr} panicked on exit: {e:?}");
            }
        }
        log::info!("Stopped accepting on {addr}");
        true
    }

    /// Wake every blocked `accept()` so each loop re-checks the stop flags.
    pub fn wake_all(&self) {
        for addr in self.addrs() {
            wake(&addr);
        }
    }

    /// Join every accept thread, blocking until they all exit.
    ///
    /// The entries stay in the map while we wait, and only the `JoinHandle` is taken.
    /// That matters: shutdown is triggered from *another* thread (the idle monitor or
    /// an admin connection), which sets the stop flag and then calls `wake_all`. If
    /// this drained the map up front, that `wake_all` would find no addresses, no
    /// `accept()` would ever unblock, and the join below would hang forever.
    pub fn join_all(&self) {
        loop {
            let next = self
                .bound
                .lock_recover()
                .iter_mut()
                .find_map(|(addr, b)| b.thread.take().map(|t| (*addr, t)));
            let Some((addr, thread)) = next else { break };
            if let Err(e) = thread.join() {
                log::warn!("accept thread for {addr} panicked on exit: {e:?}");
            }
        }
        self.bound.lock_recover().clear();
    }
}

/// The addresses a freshly started proxy should bind, given what the caller asked for.
///
/// Loopback is always served, because local tooling (`--status`, the CLI, another
/// window) must be able to reach the proxy no matter what the *first* caller happened
/// to request. Before multi-listener support, `--host 172.28.240.1` bound only that
/// address and left local clients with nothing to dial.
///
/// The wildcard is the one case where "also bind loopback" must not be taken
/// literally: `0.0.0.0` already accepts loopback connections, and binding both on the
/// same port is `EADDRINUSE` on Linux (Windows and macOS treat them as independent
/// endpoints — see the module docs). So a wildcard request yields the wildcard alone.
pub fn planned_bind_addrs(requested: Ipv4Addr) -> Vec<Ipv4Addr> {
    if requested.is_unspecified() {
        return vec![requested];
    }
    if requested == Ipv4Addr::LOCALHOST {
        return vec![Ipv4Addr::LOCALHOST];
    }
    vec![Ipv4Addr::LOCALHOST, requested]
}

/// Whether `host` may be *added* to a running proxy.
///
/// Only concrete addresses. The wildcard is refused on purpose: it cannot be added
/// alongside the existing loopback listener on Linux, and it would widen the proxy to
/// every interface when the caller only needed one virtual adapter — a different
/// security posture than the one the request implies.
pub fn is_widenable(host: Ipv4Addr) -> Result<(), String> {
    if host.is_unspecified() {
        return Err("refusing to widen to the wildcard 0.0.0.0; name a specific interface address".to_string());
    }
    if host.is_loopback() {
        return Err("loopback is always bound; nothing to widen".to_string());
    }
    Ok(())
}

/// Unblock one `accept()` by connecting to it. The connection is discarded
/// immediately; the loop notices its stop flag and never dispatches it.
///
/// A wildcard address is a bind target, not a connect target, so dial loopback for
/// `0.0.0.0` — a wildcard listener accepts loopback connections.
fn wake(addr: &SocketAddr) {
    let target = if addr.ip().is_unspecified() {
        SocketAddr::new(std::net::Ipv4Addr::LOCALHOST.into(), addr.port())
    } else {
        *addr
    };
    // A short timeout matters for a widened address: if the interface went away
    // (a WSL shutdown), connect() can otherwise hang the shutdown path.
    if let Err(e) = TcpStream::connect_timeout(&target, Duration::from_secs(2)) {
        log::warn!("Self-connect to {target} failed: {e} — accept loop may not unblock immediately");
    }
}

/// Accept connections until either the global stop flag or this listener's own stop
/// flag is set.
///
/// We generally do not have multiple clients when running inside a VS Code extension,
/// but multi-core debugging gives each core its own proxy connection, so this must
/// handle concurrent sessions without crashing or interleaving them.
fn accept_loop(listener: TcpListener, ctx: Arc<AcceptCtx>, stop: Arc<AtomicBool>) {
    let addr = listener
        .local_addr()
        .map(|a| a.to_string())
        .unwrap_or_else(|_| "<unknown>".to_string());

    let stopping =
        |ctx: &AcceptCtx, stop: &AtomicBool| ctx.stop_flag.load(Ordering::SeqCst) || stop.load(Ordering::SeqCst);

    for stream in listener.incoming() {
        // Shutdown check: whoever set a stop flag also sent a self-connection to
        // unblock this accept(). Drop the stream and stop.
        if stopping(&ctx, &stop) {
            log::info!("Accept loop on {addr} stopping");
            break;
        }
        match stream {
            Ok(stream) => {
                // Draining (admin shutdown): refuse new connections; existing
                // sessions run to completion, then the proxy exits.
                if ctx.draining.load(Ordering::SeqCst) {
                    log::info!("Draining — refusing new connection on {addr}");
                    let _ = stream.shutdown(std::net::Shutdown::Both);
                    continue;
                }
                let conn_args = ctx.conn_args.clone();
                let registry = Arc::clone(&ctx.serial_registry);
                let hub = Arc::clone(&ctx.serial_available_hub);
                let lifetime = Arc::clone(&ctx.lifetime);
                let admin_ctx = Arc::clone(&ctx.admin_ctx);
                let handle = thread::spawn(move || match admin::discriminate(&stream) {
                    admin::Kind::Session => {
                        // Session ref held for the session's lifetime; its drop
                        // (session end) may arm the idle timer.
                        let _session_ref = lifetime.acquire();
                        let mut new_client = ProxyServer::new(conn_args, stream, registry, hub);
                        new_client.message_loop().unwrap_or_else(|e| {
                            log::error!("Error in client message loop: {}", e);
                        });
                    }
                    admin::Kind::Admin => admin::handle(stream, &admin_ctx),
                    admin::Kind::Unknown => {
                        log::warn!("Unrecognized connection (no session/admin prefix) — closing");
                        let _ = stream.shutdown(std::net::Shutdown::Both);
                    }
                });
                ctx.track(handle);
            }
            Err(e) => {
                if stopping(&ctx, &stop) {
                    // Expected error from the self-connect wakeup; ignore it.
                    log::info!("Accept loop on {addr} ignoring accept error during shutdown: {e}");
                    break;
                }
                log::error!("Connection failed on {addr}: {}", e);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    /// Pick a free port by binding loopback and handing back the port. The listener is
    /// dropped, so the caller races anyone else on the machine — acceptable for a test,
    /// and retried by the caller where it matters.
    fn free_port() -> u16 {
        let l = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("bind ephemeral");
        l.local_addr().expect("local_addr").port()
    }

    /// A second IPv4 address this host will actually accept a bind on, standing in for
    /// the WSL gateway IP that widening targets in production.
    ///
    /// `127.0.0.2` works on Linux, where the whole 127/8 is local, but not on macOS or
    /// Windows, which assign only `127.0.0.1` unless you add an alias. So fall back to
    /// the address the default route would use, discovered by `connect`ing a UDP socket
    /// — that sends no packets, it only makes the kernel pick a source address.
    ///
    /// Returns `None` on a host with no usable second address (an isolated CI
    /// container), where the tests below have nothing to assert and skip instead.
    fn second_local_addr() -> Option<Ipv4Addr> {
        let candidate = Ipv4Addr::new(127, 0, 0, 2);
        if TcpListener::bind((candidate, 0)).is_ok() {
            return Some(candidate);
        }
        let sock = std::net::UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
        sock.connect("8.8.8.8:80").ok()?;
        match sock.local_addr().ok()? {
            SocketAddr::V4(a) if !a.ip().is_loopback() && !a.ip().is_unspecified() => Some(*a.ip()),
            _ => None,
        }
    }

    /// The property the whole design rests on: a second listener on the *same port* but
    /// a different specific address binds successfully. If this ever fails on a target
    /// platform, widening-by-adding is not available there and the design must change.
    #[test]
    fn two_specific_addresses_can_share_a_port() {
        let Some(alt) = second_local_addr() else {
            eprintln!("skipping: no second local address available on this host");
            return;
        };
        let first = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("bind loopback");
        let port = first.local_addr().unwrap().port();
        let second = TcpListener::bind((alt, port));
        assert!(
            second.is_ok(),
            "a second specific address ({alt}) must be bindable on the same port as \
             loopback; without this, widening-by-adding is unavailable and the proxy \
             would have to rebind: {:?}",
            second.err()
        );
    }

    /// Dropping a listener must not disturb a connection it already accepted. This is
    /// why narrowing is safe to do underneath live debug sessions.
    #[test]
    fn accepted_connection_survives_its_listener_being_dropped() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("bind");
        let port = listener.local_addr().unwrap().port();

        let server = thread::spawn(move || {
            let (mut sock, _) = listener.accept().expect("accept");
            let mut buf = [0u8; 4];
            sock.read_exact(&mut buf).expect("read");
            // The listener dies here, while the accepted socket is still in use.
            drop(listener);
            sock.write_all(b"still-alive").expect("write after drop");
        });

        let mut client = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).expect("connect");
        client.write_all(b"ping").expect("write");
        let mut got = String::new();
        client.read_to_string(&mut got).expect("read");
        server.join().expect("server thread");

        assert_eq!(got, "still-alive");
    }

    /// `wake` must dial loopback for a wildcard listener: `0.0.0.0` is a bind address,
    /// and connecting to it is not portable.
    #[test]
    fn wake_unblocks_a_wildcard_listener() {
        let listener = match TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0)) {
            Ok(l) => l,
            // Some sandboxes forbid a wildcard bind; the behavior under test is
            // `wake`'s address rewrite, which is not worth failing CI over.
            Err(e) => {
                eprintln!("skipping: wildcard bind unavailable: {e}");
                return;
            }
        };
        let addr = listener.local_addr().unwrap();
        assert!(addr.ip().is_unspecified());

        let accepted = thread::spawn(move || listener.accept().map(|_| ()).is_ok());
        wake(&addr);
        assert!(
            accepted.join().expect("accept thread"),
            "wake must produce a connection"
        );
    }

    /// A stopped listener frees its port, and the accept thread exits rather than
    /// leaking. `remove` is the narrowing path.
    ///
    /// Two listeners are registered because the set refuses to remove the last one —
    /// see `the_last_listener_cannot_be_removed`. They use different ports so the
    /// release is observable: on a shared port, removing one address frees nothing.
    #[test]
    fn remove_stops_accepting_and_frees_the_port() {
        let ctx = Arc::new(test_ctx());
        let set = AcceptSet::new();

        let keep = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("bind keeper");
        set.add(keep, Arc::clone(&ctx)).expect("add keeper");

        let port = free_port();
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, port)).expect("bind");
        let addr = set.add(listener, Arc::clone(&ctx)).expect("add");
        assert!(set.contains(&addr));

        assert!(set.remove(&addr), "remove must report the address was present");
        assert!(!set.contains(&addr));
        assert!(!set.remove(&addr), "removing twice must be a no-op");

        // The port is genuinely released once the accept thread has exited.
        TcpListener::bind((Ipv4Addr::LOCALHOST, port)).expect("port must be free after remove");

        ctx.stop_flag.store(true, Ordering::SeqCst);
        set.wake_all();
        set.join_all();
    }

    /// Loopback is always served, whatever the caller asked for. Before multi-listener
    /// support, `--host 172.28.240.1` bound *only* that address and local tooling had
    /// nothing to dial.
    #[test]
    fn a_specific_host_is_bound_alongside_loopback() {
        let gateway = Ipv4Addr::new(172, 28, 240, 1);
        let plan = planned_bind_addrs(gateway);

        assert_eq!(plan, vec![Ipv4Addr::LOCALHOST, gateway]);
        assert_eq!(plan[0], Ipv4Addr::LOCALHOST, "loopback binds first, fixing the port");
    }

    /// The wildcard is the exception: it already accepts loopback, and binding both on
    /// one port is EADDRINUSE on Linux. "Always serve loopback" is about reachability,
    /// not about literally holding a second socket.
    #[test]
    fn the_wildcard_is_bound_alone() {
        assert_eq!(planned_bind_addrs(Ipv4Addr::UNSPECIFIED), vec![Ipv4Addr::UNSPECIFIED]);
    }

    /// Asking for loopback explicitly must not plan it twice — the second bind would
    /// fail and be reported as an error for an address that is in fact served.
    #[test]
    fn requesting_loopback_plans_a_single_bind() {
        assert_eq!(planned_bind_addrs(Ipv4Addr::LOCALHOST), vec![Ipv4Addr::LOCALHOST]);
    }

    /// A running proxy may only be widened to a concrete address. The wildcard cannot
    /// be added next to the existing loopback listener on Linux, and it would expose
    /// every interface when the caller needed one virtual adapter.
    #[test]
    fn widening_rejects_the_wildcard_and_loopback() {
        assert!(is_widenable(Ipv4Addr::new(172, 28, 240, 1)).is_ok());

        let wildcard = is_widenable(Ipv4Addr::UNSPECIFIED).expect_err("wildcard must be refused");
        assert!(
            wildcard.contains("0.0.0.0"),
            "the error names what was refused: {wildcard}"
        );

        // Not an error the caller can act on, but not a widening either.
        assert!(is_widenable(Ipv4Addr::LOCALHOST).is_err());
    }

    /// Narrowing must never leave the proxy with no way in. `endpoint.json` would still
    /// advertise the port, so every client would fail to connect with nothing to
    /// explain why — strictly worse than staying bound one address too wide.
    #[test]
    fn the_last_listener_cannot_be_removed() {
        let ctx = Arc::new(test_ctx());
        let set = AcceptSet::new();

        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("bind");
        let addr = set.add(listener, Arc::clone(&ctx)).expect("add");

        assert!(!set.remove(&addr), "the only listener must not be removable");
        assert!(set.contains(&addr), "and it must still be accepting");

        ctx.stop_flag.store(true, Ordering::SeqCst);
        set.wake_all();
        set.join_all();
    }

    /// Removing one address must leave the others accepting — this is exactly the
    /// narrowing case: withdraw the widened address, keep loopback serving.
    #[test]
    fn removing_one_address_leaves_the_others_accepting() {
        let Some(alt_ip) = second_local_addr() else {
            eprintln!("skipping: no second local address available on this host");
            return;
        };
        let ctx = Arc::new(test_ctx());
        let set = AcceptSet::new();

        let port = free_port();
        let lo = TcpListener::bind((Ipv4Addr::LOCALHOST, port)).expect("bind loopback");
        let alt = TcpListener::bind((alt_ip, port)).expect("bind alt");
        let lo_addr = set.add(lo, Arc::clone(&ctx)).expect("add loopback");
        let alt_addr = set.add(alt, Arc::clone(&ctx)).expect("add alt");
        assert_eq!(set.addrs().len(), 2);

        assert!(set.remove(&alt_addr));
        assert!(set.contains(&lo_addr), "loopback must still be accepting");

        // Prove it, rather than trusting the bookkeeping: loopback still answers.
        // (The proxy will treat this as an unrecognized connection and close it —
        // irrelevant here, since what is under test is that accept() still fires.)
        TcpStream::connect(lo_addr).expect("loopback must still accept connections");

        ctx.stop_flag.store(true, Ordering::SeqCst);
        set.wake_all();
        set.join_all();
    }

    /// Shutdown is triggered from another thread (the idle monitor, or an admin
    /// connection) while the main thread is already blocked in `join_all`. This pins
    /// that ordering, which is the one that deadlocks if `join_all` empties the address
    /// map before joining: `wake_all` would then find nothing to connect to, no
    /// `accept()` would unblock, and the join would never return.
    #[test]
    fn shutdown_triggered_while_join_all_is_blocked_still_completes() {
        let ctx = Arc::new(test_ctx());
        let set = Arc::new(AcceptSet::new());

        for _ in 0..3 {
            let l = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("bind");
            set.add(l, Arc::clone(&ctx)).expect("add");
        }
        assert_eq!(set.addrs().len(), 3);

        let trigger = {
            let set = Arc::clone(&set);
            let stop = Arc::clone(&ctx.stop_flag);
            thread::spawn(move || {
                // Let the main thread reach join_all first — the interesting ordering.
                thread::sleep(Duration::from_millis(50));
                stop.store(true, Ordering::SeqCst);
                set.wake_all();
            })
        };

        // Runs on a watchdog thread so a regression fails the test instead of hanging
        // the whole suite until CI times out.
        let (tx, rx) = std::sync::mpsc::channel();
        let joiner = {
            let set = Arc::clone(&set);
            thread::spawn(move || {
                set.join_all();
                let _ = tx.send(());
            })
        };
        assert!(
            rx.recv_timeout(Duration::from_secs(10)).is_ok(),
            "join_all must return once shutdown is triggered — it deadlocked"
        );
        joiner.join().expect("joiner thread");
        trigger.join().expect("trigger thread");
        assert!(set.addrs().is_empty(), "the set is empty after join_all");
    }

    /// Minimal `AcceptCtx` — these tests exercise the accept plumbing, never a real
    /// session, so the connection template and registries only need to exist.
    fn test_ctx() -> AcceptCtx {
        let stop_flag = Arc::new(AtomicBool::new(false));
        let draining = Arc::new(AtomicBool::new(false));
        let lifetime = Lifetime::new();
        let conn_args = ProxyArgs {
            host: None,
            port: 0,
            token: Some("test-token-0123456789".to_string()),
            debug: false,
            log_stderr: false,
            log_dir: None,
            heartbeat: false,
            instance: "default".to_string(),
            idle_timeout: 0,
            status: false,
            shutdown: false,
            all: false,
            close_serial: None,
            daemonized: true,
        };
        let admin_ctx = Arc::new(AdminContext {
            token: "test-token-0123456789".to_string(),
            lifetime: Arc::clone(&lifetime),
            draining: Arc::clone(&draining),
            superseded: Arc::new(AtomicBool::new(false)),
            stop_flag: Arc::clone(&stop_flag),
            // Shutdown-by-admin is not what these tests drive; they set the stop flag
            // and wake directly through the set under test.
            accept_set: Arc::new(AcceptSet::new()),
            serial_registry: Arc::new(Mutex::new(HashMap::new())),
            local_port: 0,
            endpoint_path: std::path::PathBuf::from("/nonexistent/endpoint.json"),
            pid: std::process::id(),
            version: "test".to_string(),
            instance: "default".to_string(),
            started_at_unix: 0,
        });
        AcceptCtx {
            conn_args,
            stop_flag,
            draining,
            lifetime,
            admin_ctx,
            serial_registry: Arc::new(Mutex::new(HashMap::new())),
            serial_available_hub: Arc::new(SerialAvailabilityHub::new()),
            client_threads: Mutex::new(Vec::new()),
        }
    }
}
