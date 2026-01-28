import * as child_process from "child_process";
import * as net from "net";
import { EventEmitter } from "events";
import { Stream } from "stream";

export interface DecoderSpec {
    program: string;
    args: string[];
    cwd?: string;
    env?: Object;
}

export class Decoder extends EventEmitter {
    spec: DecoderSpec;
    process?: child_process.ChildProcess;

    constructor(spec: DecoderSpec) {
        super();
        this.spec = Object.assign({}, spec); // Deep copy
        this.spec.cwd = spec.cwd || process.cwd();
        this.spec.env = { ...process.env, ...(spec.env || {}) };
    }

    getProgram(): string {
        return this.spec.program;
    }

    getArgs(): string[] {
        return this.spec.args;
    }

    getCwd(): string | undefined {
        return this.spec.cwd;
    }

    runProgram(stdio?: any): Promise<void> {
        return new Promise((resolve, reject) => {
            const obj: any = {
                cwd: this.getCwd(),
                env: this.spec.env,
                detached: true,
            };
            if (stdio) {
                obj.stdio = stdio;
            }
            this.process = child_process.spawn(this.getProgram(), this.getArgs(), obj);

            this.process.stdout?.on("data", (data: Buffer) => {
                this.emit("stdout", data);
            });

            this.process.stderr?.on("data", (data: Buffer) => {
                this.emit("stderr", data);
            });

            this.process.on("close", (code: number) => {
                this.emit("close", code);
            });

            this.process.on("error", (err: Error) => {
                this.emit("error", err);
                reject(err);
            });

            this.process.on("spawn", () => {
                resolve();
            });

            this.on("stdin", async (data: Buffer) => {
                await this.writeStdin(data);
            });
        });
    }

    setStdinPiped(stream: Stream.Writable): void {
        stream.pipe(this.process?.stdin!);
    }
    setStdoutPiped(stream: Stream.Writable): void {
        this.process?.stdout?.pipe(stream);
    }
    setStderrPiped(stream: Stream.Writable): void {
        this.process?.stderr?.pipe(stream);
    }

    async writeStdin(data: Buffer): Promise<void> {
        if (this.process && this.process.stdin && this.process.stdin.writable) {
            if (!this.process.stdin.write(data)) {
                await this.process.stdin.once("drain", () => {});
            }
        }
    }

    close(): void {
        if (this.process) {
            this.process.stdin?.end();
            setTimeout(() => {
                this.process?.stdout?.destroy();
                this.process?.stderr?.destroy();
                this.process?.kill();
                this.process = undefined;
            }, 10);
        }
    }

    dispose(): void {
        this.close();
        this.removeAllListeners();
    }
}
