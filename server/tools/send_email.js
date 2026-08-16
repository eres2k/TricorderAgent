/* send_email — send mail over SMTP.

   Exists for the scheduled side of this agent. A task that runs at 07:00 and
   works out something useful has nowhere to put the answer: the operator is
   not looking at the chat window. Mail is the delivery channel that reaches a
   phone without this project having to become a push service.

   Zero dependencies, like everything else here, so the SMTP conversation is
   spoken directly over net/tls: EHLO, optional STARTTLS, AUTH LOGIN, MAIL
   FROM, RCPT TO, DATA. Messages are assembled as RFC 5322 with MIME parts for
   HTML and attachments.

   This is the only tool in the project that can reach a stranger. Three things
   follow from that, and none of them are optional:
     - it does nothing at all until SMTP_HOST is configured;
     - SMTP_ALLOWED_RECIPIENTS, when set, is enforced per address, so an
       autonomous task cannot mail somewhere the operator never approved;
     - it is classified as mutating, so plan mode blocks it and the approval
       gate stops it like a file write.
   Credentials are read from the environment and never appear in tool output.
*/

'use strict';

const fs = require('fs');
const net = require('net');
const tls = require('tls');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const lib = require('./_lib');

const name = 'send_email';

const schema = {
    type: 'function',
    function: {
        name,
        description: 'Send an email over the configured SMTP account. Actions: send(to, subject, body — '
            + 'optionally html, cc, bcc, attachments), check_config (verify settings and log in '
            + 'without sending). Useful for delivering the result of a scheduled or long-running '
            + 'task, since the operator is not watching the chat when those run. Requires SMTP_HOST '
            + 'in .env; check_config reports exactly what is missing.',
        parameters: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['send', 'check_config'] },
                to: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Recipient address(es). A single string is accepted too.',
                },
                subject: { type: 'string', description: 'Subject line' },
                body: { type: 'string', description: 'Plain-text body. Always send this; it is the fallback for html.' },
                html: { type: 'string', description: 'Optional HTML body. When present, body is sent alongside it as the plain-text alternative.' },
                cc: { type: 'array', items: { type: 'string' }, description: 'Carbon-copy recipients' },
                bcc: { type: 'array', items: { type: 'string' }, description: 'Blind carbon-copy recipients' },
                attachments: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'File paths to attach. Must be inside the allowed directories; 10 MB total.',
                },
                reply_to: { type: 'string', description: 'Reply-To address, if it differs from the sender' },
            },
            required: ['action'],
        },
    },
};

const REQUIRED_PARAMS = {
    send: ['to', 'subject'],
};

const timeoutMs = 60000;          // a slow relay plus a TLS handshake
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/* ── Configuration ──────────────────────────────────────────────────────── */

function readConfig(env = process.env) {
    const port = parseInt(env.SMTP_PORT, 10) || 587;
    // Implicit TLS is the norm on 465 and STARTTLS everywhere else, which is
    // right often enough to be the default and overridable when it is not.
    const mode = (env.SMTP_SECURITY || (port === 465 ? 'tls' : 'starttls')).toLowerCase();
    return {
        host: (env.SMTP_HOST || '').trim(),
        port,
        security: mode,
        user: env.SMTP_USER || '',
        pass: env.SMTP_PASS || '',
        from: (env.SMTP_FROM || env.SMTP_USER || '').trim(),
        fromName: env.SMTP_FROM_NAME || 'Tricorder Agent',
        allowed: (env.SMTP_ALLOWED_RECIPIENTS || '')
            .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
        rejectUnauthorized: env.SMTP_INSECURE_TLS !== 'true',
    };
}

function describeConfig(cfg) {
    const missing = [];
    if (!cfg.host) missing.push('SMTP_HOST');
    if (!cfg.from) missing.push('SMTP_FROM (or SMTP_USER)');
    if (cfg.user && !cfg.pass) missing.push('SMTP_PASS');
    return missing;
}

/* ── Addresses ──────────────────────────────────────────────────────────── */

const ADDRESS_RE = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;

function toList(value) {
    if (value == null || value === '') return [];
    const raw = Array.isArray(value) ? value : String(value).split(/[,;]/);
    return raw.map((s) => String(s).trim()).filter(Boolean);
}

function validateAddresses(list, label) {
    for (const addr of list) {
        if (!ADDRESS_RE.test(addr)) {
            throw new lib.ToolError(`"${addr}" is not a valid email address (${label})`, 'BAD_PARAM', { address: addr });
        }
    }
    return list;
}

// An allowlist entry is either a whole address or a bare domain ("@work.com"),
// so the common case — "this agent may only ever mail me" — is one entry.
function enforceAllowlist(cfg, addresses) {
    if (!cfg.allowed.length) return;
    for (const addr of addresses) {
        const lower = addr.toLowerCase();
        const domain = '@' + lower.split('@')[1];
        if (!cfg.allowed.includes(lower) && !cfg.allowed.includes(domain)) {
            throw new lib.ToolError(
                `Refusing to mail ${addr}: it is not in SMTP_ALLOWED_RECIPIENTS.`,
                'RECIPIENT_NOT_ALLOWED',
                { address: addr, allowed: cfg.allowed },
            );
        }
    }
}

/* ── Message assembly ───────────────────────────────────────────────────── */

// RFC 2047, so a subject with an umlaut or an em dash survives the wire.
function encodeHeader(value) {
    const s = String(value ?? '');
    if (/^[\x20-\x7E]*$/.test(s)) return s;
    return `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

function formatFrom(cfg) {
    return cfg.fromName ? `${encodeHeader(cfg.fromName)} <${cfg.from}>` : cfg.from;
}

function base64Lines(buf) {
    return (buf.toString('base64').match(/.{1,76}/g) || []).join('\r\n');
}

// A leading dot on its own line ends DATA, so any body line starting with one
// gets an extra. Without this, a message containing "...." truncates silently.
function dotStuff(text) {
    return text.replace(/\r\n\./g, '\r\n..');
}

function normalizeEol(text) {
    return String(text ?? '').replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
}

function loadAttachments(ctx, paths) {
    const files = [];
    let total = 0;
    for (const raw of paths) {
        const abs = lib.resolvePath(ctx, raw, { required: true, mustExist: true, label: 'attachment' });
        const stat = fs.statSync(abs);
        if (stat.isDirectory()) {
            throw new lib.ToolError(`Attachment is a directory: ${raw}. Zip it first with archive_tool.`, 'BAD_PARAM', { path: raw });
        }
        total += stat.size;
        if (total > MAX_ATTACHMENT_BYTES) {
            throw new lib.ToolError(
                `Attachments exceed ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB.`,
                'ATTACHMENT_TOO_LARGE', { bytes: total },
            );
        }
        files.push({ filename: path.basename(abs), content: fs.readFileSync(abs) });
    }
    return files;
}

const MIME_TYPES = {
    '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json',
    '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.zip': 'application/zip',
    '.html': 'text/html', '.log': 'text/plain', '.xml': 'application/xml',
};

function mimeFor(filename) {
    return MIME_TYPES[path.extname(filename).toLowerCase()] || 'application/octet-stream';
}

function buildMessage(cfg, msg) {
    const boundaryMixed = `=_mix_${crypto.randomBytes(12).toString('hex')}`;
    const boundaryAlt = `=_alt_${crypto.randomBytes(12).toString('hex')}`;
    const hasAttachments = msg.attachments.length > 0;
    const hasHtml = Boolean(msg.html);

    const headers = [
        `From: ${formatFrom(cfg)}`,
        `To: ${msg.to.join(', ')}`,
    ];
    if (msg.cc.length) headers.push(`Cc: ${msg.cc.join(', ')}`);
    if (msg.replyTo) headers.push(`Reply-To: ${msg.replyTo}`);
    headers.push(`Subject: ${encodeHeader(msg.subject)}`);
    headers.push(`Date: ${new Date().toUTCString()}`);
    headers.push(`Message-ID: <${crypto.randomBytes(16).toString('hex')}@${cfg.from.split('@')[1] || os.hostname()}>`);
    headers.push('MIME-Version: 1.0');

    const textPart = normalizeEol(msg.body || '');
    const parts = [];

    const pushBody = () => {
        if (!hasHtml) {
            parts.push('Content-Type: text/plain; charset=UTF-8');
            parts.push('Content-Transfer-Encoding: 8bit', '', textPart);
            return;
        }
        parts.push(`Content-Type: multipart/alternative; boundary="${boundaryAlt}"`, '');
        parts.push(`--${boundaryAlt}`);
        parts.push('Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: 8bit', '', textPart);
        parts.push(`--${boundaryAlt}`);
        parts.push('Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: 8bit', '', normalizeEol(msg.html));
        parts.push(`--${boundaryAlt}--`);
    };

    if (!hasAttachments) {
        pushBody();
        return dotStuff([...headers, ...parts].join('\r\n'));
    }

    headers.push(`Content-Type: multipart/mixed; boundary="${boundaryMixed}"`);
    parts.push('', `--${boundaryMixed}`);
    pushBody();
    for (const file of msg.attachments) {
        parts.push(`--${boundaryMixed}`);
        parts.push(`Content-Type: ${mimeFor(file.filename)}; name="${file.filename}"`);
        parts.push('Content-Transfer-Encoding: base64');
        parts.push(`Content-Disposition: attachment; filename="${file.filename}"`, '');
        parts.push(base64Lines(file.content));
    }
    parts.push(`--${boundaryMixed}--`);
    return dotStuff([...headers, ...parts].join('\r\n'));
}

/* ── The SMTP conversation ──────────────────────────────────────────────── */

// A tiny line-oriented client. Replies can be multi-line ("250-SIZE" then
// "250 OK"); only the final line — the one with a space after the code —
// completes a response.
function createSession(socket) {
    let buffer = '';
    let pending = null;

    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
        buffer += chunk;
        let idx;
        while ((idx = buffer.indexOf('\r\n')) !== -1) {
            const line = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            if (!pending) continue;
            pending.lines.push(line);
            if (/^\d{3} /.test(line)) {
                const done = pending;
                pending = null;
                done.resolve({ code: parseInt(line.slice(0, 3), 10), lines: done.lines });
            }
        }
    });

    return {
        read() {
            return new Promise((resolve, reject) => {
                pending = { lines: [], resolve, reject };
                socket.once('error', reject);
            });
        },
        send(line) {
            socket.write(line + '\r\n');
        },
        detach() {
            socket.removeAllListeners('data');
        },
    };
}

function connect({ host, port, secure, rejectUnauthorized, timeout }) {
    return new Promise((resolve, reject) => {
        const socket = secure
            ? tls.connect({ host, port, rejectUnauthorized, servername: host })
            : net.connect({ host, port });
        const onReady = () => { cleanup(); resolve(socket); };
        const onError = (err) => { cleanup(); reject(new lib.ToolError(`SMTP connection to ${host}:${port} failed: ${err.message}`, 'SMTP_CONNECT_FAILED')); };
        const onTimeout = () => { socket.destroy(); onError(new Error(`timed out after ${timeout} ms`)); };
        function cleanup() {
            socket.removeListener(secure ? 'secureConnect' : 'connect', onReady);
            socket.removeListener('error', onError);
            socket.setTimeout(0);
        }
        socket.once(secure ? 'secureConnect' : 'connect', onReady);
        socket.once('error', onError);
        socket.setTimeout(timeout, onTimeout);
    });
}

async function expect(session, codes, step) {
    const reply = await session.read();
    if (!codes.includes(reply.code)) {
        throw new lib.ToolError(
            `SMTP ${step} failed: ${reply.code} ${reply.lines.join(' ').slice(0, 300)}`,
            'SMTP_ERROR', { step, code: reply.code },
        );
    }
    return reply;
}

// Runs the whole conversation. `dryRun` stops after authentication, which is
// what check_config needs: proof the credentials work without mailing anyone.
async function speakSmtp(cfg, message, { dryRun = false } = {}) {
    const useTls = cfg.security === 'tls';
    let socket = await connect({
        host: cfg.host, port: cfg.port, secure: useTls,
        rejectUnauthorized: cfg.rejectUnauthorized, timeout: 20000,
    });
    let session = createSession(socket);
    const capabilities = [];

    try {
        await expect(session, [220], 'greeting');

        const ehlo = async () => {
            session.send(`EHLO ${os.hostname() || 'localhost'}`);
            const reply = await expect(session, [250], 'EHLO');
            capabilities.length = 0;
            for (const line of reply.lines) capabilities.push(line.slice(4).toUpperCase());
        };
        await ehlo();

        if (cfg.security === 'starttls') {
            if (!capabilities.some((l) => l.startsWith('STARTTLS'))) {
                throw new lib.ToolError(
                    `${cfg.host} does not offer STARTTLS. Set SMTP_SECURITY=tls (port 465) or none.`,
                    'SMTP_NO_STARTTLS',
                );
            }
            session.send('STARTTLS');
            await expect(session, [220], 'STARTTLS');
            session.detach();
            socket = await new Promise((resolve, reject) => {
                const upgraded = tls.connect({
                    socket, servername: cfg.host, rejectUnauthorized: cfg.rejectUnauthorized,
                }, () => resolve(upgraded));
                upgraded.once('error', reject);
            });
            session = createSession(socket);
            await ehlo();   // capabilities are re-advertised after the upgrade
        }

        if (cfg.user) {
            session.send('AUTH LOGIN');
            await expect(session, [334], 'AUTH');
            session.send(Buffer.from(cfg.user, 'utf8').toString('base64'));
            await expect(session, [334], 'AUTH username');
            session.send(Buffer.from(cfg.pass, 'utf8').toString('base64'));
            await expect(session, [235], 'AUTH password');
        }

        if (dryRun) {
            session.send('QUIT');
            return { authenticated: Boolean(cfg.user), capabilities };
        }

        session.send(`MAIL FROM:<${cfg.from}>`);
        await expect(session, [250], 'MAIL FROM');

        const envelope = [...message.to, ...message.cc, ...message.bcc];
        const accepted = [];
        for (const rcpt of envelope) {
            session.send(`RCPT TO:<${rcpt}>`);
            await expect(session, [250, 251], `RCPT TO ${rcpt}`);
            accepted.push(rcpt);
        }

        session.send('DATA');
        await expect(session, [354], 'DATA');
        socket.write(message.raw + '\r\n.\r\n');
        const done = await expect(session, [250], 'message body');

        session.send('QUIT');
        return { accepted, response: done.lines.join(' ').slice(0, 200) };
    } finally {
        socket.destroy();
    }
}

/* ── Entry point ────────────────────────────────────────────────────────── */

async function execute(args = {}, ctx = {}) {
    const action = lib.requireAction(args.action, ['send', 'check_config']);
    lib.requireParams(action, args, REQUIRED_PARAMS);

    const cfg = readConfig(ctx.env || process.env);
    const missing = describeConfig(cfg);

    if (action === 'check_config') {
        if (missing.length) {
            return {
                ok: false, configured: false, missing,
                hint: 'Set these in .env, then restart. For Gmail use an App Password, not the account password.',
            };
        }
        const probe = await speakSmtp(cfg, null, { dryRun: true });
        return {
            ok: true, configured: true,
            host: cfg.host, port: cfg.port, security: cfg.security,
            from: cfg.from, authenticated: probe.authenticated,
            allowed_recipients: cfg.allowed.length ? cfg.allowed : 'any (SMTP_ALLOWED_RECIPIENTS is unset)',
        };
    }

    if (missing.length) {
        throw new lib.ToolError(
            `Email is not configured — missing ${missing.join(', ')}. Set them in .env and restart.`,
            'NOT_CONFIGURED', { missing },
        );
    }

    const to = validateAddresses(toList(args.to), 'to');
    const cc = validateAddresses(toList(args.cc), 'cc');
    const bcc = validateAddresses(toList(args.bcc), 'bcc');
    if (!to.length) throw new lib.ToolError('At least one recipient is required', 'MISSING_PARAM');
    enforceAllowlist(cfg, [...to, ...cc, ...bcc]);
    if (args.reply_to) validateAddresses([String(args.reply_to).trim()], 'reply_to');

    const attachments = loadAttachments(ctx, toList(args.attachments));

    const message = {
        to, cc, bcc,
        subject: String(args.subject ?? ''),
        body: args.body ?? '',
        html: args.html ?? '',
        replyTo: args.reply_to ? String(args.reply_to).trim() : '',
        attachments,
    };
    message.raw = buildMessage(cfg, message);

    const result = await speakSmtp(cfg, message);

    return {
        ok: true,
        action: 'send',
        to, cc,
        bcc_count: bcc.length,          // the addresses stay out of the transcript
        subject: message.subject,
        attachments: attachments.map((a) => a.filename),
        bytes: Buffer.byteLength(message.raw, 'utf8'),
        accepted: result.accepted.length,
        server_response: result.response,
    };
}

module.exports = {
    name, schema, execute, timeoutMs,
    // Test hooks — the message builder and the address rules are the parts
    // worth checking without a live relay.
    _internals: {
        readConfig, describeConfig, buildMessage, encodeHeader, dotStuff,
        toList, validateAddresses, enforceAllowlist, mimeFor, loadAttachments,
    },
};
