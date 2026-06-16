export class BinaryRingBuffer {
    private buffer: Buffer;
    private head: number;
    private tail: number;
    private isFull: boolean;
    private capacity: number;

    constructor(capacity: number) {
        this.capacity = capacity;
        this.buffer = Buffer.alloc(capacity); // Pre-allocate raw binary space
        this.head = 0;
        this.tail = 0;
        this.isFull = false;
    }

    isEmpty(): boolean {
        return this.head === this.tail && !this.isFull;
    }

    write(byte: number) {
        this.buffer[this.tail] = byte;
        if (this.isFull) {
            this.head = (this.head + 1) % this.capacity;
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

    clear() {
        this.head = 0;
        this.tail = 0;
        this.isFull = false;
    }
}
