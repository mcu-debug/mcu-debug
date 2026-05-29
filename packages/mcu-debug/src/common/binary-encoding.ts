
import { BinaryEncoding, HrTimer, TextEncoding } from "../adapter/servers/common";
import { decoders as DECODER_MAP } from "../common/swo/decoders/utils";

interface DataSink {
    send(data: string): void;
}

function parseEncoded(buffer: Buffer, encoding: string) {
    return DECODER_MAP[encoding] ? DECODER_MAP[encoding](buffer) : DECODER_MAP.unsigned(buffer);
}

function padLeft(str: string, len: number, chr = " "): string {
    if (str.length >= len) {
        return str;
    }
    str = str.padStart(len, chr);
    return str;
}

export function getBinaryEncoding(enc: string): BinaryEncoding {
    enc = enc ? enc.toLowerCase() : "";
    if (!(enc in BinaryEncoding)) {
        enc = BinaryEncoding.UNSIGNED;
    }
    return enc as BinaryEncoding;
}

export function getTextEncoding(enc: string): TextEncoding {
    enc = enc ? enc.toLowerCase() : "";
    if (!(enc in TextEncoding)) {
        return TextEncoding.UTF8;
    }
    return enc as TextEncoding;
}

export class BinaryFormatter {
    private readonly bytesNeeded = 4;
    private buffer = Buffer.alloc(4);
    private bytesRead = 0;
    private hrTimer = new HrTimer();

    constructor(
        protected sink: DataSink,
        protected encoding: string,
        protected scale: number,
    ) {
        this.bytesRead = 0;
        this.encoding = getBinaryEncoding(encoding);
        this.scale = scale || 1;
        this.encoding = (this.encoding || "unsigned").replace(".", "_");
    }

    public writeBinary(input: string | Buffer) {
        const data: Buffer = Buffer.from(input);
        const timestamp = HrTimer.createDateTimestamp();
        for (const chr of data) {
            this.buffer[this.bytesRead] = chr;
            this.bytesRead = this.bytesRead + 1;
            if (this.bytesRead === this.bytesNeeded) {
                let chars = "";
                for (const byte of this.buffer) {
                    if (byte <= 32 || (byte >= 127 && byte <= 159)) {
                        chars += ".";
                    } else {
                        chars += String.fromCharCode(byte);
                    }
                }
                const hexvalue = padLeft(this.buffer.toString("hex"), 8, "0");
                const decodedValue = parseEncoded(this.buffer, this.encoding);
                const decodedStr = padLeft(`${decodedValue}`, 12);
                const scaledValue = padLeft(`${decodedValue * this.scale}`, 12);

                this.sink.send(`${timestamp} ${chars}  0x${hexvalue} - ${decodedStr} - ${scaledValue}\n`);
                this.bytesRead = 0;
            }
        }
    }
}
