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
            label: "Cortex Debug",
            program: "./dist/debugadapter.js",
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
                    name: "Cortex Debug: J-Link",
                    servertype: "jlink",
                    device: "STM32F103C8",
                    interface: "swd",
                    executable: "${workspaceFolder}/build/firmware.elf",
                    runToEntryPoint: "main",
                },
            ],
            configurationSnippets: [
                {
                    label: "Cortex Debug: JLink",
                    description: "Debugs an embedded ARM Cortex-M microcontroller using GDB + JLink",
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
                    label: "Cortex Debug: OpenOCD",
                    description: "Debugs an embedded ARM Cortex-M microcontroller using GDB + OpenOCD",
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
                    label: "Cortex Debug: ST-LINK",
                    description: "Debugs an embedded ARM Cortex-M microcontroller using GDB + STMicroelectronic's ST-LINK_gdbserver part of STM32CubeIDE",
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
                    label: "Cortex Debug: PyOCD",
                    description: "Debugs an embedded ARM Cortex-M microcontroller using GDB + PyOCD",
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
                    label: "Cortex Debug: ST-Util",
                    description: "Debugs an embedded ARM Cortex-M microcontroller using GDB + Texane's st-util GDB Server (https://github.com/texane/stlink)",
                    body: {
                        cwd: '^"\\${workspaceFolder}"',
                        executable: "${1:./bin/executable.elf}",
                        name: "${6:Debug with ST-Util}",
                        request: "launch",
                        type: "mcu-debug",
                        runToEntryPoint: "main",
                        debugFlags: {
                            gdbTraces: false,
                        },
                        servertype: "stutil",
                    },
                },
            ],
        },
    ];
}

function updatePackageJson() {
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, "utf8"));

    // Update configuration
    pkg.contributes.configuration = generateConfiguration();

    // Update debuggers
    pkg.contributes.debuggers = generateDebuggers();

    fs.writeFileSync(PACKAGE_JSON_PATH, JSON.stringify(pkg, null, 2) + "\n");
    console.log("Updated package.json");
}

updatePackageJson();
