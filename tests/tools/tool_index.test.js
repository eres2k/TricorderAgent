'use strict';

// Guards the shared tool-discovery index (js/llm-tools/tool-index.js): every
// native tool must map to a category (so the grouped catalogue hides nothing),
// and intent/synonym queries must resolve to the right tool family.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const toolIndex = require('../../js/llm-tools/tool-index.js');

// Load every native tool the same way the server does (loadNativeToolDefs):
// eval each category file with a register() shim and collect the schemas.
function loadNativeTools() {
    const dir = path.join(__dirname, '..', '..', 'js', 'llm-tools');
    const collected = [];
    const shim = { register(arr) { if (Array.isArray(arr)) collected.push(...arr); } };
    for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.js') || f === 'registry.js' || f === 'tool-index.js') continue;
        const code = fs.readFileSync(path.join(dir, f), 'utf8');
        // eslint-disable-next-line no-new-func
        new Function('TricorderNativeTools', code)(shim);
    }
    return collected.map(d => ({ name: d.function.name, description: d.function.description || '' }));
}

const TOOLS = loadNativeTools();

test('loads the full native tool set', () => {
    // A floor, not an exact count — adding a tool should not break this test,
    // but losing a whole category silently should.
    assert.ok(TOOLS.length >= 40, `expected 40+ tools, got ${TOOLS.length}`);
});

test('every native tool maps to a category (no orphans)', () => {
    const orphans = TOOLS.filter(t => !toolIndex.categoryOf(t.name)).map(t => t.name);
    assert.deepStrictEqual(orphans, [], `uncategorised tools: ${orphans.join(', ')}`);
});

test('catalogue covers every tool with no OTHER bucket', () => {
    const groups = toolIndex.catalogue(TOOLS);
    assert.ok(!groups.some(g => g.id === 'other'), 'no OTHER bucket expected');
    const listed = new Set(groups.flatMap(g => g.tools));
    for (const t of TOOLS) assert.ok(listed.has(t.name), `${t.name} appears in catalogue`);
});

test('intent/synonym queries resolve to the right tool family', () => {
    const cases = {
        remind: 'create_task',
        'background agent': 'agent_spawn',
        lint: 'code_linter',
        preview: 'dev_server',
        database: 'sqlite_manager',
        commit: 'git_operations',
        remember: 'memory_store',
        unzip: 'archive_tool',
        headlines: 'rss_reader',
        sandbox: 'code_exec',
        'edit file': 'file_edit',
        news: 'web_search',
    };
    for (const [query, expected] of Object.entries(cases)) {
        const { matches } = toolIndex.search(TOOLS, query, { top: 12 });
        const names = matches.map(m => m.name);
        assert.ok(names.includes(expected), `query "${query}" should surface ${expected}; got [${names.join(', ')}]`);
    }
});

test('a no-match query returns nothing', () => {
    const { matches, total } = toolIndex.search(TOOLS, 'zzqqxx', { top: 12 });
    assert.strictEqual(matches.length, 0);
    assert.strictEqual(total, 0);
});

test('empty query yields no ranked matches (caller shows the catalogue instead)', () => {
    const { matches } = toolIndex.search(TOOLS, '', { top: 12 });
    assert.strictEqual(matches.length, 0);
});
