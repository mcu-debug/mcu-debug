#!/bin/bash
# scripts/generate-types.sh

echo "Generating TypeScript types from Go..."

cd packages/proxy-server
tygo generate

echo "Copying generated types to shared package..."
cp internal/types/protocol.ts ../shared/src/types.ts

echo "✓ Types generated"
