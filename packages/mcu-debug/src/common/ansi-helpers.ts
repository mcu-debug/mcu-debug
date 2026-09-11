import colors from 'ansi-colors';
export namespace AnsiHelpers {
    const invalidKeys = ['enabled', 'visible', 'strip', 'supportsColor', 'hasColor', 'has256', 'has16m', 'unstyle', 'ok'];
    const colorNames = Object.keys(colors).filter(key => typeof (colors as any)[key] === 'function' && !invalidKeys.includes(key));
    export type ColorName = typeof colorNames[number];
    const colorMap: Record<string, (text: string) => string> = {};
    for (const color of colorNames) {
        colorMap[color] = (colors as any)[color];
    }

    export function colorize(text: string, colors: string): string {
        for (const color of colors.split('.').map(c => c.trim())) {
            const colorFunc = colorMap[color];
            if (colorFunc) {
                try { text = colorFunc(text); } catch (err) {/* ignore errors from color functions */ }
            }
        }
        return text;
    }

    export function greenFormat(msg: string) {
        return colors.green(msg);
    }

    export function magentaFormat(msg: string) {
        return colors.magenta(msg);
    }
    export function redFormat(msg: string) {
        return colors.red(msg);
    }
    export function yellowFormat(msg: string) {
        return colors.yellow(msg);
    }
    export function blueFormat(msg: string) {
        return colors.blue(msg);
    }
    export function cyanFormat(msg: string) {
        return colors.cyan(msg);
    }

    export function stripAnsiCodes(text: string): string {
        return colors.unstyle(text);
    }

    // Keep SGR (colour); discard every other escape. This is the same rule the Rust TUI
    // applies in cockpit/tui.rs ("any other CSI terminator (A-Z except m) is silently
    // discarded"), stated once so both layers agree about what survives a multiplexed stream.
    // eslint-disable-next-line no-control-regex
    const csiRe = /\u001b\[[0-9;?]*[A-Za-z]/g;
    // eslint-disable-next-line no-control-regex
    const oscRe = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g;
    // eslint-disable-next-line no-control-regex
    const charsetRe = /\u001b[()][A-Za-z0-9]/g;
    // eslint-disable-next-line no-control-regex
    const escPairRe = /\u001b[^[]/g;

    /**
     * Drop terminal control that repositions, erases or reconfigures, keeping colour.
     *
     * Firmware that owns its terminal writes these to redraw in place -- `ESC[1F` to step back
     * onto its previous line, `ESC[2J` to clear the screen at startup. Once each line carries a
     * stream prefix, that arithmetic is wrong by the width of the prefix: the device walks back
     * over our tag and overwrites it, and a clear-screen wipes the debug session's scrollback.
     * `ESC c` resets the terminal outright, `ESC]0;` retitles the window, and `ESC[6n` makes the
     * terminal answer on stdin -- where our own readline would take the reply for a command.
     *
     * None of it is data: it is addressed to a terminal the device stopped owning the moment its
     * output was multiplexed with someone else's. Colour survives because it is zero-width and
     * renders correctly wherever the line starts, and because the TUI turns it into real styling.
     */
    export function stripTerminalControl(text: string): string {
        return text
            .replace(csiRe, (seq) => (seq.endsWith('m') ? seq : ''))
            .replace(oscRe, '')
            .replace(charsetRe, '')
            .replace(escPairRe, '');
    }
    export function hasAnsiCodes(text: string): boolean {
        return colors.ansiRegex.test(text);
    }
    export function reset(): string {
        return colors.reset('');
    }
}
