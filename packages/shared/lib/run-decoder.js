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
exports.Decoder = void 0;
const child_process = __importStar(require("child_process"));
const events_1 = require("events");
class Decoder extends events_1.EventEmitter {
    spec;
    process;
    constructor(spec) {
        super();
        this.spec = Object.assign({}, spec); // Deep copy
        this.spec.cwd = spec.cwd || process.cwd();
        this.spec.env = { ...process.env, ...(spec.env || {}) };
    }
    getProgram() {
        return this.spec.program;
    }
    getArgs() {
        return this.spec.args;
    }
    getCwd() {
        return this.spec.cwd;
    }
    runProgram(stdio) {
        return new Promise((resolve, reject) => {
            const obj = {
                cwd: this.getCwd(),
                env: this.spec.env,
                detached: true,
            };
            if (stdio) {
                obj.stdio = stdio;
            }
            this.process = child_process.spawn(this.getProgram(), this.getArgs(), obj);
            this.process.stdout?.on("data", (data) => {
                this.emit("stdout", data);
            });
            this.process.stderr?.on("data", (data) => {
                this.emit("stderr", data);
            });
            this.process.on("close", (code) => {
                this.emit("close", code);
            });
            this.process.on("error", (err) => {
                this.emit("error", err);
                reject(err);
            });
            this.process.on("spawn", () => {
                resolve();
            });
            this.on("stdin", async (data) => {
                await this.writeStdin(data);
            });
        });
    }
    setStdinPiped(stream) {
        stream.pipe(this.process?.stdin);
    }
    setStdoutPiped(stream) {
        this.process?.stdout?.pipe(stream);
    }
    setStderrPiped(stream) {
        this.process?.stderr?.pipe(stream);
    }
    async writeStdin(data) {
        if (this.process && this.process.stdin && this.process.stdin.writable) {
            if (!this.process.stdin.write(data)) {
                await this.process.stdin.once("drain", () => { });
            }
        }
    }
    close() {
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
    dispose() {
        this.close();
        this.removeAllListeners();
    }
}
exports.Decoder = Decoder;
