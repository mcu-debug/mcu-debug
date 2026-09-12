# MCU Debug — AI Agent Context

This file captures architectural facts that are not obvious from reading the code alone. Read this before making changes to the debug adapter, proxy, or RTT subsystems.

---

## Key Reference Documents

| Document                                                       | What it covers                                                                                                    |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| [docs-internal/Proxy-Plan.md](docs-internal/Proxy-Plan.md)     | Definitive topology for remote probe support — two scenarios, terminology, Funnel Protocol                        |
| [docs-internal/ARCHITECTURE.md](docs-internal/ARCHITECTURE.md) | High-level architecture; may have drifted from current implementation in details, but the overall arch is correct |
| [docs/rtt.md](docs/rtt.md)                                     | RTT implementation — this project's approach is a superset of the standard gdb-server model                       |

---

## Critical: Terminology Inversion

**VS Code's "Local" / "Remote" terminology is inverted relative to the intuitive meaning in this project.**

- VS Code calls the machine with the USB probe **"Local"** (the UI side).
- VS Code calls the machine running the extension's workspace (WSL / container / SSH) **"Remote"**.
- The `mcu-debug` UI extension runs on the **VS Code Local** side (probe host).
- The Debug Adapter (DA) and GDB run on the **VS Code Remote** side (workspace / engineer's source).

When the Proxy-Plan.md says "Engineer Machine" and "Probe Host", use those terms — they are unambiguous. Do not use "local" or "remote" without qualifying which convention you mean.

---

## Debug Adapter is Three Components, Not One

The debug adapter is **not** a single TypeScript process. It has three cooperating parts:

1. **TypeScript DA** (`packages/mcu-debug/src/adapter/`) — The DAP server. Talks to VS Code, manages sessions, orchestrates GDB via stdio.

2. **`da_helper`** (Rust, `packages/mdbg/src/da_helper/`) — A Rust binary invoked by the TS DA as a subprocess. Responsible for ELF parsing, symbol table lookup, and disassembly (via objdump + Capstone). The TS side does **not** parse ELF directly. Any feature that requires symbol information goes through this helper.

3. **Proxy client** (`packages/mdbg/src/proxy_helper/`) — Also Rust. Implements the client side of the Funnel Protocol for reaching a Probe Agent on a remote/host machine. Used when the probe is not accessible directly from the DA process (WSL, Dev Container, or LAB topology).

The `mdbg` binary is a single Rust binary with subcommands (`da-helper`, `proxy`, …). Do not assume these are separate binaries.

---

## Remote Probe Topologies

There are two distinct scenarios. See [Proxy-Plan.md](docs-internal/Proxy-Plan.md) for full detail.

**Topology A — VS Code Remote (WSL / Dev Container)**
- DA runs inside WSL or a container; probe is on the host machine.
- The `mcu-debug` **UI extension** (not the DA) runs on the host and spawns the Probe Agent.
- DA reaches the Probe Agent via `127.0.0.1` (WSL mirrored mode) or `host.docker.internal`.
- This is the `type: "auto"` case in config.

**Topology B — LAB (physically separate machine)**
- DA and all tooling run on the engineer's machine; probe is on a lab server.
- An SSH tunnel (`ssh -L`) is established by the UI extension.
- The DA sees "ghost ports" on `127.0.0.1` that tunnel through to the lab server's Probe Agent.
- No inbound firewall rules are needed on the lab server.

**Probe Agent** (`mdbg proxy`) always runs on the machine physically attached to the probe. It manages gdb-server lifecycle and implements the Funnel Protocol.

---

## Module Boundary Rules (`packages/mcu-debug/src/`)

These rules are **hard constraints**. Enforce them on every change.

### 1. VS Code APIs are confined to `frontend/`

Only files inside `src/frontend/` may import from `vscode` or use any `vscode.*` API.
`common/`, `adapter/`, and `cli/` must never import `vscode`.

### 2. Nothing outside `frontend/` may import from `frontend/`

`common/`, `adapter/`, and `cli/` must never import a file whose path contains `src/frontend/`.
`frontend/` is a consumer of `common/` — not a library for it.

### 3. Platform differences go through `IHostAdapter`

When behaviour differs between the VS Code extension and the CLI, the difference is expressed through the `IHostAdapter` interface (`common/host-adapter.ts`).

- **`VscodeAdapter`** (`frontend/vscode-adapter.ts`) — calls `vscode.*` APIs.
- **`CliAdapter`** (`cli/cli-adapter.ts`, to be created) — writes to the mux stream / logger.

`adapter/` (the DAP server) does **not** use `IHostAdapter`. It conforms to the DAP protocol and has no platform-specific UI calls.

### 4. Logging via `logger`, not `console` or `MCUDebugChannel`

Use `logger` from `common/logger.ts` in `cli/` only. Use getHostAdapter().debugMessage in `common/` and `frontend/`
Transports are registered by each entry point (CLI adds `Console`+`File`; VS Code extension adds `VscodeOutputChannelTransport` — see `frontend/vscode-transport.ts`).
`MCUDebugChannel` (`frontend/dbgmsgs.ts`) is VS Code-only and may only be used within `frontend/`.

### Summary table

| Directory   | May use `vscode.`? | May import from `frontend/`? | Uses `IHostAdapter`? |
| ----------- | ------------------ | ---------------------------- | -------------------- |
| `frontend/` | ✅ yes              | ✅ yes (it IS frontend)       | Implements it        |
| `common/`   | ❌ no               | ❌ no                         | Calls it             |
| `adapter/`  | ❌ no               | ❌ no                         | ❌ no (DAP only)      |
| `cli/`      | ❌ no               | ❌ no                         | Implements it        |

---

## RTT: Two Modes

This project supports RTT in two ways. Most other debuggers only support the first.

**Standard mode (gdb-server TCP)**
- gdb-server (OpenOCD, JLink, etc.) handles RTT polling and exposes TCP ports.
- Limitations: JLink allows only one channel; OpenOCD requires manual polling or a breakpoint to start RTT.

**Alternate mode (GDB memory I/O)**
- The DA uses GDB to directly read/write the RTT control block in target memory.
- Bypasses the gdb-server for RTT data entirely.
- Supports up to 16 bidirectional RTT channels.
- Has an optional per-channel **pre-decoder** pipeline (e.g., `defmt-print` for Rust's defmt format).
- Performance bottleneck is the SWD interface, not the memory I/O round-trip; polling at 40 Hz is practical.

When making changes that touch RTT, determine which mode is in play. Do not assume the gdb-server TCP path is the only one.

---

## Variable Streaming (Push Model)

This debugger has a **push/subscription model for variable values** that is not present in standard DAP. Clients (webviews, external tools) can subscribe to named variables and receive streaming updates rather than polling. This is used for the graphing/live watch features. This is distinct from the standard DAP `variables` request flow and runs on a separate internal channel.

---

## Package Structure

```text
packages/
  mcu-debug/            # VS Code extension (TypeScript) — DAP server + UI
  mdbg/                 # Rust binary — da_helper + proxy_helper subcommands
  mcu-debug-proxy/      # Proxy-related extension packaging
  shared/               # Shared TypeScript types and protocol definitions
  shared/proxy-protocol # GENERATED files by ts_rs. DO NOT EDIT
  shared/serial-helper  # GENERATED files by ts_rs. DO NOT EDIT
  shared/dasm-helper    # GENERATED files by ts_rs. DO NOT EDIT
```

Some directories in the `packages/shared` dir. are generated files and the script `scripts/build-binaries.sh` contains the code to generate and prettify them

The `mdbg` binary is pre-built and checked in under `packages/mcu-debug/bin/` and `packages/mcu-debug-proxy/bin` for each platform. It is also built locally via the `Build Helper` task.

## Building

| What                   | command                  |
| ---------------------- | ------------------------- |
| Rust only build (dev)  | npm run build:rust:dev   |
| Rust only build (prod) | npm run build:rust:prod  |
| Compile all (dev)      | npm run compile          |
| Compile all (prod)     | npm run package          |

prod - production builds builds all OSes and archictures (optimized and stripped)
dev  - development builds builds just the current OS+arch for

`npm run build:rust:dev` / `build:rust:prod` (runnable from the repo root) delegate to
`packages/mcu-debug`'s scripts of the same name, which wrap `./scripts/build-binaries.sh dev|prod`:
they regenerate the ts-rs TypeScript bindings, **format them with prettier**, then build the
`mdbg` Rust binary (host-only for dev, all platforms for prod). This is the fast, Rust-only path.

`npm run build` (root) is a full production build across every workspace — all Rust targets,
manifest generation, the cockpit webview, esbuild bundling of the extension — and is much
heavier than a Rust-only build. Reach for `npm run build:rust:dev`/`build:rust:prod` instead
when you only touched Rust code.

**How to apply:** When Rust structs change, prefer `npm run build:rust:dev` to regenerate and
reformat the generated TS files in one step. For tests, use **`npm run test:rust`** (not bare
`cargo test`): it wraps the suite and runs the same prettier pass afterwards, so a test run
never leaves whitespace-only churn behind. Note the print width is **120**, deliberately
narrower than the project's 200 — formatting these files with the default collapses the
generated type literals onto one line and *creates* drift rather than removing it.

If you instead run the underlying cargo tests directly for speed:

```bash
  cd packages/mdbg && cargo test --lib da_helper::helper_requests::tests::ensure_ts_exports --quiet
  cd packages/mdbg && cargo test --lib proxy_helper::proxy_server::tests::ensure_ts_exports --quiet
```

this regenerates the files but **skips the prettier pass**. The raw ts-rs output differs
cosmetically from the committed (prettier-formatted) files in
`packages/shared/{dasm-helper,proxy-protocol,serial-helper}`, so `git diff` will show noisy
whitespace-only changes there that aren't real edits — before treating them as something to fix
or commit, check whether they're just this formatting drift (`git checkout -- packages/shared/...`
to discard, or run prettier to match: `node_modules/.bin/prettier --write --print-width 120
packages/shared/dasm-helper packages/shared/proxy-protocol packages/shared/serial-helper`).

There is no `npm run build:types` — an earlier version of this repo had one, but it was leftover
from a defunct Go-based codegen pipeline (`packages/proxy-server` + `tygo`) that no longer exists,
and it silently reported success while doing nothing. It was removed; use `npm run build:rust:dev`
for a Rust-only build instead.

## Rust formatting

> **Temporary (as of 2026-08-14): the crate is not currently fully formatted.** `max_width` was
> raised to 120 in `packages/mdbg/rustfmt.toml` recently and the tree has not been reformatted
> since, so `npm run fmt:rust:check` reports ~108 diff sites in already-committed code across
> ~24 files nobody is working on. Until a one-off "format the world" commit lands, **running
> `npm run fmt:rust` rewrites all of them** and buries your change in hundreds of lines of
> unrelated churn. Once that commit lands, delete this note — `fmt:rust` becomes safe and
> idempotent again, which is what it was designed to be.

`npm run fmt:rust:check` reports without writing, and is what CI should use.

**How to apply:** don't run `npm run fmt:rust` for an ordinary change. Match the surrounding
style by hand (`max_width = 120`, set in `packages/mdbg/rustfmt.toml`), then confirm you added no
new violations:

```sh
npm run fmt:rust:check 2>&1 | grep "^Diff in" | grep <file-you-touched>
```

Pre-existing hits in a file you edited are fine and are not yours to fix — check that the flagged
lines are not ones you wrote. If you do run `cargo fmt` by accident, `git checkout --` the files
you never touched rather than committing the churn.

Do **not** run `rustfmt <file>` on individual files either. `rustfmt` follows `mod` declarations,
so formatting `mod.rs` reformats every child module with it — the same problem by another route.

## Rust linting (clippy)

`cargo build`/`cargo check` never run clippy — it's a separate, much larger lint set that isn't
part of the compiler. This repo surfaces clippy in three places, all running the exact same
`cargo clippy --all-targets -- -D warnings` so nothing is CI-only or hidden:

- **Editor**: `.vscode/settings.json` sets `rust-analyzer.check.command` to `clippy`, so lint
  violations show up live as you type, the same as any other diagnostic.
- **Manual**: `npm run lint:rust` from the repo root, or the "rust: cargo clippy" VS Code task
  (Run Task), runs it on demand.
- **CI**: `.github/workflows/rust-ci.yml` runs `npm run test:rust` and `npm run lint:rust` on every
  push/PR — the identical commands available locally, so a CI failure is always reproducible on a
  laptop without needing to guess what CI is actually doing.

**How to apply:** if you add or change Rust code, run `npm run lint:rust` (or trust the live
rust-analyzer diagnostics) before considering the change done — don't rely on CI to catch it first.

## Look-alike characters in machine-parsed strings

Non-ASCII is fine — emoji in docs and UI strings are deliberate. The hazard is the narrower set
of characters that **render almost identically to an ASCII character** but are a different code
point: `—` `–` `‑` (vs `-`), `"` `"` `'` `'` (vs `"` and `'`), `…` (vs `...`), and a non-breaking
space (vs a space). These reach the repo by copy/paste from a browser or a chat window, or from
an editor's smart-quote substitution — nobody types them on purpose, and code review does not
catch them because there is nothing to see.

They are harmless in prose. They are a real bug in any string another program parses. The status
notification in `cli-driver.ts` carried an em dash in `: Reason — ${reason}` for exactly this
reason, and an AI agent matching on the documented `Reason - ` never matched.

**How to apply:**

- Never make a human-readable string the contract. If a consumer needs a value, pass it as
  structured data alongside the text. `setState()` is the pattern: it logs `infoMsg` for humans
  *and* `status`/`reason` as winston meta, which `format.json()` emits as top-level fields on the
  log line. Only `isConsole`/`color`/`skipConsole` are stripped before serialization, so any other
  meta key survives to consumers.
- Where a literal genuinely is a protocol token (a prefix, a delimiter, a sentinel), keep it
  ASCII, and prefer a character with no look-alike.
- When a doc gives a format spec next to sample output, check that the spec's punctuation matches
  the sample's. A mismatch there is the tell.
- `.vscode/settings.json` turns on `editor.unicodeHighlight.nonBasicASCII` for TypeScript, Rust
  and JSON (not Markdown, where emoji are intentional), so these render boxed in the editor as you
  type. That is the check that fires early; there is no CI check for this.

## Version bumps: one constant, never the manifests

**Do not edit the `version` field in any `package.json` or `Cargo.toml`.** Three files carry a
version and they must agree — `packages/mcu-debug/package.json`,
`packages/mcu-debug-proxy/package.json`, and `packages/mdbg/Cargo.toml`. The two extensions ship
as a matched pair and the release script refuses to publish if they differ.

The single source of truth is the `VERSION` constant at the top of `scripts/sync-versions.js`.

**How to apply:** edit that constant, then run `npm run version:sync` to propagate it. Verify with
`node scripts/sync-versions.js --check`, which reports any file that drifted and exits non-zero —
that is also what `npm run build` runs, so a hand-edited manifest surfaces as a build failure
rather than a bad release. Version numbering itself (odd minor means pre-release) and the release
flow are in [docs-internal/Publishing.md](docs-internal/Publishing.md).

## Documentation site (`apps/docs/`)

The `.md`/`.mdx` files under `apps/docs/` are **Docusaurus**, not GitHub-flavored Markdown. The
two look similar enough that GFM syntax gets written by habit and then renders as something else
entirely — so it is worth checking rather than assuming.

**Admonitions use the `:::` form, not GitHub's `> [!NOTE]`.** A GFM alert in a Docusaurus page
renders as a plain blockquote with a literal `[!NOTE]` in the text, which looks broken but does
not fail the build, so nothing catches it for you:

```md
:::note
Docusaurus. Also :::tip, :::info, :::caution, :::warning, :::important — closed with :::
:::
```

**Admonition titles use brackets.** This project is on Docusaurus v3, where a title goes
`:::note[My title]`. The v2 form `:::note My title` is still what most examples on the web show
and is what gets written from memory — in v3 it silently renders the whole block as ordinary
text, no admonition, no build error. If an admonition comes out looking like a plain paragraph,
this is why. Plain `:::note` with no title is always fine.

```md
:::caution[Install the proxy first]
Docusaurus v3. Writing `:::caution Install the proxy first` produces a paragraph.
:::
```

Other differences that bite: `.md` is parsed as MDX, so `{` and `<` are interpreted — `{/* … */}`
is the comment form, and a bare `<something>` is read as a JSX tag. Internal links are relative
file paths including the extension (`./index.md#anchor`), which is what lets the build verify
them.

**How to apply:** after editing anything under `apps/docs/`, run `npm run build` in that directory.
It reports broken links and anchors, which is the only automated check on these files. Note that
`apps/docs/docs/tracing/swo.md` has a pre-existing broken `#graphing` anchor — that one is not
yours.
