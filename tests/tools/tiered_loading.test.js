'use strict';

// End-to-end guard for tiered tool loading (js/llm.js):
//   model calls tool_search → handler activates the matches → the schemas
//   appear in body.tools of the NEXT request → the model can call them.
// Loads the REAL js/llm.js (plus registry + every tool category file) in a
// sandbox with browser-global stubs, then drives the exported _tiering hooks.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const JS_DIR = path.join(__dirname, '..', '..', 'js');

function loadTricorderLLM() {
    const read = (f) => fs.readFileSync(path.join(JS_DIR, f), 'utf8');
    // Same load order as index.html: registry, category files, tool index, llm.
    let bundle = read(path.join('llm-tools', 'registry.js'));
    for (const f of fs.readdirSync(path.join(JS_DIR, 'llm-tools')).sort()) {
        if (!f.endsWith('.js') || f === 'registry.js' || f === 'tool-index.js') continue;
        bundle += '\n' + read(path.join('llm-tools', f));
    }
    bundle += '\n' + read(path.join('llm-tools', 'tool-index.js'));
    bundle += '\n' + read('llm.js');
    bundle += '\nreturn TricorderLLM;';

    const windowStub = {
        location: { origin: 'http://127.0.0.1:5173' },
        dispatchEvent() {},
        addEventListener() {},
        TricorderToolIndex: null,
    };
    const noFetch = async () => ({
        ok: false, status: 503,
        headers: { get: () => '' },
        json: async () => ({}),
        text: async () => '',
    });
    const localStorageStub = { getItem: () => null, setItem() {}, removeItem() {} };
    // `module` must be shadowed to undefined so tool-index.js takes its
    // browser branch instead of trying to module.exports inside the bundle.
    const factory = new Function(
        'window', 'localStorage', 'fetch', 'navigator', 'document', 'module',
        bundle
    );
    return factory(windowStub, localStorageStub, noFetch, { userAgent: 'node-test' }, {}, undefined);
}

const LLM = loadTricorderLLM();
const T = LLM._tiering;

test('llm.js loads under the sandbox and exposes the tiering hooks', () => {
    assert.ok(T, '_tiering export present');
    assert.ok(Array.isArray(T.CORE_TOOL_NAMES));
});

test('core set is small and contains the discovery tool', () => {
    assert.ok(T.CORE_TOOL_NAMES.length >= 5 && T.CORE_TOOL_NAMES.length <= 7,
        `core set should be 5-7 tools, got ${T.CORE_TOOL_NAMES.length}: ${T.CORE_TOOL_NAMES.join(', ')}`);
    assert.ok(T.CORE_TOOL_NAMES.includes('tool_search'), 'tool_search must be core');
});

test('a fresh turn advertises exactly the core set', () => {
    T.beginTurnActiveTools();
    const names = T.getActiveTools().map(t => t.function.name).sort();
    assert.deepStrictEqual(names, [...T.CORE_TOOL_NAMES].sort());
    assert.ok(!names.includes('code_linter'), 'non-core tool must not be advertised');
});

test('request body carries only active schemas when tools are enabled', () => {
    LLM.saveSettings({ internetAccess: true });
    T.beginTurnActiveTools();
    const body = T.buildRequestBody(false, []);
    const names = (body.tools || []).map(t => t.function.name).sort();
    assert.deepStrictEqual(names, [...T.CORE_TOOL_NAMES].sort());
});

test('a non-core tool becomes callable after tool_search returns it', () => {
    T.beginTurnActiveTools();
    assert.ok(!T.getActiveTools().some(t => t.function.name === 'code_linter'),
        'precondition: code_linter absent from the core set');

    // The model calls tool_search with an INTENT word (not the tool name).
    const result = T.handleToolSearchLocal({
        id: 'call_1',
        function: { name: 'tool_search', arguments: JSON.stringify({ query: 'lint' }) },
    });
    assert.strictEqual(result.role, 'tool');
    assert.strictEqual(result.tool_call_id, 'call_1');
    assert.match(result.content, /code_linter/, 'search result lists the matched tool');

    // …and the NEXT request in the same turn must advertise its full schema.
    const body = T.buildRequestBody(false, []);
    const def = (body.tools || []).find(t => t.function.name === 'code_linter');
    assert.ok(def, 'code_linter schema injected into body.tools after tool_search');
    assert.strictEqual(def.type, 'function');
    assert.ok(def.function.parameters?.properties, 'schema is complete (parameters present)');
    assert.ok(Array.isArray(def.function.parameters.required), 'required metadata intact');
});

test('tools merely loaded (not called) decay at the next turn', () => {
    T.beginTurnActiveTools();
    T.handleToolSearchLocal({ id: 'c', function: { name: 'tool_search', arguments: '{"query":"lint"}' } });
    assert.ok(T.getActiveTools().some(t => t.function.name === 'code_linter'));
    T.beginTurnActiveTools(); // new turn, code_linter never actually invoked
    assert.ok(!T.getActiveTools().some(t => t.function.name === 'code_linter'),
        'loaded-but-unused tool must drop back out of the prompt');
});

test('tools the model actually CALLED carry over, then expire after the decay window', () => {
    T.beginTurnActiveTools();
    T.activateTools(['code_linter']);
    T.noteToolsUsed(['code_linter']); // an actual invocation this turn

    T.beginTurnActiveTools(); // turn +1 → still advertised
    assert.ok(T.getActiveTools().some(t => t.function.name === 'code_linter'), 'carried into next turn');
    T.beginTurnActiveTools(); // turn +2 → still within decay window
    assert.ok(T.getActiveTools().some(t => t.function.name === 'code_linter'), 'still carried');
    T.beginTurnActiveTools(); // turn +3 → past TOOL_CARRY_DECAY_TURNS
    assert.ok(!T.getActiveTools().some(t => t.function.name === 'code_linter'), 'expired after decay window');
});

test('no-query tool_search returns the grouped catalogue without activating anything', () => {
    T.beginTurnActiveTools();
    const before = T.getActiveTools().length;
    const result = T.handleToolSearchLocal({ id: 'c2', function: { name: 'tool_search', arguments: '{}' } });
    assert.match(result.content, /CODE LINTER/i, 'catalogue lists tool families');
    assert.strictEqual(T.getActiveTools().length, before, 'catalogue view must not expand the active set');
});

test('unknown-intent query tells the model how to recover', () => {
    const result = T.handleToolSearchLocal({ id: 'c3', function: { name: 'tool_search', arguments: '{"query":"zzqqxx"}' } });
    assert.match(result.content, /No tools matched/);
    assert.match(result.content, /no query/i, 'points at the catalogue fallback');
});
