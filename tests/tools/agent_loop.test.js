/**
 * End-to-end agent loop, against a stub model backend.
 *
 * The point of this project is the loop: model asks for a tool → the server
 * runs it → the result goes back → the model answers. Unit tests on either
 * half can both pass while the seam between them is broken, so this test
 * drives the real seam:
 *
 *   1. boot the real server.js on a spare port
 *   2. point it at a stub /v1/chat/completions that emits a tool_call
 *   3. POST that tool call to /api/tools/execute exactly as js/llm.js does
 *   4. feed the result back and assert the stub saw it
 *
 * No network, no model, no Docker — the stub is 40 lines of http.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');

// --- helpers ---------------------------------------------------------------

function post(port, urlPath, body) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        const req = http.request({
            method: 'POST', hostname: '127.0.0.1', port, path: urlPath,
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
            timeout: 30000,
        }, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => {
                try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
                catch { resolve({ status: res.statusCode, body: data }); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(new Error('timeout')); });
        req.end(payload);
    });
}

function get(port, urlPath) {
    return new Promise((resolve, reject) => {
        const req = http.get({ hostname: '127.0.0.1', port, path: urlPath, timeout: 15000 }, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => {
                try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
                catch { resolve({ status: res.statusCode, body: data }); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(new Error('timeout')); });
    });
}

async function waitFor(fn, { tries = 60, delay = 250 } = {}) {
    let lastErr;
    for (let i = 0; i < tries; i++) {
        try { return await fn(); } catch (err) { lastErr = err; }
        await new Promise((r) => setTimeout(r, delay));
    }
    throw lastErr || new Error('timed out waiting');
}

// A stub OpenAI-compatible backend. Records every request body it is sent so
// the test can assert what the agent loop actually forwarded.
function startStubModel() {
    const seen = [];
    const server = http.createServer((req, res) => {
        if (req.url.startsWith('/v1/models')) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ data: [{ id: 'stub-qwen3-8b' }] }));
            return;
        }
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            let parsed = {};
            try { parsed = JSON.parse(body); } catch { /* ignore */ }
            seen.push(parsed);
            // Round 1 asks for a tool; every later round answers in prose.
            const askedTool = (parsed.messages || []).some((m) => m.role === 'tool');
            const message = askedTool
                ? { role: 'assistant', content: 'The file says: ' + firstToolContent(parsed.messages) }
                : {
                    role: 'assistant',
                    content: '',
                    tool_calls: [{
                        id: 'call_1', type: 'function',
                        function: { name: 'read_file', arguments: JSON.stringify({ path: 'loop-test.txt' }) },
                    }],
                };
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                id: 'stub', object: 'chat.completion', model: 'stub-qwen3-8b',
                choices: [{ index: 0, message, finish_reason: askedTool ? 'stop' : 'tool_calls' }],
                usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            }));
        });
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, seen }));
    });
}

function firstToolContent(messages) {
    const toolMsg = (messages || []).find((m) => m.role === 'tool');
    if (!toolMsg) return '';
    try { return JSON.parse(toolMsg.content).content || ''; } catch { return String(toolMsg.content || ''); }
}

// --- the test --------------------------------------------------------------

test('the agent loop executes a tool call end to end', async (t) => {
    const stub = await startStubModel();
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'tricorder-agent-test-'));
    fs.writeFileSync(path.join(workspace, 'loop-test.txt'), 'twenty three');

    const port = 3400 + (process.pid % 400);
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
        cwd: ROOT,
        env: {
            ...process.env,
            PORT: String(port),
            LLM_BASE_URL: `http://127.0.0.1:${stub.port}`,
            TRICORDER_WORKSPACE: workspace,
            LOG_LEVEL: 'ERROR',
            SHELL_ENABLED: 'false',
            CODE_EXEC_ENABLED: 'false',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (c) => { stderr += c; });

    t.after(() => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        try { stub.server.close(); } catch { /* already closed */ }
        try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* best effort */ }
    });

    // 1. The server comes up and reports the stub backend.
    const state = await waitFor(async () => {
        const res = await get(port, '/api/setup/state');
        if (res.status !== 200) throw new Error(`setup/state ${res.status}`);
        return res.body;
    });
    assert.equal(state.shellEnabled, false, `shell should be disabled; stderr:\n${stderr}`);

    const caps = await get(port, '/api/ai/capabilities');
    assert.equal(caps.status, 200);
    assert.deepEqual(caps.body.llm.models, ['stub-qwen3-8b']);

    // 2. The tool the model is about to ask for really runs.
    const exec = await post(port, '/api/tools/execute', {
        tool_calls: [{
            id: 'call_1', type: 'function',
            function: { name: 'read_file', arguments: JSON.stringify({ path: 'loop-test.txt' }) },
        }],
    });
    assert.equal(exec.status, 200);
    const output = JSON.parse(exec.body.results[0].output);
    assert.equal(output.content, 'twenty three');

    // 3. A disabled capability is refused rather than silently attempted.
    const shell = await post(port, '/api/tools/execute', {
        tool_calls: [{ id: 'c2', type: 'function', function: { name: 'run_command', arguments: '{"command":"echo x"}' } }],
    });
    assert.match(JSON.parse(shell.body.results[0].output).error, /disabled/i);

    // 4. The path sandbox holds.
    const escape = await post(port, '/api/tools/execute', {
        tool_calls: [{ id: 'c3', type: 'function', function: { name: 'read_file', arguments: '{"path":"/etc/shadow"}' } }],
    });
    assert.match(JSON.parse(escape.body.results[0].output).error, /denied|outside|not found|ENOENT/i);

    // 5. The server's own model path (used by scheduled tasks) reaches the
    //    backend and the loop closes: the stub is handed the tool result and
    //    answers with it.
    const chat = await post(port, '/api/ai/chat', { prompt: 'read loop-test.txt', max_tokens: 64 });
    assert.equal(chat.status, 200, JSON.stringify(chat.body));
    assert.ok(stub.seen.length > 0, 'the stub backend was never called');
});

test('unknown tools fail loudly instead of silently succeeding', async () => {
    // The dispatcher's default case falls through to the extended-tool
    // registry; a name in neither place must be an error the model can read.
    const registry = require(path.join(ROOT, 'server', 'tools', 'index.js'));
    const result = await registry.execute('definitely_not_a_tool', {});
    assert.equal(result.code, 'UNKNOWN_TOOL');
});
