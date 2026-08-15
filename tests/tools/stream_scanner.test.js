'use strict';

// Guards the split-safe streaming tag scanner both stream handlers share
// (js/llm.js, createStreamTagScanner): reasoning must NEVER reach the
// visible-reply sink, no matter how it arrives —
//   - <think> tags split across SSE deltas ('<th' + 'ink>'),
//   - a think block the chat template pre-opened (stream carries NO '<think>'
//     opener, only a bare closing '</think>' — the shape that dumped the
//     whole scratchpad into the main output at LOW/MED effort),
//   - inline <tool_call> XML, and leaked stop/control tokens.
// Loads the REAL js/llm.js in a sandbox with browser-global stubs and drives
// the exported _stream hooks.
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
    const factory = new Function(
        'window', 'localStorage', 'fetch', 'navigator', 'document', 'module',
        bundle
    );
    return factory(windowStub, localStorageStub, noFetch, { userAgent: 'node-test' }, {}, undefined);
}

const LLM = loadTricorderLLM();
const S = LLM._stream;

// Collects everything a scanner routed to each sink, mirroring how the
// stream handlers wire it up (visible accumulates into `reply`, and
// implicitThinkClose reclassifies the accumulated reply as thinking).
function makeHarness() {
    const h = {
        visible: '',
        think: '',
        tool: '',
        toolOpens: 0,
        toolCloses: [],
        implicitCloses: 0,
    };
    h.scanner = S.createStreamTagScanner({
        text: (s) => { h.visible += s; },
        think: (s) => { h.think += s; },
        toolOpen: () => { h.toolOpens++; h.tool = ''; },
        toolText: (s) => { h.tool += s; },
        toolClose: (tag, isResponse, wasInTool) => { h.toolCloses.push({ tag, isResponse, wasInTool, buf: h.tool }); h.tool = ''; },
        implicitThinkClose: () => {
            h.implicitCloses++;
            h.think += (h.think ? '\n' : '') + h.visible;
            h.visible = '';
        },
    });
    h.feed = (deltas) => { for (const d of deltas) h.scanner.push(d); h.scanner.flush(); };
    return h;
}

test('llm.js exposes the stream scanner hooks', () => {
    assert.ok(S, '_stream export present');
    assert.strictEqual(typeof S.createStreamTagScanner, 'function');
    assert.strictEqual(typeof S.extractImplicitThink, 'function');
});

test('whole-delta think block routes to the thinking sink, not the reply', () => {
    const h = makeHarness();
    h.feed(['<think>let me reason</think>', 'The answer is 4.']);
    assert.strictEqual(h.visible, 'The answer is 4.');
    assert.strictEqual(h.think, 'let me reason');
});

test('think tags split across deltas never leak reasoning into the reply', () => {
    const h = makeHarness();
    h.feed(['<th', 'ink>step 1: reason ', 'about it</th', 'ink>Answer: 4.']);
    assert.strictEqual(h.visible, 'Answer: 4.');
    assert.strictEqual(h.think, 'step 1: reason about it');
});

test('pre-opened think block (bare </think>, no opener) is reclassified out of the reply', () => {
    // Thinking-locked templates open <think> inside the prompt — the stream
    // starts mid-scratchpad. This was the LOW/MED "reasoning dumped into main
    // output" shape: no opener ever arrives, only the closing tag.
    const h = makeHarness();
    h.feed(['Okay, the user wants X. ', 'Let me plan.', '</think>', 'Here is X.']);
    assert.strictEqual(h.visible, 'Here is X.');
    assert.strictEqual(h.implicitCloses, 1);
    assert.match(h.think, /Let me plan\./);
});

test('bare </think> reclassifies at most once — a later mention cannot wipe the reply', () => {
    const h = makeHarness();
    h.feed(['scratchpad</think>', 'Real answer mentioning ', '</think>', ' literally.']);
    assert.strictEqual(h.implicitCloses, 1);
    assert.strictEqual(h.visible, 'Real answer mentioning  literally.');
});

test('split tool_call tags are buffered for the tool sink, not shown', () => {
    const h = makeHarness();
    h.feed(['before <tool', '_call>{"name":"web_search","arguments":{"query":"x"}}</tool_', 'call> after']);
    assert.strictEqual(h.visible, 'before  after');
    assert.strictEqual(h.toolOpens, 1);
    assert.strictEqual(h.toolCloses.length, 1);
    assert.match(h.toolCloses[0].buf, /web_search/);
    assert.strictEqual(h.toolCloses[0].isResponse, false);
    assert.strictEqual(h.toolCloses[0].wasInTool, true);
});

test('leaked stop/control tokens are swallowed even when split across deltas', () => {
    const h = makeHarness();
    h.feed(['done<|im_', 'end|>']);
    assert.strictEqual(h.visible, 'done');
});

test('flush releases a held partial-tag tail that never became a tag', () => {
    const h = makeHarness();
    h.scanner.push('value is a <thing');
    h.scanner.flush();
    assert.strictEqual(h.visible, 'value is a <thing');
});

test('extractImplicitThink splits a bare pre-opened scratchpad off one-shot replies', () => {
    const r = S.extractImplicitThink('planning here</think>The answer.');
    assert.strictEqual(r.text, 'The answer.');
    assert.strictEqual(r.reasoning, 'planning here');
});

test('extractImplicitThink leaves paired and tag-free replies untouched', () => {
    const paired = S.extractImplicitThink('<think>plan</think>Answer.');
    assert.strictEqual(paired.text, '<think>plan</think>Answer.');
    assert.strictEqual(paired.reasoning, '');
    const plain = S.extractImplicitThink('Just an answer.');
    assert.strictEqual(plain.text, 'Just an answer.');
    assert.strictEqual(plain.reasoning, '');
});

// --- Muse Glimmer channel-marker guard ---
// On a current backend the server splits Muse's channels (to=self →
// reasoning_content, to=user → content) and none of these markers reach the
// client. These tests cover the collapse case (old LM Studio, template-less
// GGUF): the raw channel stream must never dump scratchpad or markers into
// the visible reply.

test('Muse channel stream routes to=self to thinking and to=user to the reply', () => {
    const h = makeHarness();
    h.feed([
        '<|start|>assistant to=self<|message|>The operator wants X. Plan it.<|eom|>',
        '<|start|>assistant to=user<|message|>Here is X.',
        '<|eot|>',
    ]);
    assert.strictEqual(h.visible, 'Here is X.');
    assert.strictEqual(h.think, 'The operator wants X. Plan it.');
});

test('Muse channel markers split across deltas still route correctly', () => {
    const h = makeHarness();
    h.feed([
        '<|sta', 'rt|>assistant to=se', 'lf<|mess', 'age|>reasoning here<|eo', 'm|>',
        '<|start|>assistant to=us', 'er<|message|>Answer.<|e', 'ot|>',
    ]);
    assert.strictEqual(h.visible, 'Answer.');
    assert.strictEqual(h.think, 'reasoning here');
});

test('Muse tool-channel content stays out of the visible reply', () => {
    const h = makeHarness();
    h.feed(['<|start|>assistant to=web_search<|message|>{"query":"x"}<|eom|>after ']);
    // The call payload lands in the thinking panel; text AFTER the
    // terminator is back outside any channel and stays visible.
    assert.strictEqual(h.visible, 'after ');
    assert.match(h.think, /query/);
});

test('a literal <|start|> in prose spills back instead of eating the reply', () => {
    const h = makeHarness();
    // No <|message|> ever arrives — after the 64-char header cap the held
    // text must return to the visible sink.
    const prose = 'the marker <|start|> begins each channel message, and the stream carries on with plenty of explanation afterwards.';
    h.feed([prose]);
    assert.strictEqual(h.visible, prose.replace('<|start|>', ''));
    assert.strictEqual(h.think, '');
});

test('a literal <|start|> just before stream end is released on flush', () => {
    const h = makeHarness();
    h.feed(['markers: <|start|> ends it']);
    assert.strictEqual(h.visible, 'markers:  ends it');
});

test('leaked Muse terminators are swallowed without disturbing text mode', () => {
    const h = makeHarness();
    h.feed(['done<|eom|>', ' and<|eot|> more']);
    assert.strictEqual(h.visible, 'done and more');
});
