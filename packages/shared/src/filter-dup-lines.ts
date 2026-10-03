// Copyright (c) 2026 MCU-Debug Authors.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { LineSplitter } from "./line-splitter";

export class FilterLineDups {
    private lastLine: string = "";
    private lastTimeMs: number = Date.now();
    private lastLineCount: number = 0;
    private flushTimer: NodeJS.Timeout | null = null;
    constructor(
        // flush is called to output a line or a repeated line message.
        private readonly flush: (str: string) => void,
        public readonly flushIntervalsMs: number = 5000,
    ) {
        if (this.flushIntervalsMs <= 0) {
            throw new Error("flushIntervalsMs must be positive");
        }
    }

    private repeatMsg(): string {
        return this.lastLine + ` (line repeated ${this.lastLineCount} times)`;
    }

    private clearTimer(): void {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
    }

    // Add a line without a trailing newline and handle duplicate suppression
    // A return of false means do not print the line because it is a duplicate.
    // A return of a string means the line should be printed immediately.
    public addLine(line: string): string | false {
        const now = Date.now();
        if (line !== this.lastLine || now - this.lastTimeMs >= this.flushIntervalsMs) {
            this.clearTimer();
            this.flushDupMsg();
            this.lastLine = line;
            this.lastTimeMs = now;
            return line;
        }

        this.lastLineCount++;
        if (!this.flushTimer) {
            this.flushTimer = setTimeout(() => {
                this.flushDupMsg();
                this.flushTimer = null;
            }, this.flushIntervalsMs);
            this.flushTimer.unref();
        }
        return false;
    }

    public flushDupMsg() {
        this.clearTimer();
        if (this.lastLineCount > 0) {
            if (this.lastLineCount === 1) {
                this.flush(this.lastLine);
            } else {
                this.flush(this.repeatMsg());
            }
            this.lastLineCount = 0;
        }
    }

    // Owner must call this; flushes any pending repeat message.
    public dispose(): void {
        this.flushDupMsg();
    }
}

export class FilterLineDupsMultiple {
    private splitter: LineSplitter;
    private dupFilter: FilterLineDups;
    // Text of the current line already flushed as a partial (splitter timed out mid-line).
    // LineSplitter re-delivers the whole buffer each time, so we only print what is new.
    private partialPrinted: string = "";
    constructor(
        private readonly flush: (str: string) => void,
        splitterWaitMs: number = 500,
        flushIntervalsMs: number = 5000,
    ) {
        this.splitter = new LineSplitter(this.splitterCb.bind(this), "", splitterWaitMs);
        this.dupFilter = new FilterLineDups(this.dupCb.bind(this), flushIntervalsMs);
    }

    public addChunk(chunk: string): void {
        this.splitter.write(chunk);
    }

    private splitterCb(line: string, prefix: string, partial: boolean): void {
        if (this.partialPrinted && !line.startsWith(this.partialPrinted)) {
            // Should not happen; terminate what we printed rather than garble the output
            this.flush("\n");
            this.partialPrinted = "";
        }
        const rest = line.slice(this.partialPrinted.length);
        if (partial) {
            // After splitter waited for splitterWaitMs, any partial line should be flushed immediately.
            // without a newline at the end.
            if (!this.partialPrinted) {
                this.dupFilter.flushDupMsg();
            }
            this.flush(rest);
            this.partialPrinted = line;
        } else if (this.partialPrinted) {
            // Completing a line that was partially shown; not a candidate for dup suppression
            this.flush(rest + "\n");
            this.partialPrinted = "";
        } else if (this.dupFilter.addLine(line) !== false) {
            this.flush(line + "\n");
        }
    }

    private dupCb(line: string): void {
        this.flush(line + "\n");
    }

    // Owner must call this when the stream ends; flushes any buffered partial line and pending repeat message.
    public dispose(): void {
        this.splitter.end();
        this.dupFilter.dispose();
    }
}
