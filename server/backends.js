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
   qwen3.8-27b loaded" instead of making a new user guess a URL.

   What it finds is scored against server/model-profiles.js, so "found a
   server" and "found the RIGHT model on it" are two separate answers. A
   backend that is up with an embedding model loaded is not a backend the
   agent can use, and saying so here is cheaper than discovering it three
   tool calls into a conversation.

   Zero dependencies, no side effects — pure detection.
   ============================================ */

'use strict';

const http = require('http');
const https = require('https');
const profiles = require('./model-profiles.js');

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
        hint: 'Run: llama-server -hf ggml-org/Qwen3.8-27B-GGUF:Q4_K_M -c 65536 --jinja --port 8080',
        toolCalling: 'jinja',
    },
    {
        id: 'ollama',
        label: 'Ollama',
        url: 'http://127.0.0.1:11434',
        docs: 'https://ollama.com',
        hint: 'Run: ollama serve  (then: ollama pull qwen3.8:27b)',
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
    // Ranked once, here, so every consumer — the CLI, the browser wizard, the
    // /api/setup routes — presents the same order and the same reasoning
    // instead of each inventing its own idea of "the best one".
    const ranked = profiles.rankModels(models);
    return {
        url: root, online: true, latencyMs, models, ranked,
        best: ranked.find((r) => r.score > 0) || null,
    };
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

    // Prefer a backend that has the recommended model loaded over one that is
    // merely up: with two runtimes running, the wizard should preselect the one
    // that can actually drive the agent.
    const detected = results.find((r) => r.online && r.best && r.best.tier === 'recommended')
        || results.find((r) => r.online && r.models.length)
        || results.find((r) => r.online)
        || null;

    return {
        detected: detected ? detected.id : null,
        configured: configuredRoot || null,
        backends: results,
        // What the setup wizard should be steering people towards, so the copy
        // lives in one place rather than being duplicated in the browser.
        recommended: {
            id: profiles.RECOMMENDED.id,
            label: profiles.RECOMMENDED.label,
            why: profiles.RECOMMENDED.why,
            contextNative: profiles.RECOMMENDED.contextNative,
            repos: profiles.RECOMMENDED.repos,
        },
    };
}

module.exports = { KNOWN_BACKENDS, probe, discover, identify, getJson, profiles };
