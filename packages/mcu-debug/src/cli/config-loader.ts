
import * as fs from "fs";
import * as os from "os";
import path from "path";
import * as winston from "winston";
import JSONC from 'jsonc-simple-parser';
import { ConfigurationArguments, substituteEnvVarsInConfig } from "../adapter/servers/common";
import { McuDebugConfigurationProviderBase } from "../common/config-provider";
import { processVarSubstitution } from "../adapter/servers/common";
import { getHostAdapter } from "../common/host-adapter";
import { CliArgs } from "./options";
import { CustomTransport } from "../common/cli-logger";

export interface ConfigLoaderArgs {
    json?: string;           // JSON file if any
    config: string;         // Name of the launch configuration
    configParsed?: any;
    builtins?: { [key: string]: string };
    logFile?: string;
}

// This file is responsible for loading the debug configuration from a JSON file specified in the CLI arguments,
// processing variable substitutions, and providing the final configuration object to be used for starting the
// debug session.
export class CLIConfigLoader {
    constructor(private cliArgs: ConfigLoaderArgs, private logger: winston.Logger, private forVscode: boolean) { }

    public async loadConfiguration(args: ConfigLoaderArgs): Promise<ConfigurationArguments | undefined> {
        try {
            let selectedConfig: any = args.configParsed;
            if (!selectedConfig) {
                const jsonContent = fs.readFileSync(args.json!, "utf8");
                const launchConfigs = JSONC.parse(jsonContent);
                let configurations = (launchConfigs as any).configurations;
                if (Array.isArray(configurations) === false) {
                    this.logger.error(`Invalid launch.json format: "configurations" field is missing or not an array in ${args.json}`);
                    return undefined;
                }
                // Select the configurations that are of type "mcu-debug". This allows the launch.json to contain configurations for other debuggers or tools without confusing our CLI.
                configurations = configurations.filter((c: any) => c.type === "mcu-debug");
                if (configurations.length === 0) {
                    this.logger.error(`No configurations of type "mcu-debug" found in ${args.json}`);
                    return undefined;
                }
                selectedConfig = this.selectConfiguration(configurations, args);
                if (!selectedConfig) {
                    this.logger.error(`No configuration selected. Please specify a configuration name or index using the --config argument.`);
                    return undefined;
                }
            }
            const customTransport = CustomTransport.getInstance();
            if (!this.forVscode && selectedConfig.cliOptions?.logFile && customTransport?.usingDefaultLogFile) {
                CustomTransport.getInstance()?.replaceStream(customTransport.usingDefaultLogFile, selectedConfig.cliOptions.logFile);
                try { fs.unlinkSync(customTransport.usingDefaultLogFile!); } catch (err) { /* ignore */ }
                this.cliArgs.logFile = selectedConfig.cliOptions.logFile;
            }

            const configMsg = `Loaded configuration "${selectedConfig.name}"` + (args.json ? ` from ${args.json}` : "") + (this.forVscode ? " for VSCode" : " for CLI");
            this.logger.info(configMsg, { source: 'DA' });
            selectedConfig.debugFlags = undefined as any; // TODO: Remove this line after testing normal flow
            if (selectedConfig.liveWatch?.enabled) {
                getHostAdapter().showWarning("Live watch is not supported in CLI mode. Disabling live watch.");
                delete (selectedConfig as any).liveWatch;
            }
            if (selectedConfig.swoConfig?.enabled) {
                getHostAdapter().showWarning("SWO is not supported in CLI mode. Disabling SWO.");
                delete (selectedConfig as any).swoConfig;
            }
            if (selectedConfig.chainedConfigurations?.enabled) {
                getHostAdapter().showWarning("Chained configurations are not supported in CLI mode. Ignoring chained configurations.");
                delete (selectedConfig as any).chainedConfigurations;
            }

            const processedConfig = this.processVarSubstitutions(args, selectedConfig);
            const provider = new CliConfigProvider(this.logger);
            const folder = selectedConfig.cwd || process.cwd();
            try {
                let resolvedConfig = await provider.resolveDebugConfiguration(folder, processedConfig);
                if (resolvedConfig) {
                    resolvedConfig = await provider.resolveDebugConfigurationWithSubstitutedVariables(folder, resolvedConfig);
                }
                if (!resolvedConfig) {
                    this.logger.error("Failed to resolve debug configuration.");
                    return undefined;
                }
                // During resolution, it is possible some new variables were introduced that need substitution. They
                // can be introduced for server specific paths done in resolveDebugConfigurationWithSubstitutedVariables()
                resolvedConfig = this.processVarSubstitutions(args, resolvedConfig);
                return resolvedConfig as ConfigurationArguments;
            } catch (error) {
                this.logger.error("Error in resolving debug configuration: " + (error instanceof Error ? error.message : String(error)));
                return undefined;
            }
        } catch (error) {
            this.logger.error("Failed to load configuration from launch.json: " + (error instanceof Error ? error.message : String(error)));
            return undefined;
        }
    }

    private processConfigVars(strConfig: string): string {
        const patterhn = /\$\{config:([^}]+)\}/g;
        const adapter = getHostAdapter();
        const unmatched = new Set<string>();
        const substitutedConfig = strConfig.replace(patterhn, (match, varName) => {
            let value = adapter.getSetting("", varName, undefined);
            if (value === undefined) {
                unmatched.add(varName);
                return match;
            }
            return value;
        });
        if (unmatched.size > 0) {
            this.logger.warn(`The following config variables were not found in settings and have no value: ${Array.from(unmatched).join(", ")}. They will not be substituted.`);
        }
        return substitutedConfig;
    }

    private selectConfiguration(configurations: any[], args: ConfigLoaderArgs): any | undefined {
        // Look for a configuration with a name that exactly matches the provided config argument. Case-sensitive match first since that's more intuitive and most users will expect it to be case-sensitive. If that fails, we'll try a case-insensitive match before giving up.
        let selectedConfig = configurations.find((c: any) => c.name === args.config);
        if (selectedConfig) {
            this.logger.info(`Selected configuration with name "${args.config}" from ${args.json}`);
            return selectedConfig;
        }
        // Look for a configuration with a name that exactly matches the provided config argument. case-insensitive this time since some users might not realize the name matching is case-sensitive.
        selectedConfig = configurations.find((c: any) => c.name.toLowerCase() === args.config.toLowerCase());
        if (selectedConfig) {
            this.logger.info(`Selected configuration with name "${args.config}" from ${args.json}`);
            return selectedConfig;
        }

        const isNumber = /\d+/.test(args.config) && !isNaN(Number(args.config));
        if (isNumber) {
            const index = Number(args.config);
            if (index >= 0 && index < configurations.length) {
                selectedConfig = configurations[index];
                this.logger.info(`Selected configuration at index ${index}:${selectedConfig.name} from ${args.json}`);
                return selectedConfig;
            }
        }
        // See if we can do a glob match, but it has to match exactly one configuration to avoid ambiguity.
        const minimatch = require("minimatch");
        const globMatches = configurations.filter((c: any) => minimatch(c.name, args.config));
        if (globMatches.length === 1) {
            selectedConfig = globMatches[0];
            this.logger.info(`Selected configuration with name "${selectedConfig.name}" from ${args.json} using glob pattern "${args.config}"`);
            return selectedConfig;
        } else if (globMatches.length > 1) {
            this.logger.error(`Multiple configurations match the glob pattern "${args.config}" in ${args.json}. Please specify a more specific name or index.`);
            process.exit(1);
        } else {
            this.logger.error(`Configuration with name "${args.config}" not found in ${args.json}`);
        }

        // Lets prompt to get configuration. First llist all available configurations in the log so the user knows
        // what they are. We could also consider implementing an interactive prompt to select the configuration, but
        // for now we'll just log the available configurations and ask the user to specify one using the --config argument.
        let ix = 0;
        this.logger.info(`Available 'mcu-debug' configurations in ${args.json}:`);
        for (const config of configurations) {
            this.logger.info(`  [${ix}] ${config.name}`);
            ix++;
        }
        // If stdin is a TTY or TUI, maybe we should promppt the user to select a configuration instead of just giving up?
        // For now, we'll just give up since implementing a prompt is a bit more work and we want to get this out. We can
        // always add a prompt later if users want it. We also don't know if we are in a TUI
        this.logger.info(`Please specify a configuration name or index using the --config argument.`);
        return undefined;
    }

    // TODO: Should we combine all types of variables and do substitution in one pass instead of doing built-in
    // vars first and then config vars? The main reason to do it in two passes is that it allows config vars to
    // reference built-in vars, but not the other way around. Doing it in one pass would allow more flexible
    // referencing between variables but would also be more complex and could potentially lead to circular
    // references. For now, we'll keep it as two passes since it's simpler and meets our current needs, but we
    // can consider changing it in the future if we find that users want more flexibility in variable referencing.
    private processVarSubstitutions(args: ConfigLoaderArgs, config: any): any {
        const builtins = args.builtins || CLIConfigLoader.gatherBuiltins();
        const fileName = args.json;
        const jsonContent = JSON.stringify(config);
        // built-ins go first as they may be referenced by envFile or other values we need
        let substitutedContent = processVarSubstitution(jsonContent, builtins, '', (msg) => {
            this.logger.warn(`In built-in variable substitution for ${fileName}: ${msg}`);
        });
        // If we have a settings file, we allow its values to be used in launch.json with ${config:VAR_NAME}
        substitutedContent = this.processConfigVars(substitutedContent);
        try {
            config = JSON.parse(substitutedContent) as ConfigurationArguments;
            config = substituteEnvVarsInConfig(config, (msg) => {
                this.logger.warn(`In environment variable substitution for ${fileName}: ${msg}`);
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
                this.logger.warn(`The following variables in ${fileName} were not substituted. This may indicate a mistake in the launch.json if these variables were intended to be substituted at this stage. If these variables are intended to be substituted later by the debug adapter or by the user during the debug session, then you can ignore this warning. Unsubstituted variables: ${uniqueVars.join(", ")}`);
            }
            return config;
        } catch (error) {
            this.logger.error("Failed to process variable substitutions in launch.json: " + (error instanceof Error ? error.message : String(error)));
            process.exit(1);
        }
    }

    public static gatherBuiltins(rootDir?: string): { [key: string]: any } {
        const builtins: { [key: string]: any } = {};
        // Populate built-in variables that can be used in launch.json. Only those that make sense
        // when no VSCode is involved. For example, ${workspaceFolder} is supported but ${file} is not since there is no file context.
        builtins.userHome = os.homedir() || "";
        builtins.workspaceFolder = rootDir || process.cwd();
        builtins.workspaceFolderBasename = path.basename(builtins.workspaceFolder);
        builtins.cwd = rootDir || process.cwd();
        builtins.pathSeparator = '/'; // path.sep;
        builtins["/"] = '/'; // Allow using ${/} as a platform-independent path separator in launch.json   
        return builtins;
    }
}

export class CliConfigProvider extends McuDebugConfigurationProviderBase {
    constructor(private logger: winston.Logger) {
        super(getHostAdapter(), true);
    }

    override provideDebugConfigurations(): { [key: string]: any }[] {
        this.logger.warn("provideDebugConfigurations is not supported in CLI mode. Returning empty array.");
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
            this.logger.warn("Graph config is not supported in CLI mode and will be ignored.");
            config.graphConfig = undefined;
        }

        try {
            config = (await super.resolveDebugConfiguration(folder, config)) as ConfigurationArguments;
        } catch (error) {
            this.logger.error("Error in resolveDebugConfiguration: " + (error instanceof Error ? error.message : String(error)));
            return undefined;
        }
        if (!config) {
            this.logger.error("resolveDebugConfiguration returned undefined.");
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
