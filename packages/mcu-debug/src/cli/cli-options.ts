import { Command } from 'commander';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { version } = require('../../package.json') as { version: string };

export interface CliArgs {
    config: string;
    json: string;
    help?: boolean;
    version?: boolean;
    settings?: string;
    logFile?: string;
    debug?: boolean;
    dumpConfig?: boolean;
    waitForClient?: boolean;
}

const program = new Command();

program
    .option('-c, --config <string>', 'Debug configuration to use. Can be the name of a configuration in launch.json, the index of the configuration in launch.json, or a glob pattern to match the name of the configuration in launch.json')
    .option('-j, --json <string>', 'launch.json file to use', '.vscode/launch.json')
    .option('-s, --settings <string>', 'Use custom settings JSON file', '.vscode/settings.json')
    .option('-l, --log-file <string>', 'Log file path. Default path is $TMPDIR/mcu-debug-logs/<pid>.log', '')
    .option('-d, --debug', 'Enable debug mode - more verbose logging')
    .option('--dump-config', 'Dump the configuration and exit')
    .option('--wait-for-client', 'Wait for a client to connect before starting the debug session')
    .version(version, '-V, --version', 'Show version information')
    .helpOption('-h, --help', 'Show this help message')
    .parse(process.argv);

export const cliArgs = program.opts<CliArgs>();

export function printHelp() {
    console.log(program.helpInformation());
}

