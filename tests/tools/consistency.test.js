/**
 * The browser and the server must describe the SAME tools.
 *
 * The browser sends tool schemas to the model; the server executes the calls
 * that come back. If the two drift, the model is invited to pass a parameter
 * the executor never reads — and the failure looks like a bad model, not a
 * bad build. js/llm-tools/extended-tools.js is therefore GENERATED from the
 * server modules; this test re-runs the generator and fails if the checked-in
 * file is stale.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const registry = require('../../server/tools');
const browserSchemas = require('../../js/llm-tools/extended-tools.js');
const { render } = require('../../scripts/gen-extended-tools.js');

test('the generated browser mirror is up to date', () => {
    const onDisk = fs.readFileSync(path.join(ROOT, 'js', 'llm-tools', 'extended-tools.js'), 'utf8');
    assert.strictEqual(onDisk, render(),
        'js/llm-tools/extended-tools.js is stale — run `npm run build:tools`');
});

test('every server tool is advertised to the model, and nothing else is', () => {
    const serverNames = [...registry.names].sort();
    const browserNames = browserSchemas.map((s) => s.function.name).sort();
    assert.deepStrictEqual(browserNames, serverNames);
});

test('the advertised schemas are byte-identical to the server modules', () => {
    for (const schema of registry.schemas) {
        const mirrored = browserSchemas.find((s) => s.function.name === schema.function.name);
        assert.ok(mirrored, `${schema.function.name} missing from the browser mirror`);
        assert.deepStrictEqual(mirrored, JSON.parse(JSON.stringify(schema)));
    }
});

test('every tool schema is well formed enough for a model to call', () => {
    for (const schema of registry.schemas) {
        assert.strictEqual(schema.type, 'function');
        const fn = schema.function;
        assert.ok(fn && typeof fn.name === 'string' && fn.name, 'has a name');
        assert.match(fn.name, /^[a-z][a-z0-9_]*$/, `${fn.name} is a valid function name`);
        assert.ok(typeof fn.description === 'string' && fn.description.length > 20,
            `${fn.name} has a description a model can act on`);
        assert.strictEqual(fn.parameters.type, 'object', `${fn.name} takes an object`);
        for (const required of fn.parameters.required || []) {
            assert.ok(fn.parameters.properties[required],
                `${fn.name}: required parameter "${required}" is declared in properties`);
        }
    }
});

test('every extended tool is classified for plan mode', () => {
    // Plan mode is read-only. A tool with no classification would fail closed
    // (treated as mutating), which is safe but silently unusable while
    // planning — so require the classification to be deliberate.
    for (const name of registry.names) {
        assert.ok(Object.prototype.hasOwnProperty.call(registry.MUTATING_ACTIONS, name),
            `${name} is missing from MUTATING_ACTIONS in server/tools/index.js`);
    }
});
