/* Model profiles — the provisioning facts, and the arithmetic that turns them
   into a plan.

   These tests exist because the numbers here are the ones a new user acts on
   BEFORE anything is running: which quant to download, how much context to ask
   for, which of the models already loaded is the one to point at. A wrong
   answer costs a 16 GB download and a confusing first hour, and nothing else
   in the project would catch it. */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const profiles = require('../../server/model-profiles.js');

const GIB = 1024 ** 3;

test('the recommended profile is Qwen3.8-27B, with its documented properties', () => {
    const p = profiles.RECOMMENDED;
    assert.strictEqual(p.id, 'qwen3.8-27b');
    assert.strictEqual(p.contextNative, 262144, 'native window is 256K');
    assert.strictEqual(p.contextMax, 1000000, 'extensible to 1M with YaRN');
    assert.ok(p.capabilities.toolCalling, 'tool calling is the one hard requirement');
    assert.ok(p.capabilities.vision, 'natively multimodal — no separate vision model');
    assert.ok(p.capabilities.mtp, 'trained with multi-token-prediction heads');
});

test('reasoning_effort vocabulary is the one the model declares — no "high", no "none"', () => {
    // The vocabulary is not cosmetic: an unrecognised value falls back to the
    // model's DEFAULT, which is the deepest level. Inventing a name here would
    // make "think less" mean "think as hard as possible".
    assert.deepStrictEqual(profiles.RECOMMENDED.reasoningEfforts, ['low', 'medium', 'xhigh']);
    assert.strictEqual(profiles.RECOMMENDED.defaultReasoningEffort, 'xhigh');
    assert.ok(!profiles.RECOMMENDED.reasoningEfforts.includes('high'),
        '"high" is a hard 400 on this model — it must never appear as a level');
});

test('the two sampling sets match the vendor recommendations', () => {
    const { thinking, instruct } = profiles.RECOMMENDED.sampling;
    assert.strictEqual(thinking.temperature, 1.0);
    assert.strictEqual(thinking.top_p, 0.95);
    assert.strictEqual(thinking.presence_penalty, 0.0);
    assert.strictEqual(instruct.temperature, 0.7);
    assert.strictEqual(instruct.top_p, 0.80);
    assert.strictEqual(instruct.presence_penalty, 1.5);
    // Both sets agree on top_k, which is why js/llm.js can send it unconditionally.
    assert.strictEqual(thinking.top_k, instruct.top_k);
});

test('profileFor matches the separators publishers actually use', () => {
    for (const id of ['Qwen3.8-27B', 'qwen3.8-27b', 'qwen/qwen3.8-27b',
                      'Qwen3.8-27B-FP8', 'qwen3.8:27b', 'lmstudio-community/Qwen3.8-27B-GGUF']) {
        assert.strictEqual(profiles.profileFor(id)?.id, 'qwen3.8-27b', `should match ${id}`);
    }
});

test('profileFor does not confuse generations', () => {
    assert.strictEqual(profiles.profileFor('qwen3.6-27b')?.id, 'qwen3.6-27b');
    assert.strictEqual(profiles.profileFor('Qwen3.8-2.4T-A95B')?.id, 'qwen3.8-moe');
    assert.strictEqual(profiles.profileFor('gpt-oss-20b'), null, 'unknown models are null, not guesses');
});

test('scoring puts the recommended model first and non-chat models last', () => {
    const ranked = profiles.rankModels([
        'text-embedding-qwen3-embedding-0.6b',
        'llama-3.1-8b-instruct',
        'qwen3.8-27b',
        'qwen3.6-27b',
    ]);
    assert.strictEqual(ranked[0].id, 'qwen3.8-27b');
    assert.strictEqual(ranked[0].tier, 'recommended');
    assert.strictEqual(ranked[ranked.length - 1].id, 'text-embedding-qwen3-embedding-0.6b');
    assert.strictEqual(ranked[ranked.length - 1].score, 0, 'an embedding model cannot drive the agent loop');
});

test('an embedding model is never picked as the best, even when it is the only Qwen', () => {
    // The failure this prevents: LM Studio with a chat model and nomic-embed
    // loaded lists them in load order, and preselecting the embedding model
    // makes a working install look broken on the first message.
    const ranked = profiles.rankModels(['text-embedding-qwen3-embedding-0.6b', 'mistral-small']);
    assert.strictEqual(ranked[0].id, 'mistral-small');
});

test('unknown models are workable, not rejected', () => {
    const [entry] = profiles.rankModels(['some-new-model-2027']);
    assert.strictEqual(entry.tier, 'unknown');
    assert.ok(entry.score > 0, 'the agent runs on anything with tool calling');
});

test('ties keep the backend\'s own order', () => {
    const ranked = profiles.rankModels(['unknown-a', 'unknown-b', 'unknown-c']);
    assert.deepStrictEqual(ranked.map(r => r.id), ['unknown-a', 'unknown-b', 'unknown-c']);
});

test('planQuant picks the largest quant that fits, and refuses when none does', () => {
    // 24 GB card, a modest context: Q4_K_M (15.9 GB) should fit, Q8_0 must not.
    const plan = profiles.planQuant(profiles.RECOMMENDED, { budgetGiB: 24, contextTokens: 32768 });
    assert.ok(plan.fits);
    assert.ok(plan.quantGiB <= 24 - plan.breakdown.reserveGiB);
    assert.ok(plan.totalGiB <= 24, `total ${plan.totalGiB} must fit the budget`);

    const tooSmall = profiles.planQuant(profiles.RECOMMENDED, { budgetGiB: 6, contextTokens: 32768 });
    assert.strictEqual(tooSmall.fits, false);
    assert.match(tooSmall.reason, /not enough/);
});

test('a bigger context leaves room for a smaller quant', () => {
    // The two trade against each other, and the whole point of the planner is
    // that it says so out loud instead of loading and then thrashing.
    const short = profiles.planQuant(profiles.RECOMMENDED, { budgetGiB: 32, contextTokens: 16384 });
    const long = profiles.planQuant(profiles.RECOMMENDED, { budgetGiB: 32, contextTokens: 262144 });
    assert.ok(short.fits);
    assert.ok(!long.fits || long.quant.bytes < short.quant.bytes,
        'a 256K window costs 16 GB of KV cache — something has to give');
});

test('planContext never exceeds the model\'s native window', () => {
    const q4 = profiles.RECOMMENDED.quants.find(q => q.name === 'Q4_K_M');
    const huge = profiles.planContext(profiles.RECOMMENDED, { budgetGiB: 512, quantBytes: q4.bytes });
    assert.strictEqual(huge.contextTokens, profiles.RECOMMENDED.contextNative);
    assert.strictEqual(huge.capped, true);
});

test('planContext returns zero rather than a negative window when memory is short', () => {
    const q4 = profiles.RECOMMENDED.quants.find(q => q.name === 'Q4_K_M');
    const none = profiles.planContext(profiles.RECOMMENDED, { budgetGiB: 8, quantBytes: q4.bytes });
    assert.strictEqual(none.contextTokens, 0);
});

test('KV cache cost scales linearly and is charged against the budget', () => {
    const p = profiles.RECOMMENDED;
    assert.strictEqual(profiles.kvCacheBytes(p, 0), 0);
    assert.strictEqual(profiles.kvCacheBytes(p, 2) / profiles.kvCacheBytes(p, 1), 2);
    // 64 KiB/token: a 256K window is 16 GiB of cache, which is why it cannot
    // simply be turned on because the model supports it.
    assert.strictEqual(profiles.kvCacheBytes(p, 262144) / GIB, 16);
});

test('launch commands carry the flags without which the agent silently degrades', () => {
    const llama = profiles.launchPlan('llamacpp', { contextTokens: 65536, vision: true, mtp: true });
    const all = llama.map(s => s.code).join('\n');
    assert.match(all, /--jinja/, 'without --jinja the tools parameter is ignored');
    assert.match(all, /-c 65536/, 'the context window must be stated, not defaulted');
    assert.match(all, /mmproj/, 'without the mmproj the vision tower is absent');
    assert.match(all, /draft/, 'the MTP head is the model\'s own speculative decoder');

    const ollama = profiles.launchPlan('ollama', { contextTokens: 65536 });
    assert.match(ollama[0].code, /OLLAMA_CONTEXT_LENGTH=65536/,
        'Ollama defaults to a far shorter window than the model supports');

    assert.deepStrictEqual(profiles.launchPlan('nonesuch', {}), [], 'an unknown runtime gets no instructions');
});

test('env defaults raise the timeout and leave the vision override empty', () => {
    const env = profiles.envDefaults(profiles.RECOMMENDED, { backendUrl: 'http://127.0.0.1:8080', modelId: 'qwen3.8-27b' });
    assert.strictEqual(env.LLM_BASE_URL, 'http://127.0.0.1:8080');
    assert.strictEqual(env.LLM_MODEL, 'qwen3.8-27b');
    assert.ok(parseInt(env.LLM_TIMEOUT_MS, 10) > 120000,
        'a 27B model thinking at xhigh outlives the stock 120s timeout');
    assert.strictEqual(env.LLM_VISION_MODEL, '',
        'routing images to a second model would be strictly worse than the native tower');
});
