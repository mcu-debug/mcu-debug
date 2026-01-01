import { GDBDebugSession } from "../gdb-session";
import { GdbInstance } from "./gdb-instance";
import { GdbMiOutput } from "./mi-types";

export class MiCommands {
    constructor(public readonly gdbInstance: GdbInstance) {}

    sendContinue(threadGroup: number | undefined): Promise<GdbMiOutput> {
        const cmd = "-exec-continue" + (threadGroup !== undefined ? ` --thread-group ${threadGroup}` : "");
        return this.gdbInstance.sendCommand(cmd);
    }
    sendStepIn(instr = false): Promise<GdbMiOutput> {
        const cmd = `-exec-step${instr ? "-instruction" : ""}`;
        return this.gdbInstance.sendCommand(cmd);
    }
    sendStepOut(): Promise<GdbMiOutput> {
        const cmd = "-exec-finish";
        return this.gdbInstance.sendCommand(cmd);
    }
    sendNext(instr = false): Promise<GdbMiOutput> {
        const cmd = `-exec-next${instr ? "-instruction" : ""}`;
        return this.gdbInstance.sendCommand(cmd);
    }
    sendGotoFileLine(file: string, line: number): Promise<GdbMiOutput> {
        return this.sendGoto(`"${file}":${line}`);
    }
    sendGoto(locSpec: string): Promise<GdbMiOutput> {
        const cmd = `-exec-jump ${locSpec}`;
        return this.gdbInstance.sendCommand(cmd);
    }
    sendHalt(threadGroup: number | undefined): Promise<GdbMiOutput> {
        const cmd = "-exec-interrupt" + (threadGroup !== undefined ? ` --thread-group ${threadGroup}` : "");
        return this.gdbInstance.sendCommand(cmd);
    }

    sendDataEvaluateExpression<T>(expr: string): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const cmd = `-data-evaluate-expression \"${expr}\"`;
            this.gdbInstance
                .sendCommand(cmd)
                .then((output) => {
                    const record = output.resultRecord ?? (output.outOfBandRecords && output.outOfBandRecords.length > 0 ? output.outOfBandRecords[0] : undefined);
                    if (record) {
                        const value = (record.result as any)["value"];
                        if (value !== undefined) {
                            resolve(value as T);
                            return;
                        }
                    }
                    reject(new Error(`Failed to evaluate expression '${expr}'`));
                })
                .catch(reject);
        });
    }
}
