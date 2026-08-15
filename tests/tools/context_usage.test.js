'use strict';

// Guards the context reading that the meter (js/app.js updateSessionTokenDisplay)
// and auto-compression (maybeAutoCompress) both consume.
//
// The bug this file exists for: `used` used to be _sessionPromptTokens — the
// prompt of a request built BEFORE the turn's reply was appended. The reply is
// in the KV cache and lands in the NEXT request's prompt, so the reading was
// stale by a whole exchange. On a thinking model emitting 16k tokens in a turn
// that is the difference between a meter showing 28% and a window that is 77%
// full, and auto-compression tested the same stale number, so it never fired.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const JS_DIR = path.join(__dirname, '..', '..', 'js');

function loadTricorderLLM(savedSettings) {
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
    return factory(windowStub, localStorageStub, noFetch, { userAgent: 'node-test' }, {}, undefined);
}

// Stand in for a backend usage report on the request built from the current
// history. buildStats is the real sink the streaming paths call.
function reportUsage(LLM, promptTokens, completionTokens = 0) {
    LLM._context.buildStats(Date.now(), null, completionTokens, {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
    });
}

test('an empty conversation reports zero context used', () => {
    const LLM = loadTricorderLLM(null);
    LLM.clearHistory();
    assert.strictEqual(LLM.getContextUsage().used, 0);
});

test('the reading tracks history growth after the backend has reported', () => {
    // The regression. Before the fix `used` was pinned to the reported
    // prompt_tokens, so appending the assistant reply — which the next request
    // must carry — moved the meter not at all.
    const LLM = loadTricorderLLM(null);
    LLM.clearHistory();
    LLM.saveSettings({ contextWindow: 32768 });
    LLM.appendMessage('user', 'Frage: ' + 'x'.repeat(2000));
    reportUsage(LLM, 3000);

    const before = LLM.getContextUsage().used;
    assert.ok(before > 0, 'a measured conversation reports a non-zero size');

    // A thinking model's visible reply lands in the history verbatim.
    LLM.appendMessage('assistant', 'y'.repeat(40000)); // ~10k tokens
    const after = LLM.getContextUsage().used;

    assert.ok(after > before + 5000,
        `appending a ~10k-token reply must move the reading (${before} → ${after})`);
});

test('a real usage report drops the estimated flag and calibrates the reading', () => {
    const LLM = loadTricorderLLM(null);
    LLM.clearHistory();
    LLM.appendMessage('user', 'x'.repeat(8000));

    const blind = LLM.getContextUsage();
    assert.strictEqual(blind.estimated, true, 'uncalibrated readings stay marked estimated');

    // Report twice the chars/4 estimate: the calibrated reading must follow the
    // tokenizer, not the char count.
    reportUsage(LLM, blind.used * 2);
    const calibrated = LLM.getContextUsage();
    assert.strictEqual(calibrated.estimated, false);
    assert.ok(calibrated.used > blind.used * 1.5,
        `calibration must scale the reading up (${blind.used} → ${calibrated.used})`);
});

test('an implausible usage report is ignored rather than poisoning the meter', () => {
    const LLM = loadTricorderLLM(null);
    LLM.clearHistory();
    LLM.appendMessage('user', 'x'.repeat(8000));
    const raw = LLM.getContextUsage().used;

    // A backend claiming 1 prompt token for a large history would otherwise
    // pin every later reading near zero and disable auto-compression outright.
    reportUsage(LLM, 1);
    assert.strictEqual(LLM.getContextUsage().used, raw,
        'a ratio outside the sane band must be discarded');
});

test('percent and remaining are derived from the same reading', () => {
    const LLM = loadTricorderLLM(null);
    LLM.clearHistory();
    LLM.saveSettings({ contextWindow: 32768 });
    LLM.appendMessage('user', 'x'.repeat(20000));
    const u = LLM.getContextUsage();
    assert.strictEqual(u.limit, 32768);
    assert.strictEqual(u.percent, Math.min(100, Math.round((u.used / 32768) * 100)));
    assert.strictEqual(u.remaining, Math.max(0, 32768 - u.used));
});

// ── Measured base, estimated remainder ──────────────────────
//
// The reading used to be one multiplication: chars/4 over the whole history,
// scaled by a ratio learned from the last usage report. That makes every token
// on screen a guess — including the thousands the backend had already counted
// exactly — and it puts the ratio's error on the whole conversation instead of
// on the part nobody has counted yet.
//
// With an anchor, the measured prompt size is carried verbatim and only what
// has been APPENDED since is estimated. After a turn that is one reply.

test('the measured prompt size is carried, not re-derived', () => {
    const LLM = loadTricorderLLM(null);
    LLM.clearHistory();
    LLM.appendMessage('user', 'x'.repeat(8000));
    reportUsage(LLM, 4321);

    const r = LLM._context.contextReading();
    assert.strictEqual(r.measured, 4321, 'the backend counted this much');
    assert.strictEqual(r.estimated, 0, 'nothing has been appended since');
    assert.strictEqual(r.used, 4321, 'so the reading is exactly what was measured');
});

test('growth after the measurement is the only part still estimated', () => {
    const LLM = loadTricorderLLM(null);
    LLM.clearHistory();
    LLM.appendMessage('user', 'x'.repeat(8000));
    reportUsage(LLM, 4321);
    LLM.appendMessage('assistant', 'y'.repeat(4000));

    const r = LLM._context.contextReading();
    assert.strictEqual(r.measured, 4321, 'the measured part is untouched by the append');
    assert.ok(r.estimated > 0, 'the appended reply is estimated');
    assert.strictEqual(r.used, r.measured + r.estimated);
    // The estimate covers the reply alone — a ~4000-char message, not the
    // ~12000 chars now in the history.
    assert.ok(r.estimated < 2000, `estimating far more than the reply: ${r.estimated}`);
});

test('the meter reports how much of its number is measured', () => {
    const LLM = loadTricorderLLM(null);
    LLM.clearHistory();
    LLM.saveSettings({ contextWindow: 32768 });
    LLM.appendMessage('user', 'x'.repeat(8000));

    const blind = LLM.getContextUsage();
    assert.strictEqual(blind.measuredTokens, 0);
    assert.strictEqual(blind.estimated, true, 'nothing measured yet');

    reportUsage(LLM, 4321);
    const exact = LLM.getContextUsage();
    assert.strictEqual(exact.measuredTokens, 4321);
    assert.strictEqual(exact.estimatedTokens, 0);
    assert.strictEqual(exact.estimated, false, 'an entirely measured reading is not an estimate');

    LLM.appendMessage('assistant', 'y'.repeat(4000));
    const mixed = LLM.getContextUsage();
    assert.strictEqual(mixed.measuredTokens, 4321);
    assert.ok(mixed.estimatedTokens > 0);
    assert.strictEqual(mixed.estimated, true, 'a partly guessed reading says so');
});

test('a history that is no longer an extension of the measurement drops the anchor', () => {
    // Compression rewrites the history and loading a chat replaces it. Adding
    // growth to a size that described different messages would report a
    // conversation that does not exist — and, since the meter drives
    // auto-compression, would keep re-firing it.
    const LLM = loadTricorderLLM(null);
    LLM.clearHistory();
    LLM.appendMessage('user', 'x'.repeat(20000));
    reportUsage(LLM, 9000);
    assert.strictEqual(LLM._context.contextReading().measured, 9000);

    LLM.setHistory([{ role: 'user', content: 'short' }]);
    const r = LLM._context.contextReading();
    assert.strictEqual(r.measured, 0, 'the previous conversation is not this one');
    assert.ok(r.used < 9000, `a one-line chat must not inherit 9000 tokens (${r.used})`);
});

test('an implausible report leaves neither the ratio nor the anchor behind', () => {
    const LLM = loadTricorderLLM(null);
    LLM.clearHistory();
    LLM.appendMessage('user', 'x'.repeat(8000));
    const raw = LLM.getContextUsage().used;

    reportUsage(LLM, 1);
    const r = LLM._context.contextReading();
    assert.strictEqual(r.measured, 0, 'a rejected ratio must not be anchored either');
    assert.strictEqual(r.used, raw);
});
