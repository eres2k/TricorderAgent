'use strict';

/* send_email — the SMTP tool.

   Two things are worth locking down. The message itself, because a malformed
   MIME body is not an error anyone sees: it arrives, and it is garbage. And
   the guard rails, because this is the only tool in the project that can reach
   a stranger, and it is meant to be driven by scheduled tasks running while
   nobody is watching.

   The protocol half is tested against a real socket rather than a mock. A
   hand-rolled SMTP client that has never been spoken to is not implemented,
   it is guessed. */

const { test } = require('node:test');
const assert = require('node:assert');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tool = require('../../server/tools/send_email.js');
const { buildMessage, readConfig, encodeHeader, dotStuff, toList,
        validateAddresses, enforceAllowlist } = tool._internals;

const CFG = {
    host: 'localhost', port: 2525, security: 'none', user: '', pass: '',
    from: 'agent@example.com', fromName: 'Tricorder Agent', allowed: [],
    rejectUnauthorized: false,
};

const baseMsg = (over = {}) => ({
    to: ['someone@example.com'], cc: [], bcc: [],
    subject: 'Status', body: 'All good.', html: '', replyTo: '',
    attachments: [], ...over,
});

/* ── Addresses ────────────────────────────────────────────────────────────── */

test('recipients accept a string, an array, or a separated list', () => {
    assert.deepStrictEqual(toList('a@b.com'), ['a@b.com']);
    assert.deepStrictEqual(toList(['a@b.com', 'c@d.com']), ['a@b.com', 'c@d.com']);
    assert.deepStrictEqual(toList('a@b.com, c@d.com; e@f.com'), ['a@b.com', 'c@d.com', 'e@f.com']);
    assert.deepStrictEqual(toList(''), []);
    assert.deepStrictEqual(toList(null), []);
});

test('a malformed address is refused before anything connects', () => {
    assert.throws(() => validateAddresses(['not-an-address'], 'to'), /not a valid email/);
    // Header injection: a newline here would let a body smuggle extra headers.
    assert.throws(() => validateAddresses(['a@b.com\nBcc: evil@x.com'], 'to'), /not a valid email/);
    assert.doesNotThrow(() => validateAddresses(['a.b+tag@sub.example.co.uk'], 'to'));
});

test('the allowlist is enforced per address, and understands a bare domain', () => {
    const cfg = { ...CFG, allowed: ['me@home.com', '@work.com'] };
    assert.doesNotThrow(() => enforceAllowlist(cfg, ['me@home.com']));
    assert.doesNotThrow(() => enforceAllowlist(cfg, ['anyone@work.com']));
    assert.doesNotThrow(() => enforceAllowlist(cfg, ['ME@HOME.COM']), 'matching is case-insensitive');
    assert.throws(() => enforceAllowlist(cfg, ['stranger@elsewhere.com']), /not in SMTP_ALLOWED_RECIPIENTS/);
    // One bad address in a batch fails the batch.
    assert.throws(() => enforceAllowlist(cfg, ['me@home.com', 'stranger@elsewhere.com']), /stranger/);
});

test('an empty allowlist means unrestricted, not blocked', () => {
    assert.doesNotThrow(() => enforceAllowlist({ ...CFG, allowed: [] }, ['anyone@anywhere.com']));
});

/* ── Configuration ────────────────────────────────────────────────────────── */

test('port 465 implies implicit TLS, everything else STARTTLS', () => {
    assert.strictEqual(readConfig({ SMTP_HOST: 'h', SMTP_PORT: '465' }).security, 'tls');
    assert.strictEqual(readConfig({ SMTP_HOST: 'h', SMTP_PORT: '587' }).security, 'starttls');
    assert.strictEqual(readConfig({ SMTP_HOST: 'h' }).security, 'starttls', 'default port is 587');
    assert.strictEqual(readConfig({ SMTP_HOST: 'h', SMTP_PORT: '465', SMTP_SECURITY: 'none' }).security, 'none',
        'an explicit choice still wins');
});

test('check_config names what is missing instead of failing obscurely', async () => {
    const res = await tool.execute({ action: 'check_config' }, { env: {} });
    assert.strictEqual(res.configured, false);
    assert.ok(res.missing.includes('SMTP_HOST'));
});

test('sending without configuration is a clear refusal', async () => {
    await assert.rejects(
        () => tool.execute({ action: 'send', to: ['a@b.com'], subject: 'x' }, { env: {} }),
        /not configured/i,
    );
});

/* ── Message assembly ─────────────────────────────────────────────────────── */

test('a plain message carries the headers a relay needs', () => {
    const raw = buildMessage(CFG, baseMsg());
    assert.match(raw, /^From: Tricorder Agent <agent@example\.com>/m);
    assert.match(raw, /^To: someone@example\.com$/m);
    assert.match(raw, /^Subject: Status$/m);
    assert.match(raw, /^Date: /m);
    assert.match(raw, /^Message-ID: <[0-9a-f]+@example\.com>$/m);
    assert.match(raw, /^Content-Type: text\/plain; charset=UTF-8$/m);
    assert.match(raw, /All good\./);
    assert.ok(raw.includes('\r\n'), 'SMTP wants CRLF');
});

test('bcc never appears in the message headers', () => {
    // The envelope carries bcc; the body must not, or it is not blind.
    const raw = buildMessage(CFG, baseMsg({ bcc: ['secret@example.com'] }));
    assert.ok(!/secret@example\.com/.test(raw), 'a bcc address in the headers defeats the point');
});

test('non-ASCII headers are RFC 2047 encoded', () => {
    assert.strictEqual(encodeHeader('plain ascii'), 'plain ascii');
    const encoded = encodeHeader('Bericht über Straßen');
    assert.match(encoded, /^=\?UTF-8\?B\?/);
    assert.strictEqual(Buffer.from(encoded.slice(10, -2), 'base64').toString('utf8'), 'Bericht über Straßen');

    const raw = buildMessage(CFG, baseMsg({ subject: 'Tägliche Übersicht' }));
    assert.ok(!raw.includes('Tägliche'), 'a raw 8-bit subject is not safe in a header');
    assert.match(raw, /^Subject: =\?UTF-8\?B\?/m);
});

test('a line starting with a dot cannot end the message early', () => {
    assert.strictEqual(dotStuff('a\r\n.\r\nb'), 'a\r\n..\r\nb');
    const raw = buildMessage(CFG, baseMsg({ body: 'first\n.\nlast' }));
    assert.ok(raw.includes('\r\n..\r\n'), 'an unescaped bare dot truncates the message at the relay');
});

test('html gets a plain-text alternative alongside it', () => {
    const raw = buildMessage(CFG, baseMsg({ body: 'Plain fallback', html: '<p>Rich</p>' }));
    assert.match(raw, /Content-Type: multipart\/alternative; boundary="(.+)"/);
    assert.match(raw, /Content-Type: text\/plain; charset=UTF-8/);
    assert.match(raw, /Content-Type: text\/html; charset=UTF-8/);
    assert.ok(raw.indexOf('Plain fallback') < raw.indexOf('<p>Rich</p>'),
        'the plain part must come first — clients render the last part they understand');
});

test('attachments produce a mixed multipart with base64 content', () => {
    const raw = buildMessage(CFG, baseMsg({
        attachments: [{ filename: 'report.csv', content: Buffer.from('a,b\n1,2\n') }],
    }));
    assert.match(raw, /Content-Type: multipart\/mixed; boundary="(.+)"/);
    assert.match(raw, /Content-Type: text\/csv; name="report\.csv"/);
    assert.match(raw, /Content-Disposition: attachment; filename="report\.csv"/);
    assert.match(raw, /Content-Transfer-Encoding: base64/);
    assert.ok(raw.includes(Buffer.from('a,b\n1,2\n').toString('base64')));
});

test('an attachment outside the sandbox is refused', async () => {
    await assert.rejects(
        () => tool.execute({
            action: 'send', to: ['a@b.com'], subject: 'x', attachments: ['/etc/passwd'],
        }, { env: { SMTP_HOST: 'localhost', SMTP_FROM: 'a@b.com' }, sanitizePath: () => null }),
        /Access denied/,
    );
});

/* ── The protocol, against a real socket ──────────────────────────────────── */

// A minimal relay that speaks just enough SMTP to accept one message, and
// records what it was told.
function fakeRelay() {
    const received = { rcpt: [], data: '' };
    const server = net.createServer((socket) => {
        let buf = '';
        let inData = false;
        socket.write('220 fake.relay ESMTP\r\n');
        socket.on('data', (chunk) => {
            buf += chunk.toString('utf8');
            let idx;
            while ((idx = buf.indexOf('\r\n')) !== -1) {
                const line = buf.slice(0, idx);
                buf = buf.slice(idx + 2);
                if (inData) {
                    if (line === '.') { inData = false; socket.write('250 2.0.0 Queued\r\n'); }
                    else received.data += line + '\r\n';
                    continue;
                }
                const cmd = line.toUpperCase();
                if (cmd.startsWith('EHLO')) socket.write('250-fake.relay\r\n250 SIZE 35882577\r\n');
                else if (cmd.startsWith('MAIL FROM')) { received.from = line; socket.write('250 2.1.0 Ok\r\n'); }
                else if (cmd.startsWith('RCPT TO')) { received.rcpt.push(line); socket.write('250 2.1.5 Ok\r\n'); }
                else if (cmd === 'DATA') { inData = true; socket.write('354 End data with <CR><LF>.<CR><LF>\r\n'); }
                else if (cmd === 'QUIT') { socket.write('221 2.0.0 Bye\r\n'); socket.end(); }
                else socket.write('250 2.0.0 Ok\r\n');
            }
        });
        socket.on('error', () => {});
    });
    return { server, received };
}

function listen(server) {
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

test('a real message goes down a real socket and arrives intact', async () => {
    const { server, received } = fakeRelay();
    const port = await listen(server);
    try {
        const res = await tool.execute({
            action: 'send',
            to: ['someone@example.com'],
            cc: ['copy@example.com'],
            bcc: ['hidden@example.com'],
            subject: 'Nightly report',
            body: 'Two things happened.',
        }, {
            env: {
                SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port),
                SMTP_SECURITY: 'none', SMTP_FROM: 'agent@example.com',
            },
        });

        assert.strictEqual(res.ok, true);
        assert.strictEqual(res.accepted, 3, 'to + cc + bcc all ride the envelope');
        assert.strictEqual(res.bcc_count, 1);
        assert.ok(!JSON.stringify(res).includes('hidden@example.com'),
            'a bcc address must not leak back through the tool result either');

        assert.match(received.from, /MAIL FROM:<agent@example\.com>/);
        assert.strictEqual(received.rcpt.length, 3);
        assert.ok(received.rcpt.some((r) => r.includes('hidden@example.com')));

        assert.match(received.data, /^Subject: Nightly report$/m);
        assert.match(received.data, /^To: someone@example\.com$/m);
        assert.match(received.data, /^Cc: copy@example\.com$/m);
        assert.ok(!received.data.includes('hidden@example.com'), 'still blind in the body');
        assert.match(received.data, /Two things happened\./);
    } finally {
        server.close();
    }
});

test('check_config logs in without sending anything', async () => {
    const { server, received } = fakeRelay();
    const port = await listen(server);
    try {
        const res = await tool.execute({ action: 'check_config' }, {
            env: {
                SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port),
                SMTP_SECURITY: 'none', SMTP_FROM: 'agent@example.com',
            },
        });
        assert.strictEqual(res.configured, true);
        assert.strictEqual(res.host, '127.0.0.1');
        assert.strictEqual(received.rcpt.length, 0, 'check_config must never address a recipient');
        assert.strictEqual(received.data, '', 'and never transmit a body');
    } finally {
        server.close();
    }
});

test('a relay that rejects a recipient surfaces the reason', async () => {
    const server = net.createServer((socket) => {
        let buf = '';
        socket.write('220 fake ESMTP\r\n');
        socket.on('data', (chunk) => {
            buf += chunk.toString('utf8');
            let idx;
            while ((idx = buf.indexOf('\r\n')) !== -1) {
                const line = buf.slice(0, idx); buf = buf.slice(idx + 2);
                const cmd = line.toUpperCase();
                if (cmd.startsWith('EHLO')) socket.write('250 fake\r\n');
                else if (cmd.startsWith('RCPT TO')) socket.write('550 5.1.1 No such user\r\n');
                else socket.write('250 Ok\r\n');
            }
        });
        socket.on('error', () => {});
    });
    const port = await listen(server);
    try {
        await assert.rejects(
            () => tool.execute({ action: 'send', to: ['ghost@example.com'], subject: 'x', body: 'y' }, {
                env: {
                    SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port),
                    SMTP_SECURITY: 'none', SMTP_FROM: 'agent@example.com',
                },
            }),
            /550|No such user/,
        );
    } finally {
        server.close();
    }
});
