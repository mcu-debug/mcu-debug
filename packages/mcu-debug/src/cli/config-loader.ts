
import * as fs from "fs";
import * as os from "os";
import path from "path";
import JSONC from 'jsonc-simple-parser';
import { CliArgs } from "./options";
import { logger } from "../common/logger";
import { ConfigurationArguments, substituteEnvVarsInConfig } from "../adapter/servers/common";
import { McuDebugConfigurationProviderBase } from "../common/config-provider";
import { processVarSubstitution } from "../adapter/servers/common";
import { getHostAdapter } from "../common/host-adapter";

// This file is responsible for loading the debug configuration from a JSON file specified in the CLI arguments,
// processing variable substitutions, and providing the final configuration object to be used for starting the
// debug session.
export async function loadConfiguration(args: CliArgs, settings: { [key: string]: any }): Promise<ConfigurationArguments> {
    try {
        const jsonContent = fs.readFileSync(args.json, "utf8");
        const config = JSONC.parse(jsonContent);
        let configurations = (config as any).configurations;
        if (Array.isArray(configurations) === false) {
            logger.error(`Invalid launch.json format: "configurations" field is missing or not an array in ${args.json}`);
            process.exit(1);
        }
        // Select the configurations that are of type "mcu-debug". This allows the launch.json to contain configurations for other debuggers or tools without confusing our CLI.
        configurations = configurations.filter((c: any) => c.type === "mcu-debug");
        if (configurations.length === 0) {
            logger.error(`No configurations of type "mcu-debug" found in ${args.json}`);
            process.exit(1);
        }
        let selectedConfig = selectConfiguration(configurations, args);
        logger.info(`Loaded configuration "${selectedConfig.name}" from ${args.json}`);
        const processedConfig = processVarSubstitutions(args.json, selectedConfig, settings);
        const provider = new CliConfigProvider();
        const folder = config.cwd || process.cwd();
        try {
            let resolvedConfig = await provider.resolveDebugConfiguration(folder, processedConfig);
            if (resolvedConfig) {
                resolvedConfig = await provider.resolveDebugConfigurationWithSubstitutedVariables(folder, resolvedConfig);
            }
            if (!resolvedConfig) {
                logger.error("Failed to resolve debug configuration.");
                process.exit(1);
            }
            return resolvedConfig as ConfigurationArguments;
        } catch (error) {
            logger.error("Error in resolving debug configuration: " + (error instanceof Error ? error.message : String(error)));
            process.exit(1);
        }
    } catch (error) {
        logger.error("Failed to load configuration from launch.json: " + (error instanceof Error ? error.message : String(error)));
        process.exit(1);
    }
}

function selectConfiguration(configurations: any[], args: CliArgs): any {
    // Look for a configuration with a name that exactly matches the provided config argument. Case-sensitive match first since that's more intuitive and most users will expect it to be case-sensitive. If that fails, we'll try a case-insensitive match before giving up.
    let selectedConfig = configurations.find((c: any) => c.name === args.config);
    if (selectedConfig) {
        logger.info(`Selected configuration with name "${args.config}" from ${args.json}`);
        return selectedConfig;
    }
    // Look for a configuration with a name that exactly matches the provided config argument. case-insensitive this time since some users might not realize the name matching is case-sensitive.
    selectedConfig = configurations.find((c: any) => c.name.toLowerCase() === args.config.toLowerCase());
    if (selectedConfig) {
        logger.info(`Selected configuration with name "${args.config}" from ${args.json}`);
        return selectedConfig;
    }

    const isNumber = /\d+/.test(args.config) && !isNaN(Number(args.config));
    if (isNumber) {
        const index = Number(args.config);
        if (index >= 0 && index < configurations.length) {
            selectedConfig = configurations[index];
            logger.info(`Selected configuration at index ${index}:${selectedConfig.name} from ${args.json}`);
            return selectedConfig;
        }
    }
    // See if we can do a glob match, but it has to match exactly one configuration to avoid ambiguity.
    const minimatch = require("minimatch");
    const globMatches = configurations.filter((c: any) => minimatch(c.name, args.config));
    if (globMatches.length === 1) {
        selectedConfig = globMatches[0];
        logger.info(`Selected configuration with name "${selectedConfig.name}" from ${args.json} using glob pattern "${args.config}"`);
        return selectedConfig;
    } else if (globMatches.length > 1) {
        logger.error(`Multiple configurations match the glob pattern "${args.config}" in ${args.json}. Please specify a more specific name or index.`);
        process.exit(1);
    } else {
        logger.error(`Configuration with name "${args.config}" not found in ${args.json}`);
    }

    // Lets prompt to get configuration
    let ix = 0;
    logger.info(`Available 'mcu-debug' configurations in ${args.json}:`);
    for (const config of configurations) {
        logger.info(`  [${ix}] ${config.name}`);
        ix++;
    }
    // If stdin is a TTY or TUI, maybe we should promppt the user to select a configuration instead of just giving up?
    // For now, we'll just give up since implementing a prompt is a bit more work and we want to get this out. We can
    // always add a prompt later if users want it. We also don't know if we are in a TUI
    logger.info(`Please specify a configuration name or index using the --config argument.`);
    process.exit(1);
}

// TODO: Should we combine all types of variables and do substitution in one pass instead of doing built-in
// vars first and then config vars? The main reason to do it in two passes is that it allows config vars to
// reference built-in vars, but not the other way around. Doing it in one pass would allow more flexible
// referencing between variables but would also be more complex and could potentially lead to circular
// references. For now, we'll keep it as two passes since it's simpler and meets our current needs, but we
// can consider changing it in the future if we find that users want more flexibility in variable referencing.
function processVarSubstitutions(fileName: string, config: any, settings: { [key: string]: any }): any {
    const builtins = gatherBuiltins();
    const jsonContent = JSON.stringify(config);
    // built-ins go first as they may be referenced by envFile or other values we need
    let substitutedContent = processVarSubstitution(jsonContent, builtins, '', (msg) => {
        logger.warn(`In built-in variable substitution for ${fileName}: ${msg}`);
    });
    if (settings && Object.keys(settings).length > 0) {
        // If we have a settings file, we allow its values to be used in launch.json with ${config:VAR_NAME}
        substitutedContent = processVarSubstitution(substitutedContent, settings as any, 'config:', (msg) => {
            logger.warn(`In config: variable substitution for ${fileName}: ${msg}`);
        });
    }
    try {
        config = JSON.parse(substitutedContent) as ConfigurationArguments;
        config = substituteEnvVarsInConfig(config, (msg) => {
            logger.warn(`In environment variable substitution for ${fileName}: ${msg}`);
        }) as any;
        // Now detect all variables that have not been substituted and warn about them since that likely
        // indicates a mistake in the launch.json. We allow unsubstituted variables to remain since some
        // of them might be intended to be substituted later by the debug adapter or by the user during
        // the debug session, but we want to warn about any that look like they should have been substituted
        // but weren't.
        substitutedContent = JSON.stringify(config);
        const varRegex = /\$\{[^\}]+\}/g;
        const unsubstitutedVars = substitutedContent.match(varRegex);
        if (unsubstitutedVars) {
            const uniqueVars = Array.from(new Set(unsubstitutedVars));
            logger.warn(`The following variables in ${fileName} were not substituted. This may indicate a mistake in the launch.json if these variables were intended to be substituted at this stage. If these variables are intended to be substituted later by the debug adapter or by the user during the debug session, then you can ignore this warning. Unsubstituted variables: ${uniqueVars.join(", ")}`);
        }
        return config;
    } catch (error) {
        logger.error("Failed to process variable substitutions in launch.json: " + (error instanceof Error ? error.message : String(error)));
        process.exit(1);
    }
}

function gatherBuiltins(): { [key: string]: any } {
    const builtins: { [key: string]: any } = {};
    // Populate built-in variables that can be used in launch.json. Only those that make sense
    // when no VSCode is involved. For example, ${workspaceFolder} is supported but ${file} is not since there is no file context.
    builtins.userHome = os.homedir() || "";
    builtins.workspaceFolder = process.cwd();
    builtins.workspaceFolderBasename = path.basename(builtins.workspaceFolder);
    builtins.cwd = process.cwd();
    builtins.pathSeparator = '/'; // path.sep;
    builtins["/"] = '/'; // Allow using ${/} as a platform-independent path separator in launch.json   
    return builtins;
}

export class CliConfigProvider extends McuDebugConfigurationProviderBase {
    constructor() {
        super(getHostAdapter(), true);
    }

    override provideDebugConfigurations(): { [key: string]: any }[] {
        logger.warn("provideDebugConfigurations is not supported in CLI mode. Returning empty array.");
        return [];
    }

    override async resolveDebugConfiguration(folder: string, _config: any): Promise<any> {
        let config = _config as ConfigurationArguments;
        // We already processed env vars and config vars in loadConfiguration, so we can skip that here.
        const saveEnv = config.env
        const saveEnvFile = config.envFile;
        config.env = undefined;
        config.envFile = undefined;
        if (config.graphConfig) {
            logger.warn("Graph config is not supported in CLI mode and will be ignored.");
            config.graphConfig = undefined;
        }

        try {
            config = (await super.resolveDebugConfiguration(folder, config)) as ConfigurationArguments;
        } catch (error) {
            logger.error("Error in resolveDebugConfiguration: " + (error instanceof Error ? error.message : String(error)));
            return undefined;
        }
        if (!config) {
            logger.error("resolveDebugConfiguration returned undefined.");
            return undefined;
        }

        config.env = saveEnv;
        config.envFile = saveEnvFile;
        return config;
    }

    override resolveDebugConfigurationWithSubstitutedVariables(folder: string, config: any): any {
        return super.resolveDebugConfigurationWithSubstitutedVariables(folder, config);
    }
}
