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
    export function hasAnsiCodes(text: string): boolean {
        return colors.ansiRegex.test(text);
    }
    export function reset(): string {
        return colors.reset('');
    }
}
