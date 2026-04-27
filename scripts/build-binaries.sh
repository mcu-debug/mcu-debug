#!/usr/bin/env bash
set -euo pipefail

# Build script for producing Rust executables for multiple platforms.
# Usage: ./scripts/build-binaries.sh [dev|prod]
# - dev: build only for current host (debug) and place binary at packages/mcu-debug/bin/mcu-debug-helper
# - prod: attempt release builds for multiple targets and place them under packages/mcu-debug/bin/<platform>/

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RUST_DIR="$ROOT_DIR/packages/mcu-debug-helper"
BINDIR="$ROOT_DIR/packages/mcu-debug/bin"
PROXY_BINDIR="$ROOT_DIR/packages/mcu-debug-proxy/bin"
BIN_NAME="mcu-debug-helper"

mkdir -p "$BINDIR"

mode="${1:-dev}"

PRETTIER="$ROOT_DIR/node_modules/.bin/prettier"
SHARED_DIR="$ROOT_DIR/packages/shared"

function ensure_ts_exports() {
  echo "Generating TypeScript exports..."
  cargo test --lib da_helper::helper_requests::tests::ensure_ts_exports --quiet
  cargo test --lib proxy_helper::proxy_server::tests::ensure_ts_exports --quiet
}

# Run prettier on the ts-rs generated TypeScript files.
# ts-rs --format is intentionally avoided; it uses a different formatter.
function format_ts_exports() {
  if [[ -x "$PRETTIER" ]]; then
    echo "Formatting generated TypeScript exports..."
    # Use a narrower print width than the project default (200) so that
    # generated type literals with many fields are broken across lines.
    "$PRETTIER" --write --print-width 120 \
      "$SHARED_DIR/dasm-helper" \
      "$SHARED_DIR/proxy-protocol" \
      "$SHARED_DIR/serial-helper" \
      2>/dev/null || true
  else
    echo "Warning: prettier not found at $PRETTIER, skipping format"
  fi
}

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

function native_rust_target() {
  local os arch
  os=$(uname -s)
  arch=$(uname -m)

  case "$os" in
    Darwin)
      # On Apple Silicon, a shell may run under Rosetta and report x86_64.
      # Detect underlying arm64 hardware and force native arm target.
      if [[ "$(sysctl -in hw.optional.arm64 2>/dev/null || echo 0)" == "1" ]]; then
        echo "aarch64-apple-darwin"
      else
        echo "x86_64-apple-darwin"
      fi
      ;;
    Linux)
      if [[ "$arch" == "aarch64" ]]; then
        echo "aarch64-unknown-linux-gnu"
      else
        echo "x86_64-unknown-linux-gnu"
      fi
      ;;
    MINGW*|MSYS*|CYGWIN*|Windows_NT)
      if [[ "$arch" == "aarch64" ]]; then
        echo "aarch64-pc-windows-msvc"
      else
        echo "x86_64-pc-windows-msvc"
      fi
      ;;
    *)
      echo ""
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

function sync_proxy_binaries() {
  [[ -n "${PROXY_BINDIR:-}" && "$PROXY_BINDIR" != "/" ]] || {
    echo "Refusing to clear PROXY_BINDIR='$PROXY_BINDIR'"
    exit 1
  }
  mkdir -p "$PROXY_BINDIR"
  find "$PROXY_BINDIR" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
  cp -R "$BINDIR"/. "$PROXY_BINDIR"/
  echo "Synchronized helper binaries to: $PROXY_BINDIR"
}

if [[ "$mode" == "dev" ]]; then
  echo "Dev build: building for host platform (debug)"
  cd "$RUST_DIR"

  # Generate TypeScript exports via ts_rs (requires test execution in v12.0+)
  ensure_ts_exports
  format_ts_exports

  target=$(native_rust_target)
  if [[ -n "$target" ]]; then
    if ! rustup target list --installed | grep -q "^${target}$"; then
      echo "Adding rust target: $target"
      rustup target add "$target" || true
    fi
    echo "Building debug helper for target: $target"
    cargo build --bin "$BIN_NAME" --target "$target"
    dbg_path="target/$target/debug/$BIN_NAME"
  else
    echo "Unknown host target, using default cargo host build"
    cargo build --bin "$BIN_NAME"
    dbg_path="target/debug/$BIN_NAME"
  fi

  host=$(host_platform)
  if [[ "$host" == win32-* ]]; then
    if [[ -n "$target" ]]; then
      dbg_path="target/$target/debug/$BIN_NAME.exe"
    else
      dbg_path="target/debug/$BIN_NAME.exe"
    fi
    BIN_NAME="$BIN_NAME.exe"
  fi

  # Copy root binary
  copy_artifact "$dbg_path" "$BINDIR" "$BIN_NAME" || true
  sync_proxy_binaries

  echo "Dev build complete. Main binary: $BINDIR/$BIN_NAME"
  exit 0
fi

if [[ "$mode" == "prod" ]]; then
  echo "Production build: release builds for multiple targets"

  # All cross-compilation toolchains (messense MUSL, mingw-w64) are macOS-only
  # Homebrew packages. Production builds must run on macOS.
  if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "Error: production builds are only supported on macOS."
    echo "All cross-compilation toolchains (messense MUSL, mingw-w64) are installed via Homebrew."
    exit 1
  fi

  cd "$RUST_DIR"

  # Verify all required cross-compilation toolchains are present before starting.
  # Install with:
  #   brew tap messense/macos-cross-toolchains
  #   brew install x86_64-unknown-linux-musl aarch64-unknown-linux-musl
  #   brew install mingw-w64
  missing=()
  command -v x86_64-unknown-linux-musl-gcc  >/dev/null 2>&1 || missing+=("x86_64-unknown-linux-musl-gcc  (brew install x86_64-unknown-linux-musl)")
  command -v aarch64-unknown-linux-musl-gcc >/dev/null 2>&1 || missing+=("aarch64-unknown-linux-musl-gcc (brew install aarch64-unknown-linux-musl)")
  command -v x86_64-w64-mingw32-gcc         >/dev/null 2>&1 || missing+=("x86_64-w64-mingw32-gcc         (brew install mingw-w64)")
  if [[ ${#missing[@]} -gt 0 ]]; then
    echo "Error: missing required cross-compilation toolchains:"
    for m in "${missing[@]}"; do
      echo "  - $m"
    done
    echo ""
    echo "On macOS, install all prerequisites with:"
    echo "  brew tap messense/macos-cross-toolchains"
    echo "  brew install x86_64-unknown-linux-musl aarch64-unknown-linux-musl mingw-w64"
    exit 1
  fi

  # Generate TypeScript exports via ts_rs (requires test execution in v12.0+)
  ensure_ts_exports
  format_ts_exports

  # platform|target_triple|exe_ext
  # Linux targets use MUSL for fully static binaries.
  # Note: aarch64-pc-windows-gnu not yet in stable Rust, omitted for now
  targets=(
    "darwin-arm64|aarch64-apple-darwin|"
    "darwin-x64|x86_64-apple-darwin|"
    "linux-arm64|aarch64-unknown-linux-musl|"
    "linux-x64|x86_64-unknown-linux-musl|"
    "win32-x64|x86_64-pc-windows-gnu|.exe"
  )

  for entry in "${targets[@]}"; do
    IFS='|' read -r platform triple ext <<< "$entry"
    printf "\nBuilding target: %s (platform: %s)\n" "$triple" "$platform"

    # Ensure rustup target is installed
    if ! rustup target list --installed | grep -q "^${triple}$"; then
      echo "Adding rust target: $triple"
      rustup target add "$triple" || true
    fi

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
      echo "cargo build failed for $triple — aborting."
      exit 1
    fi
  done

  sync_proxy_binaries

  echo "Production build done. Binaries under: $BINDIR"
  exit 0
fi

echo "Unknown mode: $mode"
echo "Usage: $0 [dev|prod]"
exit 2
