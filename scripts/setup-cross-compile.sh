#!/usr/bin/env bash
set -euo pipefail

# Setup script to prepare cross-platform Rust builds.
# Primary path uses `cross` (Docker/Podman-based), with optional native toolchains.
#
# This installs/configures:
# - `cross` (cargo subcommand)
# - Rust target standard libraries
# - Optionally native Linux MUSL + MinGW toolchains via Homebrew for cargo fallback

echo "Setting up cross-platform build tooling for Rust..."
echo ""

# Detect OS
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Warning: This script is currently tailored for macOS/Homebrew environments."
  echo "On Linux/Windows, install Rust + cross directly and ensure Docker/Podman is available."
  exit 1
fi

# Check if Homebrew is installed
if ! command -v brew &> /dev/null; then
  echo "Error: Homebrew not found. Install from https://brew.sh/"
  exit 1
fi

echo "Step 1: Installing cross..."
if ! command -v cross &> /dev/null; then
  cargo install cross --locked
else
  echo "  cross is already installed"
fi

echo ""
echo "Step 2: Checking container runtime..."
if command -v docker &> /dev/null; then
  echo "  docker found"
elif command -v podman &> /dev/null; then
  echo "  podman found"
else
  echo "  Warning: docker/podman not found. cross builds will fail until one is installed."
fi

echo ""
echo "Step 3: Adding Rust target standard libraries..."
rustup target add aarch64-apple-darwin
rustup target add x86_64-apple-darwin
rustup target add aarch64-unknown-linux-musl
rustup target add x86_64-unknown-linux-musl
rustup target add x86_64-pc-windows-gnu
# Note: aarch64-pc-windows-gnu may not be in stable yet, try anyway
rustup target add aarch64-pc-windows-gnu || echo "  Warning: aarch64-pc-windows-gnu not available in this Rust version"

echo ""
if [[ "${MCU_DEBUG_INSTALL_NATIVE_TOOLCHAINS:-0}" == "1" ]]; then
  echo "Step 4: Installing optional native fallback toolchains..."
  if ! brew tap | grep -q "messense/macos-cross-toolchains"; then
    echo "  Adding messense/macos-cross-toolchains tap..."
    brew tap messense/macos-cross-toolchains
  fi
  brew install x86_64-unknown-linux-musl || echo "  (already installed or failed)"
  brew install aarch64-unknown-linux-musl || echo "  (already installed or failed)"
  brew install mingw-w64 || echo "  (already installed or failed)"
else
  echo "Step 4: Skipping native fallback toolchain install"
  echo "  Set MCU_DEBUG_INSTALL_NATIVE_TOOLCHAINS=1 to install Homebrew linkers too"
fi

echo ""
echo "✅ Setup complete!"
echo ""
echo "Verify installation:"
echo "  cross --version"
echo "  docker --version   # or podman --version"
echo ""
echo "Now you can run: ./scripts/build-binaries.sh prod"
