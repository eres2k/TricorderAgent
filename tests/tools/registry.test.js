'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const registry = require('../../server/tools');

// The count is asserted so adding a module without wiring it into MODULES —
// or into the browser-side mirror — fails here rather than at runtime.
const EXPECTED_TOOLS = [
    'git_operations', 'process_manager', 'sqlite_manager',
    'code_linter', 'archive_tool', 'dev_server', 'rss_reader',
];

test('registry exposes exactly the expected tools, with valid shapes', () => {
    assert.deepStrictEqual([...registry.names].sort(), [...EXPECTED_TOOLS].sort());
    assert.strictEqual(registry.schemas.length, EXPECTED_TOOLS.length);
    for (const m of registry.MODULES) {
        assert.ok(m.name, 'module has a name');
        assert.strictEqual(m.schema.type, 'function');
        assert.strictEqual(m.schema.function.name, m.name, 'schema name matches module name');
        assert.strictEqual(typeof m.execute, 'function');
        assert.ok(Array.isArray(m.schema.function.parameters.required));
    }
});

test('has() reports membership', () => {
    assert.ok(registry.has('git_operations'));
    assert.ok(!registry.has('nonexistent_tool'));
});

test('execute() returns a structured error for unknown tools', async () => {
    const r = await registry.execute('nope', {});
    assert.strictEqual(r.code, 'UNKNOWN_TOOL');
    assert.match(r.error, /Unknown tool/);
});

test('execute() converts thrown ToolErrors into { error, code }', async () => {
    // git_operations with a missing repo_path throws MISSING_PARAM, which the
    // registry must surface as a structured payload rather than rejecting.
    const r = await registry.execute('git_operations', { action: 'status' });
    assert.ok(r.error);
    assert.ok(r.code);
});

test('execute() enforces a structured error for bad actions', async () => {
    const r = await registry.execute('rss_reader', { action: 'not_a_real_action' });
    assert.strictEqual(r.code, 'BAD_ACTION');
});

test('every mutating tool name is a real tool', () => {
    for (const t of registry.mutating) assert.ok(registry.has(t), `${t} exists`);
});

test('isMutatingCall classifies per action', () => {
    // Read-only actions of otherwise-mutating tools pass.
    assert.strictEqual(registry.isMutatingCall('git_operations', { action: 'status' }), false);
    assert.strictEqual(registry.isMutatingCall('git_operations', { action: 'push' }), true);
    assert.strictEqual(registry.isMutatingCall('rss_reader', { action: 'list_feeds' }), false);
    assert.strictEqual(registry.isMutatingCall('rss_reader', { action: 'add_feed' }), true);
    assert.strictEqual(registry.isMutatingCall('rss_reader', { action: 'get_new_since' }), true, 'get_new_since updates seen ids');
    assert.strictEqual(registry.isMutatingCall('code_linter', { action: 'lint' }), false);
    assert.strictEqual(registry.isMutatingCall('code_linter', { action: 'format' }), true);
    assert.strictEqual(registry.isMutatingCall('process_manager', { action: 'list' }), false);
    assert.strictEqual(registry.isMutatingCall('process_manager', { action: 'kill', pid: 1 }), true);
    // Raw SQL: SELECT/PRAGMA read, everything else mutates; no action fails closed.
    assert.strictEqual(registry.isMutatingCall('sqlite_manager', { action: 'execute_query', query: ' select * from t' }), false);
    assert.strictEqual(registry.isMutatingCall('sqlite_manager', { action: 'execute_query', query: 'DELETE FROM t' }), true);
    assert.strictEqual(registry.isMutatingCall('sqlite_manager', {}), true);
    assert.strictEqual(registry.isMutatingCall('dev_server', { action: 'status' }), false);
    assert.strictEqual(registry.isMutatingCall('dev_server', { action: 'start' }), true);
    assert.strictEqual(registry.isMutatingCall('archive_tool', { action: 'list_contents' }), false);
    assert.strictEqual(registry.isMutatingCall('archive_tool', { action: 'create_zip' }), true);
});

test('per-tool timeout overrides are declared and within the cap', () => {
    const lib = require('../../server/tools/_lib');
    const expect = { ffmpeg_tool: 180000, pdf_generator: 180000, image_processor: 60000, audio_transcribe: 300000, asset_cache: 180000 };
    for (const m of registry.MODULES) {
        if (expect[m.name]) assert.strictEqual(m.timeoutMs, expect[m.name], `${m.name} timeout`);
        if (m.timeoutMs != null) {
            assert.ok(m.timeoutMs > 0 && m.timeoutMs <= lib.MAX_TIMEOUT_MS, `${m.name} timeout within cap`);
        }
    }
});
