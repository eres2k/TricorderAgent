/* ============================================
   Backend detection — LM Studio, llama.cpp, Ollama, anything
   OpenAI-compatible.
   ------------------------------------------------------------------
   Tricorder Agent talks to ONE thing: an OpenAI-compatible
   /v1/chat/completions endpoint. Every supported backend speaks that
   dialect; they differ only in default port, how they report models, and
   which extras (tool calling, /v1/embeddings) they implement.

   This module probes the usual local ports and reports what it found, so
   the first-run setup wizard can say "LM Studio is running on :1234 with
   qwen3-8b loaded" instead of making a new user guess a URL.

   Zero dependencies, no side effects — pure detection.
   ============================================ */

'use strict';

const http = require('http');
const https = require('https');

// Ports we probe on first run, in preference order. `id` is what the setup
// wizard keys its instructions off; `hint` is what we show when nothing is
// listening there.
const KNOWN_BACKENDS = [
    {
        id: 'lmstudio',
        label: 'LM Studio',
        url: 'http://127.0.0.1:1234',
        docs: 'https://lmstudio.ai',
        hint: 'Open LM Studio → Developer tab → Start Server (or run `lms server start`).',
        toolCalling: 'native',
    },
    {
        id: 'llamacpp',
        label: 'llama.cpp (llama-server)',
        url: 'http://127.0.0.1:8080',
        docs: 'https://github.com/ggml-org/llama.cpp',
        hint: 'Run: llama-server -m model.gguf -c 16384 --jinja --port 8080',
        toolCalling: 'jinja',
    },
    {
        id: 'ollama',
        label: 'Ollama',
        url: 'http://127.0.0.1:11434',
        docs: 'https://ollama.com',
        hint: 'Run: ollama serve  (then: ollama pull qwen3:8b)',
        toolCalling: 'native',
    },
];

// GET a JSON document with a hard deadline. Resolves { ok, status, data } and
// never rejects — a probe that fails is an answer, not an error.
function getJson(url, { timeout = 2500, headers = {} } = {}) {
    return new Promise((resolve) => {
        let target;
        try { target = new URL(url); } catch { return resolve({ ok: false, error: 'bad url' }); }
        const transport = target.protocol === 'https:' ? https : http;
        const req = transport.request({
            method: 'GET',
            hostname: target.hostname,
            port: target.port || (target.protocol === 'https:' ? 443 : 80),
            path: target.pathname + target.search,
            headers: { Accept: 'application/json', ...headers },
            timeout,
        }, (res) => {
            let body = '';
            res.on('data', (c) => { if (body.length < 256 * 1024) body += c; });
            res.on('end', () => {
                try { resolve({ ok: res.statusCode < 400, status: res.statusCode, data: JSON.parse(body) }); }
                catch { resolve({ ok: false, status: res.statusCode, error: 'invalid JSON' }); }
            });
        });
        req.on('error', (e) => resolve({ ok: false, error: e.code || e.message }));
        req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
        req.end();
    });
}

// Probe one OpenAI-compatible base URL. Returns the same shape whether or not
// anything answered, so the caller can render a full status table.
async function probe(base, { apiKey = '', timeout = 2500 } = {}) {
    const root = String(base || '').replace(/\/+$/, '');
    const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
    const started = Date.now();
    const res = await getJson(`${root}/v1/models`, { timeout, headers });
    const latencyMs = Date.now() - started;

    if (!res.ok) {
        return { url: root, online: false, error: res.error || `HTTP ${res.status}`, latencyMs, models: [] };
    }
    // LM Studio / llama.cpp / Ollama all answer OpenAI's { data: [{ id }] }.
    const models = Array.isArray(res.data?.data)
        ? res.data.data.map((m) => m && m.id).filter(Boolean)
        : [];
    return { url: root, online: true, latencyMs, models };
}

// Which known backend does this URL correspond to? Used to pick the right
// setup instructions for a URL the user typed in themselves.
function identify(url) {
    const root = String(url || '').replace(/\/+$/, '');
    return KNOWN_BACKENDS.find((b) => b.url === root) || null;
}

// Probe every known backend in parallel plus, when given, whatever URL is
// currently configured. Returns { detected, configured, backends } where
// `detected` is the first online backend — the one the wizard preselects.
async function discover({ configuredUrl = '', apiKey = '', timeout = 2500 } = {}) {
    const targets = KNOWN_BACKENDS.slice();
    const configuredRoot = String(configuredUrl || '').replace(/\/+$/, '');
    if (configuredRoot && !targets.some((t) => t.url === configuredRoot)) {
        targets.unshift({
            id: 'custom', label: 'Configured endpoint', url: configuredRoot,
            docs: '', hint: 'Set LM_STUDIO_URL in .env to change this.', toolCalling: 'native',
        });
    }

    const results = await Promise.all(targets.map(async (t) => {
        const status = await probe(t.url, { apiKey, timeout });
        return { ...t, ...status, configured: t.url === configuredRoot };
    }));

    const detected = results.find((r) => r.online && r.models.length)
        || results.find((r) => r.online)
        || null;

    return {
        detected: detected ? detected.id : null,
        configured: configuredRoot || null,
        backends: results,
    };
}

module.exports = { KNOWN_BACKENDS, probe, discover, identify, getJson };
