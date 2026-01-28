import * as child_process from "child_process";
import { EventEmitter } from "events";
import { Stream } from "stream";
export interface DecoderSpec {
    program: string;
    args: string[];
    cwd?: string;
    env?: Object;
}
export declare class Decoder extends EventEmitter {
    spec: DecoderSpec;
    process?: child_process.ChildProcess;
    constructor(spec: DecoderSpec);
    getProgram(): string;
    getArgs(): string[];
    getCwd(): string | undefined;
    runProgram(stdio?: any): Promise<void>;
    setStdinPiped(stream: Stream.Writable): void;
    setStdoutPiped(stream: Stream.Writable): void;
    setStderrPiped(stream: Stream.Writable): void;
    writeStdin(data: Buffer): Promise<void>;
    close(): void;
    dispose(): void;
}
