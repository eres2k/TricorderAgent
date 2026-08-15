'use strict';

// Preserved thinking (js/llm.js) — Qwen3.8's `preserve_thinking`.
//
// The model renders the reasoning of PREVIOUS assistant messages back into the
// prompt when the flag is on, which is what stops round 9 of a tool chain
// re-deriving what round 3 already worked out. It takes both halves: the flag
// on the wire, and the reasoning actually attached to the assistant message
// the loop replays. This agent used to send neither.
//
// The tests below guard the two ways that goes wrong. Sent unbounded, fifteen
// rounds of xhigh reasoning overflow any window a local machine can afford.
// Left attached after the turn, every trace rides along in every later request
// forever, because buildMessages() replays history verbatim.
//
// Loads the REAL js/llm.js in a sandbox, the same way effort_tiers.test.js does.
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

test('preserved thinking is on by default, and only for families whose template reads the flag', () => {
    const LLM = loadTricorderLLM(null);
    LLM.saveSettings({ model: 'qwen3.8-27b' });
    assert.strictEqual(LLM._tiering.preservesThinking(), true);

    // Llama's template has no such variable, and it has no thinking mode to
    // preserve either — attaching reasoning there is dead prompt weight.
    LLM.saveSettings({ model: 'llama-3.1-8b-instruct' });
    assert.strictEqual(LLM._tiering.preservesThinking(), false);
});

test('the operator can turn it off, and then nothing is attached', () => {
    const LLM = loadTricorderLLM({ model: 'qwen3.8-27b', preserveThinking: false });
    assert.strictEqual(LLM._tiering.preservesThinking(), false);

    const msgs = [];
    LLM._tiering.pushAssistantRound(msgs, { role: 'assistant', content: null, tool_calls: [] }, 'a long scratchpad');
    assert.strictEqual(msgs[0].reasoning_content, undefined);
});

test('the wire flag matches what was actually sent, in both directions', () => {
    const LLM = loadTricorderLLM(null);
    const T = LLM._tiering;

    LLM.saveSettings({ model: 'qwen3.8-27b', effort: 'medium', preserveThinking: true });
    assert.strictEqual(T.buildRequestBody(false, []).chat_template_kwargs.preserve_thinking, true);

    // Off by setting…
    LLM.saveSettings({ preserveThinking: false });
    assert.strictEqual(T.buildRequestBody(false, []).chat_template_kwargs.preserve_thinking, false,
        'the model default is ON, so "off" has to be stated rather than omitted');

    // …and off because the tier is not thinking at all.
    LLM.saveSettings({ preserveThinking: true, effort: 'none' });
    assert.strictEqual(T.buildRequestBody(false, []).chat_template_kwargs.preserve_thinking, false);
});

test('the flag is absent for families that would not understand it', () => {
    const LLM = loadTricorderLLM(null);
    LLM.saveSettings({ model: 'llama-3.1-8b-instruct', effort: 'medium' });
    const body = LLM._tiering.buildRequestBody(false, []);
    assert.strictEqual('preserve_thinking' in body.chat_template_kwargs, false,
        'an inert kwarg is noise — state intent, do not spray fields');
});

test('reasoning rides along on the assistant message the loop replays', () => {
    const LLM = loadTricorderLLM(null);
    LLM.saveSettings({ model: 'qwen3.8-27b', preserveThinking: true });

    const msgs = [];
    LLM._tiering.pushAssistantRound(msgs,
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1' }] },
        'The config lives in server/, not js/. Check there first.');

    assert.strictEqual(msgs.length, 1);
    assert.match(msgs[0].reasoning_content, /config lives in server/);
    assert.deepStrictEqual(msgs[0].tool_calls, [{ id: 'c1' }], 'the tool call is untouched');
});

test('only the most recent rounds keep their trace', () => {
    // Fifteen rounds of xhigh reasoning is not a prompt, it is an outage.
    const LLM = loadTricorderLLM(null);
    LLM.saveSettings({ model: 'qwen3.8-27b', preserveThinking: true });
    const keep = LLM._tiering.PRESERVED_THINKING_ROUNDS;

    const msgs = [];
    for (let i = 0; i < keep + 4; i++) {
        LLM._tiering.pushAssistantRound(msgs, { role: 'assistant', content: null }, `reasoning for round ${i}`);
        msgs.push({ role: 'tool', tool_call_id: `c${i}`, content: '{}' });
    }

    const withTrace = msgs.filter(m => m.reasoning_content);
    assert.strictEqual(withTrace.length, keep, `exactly ${keep} traces survive`);
    assert.match(withTrace[withTrace.length - 1].reasoning_content, new RegExp(`round ${keep + 3}$`),
        'the newest round is one of the survivors');
    assert.strictEqual(msgs[0].reasoning_content, undefined, 'the oldest has been aged out');
});

test('an over-long trace is clipped from the front, keeping the conclusion', () => {
    const LLM = loadTricorderLLM(null);
    LLM.saveSettings({ model: 'qwen3.8-27b', preserveThinking: true });
    const cap = LLM._tiering.PRESERVED_THINKING_CHARS;

    const msgs = [];
    const huge = `${'x'.repeat(cap * 2)}THE CONCLUSION`;
    LLM._tiering.pushAssistantRound(msgs, { role: 'assistant', content: null }, huge);

    const kept = msgs[0].reasoning_content;
    assert.ok(kept.length < huge.length, 'it was clipped');
    assert.match(kept, /THE CONCLUSION$/, 'the tail is what the next round needs');
    assert.match(kept, /trimmed/, 'and the clipping is declared, not silent');
});

test('the trace is stripped before the turn is committed to history', () => {
    // buildMessages() replays conversationHistory verbatim, so a trace left
    // attached here would ride along in every later request for the rest of
    // the session — the exact blowout the round window prevents within a turn.
    const LLM = loadTricorderLLM(null);
    LLM.saveSettings({ model: 'qwen3.8-27b', preserveThinking: true });

    const msgs = [];
    LLM._tiering.pushAssistantRound(msgs, { role: 'assistant', content: 'answer', tool_calls: [{ id: 'c1' }] }, 'scratchpad');
    msgs.push({ role: 'tool', tool_call_id: 'c1', content: '{"ok":true}' });
    msgs.push({ role: 'user', content: '[System: Tool budget nearly exhausted]' });

    const persisted = LLM._tiering.persistableAgentMessages(msgs);
    assert.ok(persisted.every(m => !m.reasoning_content), 'no trace survives into history');
    assert.strictEqual(persisted.length, 2, 'the [System:…] nudge is still dropped');
    assert.strictEqual(persisted[0].content, 'answer', 'the reply itself is intact');
    assert.deepStrictEqual(persisted[0].tool_calls, [{ id: 'c1' }], 'so are its tool calls');
});

test('auxiliary one-shot calls ask for no preserved thinking at all', () => {
    // Compression and follow-up suggestions carry no reasoning of their own and
    // want none replayed. The model's default is ON, so silence would be wrong.
    const LLM = loadTricorderLLM(null);
    LLM.saveSettings({ model: 'qwen3.8-27b' });
    const kwargs = LLM._tiering.noThinkTemplateKwargs();
    assert.strictEqual(kwargs.preserve_thinking, false);
    assert.strictEqual(kwargs.enable_thinking, false);
    assert.strictEqual(kwargs.reasoning_effort, 'low',
        '"none" is not a level Qwen3.8 knows — an unknown one falls back to its deepest');
});
