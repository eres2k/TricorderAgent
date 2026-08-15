'use strict';

// Guards scripts/check-refs.js — the reference check for the js/ bundle.
//
// The check exists because a rename left three call sites pointing at a
// removed function (renderThinkMeter → renderRateMeter). That is a runtime
// ReferenceError which aborts whatever handler it sits in, and BOTH
// `node --check` and `new Function(src)` pass it: they validate parsing, not
// identifier resolution.
//
// These tests matter as much as the check does. The first version of it
// harvested every identifier inside any innermost {...} as a "declaration",
// which quietly registered ordinary call sites as bindings and made the whole
// thing a no-op — it passed on the clean tree AND on the broken one. A check
// that cannot fail is worse than no check, so the synthetic-bug case below is
// the one that keeps it honest.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { stripNonCode, findUnresolved, readBundle } =
    require(path.join(__dirname, '..', '..', 'scripts', 'check-refs.js'));

const sources = (obj) => new Map(Object.entries(obj));

test('a call to a removed function is reported', () => {
    const found = findUnresolved(sources({
        'a.js': `
            function renderRateMeter(m, el) { el.textContent = m.rate; }
            function onTick(el) { renderThinkMeter(el, 1); }
        `,
    }));
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].name, 'renderThinkMeter');
});

test('a call to a function defined in another file is not reported', () => {
    // index.html loads every file as a classic script, so the bundle shares
    // one global scope and cross-file calls are legitimate.
    const found = findUnresolved(sources({
        'a.js': 'function helper(x) { return x; }',
        'b.js': 'function use() { return helper(1); }',
    }));
    assert.deepStrictEqual(found, []);
});

test('calls inside a block are not mistaken for declarations', () => {
    // The exact defect that made the first version of the check a no-op.
    const found = findUnresolved(sources({
        'a.js': `
            function outer() {
                if (true) {
                    missingHelper(1, 2);
                }
            }
        `,
    }));
    assert.strictEqual(found.length, 1, 'a call inside a block must still be checked');
    assert.strictEqual(found[0].name, 'missingHelper');
});

test('multi-declarator bindings count as declared', () => {
    const found = findUnresolved(sources({
        'a.js': `
            let resolveResult, rejectResult;
            function run() { rejectResult(new Error('x')); }
        `,
    }));
    assert.deepStrictEqual(found, []);
});

test('method calls and optional chaining are ignored', () => {
    const found = findUnresolved(sources({
        'a.js': 'function go(o) { o.notAGlobal(); o?.alsoNot(); return o.deep.nested(1); }',
    }));
    assert.deepStrictEqual(found, []);
});

test('identifiers inside comments, strings and regexes are not read as code', () => {
    const found = findUnresolved(sources({
        'a.js': [
            '// refresh() in a line comment',
            '/* layout() in a block comment */',
            'function go() {',
            '  const s = "notReal(1)";',
            "  const t = 'alsoNotReal(2)';",
            '  const u = `templateNotReal(3)`;',
            '  return /regexNotReal\\(4\\)/.test(s) && t && u;',
            '}',
        ].join('\n'),
    }));
    assert.deepStrictEqual(found, []);
});

test('parameters and destructured bindings count as declared', () => {
    const found = findUnresolved(sources({
        'a.js': `
            const { alpha, beta: renamed } = window.stuff;
            function go(cb) { return cb(alpha, renamed); }
            const arrow = (fn) => fn();
        `,
    }));
    assert.deepStrictEqual(found, []);
});

test('the real js/ bundle has no unresolved call targets', () => {
    const found = findUnresolved(readBundle());
    const detail = found.map(p => `${p.file}:${p.line} ${p.name}(`).join('\n  ');
    assert.deepStrictEqual(found, [], `unresolved references in the bundle:\n  ${detail}`);
});

test('stripNonCode preserves line numbers', () => {
    // Reported line numbers have to match the real file, so blanking must not
    // collapse newlines.
    const src = 'a\n/* two\nlines */\nb\n';
    assert.strictEqual(stripNonCode(src).split('\n').length, src.split('\n').length);
});
