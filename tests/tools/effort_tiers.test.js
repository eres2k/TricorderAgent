'use strict';

// Guards the v2 effort-tier scheme (js/llm.js): NONE/LOW/MED/MAX mapped
// straight onto LM Studio's reasoning_effort levels, which
// /v1/chat/completions honours natively (tiered values since 0.4.8, "none"
// as the explicit OFF switch since 0.4.19). Covers:
//   - the UI cycle and labels,
//   - the per-tier request wiring (reasoning_effort + enable_thinking),
//   - the one-time migration of saved settings from the old
//     LOW/MED/HIGH/MAX scheme (where LOW+MED meant "thinking off").
// Loads the REAL js/llm.js in a sandbox with browser-global stubs.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const JS_DIR = path.join(__dirname, '..', '..', 'js');

function loadTricorderLLM(savedSettings, fetchImpl) {
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
    const localStorageStub = {
        getItem: (key) => (key === 'tricorder_llm_settings' && savedSettings)
            ? JSON.stringify(savedSettings)
            : null,
        setItem() {},
        removeItem() {},
    };
    const factory = new Function(
        'window', 'localStorage', 'fetch', 'navigator', 'document', 'module',
        bundle
    );
    return factory(windowStub, localStorageStub, fetchImpl || noFetch, { userAgent: 'node-test' }, {}, undefined);
}

test('effort cycle and labels are NONE/LOW/MED/MAX', () => {
    const LLM = loadTricorderLLM(null);
    assert.deepStrictEqual(LLM.EFFORT_CYCLE, ['none', 'low', 'medium', 'max']);
    assert.deepStrictEqual(LLM.EFFORT_LABELS, { none: 'NONE', low: 'LOW', medium: 'MED', max: 'MAX' });
});

test('fresh install defaults to medium and is already scheme v2', () => {
    const LLM = loadTricorderLLM(null);
    assert.strictEqual(LLM.settings.effort, 'medium');
    assert.strictEqual(LLM.settings.effortScheme, 2);
});

test('each tier sends its reasoning_effort and an explicit enable_thinking flag', () => {
    const LLM = loadTricorderLLM(null);
    const T = LLM._tiering;
    const WIRE = { none: 'none', low: 'low', medium: 'medium', max: 'high' };
    for (const tier of LLM.EFFORT_CYCLE) {
        LLM.saveSettings({ effort: tier });
        const body = T.buildRequestBody(false, []);
        assert.strictEqual(body.reasoning_effort, WIRE[tier],
            `tier ${tier} must send reasoning_effort:${WIRE[tier]}`);
        assert.strictEqual(body.chat_template_kwargs?.enable_thinking, tier !== 'none',
            `tier ${tier} must send enable_thinking:${tier !== 'none'}`);
    }
});

test('reasoning_effort is mirrored into the template kwargs, in Qwen vocabulary', () => {
    // LM Studio maps the top-level field natively, but llama.cpp's --jinja path
    // only forwards chat_template_kwargs into the template — so without the
    // mirror every thinking tier renders identically there and MED thinks as
    // deeply as MAX (48,970 reasoning tokens observed on one Qwen3.8 reply).
    //
    // The two must NOT be identical: Qwen3.8 knows low/medium/xhigh only, with
    // xhigh the default, and an unrecognised value falls back to that default —
    // the deepest setting. So "high" has to become "xhigh", and "none" (not a
    // Qwen value at all) has to become "low" so a fallback lands on the least
    // reasoning rather than the most.
    const LLM = loadTricorderLLM(null);
    const T = LLM._tiering;
    const TOP = { none: 'none', low: 'low', medium: 'medium', max: 'high' };
    const QWEN = { none: 'low', low: 'low', medium: 'medium', max: 'xhigh' };
    for (const tier of LLM.EFFORT_CYCLE) {
        LLM.saveSettings({ effort: tier });
        const body = T.buildRequestBody(false, []);
        assert.strictEqual(body.reasoning_effort, TOP[tier],
            `tier ${tier} must send reasoning_effort:${TOP[tier]} at the top level`);
        assert.strictEqual(body.chat_template_kwargs?.reasoning_effort, QWEN[tier],
            `tier ${tier} must send reasoning_effort:${QWEN[tier]} in the template kwargs`);
    }
});

test('no tier ever sends a reasoning_effort Qwen3.8 does not know', () => {
    // An unknown value silently becomes xhigh — maximum reasoning — which is
    // the opposite of what the low tiers are asking for.
    const VALID = new Set(['low', 'medium', 'xhigh']);
    const LLM = loadTricorderLLM(null);
    const T = LLM._tiering;
    for (const tier of LLM.EFFORT_CYCLE) {
        LLM.saveSettings({ effort: tier });
        const sent = T.buildRequestBody(false, []).chat_template_kwargs.reasoning_effort;
        assert.ok(VALID.has(sent), `tier ${tier} sent '${sent}', which falls back to xhigh`);
    }
});

test('MAX asks for xhigh at the top level on models whose deepest level is xhigh', () => {
    // LM Studio validates the top-level reasoning_effort against the levels the
    // LOADED model declares. Qwen3.8/Muse have no "high" at all — their deepest
    // is "xhigh" — so the OpenAI-standard value is a hard 400 and the MAX tier
    // could not complete a single turn. Only "high" moves: "none" is the
    // backend's own thinking-OFF switch, low/medium exist everywhere.
    const LLM = loadTricorderLLM(null);
    const T = LLM._tiering;
    const TOP = { none: 'none', low: 'low', medium: 'medium', max: 'xhigh' };
    for (const model of ['qwen3.8-30b-a3b', 'muse-glimmer-30b']) {
        for (const tier of LLM.EFFORT_CYCLE) {
            LLM.saveSettings({ model, effort: tier });
            assert.strictEqual(T.buildRequestBody(false, []).reasoning_effort, TOP[tier],
                `${model} at tier ${tier} must send reasoning_effort:${TOP[tier]}`);
        }
    }
});

test('models that do know "high" still get it', () => {
    // The xhigh rename is a Qwen3.8/Muse trait, not a universal one — remapping
    // everywhere would ask an OpenAI-vocabulary backend for a level IT does not
    // have, trading one 400 for another.
    const LLM = loadTricorderLLM(null);
    const T = LLM._tiering;
    for (const model of ['llama-3.3-70b', 'gpt-oss-120b', 'some-unknown-model']) {
        LLM.saveSettings({ model, effort: 'max' });
        assert.strictEqual(T.buildRequestBody(false, []).reasoning_effort, 'high',
            `${model} must still send reasoning_effort:high`);
    }
});

test('a refused reasoning_effort is rewritten from the levels the error names', () => {
    // Model ids are free-form, so the family sniff cannot catch every
    // checkpoint. When the backend refuses the value, its error message names
    // what it does accept — 400s are never retried by the transport, so
    // without this the whole turn dies on a fixable request.
    const LLM = loadTricorderLLM(null);
    const { pickEffortFallback, retryWithFallbackEffort } = LLM._tiering;

    // A refused top tier takes the DEEPEST level offered ('high' does not match
    // inside 'xhigh'); a refused low one takes the shallowest, because a
    // fallback must never turn "think less" into "think more".
    const offered = "Invalid 'reasoning_effort': must be one of low, medium, xhigh";
    assert.strictEqual(pickEffortFallback('high', offered), 'xhigh');
    assert.strictEqual(pickEffortFallback('none', offered), 'low');
    // Nothing parseable → the level every reasoning model here knows.
    assert.strictEqual(pickEffortFallback('high', 'reasoning_effort not supported'), 'medium');
    assert.strictEqual(pickEffortFallback('none', 'reasoning_effort not supported'), 'low');

    // Only a 400 that actually blames reasoning_effort is rewritten.
    const body = { model: 'some-local-30b', reasoning_effort: 'high' };
    assert.strictEqual(retryWithFallbackEffort(body, 500, offered), false);
    assert.strictEqual(retryWithFallbackEffort(body, 400, 'context length exceeded'), false);
    assert.strictEqual(body.reasoning_effort, 'high', 'an unrelated failure leaves the body alone');
    assert.strictEqual(retryWithFallbackEffort(body, 400, offered), true);
    assert.strictEqual(body.reasoning_effort, 'xhigh');
});

test('a refusal is remembered, so the next turn does not pay for the 400 again', () => {
    const LLM = loadTricorderLLM(null);
    const T = LLM._tiering;
    LLM.saveSettings({ model: 'some-local-30b', effort: 'max' });
    const first = T.buildRequestBody(false, []);
    assert.strictEqual(first.reasoning_effort, 'high', 'an unknown model starts on the standard value');

    T.retryWithFallbackEffort(first, 400, "reasoning_effort must be one of: low, medium, xhigh");
    assert.strictEqual(T.buildRequestBody(false, []).reasoning_effort, 'xhigh');

    // Scoped to the model that refused it, and to the value it refused.
    LLM.saveSettings({ effort: 'medium' });
    assert.strictEqual(T.buildRequestBody(false, []).reasoning_effort, 'medium');
    LLM.saveSettings({ model: 'other-30b', effort: 'max' });
    assert.strictEqual(T.buildRequestBody(false, []).reasoning_effort, 'high');
});

test('a refused MAX turn is re-sent instead of failing the whole turn', async () => {
    const captured = [];
    const fetchStub = async (url, opts) => {
        if (!String(url).includes('/v1/chat/completions')) {
            return { ok: false, status: 503, headers: { get: () => '' }, json: async () => ({}), text: async () => '' };
        }
        const body = JSON.parse(opts.body);
        captured.push(body.reasoning_effort);
        if (body.reasoning_effort === 'high') {
            return {
                ok: false, status: 400,
                headers: { get: () => 'application/json' },
                json: async () => ({}),
                text: async () => JSON.stringify({
                    error: { message: "Invalid 'reasoning_effort': supported values are low, medium, xhigh" },
                }),
            };
        }
        return {
            ok: true, status: 200,
            headers: { get: () => 'application/json' },
            json: async () => ({ choices: [{ message: { content: 'recovered' } }] }),
            text: async () => '',
        };
    };
    const LLM = loadTricorderLLM(null, fetchStub);
    // Tools off keeps this on the plain single-request path.
    LLM.saveSettings({ model: 'some-local-30b', effort: 'max', internetAccess: false });
    const reply = await LLM.sendMessage('hello');
    assert.strictEqual(reply, 'recovered');
    assert.deepStrictEqual(captured, ['high', 'xhigh'],
        'the refused value is retried once with a level the backend accepts');
});

test('auxiliary one-shot calls turn thinking off in the template kwargs too', async () => {
    const captured = [];
    const fetchStub = async (url, opts) => {
        if (opts && opts.body) captured.push(JSON.parse(opts.body));
        return { ok: false, status: 503, headers: { get: () => '' }, json: async () => ({}), text: async () => '' };
    };
    const LLM = loadTricorderLLM(null, fetchStub);
    await LLM.oneShot('ping');
    assert.ok(captured.length >= 1);
    assert.strictEqual(captured[0].chat_template_kwargs.enable_thinking, false);
    // 'low', not 'none' — the same fallback trap.
    assert.strictEqual(captured[0].chat_template_kwargs.reasoning_effort, 'low');
});

test('max_tokens is clamped to the window the backend actually advertises', () => {
    // llama-server divides -c across its slots, so `-c 65536 -np 2` advertises
    // 32768 per slot. MED and MAX ask for 81920 and 131072 — more than the
    // whole window before a single prompt token — and under
    // --no-context-shift that overflow is a hard failure, not a truncation.
    const LLM = loadTricorderLLM(null);
    const T = LLM._tiering;
    LLM.saveSettings({ contextWindow: 32768 });
    for (const tier of LLM.EFFORT_CYCLE) {
        LLM.saveSettings({ effort: tier });
        const body = T.buildRequestBody(false, []);
        assert.ok(body.max_tokens > 0, `tier ${tier} must still ask for output`);
        assert.ok(body.max_tokens < 32768,
            `tier ${tier} asked for ${body.max_tokens} tokens of a 32768 window`);
    }
});

test('the clamp leaves room for the prompt it was handed', () => {
    const LLM = loadTricorderLLM(null);
    const { clampMaxTokens } = LLM._tiering;
    LLM.saveSettings({ contextWindow: 32768 });
    const small = [{ role: 'user', content: 'x'.repeat(400) }];    // ~100 tokens
    const large = [{ role: 'user', content: 'x'.repeat(40000) }];  // ~10k tokens
    assert.ok(clampMaxTokens(131072, large) < clampMaxTokens(131072, small),
        'a bigger prompt must leave a smaller output budget');
    for (const msgs of [small, large]) {
        const promptTokens = Math.ceil(msgs[0].content.length / 4);
        assert.ok(promptTokens + clampMaxTokens(131072, msgs) <= 32768,
            'prompt + clamped output must fit the window');
    }
});

test('an ask that already fits is passed through untouched', () => {
    const LLM = loadTricorderLLM(null);
    const { clampMaxTokens } = LLM._tiering;
    LLM.saveSettings({ contextWindow: 65536 });
    assert.strictEqual(clampMaxTokens(4096, [{ role: 'user', content: 'hi' }]), 4096);
});

test('an unknown context window leaves the tier budget alone', () => {
    // No manual override and no window reported by the backend: guessing a
    // ceiling here would be worse than deferring to whatever the server does.
    const LLM = loadTricorderLLM(null);
    const { clampMaxTokens } = LLM._tiering;
    LLM.saveSettings({ contextWindow: 0 });
    assert.strictEqual(clampMaxTokens(131072, [{ role: 'user', content: 'hi' }]), 131072);
});

test('an already-overflowing context still asks for a usable reply, not zero', () => {
    // Getting the history back under the limit is auto-compression's job; the
    // clamp must not turn it into a max_tokens of 0 (or a negative one).
    const LLM = loadTricorderLLM(null);
    const { clampMaxTokens } = LLM._tiering;
    LLM.saveSettings({ contextWindow: 8192 });
    const overflowing = [{ role: 'user', content: 'x'.repeat(80000) }]; // ~20k tokens
    assert.strictEqual(clampMaxTokens(131072, overflowing), 1024);
});

test('old-scheme saved settings are remapped order-preserving', () => {
    // Old LOW/MED were the "thinking off" tiers; old HIGH was the default.
    const MIGRATION = { low: 'none', medium: 'low', high: 'medium', max: 'max' };
    for (const [oldTier, newTier] of Object.entries(MIGRATION)) {
        const LLM = loadTricorderLLM({ effort: oldTier });
        assert.strictEqual(LLM.settings.effort, newTier,
            `saved v1 effort '${oldTier}' must migrate to '${newTier}'`);
        assert.strictEqual(LLM.settings.effortScheme, 2);
    }
});

test('already-migrated v2 settings are left untouched', () => {
    // 'low' and 'medium' exist in BOTH schemes — the marker is what prevents
    // a v2 'low' from being remapped again to 'none' on the next load.
    for (const tier of ['none', 'low', 'medium', 'max']) {
        const LLM = loadTricorderLLM({ effort: tier, effortScheme: 2 });
        assert.strictEqual(LLM.settings.effort, tier,
            `v2 effort '${tier}' must survive a reload unchanged`);
    }
});

test('pre-tier installs migrate from the legacy reasoning boolean', () => {
    const on = loadTricorderLLM({ reasoning: true });
    assert.strictEqual(on.settings.effort, 'medium');
    const off = loadTricorderLLM({ reasoning: false });
    assert.strictEqual(off.settings.effort, 'low');
});

test('an unknown saved v1 effort falls back to the default tier', () => {
    const LLM = loadTricorderLLM({ effort: 'turbo' });
    assert.strictEqual(LLM.settings.effort, 'medium');
});

test('Muse models additionally send the reasoning_strength template kwarg', () => {
    // Muse Glimmer's template ignores enable_thinking/reasoning_effort; its
    // knob is chat_template_kwargs.reasoning_strength, and when absent the
    // template defaults to HIGH — so every tier must map onto it explicitly.
    const LLM = loadTricorderLLM(null);
    const T = LLM._tiering;
    LLM.saveSettings({ model: 'muse-glimmer-30b' });
    const STRENGTH = { none: 'low', low: 'low', medium: 'medium', max: 'xhigh' };
    for (const tier of LLM.EFFORT_CYCLE) {
        LLM.saveSettings({ effort: tier });
        const body = T.buildRequestBody(false, []);
        assert.strictEqual(body.chat_template_kwargs?.reasoning_strength, STRENGTH[tier],
            `tier ${tier} must send reasoning_strength:${STRENGTH[tier]} for Muse`);
    }
});

test('non-Muse models do not send reasoning_strength', () => {
    const LLM = loadTricorderLLM(null);
    const T = LLM._tiering;
    for (const model of ['qwen3.6-27b', 'llama-3.3-70b', 'some-unknown-model']) {
        LLM.saveSettings({ model, effort: 'medium' });
        const body = T.buildRequestBody(false, []);
        assert.strictEqual(body.chat_template_kwargs?.reasoning_strength, undefined,
            `${model} must not send reasoning_strength`);
    }
});

test('auxiliary one-shot calls pin Muse to low reasoning strength', async () => {
    // oneShot (compression) and generateFollowUps ask for thinking OFF via
    // reasoning_effort:"none" + enable_thinking:false — both of which Muse
    // ignores, defaulting to HIGH. Its own kwarg must ride along at the
    // 'low' floor (Muse has no off value) so follow-ups stay instant.
    const captured = [];
    const fetchStub = async (url, opts) => {
        if (opts && opts.body) captured.push(JSON.parse(opts.body));
        return { ok: false, status: 503, headers: { get: () => '' }, json: async () => ({}), text: async () => '' };
    };
    const LLM = loadTricorderLLM(null, fetchStub);
    LLM.saveSettings({ model: 'muse-glimmer-30b' });
    await LLM.oneShot('ping');
    await LLM.generateFollowUps('question', 'a reply long enough to qualify for follow-up generation');
    assert.ok(captured.length >= 2, 'both auxiliary requests were sent');
    for (const body of captured) {
        assert.strictEqual(body.reasoning_effort, 'none');
        assert.strictEqual(body.chat_template_kwargs.enable_thinking, false);
        assert.strictEqual(body.chat_template_kwargs.reasoning_strength, 'low',
            'Muse aux calls must pin reasoning_strength to low');
    }
});

test('auxiliary one-shot calls do not send reasoning_strength for other models', async () => {
    const captured = [];
    const fetchStub = async (url, opts) => {
        if (opts && opts.body) captured.push(JSON.parse(opts.body));
        return { ok: false, status: 503, headers: { get: () => '' }, json: async () => ({}), text: async () => '' };
    };
    const LLM = loadTricorderLLM(null, fetchStub);
    LLM.saveSettings({ model: 'qwen3.6-27b' });
    await LLM.oneShot('ping');
    assert.ok(captured.length >= 1);
    assert.strictEqual(captured[0].chat_template_kwargs.reasoning_strength, undefined);
});

test('tool-round budgets scale with effort tier', () => {
    const LLM = loadTricorderLLM(null);
    const A = LLM._agentLoop;
    assert.strictEqual(A.toolRoundCap(A.EFFORT_PROFILES.none), 3);
    assert.strictEqual(A.toolRoundCap(A.EFFORT_PROFILES.low), 6);
    assert.strictEqual(A.toolRoundCap(A.EFFORT_PROFILES.medium), 15);
    assert.strictEqual(A.toolRoundCap(A.EFFORT_PROFILES.max), 15);
    // A profile without a budget falls back to the absolute cap.
    assert.strictEqual(A.toolRoundCap({}), 15);
});

test('identical web lookups repeat from the per-turn cache, not the network', async () => {
    // Stub the blocking tool endpoint; count how many times each call reaches it.
    let executions = 0;
    const fetchStub = async (url, opts) => {
        if (String(url).includes('/api/tools/execute')) {
            const calls = JSON.parse(opts.body).tool_calls;
            executions += calls.length;
            return {
                ok: true, status: 200,
                headers: { get: () => 'application/json' },
                json: async () => ({ results: calls.map(tc => ({ tool_call_id: tc.id, output: `payload for ${tc.id}` })) }),
                text: async () => '',
            };
        }
        return { ok: false, status: 503, headers: { get: () => '' }, json: async () => ({}), text: async () => '' };
    };
    const LLM = loadTricorderLLM(null, fetchStub);
    const guarded = LLM._agentLoop.executeToolCallsGuarded;
    const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

    const cache = new Map();
    const r1 = await guarded([call('a', 'web_fetch', { url: 'https://warnungen.zamg.at/x' })], null, cache);
    assert.strictEqual(executions, 1);
    assert.match(r1[0].content, /payload for a/);

    // Same tool + identical args → served from cache with a stop notice.
    const r2 = await guarded([call('b', 'web_fetch', { url: 'https://warnungen.zamg.at/x' })], null, cache);
    assert.strictEqual(executions, 1, 'no second network execution');
    assert.match(r2[0].content, /REPEAT CALL/);
    assert.match(r2[0].content, /payload for a/);
    assert.strictEqual(r2[0].tool_call_id, 'b');

    // Different args → executes normally.
    await guarded([call('c', 'web_fetch', { url: 'https://warnungen.zamg.at/y' })], null, cache);
    assert.strictEqual(executions, 2);

    // Non-idempotent tools are never cached, even with identical args.
    await guarded([call('d', 'run_command', { command: 'dir' })], null, cache);
    await guarded([call('e', 'run_command', { command: 'dir' })], null, cache);
    assert.strictEqual(executions, 4);
});

test('failed lookups are not cached and stay retryable', async () => {
    let executions = 0;
    const fetchStub = async (url, opts) => {
        if (String(url).includes('/api/tools/execute')) {
            const calls = JSON.parse(opts.body).tool_calls;
            executions += calls.length;
            // First execution fails, the retry succeeds.
            const output = executions === 1
                ? JSON.stringify({ error: 'timeout' })
                : 'real content';
            return {
                ok: true, status: 200,
                headers: { get: () => 'application/json' },
                json: async () => ({ results: calls.map(tc => ({ tool_call_id: tc.id, output })) }),
                text: async () => '',
            };
        }
        return { ok: false, status: 503, headers: { get: () => '' }, json: async () => ({}), text: async () => '' };
    };
    const LLM = loadTricorderLLM(null, fetchStub);
    const guarded = LLM._agentLoop.executeToolCallsGuarded;
    const call = (id) => ({ id, type: 'function', function: { name: 'web_fetch', arguments: '{"url":"https://x"}' } });

    const cache = new Map();
    await guarded([call('a')], null, cache);
    const retry = await guarded([call('b')], null, cache);
    assert.strictEqual(executions, 2, 'the failed call was re-executed');
    assert.match(retry[0].content, /real content/);
    assert.ok(!/REPEAT CALL/.test(retry[0].content));
});
