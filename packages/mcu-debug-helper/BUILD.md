# Building Cross-Platform Binaries

This guide explains how to build the `mcu-debug-helper` Rust binary for multiple platforms.

## Quick Start

### Development Build (Current Platform Only)

```bash
./scripts/build-binaries.sh dev
```

Produces debug binary at `packages/mcu-debug/bin/mcu-debug-helper`

### Production Build (All Platforms)

**First time setup** (macOS only):
```bash
./scripts/setup-cross-compile.sh
```

This configures:
- `cross` (container-based cross compilation)
- Rust target standard libraries
- Optional native fallback toolchains when requested

**Then build all targets**:
```bash
./scripts/build-binaries.sh prod
```

Produces release binaries in:
```
packages/mcu-debug/bin/
├── darwin-arm64/mcu-debug-helper
├── darwin-x64/mcu-debug-helper
├── linux-arm64/mcu-debug-helper
├── linux-x64/mcu-debug-helper
├── win32-arm64/mcu-debug-helper.exe
└── win32-x64/mcu-debug-helper.exe
```

## Target Details

| Platform            | Target Triple                | Notes                                      |
| ------------------- | ---------------------------- | ------------------------------------------ |
| macOS Apple Silicon | `aarch64-apple-darwin`       | Native on M1/M2/M3 Macs                    |
| macOS Intel         | `x86_64-apple-darwin`        | Native, can cross-compile on Apple Silicon |
| Linux ARM64         | `aarch64-unknown-linux-musl` | Static-friendly via musl                   |
| Linux x64           | `x86_64-unknown-linux-musl`  | Static-friendly via musl                   |
| Windows ARM64       | `aarch64-pc-windows-gnu`     | MinGW cross-compiler                       |
| Windows x64         | `x86_64-pc-windows-gnu`      | MinGW cross-compiler                       |

## Build Strategy

- `darwin-*` targets: built natively with `cargo`.
- Linux/Windows targets: built with `cross` when available.
- If `cross` is not installed, build script falls back to native `cargo` + local linkers.

This keeps clone/build workflows working on macOS, Linux, and Windows:
- Native local builds continue to work per-platform.
- Multi-target release builds are easiest with `cross` + Docker/Podman.

## Binary Dependencies and Static Linking

### The Reality of Static Linking in 2026

Despite our best efforts, **truly static binaries are only achievable on some platforms**. Here's what you get:

#### macOS Binaries (darwin-arm64, darwin-x64)
- **Status**: As static as Apple allows
- **Dependencies**: System frameworks (Foundation, Security, etc.) must be dynamically linked
- **Portability**: Will run on any macOS 10.13+ system
- **Size**: ~3.4 MB (release)

#### Linux Binaries (linux-arm64, linux-x64)
- **Status**: Built with MUSL targets for static-friendly outputs
- **Dependencies**: Typically no glibc runtime dependency (`libc.so.6`)
- **Portability**: Better cross-distro portability than glibc-linked binaries
- **Size**: Usually larger than glibc-linked builds
- **Note**: Verify with `file`/`readelf` in CI to enforce static expectations

#### Windows Binaries (win32-x64, win32-arm64)
- **Status**: C runtime statically linked, Windows APIs dynamically linked
- **Dependencies**: Windows system DLLs only:
  - `KERNEL32.dll`, `ntdll.dll` (core Windows APIs)
  - `api-ms-win-crt-*.dll` (Universal C Runtime - included in Windows 10+)
  - `WS2_32.dll`, `USERENV.dll` (standard Windows libraries)
  - `bcryptprimitives.dll` (Windows cryptography)
- **Portability**: Will run on any Windows 10/11 system (no redistributables needed!)
- **Size**: ~5.8 MB (release)
- **Note**: These DLL dependencies are **system libraries** present on all Windows installations. No DLL hell!

### Code Signing

#### Windows
Windows Defender SmartScreen will flag **unsigned executables** as untrusted. Users will see:
- "Windows protected your PC" warning
- Requires clicking "More info" → "Run anyway"

**Solutions**:
1. **EV Code Signing Certificate** (~$300-500/year): Immediate SmartScreen reputation
2. **Standard Code Signing Certificate** (~$100-200/year): Builds reputation over time
3. **Open source projects**: Apply for free signing via [SignPath.io](https://about.signpath.io/)

**Signing command** (requires certificate):
```powershell
signtool sign /f certificate.pfx /p password /tr http://timestamp.digicert.com /td sha256 /fd sha256 mcu-debug-helper.exe
```

#### macOS
macOS Gatekeeper will quarantine unsigned binaries and show "unidentified developer" warnings.

**Solutions**:
1. **Apple Developer Account** ($99/year) + code signing + notarization
2. **For distribution**: Users must right-click → "Open" on first launch
3. **For development**: `xattr -d com.apple.quarantine mcu-debug-helper` removes quarantine

**Signing command** (requires Apple Developer certificate):
```bash
codesign --sign "Developer ID Application: Your Name" --timestamp mcu-debug-helper
xcrun notarytool submit mcu-debug-helper.zip --keychain-profile "AC_PASSWORD"
```

#### Linux
No signing required. Users may need `chmod +x` to make binary executable.

### Dependency Verification Commands

Check dependencies on any platform:

```bash
# macOS - check dynamic libraries
otool -L packages/mcu-debug/bin/darwin-arm64/mcu-debug-helper

# Linux - check shared object dependencies  
ldd packages/mcu-debug/bin/linux-x64/mcu-debug-helper
# or from macOS:
x86_64-unknown-linux-musl-objdump -p packages/mcu-debug/bin/linux-x64/mcu-debug-helper | grep NEEDED

# Windows - check DLL dependencies
# (from macOS with mingw-w64 installed)
x86_64-w64-mingw32-objdump -p packages/mcu-debug/bin/win32-x64/mcu-debug-helper.exe | grep "DLL Name"
```

## Linker Configuration

Cross-compilation linkers are configured in `packages/mcu-debug-helper/.cargo/config.toml`:
- Linux release targets use MUSL triples (`*-unknown-linux-musl`)
- `cross` is preferred for Linux/Windows to avoid local linker friction
- Windows targets remain GNU ABI (`x86_64-pc-windows-gnu`)
- macOS targets use native Xcode toolchain

## Troubleshooting

### cross build fails (Linux/Windows targets)
```bash
# Verify cross + container runtime
cross --version
docker --version   # or podman --version

# Reinstall if needed
cargo install cross --locked
```

### Windows cross-compilation fails
```bash
# Verify mingw-w64 is installed
x86_64-w64-mingw32-gcc --version

# Reinstall if needed
brew reinstall mingw-w64
```

### Alternative: Use Docker-based `cross`

If you prefer not to install native cross-compilers:
```bash
cargo install cross
cross build --release --target aarch64-unknown-linux-musl
```

## CI/CD

For automated builds on GitHub Actions, consider using separate jobs for each platform:
- `macos-latest` runner for Darwin targets
- `ubuntu-latest` runner for Linux targets  
- `windows-latest` runner for Windows targets

This provides native compilation on each platform.
