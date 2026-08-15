/* ============================================
   Tricorder Agent — Extended Tools Shared Library
   Zero npm dependencies (pure Node.js + optional Python at runtime).

   Provides the cross-cutting concerns every extended tool needs:
     - Structured errors          { error, code, details? }
     - Action logging             ~/.tricorder-agent/tool-logs/<tool>.log
     - Path sandboxing            ALLOWED_ROOTS (workspace + tmp by default;
                                  server.js passes a stricter check via ctx)
     - 30s timeout enforcement    withTimeout()
     - Child-process helpers      execFileP() / runPython()

   The helpers are self-sufficient so the modules are unit-testable
   WITHOUT booting server.js. When server.js dispatches a tool it passes a
   `ctx` carrying its own sanitizePath/WORKSPACE_DIR/log so behaviour stays
   identical to the rest of the codebase; when ctx is absent (tests) the
   library falls back to its own equivalents.
   ============================================ */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const IS_WINDOWS = os.platform() === 'win32';
const HOME_DIR = os.homedir();
const WORKSPACE_DIR = process.env.TRICORDER_WORKSPACE || path.join(HOME_DIR, 'tricorder-agent-workspace');
const CONFIG_DIR = path.join(HOME_DIR, '.tricorder-agent');
const LOG_DIR = path.join(CONFIG_DIR, 'tool-logs');

// Default sandbox roots — mirror server.js ALLOWED_ROOTS so a path accepted
// here is accepted there too. In practice server.js always passes its own
// ctx.isPathAllowed (which also applies the credential deny-list), and that
// takes over; this fallback only applies when a module is exercised directly,
// e.g. from a unit test. Keep it at least as strict as the server's default.
const ALLOWED_ROOTS = [WORKSPACE_DIR, os.tmpdir(), '/tmp', '/var/tmp'];

const DEFAULT_TIMEOUT_MS = 30000;
// Hard ceiling for any per-tool timeout override (module.exports.timeoutMs).
// Long-running work (ffmpeg re-encodes, OCR, whisper) may raise its budget up
// to this cap; nothing can hang the agent loop for longer.
const MAX_TIMEOUT_MS = 600000;

// --- Structured errors ------------------------------------------------------

// Carries a machine-readable `code` and optional `details` alongside the
// message so the dispatcher can surface { error, code, details } to the model.
class ToolError extends Error {
    constructor(message, code = 'TOOL_ERROR', details) {
        super(message);
        this.name = 'ToolError';
        this.code = code;
        if (details !== undefined) this.details = details;
    }
}

// Normalise any thrown value into the { error, code, details? } contract.
function toErrorPayload(err) {
    if (err instanceof ToolError) {
        const out = { error: err.message, code: err.code };
        if (err.details !== undefined) out.details = err.details;
        return out;
    }
    return { error: err && err.message ? err.message : String(err), code: 'TOOL_ERROR' };
}

// --- Logging ----------------------------------------------------------------

function ensureDir(dir) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* best effort */ }
}

// Append one JSON line per action to a per-tool log and a combined log.
// Never throws — logging must not break a tool call.
function logAction(tool, entry) {
    try {
        ensureDir(LOG_DIR);
        const line = JSON.stringify({ ts: new Date().toISOString(), tool, ...entry }) + '\n';
        fs.appendFileSync(path.join(LOG_DIR, `${tool}.log`), line);
        fs.appendFileSync(path.join(LOG_DIR, '_all.log'), line);
    } catch { /* best effort */ }
}

// --- Path sandboxing --------------------------------------------------------

function expandHome(p) {
    if (!p) return p;
    if (p === '~') return HOME_DIR;
    if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(HOME_DIR, p.slice(2));
    return p;
}

function isAllowed(ctx, normalized) {
    if (ctx && typeof ctx.isPathAllowed === 'function') return ctx.isPathAllowed(normalized);
    // Fallback (tests only — server.js always supplies ctx.isPathAllowed).
    // Case-folded on Windows, where path comparison is case-insensitive.
    const norm = IS_WINDOWS ? normalized.toLowerCase() : normalized;
    return ALLOWED_ROOTS.some((root) => {
        const r = IS_WINDOWS ? path.resolve(root).toLowerCase() : path.resolve(root);
        return norm === r || norm.startsWith(r + path.sep);
    });
}

// Resolve a user-supplied path inside the sandbox or throw PATH_DENIED.
// opts.mustExist throws NOT_FOUND when the target is missing.
function resolvePath(ctx, raw, opts = {}) {
    if (raw == null || raw === '') {
        if (opts.required) throw new ToolError(`${opts.label || 'path'} is required`, 'MISSING_PARAM');
        return null;
    }
    // Prefer the server's own sanitizer when present so rules stay in lockstep.
    let normalized;
    if (ctx && typeof ctx.sanitizePath === 'function') {
        normalized = ctx.sanitizePath(raw);
        if (!normalized) throw new ToolError(`Access denied: ${raw} is outside the allowed directories`, 'PATH_DENIED', { path: raw });
    } else {
        normalized = path.resolve(expandHome(raw));
        if (!isAllowed(ctx, normalized)) throw new ToolError(`Access denied: ${raw} is outside the allowed directories`, 'PATH_DENIED', { path: raw });
    }
    if (opts.mustExist && !fs.existsSync(normalized)) {
        throw new ToolError(`Not found: ${normalized}`, 'NOT_FOUND', { path: normalized });
    }
    return normalized;
}

// --- Timeout ----------------------------------------------------------------

// Reject if `promise` hasn't settled within ms. Used both per-helper and as
// the outer 30s guard in index.js so no tool can hang the agent loop.
function withTimeout(promise, ms = DEFAULT_TIMEOUT_MS, label = 'operation') {
    let timer;
    const guard = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new ToolError(`Timed out after ${ms}ms: ${label}`, 'TIMEOUT', { ms })), ms);
    });
    return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

// --- Child processes --------------------------------------------------------

function pythonBin(ctx) {
    if (ctx && ctx.pythonBin) return ctx.pythonBin;
    return process.env.TRICORDER_PYTHON || (IS_WINDOWS ? 'py' : 'python3');
}

// Promise wrapper over spawn(): resolves { stdout, stderr, code, truncated }
// for any exit code, rejects only when the binary is missing (BINARY_NOT_FOUND)
// or the call exceeds its timeout (TIMEOUT). Output is capped to keep tool
// results inside the model's context budget; `truncated` flags when the cap
// was hit so callers can surface OUTPUT_TRUNCATED instead of a cryptic parse
// failure. Timeouts honour the caller's wish up to MAX_TIMEOUT_MS.
function execFileP(file, args = [], opts = {}) {
    const timeout = Math.min(opts.timeout || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const maxBuffer = opts.maxBuffer || 8 * 1024 * 1024;
    return new Promise((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        let truncated = false;
        let killed = false;
        let child;
        try {
            child = spawn(file, args, { cwd: opts.cwd, env: opts.env || process.env, windowsHide: true });
        } catch (e) {
            reject(new ToolError(`Failed to launch ${file}: ${e.message}`, 'BINARY_NOT_FOUND', { file }));
            return;
        }
        const timer = setTimeout(() => {
            killed = true;
            try { child.kill('SIGKILL'); } catch { /* already gone */ }
        }, timeout);
        child.on('error', (e) => {
            clearTimeout(timer);
            const code = e.code === 'ENOENT' ? 'BINARY_NOT_FOUND' : 'SPAWN_ERROR';
            reject(new ToolError(`Failed to launch ${file}: ${e.message}`, code, { file }));
        });
        child.stdout.on('data', (d) => {
            if (stdout.length < maxBuffer) {
                stdout += d.toString();
                if (stdout.length > maxBuffer) { stdout = stdout.slice(0, maxBuffer); truncated = true; }
            } else {
                truncated = true;
            }
        });
        child.stderr.on('data', (d) => { if (stderr.length < maxBuffer) stderr += d.toString(); });
        if (opts.input != null) { try { child.stdin.write(opts.input); } catch { /* ignore */ } }
        try { child.stdin.end(); } catch { /* ignore */ }
        child.on('close', (code) => {
            clearTimeout(timer);
            if (killed) { reject(new ToolError(`Timed out after ${timeout}ms`, 'TIMEOUT', { file, timeout })); return; }
            resolve({ stdout, stderr, code: code == null ? -1 : code, truncated });
        });
    });
}

// --- Persistent Python worker -----------------------------------------------
// Spawning `python3 -c` per call pays interpreter startup + library import on
// every invocation (weasyprint 1-3s, Pillow 200-400ms). The worker below is a
// long-lived Python process that reads JSON lines from stdin ({id, code,
// params, max_out}), exec()s the snippet in a fresh namespace with sys.stdin
// replaced by the params JSON and sys.stdout captured — so imports stay cached
// process-wide while every existing tool snippet runs UNCHANGED. The result
// comes back as a JSON line {id, ok, out, err | error}. If the worker dies or
// misbehaves the call transparently falls back to the classic one-shot spawn
// and the worker restarts on the next call.

const WORKER_PY = `
import sys, json, io, traceback
_stdin = sys.stdin
_stdout = sys.stdout
for _line in _stdin:
    _line = _line.strip()
    if not _line:
        continue
    try:
        _req = json.loads(_line)
    except Exception:
        continue
    _out = io.StringIO()
    _err = io.StringIO()
    _resp = {"id": _req.get("id")}
    _max = int(_req.get("max_out") or 8388608)
    try:
        # Emulate the one-shot contract exactly: params arrive on stdin,
        # results are print()ed to stdout.
        sys.stdin = io.StringIO(_req.get("params") or "")
        sys.stdout = _out
        sys.stderr = _err
        _ns = {"__name__": "__main__"}
        exec(_req.get("code") or "", _ns)
        _resp["ok"] = True
    except SystemExit:
        _resp["ok"] = True
    except BaseException:
        _resp["ok"] = False
        _resp["error"] = traceback.format_exc()
    finally:
        sys.stdin = _stdin
        sys.stdout = _stdout
        sys.stderr = sys.__stderr__
    _o = _out.getvalue()
    if len(_o) > _max:
        _o = _o[:_max]
        _resp["truncated"] = True
    _resp["out"] = _o
    _resp["err"] = _err.getvalue()[-4000:]
    _stdout.write(json.dumps(_resp) + "\\n")
    _stdout.flush()
`;

// Singleton worker state: { bin, child, pending: Map<id, {resolve, timer}>, buf, nextId }
let pyWorker = null;

function killPyWorker() {
    const w = pyWorker;
    pyWorker = null;
    if (!w) return;
    for (const [, p] of w.pending) {
        clearTimeout(p.timer);
        p.reject(new Error('python worker terminated'));
    }
    w.pending.clear();
    try { w.child.kill('SIGKILL'); } catch { /* already gone */ }
}

function startPyWorker(bin) {
    let child;
    try {
        child = spawn(bin, ['-c', WORKER_PY], { env: process.env, windowsHide: true });
    } catch {
        return null;
    }
    const w = { bin, child, pending: new Map(), buf: '', nextId: 1 };
    child.on('error', () => { if (pyWorker === w) killPyWorker(); });
    child.on('close', () => { if (pyWorker === w) killPyWorker(); });
    child.stdout.on('data', (d) => {
        w.buf += d.toString();
        let nl;
        while ((nl = w.buf.indexOf('\n')) >= 0) {
            const line = w.buf.slice(0, nl);
            w.buf = w.buf.slice(nl + 1);
            let resp;
            try { resp = JSON.parse(line); } catch { continue; }
            const p = w.pending.get(resp.id);
            if (p) { w.pending.delete(resp.id); clearTimeout(p.timer); p.resolve(resp); }
        }
        // A runaway response without newline must not balloon memory.
        if (w.buf.length > 64 * 1024 * 1024) killPyWorker();
    });
    child.stderr.on('data', () => { /* worker-level stderr is per-call captured */ });
    child.stdin.on('error', () => { /* EPIPE when the worker died mid-write */ });
    // Never keep the Node process alive just for the idle worker.
    try { child.unref(); } catch { /* ignore */ }
    for (const s of [child.stdin, child.stdout, child.stderr]) {
        try { s.unref(); } catch { /* ignore */ }
    }
    return w;
}

// Send one request to the worker; rejects with a plain Error on infrastructure
// failure (caller falls back to one-shot) and resolves { timedOut: true } when
// the snippet exceeded its budget (caller kills the worker + throws TIMEOUT).
function pyWorkerCall(code, params, timeout, maxBuffer) {
    const w = pyWorker;
    if (!w) return Promise.reject(new Error('no worker'));
    return new Promise((resolve, reject) => {
        const id = w.nextId++;
        const timer = setTimeout(() => {
            w.pending.delete(id);
            resolve({ timedOut: true });
        }, timeout);
        w.pending.set(id, { resolve, reject, timer });
        try {
            w.child.stdin.write(JSON.stringify({ id, code, params, max_out: maxBuffer }) + '\n');
        } catch (e) {
            w.pending.delete(id);
            clearTimeout(timer);
            reject(e);
        }
    });
}

function pyWorkerEnabled() {
    return process.env.TRICORDER_PY_WORKER !== '0';
}

// Run an inline Python program. The script receives its parameters as a JSON
// object on stdin and is expected to print a single JSON object to stdout. A
// ModuleNotFoundError is translated into a MODULE_NOT_FOUND error carrying a
// pip install hint, so the model can self-heal instead of seeing a traceback.
// Uses the persistent worker when possible (cached imports); falls back to a
// one-shot spawn when the worker is unavailable, dead, or a custom env/python
// is requested.
async function runPython(code, opts = {}) {
    const py = pythonBin(opts.ctx);
    const input = opts.input != null ? JSON.stringify(opts.input) : '';
    const timeout = Math.min(opts.timeout || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const maxBuffer = opts.maxBuffer || 8 * 1024 * 1024;

    // --- fast path: persistent worker ---
    if (pyWorkerEnabled() && !opts.env) {
        if (!pyWorker || pyWorker.bin !== py || !pyWorker.child || pyWorker.child.exitCode !== null) {
            killPyWorker();
            pyWorker = startPyWorker(py);
        }
        if (pyWorker) {
            let resp = null;
            try {
                resp = await pyWorkerCall(code, input, timeout, maxBuffer);
            } catch {
                // Worker infrastructure failure — restart lazily, use one-shot now.
                killPyWorker();
            }
            if (resp) {
                if (resp.timedOut) {
                    // The snippet itself is too slow; a one-shot retry would just
                    // time out again under the same outer guard. Kill + report.
                    killPyWorker();
                    throw new ToolError(`Timed out after ${timeout}ms`, 'TIMEOUT', { timeout });
                }
                if (resp.truncated) {
                    throw new ToolError(`Python output exceeded the ${maxBuffer}-byte cap and was truncated. Write large results to a file instead.`, 'OUTPUT_TRUNCATED', { maxBuffer });
                }
                if (!resp.ok) throw pyErrorFrom(String(resp.error || ''), opts.requires, 1);
                return parseJsonOut(resp.out);
            }
        }
    }

    // --- fallback: classic one-shot spawn ---
    let res;
    try {
        res = await execFileP(py, ['-c', code], { timeout, input, env: opts.env, maxBuffer });
    } catch (e) {
        if (e.code === 'BINARY_NOT_FOUND') {
            throw new ToolError(`Python interpreter "${py}" not found. Set TRICORDER_PYTHON to its full path.`, 'PYTHON_NOT_FOUND', { python: py });
        }
        throw e;
    }
    if (res.code !== 0) throw pyErrorFrom(res.stderr || res.stdout || '', opts.requires, res.code);
    if (res.truncated) {
        throw new ToolError(`Python output exceeded the ${maxBuffer}-byte cap and was truncated. Write large results to a file instead.`, 'OUTPUT_TRUNCATED', { maxBuffer });
    }
    return parseJsonOut(res.stdout);
}

// Map Python failure text (stderr or a worker traceback) to a structured error.
function pyErrorFrom(text, requires, exitCode) {
    const m = /ModuleNotFoundError: No module named '([^']+)'/.exec(text);
    if (m) {
        const mod = m[1];
        const pkg = (requires && requires[mod]) || mod;
        return new ToolError(`Python module "${mod}" is not installed. Run: pip install ${pkg}`, 'MODULE_NOT_FOUND', { module: mod, install: `pip install ${pkg}` });
    }
    return new ToolError(`Python exited ${exitCode}: ${text.trim().slice(-1500)}`, 'PYTHON_ERROR', { code: exitCode });
}

// Tolerate leading prints/warnings: take the last JSON object/array in stdout.
function parseJsonOut(stdout) {
    const text = (stdout || '').trim();
    if (!text) throw new ToolError('No output from subprocess', 'EMPTY_OUTPUT');
    try { return JSON.parse(text); } catch { /* fall through to scan */ }
    const start = Math.max(text.lastIndexOf('\n{'), text.lastIndexOf('\n['));
    if (start >= 0) {
        try { return JSON.parse(text.slice(start + 1)); } catch { /* ignore */ }
    }
    const brace = text.indexOf('{');
    if (brace >= 0) {
        try { return JSON.parse(text.slice(brace)); } catch { /* ignore */ }
    }
    throw new ToolError('Subprocess did not emit valid JSON', 'BAD_OUTPUT', { raw: text.slice(0, 500) });
}

// Validate that `value` is one of the allowed actions; throws a helpful error.
function requireAction(value, allowed) {
    if (!value) throw new ToolError(`action is required (one of: ${allowed.join(', ')})`, 'MISSING_PARAM');
    if (!allowed.includes(value)) {
        throw new ToolError(`Unknown action "${value}". Allowed: ${allowed.join(', ')}`, 'BAD_ACTION', { action: value, allowed });
    }
    return value;
}

// Per-action required-parameter validation. `table` maps an action name to the
// parameters it cannot run without; a parameter counts as missing when it is
// null/undefined or an empty string (0/false are valid values). Throws a
// structured MISSING_PARAM instead of letting a Python KeyError traceback leak.
function requireParams(action, args, table) {
    const needed = table[action];
    if (!needed || needed.length === 0) return;
    const missing = needed.filter((k) => args[k] == null || args[k] === '');
    if (missing.length) {
        throw new ToolError(`${action} requires: ${missing.join(', ')}`, 'MISSING_PARAM', { action, missing });
    }
}

// Derive an output path next to the input: <dir>/<base>_<suffix><ext>.
function deriveOut(input, suffix, ext) {
    return path.join(path.dirname(input), `${path.basename(input, path.extname(input))}_${suffix}${ext}`);
}

// Small JSON-file stores (rss subscriptions, secrets). Load never throws —
// a missing/corrupt file yields a fresh copy of `fallback`.
function loadJsonStore(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return JSON.parse(JSON.stringify(fallback || {})); }
}
function saveJsonStore(file, data, opts = {}) {
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify(data, null, 2), opts.mode ? { mode: opts.mode } : undefined);
    if (opts.mode) { try { fs.chmodSync(file, opts.mode); } catch { /* best effort on Windows */ } }
}

function timestamp() {
    return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

module.exports = {
    IS_WINDOWS, HOME_DIR, WORKSPACE_DIR, CONFIG_DIR, LOG_DIR, ALLOWED_ROOTS,
    DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS,
    ToolError, toErrorPayload,
    ensureDir, logAction,
    expandHome, resolvePath, isAllowed,
    withTimeout,
    pythonBin, execFileP, runPython, parseJsonOut,
    requireAction, requireParams, timestamp,
    deriveOut, loadJsonStore, saveJsonStore,
    // test/maintenance hooks for the persistent Python worker
    _killPyWorker: killPyWorker,
    _pyWorkerAlive: () => !!(pyWorker && pyWorker.child && pyWorker.child.exitCode === null),
};
