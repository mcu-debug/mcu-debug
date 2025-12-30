import { LoggingDebugSession } from "@vscode/debugadapter";
import { DebugProtocol } from "@vscode/debugprotocol";

/// AdapterSession extends LoggingDebugSession to process requests sequentially.
/// While a request is being processed, any new incoming requests are queued. While
/// this ensures that requests are handled one at a time, it may introduce delays
/// if a request takes a long time to process. Good news is that there are no race
/// conditions to worry about since only one request is processed at a time. No out-of-order
/// handling (finishing) of requests is possible either. This gives us some determinism
///
/// Another TODO: Handle 'cancel' requests properly. Not sure what the semantics are here.
export class SeqDebugSession extends LoggingDebugSession {
    protected requestQueue: DebugProtocol.Request[] = [];
    private isProcessing = false;
    private currentRequestResolve: ((response: DebugProtocol.Response) => void) | null = null;

    constructor() {
        super();
    }

    private static exitLikeCommands: Set<string> = new Set(["disconnect", "terminate", "exit"]);
    private static continueLikeCommands: Set<string> = new Set(["continue", "next", "stepIn", "stepOut", "goto"]);

    protected exiting: boolean = false;

    protected async dispatchRequest(request: DebugProtocol.Request): Promise<void> {
        if (SeqDebugSession.exitLikeCommands.has(request.command)) {
            this.exiting = true;
            super.dispatchRequest(request);
            return;
        }

        if (SeqDebugSession.continueLikeCommands.has(request.command)) {
            for (const req of this.requestQueue) {
                const response: DebugProtocol.Response = {
                    seq: 0,
                    type: "response",
                    request_seq: req.seq,
                    command: req.command,
                    success: false,
                    message: "cancelled",
                };
                this.sendResponse(response);
            }
            this.requestQueue = [];
        }

        this.requestQueue.push(request);
        this.processQueue();
    }

    // Override sendResponse to notify the queue when a request is finished
    public sendResponse(response: DebugProtocol.Response): void {
        super.sendResponse(response);
        if (this.currentRequestResolve) {
            this.currentRequestResolve(response);
        }
    }

    private async processQueue() {
        // Guard to ensure only one processing loop runs at a time
        if (this.isProcessing) {
            return;
        }
        this.isProcessing = true;

        while (this.requestQueue.length > 0 && !this.exiting) {
            const request = this.requestQueue.shift();
            if (request) {
                await new Promise<void>((resolve) => {
                    // Set up the resolver for sendResponse
                    this.currentRequestResolve = (response) => {
                        // Ensure the response matches the current request
                        if (response.request_seq === request.seq) {
                            resolve();
                        }
                    };

                    try {
                        super.dispatchRequest(request);
                    } catch (e) {
                        // If dispatch fails synchronously, resolve to avoid hanging
                        resolve();
                    }
                });
                this.currentRequestResolve = null;
            }
        }

        this.isProcessing = false;
    }
}
