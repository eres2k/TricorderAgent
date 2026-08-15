/* preview-proxy — serve dev_server previews through the Tricorder origin.

   The dev_server tool binds to 127.0.0.1, so the pages the agent writes are
   invisible to an operator connected from outside (phone, laptop, the public
   domain). This module mounts every running dev server under
   `/preview/<port>/` on the main Tricorder server, which means previews
   inherit the site's authentication — no second password, no separately
   exposed port, and nothing reachable that the login gate doesn't cover.

   Only ports that a live dev_server instance actually owns are proxied; an
   arbitrary port in the URL is a 404, not a hole into the host's loopback
   interface.

   Served HTML gets a `<base href="/preview/<port>/">` so relative URLs keep
   resolving under the prefix. Root-absolute URLs (`/app.js`) can't be fixed
   by <base>, so server.js additionally falls back on the Referer header —
   see refererPreviewPort(). */

'use strict';

const http = require('http');

const PREVIEW_PREFIX = '/preview';

// Hop-by-hop headers must not be forwarded (RFC 7230 §6.1).
const HOP_BY_HOP = new Set([
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

/**
 * Classify a request URL against the preview mount point.
 *
 * '/preview' | '/preview/'        → { kind: 'index' }
 * '/preview/8100'                 → { kind: 'redirect', port, to }
 * '/preview/8100/app.js?v=1'      → { kind: 'proxy', port, path: '/app.js?v=1' }
 * anything else                   → null (not ours)
 */
function parsePreviewPath(rawUrl) {
    if (typeof rawUrl !== 'string') return null;
    const qIdx = rawUrl.indexOf('?');
    const pathname = qIdx < 0 ? rawUrl : rawUrl.slice(0, qIdx);
    const search = qIdx < 0 ? '' : rawUrl.slice(qIdx);

    if (pathname !== PREVIEW_PREFIX && !pathname.startsWith(PREVIEW_PREFIX + '/')) return null;
    const tail = pathname.slice(PREVIEW_PREFIX.length);
    if (tail === '' || tail === '/') return { kind: 'index' };

    const m = /^\/(\d{1,5})(\/.*)?$/.exec(tail);
    if (!m) return null;
    const port = Number(m[1]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;

    // Without the trailing slash the browser would resolve relative URLs
    // against /preview/, one level too high — redirect instead of guessing.
    if (m[2] == null) return { kind: 'redirect', port, to: `${PREVIEW_PREFIX}/${port}/${search}` };

    return { kind: 'proxy', port, path: m[2] + search };
}

/** '/preview/8100/' for a port — the public mount point of one dev server. */
function previewPath(port) {
    return `${PREVIEW_PREFIX}/${port}/`;
}

/**
 * Port of the preview page a request came from, or null.
 *
 * Pages that link their assets root-absolutely (`/app.js`) request them at the
 * Tricorder root, where <base> can't help. The Referer still names the preview
 * they belong to, which is enough to route them back.
 */
function refererPreviewPort(referer) {
    if (!referer) return null;
    let pathname;
    try {
        pathname = new URL(referer, 'http://localhost').pathname;
    } catch {
        return null;
    }
    const m = new RegExp(`^${PREVIEW_PREFIX}/(\\d{1,5})(/|$)`).exec(pathname);
    if (!m) return null;
    const port = Number(m[1]);
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

/**
 * Insert `<base href>` as the document's first base element so relative URLs
 * resolve under the preview prefix. The first base element with an href wins,
 * so ours must come before any the page defines itself.
 */
function injectBaseHref(html, href) {
    const tag = `<base href="${String(href).replace(/"/g, '&quot;')}">`;
    const head = /<head\b[^>]*>/i.exec(html);
    if (head) {
        const at = head.index + head[0].length;
        return html.slice(0, at) + tag + html.slice(at);
    }
    const htmlTag = /<html\b[^>]*>/i.exec(html);
    if (htmlTag) {
        const at = htmlTag.index + htmlTag[0].length;
        return html.slice(0, at) + `<head>${tag}</head>` + html.slice(at);
    }
    // Fragment without <html>/<head>: the parser hoists a leading <base> into
    // the head it synthesizes, so prepending is enough.
    return tag + html;
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/** LCARS-flavoured index of the running dev servers, matching the login page. */
function renderIndexPage(servers) {
    const rows = servers.length
        ? servers.map((s) => `
        <a class="row" href="${previewPath(s.port)}">
          <span class="port">:${s.port}</span>
          <span class="root">${escapeHtml(s.root)}</span>
          <span class="meta">${s.clients} client${s.clients === 1 ? '' : 's'} &middot; ${s.hits} hit${s.hits === 1 ? '' : 's'}</span>
        </a>`).join('')
        : '<div class="empty">NO DEV SERVER RUNNING — ask Tricorder to start one with the dev_server tool.</div>';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>TRICORDER — PREVIEWS</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #000; color: #ff9900; font-family: 'Courier New', Courier, monospace; min-height: 100dvh; display: flex; align-items: center; justify-content: center; padding: 1.5rem; }
    .frame { width: 100%; max-width: 640px; border: 3px solid #ff9900; border-radius: 0 0 12px 12px; overflow: hidden; }
    .header { background: #ff9900; color: #000; padding: 0.6rem 1.2rem; font-size: 1rem; font-weight: 700; letter-spacing: 0.18em; text-transform: uppercase; }
    .body { padding: 1.5rem; display: flex; flex-direction: column; gap: 0.75rem; }
    .row { display: flex; flex-direction: column; gap: 0.2rem; border: 2px solid #ff9900; border-radius: 4px; padding: 0.7rem 0.9rem; text-decoration: none; color: #ff9900; transition: background 0.15s, color 0.15s; }
    .row:hover { background: #ff9900; color: #000; }
    .port { font-size: 1rem; font-weight: 700; letter-spacing: 0.12em; }
    .root { font-size: 0.75rem; word-break: break-all; }
    .meta { font-size: 0.65rem; letter-spacing: 0.1em; opacity: 0.75; }
    .empty { font-size: 0.8rem; letter-spacing: 0.08em; color: #cc7700; }
    .footer { background: #ff9900; height: 8px; }
  </style>
</head>
<body>
  <div class="frame">
    <div class="header">TRICORDER&nbsp;&mdash;&nbsp;LIVE PREVIEWS</div>
    <div class="body">${rows}</div>
    <div class="footer"></div>
  </div>
</body>
</html>`;
}

/**
 * Build the /preview request handler.
 *
 * @param {object} deps
 * @param {() => Array<{port:number, root:string, clients:number, hits:number}>} deps.listServers
 *        Live snapshot of the running dev servers (the dev_server registry).
 * @param {(level:string, cat:string, msg:string, data?:any) => void} [deps.log]
 * @returns {(req, res, reqId?) => boolean} true when the request was handled.
 */
function createPreviewHandler({ listServers, log = () => {} }) {
    return function handlePreview(req, res, reqId) {
        const route = parsePreviewPath(req.url);
        if (!route) return false;

        if (route.kind === 'index') {
            const html = renderIndexPage(listServers());
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(html);
            return true;
        }

        if (route.kind === 'redirect') {
            res.writeHead(302, { 'Location': route.to, 'Cache-Control': 'no-store' });
            res.end();
            return true;
        }

        const servers = listServers();
        if (!servers.some((s) => s.port === route.port)) {
            const running = servers.map((s) => s.port).join(', ') || 'none';
            log('WARN', 'PREVIEW', `#${reqId} No dev server on port ${route.port} (running: ${running})`);
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(`No dev server running on port ${route.port}. Running: ${running}\n`);
            return true;
        }

        proxyToPreview(req, res, route.port, route.path, log, reqId);
        return true;
    };
}

/** Stream one request to the loopback dev server on `port`. */
function proxyToPreview(req, res, port, path, log, reqId) {
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
        if (HOP_BY_HOP.has(k.toLowerCase())) continue;
        headers[k] = v;
    }
    headers.host = `127.0.0.1:${port}`;
    // The preview is a static file server with no notion of our session; not
    // forwarding the credentials keeps them out of anything it might log.
    delete headers.cookie;
    delete headers.authorization;
    // We rewrite HTML bodies, so a compressed upstream body would have to be
    // inflated first. The dev server never compresses — say so explicitly.
    headers['accept-encoding'] = 'identity';

    const upstream = http.request({
        host: '127.0.0.1', port, path, method: req.method, headers,
        // Live-reload SSE streams stay open indefinitely; only an idle socket
        // should be reaped, and the dev server pings every 25 s.
        timeout: 120000,
    }, (up) => {
        const ct = String(up.headers['content-type'] || '').toLowerCase();
        const isHtml = ct.includes('text/html');
        const out = {};
        for (const [k, v] of Object.entries(up.headers)) {
            if (HOP_BY_HOP.has(k.toLowerCase())) continue;
            out[k] = v;
        }
        // A preview is live-edited by definition — never let a browser, the
        // service worker or an upstream CDN hold on to a stale copy.
        out['cache-control'] = 'no-store';
        if (ct.includes('text/event-stream')) out['x-accel-buffering'] = 'no';

        if (!isHtml) {
            res.writeHead(up.statusCode || 200, out);
            up.pipe(res);
            return;
        }

        // HTML is buffered so the <base> can be injected; everything else
        // (including SSE) streams untouched.
        const chunks = [];
        up.on('data', (c) => chunks.push(c));
        up.on('end', () => {
            const body = injectBaseHref(Buffer.concat(chunks).toString('utf8'), previewPath(port));
            const buf = Buffer.from(body, 'utf8');
            out['content-length'] = String(buf.length);
            res.writeHead(up.statusCode || 200, out);
            res.end(buf);
        });
        up.on('error', () => { try { res.end(); } catch { /* closed */ } });
    });

    upstream.on('timeout', () => upstream.destroy(new Error('preview timeout')));
    upstream.on('error', (err) => {
        log('ERROR', 'PREVIEW', `#${reqId} Upstream :${port} failed: ${err.message}`);
        if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        }
        try { res.end(`Preview server on port ${port} is not responding: ${err.message}\n`); } catch { /* closed */ }
    });

    req.on('aborted', () => upstream.destroy());
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
}

module.exports = {
    PREVIEW_PREFIX,
    parsePreviewPath,
    previewPath,
    refererPreviewPort,
    injectBaseHref,
    renderIndexPage,
    createPreviewHandler,
};
