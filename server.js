#!/usr/bin/env node
/* ============================================================================
   Tricorder Agent — server
   ----------------------------------------------------------------------------
   A local-first agent runtime. Zero npm dependencies: everything below is
   pure Node.js standard library.

   What this process does:
     1. serves the web app (index.html + js/ + css/)
     2. reverse-proxies /llm/* to your OpenAI-compatible backend
        (LM Studio, llama.cpp, Ollama) so the browser never fights CORS and
        never sees your API key
     3. executes the agent's tool calls (POST /api/tools/execute)
     4. keeps memory, tasks, todos and background agents on disk

   The browser drives the agent loop (js/llm.js); this server is the hands.

   ----------------------------------------------------------------------------
   MAP OF THIS FILE — search for the banner to jump
   ----------------------------------------------------------------------------
     CONFIGURATION            .env loading, ports, feature switches
     LOGGING                  log() and request ids
     AUTH                     optional SITE_PW login + cookie
     REVERSE PROXY            /llm/* → the model backend
     STATIC FILES             the web app itself
     WORKSPACE                the sandboxed directory tools write into
     SYSTEM INFO              CPU/GPU/process/network readouts
     SHELL                    /api/exec — the run_command backend
     HTTP HELPER              httpRequest() with redirects + progress
     WEB                      search / fetch / scrape / fact-check
     STORAGE                  memory, tasks, chat logs, agent state
     BACKGROUND AGENTS        agent_spawn and friends
     SANDBOX + BROWSER        code_exec (Docker) and headless Chromium (CDP)
     TOOL DISPATCHER          POST /api/tools/execute — every tool call
     APP APIS                 memory / files / tasks / notifications endpoints
     MODEL API                /api/ai/* — the model on the wire for other apps
     SCHEDULER                cron-style tasks and reminders
     SETUP                    first-run backend detection
     HTTP SERVER              routing table and boot

   ============================================================================ */

const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const dns = require('dns');
const { Worker } = require('worker_threads');
const { exec, execFile, spawn } = require('child_process');

// Document text extraction (PDF, DOCX, XLSX, PPTX, ZIP…) for the read_document
// and *_archive tools. Pure Node; loaded lazily so a missing file degrades the
// three tools that use it rather than the whole server.
let fileExtractMod;
try { fileExtractMod = require('./file-extract'); } catch { /* optional */ }

// Extended native tools (git, sqlite, dev server, …) live as self-contained
// modules under server/tools/. Each registers an OpenAI-format schema plus an
// execute(), and is dispatched from the tool switch's default case.
let extendedTools;
try { extendedTools = require('./server/tools'); }
catch (e) { console.error('[tools] failed to load server/tools:', e.message); }

// Shared intent index that powers tool_search discovery (the same module the
// browser loads). Maps query synonyms → tool families so the agent can find
// tools it isn't currently carrying. See js/llm-tools/tool-index.js.
let toolIndex;
try { toolIndex = require('./js/llm-tools/tool-index.js'); }
catch (e) { console.error('[tools] failed to load tool-index:', e.message); }

// Durable streaming: makes a model turn survive client disconnects (locked
// phone, network switch, tab switch) and resumable by cursor. The generation is
// owned server-side and persisted; the browser is just a re-attachable listener.
// See server/durable-stream.js. Wired up (forwardChatCompletion + routes) below.
let createDurableManager;
try { ({ createDurableManager } = require('./server/durable-stream')); }
catch (e) { console.error('[durable] failed to load durable-stream:', e.message); }

// Live previews: re-serves the dev_server tool's loopback instances under
// /preview/<port>/ on this origin, so pages the agent writes are reachable
// from a phone or the public domain — behind this server's login, since the
// route sits after handleAuth. See server/preview-proxy.js.
let previewProxy, devServerTool;
try {
    previewProxy = require('./server/preview-proxy');
    devServerTool = require('./server/tools/dev_server');
} catch (e) { console.error('[preview] failed to load preview proxy:', e.message); }

// First-run backend detection (LM Studio / llama.cpp / Ollama). See
// server/backends.js and the /api/setup route.
let backends;
try { backends = require('./server/backends'); }
catch (e) { console.error('[setup] failed to load server/backends:', e.message); }

// Keep-alive agents for persistent connections to the model backend (usually
// the same machine). Avoids TCP handshake overhead on every request. A
// streaming chat holds one socket open for the whole reply, so maxSockets is
// generous enough that concurrent health/model probes never queue behind it.
const httpAgent  = new http.Agent({ keepAlive: true, maxSockets: 32, maxFreeSockets: 8, keepAliveMsecs: 30000, scheduling: 'fifo' });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 32, maxFreeSockets: 8, keepAliveMsecs: 30000, scheduling: 'fifo' });

// --- Load .env file (zero-dependency) ---
(function loadEnv() {
    try {
        const envPath = path.join(__dirname, '.env');
        const content = fs.readFileSync(envPath, 'utf8');
        for (const line of content.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const eqIdx = trimmed.indexOf('=');
            if (eqIdx < 0) continue;
            const key = trimmed.slice(0, eqIdx).trim();
            let value = trimmed.slice(eqIdx + 1).trim();
            if ((value.startsWith('"') && value.endsWith('"')) ||
                (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1);
            }
            if (!(key in process.env)) process.env[key] = value;
        }
    } catch { /* .env file is optional */ }
})();

/* ============================================================================
   CONFIGURATION
   Every knob is an environment variable with a working default, so `node
   server.js` runs with no configuration at all. Copy .env.example to .env to
   change anything — the loader above reads it before this block.
   ============================================================================ */

const PORT = parseInt(process.env.PORT, 10) || 3000;

// Path the browser reaches the model backend through. Everything under it is
// proxied verbatim, so /llm/v1/chat/completions is the backend's own endpoint.
const PROXY_PATH = '/llm';

// Backend LLM endpoint: any OpenAI-compatible server. Point this at the
// server ROOT (no /v1 suffix). Defaults suit LM Studio; for llama.cpp use
// http://127.0.0.1:8080, for Ollama http://127.0.0.1:11434.
// LLM_BASE_URL is the name this project prefers; LM_STUDIO_URL is accepted as
// an alias so existing setups and the LM Studio docs keep working.
const LLM_TARGET = process.env.LLM_BASE_URL || process.env.LM_STUDIO_URL || 'http://127.0.0.1:1234';

// Model id for server-side LLM calls (scheduled tasks, background agents,
// /api/ai/*). "auto" picks the first model the backend reports as loaded, so a
// fresh install works without naming anything. Set LLM_MODEL to pin one —
// e.g. LLM_MODEL=qwen3.8-27b.
const LLM_MODEL = process.env.LLM_MODEL || 'auto';

// Optional separate model for image/vision turns. Many local setups load a
// text-only chat model and a vision model side by side; the default LLM_MODEL
// may not accept images. Falls back to LLM_MODEL when unset.
// Qwen3.8-27B is natively multimodal, so on the recommended setup this stays
// empty on purpose — routing images to a second model would be strictly worse.
const LLM_VISION_MODEL = process.env.LLM_VISION_MODEL || '';

// Per-process secret so the server's own agent loops (scheduled tasks,
// background hand-off) can call internal /api endpoints over loopback without
// the site password.
const INTERNAL_TOKEN = crypto.randomBytes(24).toString('hex');

// Optional bearer for the backend. Most local installs run without auth; when
// set, it is injected server-side and never exposed to the browser.
// LLM_API_KEY is preferred; LM_STUDIO_API_KEY is kept as an alias.
const LM_STUDIO_API_KEY = process.env.LLM_API_KEY || process.env.LM_STUDIO_API_KEY || '';

// Wall-clock budget for non-streaming server-side LLM calls (llmChatRaw). A
// non-streaming completion sends NOTHING until generation finishes, so a long
// reasoning turn can look like a dead socket. Raise this on slower hardware.
const LLM_TIMEOUT_MS = Math.max(1000, parseInt(process.env.LLM_TIMEOUT_MS, 10) || 120000);

// OpenAI-compatible /v1/embeddings host for memory relevance ranking. Defaults
// to the chat backend; load an embedding model there, or point this elsewhere.
const EMBEDDING_URL = (process.env.EMBEDDING_URL || LLM_TARGET).replace(/\/+$/, '');

// Public HTTPS origin this instance is reachable at, when you put it behind a
// tunnel or reverse proxy (e.g. https://agent.example.com). Used to build
// shareable links for dev_server previews.
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');

// --- Browser automation (headless Chromium via CDP) ---
// Auto-detect a Chrome/Chromium binary, or set CHROMIUM_PATH. To use a remote
// Chrome instead of launching one locally, set BROWSER_CDP_URL to its
// http://host:port DevTools endpoint (e.g. browserless). Needs Node >= 21.
const CHROMIUM_PATH = process.env.CHROMIUM_PATH || '';
const BROWSER_CDP_URL = process.env.BROWSER_CDP_URL || '';
const BROWSER_DEBUG_PORT = parseInt(process.env.BROWSER_DEBUG_PORT, 10) || 9222;

// --- Code execution (sandboxed Docker containers) ---
// Requires Docker on the host. When Docker is missing the tool reports that
// clearly instead of failing mysteriously, so leaving this on is safe.
const CODE_EXEC_ENABLED = (process.env.CODE_EXEC_ENABLED || 'true') !== 'false';
const CODE_EXEC_IMAGES = {
    python: process.env.CODE_EXEC_IMAGE_PYTHON || 'python:3.12-slim',
    node: process.env.CODE_EXEC_IMAGE_NODE || 'node:20-slim',
    bash: process.env.CODE_EXEC_IMAGE_BASH || 'alpine:3.20',
};

// --- Auth Configuration ---
// Leave SITE_PW empty for a purely local install (no login screen). Set it
// before exposing this server to a network — it gates the app, the LLM proxy
// and /preview/* alike.
const SITE_PW = process.env.SITE_PW || '';
const AUTH_ENABLED = !!SITE_PW;
const COOKIE_NAME = 'tricorder_agent_auth';
const COOKIE_MAX_AGE = 60 * 60 * 8; // 8 hours

// --- Shell access ---
// run_command / /api/exec spawn processes as the user running this server.
// That is the point of a local agent, but it is also the sharpest edge in the
// project: set SHELL_ENABLED=false to remove the capability entirely.
const SHELL_ENABLED = (process.env.SHELL_ENABLED || 'true') !== 'false';

// --- Logging ---
const LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const LOG_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL?.toUpperCase()] ?? LOG_LEVELS.INFO;
let requestCounter = 0;

function log(level, category, message, data = null) {
    if (LOG_LEVELS[level] < LOG_LEVEL) return;
    const prefix = `[${new Date().toISOString()}] [${level.padEnd(5)}] [${category.padEnd(8)}]`;
    const out = data
        ? `${prefix} ${message} ${JSON.stringify(data)}`
        : `${prefix} ${message}`;
    if (level === 'ERROR') console.error(out);
    else if (level === 'WARN') console.warn(out);
    else console.log(out);
}

function getRequestId() {
    return ++requestCounter;
}

// --- Auth Helpers ---
function sha256(text) {
    return crypto.createHash('sha256').update(text).digest('hex');
}

function getSessionToken() {
    const sessionSecret = SITE_PW || 'tricorder';
    return sha256(sessionSecret + ':tricorder-session');
}

function parseCookies(header) {
    const cookies = {};
    if (!header) return cookies;
    for (const part of header.split(';')) {
        const idx = part.indexOf('=');
        if (idx < 0) continue;
        const name = part.slice(0, idx).trim();
        const value = part.slice(idx + 1).trim();
        if (name) cookies[name] = value;
    }
    return cookies;
}

function sanitizeRedirect(raw) {
    if (!raw || !raw.startsWith('/')) return '/';
    return raw;
}

// Whether the browser reached us over TLS. Behind a tunnel/reverse proxy the
// socket itself is plain HTTP, so the terminating hop's X-Forwarded-Proto is
// the only signal — that's the normal shape for the public domain.
function isHttpsRequest(req) {
    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    if (proto) return proto === 'https';
    return !!req.socket?.encrypted;
}

function authCookieHeader(token, { secure = false } = {}) {
    // Secure only when the session was actually established over HTTPS —
    // setting it unconditionally would lock out plain-HTTP access on the LAN.
    return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}${secure ? '; Secure' : ''}`;
}

function authRedirect(res, location, token, opts) {
    res.writeHead(302, {
        'Location': location,
        'Set-Cookie': authCookieHeader(token, opts),
    });
    res.end();
}

// True only for a request that originated on this machine — not one relayed by
// a local reverse proxy or tunnel. cloudflared and nginx also connect over
// loopback, so the socket address alone cannot tell a browser on the host from
// the entire internet; the forwarding headers are what separate them.
function isDirectLocalRequest(req) {
    const ra = req.socket?.remoteAddress || '';
    const loopback = ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1';
    if (!loopback) return false;
    return !req.headers['x-forwarded-for']
        && !req.headers['x-real-ip']
        && !req.headers['cf-connecting-ip']
        && !req.headers['forwarded'];
}

function parseFormBody(req) {
    return new Promise((resolve) => {
        let data = '';
        req.on('data', chunk => { data += chunk; });
        req.on('end', () => {
            const params = {};
            for (const pair of data.split('&')) {
                const [k, v] = pair.split('=').map(decodeURIComponent);
                if (k) params[k] = v || '';
            }
            resolve(params);
        });
    });
}

function renderLoginPage({ redirect, pwError }) {
    const escapedRedirect = (redirect || '/').replace(/"/g, '&quot;');

    const pwSection = `
      <div class="section-label">ACCESS CODE</div>
      ${pwError ? '<div class="error-msg">&#9888; INVALID ACCESS CODE — ACCESS DENIED</div>' : ''}
      <form method="POST" action="/_auth">
        <input type="hidden" name="redirect" value="${escapedRedirect}" />
        <div class="field">
          <input type="password" name="password" placeholder="••••••••" autocomplete="current-password" autofocus required />
        </div>
        <button type="submit" class="btn-primary">ENGAGE</button>
      </form>`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>TRICORDER — AUTHORIZATION REQUIRED</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #000; color: #ff9900; font-family: 'Courier New', Courier, monospace; min-height: 100dvh; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 1.5rem; }
    .frame { width: 100%; max-width: 480px; border: 3px solid #ff9900; border-radius: 0 0 12px 12px; overflow: hidden; }
    .header { background: #ff9900; color: #000; padding: 0.6rem 1.2rem; display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
    .header-title { font-size: 1rem; font-weight: 700; letter-spacing: 0.18em; text-transform: uppercase; }
    .header-dots { display: flex; gap: 6px; }
    .dot { width: 10px; height: 10px; border-radius: 50%; background: #000; opacity: 0.4; }
    .dot.active { opacity: 1; background: #cc0000; }
    .body { padding: 2rem 1.5rem; display: flex; flex-direction: column; gap: 1.2rem; }
    .info-row { display: flex; justify-content: space-between; font-size: 0.7rem; letter-spacing: 0.12em; color: #cc7700; border-bottom: 1px solid #331a00; padding-bottom: 0.8rem; }
    .section-label { font-size: 0.65rem; letter-spacing: 0.2em; text-transform: uppercase; color: #cc7700; margin-bottom: 0.5rem; }
    .error-msg { background: #1a0000; border: 1px solid #cc0000; color: #ff4444; padding: 0.6rem 0.9rem; font-size: 0.75rem; letter-spacing: 0.08em; border-radius: 4px; margin-bottom: 0.6rem; }
    .field { margin-bottom: 0.8rem; }
    input[type="password"] { width: 100%; background: #0d0d0d; border: 2px solid #ff9900; color: #ff9900; font-family: inherit; font-size: 1rem; letter-spacing: 0.2em; padding: 0.6rem 0.8rem; border-radius: 4px; outline: none; transition: border-color 0.2s; }
    input[type="password"]:focus { border-color: #ffcc44; }
    input[type="password"]::placeholder { color: #553300; letter-spacing: 0.12em; }
    .btn-primary { display: block; width: 100%; background: #ff9900; color: #000; border: none; font-family: inherit; font-size: 0.85rem; font-weight: 700; letter-spacing: 0.2em; text-transform: uppercase; padding: 0.75rem; border-radius: 4px; cursor: pointer; transition: background 0.15s; text-align: center; }
    .btn-primary:hover { background: #ffcc44; }
    .btn-primary:active { background: #cc7700; }
    .footer { background: #ff9900; height: 8px; }
  </style>
</head>
<body>
  <div class="frame">
    <div class="header">
      <span class="header-title">TRICORDER&nbsp;v1.0</span>
      <div class="header-dots"><div class="dot active"></div><div class="dot"></div><div class="dot"></div></div>
    </div>
    <div class="body">
      <div class="info-row"><span>STATUS: RESTRICTED</span><span>CLEARANCE: REQUIRED</span></div>
      ${pwSection}
    </div>
    <div class="footer"></div>
  </div>
</body>
</html>`;
}

// --- Auth Middleware ---
async function handleAuth(req, res, reqId) {
    if (!AUTH_ENABLED) return false;

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const isApiPath = url.pathname.startsWith('/llm') || url.pathname.startsWith('/api/');

    const isPwaAsset =
        url.pathname === '/manifest.webmanifest' ||
        url.pathname === '/manifest.json' ||
        url.pathname === '/sw.js' ||
        url.pathname.startsWith('/icons/');
    if (isPwaAsset) return false;

    // Public webhooks are called by third-party servers (no session cookie):
    // they authenticate via their own verify token, not the site password.
    if (url.pathname.startsWith('/_webhook/')) return false;

    // Internal loopback calls from our own agent loops carry a per-process
    // token (never exposed to the browser) and skip the password gate.
    const ra = req.socket?.remoteAddress || '';
    const isLoopback = ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1';
    if (isLoopback && req.headers['x-internal-token'] === INTERNAL_TOKEN) return false;

    const sessionToken = getSessionToken();
    const cookies = parseCookies(req.headers.cookie);
    const isAuthenticated = cookies[COOKIE_NAME] === sessionToken;

    if (url.pathname === '/_auth/logout') {
        res.writeHead(302, {
            'Location': '/',
            'Set-Cookie': `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
        });
        res.end();
        return true;
    }

    if (req.method === 'POST' && url.pathname === '/_auth') {
        if (!SITE_PW) {
            res.writeHead(404);
            res.end('Not Found');
            return true;
        }
        const form = await parseFormBody(req);
        const submitted = form.password || '';
        const redirect = sanitizeRedirect(form.redirect || '/');
        if (submitted === SITE_PW) {
            authRedirect(res, redirect, sessionToken, { secure: isHttpsRequest(req) });
            log('INFO', 'AUTH', `#${reqId} Password auth successful`);
            return true;
        }
        log('WARN', 'AUTH', `#${reqId} Password auth failed`);
        const html = renderLoginPage({ redirect, pwError: true });
        res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(html);
        return true;
    }

    if (isAuthenticated) return false;

    if (isApiPath) {
        res.writeHead(401, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-LM-Target',
        });
        res.end(JSON.stringify({ error: { message: 'Authentication required', type: 'auth_error' } }));
        return true;
    }

    // Only document navigations should receive the HTML login page. Subresource
    // requests (CSS/JS/images/fetch) must NOT get a 200 text/html body, or the
    // browser reports a MIME mismatch for stylesheets/scripts and the service
    // worker caches the login HTML as that asset. For those, return a 401.
    const secFetchDest = (req.headers['sec-fetch-dest'] || '').toLowerCase();
    const secFetchMode = (req.headers['sec-fetch-mode'] || '').toLowerCase();
    const accept = req.headers['accept'] || '';
    const isNavigation = secFetchDest
        ? (secFetchDest === 'document' || secFetchMode === 'navigate')
        : accept.includes('text/html');

    if (!isNavigation) {
        res.writeHead(401, {
            'Content-Type': 'text/plain',
            'Cache-Control': 'no-store',
        });
        res.end('Authentication required');
        return true;
    }

    const redirectAfter = sanitizeRedirect(url.pathname + url.search);
    const html = renderLoginPage({ redirect: redirectAfter });
    // no-store so a CDN/Cloudflare never caches the login page (e.g. against an
    // asset URL), which would poison the edge cache with an HTML body.
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
    return true;
}

// --- MIME types ---
const MIME = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.webp': 'image/webp',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.ttf': 'font/ttf',
    '.webmanifest': 'application/manifest+json',
};

// --- Reverse Proxy ---
function proxyRequest(clientReq, clientRes, targetUrl, reqId) {
    const startTime = Date.now();
    const url = new URL(targetUrl);
    const transport = url.protocol === 'https:' ? https : http;

    log('INFO', 'PROXY', `#${reqId} Forwarding ${clientReq.method} → ${targetUrl}`);

    const options = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + (url.search || ''),
        method: clientReq.method,
        headers: { ...clientReq.headers, host: url.host },
        // Socket-INACTIVITY timeout, not a total deadline. Must outlast the
        // longest legitimate silent gap: backends that buffer tool-call
        // arguments (LM Studio) send zero bytes while generating them, so 5
        // minutes killed healthy big file-writes. The client's tool-aware
        // stall watchdog provides the tighter liveness bound.
        timeout: 600000,
        agent: url.protocol === 'https:' ? httpsAgent : httpAgent,
    };

    // Remove browser-specific headers that cause issues
    delete options.headers['origin'];
    delete options.headers['referer'];
    delete options.headers['x-lm-target'];
    // Force identity encoding for the upstream request. Merely deleting the
    // header lets some backends/middleboxes default to gzip anyway, and a
    // compressed SSE body is doubly bad: the browser must buffer-then-inflate
    // (killing token-by-token streaming), and when it arrives truncated or
    // oddly chunked the fetch body reader rejects with the opaque browser error
    // "Error in input stream". Asking explicitly for identity avoids both.
    options.headers['accept-encoding'] = 'identity';

    // Inject the LM Studio API key (server-side secret, never exposed to the
    // client). Drop any client-sent Authorization first so it can't leak.
    delete options.headers['authorization'];
    if (LM_STUDIO_API_KEY) options.headers['authorization'] = `Bearer ${LM_STUDIO_API_KEY}`;

    // Inspect the request body for logging ONLY when DEBUG is active. Buffering the
    // full body (vision calls carry multi-MB base64 images) just to log a one-line
    // summary wastes CPU/memory and would delay forwarding, so we cap what we capture
    // and never touch it at higher log levels. The real body is streamed straight
    // through via clientReq.pipe(proxyReq) below — this never consumes it.
    if (LOG_LEVEL <= LOG_LEVELS.DEBUG) {
        const bodyChunks = [];
        let bodyBytes = 0;
        const BODY_LOG_CAP = 64 * 1024; // enough to see params; never the whole image
        clientReq.on('data', (chunk) => {
            if (bodyBytes < BODY_LOG_CAP) { bodyChunks.push(chunk); bodyBytes += chunk.length; }
        });
        clientReq.on('end', () => {
            if (!bodyChunks.length) return;
            const raw = Buffer.concat(bodyChunks).toString('utf8');
            try {
                const parsed = JSON.parse(raw);
                log('DEBUG', 'PROXY', `#${reqId} Request body`, {
                    model: parsed.model,
                    stream: parsed.stream,
                    temperature: parsed.temperature,
                    max_tokens: parsed.max_tokens,
                    messages: parsed.messages?.length ?? 0,
                    has_images: parsed.messages?.some(m => Array.isArray(m.content)) ?? false,
                });
            } catch {
                log('DEBUG', 'PROXY', `#${reqId} Request body (raw, ${bodyBytes}+ bytes, capped)`);
            }
        });
    }

    // Tracks the browser hanging up before the reply is finished (tab closed,
    // navigation, network drop) — typically while an agent is mid-stream. Once
    // true, we stop touching clientRes and tear the upstream request down.
    let clientGone = false;

    const proxyReq = transport.request(options, (proxyRes) => {
        const elapsed = Date.now() - startTime;
        const contentType = proxyRes.headers['content-type'] || '';
        const transferEncoding = (proxyRes.headers['transfer-encoding'] || '').toLowerCase();
        const isSSE = contentType.includes('text/event-stream')
            || (transferEncoding.includes('chunked') && !proxyRes.headers['content-length']);

        log('INFO', 'PROXY', `#${reqId} Response ${proxyRes.statusCode} (${elapsed}ms)${isSSE ? ' [SSE]' : ''}`, {
            statusCode: proxyRes.statusCode,
            contentType,
        });

        let responseSize = 0;
        proxyRes.on('data', (chunk) => { responseSize += chunk.length; });
        proxyRes.on('end', () => {
            const totalElapsed = Date.now() - startTime;
            log('INFO', 'PROXY', `#${reqId} Completed (${totalElapsed}ms, ${responseSize} bytes)`);
        });

        const responseHeaders = {
            ...proxyRes.headers,
            'access-control-allow-origin': '*',
            'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'access-control-allow-headers': 'Content-Type, Authorization, X-LM-Target',
        };

        if (isSSE) {
            responseHeaders['cache-control'] = 'no-cache, no-transform';
            responseHeaders['x-accel-buffering'] = 'no';
            delete responseHeaders['content-length'];
            clientRes.socket?.setNoDelay(true);
        }

        clientRes.writeHead(proxyRes.statusCode, responseHeaders);

        if (isSSE) {
            // Stream tokens straight through, but honor backpressure: if the
            // browser (or a downstream tunnel) is slow to drain, pause the
            // upstream read instead of buffering the whole reply in memory.
            proxyRes.on('data', (chunk) => {
                // The browser may have closed mid-stream. Writing to a dead
                // socket emits an 'error' that — with no listener — escalates to
                // uncaughtException and exits the process. Stop and tear the
                // upstream generation down the moment the client is gone.
                if (clientGone || clientRes.destroyed) { proxyReq.destroy(); return; }
                if (clientRes.write(chunk) === false) {
                    proxyRes.pause();
                    clientRes.once('drain', () => proxyRes.resume());
                }
            });
            proxyRes.on('end', () => { try { clientRes.end(); } catch {} });
        } else {
            proxyRes.pipe(clientRes, { end: true });
        }
    });

    // Disable Nagle on the upstream socket so the request reaches the backend
    // without a coalescing delay and SSE tokens flow back the instant they're produced.
    proxyReq.on('socket', (socket) => socket.setNoDelay(true));

    proxyReq.on('error', (err) => {
        // We aborted the upstream ourselves because the client vanished — that's
        // an expected teardown, not a reachability failure. Don't log it as an
        // error and don't try to answer a socket that's already gone.
        if (clientGone) return;
        const elapsed = Date.now() - startTime;
        log('ERROR', 'PROXY', `#${reqId} Connection error after ${elapsed}ms: ${err.message}`, {
            target: targetUrl,
            code: err.code,
        });
        // If we've already started streaming the response (SSE), the status line
        // is long gone — writing a new header here throws ERR_HTTP_HEADERS_SENT
        // and crashes the process. Just close the half-sent response instead.
        if (clientRes.headersSent) { try { clientRes.end(); } catch {} return; }
        clientRes.writeHead(502, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-LM-Target',
        });
        clientRes.end(JSON.stringify({
            error: {
                message: `Cannot reach LM Studio at ${LLM_TARGET}. Is it running?`,
                type: 'proxy_error',
                details: err.message,
            }
        }));
    });

    proxyReq.on('timeout', () => {
        const elapsed = Date.now() - startTime;
        log('ERROR', 'PROXY', `#${reqId} Timeout after ${elapsed}ms`, { target: targetUrl });
        proxyReq.destroy();
        // Same guard as the error handler: a timeout can fire mid-stream, after
        // the response headers (and tokens) have already gone out.
        if (clientRes.headersSent) { try { clientRes.end(); } catch {} return; }
        clientRes.writeHead(504, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-LM-Target',
        });
        clientRes.end(JSON.stringify({
            error: { message: 'LM Studio request timed out', type: 'timeout' }
        }));
    });

    // Detect the browser hanging up. 'close' fires on the response for both a
    // clean finish and a premature disconnect; writableFinished tells them
    // apart. On a premature close (agent still streaming) we abort the upstream
    // so the LLM stops generating into a dead socket instead of running to
    // completion and burning GPU after the user has already left.
    const onClientClose = () => {
        if (clientGone || clientRes.writableFinished) return;
        clientGone = true;
        log('INFO', 'PROXY', `#${reqId} Client disconnected mid-response — aborting upstream`);
        try { proxyReq.destroy(); } catch { /* already torn down */ }
    };
    clientRes.on('close', onClientClose);
    // A write that loses the race against the socket closing surfaces here as
    // EPIPE/ECONNRESET. Catching it keeps a routine disconnect from reaching the
    // process-level uncaughtException handler (which exits the whole server).
    clientRes.on('error', (err) => {
        clientGone = true;
        log('DEBUG', 'PROXY', `#${reqId} Client response stream error: ${err.message}`, { code: err.code });
        try { proxyReq.destroy(); } catch { /* already torn down */ }
    });

    clientReq.pipe(proxyReq, { end: true });
}

// --- Static File Server ---
function serveStatic(req, res) {
    let filePath = path.join(__dirname, req.url === '/' ? '/index.html' : req.url);

    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(__dirname))) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME[ext] || 'application/octet-stream';

    const noCachePaths = ['/', '/index.html', '/sw.js', '/manifest.webmanifest'];
    const noCacheExts = ['.html', '.js', '.css'];
    const noCache = noCachePaths.includes(req.url) || noCacheExts.includes(ext);
    const cacheHeaders = noCache
        ? { 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache', 'Expires': '0' }
        : {};

    fs.readFile(filePath, (err, data) => {
        if (err) {
            if (err.code === 'ENOENT') {
                // SPA fallback to index.html is only valid for navigation routes
                // (extensionless paths). A missing asset with a real extension
                // (.css/.js/.png/…) must return a genuine 404 — never an HTML 200,
                // otherwise the browser sees a MIME mismatch ("text/html" for a
                // stylesheet / "got '<'" for a script) and the service worker
                // would cache the HTML body as that asset.
                if (ext) {
                    res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
                    res.end('Not Found');
                    return;
                }
                fs.readFile(path.join(__dirname, 'index.html'), (err2, indexData) => {
                    if (err2) { res.writeHead(500); res.end('Internal server error'); return; }
                    res.writeHead(200, { 'Content-Type': 'text/html', ...cacheHeaders });
                    res.end(indexData);
                });
            } else {
                res.writeHead(500);
                res.end('Internal server error');
            }
            return;
        }
        res.writeHead(200, { 'Content-Type': contentType, ...cacheHeaders });
        res.end(data);
    });
}

// --- Server Management API ---
function readJsonBody(req) {
    return new Promise((resolve) => {
        let data = '';
        req.on('data', chunk => { data += chunk; });
        req.on('end', () => {
            try { resolve(data ? JSON.parse(data) : {}); }
            catch { resolve({}); }
        });
    });
}

function jsonRes(res, status, data) {
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(data));
}

const IS_WINDOWS = os.platform() === 'win32';

// --- LLM Agent Workspace ---
// Dedicated directory for LLM agent file operations (code gen, downloads, scratch)
const WORKSPACE_DIR = process.env.TRICORDER_WORKSPACE || path.join(os.homedir(), 'tricorder-agent-workspace');

/* ============================================================================
   FILE SANDBOX
   ----------------------------------------------------------------------------
   Every file the agent touches goes through sanitizePath(), which resolves the
   path and refuses anything outside ALLOWED_ROOTS. The default is deliberately
   narrow — the workspace and the temp directory — because an agent that can
   read your whole home directory can read your SSH keys, your browser
   profile, and every .env you own.

   Widen it when you actually need to: set ALLOWED_PATHS to a list of extra
   roots (`:`-separated on Unix, `;` on Windows), e.g.

       ALLOWED_PATHS=/home/me/projects:/home/me/notes

   or ALLOW_HOME=true to grant the whole home directory the way earlier
   versions did. Even then, DENIED_PATTERNS below still applies: credential
   stores stay off limits inside an allowed root, because "the agent may work
   in my projects folder" is never meant to include "…and may read the AWS
   keys that happen to live under it".
   ============================================================================ */

const HOME_DIR = os.homedir();

// Extra roots from the environment. Empty entries and relative paths are
// dropped rather than silently resolved against the server's cwd.
const EXTRA_ROOTS = (process.env.ALLOWED_PATHS || '')
    .split(IS_WINDOWS ? ';' : ':')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => (p.startsWith('~') ? path.join(HOME_DIR, p.slice(1)) : p))
    .filter((p) => path.isAbsolute(p))
    .map((p) => path.resolve(p));

const ALLOW_HOME = process.env.ALLOW_HOME === 'true';

const ALLOWED_ROOTS = [
    path.resolve(WORKSPACE_DIR),
    path.resolve(os.tmpdir()),
    ...EXTRA_ROOTS,
    ...(ALLOW_HOME ? [HOME_DIR] : []),
];

// Off limits even inside an allowed root. These are the paths where a single
// successful read is a credential leak, so they are checked against the
// resolved path rather than trusted to be outside the sandbox.
const DENIED_PATTERNS = [
    /(^|[\\/])\.ssh([\\/]|$)/i,
    /(^|[\\/])\.gnupg([\\/]|$)/i,
    /(^|[\\/])\.aws([\\/]|$)/i,
    /(^|[\\/])\.kube([\\/]|$)/i,
    /(^|[\\/])\.docker([\\/])config\.json$/i,
    /(^|[\\/])\.netrc$/i,
    /(^|[\\/])\.npmrc$/i,
    /(^|[\\/])\.git-credentials$/i,
    /(^|[\\/])id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
    /(^|[\\/])\.env(\.[\w.-]+)?$/i,
];

function isPathDenied(resolvedPath) {
    return DENIED_PATTERNS.some((re) => re.test(resolvedPath));
}

const BINARY_EXTENSIONS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg',
    '.mp3', '.mp4', '.wav', '.ogg', '.flac', '.avi', '.mkv', '.mov',
    '.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.rar',
    '.exe', '.dll', '.so', '.dylib', '.bin', '.dat',
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
    '.woff', '.woff2', '.ttf', '.otf', '.eot',
]);

function isPathAllowed(targetPath) {
    const normalized = path.resolve(targetPath);
    if (isPathDenied(normalized)) return false;
    // Windows path comparison is case-insensitive, so compare case-folded
    // there — otherwise C:\\Users\\me vs c:\\users\\me reads as an escape.
    const norm = IS_WINDOWS ? normalized.toLowerCase() : normalized;
    return ALLOWED_ROOTS.some((root) => {
        const r = IS_WINDOWS ? path.resolve(root).toLowerCase() : path.resolve(root);
        return norm === r || norm.startsWith(r + path.sep);
    });
}

function expandHome(p) {
    if (!p) return p;
    if (p === '~') return HOME_DIR;
    if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(HOME_DIR, p.slice(2));
    return p;
}

function sanitizePath(rawPath) {
    if (!rawPath) return HOME_DIR;
    const expanded = expandHome(rawPath);
    // Resolve bare relative paths against the agent workspace (where files are
    // actually written), NOT the server's cwd. Without this, a model that says
    // "saved to scratch/foo.html" produces a path the preview/read can't find
    // when the workspace isn't ~/tricorder-agent-workspace (e.g. a custom
    // TRICORDER_WORKSPACE). Absolute and ~-rooted paths are unaffected.
    const normalized = path.isAbsolute(expanded)
        ? path.resolve(expanded)
        : path.resolve(WORKSPACE_DIR, expanded);
    if (!isPathAllowed(normalized)) return null;
    return normalized;
}

(function ensureWorkspace() {
    try {
        fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
        // Create standard sub-directories
        for (const sub of ['code', 'data', 'downloads', 'scratch']) {
            fs.mkdirSync(path.join(WORKSPACE_DIR, sub), { recursive: true });
        }
        console.log(`  Workspace: ${WORKSPACE_DIR}`);
    } catch (e) {
        console.error(`  Failed to create workspace: ${e.message}`);
    }
})();

function shell(cmd, timeout = 10000) {
    return new Promise((resolve, reject) => {
        // windowsHide:true prevents a cmd.exe window from flashing on Windows
        // for every exec call — critical because the system snapshot sampler
        // runs this helper on a 60s interval.
        exec(cmd, { timeout, cwd: WORKSPACE_DIR, windowsHide: true }, (err, stdout) => {
            if (err) reject(err);
            else resolve(stdout.trim());
        });
    });
}

function powershell(cmd, timeout = 10000) {
    return shell(`powershell -NoProfile -Command "${cmd.replace(/"/g, '\\"')}"`, timeout);
}

// Apply terminal carriage-return semantics to captured process output.
// tqdm / pip / git redraw their progress bars by emitting `\r` and rewriting
// the same line; a terminal collapses that to one updating line, but a raw
// capture keeps every redraw. Without this, a 10-minute download tail is
// thousands of stacked half-bars instead of the single line the user would
// see in PowerShell.
function collapseCarriageReturns(text) {
    if (!text || text.indexOf('\r') === -1) return text;
    return text.split('\n').map(line => {
        if (line.indexOf('\r') === -1) return line;
        // A lone \r rewinds to column 0; the next segment overwrites the
        // previous one character-for-character (a shorter redraw keeps the
        // old line's tail, like a real terminal). `\r\n` leaves a trailing
        // empty segment, which overwrites nothing.
        let out = '';
        for (const seg of line.split('\r')) {
            out = seg.length >= out.length ? seg : seg + out.slice(seg.length);
        }
        return out;
    }).join('\n');
}

// Streaming variant of shell() for the run_command tool. exec() buffers
// everything until the process exits — and its success callback drops stderr
// entirely, which is where tqdm/pip/git write progress. spawn() + live
// onProgress lets the UI show the same moving progress bar a terminal would.
function runCommandStreaming(cmd, { timeout = 15000, cwd = WORKSPACE_DIR, onProgress = null } = {}) {
    return new Promise((resolve) => {
        const child = spawn(cmd, { shell: true, cwd, windowsHide: true });
        const MAX_BUF = 1024 * 1024;
        let buf = '';
        let timedOut = false;
        let settled = false;

        // Throttle progress to ~3/s — tqdm redraws far faster than that and
        // each event crosses the SSE wire.
        let lastEmit = 0;
        const EMIT_MS = 300;
        const emit = (force) => {
            if (!onProgress) return;
            const now = Date.now();
            if (!force && now - lastEmit < EMIT_MS) return;
            lastEmit = now;
            const collapsed = collapseCarriageReturns(buf.slice(-8192));
            const lines = collapsed.split('\n').filter(l => l.trim());
            try {
                onProgress({
                    phase: 'output',
                    message: (lines[lines.length - 1] || '').slice(0, 200),
                    output_tail: collapsed.slice(-1600),
                    outputBytes: buf.length,
                });
            } catch { /* progress must never break execution */ }
        };

        const append = (chunk) => {
            if (buf.length < MAX_BUF) {
                buf += chunk.toString();
                if (buf.length > MAX_BUF) buf = buf.slice(0, MAX_BUF) + '\n[...output truncated at 1MB]';
            }
            emit(false);
        };
        child.stdout.on('data', append);
        child.stderr.on('data', append);

        const timer = setTimeout(() => {
            timedOut = true;
            try { child.kill('SIGTERM'); } catch {}
            setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 3000);
        }, timeout);

        const finish = (ok, exitCode, note) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            emit(true);
            let out = collapseCarriageReturns(buf).trim();
            if (note) out = out ? out + '\n' + note : note;
            // Keep head + tail on overflow — with long commands the errors
            // and summaries live at the end, not the start.
            if (out.length > 10000) out = out.slice(0, 4000) + '\n[...truncated...]\n' + out.slice(-6000);
            resolve({ ok, exitCode, output: out });
        };

        const conclude = (code) => {
            if (timedOut) finish(false, code == null ? 1 : code, `[Killed: exceeded ${Math.round(timeout / 1000)}s timeout]`);
            else finish(code === 0, code == null ? 1 : code, code == null ? '[Process terminated by signal]' : null);
        };
        child.on('error', (err) => finish(false, 1, `[Process error: ${err.message}]`));
        // 'close' fires once stdio is fully drained — the normal path. But if
        // the shell forks instead of exec'ing (or the command launches a
        // daemon), an orphaned grandchild keeps the inherited pipes open and
        // 'close' never fires even though the command is done. Fall back to
        // concluding shortly after 'exit' so a run_command can never hang the
        // tool call forever.
        child.on('close', conclude);
        child.on('exit', (code) => setTimeout(() => conclude(code), 1500));
    });
}

async function getSystemStatus() {
    const cpus = os.cpus();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;

    let disk = null;
    try {
        if (IS_WINDOWS) {
            const raw = await powershell("Get-PSDrive C | Select-Object Used,Free | ConvertTo-Json");
            const d = JSON.parse(raw);
            const used = d.Used, free = d.Free, total = used + free;
            disk = { total, used, free, percent: Math.round((used / total) * 100) };
        } else {
            const raw = await shell('df -B1 / | tail -1');
            const p = raw.split(/\s+/);
            if (p.length >= 5) {
                disk = { total: +p[1], used: +p[2], free: +p[3], percent: parseInt(p[4]) };
            }
        }
    } catch { /* optional */ }

    let cpuPercent = null;
    try {
        if (IS_WINDOWS) {
            const raw = await powershell("(Get-CimInstance Win32_Processor).LoadPercentage");
            cpuPercent = parseInt(raw) || 0;
        } else {
            const la = os.loadavg();
            cpuPercent = Math.min(100, Math.round((la[0] / cpus.length) * 100));
        }
    } catch { /* optional */ }

    return {
        hostname: os.hostname(),
        platform: `${os.platform()} ${os.arch()}`,
        release: os.release(),
        uptime: os.uptime(),
        loadavg: os.loadavg(),
        cpu: { model: cpus[0]?.model || 'Unknown', cores: cpus.length, percent: cpuPercent },
        memory: { total: totalMem, used: usedMem, free: freeMem, percent: Math.round((usedMem / totalMem) * 100) },
        disk,
    };
}

// --- GPU Info (nvidia-smi) ---
async function getGpuInfo() {
    try {
        const raw = await shell('nvidia-smi --query-gpu=name,temperature.gpu,utilization.gpu,memory.used,memory.total,power.draw,fan.speed,driver_version --format=csv,noheader,nounits 2>/dev/null', 5000);
        if (!raw) return null;
        const parts = raw.split(',').map(s => s.trim());
        if (parts.length < 8) return null;
        return {
            name: parts[0],
            tempC: parseInt(parts[1]) || 0,
            utilPercent: parseInt(parts[2]) || 0,
            memUsedMB: parseInt(parts[3]) || 0,
            memTotalMB: parseInt(parts[4]) || 0,
            memPercent: parts[4] > 0 ? Math.round((parseInt(parts[3]) / parseInt(parts[4])) * 100) : 0,
            powerW: parseFloat(parts[5]) || 0,
            fanPercent: parseInt(parts[6]) || 0,
            driver: parts[7],
        };
    } catch {
        // Try Windows nvidia-smi
        try {
            const raw = await shell('nvidia-smi --query-gpu=name,temperature.gpu,utilization.gpu,memory.used,memory.total,power.draw,fan.speed,driver_version --format=csv,noheader,nounits 2>nul', 5000);
            if (!raw) return null;
            const parts = raw.split(',').map(s => s.trim());
            if (parts.length < 8) return null;
            return {
                name: parts[0], tempC: parseInt(parts[1]) || 0, utilPercent: parseInt(parts[2]) || 0,
                memUsedMB: parseInt(parts[3]) || 0, memTotalMB: parseInt(parts[4]) || 0,
                memPercent: parts[4] > 0 ? Math.round((parseInt(parts[3]) / parseInt(parts[4])) * 100) : 0,
                powerW: parseFloat(parts[5]) || 0, fanPercent: parseInt(parts[6]) || 0, driver: parts[7],
            };
        } catch { return null; }
    }
}

// --- Process List ---
async function getProcessList(limit = 15) {
    try {
        if (IS_WINDOWS) {
            const raw = await powershell(`Get-Process | Sort-Object CPU -Descending | Select-Object -First ${limit} Id,ProcessName,CPU,@{N='MemMB';E={[math]::Round($_.WorkingSet64/1MB,1)}} | ConvertTo-Json`, 8000);
            const procs = JSON.parse(raw);
            return (Array.isArray(procs) ? procs : [procs]).map(p => ({
                pid: p.Id, name: p.ProcessName, cpu: Math.round((p.CPU || 0) * 10) / 10, memMB: p.MemMB || 0,
            }));
        } else {
            const raw = await shell(`ps aux --sort=-%cpu | head -${limit + 1}`, 5000);
            const lines = raw.split('\n').slice(1); // skip header
            return lines.filter(l => l.trim()).map(line => {
                const parts = line.trim().split(/\s+/);
                return {
                    pid: parseInt(parts[1]) || 0,
                    name: parts.slice(10).join(' ').substring(0, 60),
                    cpu: parseFloat(parts[2]) || 0,
                    memMB: Math.round((parseFloat(parts[5]) || 0) / 1024),
                };
            });
        }
    } catch { return []; }
}

// --- Network Interfaces ---
function getNetworkInfo() {
    const ifaces = os.networkInterfaces();
    const result = [];
    for (const [name, addrs] of Object.entries(ifaces)) {
        for (const addr of addrs) {
            if (!addr.internal && addr.family === 'IPv4') {
                result.push({ name, address: addr.address, mac: addr.mac, netmask: addr.netmask });
            }
        }
    }
    return result;
}

// --- Dashboard API (aggregates everything) ---
async function handleDashboardApi(req, res, reqId) {
    const endpoint = req.url.replace('/api/dashboard/', '').split('?')[0];
    log('INFO', 'DASH', `#${reqId} ${req.method} /api/dashboard/${endpoint}`);

    if (req.method === 'GET' && endpoint === 'full') {
        try {
            const [status, gpu, processes] = await Promise.all([
                getSystemStatus(),
                getGpuInfo(),
                getProcessList(),
            ]);
            const network = getNetworkInfo();

            // Get active tasks count and pending notifications count
            let taskCount = 0, notifCount = 0;
            try { taskCount = _tasks ? _tasks.length : 0; } catch {}
            try { notifCount = _notifications ? _notifications.filter(n => n.status !== 'dismissed').length : 0; } catch {}

            jsonRes(res, 200, {
                system: status,
                gpu,
                processes,
                network,
                taskCount,
                notifCount,
                serverUptime: process.uptime(),
                nodeVersion: process.version,
                timestamp: Date.now(),
            });
        } catch (e) {
            log('ERROR', 'DASH', `#${reqId} Dashboard fetch failed: ${e.message}`);
            jsonRes(res, 500, { error: e.message });
        }
        return;
    }

    if (req.method === 'GET' && endpoint === 'gpu') {
        try {
            const gpu = await getGpuInfo();
            jsonRes(res, 200, { gpu });
        } catch (e) {
            jsonRes(res, 200, { gpu: null });
        }
        return;
    }

    if (req.method === 'GET' && endpoint === 'processes') {
        try {
            const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
            const limit = parseInt(urlObj.searchParams.get('limit'), 10) || 15;
            const processes = await getProcessList(Math.min(limit, 50));
            jsonRes(res, 200, { processes });
        } catch (e) {
            jsonRes(res, 200, { processes: [] });
        }
        return;
    }

    if (req.method === 'GET' && endpoint === 'network') {
        jsonRes(res, 200, { interfaces: getNetworkInfo() });
        return;
    }

    jsonRes(res, 404, { error: 'Unknown dashboard endpoint' });
}

// --- Command Execution API (Desktop Commander integration) ---
// Allows executing safe shell commands from the frontend.
// Restricted to a whitelist of read-only / monitoring commands.
// NOTE ON SCOPE: the shell interpreters at the bottom (bash, sh, cmd,
// powershell, python, node …) are themselves full code-execution entrypoints —
// `bash -c '…'` already runs anything. So this list is a UX convenience that
// keeps the model from being nagged about everyday tools, NOT the security
// boundary. That's why it's broad. The real gate is that /api/exec is reachable
// only behind the app's auth session. Every entry must be lower-case — token
// names are normalised with commandBaseName() (lower-cased, .exe stripped)
// before lookup.
const ALLOWED_COMMANDS = new Set([
    // ── System / host info ──────────────────────────────────────────────
    'whoami', 'hostname', 'hostnamectl', 'uptime', 'date', 'cal', 'uname', 'arch',
    'lsb_release', 'lscpu', 'lsblk', 'blkid', 'lsusb', 'lspci', 'lsmem', 'free', 'top',
    'htop', 'vmstat', 'iostat', 'mpstat', 'sar', 'dmesg', 'sensors', 'nvidia-smi',
    'rocm-smi', 'getconf', 'locale', 'printenv', 'env', 'id', 'groups', 'who', 'w',
    'last', 'tty', 'timedatectl', 'systeminfo', 'ver', 'set', 'wmic', 'reg', 'sc',
    // ── Processes / services ────────────────────────────────────────────
    'ps', 'pgrep', 'pidof', 'lsof', 'pmap', 'tasklist', 'taskkill', 'kill', 'killall',
    'docker', 'docker-compose', 'podman', 'kubectl', 'systemctl', 'service',
    'journalctl', 'launchctl',
    // ── Networking ──────────────────────────────────────────────────────
    'ip', 'ifconfig', 'ipconfig', 'netstat', 'ss', 'ping', 'traceroute', 'tracert',
    'nslookup', 'dig', 'host', 'whois', 'arp', 'route', 'getent', 'mtr', 'nc', 'ncat',
    'ssh', 'scp', 'sftp', 'rsync', 'ssh-keygen', 'ssh-keyscan', 'nmap',
    // ── Filesystem (read) ───────────────────────────────────────────────
    'ls', 'dir', 'tree', 'pwd', 'realpath', 'readlink', 'dirname', 'basename', 'stat',
    'file', 'du', 'df', 'find', 'locate', 'which', 'where', 'whereis', 'type',
    'cat', 'tac', 'head', 'tail', 'wc', 'nl', 'mountpoint',
    // ── Filesystem (write / mutate) ─────────────────────────────────────
    'mkdir', 'rmdir', 'rm', 'cp', 'mv', 'ln', 'touch', 'chmod', 'chown', 'chgrp',
    'truncate', 'install', 'mktemp', 'sync', 'shred', 'rename', 'patch',
    // Windows file builtins (run through the cmd.exe wrapper exec() provides)
    'copy', 'move', 'del', 'erase', 'ren', 'md', 'rd', 'xcopy', 'robocopy', 'attrib',
    'fc', 'comp', 'mklink',
    // ── Text processing ─────────────────────────────────────────────────
    'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'awk', 'gawk', 'sed', 'sort', 'uniq',
    'cut', 'tr', 'diff', 'cmp', 'comm', 'join', 'paste', 'rev', 'column', 'fold', 'fmt',
    'expand', 'unexpand', 'tee', 'xargs', 'echo', 'printf', 'seq', 'findstr',
    'jq', 'yq', 'xxd', 'od', 'hexdump', 'strings', 'base64', 'base32',
    'md5sum', 'sha1sum', 'sha256sum', 'sha512sum', 'cksum', 'b2sum', 'certutil',
    // ── Archive / compression ───────────────────────────────────────────
    'tar', 'zip', 'unzip', 'gzip', 'gunzip', 'zcat', 'bzip2', 'bunzip2', 'xz', 'unxz',
    'zstd', 'lz4', '7z', '7za', 'cpio', 'compress',
    // ── Fetch / transfer ────────────────────────────────────────────────
    'curl', 'wget', 'http', 'https', 'aria2c',
    // ── Version control ─────────────────────────────────────────────────
    'git', 'gh', 'svn', 'hg',
    // ── Languages / runtimes / build ────────────────────────────────────
    'node', 'npm', 'npx', 'yarn', 'pnpm', 'bun', 'deno', 'tsc', 'ts-node',
    'python', 'python3', 'py', 'pyw', 'pip', 'pip3', 'pipx', 'poetry', 'pytest', 'conda', 'uv',
    'ruby', 'gem', 'bundle', 'rake', 'perl', 'php', 'composer', 'lua',
    'go', 'gofmt', 'rustc', 'cargo', 'rustup', 'java', 'javac', 'kotlin', 'mvn', 'gradle',
    'dotnet', 'make', 'cmake', 'ninja', 'gcc', 'g++', 'cc', 'clang', 'clang++', 'ld',
    'pkg-config', 'rscript', 'julia', 'swift', 'swiftc',
    // ── Linters / formatters / test runners ─────────────────────────────
    'eslint', 'prettier', 'jest', 'mocha', 'vitest', 'ruff', 'black', 'flake8', 'mypy',
    'pylint', 'isort', 'shellcheck',
    // ── Cloud / devops CLIs ─────────────────────────────────────────────
    'helm', 'terraform', 'ansible', 'vagrant', 'aws', 'gcloud', 'az', 'heroku',
    'flyctl', 'fly', 'wrangler', 'vercel', 'netlify', 'supabase', 'doctl',
    // ── Media / documents ───────────────────────────────────────────────
    'ffmpeg', 'ffprobe', 'convert', 'magick', 'identify', 'mogrify', 'gs', 'pandoc',
    'wkhtmltopdf', 'pdfinfo', 'pdftotext', 'pdftoppm', 'exiftool', 'sox', 'qpdf',
    // ── Databases ───────────────────────────────────────────────────────
    'sqlite3', 'psql', 'mysql', 'mariadb', 'mongosh', 'redis-cli',
    // ── Package managers (system) ───────────────────────────────────────
    'brew', 'apt', 'apt-get', 'apt-cache', 'dpkg', 'yum', 'dnf', 'pacman', 'snap',
    'flatpak', 'winget', 'choco', 'scoop', 'pkg', 'port',
    // ── Shell interpreters & code-exec entrypoints — handled specially in
    //    isCommandAllowed() (the whole line is trusted once the leading
    //    interpreter is allowlisted, since e.g. PowerShell/cmd one-liners are
    //    full of $, |, > that the per-segment metacharacter check would reject).
    'powershell', 'pwsh', 'cmd', 'bash', 'sh', 'zsh', 'fish', 'dash', 'ksh',
]);

// Tools that touch the filesystem, run commands, reach the outside world, or
// destroy data — i.e. everything plan mode (read-only investigation) must
// refuse. Internal planning bookkeeping (todo_write, memory_store, mood,
// opinions) is intentionally NOT here so writing up the plan still works.
const MUTATING_TOOLS = new Set([
    'write_file', 'file_edit', 'run_command', 'agent_spawn',
    'create_task', 'task_update',
    'task_delete', 'send_notification', 'vector_delete',
    'browser_navigate', 'browser_click', 'browser_type', 'code_exec',
]);
// Extended tools (server/tools/*) that mutate state or reach outside are also
// blocked in plan mode. Registered here so the set stays the single source of
// truth without server.js having to hard-code each new tool name.
if (extendedTools && Array.isArray(extendedTools.mutating)) {
    for (const t of extendedTools.mutating) MUTATING_TOOLS.add(t);
}

// Split a command line on the shell operators that chain commands together.
const SHELL_CHAIN = /\s*(?:\|\||&&|;|\||&)\s*/;

// Interpreters that take arbitrary code/scripts as arguments. When one of these
// is invoked directly it IS the allowlisted trust unit — it can already run
// anything by design (python -c, node -e, powershell -Command, cmd /c …), so
// subjecting it to the per-segment metacharacter/pipeline checks below buys no
// security and actively breaks normal one-liners: a Python snippet legitimately
// contains `;` (statement separator), `>`/`<` (comparisons, redirects), `|`
// (bitwise/Pandas) and quotes; PowerShell uses `$`, `|`, `>` everywhere. So we
// allow the whole line as long as the leading interpreter is allowlisted.
// python/python3/node are included alongside the shells precisely because they
// are full code-execution entrypoints — exactly the cases the operator reported
// being wrongly blocked when deleting files (e.g. `cmd /c del`, `python -c
// "import os; os.remove(...)"`, `powershell -Command "Remove-Item ..."`).
const INTERPRETER_COMMANDS = new Set([
    'powershell', 'pwsh', 'cmd', 'bash', 'sh', 'zsh', 'fish', 'dash', 'ksh', // shells
    'python', 'python3', 'py', 'pyw', 'node', 'deno', 'bun',                 // JS / Python (py = Windows launcher)
    'ruby', 'perl', 'php', 'lua', 'julia', 'rscript',                        // other -e/-r runners
]);

// Reduce a command token to its bare program name: drop any directory prefix
// (both / and \ separators) and a trailing .exe, and lower-case it — so Windows
// invocations like `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`
// match the allowlist just as `powershell` does.
function commandBaseName(token) {
    return String(token || '')
        .replace(/^.*[\\/]/, '')
        .replace(/\.exe$/i, '')
        .toLowerCase();
}

function isCommandAllowed(cmd) {
    const c = (cmd || '').trim();
    if (!c) return false;
    // A single exec() call runs a single command line — never allow raw
    // newlines to smuggle a second command, regardless of interpreter.
    if (/[\r\n]/.test(c)) return false;
    const firstBase = commandBaseName(c.split(/\s+/)[0]);
    // Interpreters are themselves the trust boundary: allow the whole line
    // (with its $, |, >, ;, quotes …) provided the interpreter is allowlisted.
    if (INTERPRETER_COMMANDS.has(firstBase)) return ALLOWED_COMMANDS.has(firstBase);
    // Everything else: reject command substitution, variable expansion and
    // redirects outright. Without this, an allowlisted base command can smuggle
    // arbitrary execution past the per-segment check — e.g. `echo $(rm -rf x)`
    // or `cat a > /etc/passwd` — because only the first word used to be checked.
    if (/[`$<>]/.test(c) || c.includes('$(')) return false;
    // Validate EVERY segment of a pipeline/chain, not just the first, so
    // `ls | curl evil` can't pass on the strength of `ls` alone.
    const segments = c.split(SHELL_CHAIN).filter(Boolean);
    if (segments.length === 0) return false;
    return segments.every((seg) => ALLOWED_COMMANDS.has(commandBaseName(seg.trim().split(/\s+/)[0])));
}

// Best-effort recovery of malformed tool-call JSON arguments. Local models often
// emit an entire file as one write_file call and break the JSON escaping of the
// content (raw newlines, unescaped quotes, an embedded </script>). Strict
// JSON.parse rejects that, the agent treats it as a tool error and loops —
// regenerating the whole file again and again until it gives up. For the big
// content-carrying tools we instead salvage the fields heuristically. Returns a
// usable args object, or null when nothing trustworthy can be recovered (so the
// caller still surfaces a clean "invalid arguments" error).
// Did the model finish emitting this arguments blob at all? The salvage below
// exists for a COMPLETE call whose content broke the JSON escaping — there the
// object is closed, only the escaping inside it is wrong. A call cut off at
// max_tokens looks deceptively similar (the leading "path" is intact, and a
// half-written HTML file still contains plenty of quotes for the content grab
// to end on), so without this check the salvage happily writes the fragment
// and reports ok — a file ending mid-tag, delivered as a success.
// Terminated means: the object's closing brace is there, and the last string
// value was closed before it (only scalar fields like "append" may follow).
function argsBlobTerminated(raw) {
    const tail = String(raw).trimEnd();
    if (!tail.endsWith('}')) return false;
    const lastQuote = tail.lastIndexOf('"');
    return lastQuote !== -1 && /^[^"]*\}$/.test(tail.slice(lastQuote + 1));
}

// Tools whose truncated call is worth an explicit "resume in chunks" hint —
// the ones that carry a whole file in one argument.
const FILE_CONTENT_TOOLS = new Set(['write_file', 'file_write', 'file_create', 'file_edit']);

function recoverToolArgs(fnName, raw) {
    if (typeof raw !== 'string' || !raw.includes('"')) return null;
    const unescape = (s) => s
        .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
        .replace(/\\([\\/"bfnrt])/g, (_, c) => ({ '\\': '\\', '/': '/', '"': '"', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }[c]));
    // A short leading string field (path) is almost always intact even when the
    // trailing content is mangled.
    const grabShort = (key) => {
        const m = raw.match(new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`));
        return m ? unescape(m[1]) : null;
    };
    // The big content value: from the opening quote after the key to the LAST
    // quote in the blob (the closing quote before the object's "}").
    const grabBig = (key, src = raw) => {
        const km = src.match(new RegExp(`"${key}"\\s*:\\s*"`));
        if (!km) return null;
        const start = km.index + km[0].length;
        const end = src.lastIndexOf('"');
        return end > start ? unescape(src.slice(start, end)) : null;
    };
    if (fnName === 'write_file') {
        const path = grabShort('path');
        // A trailing `"append": true/false` field would land inside grabBig's
        // last-quote heuristic — cut it off the blob before extracting content.
        const append = /"append"\s*:\s*(?:true|"true")/.test(raw);
        const am = raw.match(/,?\s*"append"\s*:\s*(?:true|false|"true"|"false")\s*}?\s*$/);
        const content = grabBig('content', am ? raw.slice(0, am.index) : raw);
        if (path && content != null) return append ? { path, content, append: true } : { path, content };
    }
    return null;
}

// Chunking guard for content-carrying file tools. A single oversized content
// blob means minutes of buffered silence on backends that don't stream
// tool-call arguments (LM Studio), plus a higher chance of broken JSON
// escaping. But by the time the content reaches this guard it has ALREADY
// been fully generated and parsed — rejecting it here throws away minutes of
// work and forces the model to regenerate the entire file. So the guard is
// SOFT: the write goes through, and the tool result carries a notice steering
// the model toward chunked delivery next time. Only absurdly large content
// (a runaway loop, not a real file) is still rejected outright.
// Override the soft threshold with WRITE_FILE_MAX_CHARS (0 disables both).
const WRITE_FILE_MAX_CHARS = (() => {
    const v = parseInt(process.env.WRITE_FILE_MAX_CHARS, 10);
    return Number.isFinite(v) ? Math.max(0, v) : 12000;
})();
const WRITE_FILE_HARD_MAX_CHARS = (() => {
    const v = parseInt(process.env.WRITE_FILE_HARD_MAX_CHARS, 10);
    if (Number.isFinite(v)) return Math.max(0, v);
    return WRITE_FILE_MAX_CHARS ? Math.max(400000, WRITE_FILE_MAX_CHARS * 4) : 0;
})();
// Returns a notice string for oversized-but-accepted content, null when the
// size is fine. Throws only above the hard cap.
function chunkSizeNotice(tool, field, content) {
    if (!WRITE_FILE_MAX_CHARS || content.length <= WRITE_FILE_MAX_CHARS) return null;
    const lines = content.split('\n').length;
    if (WRITE_FILE_HARD_MAX_CHARS && content.length > WRITE_FILE_HARD_MAX_CHARS) {
        throw new Error(
            `${field} too large for one ${tool} call (${content.length} chars / ${lines} lines; hard max ${WRITE_FILE_HARD_MAX_CHARS} chars). ` +
            'Nothing was written. Deliver the file in CHUNKS: call write_file with the first ~100 lines, ' +
            'then write_file with append:true for each following ~100-line chunk, in order, until the file is complete.'
        );
    }
    // "Written in full" is a claim this guard cannot make: it sees the content
    // it was handed, not whether the model finished generating it. Report the
    // size that reached disk and let the model verify the rest.
    return `Written (${content.length} chars), but that much in one ${tool} call is fragile — buffered silence, JSON-escaping risk, and a reply that hits its output token ceiling mid-call loses everything after the cut. ` +
        'Next time deliver files this large in ~100-line chunks: first write_file call plain, then append:true continuations.';
}

async function handleExecApi(req, res, reqId) {
    if (req.method !== 'POST') {
        jsonRes(res, 405, { error: 'Method not allowed' });
        return;
    }
    if (!SHELL_ENABLED) {
        jsonRes(res, 403, { error: 'Shell access is disabled on this server (SHELL_ENABLED=false).' });
        return;
    }

    const body = await readJsonBody(req);
    const cmd = (body.command || '').trim();

    if (!cmd) {
        jsonRes(res, 400, { error: 'command parameter required' });
        return;
    }

    if (!isCommandAllowed(cmd)) {
        const base = cmd.split(/\s+/)[0];
        log('WARN', 'EXEC', `#${reqId} Blocked command: ${base}`);
        jsonRes(res, 403, { error: `Command "${base}" is not in the allowed list. Allowed: ${[...ALLOWED_COMMANDS].sort().join(', ')}` });
        return;
    }

    log('INFO', 'EXEC', `#${reqId} Executing: ${cmd.substring(0, 200)}`);

    try {
        const timeout = Math.min(parseInt(body.timeout, 10) || 15000, 30000);
        const output = await shell(cmd, timeout);
        log('INFO', 'EXEC', `#${reqId} Command completed (${output.length} chars)`);
        jsonRes(res, 200, { ok: true, command: cmd, output, exitCode: 0 });
    } catch (e) {
        const output = e.stdout || e.stderr || e.message;
        log('WARN', 'EXEC', `#${reqId} Command failed: ${e.message}`);
        jsonRes(res, 200, { ok: false, command: cmd, output, exitCode: e.code || 1, error: e.message });
    }
}

// --- Screenshot / URL Preview API (Playwright-lite via web fetch) ---
async function handleScreenshotApi(req, res, reqId) {
    if (req.method !== 'POST') {
        jsonRes(res, 405, { error: 'Method not allowed' });
        return;
    }

    const body = await readJsonBody(req);
    const targetUrl = (body.url || '').trim();

    if (!targetUrl) {
        jsonRes(res, 400, { error: 'url parameter required' });
        return;
    }

    log('INFO', 'BROWSE', `#${reqId} Fetching URL preview: ${targetUrl}`);

    try {
        const maxBytes = 100000;
        const { statusCode, data, totalBytes, finalUrl } = await httpRequest(targetUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            },
            maxBytes,
        });

        // Extract metadata
        const title = (data.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]?.trim() || '';
        const description = (data.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i) || [])[1]?.trim() || '';
        const favicon = (data.match(/<link[^>]+rel=["'](?:shortcut )?icon["'][^>]+href=["']([^"']*)/i) || [])[1] || '';
        const ogImage = (data.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']*)/i) || [])[1] || '';

        // Extract text content
        let text = data
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s{2,}/g, ' ')
            .trim();
        if (text.length > 5000) text = text.substring(0, 5000) + '...';

        // Extract links
        const links = [];
        const linkRegex = /<a[^>]+href=["']([^"'#][^"']*?)["'][^>]*>([\s\S]*?)<\/a>/gi;
        let match;
        while ((match = linkRegex.exec(data)) !== null && links.length < 10) {
            const href = match[1].trim();
            const linkText = match[2].replace(/<[^>]+>/g, '').trim();
            if (linkText && href && !href.startsWith('javascript:')) {
                links.push({ url: href, text: linkText.substring(0, 100) });
            }
        }

        jsonRes(res, 200, {
            status: statusCode,
            url: finalUrl || targetUrl,
            title,
            description,
            favicon: favicon ? new URL(favicon, targetUrl).href : '',
            ogImage: ogImage ? new URL(ogImage, targetUrl).href : '',
            text,
            links,
            truncated: totalBytes > maxBytes,
        });
    } catch (e) {
        log('ERROR', 'BROWSE', `#${reqId} URL fetch failed: ${e.message}`);
        jsonRes(res, 200, { error: e.message, url: targetUrl });
    }
}

// --- VRAM Purge ---
async function purgeVram() {
    if (IS_WINDOWS) {
        await powershell('Get-Process | % { $_.MinWorkingSet = $_.MinWorkingSet }').catch(() => {});
        await shell('nvidia-smi --gpu-reset 2>nul').catch(() => {});
    } else {
        await shell('sync && sudo sh -c "echo 3 > /proc/sys/vm/drop_caches"')
            .catch(() => shell('sync && echo 3 | sudo tee /proc/sys/vm/drop_caches > /dev/null').catch(() => {}));
        await shell('nvidia-smi --gpu-reset 2>/dev/null').catch(() => {});
    }
}

async function handleServerApi(req, res, reqId) {
    const endpoint = req.url.replace('/api/server/', '').split('?')[0];
    log('INFO', 'API', `#${reqId} ${req.method} /api/server/${endpoint}`);

    if (req.method === 'GET' && endpoint === 'status') {
        try {
            const status = await getSystemStatus();
            log('DEBUG', 'API', `#${reqId} System status retrieved`, {
                cpu: status.cpu.cores + ' cores',
                memPercent: status.memory.percent + '%',
                diskPercent: status.disk?.percent + '%',
            });
            jsonRes(res, 200, status);
        } catch (e) {
            log('ERROR', 'API', `#${reqId} Failed to get system status: ${e.message}`);
            jsonRes(res, 500, { error: e.message });
        }
        return;
    }

    if (req.method !== 'POST') {
        log('WARN', 'API', `#${reqId} Method not allowed: ${req.method}`);
        jsonRes(res, 405, { error: 'Method not allowed' });
        return;
    }

    const body = await readJsonBody(req);
    try {
        switch (endpoint) {
            case 'purge-vram':
                log('WARN', 'API', `#${reqId} VRAM purge requested`);
                await purgeVram();
                log('INFO', 'API', `#${reqId} VRAM purged, free mem: ${os.freemem()} bytes`);
                jsonRes(res, 200, { ok: true, message: 'VRAM purged', freeMem: os.freemem() });
                break;
            default:
                log('WARN', 'API', `#${reqId} Unknown endpoint: ${endpoint}`);
                jsonRes(res, 404, { error: 'Unknown endpoint' });
        }
    } catch (e) {
        log('ERROR', 'API', `#${reqId} ${endpoint} failed: ${e.message}`);
        jsonRes(res, 500, { error: e.message });
    }
}

// --- HTTP request helper with redirect following ---
// SSRF guard for LLM-reachable HTTP tools: with { blockPrivate: true } every
// hop (initial URL and each redirect) is rejected when the hostname — or any
// IP it resolves to (light DNS-rebinding defence) — is private/internal.
// Operators who deliberately want the agent to reach LAN devices can opt out
// globally with ALLOW_PRIVATE_HTTP=true in .env.
const ALLOW_PRIVATE_HTTP = process.env.ALLOW_PRIVATE_HTTP === 'true';

function assertPublicHost(parsed) {
    return new Promise((resolve, reject) => {
        const host = parsed.hostname;
        if (isPrivateHost(host)) {
            reject(new Error(`Blocked: "${host}" is a private/internal host. Set ALLOW_PRIVATE_HTTP=true to allow LAN targets.`));
            return;
        }
        // Hostname is not an IP literal — resolve it and check every address,
        // so private-DNS tricks (public name → 192.168.x.x) are caught too.
        if (net.isIP(host.replace(/^\[|\]$/g, ''))) { resolve(); return; }
        dns.lookup(host, { all: true }, (err, addrs) => {
            // Resolution failures are not a policy violation — let the actual
            // request fail with its own (clearer) connection error.
            if (err || !Array.isArray(addrs)) { resolve(); return; }
            const bad = addrs.find(a => isPrivateHost(a.address));
            if (bad) {
                reject(new Error(`Blocked: "${host}" resolves to private address ${bad.address}. Set ALLOW_PRIVATE_HTTP=true to allow LAN targets.`));
            } else {
                resolve();
            }
        });
    });
}

function httpRequest(url, { method = 'GET', headers = {}, body = null, maxRedirects = 5, maxBytes = 0, onProgress = null, blockPrivate = false } = {}) {
    return new Promise((resolve, reject) => {
        // Throttle progress callbacks so we don't flood the SSE channel.
        let lastProgressAt = 0;
        const safeProgress = (info) => {
            if (!onProgress) return;
            const now = Date.now();
            // Always emit the terminal "end" event; throttle intermediate updates.
            if (info.phase !== 'end' && info.phase !== 'start' && (now - lastProgressAt) < 250) return;
            lastProgressAt = now;
            try { onProgress(info); } catch { /* never let a progress handler break the download */ }
        };

        function doRequest(targetUrl, redirectsLeft) {
            let parsed;
            try { parsed = new URL(targetUrl); } catch (e) { reject(e); return; }
            // Validate every hop (initial + redirects) when the caller opted
            // into the SSRF guard, so a public URL can't 302 to localhost.
            const guard = (blockPrivate && !ALLOW_PRIVATE_HTTP)
                ? assertPublicHost(parsed)
                : Promise.resolve();
            guard.then(() => doRequestChecked(parsed, targetUrl, redirectsLeft)).catch(reject);
        }

        function doRequestChecked(parsed, targetUrl, redirectsLeft) {
            const transport = parsed.protocol === 'https:' ? https : http;

            safeProgress({ phase: 'start', url: targetUrl, method });

            const fetchReq = transport.request(parsed, {
                method,
                headers,
                timeout: 15000,
            }, (fetchRes) => {
                if ([301, 302, 303, 307, 308].includes(fetchRes.statusCode) && fetchRes.headers.location) {
                    if (redirectsLeft <= 0) { reject(new Error('Too many redirects')); return; }
                    const redirectUrl = new URL(fetchRes.headers.location, targetUrl).href;
                    safeProgress({ phase: 'redirect', url: redirectUrl });
                    fetchRes.resume();
                    doRequest(redirectUrl, redirectsLeft - 1);
                    return;
                }

                const contentLength = parseInt(fetchRes.headers['content-length'], 10) || 0;
                safeProgress({
                    phase: 'response',
                    statusCode: fetchRes.statusCode,
                    contentLength,
                    contentType: fetchRes.headers['content-type'] || '',
                });

                let data = '';
                let totalBytes = 0;
                fetchRes.on('data', (chunk) => {
                    totalBytes += chunk.length;
                    if (!maxBytes || totalBytes <= maxBytes) data += chunk;
                    safeProgress({
                        phase: 'data',
                        bytes: totalBytes,
                        totalBytes: contentLength,
                        statusCode: fetchRes.statusCode,
                    });
                });
                fetchRes.on('end', () => {
                    safeProgress({
                        phase: 'end',
                        bytes: totalBytes,
                        totalBytes: contentLength,
                        statusCode: fetchRes.statusCode,
                    });
                    resolve({ statusCode: fetchRes.statusCode, data, totalBytes, finalUrl: targetUrl, headers: fetchRes.headers });
                });
            });

            fetchReq.on('error', reject);
            fetchReq.on('timeout', () => { fetchReq.destroy(); reject(new Error('Request timed out')); });
            if (body) fetchReq.write(body);
            fetchReq.end();
        }
        doRequest(url, maxRedirects);
    });
}

// --- Image Proxy API ---
// Proxies remote images through our server to avoid hotlink blocks (Wikimedia
// and other sites with strict Referer checks) and CORS issues when embedding
// images returned by web_search in chat responses.
function isPrivateHost(host) {
    if (!host) return true;
    const h = host.toLowerCase().replace(/^\[|\]$/g, '');
    if (h === 'localhost' || h === '0.0.0.0' || h === '::' || h === '::1') return true;
    if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return true;
    if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(h)) return true;
    if (h.endsWith('.local') || h.endsWith('.localhost') || h.endsWith('.internal')) return true;
    if (h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;
    return false;
}

async function handleImageProxyApi(req, res, reqId) {
    const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const imageUrl = urlObj.searchParams.get('url');

    if (!imageUrl) {
        jsonRes(res, 400, { error: 'url parameter required' });
        return;
    }

    let target;
    try {
        target = new URL(imageUrl);
    } catch {
        jsonRes(res, 400, { error: 'invalid url' });
        return;
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
        jsonRes(res, 400, { error: 'only http/https allowed' });
        return;
    }
    if (isPrivateHost(target.hostname)) {
        log('WARN', 'IMGPROXY', `#${reqId} Blocked private host: ${target.hostname}`);
        jsonRes(res, 403, { error: 'internal hosts not allowed' });
        return;
    }

    log('INFO', 'IMGPROXY', `#${reqId} Fetching ${imageUrl}`);

    // Pick a site-appropriate Referer so hotlink-blocking hosts (Wikimedia,
    // many CDNs) return the image instead of a 403.
    function pickReferer(u) {
        const host = u.hostname.toLowerCase();
        if (/wikimedia|wikipedia/.test(host)) return 'https://en.wikipedia.org/';
        if (/ddg|duckduckgo/.test(host)) return 'https://duckduckgo.com/';
        return `${u.protocol}//${u.hostname}/`;
    }

    try {
        await new Promise((resolve, reject) => {
            const doRequest = (urlStr, redirectsLeft) => {
                let u;
                try { u = new URL(urlStr); }
                catch { return reject(new Error('invalid redirect url')); }
                if (isPrivateHost(u.hostname)) {
                    return reject(new Error('redirect to private host blocked'));
                }
                const t = u.protocol === 'https:' ? https : http;
                const ag = u.protocol === 'https:' ? httpsAgent : httpAgent;
                const r = t.request(u, {
                    method: 'GET',
                    agent: ag,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
                        'Accept-Language': 'en-US,en;q=0.9',
                        'Referer': pickReferer(u),
                    },
                    timeout: 15000,
                }, (upstream) => {
                    if ([301, 302, 303, 307, 308].includes(upstream.statusCode) && upstream.headers.location && redirectsLeft > 0) {
                        upstream.resume();
                        try {
                            const redirectUrl = new URL(upstream.headers.location, urlStr).href;
                            doRequest(redirectUrl, redirectsLeft - 1);
                        } catch (e) { reject(e); }
                        return;
                    }
                    if (upstream.statusCode >= 400) {
                        log('WARN', 'IMGPROXY', `#${reqId} Upstream ${upstream.statusCode} for ${urlStr}`);
                        res.writeHead(upstream.statusCode, { 'Content-Type': 'text/plain' });
                        res.end(`Upstream error: ${upstream.statusCode}`);
                        upstream.resume();
                        resolve();
                        return;
                    }
                    const ct = upstream.headers['content-type'] || 'application/octet-stream';
                    if (!/^image\//.test(ct) && !/^application\/octet-stream/.test(ct)) {
                        log('WARN', 'IMGPROXY', `#${reqId} Rejecting non-image content-type: ${ct}`);
                        res.writeHead(415, { 'Content-Type': 'text/plain' });
                        res.end(`Unsupported content-type: ${ct}`);
                        upstream.resume();
                        resolve();
                        return;
                    }
                    const headers = {
                        'Content-Type': ct,
                        'Cache-Control': 'public, max-age=3600',
                        'Access-Control-Allow-Origin': '*',
                    };
                    if (upstream.headers['content-length']) {
                        headers['Content-Length'] = upstream.headers['content-length'];
                    }
                    res.writeHead(200, headers);
                    // Enforce a max size while streaming (defence in depth)
                    let bytes = 0;
                    const MAX_BYTES = 8 * 1024 * 1024;
                    upstream.on('data', (chunk) => {
                        bytes += chunk.length;
                        if (bytes > MAX_BYTES) {
                            upstream.destroy();
                            res.end();
                            resolve();
                        } else {
                            res.write(chunk);
                        }
                    });
                    upstream.on('end', () => { res.end(); resolve(); });
                    upstream.on('error', reject);
                });
                r.on('error', reject);
                r.on('timeout', () => { r.destroy(); reject(new Error('image fetch timeout')); });
                r.end();
            };
            doRequest(imageUrl, 5);
        });
    } catch (e) {
        log('ERROR', 'IMGPROXY', `#${reqId} ${e.message}`);
        if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'text/plain' });
            res.end(`Image fetch failed: ${e.message}`);
        } else {
            try { res.end(); } catch {}
        }
    }
}

// --- Image Search Helpers ---
// Used by web_search to enrich text results with relevant image thumbnails.
// Combines multiple sources (DuckDuckGo image search, Wikipedia REST API,
// OpenGraph extraction from top result pages) and routes every image URL
// through /api/img-proxy so hotlink blocks and CORS are no longer an issue.
function imgProxyUrl(imageUrl) {
    if (!imageUrl) return '';
    return `/api/img-proxy?url=${encodeURIComponent(imageUrl)}`;
}

async function fetchDuckDuckGoImages(query, max = 4) {
    try {
        // Step 1: request the image-search landing page to obtain the vqd token
        const { data: homepage } = await httpRequest(
            `https://duckduckgo.com/?q=${encodeURIComponent(query)}&iax=images&ia=images`,
            {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                },
                maxBytes: 200000,
            }
        );
        // vqd tokens are alphanumeric+dash, e.g. "3-12345..." or "3-ABCdef..."
        // Capture from quoted attributes, JSON fields, HTML-encoded quotes, and bare URL params.
        const vqdMatch = homepage.match(/vqd=["']([\w-]+)["']/) ||
                         homepage.match(/vqd=&quot;([\w-]+)&quot;/) ||
                         homepage.match(/"vqd":"([\w-]+)"/) ||
                         homepage.match(/vqd=([\w-]+)[&"']/) ||
                         homepage.match(/[?&]vqd=([\w-]+)/) ||
                         homepage.match(/name=["']vqd["'][^>]*value=["']([\w-]+)["']/) ||
                         homepage.match(/value=["']([\w-]+)["'][^>]*name=["']vqd["']/);
        if (!vqdMatch) return [];
        const vqd = vqdMatch[1];

        // Step 2: fetch JSON image results
        const imgUrl = `https://duckduckgo.com/i.js?q=${encodeURIComponent(query)}&vqd=${encodeURIComponent(vqd)}&o=json&l=us-en&f=,,,&p=1`;
        const { data: imgData } = await httpRequest(imgUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                'Accept': 'application/json, text/javascript, */*; q=0.01',
                'Accept-Language': 'en-US,en;q=0.9',
                'X-Requested-With': 'XMLHttpRequest',
                'Referer': 'https://duckduckgo.com/',
            },
            maxBytes: 300000,
        });

        let parsed;
        try { parsed = JSON.parse(imgData); }
        catch { return []; }

        const out = [];
        for (const r of (parsed.results || []).slice(0, max * 2)) {
            const rawImg = r.image || r.thumbnail;
            if (!rawImg) continue;
            out.push({
                title: (r.title || '').substring(0, 200),
                thumbnail: imgProxyUrl(r.thumbnail || rawImg),
                image: imgProxyUrl(rawImg),
                source: r.url || r.source || '',
                provider: 'duckduckgo',
            });
            if (out.length >= max) break;
        }
        return out;
    } catch (err) {
        log('DEBUG', 'WEB', `DDG image search failed: ${err.message}`);
        return [];
    }
}

async function fetchWikipediaImage(query) {
    try {
        // Step 1: opensearch to find the best matching article title
        const openSearchUrl = `https://en.wikipedia.org/w/api.php?action=opensearch&format=json&limit=1&search=${encodeURIComponent(query)}`;
        const { data: osData } = await httpRequest(openSearchUrl, {
            headers: {
                'User-Agent': 'Tricorder/2.0 (image search helper)',
                'Accept': 'application/json',
            },
            maxBytes: 20000,
        });
        let openSearch;
        try { openSearch = JSON.parse(osData); }
        catch { return null; }
        const title = openSearch?.[1]?.[0];
        const pageUrl = openSearch?.[3]?.[0];
        if (!title) return null;

        // Step 2: page summary REST endpoint gives thumbnail + originalimage
        const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`;
        const { data: sumData, statusCode } = await httpRequest(summaryUrl, {
            headers: {
                'User-Agent': 'Tricorder/2.0 (image search helper)',
                'Accept': 'application/json',
            },
            maxBytes: 60000,
        });
        if (statusCode >= 400) return null;
        let summary;
        try { summary = JSON.parse(sumData); }
        catch { return null; }
        const rawThumb = summary.thumbnail?.source;
        if (!rawThumb) return null;
        const rawOrig = summary.originalimage?.source || rawThumb;

        return {
            title: summary.title || title,
            thumbnail: imgProxyUrl(rawThumb),
            image: imgProxyUrl(rawOrig),
            source: pageUrl || `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`,
            provider: 'wikipedia',
            description: (summary.extract || '').substring(0, 240),
        };
    } catch (err) {
        log('DEBUG', 'WEB', `Wikipedia image fetch failed: ${err.message}`);
        return null;
    }
}

async function fetchOpenGraphImages(urls, max = 3) {
    const out = [];
    // Parallel with a hard 3s per-URL budget — one slow page must not stall
    // the whole web_search tool call.
    const OG_TIMEOUT_MS = 3000;
    const withTimeout = (p) => Promise.race([p, new Promise(resolve => setTimeout(() => resolve(null), OG_TIMEOUT_MS))]);
    const jobs = urls.slice(0, max).map((u) => withTimeout((async () => {
        try {
            const { data, statusCode } = await httpRequest(u, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                },
                maxBytes: 80000,
            });
            if (statusCode >= 400) return null;
            const ogMatch = data.match(/<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]*content=["']([^"']+)["']/i) ||
                            data.match(/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:image(?::secure_url)?["']/i) ||
                            data.match(/<meta[^>]+name=["']twitter:image(?::src)?["'][^>]*content=["']([^"']+)["']/i);
            if (!ogMatch) return null;
            let rawImg = ogMatch[1].replace(/&amp;/g, '&').trim();
            if (rawImg.startsWith('//')) rawImg = 'https:' + rawImg;
            else if (rawImg.startsWith('/')) {
                try { rawImg = new URL(rawImg, u).href; } catch { return null; }
            }
            // Validate the extracted URL
            try {
                const pu = new URL(rawImg);
                if (isPrivateHost(pu.hostname)) return null;
            } catch { return null; }
            const titleMatch = data.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i) ||
                               data.match(/<title[^>]*>([^<]+)<\/title>/i);
            const title = (titleMatch ? titleMatch[1].trim() : u).substring(0, 200);
            return {
                title,
                thumbnail: imgProxyUrl(rawImg),
                image: imgProxyUrl(rawImg),
                source: u,
                provider: 'opengraph',
            };
        } catch { return null; }
    })()));
    const settled = await Promise.all(jobs);
    for (const r of settled) if (r) out.push(r);
    return out;
}

// --- Web tool result cache ---------------------------------------------------
// Small in-memory LRU with TTL for web_search and web_fetch results. Repeat
// queries within the TTL window (common in multi-step agent loops) skip the
// network round-trip. Only successful responses are cached.
const _webToolCache = new Map(); // key → { at, value }
const WEB_CACHE_MAX = 50;
const WEB_CACHE_TTL_MS = 10 * 60 * 1000;
function webCacheGet(key) {
    const hit = _webToolCache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > WEB_CACHE_TTL_MS) { _webToolCache.delete(key); return null; }
    _webToolCache.delete(key);
    _webToolCache.set(key, hit); // refresh LRU position
    return hit.value;
}
function webCacheSet(key, value) {
    _webToolCache.set(key, { at: Date.now(), value });
    if (_webToolCache.size > WEB_CACHE_MAX) _webToolCache.delete(_webToolCache.keys().next().value);
}

// Combines DuckDuckGo + Wikipedia + OpenGraph images. Runs the primary sources
// in parallel; falls back to OpenGraph on the top text results if needed.
async function gatherImagesForQuery(query, textResults, opts = {}) {
    const maxImages = opts.maxImages || 6;
    const [ddg, wiki] = await Promise.all([
        fetchDuckDuckGoImages(query, 4).catch(() => []),
        fetchWikipediaImage(query).catch(() => null),
    ]);
    const out = [];
    const seen = new Set();
    if (wiki && wiki.image && !seen.has(wiki.image)) { out.push(wiki); seen.add(wiki.image); }
    for (const im of ddg) {
        if (out.length >= maxImages) break;
        if (seen.has(im.image)) continue;
        seen.add(im.image);
        out.push(im);
    }
    if (out.length < 3 && Array.isArray(textResults) && textResults.length > 0) {
        const urls = textResults.map(r => r.url).filter(Boolean).slice(0, 3);
        const og = await fetchOpenGraphImages(urls, 3).catch(() => []);
        for (const im of og) {
            if (out.length >= maxImages) break;
            if (seen.has(im.image)) continue;
            seen.add(im.image);
            out.push(im);
        }
    }
    return out.slice(0, maxImages);
}

// --- Structured HTML Scraper Helpers ---
// Pure regex-based extraction for tables, headings, metadata, links, JSON-LD.
// Zero dependencies. Good enough for most sites; fails gracefully on messy markup.

function htmlDecode(s) {
    if (!s) return '';
    return String(s)
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
        .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function stripTags(html) {
    return htmlDecode(String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

function scrubScripts(html) {
    return String(html || '')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ');
}

function extractMeta(html) {
    const meta = { description: null, keywords: null, author: null, og: {}, twitter: {}, canonical: null };
    const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
    if (title) meta.title = stripTags(title);

    const metaRe = /<meta\b([^>]*)>/gi;
    let m;
    while ((m = metaRe.exec(html)) !== null) {
        const attrs = m[1];
        const name = (attrs.match(/\bname\s*=\s*["']([^"']+)["']/i) || [])[1];
        const prop = (attrs.match(/\bproperty\s*=\s*["']([^"']+)["']/i) || [])[1];
        const content = (attrs.match(/\bcontent\s*=\s*["']([^"']*)["']/i) || [])[1];
        if (!content) continue;
        const decoded = htmlDecode(content);
        const key = (name || prop || '').toLowerCase();
        if (!key) continue;
        if (key === 'description') meta.description = decoded;
        else if (key === 'keywords') meta.keywords = decoded;
        else if (key === 'author') meta.author = decoded;
        else if (key.startsWith('og:')) meta.og[key.slice(3)] = decoded;
        else if (key.startsWith('twitter:')) meta.twitter[key.slice(8)] = decoded;
    }

    const canonical = html.match(/<link[^>]+rel\s*=\s*["']canonical["'][^>]*href\s*=\s*["']([^"']+)["']/i);
    if (canonical) meta.canonical = htmlDecode(canonical[1]);
    return meta;
}

function extractHeadings(html, max = 60) {
    const headings = [];
    const re = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
    let m;
    while ((m = re.exec(html)) !== null && headings.length < max) {
        const text = stripTags(m[2]);
        if (text) headings.push({ level: parseInt(m[1], 10), text });
    }
    return headings;
}

function extractLinks(html, baseUrl, max = 80) {
    const links = [];
    const seen = new Set();
    const re = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(html)) !== null && links.length < max) {
        let href = htmlDecode(m[1]);
        if (!href || href.startsWith('#') || href.startsWith('javascript:')) continue;
        try { if (baseUrl) href = new URL(href, baseUrl).href; } catch { /* keep raw */ }
        if (seen.has(href)) continue;
        seen.add(href);
        const text = stripTags(m[2]).slice(0, 200);
        links.push({ href, text });
    }
    return links;
}

function extractImages(html, baseUrl, max = 40) {
    const images = [];
    const seen = new Set();
    const re = /<img\b[^>]*>/gi;
    let m;
    while ((m = re.exec(html)) !== null && images.length < max) {
        const tag = m[0];
        const src = (tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i) || [])[1];
        if (!src) continue;
        let full = htmlDecode(src);
        try { if (baseUrl) full = new URL(full, baseUrl).href; } catch {}
        if (seen.has(full)) continue;
        seen.add(full);
        const alt = (tag.match(/\balt\s*=\s*["']([^"']*)["']/i) || [])[1] || '';
        images.push({ src: full, alt: htmlDecode(alt) });
    }
    return images;
}

function extractTables(html, max = 20) {
    const tables = [];
    const tableRe = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;
    let t;
    while ((t = tableRe.exec(html)) !== null && tables.length < max) {
        const inner = t[1];
        const captionMatch = /<caption\b[^>]*>([\s\S]*?)<\/caption>/i.exec(inner);
        const caption = captionMatch ? stripTags(captionMatch[1]) : null;

        const rows = [];
        const rowFlags = [];
        const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
        let r;
        while ((r = rowRe.exec(inner)) !== null) {
            const rowHtml = r[1];
            const cells = [];
            let hasTh = false;
            const cellRe = /<(t[hd])\b[^>]*>([\s\S]*?)<\/\1>/gi;
            let c;
            while ((c = cellRe.exec(rowHtml)) !== null) {
                if (c[1].toLowerCase() === 'th') hasTh = true;
                cells.push(stripTags(c[2]));
            }
            if (cells.length > 0) {
                rows.push(cells);
                rowFlags.push(hasTh);
            }
        }
        if (rows.length === 0) continue;

        let headers = null;
        let dataRows = rows;
        if (rowFlags[0]) {
            headers = rows[0];
            dataRows = rows.slice(1);
        }
        const colCount = rows.reduce((mx, row) => Math.max(mx, row.length), 0);
        tables.push({
            caption,
            headers,
            rows: dataRows,
            rowCount: dataRows.length,
            colCount,
        });
    }
    return tables;
}

function extractJsonLd(html, max = 10) {
    const results = [];
    const re = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = re.exec(html)) !== null && results.length < max) {
        try { results.push(JSON.parse(m[1].trim())); }
        catch { /* malformed JSON-LD; skip */ }
    }
    return results;
}

function extractMainText(html, maxChars = 15000) {
    const cleaned = scrubScripts(html)
        .replace(/<(nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi, ' ');
    const text = stripTags(cleaned);
    return text.length > maxChars ? text.substring(0, maxChars) + '\n[...truncated]' : text;
}

// Aggressively reduce an HTML page to readable article text for LLM
// consumption. Strips the noise that bloats web_fetch/fact_check output and
// that the model otherwise complains about: scripts, stylesheets, the entire
// <head>, SVG icon path data, navigation/footer/cookie chrome, and forms.
// Prefers a <main>/<article> region when the page marks one up, and preserves
// paragraph breaks so the result reads as text rather than one giant line.
function htmlToReadableText(html, maxChars = 15000) {
    let h = String(html || '');

    // The <head> is pure meta/link/script/style boilerplate — drop it whole.
    h = h.replace(/<head\b[\s\S]*?<\/head>/gi, ' ');

    // Scripts, styles, noscript, HTML comments.
    h = scrubScripts(h);

    // Non-textual and page-chrome elements (content included).
    h = h
        .replace(/<svg\b[\s\S]*?<\/svg>/gi, ' ')
        .replace(/<math\b[\s\S]*?<\/math>/gi, ' ')
        .replace(/<(nav|header|footer|aside|form|iframe|template|figure|button|select)\b[\s\S]*?<\/\1>/gi, ' ');

    // Prefer the primary content region when the page declares one.
    const mainMatch = h.match(/<(?:main|article)\b[^>]*>([\s\S]*?)<\/(?:main|article)>/i);
    if (mainMatch && stripTags(mainMatch[1]).length > 200) h = mainMatch[1];

    // Turn block-level boundaries into newlines before stripping tags so the
    // text keeps paragraph/heading/list structure instead of collapsing.
    h = h
        .replace(/<br\b[^>]*\/?>/gi, '\n')
        .replace(/<\/(p|div|section|article|h[1-6]|li|tr|ul|ol|table|blockquote)\s*>/gi, '\n');

    let text = htmlDecode(h.replace(/<[^>]+>/g, ' '));

    // Collapse runs of spaces and blank lines.
    text = text
        .replace(/[ \t\f\v]+/g, ' ')
        .replace(/ *\n */g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    return text.length > maxChars ? text.substring(0, maxChars) + '\n[...truncated]' : text;
}

function scrapeHtml(html, { url = '', include = null } = {}) {
    const sections = include && Array.isArray(include) && include.length > 0
        ? new Set(include.map(s => String(s).toLowerCase()))
        : null;
    const want = (key) => !sections || sections.has(key);

    const out = { url };
    if (want('meta'))       out.meta     = extractMeta(html);
    if (want('headings'))   out.headings = extractHeadings(html);
    if (want('tables'))     out.tables   = extractTables(html);
    if (want('links'))      out.links    = extractLinks(html, url);
    if (want('images'))     out.images   = extractImages(html, url);
    if (want('jsonld'))     out.jsonLd   = extractJsonLd(html);
    if (want('text'))       out.text     = extractMainText(html);
    return out;
}

async function fetchAndScrape(targetUrl, { include = null, maxBytes = 200000, onProgress = null, blockPrivate = false } = {}) {
    const { statusCode, data } = await httpRequest(targetUrl, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
        },
        maxBytes,
        onProgress,
        blockPrivate,
    });
    const scraped = scrapeHtml(data, { url: targetUrl, include });
    scraped.status = statusCode;
    return scraped;
}

// --- Web Fetch API (for LLM internet access via tool calls) ---
async function handleWebFetchApi(req, res, reqId) {
    if (req.method !== 'POST') {
        jsonRes(res, 405, { error: 'Method not allowed' });
        return;
    }

    const body = await readJsonBody(req);
    const endpoint = req.url.replace('/api/web/', '').split('?')[0];

    if (endpoint === 'fetch') {
        const { url: targetUrl } = body;
        if (!targetUrl) { jsonRes(res, 400, { error: 'url parameter required' }); return; }

        log('INFO', 'WEB', `#${reqId} Fetching URL: ${targetUrl}`);

        try {
            const maxBytes = 50000;
            const { statusCode, data, totalBytes } = await httpRequest(targetUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7',
                },
                maxBytes,
                blockPrivate: true,
            });

            let text = data
                .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                .replace(/<[^>]+>/g, ' ')
                .replace(/\s{2,}/g, ' ')
                .trim();

            if (text.length > 15000) text = text.substring(0, 15000) + '\n[...truncated]';

            const result = {
                status: statusCode,
                url: targetUrl,
                title: (data.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]?.trim() || '',
                content: text,
                truncated: totalBytes > maxBytes,
            };

            log('INFO', 'WEB', `#${reqId} Fetched ${targetUrl} (${result.status}, ${result.content.length} chars)`);
            jsonRes(res, 200, result);
        } catch (e) {
            log('ERROR', 'WEB', `#${reqId} Fetch failed: ${e.message}`);
            jsonRes(res, 200, { error: e.message, url: targetUrl, content: '' });
        }
        return;
    }

    if (endpoint === 'search') {
        const { query, include_images } = body;
        if (!query) { jsonRes(res, 400, { error: 'query parameter required' }); return; }

        log('INFO', 'WEB', `#${reqId} Web search: "${query}"`);

        try {
            const searchUrl = 'https://html.duckduckgo.com/html/';
            const formBody = `q=${encodeURIComponent(query)}`;

            const { data } = await httpRequest(searchUrl, {
                method: 'POST',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Content-Length': Buffer.byteLength(formBody),
                    'Referer': 'https://html.duckduckgo.com/',
                    'Origin': 'https://html.duckduckgo.com',
                },
                body: formBody,
            });

            const results = [];
            const resultRegex = /<a[^>]+class="result__a"[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
            let match;
            while ((match = resultRegex.exec(data)) !== null && results.length < 8) {
                const href = decodeURIComponent((match[1].match(/uddg=([^&]*)/) || [])[1] || match[1]);
                results.push({
                    title: match[2].replace(/<[^>]+>/g, '').trim(),
                    url: href,
                    snippet: match[3].replace(/<[^>]+>/g, '').trim(),
                });
            }

            let images = [];
            if (include_images !== false) {
                images = await gatherImagesForQuery(query, results, { maxImages: 6 });
            }

            log('INFO', 'WEB', `#${reqId} Search returned ${results.length} results, ${images.length} images`);
            jsonRes(res, 200, { query, results, images });
        } catch (e) {
            log('ERROR', 'WEB', `#${reqId} Search failed: ${e.message}`);
            jsonRes(res, 200, { query, results: [], images: [], error: e.message });
        }
        return;
    }

    if (endpoint === 'scrape') {
        const { url: targetUrl, include, max_bytes } = body;
        if (!targetUrl) { jsonRes(res, 400, { error: 'url parameter required' }); return; }

        log('INFO', 'WEB', `#${reqId} Scraping URL: ${targetUrl}`);
        try {
            const scraped = await fetchAndScrape(targetUrl, {
                include: Array.isArray(include) ? include : null,
                maxBytes: Math.min(Math.max(parseInt(max_bytes, 10) || 200000, 10000), 1000000),
                blockPrivate: true,
            });
            log('INFO', 'WEB', `#${reqId} Scraped ${targetUrl} (${scraped.status}, ${scraped.tables?.length || 0} tables, ${scraped.headings?.length || 0} headings)`);
            jsonRes(res, 200, scraped);
        } catch (e) {
            log('ERROR', 'WEB', `#${reqId} Scrape failed: ${e.message}`);
            jsonRes(res, 200, { error: e.message, url: targetUrl });
        }
        return;
    }

    jsonRes(res, 404, { error: 'Unknown web API endpoint' });
}

// --- Shared State (tasks, notifications) ---
// Declared here so both the tool execution API and the dedicated task/notification
// handlers can access them. Originally at the bottom of the file.
const tasks = [];
let taskIdCounter = 0;
const notifications = [];

// --- Persistent Memory Store ---
// Simple JSON-file-backed key-value memory for the agent.
// Persists across server restarts. Stored at ~/.tricorder-agent/memory.json
const MEMORY_DIR = path.join(os.homedir(), '.tricorder-agent');
const MEMORY_FILE = path.join(MEMORY_DIR, 'memory.json');

// --- Crash-safe JSON persistence -------------------------------------------
// Writing JSON stores directly with writeFileSync means a crash mid-write
// leaves a truncated, unparseable file — total data loss. Instead: write to a
// .tmp sibling and rename it over the target (atomic on the same filesystem).
// Additionally, once per process start, the last known-good version is copied
// to file+'.bak' before the first overwrite, so loadMemory() can recover from
// a corrupted store.
const _backedUpFiles = new Set();
function atomicWriteJson(file, data, { pretty = true } = {}) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!_backedUpFiles.has(file)) {
        _backedUpFiles.add(file);
        try {
            if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak');
        } catch (e) {
            log('WARN', 'STORE', `Failed to back up ${path.basename(file)}: ${e.message}`);
        }
    }
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data), 'utf8');
    fs.renameSync(tmp, file);
}

// --- In-process memory mutex ------------------------------------------------
// Multiple writers (tool case memory_store, nightly chat review, memory API,
// server-side agent loops) do load → mutate → save on the same file. Without
// serialisation, concurrent read-modify-write cycles silently drop each
// other's updates. withMemoryLock() chains all mutations onto one promise
// tail so they run strictly one after another.
let _memoryLockTail = Promise.resolve();
function withMemoryLock(fn) {
    const run = _memoryLockTail.then(() => fn());
    // Keep the chain alive even when a mutation fails.
    _memoryLockTail = run.catch(() => {});
    return run;
}

// In-memory cache: hot paths (system-prompt build, scheduler loop) call
// loadMemory() constantly — hit disk only on first use, then serve the cache.
let _memoryCache = null;
function loadMemory() {
    if (_memoryCache) return _memoryCache;
    let raw = null;
    try {
        raw = fs.readFileSync(MEMORY_FILE, 'utf8');
    } catch {
        // No store yet (fresh install) — start empty.
        _memoryCache = {};
        return _memoryCache;
    }
    try {
        _memoryCache = JSON.parse(raw);
    } catch (e) {
        // Corrupted store: fall back to the last known-good backup instead of
        // silently wiping everything with an empty object.
        try {
            _memoryCache = JSON.parse(fs.readFileSync(MEMORY_FILE + '.bak', 'utf8'));
            log('WARN', 'MEMORY', `memory.json is corrupted (${e.message}) — recovered from memory.json.bak`);
            // Don't let the next save "back up" the corrupt file over the
            // good .bak we just recovered from.
            _backedUpFiles.add(MEMORY_FILE);
        } catch {
            log('WARN', 'MEMORY', `memory.json is corrupted (${e.message}) and no usable backup exists — starting empty`);
            _memoryCache = {};
        }
    }
    return _memoryCache;
}

function saveMemory(mem) {
    try {
        atomicWriteJson(MEMORY_FILE, mem);
        _memoryCache = mem;
    } catch (e) {
        log('ERROR', 'MEMORY', `Failed to save memory: ${e.message}`);
    }
}

// --- Persistent Tasks Store ---
// Scheduled tasks must survive server restarts — a 09:00 job is useless if
// it's wiped every reboot. We
// persist the in-memory tasks[] array to ~/.tricorder-agent/tasks.json and rehydrate
// it on startup, recomputing nextRun so a job missed while the server was down
// gets rescheduled to its next occurrence.
const TASKS_FILE = path.join(MEMORY_DIR, 'tasks.json');

function saveTasks() {
    try {
        atomicWriteJson(TASKS_FILE, tasks);
    } catch (e) {
        log('ERROR', 'TASKS', `Failed to persist tasks: ${e.message}`);
    }
}

function loadPersistedTasks() {
    let saved;
    try { saved = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8')); }
    catch { return; }
    if (!Array.isArray(saved)) return;
    let maxId = 0;
    for (const t of saved) {
        if (!t || !t.id) continue;
        // Tasks left mid-run when the server stopped should not be stuck
        // "running" forever — reset them so the scheduler can pick them up.
        if (t.status === 'running') t.status = t.schedule ? 'pending' : 'completed';
        if (t.schedule && t.enabled !== false) {
            t.status = 'pending';
            try { t.nextRun = computeNextRun(t); } catch { /* keep stored nextRun */ }
        }
        tasks.push(t);
        const m = String(t.id).match(/^task_(\d+)_/);
        if (m) maxId = Math.max(maxId, parseInt(m[1], 10));
    }
    taskIdCounter = Math.max(taskIdCounter, maxId);
    if (tasks.length) log('INFO', 'TASKS', `Restored ${tasks.length} persisted task(s) from ${TASKS_FILE}`);
}
loadPersistedTasks();

// --- Server-Side Chat Log Storage ---
// Persists chat logs to ~/.tricorder-agent/chatlogs/ as individual JSON files
const CHATLOGS_DIR = path.join(MEMORY_DIR, 'chatlogs');

function _ensureChatlogsDir() {
    fs.mkdirSync(CHATLOGS_DIR, { recursive: true });
}

function saveChatlog(id, data) {
    _ensureChatlogsDir();
    const filePath = path.join(CHATLOGS_DIR, `${id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    log('DEBUG', 'CHATLOGS', `Saved chatlog ${id} (${data.messages?.length || 0} messages)`);
}

function loadChatlog(id) {
    try {
        return JSON.parse(fs.readFileSync(path.join(CHATLOGS_DIR, `${id}.json`), 'utf8'));
    } catch { return null; }
}

function listChatlogs() {
    _ensureChatlogsDir();
    try {
        const files = fs.readdirSync(CHATLOGS_DIR).filter(f => f.endsWith('.json'));
        const chats = [];
        for (const f of files) {
            try {
                const data = JSON.parse(fs.readFileSync(path.join(CHATLOGS_DIR, f), 'utf8'));
                chats.push({
                    id: data.id || f.replace('.json', ''),
                    title: data.title || 'Untitled',
                    createdAt: data.createdAt || 0,
                    messageCount: data.messages?.length || 0,
                    reviewed: !!data.reviewed,
                });
            } catch {}
        }
        return chats.sort((a, b) => b.createdAt - a.createdAt);
    } catch { return []; }
}

function deleteChatlog(id) {
    try {
        fs.unlinkSync(path.join(CHATLOGS_DIR, `${id}.json`));
        return true;
    } catch { return false; }
}

/* ============================================================================
   MEMORY RANKING — embeddings + BM25
   ----------------------------------------------------------------------------
   Memory is ranked before it is injected into the system prompt, so a large
   memory store costs context proportional to relevance rather than size.
   Semantic ranking uses the backend's /v1/embeddings when an embedding model
   is loaded; BM25 always works and is the fallback when it isn't.
   ============================================================================ */

const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-qwen3-embedding-0.6b';
const EMBEDDING_DISABLED = process.env.EMBEDDING_DISABLED === '1';
// Where to fetch embeddings. Defaults to the main LM Studio backend, but can
// be pointed at any OpenAI-compatible /v1/embeddings host. Without an
// embedding model loaded, semantic search falls back to BM25-only.
const EMBEDDING_TARGET = process.env.EMBEDDING_URL || LLM_TARGET;

// In-memory cache of parsed store for faster reads
let _vectorStoreCache = null;
let _vectorEmbeddingUnavailableUntil = 0; // debounce failed embedding calls
// The configured embedding model may simply not exist on the target server —
// e.g. LM Studio without the Qwen3 embedding model downloaded rejects every
// /v1/embeddings call with "No models loaded". Resolve the model against the
// server's /v1/models list once: keep the configured id when it's offered,
// otherwise fall back to any embedding-capable model that IS available (LM
// Studio ships nomic-embed by default). Resolution failures (server down)
// keep the configured name and retry later.
let _resolvedEmbeddingModel = null;
let _embeddingResolveRetryAt = 0;
async function resolveEmbeddingModel() {
    if (_resolvedEmbeddingModel) return _resolvedEmbeddingModel;
    if (Date.now() < _embeddingResolveRetryAt) return EMBEDDING_MODEL;
    _embeddingResolveRetryAt = Date.now() + 60000;
    try {
        const targetUrl = new URL('/v1/models', EMBEDDING_TARGET).href;
        const { statusCode, data } = await httpRequest(targetUrl, {
            headers: { ...(LM_STUDIO_API_KEY ? { Authorization: `Bearer ${LM_STUDIO_API_KEY}` } : {}) },
        });
        if (statusCode !== 200) return EMBEDDING_MODEL;
        const ids = (JSON.parse(data)?.data || []).map(m => m && m.id).filter(Boolean);
        if (ids.includes(EMBEDDING_MODEL)) {
            _resolvedEmbeddingModel = EMBEDDING_MODEL;
        } else {
            const fallback = ids.find(id => /embed/i.test(id));
            if (fallback) {
                _resolvedEmbeddingModel = fallback;
                log('WARN', 'VECTOR', `Embedding model "${EMBEDDING_MODEL}" not available at ${EMBEDDING_TARGET} — using "${fallback}" instead. Load the configured model (lms load ${EMBEDDING_MODEL}) or set EMBEDDING_MODEL to silence this.`);
            }
        }
    } catch { /* server unreachable — keep configured name, retry in 60s */ }
    return _resolvedEmbeddingModel || EMBEDDING_MODEL;
}

// Bumped whenever tokenize() changes behaviour. Docs persisted with an older
// tokenizer get re-tokenised once on load so stored term frequencies stay
// consistent with query-time tokenisation.
// Bumped when tokenisation changes, so anything that cached term frequencies
// under an older tokenizer is re-tokenised once instead of silently scoring
// against a stale vocabulary.
const TOKENIZER_VERSION = 2;

// Short English + German stopwords — good enough for BM25 noise reduction
const STOPWORDS = new Set([
    // English
    'a','an','the','and','or','but','if','then','else','for','to','of','in','on','at','by','with',
    'is','are','was','were','be','been','being','have','has','had','do','does','did','this','that',
    'these','those','i','you','he','she','it','we','they','them','his','her','its','our','their',
    'as','from','so','than','too','very','can','will','just','not','no','yes','up','down','out',
    'about','into','over','under','again','more','most','some','any','all','each','every','only',
    // German
    'der','die','das','und','oder','nicht','ein','eine','einen','einem','einer','eines','ist','sind',
    'war','waren','mit','für','auf','von','zu','zum','zur','im','an','am','bei','nach','über','unter',
    'auch','aber','wenn','dann','noch','nur','schon','wie','was','wer','wo','ich','du','er','sie','es',
    'wir','ihr','mein','dein','sein','seine','ihre','haben','hat','hatte','hatten','werden','wird',
    'wurde','wurden','kann','können','muss','müssen','soll','sollen','will','wollen','mag','möchte',
    'dass','als','aus','dem','den','des','um','bis','durch','gegen','ohne','man','sich','doch','ja',
    'nein','sehr','mehr','etwas','nichts','alle','alles','kein','keine','beim','vom','ans','ins',
]);

// Light German suffix stripping (harmless for English plurals/verb endings
// too): words of 5+ chars lose a trailing en/er/es/e/n/s so inflected forms
// ("Termine", "Terminen") collapse onto one stem ("termin"). Applied both at
// index time and at query time — see TOKENIZER_VERSION migration above.
const _STEM_SUFFIXES = ['en', 'er', 'es', 'e', 'n', 's'];
function stemToken(t) {
    // Strip repeatedly so inflection chains converge on one stem — otherwise
    // "termine"→"termin" but "termin"→"termi" would never match each other.
    let s = t;
    let changed = true;
    while (changed && s.length >= 5) {
        changed = false;
        for (const suf of _STEM_SUFFIXES) {
            if (s.endsWith(suf) && s.length - suf.length >= 3) {
                s = s.slice(0, s.length - suf.length);
                changed = true;
                break;
            }
        }
    }
    return s;
}

function tokenize(text) {
    const clean = String(text || '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
        .split(/\s+/);
    const tokens = [];
    for (const t of clean) {
        if (!t || t.length < 2 || t.length > 32) continue;
        if (STOPWORDS.has(t)) continue;
        tokens.push(stemToken(t));
    }
    return tokens;
}

function termFreq(tokens) {
    const tf = Object.create(null);
    for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
    return tf;
}

function cosineSim(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na  += a[i] * a[i];
        nb  += b[i] * b[i];
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Compute BM25 scores for all docs in a collection against a tokenised query.
function bm25Scores(queryTokens, docs, { k1 = 1.5, b = 0.75 } = {}) {
    const N = docs.length || 1;
    const avgDocLen = docs.reduce((s, d) => s + (d.tokenCount || 0), 0) / N || 1;
    const df = Object.create(null);
    for (const t of queryTokens) {
        if (df[t] != null) continue;
        let c = 0;
        for (const d of docs) if (d.tokenFreq && d.tokenFreq[t]) c++;
        df[t] = c;
    }
    const scores = new Array(docs.length).fill(0);
    for (let i = 0; i < docs.length; i++) {
        const d = docs[i];
        const dl = d.tokenCount || 0;
        let s = 0;
        for (const t of queryTokens) {
            const f = (d.tokenFreq && d.tokenFreq[t]) || 0;
            if (!f) continue;
            const idf = Math.log(1 + (N - df[t] + 0.5) / (df[t] + 0.5));
            const norm = (f * (k1 + 1)) / (f + k1 * (1 - b + b * (dl / avgDocLen)));
            s += idf * norm;
        }
        scores[i] = s;
    }
    return scores;
}
// Fetch embeddings for one or many texts in a single request (the
// OpenAI-compatible /v1/embeddings endpoint accepts an input array). Returns
// an array aligned with `texts` (null slots for failed items), or null when
// the backend is unavailable. Silently disables itself for 60s after a
// failure to avoid spam.
async function fetchEmbeddings(texts) {
    if (EMBEDDING_DISABLED) return null;
    if (Date.now() < _vectorEmbeddingUnavailableUntil) return null;
    const inputs = (Array.isArray(texts) ? texts : [texts]).map(t => String(t || '').substring(0, 8000));
    if (!inputs.length || inputs.every(t => !t)) return null;
    try {
        const model = await resolveEmbeddingModel();
        const payload = JSON.stringify({ model, input: inputs.length === 1 ? inputs[0] : inputs });
        const targetUrl = new URL('/v1/embeddings', EMBEDDING_TARGET).href;
        const { statusCode, data } = await httpRequest(targetUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
                ...(LM_STUDIO_API_KEY ? { Authorization: `Bearer ${LM_STUDIO_API_KEY}` } : {}),
            },
            body: payload,
        });
        if (statusCode !== 200) {
            _vectorEmbeddingUnavailableUntil = Date.now() + 60000;
            return null;
        }
        const json = JSON.parse(data);
        const rows = json?.data;
        if (!Array.isArray(rows) || rows.length === 0) return null;
        // Respect the per-row index field (the API may reorder results).
        const out = new Array(inputs.length).fill(null);
        for (let i = 0; i < rows.length; i++) {
            const r = rows[i];
            if (!r || !Array.isArray(r.embedding) || r.embedding.length === 0) continue;
            const idx = Number.isInteger(r.index) ? r.index : i;
            if (idx >= 0 && idx < out.length) out[idx] = r.embedding;
        }
        return out;
    } catch (e) {
        _vectorEmbeddingUnavailableUntil = Date.now() + 60000;
        log('DEBUG', 'VECTOR', `Embedding unavailable: ${e.message}`);
        return null;
    }
}

// Fetch embedding from the backend. Returns number[] or null on failure.
async function fetchEmbedding(text) {
    const batch = await fetchEmbeddings([text]);
    return (batch && batch[0]) || null;
}

// LRU cache for query embeddings — repeated searches for the same query (e.g.
// per-turn memory ranking with an unchanged prompt) skip the embedding call.
const _queryEmbedCache = new Map(); // cacheKey → embedding
const QUERY_EMBED_CACHE_MAX = 100;
async function fetchQueryEmbedding(text) {
    const snippet = String(text || '').substring(0, 8000);
    if (!snippet) return null;
    const key = `${_resolvedEmbeddingModel || EMBEDDING_MODEL}:${snippet}`;
    if (_queryEmbedCache.has(key)) {
        const v = _queryEmbedCache.get(key);
        _queryEmbedCache.delete(key);
        _queryEmbedCache.set(key, v); // refresh LRU position
        return v;
    }
    const emb = await fetchEmbedding(snippet);
    if (emb) {
        _queryEmbedCache.set(key, emb);
        if (_queryEmbedCache.size > QUERY_EMBED_CACHE_MAX) {
            _queryEmbedCache.delete(_queryEmbedCache.keys().next().value);
        }
    }
    return emb;
}

// --- Memory relevance scoring (BM25 over the memory store) -------------------
// Treats every memory entry (key + value + tags) as a mini corpus document and
// ranks it against a free-text query. Shared by GET /api/memory/relevant and
// the memory_recall tool. Returns [{ key, value, category, tags, updatedAt,
// score }] sorted by score desc, then updatedAt desc.
function scoreMemoryEntries(query, mem, k = 10) {
    const qTokens = tokenize(query);
    if (!qTokens.length) return [];
    const entries = Object.entries(mem || {}).filter(([key]) => key !== 'chat_improvements');
    if (!entries.length) return [];
    const docs = entries.map(([key, entry]) => {
        const value = entry && typeof entry === 'object' ? entry.value : entry;
        const tags = (entry && Array.isArray(entry.tags)) ? entry.tags : [];
        const tokens = tokenize(`${key.replace(/_/g, ' ')} ${value ?? ''} ${tags.join(' ')}`);
        return { key, entry, tokenCount: tokens.length, tokenFreq: termFreq(tokens) };
    });
    const scores = bm25Scores(qTokens, docs);
    const kMax = Math.max(1, Math.min(parseInt(k, 10) || 10, 50));
    return docs
        .map((d, i) => ({ d, score: scores[i] }))
        .filter(r => r.score > 0)
        .sort((a, b) => (b.score - a.score)
            || ((Date.parse(b.d.entry?.updatedAt) || 0) - (Date.parse(a.d.entry?.updatedAt) || 0)))
        .slice(0, kMax)
        .map(r => ({
            key: r.d.key,
            value: r.d.entry && typeof r.d.entry === 'object' ? r.d.entry.value : r.d.entry,
            category: (r.d.entry && r.d.entry.category) || null,
            tags: (r.d.entry && r.d.entry.tags) || [],
            updatedAt: (r.d.entry && r.d.entry.updatedAt) || null,
            score: Number(r.score.toFixed(4)),
        }));
}

// Lazy per-entry embedding cache for hybrid memory ranking. Embeddings are
// NEVER persisted into memory.json — they live only in this process-local map
// and are recomputed when an entry's value changes (hash mismatch).
const _memEmbedCache = new Map(); // key → { hash, embedding }
function _memValueHash(value) {
    return crypto.createHash('sha1').update(String(value ?? '')).digest('hex');
}

// Hybrid variant: BM25 first, then — if an embedding backend answers within
// `budgetMs` — blend in cosine similarity over cached entry embeddings.
// Falls back to pure BM25 on timeout or any embedding failure.
async function scoreMemoryEntriesHybrid(query, mem, k = 10, budgetMs = 800) {
    const bm = scoreMemoryEntries(query, mem, k);
    if (EMBEDDING_DISABLED || Date.now() < _vectorEmbeddingUnavailableUntil) return bm;
    if (!bm.length) return bm;
    try {
        const deadline = new Promise(resolve => setTimeout(() => resolve(null), budgetMs));
        const mixed = await Promise.race([deadline, (async () => {
            const qEmbedding = await fetchQueryEmbedding(query);
            if (!qEmbedding) return null;
            // Only embed the BM25 candidates (small set) — lazily, cache-first.
            const missing = bm.filter(e => {
                const c = _memEmbedCache.get(e.key);
                return !c || c.hash !== _memValueHash(e.value);
            });
            if (missing.length) {
                const embs = await fetchEmbeddings(missing.map(e => `${e.key.replace(/_/g, ' ')}: ${e.value}`));
                if (embs) {
                    for (let i = 0; i < missing.length; i++) {
                        if (embs[i]) _memEmbedCache.set(missing[i].key, { hash: _memValueHash(missing[i].value), embedding: embs[i] });
                    }
                    // Bound the cache — the memory store is small, but be safe.
                    while (_memEmbedCache.size > 500) _memEmbedCache.delete(_memEmbedCache.keys().next().value);
                }
            }
            const maxBm = Math.max(1e-9, ...bm.map(e => e.score));
            return bm
                .map(e => {
                    const cached = _memEmbedCache.get(e.key);
                    const emb = cached && cached.hash === _memValueHash(e.value) ? cached.embedding : null;
                    const bmNorm = e.score / maxBm;
                    const score = (emb && emb.length === qEmbedding.length)
                        ? 0.5 * cosineSim(qEmbedding, emb) + 0.5 * bmNorm
                        : 0.5 * bmNorm;
                    return { ...e, score: Number(score.toFixed(4)) };
                })
                .sort((a, b) => (b.score - a.score)
                    || ((Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0)));
        })()]);
        return mixed || bm;
    } catch {
        return bm; // any embedding hiccup → BM25-only result
    }
}

// --- "Known improvements" list -----------------------------------------------
// mem['chat_improvements'].value holds a JSON array. Internally each item is
// { text, addedAt } so stale suggestions can expire; the public APIs keep
// delivering plain strings (the frontend renders the array as-is).
const IMPROVEMENT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const IMPROVEMENT_CAP = 20;

// Parse the stored improvements value into [{ text, addedAt }], migrating
// legacy plain-string items ({ text, addedAt: now }).
function parseImprovements(entry) {
    let arr;
    try { arr = JSON.parse((entry && entry.value) || '[]'); } catch { arr = []; }
    if (!Array.isArray(arr)) arr = [];
    const now = new Date().toISOString();
    const out = [];
    for (const item of arr) {
        if (typeof item === 'string' && item.trim()) out.push({ text: item.trim(), addedAt: now });
        else if (item && typeof item === 'object' && typeof item.text === 'string' && item.text.trim()) {
            out.push({ text: item.text.trim(), addedAt: item.addedAt || now });
        }
    }
    return out;
}

// Jaccard-consolidate (threshold 0.7), expire items older than 30 days, cap.
// Keeps the newest phrasing of near-duplicate suggestions.
function consolidateImprovements(list) {
    const cutoff = Date.now() - IMPROVEMENT_MAX_AGE_MS;
    const fresh = list.filter(i => (Date.parse(i.addedAt) || Date.now()) >= cutoff);
    // Newest first so duplicates collapse onto the freshest phrasing.
    fresh.sort((a, b) => (Date.parse(b.addedAt) || 0) - (Date.parse(a.addedAt) || 0));
    const kept = [];
    for (const item of fresh) {
        const norm = normalizeInsightValue(item.text);
        if (!norm) continue;
        if (kept.some(k => k.norm === norm || insightSimilarity(k.norm, norm) >= 0.7)) continue;
        kept.push({ ...item, norm });
    }
    return kept.slice(0, IMPROVEMENT_CAP).map(({ norm, ...rest }) => rest);
}

// Merge new suggestion strings into mem['chat_improvements'] (mutates mem).
function mergeImprovements(mem, newTexts = []) {
    const now = new Date().toISOString();
    const existing = parseImprovements(mem['chat_improvements']);
    const incoming = (Array.isArray(newTexts) ? newTexts : [])
        .filter(t => typeof t === 'string' && t.trim())
        .map(t => ({ text: t.trim(), addedAt: now }));
    const merged = consolidateImprovements([...incoming, ...existing]);
    mem['chat_improvements'] = {
        value: JSON.stringify(merged),
        tags: ['improvements', 'self-review'],
        updatedAt: now,
    };
    return merged.length;
}

// Plain-string view for API consumers (the frontend expects an array of
// strings inside chat_improvements.value).
function improvementTexts(mem) {
    return parseImprovements(mem && mem['chat_improvements']).map(i => i.text);
}

// --- Periodic AI Chat Review ---
// Reviews unreviewed chatlogs via LLM and saves insights to memory
// Daily chat-log review at a fixed local hour (default 05:00). Running it
// more often made the backend JIT-reload the big chat model every cycle even
// with the UI closed; once a day at a quiet hour avoids that churn. Override
// the hour with CHATLOG_REVIEW_HOUR (0-23).
const CHATLOG_REVIEW_HOUR = (() => {
    const h = parseInt(process.env.CHATLOG_REVIEW_HOUR, 10);
    return Number.isInteger(h) && h >= 0 && h <= 23 ? h : 5;
})();
let _lastChatReviewDay = null; // 'YYYY-M-D' of the last review run

// Chats shorter than this never carry extractable insights, so the review
// skips them. Anything below the threshold must NOT be counted as "pending"
// either — otherwise the pending stat can never reach zero (the review run
// ends with 0 chats processed while the counter still shows a backlog).
const CHATLOG_REVIEW_MIN_MESSAGES = 4;
function isReviewEligible(c) {
    return !c.reviewed && c.messageCount >= CHATLOG_REVIEW_MIN_MESSAGES;
}

// Review run state, surfaced via GET /api/chatlogs/review/status so the
// Memory panel can show what the loop is doing instead of guessing.
let _reviewRunning = false;
let _lastReviewAt = null;    // ISO timestamp of the last completed run
let _lastReviewStats = null; // { chats, insights, improvements } of that run

// Next scheduled auto-review as an ISO timestamp: today at the review hour
// if it hasn't fired yet, otherwise tomorrow.
function nextReviewRunAt() {
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), CHATLOG_REVIEW_HOUR, 0, 0, 0);
    const todayKey = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
    if (next <= now || todayKey === _lastChatReviewDay) next.setDate(next.getDate() + 1);
    return next.toISOString();
}

// --- Insight consolidation ---------------------------------------------------
// The daily review loop extracts chat_insight_* entries. Unchecked, they
// accumulate near-duplicates ("prefers german" vs "user prefers german
// replies") and bloat both the store and every system prompt. Keep them
// bounded: collapse duplicates (keeping the freshest), then evict the oldest
// beyond INSIGHT_CAP. Seed/live/improvements buckets are left untouched.
const INSIGHT_CAP = parseInt(process.env.TRICORDER_INSIGHT_CAP, 10) || 25;

function normalizeInsightValue(v) {
    return String(v || '').toLowerCase().replace(/[^a-z0-9äöüß ]+/gi, ' ').replace(/\s+/g, ' ').trim();
}

// Jaccard overlap of word sets — cheap, embedding-free, good enough to catch
// the paraphrased near-duplicates the review loop tends to emit.
function insightSimilarity(a, b) {
    const sa = new Set(a.split(' ').filter(Boolean));
    const sb = new Set(b.split(' ').filter(Boolean));
    if (!sa.size || !sb.size) return 0;
    let inter = 0;
    for (const w of sa) if (sb.has(w)) inter++;
    return inter / (sa.size + sb.size - inter);
}

// Dedup + cap the chat_insight_* entries in `mem` (mutates it). Returns stats.
function consolidateInsights(mem, cap = INSIGHT_CAP) {
    const keys = Object.keys(mem).filter(k => k.startsWith('chat_insight_'));
    const before = keys.length;
    // Newest first so duplicates collapse onto the freshest entry.
    const entries = keys
        .map(k => ({ k, norm: normalizeInsightValue(mem[k] && mem[k].value), ts: Date.parse(mem[k] && mem[k].updatedAt) || 0 }))
        .sort((a, b) => b.ts - a.ts);
    const kept = [];
    for (const e of entries) {
        if (!e.norm) { delete mem[e.k]; continue; }
        const dup = kept.find(k => k.norm === e.norm || insightSimilarity(k.norm, e.norm) >= 0.8);
        if (dup) {
            // Merge: the kept (fresher) entry inherits the union of both tag
            // sets, so category info from the discarded duplicate survives.
            const keptEntry = mem[dup.k];
            const oldEntry = mem[e.k];
            if (keptEntry && oldEntry && Array.isArray(oldEntry.tags) && oldEntry.tags.length) {
                keptEntry.tags = [...new Set([...(keptEntry.tags || []), ...oldEntry.tags])];
            }
            delete mem[e.k];
            continue;
        }
        kept.push(e);
    }
    // Evict oldest beyond the cap (kept is newest-first).
    for (const e of kept.slice(cap)) delete mem[e.k];
    const after = Object.keys(mem).filter(k => k.startsWith('chat_insight_')).length;
    return { before, after, removed: before - after };
}

// Ask the LLM for a review of one transcript and parse the JSON reply.
// Throws on transport errors; returns null when the reply isn't valid JSON.
async function _requestChatReview(reviewPrompt) {
    const msg = await llmChatRaw([
        { role: 'system', content: 'You are a helpful assistant that analyzes conversations and extracts insights. Always respond with valid JSON only.' },
        { role: 'user', content: reviewPrompt },
    ], { maxTokens: 1000, temperature: 0.3, timeoutMs: 60000 });
    const reply = msg?.content || '';
    // Extract JSON from reply (handle markdown code blocks)
    const jsonMatch = reply.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, reply];
    try { return { data: JSON.parse(jsonMatch[1].trim()), reply }; }
    catch { return { data: null, reply }; }
}

async function reviewChatlogs() {
    // Serialize runs — a manual REVIEW NOW while the daily run is in flight
    // would double-process the same backlog.
    if (_reviewRunning) return { alreadyRunning: true };
    _reviewRunning = true;
    try {
        return await _reviewChatlogsInner();
    } finally {
        _reviewRunning = false;
        _lastReviewAt = new Date().toISOString();
    }
}

async function _reviewChatlogsInner() {
    const chats = listChatlogs();
    const unreviewed = chats.filter(isReviewEligible);
    const stats = { chats: 0, insights: 0, improvements: 0 };
    _lastReviewStats = stats;
    if (unreviewed.length === 0) return stats;

    log('INFO', 'CHATLOGS', `Reviewing ${unreviewed.length} unreviewed chat(s)...`);

    // Work through the WHOLE backlog (one run per day), pausing 2s between
    // chats so the LLM backend isn't hammered back-to-back.
    while (unreviewed.length > 0) {
        const chatMeta = unreviewed.shift();
        try {
            const chat = loadChatlog(chatMeta.id);
            if (!chat || !chat.messages) continue;

            // Build a condensed transcript (user + assistant only, truncated)
            const transcript = chat.messages
                .filter(m => m.role === 'user' || m.role === 'assistant')
                .map(m => {
                    const text = typeof m.content === 'string'
                        ? m.content
                        : m.content?.find?.(c => c.type === 'text')?.text || '';
                    const truncated = text.length > 500 ? text.substring(0, 500) + '...' : text;
                    return `${m.role.toUpperCase()}: ${truncated}`;
                })
                .join('\n\n');

            if (transcript.length < 50) {
                chat.reviewed = true;
                saveChatlog(chatMeta.id, chat);
                continue;
            }

            // Window the transcript: opening (how the chat started) + the last
            // stretch (where conclusions/preferences usually surface), instead
            // of blindly cutting after the first 4000 chars.
            const windowed = transcript.length <= 4000
                ? transcript
                : transcript.substring(0, 1500) + '\n\n[... middle of conversation omitted ...]\n\n'
                    + transcript.substring(transcript.length - 2500);

            // Feed the already-stored insights so the model skips known facts.
            let existingBlock = '';
            try {
                const mem = loadMemory();
                const lines = Object.entries(mem)
                    .filter(([k]) => k.startsWith('chat_insight_'))
                    .map(([k, e]) => `- ${k}: ${String(e && e.value || '').substring(0, 120)}`)
                    .slice(0, 40);
                if (lines.length) {
                    existingBlock = `\n\nEXISTING INSIGHTS (already stored):\n${lines.join('\n')}\n`
                        + `Skip anything already covered by these existing insights.`;
                }
            } catch { /* memory unavailable — review without the dedup hint */ }

            // Ask LLM to extract insights
            const reviewPrompt = `Analyze this conversation and extract useful insights. Focus on:
1. User preferences and communication style
2. Topics of interest or recurring themes
3. Things the assistant could do better
4. Key facts about the user worth remembering
5. Technical preferences (tools, languages, workflows)

Be concise. Store insights in English. Output JSON with this structure:
{"insights": [{"key": "short_key", "value": "what to remember", "tags": ["tag1","tag2"]}], "improvements": ["suggestion1", "suggestion2"]}${existingBlock}

CONVERSATION:
${windowed}`;

            // One retry on unparseable JSON; only after the second failure is
            // the chat marked reviewed (with a WARN) so it isn't retried forever.
            let review = await _requestChatReview(reviewPrompt);
            if (!review.data) {
                log('WARN', 'CHATLOGS', `Unparseable review for ${chatMeta.id}, retrying once: ${review.reply.substring(0, 120)}`);
                review = await _requestChatReview(reviewPrompt);
            }
            const reviewData = review.data;
            if (!reviewData) {
                log('WARN', 'CHATLOGS', `Failed to parse review for ${chatMeta.id} after retry — marking reviewed: ${review.reply.substring(0, 200)}`);
                chat.reviewed = true;
                saveChatlog(chatMeta.id, chat);
                continue;
            }

            // Save insights to memory (serialised — other writers may run
            // concurrently with the nightly review).
            await withMemoryLock(async () => {
                const mem = loadMemory();
                if (reviewData.insights && Array.isArray(reviewData.insights)) {
                    for (const insight of reviewData.insights) {
                        if (insight.key && insight.value) {
                            // Namespace per chat so two chats' "prefers_german"
                            // don't clobber each other; near-duplicates are
                            // collapsed by consolidateInsights below.
                            const safeKey = String(insight.key).replace(/[^a-zA-Z0-9_]+/g, '_').substring(0, 60);
                            const memKey = `chat_insight_${chatMeta.id}_${safeKey}`;
                            mem[memKey] = {
                                value: insight.value,
                                tags: Array.isArray(insight.tags) ? insight.tags : [],
                                updatedAt: new Date().toISOString(),
                                source: `chatlog:${chatMeta.id}`,
                            };
                        }
                    }
                }
                if (reviewData.improvements && Array.isArray(reviewData.improvements)) {
                    mergeImprovements(mem, reviewData.improvements);
                }
                // Collapse near-duplicates and cap before persisting, so freshly
                // extracted insights can't grow the store past INSIGHT_CAP.
                const consolidated = consolidateInsights(mem);
                if (consolidated.removed > 0) {
                    log('INFO', 'MEMORY', `Consolidated insights: ${consolidated.before}→${consolidated.after} (-${consolidated.removed})`);
                }
                saveMemory(mem);
            });

            chat.reviewed = true;
            chat.reviewedAt = new Date().toISOString();
            saveChatlog(chatMeta.id, chat);

            stats.chats++;
            stats.insights += reviewData.insights?.length || 0;
            stats.improvements += reviewData.improvements?.length || 0;
            log('INFO', 'CHATLOGS', `Reviewed chat "${chatMeta.title}" — ${reviewData.insights?.length || 0} insights, ${reviewData.improvements?.length || 0} improvements`);
        } catch (e) {
            log('ERROR', 'CHATLOGS', `Failed to review chat ${chatMeta.id}: ${e.message}`);
        }
        if (unreviewed.length > 0) await new Promise(r => setTimeout(r, 2000));
    }
    return stats;
}

// Run the review once per day, during the configured hour. The minute-level
// tick fires it on the first check inside that hour, and the per-day guard
// stops it repeating (including on a same-hour server restart) — so the big
// chat model is loaded at most once a day, not every hour.
setInterval(() => {
    const now = new Date();
    if (now.getHours() !== CHATLOG_REVIEW_HOUR) return;
    const today = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
    if (today === _lastChatReviewDay) return;
    _lastChatReviewDay = today;
    log('INFO', 'CHATLOGS', `Daily review window (${CHATLOG_REVIEW_HOUR}:00) — starting review`);
    reviewChatlogs().catch(e => log('ERROR', 'CHATLOGS', `Review cycle failed: ${e.message}`));
}, 60000); // Check every minute

// --- Seed memory from memory-seed.json on startup ---------------------------
// New keys are added; existing entries that still carry the seedHash of a
// previous seed value (i.e. were never manually edited — manual edits via
// memory_store / POST /api/memory replace the whole entry and drop seedHash)
// are UPDATED when the seed file's value changed. Manually edited entries are
// never overwritten.
try {
    const seedFile = path.join(__dirname, 'memory-seed.json');
    if (fs.existsSync(seedFile)) {
        const seed = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
        const mem = loadMemory();
        let added = 0, updated = 0;
        for (const [key, entry] of Object.entries(seed)) {
            const seedHash = crypto.createHash('sha1').update(String(entry && entry.value || '')).digest('hex');
            const existing = mem[key];
            if (!existing) {
                mem[key] = { ...entry, seedHash };
                added++;
            } else if (existing.seedHash && existing.seedHash !== seedHash) {
                // Seed value changed and the stored entry was still the old
                // (untouched) seed → refresh it.
                mem[key] = { ...entry, seedHash, updatedAt: new Date().toISOString() };
                updated++;
            } else if (!existing.seedHash && existing.value === (entry && entry.value)) {
                // Migration: entry predates seedHash tracking but is verbatim
                // the current seed value — stamp it so future seed edits apply.
                existing.seedHash = seedHash;
                updated++;
            }
        }
        if (added > 0 || updated > 0) {
            saveMemory(mem);
            log('INFO', 'MEMORY', `Seed merge: ${added} added, ${updated} updated from memory-seed.json (total: ${Object.keys(mem).length})`);
        }
    }
} catch (e) {
    log('WARN', 'MEMORY', `Failed to seed memory: ${e.message}`);
}

// --- One-time insight consolidation on startup -------------------------------
// Collapse any pre-existing bloat (e.g. ~140 accumulated chat insights) down to
// the cap immediately, not only going forward. Seed/live/improvements untouched.
try {
    const mem = loadMemory();
    const stats = consolidateInsights(mem);
    // Also migrate/expire the improvements list (strings → {text, addedAt},
    // Jaccard dedup, 30-day expiry) once per start.
    let improvementsChanged = false;
    if (mem['chat_improvements']) {
        const beforeVal = mem['chat_improvements'].value;
        const consolidated = consolidateImprovements(parseImprovements(mem['chat_improvements']));
        const afterVal = JSON.stringify(consolidated);
        if (afterVal !== beforeVal) {
            mem['chat_improvements'] = { ...mem['chat_improvements'], value: afterVal, updatedAt: new Date().toISOString() };
            improvementsChanged = true;
        }
    }
    if (stats.removed > 0 || improvementsChanged) {
        saveMemory(mem);
        if (stats.removed > 0) log('INFO', 'MEMORY', `Startup insight consolidation: ${stats.before}→${stats.after} (-${stats.removed} duplicates/overflow)`);
        if (improvementsChanged) log('INFO', 'MEMORY', 'Startup improvements consolidation applied (migration/dedup/expiry)');
    }
} catch (e) {
    log('WARN', 'MEMORY', `Insight consolidation failed: ${e.message}`);
}

// --- Agent state (todos, plan mode) persisted alongside memory ---
const AGENT_STATE_FILE = path.join(MEMORY_DIR, 'agent-state.json');

function loadAgentState() {
    try {
        return JSON.parse(fs.readFileSync(AGENT_STATE_FILE, 'utf8'));
    } catch {
        return { todos: [], planMode: false };
    }
}

function saveAgentState(state) {
    try {
        fs.mkdirSync(MEMORY_DIR, { recursive: true });
        fs.writeFileSync(AGENT_STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
    } catch (e) {
        log('ERROR', 'AGENT', `Failed to save agent state: ${e.message}`);
    }
}

// Key prefixes that mark durable identity/seed facts (mirrors the frontend's
// classification in js/llm.js).
const _MEM_SEED_PREFIXES = ['operator_', 'agent_', 'workspace_', 'preferred_', 'stack_'];

// Single source of truth for bucketing a memory entry. The frontend used to
// re-derive this from key prefixes alone (and missed seeded keys like
// tricorder_* that carry a seedHash) — now GET /api/memory ships the bucket
// with every entry and the UI just renders it.
//   'improvements' — the JSON improvements list (chat_improvements)
//   'insight'      — extracted by the daily chat review
//   'seed'         — from memory-seed.json (seedHash) or identity prefixes
//   'live'         — written by the LLM via memory_store / POST /api/memory
function classifyMemoryEntry(key, entry) {
    if (key === 'chat_improvements') return 'improvements';
    if (key.startsWith('chat_insight_')) return 'insight';
    if (entry && typeof entry.source === 'string' && entry.source.startsWith('chatlog:')) return 'insight';
    if (entry && entry.seedHash) return 'seed';
    if (_MEM_SEED_PREFIXES.some(p => key.startsWith(p))) return 'seed';
    return 'live';
}

function buildMemoryContextBlock(budget = 3000) {
    let mem;
    try { mem = loadMemory(); } catch { return ''; }
    const keys = Object.keys(mem || {});
    if (!keys.length) return '';
    // Seed/identity entries first (always the most load-bearing facts), then
    // everything else newest-first — instead of raw insertion order, which let
    // stale auto-insights crowd out identity facts.
    const isSeed = (k) => !!(mem[k] && mem[k].seedHash) || _MEM_SEED_PREFIXES.some(p => k.startsWith(p));
    const ts = (k) => Date.parse(mem[k] && mem[k].updatedAt) || 0;
    const ordered = [
        ...keys.filter(isSeed),
        ...keys.filter(k => !isSeed(k)).sort((a, b) => ts(b) - ts(a)),
    ];
    const lines = [];
    let used = 0;
    for (const k of ordered) {
        if (k === 'chat_improvements') continue; // meta list, not an operator fact
        const entry = mem[k];
        const value = entry && typeof entry === 'object' ? entry.value : entry;
        if (value == null || value === '') continue;
        const line = `- ${k.replace(/_/g, ' ')}: ${String(value).slice(0, 400)}`;
        if (used + line.length + 1 > budget) break;
        used += line.length + 1;
        lines.push(line);
    }
    return lines.join('\n');
}

// --- Background Agent System ---
// Spawn and manage long-running background shell commands.
// Agents run as child processes with output buffering and timeout support.
const backgroundAgents = new Map();  // agent_id → { proc, output, status, description, startedAt, ... }
let agentIdCounter = 0;

// Subscriber set for /api/agents/events SSE clients. Each subscriber is a
// function(event, data) that writes one SSE record. The set is populated by
// the endpoint handler and drained on client disconnect.
const agentSubscribers = new Set();
function broadcastAgentEvent(event, data) {
    for (const fn of agentSubscribers) {
        try { fn(event, data); } catch { /* subscriber crashed — endpoint will clean up */ }
    }
}
// --- Proactive chat pushes ---
// A message Tricorder puts into the chat on its own initiative — a finished
// background download, a scheduled task's result — without the operator having
// asked for it in that turn. It rides the /api/agents/events SSE stream that
// the chat UI already holds open, so delivery is instant and needs no polling
// task. Recent pushes are replayed to every new SSE connection, so one that
// fired while the app was closed still shows up on reopen; the browser drops
// a replayed id it has already rendered.
const chatPushes = [];
const CHAT_PUSH_MAX = 50;
const CHAT_PUSH_TTL_MS = 24 * 60 * 60 * 1000;

function pushChatMessage(text, { title = null, source = 'system', sourceId = null } = {}) {
    const body = String(text || '').trim();
    if (!body) return null;
    const msg = {
        id: `push_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        text: body,
        title,
        source,
        sourceId,
        createdAt: new Date().toISOString(),
    };
    chatPushes.push(msg);
    if (chatPushes.length > CHAT_PUSH_MAX) chatPushes.splice(0, chatPushes.length - CHAT_PUSH_MAX);
    log('INFO', 'PUSH', `Proactive chat message (${source}): ${body.replace(/\s+/g, ' ').slice(0, 120)}`);
    broadcastAgentEvent('chat_push', msg);
    return msg;
}

// Pushes young enough to still be worth replaying to a reconnecting tab.
function recentChatPushes() {
    const cutoff = Date.now() - CHAT_PUSH_TTL_MS;
    return chatPushes.filter(m => new Date(m.createdAt).getTime() >= cutoff);
}

// Public snapshot for a single agent. Callers choose whether to include the
// output tail (expensive for large buffers).
function agentSnapshot(agent, { tailBytes = 0 } = {}) {
    const snap = {
        id: agent.id,
        description: agent.description,
        command: agent.command,
        status: agent.status,
        pid: agent.pid,
        exit_code: agent.exitCode,
        started_at: agent.startedAt,
        completed_at: agent.completedAt,
        output_size: agent.output.length,
    };
    if (tailBytes > 0) {
        // Collapse \r redraws over a wider window first, then cut the tail —
        // tqdm-style output shrinks massively once collapsed.
        snap.output_tail = collapseCarriageReturns(agent.output.slice(-(tailBytes * 4))).slice(-tailBytes);
    }
    return snap;
}

// Post a short "your background job finished" line into the chat. Agents that
// finish almost immediately are skipped: the model is still in the same turn it
// spawned them and reports the outcome itself, so a push would just duplicate
// it. Anything longer outlives the turn — that's exactly the case the operator
// would otherwise have to poll for.
const AGENT_NOTIFY_MIN_MS = 30000;
function notifyAgentFinished(agent) {
    // A failed spawn fires both 'error' and 'close' — notify once.
    if (agent._notified) return;
    agent._notified = true;
    const ms = Date.now() - new Date(agent.startedAt).getTime();
    if (ms < AGENT_NOTIFY_MIN_MS) return;
    const secs = Math.round(ms / 1000);
    const runtime = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
    const ok = agent.status === 'completed';
    const head = ok
        ? `✅ **Fertig:** ${agent.description} _(${runtime})_`
        : `⚠️ **Abgebrochen:** ${agent.description} _(${runtime}, exit ${agent.exitCode ?? '–'})_`;
    // Last few lines of output — enough to see the result (or the error)
    // without pasting a whole build log into the chat.
    const tail = collapseCarriageReturns(agent.output.slice(-8192))
        .trim().split('\n').slice(-5).join('\n').trim();
    pushChatMessage(tail ? `${head}\n\n\`\`\`\n${tail}\n\`\`\`` : head, {
        title: agent.description, source: 'agent', sourceId: agent.id,
    });
}

function spawnBackgroundAgent(command, description, timeoutSecs = 300, cwd = null, { notifyWhenDone = true } = {}) {
    const agentId = `agent_${++agentIdCounter}_${Date.now().toString(36)}`;
    const maxTimeout = Math.min(Math.max(timeoutSecs, 10), 600);

    // Use the platform's native shell so agents work on Windows too,
    // and hide the console window that Windows would otherwise flash.
    const isWin = process.platform === 'win32';
    const agentShell = isWin ? 'cmd.exe' : 'bash';
    const agentShellArg = isWin ? '/c' : '-c';
    const proc = require('child_process').spawn(agentShell, [agentShellArg, command], {
        cwd: cwd || WORKSPACE_DIR,
        env: { ...process.env, AGENT_ID: agentId },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
        windowsHide: true,
    });

    const agent = {
        id: agentId,
        description,
        command,
        status: 'running',
        pid: proc.pid,
        output: '',
        exitCode: null,
        startedAt: new Date().toISOString(),
        completedAt: null,
        timeout: maxTimeout,
    };

    // Throttle output broadcasts to ~4/s per agent so a chatty download
    // doesn't saturate the SSE channel. Always flush the tail on close.
    let lastOutputEmit = 0;
    const OUTPUT_EMIT_MS = 250;
    const emitOutput = (force) => {
        const now = Date.now();
        if (!force && now - lastOutputEmit < OUTPUT_EMIT_MS) return;
        lastOutputEmit = now;
        broadcastAgentEvent('agent_output', {
            id: agent.id,
            status: agent.status,
            output_size: agent.output.length,
            // Last ~2 KB tail — enough for a progress bar or the latest log
            // lines without flooding the wire. \r redraws are collapsed to
            // terminal semantics so a tqdm bar shows as one updating line
            // instead of stacking every redraw in the panel.
            output_tail: collapseCarriageReturns(agent.output.slice(-8192)).slice(-2048),
            elapsedMs: now - new Date(agent.startedAt).getTime(),
        });
    };

    // Buffer output (capped at 1MB)
    const MAX_OUTPUT = 1024 * 1024;
    const appendOutput = (chunk) => {
        if (agent.output.length >= MAX_OUTPUT) return;
        agent.output += chunk.toString();
        if (agent.output.length > MAX_OUTPUT) {
            agent.output = agent.output.substring(0, MAX_OUTPUT) + '\n[...output truncated at 1MB]';
        }
        emitOutput(false);
    };
    proc.stdout.on('data', appendOutput);
    proc.stderr.on('data', appendOutput);

    proc.on('close', (code) => {
        agent.status = code === 0 ? 'completed' : 'failed';
        agent.exitCode = code;
        agent.completedAt = new Date().toISOString();
        log('INFO', 'AGENT', `Background agent ${agentId} ${agent.status} (exit ${code})`);
        emitOutput(true);
        broadcastAgentEvent('agent_close', agentSnapshot(agent));
        if (notifyWhenDone) notifyAgentFinished(agent);
    });

    proc.on('error', (err) => {
        agent.status = 'failed';
        agent.output += `\n[Process error: ${err.message}]`;
        agent.completedAt = new Date().toISOString();
        emitOutput(true);
        broadcastAgentEvent('agent_close', agentSnapshot(agent));
        if (notifyWhenDone) notifyAgentFinished(agent);
    });

    // Timeout watchdog
    const timer = setTimeout(() => {
        if (agent.status === 'running') {
            agent.status = 'timeout';
            agent.output += `\n[Killed: exceeded ${maxTimeout}s timeout]`;
            agent.completedAt = new Date().toISOString();
            try { proc.kill('SIGTERM'); } catch {}
            setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 5000);
        }
    }, maxTimeout * 1000);

    proc.on('close', () => clearTimeout(timer));

    backgroundAgents.set(agentId, agent);
    log('INFO', 'AGENT', `Spawned background agent ${agentId}: ${description}`, { command, timeout: maxTimeout });
    broadcastAgentEvent('agent_spawn', agentSnapshot(agent));

    return agent;
}

// --- Glob to RegExp conversion ---
// Converts a glob pattern (supporting *, **, ?, [abc]) to a RegExp.
function globToRegExp(glob) {
    let re = '^';
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === '*') {
            if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; }
            else re += '[^/]*';
        } else if (c === '?') re += '[^/]';
        else if (c === '[') {
            const end = glob.indexOf(']', i);
            if (end === -1) re += '\\[';
            else { re += '[' + glob.slice(i + 1, end) + ']'; i = end; }
        } else if ('.+^$(){}|\\'.includes(c)) re += '\\' + c;
        else re += c;
    }
    return new RegExp(re + '$');
}

// --- Code execution (sandboxed Docker container) -----------------------------
function runCodeInContainer({ language, code, stdin = '', timeoutSec = 20, network = false }) {
    return new Promise((resolve) => {
        const lang = language === 'javascript' ? 'node' : language;
        const image = CODE_EXEC_IMAGES[lang];
        if (!image) return resolve({ ok: false, error: `Unsupported language: ${language}` });
        const fileName = lang === 'python' ? 'main.py' : lang === 'node' ? 'main.js' : 'main.sh';
        const runner = lang === 'python' ? `python /work/${fileName}`
            : lang === 'node' ? `node /work/${fileName}`
                : `sh /work/${fileName}`;
        // Stage the snippet in a private temp dir mounted read-only into /work.
        let tmpDir;
        try {
            tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tricorder-code-'));
            fs.writeFileSync(path.join(tmpDir, fileName), code, 'utf8');
        } catch (e) {
            return resolve({ ok: false, error: `Failed to stage code: ${e.message}` });
        }
        const cap = Math.min(Math.max(parseInt(timeoutSec, 10) || 20, 1), 60);
        const dockerArgs = [
            'run', '--rm', '-i',
            '--network', network ? 'bridge' : 'none',
            '--memory', '512m', '--cpus', '1', '--pids-limit', '256',
            '--read-only', '--tmpfs', '/tmp:rw,size=64m',
            '-v', `${tmpDir}:/work:ro`, '-w', '/work',
            image, 'sh', '-c', `timeout ${cap} ${runner}`,
        ];
        const child = require('child_process').spawn('docker', dockerArgs, { windowsHide: true });
        let stdout = '', stderr = '', killed = false;
        const killTimer = setTimeout(() => { killed = true; try { child.kill('SIGKILL'); } catch {} }, (cap + 10) * 1000);
        child.stdout.on('data', d => { if (stdout.length < 100000) stdout += d; });
        child.stderr.on('data', d => { if (stderr.length < 100000) stderr += d; });
        child.on('error', (err) => {
            clearTimeout(killTimer);
            try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
            if (err.code === 'ENOENT') resolve({ ok: false, error: 'Docker not found on host. Install Docker to enable code_exec.' });
            else resolve({ ok: false, error: err.message });
        });
        child.on('close', (codeNum) => {
            clearTimeout(killTimer);
            try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
            resolve({
                ok: !killed && codeNum === 0,
                language: lang,
                image,
                exitCode: killed ? 124 : codeNum,
                stdout: stdout.slice(0, 20000),
                stderr: stderr.slice(0, 8000),
                timedOut: killed,
            });
        });
        if (stdin) { try { child.stdin.write(stdin); } catch {} }
        try { child.stdin.end(); } catch {}
    });
}

// --- Headless browser automation (Chrome DevTools Protocol) ------------------
// A single persistent page session driven over CDP. We talk to Chrome's
// /json HTTP endpoint to find the browser WebSocket, then attach to a page
// target with flattened sessions and issue Page/Runtime/Input commands.
const CHROMIUM_CANDIDATES = IS_WINDOWS
    ? [ // Per-user installs (most common — Chrome installs here by default)
       path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
       'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
       'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
       // Microsoft Edge (Chromium-based) — preinstalled on Windows 10/11
       'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
       'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
       path.join(process.env.LOCALAPPDATA || '', 'Microsoft\\Edge\\Application\\msedge.exe')]
    : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium',
       '/usr/bin/chromium-browser', '/snap/bin/chromium',
       '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
       '/Applications/Chromium.app/Contents/MacOS/Chromium',
       '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'];

function detectChromium() {
    // An explicit CHROMIUM_PATH wins, but only if it actually exists — a stale
    // or wrong path would otherwise be spawned blindly and fail with ENOENT.
    if (CHROMIUM_PATH) {
        try { if (fs.existsSync(CHROMIUM_PATH)) return CHROMIUM_PATH; } catch {}
        console.warn(`[browser] CHROMIUM_PATH is set but not found: ${CHROMIUM_PATH} — falling back to auto-detection.`);
    }
    for (const c of CHROMIUM_CANDIDATES) {
        try { if (c && fs.existsSync(c)) return c; } catch {}
    }
    return null;
}

function httpGetJson(url, timeoutMs = 4000) {
    return new Promise((resolve, reject) => {
        const r = http.get(url, { timeout: timeoutMs }, (res) => {
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Bad CDP JSON')); } });
        });
        r.on('error', reject);
        r.on('timeout', () => { r.destroy(); reject(new Error('CDP HTTP timeout')); });
    });
}

const Browser = {
    proc: null,
    base: null,        // http://127.0.0.1:port
    ws: null,          // WebSocket to the browser
    sessionId: null,   // attached page session
    targetId: null,
    _nextId: 1,
    _pending: new Map(),
    _events: new Map(),

    async _launchLocal() {
        const bin = detectChromium();
        if (!bin) throw new Error('No Chrome/Chromium found. Install it or set CHROMIUM_PATH (or point BROWSER_CDP_URL at a remote Chrome).');
        const userDir = path.join(os.tmpdir(), 'tricorder-chrome-profile');
        try { fs.mkdirSync(userDir, { recursive: true }); } catch {}
        const args = [
            `--remote-debugging-port=${BROWSER_DEBUG_PORT}`,
            '--remote-debugging-address=127.0.0.1',
            '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
            '--no-sandbox', '--disable-dev-shm-usage', '--disable-extensions',
            '--window-size=1280,900', `--user-data-dir=${userDir}`, 'about:blank',
        ];
        this.proc = require('child_process').spawn(bin, args, { windowsHide: true, detached: false });
        this.proc.on('exit', () => { this.proc = null; this.ws = null; this.sessionId = null; });
        // A spawn failure (e.g. bad CHROMIUM_PATH) emits 'error' asynchronously.
        // Without a listener Node rethrows it as an uncaught exception that would
        // crash the whole server, so capture it and surface it as a tool error.
        let spawnError = null;
        this.proc.on('error', (err) => { spawnError = err; this.proc = null; });
        // Wait for the debug endpoint to come up.
        const base = `http://127.0.0.1:${BROWSER_DEBUG_PORT}`;
        for (let i = 0; i < 40; i++) {
            if (spawnError) {
                throw new Error(`Failed to launch Chromium at "${bin}": ${spawnError.code === 'ENOENT' ? 'file not found — check CHROMIUM_PATH or install Chrome/Chromium/Edge' : spawnError.message}`);
            }
            try { await httpGetJson(`${base}/json/version`); this.base = base; return; }
            catch { await new Promise(r => setTimeout(r, 250)); }
        }
        throw new Error('Chromium started but DevTools endpoint did not become ready.');
    },

    async _connect() {
        if (this.ws && this.ws.readyState === 1) return;
        if (typeof WebSocket === 'undefined') {
            throw new Error('Global WebSocket unavailable — Node >= 21 is required for browser automation (or run a CDP proxy).');
        }
        if (BROWSER_CDP_URL) {
            this.base = BROWSER_CDP_URL.replace(/\/+$/, '');
        } else if (!this.base || !this.proc) {
            await this._launchLocal();
        }
        const version = await httpGetJson(`${this.base}/json/version`);
        const wsUrl = version.webSocketDebuggerUrl;
        if (!wsUrl) throw new Error('CDP did not expose a browser WebSocket URL.');
        await new Promise((resolve, reject) => {
            const ws = new WebSocket(wsUrl);
            const to = setTimeout(() => reject(new Error('CDP WebSocket connect timeout')), 8000);
            ws.onopen = () => { clearTimeout(to); this.ws = ws; resolve(); };
            ws.onerror = () => { clearTimeout(to); reject(new Error('CDP WebSocket error')); };
            ws.onclose = () => { this.ws = null; this.sessionId = null; };
            ws.onmessage = (ev) => this._onMessage(ev);
        });
    },

    _onMessage(ev) {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.id && this._pending.has(msg.id)) {
            const { resolve, reject } = this._pending.get(msg.id);
            this._pending.delete(msg.id);
            if (msg.error) reject(new Error(msg.error.message || 'CDP error'));
            else resolve(msg.result);
        } else if (msg.method) {
            const h = this._events.get(msg.method);
            if (h) h(msg.params, msg.sessionId);
        }
    },

    send(method, params = {}, sessionId) {
        return new Promise((resolve, reject) => {
            const id = this._nextId++;
            this._pending.set(id, { resolve, reject });
            const payload = { id, method, params };
            if (sessionId) payload.sessionId = sessionId;
            try { this.ws.send(JSON.stringify(payload)); } catch (e) { this._pending.delete(id); return reject(e); }
            setTimeout(() => {
                if (this._pending.has(id)) { this._pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }
            }, 30000);
        });
    },

    once(method, predicate, timeoutMs) {
        return new Promise((resolve) => {
            const to = setTimeout(() => { this._events.delete(method); resolve(false); }, timeoutMs);
            this._events.set(method, (params, sid) => {
                if (predicate && !predicate(params, sid)) return;
                clearTimeout(to); this._events.delete(method); resolve(params || true);
            });
        });
    },

    async _ensurePage() {
        await this._connect();
        if (this.sessionId) return this.sessionId;
        // Reuse an existing page target if present, else create one.
        let targetId;
        try {
            const list = await httpGetJson(`${this.base}/json/list`);
            const page = (list || []).find(t => t.type === 'page');
            if (page) targetId = page.id;
        } catch {}
        if (!targetId) {
            const created = await this.send('Target.createTarget', { url: 'about:blank' });
            targetId = created.targetId;
        }
        const attached = await this.send('Target.attachToTarget', { targetId, flatten: true });
        this.sessionId = attached.sessionId;
        this.targetId = targetId;
        await this.send('Page.enable', {}, this.sessionId);
        await this.send('Runtime.enable', {}, this.sessionId);
        await this.send('DOM.enable', {}, this.sessionId);
        return this.sessionId;
    },

    // Evaluate JS in the page; returns the value (returnByValue) or throws.
    async eval(expression) {
        const sid = await this._ensurePage();
        const res = await this.send('Runtime.evaluate', {
            expression, returnByValue: true, awaitPromise: true, userGesture: true,
        }, sid);
        if (res.exceptionDetails) {
            throw new Error(res.exceptionDetails.exception?.description
                || res.exceptionDetails.text || 'Page evaluation error');
        }
        return res.result?.value;
    },

    async navigate(url, waitMs = 0) {
        const sid = await this._ensurePage();
        // Any explicit scheme (http:, https:, data:, about:, file:) is used
        // as-is; a bare host/path gets https:// prepended.
        const target = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
        const loaded = this.once('Page.loadEventFired', (_p, s) => s === sid, 20000);
        await this.send('Page.navigate', { url: target }, sid);
        await loaded;
        // Settle: poll readyState, then optional extra wait for dynamic content.
        for (let i = 0; i < 20; i++) {
            try { if (await this.eval('document.readyState') === 'complete') break; } catch {}
            await new Promise(r => setTimeout(r, 200));
        }
        if (waitMs) await new Promise(r => setTimeout(r, Math.min(waitMs, 10000)));
        return this.state();
    },

    // Build a JS picker that resolves an element by selector|index|text.
    _picker(opts) {
        const o = JSON.stringify({ selector: opts.selector || null, index: (typeof opts.index === 'number' ? opts.index : null), text: opts.text || null });
        return `(()=>{const o=${o};const sel='a[href],button,input,textarea,select,[role=button],[onclick],[contenteditable=""],[contenteditable=true]';`
            + `const vis=el=>{const r=el.getBoundingClientRect();const s=getComputedStyle(el);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none';};`
            + `let el=null;`
            + `if(o.selector){el=document.querySelector(o.selector);}`
            + `else if(o.index!=null){el=document.querySelectorAll('[data-tricorder-idx="'+o.index+'"]')[0]||[...document.querySelectorAll(sel)].filter(vis)[o.index];}`
            + `else if(o.text){const t=o.text.toLowerCase();el=[...document.querySelectorAll(sel)].filter(vis).find(e=>((e.innerText||e.value||e.getAttribute('aria-label')||'').toLowerCase().includes(t)));}`
            + `return el;})()`;
    },

    async click(opts) {
        const expr = `(()=>{const el=${this._picker(opts)};if(!el)return {ok:false,error:'Element not found'};el.scrollIntoView({block:'center',inline:'center'});el.click();return {ok:true,tag:el.tagName.toLowerCase(),text:(el.innerText||el.value||'').trim().slice(0,80)};})()`;
        const r = await this.eval(expr);
        if (!r || !r.ok) throw new Error(r?.error || 'Click failed');
        await new Promise(res => setTimeout(res, 600)); // let navigation/JS settle
        return { clicked: r, ...(await this.state()) };
    },

    async type(opts) {
        const clear = opts.clear !== false;
        const text = JSON.stringify(opts.text || '');
        const expr = `(()=>{const el=${this._picker(opts)};if(!el)return {ok:false,error:'Field not found'};el.focus();`
            + `const v=${text};const clr=${clear};`
            + `if(el.isContentEditable){if(clr)el.textContent='';el.textContent+=v;}`
            + `else{const proto=el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;const set=Object.getOwnPropertyDescriptor(proto,'value').set;set.call(el,clr?v:(el.value+v));}`
            + `el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));`
            + `return {ok:true,tag:el.tagName.toLowerCase()};})()`;
        const r = await this.eval(expr);
        if (!r || !r.ok) throw new Error(r?.error || 'Type failed');
        if (opts.submit) {
            await this.eval(`(()=>{const el=${this._picker(opts)};if(!el)return;`
                + `for(const type of ['keydown','keypress','keyup'])el.dispatchEvent(new KeyboardEvent(type,{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true}));`
                + `if(el.form&&el.form.requestSubmit)try{el.form.requestSubmit();}catch(e){}})()`);
            await new Promise(res => setTimeout(res, 800));
        }
        return { typed: r, ...(await this.state()) };
    },

    // Snapshot of the page: url, title, visible text, interactive elements.
    async state() {
        const expr = `(()=>{const sel='a[href],button,input,textarea,select,[role=button],[onclick],[contenteditable=""],[contenteditable=true]';`
            + `const vis=el=>{const r=el.getBoundingClientRect();const s=getComputedStyle(el);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none';};`
            + `const nodes=[...document.querySelectorAll(sel)].filter(vis).slice(0,80);`
            + `nodes.forEach((el,i)=>el.setAttribute('data-tricorder-idx',i));`
            + `const els=nodes.map((el,i)=>{const label=(el.getAttribute('aria-label')||el.value||el.placeholder||el.innerText||el.textContent||'').trim().replace(/\\s+/g,' ').slice(0,80);`
            + `return {index:i,tag:el.tagName.toLowerCase(),type:el.getAttribute('type')||undefined,name:el.getAttribute('name')||undefined,text:label,href:el.getAttribute('href')||undefined};});`
            + `const text=(document.body?document.body.innerText:'').replace(/\\n{3,}/g,'\\n\\n').trim().slice(0,6000);`
            + `return {url:location.href,title:document.title,text,elements:els};})()`;
        return this.eval(expr);
    },

    async screenshot(opts = {}) {
        const sid = await this._ensurePage();
        if (opts.scroll === 'top') await this.eval('window.scrollTo(0,0)');
        else if (opts.scroll === 'bottom') await this.eval('window.scrollTo(0,document.body.scrollHeight)');
        else if (opts.scroll === 'down') await this.eval('window.scrollBy(0,window.innerHeight*0.9)');
        else if (opts.scroll === 'up') await this.eval('window.scrollBy(0,-window.innerHeight*0.9)');
        if (opts.scroll) await new Promise(r => setTimeout(r, 300));
        const params = { format: 'png' };
        if (opts.full_page) {
            const dims = await this.eval('({w:document.documentElement.scrollWidth,h:document.documentElement.scrollHeight})');
            params.captureBeyondViewport = true;
            params.clip = { x: 0, y: 0, width: Math.min(dims.w, 2000), height: Math.min(dims.h, 12000), scale: 1 };
        }
        const shot = await this.send('Page.captureScreenshot', params, sid);
        const dir = path.join(WORKSPACE_DIR, 'scratch');
        try { fs.mkdirSync(dir, { recursive: true }); } catch {}
        const file = path.join(dir, `browser-${Date.now()}.png`);
        fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
        const st = await this.state();
        return { screenshot_path: file, ...st };
    },
};

// --- In-App Tool Executor (LM Studio direct backend) ---
// Executes NATIVE_TOOLS calls issued by the frontend agent loop in js/llm.js.
// POST /api/tools/execute (JSON) and /api/tools/execute-stream (SSE progress).
// --- Tool dispatcher guards --------------------------------------------------
// Per-call watchdog: a hung upstream (a slow site, a dead socket past the
// 15s idle timeout) must fail the single tool call, not block the whole
// request forever. Tools that legitimately run long and carry their own
// internal timeouts (code_exec, browser automation, run_command) get a
// generous outer guard instead.
const TOOL_TIMEOUT_MS = Math.max(parseInt(process.env.TOOL_TIMEOUT_MS, 10) || 120000, 1000);
const TOOL_LONG_TIMEOUT_MS = Math.max(TOOL_TIMEOUT_MS, 600000);
const LONG_RUNNING_TOOL_RE = /^(code_exec$|run_command$|browser_)/;
// Cap on concurrently running tool calls per request — the model can emit a
// dozen calls at once; running them all in parallel starves the event loop
// and hammers upstreams.
const TOOL_MAX_PARALLEL = Math.max(parseInt(process.env.TOOL_MAX_PARALLEL, 10) || 4, 1);

async function handleToolExecApi(req, res, reqId) {
    if (req.method !== 'POST') {
        jsonRes(res, 405, { error: 'Method not allowed' });
        return;
    }

    const body = await readJsonBody(req);
    const { tool_calls } = body;

    if (!Array.isArray(tool_calls) || tool_calls.length === 0) {
        jsonRes(res, 400, { error: 'tool_calls array required' });
        return;
    }

    // Streaming mode: /api/tools/execute-stream returns an SSE feed so the
    // client can show live per-tool progress (downloads, heartbeats, errors)
    // instead of freezing on one long tool call. The plain
    // /api/tools/execute endpoint keeps its original JSON behaviour.
    const streaming = req.url.startsWith('/api/tools/execute-stream');

    let sseAlive = false;
    let heartbeatTimer = null;
    function sseWrite(event, data) {
        if (!sseAlive) return;
        try {
            res.write(`event: ${event}\n`);
            res.write(`data: ${JSON.stringify(data)}\n\n`);
        } catch { /* client went away */ }
    }
    if (streaming) {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        // Initial flush so the client switches into streaming mode right away.
        try { res.write(': tricorder-tools-stream\n\n'); } catch {}
        sseAlive = true;
        req.on('close', () => { sseAlive = false; if (heartbeatTimer) clearInterval(heartbeatTimer); });
    }

    log('INFO', 'TOOLS', `#${reqId} Executing ${tool_calls.length} tool call(s)${tool_calls.length > 1 ? ' in parallel' : ''}${streaming ? ' [stream]' : ''}`);

    // --- Per-tool progress tracking (shared across all in-flight tools) ---
    // Each entry: { index, tool_call_id, name, startedAt, lastBytes, done }
    const toolState = new Map();

    function emitToolEvent(event, info) {
        if (!streaming) return;
        sseWrite(event, info);
    }

    // One interval broadcasts a heartbeat for every still-running tool, so
    // even purely-synchronous tools (no onProgress signal) show the user the
    // agent is alive and how long the call has been running.
    if (streaming) {
        heartbeatTimer = setInterval(() => {
            const now = Date.now();
            for (const s of toolState.values()) {
                if (s.done) continue;
                emitToolEvent('tool_heartbeat', {
                    index: s.index,
                    tool_call_id: s.tool_call_id,
                    tool: s.name,
                    elapsedMs: now - s.startedAt,
                });
            }
        }, 1500);
    }

    // Execute a single tool call and return { tool_call_id, output }
    async function executeSingle(tc, index) {
        const fnName = tc.function?.name || tc.name;
        let args;
        try {
            args = typeof tc.function?.arguments === 'string'
                ? JSON.parse(tc.function.arguments)
                : (tc.function?.arguments || tc.arguments || {});
        } catch {
            const rawArgs = typeof tc.function?.arguments === 'string' ? tc.function.arguments : null;
            // A blob whose JSON object never closed is a call the model did not
            // finish emitting — the generation hit its token ceiling mid-call.
            // Salvaging that writes a stub and calls it a success, so refuse it
            // and say what actually happened; the model can then resume the file
            // instead of believing it is on disk.
            if (rawArgs && !argsBlobTerminated(rawArgs)) {
                log('WARN', 'TOOLS', `#${reqId} ${fnName}: arguments truncated mid-call (${rawArgs.length} chars, object never closed) — refusing`);
                const resume = FILE_CONTENT_TOOLS.has(fnName)
                    ? ' Re-send it in CHUNKS: write_file with the first ~100 lines, then write_file with append:true for each following ~100-line chunk.'
                    : ' Re-send the call with a smaller payload.';
                return { tool_call_id: tc.id, output: JSON.stringify({
                    error: `${fnName} arguments were cut off mid-call (${rawArgs.length} chars, the JSON object never closed) — the reply hit its output token limit before the call finished. NOTHING was written.${resume}`,
                }) };
            }
            // Before failing (which sends the model into a regenerate-the-whole-
            // file retry loop), try to salvage the common case: a big write_file
            // whose content broke the JSON escaping.
            const recovered = rawArgs ? recoverToolArgs(fnName, rawArgs) : null;
            if (!recovered) {
                return { tool_call_id: tc.id, output: JSON.stringify({ error: `Invalid JSON arguments for ${fnName}` }) };
            }
            log('WARN', 'TOOLS', `#${reqId} ${fnName}: recovered malformed JSON arguments (${tc.function.arguments.length} chars)`);
            args = recovered;
        }

        log('INFO', 'TOOLS', `#${reqId} → ${fnName}(${JSON.stringify(args).substring(0, 200)})`);

        // Register state + emit start event so the UI shows a placeholder
        // row for this tool as soon as execution begins.
        const state = {
            index,
            tool_call_id: tc.id,
            name: fnName,
            startedAt: Date.now(),
            lastBytes: 0,
            done: false,
        };
        toolState.set(tc.id || `idx-${index}`, state);
        emitToolEvent('tool_start', {
            index,
            tool_call_id: tc.id,
            tool: fnName,
            args,
        });

        // Progress reporter handed to tool bodies. Tools that actually
        // download bytes pass this into httpRequest as `onProgress`; other
        // tools can call it directly with { message: 'phase label' }.
        const progress = (info) => {
            if (!streaming || state.done) return;
            // Only fire data events when the byte count meaningfully changed
            // (avoids flooding when the chunk stream is very tight).
            if (info && info.phase === 'data') {
                const bytes = info.bytes || 0;
                if (bytes - state.lastBytes < 1024 && bytes !== (info.totalBytes || 0)) return;
                state.lastBytes = bytes;
            }
            emitToolEvent('tool_progress', {
                index,
                tool_call_id: tc.id,
                tool: fnName,
                elapsedMs: Date.now() - state.startedAt,
                ...info,
            });
        };
        // Tools read this under `args.__progress` to stay compatible with
        // the existing argument-destructuring style in each case block.
        args.__progress = progress;

        try {
            let output;
            // Plan mode is read-only: refuse anything that mutates state or
            // reaches outside, so "plan first, then act" is actually enforced
            // instead of being a flag the model can ignore.
            // Extended tools can classify mutating-ness per action (e.g. a
            // "status" action of an otherwise-mutating tool stays allowed in
            // plan mode) via isMutatingCall(); fall back to the coarse
            // per-tool set when that export isn't available yet.
            const isMutating = (extendedTools && typeof extendedTools.isMutatingCall === 'function' && extendedTools.has(fnName))
                ? !!extendedTools.isMutatingCall(fnName, args)
                : MUTATING_TOOLS.has(fnName);
            if (isMutating) {
                let planning = false;
                try { planning = !!loadAgentState().planMode; } catch { /* state unavailable */ }
                if (planning) {
                    throw new Error(`Plan mode is active — "${fnName}" is blocked until plan_mode_exit is called.`);
                }
            }
            switch (fnName) {
                case 'web_search': {

                    // Images are opt-in: only fetched on explicit include_images:true.
                    const wantImages = args.include_images === true;
                    const searchCacheKey = `search:${args.query}:${wantImages ? 1 : 0}`;
                    const cachedSearch = webCacheGet(searchCacheKey);
                    if (cachedSearch) {
                        output = JSON.stringify({ ...cachedSearch, cached: true });
                        break;
                    }
                    const searchUrl = 'https://html.duckduckgo.com/html/';
                    const formBody = `q=${encodeURIComponent(args.query)}`;
                    const { data } = await httpRequest(searchUrl, {
                        method: 'POST',
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                            'Content-Type': 'application/x-www-form-urlencoded',
                            'Content-Length': Buffer.byteLength(formBody),
                            'Referer': 'https://html.duckduckgo.com/',
                            'Origin': 'https://html.duckduckgo.com',
                        },
                        body: formBody,
                    });
                    const searchResults = [];
                    const resultRegex = /<a[^>]+class="result__a"[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
                    let match;
                    while ((match = resultRegex.exec(data)) !== null && searchResults.length < 8) {
                        const href = decodeURIComponent((match[1].match(/uddg=([^&]*)/) || [])[1] || match[1]);
                        searchResults.push({
                            title: match[2].replace(/<[^>]+>/g, '').trim(),
                            url: href,
                            snippet: match[3].replace(/<[^>]+>/g, '').trim(),
                        });
                    }

                    // Enrich with images from DuckDuckGo + Wikipedia + OpenGraph.
                    // Every image URL is proxied through /api/img-proxy so the LLM
                    // can embed them as ![title](url) without hotlink breakage.
                    // Opt IN by setting include_images:true (default is text-only —
                    // the image pipeline costs several extra network round-trips).
                    let images = [];
                    if (wantImages) {
                        try {
                            images = await gatherImagesForQuery(args.query, searchResults, { maxImages: 6 });
                        } catch (err) {
                            log('DEBUG', 'TOOLS', `#${reqId} image search failed: ${err.message}`);
                        }
                    }

                    // Keep the payload comfortably under the client's 12k-per-tool
                    // cap (capToolResults in js/llm.js). The images array —
                    // long proxied URLs — serialises AFTER the text results, so
                    // an oversized payload was truncated exactly where the image
                    // URLs live and the model never saw them. Slim both parts:
                    // trim snippets/titles and send only the fields the model
                    // actually embeds (title + image + source).
                    const payload = {
                        query: args.query,
                        // Hint so the LLM knows how to render images inline
                        image_usage: images.length > 0
                            ? 'Render 1-3 relevant images inline with ![title](image) markdown using the image field from each entry.'
                            : undefined,
                        // Explicit warning on zero hits so the model doesn't
                        // mistake a rate-limited/blocked backend for "no info".
                        warning: searchResults.length === 0
                            ? 'No results — the search backend may be rate-limiting or the query too narrow. Try different terms.'
                            : undefined,
                        results: searchResults.map(r => ({
                            title: (r.title || '').substring(0, 120),
                            url: r.url,
                            snippet: (r.snippet || '').substring(0, 220),
                        })),
                        images: images.slice(0, 4).map(im => ({
                            title: (im.title || '').substring(0, 80),
                            image: im.image,
                            source: (im.source || '').substring(0, 160),
                        })),
                    };
                    output = JSON.stringify(payload);
                    // Hard ceiling: if still too large, drop trailing images —
                    // a smaller complete list beats a truncated unparseable one.
                    while (output.length > 11000 && payload.images.length > 0) {
                        payload.images.pop();
                        if (payload.images.length === 0) delete payload.image_usage;
                        output = JSON.stringify(payload);
                    }
                    // Cache only successful (non-empty) searches.
                    if (searchResults.length > 0) webCacheSet(searchCacheKey, payload);
                    break;
                }
                case 'web_fetch': {
                    const fetchCacheKey = `fetch:${args.url}`;
                    const cachedFetch = webCacheGet(fetchCacheKey);
                    if (cachedFetch) {
                        output = JSON.stringify({ ...cachedFetch, cached: true });
                        break;
                    }
                    const { data, statusCode } = await httpRequest(args.url, {
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7',
                        },
                        // Heavy pages bury the article below ~50KB of <head>/nav
                        // boilerplate; fetch enough to reach real content. The
                        // extractor below keeps the returned text small.
                        maxBytes: 250000,
                        onProgress: args.__progress,
                        blockPrivate: true,
                    });
                    const text = htmlToReadableText(data, 15000);
                    const rawTitle = (data.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
                    const title = rawTitle ? stripTags(rawTitle) : '';
                    const fetchPayload = { url: args.url, status: statusCode, title, content: text };
                    if (statusCode < 400) webCacheSet(fetchCacheKey, fetchPayload);
                    output = JSON.stringify(fetchPayload);
                    break;
                }
                case 'fact_check': {
                    // --- Multi-Source Fact Checker ---
                    // Source reliability tiers
                    const FC_TIERS = {
                        'reuters.com': { tier: 1, label: 'Reuters' }, 'apnews.com': { tier: 1, label: 'AP News' },
                        'bloomberg.com': { tier: 1, label: 'Bloomberg' }, 'nytimes.com': { tier: 1, label: 'New York Times' },
                        'washingtonpost.com': { tier: 1, label: 'Washington Post' }, 'wsj.com': { tier: 1, label: 'Wall Street Journal' },
                        'axios.com': { tier: 1, label: 'Axios' }, 'bbc.com': { tier: 1, label: 'BBC' }, 'bbc.co.uk': { tier: 1, label: 'BBC' },
                        'theguardian.com': { tier: 1, label: 'The Guardian' }, 'nature.com': { tier: 1, label: 'Nature' },
                        'github.com': { tier: 1, label: 'GitHub' },
                        'forbes.com': { tier: 2, label: 'Forbes' }, 'cnbc.com': { tier: 2, label: 'CNBC' },
                        'techcrunch.com': { tier: 2, label: 'TechCrunch' }, 'arstechnica.com': { tier: 2, label: 'Ars Technica' },
                        'theverge.com': { tier: 2, label: 'The Verge' }, 'wired.com': { tier: 2, label: 'Wired' },
                        'wikipedia.org': { tier: 2, label: 'Wikipedia' }, 'en.wikipedia.org': { tier: 2, label: 'Wikipedia' },
                        'cnn.com': { tier: 2, label: 'CNN' }, 'ft.com': { tier: 2, label: 'Financial Times' },
                        'snopes.com': { tier: 2, label: 'Snopes' }, 'factcheck.org': { tier: 2, label: 'FactCheck.org' },
                    };
                    function fcClassify(url) {
                        try {
                            const h = new URL(url).hostname.replace(/^www\./, '');
                            if (FC_TIERS[h]) return { ...FC_TIERS[h], domain: h };
                            for (const [d, info] of Object.entries(FC_TIERS)) {
                                if (h.endsWith('.' + d)) return { ...info, domain: h };
                            }
                            const isBlog = /medium\.com|substack\.com|blogspot|wordpress\.com|dev\.to|hashnode/i.test(h);
                            return { tier: 3, label: isBlog ? 'Blog/Opinion' : h, domain: h };
                        } catch { return { tier: 3, label: 'Unknown', domain: url }; }
                    }

                    const fcClaim = args.claim;
                    const fcDepth = args.depth || 'standard';
                    const fcContext = args.context || '';
                    const fcConfig = {
                        quick:    { maxSearches: 2, maxSources: 3,  fetchTop: 0, devilsAdvocate: false, numberCheck: false },
                        standard: { maxSearches: 3, maxSources: 6,  fetchTop: 3, devilsAdvocate: false, numberCheck: false },
                        deep:     { maxSearches: 8, maxSources: 12, fetchTop: 7, devilsAdvocate: true,  numberCheck: true  },
                    }[fcDepth] || { maxSearches: 3, maxSources: 6, fetchTop: 3, devilsAdvocate: false, numberCheck: false };

                    // Generate search queries
                    const fcQueries = [fcClaim];
                    const fcWords = fcClaim.split(/\s+/).filter(w => w.length > 3).slice(0, 5).join(' ');
                    if (fcDepth !== 'quick') {
                        fcQueries.push(`${fcWords} site:reuters.com OR site:bloomberg.com OR site:apnews.com`);
                        fcQueries.push(`"${fcWords}" fact check verify`);
                    }
                    if (fcDepth === 'deep') {
                        fcQueries.push(`${fcWords} ${fcContext} timeline chronology`.trim());
                        fcQueries.push(`${fcWords} false wrong incorrect debunked correction retraction`);
                        const fcNums = fcClaim.match(/[\d,.]+\s*(?:billion|million|percent|%|\$|€|£)/gi);
                        if (fcNums && fcNums.length > 0) fcQueries.push(`${fcWords} official figures numbers data ${fcNums[0]}`);
                        fcQueries.push(`${fcWords} site:en.wikipedia.org OR site:britannica.com`);
                        if (fcContext) fcQueries.push(`${fcContext} ${fcWords.split(' ').slice(0, 3).join(' ')} criticism analysis`);
                    }

                    // Phase 1: Multi-source search
                    const fcSearches = [];
                    const fcAllResults = [];
                    for (const q of fcQueries.slice(0, fcConfig.maxSearches)) {
                        try {
                            const formBody = `q=${encodeURIComponent(q)}`;
                            const { data: searchData } = await httpRequest('https://html.duckduckgo.com/html/', {
                                method: 'POST', headers: {
                                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                                    'Content-Type': 'application/x-www-form-urlencoded',
                                    'Content-Length': Buffer.byteLength(formBody).toString(),
                                    'Referer': 'https://html.duckduckgo.com/', 'Origin': 'https://html.duckduckgo.com',
                                }, body: formBody,
                            });
                            const results = [];
                            const rr = /<a[^>]+class="result__a"[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
                            let m;
                            while ((m = rr.exec(searchData)) !== null && results.length < 8) {
                                const href = decodeURIComponent((m[1].match(/uddg=([^&]*)/) || [])[1] || m[1]);
                                results.push({ title: m[2].replace(/<[^>]+>/g, '').trim(), url: href, snippet: m[3].replace(/<[^>]+>/g, '').trim() });
                            }
                            fcSearches.push({ query: q, resultCount: results.length });
                            fcAllResults.push(...results);
                        } catch (err) { fcSearches.push({ query: q, error: err.message }); }
                    }

                    // Phase 2: Classify & deduplicate
                    const fcSeen = new Set();
                    const fcSources = [];
                    for (const r of fcAllResults) {
                        if (!r.url || fcSeen.has(r.url)) continue;
                        fcSeen.add(r.url);
                        fcSources.push({ url: r.url, title: r.title, snippet: r.snippet, ...fcClassify(r.url) });
                    }
                    fcSources.sort((a, b) => a.tier - b.tier);
                    const fcTopSources = fcSources.slice(0, fcConfig.maxSources);
                    const fcTiers = { tier1: [], tier2: [], tier3: [] };
                    for (const s of fcTopSources) {
                        const tk = `tier${s.tier}`;
                        if (fcTiers[tk]) fcTiers[tk].push({ label: s.label, url: s.url, title: s.title });
                    }

                    // Phase 3: Fetch top articles
                    const fcArticles = [];
                    if (fcConfig.fetchTop > 0) {
                        const toFetch = fcTopSources.filter(s => s.tier <= 2).slice(0, fcConfig.fetchTop);
                        if (toFetch.length < fcConfig.fetchTop) {
                            toFetch.push(...fcTopSources.filter(s => s.tier === 3 && !toFetch.find(f => f.url === s.url)).slice(0, fcConfig.fetchTop - toFetch.length));
                        }
                        const fetches = await Promise.all(toFetch.map(async (src) => {
                            try {
                                const { data: pageData, statusCode: ps } = await httpRequest(src.url, {
                                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'text/html,*/*;q=0.7' },
                                    maxBytes: 250000,
                                    blockPrivate: true,
                                });
                                const txt = htmlToReadableText(pageData, 15000);
                                const rawTitle = (pageData.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
                                const title = rawTitle ? stripTags(rawTitle) : src.title;
                                // Extract key facts (sentences with numbers, percentages, key action verbs)
                                const sentences = txt.split(/[.!?]+/).filter(s => s.trim().length > 20);
                                const keyFacts = sentences.filter(s => /\d+/.test(s) || /%/.test(s) || /\$/.test(s) || /acquired|merged|launched|announced|released|confirmed|denied|reported/i.test(s)).slice(0, 10).map(s => s.trim());
                                // Extract dates
                                const dates = [];
                                const dp = [/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})\b/gi, /\b(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})\b/g, /\b(Q[1-4])\s+(\d{4})\b/gi];
                                for (const p of dp) { let dm; while ((dm = p.exec(txt)) !== null) dates.push(dm[0]); }
                                return { url: src.url, title, tier: src.tier, label: src.label, contentLength: txt.length, keyFacts, dates, snippet: txt.substring(0, 500) };
                            } catch (err) { return { url: src.url, title: src.title, tier: src.tier, label: src.label, error: err.message }; }
                        }));
                        fcArticles.push(...fetches);
                    }

                    // Phase 4: Cross-verification
                    const fcCross = { consistent: [], contradictions: [], unverified: [] };
                    if (fcArticles.length >= 2) {
                        const factsBySource = fcArticles.filter(a => a.keyFacts?.length > 0).map(a => ({ source: a.label, tier: a.tier, facts: a.keyFacts }));
                        const claimWords = fcClaim.toLowerCase().split(/\s+/).filter(w => w.length > 3);
                        const consistentSet = new Set();
                        for (const { source, tier, facts } of factsBySource) {
                            for (const fact of facts) {
                                const fl = fact.toLowerCase();
                                if (claimWords.filter(w => fl.includes(w)).length < 2) continue;
                                let corr = false;
                                for (const other of factsBySource) {
                                    if (other.source === source) continue;
                                    if (other.facts.some(of => claimWords.filter(w => of.toLowerCase().includes(w)).length >= 2)) {
                                        const key = fact.substring(0, 50);
                                        if (!consistentSet.has(key)) {
                                            consistentSet.add(key);
                                            fcCross.consistent.push({ fact: fact.substring(0, 200), sources: [source, other.source], tiers: [tier, other.tier] });
                                        }
                                        corr = true; break;
                                    }
                                }
                                if (!corr) fcCross.unverified.push({ fact: fact.substring(0, 200), source, tier });
                            }
                        }
                    }

                    // Phase 5: Timeline analysis
                    const fcTimeline = { dates: [], plausible: null, notes: [] };
                    if (fcDepth !== 'quick') {
                        for (const a of fcArticles) {
                            if (a.dates) fcTimeline.dates.push(...a.dates.map(d => ({ date: d, source: a.label })));
                        }
                        const claimDateP = [/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})\b/gi, /\b(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})\b/g];
                        const claimDates = [];
                        for (const p of claimDateP) { let dm; while ((dm = p.exec(fcClaim)) !== null) claimDates.push(dm[0]); }
                        if (claimDates.length > 0) {
                            fcTimeline.plausible = true;
                            for (const cd of claimDates) {
                                if (!fcArticles.some(a => a.dates?.some(d => d.includes(cd) || cd.includes(d)))) {
                                    fcTimeline.notes.push(`Date "${cd}" from claim not confirmed in fetched sources`);
                                    fcTimeline.plausible = false;
                                }
                            }
                        }
                        fcTimeline.dates = fcTimeline.dates.slice(0, 20);
                    }

                    // Phase 4b: Devil's Advocate (deep only)
                    let fcDevil = null;
                    if (fcConfig.devilsAdvocate) {
                        fcDevil = { counterEvidence: [], debunkAttempts: 0 };
                        const counterQ = `${fcClaim.split(/\s+/).filter(w => w.length > 3).slice(0, 4).join(' ')} false wrong incorrect misleading`;
                        try {
                            const counterForm = `q=${encodeURIComponent(counterQ)}`;
                            const { data: counterData } = await httpRequest('https://html.duckduckgo.com/html/', {
                                method: 'POST', headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(counterForm).toString(), 'Referer': 'https://html.duckduckgo.com/', 'Origin': 'https://html.duckduckgo.com' }, body: counterForm,
                            });
                            fcDevil.debunkAttempts = 1;
                            const counterResults = [];
                            const crr = /<a[^>]+class="result__a"[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
                            let cm; while ((cm = crr.exec(counterData)) !== null && counterResults.length < 3) {
                                counterResults.push({ url: decodeURIComponent((cm[1].match(/uddg=([^&]*)/) || [])[1] || cm[1]), title: cm[2].replace(/<[^>]+>/g, '').trim() });
                            }
                            fcSearches.push({ query: counterQ, resultCount: counterResults.length, type: 'devils_advocate' });
                            for (const csrc of counterResults.slice(0, 2)) {
                                try {
                                    const { data: cpage } = await httpRequest(csrc.url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }, maxBytes: 50000 });
                                    let ctxt = cpage.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim();
                                    if (ctxt.length > 15000) ctxt = ctxt.substring(0, 15000);
                                    const clWords = fcClaim.toLowerCase().split(/\s+/).filter(w => w.length > 3);
                                    const hasCounter = /\b(false|wrong|incorrect|misleading|debunk|myth|hoax|not true|inaccurate|retract|correct(ed|ion))\b/i.test(ctxt);
                                    const relev = clWords.filter(w => ctxt.toLowerCase().includes(w)).length;
                                    if (hasCounter && relev >= 2) {
                                        const sents = ctxt.split(/[.!?]+/).filter(s => /\b(false|wrong|incorrect|not true|misleading|debunk)\b/i.test(s) && clWords.some(w => s.toLowerCase().includes(w))).slice(0, 3);
                                        if (sents.length > 0) fcDevil.counterEvidence.push({ url: csrc.url, title: csrc.title, contradictions: sents.map(s => s.trim().substring(0, 300)) });
                                    }
                                } catch { /* skip */ }
                            }
                        } catch (err) { fcSearches.push({ query: counterQ, error: err.message, type: 'devils_advocate' }); }
                    }

                    // Phase 4c: Number verification (deep only)
                    let fcNumVerify = null;
                    if (fcConfig.numberCheck) {
                        fcNumVerify = { claimNumbers: [], sourceNumbers: [], matches: [], mismatches: [] };
                        const numRx = /(?:[\$€£]?\s*[\d,.]+\s*(?:billion|million|thousand|percent|%|bn|mn|m|k|B|M)?)/gi;
                        fcNumVerify.claimNumbers = [...(fcClaim.match(numRx) || [])].map(n => n.trim()).filter(n => n.length > 0);
                        if (fcNumVerify.claimNumbers.length > 0 && fcArticles.length > 0) {
                            const normNum = (s) => { let n = s.replace(/[\$€£,\s]/g, '').toLowerCase(); if (/billion|bn|b$/i.test(n)) n = parseFloat(n) * 1e9; else if (/million|mn|m$/i.test(n)) n = parseFloat(n) * 1e6; else if (/thousand|k$/i.test(n)) n = parseFloat(n) * 1e3; else n = parseFloat(n); return isNaN(n) ? null : n; };
                            for (const art of fcArticles) {
                                if (art.error || !art.keyFacts) continue;
                                const artText = art.keyFacts.join(' ') + ' ' + (art.snippet || '');
                                const artNums = [...(artText.match(numRx) || [])].map(n => n.trim());
                                fcNumVerify.sourceNumbers.push({ source: art.label, numbers: artNums.slice(0, 10) });
                                for (const cn of fcNumVerify.claimNumbers) {
                                    const cv = normNum(cn); if (cv === null) continue;
                                    for (const an of artNums) {
                                        const av = normNum(an); if (av === null) continue;
                                        const ratio = cv > 0 ? av / cv : 0;
                                        if (ratio >= 0.9 && ratio <= 1.1) fcNumVerify.matches.push({ claimNumber: cn, sourceNumber: an, source: art.label, tier: art.tier });
                                        else if (ratio > 0 && (ratio < 0.5 || ratio > 2.0)) fcNumVerify.mismatches.push({ claimNumber: cn, sourceNumber: an, source: art.label, tier: art.tier, ratio: ratio.toFixed(2) });
                                    }
                                }
                            }
                        }
                    }

                    // Phase 6: Verdict
                    const t1 = fcTiers.tier1.length, t2 = fcTiers.tier2.length, t3 = fcTiers.tier3.length;
                    const total = fcTopSources.length;
                    const vNotes = [];
                    let conf = 0;
                    if (total >= 5) { conf += 25; vNotes.push(`${total} sources`); }
                    else if (total >= 3) { conf += 20; vNotes.push(`${total} sources`); }
                    else if (total >= 1) { conf += 10; vNotes.push(`only ${total} source(s)`); }
                    conf += t1 * 15 + t2 * 8 + t3 * 2;
                    if (t1 >= 2) vNotes.push(`${t1} Tier 1`);
                    if (fcCross.consistent.length > 0) { conf += Math.min(fcCross.consistent.length * 10, 30); vNotes.push(`${fcCross.consistent.length} cross-verified`); }
                    if (fcCross.contradictions.length > 0) { conf -= fcCross.contradictions.length * 20; vNotes.push(`⚠ ${fcCross.contradictions.length} contradiction(s)`); }
                    if (fcTimeline.plausible === false) { conf -= 15; vNotes.push('⚠ timeline issue'); }
                    const fetchOk = fcArticles.filter(a => !a.error).length;
                    if (fetchOk >= 3) conf += 15; else if (fetchOk >= 2) conf += 10;
                    if (fcDevil) {
                        if (fcDevil.counterEvidence.length > 0) { conf -= Math.min(fcDevil.counterEvidence.length * 15, 30); vNotes.push(`⚠ ${fcDevil.counterEvidence.length} counter-evidence`); }
                        else if (fcDevil.debunkAttempts > 0) { conf += 10; vNotes.push('no counter-evidence'); }
                    }
                    if (fcNumVerify) {
                        if (fcNumVerify.matches.length > 0) { conf += Math.min(fcNumVerify.matches.length * 8, 20); vNotes.push(`${fcNumVerify.matches.length} number(s) confirmed`); }
                        if (fcNumVerify.mismatches.length > 0) { conf -= Math.min(fcNumVerify.mismatches.length * 12, 25); vNotes.push(`⚠ ${fcNumVerify.mismatches.length} number discrepancy`); }
                    }
                    conf = Math.max(0, Math.min(100, conf));

                    let verdict;
                    if (conf >= 75) verdict = { confidence: conf, status: 'likely_true', reasoning: `Claim supported by ${t1 + t2} reputable source(s). ${vNotes.join('. ')}.`, notes: vNotes };
                    else if (conf >= 45) verdict = { confidence: conf, status: 'partially_verified', reasoning: `Partially supported. ${vNotes.join('. ')}.`, notes: vNotes };
                    else if (total === 0) verdict = { confidence: 0, status: 'no_sources', reasoning: 'No web sources found.', notes: vNotes };
                    else verdict = { confidence: conf, status: 'unverified', reasoning: `Insufficient evidence. ${vNotes.join('. ')}.`, notes: vNotes };

                    const fcResult = {
                        claim: fcClaim, depth: fcDepth, timestamp: new Date().toISOString(),
                        searches: fcSearches, sources: fcTopSources, tierBreakdown: fcTiers,
                        fetchedArticles: fcArticles, crossVerification: fcCross, timelineAnalysis: fcTimeline,
                        verdict,
                        checklist: {
                            multipleIndependentSources: total >= 2, tier1SourcePresent: t1 >= 1,
                            articlesFetched: fetchOk, crossVerified: fcCross.consistent.length > 0,
                            timelineChecked: fcTimeline.dates.length > 0, contradictionsFound: fcCross.contradictions.length,
                            devilsAdvocateRun: !!fcDevil, counterEvidenceFound: fcDevil ? fcDevil.counterEvidence.length : 0,
                            numbersVerified: fcNumVerify ? fcNumVerify.matches.length : 0, numberMismatches: fcNumVerify ? fcNumVerify.mismatches.length : 0,
                        }
                    };
                    if (fcDevil) fcResult.devilsAdvocate = fcDevil;
                    if (fcNumVerify) fcResult.numberVerification = fcNumVerify;
                    output = JSON.stringify(fcResult);
                    break;
                }
                case 'read_document': {
                    const filePath = path.resolve(args.path);
                    const ext = path.extname(filePath).toLowerCase();
                    if (!fileExtractMod || !fileExtractMod.canExtract(ext)) {
                        output = JSON.stringify({ error: `Unsupported file type: ${ext}` });
                    } else {
                        const buffer = fs.readFileSync(filePath);
                        if (buffer.length > 20 * 1024 * 1024) throw new Error('File too large (max 20 MB)');
                        const extracted = fileExtractMod.extractText(buffer, ext);
                        let text = extracted.text;
                        if (text.length > 50000) text = text.substring(0, 50000) + '\n\n[...truncated]';
                        output = JSON.stringify({ path: filePath, type: extracted.type, text });
                    }
                    break;
                }
                case 'list_archive': {
                    const filePath = path.resolve(args.path);
                    const buffer = fs.readFileSync(filePath);
                    const entries = fileExtractMod.listZipContents(buffer);
                    output = JSON.stringify({ path: filePath, entries });
                    break;
                }
                case 'extract_archive_file': {
                    const filePath = path.resolve(args.path);
                    const buffer = fs.readFileSync(filePath);
                    const text = fileExtractMod.readZipTextEntry(buffer, args.entry);
                    output = JSON.stringify({ entry: args.entry, text: text.length > 50000 ? text.substring(0, 50000) + '\n\n[...truncated]' : text });
                    break;
                }
                // --- System & File Tools ---
                case 'list_directory': {
                    const dirPath = sanitizePath(args.path || os.homedir());
                    if (!dirPath) throw new Error('Access denied: path outside allowed directories');
                    const stat = await fs.promises.stat(dirPath);
                    if (!stat.isDirectory()) throw new Error('Path is not a directory');
                    const dirents = await fs.promises.readdir(dirPath, { withFileTypes: true });
                    const entries = [];
                    for (const d of dirents) {
                        try {
                            const fullPath = path.join(dirPath, d.name);
                            const s = await fs.promises.stat(fullPath).catch(() => null);
                            entries.push({
                                name: d.name,
                                type: d.isDirectory() ? 'dir' : 'file',
                                size: s ? s.size : 0,
                                modified: s ? s.mtime.toISOString() : null,
                                ext: d.isDirectory() ? null : path.extname(d.name).toLowerCase(),
                            });
                        } catch { /* skip inaccessible */ }
                    }
                    entries.sort((a, b) => {
                        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
                        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
                    });
                    output = JSON.stringify({ path: dirPath, count: entries.length, entries });
                    break;
                }
                case 'run_command': {
                    if (!SHELL_ENABLED) throw new Error('Shell access is disabled on this server (SHELL_ENABLED=false).');
                    const cmd = (args.command || '').trim();
                    if (!cmd) throw new Error('command parameter required');
                    if (!isCommandAllowed(cmd)) {
                        const base = cmd.split(/\s+/)[0];
                        throw new Error(`Command "${base}" is not allowed. Allowed: ${[...ALLOWED_COMMANDS].sort().join(', ')}`);
                    }
                    // Cap raised from 30s to 5min: output now streams live to
                    // the operator (progress bars, build logs), so a longer
                    // command is watchable instead of a frozen badge.
                    const timeout = Math.min(parseInt(args.timeout, 10) || 15000, 300000);
                    const cmdCwd = args.cwd ? sanitizePath(args.cwd) : WORKSPACE_DIR;
                    if (args.cwd && !cmdCwd) throw new Error('Access denied: cwd outside allowed directories');
                    const cmdResult = await runCommandStreaming(cmd, { timeout, cwd: cmdCwd, onProgress: args.__progress });
                    output = JSON.stringify({ ok: cmdResult.ok, command: cmd, cwd: cmdCwd, output: cmdResult.output, exitCode: cmdResult.exitCode });
                    break;
                }
                case 'read_file': {
                    const filePath = sanitizePath(args.path);
                    if (!filePath) throw new Error('Access denied: path outside allowed directories');
                    const stat = await fs.promises.stat(filePath);
                    if (stat.isDirectory()) throw new Error('Path is a directory, not a file');
                    const ext = path.extname(filePath).toLowerCase();
                    // Documents (PDF/DOCX/XLSX/PPTX) aren't plain text, but we can
                    // still pull their text out — do it transparently so the agent
                    // doesn't dead-end on read_file when read_document was meant.
                    if (fileExtractMod && fileExtractMod.canExtract(ext)) {
                        if (stat.size > 20 * 1024 * 1024) throw new Error('File too large (max 20 MB)');
                        const buffer = await fs.promises.readFile(filePath);
                        const extracted = fileExtractMod.extractText(buffer, ext);
                        let content = extracted.text || '';
                        if (content.length > 50000) content = content.substring(0, 50000) + '\n\n[...truncated]';
                        output = JSON.stringify({ path: filePath, type: extracted.type, content, size: stat.size });
                        break;
                    }
                    if (BINARY_EXTENSIONS.has(ext)) throw new Error(`Binary file type (${ext}) cannot be read as text — and no text extractor is available for it`);
                    if (stat.size > 102400) throw new Error(`File too large (${stat.size} bytes, max 100KB)`);
                    const content = await fs.promises.readFile(filePath, 'utf8');
                    output = JSON.stringify({ path: filePath, content, size: stat.size });
                    break;
                }
                case 'write_file': {
                    const filePath = sanitizePath(args.path);
                    if (!filePath) throw new Error('Access denied: path outside allowed directories');
                    if (typeof args.content !== 'string') throw new Error('content parameter required');
                    const sizeNotice = chunkSizeNotice('write_file', 'content', args.content);
                    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
                    // append=true lets the model deliver a large file as several
                    // small sequential calls (visible progress; no giant buffered
                    // tool call). Overwrite remains the default.
                    const append = args.append === true || args.append === 'true';
                    if (append) await fs.promises.appendFile(filePath, args.content, 'utf8');
                    else await fs.promises.writeFile(filePath, args.content, 'utf8');
                    const stat = await fs.promises.stat(filePath);
                    output = JSON.stringify({ ok: true, path: filePath, size: stat.size, ...(append ? { appended: true } : {}), ...(sizeNotice ? { notice: sizeNotice } : {}) });
                    break;
                }
                case 'search_files': {
                    // Default to the Tricorder workspace, not the whole home dir
                    // — walking $HOME regularly burned the crawl budget in
                    // AppData/caches before reaching anything useful. Explicit
                    // paths behave as before.
                    const searchRoot = sanitizePath(args.path || WORKSPACE_DIR);
                    if (!searchRoot) throw new Error('Access denied: path outside allowed directories');
                    const query = (args.query || '').toLowerCase();
                    if (!query) throw new Error('query parameter required');
                    const maxResults = 50;
                    const MAX_DEPTH = 8;
                    const results = [];
                    async function searchDir(dirPath, depth) {
                        if (depth > MAX_DEPTH || results.length >= maxResults) return;
                        try {
                            const dirents = await fs.promises.readdir(dirPath, { withFileTypes: true });
                            for (const d of dirents) {
                                if (results.length >= maxResults) break;
                                if (d.name.startsWith('.') || d.name === 'node_modules' || d.name === 'AppData') continue;
                                const fullPath = path.join(dirPath, d.name);
                                if (d.name.toLowerCase().includes(query)) {
                                    try {
                                        const s = await fs.promises.stat(fullPath);
                                        results.push({ path: fullPath, name: d.name, type: d.isDirectory() ? 'dir' : 'file', size: s.size });
                                    } catch { /* skip */ }
                                }
                                if (d.isDirectory()) await searchDir(fullPath, depth + 1);
                            }
                        } catch { /* skip inaccessible dirs */ }
                    }
                    await searchDir(searchRoot, 0);
                    output = JSON.stringify({ query: args.query, root: searchRoot, count: results.length, results });
                    break;
                }
                case 'system_status': {
                    const status = await getSystemStatus();
                    output = JSON.stringify(status);
                    break;
                }
                case 'create_task': {
                    if (!args.name) throw new Error('name is required');
                    // Map the friendly `action` onto the internal action + type.
                    // reminder→notify (fixed message), smart→AI prompt, command→shell.
                    const reqAction = args.action ? String(args.action).toLowerCase() : null;
                    let action = null, taskType = 'scheduled', actionConfig = null;
                    if (reqAction === 'smart' || (!reqAction && args.prompt)) {
                        action = 'smart'; taskType = 'scheduled';
                        actionConfig = {
                            prompt: String(args.prompt || args.message || args.name),
                            delivery: args.delivery || 'both',
                            useTools: args.useTools !== false,
                        };
                        // Watch task: runs until the condition holds, then removes itself.
                        if (args.until) actionConfig.until = String(args.until).trim();
                        if (args.onDone === 'disable') actionConfig.onDone = 'disable';
                    } else if (reqAction === 'reminder' || reqAction === 'notify' || (!reqAction && args.message && !args.command)) {
                        action = 'notify'; taskType = 'reminder';
                        actionConfig = { message: String(args.message || args.name), delivery: args.delivery || 'both' };
                    } else {
                        const validTypes = ['reminder', 'scheduled', 'automation'];
                        taskType = validTypes.includes(args.type) ? args.type : (args.command ? 'automation' : 'scheduled');
                    }
                    // Shell-command tasks go through the same allowlist as
                    // run_command — otherwise create_task would be a trivial
                    // bypass (the scheduler exec()s task.command later).
                    if (args.command && !isCommandAllowed(String(args.command))) {
                        const base = String(args.command).trim().split(/\s+/)[0];
                        throw new Error(`Task command "${base}" is not allowed. Allowed: ${[...ALLOWED_COMMANDS].sort().join(', ')}`);
                    }
                    const task = {
                        id: generateTaskId(),
                        name: args.name,
                        type: taskType,
                        status: 'pending',
                        schedule: args.schedule || null,
                        command: args.command || null,
                        action,
                        actionConfig,
                        enabled: true,
                        createdAt: new Date().toISOString(),
                        nextRun: null,
                        lastRun: null,
                        result: null,
                    };
                    if (task.schedule) task.nextRun = computeNextRun(task);
                    tasks.push(task);
                    saveTasks();
                    output = JSON.stringify({ ok: true, task });
                    break;
                }
                case 'send_notification': {
                    if (!args.message) throw new Error('message is required');
                    const triggerIn = args.triggerIn || 'now';
                    let triggerAt;
                    if (triggerIn === 'now') {
                        triggerAt = new Date().toISOString();
                    } else if (/^\d+[smh]$/.test(triggerIn)) {
                        const val = parseInt(triggerIn);
                        const unit = triggerIn.slice(-1);
                        const ms = unit === 'h' ? val * 3600000 : unit === 'm' ? val * 60000 : val * 1000;
                        triggerAt = new Date(Date.now() + ms).toISOString();
                    } else {
                        triggerAt = new Date(triggerIn).toISOString();
                    }
                    const notif = {
                        id: `notif_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                        message: args.message,
                        status: 'pending',
                        triggerAt,
                        recurring: !!args.recurring,
                        createdAt: new Date().toISOString(),
                    };
                    notifications.push(notif);
                    output = JSON.stringify({ ok: true, notification: notif });
                    break;
                }
                // --- Memory Tools ---
                case 'memory_store': {
                    if (!args.key || !args.value) throw new Error('key and value are required');
                    // Serialised via the memory lock so parallel tool calls /
                    // API writers can't drop each other's updates.
                    output = await withMemoryLock(async () => {
                        const mem = loadMemory();
                        mem[args.key] = {
                            value: args.value,
                            tags: args.tags ? args.tags.split(',').map(t => t.trim().toLowerCase()) : [],
                            updatedAt: new Date().toISOString()
                        };
                        saveMemory(mem);
                        return JSON.stringify({ ok: true, key: args.key, stored: true, totalEntries: Object.keys(mem).length });
                    });
                    break;
                }
                case 'memory_recall': {
                    if (!args.query) throw new Error('query is required');
                    const mem = loadMemory();
                    // BM25 relevance ranking (same scoring as /api/memory/relevant),
                    // sorted by score then updatedAt.
                    let matches = scoreMemoryEntries(args.query, mem, 20)
                        .map(e => ({ key: e.key, value: e.value, tags: e.tags, updatedAt: e.updatedAt, score: e.score }));
                    // Fallback for queries BM25 can't tokenize usefully (e.g.
                    // pure stopwords or exact key fragments): substring match.
                    if (matches.length === 0) {
                        const q = args.query.toLowerCase();
                        for (const [key, entry] of Object.entries(mem)) {
                            const combined = `${key} ${entry.value} ${(entry.tags || []).join(' ')}`.toLowerCase();
                            if (combined.includes(q)) {
                                matches.push({ key, value: entry.value, tags: entry.tags, updatedAt: entry.updatedAt });
                            }
                        }
                        matches.sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
                        matches = matches.slice(0, 20);
                    }
                    output = JSON.stringify({ query: args.query, count: matches.length, results: matches });
                    break;
                }
                // --- Vector Search (local semantic + BM25 knowledge base) ---
                case 'scrape_url': {
                    if (!args.url) throw new Error('url is required');
                    const include = Array.isArray(args.include) ? args.include : null;
                    const scraped = await fetchAndScrape(args.url, {
                        include,
                        maxBytes: Math.min(Math.max(parseInt(args.max_bytes, 10) || 300000, 10000), 1000000),
                        onProgress: args.__progress,
                        blockPrivate: true,
                    });
                    output = JSON.stringify(scraped);
                    break;
                }
                // --- Opinion Engine (stored stances across sessions) ---
                case 'file_edit': {
                    const filePath = sanitizePath(args.path);
                    if (!filePath) throw new Error('Access denied: path outside allowed directories');
                    if (typeof args.old_string !== 'string' || typeof args.new_string !== 'string') {
                        throw new Error('old_string and new_string must be strings');
                    }
                    if (args.old_string === args.new_string) throw new Error('old_string and new_string are identical');
                    const editNotice = chunkSizeNotice('file_edit', 'new_string', args.new_string);
                    const stat = await fs.promises.stat(filePath);
                    if (stat.isDirectory()) throw new Error('Path is a directory, not a file');
                    if (stat.size > 5 * 1024 * 1024) throw new Error('File too large for edit (max 5 MB)');
                    const original = await fs.promises.readFile(filePath, 'utf8');
                    let occurrences = 0;
                    let idx = 0;
                    while ((idx = original.indexOf(args.old_string, idx)) !== -1) { occurrences++; idx += args.old_string.length; }
                    if (occurrences === 0) throw new Error('old_string not found in file');
                    if (!args.replace_all && occurrences > 1) {
                        throw new Error(`old_string appears ${occurrences} times; provide more context to make it unique, or set replace_all=true`);
                    }
                    const updated = args.replace_all
                        ? original.split(args.old_string).join(args.new_string)
                        : original.replace(args.old_string, args.new_string);
                    await fs.promises.writeFile(filePath, updated, 'utf8');
                    output = JSON.stringify({ ok: true, path: filePath, replacements: args.replace_all ? occurrences : 1, ...(editNotice ? { notice: editNotice } : {}) });
                    break;
                }
                case 'glob': {
                    // Same default-root change as search_files: workspace, not $HOME.
                    const rootPath = sanitizePath(args.path || WORKSPACE_DIR);
                    if (!rootPath) throw new Error('Access denied: path outside allowed directories');
                    if (!args.pattern) throw new Error('pattern parameter required');
                    const re = globToRegExp(args.pattern);
                    const matches = [];
                    const MAX = 500;
                    const MAX_DEPTH = 12;
                    async function walk(dir, rel, depth) {
                        if (depth > MAX_DEPTH || matches.length >= MAX) return;
                        let dirents;
                        try { dirents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
                        for (const d of dirents) {
                            if (matches.length >= MAX) break;
                            if (d.name === 'node_modules' || d.name === 'AppData' || d.name.startsWith('.')) continue;
                            const full = path.join(dir, d.name);
                            const relPath = rel ? `${rel}/${d.name}` : d.name;
                            if (d.isFile() && re.test(relPath)) {
                                try { const s = await fs.promises.stat(full); matches.push({ path: full, mtime: s.mtimeMs, size: s.size }); } catch {}
                            } else if (d.isDirectory()) {
                                await walk(full, relPath, depth + 1);
                            }
                        }
                    }
                    await walk(rootPath, '', 0);
                    matches.sort((a, b) => b.mtime - a.mtime);
                    output = JSON.stringify({ pattern: args.pattern, root: rootPath, count: matches.length, files: matches.map(m => ({ path: m.path, size: m.size })) });
                    break;
                }
                case 'grep': {
                    const rootPath = sanitizePath(args.path || os.homedir());
                    if (!rootPath) throw new Error('Access denied: path outside allowed directories');
                    if (!args.pattern) throw new Error('pattern parameter required');
                    const flags = args.case_insensitive ? 'i' : '';
                    // Validate the pattern compiles before spawning a worker.
                    try { new RegExp(args.pattern, flags); } catch (e) { throw new Error(`Invalid regex: ${e.message}`); }
                    const globRe = args.glob ? globToRegExp(args.glob) : null;
                    const maxResults = Math.min(parseInt(args.max_results, 10) || 100, 500);
                    const MAX_DEPTH = 12;
                    const MAX_FILE_SIZE = 2 * 1024 * 1024;
                    const MAX_FILES = 2000;
                    // Phase 1 (main thread): collect candidate files only.
                    const candidates = [];
                    async function walk(dir, rel, depth) {
                        if (depth > MAX_DEPTH || candidates.length >= MAX_FILES) return;
                        let dirents;
                        try { dirents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
                        for (const d of dirents) {
                            if (candidates.length >= MAX_FILES) break;
                            if (d.name === 'node_modules' || d.name === '.git' || d.name.startsWith('.')) continue;
                            const full = path.join(dir, d.name);
                            const relPath = rel ? `${rel}/${d.name}` : d.name;
                            if (d.isDirectory()) { await walk(full, relPath, depth + 1); continue; }
                            if (!d.isFile()) continue;
                            const ext = path.extname(d.name).toLowerCase();
                            if (BINARY_EXTENSIONS.has(ext)) continue;
                            if (globRe && !globRe.test(relPath)) continue;
                            let s; try { s = await fs.promises.stat(full); } catch { continue; }
                            if (s.size > MAX_FILE_SIZE) continue;
                            candidates.push(full);
                        }
                    }
                    await walk(rootPath, '', 0);
                    // Phase 2 (worker thread): run the actual regex matching off
                    // the main thread — an LLM-supplied pattern with catastrophic
                    // backtracking would otherwise freeze the whole event loop.
                    // Hard 5s budget; on timeout the worker is terminated and a
                    // structured error is returned.
                    const GREP_WORKER_CODE = `
                        const { parentPort, workerData } = require('worker_threads');
                        const fs = require('fs');
                        const { files, pattern, flags, maxResults } = workerData;
                        const re = new RegExp(pattern, flags);
                        const results = [];
                        outer: for (const f of files) {
                            let text;
                            try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
                            const lines = text.split('\\n');
                            for (let i = 0; i < lines.length; i++) {
                                if (re.test(lines[i])) {
                                    results.push({ path: f, line: i + 1, text: lines[i].length > 300 ? lines[i].slice(0, 300) + '…' : lines[i] });
                                    if (results.length >= maxResults) break outer;
                                }
                            }
                        }
                        parentPort.postMessage(results);
                    `;
                    output = await new Promise((resolve) => {
                        const worker = new Worker(GREP_WORKER_CODE, {
                            eval: true,
                            workerData: { files: candidates, pattern: args.pattern, flags, maxResults },
                        });
                        let settled = false;
                        const finish = (out) => {
                            if (settled) return;
                            settled = true;
                            clearTimeout(killTimer);
                            worker.terminate().catch(() => {});
                            resolve(out);
                        };
                        const killTimer = setTimeout(() => {
                            finish(JSON.stringify({
                                error: 'Regex matching timed out after 5s — the pattern likely causes catastrophic backtracking. Simplify it (avoid nested quantifiers).',
                                code: 'REGEX_TIMEOUT',
                                pattern: args.pattern,
                            }));
                        }, 5000);
                        worker.once('message', (results) => {
                            finish(JSON.stringify({ pattern: args.pattern, root: rootPath, count: results.length, matches: results }));
                        });
                        worker.once('error', (e) => finish(JSON.stringify({ error: `grep worker failed: ${e.message}` })));
                    });
                    break;
                }
                // --- HTTP ---
                case 'http_request': {
                    if (!args.url) throw new Error('url parameter required');
                    const method = (args.method || 'GET').toUpperCase();
                    const headers = args.headers && typeof args.headers === 'object' ? args.headers : {};
                    // Never let the model forge our internal-loopback auth header
                    // (or otherwise smuggle it to an external host).
                    for (const h of Object.keys(headers)) {
                        if (h.toLowerCase() === 'x-internal-token') delete headers[h];
                    }
                    const body = typeof args.body === 'string' ? args.body : (args.body ? JSON.stringify(args.body) : null);
                    if (body) headers['Content-Length'] = Buffer.byteLength(body);
                    const { data, statusCode, headers: respHeaders } = await httpRequest(args.url, {
                        method, headers, body, maxBytes: 100000, onProgress: args.__progress, blockPrivate: true,
                    });
                    const textBody = data.length > 20000 ? data.slice(0, 20000) + '\n[...truncated]' : data;
                    output = JSON.stringify({ url: args.url, method, status: statusCode, headers: respHeaders, body: textBody });
                    break;
                }
                // --- GitHub API Tools ---
                case 'agent_spawn': {
                    if (!args.command) throw new Error('command is required');
                    if (!args.description) throw new Error('description is required');
                    if (!isCommandAllowed(args.command)) {
                        const base = args.command.split(/\s+/)[0];
                        throw new Error(`Command "${base}" is not allowed. Allowed: ${[...ALLOWED_COMMANDS].sort().join(', ')}`);
                    }
                    const notifyWhenDone = args.notify_when_done !== false;
                    const agent = spawnBackgroundAgent(
                        args.command,
                        args.description,
                        parseInt(args.timeout, 10) || 300,
                        args.cwd,
                        { notifyWhenDone }
                    );
                    output = JSON.stringify({
                        ok: true, agent_id: agent.id, description: agent.description,
                        pid: agent.pid, status: agent.status, timeout: agent.timeout,
                        notify_when_done: notifyWhenDone,
                        note: notifyWhenDone
                            ? 'Use agent_status to check progress, agent_result to get output when completed. Completion is announced in the chat automatically — do NOT create a polling task or reminder just to tell the operator it finished.'
                            : 'Use agent_status to check progress, agent_result to get output when completed.'
                    });
                    break;
                }
                case 'agent_status': {
                    if (!args.agent_id) throw new Error('agent_id is required');
                    const agent = backgroundAgents.get(args.agent_id);
                    if (!agent) throw new Error(`Agent not found: ${args.agent_id}`);
                    const runtime = agent.completedAt
                        ? ((new Date(agent.completedAt) - new Date(agent.startedAt)) / 1000).toFixed(1) + 's'
                        : ((Date.now() - new Date(agent.startedAt).getTime()) / 1000).toFixed(1) + 's (running)';
                    // Include a tail of the live output so the model (and the
                    // operator reading the tool call in the UI) can see what
                    // the agent is actually doing — not just a byte count.
                    // Tunable via args.tail_bytes, default 2 KB.
                    const tailBytes = Math.min(Math.max(parseInt(args.tail_bytes, 10) || 2048, 0), 16384);
                    const outputTail = tailBytes > 0 && agent.output.length
                        ? collapseCarriageReturns(agent.output.slice(-(tailBytes * 4))).slice(-tailBytes)
                        : '';
                    output = JSON.stringify({
                        agent_id: agent.id, status: agent.status,
                        description: agent.description, runtime,
                        exit_code: agent.exitCode,
                        output_lines: agent.output.split('\n').length,
                        output_size: agent.output.length,
                        output_tail: outputTail,
                    });
                    break;
                }
                case 'agent_result': {
                    if (!args.agent_id) throw new Error('agent_id is required');
                    const agent = backgroundAgents.get(args.agent_id);
                    if (!agent) throw new Error(`Agent not found: ${args.agent_id}`);
                    let agentOutput = collapseCarriageReturns(agent.output);
                    if (args.tail) {
                        const lines = agentOutput.split('\n');
                        agentOutput = lines.slice(-Math.min(args.tail, lines.length)).join('\n');
                    }
                    if (agentOutput.length > 50000) agentOutput = agentOutput.substring(0, 50000) + '\n[...truncated]';
                    output = JSON.stringify({
                        agent_id: agent.id, status: agent.status,
                        exit_code: agent.exitCode,
                        output: agentOutput,
                    });
                    break;
                }
                // --- Tool discovery ---
                // Derived from the live tool registry (loadNativeToolDefs) and
                // ranked through the shared intent index, so it never drifts
                // from the real tool set and resolves synonyms (e.g. "email"
                // → memory_*, "lint" → code_linter, "preview" → dev_server).
                case 'tool_search': {
                    const defs = (loadNativeToolDefs() || [])
                        .filter(d => d?.function?.name && d.function.name !== 'tool_search')
                        .map(d => ({ name: d.function.name, description: d.function.description || '' }));
                    const shorten = (s) => {
                        const t = (s || '').replace(/\s+/g, ' ').trim();
                        return t.length > 160 ? t.slice(0, 157) + '…' : t;
                    };
                    if (toolIndex && (args.query || '').trim()) {
                        const { matches, total } = toolIndex.search(defs, args.query, { top: 15 });
                        output = JSON.stringify({
                            query: args.query, count: matches.length, more: Math.max(total - matches.length, 0),
                            tools: matches.map(m => ({ name: m.name, description: shorten(m.description) })),
                        });
                    } else if (toolIndex) {
                        const groups = toolIndex.catalogue(defs);
                        output = JSON.stringify({
                            query: null, count: defs.length,
                            note: 'Call tool_search with a keyword (e.g. {"query":"email"}) to load a group.',
                            groups: Object.fromEntries(groups.map(g => [g.label, g.tools])),
                        });
                    } else {
                        // Index unavailable — fall back to a plain name match.
                        const q = (args.query || '').toLowerCase();
                        const names = defs.map(d => d.name);
                        const matches = q ? names.filter(n => n.includes(q)) : names;
                        output = JSON.stringify({ query: args.query || null, count: matches.length, tools: matches });
                    }
                    break;
                }
                // --- Task CRUD ---
                case 'task_list': {
                    output = JSON.stringify({ count: tasks.length, tasks: tasks.map(t => ({ id: t.id, name: t.name, type: t.type, action: t.action || null, status: t.status, schedule: t.schedule, enabled: t.enabled !== false, nextRun: t.nextRun, lastRun: t.lastRun })) });
                    break;
                }
                case 'task_get': {
                    if (!args.id) throw new Error('id is required');
                    const t = tasks.find(x => x.id === args.id);
                    if (!t) throw new Error(`Task not found: ${args.id}`);
                    output = JSON.stringify({ task: t });
                    break;
                }
                case 'task_update': {
                    if (!args.id) throw new Error('id is required');
                    const t = tasks.find(x => x.id === args.id);
                    if (!t) throw new Error(`Task not found: ${args.id}`);
                    if (args.name !== undefined) t.name = args.name;
                    if (args.schedule !== undefined) { t.schedule = args.schedule; t.nextRun = computeNextRun(t); }
                    if (args.command !== undefined) t.command = args.command;
                    if (args.status !== undefined) t.status = args.status;
                    if (args.prompt !== undefined) { t.action = 'smart'; t.actionConfig = { delivery: 'both', useTools: true, ...(t.actionConfig || {}), prompt: args.prompt }; }
                    if (args.message !== undefined && (t.action === 'notify' || t.type === 'reminder')) { t.action = 'notify'; t.actionConfig = { delivery: 'both', ...(t.actionConfig || {}), message: args.message }; }
                    if (args.delivery !== undefined && t.actionConfig) t.actionConfig.delivery = args.delivery;
                    if (args.until !== undefined && t.actionConfig) t.actionConfig.until = String(args.until).trim() || undefined;
                    saveTasks();
                    output = JSON.stringify({ ok: true, task: t });
                    break;
                }
                case 'task_delete': {
                    if (!args.id) throw new Error('id is required');
                    const idx = tasks.findIndex(x => x.id === args.id);
                    if (idx === -1) throw new Error(`Task not found: ${args.id}`);
                    const removed = tasks.splice(idx, 1)[0];
                    saveTasks();
                    output = JSON.stringify({ ok: true, deleted: { id: removed.id, name: removed.name } });
                    break;
                }
                // --- Todos ---
                case 'todo_write': {
                    if (!Array.isArray(args.items)) throw new Error('items array is required');
                    const items = args.items.map(it => ({
                        content: String(it.content || ''),
                        status: ['pending','in_progress','completed'].includes(it.status) ? it.status : 'pending'
                    }));
                    const state = loadAgentState();
                    state.todos = items;
                    state.todosUpdatedAt = new Date().toISOString();
                    saveAgentState(state);
                    output = JSON.stringify({ ok: true, count: items.length, items });
                    break;
                }
                case 'todo_list': {
                    const state = loadAgentState();
                    output = JSON.stringify({ count: (state.todos || []).length, items: state.todos || [], updatedAt: state.todosUpdatedAt || null });
                    break;
                }
                // --- Planning / agent control ---
                case 'plan_mode_enter': {
                    const state = loadAgentState();
                    state.planMode = true;
                    state.planReason = args.reason || null;
                    state.planEnteredAt = new Date().toISOString();
                    saveAgentState(state);
                    output = JSON.stringify({ ok: true, planMode: true, reason: state.planReason });
                    break;
                }
                case 'plan_mode_exit': {
                    const state = loadAgentState();
                    state.planMode = false;
                    state.planReason = null;
                    saveAgentState(state);
                    output = JSON.stringify({ ok: true, planMode: false });
                    break;
                }
                case 'ask_user': {
                    if (!args.question) throw new Error('question is required');
                    output = JSON.stringify({
                        _prompt: true,
                        question: args.question,
                        choices: Array.isArray(args.choices) ? args.choices : null,
                        note: 'Display this question to the operator in your next message and stop producing tool calls. Wait for the operator to reply before continuing.'
                    });
                    break;
                }
                // --- Sleep ---
                case 'sleep': {
                    const ms = Math.min(Math.max(parseInt(args.ms, 10) || 0, 0), 30000);
                    await new Promise(r => setTimeout(r, ms));
                    output = JSON.stringify({ ok: true, slept_ms: ms });
                    break;
                }
                // --- Browser Automation (headless Chromium / CDP) ---
                case 'browser_navigate': {
                    if (!args.url) throw new Error('url is required');
                    args.__progress?.({ message: `Loading ${args.url}` });
                    const st = await Browser.navigate(args.url, Math.min(parseInt(args.wait_ms, 10) || 0, 10000));
                    output = JSON.stringify(st);
                    break;
                }
                case 'browser_click': {
                    if (!args.selector && args.index == null && !args.text) throw new Error('Provide selector, index, or text to click');
                    args.__progress?.({ message: 'Clicking element' });
                    output = JSON.stringify(await Browser.click(args));
                    break;
                }
                case 'browser_type': {
                    if (!args.text) throw new Error('text is required');
                    if (!args.selector && args.index == null) throw new Error('Provide selector or index for the field');
                    args.__progress?.({ message: 'Typing into field' });
                    output = JSON.stringify(await Browser.type(args));
                    break;
                }
                case 'browser_vision': {
                    args.__progress?.({ message: 'Capturing page' });
                    output = JSON.stringify(await Browser.screenshot(args));
                    break;
                }
                // --- Code Execution (sandboxed Docker container) ---
                case 'code_exec': {
                    if (!CODE_EXEC_ENABLED) throw new Error('Code execution is disabled (set CODE_EXEC_ENABLED=true).');
                    if (!args.language) throw new Error('language is required');
                    if (typeof args.code !== 'string' || !args.code.trim()) throw new Error('code is required');
                    args.__progress?.({ message: `Running ${args.language} in a container` });
                    const result = await runCodeInContainer({
                        language: args.language,
                        code: args.code,
                        stdin: args.stdin || '',
                        timeoutSec: args.timeout,
                        network: !!args.network,
                    });
                    output = JSON.stringify(result);
                    break;
                }

                default:
                    if (extendedTools && extendedTools.has(fnName)) {
                        // Modular extended tools (server/tools/*). Hand them the
                        // same security primitives the built-in cases use so path
                        // sandboxing and platform detection stay consistent.
                        const toolCtx = {
                            sanitizePath, isPathAllowed,
                            WORKSPACE_DIR, HOME_DIR, IS_WINDOWS,
                            pythonBin: process.env.TRICORDER_PYTHON || (IS_WINDOWS ? 'py' : 'python3'),
                            progress: args.__progress,
                        };
                        const result = await extendedTools.execute(fnName, args, toolCtx);
                        output = typeof result === 'string' ? result : JSON.stringify(result);
                    } else {
                        output = JSON.stringify({ error: `Unknown tool: ${fnName}` });
                    }
            }

            log('INFO', 'TOOLS', `#${reqId} ← ${fnName}: ${output.length} chars`);
            state.done = true;
            emitToolEvent('tool_done', {
                index,
                tool_call_id: tc.id,
                tool: fnName,
                elapsedMs: Date.now() - state.startedAt,
                outputBytes: output.length,
            });
            return { tool_call_id: tc.id, output };
        } catch (err) {
            log('ERROR', 'TOOLS', `#${reqId} ✗ ${fnName}: ${err.message}`);
            state.done = true;
            emitToolEvent('tool_error', {
                index,
                tool_call_id: tc.id,
                tool: fnName,
                elapsedMs: Date.now() - state.startedAt,
                error: err.message,
            });
            return { tool_call_id: tc.id, output: JSON.stringify({ error: err.message }) };
        }
    }

    // Wrap a single execution in the per-call watchdog. On timeout the call
    // resolves with a structured error result — the request itself survives.
    async function executeGuarded(tc, index) {
        const fnName = tc.function?.name || tc.name || 'unknown';
        const budget = LONG_RUNNING_TOOL_RE.test(fnName) ? TOOL_LONG_TIMEOUT_MS : TOOL_TIMEOUT_MS;
        let timer;
        const timeoutResult = new Promise((resolve) => {
            timer = setTimeout(() => {
                const state = toolState.get(tc.id || `idx-${index}`);
                if (state) state.done = true;
                log('ERROR', 'TOOLS', `#${reqId} ✗ ${fnName}: timed out after ${Math.round(budget / 1000)}s`);
                emitToolEvent('tool_error', {
                    index,
                    tool_call_id: tc.id,
                    tool: fnName,
                    elapsedMs: budget,
                    error: `Tool timed out after ${Math.round(budget / 1000)}s`,
                });
                resolve({ tool_call_id: tc.id, output: JSON.stringify({ error: `Tool timed out after ${Math.round(budget / 1000)}s`, code: 'TIMEOUT' }) });
            }, budget);
        });
        try {
            return await Promise.race([executeSingle(tc, index), timeoutResult]);
        } finally {
            clearTimeout(timer);
        }
    }

    // Simple semaphore: at most TOOL_MAX_PARALLEL tool calls run at once;
    // the rest queue in arrival order.
    let inFlight = 0;
    const slotWaiters = [];
    async function withSlot(fn) {
        if (inFlight >= TOOL_MAX_PARALLEL) await new Promise(r => slotWaiters.push(r));
        inFlight++;
        try {
            return await fn();
        } finally {
            inFlight--;
            const next = slotWaiters.shift();
            if (next) next();
        }
    }

    const results = await Promise.all(tool_calls.map((tc, idx) => withSlot(() => executeGuarded(tc, idx))));

    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }

    if (streaming) {
        sseWrite('done', { results });
        try { res.end(); } catch {}
    } else {
        jsonRes(res, 200, { results });
    }
}

// --- Speech-to-Text API (Whisper) ---
function readRawBody(req, maxBytes = 25 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', chunk => {
            size += chunk.length;
            if (size > maxBytes) { req.destroy(); reject(new Error('Body too large')); return; }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

// --- Chat Logs API ---
// --- Memory API (direct access for system prompt injection) ---
async function handleMemoryApi(req, res, reqId) {
    const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    // Path after /api/memory — empty string, or /<key>
    const keyPath = urlObj.pathname.replace(/^\/api\/memory\/?/, '');
    log('INFO', 'MEMORY', `#${reqId} ${req.method} /api/memory${keyPath ? '/' + keyPath : ''}`);

    // GET /api/memory — return all memory entries (bucket = server-side
    // classification: seed | live | insight | improvements)
    if (req.method === 'GET' && !keyPath) {
        const mem = loadMemory();
        const entries = Object.entries(mem).map(([key, entry]) => ({
            key,
            // chat_improvements is stored as [{text, addedAt}] internally, but
            // the frontend expects a plain string array — serve that view.
            value: key === 'chat_improvements' ? JSON.stringify(improvementTexts(mem)) : entry.value,
            tags: entry.tags || [], updatedAt: entry.updatedAt,
            source: entry.source || null,
            bucket: classifyMemoryEntry(key, entry),
        }));
        jsonRes(res, 200, { count: entries.length, entries });
        return;
    }

    // GET /api/memory/relevant?q=<text>&k=<n> — rank memory entries against a
    // query (BM25, hybrid with embeddings when the backend answers fast).
    // Used by the frontend for per-turn memory injection.
    if (req.method === 'GET' && keyPath === 'relevant') {
        const q = (urlObj.searchParams.get('q') || '').trim();
        const k = parseInt(urlObj.searchParams.get('k'), 10) || 10;
        if (!q) { jsonRes(res, 200, { entries: [] }); return; }
        const entries = await scoreMemoryEntriesHybrid(q.substring(0, 4000), loadMemory(), k, 800);
        jsonRes(res, 200, { entries });
        return;
    }

    // POST /api/memory — store a memory entry
    if (req.method === 'POST' && !keyPath) {
        const body = await readRawBody(req);
        let data;
        try { data = JSON.parse(body.toString('utf8')); }
        catch { jsonRes(res, 400, { error: 'Invalid JSON' }); return; }
        if (!data.key || !data.value) { jsonRes(res, 400, { error: 'key and value required' }); return; }
        await withMemoryLock(async () => {
            const mem = loadMemory();
            mem[data.key] = {
                value: data.value,
                tags: Array.isArray(data.tags) ? data.tags : (data.tags ? data.tags.split(',').map(t => t.trim()) : []),
                updatedAt: new Date().toISOString(),
            };
            saveMemory(mem);
            jsonRes(res, 200, { ok: true, key: data.key, totalEntries: Object.keys(mem).length });
        });
        return;
    }

    // POST /api/memory/consolidate — dedup + cap chat insights on demand
    if (req.method === 'POST' && keyPath === 'consolidate') {
        await withMemoryLock(async () => {
            const mem = loadMemory();
            const stats = consolidateInsights(mem);
            if (stats.removed > 0) saveMemory(mem);
            jsonRes(res, 200, { ok: true, ...stats, totalEntries: Object.keys(mem).length });
        });
        return;
    }

    // DELETE /api/memory/:key — delete a single memory entry
    if (req.method === 'DELETE' && keyPath) {
        await withMemoryLock(async () => {
            const mem = loadMemory();
            const decoded = decodeURIComponent(keyPath);
            if (!(decoded in mem)) { jsonRes(res, 404, { error: 'Key not found', key: decoded }); return; }
            delete mem[decoded];
            saveMemory(mem);
            jsonRes(res, 200, { ok: true, key: decoded, totalEntries: Object.keys(mem).length });
        });
        return;
    }

    jsonRes(res, 405, { error: 'Method not allowed' });
}

async function handleChatlogsApi(req, res, reqId) {
    const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const endpoint = urlObj.pathname.replace('/api/chatlogs/', '').replace('/api/chatlogs', '').split('?')[0];
    log('INFO', 'CHATLOGS', `#${reqId} ${req.method} /api/chatlogs/${endpoint}`);

    // GET /api/chatlogs/list — list all saved chatlogs
    if (req.method === 'GET' && (endpoint === 'list' || endpoint === '')) {
        jsonRes(res, 200, { chatlogs: listChatlogs() });
        return;
    }

    // GET /api/chatlogs/review/status — what the auto-review loop is doing.
    // Lets the Memory panel show schedule + live progress instead of guessing.
    // Must be checked BEFORE the generic GET /:id handler below.
    if (req.method === 'GET' && endpoint === 'review/status') {
        const chats = listChatlogs();
        jsonRes(res, 200, {
            reviewHour: CHATLOG_REVIEW_HOUR,
            running: _reviewRunning,
            lastRunAt: _lastReviewAt,
            lastRunStats: _lastReviewStats,
            nextRunAt: nextReviewRunAt(),
            reviewed: chats.filter(c => c.reviewed).length,
            // "unreviewed" = chats the next review run will actually process.
            // Chats below the message threshold are reported separately so the
            // UI doesn't show a pending backlog that can never drain.
            unreviewed: chats.filter(isReviewEligible).length,
            tooShort: chats.filter(c => !c.reviewed && c.messageCount < CHATLOG_REVIEW_MIN_MESSAGES).length,
            minMessages: CHATLOG_REVIEW_MIN_MESSAGES,
        });
        return;
    }

    // GET /api/chatlogs/:id — get a specific chatlog
    if (req.method === 'GET' && endpoint) {
        const chat = loadChatlog(endpoint);
        if (!chat) { jsonRes(res, 404, { error: 'Chat not found' }); return; }
        jsonRes(res, 200, chat);
        return;
    }

    // POST /api/chatlogs/review — trigger a review now
    // Must be checked BEFORE the generic POST handler below, otherwise
    // the save handler intercepts and 400s on the empty body.
    if (req.method === 'POST' && endpoint === 'review') {
        if (_reviewRunning) {
            jsonRes(res, 200, { ok: true, alreadyRunning: true, message: 'Review already in progress' });
            return;
        }
        reviewChatlogs().catch(e => log('ERROR', 'CHATLOGS', `Manual review failed: ${e.message}`));
        jsonRes(res, 200, { ok: true, message: 'Review started' });
        return;
    }

    // POST /api/chatlogs — save a chatlog
    if (req.method === 'POST') {
        const body = await readRawBody(req);
        let data;
        try { data = JSON.parse(body.toString('utf8')); }
        catch { jsonRes(res, 400, { error: 'Invalid JSON' }); return; }

        if (!data.id || !Array.isArray(data.messages)) {
            jsonRes(res, 400, { error: 'id and messages[] required' });
            return;
        }
        saveChatlog(data.id, data);
        jsonRes(res, 200, { ok: true, id: data.id });
        return;
    }

    // DELETE /api/chatlogs/:id — delete a chatlog
    if (req.method === 'DELETE' && endpoint) {
        const ok = deleteChatlog(endpoint);
        jsonRes(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'Not found' });
        return;
    }

    jsonRes(res, 405, { error: 'Method not allowed' });
}

// --- File Manager API ---
// MIME types for the /api/files/raw endpoint. Anything not listed falls
// through to application/octet-stream and the browser will offer a download.
const RAW_MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.htm':  'text/html; charset=utf-8',
    '.svg':  'image/svg+xml',
    '.css':  'text/css; charset=utf-8',
    '.js':   'application/javascript; charset=utf-8',
    '.mjs':  'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.txt':  'text/plain; charset=utf-8',
    '.md':   'text/plain; charset=utf-8',
    '.xml':  'application/xml; charset=utf-8',
    '.csv':  'text/csv; charset=utf-8',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif':  'image/gif',
    '.webp': 'image/webp',
    '.bmp':  'image/bmp',
    '.ico':  'image/x-icon',
    '.pdf':  'application/pdf',
    '.mp3':  'audio/mpeg',
    '.wav':  'audio/wav',
    '.ogg':  'audio/ogg',
    '.mp4':  'video/mp4',
    '.webm': 'video/webm',
};

async function handleFilesApi(req, res, reqId) {
    const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const endpoint = urlObj.pathname.replace('/api/files/', '').split('?')[0];
    log('INFO', 'FILES', `#${reqId} ${req.method} /api/files/${endpoint}`);

    // --- Browse directory ---
    if (req.method === 'GET' && endpoint === 'browse') {
        const targetPath = sanitizePath(urlObj.searchParams.get('path') || HOME_DIR);
        if (!targetPath) {
            jsonRes(res, 403, { error: 'Access denied: path outside allowed directories' });
            return;
        }

        try {
            const stat = await fs.promises.stat(targetPath);
            if (!stat.isDirectory()) {
                jsonRes(res, 400, { error: 'Path is not a directory' });
                return;
            }

            const dirents = await fs.promises.readdir(targetPath, { withFileTypes: true });
            const entries = [];
            for (const d of dirents) {
                // Skip hidden/system files starting with .
                try {
                    const fullPath = path.join(targetPath, d.name);
                    const s = await fs.promises.stat(fullPath).catch(() => null);
                    entries.push({
                        name: d.name,
                        type: d.isDirectory() ? 'dir' : 'file',
                        size: s ? s.size : 0,
                        modified: s ? s.mtime.toISOString() : null,
                        ext: d.isDirectory() ? null : path.extname(d.name).toLowerCase(),
                    });
                } catch { /* skip inaccessible entries */ }
            }

            // Sort: dirs first, then files, alphabetically within each group
            entries.sort((a, b) => {
                if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
                return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
            });

            const parent = path.dirname(targetPath);
            jsonRes(res, 200, {
                path: targetPath,
                parent: isPathAllowed(parent) ? parent : null,
                entries,
            });
        } catch (e) {
            log('ERROR', 'FILES', `#${reqId} Browse failed: ${e.message}`);
            jsonRes(res, 500, { error: e.message });
        }
        return;
    }

    // --- Read file ---
    if (req.method === 'GET' && endpoint === 'read') {
        const targetPath = sanitizePath(urlObj.searchParams.get('path'));
        if (!targetPath) {
            jsonRes(res, 403, { error: 'Access denied: path outside allowed directories' });
            return;
        }
        const maxSize = parseInt(urlObj.searchParams.get('maxSize'), 10) || 102400;

        try {
            const stat = await fs.promises.stat(targetPath);
            if (stat.isDirectory()) {
                jsonRes(res, 400, { error: 'Path is a directory, not a file' });
                return;
            }
            const ext = path.extname(targetPath).toLowerCase();
            if (BINARY_EXTENSIONS.has(ext)) {
                jsonRes(res, 400, { error: `Binary file type (${ext}) cannot be read as text` });
                return;
            }
            if (stat.size > maxSize) {
                jsonRes(res, 400, { error: `File too large (${stat.size} bytes, max ${maxSize})` });
                return;
            }

            const content = await fs.promises.readFile(targetPath, 'utf8');
            jsonRes(res, 200, { path: targetPath, content, size: stat.size, encoding: 'utf8' });
        } catch (e) {
            log('ERROR', 'FILES', `#${reqId} Read failed: ${e.message}`);
            jsonRes(res, 500, { error: e.message });
        }
        return;
    }

    // --- Raw file stream (for inline preview: HTML/SVG/images/PDF/etc.) ---
    // Used by the chat canvas to render workspace files the agent created.
    // Iframes loading this URL must keep sandbox="allow-scripts" (no
    // allow-same-origin) so a malicious file can't reach Tricorder state.
    if (req.method === 'GET' && endpoint === 'raw') {
        const targetPath = sanitizePath(urlObj.searchParams.get('path'));
        if (!targetPath) {
            jsonRes(res, 403, { error: 'Access denied: path outside allowed directories' });
            return;
        }
        const maxSize = parseInt(urlObj.searchParams.get('maxSize'), 10) || 25 * 1024 * 1024;
        try {
            const stat = await fs.promises.stat(targetPath);
            if (stat.isDirectory()) {
                jsonRes(res, 400, { error: 'Path is a directory, not a file' });
                return;
            }
            if (stat.size > maxSize) {
                jsonRes(res, 413, { error: `File too large (${stat.size} bytes, max ${maxSize})` });
                return;
            }
            const ext = path.extname(targetPath).toLowerCase();
            const contentType = RAW_MIME_TYPES[ext] || 'application/octet-stream';
            const safeName = path.basename(targetPath).replace(/["\r\n]/g, '');
            res.writeHead(200, {
                'Content-Type': contentType,
                'Content-Length': stat.size,
                'X-Content-Type-Options': 'nosniff',
                'Content-Disposition': `inline; filename="${safeName}"`,
                'Cache-Control': 'no-store',
            });
            const stream = fs.createReadStream(targetPath);
            stream.on('error', () => { try { res.end(); } catch {} });
            stream.pipe(res);
            log('INFO', 'FILES', `#${reqId} Streamed ${stat.size}B from ${targetPath} as ${contentType}`);
        } catch (e) {
            log('ERROR', 'FILES', `#${reqId} Raw read failed: ${e.message}`);
            jsonRes(res, 500, { error: e.message });
        }
        return;
    }

    // --- Write file ---
    if (req.method === 'POST' && endpoint === 'write') {
        const body = await readJsonBody(req);
        const targetPath = sanitizePath(body.path);
        if (!targetPath) {
            jsonRes(res, 403, { error: 'Access denied: path outside allowed directories' });
            return;
        }
        if (typeof body.content !== 'string') {
            jsonRes(res, 400, { error: 'content (string) is required' });
            return;
        }

        try {
            // Ensure parent directory exists
            await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
            await fs.promises.writeFile(targetPath, body.content, 'utf8');
            const stat = await fs.promises.stat(targetPath);
            log('INFO', 'FILES', `#${reqId} Wrote ${stat.size} bytes to ${targetPath}`);
            jsonRes(res, 200, { ok: true, path: targetPath, size: stat.size });
        } catch (e) {
            log('ERROR', 'FILES', `#${reqId} Write failed: ${e.message}`);
            jsonRes(res, 500, { error: e.message });
        }
        return;
    }

    // --- Search files ---
    if (req.method === 'GET' && endpoint === 'search') {
        const searchRoot = sanitizePath(urlObj.searchParams.get('path') || HOME_DIR);
        if (!searchRoot) {
            jsonRes(res, 403, { error: 'Access denied: path outside allowed directories' });
            return;
        }
        const query = (urlObj.searchParams.get('query') || '').toLowerCase();
        if (!query) {
            jsonRes(res, 400, { error: 'query parameter required' });
            return;
        }
        const maxResults = Math.min(parseInt(urlObj.searchParams.get('maxResults'), 10) || 50, 200);
        const MAX_DEPTH = 8;

        const results = [];

        async function searchDir(dirPath, depth) {
            if (depth > MAX_DEPTH || results.length >= maxResults) return;
            try {
                const dirents = await fs.promises.readdir(dirPath, { withFileTypes: true });
                for (const d of dirents) {
                    if (results.length >= maxResults) break;
                    // Skip hidden dirs and node_modules
                    if (d.name.startsWith('.') || d.name === 'node_modules') continue;
                    const fullPath = path.join(dirPath, d.name);
                    if (d.name.toLowerCase().includes(query)) {
                        try {
                            const s = await fs.promises.stat(fullPath);
                            results.push({
                                path: fullPath,
                                name: d.name,
                                type: d.isDirectory() ? 'dir' : 'file',
                                size: s.size,
                            });
                        } catch { /* skip */ }
                    }
                    if (d.isDirectory()) {
                        await searchDir(fullPath, depth + 1);
                    }
                }
            } catch { /* skip inaccessible dirs */ }
        }

        try {
            await searchDir(searchRoot, 0);
            log('INFO', 'FILES', `#${reqId} Search "${query}" found ${results.length} results`);
            jsonRes(res, 200, { query, root: searchRoot, results });
        } catch (e) {
            log('ERROR', 'FILES', `#${reqId} Search failed: ${e.message}`);
            jsonRes(res, 500, { error: e.message });
        }
        return;
    }

    // --- File info ---
    if (req.method === 'GET' && endpoint === 'info') {
        const targetPath = sanitizePath(urlObj.searchParams.get('path'));
        if (!targetPath) {
            jsonRes(res, 403, { error: 'Access denied: path outside allowed directories' });
            return;
        }

        try {
            const stat = await fs.promises.stat(targetPath);
            jsonRes(res, 200, {
                path: targetPath,
                name: path.basename(targetPath),
                type: stat.isDirectory() ? 'dir' : 'file',
                size: stat.size,
                created: stat.birthtime.toISOString(),
                modified: stat.mtime.toISOString(),
                accessed: stat.atime.toISOString(),
                permissions: (stat.mode & 0o777).toString(8),
                ext: stat.isDirectory() ? null : path.extname(targetPath).toLowerCase(),
            });
        } catch (e) {
            log('ERROR', 'FILES', `#${reqId} Info failed: ${e.message}`);
            jsonRes(res, 500, { error: e.message });
        }
        return;
    }

    // --- Extract text from binary files (PDF, DOCX, XLSX, PPTX, ZIP) ---
    if (req.method === 'POST' && endpoint === 'extract') {
        const body = await readJsonBody(req);

        try {
            const fileExtract = require('./file-extract');
            let buffer, ext, fileName;

            if (body.path) {
                // Read from disk
                const targetPath = sanitizePath(body.path);
                if (!targetPath) {
                    jsonRes(res, 403, { error: 'Access denied: path outside allowed directories' });
                    return;
                }
                ext = path.extname(targetPath).toLowerCase();
                fileName = path.basename(targetPath);
                buffer = await fs.promises.readFile(targetPath);
            } else if (body.data && body.filename) {
                // Base64-encoded upload
                ext = path.extname(body.filename).toLowerCase();
                fileName = body.filename;
                buffer = Buffer.from(body.data, 'base64');
            } else {
                jsonRes(res, 400, { error: 'Provide either { path } or { data, filename }' });
                return;
            }

            if (!fileExtract.canExtract(ext)) {
                jsonRes(res, 400, { error: `Unsupported file type: ${ext}. Supported: ${[...fileExtract.EXTRACTABLE_EXTENSIONS].join(', ')}` });
                return;
            }

            // 20MB limit
            if (buffer.length > 20 * 1024 * 1024) {
                jsonRes(res, 400, { error: `File too large (${(buffer.length / 1048576).toFixed(1)} MB, max 20 MB)` });
                return;
            }

            const result = fileExtract.extractText(buffer, ext);
            // Truncate to 50KB to fit in LLM context
            if (result.text.length > 50000) {
                result.text = result.text.substring(0, 50000) + '\n\n[...truncated — extracted text exceeded 50KB]';
            }
            log('INFO', 'FILES', `#${reqId} Extracted ${result.type} from ${fileName} (${result.text.length} chars)`);
            jsonRes(res, 200, { filename: fileName, type: result.type, text: result.text, size: buffer.length });
        } catch (e) {
            log('ERROR', 'FILES', `#${reqId} Extract failed: ${e.message}`);
            jsonRes(res, 500, { error: `Extraction failed: ${e.message}` });
        }
        return;
    }

    jsonRes(res, 404, { error: 'Unknown files API endpoint' });
}

// --- Background Tasks API ---
// tasks[] and taskIdCounter are declared near the top of the file (shared with tool exec).

function generateTaskId() {
    return `task_${++taskIdCounter}_${Date.now()}`;
}

function parseSchedule(schedule) {
    if (!schedule) return null;
    const s = schedule.trim().toLowerCase();

    // "every Nm" or "every Nh"
    const everyMatch = s.match(/^every\s+(\d+)\s*(m|min|minutes?|h|hr|hours?)$/);
    if (everyMatch) {
        const value = parseInt(everyMatch[1], 10);
        const unit = everyMatch[2].startsWith('h') ? 'h' : 'm';
        const intervalMs = unit === 'h' ? value * 3600000 : value * 60000;
        return { type: 'interval', intervalMs, raw: schedule };
    }

    // "at HH:MM"
    const atMatch = s.match(/^at\s+(\d{1,2}):(\d{2})$/);
    if (atMatch) {
        const hour = parseInt(atMatch[1], 10);
        const minute = parseInt(atMatch[2], 10);
        if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
            return { type: 'daily', hour, minute, raw: schedule };
        }
    }

    // Standard 5-field cron: "min hour day-of-month month day-of-week".
    // Accepts an optional "cron:" prefix. Each field supports *, */n, a-b,
    // a-b/n, and comma lists. Enables things like "0 9 * * 1-5" (weekday 09:00).
    const cronStr = s.replace(/^cron:\s*/, '');
    const parts = cronStr.split(/\s+/);
    if (parts.length === 5 && /^[\d*,/-]+$/.test(parts.join(''))) {
        const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
        const fields = parts.map((f, i) => parseCronField(f, ranges[i][0], ranges[i][1]));
        if (fields.every(Boolean)) {
            return { type: 'cron', fields, raw: schedule };
        }
    }

    return null;
}

// Expand one cron field into a Set of allowed integers. Returns null if the
// field is malformed so the caller can reject the whole expression.
function parseCronField(field, min, max) {
    const allowed = new Set();
    for (const part of field.split(',')) {
        const [rangePart, stepPart] = part.split('/');
        const step = stepPart ? parseInt(stepPart, 10) : 1;
        if (!Number.isInteger(step) || step < 1) return null;
        let lo, hi;
        if (rangePart === '*') {
            lo = min; hi = max;
        } else if (rangePart.includes('-')) {
            const [a, b] = rangePart.split('-').map(n => parseInt(n, 10));
            if (!Number.isInteger(a) || !Number.isInteger(b)) return null;
            lo = a; hi = b;
        } else {
            const v = parseInt(rangePart, 10);
            if (!Number.isInteger(v)) return null;
            lo = v; hi = v;
        }
        if (lo < min || hi > max || lo > hi) return null;
        for (let v = lo; v <= hi; v += step) allowed.add(v);
    }
    return allowed.size ? allowed : null;
}

// Does `date` satisfy a parsed cron `fields` array? Day-of-month and
// day-of-week use cron's OR semantics when both are restricted.
function cronMatchesDate(fields, date) {
    const [min, hr, dom, mon, dow] = fields;
    const dowVal = date.getDay(); // 0=Sun..6=Sat (7 also means Sun if present)
    const domRestricted = dom.size < 31;
    const dowRestricted = dow.size < 7;
    let dayOk;
    const domHit = dom.has(date.getDate());
    const dowHit = dow.has(dowVal) || (dowVal === 0 && dow.has(7));
    if (domRestricted && dowRestricted) dayOk = domHit || dowHit;
    else dayOk = domHit && dowHit;
    return min.has(date.getMinutes()) && hr.has(date.getHours())
        && mon.has(date.getMonth() + 1) && dayOk;
}

function computeNextRun(task) {
    const sched = parseSchedule(task.schedule);
    if (!sched) return null;

    if (sched.type === 'interval') {
        const base = task.lastRun ? new Date(task.lastRun).getTime() : Date.now();
        return new Date(base + sched.intervalMs).toISOString();
    }

    if (sched.type === 'daily') {
        const now = new Date();
        const next = new Date(now);
        next.setHours(sched.hour, sched.minute, 0, 0);
        if (next <= now) next.setDate(next.getDate() + 1);
        return next.toISOString();
    }

    if (sched.type === 'cron') {
        // Scan forward minute-by-minute from the next whole minute. Cap at
        // ~366 days so an impossible expression (e.g. Feb 30) can't loop.
        const cur = new Date();
        cur.setSeconds(0, 0);
        cur.setMinutes(cur.getMinutes() + 1);
        const limit = 366 * 24 * 60;
        for (let i = 0; i < limit; i++) {
            if (cronMatchesDate(sched.fields, cur)) return cur.toISOString();
            cur.setMinutes(cur.getMinutes() + 1);
        }
        return null;
    }

    return null;
}

// Load the native tool schemas from js/llm-tools/*.js — the same definitions
// the browser agent uses — by running each file with a register() shim. These
// are pure `TricorderNativeTools.register([...])` calls (no DOM access).
let _nativeToolDefs = null;
function loadNativeToolDefs() {
    if (_nativeToolDefs) return _nativeToolDefs;
    const dir = path.join(__dirname, 'js', 'llm-tools');
    const collected = [];
    const shim = { register(arr) { if (Array.isArray(arr)) collected.push(...arr); } };
    try {
        for (const f of fs.readdirSync(dir)) {
            if (!f.endsWith('.js') || f === 'registry.js' || f === 'tool-index.js') continue;
            try {
                const code = fs.readFileSync(path.join(dir, f), 'utf8');
                new Function('TricorderNativeTools', code)(shim);
            } catch (e) { log('DEBUG', 'WA-AI', `tool defs ${f}: ${e.message}`); }
        }
    } catch (e) { log('WARN', 'WA-AI', `could not load tool defs: ${e.message}`); }
    _nativeToolDefs = collected;
    log('INFO', 'TOOLS', `Loaded ${collected.length} native tool definitions for the server-side agent`);
    return collected;
}

// Execute tool calls through the existing server-side executor (reuses the full
// switch in handleToolExecApi) via an internal loopback call.
function executeToolCallsInternal(tool_calls) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ tool_calls });
        const r = http.request({
            method: 'POST', hostname: '127.0.0.1', port: PORT, path: '/api/tools/execute',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
                'X-Internal-Token': INTERNAL_TOKEN,
            },
            agent: httpAgent, timeout: 180000,
        }, (res) => {
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', () => { try { resolve(JSON.parse(data).results || []); } catch { reject(new Error('tool exec parse error')); } });
        });
        r.on('error', reject);
        r.on('timeout', () => { r.destroy(); reject(new Error('tool exec timeout')); });
        r.write(body); r.end();
    });
}

// ============================================================================

// Resolve which model id to send. An explicit LLM_MODEL always wins. When it's
// "auto" (default), ask the backend's /v1/models and use the first one — so
// LM Studio "just works" with whatever model is loaded (and, with JIT loading
// enabled, even auto-loads it). Falls back to "auto" (uncached) until a model
// is available, so it self-heals once you load one.
let _resolvedModel = null;
function fetchModelIds() {
    return new Promise((resolve, reject) => {
        const u = new URL('/v1/models', LLM_TARGET);
        const transport = u.protocol === 'https:' ? https : http;
        const r = transport.request({
            method: 'GET', hostname: u.hostname, port: u.port, path: u.pathname,
            headers: { ...(LM_STUDIO_API_KEY ? { 'Authorization': `Bearer ${LM_STUDIO_API_KEY}` } : {}) },
            agent: transport === https ? httpsAgent : httpAgent, timeout: 8000,
        }, (res) => {
            let d = ''; res.on('data', c => { d += c; });
            res.on('end', () => { try { resolve((JSON.parse(d).data || []).map(m => m.id).filter(Boolean)); } catch { reject(new Error('models parse error')); } });
        });
        r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('models timeout')); }); r.end();
    });
}
async function getLlmModel() {
    if (LLM_MODEL && LLM_MODEL !== 'auto') return LLM_MODEL;
    if (_resolvedModel) return _resolvedModel;
    try {
        const ids = await fetchModelIds();
        if (ids[0]) { _resolvedModel = ids[0]; log('INFO', 'LLM', `Using model "${_resolvedModel}" (auto-detected from backend)`); return _resolvedModel; }
    } catch { /* backend down / no models — fall through */ }
    return 'auto'; // not cached, so we retry detection next call
}

// Local "hybrid thinking" models (Qwen 3.x, DeepSeek R1) emit their chain-of-
// thought inside <think>…</think> (sometimes <thinking>/<reasoning>) in the
// message content. That's meant for the app's reasoning panel — it must never
// be forwarded to the chat window, a notification, or any other channel.
// Strip complete blocks, and also handle a dangling </think> with no surviving
// opening tag (the open token is often eaten by the chat template) by dropping
// everything up to and including the last close tag.
function stripReasoning(text) {
    if (text == null) return '';
    let s = String(text);
    // Well-formed <think>…</think> / <thinking> / <reasoning> blocks anywhere.
    s = s.replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '');
    // Dangling close tag: reasoning streamed before any opening tag survived.
    const closes = s.match(/<\/(?:think|thinking|reasoning)>/gi);
    if (closes) {
        const last = closes[closes.length - 1];
        s = s.slice(s.lastIndexOf(last) + last.length);
    }
    // A lone unclosed reasoning tag at the very start (all think, no answer yet).
    s = s.replace(/^\s*<(?:think|thinking|reasoning)>[\s\S]*$/i, '');
    return s.trim();
}

// Some OpenAI-compatible backends don't lift a model's *textual* tool-call
// syntax into the structured `tool_calls` field — the model emits the call
// inline in `content` instead, e.g.
//   <tool_call>{"name":"web_search","arguments":{"query":"…"}}</tool_call>
// or the function/parameter form
//   <tool_call><function=run_command><parameter=command>…</parameter></function></tool_call>
// Left untouched, that raw markup leaks straight to the user and the tool never
// runs. Pull it out so the agent loop can execute it like a real tool call, and
// strip it from the visible reply. Returns { toolCalls, text } where text has
// every recognised call removed. Only blocks we can actually parse are stripped.
function parseTextToolCalls(content) {
    const text = String(content || '');
    if (!/<tool_call|<function\s*=/i.test(text)) return { toolCalls: [], text };
    const calls = [];

    const pushCall = (name, args) => {
        if (!name) return false;
        calls.push({
            id: `txt_${Date.now().toString(36)}_${calls.length}`,
            type: 'function',
            function: {
                name: String(name).trim(),
                arguments: typeof args === 'string' ? args : JSON.stringify(args || {}),
            },
        });
        return true;
    };

    // Turn one inner blob into a tool call. Prefer the explicit <function=…> tag
    // form (its <parameter> values can legitimately contain { } that aren't
    // JSON, e.g. a Python f-string); otherwise fall back to a
    // {"name":…,"arguments":…} JSON object.
    const parseInner = (blob) => {
        const s = String(blob);
        const fn = s.match(/<function\s*=\s*([^>\s]+)\s*>/i);
        if (fn) {
            const args = {};
            const re = /<parameter\s*=\s*([^>\s]+)\s*>([\s\S]*?)<\/parameter\s*>/gi;
            let pm;
            while ((pm = re.exec(s)) !== null) {
                let v = pm[2].trim();
                if (/^-?\d+$/.test(v)) v = parseInt(v, 10);
                else if (/^-?\d*\.\d+$/.test(v)) v = parseFloat(v);
                else if (v === 'true' || v === 'false') v = (v === 'true');
                else if (/^[[{]/.test(v)) { try { v = JSON.parse(v); } catch { /* keep raw string */ } }
                args[pm[1].trim()] = v;
            }
            return pushCall(fn[1], args);
        }
        const j = s.match(/\{[\s\S]*\}/);
        if (j) {
            try {
                const obj = JSON.parse(j[0]);
                const name = obj.name || obj.function?.name || obj.tool || obj.tool_name;
                let a = obj.arguments ?? obj.parameters ?? obj.args ?? {};
                if (typeof a === 'string') { try { a = JSON.parse(a); } catch { /* keep string */ } }
                return pushCall(name, a);
            } catch { /* not JSON — give up on this block */ }
        }
        return false;
    };

    let cleaned = text;
    // <tool_call> … </tool_call> (closed first, then a tolerant unclosed variant
    // for truncated output that dropped the closing tag).
    cleaned = cleaned.replace(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call\s*>/gi, (m, inner) => parseInner(inner) ? '' : m);
    cleaned = cleaned.replace(/<tool_call>\s*([\s\S]*?)\s*$/i, (m, inner) => parseInner(inner) ? '' : m);
    // Bare <function=…>…</function> with no <tool_call> wrapper (closed + unclosed).
    cleaned = cleaned.replace(/<function\s*=\s*[^>]+>[\s\S]*?<\/function\s*>/gi, (m) => parseInner(m) ? '' : m);
    cleaned = cleaned.replace(/<function\s*=\s*[^>]+>[\s\S]*$/i, (m) => parseInner(m) ? '' : m);

    cleaned = cleaned.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    return { toolCalls: calls, text: cleaned };
}

// Server-side LLM call against the configured OpenAI-compatible backend
// (LM_STUDIO_URL).
// Returns the full assistant message ({ content, tool_calls }); rejects on
// transport error. Pass `tools` to enable function calling. The assistant's
// content is run through stripReasoning() so leaked <think> chain-of-thought
// never reaches a delivery channel (the app chat strips it client-side).
async function llmChatRaw(messages, { tools, toolChoice, maxTokens = 800, temperature = 0.6, timeoutMs = LLM_TIMEOUT_MS, model: modelOverride, baseUrl, headers: extraHeaders, signal, responseFormat } = {}) {
    const model = modelOverride || await getLlmModel();
    return new Promise((resolve, reject) => {
        if (signal?.aborted) { reject(new Error('aborted')); return; }
        const payload = { model, messages, max_tokens: maxTokens, temperature };
        // Constrained decoding, when the caller needs JSON rather than prose.
        // Only sent when asked for: a backend that doesn't know the field
        // rejects the whole request, so every existing caller must be unaffected.
        if (responseFormat) payload.response_format = responseFormat;
        if (tools && tools.length) { payload.tools = tools; payload.tool_choice = toolChoice || 'auto'; }
        const body = JSON.stringify(payload);
        // Default to the configured backend. Callers can point this at the local
        // /llm proxy (with X-LM-Target / X-Internal-Token headers) to reuse the
        // exact backend + API-key routing the browser used — see the background
        // agent hand-off. Append the path rather than using new URL(path, base),
        // which would drop a base path like "…/llm".
        const targetUrl = new URL((baseUrl || LLM_TARGET).replace(/\/+$/, '') + '/v1/chat/completions');
        const transport = targetUrl.protocol === 'https:' ? https : http;
        const r = transport.request({
            method: 'POST',
            hostname: targetUrl.hostname,
            port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
            path: targetUrl.pathname,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
                ...(LM_STUDIO_API_KEY ? { 'Authorization': `Bearer ${LM_STUDIO_API_KEY}` } : {}),
                ...(extraHeaders || {}),
            },
            agent: transport === https ? httpsAgent : httpAgent,
            timeout: timeoutMs,
        }, (res) => {
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (res.statusCode >= 400) return reject(new Error(`LLM ${res.statusCode}: ${parsed.error?.message || parsed.error || JSON.stringify(parsed).slice(0, 200)}`));
                    const choice = parsed.choices?.[0] || null;
                    const msg = choice?.message || null;
                    const finishReason = choice?.finish_reason ?? null;
                    const usage = parsed.usage || null;
                    // The empty-prediction signature of a mid-generation
                    // disconnect (LM Studio: "Client disconnected. Stopping
                    // generation"): no message, or empty content with no tool
                    // calls and either no finish_reason at all or a "stop"
                    // that produced zero completion tokens. Never surface
                    // that as a successful completion.
                    const completionTokens = Number.isFinite(usage?.completion_tokens) ? usage.completion_tokens : null;
                    if (!msg || (!(msg.tool_calls?.length) && !(typeof msg.content === 'string' && msg.content.trim())
                        && (finishReason == null || (finishReason === 'stop' && !completionTokens)))) {
                        return reject(new Error(`LLM returned an empty completion (finish_reason: ${finishReason ?? 'absent'}, completion_tokens: ${completionTokens ?? 'absent'}) — likely an interrupted generation`));
                    }
                    // Truncation is a caller-visible condition, not a short
                    // answer — surface it on the message and flag it loudly.
                    msg.finish_reason = finishReason;
                    msg.usage = usage;
                    if (finishReason === 'length') {
                        log('WARN', 'LLM', `completion truncated at max_tokens (finish_reason "length", ${completionTokens ?? '?'} tokens) — callers should treat this as incomplete`);
                    }
                    if (msg && typeof msg.content === 'string') {
                        msg.content = stripReasoning(msg.content);
                        // Recover (and strip) any textual tool-call markup the
                        // backend left inline because it didn't populate the
                        // structured tool_calls field — otherwise it leaks to
                        // delivered verbatim and the tool never runs.
                        if (!Array.isArray(msg.tool_calls) || !msg.tool_calls.length) {
                            const recovered = parseTextToolCalls(msg.content);
                            if (recovered.toolCalls.length) {
                                msg.tool_calls = recovered.toolCalls;
                                msg.content = recovered.text;
                                log('INFO', 'LLM', `Recovered ${recovered.toolCalls.length} textual tool call(s) from content: ${recovered.toolCalls.map(t => t.function.name).join(', ')}`);
                            }
                        }
                    }
                    resolve(msg);
                } catch { reject(new Error(`LLM parse error (status ${res.statusCode}): ${String(data).slice(0, 200)}`)); }
            });
        });
        r.on('error', reject);
        r.on('timeout', () => { r.destroy(); reject(new Error(`LLM timeout after ${timeoutMs}ms with no response — the backend may still be generating; raise LLM_TIMEOUT_MS (or the call's timeoutMs) for long generations`)); });
        // Operator aborted the background run — tear the request down.
        if (signal) {
            signal.addEventListener('abort', () => { try { r.destroy(); } catch {} reject(new Error('aborted')); }, { once: true });
        }
        r.write(body); r.end();
    });
}

// Convenience wrapper that returns just the assistant text (no tools).
function llmChat(messages, opts = {}) {
    return llmChatRaw(messages, opts).then(m => m?.content || '');
}

// ============================================================
// AI task API — /api/ai/*
// ============================================================
// Tricorder Agent's own surfaces (chat, scheduled tasks, background agents) all
// reach the model through llmChatRaw, which knows how to pick the model,
// strip leaked reasoning and notice a truncated or interrupted generation.
// Nothing outside the process could: an external caller got the bare /llm
// passthrough and had to rebuild all of that itself.
//
// /api/ai/* puts the same capabilities on the wire for any other app on your
// machine or LAN. It is gated by the site password like every other /api/*
// route, and it composes the existing internals rather than duplicating them,
// so an answer served here goes through exactly the pipeline the app's own
// chat does. Streaming stays at /llm/v1/chat/completions, which has durable
// resume.

const AI_ENDPOINTS = [
    { method: 'GET',  path: '/api/ai/capabilities',   summary: 'Model, vision model, backend reachability, plus this list' },
    { method: 'GET',  path: '/api/ai/health',         summary: 'Per-service reachability with latency' },
    { method: 'POST', path: '/api/ai/chat',           summary: '{ prompt | messages, system, images, model, max_tokens } → { text }' },
    { method: 'POST', path: '/api/ai/json',           summary: '{ prompt, schema } → { data }' },
    { method: 'POST', path: '/api/ai/vision',         summary: '{ image, prompt } → { text } — uses LLM_VISION_MODEL when set' },
    { method: 'POST', path: '/api/ai/caption',        summary: '{ image, style: natural|tags|alt|prompt } → { caption }' },
    { method: 'POST', path: '/api/ai/summarize',      summary: '{ text, maxWords, language, format } → { summary }' },
    { method: 'POST', path: '/api/ai/translate',      summary: '{ text, to, from } → { text }' },
    { method: 'POST', path: '/api/ai/enhance-prompt', summary: '{ prompt, target, style } → { prompt, negative }' },
    { method: 'POST', path: '/api/ai/embed',          summary: '{ input } → { vectors, dims } — the same embedder memory search uses' },
];

function aiImagePart(src) {
    const s = String(src || '').trim();
    if (!s) return null;
    if (/^data:/i.test(s) || /^https?:\/\//i.test(s)) return { type: 'image_url', image_url: { url: s } };
    const cleaned = s.replace(/\s+/g, '');
    if (/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned) && cleaned.length > 64) {
        return { type: 'image_url', image_url: { url: `data:image/png;base64,${cleaned}` } };
    }
    return null;
}

// Accepts several shorthands so a caller isn't forced to build a messages
// array: a bare `prompt`, a `system` preamble, an OpenAI `messages` array, or
// images alongside any of them.
function aiMessages({ messages, prompt, system, image, images } = {}) {
    const out = [];
    if (system) out.push({ role: 'system', content: String(system) });
    if (Array.isArray(messages) && messages.length) {
        for (const m of messages) if (m && m.role) out.push({ role: m.role, content: m.content ?? '' });
    } else if (prompt != null) {
        out.push({ role: 'user', content: String(prompt) });
    }
    const imgs = (Array.isArray(images) ? images : image ? [image] : []).map(aiImagePart).filter(Boolean);
    if (imgs.length) {
        let i = out.length - 1;
        while (i >= 0 && out[i].role !== 'user') i--;
        if (i < 0) { out.push({ role: 'user', content: '' }); i = out.length - 1; }
        const text = typeof out[i].content === 'string' ? out[i].content : '';
        out[i] = { role: 'user', content: [...(text ? [{ type: 'text', text }] : []), ...imgs] };
    }
    return out;
}

// Models fence their JSON or wrap it in a sentence often enough that an
// endpoint accepting only a bare object would reject answers that are right.
function aiParseJson(text) {
    const s = String(text || '').trim();
    if (!s) return null;
    try { return JSON.parse(s); } catch {}
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) { try { return JSON.parse(fence[1].trim()); } catch {} }
    const first = s.search(/[[{]/);
    if (first >= 0) {
        const last = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
        if (last > first) { try { return JSON.parse(s.slice(first, last + 1)); } catch {} }
    }
    return null;
}

async function aiRun(body, overrides = {}) {
    const b = { ...body, ...overrides };
    const messages = aiMessages(b);
    if (!messages.some(m => m.role !== 'system')) throw new Error('prompt or messages is required');
    const hasImages = messages.some(m => Array.isArray(m.content));
    // A text-only chat model rejects image turns, so a vision request goes to
    // LLM_VISION_MODEL when the operator configured one. Resolved here rather
    // than left to llmChatRaw so the response can report what actually served.
    const model = b.model || (hasImages && LLM_VISION_MODEL ? LLM_VISION_MODEL : await getLlmModel());
    // Structured output, when the caller asked for a shape rather than prose.
    const schema = b.json_schema || b.schema;
    const responseFormat = schema
        ? { type: 'json_schema', json_schema: { name: 'response', strict: b.strict !== false, schema } }
        : (b.json === true ? { type: 'json_object' } : undefined);
    const t0 = Date.now();
    const opts = {
        model,
        responseFormat,
        maxTokens: parseInt(b.max_tokens ?? b.maxTokens, 10) || 800,
        temperature: Number.isFinite(Number(b.temperature)) ? Number(b.temperature) : 0.6,
        timeoutMs: Math.max(1000, parseInt(b.timeout_ms, 10) || LLM_TIMEOUT_MS),
    };
    let msg;
    try {
        msg = await llmChatRaw(messages, opts);
    } catch (e) {
        // Not every backend/model pair supports constrained decoding, and one
        // that doesn't rejects the whole request rather than ignoring the
        // field. The system prompt already asks for JSON, so retry without the
        // constraint instead of failing a request the model could answer.
        if (!responseFormat || !/response_format|json_schema|Unrecognized|unsupported|400/i.test(e.message)) throw e;
        log('DEBUG', 'AI-API', `Backend rejected response_format (${e.message.slice(0, 120)}) — retrying unconstrained`);
        msg = await llmChatRaw(messages, { ...opts, responseFormat: undefined });
    }
    return {
        text: msg?.content || '',
        model,
        finishReason: msg?.finish_reason ?? null,
        usage: msg?.usage || null,
        ms: Date.now() - t0,
    };
}

async function handleAiApi(req, res, reqId) {
    const p = req.url.split('?')[0];
    const isPost = req.method === 'POST';
    const body = isPost ? await readJsonBody(req) : {};

    try {
        if (req.method === 'GET' && p === '/api/ai/capabilities') {
            const modelIds = await fetchModelIds().catch(() => []);
            jsonRes(res, 200, {
                ok: true,
                llm: {
                    base: LLM_TARGET,
                    proxy: PROXY_PATH,
                    model: await getLlmModel(),
                    visionModel: LLM_VISION_MODEL || null,
                    models: modelIds,
                    streaming: `${PROXY_PATH}/v1/chat/completions`,
                },
                tools: extendedTools ? extendedTools.names : [],
                endpoints: AI_ENDPOINTS,
            });
            return;
        }

        if (req.method === 'GET' && p === '/api/ai/health') {
            const probe = async (name, fn) => {
                const t0 = Date.now();
                try { const d = await fn(); return { name, ok: true, ms: Date.now() - t0, ...(d || {}) }; }
                catch (e) { return { name, ok: false, ms: Date.now() - t0, error: e.message }; }
            };
            const services = await Promise.all([
                probe('llm', async () => ({ models: (await fetchModelIds()).length })),
            ]);
            jsonRes(res, 200, { ok: services.every(s => s.ok), services });
            return;
        }

        if (!AI_ENDPOINTS.some(e => e.path === p)) {
            jsonRes(res, 404, { error: `unknown AI endpoint: ${p}`, endpoints: AI_ENDPOINTS.filter(e => e.path.startsWith('/api/ai')) });
            return;
        }
        if (!isPost) { jsonRes(res, 405, { error: `${p} is POST-only` }); return; }

        if (p === '/api/ai/chat') {
            // Streaming has a first-class path already (the /llm proxy, which
            // the app's own chat uses and which survives a dropped socket via
            // durable-stream). Silently answering a stream request with one
            // blob would be worse than saying where streaming lives.
            if (body.stream) {
                jsonRes(res, 400, {
                    error: 'streaming is not served here',
                    hint: `POST ${PROXY_PATH}/v1/chat/completions with stream:true — the OpenAI SSE shape, with durable resume`,
                });
                return;
            }
            jsonRes(res, 200, { ok: true, ...(await aiRun(body)) });
            return;
        }

        if (p === '/api/ai/json') {
            if (!body.schema && !body.json_schema) { jsonRes(res, 400, { error: 'schema is required (a JSON Schema object)' }); return; }
            const r = await aiRun(body, {
                system: body.system
                    || `You answer only with JSON satisfying this schema: ${JSON.stringify(body.schema || body.json_schema)}. No prose, no code fences.`,
            });
            const data = aiParseJson(r.text);
            if (data === null) { jsonRes(res, 502, { ok: false, error: 'model did not return parsable JSON', text: r.text.slice(0, 1000) }); return; }
            jsonRes(res, 200, { ok: true, data, model: r.model, usage: r.usage, ms: r.ms });
            return;
        }

        if (p === '/api/ai/vision') {
            if (!body.image && !body.images) { jsonRes(res, 400, { error: 'image is required (data: URL, http URL or base64)' }); return; }
            jsonRes(res, 200, { ok: true, ...(await aiRun(body, { prompt: body.prompt || 'Describe this image in detail.' })) });
            return;
        }

        if (p === '/api/ai/caption') {
            if (!body.image) { jsonRes(res, 400, { error: 'image is required' }); return; }
            const style = String(body.style || 'natural');
            const guide = style === 'tags' ? 'Answer with a comma-separated list of descriptive tags, most important first. No sentences.'
                : style === 'alt' ? 'Answer with one short alt-text sentence for a screen reader.'
                : style === 'prompt' ? 'Answer with a single image-generation prompt that would recreate this image: subject, composition, lighting, style, lens. No preamble.'
                : 'Answer with one or two plain sentences describing the image.';
            const r = await aiRun(body, {
                system: `You caption images. ${guide}`,
                prompt: body.prompt || 'Caption this image.',
                messages: null,
                max_tokens: body.max_tokens ?? 300,
            });
            jsonRes(res, 200, { ok: true, caption: r.text.trim(), style, model: r.model, ms: r.ms });
            return;
        }

        if (p === '/api/ai/summarize') {
            if (!body.text) { jsonRes(res, 400, { error: 'text is required' }); return; }
            const maxWords = Math.min(2000, Math.max(10, parseInt(body.maxWords ?? body.max_words, 10) || 120));
            const format = body.format === 'bullets' ? 'as short bullet points' : 'as a single tight paragraph';
            const lang = body.language ? ` Write it in ${body.language}.` : ' Write it in the same language as the source.';
            const r = await aiRun(body, {
                system: `You summarize text ${format}, in at most ${maxWords} words.${lang} Return only the summary.`,
                prompt: String(body.text),
                messages: null,
                max_tokens: body.max_tokens ?? Math.max(256, maxWords * 3),
            });
            jsonRes(res, 200, { ok: true, summary: r.text.trim(), model: r.model, usage: r.usage, ms: r.ms });
            return;
        }

        if (p === '/api/ai/translate') {
            if (!body.text) { jsonRes(res, 400, { error: 'text is required' }); return; }
            if (!body.to) { jsonRes(res, 400, { error: 'to is required (target language)' }); return; }
            const r = await aiRun(body, {
                system: `Translate the user's text${body.from ? ` from ${body.from}` : ''} into ${body.to}. Preserve formatting, names and markup. Return only the translation.`,
                prompt: String(body.text),
                messages: null,
                temperature: body.temperature ?? 0.2,
            });
            jsonRes(res, 200, { ok: true, text: r.text.trim(), to: body.to, model: r.model, ms: r.ms });
            return;
        }

        if (p === '/api/ai/enhance-prompt') {
            if (!body.prompt) { jsonRes(res, 400, { error: 'prompt is required' }); return; }
            const target = String(body.target || 'sdxl').toLowerCase();
            const houseStyle = (target === 'flux' || target === 'video')
                ? 'Write flowing natural-language description in full sentences.'
                : 'Write comma-separated descriptive phrases, most important first — subject, composition, lighting, style, quality.';
            const r = await aiRun(body, {
                system: `You rewrite short ideas into ${target} generation prompts. ${houseStyle} `
                    + (body.style ? `House style: ${body.style}. ` : '')
                    + 'Keep every concrete detail the user gave and add only what is implied. '
                    + 'Answer with JSON: {"prompt": "...", "negative": "..."} and nothing else.',
                prompt: String(body.prompt),
                messages: null,
                json: true,
                temperature: body.temperature ?? 0.8,
                max_tokens: body.max_tokens ?? 600,
            });
            const parsed = aiParseJson(r.text);
            jsonRes(res, 200, {
                ok: true,
                prompt: (parsed?.prompt || r.text).trim(),
                negative: (parsed?.negative || '').trim(),
                original: String(body.prompt),
                target, model: r.model, ms: r.ms,
                degraded: parsed ? undefined : 'model did not return JSON — prompt is its raw answer',
            });
            return;
        }

        if (p === '/api/ai/embed') {
            const input = body.input ?? body.text ?? body.texts;
            if (input == null || (Array.isArray(input) && !input.length)) { jsonRes(res, 400, { error: 'input is required (string or string[])' }); return; }
            const texts = Array.isArray(input) ? input : [input];
            const vectors = await fetchEmbeddings(texts);
            if (!vectors) { jsonRes(res, 503, { ok: false, error: 'no embedding backend available' }); return; }
            jsonRes(res, 200, {
                ok: true, vectors, count: vectors.length,
                dims: vectors.find(Boolean)?.length || 0,
                failed: vectors.reduce((n, v) => n + (v ? 0 : 1), 0),
            });
            return;
        }

        jsonRes(res, 404, { error: `unknown AI endpoint: ${p}`, endpoints: AI_ENDPOINTS.filter(e => e.path.startsWith('/api/ai')) });
    } catch (err) {
        log('ERROR', 'AI-API', `#${reqId} ${p}: ${err.message}`);
        if (!res.headersSent) jsonRes(res, 502, { ok: false, error: err.message });
    }
}

// ---------------------------------------------------------------------------
//  Smart Tasks — an AI instruction that runs on a schedule and delivers its
//  generated result. e.g. "every day at 10:00, write my daily fitness plan and
//  post it to the chat". The prompt is run through the LLM with the full native
//  tool set (so it can pull health data, the calendar, weather, memory, the
//  web, …), then the answer is delivered over the chosen channel(s).
//  Reminders are the same machinery with a fixed message instead of a prompt.
// ---------------------------------------------------------------------------
const SMART_TASK_SYSTEM = "You are Tricorder Agent, carrying out a scheduled task. Follow the instruction and produce the finished result as a single, self-contained message that is ready to read straight through. You have the full tool set (web search and fetch, files, shell, memory, git, databases, …) — use it to ground the result in real, current data instead of inventing it. Write in the user's language. Keep it well-structured and concise, with light markdown formatting. Output only the message itself — no preamble and no commentary about what you did.";

// Run an instruction through the LLM with native tools (a bounded agentic loop)
// and return the final text. Falls back to a tool-less completion if the
// backend rejects the `tools` parameter.
async function runSmartAgent(prompt, { system = SMART_TASK_SYSTEM, useTools = true, maxTokens = 2000, maxSteps = 6 } = {}) {
    const tools = useTools ? loadNativeToolDefs() : null;
    const haveTools = !!(tools && tools.length);
    const work = [{ role: 'system', content: system }, { role: 'user', content: prompt }];
    let finalText = '';
    for (let step = 0; step < maxSteps; step++) {
        let msg;
        try {
            msg = await llmChatRaw(work, { tools: haveTools ? tools : undefined, maxTokens, temperature: 0.7, timeoutMs: 120000 });
        } catch (e) {
            // Some backends/models reject the tools param — retry once plain.
            if (step === 0 && haveTools) {
                log('WARN', 'SMART', `tools call failed (${e.message}); retrying without tools`);
                msg = await llmChatRaw(work, { maxTokens, temperature: 0.7, timeoutMs: 120000 });
            } else throw e;
        }
        if (!msg) break;
        const toolCalls = msg.tool_calls || [];
        if (toolCalls.length) {
            work.push({ role: 'assistant', content: msg.content || '', tool_calls: toolCalls });
            let results = [];
            try { results = await executeToolCallsInternal(toolCalls); }
            catch (e) { log('WARN', 'SMART', `tool exec failed: ${e.message}`); }
            const byId = new Map(results.map(r => [r.tool_call_id, r.output]));
            for (const tc of toolCalls) work.push({ role: 'tool', tool_call_id: tc.id, content: byId.get(tc.id) ?? JSON.stringify({ error: 'no result' }) });
            continue;
        }
        finalText = (msg.content || '').trim();
        break;
    }
    // Used the whole tool budget without a final answer → force a tool-less one.
    if (!finalText) {
        work.push({ role: 'user', content: 'Stop using tools and produce the finished result now, using what you have already gathered.' });
        const forced = await llmChatRaw(work, { maxTokens, temperature: 0.7, timeoutMs: 120000 }).catch(() => null);
        finalText = (forced?.content || '').trim();
    }
    if (!finalText) throw new Error('LLM returned no content for the task');
    return finalText;
}

// Deliver a task's text output over the channel(s) named in
// actionConfig.delivery: 'chat' (straight into the open chat window) and/or
// 'notification' (the in-app notification feed, which the browser turns into a
// desktop notification). Default is both, so a scheduled result is never lost
// just because no tab was open when it finished.
async function deliverTaskOutput(task, text, { subject } = {}) {
    const config = task.actionConfig || {};
    const delivery = config.delivery || 'both';
    const wantChat = delivery === 'chat' || delivery === 'both';
    const wantNotification = delivery === 'notification' || delivery === 'both';
    const results = {}; const errors = [];

    if (wantChat) {
        // Straight into the open chat — no polling on the operator's side.
        // With no tab connected the push is replayed on the next connect.
        const pushed = pushChatMessage(text, { title: task.name, source: 'task', sourceId: task.id });
        if (pushed) results.chat = { id: pushed.id };
        else errors.push('chat: empty message');
    }

    if (wantNotification) {
        notifications.push({
            id: generateNotifId(), message: text, status: 'triggered',
            triggerAt: null, recurring: false, intervalMs: null,
            createdAt: new Date().toISOString(), triggeredAt: new Date().toISOString(),
            source: 'task', taskId: task.id, title: task.name || subject || 'Scheduled task',
        });
        results.notification = true;
    }

    if (!Object.keys(results).length) throw new Error(`not delivered — ${errors.join('; ')}`);
    return { delivered: results, errors: errors.length ? errors : undefined };
}

// ---------------------------------------------------------------------------
//  Background agent hand-off — when the operator closes the app mid-run, the
//  browser ships the in-flight conversation here (navigator.sendBeacon) so the
//  task finishes server-side instead of dying with the tab. The result is
//  delivered over the operator's chosen channel(s) when it's done.
// ---------------------------------------------------------------------------
const BACKGROUND_AGENT_SYSTEM = "You are Tricorder, the user's personal AI assistant. The user started a task and then closed the app, handing the in-progress conversation to you to finish in the background. Pick up exactly where it left off: complete any remaining work with your tools, then produce the finished result as a single, self-contained message that reads on its own. Don't ask follow-up questions — the user isn't at the screen — make reasonable assumptions and state them briefly. Write in the user's language, keep it well-structured, and output only the result.";

// Keep only well-formed chat messages and bound the total size (sendBeacon caps
// the body near 64 KB anyway). Repairs a tail the chat template would choke on:
// an assistant turn carrying tool_calls that were never answered (the user
// closed before the results came back) — drop the dangling call so the model
// just redoes that step server-side.
function sanitizeBackgroundMessages(messages) {
    const out = [];
    let budget = 256 * 1024;
    for (const m of Array.isArray(messages) ? messages : []) {
        if (!m || typeof m !== 'object') continue;
        if (!['system', 'user', 'assistant', 'tool'].includes(m.role)) continue;
        const entry = { role: m.role };
        if (typeof m.content === 'string') entry.content = m.content;
        else if (Array.isArray(m.content)) entry.content = m.content;   // vision parts
        else entry.content = '';
        if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) entry.tool_calls = m.tool_calls;
        if (m.role === 'tool' && m.tool_call_id) entry.tool_call_id = m.tool_call_id;
        const size = JSON.stringify(entry).length;
        if (size > budget) break;
        budget -= size;
        out.push(entry);
    }
    // A tool_calls turn must be followed by tool results; strip any that aren't.
    for (let i = 0; i < out.length; i++) {
        if (out[i].tool_calls && out[i + 1]?.role !== 'tool') {
            const copy = { ...out[i] }; delete copy.tool_calls; out[i] = copy;
        }
    }
    // Trimming the head can orphan leading `tool` turns (their assistant
    // tool_calls turn was dropped) — a tool result with nothing to answer breaks
    // the chat template, so peel them off the front.
    while (out.length && out[0].role === 'tool') out.shift();
    return out;
}

// Run the handed-off conversation to completion with the full server-side tool
// set (a bounded agentic loop, same shape as runSmartAgent). `lmHeaders` route
// the LLM calls through the local /llm proxy so they hit the same backend the
// browser was using (the configured LM Studio URL).
async function runBackgroundAgentContinuation(messages, { model, lmHeaders, signal, maxSteps = 8, maxTokens = 4000 } = {}) {
    const tools = loadNativeToolDefs();
    const haveTools = !!(tools && tools.length);
    const baseUrl = `http://127.0.0.1:${PORT}/llm`;
    const headers = { 'X-Internal-Token': INTERNAL_TOKEN, ...(lmHeaders || {}) };
    const callOpts = { baseUrl, headers, model, signal, maxTokens, temperature: 0.7, timeoutMs: 180000 };

    const work = [{ role: 'system', content: BACKGROUND_AGENT_SYSTEM }, ...messages];
    // If the convo ended on the assistant's own turn, nudge it to finish rather
    // than re-emit its last message verbatim.
    if (work[work.length - 1]?.role === 'assistant') {
        work.push({ role: 'user', content: 'Finish the task now and give me the final result.' });
    }

    let finalText = '';
    for (let step = 0; step < maxSteps; step++) {
        if (signal?.aborted) break;
        let msg;
        try {
            msg = await llmChatRaw(work, { ...callOpts, tools: haveTools ? tools : undefined });
        } catch (e) {
            if (signal?.aborted) break;
            if (step === 0 && haveTools) msg = await llmChatRaw(work, callOpts);   // backend rejected tools — retry plain
            else throw e;
        }
        if (!msg) break;
        const toolCalls = msg.tool_calls || [];
        if (toolCalls.length) {
            work.push({ role: 'assistant', content: msg.content || '', tool_calls: toolCalls });
            let results = [];
            try { results = await executeToolCallsInternal(toolCalls); }
            catch (e) { log('WARN', 'BG-AGENT', `tool exec failed: ${e.message}`); }
            if (signal?.aborted) break;
            const byId = new Map(results.map(r => [r.tool_call_id, r.output]));
            for (const tc of toolCalls) work.push({ role: 'tool', tool_call_id: tc.id, content: byId.get(tc.id) ?? JSON.stringify({ error: 'no result' }) });
            continue;
        }
        finalText = (msg.content || '').trim();
        break;
    }
    if (!finalText) {
        work.push({ role: 'user', content: 'Stop using tools and give me the finished result now, based on what you already have.' });
        const forced = await llmChatRaw(work, callOpts).catch(() => null);
        finalText = (forced?.content || '').trim();
    }
    return finalText;
}

// Registry of background runs so the operator can see running and recently
// finished tasks when they reopen the app (GET /api/agent/background, polled by
// the in-app panel). Newest first, capped. Holds the full result text — the
// notifications stay deliberately short and point back here.
const backgroundRuns = [];
const BACKGROUND_RUNS_MAX = 30;
// In-flight de-dupe, since some browsers fire pagehide AND beforeunload and the
// same hand-off can arrive twice.
const _backgroundAgentRuns = new Set();
// run.id → AbortController, so the operator can cancel a running task.
const _bgControllers = new Map();

async function handleBackgroundAgentApi(req, res, reqId) {
    const pathname = new URL(req.url, 'http://localhost').pathname;

    // POST /api/agent/background/abort { id } → cancel a running task.
    if (req.method === 'POST' && pathname.endsWith('/abort')) {
        const body = await readJsonBody(req);
        const id = String(body.id || '');
        const run = backgroundRuns.find(r => r.id === id);
        if (!run) { jsonRes(res, 404, { error: 'run not found' }); return; }
        if (run.status === 'running') {
            try { _bgControllers.get(id)?.abort(new Error('aborted by operator')); } catch { /* already settled */ }
            log('INFO', 'BG-AGENT', `#${reqId} Abort requested for "${run.title}" (${id})`);
        }
        jsonRes(res, 200, { ok: true, id, status: run.status === 'running' ? 'aborting' : run.status });
        return;
    }

    // GET → the list the in-app panel polls so the operator can see what's still
    // running (and read finished results) after reopening Tricorder.
    if (req.method === 'GET') {
        jsonRes(res, 200, { runs: backgroundRuns });
        return;
    }
    if (req.method !== 'POST') { jsonRes(res, 405, { error: 'Method not allowed' }); return; }

    const body = await readJsonBody(req);
    const messages = sanitizeBackgroundMessages(body.messages);
    if (!messages.length) { jsonRes(res, 400, { error: 'messages array required' }); return; }

    const title = (typeof body.title === 'string' && body.title.trim())
        ? body.title.trim().slice(0, 120) : 'Background task';
    const delivery = ['both', 'notification', 'chat'].includes(body.delivery) ? body.delivery : 'both';
    const model = (typeof body.model === 'string' && body.model.trim()) ? body.model.trim() : undefined;
    // Re-create the backend-routing headers the browser used. Only http(s)
    // targets are accepted (the proxy forwards to whatever X-LM-Target names —
    // the same surface the live browser already has).
    const lmHeaders = {};
    if (typeof body.lmTarget === 'string' && /^https?:\/\//i.test(body.lmTarget)) {
        lmHeaders['X-LM-Target'] = body.lmTarget.replace(/\/+$/, '');
    }

    // De-dupe a double-fire beacon (same convo tail).
    const key = `${title}::${messages.length}::${JSON.stringify(messages[messages.length - 1]).length}`;
    if (_backgroundAgentRuns.has(key)) { jsonRes(res, 202, { ok: true, duplicate: true }); return; }
    _backgroundAgentRuns.add(key);

    // Register it as "running" up front so it shows the instant the app reopens.
    const run = {
        id: 'bg-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        title, status: 'running', startedAt: new Date().toISOString(),
        finishedAt: null, durationMs: null, preview: '', result: '', error: null,
    };
    backgroundRuns.unshift(run);
    if (backgroundRuns.length > BACKGROUND_RUNS_MAX) backgroundRuns.length = BACKGROUND_RUNS_MAX;

    const ac = new AbortController();
    _bgControllers.set(run.id, ac);

    // Acknowledge immediately — the client is unloading and won't read the body.
    jsonRes(res, 202, { ok: true, accepted: true, id: run.id });

    (async () => {
        const t0 = Date.now();
        log('INFO', 'BG-AGENT', `#${reqId} Continuing "${title}" server-side (${messages.length} msgs) after app close`);
        try {
            const text = await runBackgroundAgentContinuation(messages, { model, lmHeaders, signal: ac.signal });
            if (ac.signal.aborted) throw new Error('aborted');
            if (!text) throw new Error('no result produced');
            run.status = 'done';
            run.result = text;
            run.preview = text.replace(/\s+/g, ' ').trim().slice(0, 160);
            run.finishedAt = new Date().toISOString();
            run.durationMs = Date.now() - t0;
            const secs = Math.round(run.durationMs / 1000);
            // Keep the notification SHORT — the full result waits in the in-app
            // panel (one tap away on reopen), so we don't also notify.
            const shortMsg = `✅ Hintergrund-Task fertig: "${title}" (${secs}s). In Tricorder öffnen für das Ergebnis.`;
            await deliverTaskOutput(
                { id: run.id, name: title, actionConfig: { delivery } },
                shortMsg, { subject: `✅ ${title}` },
            ).catch(e => log('WARN', 'BG-AGENT', `#${reqId} notify failed: ${e.message}`));
            log('INFO', 'BG-AGENT', `#${reqId} "${title}" finished & delivered in ${secs}s`);
        } catch (e) {
            run.finishedAt = new Date().toISOString();
            run.durationMs = Date.now() - t0;
            if (ac.signal.aborted || e.message === 'aborted') {
                // Operator cancelled it — not a failure, and no notification.
                run.status = 'aborted';
                run.error = null;
                log('INFO', 'BG-AGENT', `#${reqId} "${title}" aborted by operator`);
            } else {
                run.status = 'failed';
                run.error = e.message;
                log('ERROR', 'BG-AGENT', `#${reqId} "${title}" failed: ${e.message}`);
                // Leave a breadcrumb in the in-app feed so the operator learns the
                // backgrounded task didn't make it.
                try {
                    notifications.push({
                        id: generateNotifId(),
                        message: `⚠️ Hintergrund-Task "${title}" fehlgeschlagen: ${e.message}`,
                        status: 'triggered', triggerAt: null, recurring: false, intervalMs: null,
                        createdAt: new Date().toISOString(), triggeredAt: new Date().toISOString(),
                        source: 'background-agent', title,
                    });
                } catch { /* notifications store unavailable — nothing else to do */ }
            }
        } finally {
            _backgroundAgentRuns.delete(key);
            _bgControllers.delete(run.id);
        }
    })();
}

// Marker a watch task's agent appends once its completion condition is met.
// Stripped before delivery — the operator never sees it.
const WATCH_DONE_MARKER = '[[TASK_DONE]]';

// Action handler for `smart` tasks — generate content from a prompt, deliver it.
async function runSmartTaskAction(task) {
    const config = task.actionConfig || {};
    const basePrompt = String(config.prompt || task.name || '').trim();
    if (!basePrompt) throw new Error('Smart task has no instruction/prompt');
    // A watch task exists only until `until` comes true (e.g. "the model
    // download in D:\AI\models\exl3 is complete"). Telling the agent how to
    // signal that is what lets the task retire itself instead of pinging the
    // operator forever after the thing it was watching already happened.
    const until = String(config.until || '').trim();
    const prompt = until
        ? `${basePrompt}\n\nThis is a watch task. Completion condition: ${until}\n`
          + `Check the condition now with your tools. If it is met, say so in one or two short lines `
          + `and end your message with ${WATCH_DONE_MARKER} on its own line. `
          + `If it is not met yet, report the current progress in one short line and do NOT output that marker.`
        : basePrompt;
    log('INFO', 'SMART', `Running smart task "${task.name}" (${task.id}, delivery=${config.delivery || 'both'}${until ? ', watch' : ''})`);
    // Multi-section overviews (e.g. a weekly digest with email + health + …)
    // can run long; a generous token budget keeps them from being cut off
    // mid-section. Still capped, and per-task overridable via config.maxTokens.
    // The base system prompt says "output only the message" — which would eat
    // the marker. Say explicitly that it belongs in the output for watch runs.
    const system = until
        ? `${SMART_TASK_SYSTEM} This run is a watch check. If the completion condition stated in the instruction is met, append ${WATCH_DONE_MARKER} as the very last line — it is stripped before the user sees it and is the only way to stop this task from firing again.`
        : SMART_TASK_SYSTEM;
    const raw = await runSmartAgent(prompt, { system, useTools: config.useTools !== false, maxTokens: config.maxTokens || 2000 });
    const done = until ? raw.includes(WATCH_DONE_MARKER) : false;
    const text = raw.split(WATCH_DONE_MARKER).join('').trim();
    const res = await deliverTaskOutput(task, text, { subject: config.subject });
    return { ok: true, done, ...res, preview: text.slice(0, 280) };
}

// Action handler for `notify` (reminder) tasks — deliver a fixed message.
async function runReminderAction(task) {
    const config = task.actionConfig || {};
    const text = String(config.message || task.name || '').trim();
    if (!text) throw new Error('Reminder has no message');
    log('INFO', 'TASKS', `Firing reminder "${task.name}" (${task.id}, delivery=${config.delivery || 'both'})`);
    const res = await deliverTaskOutput(task, text);
    return { ok: true, ...res };
}

// Registry of server-side task actions (vs. shell-command tasks).
const TASK_ACTIONS = {
    smart: runSmartTaskAction,
    notify: runReminderAction,
};

// Reschedule a recurring task and persist the new state. `done` marks a watch
// task whose condition just came true: it has nothing left to watch, so it
// retires instead of firing again. Default is to delete it outright — a
// leftover watchdog in the task list is exactly the clutter it was meant to
// spare the operator. Set actionConfig.onDone = 'disable' to keep the entry.
function _rescheduleTask(task, { done = false } = {}) {
    if (done) {
        const onDone = (task.actionConfig || {}).onDone === 'disable' ? 'disable' : 'delete';
        if (onDone === 'delete') {
            const idx = tasks.findIndex(t => t.id === task.id);
            if (idx >= 0) tasks.splice(idx, 1);
            log('INFO', 'TASKS', `Watch task "${task.name}" (${task.id}) reached its condition — removed`);
        } else {
            task.enabled = false;
            task.status = 'completed';
            task.nextRun = null;
            log('INFO', 'TASKS', `Watch task "${task.name}" (${task.id}) reached its condition — disabled`);
        }
        saveTasks();
        return;
    }
    if (task.schedule && task.enabled !== false) {
        task.status = 'pending';
        task.nextRun = computeNextRun(task);
    }
    saveTasks();
}

function executeTask(task) {
    task.status = 'running';
    task.lastRun = new Date().toISOString();
    saveTasks();

    // Server-side action tasks (smart tasks, reminders) run an internal async
    // handler instead of a shell command.
    if (task.action && TASK_ACTIONS[task.action]) {
        let watchDone = false;
        Promise.resolve()
            .then(() => TASK_ACTIONS[task.action](task))
            .then((result) => {
                task.status = 'completed';
                task.result = result || { ok: true };
                watchDone = !!(result && result.done);
                log('INFO', 'TASKS', `Action task "${task.name}" (${task.id}) completed: ${task.action}`);
            })
            .catch((err) => {
                task.status = 'failed';
                task.result = { error: err.message };
                log('WARN', 'TASKS', `Action task "${task.name}" (${task.id}) failed: ${err.message}`);
            })
            .finally(() => _rescheduleTask(task, { done: watchDone }));
        return;
    }

    if (task.command) {
        // Defense-in-depth: re-check the allowlist at execution time. Tasks
        // may have been persisted by an older version (or the file edited by
        // hand), so creation-time validation alone is not enough.
        if (!isCommandAllowed(task.command)) {
            task.status = 'failed';
            task.result = { error: 'Task command is not allowed by the command allowlist — refused to execute.' };
            log('WARN', 'TASKS', `Task "${task.name}" (${task.id}) blocked: command not in allowlist`);
            _rescheduleTask(task);
            return;
        }
        // windowsHide:true prevents a cmd.exe window from flashing on Windows
        // every time a scheduled task fires.
        exec(task.command, { timeout: 30000, windowsHide: true }, (err, stdout, stderr) => {
            if (err) {
                task.status = 'failed';
                task.result = { error: err.message, stderr: (stderr || '').substring(0, 1000) };
                log('WARN', 'TASKS', `Task "${task.name}" (${task.id}) failed: ${err.message}`);
            } else {
                task.status = 'completed';
                task.result = { stdout: (stdout || '').substring(0, 2000), stderr: (stderr || '').substring(0, 500) };
                log('INFO', 'TASKS', `Task "${task.name}" (${task.id}) completed`);
            }
            _rescheduleTask(task);
        });
    } else {
        // No command — just mark as completed (e.g. reminder type)
        task.status = 'completed';
        task.result = { message: 'Task triggered (no command)' };
        log('INFO', 'TASKS', `Task "${task.name}" (${task.id}) triggered`);
        _rescheduleTask(task);
    }
}

// Scheduler: check every 30 seconds for due tasks
setInterval(() => {
    const now = Date.now();
    for (const task of tasks) {
        if (task.enabled === false) continue;
        if (task.status === 'pending' && task.nextRun) {
            const dueTime = new Date(task.nextRun).getTime();
            if (dueTime <= now) {
                log('INFO', 'TASKS', `Scheduler: running due task "${task.name}" (${task.id})`);
                executeTask(task);
            }
        }
    }
}, 30000);

// Daily-job types the UI can create as editable scheduled actions.
const VALID_TASK_ACTIONS = Object.keys(TASK_ACTIONS);

async function handleTasksApi(req, res, reqId) {
    const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const endpoint = urlObj.pathname.replace('/api/tasks/', '').split('?')[0];
    log('INFO', 'TASKS', `#${reqId} ${req.method} /api/tasks/${endpoint}`);

    // --- List tasks ---
    if (req.method === 'GET' && endpoint === 'list') {
        jsonRes(res, 200, { tasks });
        return;
    }

    if (req.method !== 'POST') {
        jsonRes(res, 405, { error: 'Method not allowed' });
        return;
    }

    const body = await readJsonBody(req);

    // --- Create task ---
    if (endpoint === 'create') {
        if (!body.name) {
            jsonRes(res, 400, { error: 'name is required' });
            return;
        }
        const validTypes = ['reminder', 'scheduled', 'automation'];
        const taskType = validTypes.includes(body.type) ? body.type : 'scheduled';
        const action = VALID_TASK_ACTIONS.includes(body.action) ? body.action : null;

        // Same allowlist as run_command — a task command is exec()'d later.
        if (body.command && !isCommandAllowed(String(body.command))) {
            jsonRes(res, 400, { error: `Task command is not allowed. Allowed commands: ${[...ALLOWED_COMMANDS].sort().join(', ')}` });
            return;
        }

        const task = {
            id: generateTaskId(),
            name: body.name,
            type: taskType,
            status: 'pending',
            schedule: body.schedule || null,
            command: body.command || null,
            action,
            actionConfig: action ? (body.actionConfig || {}) : null,
            enabled: body.enabled !== false,
            createdAt: new Date().toISOString(),
            nextRun: null,
            lastRun: null,
            result: null,
        };
        task.nextRun = task.enabled ? computeNextRun(task) : null;
        tasks.push(task);
        saveTasks();
        log('INFO', 'TASKS', `#${reqId} Created task "${task.name}" (${task.id})${action ? ` [action: ${action}]` : ''}`);
        jsonRes(res, 200, { ok: true, task });
        return;
    }

    // --- Update task (edit an existing daily job / scheduled task) ---
    if (endpoint === 'update') {
        if (!body.id) {
            jsonRes(res, 400, { error: 'id is required' });
            return;
        }
        const task = tasks.find(t => t.id === body.id);
        if (!task) {
            jsonRes(res, 404, { error: 'Task not found' });
            return;
        }
        if (typeof body.name === 'string' && body.name.trim()) task.name = body.name.trim();
        if (body.type !== undefined) {
            const validTypes = ['reminder', 'scheduled', 'automation'];
            if (validTypes.includes(body.type)) task.type = body.type;
        }
        if (body.schedule !== undefined) task.schedule = body.schedule || null;
        if (body.command !== undefined) {
            // Same allowlist as run_command — a task command is exec()'d later.
            if (body.command && !isCommandAllowed(String(body.command))) {
                jsonRes(res, 400, { error: `Task command is not allowed. Allowed commands: ${[...ALLOWED_COMMANDS].sort().join(', ')}` });
                return;
            }
            task.command = body.command || null;
        }
        if (body.action !== undefined) {
            task.action = VALID_TASK_ACTIONS.includes(body.action) ? body.action : null;
            if (!task.action) task.actionConfig = null;
        }
        if (body.actionConfig !== undefined && task.action) {
            task.actionConfig = { ...(task.actionConfig || {}), ...body.actionConfig };
        }
        if (body.enabled !== undefined) task.enabled = !!body.enabled;
        // Recompute the next fire time from the (possibly new) schedule.
        task.status = task.enabled === false ? 'paused' : 'pending';
        task.nextRun = task.enabled === false ? null : computeNextRun(task);
        saveTasks();
        log('INFO', 'TASKS', `#${reqId} Updated task "${task.name}" (${task.id})`);
        jsonRes(res, 200, { ok: true, task });
        return;
    }

    // --- Delete task ---
    if (endpoint === 'delete') {
        if (!body.id) {
            jsonRes(res, 400, { error: 'id is required' });
            return;
        }
        const idx = tasks.findIndex(t => t.id === body.id);
        if (idx === -1) {
            jsonRes(res, 404, { error: 'Task not found' });
            return;
        }
        const removed = tasks.splice(idx, 1)[0];
        saveTasks();
        log('INFO', 'TASKS', `#${reqId} Deleted task "${removed.name}" (${removed.id})`);
        jsonRes(res, 200, { ok: true, deleted: removed });
        return;
    }

    // --- Run task immediately ---
    if (endpoint === 'run') {
        if (!body.id) {
            jsonRes(res, 400, { error: 'id is required' });
            return;
        }
        const task = tasks.find(t => t.id === body.id);
        if (!task) {
            jsonRes(res, 404, { error: 'Task not found' });
            return;
        }
        log('INFO', 'TASKS', `#${reqId} Manual run of task "${task.name}" (${task.id})`);
        executeTask(task);
        jsonRes(res, 200, { ok: true, task });
        return;
    }

    jsonRes(res, 404, { error: 'Unknown tasks API endpoint' });
}

// --- Notifications API ---
// notifications[] is declared near the top of the file (shared with tool exec).
let notifIdCounter = 0;

function generateNotifId() {
    return `notif_${++notifIdCounter}_${Date.now()}`;
}

// --- System Snapshot Sampler ---
// Most recent system snapshot (CPU/GPU/memory), set by sampleSystemSnapshot()
// and read by anything that wants a cheap current reading without shelling out.
let _lastMonitorSnapshot = null;

// Samples CPU/RAM/disk/GPU once a minute purely so the mood engine has fresh
// numbers without re-running nvidia-smi on every /api/mood request. It raises
// no alerts and creates no notifications — resource levels are surfaced on the
// dashboard, not pushed at the operator.
const SNAPSHOT_INTERVAL_MS = 60 * 1000;

async function sampleSystemSnapshot() {
    try {
        const status = await getSystemStatus();
        const gpu = await getGpuInfo().catch(() => null);
        _lastMonitorSnapshot = {
            cpu:  status.cpu?.percent ?? null,
            ram:  status.memory?.percent ?? null,
            disk: status.disk?.percent ?? null,
            gpu:  gpu?.utilPercent ?? null,
            vram: gpu?.memPercent ?? null,
            gpuTempC: gpu?.tempC ?? null,
            at: new Date().toISOString(),
        };
    } catch (e) {
        log('DEBUG', 'SNAPSHOT', `System snapshot failed: ${e.message}`);
    }
}

// Kick off an immediate snapshot so the system readouts have real data right
// away (don't wait for the first 60s tick). If sampling fails the snapshot
// just stays null and every consumer degrades gracefully.
setTimeout(() => { sampleSystemSnapshot().catch(() => {}); }, 1500);
setInterval(() => { sampleSystemSnapshot().catch(() => {}); }, SNAPSHOT_INTERVAL_MS);

// Check for due notifications every 30 seconds (same interval as tasks)
setInterval(() => {
    const now = Date.now();
    for (const notif of notifications) {
        if (notif.status === 'pending' && notif.triggerAt) {
            const dueTime = new Date(notif.triggerAt).getTime();
            if (dueTime <= now) {
                notif.status = 'triggered';
                notif.triggeredAt = new Date().toISOString();
                log('INFO', 'NOTIF', `Notification triggered: "${notif.message}" (${notif.id})`);
                pushChatMessage(`🔔 ${notif.message}`, { title: 'Reminder', source: 'notification', sourceId: notif.id });
                // If recurring, reschedule
                if (notif.recurring && notif.intervalMs) {
                    const next = new Date(now + notif.intervalMs);
                    notifications.push({
                        id: generateNotifId(),
                        message: notif.message,
                        status: 'pending',
                        triggerAt: next.toISOString(),
                        recurring: true,
                        intervalMs: notif.intervalMs,
                        createdAt: new Date().toISOString(),
                        triggeredAt: null,
                    });
                }
            }
        }
    }
}, 30000);

async function handleNotificationsApi(req, res, reqId) {
    const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const endpoint = urlObj.pathname.replace('/api/notifications/', '').split('?')[0];
    log('INFO', 'NOTIF', `#${reqId} ${req.method} /api/notifications/${endpoint}`);

    // --- List notifications ---
    if (req.method === 'GET' && endpoint === 'list') {
        // Return active (non-dismissed) notifications
        const active = notifications.filter(n => n.status !== 'dismissed');
        jsonRes(res, 200, { notifications: active });
        return;
    }

    if (req.method !== 'POST') {
        jsonRes(res, 405, { error: 'Method not allowed' });
        return;
    }

    const body = await readJsonBody(req);

    // --- Create notification/reminder ---
    if (endpoint === 'create') {
        if (!body.message) {
            jsonRes(res, 400, { error: 'message is required' });
            return;
        }

        let triggerAt = null;
        let intervalMs = null;

        if (body.time) {
            // Support relative times: "5m", "1h", "30s" or absolute ISO strings
            const relMatch = String(body.time).match(/^(\d+)\s*(s|sec|seconds?|m|min|minutes?|h|hr|hours?)$/i);
            if (relMatch) {
                const value = parseInt(relMatch[1], 10);
                const unit = relMatch[2].toLowerCase();
                let ms;
                if (unit.startsWith('s')) ms = value * 1000;
                else if (unit.startsWith('m')) ms = value * 60000;
                else ms = value * 3600000;
                triggerAt = new Date(Date.now() + ms).toISOString();
                if (body.recurring) intervalMs = ms;
            } else {
                // Try as ISO date string
                const parsed = new Date(body.time);
                if (!isNaN(parsed.getTime())) {
                    triggerAt = parsed.toISOString();
                }
            }
        }

        const notif = {
            id: generateNotifId(),
            message: body.message,
            status: triggerAt ? 'pending' : 'triggered',
            triggerAt,
            recurring: !!body.recurring,
            intervalMs,
            createdAt: new Date().toISOString(),
            triggeredAt: triggerAt ? null : new Date().toISOString(),
        };
        notifications.push(notif);
        log('INFO', 'NOTIF', `#${reqId} Created notification "${notif.message}" (${notif.id})`);
        jsonRes(res, 200, { ok: true, notification: notif });
        return;
    }

    // --- Dismiss notification ---
    if (endpoint === 'dismiss') {
        if (!body.id) {
            jsonRes(res, 400, { error: 'id is required' });
            return;
        }
        const notif = notifications.find(n => n.id === body.id);
        if (!notif) {
            jsonRes(res, 404, { error: 'Notification not found' });
            return;
        }
        notif.status = 'dismissed';
        log('INFO', 'NOTIF', `#${reqId} Dismissed notification "${notif.message}" (${notif.id})`);
        jsonRes(res, 200, { ok: true, dismissed: notif });
        return;
    }

    jsonRes(res, 404, { error: 'Unknown notifications API endpoint' });
}

/* ============================================================================
   SETUP — first-run backend detection
   ----------------------------------------------------------------------------
   The single hardest thing about a local-first agent is the first ten minutes:
   is a model server running, on which port, with what loaded, and does it
   support tool calling? These routes answer that so js/setup.js can show a
   wizard instead of an error.

     GET  /api/setup/state      → has setup been completed? what is configured?
     GET  /api/setup/detect     → probe LM Studio / llama.cpp / Ollama
     POST /api/setup/test       → { url, apiKey } → probe one endpoint
     POST /api/setup/complete   → { url, model } → remember the choice
     POST /api/setup/reset      → show the wizard again
   ============================================================================ */

const SETUP_FILE = path.join(MEMORY_DIR, 'setup.json');

function loadSetupState() {
    try {
        const raw = JSON.parse(fs.readFileSync(SETUP_FILE, 'utf8'));
        if (raw && typeof raw === 'object') return raw;
    } catch { /* first run */ }
    return { completed: false, url: '', model: '', completedAt: null };
}

function saveSetupState(state) {
    try {
        fs.mkdirSync(MEMORY_DIR, { recursive: true });
        fs.writeFileSync(SETUP_FILE, JSON.stringify(state, null, 2));
        return true;
    } catch (err) {
        log('WARN', 'SETUP', `Could not persist setup state: ${err.message}`);
        return false;
    }
}

// The environment already answers most of the wizard's questions. When
// LLM_BASE_URL/LM_STUDIO_URL is set explicitly in .env the operator has made
// the choice the wizard exists to ask about, so we don't ask again.
function setupConfiguredByEnv() {
    return !!(process.env.LLM_BASE_URL || process.env.LM_STUDIO_URL);
}

async function handleSetupApi(req, res, reqId) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const route = url.pathname.replace(/^\/api\/setup\/?/, '');

    if (route === 'state' && req.method === 'GET') {
        const state = loadSetupState();
        jsonRes(res, 200, {
            completed: state.completed || setupConfiguredByEnv(),
            configuredByEnv: setupConfiguredByEnv(),
            url: state.url || LLM_TARGET,
            model: state.model || (LLM_MODEL === 'auto' ? '' : LLM_MODEL),
            // The model this build targets, straight from the profile table, so
            // the Settings panel and `npm run setup` never name different ones.
            recommendedModel: backends ? backends.profiles.RECOMMENDED.label : '',
            defaultUrl: LLM_TARGET,
            shellEnabled: SHELL_ENABLED,
            codeExecEnabled: CODE_EXEC_ENABLED,
            authEnabled: AUTH_ENABLED,
            workspace: WORKSPACE_DIR,
            platform: `${os.platform()} ${os.arch()}`,
            nodeVersion: process.version,
        });
        return;
    }

    if (route === 'detect' && req.method === 'GET') {
        if (!backends) { jsonRes(res, 500, { error: 'backend detection unavailable' }); return; }
        const found = await backends.discover({ configuredUrl: LLM_TARGET, apiKey: LM_STUDIO_API_KEY });
        log('INFO', 'SETUP', `#${reqId} Detect: ${found.detected || 'nothing online'}`);
        jsonRes(res, 200, found);
        return;
    }

    if (route === 'test' && req.method === 'POST') {
        if (!backends) { jsonRes(res, 500, { error: 'backend detection unavailable' }); return; }
        const body = await readJsonBody(req);
        if (!body.url) { jsonRes(res, 400, { error: 'url required' }); return; }
        const result = await backends.probe(body.url, { apiKey: body.apiKey || LM_STUDIO_API_KEY, timeout: 5000 });
        jsonRes(res, 200, result);
        return;
    }

    if (route === 'complete' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const state = {
            completed: true,
            url: String(body.url || LLM_TARGET),
            model: String(body.model || ''),
            completedAt: new Date().toISOString(),
        };
        saveSetupState(state);
        log('INFO', 'SETUP', `#${reqId} Setup complete → ${state.url} (${state.model || 'auto'})`);
        jsonRes(res, 200, { ok: true, ...state });
        return;
    }

    if (route === 'reset' && req.method === 'POST') {
        saveSetupState({ completed: false, url: '', model: '', completedAt: null });
        jsonRes(res, 200, { ok: true });
        return;
    }

    jsonRes(res, 404, { error: 'Unknown setup route' });
}

// --- HTTP Server ---
// --- Durable streaming wiring ------------------------------------------------
// The real upstream adapter for the durable manager. Mirrors proxyRequest()'s
// target resolution + per-backend API-key injection, but instead of piping to a
// browser socket it drives callbacks, so the generation is decoupled from any
// client connection. Forwards each backend `data:` payload verbatim (the browser
// keeps its existing SSE/tool-call parser); "[DONE]" is swallowed because the
// manager emits its own terminal `end` frame on stream end.
function forwardChatCompletion(routing, body, { signal, onData, onDone, onError }) {
    const customTarget = routing.lmTarget;
    const baseUrl = (customTarget || LLM_TARGET).replace(/\/+$/, '');
    const targetUrl = new URL(baseUrl + '/v1/chat/completions');
    const transport = targetUrl.protocol === 'https:' ? https : http;

    const payload = { ...body, stream: true };
    if (!payload.stream_options) payload.stream_options = { include_usage: true };
    const bodyStr = JSON.stringify(payload);

    const headers = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
        'Accept-Encoding': 'identity',   // never gzip an SSE body (kills token streaming)
    };
    if (LM_STUDIO_API_KEY) headers['Authorization'] = `Bearer ${LM_STUDIO_API_KEY}`;

    const req = transport.request({
        method: 'POST', hostname: targetUrl.hostname,
        port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
        path: targetUrl.pathname, headers,
        agent: transport === https ? httpsAgent : httpAgent,
        // Socket-inactivity timeout — must outlast the durable manager's
        // toolIdleMs (buffered tool-call args mean minutes of legal silence).
        timeout: 660000,
    }, (upstream) => {
        if (upstream.statusCode >= 400) {
            let err = '';
            upstream.on('data', c => { if (err.length < 2048) err += c; });
            upstream.on('end', () => onError(new Error(`LLM ${upstream.statusCode}: ${String(err).slice(0, 300)}`)));
            return;
        }
        let buf = '';
        upstream.on('data', (chunk) => {
            buf += chunk.toString('utf8');
            let nl;
            while ((nl = buf.indexOf('\n')) !== -1) {
                const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
                const t = line.trim();
                if (!t.startsWith('data:')) continue;          // skip comments/blank/event lines
                const data = t.slice(5).trim();
                if (!data || data === '[DONE]') continue;       // terminal handled by 'end'
                onData(data);
            }
        });
        upstream.on('end', () => onDone());
        upstream.on('error', (e) => onError(e));
    });
    req.on('error', (e) => onError(e));
    req.on('timeout', () => { try { req.destroy(new Error('LLM connect timeout')); } catch {} });
    if (signal) signal.addEventListener('abort', () => { try { req.destroy(); } catch {} }, { once: true });
    req.write(bodyStr);
    req.end();
}

const durableStream = createDurableManager
    ? createDurableManager({
        backend: forwardChatCompletion,
        dir: path.join(MEMORY_DIR, 'generations'),
        log,
    })
    : null;

const handlePreview = (previewProxy && devServerTool)
    ? previewProxy.createPreviewHandler({ listServers: devServerTool.listServers, log })
    : null;

// Does this URL name a file of the app itself? Used to decide whether a
// root-absolute request coming from a preview page belongs to Tricorder or to
// the preview — ours always wins.
function appFileExists(rawUrl) {
    const clean = rawUrl.split('?')[0];
    let decoded;
    try { decoded = decodeURIComponent(clean); } catch { return false; }
    // Same mapping serveStatic uses, so '/' counts as the app's own entry point.
    const rel = decoded === '/' ? '/index.html' : decoded;
    const resolved = path.resolve(path.join(__dirname, rel));
    if (!resolved.startsWith(path.resolve(__dirname))) return false;
    try { return fs.statSync(resolved).isFile(); } catch { return false; }
}

const server = http.createServer(async (req, res) => {
    const reqId = getRequestId();
    const startTime = Date.now();
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    log('INFO', 'HTTP', `#${reqId} ${req.method} ${req.url} from ${clientIp}`, {
        userAgent: req.headers['user-agent'],
    });

    res.on('finish', () => {
        const elapsed = Date.now() - startTime;
        log('INFO', 'HTTP', `#${reqId} ${res.statusCode} (${elapsed}ms)`);
    });

    if (req.method === 'OPTIONS') {
        log('DEBUG', 'HTTP', `#${reqId} CORS preflight`);
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-LM-Target',
            'Access-Control-Max-Age': '86400',
        });
        res.end();
        return;
    }

    try {
        const handled = await handleAuth(req, res, reqId);
        if (handled) return;
    } catch (err) {
        log('ERROR', 'AUTH', `#${reqId} Auth error: ${err.message}`);
        if (!res.headersSent) { res.writeHead(500); res.end('Internal server error'); }
        return;
    }


    // Quick TCP connectivity probe used by the client to check whether
    // LM Studio (or another local service) is reachable before issuing a
    // request. Localhost-only.
    if (req.url.startsWith('/llm/health-check')) {
        const params = new URL(req.url, `http://${req.headers.host || 'localhost'}`).searchParams;
        const host = params.get('host') || '127.0.0.1';
        const port = parseInt(params.get('port'), 10);
        if (!port || port < 1 || port > 65535) {
            jsonRes(res, 400, { error: 'Invalid port' });
            return;
        }
        // Only allow localhost probes — never probe external hosts
        if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
            jsonRes(res, 403, { error: 'Only localhost probes allowed' });
            return;
        }
        const sock = new net.Socket();
        sock.setTimeout(1000);
        sock.once('connect', () => { sock.destroy(); jsonRes(res, 200, { reachable: true }); });
        sock.once('error',   () => { sock.destroy(); jsonRes(res, 200, { reachable: false }); });
        sock.once('timeout', () => { sock.destroy(); jsonRes(res, 200, { reachable: false }); });
        sock.connect(port, host);
        return;
    }

    // --- Durable LLM streaming (Claude-style resume) ---------------------
    // generate → start a server-owned generation; stream → (re)attach by
    // cursor; state → snapshot/floor; cancel → stop. A dropped client only
    // detaches a subscriber; the generation keeps running and persists.
    if (durableStream && req.url.startsWith('/api/llm/')) {
        const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const p = u.pathname;

        if (p === '/api/llm/generate' && req.method === 'POST') {
            readJsonBody(req).then((body) => {
                if (!body || !Array.isArray(body.messages)) { jsonRes(res, 400, { error: 'messages[] required' }); return; }
                const routing = {
                    lmTarget: req.headers['x-lm-target'] || '',
                };
                const generationId = req.headers['x-generation-id'] || crypto.randomUUID();
                const chatId = req.headers['x-chat-id'] || null;
                const session = durableStream.start({ generationId, chatId, routing, body });
                log('INFO', 'DURABLE', `#${reqId} start ${session.generationId} (chat ${chatId || '-'})`);
                jsonRes(res, 202, { generationId: session.generationId, status: session.status });
            }).catch((e) => { if (!res.headersSent) jsonRes(res, 500, { error: e.message }); });
            return;
        }

        if (p.startsWith('/api/llm/stream/') && req.method === 'GET') {
            const id = p.slice('/api/llm/stream/'.length);
            const cursor = Number(req.headers['last-event-id'] ?? u.searchParams.get('cursor') ?? -1);
            res.writeHead(200, {
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-cache, no-transform',
                'Connection': 'keep-alive',
                'X-Accel-Buffering': 'no',
                'Access-Control-Allow-Origin': '*',
            });
            try { res.socket?.setNoDelay(true); } catch {}
            try { res.write(':ok\n\n'); } catch {}
            const writeFrame = (frame) => {
                try {
                    if (frame.type === 'data') res.write(`id: ${frame.seq}\nevent: data\ndata: ${frame.data}\n\n`);
                    else res.write(`id: ${frame.seq}\nevent: ${frame.type}\ndata: ${JSON.stringify(frame.data)}\n\n`);
                } catch { /* client vanished; close handler unsubscribes */ }
            };
            const session = durableStream.get(id);
            if (!session) {
                const state = durableStream.getState(id);
                if (state) writeFrame({ seq: state.seq, type: 'end', data: { status: state.status, finishReason: state.finishReason, reason: state.error, text: state.text } });
                else writeFrame({ seq: 0, type: 'end', data: { status: 'error', reason: 'unknown generation' } });
                res.end();
                return;
            }
            const unsubscribe = session.subscribe(cursor, writeFrame);
            if (durableStream.TERMINAL.has(session.status)) { res.end(); return; }
            const ka = setInterval(() => { try { res.write(':ka\n\n'); } catch {} }, 15000);
            if (ka.unref) ka.unref();
            req.on('close', () => { clearInterval(ka); unsubscribe(); });   // detach ONLY — never aborts the generation
            return;
        }

        if (p.startsWith('/api/llm/state/') && req.method === 'GET') {
            const state = durableStream.getState(p.slice('/api/llm/state/'.length));
            if (!state) { jsonRes(res, 404, { error: 'unknown generation' }); return; }
            jsonRes(res, 200, state);
            return;
        }

        if (p.startsWith('/api/llm/cancel/') && req.method === 'POST') {
            const ok = durableStream.cancel(p.slice('/api/llm/cancel/'.length));
            jsonRes(res, 200, { cancelled: ok });
            return;
        }

        jsonRes(res, 404, { error: 'unknown durable endpoint' });
        return;
    }

    // Live dev-server previews (/preview/<port>/…). The dev_server tool binds
    // to 127.0.0.1, so this is what makes a page the agent is iterating on
    // reachable from a phone or the public domain. The route sits after
    // handleAuth, so the site login already covers it — but with no SITE_PW
    // configured there is no login to pass, and then only a request that
    // originated on this host may see the workspace.
    if (previewProxy && previewProxy.parsePreviewPath(req.url)) {
        if (!handlePreview) {
            jsonRes(res, 503, { error: 'Preview proxy unavailable' });
            return;
        }
        if (!AUTH_ENABLED && !isDirectLocalRequest(req)) {
            log('WARN', 'PREVIEW', `#${reqId} Refused remote preview — SITE_PW not set`);
            res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end('Previews are served to authenticated sessions only. Set SITE_PW in .env and restart '
                + 'Tricorder to reach them from outside this host.\n');
            return;
        }
        handlePreview(req, res, reqId);
        return;
    }

    if (req.url.startsWith(PROXY_PATH)) {
        const downstreamPath = req.url.slice(PROXY_PATH.length) || '/';
        const customTarget = req.headers['x-lm-target'];
        const baseUrl = (customTarget || LLM_TARGET).replace(/\/+$/, '');
        const target = baseUrl + downstreamPath;
        if (customTarget) log('INFO', 'PROXY', `#${reqId} Custom target: ${customTarget}`);
        proxyRequest(req, res, target, reqId);
        return;
    }

    if (req.url.startsWith('/api/web/')) {
        handleWebFetchApi(req, res, reqId).catch(err => {
            log('ERROR', 'WEB', `#${reqId} Unhandled error: ${err.message}`);
            if (!res.headersSent) jsonRes(res, 500, { error: err.message });
        });
        return;
    }

    if (req.url.startsWith('/api/img-proxy')) {
        handleImageProxyApi(req, res, reqId).catch(err => {
            log('ERROR', 'IMGPROXY', `#${reqId} Unhandled error: ${err.message}`);
            if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end(`Image proxy error: ${err.message}`);
            }
        });
        return;
    }

    // Long-lived SSE feed for background-agent activity. The chat UI opens
    // this once on page load so the user sees spawn/output/close events in
    // real time instead of only what the model chooses to poll via
    // agent_status. We send a snapshot of all active agents on connect so a
    // late-joining tab immediately shows the current state.
    if (req.method === 'GET' && (req.url === '/api/agents/events' || req.url.startsWith('/api/agents/events?'))) {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        try { res.write(': tricorder-agents-stream\n\n'); } catch {}
        const write = (event, data) => {
            try {
                res.write(`event: ${event}\n`);
                res.write(`data: ${JSON.stringify(data)}\n\n`);
            } catch { /* client went away; cleanup below */ }
        };
        // Snapshot: send all known agents (running + recently completed) so
        // the panel can be reconstructed after a reload.
        for (const agent of backgroundAgents.values()) {
            write('agent_snapshot', agentSnapshot(agent, { tailBytes: 2048 }));
        }
        // Replay recent proactive messages, so one that fired while the app was
        // closed still lands in the chat on reopen. The browser drops ids it has
        // already rendered, which also covers a second tab and a reconnect.
        for (const msg of recentChatPushes()) write('chat_push', msg);
        agentSubscribers.add(write);
        const keepalive = setInterval(() => { try { res.write(': keepalive\n\n'); } catch {} }, 15000);
        req.on('close', () => {
            agentSubscribers.delete(write);
            clearInterval(keepalive);
        });
        return;
    }

    // First-run setup: backend detection and the wizard's saved choice.
    if (req.url.startsWith('/api/setup')) {
        handleSetupApi(req, res, reqId).catch(err => {
            log('ERROR', 'SETUP', `#${reqId} Unhandled error: ${err.message}`);
            if (!res.headersSent) jsonRes(res, 500, { error: err.message });
        });
        return;
    }

    if (req.url.startsWith('/api/server/')) {
        handleServerApi(req, res, reqId).catch(err => {
            log('ERROR', 'API', `#${reqId} Unhandled error: ${err.message}`);
            if (!res.headersSent) jsonRes(res, 500, { error: err.message });
        });
        return;
    }

    if (req.url === '/api/memory' || req.url.startsWith('/api/memory?') || req.url.startsWith('/api/memory/')) {
        handleMemoryApi(req, res, reqId).catch(err => {
            log('ERROR', 'MEMORY', `#${reqId} Unhandled error: ${err.message}`);
            if (!res.headersSent) jsonRes(res, 500, { error: err.message });
        });
        return;
    }

    if (req.url === '/api/tools/execute' || req.url.startsWith('/api/tools/execute?')
        || req.url === '/api/tools/execute-stream' || req.url.startsWith('/api/tools/execute-stream?')) {
        handleToolExecApi(req, res, reqId).catch(err => {
            log('ERROR', 'TOOLS', `#${reqId} Unhandled error: ${err.message}`);
            if (!res.headersSent) jsonRes(res, 500, { error: err.message });
        });
        return;
    }

    if (req.url.startsWith('/api/chatlogs')) {
        handleChatlogsApi(req, res, reqId).catch(err => {
            log('ERROR', 'CHATLOGS', `#${reqId} Unhandled error: ${err.message}`);
            if (!res.headersSent) jsonRes(res, 500, { error: err.message });
        });
        return;
    }

    // Task API over the model Tricorder already uses — same pipeline as the
    // app's own chat, on the wire for anything else on the LAN.
    if (req.url.startsWith('/api/ai/')) {
        handleAiApi(req, res, reqId).catch(err => {
            log('ERROR', 'AI-API', `#${reqId} Unhandled error: ${err.message}`);
            if (!res.headersSent) jsonRes(res, 500, { error: err.message });
        });
        return;
    }

    if (req.url.startsWith('/api/files/')) {
        handleFilesApi(req, res, reqId).catch(err => {
            log('ERROR', 'FILES', `#${reqId} Unhandled error: ${err.message}`);
            if (!res.headersSent) jsonRes(res, 500, { error: err.message });
        });
        return;
    }

    if (req.url.startsWith('/api/tasks/')) {
        handleTasksApi(req, res, reqId).catch(err => {
            log('ERROR', 'TASKS', `#${reqId} Unhandled error: ${err.message}`);
            if (!res.headersSent) jsonRes(res, 500, { error: err.message });
        });
        return;
    }

    if (req.url.startsWith('/api/notifications/')) {
        handleNotificationsApi(req, res, reqId).catch(err => {
            log('ERROR', 'NOTIF', `#${reqId} Unhandled error: ${err.message}`);
            if (!res.headersSent) jsonRes(res, 500, { error: err.message });
        });
        return;
    }

    if (req.url === '/api/agent/background' || req.url.startsWith('/api/agent/background?')
        || req.url === '/api/agent/background/abort' || req.url.startsWith('/api/agent/background/abort?')) {
        handleBackgroundAgentApi(req, res, reqId).catch(err => {
            log('ERROR', 'BG-AGENT', `#${reqId} Unhandled error: ${err.message}`);
            if (!res.headersSent) jsonRes(res, 500, { error: err.message });
        });
        return;
    }

    if (req.url.startsWith('/api/dashboard/')) {
        handleDashboardApi(req, res, reqId).catch(err => {
            log('ERROR', 'DASH', `#${reqId} Unhandled error: ${err.message}`);
            if (!res.headersSent) jsonRes(res, 500, { error: err.message });
        });
        return;
    }

    if (req.url === '/api/workspace') {
        // Return workspace info (path, sub-dirs, disk usage)
        try {
            const subs = fs.readdirSync(WORKSPACE_DIR, { withFileTypes: true });
            const dirs = subs.filter(d => d.isDirectory()).map(d => d.name);
            const files = subs.filter(d => d.isFile()).map(d => d.name);
            jsonRes(res, 200, { path: WORKSPACE_DIR, dirs, files });
        } catch (e) {
            jsonRes(res, 500, { error: e.message });
        }
        return;
    }

    if (req.url === '/api/system-info') {
        // Platform/shell/python capabilities so the LLM knows where it lives.
        // Surfaced to the client and injected into the system prompt by js/llm.js.
        try {
            const isWin = process.platform === 'win32';
            const pythonBin = process.env.TRICORDER_PYTHON || (isWin ? 'py' : 'python3');
            const shell = isWin ? 'cmd.exe' : (process.env.SHELL || '/bin/sh');
            const pathSep = isWin ? ';' : ':';
            const fileSep = isWin ? '\\' : '/';
            // Detect a handful of common tools on PATH (best-effort, non-blocking).
            const which = (bin) => {
                try {
                    const dirs = (process.env.PATH || '').split(pathSep);
                    const exts = isWin ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
                    for (const d of dirs) {
                        if (!d) continue;
                        for (const ext of exts) {
                            const p = path.join(d, bin + ext);
                            try { if (fs.statSync(p).isFile()) return p; } catch {}
                        }
                    }
                } catch {}
                return null;
            };
            const tools = {};
            for (const bin of ['python', 'python3', 'py', 'node', 'npm', 'git', 'powershell', 'pwsh', 'curl', 'ffmpeg']) {
                const p = which(bin);
                if (p) tools[bin] = p;
            }
            jsonRes(res, 200, {
                platform: process.platform,            // 'win32' | 'linux' | 'darwin'
                platformLabel: isWin ? 'Windows' : (process.platform === 'darwin' ? 'macOS' : 'Linux'),
                arch: process.arch,
                release: os.release(),
                hostname: os.hostname(),
                user: os.userInfo().username,
                shell,
                pathSep,
                fileSep,
                pythonBin,
                pythonPreferred: true,
                nodeVersion: process.version,
                cpus: os.cpus().length,
                totalMemoryGB: +(os.totalmem() / 1e9).toFixed(1),
                workspace: WORKSPACE_DIR,
                homedir: os.homedir(),
                tmpdir: os.tmpdir(),
                toolsOnPath: tools,
            });
        } catch (e) {
            jsonRes(res, 500, { error: e.message });
        }
        return;
    }

    if (req.url === '/api/exec' || req.url.startsWith('/api/exec?')) {
        handleExecApi(req, res, reqId).catch(err => {
            log('ERROR', 'EXEC', `#${reqId} Unhandled error: ${err.message}`);
            if (!res.headersSent) jsonRes(res, 500, { error: err.message });
        });
        return;
    }

    if (req.url === '/api/screenshot' || req.url.startsWith('/api/screenshot?')) {
        handleScreenshotApi(req, res, reqId).catch(err => {
            log('ERROR', 'BROWSE', `#${reqId} Unhandled error: ${err.message}`);
            if (!res.headersSent) jsonRes(res, 500, { error: err.message });
        });
        return;
    }

    // Last stop before our own files: a preview page that links its assets
    // root-absolutely (`/app.js`) asks for them here instead of under
    // /preview/<port>/, where the injected <base> would have resolved them.
    // The Referer names the preview they belong to, so send them back — but
    // never for a path Tricorder itself serves, and never when the site has no
    // login to protect the workspace with. The header parse is ordered first
    // because it returns null for every ordinary request, which keeps the
    // filesystem probe off the hot path.
    if (handlePreview && req.headers.referer && (AUTH_ENABLED || isDirectLocalRequest(req))) {
        const port = previewProxy.refererPreviewPort(req.headers.referer);
        if (port && !appFileExists(req.url)) {
            // Rewriting the URL keeps one code path for both entry points;
            // nothing downstream of here reads it again. Re-parsing first
            // guarantees the handler really takes it, so an odd request form
            // falls through to serveStatic instead of hanging.
            const rewritten = `${previewProxy.PREVIEW_PREFIX}/${port}${req.url}`;
            if (previewProxy.parsePreviewPath(rewritten)) {
                log('DEBUG', 'PREVIEW', `#${reqId} Referer fallback → :${port}${req.url}`);
                req.url = rewritten;
                handlePreview(req, res, reqId);
                return;
            }
        }
    }

    log('DEBUG', 'STATIC', `#${reqId} Serving ${req.url}`);
    serveStatic(req, res);
});
/* ============================================================================
   BOOT
   ============================================================================ */

// --- WebSocket upgrade routing ---
// Nothing in this build needs a WebSocket, so every upgrade is refused rather
// than left hanging. (Live-reload for dev_server previews rides on SSE.)
server.on('upgrade', (req, socket, head) => {
    const reqId = getRequestId();
    log('DEBUG', 'WS', `#${reqId} Upgrade refused: ${(req.url || '').split('?')[0]}`);
    try { socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); } catch {}
    try { socket.destroy(); } catch {}
});

// --- Backend health probe ---
// Hits the backend's /v1/models endpoint and returns the model-id list, or
// null when unreachable. Used for the startup banner so you immediately know
// whether the model server is up.
function probeLlmBackend(timeoutMs = 2500) {
    return new Promise((resolve) => {
        let url;
        try { url = new URL('/v1/models', LLM_TARGET); }
        catch { return resolve(null); }
        const transport = url.protocol === 'https:' ? https : http;
        const agent = url.protocol === 'https:' ? httpsAgent : httpAgent;
        const headers = { 'Accept': 'application/json' };
        if (LM_STUDIO_API_KEY) headers['authorization'] = `Bearer ${LM_STUDIO_API_KEY}`;
        const r = transport.request(url, { method: 'GET', agent, timeout: timeoutMs, headers }, (resp) => {
            let body = '';
            resp.setEncoding('utf8');
            resp.on('data', (c) => { if (body.length < 65536) body += c; });
            resp.on('end', () => {
                if (resp.statusCode >= 400) return resolve(null);
                try { resolve((JSON.parse(body).data || []).map(m => m.id).filter(Boolean)); } catch { resolve(null); }
            });
        });
        r.on('error', () => resolve(null));
        r.on('timeout', () => { r.destroy(); resolve(null); });
        r.end();
    });
}

// Flag any generation left mid-stream by a previous crash/restart as
// `interrupted` so clients surface the partial + a continue affordance instead
// of waiting on a stream that will never resume.
try { durableStream?.recoverInterrupted(); } catch (e) { console.error('[durable] recovery failed:', e.message); }

// One padded row of the boot banner.
function bannerRow(label, value) {
    const text = `  ${label.padEnd(11)}${String(value).slice(0, 30)}`;
    console.log(`  ║${text.padEnd(46)}║`);
}

server.listen(PORT, '0.0.0.0', () => {
    const levelName = Object.keys(LOG_LEVELS).find(k => LOG_LEVELS[k] === LOG_LEVEL) || 'DEBUG';
    const authMode = AUTH_ENABLED ? 'password' : 'disabled (local only)';

    console.log('');
    console.log('  ╔══════════════════════════════════════════════╗');
    console.log('  ║             TRICORDER AGENT                  ║');
    console.log('  ║        local-first agent runtime             ║');
    console.log('  ╠══════════════════════════════════════════════╣');
    bannerRow('Open:', `http://localhost:${PORT}`);
    bannerRow('Network:', `http://<your-ip>:${PORT}`);
    console.log('  ║                                              ║');
    bannerRow('Model:', LLM_TARGET);
    bannerRow('Proxy:', `${PROXY_PATH}/* → the model backend`);
    bannerRow('Previews:', '/preview/* (dev_server)');
    console.log('  ║                                              ║');
    bannerRow('Auth:', authMode);
    bannerRow('Shell:', SHELL_ENABLED ? 'enabled' : 'disabled');
    bannerRow('Code exec:', CODE_EXEC_ENABLED ? 'enabled (needs docker)' : 'disabled');
    bannerRow('Browser:', (BROWSER_CDP_URL || detectChromium()) ? 'available' : 'no chromium found');
    bannerRow('Workspace:', WORKSPACE_DIR);
    bannerRow('Log level:', levelName);
    console.log('  ╚══════════════════════════════════════════════╝');
    console.log('');

    log('INFO', 'SERVER', 'Tricorder Agent started', {
        port: PORT,
        llmTarget: LLM_TARGET,
        auth: authMode,
        logLevel: levelName,
        nodeVersion: process.version,
        pid: process.pid,
    });

    if (!AUTH_ENABLED) {
        log('WARN', 'AUTH', 'SITE_PW is not set — anyone who can reach this port gets a shell-capable agent. Set SITE_PW in .env before exposing this server beyond localhost.');
    }

    // Probe the backend so you immediately know whether it is up — far more
    // useful than only printing the target URL. The first-run wizard in the
    // browser does the same check and offers to fix it.
    probeLlmBackend().then((models) => {
        if (models && models.length) {
            log('INFO', 'LLM', `✓ Backend reachable at ${LLM_TARGET} — ${models.length} model(s): ${models.slice(0, 3).join(', ')}${models.length > 3 ? ', …' : ''}`);
            // Say something useful about WHICH model, not just how many. A
            // backend that is up with only an embedding model loaded reads as
            // healthy here and then fails on the first tool call.
            if (backends) {
                const best = backends.profiles.rankModels(models)[0];
                if (best && best.score < 100) log('INFO', 'LLM', `${best.id}: ${best.note} Run \`npm run doctor\` for the full picture.`);
            }
        } else if (models) {
            log('WARN', 'LLM', `Backend reachable at ${LLM_TARGET} but no model is loaded. Load one (LM Studio: Developer → select a model; llama.cpp: pass -hf ggml-org/Qwen3.8-27B-GGUF:Q4_K_M).`);
        } else {
            log('WARN', 'LLM', `No model backend at ${LLM_TARGET}. Run \`npm run setup\` for guided setup, or open the app and follow the wizard. Set LLM_BASE_URL in .env if yours lives elsewhere.`);
        }
    }).catch(() => { /* non-fatal */ });

    if (LLM_VISION_MODEL) {
        log('INFO', 'LLM', `Vision model "${LLM_VISION_MODEL}" set — image turns route there`);
    }
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`\n  Port ${PORT} is already in use.`);
        console.error(`  Either stop what is using it, or start on another port:  PORT=3001 node server.js\n`);
        process.exit(1);
    }
    log('ERROR', 'SERVER', `Server error: ${err.message}`);
    process.exit(1);
});

process.on('uncaughtException', (err) => {
    log('ERROR', 'PROCESS', `Uncaught exception: ${err.message}`, { stack: err.stack });
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    log('ERROR', 'PROCESS', `Unhandled rejection: ${reason}`, {
        stack: reason instanceof Error ? reason.stack : undefined,
    });
});

// Graceful shutdown so an in-flight generation is not cut mid-write and the
// dev_server previews release their ports.
for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
        log('INFO', 'SERVER', `${sig} — shutting down`);
        try { server.close(); } catch {}
        setTimeout(() => process.exit(0), 300).unref();
    });
}
