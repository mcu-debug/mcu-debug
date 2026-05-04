const fs = require("fs");
const path = require("path");
const definitions = require("../manifest-src/definitions");

const PACKAGE_JSON_PATH = path.join(__dirname, "../package.json");

function createPlatformProps(name, description) {
    const props = {};
    const baseProp = `mcu-debug.${name}`;

    props[baseProp] = {
        type: ["string", "null"],
        default: null,
        description,
    };

    ["linux", "osx", "windows"].forEach((platform) => {
        props[`${baseProp}.${platform}`] = {
            type: ["string", "null"],
            default: null,
            description,
        };
    });

    return props;
}

function generateConfiguration() {
    // Group 1: General Settings
    const generalProperties = {
        "mcu-debug.enableTelemetry": {
            type: "boolean",
            default: true,
            description: "Enable Telemetry for the Mcu-Debug Extension.",
        },
        "mcu-debug.dbgServerLogfile": {
            type: ["string", "null"],
            default: null,
            description: "Logs the contents of the gdb-server terminal. Use ${PID} in the file name to make it unique per VSCode session",
        },
    };

    // Group 2: Toolchain Paths
    const toolchainProperties = {
        ...createPlatformProps("armToolchainPath", "Path to the ARM Toolchain. If not set, the extension will look in the system path."),
        ...createPlatformProps("gdbPath", "Path to the GDB executable. If not set, the extension will look in the system path."),
        ...createPlatformProps("objdumpPath", "Path to the objdump executable. If not set, the extension will look in the system path."),
    };

    // Group 3: GDB Server Paths
    const serverProperties = {
        ...createPlatformProps("jlinkGDBServerPath", "Path to the J-Link GDB Server. If not set, the extension will look in the system path."),
        ...createPlatformProps("openocdPath", "Path to the OpenOCD executable. If not set, the extension will look in the system path."),
        ...createPlatformProps("pyocdPath", "Path to the PyOCD executable. If not set, the extension will look in the system path."),
        ...createPlatformProps("stlinkPath", "Path to the ST-Link GDB Server. If not set, the extension will look in the system path."),
        ...createPlatformProps("stutilPath", "Path to the ST-Util GDB Server. If not set, the extension will look in the system path."),
        ...createPlatformProps("PEGDBServerPath", "Path to the PE Micro GDB Server. If not set, the extension will look in the system path."),
    };

    return [
        {
            title: "MCU Debug: General",
            properties: generalProperties,
        },
        {
            title: "MCU Debug: Toolchain Paths",
            properties: toolchainProperties,
        },
        {
            title: "MCU Debug: GDB Server Paths",
            properties: serverProperties,
        },
    ];
}

function generateDebuggers() {
    const commonProps = { ...definitions };

    // Launch specific properties
    const launchProps = {
        ...commonProps,
        // Add launch-only properties here if any
    };

    // Attach specific properties
    const attachProps = {
        ...commonProps,
        // Add attach-only properties here if any
    };

    return [
        {
            type: "mcu-debug",
            label: "MCU Debug",
            program: "./dist/adapter.js",
            runtime: "node",
            languages: ["c", "cpp", "rust"],
            configurationAttributes: {
                launch: {
                    required: ["executable"],
                    properties: launchProps,
                },
                attach: {
                    required: ["executable"],
                    properties: attachProps,
                },
            },
            initialConfigurations: [
                {
                    type: "mcu-debug",
                    request: "launch",
                    name: "MCU Debug: J-Link",
                    servertype: "jlink",
                    device: "STM32F103C8",
                    interface: "swd",
                    executable: "${workspaceFolder}/build/firmware.elf",
                    runToEntryPoint: "main",
                },
            ],
            configurationSnippets: [
                {
                    label: "MCU Debug: JLink",
                    description: "Debugs an embedded microcontroller using GDB + JLink",
                    body: {
                        cwd: '^"\\${workspaceFolder}"',
                        executable: "${1:./bin/executable.elf}",
                        name: "${6:Debug with JLink}",
                        request: "launch",
                        type: "mcu-debug",
                        device: "",
                        runToEntryPoint: "main",
                        debugFlags: {
                            gdbTraces: false,
                        },
                        servertype: "jlink",
                    },
                },
                {
                    label: "MCU Debug: OpenOCD",
                    description: "Debugs an embedded microcontroller using GDB + OpenOCD",
                    body: {
                        cwd: '^"\\${workspaceRoot}"',
                        executable: "${1:./bin/executable.elf}",
                        name: "${6:Debug with OpenOCD}",
                        request: "launch",
                        type: "mcu-debug",
                        servertype: "openocd",
                        configFiles: [],
                        searchDir: [],
                        runToEntryPoint: "main",
                        debugFlags: {
                            gdbTraces: false,
                        },
                    },
                },
                {
                    label: "MCU Debug: ST-LINK",
                    description: "Debugs an embedded microcontroller using GDB + ST-LINK_gdbserver from STMicroelectronics",
                    body: {
                        cwd: '^"\\${workspaceFolder}"',
                        executable: "${1:./bin/executable.elf}",
                        name: "${6:Debug with ST-Link}",
                        request: "launch",
                        type: "mcu-debug",
                        runToEntryPoint: "main",
                        debugFlags: {
                            gdbTraces: false,
                        },
                        servertype: "stlink",
                    },
                },
                {
                    label: "MCU Debug: PyOCD",
                    description: "Debugs an embedded microcontroller using GDB + PyOCD",
                    body: {
                        cwd: '^"\\${workspaceFolder}"',
                        executable: "${1:./bin/executable.elf}",
                        name: "${6:Debug with PyOCD}",
                        request: "launch",
                        type: "mcu-debug",
                        runToEntryPoint: "main",
                        debugFlags: {
                            gdbTraces: false,
                        },
                        servertype: "pyocd",
                    },
                },
                {
                    label: "MCU Debug: Probe-RS (experimental)",
                    description: "Debugs an embedded microcontroller using GDB + Probe-RS",
                    body: {
                        cwd: '^"\\${workspaceFolder}"',
                        executable: "${1:./bin/executable.elf}",
                        name: "${6:Debug with Probe-RS (experimental)}",
                        request: "launch",
                        type: "mcu-debug",
                        loadFiles: [],
                        device: "specify-your-chip-here",
                        serialNumber: "optional-board-serial-number",
                        interface: "swd",
                        runToEntryPoint: "main",
                        debugFlags: {
                            gdbTraces: false,
                        },
                        servertype: "probe-rs",
                    },
                },
            ],
        },
    ];
}

function updatePackageJson() {
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, "utf8"));

    // Keep packaging scripts non-recursive.
    // `vsce package` always runs `vscode:prepublish`; if that script calls `npm run package`,
    // and `package` itself calls `vsce package`, packaging recurses indefinitely.
    if (pkg.scripts) {
        pkg.scripts["vscode:prepublish"] = "npm run build-all";
        pkg.scripts["package"] = "vsce package --no-dependencies";

        // Unified VSIX is the default packaging strategy.
        for (const target of ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win32-x64"]) {
            delete pkg.scripts[`package:${target}`];
        }
    }

    // Update configuration
    pkg.contributes.configuration = generateConfiguration();

    // Update debuggers
    pkg.contributes.debuggers = generateDebuggers();

    fs.writeFileSync(PACKAGE_JSON_PATH, JSON.stringify(pkg, null, 2) + "\n");
    console.log("Updated package.json");
}

updatePackageJson();
