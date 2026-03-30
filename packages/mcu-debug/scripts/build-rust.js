#!/usr/bin/env node
// Cross-platform wrapper for build-binaries.sh. Runs from monorepo root.
const { spawnSync } = require('child_process');
const path = require('path');

const mode = process.argv[2] || 'dev';
const root = path.resolve(__dirname, '../../..');
const script = path.join(root, 'scripts', 'build-binaries.sh');
const bash = process.platform === 'win32' ? 'bash.exe' : 'bash';

const result = spawnSync(bash, [script, mode], { cwd: root, stdio: 'inherit', shell: false });
process.exit(result.status ?? 1);
