#!/bin/bash
# scripts/package-extensions.sh

set -e

echo "==> Packaging mcu-debug..."
cd packages/mcu-debug
vsce package --out ../../dist/

echo ""
echo "==> Packaging mcu-debug-proxy..."
cd ../mcu-debug-proxy
vsce package --out ../../dist/

echo ""
echo "✓ Extensions packaged in ./dist/"
ls -lh ../../dist/*.vsix
