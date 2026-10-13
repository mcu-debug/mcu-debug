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

//! Serial port enumeration for Linux via a pure-sysfs walk.
//!
//! Does **not** use libudev. Filters phantom `ttyS*` entries (driver-declared
//! but no real hardware) by checking that the device chains back to a real bus
//! (USB, PCI, or platform). USB devices are annotated with VID/PID and
//! manufacturer/product strings read from sysfs ancestry.
//!
//! See `uart-management.md §4` ("Linux sysfs walker algorithm") for the full
//! algorithm description.

use super::AvailablePort;
use std::fs;
use std::path::{Path, PathBuf};

/// Walk `/sys/class/tty/`, filter phantoms, and return real serial ports.
pub fn list() -> Vec<AvailablePort> {
    let mut result = Vec::new();
    let tty_dir = Path::new("/sys/class/tty");
    let entries = match fs::read_dir(tty_dir) {
        Ok(e) => e,
        Err(_) => return result,
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        let tty_path = tty_dir.join(&name);

        // 1. Every real tty device has a `device` symlink. Phantoms, consoles,
        //    and pseudo-terminals do not.
        let device_link = tty_path.join("device");
        if !device_link.exists() {
            continue;
        }

        // 2. Resolve the symlink and check that it chains back to a real bus.
        let resolved = match fs::canonicalize(&device_link) {
            Ok(p) => p,
            Err(_) => continue,
        };
        if !chains_to_real_bus(&resolved) {
            continue;
        }

        // 3. Build AvailablePort — attempt USB ancestry for description/VID/PID/serial.
        let (description, vid, pid, serial) = usb_info(&resolved)
            .map(|(d, v, p, s)| (d, Some(v), Some(p), s))
            .unwrap_or_else(|| (driver_name(&resolved), None, None, None));

        result.push(AvailablePort {
            path: format!("/dev/{}", name_str),
            description,
            vid,
            pid,
            serial,
        });
    }
    result
}

/// Return `true` if `device_path` (a resolved sysfs device node) chains back
/// to a USB, PCI, or platform bus that implies real hardware.
///
/// The path typically looks like:
///   `/sys/devices/pci0000:00/.../.../ttyUSB0`  (USB)
///   `/sys/devices/platform/.../.../ttyAMA0`    (platform UART on SBC)
///   `/sys/devices/pci.../.../.../ttyS0`         (real PCI UART)
///
/// Phantoms (serial8250 with no real resources) have a path that contains
/// `serial8250` without any real bus prefix — we exclude those.
fn chains_to_real_bus(device_path: &Path) -> bool {
    let s = device_path.to_string_lossy();
    // Reject pure serial8250 phantom entries (no USB/PCI ancestry).
    if s.contains("serial8250") && !s.contains("/usb") && !s.contains("/pci") {
        return false;
    }
    // Accept anything that resolves to a real bus subtree.
    s.contains("/usb") || s.contains("/pci") || s.contains("/platform")
}

/// Walk up the sysfs ancestry from `device_path` to find a USB device node,
/// then read VID, PID, manufacturer, product, and serial number from it.
///
/// Returns `(description, vid, pid, serial)` if a USB ancestor is found, `None` otherwise.
fn usb_info(device_path: &Path) -> Option<(String, u16, u16, Option<String>)> {
    // Walk up the directory tree looking for `idVendor` / `idProduct` files,
    // which appear at the USB device node (one level above the interface node).
    let mut path: PathBuf = device_path.to_path_buf();
    loop {
        let vid_path = path.join("idVendor");
        let pid_path = path.join("idProduct");
        if vid_path.exists() && pid_path.exists() {
            let vid = read_hex_u16(&vid_path)?;
            let pid = read_hex_u16(&pid_path)?;
            let manufacturer = read_trimmed(&path.join("manufacturer"));
            let product = read_trimmed(&path.join("product"));
            let serial = read_trimmed(&path.join("serial"));
            let description = [manufacturer.as_deref(), product.as_deref()]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join(" ")
                .trim()
                .to_string();
            return Some((description, vid, pid, serial));
        }
        // Move one level up; stop at the sysfs root.
        if !path.pop() {
            break;
        }
    }
    None
}

/// Read the driver name from `<device>/driver` symlink as a fallback description
/// for non-USB ports (PCI, platform).
fn driver_name(device_path: &Path) -> String {
    let driver_link = device_path.join("driver");
    fs::read_link(&driver_link)
        .ok()
        .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
        .unwrap_or_default()
}

fn read_hex_u16(path: &Path) -> Option<u16> {
    let s = fs::read_to_string(path).ok()?;
    u16::from_str_radix(s.trim(), 16).ok()
}

fn read_trimmed(path: &Path) -> Option<String> {
    fs::read_to_string(path)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}
