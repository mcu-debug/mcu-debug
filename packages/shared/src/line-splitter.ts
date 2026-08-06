

export class LineSplitter {
    private buffer: string = '';
    private timer: NodeJS.Timeout | null = null;

    constructor(
        private callback: (line: string, prefix: string, partial: boolean) => void,
        private prefix: string = '',
        private flushTimerMs: number = 500) {       // Use 0 to disable the flush timer
    }

    public write(data: string): void {
        this.clearTimer();
        this.buffer += data.replace(/\r\n/g, '\n'); // Normalize line endings to LF
        let indexLF: number;
        let indexCR: number;
        while (this.buffer.length > 0) {
            indexLF = this.buffer.indexOf('\n');
            indexCR = this.buffer.indexOf('\r');
            if (indexLF < 0 && indexCR < 0) {
                break;
            }
            let index: number;
            if (indexLF >= 0 && indexCR >= 0) {
                index = Math.min(indexLF, indexCR);
            } else {
                index = Math.max(indexLF, indexCR);
            }
            let line = this.buffer.slice(0, index);
            this.callback(line, this.prefix, false);
            this.buffer = this.buffer.slice(index + 1);
        }
        if (this.buffer.length > 0 && this.flushTimerMs > 0) {
            this.timer = setTimeout(() => {
                if (this.buffer.length > 0) {
                    this.callback(this.buffer, this.prefix, true);
                }
                this.timer = null;
            }, this.flushTimerMs);
        }
    }

    public end(): void {
        this.clearTimer();
        if (this.buffer.length > 0) {
            this.callback(this.buffer, this.prefix, false);
            this.buffer = '';
        }
    }

    private clearTimer() {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }
}
