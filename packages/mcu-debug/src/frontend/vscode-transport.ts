import TransportStream, { TransportStreamOptions } from 'winston-transport';
import { IOutputChannel } from '../common/host-adapter';

export interface VscodeTransportOptions extends TransportStreamOptions {
    /** Prefix each line, e.g. '[mcu-debug]'. Defaults to none. */
    prefix?: string;
}

/**
 * Winston transport that writes to a VS Code OutputChannel (via IOutputChannel).
 * Uses the platform-agnostic IOutputChannel interface so it can also be tested
 * outside VS Code with a stub.
 */
export class VscodeOutputChannelTransport extends TransportStream {
    private readonly channel: IOutputChannel;
    private readonly prefix: string;

    constructor(channel: IOutputChannel, opts: VscodeTransportOptions = {}) {
        super(opts);
        this.channel = channel;
        this.prefix = opts.prefix ? opts.prefix + ' ' : '';
    }

    log(info: { level: string; message: string;[key: string]: unknown }, callback: () => void): void {
        setImmediate(() => this.emit('logged', info));
        const extras = Object.entries(info)
            .filter(([k]) => k !== 'level' && k !== 'message')
            .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
            .join(' ');
        const line = `${this.prefix}[${info.level}] ${info.message}${extras ? '  ' + extras : ''}`;
        this.channel.appendLine(line);
        callback();
    }
}
