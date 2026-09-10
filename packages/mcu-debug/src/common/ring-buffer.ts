export class BinaryRingBuffer {
    private buffer: Buffer;
    private head: number;
    private tail: number;
    private isFull: boolean;
    private capacity: number;
    // True once at least one byte has actually been overwritten, i.e. `head` no longer sits at a
    // record boundary. Distinct from `isFull`, which is also true the instant the buffer fills
    // exactly, before anything has been lost.
    private overwritten: boolean;

    constructor(capacity: number) {
        this.capacity = capacity;
        this.buffer = Buffer.alloc(capacity); // Pre-allocate raw binary space
        this.head = 0;
        this.tail = 0;
        this.isFull = false;
        this.overwritten = false;
    }

    isEmpty(): boolean {
        return this.head === this.tail && !this.isFull;
    }

    write(byte: number) {
        this.buffer[this.tail] = byte;
        if (this.isFull) {
            this.head = (this.head + 1) % this.capacity;
            this.overwritten = true;
        }
        this.tail = (this.tail + 1) % this.capacity;
        this.isFull = this.tail === this.head;
    }

    writeBuffer(data: Buffer) {
        for (const byte of data) {
            this.write(byte);
        }
    }

    read(): number | null {
        if (this.tail === this.head && !this.isFull) return null; // Empty
        const val = this.buffer[this.head];
        this.isFull = false;
        this.head = (this.head + 1) % this.capacity;
        return val;
    }

    snapshot(): Buffer {
        if (this.isFull) {
            return Buffer.concat([this.buffer.subarray(this.head), this.buffer.subarray(0, this.head)]);
        } else if (this.tail >= this.head) {
            return this.buffer.subarray(this.head, this.tail); // Return a copy of the valid data
        } else {
            return Buffer.concat([this.buffer.subarray(this.head), this.buffer.subarray(0, this.tail)]);
        }
    }

    /**
     * Snapshot that always begins at a record boundary. Once the buffer has overwritten anything,
     * `head` lands at an arbitrary byte offset, so the first record of a raw snapshot() is a
     * fragment — a consumer parsing newline-delimited JSON would throw on it. Use this instead of
     * snapshot() whenever the contents are delimited records rather than opaque bytes.
     *
     * Returns an empty buffer if no delimiter is present (a single record longer than capacity).
     */
    snapshotFromRecordStart(delimiter: number = 0x0a): Buffer {
        const snap = this.snapshot();
        if (!this.overwritten) {
            return snap; // Nothing lost yet — head is still at the very first byte written.
        }
        const idx = snap.indexOf(delimiter);
        return idx < 0 ? Buffer.alloc(0) : snap.subarray(idx + 1);
    }

    clear() {
        this.head = 0;
        this.tail = 0;
        this.isFull = false;
        this.overwritten = false;
    }
}
