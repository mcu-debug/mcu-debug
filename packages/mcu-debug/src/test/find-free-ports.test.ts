// Copyright (c) 2026 MCU-Debug Authors.
// SPDX-License-Identifier: Apache-2.0
//
// The port allocator must not hand out a port someone else is listening on, on *any* local address.
// macOS and Windows treat loopback, wildcard and each interface address as independent endpoints, so a
// listener on just one of them is easy to miss -- simavr on `*:2600`, or our own proxy on a WSL gateway
// address. The Rust allocator (mdbg common/tcpports.rs) has the same tests.

import test from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import * as os from "node:os";

// Through the package, as production code does; it runs `shared`'s compiled lib, so build it first.
import { TcpPortScanner } from "@mcu-debug/shared";

function listen(host: string): Promise<net.Server> {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once("error", reject);
        server.listen(0, host, () => resolve(server));
    });
}

function portOf(server: net.Server): number {
    return (server.address() as net.AddressInfo).port;
}

async function assertNotHandedOut(held: net.Server, where: string) {
    const port = portOf(held);
    try {
        assert.equal(await TcpPortScanner.isPortInUse(port, undefined), true, `isPortInUse missed a listener on ${where}:${port}`);
        const [got] = await TcpPortScanner.findFreePorts(1, { start: port, consecutive: true });
        assert.notEqual(got, port, `findFreePorts handed out ${port}, held on ${where}`);
    } finally {
        await TcpPortScanner.releaseHeldPorts();
        await new Promise((r) => held.close(r));
    }
}

test("a port held on the wildcard is not free", async () => {
    await assertNotHandedOut(await listen("0.0.0.0"), "0.0.0.0");
});

test("a port held on one specific interface address is not free", async (t) => {
    const addr = Object.values(os.networkInterfaces())
        .flat()
        .find((i) => i && i.family === "IPv4" && !i.internal)?.address;
    if (!addr) {
        t.skip("no non-loopback IPv4 address on this host");
        return;
    }
    await assertNotHandedOut(await listen(addr), addr);
});
