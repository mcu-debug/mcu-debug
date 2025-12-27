import { GDBDebugSession } from "../gdb-session";
import { GdbInstance } from "./gdb-instance";
import { GdbMiRecord } from "./mi-types";

export class MiCommands {
    public readonly gdbInstance: GdbInstance;
    constructor(
        public readonly debugSession: GDBDebugSession,
        isLive: boolean,
    ) {
        this.gdbInstance = isLive ? debugSession.liveGdbInstance! : debugSession.gdbInstance!;
    }

    sendContinue(threadGroup: number | undefined): Promise<GdbMiRecord> {
        const cmd = "-exec-continue" + (threadGroup !== undefined ? ` --thread-group ${threadGroup}` : "");
        return this.gdbInstance.sendCommand(cmd);
    }
    sendStepIn(instr = false): Promise<GdbMiRecord> {
        const cmd = `-exec-step${instr ? "-instruction" : ""}`;
        return this.gdbInstance.sendCommand(cmd);
    }
    sendStepOut(): Promise<GdbMiRecord> {
        const cmd = "-exec-finish";
        return this.gdbInstance.sendCommand(cmd);
    }
    sendNext(instr = false): Promise<GdbMiRecord> {
        const cmd = `-exec-next${instr ? "-instruction" : ""}`;
        return this.gdbInstance.sendCommand(cmd);
    }
    sendGotoFileLine(file: string, line: number): Promise<GdbMiRecord> {
        return this.sendGoto(`"${file}":${line}`);
    }
    sendGoto(locSpec: string): Promise<GdbMiRecord> {
        const cmd = `-exec-jump ${locSpec}`;
        return this.gdbInstance.sendCommand(cmd);
    }
    sendHalt(threadGroup: number | undefined): Promise<GdbMiRecord> {
        const cmd = "-exec-interrupt" + (threadGroup !== undefined ? ` --thread-group ${threadGroup}` : "");
        return this.gdbInstance.sendCommand(cmd);
    }
}
