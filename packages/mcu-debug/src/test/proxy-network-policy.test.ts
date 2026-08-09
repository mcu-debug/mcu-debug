// Copyright (c) 2026 MCU-Debug Authors.
// SPDX-License-Identifier: Apache-2.0
//
// The launch policy decides two different things that are easy to conflate: which
// address the Proxy Agent *binds* on the Windows host, and which address the debug
// adapter *dials* from inside the guest. These tests pin both, and pin that neither
// is ever a placeholder or a wildcard.

import test from "node:test";
import assert from "node:assert/strict";
import * as os from "os";

// Via the package export, not a relative path into ../../../shared/src: the strict
// typecheck pins rootDir to this package's src.
import { computeProxyLaunchPolicy, findWslAdapterIp, parseDefaultGateway, type ProxyNetworkMode, type WslProbes } from "@mcu-debug/shared";

/** Representative `ip route` output from a WSL2 guest in NAT mode. */
const IP_ROUTE_NAT = `default via 172.28.240.1 dev eth0 proto kernel
172.28.240.0/20 dev eth0 proto kernel scope link src 172.28.245.100
`;

function probes(networkingMode: string, gatewayIp: string | null): WslProbes {
    return { networkingMode: () => networkingMode, gatewayIp: () => gatewayIp };
}

test("parseDefaultGateway pulls the gateway out of ip route output", () => {
    assert.equal(parseDefaultGateway(IP_ROUTE_NAT), "172.28.240.1");
});

test("parseDefaultGateway returns null when there is no default route", () => {
    assert.equal(parseDefaultGateway("172.28.240.0/20 dev eth0 proto kernel scope link\n"), null);
});

test("parseDefaultGateway only matches a route line that starts with 'default'", () => {
    // A device or table named "default" mid-line must not be mistaken for the
    // default route -- the old unanchored /default via ([\d.]+) dev/ would have.
    assert.equal(parseDefaultGateway("10.0.0.0/8 via 10.1.2.3 dev default-tun\n"), null);
});

test("findWslAdapterIp matches both known WSL adapter names", () => {
    // Windows renames this adapter when the Hyper-V firewall is in play, so both
    // spellings have to match. This is the host-side lookup, used instead of shelling
    // into the guest -- it needs no running distro.
    for (const name of ["vEthernet (WSL)", "vEthernet (WSL (Hyper-V firewall))"]) {
        const nets = {
            "Loopback Pseudo-Interface 1": [{ address: "127.0.0.1", family: "IPv4", internal: true } as os.NetworkInterfaceInfo],
            [name]: [{ address: "172.28.240.1", family: "IPv4", internal: false } as os.NetworkInterfaceInfo],
        };
        assert.equal(findWslAdapterIp(nets), "172.28.240.1", `must match adapter named "${name}"`);
    }
});

test("findWslAdapterIp ignores unrelated adapters and returns null when absent", () => {
    const nets = {
        Ethernet: [{ address: "192.168.1.10", family: "IPv4", internal: false } as os.NetworkInterfaceInfo],
        "vEthernet (Default Switch)": [{ address: "172.17.0.1", family: "IPv4", internal: false } as os.NetworkInterfaceInfo],
    };
    assert.equal(findWslAdapterIp(nets), null, "a non-WSL vEthernet adapter must not be mistaken for it");
});

test("WSL NAT binds the gateway address, not the wildcard", () => {
    const policy = computeProxyLaunchPolicy("auto-wsl", probes("nat", "172.28.240.1"));

    // The host binds exactly the adapter the guest talks to. Both fields are the same
    // address here, but for different reasons -- see the comments in proxy-network.ts.
    assert.equal(policy.bindHost, "172.28.240.1", "bindHost must be the gateway address");
    assert.equal(policy.proxyHostForDA, "172.28.240.1", "the guest dials the same address");
    assert.notEqual(policy.bindHost, "0.0.0.0", "the wildcard exposes every interface");
});

test("WSL mirrored networking stays on loopback", () => {
    const policy = computeProxyLaunchPolicy("auto-wsl", probes("mirrored", "172.28.240.1"));

    // Mirrored gives the guest the host's own interfaces, so there is nothing to widen
    // even though a gateway address is available.
    assert.equal(policy.bindHost, "127.0.0.1");
    assert.equal(policy.proxyHostForDA, "127.0.0.1");
});

test("WSL NAT with an unresolvable gateway degrades to loopback and says why", () => {
    const policy = computeProxyLaunchPolicy("auto-wsl", probes("nat", null));

    // Degrading beats throwing, but it is not a working configuration -- the reason has
    // to make that visible, because the symptom is a connection timeout much later.
    assert.equal(policy.bindHost, "127.0.0.1");
    assert.equal(policy.proxyHostForDA, "127.0.0.1");
    assert.match(policy.reason, /could not resolve/i);
});

test("no mode ever yields a placeholder or wildcard bind address", () => {
    // `proxyHostForDA` was once the literal string "<wsl-gateway-ip>", left for each
    // caller to substitute; one that trusted the field would hand it straight to
    // connect(). And `0.0.0.0` is a bind wildcard that is meaningless as a connect
    // target, so it must never appear in proxyHostForDA either.
    const modes: ProxyNetworkMode[] = [
        "local",
        "ssh",
        "auto-local",
        "auto-wsl",
        "auto-wsl-container",
        "auto-dev-container",
        "auto-ssh-remote",
    ];

    for (const mode of modes) {
        for (const p of [probes("nat", "172.28.240.1"), probes("nat", null), probes("mirrored", null)]) {
            const policy = computeProxyLaunchPolicy(mode, p);
            for (const field of ["bindHost", "proxyHostForDA"] as const) {
                assert.doesNotMatch(policy[field], /[<>]/, `${mode}.${field} must be a real address, not a placeholder`);
                assert.notEqual(policy[field], "", `${mode}.${field} must not be empty`);
            }
            assert.notEqual(policy.proxyHostForDA, "0.0.0.0", `${mode}: the wildcard is not a connect address`);
        }
    }
});
