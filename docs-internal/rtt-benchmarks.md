# RTT throughput results

We will use a Rust STM32 program that streams data via RTT as fast as it can. No sleeps. We can use several gdb-servers. All of these were run under the debugger for both TS and Rust

See: /Users/hdm/src/stm32f429-rtt

All figures are session averages, computed from the last `total` line of each run rather than from a
single window. Measured at the same place in every case -- a `pipe` decoder with `output: "none"`, so
no terminal and no child process are in the data path.

| Server  | builtin (TS) | builtin (Rust) | Rust vs TS | server RTT | Rust vs server |
| ------- | ------------ | -------------- | ---------- | ---------- | -------------- |
| OpenOCD | 50.9 KB/s    | 66.2           | 1.30×      | 80.1       | 0.83×          |
| pyOCD   | 24.8         | — (see below)  | —          | — ¹        | —              |
| ST-LINK | 62.4         | **89.5**       | **1.43×**  | — ²        | —              |
| JLink   | 68.3         | 80.5           | 1.18×      | 152.1 ³    | 0.53×          |

¹ needs OpenOCD's `rtt start`/poll dance, which we have not implemented for pyOCD.
² the ST-LINK gdb-server has no RTT support at all, so builtin is the only option.
³ J-Link polls RTT in **probe firmware**, with no host round trip per poll. Not the same architecture,
and not a target to chase.

**pyOCD cannot run the Agent engine.** It does not refuse a memory read while the target runs and it
does not error -- it _queues_ the read and answers when the target next stops. Observed as five
consecutive two-second timeouts through a run, each answered within a millisecond of the halt that
followed, while `WrOff` advanced 0 → 0x2f9 the whole time. So the data was there and unreachable. Its
tier is `HaltedOnly`, and for pyOCD `useBuiltinRTT.implementation: "typescript"` is not a fallback but
the only option: the adapter's own engine reads over a **second** connection, where pyOCD answers
happily. See `gdb-rsp.md` §7.

### Where the ceiling is

Not bytes -- round trips. OpenOCD and ST-LINK both run at ~180 drain passes/sec, J-Link at ~112, and
each pass costs three round trips (read the descriptor, read the data, write `RdOff`). Bytes per pass
differ (377, 514 and 736 respectively); passes per second is what the server and probe latency set.

So the remaining lever is `set_depth(2)` in no-ack mode, overlapping the `RdOff` write with the next
descriptor read -- three serialised round trips down to about two. §4.2.1 says the servers are serial
so it buys nothing server-side, but the latency it hides is exactly what we are bound by.

### Caveats on these numbers

- ST-LINK's 89.5 predates the 500-byte drain cap (`SAFE_DRAIN_BYTES`) and averaged 514 bytes/pass,
  just above it -- so expect nearer 88 on a re-run.
- The ST-LINK gdb-server truncates a reply of exactly 1024 bytes, losing its last checksum digit to a
  NUL terminator. A 510-byte read produces exactly that, and failed 4 times out of 4. Hence the cap;
  see `SAFE_DRAIN_BYTES` for the arithmetic and the family of bad sizes.
- `polling_interval: 1` throughout, which is irrelevant at these rates: the loop does not sleep at all
  while data is flowing.

## Builtin RTT in Typescript

### OpenOCD

```
[RTT Logs stats] 53.42 KB/sec | 195.9 msgs/sec | window 5.0s, 267.18 KB | total 267.18 KB over 5.0s
[RTT Logs stats] 52.52 KB/sec | 196.0 msgs/sec | window 5.0s, 262.67 KB | total 529.85 KB over 10.0s
[RTT Logs stats] 50.54 KB/sec | 192.9 msgs/sec | window 5.0s, 252.87 KB | total 782.72 KB over 15.0s
[RTT Logs stats] 53.06 KB/sec | 200.3 msgs/sec | window 5.0s, 265.74 KB | total 1.02 MB over 20.0s
[RTT Logs stats] 49.70 KB/sec | 191.6 msgs/sec | window 5.0s, 248.76 KB | total 1.27 MB over 25.0s
[RTT Logs stats] 50.80 KB/sec | 193.0 msgs/sec | window 5.0s, 254.31 KB | total 1.52 MB over 30.1s
[RTT Logs stats] 51.29 KB/sec | 192.8 msgs/sec | window 5.0s, 256.69 KB | total 1.77 MB over 35.1s
[RTT Logs stats] 51.26 KB/sec | 190.9 msgs/sec | window 5.0s, 256.41 KB | total 2.02 MB over 40.1s
[RTT Logs stats] 48.91 KB/sec | 189.3 msgs/sec | window 5.0s, 244.72 KB | total 2.26 MB over 45.1s
[RTT Logs stats] 51.45 KB/sec | 193.5 msgs/sec | window 5.0s, 257.37 KB | total 2.51 MB over 50.1s
[RTT Logs stats] 49.78 KB/sec | 191.9 msgs/sec | window 5.0s, 249.00 KB | total 2.75 MB over 55.1s
[RTT Logs stats] 49.98 KB/sec | 192.0 msgs/sec | window 5.0s, 250.14 KB | total 2.99 MB over 60.1s
[RTT Logs stats] 50.10 KB/sec | 191.6 msgs/sec | window 5.0s, 250.78 KB | total 3.24 MB over 65.1s
```

### pyOCD

```
[RTT Logs stats] 25.85 KB/sec | 98.2 msgs/sec | window 5.0s, 129.50 KB | total 129.50 KB over 5.0s
[RTT Logs stats] 25.27 KB/sec | 95.1 msgs/sec | window 5.0s, 126.50 KB | total 256.00 KB over 10.0s
[RTT Logs stats] 24.65 KB/sec | 93.8 msgs/sec | window 5.0s, 123.55 KB | total 379.55 KB over 15.0s
[RTT Logs stats] 24.76 KB/sec | 92.9 msgs/sec | window 5.0s, 123.95 KB | total 503.50 KB over 20.1s
[RTT Logs stats] 24.56 KB/sec | 93.5 msgs/sec | window 5.0s, 122.93 KB | total 626.43 KB over 25.1s
[RTT Logs stats] 24.69 KB/sec | 92.3 msgs/sec | window 5.0s, 123.57 KB | total 750.00 KB over 30.1s
[RTT Logs stats] 24.09 KB/sec | 93.5 msgs/sec | window 5.0s, 120.54 KB | total 870.54 KB over 35.1s
[RTT Logs stats] 24.44 KB/sec | 92.6 msgs/sec | window 5.0s, 122.46 KB | total 993.00 KB over 40.1s
```

### STLink

```
[RTT Logs stats] 64.35 KB/sec | 219.8 msgs/sec | window 5.0s, 321.83 KB | total 321.83 KB over 5.0s
[RTT Logs stats] 61.87 KB/sec | 216.8 msgs/sec | window 5.0s, 309.67 KB | total 631.50 KB over 10.0s
[RTT Logs stats] 61.28 KB/sec | 216.7 msgs/sec | window 5.0s, 306.50 KB | total 938.00 KB over 15.0s
[RTT Logs stats] 61.54 KB/sec | 216.8 msgs/sec | window 5.0s, 308.00 KB | total 1.22 MB over 20.0s
[RTT Logs stats] 61.94 KB/sec | 217.5 msgs/sec | window 5.0s, 309.83 KB | total 1.52 MB over 25.0s
[RTT Logs stats] 60.56 KB/sec | 217.3 msgs/sec | window 5.0s, 302.97 KB | total 1.82 MB over 30.0s
[RTT Logs stats] 64.59 KB/sec | 222.9 msgs/sec | window 5.0s, 323.09 KB | total 2.13 MB over 35.0s
[RTT Logs stats] 64.17 KB/sec | 222.6 msgs/sec | window 5.0s, 321.11 KB | total 2.44 MB over 40.1s
[RTT Logs stats] 62.43 KB/sec | 218.7 msgs/sec | window 5.0s, 312.57 KB | total 2.75 MB over 45.1s
```

### JLink (fw programmed into STLink)

```
[RTT Logs stats] 67.45 KB/sec | 114.2 msgs/sec | window 5.0s, 337.38 KB | total 337.38 KB over 5.0s
[RTT Logs stats] 68.26 KB/sec | 114.3 msgs/sec | window 5.0s, 341.63 KB | total 679.00 KB over 10.0s
[RTT Logs stats] 67.11 KB/sec | 113.5 msgs/sec | window 5.0s, 335.98 KB | total 1014.98 KB over 15.0s
[RTT Logs stats] 67.80 KB/sec | 111.9 msgs/sec | window 5.0s, 339.41 KB | total 1.32 MB over 20.0s
[RTT Logs stats] 69.06 KB/sec | 112.1 msgs/sec | window 5.0s, 345.66 KB | total 1.66 MB over 25.0s
[RTT Logs stats] 68.14 KB/sec | 113.7 msgs/sec | window 5.0s, 341.09 KB | total 1.99 MB over 30.1s
[RTT Logs stats] 68.95 KB/sec | 114.3 msgs/sec | window 5.0s, 345.15 KB | total 2.33 MB over 35.1s
[RTT Logs stats] 70.17 KB/sec | 112.5 msgs/sec | window 5.0s, 351.21 KB | total 2.67 MB over 40.1s
[RTT Logs stats] 69.79 KB/sec | 115.0 msgs/sec | window 5.0s, 349.50 KB | total 3.01 MB over 45.1s
```

## Builtin RTT in Rust

### OpenOCD

```
[RTT Logs stats] 66.05 KB/sec | 183.0 msgs/sec | window 5.0s, 330.58 KB | total 330.58 KB over 5.0s
[RTT Logs stats] 66.40 KB/sec | 182.1 msgs/sec | window 5.0s, 332.25 KB | total 662.83 KB over 10.0s
[RTT Logs stats] 66.57 KB/sec | 179.3 msgs/sec | window 5.0s, 333.07 KB | total 995.90 KB over 15.0s
[RTT Logs stats] 66.65 KB/sec | 180.3 msgs/sec | window 5.0s, 333.54 KB | total 1.30 MB over 20.0s
[RTT Logs stats] 66.12 KB/sec | 181.8 msgs/sec | window 5.0s, 330.94 KB | total 1.62 MB over 25.0s
[RTT Logs stats] 65.26 KB/sec | 179.3 msgs/sec | window 5.0s, 326.77 KB | total 1.94 MB over 30.1s
[RTT Logs stats] 65.65 KB/sec | 179.4 msgs/sec | window 5.0s, 328.63 KB | total 2.26 MB over 35.1s
[RTT Logs stats] 66.52 KB/sec | 181.0 msgs/sec | window 5.0s, 332.91 KB | total 2.59 MB over 40.1s
[RTT Logs stats] 66.29 KB/sec | 179.2 msgs/sec | window 5.0s, 331.80 KB | total 2.91 MB over 45.1s
[RTT Logs stats] 67.05 KB/sec | 181.7 msgs/sec | window 5.0s, 335.45 KB | total 3.24 MB over 50.1s
[RTT Logs stats] 66.91 KB/sec | 178.6 msgs/sec | window 5.0s, 334.64 KB | total 3.57 MB over 55.1s
[RTT Logs stats] 65.89 KB/sec | 180.3 msgs/sec | window 5.0s, 329.65 KB | total 3.89 MB over 60.1s
[RTT Logs stats] 66.24 KB/sec | 177.1 msgs/sec | window 5.0s, 331.38 KB | total 4.21 MB over 65.1s
[RTT Logs stats] 65.25 KB/sec | 179.3 msgs/sec | window 5.0s, 326.45 KB | total 4.53 MB over 70.1s
```

### STLink

```
[RTT Logs stats] 91.23 KB/sec | 184.9 msgs/sec | window 5.0s, 456.33 KB | total 456.33 KB over 5.0s
[RTT Logs stats] 88.87 KB/sec | 180.7 msgs/sec | window 5.0s, 444.54 KB | total 900.88 KB over 10.0s
[RTT Logs stats] 88.35 KB/sec | 177.6 msgs/sec | window 5.0s, 441.86 KB | total 1.31 MB over 15.0s
[RTT Logs stats] 92.18 KB/sec | 185.2 msgs/sec | window 5.0s, 461.01 KB | total 1.76 MB over 20.0s
[RTT Logs stats] 91.39 KB/sec | 182.1 msgs/sec | window 5.0s, 457.31 KB | total 2.21 MB over 25.0s
[RTT Logs stats] 90.15 KB/sec | 183.3 msgs/sec | window 5.0s, 451.37 KB | total 2.65 MB over 30.0s
[RTT Logs stats] 89.07 KB/sec | 178.6 msgs/sec | window 5.0s, 445.42 KB | total 3.08 MB over 35.0s
[RTT Logs stats] 91.06 KB/sec | 177.5 msgs/sec | window 5.0s, 455.47 KB | total 3.53 MB over 40.0s
[RTT Logs stats] 90.50 KB/sec | 183.0 msgs/sec | window 5.0s, 453.03 KB | total 3.97 MB over 45.1s
[RTT Logs stats] 90.57 KB/sec | 183.5 msgs/sec | window 5.0s, 453.01 KB | total 4.41 MB over 50.1s
[RTT Logs stats] 91.41 KB/sec | 180.7 msgs/sec | window 5.0s, 457.43 KB | total 4.86 MB over 55.1s
[RTT Logs stats] 90.55 KB/sec | 181.5 msgs/sec | window 5.0s, 453.09 KB | total 5.30 MB over 60.1s
[RTT Logs stats] 89.58 KB/sec | 177.0 msgs/sec | window 5.0s, 448.34 KB | total 5.74 MB over 65.1s
[RTT Logs stats] 90.81 KB/sec | 181.5 msgs/sec | window 5.0s, 454.23 KB | total 6.18 MB over 70.1s
[RTT Logs stats] 90.14 KB/sec | 184.0 msgs/sec | window 5.0s, 450.77 KB | total 6.62 MB over 75.1s
[RTT Logs stats] 89.58 KB/sec | 177.6 msgs/sec | window 5.0s, 448.00 KB | total 7.06 MB over 80.1s
```

### JLink

```
[RTT Logs stats] 80.93 KB/sec | 112.1 msgs/sec | window 5.0s, 404.96 KB | total 404.96 KB over 5.0s
[RTT Logs stats] 80.35 KB/sec | 112.5 msgs/sec | window 5.0s, 402.24 KB | total 807.20 KB over 10.0s
[RTT Logs stats] 80.62 KB/sec | 113.2 msgs/sec | window 5.0s, 403.20 KB | total 1.18 MB over 15.0s
[RTT Logs stats] 80.33 KB/sec | 114.7 msgs/sec | window 5.0s, 402.54 KB | total 1.58 MB over 20.0s
[RTT Logs stats] 80.91 KB/sec | 112.9 msgs/sec | window 5.0s, 404.94 KB | total 1.97 MB over 25.1s
[RTT Logs stats] 80.81 KB/sec | 111.9 msgs/sec | window 5.0s, 404.28 KB | total 2.37 MB over 30.1s
[RTT Logs stats] 80.10 KB/sec | 112.0 msgs/sec | window 5.0s, 401.38 KB | total 2.76 MB over 35.1s
[RTT Logs stats] 79.69 KB/sec | 110.4 msgs/sec | window 5.0s, 398.52 KB | total 3.15 MB over 40.1s
[RTT Logs stats] 79.87 KB/sec | 110.6 msgs/sec | window 5.0s, 399.42 KB | total 3.54 MB over 45.1s
[RTT Logs stats] 80.89 KB/sec | 113.0 msgs/sec | window 5.0s, 404.54 KB | total 3.93 MB over 50.1s
[RTT Logs stats] 80.69 KB/sec | 111.5 msgs/sec | window 5.0s, 403.86 KB | total 4.33 MB over 55.1s
[RTT Logs stats] 80.67 KB/sec | 111.3 msgs/sec | window 5.0s, 403.83 KB | total 4.72 MB over 60.2s
[RTT Logs stats] 80.73 KB/sec | 112.6 msgs/sec | window 5.0s, 404.20 KB | total 5.12 MB over 65.2s
[RTT Logs stats] 82.06 KB/sec | 113.2 msgs/sec | window 5.0s, 410.88 KB | total 5.52 MB over 70.2s
```

# RTT provided by gdb-server

## Openocd

```
[RTT Logs stats] 81.62 KB/sec | 162.6 msgs/sec | window 5.0s, 408.68 KB | total 408.68 KB over 5.0s
[RTT Logs stats] 81.17 KB/sec | 161.9 msgs/sec | window 5.0s, 406.02 KB | total 814.69 KB over 10.0s
[RTT Logs stats] 80.77 KB/sec | 160.8 msgs/sec | window 5.0s, 403.95 KB | total 1.19 MB over 15.0s
[RTT Logs stats] 80.12 KB/sec | 162.5 msgs/sec | window 5.0s, 400.77 KB | total 1.58 MB over 20.0s
[RTT Logs stats] 79.54 KB/sec | 161.7 msgs/sec | window 5.0s, 398.04 KB | total 1.97 MB over 25.0s
[RTT Logs stats] 79.46 KB/sec | 163.7 msgs/sec | window 5.0s, 397.92 KB | total 2.36 MB over 30.1s
[RTT Logs stats] 78.12 KB/sec | 159.2 msgs/sec | window 5.0s, 391.15 KB | total 2.74 MB over 35.1s
[RTT Logs stats] 80.68 KB/sec | 163.2 msgs/sec | window 5.0s, 403.48 KB | total 3.13 MB over 40.1s
[RTT Logs stats] 81.02 KB/sec | 162.5 msgs/sec | window 5.0s, 405.26 KB | total 3.53 MB over 45.1s
```

## pyOCD

Not functional...same issue as openocd, we have to poll and start rtt and we don't know how to do
that yet as we use the tcl channel for doing that polling. Not worth that investment.

## STlink

Not supported by stlink

## JLink (fw programmed into STLink)

```
[RTT Logs stats] 59.04 KB/sec | 24.1 msgs/sec | window 5.0s, 296.12 KB | total 296.12 KB over 5.0s
[RTT Logs stats] 150.68 KB/sec | 55.0 msgs/sec | window 5.0s, 753.68 KB | total 1.03 MB over 10.0s
[RTT Logs stats] 152.80 KB/sec | 54.7 msgs/sec | window 5.0s, 765.67 KB | total 1.77 MB over 15.1s
[RTT Logs stats] 152.67 KB/sec | 54.0 msgs/sec | window 5.0s, 763.66 KB | total 2.52 MB over 20.1s
[RTT Logs stats] 152.79 KB/sec | 54.3 msgs/sec | window 5.0s, 765.79 KB | total 3.27 MB over 25.1s
[RTT Logs stats] 152.77 KB/sec | 54.0 msgs/sec | window 5.0s, 765.98 KB | total 4.01 MB over 30.1s
[RTT Logs stats] 152.85 KB/sec | 54.9 msgs/sec | window 5.0s, 765.16 KB | total 4.76 MB over 35.2s
[RTT Logs stats] 152.96 KB/sec | 54.8 msgs/sec | window 5.0s, 764.96 KB | total 5.51 MB over 40.2s
[RTT Logs stats] 152.75 KB/sec | 54.4 msgs/sec | window 5.0s, 766.37 KB | total 6.26 MB over 45.2s
```
