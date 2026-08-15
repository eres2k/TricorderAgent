'use strict';

// archive_tool roundtrips (zip + tar.gz) via Python's stdlib zipfile/tarfile,
// plus the validation guards that run before any subprocess.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const registry = require('../../server/tools');
const lib = require('../../server/tools/_lib');

const PY = process.env.TRICORDER_PYTHON || (process.platform === 'win32' ? 'py' : 'python3');
const hasPython = (() => {
    try { return spawnSync(PY, ['--version'], { stdio: 'ignore' }).status === 0; } catch { return false; }
})();
const skip = hasPython ? false : 'python interpreter not available';

let dir;

before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tricorder-arch-'));
    fs.mkdirSync(path.join(dir, 'src', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'a.txt'), 'alpha');
    fs.writeFileSync(path.join(dir, 'src', 'sub', 'b.txt'), 'beta');
});
after(() => {
    lib._killPyWorker();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('zip roundtrip: create_zip(input_dir) → list → extract', { skip }, async () => {
    const zip = path.join(dir, 'out.zip');
    const created = await registry.execute('archive_tool', { action: 'create_zip', input_dir: path.join(dir, 'src'), output_path: zip });
    assert.strictEqual(created.ok, true, JSON.stringify(created));
    assert.strictEqual(created.entries, 2);
    assert.ok(fs.existsSync(zip));

    const listed = await registry.execute('archive_tool', { action: 'list', input_path: zip });
    assert.strictEqual(listed.ok, true, JSON.stringify(listed));
    const names = listed.entries.map((e) => e.name).sort();
    assert.deepStrictEqual(names, ['src/a.txt', 'src/sub/b.txt']);

    const dest = path.join(dir, 'unzipped');
    const extracted = await registry.execute('archive_tool', { action: 'extract', input_path: zip, output_dir: dest });
    assert.strictEqual(extracted.ok, true, JSON.stringify(extracted));
    assert.strictEqual(fs.readFileSync(path.join(dest, 'src', 'a.txt'), 'utf8'), 'alpha');
    assert.strictEqual(fs.readFileSync(path.join(dest, 'src', 'sub', 'b.txt'), 'utf8'), 'beta');
});

test('tar.gz roundtrip with explicit input_paths', { skip }, async () => {
    const tgz = path.join(dir, 'out.tar.gz');
    const created = await registry.execute('archive_tool', {
        action: 'create_zip',
        input_paths: [path.join(dir, 'src', 'a.txt')],
        output_path: tgz,
    });
    assert.strictEqual(created.ok, true, JSON.stringify(created));

    const listed = await registry.execute('archive_tool', { action: 'list', input_path: tgz });
    assert.deepStrictEqual(listed.entries.map((e) => e.name), ['a.txt']);

    const dest = path.join(dir, 'untarred');
    const extracted = await registry.execute('archive_tool', { action: 'extract', input_path: tgz, output_dir: dest });
    assert.strictEqual(extracted.ok, true, JSON.stringify(extracted));
    assert.strictEqual(fs.readFileSync(path.join(dest, 'a.txt'), 'utf8'), 'alpha');
});

test('create_zip without inputs or output_path is MISSING_PARAM', async () => {
    const noOut = await registry.execute('archive_tool', { action: 'create_zip', input_dir: '/tmp' });
    assert.strictEqual(noOut.code, 'MISSING_PARAM');
    const noIn = await registry.execute('archive_tool', { action: 'create_zip', output_path: path.join(os.tmpdir(), 'x.zip') });
    assert.strictEqual(noIn.code, 'MISSING_PARAM');
});

test('extract/list demand an existing archive inside the sandbox', async () => {
    const missing = await registry.execute('archive_tool', { action: 'list', input_path: path.join(os.tmpdir(), 'no-such.zip') });
    assert.strictEqual(missing.code, 'NOT_FOUND');
    const denied = await registry.execute('archive_tool', { action: 'extract', input_path: '/srv/evil.zip' });
    assert.strictEqual(denied.code, 'PATH_DENIED');
});
