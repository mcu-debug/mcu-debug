import { DebugProtocol } from "@vscode/debugprotocol";
import { GDBDebugSession } from "./gdb-session";
import { GdbInstance } from "./gdb-mi/gdb-instance";
import { formatAddress, parseAddress } from "../frontend/utils";
import { GdbMiRecord } from "./gdb-mi/mi-types";

export type MemoryReadCallback = (b: Buffer, len: number) => Promise<void>;
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

    public async readMemoryBytes(address: bigint, length: number, callback?: MemoryReadCallback): Promise<Buffer> {
        try {
            let ret = Buffer.alloc(0);
            let promises: Promise<void>[] = [];
            while (length > 0) {
                const addressHex = formatAddress(address);
                const chunkSize = Math.min(length, 512); // Read in 512B chunks to avoid GDB limits
                const command = `-data-read-memory-bytes "${addressHex}" ${chunkSize}`;
                const miOutput = await this.gdbInstance.sendCommand(command);
                const record = miOutput.resultRecord?.result as any;
                const memoryArray = record ? record["memory"] : undefined;

                if (!memoryArray || !Array.isArray(memoryArray) || memoryArray.length === 0) {
                    throw new Error("No memory data returned from GDB");
                }

                // Error out if GDB returned multiple memory chunks (e.g., spanning regions)
                if (memoryArray.length > 1) {
                    throw new Error(`Memory request spans multiple regions (${memoryArray.length} chunks). This can happen when memory crosses protection boundaries or unmapped regions.`);
                }

                const memory = memoryArray[0];

                const contents = memory["contents"] || "";
                const chunk = Buffer.from(contents, "hex");
                ret = Buffer.concat([ret, chunk]);

                // GDB always returns hex with "0x" prefix - parse back to BigInt
                const begin = parseAddress(memory["begin"] || "0x0");
                const recordOffset = parseAddress(memory["offset"] || "0x0");
                const actualStart = begin + recordOffset; // BigInt arithmetic stays 64-bit clean
                if (actualStart != address) {
                    throw new Error(`GDB returned memory from unexpected address. Requested ${formatAddress(address)}, got ${formatAddress(actualStart)}`);
                }
                const end = parseAddress(memory["end"] || "0x0");
                const actualLength = Number(end - actualStart);
                if (actualLength < chunkSize) {
                    // GDB returned less data than requested - likely hit unmapped region
                    break; // End loop
                }
                if (callback) {
                    promises.push(callback(chunk, actualLength));
                }

                length -= chunkSize;
                address += BigInt(chunkSize);
            }
            await Promise.all(promises);
            return ret;
        } catch (error: any) {
            throw new Error(`Read memory error: ${error.toString()}`);
        }
    }

    public async writeMemoryBytes(address: bigint, data: Buffer): Promise<void> {
        try {
            const addressHex = formatAddress(address);

            // Convert buffer to hex string (no 0x prefix for GDB command)
            const hexData = data.toString("hex");

            if (hexData.length === 0) {
                return;
            }

            const command = `-data-write-memory-bytes "${addressHex}" "${hexData}"`;
            await this.gdbInstance.sendCommand(command);
        } catch (error: any) {
            throw new Error(`Write memory error: ${error.toString()}`);
        }
    }

    public async readWord(addr: bigint): Promise<number> {
        const data = await this.readMemoryBytes(addr, 4);
        return data.readUInt32LE(0);
    }

    public async writeWord(addr: bigint, value: number): Promise<void> {
        const buffer = Buffer.alloc(4);
        buffer.writeUInt32LE(value, 0);
        await this.writeMemoryBytes(addr, buffer);
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

            const contents = await this.readMemoryBytes(useAddr, length);
            const b64Data = contents.toString("base64");

            response.body = {
                data: b64Data,
                address: formatAddress(useAddr),
            };
            this.sendResponse(response);
        } catch (error: any) {
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
        } catch (error: any) {
            this.handleErrResponse(response, `Write memory error: ${error.toString()}`);
        }
    }
}
