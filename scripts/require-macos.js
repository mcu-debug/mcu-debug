#!/usr/bin/env node

if (process.platform !== "darwin") {
  console.error("Error: packaging all-platform VSIX artifacts is only supported on macOS.");
  console.error(`Current platform: ${process.platform}`);
  process.exit(1);
}
