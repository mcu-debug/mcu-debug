/**
 * Development-only fake orchestrator. Exercises tab lifecycle and streaming
 * so you can prototype the full panel in a browser without hardware or VS Code.
 * Excluded from the production bundle (only imported inside import.meta.env.DEV guard).
 */
import type { ToUi } from '@mcu-debug/shared';

function dispatch(msg: ToUi) {
    window.dispatchEvent(new MessageEvent('message', { data: msg }));
}

// Stable tabIds — opaque to the webview, meaningful to the mock
const TABS = {
    uart0: 'uart::/dev/ttyUSB0',
    uart1: 'uart::COM3',
    rtt0:  'rtt::session-1::0',
    cockpit: 'cockpit::session-1',
} as const;

const RTT_LINES = [
    '[RTT#0] System booted\r\n',
    '[RTT#0] DMA transfer started\r\n',
    '[RTT#0] IRQ count: 0\r\n',
    '[RTT#0] WARNING: callback not fired after 50ms\r\n',
    '[RTT#0] IRQ count: 1\r\n',
    '[RTT#0] Hard fault at 0x0800_1A3C\r\n',
];

const UART0_LINES = [
    '[UART:ttyUSB0] > ready\r\n',
    '[UART:ttyUSB0] > ack 0x42\r\n',
    '[UART:ttyUSB0] > heartbeat 1\r\n',
    '[UART:ttyUSB0] > heartbeat 2\r\n',
];

const UART1_LINES = [
    '[UART:COM3] MAVLink HEARTBEAT\r\n',
    '[UART:COM3] MAVLink STATUS_TEXT: booting\r\n',
];

const COCKPIT_LINES = [
    '[GDB] GNU gdb (GDB) 13.2\r\n',
    '[GDB] Reading symbols from firmware.elf...\r\n',
    '[GDB] Remote debugging using localhost:3333\r\n',
    '[RTT#0] Motor: speed=1200 rpm\r\n',
    '[GDB] Breakpoint 1, main () at main.c:42\r\n',
    '[SWO] PC sample: 0x0800_1A3C\r\n',
];

export function startMock() {
    // --- Add tabs in lifecycle order: UARTs first, then session-scoped ---
    dispatch({
        type: 'tab-add',
        tab: {
            tabId: TABS.uart0,
            kind: 'uart',
            label: 'ttyUSB0',
            direction: 'both',
            state: { kind: 'active' },
        },
    });

    dispatch({
        type: 'tab-add',
        tab: {
            tabId: TABS.uart1,
            kind: 'uart',
            label: 'COM3',
            direction: 'both',
            state: { kind: 'active' },
        },
    });

    dispatch({
        type: 'tab-add',
        tab: {
            tabId: TABS.rtt0,
            kind: 'rtt',
            label: 'RTT#0',
            direction: 'rx',
            state: { kind: 'active' },
        },
    });

    dispatch({
        type: 'tab-add',
        tab: {
            tabId: TABS.cockpit,
            kind: 'cockpit',
            label: 'Glass Cockpit',
            state: { kind: 'active' },
        },
    });

    // --- Drip data to each tab independently ---
    let uart0Idx = 0;
    setInterval(() => {
        dispatch({ type: 'stream', tabId: TABS.uart0, text: UART0_LINES[uart0Idx % UART0_LINES.length] });
        uart0Idx++;
    }, 600);

    let uart1Idx = 0;
    setInterval(() => {
        dispatch({ type: 'stream', tabId: TABS.uart1, text: UART1_LINES[uart1Idx % UART1_LINES.length] });
        uart1Idx++;
    }, 1500);

    let rttIdx = 0;
    setInterval(() => {
        dispatch({ type: 'stream', tabId: TABS.rtt0, text: RTT_LINES[rttIdx % RTT_LINES.length] });
        rttIdx++;
    }, 400);

    let cockpitIdx = 0;
    setInterval(() => {
        dispatch({ type: 'stream', tabId: TABS.cockpit, text: COCKPIT_LINES[cockpitIdx % COCKPIT_LINES.length] });
        cockpitIdx++;
    }, 700);

    // --- Simulate UART disconnect → reconnect cycle ---
    setTimeout(() => {
        dispatch({
            type: 'tab-set-state',
            tabId: TABS.uart1,
            state: { kind: 'disconnected', message: 'Device removed: COM3' },
        });
    }, 8_000);

    setTimeout(() => {
        dispatch({
            type: 'tab-set-state',
            tabId: TABS.uart1,
            state: { kind: 'active' },
        });
        dispatch({ type: 'stream', tabId: TABS.uart1, text: '[UART:COM3] reconnected\r\n' });
    }, 15_000);

    // --- Simulate AI-REQUEST on the Cockpit tab ---
    setTimeout(() => {
        dispatch({
            type: 'ai-request',
            tabId: TABS.cockpit,
            text: 'Rotate the motor shaft by hand and observe the RTT speed reading.',
        });
    }, 5_000);

    setTimeout(() => {
        dispatch({ type: 'ai-request-clear', tabId: TABS.cockpit });
    }, 12_000);

    // --- Simulate session end: RTT and Cockpit become inactive ---
    setTimeout(() => {
        dispatch({ type: 'tab-set-state', tabId: TABS.rtt0,    state: { kind: 'inactive' } });
        dispatch({ type: 'tab-set-state', tabId: TABS.cockpit, state: { kind: 'inactive' } });
    }, 20_000);

    console.info('[dev-mock] Fake orchestrator started. Tabs:', Object.values(TABS));
}
