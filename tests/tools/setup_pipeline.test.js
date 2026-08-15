/* The setup pipeline — scripts/setup.js.

   Two things are worth locking down here. The first is .env handling: this
   script writes to a file the operator owns, and the one unacceptable outcome
   is losing something they put there. The second is the capability probe,
   which exists to catch "it chats but never uses a tool" — the failure this
   project sees most often and the one that is invisible until you ask the
   agent to actually do something. Both are tested against a stub backend
   rather than mocked, so the request that goes out is the real one. */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const setup = require('../../scripts/setup.js');

/* ── Argument parsing ─────────────────────────────────────────────────────── */

test('flags parse, including their aliases', () => {
    assert.strictEqual(setup.parseArgs(['--check']).check, true);
    assert.strictEqual(setup.parseArgs(['--doctor']).check, true);
    assert.strictEqual(setup.parseArgs(['-y']).yes, true);
    assert.strictEqual(setup.parseArgs(['--url=http://x:1/']).url, 'http://x:1/');
    assert.strictEqual(setup.parseArgs(['--model=qwen3.8-27b']).model, 'qwen3.8-27b');
    assert.deepStrictEqual(setup.parseArgs(['--nonsense']).unknown, ['--nonsense']);
});

test('non-interactive modes never leave a prompt waiting', () => {
    // A setup script that blocks on stdin inside a Dockerfile or a CI step is
    // worse than one that guesses: it hangs until the job times out.
    assert.strictEqual(setup.parseArgs(['--json']).yes, true);
    assert.strictEqual(setup.parseArgs(['--check']).yes, true);
});

test('--check never runs the test suite', () => {
    assert.strictEqual(setup.parseArgs(['--check', '--verify']).verify, false);
});

/* ── .env reading ─────────────────────────────────────────────────────────── */

test('parseEnvFile reads set values and ignores commented ones', () => {
    // .env.example ships entirely commented out on purpose. Reading those as
    // configuration would make every default look like a deliberate choice,
    // and the script would then never offer to change anything.
    const env = setup.parseEnvFile([
        '# LLM_MODEL=commented-out',
        'LLM_BASE_URL=http://127.0.0.1:8080',
        'SITE_PW="quoted value"',
        "LOG_LEVEL='single'",
        'not a line',
        'EMPTY=',
    ].join('\n'));
    assert.strictEqual(env.get('LLM_BASE_URL'), 'http://127.0.0.1:8080');
    assert.strictEqual(env.get('SITE_PW'), 'quoted value');
    assert.strictEqual(env.get('LOG_LEVEL'), 'single');
    assert.strictEqual(env.get('EMPTY'), '');
    assert.strictEqual(env.has('LLM_MODEL'), false);
});

/* ── .env writing ─────────────────────────────────────────────────────────── */

test('upsertEnv rewrites a set key in place, keeping everything around it', () => {
    const before = [
        '# ── The model ──',
        '# Where your server lives.',
        'LLM_BASE_URL=http://127.0.0.1:1234',
        '',
        'SITE_PW=hunter2',
    ].join('\n');
    const after = setup.upsertEnv(before, { LLM_BASE_URL: 'http://127.0.0.1:8080' });

    assert.match(after, /^LLM_BASE_URL=http:\/\/127\.0\.0\.1:8080$/m);
    assert.match(after, /# Where your server lives\./, 'the comment above it survives');
    assert.match(after, /^SITE_PW=hunter2$/m, 'unrelated settings are untouched');
    assert.doesNotMatch(after, /1234/, 'the old value is gone, not duplicated');
});

test('upsertEnv uncomments a key rather than appending a second copy', () => {
    // This is what makes `cp .env.example .env` work: every key is already in
    // the file, commented, in the right section, next to the paragraph that
    // explains it. Appending a duplicate at the bottom would split the file
    // into "the documentation" and "the part that actually applies".
    const before = '# ── The model ──\n#LLM_MODEL=auto\n';
    const after = setup.upsertEnv(before, { LLM_MODEL: 'qwen3.8-27b' });

    assert.match(after, /^LLM_MODEL=qwen3\.8-27b$/m);
    assert.strictEqual(after.match(/LLM_MODEL=/g).length, 1, 'exactly one LLM_MODEL line');
    assert.match(after, /# ── The model ──/, 'it stays in its section');
});

test('upsertEnv appends keys the file has never heard of, under a header', () => {
    const after = setup.upsertEnv('SITE_PW=x\n', { LLM_TIMEOUT_MS: '600000' }, { stamp: '2026-08-15' });
    assert.match(after, /^SITE_PW=x$/m);
    assert.match(after, /Written by `npm run setup` — 2026-08-15/);
    assert.match(after, /^LLM_TIMEOUT_MS=600000$/m);
});

test('upsertEnv on an empty file produces a valid one', () => {
    const after = setup.upsertEnv('', { LLM_MODEL: 'qwen3.8-27b' });
    assert.deepStrictEqual(setup.parseEnvFile(after).get('LLM_MODEL'), 'qwen3.8-27b');
});

test('an active setting wins over a commented one with the same name', () => {
    // Files like this exist: someone commented the example out, then set the
    // value again lower down. The live line is the one that means anything, so
    // it is the one that must be rewritten.
    const before = '#LLM_MODEL=auto\nLLM_MODEL=old-model\n';
    const after = setup.upsertEnv(before, { LLM_MODEL: 'qwen3.8-27b' });
    assert.match(after, /^LLM_MODEL=qwen3\.8-27b$/m);
    assert.match(after, /^#LLM_MODEL=auto$/m, 'the commented line is left as the comment it is');
    assert.doesNotMatch(after, /old-model/);
});

test('envDiff reports only what would actually change', () => {
    const current = setup.parseEnvFile('LLM_MODEL=qwen3.8-27b\nLLM_TIMEOUT_MS=600000\n');
    const diff = setup.envDiff(current, { LLM_MODEL: 'qwen3.8-27b', LLM_TIMEOUT_MS: '600000', LLM_BASE_URL: 'http://x' });
    assert.deepStrictEqual(diff, { LLM_BASE_URL: 'http://x' },
        'an .env that already says the right thing must not be rewritten');
});

/* ── Memory budgeting ─────────────────────────────────────────────────────── */

test('a discrete GPU sets the budget; system RAM does not', () => {
    const plan = setup.memoryBudgetGiB({ totalMemBytes: 64 * 1024 ** 3, vramGiB: 24, platform: 'linux' });
    assert.strictEqual(plan.budgetGiB, 24);
    assert.strictEqual(plan.kind, 'vram');
});

test('Apple Silicon budgets a fraction of unified memory', () => {
    const plan = setup.memoryBudgetGiB({ totalMemBytes: 32 * 1024 ** 3, vramGiB: null, platform: 'darwin', arch: 'arm64' });
    assert.strictEqual(plan.kind, 'unified');
    assert.ok(plan.budgetGiB < 32, 'macOS will not hand the whole pool to a model');
    assert.ok(plan.budgetGiB > 16, 'nor is it as pessimistic as leaving the CPU path\'s reserve');
});

test('CPU inference reserves memory for the rest of the machine', () => {
    const plan = setup.memoryBudgetGiB({ totalMemBytes: 32 * 1024 ** 3, vramGiB: null, platform: 'linux' });
    assert.strictEqual(plan.budgetGiB, 28);
});

test('a tiny GPU is ignored in favour of the CPU path', () => {
    // A 4 GB laptop GPU cannot hold any quant of a 27B model. Budgeting from
    // it would report "nothing fits" on a machine with 64 GB of RAM that runs
    // the model perfectly well, slowly.
    const plan = setup.memoryBudgetGiB({ totalMemBytes: 64 * 1024 ** 3, vramGiB: 4, platform: 'linux' });
    assert.strictEqual(plan.kind, 'ram');
    assert.strictEqual(plan.budgetGiB, 60);
});

/* ── Live capability probe ────────────────────────────────────────────────── */

// A stub OpenAI-compatible backend. `behaviour` decides what it pretends to be.
function stubBackend(behaviour) {
    const seen = [];
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            const body = raw ? JSON.parse(raw) : {};
            seen.push({ path: req.url, body });
            const reply = behaviour(req.url, body);
            res.writeHead(reply.status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(reply.body));
        });
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            resolve({ url: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close() });
        });
    });
}

const chatReply = (message) => ({
    status: 200,
    body: { id: 'stub', object: 'chat.completion', choices: [{ index: 0, message, finish_reason: 'stop' }] },
});

test('a model that calls the tool natively is reported as native', async () => {
    const stub = await stubBackend(() => chatReply({
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_reactor_output', arguments: '{"unit":"GW"}' } }],
    }));
    try {
        const result = await setup.probeToolCalling(stub.url, 'stub-model');
        assert.strictEqual(result.supported, true);
        assert.strictEqual(result.mode, 'native');
        assert.strictEqual(result.toolName, 'get_reactor_output');
    } finally { stub.close(); }
});

test('the probe request carries the tool schema and does not ask for deep thinking', async () => {
    const stub = await stubBackend(() => chatReply({ role: 'assistant', content: 'ok' }));
    try {
        await setup.probeToolCalling(stub.url, 'stub-model');
        const sent = stub.seen[0].body;
        assert.strictEqual(sent.tools[0].function.name, 'get_reactor_output');
        assert.strictEqual(sent.tool_choice, 'auto');
        // A cold 27B model reasoning at its default depth turns a two-second
        // check into a multi-minute one, for an answer thinking cannot change.
        assert.strictEqual(sent.chat_template_kwargs.enable_thinking, false);
        assert.strictEqual(sent.chat_template_kwargs.reasoning_effort, 'low',
            '"none" is not a level Qwen3.8 knows — an unknown one falls back to its deepest');
    } finally { stub.close(); }
});

test('a model that answers without calling the tool is a failure, not a pass', async () => {
    // This is the llama.cpp-without---jinja signature: the request succeeds,
    // the tools parameter is ignored, and the agent becomes a chatbot that
    // describes actions instead of taking them.
    const stub = await stubBackend(() => chatReply({ role: 'assistant', content: 'The reactor is at 1.21 GW.' }));
    try {
        const result = await setup.probeToolCalling(stub.url, 'stub-model');
        assert.strictEqual(result.supported, false);
        assert.strictEqual(result.mode, 'none');
    } finally { stub.close(); }
});

test('a tool call emitted as text counts as working, but is named as the fallback', async () => {
    const stub = await stubBackend(() => chatReply({
        role: 'assistant',
        content: '<tool_call>{"name": "get_reactor_output", "arguments": {"unit": "GW"}}</tool_call>',
    }));
    try {
        const result = await setup.probeToolCalling(stub.url, 'stub-model');
        assert.strictEqual(result.supported, true);
        assert.strictEqual(result.mode, 'xml-fallback');
    } finally { stub.close(); }
});

test('a backend that rejects the deepest reasoning level is distinguished from one that is simply down', async () => {
    const rejecting = await stubBackend(() => ({
        status: 400,
        body: { error: { message: 'Invalid value for reasoning_effort: xhigh. Supported: low, medium' } },
    }));
    try {
        const result = await setup.probeReasoningEffort(rejecting.url, 'stub-model', 'xhigh');
        assert.strictEqual(result.accepted, false);
        assert.strictEqual(result.rejected, true, 'the field was refused by name');
    } finally { rejecting.close(); }

    const broken = await stubBackend(() => ({ status: 500, body: { error: 'out of memory' } }));
    try {
        const result = await setup.probeReasoningEffort(broken.url, 'stub-model', 'xhigh');
        assert.strictEqual(result.accepted, false);
        assert.strictEqual(result.rejected, false, 'a sick backend is a different finding from a refused field');
    } finally { broken.close(); }
});

test('vision is probed with a real image part', async () => {
    const stub = await stubBackend(() => chatReply({ role: 'assistant', content: 'ok' }));
    try {
        const result = await setup.probeVision(stub.url, 'stub-model');
        assert.strictEqual(result.supported, true);
        const parts = stub.seen[0].body.messages[0].content;
        assert.strictEqual(parts[0].type, 'image_url');
        assert.match(parts[0].image_url.url, /^data:image\/png;base64,/);
    } finally { stub.close(); }
});

test('context length prefers llama.cpp\'s live /props over the catalogue', async () => {
    const stub = await stubBackend((path) => {
        if (path === '/props') return { status: 200, body: { default_generation_settings: { n_ctx: 65536 } } };
        return { status: 200, body: { data: [{ id: 'stub-model', context_length: 4096 }] } };
    });
    try {
        const result = await setup.probeContextLength(stub.url, 'stub-model');
        assert.strictEqual(result.contextTokens, 65536);
        assert.strictEqual(result.source, 'props');
    } finally { stub.close(); }
});

test('context length falls back to the catalogue, then admits it does not know', async () => {
    const catalog = await stubBackend((path) => {
        if (path === '/props') return { status: 404, body: { error: 'not found' } };
        return { status: 200, body: { data: [{ id: 'stub-model', loaded_context_length: 32768 }] } };
    });
    try {
        const result = await setup.probeContextLength(catalog.url, 'stub-model');
        assert.strictEqual(result.contextTokens, 32768);
        assert.strictEqual(result.source, 'catalog');
    } finally { catalog.close(); }

    const silent = await stubBackend(() => ({ status: 200, body: { data: [{ id: 'stub-model' }] } }));
    try {
        const result = await setup.probeContextLength(silent.url, 'stub-model');
        assert.strictEqual(result.contextTokens, 0);
        assert.strictEqual(result.source, 'unknown');
    } finally { silent.close(); }
});

test('embeddings absence is reported without inventing dimensions', async () => {
    const stub = await stubBackend(() => ({ status: 404, body: { error: 'no embedding model loaded' } }));
    try {
        const result = await setup.probeEmbeddings(stub.url, '');
        assert.strictEqual(result.supported, false);
        assert.strictEqual(result.dims, 0);
    } finally { stub.close(); }
});

test('a probe against nothing at all resolves rather than throwing', async () => {
    // Every probe has to survive "the port is closed" — that is the normal
    // state during setup, not an exceptional one.
    const result = await setup.probeToolCalling('http://127.0.0.1:1', 'stub-model', { timeout: 1500 });
    assert.strictEqual(result.supported, false);
    assert.ok(result.error, 'the failure is reported, not thrown');
});

/* ── Report ───────────────────────────────────────────────────────────────── */

test('the report\'s verdict is its worst finding', () => {
    const report = setup.createReport();
    report.ok('host', 'fine');
    assert.strictEqual(report.worst(), 'ok');
    report.warn('model', 'tight on memory');
    assert.strictEqual(report.worst(), 'warn');
    report.fail('backend', 'nothing running');
    assert.strictEqual(report.worst(), 'fail');
});
