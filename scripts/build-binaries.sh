#!/usr/bin/env bash
set -euo pipefail

# Build script for producing Rust executables for multiple platforms.
# Usage: ./scripts/build-binaries.sh [dev|prod]
# - dev: build only for current host (debug) and place binary at packages/mcu-debug/bin/mcu-debug
# - prod: attempt release builds for multiple targets and place them under packages/mcu-debug/bin/<platform>/

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RUST_DIR="$ROOT_DIR/packages/mdbg"
BINDIR="$ROOT_DIR/packages/mcu-debug/bin"
PROXY_BINDIR="$ROOT_DIR/packages/mcu-debug-proxy/bin"
BIN_NAME="mdbg"

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
  # Replace the destination by swapping in a fresh inode instead of writing
  # into the existing one. The singleton proxy daemon is long-lived and may
  # still have the old binary mmap'd; an in-place `cp` overwrite corrupts the
  # running Mach-O's code signature, and on macOS AMFI then SIGKILLs the very
  # next exec of that path ("zsh: killed"). `mv` unlinks the old inode (the
  # daemon keeps its now-anonymous mapping, unharmed) and atomically links a
  # brand-new, correctly-signed file for future launches.
  local tmp="$dest_dir/.$dest_name.tmp.$$"
  cp "$src" "$tmp"
  chmod +x "$tmp" 2>/dev/null || true
  mv -f "$tmp" "$dest_dir/$dest_name"
  echo "Wrote: $dest_dir/$dest_name"
}

# Best-effort: stop any lingering singleton proxy daemon(s) before we swap
# binaries. Unlike a version-bumped release (which hands off via the upgrade
# path), a dev rebuild keeps the SAME version, so a relaunch would otherwise
# reuse the still-running daemon executing the OLD code. `pkill -f 'mdbg proxy'`
# targets only proxy daemons (not an unrelated `mdbg da-helper`/cockpit) across
# all instances at once; `killall` is a fallback where pkill is unavailable.
# All best-effort: no daemon running, or no such tool, is fine. Copy safety
# does NOT depend on this — copy_artifact's inode swap is safe regardless.
function stop_running_proxies() {
  if command -v pkill >/dev/null 2>&1; then
    pkill -f "$BIN_NAME proxy" 2>/dev/null || true
  elif command -v killall >/dev/null 2>&1; then
    killall "$BIN_NAME" 2>/dev/null || true
  fi
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

  # Stop any lingering singleton daemon so the next launch runs these fresh
  # bytes (dev builds keep the same version, so no auto-upgrade handover).
  stop_running_proxies

  # Copy root binary
  copy_artifact "$dbg_path" "$BINDIR" "$BIN_NAME" || true
  sync_proxy_binaries

  echo "Dev build complete. Main binary: $BINDIR/$BIN_NAME"
  exit 0
fi

if [[ "$mode" == "prod" ]]; then
  echo "Production build: release builds for multiple targets"

  host_os="$(uname -s)"
  if [[ "$host_os" != "Darwin" && "$host_os" != "Linux" ]]; then
    echo "Error: production builds are only supported on macOS and Linux."
    echo "Current host OS: $host_os"
    exit 1
  fi

  cd "$RUST_DIR"

  # Resolve commonly-used toolchain aliases on Linux distributions.
  # .cargo/config.toml uses the canonical *-unknown-* names, but several
  # distros provide equivalent binaries with slightly different names.
  linux_x64_musl_gcc="x86_64-unknown-linux-musl-gcc"
  linux_arm64_musl_gcc="aarch64-unknown-linux-musl-gcc"

  if command -v musl-gcc >/dev/null 2>&1; then
    linux_x64_musl_gcc="musl-gcc"
  fi
  if command -v x86_64-linux-musl-gcc >/dev/null 2>&1; then
    linux_x64_musl_gcc="x86_64-linux-musl-gcc"
  fi
  if command -v x86_64-unknown-linux-musl-gcc >/dev/null 2>&1; then
    linux_x64_musl_gcc="x86_64-unknown-linux-musl-gcc"
  fi

  if command -v aarch64-linux-musl-gcc >/dev/null 2>&1; then
    linux_arm64_musl_gcc="aarch64-linux-musl-gcc"
  fi
  if command -v aarch64-unknown-linux-musl-gcc >/dev/null 2>&1; then
    linux_arm64_musl_gcc="aarch64-unknown-linux-musl-gcc"
  fi

  has_linux_x64_musl="false"
  has_linux_arm64_musl="false"
  has_win_x64_gnu="false"
  command -v "$linux_x64_musl_gcc" >/dev/null 2>&1 && has_linux_x64_musl="true"
  command -v "$linux_arm64_musl_gcc" >/dev/null 2>&1 && has_linux_arm64_musl="true"
  if command -v x86_64-w64-mingw32-gcc >/dev/null 2>&1 && command -v x86_64-w64-mingw32-ar >/dev/null 2>&1; then
    has_win_x64_gnu="true"
  fi

  # Override linker selection so rustc/cc-rs use the resolved native toolchains.
  # Only set these when the native toolchain is actually present: leaving them
  # unset lets the `cross` fallback below use the linker baked into its own
  # container images instead of a host binary name that doesn't exist there.
  if [[ "$has_linux_x64_musl" == "true" ]]; then
    export CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER="$linux_x64_musl_gcc"
    export CC_x86_64_unknown_linux_musl="$linux_x64_musl_gcc"
  fi
  if [[ "$has_linux_arm64_musl" == "true" ]]; then
    export CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_LINKER="$linux_arm64_musl_gcc"
    export CC_aarch64_unknown_linux_musl="$linux_arm64_musl_gcc"
  fi
  if [[ "$has_win_x64_gnu" == "true" ]]; then
    export CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER="x86_64-w64-mingw32-gcc"
    export CC_x86_64_pc_windows_gnu="x86_64-w64-mingw32-gcc"
    export CARGO_TARGET_X86_64_PC_WINDOWS_GNU_AR="x86_64-w64-mingw32-ar"
  fi

  # Fallback: use `cross` (Docker/Podman-based) for any target whose native
  # toolchain isn't installed. Requires both the `cross` cargo subcommand and
  # a reachable container runtime.
  needs_container="false"
  if [[ "$has_linux_x64_musl" != "true" || "$has_linux_arm64_musl" != "true" || "$has_win_x64_gnu" != "true" ]]; then
    needs_container="true"
  fi

  # If a container runtime is required and installed but not currently
  # running, try to start it ourselves (Docker Desktop / podman machine are
  # both local, reversible, single-command starts) instead of just failing.
  # Skipped in CI, where the runtime is expected to already be up (see the
  # CI guard in package-extensions.sh) and there's no GUI app to launch.
  function try_start_container_runtime() {
    if [[ "$host_os" != "Darwin" || "${CI:-}" == "true" ]]; then
      return 1
    fi
    if command -v docker >/dev/null 2>&1 && ! docker info >/dev/null 2>&1; then
      echo "Docker CLI found but the daemon isn't responding — starting Docker Desktop..."
      open -a Docker >/dev/null 2>&1 || true
      local waited=0 max_wait=90
      while (( waited < max_wait )); do
        sleep 3
        waited=$(( waited + 3 ))
        if docker info >/dev/null 2>&1; then
          echo "Docker is up (after ${waited}s)."
          return 0
        fi
        echo "  ...still waiting for Docker (${waited}s/${max_wait}s)"
      done
      echo "Docker didn't come up within ${max_wait}s. Start it manually with: open -a Docker"
      return 1
    fi
    if command -v podman >/dev/null 2>&1 && ! podman info >/dev/null 2>&1; then
      echo "podman CLI found but not responding — starting podman machine..."
      podman machine start >/dev/null 2>&1 && podman info >/dev/null 2>&1 && return 0
      echo "podman machine didn't come up. Start it manually with: podman machine start"
      return 1
    fi
    return 1
  }

  has_cross="false"
  if [[ "$needs_container" == "true" ]] && command -v cross >/dev/null 2>&1; then
    if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
      has_cross="true"
    elif command -v podman >/dev/null 2>&1 && podman info >/dev/null 2>&1; then
      has_cross="true"
    elif try_start_container_runtime; then
      has_cross="true"
    fi
  fi

  # Two skip categories:
  # - skipped_expected: structurally impossible on this host (e.g. Apple
  #   targets from a non-macOS host, no legal/technical way around it).
  # - skipped_env: this host *should* be able to build the target (native
  #   toolchain or cross+container), but isn't currently set up for it. This
  #   is an environment problem, not an inherent limitation, so it's treated
  #   as a hard failure below instead of silently shipping stale binaries.
  skipped_expected=()
  skipped_env=()

  # Generate TypeScript exports via ts_rs (requires test execution in v12.0+)
  ensure_ts_exports
  format_ts_exports

  # platform|target_triple|exe_ext|method
  # Linux targets use MUSL for static-friendly binaries.
  # Note: aarch64-pc-windows-gnu not yet in stable Rust, omitted for now.
  targets=()

  # Native Apple targets are only practical when building on macOS.
  if [[ "$host_os" == "Darwin" ]]; then
    targets+=("darwin-arm64|aarch64-apple-darwin||native")
    targets+=("darwin-x64|x86_64-apple-darwin||native")
  else
    skipped_expected+=("darwin-arm64 (non-macOS host)")
    skipped_expected+=("darwin-x64 (non-macOS host)")
  fi

  if [[ "$has_linux_arm64_musl" == "true" ]]; then
    targets+=("linux-arm64|aarch64-unknown-linux-musl||native")
  elif [[ "$has_cross" == "true" ]]; then
    targets+=("linux-arm64|aarch64-unknown-linux-musl||cross")
  else
    skipped_env+=("linux-arm64 (missing $linux_arm64_musl_gcc, and no cross+container available)")
  fi

  if [[ "$has_linux_x64_musl" == "true" ]]; then
    targets+=("linux-x64|x86_64-unknown-linux-musl||native")
  elif [[ "$has_cross" == "true" ]]; then
    targets+=("linux-x64|x86_64-unknown-linux-musl||cross")
  else
    skipped_env+=("linux-x64 (missing $linux_x64_musl_gcc, and no cross+container available)")
  fi

  if [[ "$has_win_x64_gnu" == "true" ]]; then
    targets+=("win32-x64|x86_64-pc-windows-gnu|.exe|native")
  elif [[ "$has_cross" == "true" ]]; then
    targets+=("win32-x64|x86_64-pc-windows-gnu|.exe|cross")
  else
    skipped_env+=("win32-x64 (missing x86_64-w64-mingw32-gcc/ar, and no cross+container available)")
  fi

  if [[ ${#skipped_expected[@]} -gt 0 ]]; then
    echo "Skipping targets not buildable from this host:"
    for s in "${skipped_expected[@]}"; do
      echo "  - $s"
    done
    echo ""
  fi

  if [[ ${#targets[@]} -eq 0 ]]; then
    echo "Error: no buildable production targets found on this host."
    if [[ "$host_os" == "Darwin" ]]; then
      echo "Install native toolchains with:"
      echo "  brew tap messense/macos-cross-toolchains"
      echo "  brew trust --tap messense/macos-cross-toolchains   # Homebrew 6+ only; required before install below will work"
      echo "  brew install x86_64-unknown-linux-musl aarch64-unknown-linux-musl mingw-w64"
    else
      echo "Install native toolchains on Debian/Ubuntu with: sudo apt-get update && sudo apt-get install -y musl-tools gcc-mingw-w64 binutils-mingw-w64"
      echo "For linux-arm64, install a cross toolchain that provides aarch64-unknown-linux-musl-gcc (or aarch64-linux-musl-gcc)."
    fi
    echo "Or install 'cross' (cargo install cross --locked) and start Docker/Podman: see scripts/setup-cross-compile.sh"
    exit 1
  fi

  # Unlike skipped_expected, these targets are ones this host is supposed to
  # be able to build. Shipping without them would silently leave stale
  # binaries in place from a previous build, so fail loudly instead.
  if [[ ${#skipped_env[@]} -gt 0 ]]; then
    echo "Error: the following targets should be buildable from this host but their toolchain isn't set up:"
    for s in "${skipped_env[@]}"; do
      echo "  - $s"
    done
    echo ""
    if ! command -v cross >/dev/null 2>&1; then
      echo "Fix by installing the missing native toolchain(s) above, or install 'cross' to build via container:"
      echo "  cargo install cross --locked"
    elif [[ "$host_os" == "Darwin" ]] && command -v docker >/dev/null 2>&1; then
      echo "'cross' is installed but Docker isn't running. Start it, then re-run this build:"
      echo "  open -a Docker"
    elif [[ "$host_os" == "Darwin" ]] && command -v podman >/dev/null 2>&1; then
      echo "'cross' is installed but podman isn't running. Start it, then re-run this build:"
      echo "  podman machine start"
    else
      echo "Fix by installing the missing native toolchain(s) above, or install and start Docker/Podman"
      echo "for 'cross' to use (see scripts/setup-cross-compile.sh)."
    fi
    echo "Refusing to proceed with a partial build — packaging would silently ship stale binaries for these platforms."
    exit 1
  fi

  # Stop any lingering singleton daemon before we swap the deployed binaries.
  stop_running_proxies

  for entry in "${targets[@]}"; do
    IFS='|' read -r platform triple ext method <<< "$entry"
    printf "\nBuilding target: %s (platform: %s, via: %s)\n" "$triple" "$platform" "$method"

    if [[ "$method" == "native" ]]; then
      # Ensure rustup target is installed
      if ! rustup target list --installed | grep -q "^${triple}$"; then
        echo "Adding rust target: $triple"
        rustup target add "$triple" || true
      fi
      build_cmd=(cargo build --release --bin "$BIN_NAME" --target "$triple")
      target_dir="target"
    else
      # Each cross target gets its own --target-dir. cross's per-triple
      # container images aren't ABI-compatible with each other, but the
      # host-side proc-macro/build-script artifacts cargo compiles while
      # cross-compiling live under <target-dir>/release (not namespaced by
      # triple) — sharing one target dir across triples causes cargo to
      # reuse a proc-macro .so built by a different container's toolchain
      # and fail with "can't find crate for `foo_impl`".
      target_dir="target-cross/$triple"
      build_cmd=(cross build --release --bin "$BIN_NAME" --target "$triple" --target-dir "$target_dir")
    fi

    if "${build_cmd[@]}"; then
      artifact="$target_dir/$triple/release/$BIN_NAME$ext"
      dest_dir="$BINDIR/$platform"
      dest_name="$BIN_NAME$ext"
      if [[ -f "$artifact" ]]; then
        copy_artifact "$artifact" "$dest_dir" "$dest_name" || true
      else
        echo "Expected artifact not found: $artifact"
      fi
    else
      echo "build failed for $triple (via $method) — aborting."
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
