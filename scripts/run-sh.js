#!/usr/bin/env node
// Cross-platform shell script runner. Invokes bash (Git Bash on Windows).
const { spawnSync } = require('child_process');
const [script, ...args] = process.argv.slice(2);

if (!script) {
  console.error('Usage: node scripts/run-sh.js <script.sh> [args...]');
  process.exit(1);
}

const bash = process.platform === 'win32' ? 'bash.exe' : 'bash';
const result = spawnSync(bash, [script, ...args], { stdio: 'inherit', shell: false });
process.exit(result.status ?? 1);
