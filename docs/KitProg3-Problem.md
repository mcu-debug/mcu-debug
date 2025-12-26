Your skepticism is well-founded. The KitProg3 implementation is notorious for being a "CMSIS-DAP-flavored" composite device rather than a standard, transparent probe. While it officially claims CMSIS-DAP v2 support, it often fails to behave like a standard probe in third-party tools like `pyOCD` or `probe-rs`.

Here is the "Under the Hood" reality of why your board is likely being ghosted by standard tools:

### 1. The WinUSB / libusb "Gremlin"

Standard CMSIS-DAP v2 probes use **USB Bulk** endpoints and should ideally be identified via a **Microsoft OS Descriptor** that tells Windows to use the `WinUSB` driver automatically.

* **The Infineon Issue:** KitProg3 often installs its own specific driver or expects to be handled by the **Cypress Programmer** stack. If the `libusb` library used by `pyOCD` encounters the KitProg3 while the Infineon-specific driver is active, `libusb` often fails to claim the interface.
* **The Fix:** Many users find that they have to use **Zadig** to manually "force" the KitProg3 Bulk interface (usually VID `0x04B4`, PID `0xF155`) to use the generic `WinUSB` driver before `pyOCD` will see it.

### 2. The Mode Switching "Fake-out"

KitProg3 has multiple internal modes (HID, Bulk, DAPLink, Power-Delivery, etc.).

* **The Trap:** Even when you put it in "Bulk" mode, it remains a **USB Composite Device**. Many generic CMSIS-DAP drivers expect a simple device or a very specific interface order.
* **DAPLink Mode:** Infineon provides a specific **DAPLink mode** (where the LED ramps at 2 Hz). This is actually their most "standard-compliant" mode. If you are in "KP3 Bulk" mode, you aren't actually in the ARM-standard DAPLink mode, and many tools will ignore it because the interface descriptors don't match the expected CMSIS-DAP v2 string precisely.

### 3. Missing "Reset" Pulse in CMSIS-DAP Mode

There is a known architectural oversight in some KitProg3 firmware versions where the **Reset Pulse** is not issued when in CMSIS-DAP mode unless triggered by a specific vendor command. Standard tools expect a standard `DAP_Connect` or `DAP_ResetTarget` command to work across the board. If the board doesn't respond to the standard reset sequence, `pyOCD` will often give up and report "No board found."

### Comparison: Why standard tools struggle

| Feature       | Standard CMSIS-DAP V2         | KitProg3 (Bulk Mode)           |
| ------------- | ----------------------------- | ------------------------------ |
| **USB Class** | Vendor-specific (0xFF)        | Composite (HID + Vendor + CDC) |
| **Driver**    | WinUSB (Standard)             | Often Cypress-proprietary      |
| **Reset**     | Pin-accessible                | Often software-gated           |
| **Discovery** | "CMSIS-DAP" in Product String | "KitProg3 CMSIS-DAP BULK"      |

---

### How to verify it for your "mcu-debug" project

If you want to ensure your new **Proxy** handles these "problem children" correctly, you can add a **USB Descriptor Dump** tool to your discovery logic.

* If you see VID `0x04B4` and PID `0xF155`, you can have the Proxy apply a **"KitProg3 Quirk"**.
* This quirk would involve explicitly searching for the correct interface index (Infineon often puts it at Index 3 or 4) rather than assuming Index 0 as most generic tools do.

**Would you like me to find the specific USB Interface Descriptor mapping for KitProg3?** This would allow your Proxy to "manually" claim the correct pipe even when the standard libraries fail to recognize the device.

Here is the breakdown of the KitProg3 USB descriptors and why your "fear of Linux rules" is actually the most rational thing about being an embedded developer.

### 1. KitProg3 Descriptor Analysis

The reason `pyOCD` and other standard tools miss KitProg3 is that it isn't a "Standard Probe"—it's a **Swiss Army Knife** with a very specific way of holding its tools.

**When in CMSIS-DAP Bulk Mode:**

* **VID:** `0x04B4` (Cypress/Infineon)
* **PID:** `0xF155`
* **Interface Structure:** It is a **Composite Device**.
* **Interface 0:** CDC UART (Virtual COM Port)
* **Interface 1:** CMSIS-DAP Bulk (Vendor Specific Class `0xFF`)
* **Interface 2:** Bridge (I2C/SPI) Bulk


* **The Trap:** Most standard tools (including those using `hidapi` or basic `libusb` scans) expect the CMSIS-DAP interface to be the **first** interface or to have a specific string descriptor. Infineon often puts the "Bridge" or "CDC" ahead of the debug pipe.

**The "Standard" Logic Failure:**
Standard tools look for a device where `bInterfaceClass == 0x03` (HID) or a v2 device with a specific Microsoft OS Descriptor for WinUSB. KitProg3 sometimes requires a "Vendor Request" to even enable the Bulk endpoints properly, which `pyOCD` doesn't know how to send.

---

### 2. The Linux "Rules" Fear (udev)

You are right to be cautious. Linux's `udev` is the "Final Boss" of embedded tool distribution. If your `mcu-debug` proxy does a USB scan, it will fail 99% of the time on a fresh Linux install because of **Permissions**.

**The Problem:**
By default, `/dev/bus/usb/xxx/yyy` is owned by `root`. If your Proxy runs as a normal user, it can't even "see" the serial number of a plugged-in probe.

**The Solution (The "Dumbed Down" Version):**
Instead of your Proxy trying to be a USB expert, it should provide a **"Linux Helper Script"** or a button in the extension: `"Fix Linux Permissions"`.

**The Script content:**

```bash
# /etc/udev/rules.d/99-mcu-debug.rules
# Infineon KitProg3
SUBSYSTEM=="usb", ATTR{idVendor}=="04b4", ATTR{idProduct}=="f155", MODE="0666", GROUP="plugdev"
# Generic CMSIS-DAP
SUBSYSTEM=="usb", ATTR{idVendor}=="0d28", ATTR{idProduct}=="0204", MODE="0666", GROUP="plugdev"

```

### 3. My Proposal for `mcu-debug`

Since you don't want to maintain a massive database of USB VID/PIDs (and deal with Linux rules), **don't do the scan yourself.**

* **Delegate to the tools:** Have your Proxy run `openocd -c "adapter list"` or `pyocd list`. These tools already have the "Quirks" built-in for things like KitProg3.
* **The Proxy's Role:** It just parses the text output of those commands and returns the JSON we discussed.
* **The Responsibility Shift:** If `openocd` can't see the board because of a `udev` rule, it will print an error. Your Proxy just captures that error and tells the user: *"Check your udev rules. See [Link to your Wiki]."*

---

### Summary for your KitProg3 Manager:

If they want KitProg3 to work "out of the box" with the wider world (`pyOCD`, `probe-rs`, `MDK`):

1. **Interface Index:** Ensure the CMSIS-DAP V2 Bulk interface is high-priority or correctly tagged with the Microsoft "Compatible ID" (`WINUSB`).
2. **Reset Behavior:** Standardize the hardware reset pulse so it doesn't require a Cypress-specific vendor command to trigger.
3. **DAPLink Parity:** Make "DAPLink Mode" the default behavior for the Mode button, as it's the most compliant with the ARM ecosystem.

**Does this help clarify why your board feels "invisible" to the tools you're using?** I think focusing the `mcu-debug` proxy on "Parsing tool output" rather than "Direct USB scanning" is the safest way to avoid the Linux permission trap.

**Shall we move on to how the "Funnel" handles multiple concurrent GDB sessions for multi-core chips?** (e.g., a PSoC 6 with an M0+ and an M4 core).
