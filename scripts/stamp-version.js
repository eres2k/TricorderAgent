#!/usr/bin/env node
/**
 * Build script: stamps a unique deploy version into sw.js
 * so the service worker always reinstalls on each deploy,
 * clearing stale caches automatically.
 *
 * Usage: node scripts/stamp-version.js
 *
 * Uses git short hash if available, otherwise falls back to a timestamp.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SW_PATH = path.join(__dirname, '..', 'sw.js');

let version;
try {
    // Use git short hash + timestamp for a meaningful, unique version
    const hash = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
    version = `${new Date().toISOString().slice(0, 10)}-${hash}`;
} catch {
    version = Date.now().toString();
}

const sw = fs.readFileSync(SW_PATH, 'utf8');
const updated = sw.replace(
  /const CACHE_VERSION = '[^']*';/,
  `const CACHE_VERSION = '${version}';`
);

fs.writeFileSync(SW_PATH, updated, 'utf8');
console.log(`[stamp-version] CACHE_VERSION set to '${version}'`);
