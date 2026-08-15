/* dev_server — persistent local static-file server with live reload.
   Serves a workspace directory on 127.0.0.1 and auto-reloads open browser
   tabs when a file under the root changes: HTML responses get a small
   EventSource client injected, a recursive fs.watch broadcasts a debounced
   `reload` SSE event on every change. Servers live in module state, so they
   persist across agent turns until stopped (or the Tricorder server exits) —
   the "persistent dev server" a one-shot `python -m http.server` run from
   run_command can never be. Pure Node, zero dependencies.

   Binding to 127.0.0.1 keeps the preview off the network; the main Tricorder
   server re-exposes every running instance under /preview/<port>/ behind its
   own login (see server/preview-proxy.js), so a remote operator reaches it
   through the authenticated origin instead of an open port. */

'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const lib = require('./_lib');
const { previewPath } = require('../preview-proxy');

const name = 'dev_server';

const schema = {
    type: 'function',
    function: {
        name,
        description: 'Persistent local static-file dev server with live reload. Actions: '
            + 'start(root?, port?) serves a directory at http://127.0.0.1:<port>/ and auto-reloads '
            + 'open browser tabs whenever a file under the root changes — start it once, then iterate '
            + 'with file_edit/write_file and view via browser_navigate + browser_vision; '
            + 'stop(port?) stops one server (or all when no port is given); status lists running servers. '
            + 'The server persists across turns until stopped. Every running server is also reachable '
            + 'through Tricorder itself at the returned preview_path (/preview/<port>/), behind the site '
            + 'login — give the operator public_url (or preview_path) so they can open the page from '
            + 'another device; the 127.0.0.1 URL only works on the host.',
        parameters: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['start', 'stop', 'status'] },
                root: { type: 'string', description: 'Directory to serve (default <workspace>/code)' },
                port: { type: 'number', description: 'Port to listen on (default: first free port from 8100; 0 picks an ephemeral port)' },
            },
            required: ['action'],
        },
    },
};

const ACTIONS = ['start', 'stop', 'status'];
const REQUIRED_PARAMS = { start: [], stop: [], status: [] };

// First auto-assigned port and how many consecutive ports to try before
// giving up. High enough to dodge common dev defaults (3000/5173/8000/8080).
const PORT_SCAN_START = 8100;
const PORT_SCAN_COUNT = 30;

const MIME = {
    '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
    '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/plain; charset=utf-8', '.xml': 'application/xml',
    '.wasm': 'application/wasm', '.pdf': 'application/pdf',
    // 3D / asset-pipeline types (glTF workflows are a primary use case)
    '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
    '.bin': 'application/octet-stream', '.obj': 'text/plain; charset=utf-8',
    '.mtl': 'text/plain; charset=utf-8', '.hdr': 'application/octet-stream',
    '.ktx2': 'image/ktx2', '.exr': 'application/octet-stream',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
    '.mp4': 'video/mp4', '.webm': 'video/webm',
    '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
};

// Injected before </body> of every served HTML file. EventSource auto-
// reconnects, so a server restart just re-attaches instead of going dead.
// The endpoint is resolved against document.baseURI rather than the origin
// root: served directly that is the page's own URL, and behind the
// /preview/<port>/ proxy it is the <base href> the proxy injects — so the
// same snippet finds the SSE stream either way. handleRequest accepts
// __livereload at any depth to match.
const RELOAD_SNIPPET = '<script>/* tricorder live-reload */new EventSource(new URL("__livereload",document.baseURI)).addEventListener("reload",function(){location.reload()});</script>';

// port → { server, root, watcher, clients:Set, heartbeat, startedAt, hits, reloads, lastChange }
const SERVERS = new Map();

// Where this server can be reached from. The loopback URL only works on the
// host; Tricorder re-serves the same instance under /preview/<port>/ behind
// the site login, and PUBLIC_URL (e.g. https://tricorder.example.com) turns
// that path into a link the operator can open from any device.
function reachableFrom(port) {
    const out = { url: `http://127.0.0.1:${port}/`, preview_path: previewPath(port) };
    const base = (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
    if (base) out.public_url = base + previewPath(port);
    return out;
}

/** Live snapshot of the running servers — the registry the preview proxy
    validates ports against. Sync on purpose: it runs per proxied request. */
function listServers() {
    return [...SERVERS.entries()].map(([port, e]) => ({
        port,
        root: e.root,
        clients: e.clients.size,
        hits: e.hits,
        reloads: e.reloads,
        startedAt: e.startedAt,
    }));
}

function broadcast(entry, file) {
    entry.reloads++;
    entry.lastChange = file || null;
    for (const res of entry.clients) {
        try { res.write(`event: reload\ndata: ${JSON.stringify(file || '')}\n\n`); } catch { /* gone */ }
    }
}

function handleRequest(entry, req, res) {
    const root = entry.root;
    let pathname;
    try {
        pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
        res.writeHead(400); res.end('Bad request'); return;
    }

    // SSE endpoint the injected client connects to. Accepted at any depth
    // because the client resolves it relative to the document's base URL,
    // which is the page's directory for a nested page served directly.
    if (pathname === '/__livereload' || pathname.endsWith('/__livereload')) {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-store',
            'Connection': 'keep-alive',
        });
        res.write('retry: 1000\n\n');
        entry.clients.add(res);
        req.on('close', () => entry.clients.delete(res));
        return;
    }

    // Resolve inside the root only — path.normalize collapses any ../ before
    // the prefix check, so traversal can't escape.
    let fp = path.normalize(path.join(root, pathname));
    if (fp !== root && !fp.startsWith(root + path.sep)) {
        res.writeHead(403); res.end('Forbidden'); return;
    }

    let st;
    try { st = fs.statSync(fp); } catch { st = null; }
    if (st && st.isDirectory()) {
        fp = path.join(fp, 'index.html');
        try { st = fs.statSync(fp); } catch { st = null; }
    }
    if (!st || !st.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end(`Not found: ${pathname}`);
        return;
    }

    entry.hits++;
    const ext = path.extname(fp).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    if (ext === '.html' || ext === '.htm') {
        // Buffer HTML to inject the reload client; everything else streams.
        let html;
        try { html = fs.readFileSync(fp, 'utf8'); } catch (e) {
            res.writeHead(500); res.end(e.message); return;
        }
        html = /<\/body>/i.test(html)
            ? html.replace(/<\/body>/i, RELOAD_SNIPPET + '</body>')
            : html + RELOAD_SNIPPET;
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
        res.end(html);
        return;
    }
    res.writeHead(200, { 'Content-Type': mime, 'Content-Length': st.size, 'Cache-Control': 'no-store' });
    const stream = fs.createReadStream(fp);
    stream.on('error', () => { try { res.end(); } catch { /* closed */ } });
    stream.pipe(res);
}

function makeWatcher(entry) {
    // Debounce: editors fire several events per save (write + rename), and a
    // build step may touch many files at once — one reload beats a stampede.
    let timer = null;
    const onChange = (_event, file) => {
        clearTimeout(timer);
        timer = setTimeout(() => broadcast(entry, file ? String(file) : null), 200);
    };
    try {
        return fs.watch(entry.root, { recursive: true }, onChange);
    } catch {
        // Recursive watch is unavailable on some platforms/filesystems —
        // top-level changes still reload, subdirectories won't.
        return fs.watch(entry.root, onChange);
    }
}

function listen(server, port) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
            server.removeListener('error', reject);
            resolve(server.address().port);
        });
    });
}

async function start(args, ctx) {
    const workspace = (ctx && ctx.WORKSPACE_DIR) || lib.WORKSPACE_DIR;
    const root = lib.resolvePath(ctx, args.root || path.join(workspace, 'code'), { label: 'root' });
    lib.ensureDir(root);

    // Idempotent per root: a second start on the same directory returns the
    // running server instead of burning another port.
    for (const [port, entry] of SERVERS) {
        if (entry.root === root) {
            return { ok: true, already_running: true, ...reachableFrom(port), root, port, live_reload: true };
        }
    }

    const entry = { server: null, root, watcher: null, clients: new Set(), heartbeat: null, startedAt: Date.now(), hits: 0, reloads: 0, lastChange: null };
    const server = http.createServer((req, res) => handleRequest(entry, req, res));
    entry.server = server;

    let port;
    if (args.port != null) {
        const wanted = Number(args.port);
        if (!Number.isInteger(wanted) || wanted < 0 || wanted > 65535 || (wanted !== 0 && wanted < 1024)) {
            throw new lib.ToolError(`Invalid port ${args.port} (use 1024-65535, or 0 for an ephemeral port)`, 'BAD_PORT', { port: args.port });
        }
        try {
            port = await listen(server, wanted);
        } catch (e) {
            throw new lib.ToolError(`Port ${wanted} is unavailable: ${e.message}`, 'PORT_IN_USE', { port: wanted });
        }
    } else {
        let lastErr = null;
        for (let p = PORT_SCAN_START; p < PORT_SCAN_START + PORT_SCAN_COUNT; p++) {
            if (SERVERS.has(p)) continue;
            try { port = await listen(server, p); break; } catch (e) { lastErr = e; }
        }
        if (port == null) {
            throw new lib.ToolError(`No free port in ${PORT_SCAN_START}-${PORT_SCAN_START + PORT_SCAN_COUNT - 1}: ${lastErr && lastErr.message}`, 'PORT_IN_USE');
        }
    }

    entry.watcher = makeWatcher(entry);
    // SSE connections die silently behind proxies/sleeps without traffic;
    // a comment ping keeps them (and the reload pipe) alive.
    entry.heartbeat = setInterval(() => {
        for (const res of entry.clients) { try { res.write(':ping\n\n'); } catch { /* gone */ } }
    }, 25000);
    // Never keep the host process alive on our account (matters for tests;
    // the real Tricorder server runs indefinitely anyway).
    try { server.unref(); entry.heartbeat.unref(); } catch { /* ignore */ }

    SERVERS.set(port, entry);
    return {
        ok: true, ...reachableFrom(port), root, port, live_reload: true,
        note: 'Serves until stopped. Edit files under the root and open tabs reload automatically. '
            + 'Send the operator public_url (or preview_path on the current origin) — it goes through '
            + 'Tricorder and needs the site login; the 127.0.0.1 URL only works on the host.',
    };
}

function stopOne(port) {
    const entry = SERVERS.get(port);
    if (!entry) return false;
    SERVERS.delete(port);
    clearInterval(entry.heartbeat);
    try { entry.watcher && entry.watcher.close(); } catch { /* ignore */ }
    for (const res of entry.clients) { try { res.end(); } catch { /* ignore */ } }
    entry.clients.clear();
    try { entry.server.close(); } catch { /* ignore */ }
    return true;
}

async function stop(args) {
    if (args.port != null) {
        const port = Number(args.port);
        if (!stopOne(port)) {
            throw new lib.ToolError(`No dev server running on port ${port}`, 'NOT_FOUND', { port });
        }
        return { ok: true, stopped: [port] };
    }
    const ports = [...SERVERS.keys()];
    ports.forEach(stopOne);
    return { ok: true, stopped: ports };
}

async function status() {
    const servers = [...SERVERS.entries()].map(([port, e]) => ({
        port,
        ...reachableFrom(port),
        root: e.root,
        clients: e.clients.size,
        hits: e.hits,
        reloads: e.reloads,
        last_change: e.lastChange,
        uptime_s: Math.round((Date.now() - e.startedAt) / 1000),
    }));
    return { ok: true, running: servers.length, servers };
}

async function execute(args, ctx) {
    const action = lib.requireAction(args.action, ACTIONS);
    lib.requireParams(action, args, REQUIRED_PARAMS);
    switch (action) {
        case 'start': return start(args, ctx);
        case 'stop': return stop(args);
        case 'status': return status();
        default: throw new lib.ToolError(`Unhandled action ${action}`, 'BAD_ACTION');
    }
}

module.exports = { name, schema, execute, listServers };
