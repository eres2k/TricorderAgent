'use strict';

// Exercises the input-validation guard rails that run BEFORE any subprocess,
// so these pass on any platform without ffmpeg/Python/Office deps installed.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const registry = require('../../server/tools');

const tmp = [];
function tmpFile(name, body = 'x') {
    const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tric-')), name);
    fs.writeFileSync(p, body);
    tmp.push(path.dirname(p));
    return p;
}
after(() => { for (const d of tmp) try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } });

test('sqlite_manager rejects a non-identifier table name', async () => {
    const db = tmpFile('t.db');
    const r = await registry.execute('sqlite_manager', { db_path: db, action: 'create_table', table: 'bad table; DROP', data: { a: 'TEXT' } });
    assert.strictEqual(r.code, 'BAD_IDENTIFIER');
});

test('sqlite_manager rejects a non-identifier column name', async () => {
    const db = tmpFile('t2.db');
    const r = await registry.execute('sqlite_manager', { db_path: db, action: 'insert', table: 'users', data: { 'a; DROP': 1 } });
    assert.strictEqual(r.code, 'BAD_IDENTIFIER');
});

test('process_manager refuses to kill a system PID without confirm', async () => {
    const r = await registry.execute('process_manager', { action: 'kill', pid: 4 });
    assert.strictEqual(r.code, 'CONFIRM_REQUIRED');
});

test('code_linter cannot detect language for an unknown extension', async () => {
    const f = tmpFile('mystery.xyz', 'data');
    const r = await registry.execute('code_linter', { action: 'lint', file_path: f });
    assert.strictEqual(r.code, 'UNKNOWN_LANGUAGE');
});

test('code_linter check_security flags hard-coded secrets', async () => {
    const f = tmpFile('leak.js', 'const api_key = "abcdef123456";\nconst ok = 1;\n');
    const r = await registry.execute('code_linter', { action: 'check_security', file_path: f });
    assert.strictEqual(r.ok, true);
    assert.ok(r.count >= 1);
    assert.strictEqual(r.issues[0].line, 1);
});

test('rss_reader rejects an invalid feed url', async () => {
    const r = await registry.execute('rss_reader', { action: 'add_feed', feed_url: 'not a url' });
    assert.strictEqual(r.code, 'BAD_PARAM');
});

test('sqlite_manager insert without data is MISSING_PARAM', async () => {
    const db = tmpFile('t3.db');
    const r = await registry.execute('sqlite_manager', { db_path: db, action: 'insert', table: 'users' });
    assert.strictEqual(r.code, 'MISSING_PARAM');
});

