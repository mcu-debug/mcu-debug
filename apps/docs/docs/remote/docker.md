---
sidebar_position: 3
title: Docker
---

# Docker

Debugging from a Docker dev container when the debug probe is connected to the Docker host machine.

:::note
We tested the debugger from within VSCode as a normal debugging session and it works. We also tested it from the CLI but only using the builtin VSCode terminals and our own **MCU Debug->AI Cockpit"** panel. We have not tested it from outside VSCode environment yet and is likely going to need some enhancements to our extensions.

One thing still depends on VS Code: the host-side proxy is normally started through a VS
Code command on the host. A container with no VS Code in it must start the agent itself
and name the endpoint — see
[Connecting to an Agent You Started Yourself](./index.md#connecting-to-an-agent-you-started-yourself).
That path needs no VS Code at either end, but we have not tested it yet.
:::

## How It Works

mcu-debug detects it is running inside Docker via `/.dockerenv`. The Docker host is reachable from the container at a known address. mcu-debug connects to a proxy running on the host.

## Configuration

Add `hostConfig` to your `launch.json`:

```json
{
  "type": "mcu-debug",
  "request": "launch",
  "name": "Debug from Container",
  "servertype": "openocd",
  "executable": "${workspaceFolder}/build/firmware.elf",
  "serverpath": "<path-to-gdb-server-on-remote>",
  "configFiles": ["interface/stlink.cfg", "target/stm32f4x.cfg"],
  "hostConfig": {
    "enabled": true,
    "type": "auto"
  }
}
```

With `"type": "auto"`, mcu-debug detects the container environment and chooses the right host address.

## Host Address Resolution

| Docker Setup                   | Host Address                                          |
| ------------------------------ | ----------------------------------------------------- |
| Docker Desktop (macOS/Windows) | `host.docker.internal`                                |
| Linux Docker (no Desktop)      | TBD: Default gateway IP (detected from routing table) |

mcu-debug currently only works with `host.docker.internal` so use the workaround mentioned in [Dev Container Configuration](#dev-container-configuration)

## Starting the Host Proxy

When using from within VSCode, the proxy on the host side is automatically started when the first session starts. On the host, you can verify by doing

```sh
mcu-debug proxy --status
```

### Docker Desktop: Automatic Proxy Start

With Docker Desktop on macOS or Windows, if VS Code Dev Containers extension is in use, the VS Code extension on the host can start the proxy automatically.

### Starting it yourself

Outside that setup — a plain `docker run`, a CLI-only container, CI — start it on the **host**
before launching the session:

```sh
mcu-debug proxy
```

On **Docker Desktop** (macOS and Windows) that is enough. `host.docker.internal` is implemented
by Docker Desktop's own networking and terminates on the host's loopback interface, so a proxy
bound to `127.0.0.1` — the default — is reachable from the container. This is verified: a working
session shows `"hosts": ["127.0.0.1"]` in `--status`.

On **native Linux Docker** there is no such VM layer. The container reaches the host across the
bridge network, arriving at the host's bridge address rather than its loopback, so a
loopback-only proxy will not answer. Bind that address as well:

```sh
mcu-debug proxy --host <host-bridge-address>
```

Running `mcu-debug proxy` again with a different `--host` does not start a second proxy; it asks
the running one to also listen on that address, leaving existing sessions untouched. The reply
lists every address it ended up bound to.

If nothing on the container side can start the agent for you — a CLI-only container or a CI
runner — point `launch.json` at the endpoint directly with
[`hostConfig.proxy`](./index.md#connecting-to-an-agent-you-started-yourself), which skips
detection and launching entirely.

:::note
The address the container **dials** and the address the host proxy **binds** are two different
things, and a mismatch times out in a way that looks like a firewall problem. To check what the
proxy is actually bound to:

```sh
mcu-debug proxy --status
```

and look at `hosts`. On Docker Desktop, `127.0.0.1` alone is expected and correct.
:::

## Dev Container Configuration

In your `.devcontainer/devcontainer.json`, no special probe forwarding is needed — the proxy handles routing. However, the container must be able to reach the host network:

```json
{
  "runArgs": ["--add-host=host.docker.internal:host-gateway"]
}
```

This is automatic on Docker Desktop but may need explicit configuration on Linux.

## VS Code Port Forwarding

VS Code automatically forwards the debug-adapter's internal ports back to your local machine and
offers to open them in a browser. Opening a gdb port that way can abort the gdb-server. See
[VS Code Port Forwarding](./index.md#vs-code-port-forwarding) for the `settings.json` snippet that
turns this off — it applies to every remote topology, not just this one.

## Troubleshooting

### Cannot connect to proxy

- On the host, verify `mcu-debug proxy --status` shows it running, and note the `port`.
  On **Docker Desktop**, `"hosts": ["127.0.0.1"]` is expected and fine — its networking
  terminates on the host's loopback, so a loopback-only proxy is reachable from the
  container. Only on **native Linux Docker** does the container arrive at the host's bridge
  address instead, and need it bound — see [Starting it yourself](#starting-it-yourself).
  (WSL NAT is a different topology and *does* require a non-loopback bind; see
  [WSL](./wsl.md).)
- From the container, check the name resolves *and* the port answers. `ping` only proves the
  first, and many slim images have no `ping` at all:

  ```sh
  getent hosts host.docker.internal          # does the name resolve?
  nc -z -w 2 host.docker.internal <port>     # does the proxy answer?
  ```

  With neither `nc` nor `getent`, bash can do it alone:

  ```sh
  timeout 2 bash -c '</dev/tcp/host.docker.internal/<port>' && echo reachable
  ```
- If the name does not resolve, add the `--add-host` run argument from
  [Dev Container Configuration](#dev-container-configuration).
