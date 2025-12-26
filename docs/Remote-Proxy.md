To implement a **Remote Proxy Discovery** that feels "magic" to the user while remaining architecturally clean, you need a robust handshake that handles both **Bootstrap** (getting the proxy on the machine) and **Discovery** (finding where it's running).

Since you are using SSH as your primary "Secure Transport," you can leverage it not just for a tunnel, but as the **deployment and orchestration agent**.

### 1. The "Probe-and-Deploy" Flow

Instead of making the user manually install the Proxy on the remote host, the VS Code extension should treat the remote host as a "managed target."

1. **Version Check:** Extension connects via SSH and runs `mcu-proxy --version`.
2. **Auto-Update:** If the Proxy is missing or outdated, the extension **SCP**s (or `rsync`s) the correct binary for the remote architecture (detected via `uname -m`) to a hidden folder (e.g., `~/.mcu-debug/bin/`).
3. **Process Discovery:** The extension checks if a Proxy is already running for the current project using a "Lockfile" or a specific process name.
4. **Launch:** If not running, it spawns the Proxy via SSH:
`ssh user@host "~/.mcu-debug/bin/mcu-proxy --port 0 --token <secret>"`
* **Note:** Using `--port 0` allows the OS to pick any free port, avoiding "Address already in use" errors.



### 2. The "Handshake" (Discovery)

Since you used `--port 0`, the extension needs to know which port the Proxy picked. You can solve this by having the Proxy print a **Discovery JSON** to `stdout` immediately upon startup.

**The Proxy output:**

```json
{
  "status": "ready",
  "port": 54321,
  "token": "abc-123-xyz",
  "pid": 9876
}

```

The extension parses this single line from the SSH `stdout` stream, then immediately sets up the **SSH Tunnel** to that specific port.

### 3. The "State Machine" of Discovery

Your `mcu-debug` core should follow a state machine to ensure the UI doesn't hang if the remote host is slow.

| State          | Action                             | Transition                                  |
| -------------- | ---------------------------------- | ------------------------------------------- |
| **Connecting** | Establish SSH session              | `Success -> Checking`                       |
| **Checking**   | Verify Proxy binary exists/version | `Missing -> Deploying`, `Found -> Starting` |
| **Deploying**  | SCP the correct binary             | `Success -> Starting`                       |
| **Starting**   | Execute Proxy command              | `Parse Stdout -> Tunneling`                 |
| **Tunneling**  | Open SSH `-L` tunnel               | `Success -> Ready`                          |

### 4. Handling Containers (Docker/WSL)

For containers, "Discovery" is slightly different because you often don't have SSH inside the container.

* **Host-to-Container:** The extension can use `docker exec` instead of `ssh` to perform the same "Probe-and-Deploy" logic.
* **WSL:** You can use the `wsl.exe` command to launch the Proxy on the Linux side from the Windows extension side.

### 5. Why this beats "Static" Discovery (mDNS)

While mDNS/Bonjour is great for "printers," it’s unreliable in corporate labs or multi-tenant servers where multiple users might be running the same Proxy.

* **SSH-based Discovery** is private: Only the user who can SSH into the box can find and use the Proxy.
* **It’s multi-instance safe:** Ten different users can run ten different Proxies on the same Lab server, and they will all find their own unique ports automatically.

---

**Would you like me to look into a "Multi-Probe" logic?** For example, if the remote lab has 5 different ST-Links plugged in, the Proxy could return a list of available `serialNumbers` in that initial "Discovery JSON" so the user can pick the right one from a dropdown in VS Code.

This is the "Enterprise Embedded" problem. In a lab, you often have a single Linux server (or Raspberry Pi) with a USB hub literal with 10 identical ST-Links or CMSIS-DAP probes.

To answer your question: **CMSIS-DAP is actually the solution here**, not an extra requirement. CMSIS-DAP v2 (USB Bulk) in particular provides much faster and more reliable unique identification than the older HID-based probes.

Here is how the "Multi-Probe" logic would work in your `mcu-debug` Proxy.

### 1. The "Probe Inventory" Command

Since your Proxy is the "Source of Truth" on the host, it needs a way to scan the USB bus and return a structured list. You can use `libusb` or simply wrap the `list` commands from OpenOCD/J-Link.

**The Proxy should return a JSON like this during discovery:**

```json
{
  "probes": [
    {
      "type": "ST-Link V3",
      "serial": "002900343130511739303337",
      "manufacturer": "STMicroelectronics",
      "label": "Lab-Bench-A-STM32"
    },
    {
      "type": "CMSIS-DAP",
      "serial": "0240000032224e4500121008",
      "manufacturer": "ARM",
      "label": "Lab-Bench-B-RP2040"
    }
  ]
}

```

### 2. Why CMSIS-DAP is the "Gold Standard" for Labs

Unlike vendor-locked probes, **CMSIS-DAP** probes are designed to be "ID-friendly."

* **Unique Serials:** Every CMSIS-DAP compliant probe is *required* to provide a unique USB serial number string.
* **Vendor Agnostic:** You can use the same `cmsis-dap.cfg` logic in OpenOCD for NXP, Microchip, and DIY probes.
* **WinUSB/Driverless:** In your Lab scenario, CMSIS-DAP v2 is "driverless" (WinUSB) on Windows and generic HID/Bulk on Linux, making it much easier to manage across a fleet of remote machines without installing 10 different driver packages.

### 3. The "Ambiguity" Resolution

When your Proxy finds multiple probes, you have three ways to handle it in the `mcu-debug` extension:

1. **Strict Serial (The "Pro" Way):** In `launch.json`, the user specifies `"serialNumber": "00290034..."`. The Proxy will *only* connect to that probe.
2. **Interactive Pick (The "Lab" Way):** If the user doesn't specify a serial, the Extension shows a VS Code **QuickPick** menu with the labels/serials found by the Proxy.
3. **Alias/Labeling:** Since many serial numbers are just hex strings, your Proxy could support a small `probes.json` config file on the host that maps `00290034...` to a friendly name like `"Core-Board-01"`.

### 4. Implementation Trick: The "Pseudo-CWD" for Probes

In your Lab setup, you can store that `probes.json` in the `$cwd` you mentioned earlier.

* When the Proxy starts, it looks in the `$cwd` for an alias file.
* If it finds one, it decorates the Discovery JSON with those names.
* This allows a lab manager to name the boards ("Inverted Pendulum", "Robot Arm") so students don't have to look at serial numbers.

### 5. OpenOCD / J-Link Integration

To make this work with the actual gdb-servers:

* **OpenOCD:** You pass `-c "adapter serial 00290034..."`.
* **J-Link:** You pass `-select usb=00290034...`.

**The "Dumbed Down" Result:**
The user just clicks "Start Debugging." If they have one probe, it starts. If they have five, a menu pops up: "Which board do you want to use?"

---

**Should we look at how to handle "Multi-Target" (one probe connected to multiple chips in a JTAG chain)?** This is the next level of Lab complexity where CMSIS-DAP really shines.

(It sounds like the `mcu-debug` flagship is becoming a true "Lab Management" tool!)
