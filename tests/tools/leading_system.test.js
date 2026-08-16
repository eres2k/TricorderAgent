'use strict';

/* Where the volatile context block is allowed to sit (js/llm.js).

   Strict chat templates — Qwen's among them — raise a Jinja exception if a
   `system` message appears anywhere but the very beginning of the
   conversation. Tricorder appends a volatile block AFTER the history on
   purpose, so the static prefix stays byte-stable and cacheable, which means
   that block's ROLE has to be chosen per family.

   The guard for that existed and was still wrong in the way that mattered. It
   asked getModelFamily(), which asks getModelId(), which returns
   settings.model — and settings.model is EMPTY on the default "auto" setting,
   because the operator pinned nothing. So the recommended Qwen build reported
   family 'unknown', fell through to system-role, and failed every single
   message with a 500:

     Jinja Exception: System message must be at the beginning.

   Two things are locked down here. The role must be safe for an unrecognised
   model, not just for a recognised one; and the invariant the template
   actually enforces — nothing system-role after index 0 — is asserted against
   a real built request body rather than inferred from the family table.

   Loads the REAL js/llm.js in a sandbox, the same way preserved_thinking does. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const JS_DIR = path.join(__dirname, '..', '..', 'js');

function loadTricorderLLM(savedSettings) {
    const read = (f) => fs.readFileSync(path.join(JS_DIR, f), 'utf8');
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
        dispatchEvent() {}, addEventListener() {}, TricorderToolIndex: null,
    };
    const noFetch = async () => ({
        ok: false, status: 503, headers: { get: () => '' },
        json: async () => ({}), text: async () => '',
    });
    const localStorageStub = {
        getItem: (key) => (key === 'tricorder_llm_settings' && savedSettings) ? JSON.stringify(savedSettings) : null,
        setItem() {}, removeItem() {},
    };
    const factory = new Function('window', 'localStorage', 'fetch', 'navigator', 'document', 'module', bundle);
    return factory(windowStub, localStorageStub, noFetch, { userAgent: 'node-test' }, {}, undefined);
}

// The invariant the chat template enforces, stated once.
function systemMessagesAfterStart(body) {
    return body.messages
        .map((m, i) => ({ i, role: m.role }))
        .filter((m) => m.i > 0 && m.role === 'system');
}

test('an unrecognised model gets the role that works everywhere', () => {
    const LLM = loadTricorderLLM(null);
    const T = LLM._tiering;
    assert.strictEqual(T.trailingContextRole('unknown'), 'user',
        'unknown must not gamble on system-role: it is a hard 500 on strict templates');
});

test('the default "auto" setting does not send a trailing system message', () => {
    // The exact configuration that was broken: nothing pinned, so
    // settings.model is '' and the family is unidentifiable.
    const LLM = loadTricorderLLM({ model: '', effort: 'medium' });
    assert.strictEqual(LLM._tiering.getModelFamily(), 'unknown', 'precondition: auto means unknown');

    const body = LLM._tiering.buildRequestBody(false, []);
    assert.deepStrictEqual(systemMessagesAfterStart(body), [],
        'a system message after index 0 is what produced "System message must be at the beginning"');
});

test('an explicitly pinned Qwen does not either', () => {
    const LLM = loadTricorderLLM({ model: 'qwen3.8-27b', effort: 'medium' });
    assert.strictEqual(LLM._tiering.getModelFamily(), 'qwen');
    assert.deepStrictEqual(systemMessagesAfterStart(LLM._tiering.buildRequestBody(false, [])), []);
});

test('the real-world model id from the bug report resolves to qwen', () => {
    // Backends publish decorated ids — quantisation, attention and speculative
    // -decoding suffixes all ride along on the name.
    const LLM = loadTricorderLLM({ model: 'Qwen3.8-27B-NVFP4-MTP-Q8attn', effort: 'medium' });
    assert.strictEqual(LLM._tiering.getModelFamily(), 'qwen');
    assert.deepStrictEqual(systemMessagesAfterStart(LLM._tiering.buildRequestBody(false, [])), []);
});

test('the system prompt itself is still first', () => {
    // The fix must not have moved the thing that is SUPPOSED to be a leading
    // system message.
    for (const model of ['', 'qwen3.8-27b', 'llama-3.1-8b-instruct']) {
        const LLM = loadTricorderLLM({ model, effort: 'medium' });
        const body = LLM._tiering.buildRequestBody(false, []);
        assert.strictEqual(body.messages[0].role, 'system', `${model || 'auto'}: prompt must lead`);
        assert.ok(body.messages[0].content.length > 0);
    }
});

test('families that tolerate it still get the better shape', () => {
    // Trailing system-role carries more instruction weight where it is legal,
    // so this is an allowlist rather than a blanket downgrade to user-role.
    const T = loadTricorderLLM(null)._tiering;
    assert.strictEqual(T.trailingContextRole('llama'), 'system');
    assert.strictEqual(T.trailingContextRole('mistral'), 'system');
    assert.strictEqual(T.trailingContextRole('qwen'), 'user');
});
