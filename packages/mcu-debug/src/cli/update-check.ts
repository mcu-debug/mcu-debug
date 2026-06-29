import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import colors from 'ansi-colors';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { version: currentVersion, name: packageName } = require('../../package.json') as { version: string; name: string };

const CACHE_FILE = path.join(os.homedir(), '.mcu-debug', 'update-check.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const FETCH_TIMEOUT_MS = 5000;

interface UpdateCache {
    checkedAt: number;
    latestVersion: string;
}

function readCache(): UpdateCache | null {
    try {
        const raw = fs.readFileSync(CACHE_FILE, 'utf-8');
        return JSON.parse(raw) as UpdateCache;
    } catch {
        return null;
    }
}

function writeCache(latestVersion: string) {
    try {
        fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
        fs.writeFileSync(CACHE_FILE, JSON.stringify({ checkedAt: Date.now(), latestVersion }));
    } catch {
        // Non-critical — ignore
    }
}

function fetchLatestVersion(): Promise<string> {
    return new Promise((resolve, reject) => {
        const req = https.get(
            `https://registry.npmjs.org/${packageName}/latest`,
            { headers: { Accept: 'application/json' } },
            (res) => {
                if (res.statusCode !== 200) {
                    reject(new Error(`HTTP ${res.statusCode}`));
                    return;
                }
                let body = '';
                res.on('data', (chunk: string) => (body += chunk));
                res.on('end', () => {
                    try {
                        resolve((JSON.parse(body) as { version: string }).version);
                    } catch (e) {
                        reject(e);
                    }
                });
            }
        );
        req.setTimeout(FETCH_TIMEOUT_MS, () => {
            req.destroy(new Error('timeout'));
        });
        req.on('error', reject);
    });
}

function isNewer(latest: string, current: string): boolean {
    const parse = (v: string) => v.split('.').map(Number);
    const [lMaj, lMin, lPat] = parse(latest);
    const [cMaj, cMin, cPat] = parse(current);
    if (lMaj !== cMaj) return lMaj > cMaj;
    if (lMin !== cMin) return lMin > cMin;
    return lPat > cPat;
}

function printUpdateNotice(latestVersion: string) {
    const line1 = `  Update available: ${colors.dim(currentVersion)} → ${colors.green(latestVersion)}  `;
    const line2 = `  Run: ${colors.cyan(`npm install -g ${packageName}`)}  `;
    const width = Math.max(line1.replace(/\x1b\[[0-9;]*m/g, '').length, line2.replace(/\x1b\[[0-9;]*m/g, '').length);
    const bar = '─'.repeat(width);
    process.stderr.write('\n');
    process.stderr.write(colors.yellow(`╭${bar}╮\n`));
    process.stderr.write(colors.yellow('│') + line1.padEnd(width + (line1.length - line1.replace(/\x1b\[[0-9;]*m/g, '').length)) + colors.yellow('│\n'));
    process.stderr.write(colors.yellow('│') + line2.padEnd(width + (line2.length - line2.replace(/\x1b\[[0-9;]*m/g, '').length)) + colors.yellow('│\n'));
    process.stderr.write(colors.yellow(`╰${bar}╯\n`));
    process.stderr.write('\n');
}

export async function checkForUpdate(): Promise<void> {
    try {
        const cache = readCache();
        let latestVersion: string;

        if (cache && Date.now() - cache.checkedAt < CACHE_TTL_MS) {
            latestVersion = cache.latestVersion;
        } else {
            latestVersion = await fetchLatestVersion();
            writeCache(latestVersion);
        }

        if (isNewer(latestVersion, currentVersion)) {
            printUpdateNotice(latestVersion);
        }
    } catch {
        // Non-critical — silently ignore network or parse failures
    }
}
