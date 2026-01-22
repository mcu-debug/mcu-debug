// @ts-strict-ignore
import { DebugProtocol } from "@vscode/debugprotocol";
import { GDBDebugSession } from "./gdb-session";
import { GdbInstance } from "./gdb-mi/gdb-instance";
import { formatAddress, parseAddress } from "../frontend/utils";

export class MemoryRequests {
    constructor(
        private mainSession: GDBDebugSession,
        private gdbInstance: GdbInstance,
    ) {}
    private sendResponse(response: DebugProtocol.Response) {
        this.mainSession.sendResponse(response);
    }
    private handleErrResponse(response: DebugProtocol.Response, message: string) {
        this.mainSession.handleErrResponse(response, message);
    }

    public async readMemoryRequest(response: DebugProtocol.ReadMemoryResponse, args: DebugProtocol.ReadMemoryArguments): Promise<void> {
        try {
            const startAddress = parseAddress(args.memoryReference);
            const length = args.count;
            const offset = BigInt(args.offset || 0);
            const useAddr = startAddress + offset;

            const useAddrHex = formatAddress(useAddr);

            if (length === 0) {
                response.body = {
                    address: useAddrHex,
                    data: "",
                };
                this.sendResponse(response);
                return;
            }

            const command = `-data-read-memory-bytes "${useAddrHex}" ${length}`;
            const miOutput = await this.gdbInstance.sendCommand(command);
            const record = miOutput.resultRecord?.result;
            const memoryArray = record ? record["memory"] : undefined;

            if (!memoryArray || !Array.isArray(memoryArray) || memoryArray.length === 0) {
                throw new Error("No memory data returned from GDB");
            }

            // Error out if GDB returned multiple memory chunks (e.g., spanning regions)
            if (memoryArray.length > 1) {
                throw new Error(`Memory request spans multiple regions (${memoryArray.length} chunks). This can happen when memory crosses protection boundaries or unmapped regions.`);
            }

            const memory = memoryArray[0];

            // GDB always returns hex with "0x" prefix - parse back to BigInt
            const begin = parseAddress(memory["begin"] || "0x0");
            const recordOffset = parseAddress(memory["offset"] || "0x0");
            const actualStart = begin + recordOffset; // BigInt arithmetic stays 64-bit clean

            const contents = memory["contents"] || "";
            const b64Data = Buffer.from(contents, "hex").toString("base64");

            response.body = {
                data: b64Data,
                address: formatAddress(actualStart),
            };
            this.sendResponse(response);
        } catch (error) {
            this.handleErrResponse(response, `Read memory error: ${error.toString()}`);
        }
    }

    public async writeMemoryRequest(response: DebugProtocol.WriteMemoryResponse, args: DebugProtocol.WriteMemoryArguments): Promise<void> {
        try {
            const startAddress = parseAddress(args.memoryReference);
            const offset = BigInt(args.offset || 0);
            const useAddr = startAddress + offset;
            const useAddrHex = formatAddress(useAddr);

            // Convert base64 data to hex string (no 0x prefix for GDB command)
            const hexData = Buffer.from(args.data, "base64").toString("hex");

            if (hexData.length === 0) {
                response.body = {
                    bytesWritten: 0,
                };
                this.sendResponse(response);
                return;
            }

            const command = `-data-write-memory-bytes "${useAddrHex}" "${hexData}"`;
            await this.gdbInstance.sendCommand(command);

            // Calculate bytes written (each hex pair is one byte)
            const bytesWritten = hexData.length / 2;

            response.body = {
                bytesWritten: bytesWritten,
            };
            this.sendResponse(response);
        } catch (error) {
            this.handleErrResponse(response, `Write memory error: ${error.toString()}`);
        }
    }
}
