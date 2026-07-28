#!/bin/bash
# scripts/package-extensions.sh

set -e
node ./scripts/require-macos.js

mkdir -p dist
rm -f dist/*.vsix

# CI guard: if cross exists, require a container runtime so CI doesn't silently
# rely on host cargo fallback for non-Darwin targets.
if [[ "${CI:-}" == "true" ]] && command -v cross >/dev/null 2>&1; then
	if ! command -v docker >/dev/null 2>&1 && ! command -v podman >/dev/null 2>&1; then
		echo "Error: CI requires Docker or Podman when 'cross' is installed."
		echo "Install Docker/Podman, or remove/disable cross in this CI environment."
		exit 1
	fi
fi

echo "==> Build mode preflight..."
if command -v cross >/dev/null 2>&1; then
	if command -v docker >/dev/null 2>&1 || command -v podman >/dev/null 2>&1; then
		echo "Mode: native toolchains where installed, 'cross'+container fallback otherwise"
	else
		echo "Mode: cross installed, but no Docker/Podman detected"
		echo "      build-binaries.sh will only build targets with native toolchains installed"
	fi
else
	echo "Mode: native toolchains only ('cross' not installed)"
fi
echo ""

echo "==> Building Rust helper binaries (prod, all platforms)..."
bash ./scripts/build-binaries.sh prod

echo "==> Syncing helper binaries for both extensions..."
bash ./scripts/sync-helper-binaries.sh

echo "==> Packaging mcu-debug..."
cd packages/mcu-debug
rm -f ./*.vsix
vsce package --no-dependencies --out ../../dist/

echo ""
echo "==> Packaging mcu-debug-proxy..."
cd ../mcu-debug-proxy
rm -f ./*.vsix
vsce package --no-dependencies --out ../../dist/

echo ""
echo "✓ Extensions packaged in ./dist/"
ls -lh ../../dist/*.vsix
