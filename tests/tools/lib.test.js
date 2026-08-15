'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const lib = require('../../server/tools/_lib');

test('resolvePath denies paths outside the sandbox', () => {
    assert.throws(() => lib.resolvePath(null, '/srv/secret.txt'), (e) => e.code === 'PATH_DENIED');
});

test('resolvePath allows paths inside the sandbox', () => {
    const p = lib.resolvePath(null, path.join(os.tmpdir(), 'tricorder-test.txt'));
    assert.ok(p && path.isAbsolute(p));
});

test('resolvePath honours a ctx.sanitizePath override', () => {
    const ctx = { sanitizePath: (raw) => (raw === 'ok' ? '/tmp/ok' : null) };
    assert.strictEqual(lib.resolvePath(ctx, 'ok'), '/tmp/ok');
    assert.throws(() => lib.resolvePath(ctx, 'nope'), (e) => e.code === 'PATH_DENIED');
});

test('resolvePath enforces mustExist', () => {
    assert.throws(
        () => lib.resolvePath(null, path.join(os.tmpdir(), 'definitely-missing-xyz'), { mustExist: true }),
        (e) => e.code === 'NOT_FOUND',
    );
});

test('requireAction rejects unknown actions', () => {
    assert.throws(() => lib.requireAction('bogus', ['a', 'b']), (e) => e.code === 'BAD_ACTION');
    assert.throws(() => lib.requireAction('', ['a']), (e) => e.code === 'MISSING_PARAM');
    assert.strictEqual(lib.requireAction('a', ['a', 'b']), 'a');
});

test('toErrorPayload yields the { error, code } contract', () => {
    const p = lib.toErrorPayload(new lib.ToolError('boom', 'X_CODE', { a: 1 }));
    assert.deepStrictEqual(p, { error: 'boom', code: 'X_CODE', details: { a: 1 } });
    const p2 = lib.toErrorPayload(new Error('plain'));
    assert.deepStrictEqual(p2, { error: 'plain', code: 'TOOL_ERROR' });
});

test('withTimeout rejects with TIMEOUT', async () => {
    await assert.rejects(
        () => lib.withTimeout(new Promise((r) => setTimeout(r, 200)), 20, 'slow'),
        (e) => e.code === 'TIMEOUT',
    );
});

test('withTimeout resolves a fast promise', async () => {
    assert.strictEqual(await lib.withTimeout(Promise.resolve(42), 1000), 42);
});

test('parseJsonOut tolerates leading noise', () => {
    assert.deepStrictEqual(lib.parseJsonOut('warning: foo\n{"ok":true}'), { ok: true });
    assert.throws(() => lib.parseJsonOut('not json at all'), (e) => e.code === 'BAD_OUTPUT');
});
