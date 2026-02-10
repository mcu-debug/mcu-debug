import { existsSync } from "fs";
import { spawn, ChildProcess } from "child_process";
import { Stderr, Stdout } from "./gdb-mi/mi-types";
import { GDBDebugSession } from "./gdb-session";
import { SymbolFile, validateELFHeader } from "./servers/common";
import type { DisasmResponse } from "@mcu-debug/shared/dasm-helper/DisasmResponse";
import type { GlobalsResponse } from "@mcu-debug/shared/dasm-helper/GlobalsResponse";
import type { StaticsResponse } from "@mcu-debug/shared/dasm-helper/StaticsResponse";
import type { SymbolLookupResponse } from "@mcu-debug/shared/dasm-helper/SymbolLookupResponse";
import type { HelperEvent } from "@mcu-debug/shared/dasm-helper/HelperEvent";
import { getObjdumpPath } from "./symbols";

type HelperResponse = DisasmResponse | GlobalsResponse | StaticsResponse | SymbolLookupResponse;

interface PendingRequest {
    resolve: (value: HelperResponse) => void;
    reject: (reason?: any) => void;
    type: string;
}

/**
 * Wraps a promise with a timeout, rejecting if it takes too long.
 * @param {number} millis - The timeout duration in milliseconds.
 * @param {Promise<any>} promise - The promise to run with a timeout.
 * @returns {Promise<any>} A new promise that resolves/rejects with the original promise's outcome or a timeout error.
 */
export function withTimeout(millis: number, promise: Promise<any>): Promise<any> {
    let timeoutId: NodeJS.Timeout;
    // Create a promise that rejects after 'millis'
    const timeout = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            reject(new Error(`Timed out after ${millis} ms.`));
        }, millis);
    });

    // Race the original promise and the timeout promise
    return Promise.race([promise, timeout]).finally(() => {
        // Clear the timeout when the race is over (either way)
        clearTimeout(timeoutId);
    });
}

/**
 * DebugHelper manages communication with the mcu-debug-helper Rust process.
 *
 * Protocol: Content-Length based (same as DAP/LSP)
 * - Both directions use: "Content-Length: <bytes>\r\n\r\n<JSON body>"
 * - Rust side: See packages/mcu-debug-helper/src/transport.rs:StdioTransport
 *
 * Traffic characteristics:
 * - TS -> Rust: Light, infrequent (requests for disassembly, symbol lookups, etc.)
 * - Rust -> TS: Can be heavy and bursty (disassembly responses with thousands of instructions, events)
 *
 * Performance considerations for heavy/bursty traffic:
 * - Messages processed in batches (MAX_MESSAGES_PER_BATCH at a time)
 * - Uses setImmediate() to yield control back to event loop between batches
 * - Prevents blocking the debugger UI during large data transfers
 */
export class DebugHelper {
    // If the RTT symbol promise is resolved naturally, this will be set to the address of the RTT control
    // block (e.g. _SEGGER_RTT) for use in the adapter's RTT implementation. If the entire symbol table
    // is loaded and we still don't have the RTT symbol, this will remain undefined and RTT features will be disabled.
    // You can chose to wait on the promise 'rttSymbolReady' to know when the search is complete and the result is
    // ready (address or not).
    public rttSymbolAddress?: string;
    public symbolTableReady: Promise<void>;
    public rttSymbolReady: Promise<void>;
    private lookingForRTT = false;
    private symbolTableResolve!: () => void;
    private symbolTableReject!: (reason?: any) => void;
    private rttSymbolResolve!: () => void;
    private rttSymbolReject!: (reason?: any) => void;
    process: NodeJS.Process = process;
    private helperProcess?: ChildProcess;
    private rawBuffer = Buffer.alloc(0);
    private stderrBuffer = "";
    private pendingRequests = new Map<number, PendingRequest>();
    private nextSeq = 1;
    private processingMessages = false;
    private messagesProcessedInBatch = 0;
    private readonly MAX_MESSAGES_PER_BATCH = 50; // Process at most 50 messages before yielding
    private startTime = Date.now();

    // Reusable buffers for protocol parsing (avoid allocations in hot path)
    private static readonly CRLF_CRLF = Buffer.from("\r\n\r\n");
    private static readonly NL_NL = Buffer.from("\n\n");

    constructor(private session: GDBDebugSession) {
        this.rttSymbolReady = new Promise<void>((resolve, reject) => {
            // This will be resolved when the RTT symbol is found during initialization (if enabled)
            this.rttSymbolResolve = resolve;
            this.rttSymbolReject = reject;
        });
        this.symbolTableReady = new Promise<void>((resolve, reject) => {
            this.symbolTableResolve = resolve;
            this.symbolTableReject = reject;
        });
    }

    async initialize(fileConfigs: SymbolFile[]): Promise<void> {
        try {
            const files = fileConfigs.map((cfg) => cfg.file);
            const executables = [];
            for (const file of files) {
                if (!validateELFHeader(file)) {
                    this.session.handleMsg(Stderr, `Warning: ${file} is not an ELF file format. Some features won't work -- Globals, Locals, disassembly, etc.`);
                    continue;
                }
                executables.push(file);
            }
            if (executables.length === 0) {
                this.session.handleMsg(Stderr, `Warning: No valid ELF files provided. Debugging features will be limited.`);
                return;
            }

            const helperPath = this.getHelperExecutable();
            if (!helperPath) {
                throw new Error("Helper executable not found");
            }
            const objdumpPath = getObjdumpPath(this.session.args);

            const args = ["--objdump-path", objdumpPath];
            if (this.process.env.PROD_MCU_DEBUG_HELPER === "1") {
                args.push("--timing");
            }
            if (this.session.args.rttConfig?.enabled && (this.session.args.rttConfig.address === "auto" || !this.session.args.rttConfig.address)) {
                args.push(`--rtt-search`);
                this.lookingForRTT = true;
            } else if (this.rttSymbolResolve) {
                this.rttSymbolResolve(); // Resolve RTT promise since we're not looking for it, to avoid hanging any RTT-dependent features waiting for it
            }
            // Spawn the helper process with the list of executables as arguments
            this.session.handleMsg(Stdout, `Starting helper process: ${helperPath} ${[...args, ...executables].join(" ")}`);
            this.helperProcess = spawn(helperPath, [...args, ...executables], {
                stdio: ["pipe", "pipe", "pipe"],
            });

            if (!this.helperProcess.stdout || !this.helperProcess.stderr) {
                throw new Error("Failed to initialize helper process stdio");
            }

            this.helperProcess.stdout.on("data", (data) => {
                this.handleHelperStdout(data);
            });

            this.helperProcess.stderr.on("data", (data) => {
                this.handleHelperStderr(data);
            });

            this.helperProcess.on("close", (code) => {
                this.session.handleMsg(Stderr, `Helper process exited with code ${code}`);
            });
            this.helperProcess.on("spawn", () => {
                this.startTime = Date.now();
            });
        } catch (error) {
            this.session.handleMsg(Stderr, `Failed to initialize DebugHelper: ${error}`);
            this.symbolTableReject(error);
        }
    }

    private getHelperExecutable() {
        const extPath = this.session.args.extensionPath;
        const platform = process.platform;
        const arch = process.arch;
        let helperName = "mcu-debug-helper";
        if (platform === "win32") {
            helperName += ".exe";
        }
        let helperPath = `${extPath}/bin/${helperName}`;
        if (existsSync(helperPath) && this.process.env.PROD_MCU_DEBUG_HELPER !== "1") {
            return helperPath;
        }
        helperPath = `${extPath}/bin/${platform}-${arch}/${helperName}`;
        if (existsSync(helperPath)) {
            return helperPath;
        } else {
            throw new Error(`mcu-debug-helper executable not found for platform ${platform} and architecture ${arch} at path ${helperPath}`);
        }
    }

    private handleHelperStdout(message: Buffer | string) {
        // Accumulate data in buffer (as Buffer to handle binary data correctly)
        const data = Buffer.isBuffer(message) ? message : Buffer.from(message);
        this.rawBuffer = Buffer.concat([this.rawBuffer, data]);

        // If we're already processing, don't start another processing loop
        if (this.processingMessages) {
            return;
        }

        this.processingMessages = true;
        this.messagesProcessedInBatch = 0;
        this.processMessages();
    }

    /**
     * Process messages from the buffer, yielding control back to the event loop
     * periodically to avoid blocking on heavy/bursty traffic.
     */
    private processMessages() {
        // Process complete messages (Content-Length protocol like DAP/LSP)
        while (this.messagesProcessedInBatch < this.MAX_MESSAGES_PER_BATCH) {
            // Look for the header separator: \r\n\r\n
            const separatorIndex = this.findHeaderSeparator(this.rawBuffer);
            if (separatorIndex === -1) {
                break; // Need more data
            }

            // Extract and parse headers
            const headerText = this.rawBuffer.subarray(0, separatorIndex).toString("utf8");
            const contentLength = this.parseContentLength(headerText);

            if (contentLength === null) {
                this.session.handleMsg(Stderr, `Failed to parse Content-Length from headers: ${headerText}`);
                // Skip past the separator and continue
                const skipBytes = this.rawBuffer[separatorIndex + 1] === 0x0a && this.rawBuffer[separatorIndex + 2] === 0x0d ? 4 : 2;
                this.rawBuffer = this.rawBuffer.subarray(separatorIndex + skipBytes);
                continue;
            }

            // Determine separator length (\r\n\r\n = 4 bytes, \n\n = 2 bytes)
            const separatorLen =
                this.rawBuffer[separatorIndex] === 0x0d && this.rawBuffer[separatorIndex + 1] === 0x0a && this.rawBuffer[separatorIndex + 2] === 0x0d && this.rawBuffer[separatorIndex + 3] === 0x0a
                    ? 4
                    : 2;

            // Check if we have the complete message body
            const messageStart = separatorIndex + separatorLen;
            const messageEnd = messageStart + contentLength;

            if (this.rawBuffer.length < messageEnd) {
                break; // Need more data
            }

            // Extract the message body
            const messageBody = this.rawBuffer.subarray(messageStart, messageEnd);
            this.rawBuffer = this.rawBuffer.subarray(messageEnd);

            // Parse and handle the JSON message
            try {
                const parsed = JSON.parse(messageBody.toString("utf8"));
                this.handleHelperMessage(parsed);
                this.messagesProcessedInBatch++;
            } catch (error) {
                this.session.handleMsg(Stderr, `Failed to parse helper message: ${error}. Body: ${messageBody.toString("utf8").substring(0, 200)}`);
            }
        }

        // If we hit the batch limit and there's more data, yield control and continue processing
        if (this.rawBuffer.length > 0 && this.messagesProcessedInBatch >= this.MAX_MESSAGES_PER_BATCH) {
            this.messagesProcessedInBatch = 0;
            setImmediate(() => this.processMessages());
        } else {
            this.processingMessages = false;
        }
    }

    /**
     * Find the header separator (\r\n\r\n or \n\n) in the buffer.
     * Returns the index of the first byte of the separator, or -1 if not found.
     * Optimized using Buffer.indexOf for better performance on large buffers.
     */
    private findHeaderSeparator(buffer: Buffer): number {
        // Look for \r\n\r\n (standard)
        const stdIndex = buffer.indexOf(DebugHelper.CRLF_CRLF);
        if (stdIndex !== -1) {
            return stdIndex;
        }

        // Look for \n\n (fallback)
        return buffer.indexOf(DebugHelper.NL_NL);
    }

    /**
     * Parse the Content-Length from the header text.
     * Returns the content length in bytes, or null if not found.
     */
    private parseContentLength(headerText: string): number | null {
        const lines = headerText.split(/\r?\n/);
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.toLowerCase().startsWith("content-length")) {
                const colonIndex = trimmed.indexOf(":");
                if (colonIndex !== -1) {
                    const numStr = trimmed.substring(colonIndex + 1).trim();
                    const num = parseInt(numStr, 10);
                    if (!isNaN(num) && num >= 0) {
                        return num;
                    }
                }
            }
        }
        return null;
    }

    private handleHelperMessage(message: any) {
        // Check if it's a response (has seq and req fields matching a pending request)
        if (typeof message.seq === "number" && typeof message.req === "string") {
            const pending = this.pendingRequests.get(message.seq);
            if (pending) {
                this.pendingRequests.delete(message.seq);
                pending.resolve(message as HelperResponse);
                return;
            }
        }

        // Otherwise, it's an event
        if (message.method === "HelperEvent") {
            this.handleHelperEvent(message.args as HelperEvent);
        } else {
            this.session.handleMsg(Stderr, `Unknown helper message format: ${JSON.stringify(message)}`);
        }
    }

    private handleHelperEvent(event: HelperEvent) {
        switch (event.type) {
            case "SymbolTableReady": {
                this.symbolTableResolve();
                if (!this.rttSymbolAddress && this.lookingForRTT) {
                    this.session.handleMsg(Stdout, `Symbol table ready but RTT symbol not found. RTT features will be disabled.`);
                    this.rttSymbolResolve(); // Resolve RTT promise anyway to avoid hanging if RTT symbol is missing
                }
                const delta = Date.now() - this.startTime;
                this.session.handleMsg(Stderr, `mcu-debug-helper: Symbol table ready (version: ${event.version}, elapsed: ${delta}ms)`);
                break;
            }
            case "DisassemblyReady": {
                const delta = Date.now() - this.startTime;
                this.session.handleMsg(Stderr, `mcu-debug-helper: Disassembly ready (${event.instruction_count} instructions, elapsed: ${delta}ms)`);
                break;
            }

            case "RTTFound": {
                this.rttSymbolAddress = event.address;
                this.rttSymbolResolve();
                const delta = Date.now() - this.startTime;
                this.session.handleMsg(Stderr, `mcu-debug-helper: RTT found at ${event.address}, elapsed: ${delta}ms`);
                break;
            }
            case "Progress":
                const progressMsg = event.message || `${event.operation}: ${event.percentage ?? "?"}%`;
                this.session.handleMsg(Stdout, progressMsg);
                break;

            case "Output":
                const outputType = event.category === "stderr" ? Stderr : Stdout;
                this.session.handleMsg(outputType, event.message);
                break;

            case "Error":
                const errorMsg = event.details ? `${event.message} (${event.code || "unknown"}): ${event.details}` : `${event.message} ${event.code ? `(${event.code})` : ""}`;
                this.session.handleMsg(Stderr, `Helper error: ${errorMsg}`);
                break;

            case "Log":
                this.session.handleMsg(Stdout, `[${event.level}] ${event.message}`);
                break;

            default:
                this.session.handleMsg(Stderr, `Unknown helper event type: ${JSON.stringify(event)}`);
        }
    }

    private handleHelperStderr(message: Buffer | string) {
        if (!this.session.args.debugFlags.anyFlags) {
            // If debug flags are not enabled, skip logging stderr to avoid noise
            return;
        }
        // Accumulate and log stderr
        this.stderrBuffer += message.toString();

        let newlineIndex: number;
        while ((newlineIndex = this.stderrBuffer.indexOf("\n")) !== -1) {
            const line = this.stderrBuffer.substring(0, newlineIndex).trim();
            this.stderrBuffer = this.stderrBuffer.substring(newlineIndex + 1);

            if (line.length > 0) {
                this.session.handleMsg(Stderr, `mcu-debug-helper stderr: ${line}`);
            }
        }
    }

    /**
     * Send a request to the helper process and wait for the response.
     * @param requestType The type of request (e.g., "disassemble", "globals", "statics", "symbol_lookup_address", "symbol_lookup_name")
     * @param params The request parameters
     * @param timeoutMs Optional timeout in milliseconds (default: 30000)
     * @returns Promise that resolves with the response
     */
    private async sendRequest<T extends HelperResponse>(requestType: string, params: any, timeoutMs = 30000): Promise<T> {
        if (!this.helperProcess?.stdin || !this.helperProcess.stdin.writable) {
            throw new Error("Helper process not initialized");
        }

        const seq = this.nextSeq++;
        const request = {
            req: requestType,
            seq,
            ...params,
        };

        return new Promise<T>((resolve, reject) => {
            // Set up timeout
            const timeout = setTimeout(() => {
                this.pendingRequests.delete(seq);
                reject(new Error(`Helper request timeout for ${requestType} (seq: ${seq})`));
            }, timeoutMs);

            // Store pending request
            this.pendingRequests.set(seq, {
                resolve: (response) => {
                    clearTimeout(timeout);
                    resolve(response as T);
                },
                reject: (reason) => {
                    clearTimeout(timeout);
                    reject(reason);
                },
                type: requestType,
            });

            // Send request using Content-Length protocol (same as DAP/LSP)
            // Format: "Content-Length: <bytes>\r\n\r\n<JSON body>"
            // Matches what Rust expects in: packages/mcu-debug-helper/src/transport.rs:read_message()
            try {
                const body = Buffer.from(JSON.stringify(request), "utf8");
                const header = `Content-Length: ${body.length}\r\n\r\n`;
                this.helperProcess!.stdin!.write(header);
                this.helperProcess!.stdin!.write(body);
            } catch (error) {
                clearTimeout(timeout);
                this.pendingRequests.delete(seq);
                reject(error);
            }
        });
    }

    /**
     * Request disassembly for a memory region.
     */
    async disassemble(args: { memoryReference: string; offset?: number; instructionOffset?: number; instructionCount: number; resolveSymbols?: boolean }): Promise<DisasmResponse> {
        return this.sendRequest<DisasmResponse>("disassemble", { arguments: args });
    }

    /**
     * Get all global variables.
     */
    async getGlobals(): Promise<GlobalsResponse> {
        return this.sendRequest<GlobalsResponse>("globals", {});
    }

    /**
     * Get static variables for a specific file.
     */
    async getStatics(fileName: string): Promise<StaticsResponse> {
        return this.sendRequest<StaticsResponse>("statics", { file_name: fileName });
    }

    /**
     * Lookup symbol by address.
     */
    async lookupSymbolByAddress(address: string): Promise<SymbolLookupResponse> {
        return this.sendRequest<SymbolLookupResponse>("symbol_lookup_address", { address });
    }

    /**
     * Lookup symbol by name.
     */
    async lookupSymbolByName(name: string, fileName?: string): Promise<SymbolLookupResponse> {
        return this.sendRequest<SymbolLookupResponse>("symbol_lookup_name", {
            name,
            file_name: fileName ?? null,
        });
    }

    /**
     * Cleanup: terminate the helper process.
     */
    dispose() {
        if (this.helperProcess) {
            this.helperProcess.kill();
            this.helperProcess = undefined;
        }
        this.pendingRequests.clear();
    }
}
