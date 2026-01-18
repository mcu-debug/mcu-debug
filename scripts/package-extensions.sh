#!/bin/bash
# scripts/package-extensions.sh

set -e
mkdir -p dist

echo "==> Packaging mcu-debug..."
cd packages/mcu-debug
vsce package --no-dependencies --out ../../dist/

echo ""
echo "==> Packaging mcu-debug-proxy..."
cd ../mcu-debug-proxy
vsce package --no-dependencies --out ../../dist/

echo ""
echo "✓ Extensions packaged in ./dist/"
ls -lh ../../dist/*.vsix
