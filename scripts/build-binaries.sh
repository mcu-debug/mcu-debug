#!/usr/bin/env bash
set -euo pipefail

# Build script for producing Rust executables for multiple platforms.
# Usage: ./scripts/build-binaries.sh [dev|prod]
# - dev: build only for current host (debug) and place binary at packages/mcu-debug/bin/mcu-debug-helper
# - prod: attempt release builds for multiple targets and place them under packages/mcu-debug/bin/<platform>/

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RUST_DIR="$ROOT_DIR/packages/mcu-debug-helper"
BINDIR="$ROOT_DIR/packages/mcu-debug/bin"
BIN_NAME="mcu-debug-helper"

mkdir -p "$BINDIR"

mode="${1:-dev}"

function host_platform() {
  local os arch
  os=$(uname -s)
  arch=$(uname -m)
  case "$os" in
    Darwin)
      if [[ "$arch" == "arm64" || "$arch" == "aarch64" ]]; then
        echo "darwin-arm64"
      else
        echo "darwin-x64"
      fi
      ;;
    Linux)
      if [[ "$arch" == "aarch64" ]]; then
        echo "linux-arm64"
      else
        echo "linux-x64"
      fi
      ;;
    MINGW*|MSYS*|CYGWIN*|Windows_NT)
      if [[ "$arch" == "aarch64" ]]; then
        echo "win32-arm64"
      else
        echo "win32-x64"
      fi
      ;;
    *)
      echo "unknown"
      ;;
  esac
}

function copy_artifact() {
  local src=$1 dest_dir=$2 dest_name=$3
  mkdir -p "$dest_dir"
  if [[ ! -f "$src" ]]; then
    echo "Warning: artifact not found: $src"
    return 1
  fi
  cp "$src" "$dest_dir/$dest_name"
  echo "Wrote: $dest_dir/$dest_name"
}

if [[ "$mode" == "dev" ]]; then
  echo "Dev build: building for host platform (debug)"
  cd "$RUST_DIR"
  
  # Generate TypeScript exports via ts_rs (happens during test compilation)
  echo "Generating TypeScript exports..."
  cargo test --lib --no-run --quiet 2>/dev/null || true
  
  cargo build --bin "$BIN_NAME"
  host=$(host_platform)
  dbg_path="target/debug/$BIN_NAME"
  if [[ "$host" == win32-* ]]; then
    dbg_path="target/debug/$BIN_NAME.exe"
    BIN_NAME="$BIN_NAME.exe"
  fi

  # Copy root binary
  copy_artifact "$dbg_path" "$BINDIR" "$BIN_NAME" || true

  echo "Dev build complete. Main binary: $BINDIR/$BIN_NAME"
  exit 0
fi

if [[ "$mode" == "prod" ]]; then
  echo "Production build: release builds for multiple targets"
  cd "$RUST_DIR"
  
  # Generate TypeScript exports via ts_rs (happens during test compilation)
  echo "Generating TypeScript exports..."
  cargo test --lib --no-run --quiet 2>/dev/null || true

  
  # platform|target_triple|exe_ext
  # Note: aarch64-pc-windows-gnu not yet in stable Rust, omitted for now
  targets=(
    "darwin-arm64|aarch64-apple-darwin|"
    "darwin-x64|x86_64-apple-darwin|"
    "linux-arm64|aarch64-unknown-linux-gnu|"
    "linux-x64|x86_64-unknown-linux-gnu|"
    "win32-x64|x86_64-pc-windows-gnu|.exe"
  )

  for entry in "${targets[@]}"; do
    IFS='|' read -r platform triple ext <<< "$entry"
    printf "\nBuilding target: %s (platform: %s)" "$triple" "$platform"

    # Ensure target installed
    if ! rustup target list --installed | grep -q "^${triple}$"; then
      echo "Adding rust target: $triple"
      rustup target add "$triple" || true
    fi

    # Try cargo build --release --target. If it fails, suggest `cross`.
    if cargo build --release --bin "$BIN_NAME" --target "$triple"; then
      artifact="target/$triple/release/$BIN_NAME$ext"
      dest_dir="$BINDIR/$platform"
      dest_name="$BIN_NAME$ext"
      if [[ -f "$artifact" ]]; then
        copy_artifact "$artifact" "$dest_dir" "$dest_name" || true
      else
        echo "Expected artifact not found: $artifact"
      fi
    else
      echo "cargo build failed for $triple. Consider installing and using 'cross' for cross-compilation or ensure the appropriate linker/toolchain is available."
    fi
  done

  echo "Production build done. Binaries under: $BINDIR"
  exit 0
fi

echo "Unknown mode: $mode"
echo "Usage: $0 [dev|prod]"
exit 2
