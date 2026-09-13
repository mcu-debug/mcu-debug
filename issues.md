- [ ] **Post install issues**

    This applies to both extensions in non-remote environments. We should attempt a daemon cleanup if an older version is running.

    - Should be done at activated
    - Run `mdbg proxy status`
      - Not running, nothing to do
      - Running
        - If there are sessions/serial-ports-with-connections they will drain but, do we let the user know
          - Offer to shutdown ongoing sessions? If so, do we want a --now option?
        - Upgrade or Downgrade accordingly. Maybe not worry about downgrade
        - See docs-internal/Singleton-Tier1-Plan.md Step (§5)

    This utility, should we develop it so it can be part of the extensions as well as a standalone utility?

---

## Daemon upgrade / widen on launch — what actually happens (2026-09-12)

Checked against the code, because the plan document and the implementation had drifted in my
head. Short version: **both the version upgrade and the widen are implemented and both run on
every launch.** Neither was visible, which is what made it look like only one of them worked.

`startProxyServerWrapper()` is not where the decision is made. It spawns `mdbg proxy`, and that
process — in [`acquire_or_reuse()`](packages/mdbg/src/proxy_helper/run.rs) — does the whole
dance before printing its discovery line:

| Situation                                               | What happens                                   | Where you could see it                           |
| ------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------ |
| No daemon running                                       | acquire lock, bind, become the singleton       | discovery `pid` is the new one                   |
| Running daemon, **older** version                       | admin `upgrade` → old one drains, we take over | daemon log: `requesting handover`                |
| Running daemon, **same** version                        | reuse it untouched                             | daemon log: `Reusing existing proxy`             |
| Running daemon, **newer** version                       | reuse it (downgrade guard)                     | daemon log: `A newer proxy … is already running` |
| Handover requested but **refused/unreachable**          | silently falls back to reuse                   | daemon log only (`log::warn!`)                   |
| `--host` asked for an address the daemon does not serve | admin `widen`                                  | discovery `hosts` grows                          |
| widen refused                                           | reported in `bind_errors`                      | `showError` on the mcu-debug side, launch aborts |

So the asymmetry that made this look broken is real but it is about *reporting*, not behaviour:
**widen failure aborts the launch loudly; a version mismatch was completely silent.** The
discovery line has carried `version` all along and `ProxyLaunchResults` dropped the field on the
floor, so no TS code on either side of the extension pair could tell which daemon answered.

### Done

- [x] `ProxyLaunchResults` now carries `version` and `pid` from the discovery line
      (`shared/src/proxy-network.ts`, `shared/src/proxy-starter.ts` — both the direct and the
      WSL-interop launch paths).
- [x] The proxy extension has a `LogOutputChannel` ("MCU-Debug Proxy") and traces
      `activate`, `startProxy.request`, `startProxy.ready`, `startProxy.failed`,
      `startProxy.rejected`, `startProxy.no-policy`, `revTunnel.up/failed`. `startProxy.ready`
      records port, daemon pid, daemon version vs extension version, `hosts`, `bind_errors`.
- [x] Two explicit verdicts, because these were the invisible ones:
      `startProxy.version-mismatch` (a daemon other than the one this build shipped answered) and
      `startProxy.host-not-served` (the requested `bindHost` is not in `hosts` — widen did not
      take). `activate` also logs the daemon's log directory, since the branch decision is only
      recorded there.

### Still open

1. ~~Equal version reuses — which is wrong for development.~~ **Fixed.** Each proxy now stamps its
   executable's path and mtime at startup and publishes it in `endpoint.json`; a launch supersedes a
   running daemon when the versions are equal, the path is identical, and its own file is strictly
   newer. `singleton::decide_handover` is the single rule, run by both the challenger and the
   incumbent, so the incumbent cannot be talked past its own check. Default on, with
   `MDBG_PROXY_AUTO_UPGRADE=0` to suppress; `upgrade` is now loopback-only; and
   `scripts/build-binaries.sh` no longer needs its `pkill`. Details and the guard list are in
   `docs-internal/Singleton-Tier1-Plan.md` Phase D.1.

   This covers the reinstall case, not just the dev loop — VS Code installs into a version-stamped
   directory, so a same-version vsix reinstalled over itself lands at the *same* path with a fresh
   install-time mtime, which is exactly what the rule detects. (Verified: extraction stamps install
   time rather than preserving the vsix's stored zip timestamps.)

   One-time limitation: a daemon running code from before this landed refuses an equal-version
   handover, because its own `begin_upgrade` predates the rule — the launch falls back to reuse and
   logs why. So the first relaunch after upgrading to this still wants
   `mdbg proxy --shutdown --all`; every one after that is automatic. `--all` matters because the
   bare form drains only `default`, and dev/test runs use other instances (`dev`, plus whatever a
   test harness names). `--status` needs no `--all` — it is instance-agnostic by design.

2. ~~Default idle timeout is 5 hours, not 5 minutes.~~ **Settled: 5 hours is correct; the docs were
   wrong.** Minutes reaped the daemon out from under anyone who stepped away mid-session. Fixed in
   `Singleton-Tier1-Plan.md` (§4, Phase B, open decision 3) and `CLI-Proxy-Provisioning.md`, and
   the `5*60*60` now carries a doc comment so it does not read as a typo for `5*60`. The
   consequence stands and is worth keeping in mind: an old daemon is almost always still alive
   when someone updates the extension, so the upgrade/handover path is the **normal** case after a
   release, not an edge case.

3. ~~`narrow` has no TS caller, so a widened address is never withdrawn.~~ **Not a gap — by
   design.** Widen is reached by exactly one policy: WSL **NAT** mode, which binds the WSL gateway
   IP (`getWslGatewayIp()`). Mirrored WSL, dev containers (`host.docker.internal`), SSH and local
   all stay on loopback and never widen. Once a host has served a WSL NAT guest, assume it will
   again — in practice the daemon is usually started that way, and only someone alternating Windows
   and WSL sessions in one sitting (i.e. testing) sees it acquired mid-life. So the widened gateway
   address stays for the daemon's life, deliberately: withdrawing it would buy nothing and cost a
   refcount plus a reconnect hazard. `narrow` stays implemented and tested but uncalled; a request
   that did arrive should be ignored-with-a-warning rather than honoured, and its existing
   guards (loopback refused, last listener not removable) already make it safe.

   The rule this all serves, worth stating plainly: **widen to cover the requests that arrive,
   never to `0.0.0.0` if there is any alternative.** The NAT gateway is that alternative — one
   number that answers both "what does the host bind" and "what does the guest dial", on an adapter
   that is host-local by construction.

   *(An earlier version of this item claimed a `0.0.0.0` gap. There isn't one: `bindHost` has a
   single producer, `computeProxyLaunchPolicy`, and every branch returns `127.0.0.1` or the NAT
   gateway — never the wildcard, which a unit test also pins. `is_widenable` refusing the wildcard
   and widen being IPv4-only are both deliberate and consistent with the rest of the proxy, which
   is `Ipv4Addr` throughout. Only a hand-typed `mdbg proxy --host 0.0.0.0` can reach that refusal,
   and an operator doing that can read the error.)*

4. **Nothing surfaces the daemon's own state to the user.** `mcu-debug.checkProxy` reports the two
   *extension* versions and stops there — the interesting facts (daemon pid, version, `state`
   active/draining, `hosts`, active sessions) are one `mdbg proxy --status` away. Proposal: a
   `mcu-debug-proxy.proxyStatus` command that runs `--status` and returns the JSON, and have
   `checkProxy` print extensions *and* daemon in one report. That subsumes the `mdbg proxy status`
   step sketched in the **Post install issues** item above, and is the standalone-utility question
   answered the cheap way: the daemon already implements it, the extensions just need to ask.

5. **A failed handover is indistinguishable from a normal reuse** from outside the daemon. The
   fallback is a `log::warn!` in a temp-dir log. Adding the taken branch to the discovery line
   (`"action": "started" | "reused" | "upgraded"`) would make the trace above definitive instead
   of inferring it from a version comparison. Cheap, and `#[serde(default)]` keeps it compatible.
