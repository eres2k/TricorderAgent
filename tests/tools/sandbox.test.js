/**
 * The file sandbox.
 *
 * This is the one guard that stands between "an agent that edits your project"
 * and "an agent that reads your SSH key". It is worth testing directly rather
 * than only through the tool dispatcher, because the interesting cases are the
 * ones no tool asks for on purpose: `..` traversal, a symlink-shaped absolute
 * path, a credential file that happens to sit inside an allowed root.
 *
 * The server is booted with a known workspace and ALLOWED_PATHS so the
 * expectations are about the rule, not about whoever's machine runs the test.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');

function post(port, urlPath, body) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        const req = http.request({
            method: 'POST', hostname: '127.0.0.1', port, path: urlPath,
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
            timeout: 20000,
        }, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({ raw: data }); } });
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.end(payload);
    });
}

// Run one read_file call and return its parsed result.
async function readFile(port, filePath) {
    const res = await post(port, '/api/tools/execute', {
        tool_calls: [{
            id: 'x', type: 'function',
            function: { name: 'read_file', arguments: JSON.stringify({ path: filePath }) },
        }],
    });
    return JSON.parse(res.results[0].output);
}

test('the sandbox allows the workspace and refuses everything else', async (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'tricorder-sandbox-'));
    const extra = fs.mkdtempSync(path.join(os.tmpdir(), 'tricorder-extra-'));

    fs.writeFileSync(path.join(workspace, 'inside.txt'), 'allowed');
    fs.writeFileSync(path.join(extra, 'granted.txt'), 'also allowed');
    // A credential file placed inside an allowed root: being under ALLOWED_PATHS
    // must not be enough to read it.
    fs.mkdirSync(path.join(extra, '.ssh'), { recursive: true });
    fs.writeFileSync(path.join(extra, '.ssh', 'id_rsa'), 'PRIVATE KEY');
    fs.writeFileSync(path.join(extra, '.env'), 'SECRET=hunter2');

    const port = 3800 + (process.pid % 150);
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
        cwd: ROOT,
        env: {
            ...process.env,
            PORT: String(port),
            TRICORDER_WORKSPACE: workspace,
            ALLOWED_PATHS: extra,
            ALLOW_HOME: 'false',
            LOG_LEVEL: 'ERROR',
        },
        stdio: ['ignore', 'ignore', 'pipe'],
    });
    t.after(() => {
        try { child.kill('SIGKILL'); } catch { /* gone */ }
        for (const dir of [workspace, extra]) {
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
        }
    });

    // Wait for the port to answer.
    for (let i = 0; i < 60; i++) {
        try { await readFile(port, 'inside.txt'); break; }
        catch { await new Promise((r) => setTimeout(r, 250)); }
    }

    await t.test('reads inside the workspace', async () => {
        const res = await readFile(port, 'inside.txt');
        assert.equal(res.content, 'allowed');
    });

    await t.test('reads inside an explicitly granted extra root', async () => {
        const res = await readFile(port, path.join(extra, 'granted.txt'));
        assert.equal(res.content, 'also allowed');
    });

    await t.test('refuses an absolute path outside every root', async () => {
        const res = await readFile(port, '/etc/hostname');
        assert.ok(res.error, 'reading /etc/hostname should have been refused');
    });

    await t.test('refuses traversal out of the workspace', async () => {
        const res = await readFile(port, '../../../etc/hostname');
        assert.ok(res.error, 'traversal out of the workspace should have been refused');
    });

    await t.test('refuses credential files even inside an allowed root', async () => {
        const key = await readFile(port, path.join(extra, '.ssh', 'id_rsa'));
        assert.ok(key.error, 'an SSH key inside an allowed root must still be refused');
        assert.ok(!String(JSON.stringify(key)).includes('PRIVATE KEY'));

        const env = await readFile(port, path.join(extra, '.env'));
        assert.ok(env.error, 'a .env inside an allowed root must still be refused');
        assert.ok(!String(JSON.stringify(env)).includes('hunter2'));
    });

    await t.test('refuses writes outside the sandbox too', async () => {
        const res = await post(port, '/api/tools/execute', {
            tool_calls: [{
                id: 'w', type: 'function',
                function: { name: 'write_file', arguments: JSON.stringify({ path: '/etc/tricorder-should-not-exist', content: 'x' }) },
            }],
        });
        assert.ok(JSON.parse(res.results[0].output).error);
        assert.equal(fs.existsSync('/etc/tricorder-should-not-exist'), false);
    });
});
