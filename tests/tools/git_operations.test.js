'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const registry = require('../../server/tools');

let repo;

before(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tricorder-git-'));
    const run = require('node:child_process').execFileSync;
    run('git', ['-C', repo, 'init', '-q'], { stdio: 'ignore' });
    run('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
    run('git', ['-C', repo, 'config', 'user.name', 'Test']);
    // Some CI sandboxes enforce global commit signing via a server key; the
    // temp repo must opt out so commits don't depend on that infrastructure.
    run('git', ['-C', repo, 'config', 'commit.gpgsign', 'false']);
});

after(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ } });

test('git status on a fresh repo succeeds', async () => {
    const r = await registry.execute('git_operations', { repo_path: repo, action: 'status' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.exitCode, 0);
});

test('add + commit round trip', async () => {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'hello');
    const add = await registry.execute('git_operations', { repo_path: repo, action: 'add', files: 'a.txt' });
    assert.strictEqual(add.ok, true);
    const commit = await registry.execute('git_operations', { repo_path: repo, action: 'commit', message: 'init' });
    assert.strictEqual(commit.ok, true);
    const log = await registry.execute('git_operations', { repo_path: repo, action: 'log' });
    assert.match(log.output, /init/);
});

test('commit without a message is a structured error', async () => {
    const r = await registry.execute('git_operations', { repo_path: repo, action: 'commit' });
    assert.strictEqual(r.code, 'MISSING_PARAM');
});

test('branch names starting with - are rejected', async () => {
    const r = await registry.execute('git_operations', { repo_path: repo, action: 'branch_create', branch: '--force' });
    assert.strictEqual(r.code, 'BAD_PARAM');
});

test('a non-repo path is rejected', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tricorder-norepo-'));
    const r = await registry.execute('git_operations', { repo_path: dir, action: 'status' });
    assert.strictEqual(r.code, 'NOT_A_REPO');
    fs.rmSync(dir, { recursive: true, force: true });
});

test('a path outside the sandbox is denied', async () => {
    const r = await registry.execute('git_operations', { repo_path: '/srv/nope', action: 'status' });
    assert.strictEqual(r.code, 'PATH_DENIED');
});

test('a failing git command surfaces as a structured GIT_ERROR', async () => {
    const r = await registry.execute('git_operations', { repo_path: repo, action: 'branch_switch', branch: 'no-such-branch-xyz' });
    assert.strictEqual(r.code, 'GIT_ERROR');
    assert.ok(r.error, 'carries the git stderr message');
    assert.ok(r.details && r.details.exitCode !== 0, 'details carry the exit code');
});
