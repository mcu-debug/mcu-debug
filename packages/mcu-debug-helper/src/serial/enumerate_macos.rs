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

//! Serial port enumeration for macOS via `serialport::available_ports()`,
//! which wraps IOKit (always present, no extra dependencies).

use super::AvailablePort;
use serialport::SerialPortType;

/// Enumerate available serial ports using the macOS IOKit APIs.
pub fn list() -> Vec<AvailablePort> {
    match serialport::available_ports() {
        Err(_) => Vec::new(),
        Ok(ports) => ports
            .into_iter()
            .map(|info| {
                let (description, vid, pid) = match info.port_type {
                    SerialPortType::UsbPort(usb) => {
                        let desc = [usb.manufacturer.as_deref(), usb.product.as_deref()]
                            .into_iter()
                            .flatten()
                            .collect::<Vec<_>>()
                            .join(" ")
                            .trim()
                            .to_string();
                        (desc, Some(usb.vid), Some(usb.pid))
                    }
                    SerialPortType::BluetoothPort => ("Bluetooth".to_string(), None, None),
                    SerialPortType::PciPort => ("PCI".to_string(), None, None),
                    SerialPortType::Unknown => (String::new(), None, None),
                };
                AvailablePort {
                    path: info.port_name,
                    description,
                    vid,
                    pid,
                }
            })
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Visual smoke test — prints whatever IOKit reports on this machine.
    /// Run with: cargo test enumerate_macos::tests::list_available_ports -- --nocapture
    #[test]
    fn list_available_ports() {
        let ports = list();
        println!("\n--- macOS serial ports ({} found) ---", ports.len());
        for p in &ports {
            println!(
                "  path={:?}  desc={:?}  vid={:?}  pid={:?}",
                p.path, p.description, p.vid, p.pid
            );
        }
        // Not asserting anything specific — this is a hardware-dependent visual check.
        println!("---");
    }
}
