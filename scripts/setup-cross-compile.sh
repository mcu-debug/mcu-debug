#!/usr/bin/env bash
set -euo pipefail

# Setup script to install cross-compilation toolchains for building Rust binaries
# for multiple platforms from macOS without Docker/containers.
#
# This installs:
# - Linux cross-compilers (x86_64, aarch64) via Homebrew
# - MinGW-w64 for Windows cross-compilation
# - Rust target standard libraries

echo "Setting up cross-compilation toolchains for Rust..."
echo ""

# Detect OS
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Warning: This script is designed for macOS. On Linux, you may need different cross-compilers."
  echo "Consider using your package manager or 'cross' tool instead."
  exit 1
fi

# Check if Homebrew is installed
if ! command -v brew &> /dev/null; then
  echo "Error: Homebrew not found. Install from https://brew.sh/"
  exit 1
fi

echo "Step 1: Installing Linux cross-compilers..."
# Add the tap for macOS cross-toolchains
if ! brew tap | grep -q "messense/macos-cross-toolchains"; then
  echo "  Adding messense/macos-cross-toolchains tap..."
  brew tap messense/macos-cross-toolchains
fi

# Install Linux cross-compilers
echo "  Installing x86_64-unknown-linux-gnu toolchain..."
brew install x86_64-unknown-linux-gnu || echo "  (already installed or failed)"

echo "  Installing aarch64-unknown-linux-gnu toolchain..."
brew install aarch64-unknown-linux-gnu || echo "  (already installed or failed)"

echo ""
echo "Step 2: Installing MinGW-w64 for Windows cross-compilation..."
brew install mingw-w64 || echo "  (already installed or failed)"

echo ""
echo "Step 3: Adding Rust target standard libraries..."
rustup target add aarch64-apple-darwin
rustup target add x86_64-apple-darwin
rustup target add aarch64-unknown-linux-gnu
rustup target add x86_64-unknown-linux-gnu
rustup target add x86_64-pc-windows-gnu
# Note: aarch64-pc-windows-gnu may not be in stable yet, try anyway
rustup target add aarch64-pc-windows-gnu || echo "  Warning: aarch64-pc-windows-gnu not available in this Rust version"

echo ""
echo "✅ Setup complete!"
echo ""
echo "Verify installation:"
echo "  aarch64-unknown-linux-gnu-gcc --version"
echo "  x86_64-unknown-linux-gnu-gcc --version"
echo "  x86_64-w64-mingw32-gcc --version"
echo ""
echo "Now you can run: ./scripts/build-binaries.sh prod"
