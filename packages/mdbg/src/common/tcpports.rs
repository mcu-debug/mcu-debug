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

use std::io::ErrorKind;
use std::net::{IpAddr, Ipv4Addr, TcpListener};

/// Take `port` on the loopback -- the address every caller binds -- but only if nobody holds it on
/// *any* local IPv4 address.
///
/// A loopback bind alone is not a complete test. macOS and Windows treat `127.0.0.1:P`, `0.0.0.0:P`
/// and `<interface address>:P` as independent endpoints, and std sets `SO_REUSEADDR` on Unix, so on
/// macOS the loopback bind succeeds right next to another process listening on the wildcard (simavr on
/// `*:2600`) or on one interface address (our own proxy on a WSL gateway, RTT's `serve.hostName`). The
/// gdb-server we then launch fails to bind, or the client connects to the wrong program. Linux
/// refuses those combinations, so it never showed there.
///
/// So, before the loopback is taken:
/// - the wildcard is probed: it fails if anyone holds the port on the wildcard (everywhere), or on any
///   address at all (Linux, where this probe alone is a complete test);
/// - each interface address in `addrs` is probed, for a listener on just that address.
///
/// Probes are dropped at once -- Linux will not let one process hold the wildcard and a specific
/// address together. Any bind error means "not available", except `AddrNotAvailable` on an interface
/// address: an interface that went away (a VPN, a tunnel) says nothing about the port.
/// `shared/src/find-free-ports.ts` applies the same rule on the TypeScript side.
fn claim_port(port: u16, addrs: &[Ipv4Addr]) -> Option<TcpListener> {
    drop(TcpListener::bind((Ipv4Addr::UNSPECIFIED, port)).ok()?);
    for &addr in addrs {
        match TcpListener::bind((addr, port)) {
            Ok(probe) => drop(probe),
            Err(e) if e.kind() == ErrorKind::AddrNotAvailable => {}
            Err(_) => return None,
        }
    }
    TcpListener::bind((Ipv4Addr::LOCALHOST, port)).ok()
}

/// This machine's IPv4 addresses other than `127.0.0.1` (which `claim_port` binds last anyway), read
/// once per allocation. If they cannot be listed, the check falls back to the wildcard and loopback.
fn interface_addrs() -> Vec<Ipv4Addr> {
    let mut addrs: Vec<Ipv4Addr> = if_addrs::get_if_addrs()
        .map(|ifaces| {
            ifaces
                .into_iter()
                .filter_map(|i| match i.ip() {
                    IpAddr::V4(v4) if v4 != Ipv4Addr::LOCALHOST => Some(v4),
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default();
    addrs.sort();
    addrs.dedup();
    addrs
}

pub struct TcpPortFinderArgs {
    pub consecutive: bool,
    pub count: u16,
    pub start_port: u16,
}

/// If args.consecutive is true, finds a block of `args.count` consecutive free TCP ports starting from
/// `args.start_port`. If args.consecutive is false, finds any `args.count` free TCP ports starting from
/// `args.start_port` (not necessarily consecutive). Returns a vector of the free port numbers if
/// successful, or None if it fails to find the required number of ports.
///
/// Note tThis function does not reserve the ports it finds. If you need to reserve them, you should use
/// `reserve_free_ports` instead.
pub fn find_free_ports(args: &TcpPortFinderArgs) -> Option<Vec<u16>> {
    let addrs = interface_addrs();
    let start_port = args.start_port.max(1025);
    let end_port = 65535 - args.count; // Ensure we have enough ports to check for the count

    let mut ret: Vec<u16> = Vec::new();
    let mut port = start_port;
    while port <= end_port {
        let mut found_all = true;

        ret.clear();
        while (ret.len() as u16) < args.count {
            let current_port = port;
            port += 1;
            match claim_port(current_port, &addrs) {
                Some(_listener) => {
                    ret.push(current_port);
                }
                None => {
                    if args.consecutive {
                        // If we require consecutive ports, we can break immediately on failure
                        found_all = false;
                        break;
                    }
                }
            }
        }

        if found_all {
            // Successfully bound all n ports.
            // Return the port numbers.
            // Note: Keep `listeners` in scope if you need to reserve them!
            return Some(ret);
        }
    }

    None
}

pub fn reserve_free_ports(args: &TcpPortFinderArgs) -> Option<Vec<TcpListener>> {
    let addrs = interface_addrs();
    let start_port = args.start_port.max(1025);
    let end_port = 65535 - args.count; // Ensure we have enough ports to check for the count

    let mut ret: Vec<TcpListener> = Vec::new();
    let mut port = start_port;
    while port <= end_port {
        let mut found_all = true;

        ret.clear();
        while (ret.len() as u16) < args.count {
            let current_port = port;
            port += 1;
            match claim_port(current_port, &addrs) {
                Some(listener) => {
                    ret.push(listener);
                }
                None => {
                    if args.consecutive {
                        // If we require consecutive ports, we can break immediately on failure
                        found_all = false;
                        break;
                    }
                }
            }
        }

        if found_all {
            // Successfully bound all n ports.
            // Return the listeners.
            // Note: Keep `listeners` in scope if you need to reserve them!
            return Some(ret);
        }
        // If not found, `listeners` drops here, closing the ports automatically
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A port another process holds on the *wildcard* (simavr listens on `*:2600`) must not be
    /// reported free. macOS (and Windows) treat `127.0.0.1:P` and `0.0.0.0:P` as independent, so a
    /// loopback-only probe -- which `SO_REUSEADDR`, set by std on Unix, lets through -- missed it.
    #[test]
    fn a_port_held_on_the_wildcard_is_not_free() {
        let held = TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0)).expect("bind wildcard");
        let port = held.local_addr().unwrap().port();
        let args = TcpPortFinderArgs {
            consecutive: true,
            count: 1,
            start_port: port,
        };

        let reserved = reserve_free_ports(&args).expect("some port is free");
        let got = reserved[0].local_addr().unwrap().port();
        assert_ne!(got, port, "reserve_free_ports handed out a port held on the wildcard");
        drop(reserved);

        let found = find_free_ports(&args).expect("some port is free");
        assert_ne!(found[0], port, "find_free_ports reported a port held on the wildcard");
    }

    /// A listener on one *specific* non-loopback address -- what the proxy itself does for a WSL
    /// gateway (`192.168.1.5:P`), or RTT's `serve.hostName` -- must not be reported free. On macOS and
    /// Windows neither the loopback nor the wildcard probe sees it, yet a gdb-server that later binds
    /// the wildcard on that port can fail.
    #[test]
    fn a_port_held_on_a_specific_interface_address_is_not_free() {
        let Some(addr) = if_addrs::get_if_addrs()
            .ok()
            .into_iter()
            .flatten()
            .find_map(|i| match i.ip() {
                std::net::IpAddr::V4(v4) if !v4.is_loopback() => Some(v4),
                _ => None,
            })
        else {
            eprintln!("no non-loopback IPv4 address on this host; nothing to test");
            return;
        };
        let held = TcpListener::bind((addr, 0)).expect("bind interface address");
        let port = held.local_addr().unwrap().port();
        let args = TcpPortFinderArgs {
            consecutive: true,
            count: 1,
            start_port: port,
        };
        let reserved = reserve_free_ports(&args).expect("some port is free");
        assert_ne!(
            reserved[0].local_addr().unwrap().port(),
            port,
            "reserve_free_ports handed out a port held on {addr}"
        );
    }

    /// The loopback case, which always worked, must keep working.
    #[test]
    fn a_port_held_on_the_loopback_is_not_free() {
        let held = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("bind loopback");
        let port = held.local_addr().unwrap().port();
        let args = TcpPortFinderArgs {
            consecutive: true,
            count: 1,
            start_port: port,
        };
        let reserved = reserve_free_ports(&args).expect("some port is free");
        assert_ne!(reserved[0].local_addr().unwrap().port(), port);
    }
}
