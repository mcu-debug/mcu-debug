#!/bin/bash
# scripts/build-all.sh

set -e

echo "==> Building Go proxy server..."
cd packages/proxy-server
make build-all  # Builds for Windows, Linux, macOS

echo ""
echo "==> Generating TypeScript types..."
cd ../..
./scripts/generate-types.sh

echo ""
echo "==> Building shared package..."
npm run build --workspace=packages/shared

echo ""
echo "==> Building extensions..."
npm run build --workspace=packages/mcu-debug
npm run build --workspace=packages/mcu-debug-proxy

echo ""
echo "✓ All builds complete"
