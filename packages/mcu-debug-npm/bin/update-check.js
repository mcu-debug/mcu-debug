"use strict";

const { readFileSync, writeFileSync, mkdirSync } = require("fs");
const { homedir } = require("os");
const { join, dirname } = require("path");
const { spawn } = require("child_process");

const { name: PACKAGE_NAME, version: CURRENT_VERSION } = require("../package.json");
const CACHE_FILE = join(homedir(), ".mcu-debug", "update-check.json");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// Raw ANSI — no dependency needed in this thin wrapper
const Y = "\x1b[33m",
    G = "\x1b[32m",
    C = "\x1b[36m",
    D = "\x1b[2m",
    R = "\x1b[0m";

function readCache() {
    try {
        return JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
    } catch {
        return null;
    }
}

function isNewer(latest, current) {
    const p = (v) => v.split(".").map(Number);
    const [lM, lm, lp] = p(latest),
        [cM, cm, cp] = p(current);
    return lM !== cM ? lM > cM : lm !== cm ? lm > cm : lp > cp;
}

function printNotice(latestVersion) {
    const l1vis = `  Update available: ${CURRENT_VERSION} \u2192 ${latestVersion}  `;
    const l2vis = `  Run: npm install -g ${PACKAGE_NAME}  `;
    const w = Math.max(l1vis.length, l2vis.length);
    const bar = "\u2500".repeat(w);
    const l1 = `  Update available: ${D}${CURRENT_VERSION}${R} ${Y}\u2192${R} ${G}${latestVersion}${R}  `;
    const l2 = `  Run: ${C}npm install -g ${PACKAGE_NAME}${R}  `;
    process.stderr.write(`\n${Y}\u256D${bar}\u256E${R}\n`);
    process.stderr.write(`${Y}\u2502${R}${l1}${" ".repeat(w - l1vis.length)}${Y}\u2502${R}\n`);
    process.stderr.write(`${Y}\u2502${R}${l2}${" ".repeat(w - l2vis.length)}${Y}\u2502${R}\n`);
    process.stderr.write(`${Y}\u2570${bar}\u256F${R}\n\n`);
}

/**
 * Read cached result and print a notice if a newer version was found on a previous check.
 * Zero blocking — only synchronous file I/O.
 */
function checkAndNotify() {
    const cache = readCache();
    if (cache?.latestVersion && isNewer(cache.latestVersion, CURRENT_VERSION)) {
        printNotice(cache.latestVersion);
    }
}

/**
 * Spawn a detached background process to fetch the latest version from npm and
 * update the cache. Unref'd immediately so it never delays the main process exit.
 * Only runs when the cache is stale or missing.
 */
function scheduleCheck() {
    const cache = readCache();
    if (cache && Date.now() - cache.checkedAt < CACHE_TTL_MS) {
        return;
    }

    const script = `
        const https = require('https');
        const fs = require('fs');
        const path = require('path');
        const cacheFile = process.env.MCU_DEBUG_CACHE_FILE;
        const pkg = process.env.MCU_DEBUG_PACKAGE;
        const req = https.get(
            'https://registry.npmjs.org/' + pkg + '/latest',
            { headers: { Accept: 'application/json' } },
            (res) => {
                let body = '';
                res.on('data', (c) => (body += c));
                res.on('end', () => {
                    try {
                        const version = JSON.parse(body).version;
                        fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
                        fs.writeFileSync(cacheFile, JSON.stringify({ checkedAt: Date.now(), latestVersion: version }));
                    } catch {}
                });
            }
        );
        req.setTimeout(5000, () => req.destroy());
        req.on('error', () => {});
    `;

    try {
        const child = spawn(process.execPath, ["-e", script], {
            detached: true,
            stdio: "ignore",
            env: { MCU_DEBUG_CACHE_FILE: CACHE_FILE, MCU_DEBUG_PACKAGE: PACKAGE_NAME },
        });
        child.unref();
    } catch {
        // Non-critical
    }
}

module.exports = { checkAndNotify, scheduleCheck };
