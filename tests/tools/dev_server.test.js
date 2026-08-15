'use strict';

// End-to-end coverage of the dev_server tool: serving, HTML live-reload
// injection, SSE reload events on file change, path-traversal rejection and
// the start/stop/status lifecycle. Everything runs against an ephemeral port
// (port: 0) in a temp directory, so tests are parallel-safe and leave no
// state behind.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const devServer = require('../../server/tools/dev_server');

function tmpRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'tricorder-devsrv-'));
}

function get(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let body = '';
            res.on('data', (d) => { body += d; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
        }).on('error', reject);
    });
}

// Always stop every server this file started, even on assertion failures.
after(async () => { await devServer.execute({ action: 'stop' }); });

test('start serves files and injects the live-reload client into HTML', async () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, 'index.html'), '<html><body><h1>Hi</h1></body></html>');
    fs.writeFileSync(path.join(root, 'app.js'), 'console.log(1)');

    const r = await devServer.execute({ action: 'start', root, port: 0 });
    assert.strictEqual(r.ok, true);
    assert.match(r.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);

    const page = await get(r.url);
    assert.strictEqual(page.status, 200);
    assert.match(page.headers['content-type'], /text\/html/);
    assert.match(page.body, /<h1>Hi<\/h1>/);
    assert.match(page.body, /__livereload/, 'reload client injected');
    assert.match(page.body, /__livereload[\s\S]*<\/body>/, 'injected before </body>');

    const js = await get(r.url + 'app.js');
    assert.strictEqual(js.status, 200);
    assert.match(js.headers['content-type'], /javascript/);
    assert.ok(!js.body.includes('__livereload'), 'non-HTML is not modified');

    await devServer.execute({ action: 'stop', port: r.port });
});

test('a file change broadcasts a reload event to connected SSE clients', async () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, 'index.html'), '<html><body>v1</body></html>');
    const r = await devServer.execute({ action: 'start', root, port: 0 });

    const reloadSeen = new Promise((resolve, reject) => {
        const req = http.get(`${r.url}__livereload`, (res) => {
            assert.match(res.headers['content-type'], /text\/event-stream/);
            let buf = '';
            res.on('data', (d) => {
                buf += d;
                if (buf.includes('event: reload')) { req.destroy(); resolve(); }
            });
        });
        req.on('error', () => { /* destroyed after resolve */ });
        setTimeout(() => { req.destroy(); reject(new Error('no reload event within 5s')); }, 5000).unref();
    });

    // Give the SSE connection and fs.watch a moment to attach, then touch.
    await new Promise((res) => setTimeout(res, 300));
    fs.writeFileSync(path.join(root, 'index.html'), '<html><body>v2</body></html>');

    await reloadSeen;
    await devServer.execute({ action: 'stop', port: r.port });
});

test('path traversal outside the root is rejected', async () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, 'index.html'), '<html><body>x</body></html>');
    const r = await devServer.execute({ action: 'start', root, port: 0 });

    const res = await get(`http://127.0.0.1:${r.port}/..%2f..%2f..%2fetc%2fpasswd`);
    assert.ok(res.status === 403 || res.status === 404, `expected 403/404, got ${res.status}`);
    assert.ok(!res.body.includes('root:'), 'must not leak files outside the root');

    await devServer.execute({ action: 'stop', port: r.port });
});

test('start is idempotent per root; status and stop reflect the lifecycle', async () => {
    const root = tmpRoot();
    const first = await devServer.execute({ action: 'start', root, port: 0 });
    const second = await devServer.execute({ action: 'start', root });
    assert.strictEqual(second.already_running, true);
    assert.strictEqual(second.port, first.port);

    const st = await devServer.execute({ action: 'status' });
    assert.ok(st.servers.some((s) => s.port === first.port && s.root === root));

    const stopped = await devServer.execute({ action: 'stop', port: first.port });
    assert.deepStrictEqual(stopped.stopped, [first.port]);
    const after1 = await devServer.execute({ action: 'status' });
    assert.ok(!after1.servers.some((s) => s.port === first.port));
});

test('the live-reload endpoint answers at any depth', async () => {
    // The injected client resolves __livereload against document.baseURI, which
    // is the page's own directory for a nested page served directly and the
    // <base href> the preview proxy injects when it is proxied. Both forms have
    // to land on the SSE stream.
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, 'sub'));
    fs.writeFileSync(path.join(root, 'sub', 'page.html'), '<html><body>x</body></html>');
    const r = await devServer.execute({ action: 'start', root, port: 0 });

    for (const p of ['__livereload', 'sub/__livereload']) {
        const res = await new Promise((resolve, reject) => {
            const req = http.get(`${r.url}${p}`, (res2) => { req.destroy(); resolve(res2); });
            req.on('error', () => { /* destroyed above */ });
            setTimeout(() => { req.destroy(); reject(new Error(`no response for ${p}`)); }, 5000).unref();
        });
        assert.strictEqual(res.statusCode, 200, p);
        assert.match(res.headers['content-type'], /text\/event-stream/, p);
    }

    // The snippet must resolve relatively, or the nested page above would look
    // for the stream at the origin root.
    const page = await get(`${r.url}sub/page.html`);
    assert.match(page.body, /new URL\("__livereload",document\.baseURI\)/);

    await devServer.execute({ action: 'stop', port: r.port });
});

test('results carry the authenticated preview path, and a public URL when configured', async () => {
    const root = tmpRoot();
    const prev = process.env.PUBLIC_URL;
    delete process.env.PUBLIC_URL;

    const plain = await devServer.execute({ action: 'start', root, port: 0 });
    assert.strictEqual(plain.preview_path, `/preview/${plain.port}/`);
    assert.strictEqual(plain.public_url, undefined, 'no PUBLIC_URL → no absolute link to invent');
    assert.strictEqual(plain.url, `http://127.0.0.1:${plain.port}/`);

    // Trailing slashes in the configured origin must not double up.
    process.env.PUBLIC_URL = 'https://tricorder.example.com/';
    const st = await devServer.execute({ action: 'status' });
    const entry = st.servers.find((s) => s.port === plain.port);
    assert.strictEqual(entry.public_url, `https://tricorder.example.com/preview/${plain.port}/`);
    assert.strictEqual(entry.preview_path, `/preview/${plain.port}/`);

    if (prev === undefined) delete process.env.PUBLIC_URL; else process.env.PUBLIC_URL = prev;
    await devServer.execute({ action: 'stop', port: plain.port });
});

test('listServers exposes the running set the preview proxy validates against', async () => {
    const root = tmpRoot();
    const r = await devServer.execute({ action: 'start', root, port: 0 });

    const running = devServer.listServers();
    const mine = running.find((s) => s.port === r.port);
    assert.ok(mine, 'started server is listed');
    assert.strictEqual(mine.root, root);
    assert.strictEqual(typeof mine.clients, 'number');

    await devServer.execute({ action: 'stop', port: r.port });
    assert.ok(!devServer.listServers().some((s) => s.port === r.port), 'stopped server is gone');
});

test('stop on an unknown port and invalid ports are structured errors', async () => {
    await assert.rejects(
        () => devServer.execute({ action: 'stop', port: 64999 }),
        (e) => e.code === 'NOT_FOUND',
    );
    await assert.rejects(
        () => devServer.execute({ action: 'start', root: tmpRoot(), port: 80 }),
        (e) => e.code === 'BAD_PORT',
    );
});
