/**
 * Byte-rate measurement for a trace stream.
 *
 * Lives here rather than in `rtt-builtin.ts`, where it started, because the number is only
 * meaningful when the same code measures every path. Built-in RTT reads target memory and
 * serves the bytes on its own TCP port; a gdb-server's RTT serves them directly. Comparing
 * those two, or one server against another, means measuring at the same place with the same
 * arithmetic -- otherwise the difference being measured is ours.
 *
 * **Measure the bytes going in, at the last consumer.** Not the bytes a pre-decoder or pipe
 * program produces: `defmt-print` turns a few bytes of frame into a line of text, so its
 * output rate says more about the log format than about the probe. Counting input at the far
 * end still catches throttling anywhere upstream -- if a terminal cannot keep up and the
 * socket backs up behind it, fewer bytes per second arrive here, which is exactly the effect
 * worth seeing.
 */
export class ThroughputMonitor {
    private totalBytes = 0;
    private messageCount = 0;
    /** Start of the current reporting window. */
    private windowStart = 0;
    /** First byte ever seen, for a real uptime. 0 until something arrives. */
    private firstByteAt = 0;
    private lastReportTime = 0;
    private windowsReported = 0;
    private allBytes = 0;

    /**
     * @param report where a line of statistics goes. A callback rather than a session,
     *   because this runs in the debug adapter, the extension host and the CLI.
     * @param label identifies the stream in the report, e.g. `RTT CH:0`.
     * @param intervalMs how often to report. The window is at least this long; it is closed
     *   by the arrival of data, so an idle stream reports nothing rather than reporting zero.
     */
    constructor(
        private readonly report: (msg: string) => void,
        private readonly label: string,
        private readonly intervalMs = 5000,
    ) {}

    /** Call for every buffer received from the stream. */
    public record(buffer: Buffer, msgCount: number = 1) {
        const now = Date.now();
        if (this.messageCount === 0) {
            // Start the window at the first byte *of this window*, so an idle gap is not
            // averaged into the rate. Without this a stream that is quiet for a minute and
            // then bursts reads as slow, which is the opposite of what happened.
            this.windowStart = now;
            this.lastReportTime = now;
            if (this.firstByteAt === 0) {
                this.firstByteAt = now;
            }
        }
        this.totalBytes += buffer.length;
        this.allBytes += buffer.length;
        this.messageCount += msgCount;

        if (now - this.lastReportTime > this.intervalMs) {
            this.flush(now);
        }
    }

    /**
     * Report the window that has accumulated, if any, and start a new one.
     *
     * Public so a caller can produce a final line at the end of a run: the last window is
     * almost never full, and for a short measurement it may be the only one.
     */
    public flush(now = Date.now()) {
        if (this.messageCount === 0) {
            return; // Nothing arrived; a report of 0 B/s would be about the idle gap, not the stream.
        }
        // The window is measured from its first byte to now, not from the previous report --
        // those differ by exactly the idle gap that must not be counted.
        const seconds = Math.max((now - this.windowStart) / 1000, 0.001);
        const bytesPerSec = this.totalBytes / seconds;
        const msgPerSec = this.messageCount / seconds;
        // Uptime is from the first byte ever, which is what "uptime" means. It used to be
        // reset at the start of every window, so it always read as one window length.
        const uptime = (now - this.firstByteAt) / 1000;

        this.report(
            `[${this.label} stats] ${fmtRate(bytesPerSec)} | ${msgPerSec.toFixed(1)} msgs/sec | ` +
                `window ${seconds.toFixed(1)}s, ${fmtBytes(this.totalBytes)} | total ${fmtBytes(this.allBytes)} over ${uptime.toFixed(1)}s`,
        );

        this.windowsReported++;
        this.totalBytes = 0;
        this.messageCount = 0;
        this.lastReportTime = now;
    }

    /** Bytes seen since the first one, across every window. For a test or a final summary. */
    public get bytesTotal(): number {
        return this.allBytes;
    }

    /** Average over the whole run, which is the number to quote when comparing servers. */
    public get averageBytesPerSec(): number {
        if (this.firstByteAt === 0) {
            return 0;
        }
        const seconds = Math.max((Date.now() - this.firstByteAt) / 1000, 0.001);
        return this.allBytes / seconds;
    }

    public get reportCount(): number {
        return this.windowsReported;
    }
}

/** Bytes as B/KB/MB, so 70 KB/s does not have to be read out of `71680.00`. */
export function fmtBytes(bytes: number): string {
    if (bytes >= 1024 * 1024) {
        return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    }
    if (bytes >= 1024) {
        return `${(bytes / 1024).toFixed(2)} KB`;
    }
    return `${bytes.toFixed(0)} B`;
}

export function fmtRate(bytesPerSec: number): string {
    return `${fmtBytes(bytesPerSec)}/sec`;
}
