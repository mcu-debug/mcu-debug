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

function has_cross() {
  command -v cross >/dev/null 2>&1
}

function has_container_runtime() {
  command -v docker >/dev/null 2>&1 || command -v podman >/dev/null 2>&1
}

if [[ "$mode" == "dev" ]]; then
  echo "Dev build: building for host platform (debug)"
  cd "$RUST_DIR"
  
  # Generate TypeScript exports via ts_rs (requires test execution in v12.0+)
  echo "Generating TypeScript exports..."
  cargo test --lib helper_requests::tests::ensure_ts_exports --quiet 2>/dev/null || true
  cargo test --lib proxy_server::tests::ensure_ts_exports --quiet 2>/dev/null || true
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
  cd "$RUST_DIR"

  # CI guard: if cross exists, require a container runtime so builds don't silently
  # downgrade to host cargo fallback in automated environments.
  if [[ "${CI:-}" == "true" ]] && has_cross && ! has_container_runtime; then
    echo "Error: CI requires container runtime when 'cross' is installed."
    echo "Install Docker or Podman, or remove/disable cross in this CI environment."
    exit 1
  fi

  # cross >=0.2.5 pre-installs the Linux x86_64 host toolchain before launching its
  # Docker container (the container runs x86_64 Linux and needs that toolchain).
  # On macOS, rustup refuses the install without --force-non-host because the
  # toolchain can't execute on macOS — but it runs fine inside the Docker container.
  # Pre-install it here so cross doesn't fail at startup.
  if [[ "$(uname -s)" == "Darwin" ]] && has_cross && has_container_runtime; then
    linux_host_tc="stable-x86_64-unknown-linux-gnu"
    if ! rustup toolchain list 2>/dev/null | grep -q "^${linux_host_tc}"; then
      echo "Pre-installing cross container toolchain (${linux_host_tc}) with --force-non-host..."
      rustup toolchain add "$linux_host_tc" --profile minimal --force-non-host || true
    fi
  fi

  # Generate TypeScript exports via ts_rs (requires test execution in v12.0+)
  echo "Generating TypeScript exports..."
  cargo test --lib helper_requests::tests::ensure_ts_exports --quiet 2>/dev/null || true
  cargo test --lib proxy_server::tests::ensure_ts_exports --quiet 2>/dev/null || true
  format_ts_exports

  # platform|target_triple|exe_ext
  # Linux targets intentionally use MUSL to produce static-friendly binaries.
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
    printf "\nBuilding target: %s (platform: %s)" "$triple" "$platform"

    # Apple Darwin targets require the macOS SDK and can only be built on macOS.
    if [[ "$triple" == *"-apple-darwin" ]] && [[ "$(uname -s)" != "Darwin" ]]; then
      echo " — skipping (Apple Darwin targets require a macOS host)"
      continue
    fi

    builder="cargo"
    if [[ "$triple" != *"-apple-darwin" ]] && has_cross && has_container_runtime; then
      builder="cross"
    fi
    echo ""
    echo "Using builder: $builder"

    # Ensure target installed
    if [[ "$builder" == "cargo" ]] && ! rustup target list --installed | grep -q "^${triple}$"; then
      echo "Adding rust target: $triple"
      rustup target add "$triple" || true
    fi

    # Build for target. Prefer `cross` for non-Darwin targets when available.
    if [[ "$builder" == "cross" ]]; then
      build_cmd=(cross build --release --bin "$BIN_NAME" --target "$triple")
    else
      build_cmd=(cargo build --release --bin "$BIN_NAME" --target "$triple")
    fi

    if "${build_cmd[@]}"; then
      artifact="target/$triple/release/$BIN_NAME$ext"
      dest_dir="$BINDIR/$platform"
      dest_name="$BIN_NAME$ext"
      if [[ -f "$artifact" ]]; then
        copy_artifact "$artifact" "$dest_dir" "$dest_name" || true
      else
        echo "Expected artifact not found: $artifact"
      fi
    else
      echo "$builder build failed for $triple."
      if [[ "$builder" == "cross" ]]; then
        echo "Make sure Docker/Podman is available for cross container builds."
      else
        echo "Consider installing 'cross' (cargo install cross --locked) or ensure native toolchain/linker availability."
      fi
    fi
  done

  sync_proxy_binaries

  echo "Production build done. Binaries under: $BINDIR"
  exit 0
fi

echo "Unknown mode: $mode"
echo "Usage: $0 [dev|prod]"
exit 2
