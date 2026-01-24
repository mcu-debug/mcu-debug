"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.WaitForPort = void 0;
const net = __importStar(require("net"));
const DefaultWaitCallbacks = {
    silent: {
        setup: () => { },
        starting: () => { },
        tryConnect: () => { },
        connected: () => { },
        timeout: () => { },
    },
    verbose: {
        starting: ({ host, port }) => {
            console.log(`Waiting for ${host}:${port} to become available...`);
        },
        setup: (socket) => {
            console.log(`Socket created: ${socket.remoteAddress}:${socket.remotePort}`);
        },
        tryConnect: () => {
            console.log("Trying to connect...");
        },
        connected: (socket) => {
            console.log("Connected!");
        },
        timeout: () => {
            console.log("Timeout reached, giving up.");
        },
    },
};
class WaitForPort {
    params;
    IPv6enabled = true;
    constructor(params) {
        this.params = params;
    }
    returnedSocket = false;
    createConnectionWithTimeout(ipVersion, timeout, callback) {
        //  Variable to hold the timer we'll use to kill the socket if we don't
        //  connect in time.
        let timer = null;
        //  Try and open the socket, with the params and callback.
        const opts = {
            host: this.params.host,
            port: this.params.port,
            family: ipVersion,
            autoSelectFamily: true,
        };
        const socket = net.createConnection(opts, (err) => {
            if (!err && timer) {
                clearTimeout(timer);
                timer = null;
            }
            if (!this.returnedSocket) {
                return callback(err);
            }
        });
        // Let the caller setup their own socket handlers
        this.params.callbacks.setup?.(socket);
        //  TODO: Check for the socket ECONNREFUSED event.
        socket.on("error", (error) => {
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            if (!this.returnedSocket) {
                socket.destroy();
                callback(error);
            }
        });
        //  Kill the socket if we don't open in time.
        timer = setTimeout(() => {
            socket.destroy();
            const error = new Error(`Timeout trying to open socket to ${this.params.host}:${this.params.port}, IPv${ipVersion}`);
            error.code = "ECONNTIMEOUT";
            callback(error);
        }, timeout);
        //  Return the socket.
        return socket;
    }
    checkHttp(socket, ipVersion, timeout, callback) {
        //  Create the HTTP request.
        const request = `GET ${this.params.path} HTTP/1.1\r\nHost: ${this.params.host}\r\n\r\n`;
        let timer = null;
        timer = setTimeout(() => {
            socket.destroy();
            const error = new Error(`Timeout waiting for data from ${this.params.host}:${this.params.port}, IPv${ipVersion}`);
            error.code = "EREQTIMEOUT";
            callback(error);
        }, timeout);
        //  Get ready for a response.
        socket.on("data", function (data) {
            //  Get the response as text.
            const response = data.toString();
            const statusLine = response.split("\n")[0];
            //  Stop the timer.
            if (timer)
                clearTimeout(timer);
            //  Check the data. Remember an HTTP response is:
            //  HTTP/1.1 XXX Stuff
            const statusLineParts = statusLine.split(" ");
            if (statusLineParts.length < 2 || statusLineParts[1].startsWith("2") === false) {
                const error = new Error("Invalid response from server");
                error.code = "ERESPONSE";
                callback(error);
            }
            //  ALL good!
            callback();
        });
        //  Send the request.
        socket.write(request);
    }
    //  This function attempts to open a connection, given a limited time window.
    //  This is the function which we will run repeatedly until we connect.
    tryConnect(ipVersion, timeout) {
        return new Promise((resolve, reject) => {
            try {
                const socket = this.createConnectionWithTimeout(ipVersion, this.params.interval || 1000, (err) => {
                    if (err) {
                        if (err.code === "ECONNREFUSED" || err.code === "EACCES") {
                            //  We successfully *tried* to connect, so resolve with false so
                            //  that we try again.
                            socket.destroy();
                            return resolve([false]);
                        }
                        else if (err.code === "ECONNTIMEOUT") {
                            //  We've successfully *tried* to connect, but we're timing out
                            //  establishing the connection. This is not ideal (either
                            //  the port is open or it ain't).
                            socket.destroy();
                            return resolve([false]);
                        }
                        else if (err.code === "ECONNRESET") {
                            //  This can happen if the target server kills its connection before
                            //  we can read from it, we can normally just try again.
                            socket.destroy();
                            return resolve([false]);
                        }
                        else if (this.IPv6enabled === true && (err.code === "EADDRNOTAVAIL" || err.code === "ENOTFOUND")) {
                            //  This will occur if the IP address we are trying to connect to does not exist
                            //  This can happen for ::1 or other IPv6 addresses if the IPv6 stack is not enabled.
                            //  In this case we disable the IPv6 lookup
                            this.IPv6enabled = false;
                            socket.destroy();
                            return resolve([false]);
                        }
                        else if (err.code === "ENOTFOUND") {
                            //  This will occur if the address is not found, i.e. due to a dns
                            //  lookup fail (normally a problem if the domain is wrong).
                            socket.destroy();
                            //  If we are going to wait for DNS records, we can actually just try
                            //  again...
                            if (this.params.waitForDns === true)
                                return resolve([false]);
                            // ...otherwise, we will explicitly fail with a meaningful error for
                            //  the user.
                            return reject(new Error(`The address '${this.params.host}' cannot be found`));
                        }
                        //  Trying to open the socket has resulted in an error we don't
                        //  understand. Better give up.
                        socket.destroy();
                        // If we are currently checking for IPv6 we ignore this error and disable IPv6
                        if (ipVersion === 6) {
                            this.IPv6enabled = false;
                            return resolve([false]);
                        }
                        return reject(err);
                    }
                    //  Boom, we connected!
                    //  If we are not dealing with http, we're done.
                    if (this.params.protocol !== "http") {
                        // stop the timer and resolve.
                        // socket.destroy();
                        return resolve([true, socket]);
                    }
                    //  TODO: we should only use the portion of the timeout for this interval which is still left to us.
                    //  Now we've got to wait for a HTTP response.
                    this.checkHttp(socket, ipVersion, timeout, (err) => {
                        if (err) {
                            if (err.code === "EREQTIMEOUT") {
                                socket.destroy();
                                return resolve([false]);
                            }
                            else if (err.code === "ERESPONSE") {
                                socket.destroy();
                                return resolve([false]);
                            }
                            socket.destroy();
                            return reject(err);
                        }
                        // socket.destroy();
                        return resolve([true, socket]);
                    });
                });
            }
            catch (err) {
                //  Trying to open the socket has resulted in an exception we don't
                //  understand. Better give up.
                return reject(err);
            }
        });
    }
    waitPort() {
        this.returnedSocket = false;
        this.IPv6enabled = true;
        return new Promise((resolve, reject) => {
            validateParameters(this.params);
            const host = this.params.host;
            const port = this.params.port;
            const interval = this.params.interval;
            const timeout = this.params.timeout;
            //  Keep track of the start time (needed for timeout calcs).
            const startTime = new Date();
            //  Don't wait for more than connectTimeout to try and connect.
            const connectTimeout = 1000;
            //  Grab the object for output.
            const outputFunction = this.params.callbacks || DefaultWaitCallbacks.silent;
            outputFunction.starting({ host, port });
            //  Start trying to connect.
            const loop = (ipVersion = 4) => {
                outputFunction.tryConnect?.();
                this.tryConnect(ipVersion, connectTimeout)
                    .then(([open, socket]) => {
                    //  The socket is open, we're done.
                    if (open) {
                        this.returnedSocket = true;
                        outputFunction.connected(socket);
                        return resolve({ open: true, ipVersion, socket });
                    }
                    //  If we have a timeout, and we've passed it, we're done.
                    const now = new Date();
                    const delta = now.getTime() - startTime.getTime();
                    if (timeout && delta > timeout) {
                        outputFunction.timeout();
                        return resolve({ open: false });
                    }
                    // Check for IPv6 next
                    if (this.IPv6enabled && ipVersion === 4 && !net.isIP(host)) {
                        return loop(6);
                    }
                    //  Run the loop again.
                    return setTimeout(loop, interval);
                })
                    .catch((err) => {
                    return reject(err);
                });
            };
            //  Start the loop.
            loop();
        });
    }
}
exports.WaitForPort = WaitForPort;
function validateParameters(params) {
    params.protocol = params.protocol || "tcp";
    params.host = params.host || "127.0.0.1";
    params.port = params.port || 80;
    params.path = params.path || "/";
    params.interval = params.interval || 1000;
    params.timeout = params.timeout || 0;
    params.waitForDns = params.waitForDns || false;
}
