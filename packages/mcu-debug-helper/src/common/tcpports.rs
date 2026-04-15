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

use std::net::{Ipv4Addr, TcpListener};

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
            match TcpListener::bind((Ipv4Addr::LOCALHOST, current_port)) {
                Ok(_listener) => {
                    ret.push(current_port);
                }
                Err(_) => {
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
            match TcpListener::bind((Ipv4Addr::LOCALHOST, current_port)) {
                Ok(listener) => {
                    ret.push(listener);
                }
                Err(_) => {
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
