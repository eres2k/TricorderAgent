#!/usr/bin/env node
/* ============================================
   Setup pipeline — `npm run setup`
   ------------------------------------------------------------------
   The first ten minutes of a local-first agent are the hard part: is a model
   server running, on what port, with what loaded, and does that model actually
   call tools? The browser wizard answers the first three. This answers all
   four, on the host, before you open a tab — and writes down what it found.

   Seven stages, each of which prints what it did and why:

     1  host        Node, memory, and the optional extras (Docker, Chromium, Python)
     2  model       what fits in the memory you have, and the command to run it
     3  backend     probe LM Studio / llama.cpp / Ollama, pick one
     4  capability  a LIVE request: tool calling, thinking depth, vision, context
     5  config      write .env — merged, never clobbered
     6  workspace   create the sandbox the file tools live in
     7  verify      the test suite, when asked

   Modes:
     node scripts/setup.js              interactive where it needs an answer
     node scripts/setup.js --yes        take the best default for everything
     node scripts/setup.js --check      diagnose only, write nothing (the doctor)
     node scripts/setup.js --json       machine-readable report on stdout
     node scripts/setup.js --verify     also run the test suite at the end

   Stage 4 is the one that earns this script's existence. "It chats but never
   uses a tool" is the single most common failure in this project, it is
   invisible until you ask the agent to do something, and it is one HTTP
   request away from being caught here instead.

   Zero dependencies, like the rest of the project.
   ============================================ */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const readline = require('readline');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const backends = require(path.join(ROOT, 'server', 'backends.js'));
const profiles = require(path.join(ROOT, 'server', 'model-profiles.js'));

const GIB = 1024 ** 3;

/* ── Argument parsing ─────────────────────────────────────────────────────── */

const FLAGS = {
    yes: ['--yes', '-y'],
    check: ['--check', '--doctor'],
    json: ['--json'],
    verify: ['--verify'],
    noProbe: ['--no-probe'],
    help: ['--help', '-h'],
};

function parseArgs(argv = []) {
    const opts = { yes: false, check: false, json: false, verify: false, noProbe: false, help: false, url: '', model: '' };
    const unknown = [];
    for (const raw of argv) {
        const arg = String(raw);
        let matched = false;
        for (const [key, aliases] of Object.entries(FLAGS)) {
            if (aliases.includes(arg)) { opts[key] = true; matched = true; break; }
        }
        if (matched) continue;
        const kv = /^--(url|model)=(.*)$/.exec(arg);
        if (kv) { opts[kv[1]] = kv[2]; continue; }
        unknown.push(arg);
    }
    // --json and --check both mean "don't talk to me", so neither may block on
    // a prompt. Same for a non-interactive stdin: a setup script that hangs
    // waiting for input inside a Dockerfile is worse than one that guesses.
    if (opts.json || opts.check || !process.stdin.isTTY) opts.yes = true;
    if (opts.check) opts.verify = false;
    return { ...opts, unknown };
}

/* ── Output ───────────────────────────────────────────────────────────────── */

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const c = {
    dim: (s) => (COLOR ? `\x1b[2m${s}\x1b[0m` : s),
    bold: (s) => (COLOR ? `\x1b[1m${s}\x1b[0m` : s),
    green: (s) => (COLOR ? `\x1b[32m${s}\x1b[0m` : s),
    yellow: (s) => (COLOR ? `\x1b[33m${s}\x1b[0m` : s),
    red: (s) => (COLOR ? `\x1b[31m${s}\x1b[0m` : s),
    cyan: (s) => (COLOR ? `\x1b[36m${s}\x1b[0m` : s),
};

// A findings log rather than a stream of prints: every stage appends, the
// summary reads back, and --json serialises the same objects the humans saw.
function createReport() {
    const findings = [];
    return {
        findings,
        ok:    (stage, msg, extra) => findings.push({ level: 'ok', stage, msg, ...extra }),
        info:  (stage, msg, extra) => findings.push({ level: 'info', stage, msg, ...extra }),
        warn:  (stage, msg, extra) => findings.push({ level: 'warn', stage, msg, ...extra }),
        fail:  (stage, msg, extra) => findings.push({ level: 'fail', stage, msg, ...extra }),
        worst: () => (findings.some((f) => f.level === 'fail') ? 'fail'
                    : findings.some((f) => f.level === 'warn') ? 'warn' : 'ok'),
    };
}

const MARK = { ok: () => c.green('✓'), info: () => c.dim('·'), warn: () => c.yellow('!'), fail: () => c.red('✗') };

function say(level, msg) { console.log(`  ${MARK[level]()} ${msg}`); }
function heading(n, title) { console.log(`\n${c.bold(`${n}. ${title}`)}`); }
function code(block) { console.log(block.split('\n').map((l) => `      ${c.cyan(l)}`).join('\n')); }

/* ── .env handling ────────────────────────────────────────────────────────── */

// Read the values a .env actually SETS. Commented lines are not values —
// .env.example is entirely commented out on purpose, and reading it as
// configuration would make every default look like an explicit choice.
function parseEnvFile(text) {
    const out = new Map();
    for (const line of String(text || '').split('\n')) {
        const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
        if (!m) continue;
        let value = m[2].trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        out.set(m[1], value);
    }
    return out;
}

// Merge a patch into an existing .env WITHOUT losing the file's comments or
// its ordering. Three cases, in priority order:
//   1. the key is already set        → rewrite that line's value in place
//   2. the key exists commented out  → uncomment it with the new value
//   3. the key is absent             → append under a dated section
// Case 2 is what makes `cp .env.example .env` work: the example ships every
// key commented, so the keys are already where they belong, in the right
// section, next to the paragraph explaining them.
function upsertEnv(text, patch, { stamp = null } = {}) {
    const lines = String(text || '').split('\n');
    const pending = new Map(Object.entries(patch));

    for (const [key, value] of Array.from(pending)) {
        const active = lines.findIndex((l) => new RegExp(`^\\s*${key}\\s*=`).test(l));
        if (active !== -1) {
            lines[active] = `${key}=${value}`;
            pending.delete(key);
            continue;
        }
        const commented = lines.findIndex((l) => new RegExp(`^\\s*#\\s*${key}\\s*=`).test(l));
        if (commented !== -1) {
            lines[commented] = `${key}=${value}`;
            pending.delete(key);
        }
    }

    if (pending.size) {
        if (lines.length && lines[lines.length - 1].trim() !== '') lines.push('');
        lines.push(`# ── Written by \`npm run setup\`${stamp ? ` — ${stamp}` : ''} ──`);
        for (const [key, value] of pending) lines.push(`${key}=${value}`);
        lines.push('');
    }

    return lines.join('\n');
}

// Which keys the patch would actually CHANGE. An .env that already says the
// right thing should not be rewritten — a "wrote .env" line the operator did
// not ask for teaches them to distrust this script.
function envDiff(current, patch) {
    const changed = {};
    for (const [key, value] of Object.entries(patch)) {
        if (current.get(key) !== String(value)) changed[key] = String(value);
    }
    return changed;
}

/* ── Host inspection ──────────────────────────────────────────────────────── */

function which(bin) {
    try {
        const cmd = process.platform === 'win32' ? 'where' : 'which';
        const out = execFileSync(cmd, [bin], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
        return String(out).split('\n')[0].trim() || null;
    } catch { return null; }
}

function tryExec(bin, args, timeout = 5000) {
    try {
        return String(execFileSync(bin, args, { stdio: ['ignore', 'pipe', 'ignore'], timeout })).trim();
    } catch { return null; }
}

// Discrete GPU memory, when there is a discrete GPU and a tool that will admit
// to it. Returns null rather than guessing — an unknown VRAM figure falls back
// to system RAM, which is the right budget on unified memory anyway.
function detectVramGiB() {
    const smi = tryExec('nvidia-smi', ['--query-gpu=memory.total', '--format=csv,noheader,nounits']);
    if (smi) {
        const mib = smi.split('\n').map((l) => parseInt(l.trim(), 10)).filter(Number.isFinite);
        if (mib.length) return Math.max(...mib) / 1024;
    }
    const rocm = tryExec('rocm-smi', ['--showmeminfo', 'vram', '--csv']);
    if (rocm) {
        const bytes = rocm.match(/(\d{9,})/g);
        if (bytes) return Math.max(...bytes.map(Number)) / GIB;
    }
    return null;
}

// On Apple Silicon the GPU and the CPU share one pool, so "VRAM" is the wrong
// question — but the OS will not hand all of it to a model either. macOS caps
// GPU-resident working set well below total RAM; the conservative fractions
// below are what actually loads without swapping.
function memoryBudgetGiB({ totalMemBytes = os.totalmem(), vramGiB = null, platform = process.platform, arch = process.arch } = {}) {
    const totalGiB = totalMemBytes / GIB;
    if (vramGiB && vramGiB >= 6) {
        return { budgetGiB: vramGiB, kind: 'vram', totalGiB, note: 'discrete GPU memory' };
    }
    if (platform === 'darwin' && arch === 'arm64') {
        const fraction = totalGiB >= 64 ? 0.75 : 0.65;
        return { budgetGiB: totalGiB * fraction, kind: 'unified', totalGiB, note: 'Apple Silicon unified memory' };
    }
    return { budgetGiB: Math.max(0, totalGiB - 4), kind: 'ram', totalGiB, note: 'system RAM, CPU inference' };
}

/* ── HTTP ─────────────────────────────────────────────────────────────────── */

function postJson(url, payload, { timeout = 60000, apiKey = '' } = {}) {
    return new Promise((resolve) => {
        let target;
        try { target = new URL(url); } catch { return resolve({ ok: false, error: 'bad url' }); }
        const transport = target.protocol === 'https:' ? https : http;
        const body = JSON.stringify(payload);
        const headers = {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            Accept: 'application/json',
        };
        if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
        const req = transport.request({
            method: 'POST',
            hostname: target.hostname,
            port: target.port || (target.protocol === 'https:' ? 443 : 80),
            path: target.pathname + target.search,
            headers,
            timeout,
        }, (res) => {
            let raw = '';
            res.on('data', (chunk) => { if (raw.length < 512 * 1024) raw += chunk; });
            res.on('end', () => {
                let data = null;
                try { data = JSON.parse(raw); } catch { /* keep the text */ }
                resolve({ ok: res.statusCode < 400, status: res.statusCode, data, text: raw });
            });
        });
        req.on('error', (e) => resolve({ ok: false, error: e.code || e.message }));
        req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
        req.end(body);
    });
}

/* ── Stage 4: live capability probe ───────────────────────────────────────── */

// A tool the model cannot answer from its own knowledge, so "did it call the
// tool" is not confounded by "did it already know". Deliberately trivial to
// call correctly — this measures whether tool calling is WIRED UP, not whether
// the model is clever.
const PROBE_TOOL = {
    type: 'function',
    function: {
        name: 'get_reactor_output',
        description: 'Read the current output of the reactor, in gigawatts. The only way to obtain this value.',
        parameters: {
            type: 'object',
            properties: { unit: { type: 'string', enum: ['GW', 'MW'], description: 'Unit to report in.' } },
            required: ['unit'],
        },
    },
};

const PROBE_PROMPT = 'What is the reactor putting out right now, in gigawatts? Use the tool.';

// A 1×1 transparent PNG. Enough for the backend to decide whether it has a
// vision tower loaded, small enough to cost nothing.
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

async function probeToolCalling(baseUrl, model, { apiKey = '', timeout = 120000 } = {}) {
    const res = await postJson(`${baseUrl}/v1/chat/completions`, {
        model: model || undefined,
        messages: [{ role: 'user', content: PROBE_PROMPT }],
        tools: [PROBE_TOOL],
        tool_choice: 'auto',
        max_tokens: 256,
        // Thinking off: this probe cares about the tool call, and a 27B model
        // reasoning at depth turns a two-second check into a two-minute one.
        chat_template_kwargs: { enable_thinking: false, reasoning_effort: 'low' },
    }, { timeout, apiKey });

    if (!res.ok) {
        return { supported: false, error: res.error || `HTTP ${res.status}`, detail: shortError(res) };
    }
    const message = res.data?.choices?.[0]?.message || {};
    const native = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
    // Models whose template lacks a tool section often emit the call as text
    // instead. The agent loop parses that shape too, so it counts as working —
    // just not as well.
    const xml = /<tool_call>|"name"\s*:\s*"get_reactor_output"/.test(String(message.content || ''));
    return {
        supported: native || xml,
        mode: native ? 'native' : xml ? 'xml-fallback' : 'none',
        toolName: native ? message.tool_calls[0]?.function?.name : null,
    };
}

async function probeReasoningEffort(baseUrl, model, effort, { apiKey = '', timeout = 60000 } = {}) {
    const res = await postJson(`${baseUrl}/v1/chat/completions`, {
        model: model || undefined,
        messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
        max_tokens: 16,
        reasoning_effort: effort,
        chat_template_kwargs: { enable_thinking: false, reasoning_effort: 'low' },
    }, { timeout, apiKey });
    // Only a 400 that NAMES the field is a rejection of the field. Anything
    // else failing means the backend is unwell, which is a different finding.
    const rejected = res.status === 400 && /reasoning[_\s-]?effort/i.test(res.text || '');
    return { accepted: res.ok, rejected, error: res.ok ? null : (res.error || `HTTP ${res.status}`) };
}

async function probeVision(baseUrl, model, { apiKey = '', timeout = 60000 } = {}) {
    const res = await postJson(`${baseUrl}/v1/chat/completions`, {
        model: model || undefined,
        messages: [{
            role: 'user',
            content: [
                { type: 'image_url', image_url: { url: TINY_PNG } },
                { type: 'text', text: 'Reply with the single word: ok' },
            ],
        }],
        max_tokens: 16,
        chat_template_kwargs: { enable_thinking: false, reasoning_effort: 'low' },
    }, { timeout, apiKey });
    return { supported: res.ok, error: res.ok ? (res.error || null) : shortError(res) };
}

async function probeEmbeddings(baseUrl, model, { apiKey = '', timeout = 30000 } = {}) {
    const res = await postJson(`${baseUrl}/v1/embeddings`, {
        model: model || undefined,
        input: 'tricorder setup probe',
    }, { timeout, apiKey });
    const dims = res.data?.data?.[0]?.embedding?.length || 0;
    return { supported: res.ok && dims > 0, dims };
}

// What context window is this backend actually serving? Three sources, in
// descending order of how much they can be trusted: llama.cpp's live /props,
// the model catalogue, and finally nothing.
async function probeContextLength(baseUrl, model, { apiKey = '' } = {}) {
    const props = await backends.getJson(`${baseUrl}/props`, { timeout: 3000, headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} });
    const nCtx = props.data?.default_generation_settings?.n_ctx;
    if (Number.isFinite(nCtx) && nCtx > 0) return { contextTokens: nCtx, source: 'props' };

    const models = await backends.getJson(`${baseUrl}/v1/models`, { timeout: 3000, headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} });
    const entries = Array.isArray(models.data?.data) ? models.data.data : [];
    const entry = entries.find((e) => e && e.id === model) || entries[0];
    const catalog = entry && (entry.loaded_context_length || entry.max_context_length || entry.context_length || entry.max_model_len);
    if (Number.isFinite(catalog) && catalog > 0) return { contextTokens: catalog, source: 'catalog' };

    return { contextTokens: 0, source: 'unknown' };
}

function shortError(res) {
    const msg = res.data?.error?.message || res.data?.error || res.text || res.error || '';
    return String(msg).replace(/\s+/g, ' ').slice(0, 200);
}

/* ── Prompting ────────────────────────────────────────────────────────────── */

async function ask(question, fallback, { yes }) {
    if (yes) return fallback;
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
        const answer = (await rl.question(`  ${question} ${c.dim(`[${fallback}]`)} `)).trim();
        return answer || fallback;
    } finally { rl.close(); }
}

async function confirm(question, fallback, opts) {
    const answer = await ask(`${question} (y/n)`, fallback ? 'y' : 'n', opts);
    return /^y/i.test(answer);
}

/* ── The pipeline ─────────────────────────────────────────────────────────── */

async function run(argv) {
    const opts = parseArgs(argv);
    if (opts.help) { usage(); return 0; }

    const report = createReport();
    const out = { mode: opts.check ? 'check' : 'setup', stages: {} };
    const quiet = opts.json;

    if (!quiet) {
        console.log(`\n${c.bold('Tricorder Agent — setup')}`);
        console.log(c.dim(opts.check
            ? 'Diagnosing. Nothing will be written.'
            : `Target model: ${profiles.RECOMMENDED.label}`));
    }

    /* 1 ── Host ---------------------------------------------------------- */
    if (!quiet) heading(1, 'Host');

    const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
    if (nodeMajor >= 21) {
        report.ok('host', `Node ${process.version} — browser tools available`);
    } else if (nodeMajor >= 20) {
        report.warn('host', `Node ${process.version} — fine, but browser_* tools need Node 21+`);
    } else {
        report.fail('host', `Node ${process.version} is too old. This project needs Node 20 or newer.`);
    }

    const vramGiB = detectVramGiB();
    const memory = memoryBudgetGiB({ vramGiB });
    report.info('host', `${memory.totalGiB.toFixed(1)} GB total · ${memory.budgetGiB.toFixed(1)} GB usable for a model (${memory.note})`,
        { budgetGiB: memory.budgetGiB, kind: memory.kind });

    const extras = [
        { bin: 'docker', unlocks: 'code_exec (sandboxed Python/Node/Bash)' },
        { bin: process.platform === 'darwin' ? 'chromium' : 'chromium-browser', unlocks: 'browser_* tools', alt: ['chromium', 'google-chrome', 'chrome'] },
        { bin: 'python3', unlocks: 'code_linter' },
    ];
    for (const extra of extras) {
        const found = [extra.bin, ...(extra.alt || [])].map(which).find(Boolean);
        if (found) report.ok('host', `${extra.bin} → ${extra.unlocks}`);
        else report.info('host', `no ${extra.bin} — ${extra.unlocks} will report that clearly rather than failing oddly`);
    }
    out.stages.host = { node: process.version, platform: `${os.platform()} ${os.arch()}`, ...memory };
    if (!quiet) flush(report, 'host');

    /* 2 ── Model plan ---------------------------------------------------- */
    if (!quiet) heading(2, `Model — ${profiles.RECOMMENDED.label}`);

    const profile = profiles.RECOMMENDED;
    const wantVision = true;
    // Size the context first at the quant we would prefer, then let the quant
    // planner take that context back as a cost. Two passes, because the two
    // numbers trade against each other and a single pass would silently favour
    // whichever was computed first.
    const preferred = profile.quants.find((q) => q.name === 'Q4_K_M');
    const ctxPlan = profiles.planContext(profile, {
        budgetGiB: memory.budgetGiB, quantBytes: preferred.bytes, vision: wantVision,
    });
    const contextTokens = Math.max(ctxPlan.contextTokens, profiles.MIN_USEFUL_CONTEXT);
    const quantPlan = profiles.planQuant(profile, {
        budgetGiB: memory.budgetGiB, contextTokens, vision: wantVision,
    });

    if (quantPlan.fits) {
        report.ok('model', `${quantPlan.quant.name} fits — ${quantPlan.quantGiB} GB of weights, `
            + `${contextTokens.toLocaleString('en-US')} tokens of context, ${quantPlan.totalGiB} GB in total`);
        report.info('model', quantPlan.quant.note);
        if (ctxPlan.contextTokens < profiles.MIN_USEFUL_CONTEXT) {
            report.warn('model', `Only ${ctxPlan.contextTokens.toLocaleString('en-US')} tokens of context fit comfortably. `
                + 'The tool schemas and memory block are a few thousand tokens before you type anything — expect trimming.');
        } else if (!ctxPlan.capped) {
            report.info('model', `Native window is ${profile.contextNative.toLocaleString('en-US')}; `
                + 'this plan is sized to your memory, not to the model.');
        }
    } else {
        report.warn('model', quantPlan.reason);
        report.info('model', `A smaller model from the same line, or ${profile.repos.ollama} on a machine with more memory, `
            + 'is the honest answer here. The agent still runs on anything with tool calling.');
    }
    out.stages.model = { profile: profile.id, contextTokens, quant: quantPlan.quant?.name || null, fits: quantPlan.fits };
    if (!quiet) flush(report, 'model');

    /* 3 ── Backend ------------------------------------------------------- */
    if (!quiet) heading(3, 'Backend');

    const envPath = path.join(ROOT, '.env');
    const envText = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
    const envNow = parseEnvFile(envText);
    const configuredUrl = opts.url || envNow.get('LLM_BASE_URL') || envNow.get('LM_STUDIO_URL') || '';
    const apiKey = envNow.get('LLM_API_KEY') || process.env.LLM_API_KEY || '';

    const found = await backends.discover({ configuredUrl, apiKey, timeout: 3000 });
    const online = found.backends.filter((b) => b.online);

    for (const b of found.backends) {
        if (b.online) report.ok('backend', `${b.label} at ${b.url} — ${b.models.length} model(s), ${b.latencyMs}ms`);
        else report.info('backend', `${b.label} at ${b.url} — not running`);
    }

    let chosen = online.find((b) => b.url === configuredUrl) || online.find((b) => b.models.length) || online[0] || null;

    if (!chosen) {
        report.fail('backend', 'No model server is running.');
        if (!quiet) {
            console.log(`\n  ${c.bold('Start one of these, then run this again:')}`);
            // Nothing fits? Still print a command — with the smallest quant, so
            // the instructions describe the closest thing to a working setup
            // rather than one this machine has already been told it cannot run.
            const showQuant = quantPlan.quant || profile.quants[0];
            for (const b of backends.KNOWN_BACKENDS) {
                console.log(`\n  ${c.bold(b.label)} ${c.dim(b.docs)}`);
                for (const step of profiles.launchPlan(b.id, { profile, contextTokens, quant: showQuant, vision: wantVision, mtp: memory.budgetGiB >= 24 })) {
                    console.log(`    ${step.title}:`);
                    code(step.code);
                    console.log(`      ${c.dim(step.note)}`);
                }
            }
        }
        out.stages.backend = { online: false };
        return finish(report, out, opts, 1);
    }

    if (online.length > 1 && !opts.yes) {
        const pick = await ask(
            `Use which backend? ${online.map((b, i) => `${i + 1}) ${b.label}`).join('  ')}`,
            String(online.indexOf(chosen) + 1), opts);
        chosen = online[parseInt(pick, 10) - 1] || chosen;
    }
    report.ok('backend', `Using ${chosen.label} at ${chosen.url}`);

    /* Model selection, ranked against the profile. */
    const ranked = profiles.rankModels(chosen.models);
    let model = opts.model || envNow.get('LLM_MODEL') || '';
    if (model === 'auto') model = '';
    if (!model) model = ranked.find((r) => r.score > 0)?.id || chosen.models[0] || '';

    if (!chosen.models.length) {
        report.fail('backend', 'The server answered but reports no loaded model. Load one and run this again.');
        out.stages.backend = { online: true, url: chosen.url, models: [] };
        return finish(report, out, opts, 1);
    }

    if (ranked.length > 1 && !opts.yes) {
        console.log(`\n  ${c.bold('Loaded models, best first:')}`);
        ranked.forEach((r, i) => console.log(`    ${i + 1}) ${r.id} ${c.dim(`— ${r.note}`)}`));
        const pick = await ask('Use which model?', String(ranked.findIndex((r) => r.id === model) + 1 || 1), opts);
        model = ranked[parseInt(pick, 10) - 1]?.id || model;
    }

    const verdict = profiles.scoreModel(model);
    if (verdict.tier === 'recommended') report.ok('backend', `Model: ${model} — ${verdict.note}`);
    else if (verdict.score >= 60) report.warn('backend', `Model: ${model} — ${verdict.note}`);
    else report.warn('backend', `Model: ${model} — ${verdict.note} `
        + `Consider ${profile.label}: ${profile.why}`);

    out.stages.backend = { online: true, url: chosen.url, id: chosen.id, model, ranked };
    if (!quiet) flush(report, 'backend');

    /* 4 ── Capabilities -------------------------------------------------- */
    const caps = {};
    if (opts.noProbe) {
        if (!quiet) heading(4, 'Capabilities — skipped (--no-probe)');
    } else {
        if (!quiet) heading(4, 'Capabilities');
        if (!quiet) console.log(c.dim('  Sending real requests. A cold model loads on the first one — this can take a minute.'));

        const ctx = await probeContextLength(chosen.url, model, { apiKey });
        if (ctx.contextTokens) {
            const enough = ctx.contextTokens >= profiles.MIN_USEFUL_CONTEXT;
            report[enough ? 'ok' : 'warn']('capability',
                `Context window: ${ctx.contextTokens.toLocaleString('en-US')} tokens (${ctx.source})`
                + (enough ? '' : ` — below the ${profiles.MIN_USEFUL_CONTEXT.toLocaleString('en-US')} this agent needs to work comfortably`));
            if (enough && verdict.tier === 'recommended' && ctx.contextTokens < profile.contextNative) {
                report.info('capability', `${profile.label} supports ${profile.contextNative.toLocaleString('en-US')}. `
                    + 'Raising it is a launch flag, not a re-download.');
            }
        } else {
            report.info('capability', 'Context window: the backend does not report one. The meter will estimate.');
        }
        caps.context = ctx;

        const tools = await probeToolCalling(chosen.url, model, { apiKey });
        if (tools.mode === 'native') {
            report.ok('capability', `Tool calling: native (the model called ${tools.toolName})`);
        } else if (tools.mode === 'xml-fallback') {
            report.warn('capability', 'Tool calling: the model emitted a tool call as TEXT, not as a structured call. '
                + 'The agent parses that, but it is less reliable. On llama.cpp this is the --jinja symptom.');
        } else if (tools.error) {
            report.fail('capability', `Tool calling: the request failed — ${tools.detail || tools.error}`);
        } else {
            report.fail('capability', 'Tool calling: the model answered without calling the tool. '
                + 'Either it has no tool-calling support, or llama.cpp is running without --jinja. '
                + 'Without this the agent chats but never acts.');
        }
        caps.tools = tools;

        const deepest = (profile.reasoningEfforts || []).slice(-1)[0] || 'high';
        const effort = await probeReasoningEffort(chosen.url, model, deepest, { apiKey });
        if (effort.accepted) report.ok('capability', `Reasoning depth: reasoning_effort="${deepest}" accepted — MAX effort is real`);
        else if (effort.rejected) report.warn('capability', `Reasoning depth: this backend rejects reasoning_effort="${deepest}". `
            + 'The agent falls back automatically, but the top effort tier will not reach full depth.');
        else report.info('capability', `Reasoning depth: could not tell (${effort.error}).`);
        caps.reasoningEffort = effort;

        if (profile.capabilities.vision && verdict.tier === 'recommended') {
            const vision = await probeVision(chosen.url, model, { apiKey });
            if (vision.supported) report.ok('capability', 'Vision: images accepted — no separate vision model needed');
            else report.warn('capability', 'Vision: images rejected. The weights have a vision tower; the backend has not loaded it '
                + '(llama.cpp needs --mmproj). Image turns will fail until it does.');
            caps.vision = vision;
        }

        const embedUrl = envNow.get('EMBEDDING_URL') || chosen.url;
        const embed = await probeEmbeddings(embedUrl, envNow.get('EMBEDDING_MODEL') || '', { apiKey });
        if (embed.supported) report.ok('capability', `Embeddings: ${embed.dims}-dimensional — memory ranks semantically`);
        else report.info('capability', 'Embeddings: none loaded. Memory ranking falls back to BM25, which works fine.');
        caps.embeddings = embed;
    }
    out.stages.capability = caps;
    if (!quiet) flush(report, 'capability');

    /* 5 ── Config -------------------------------------------------------- */
    if (!quiet) heading(5, 'Configuration');

    // The model is pinned by id rather than left on "auto": auto takes whatever
    // the backend lists first, which is a coin flip the moment an embedding
    // model is loaded alongside the chat model.
    const patch = profiles.envDefaults(profile, { backendUrl: chosen.url, modelId: model });
    const changes = envDiff(envNow, patch);

    if (!Object.keys(changes).length) {
        report.ok('config', '.env already says everything this would say');
    } else if (opts.check) {
        report.info('config', `Would set: ${Object.entries(changes).map(([k, v]) => `${k}=${v || '(empty)'}`).join(', ')}`);
    } else {
        const write = await confirm(`Write ${Object.keys(changes).length} setting(s) to .env?`, true, opts);
        if (write) {
            const base = envText || fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
            const next = upsertEnv(base, changes, { stamp: new Date().toISOString().slice(0, 10) });
            fs.writeFileSync(envPath, next);
            report.ok('config', `Wrote .env — ${Object.keys(changes).join(', ')}`);
        } else {
            report.info('config', 'Left .env alone. Settings in the browser override it anyway.');
        }
    }
    out.stages.config = { changes };
    if (!quiet) flush(report, 'config');

    /* 6 ── Workspace ----------------------------------------------------- */
    if (!quiet) heading(6, 'Workspace');

    const wsRaw = envNow.get('TRICORDER_WORKSPACE') || process.env.TRICORDER_WORKSPACE || '~/tricorder-agent-workspace';
    const workspace = wsRaw.replace(/^~(?=$|\/)/, os.homedir());
    const subdirs = ['code', 'data', 'downloads', 'scratch'];
    if (opts.check) {
        report[fs.existsSync(workspace) ? 'ok' : 'info']('workspace',
            fs.existsSync(workspace) ? `${workspace} exists` : `${workspace} would be created on first start`);
    } else {
        try {
            for (const dir of subdirs) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
            report.ok('workspace', `${workspace} — ${subdirs.join(', ')}`);
        } catch (err) {
            report.warn('workspace', `Could not create ${workspace}: ${err.message}. The server retries on start.`);
        }
    }
    out.stages.workspace = { path: workspace };
    if (!quiet) flush(report, 'workspace');

    /* 7 ── Verify -------------------------------------------------------- */
    if (opts.verify) {
        if (!quiet) heading(7, 'Verify');
        try {
            execFileSync(process.execPath, ['--test', 'tests/**/*.test.js'], { cwd: ROOT, stdio: quiet ? 'ignore' : 'inherit' });
            report.ok('verify', 'Test suite passed');
        } catch {
            report.fail('verify', 'Test suite failed. Run `npm test` for the detail.');
        }
        if (!quiet) flush(report, 'verify');
    }

    return finish(report, out, opts, report.worst() === 'fail' ? 1 : 0);
}

// Print the findings for one stage and mark them printed, so a later flush
// does not repeat them.
function flush(report, stage) {
    for (const f of report.findings) {
        if (f.stage !== stage || f._printed) continue;
        f._printed = true;
        say(f.level, f.msg);
    }
}

function finish(report, out, opts, exitCode) {
    out.status = report.worst();
    out.findings = report.findings.map(({ _printed, ...f }) => f);

    if (opts.json) {
        console.log(JSON.stringify(out, null, 2));
        return exitCode;
    }

    const fails = report.findings.filter((f) => f.level === 'fail');
    const warns = report.findings.filter((f) => f.level === 'warn');

    console.log('');
    if (!fails.length && !warns.length) {
        console.log(c.green(c.bold('  Ready.')) + ' Run ' + c.cyan('npm start') + ' and open http://localhost:3000');
    } else if (!fails.length) {
        console.log(c.yellow(c.bold(`  Ready, with ${warns.length} thing(s) worth knowing.`)));
        for (const w of warns) console.log(`    ${c.yellow('!')} ${w.msg}`);
        console.log(`\n  Run ${c.cyan('npm start')} and open http://localhost:3000`);
    } else {
        console.log(c.red(c.bold(`  ${fails.length} problem(s) to fix first:`)));
        for (const f of fails) console.log(`    ${c.red('✗')} ${f.msg}`);
        console.log(`\n  Fix those, then run ${c.cyan('npm run setup')} again.`);
    }
    console.log('');
    return exitCode;
}

function usage() {
    console.log(`
${c.bold('Tricorder Agent setup')}

  node scripts/setup.js [options]

  --yes, -y        Take the best default for every question
  --check          Diagnose only — write nothing (also: --doctor)
  --json           Machine-readable report on stdout
  --verify         Run the test suite as a final stage
  --no-probe       Skip the live capability requests
  --url=URL        Use this backend instead of the detected one
  --model=ID       Use this model instead of the best-ranked one
  --help, -h       This

  Targets ${profiles.RECOMMENDED.label} (${profiles.RECOMMENDED.repos.weights}).
`);
}

if (require.main === module) {
    run(process.argv.slice(2))
        .then((codeOut) => process.exit(codeOut))
        .catch((err) => { console.error(`\n  ${c.red('✗')} setup failed: ${err.stack || err.message}\n`); process.exit(2); });
}

module.exports = {
    parseArgs, parseEnvFile, upsertEnv, envDiff, memoryBudgetGiB,
    probeToolCalling, probeReasoningEffort, probeVision, probeEmbeddings, probeContextLength,
    createReport, run, PROBE_TOOL,
};
