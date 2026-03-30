#!/usr/bin/env node
// Cross-platform replacement for copy-codicons.sh
const { cpSync, mkdirSync, readdirSync } = require('fs');
const path = require('path');

const src = path.resolve(__dirname, '../../../node_modules/@vscode/codicons/dist');
const dest = path.resolve(__dirname, '../resources/codicons');

mkdirSync(dest, { recursive: true });

for (const item of readdirSync(src)) {
  cpSync(path.join(src, item), path.join(dest, item), { recursive: true });
}
