/* code_linter — lint/format code and surface issues with line numbers.
   JavaScript/TypeScript -> ESLint (+ --fix for format).
   Python -> black (format) and pyflakes/py_compile (lint).
   Language is auto-detected from the file extension when not given. */

'use strict';

const path = require('path');
const lib = require('./_lib');

const name = 'code_linter';

const schema = {
    type: 'function',
    function: {
        name,
        description: 'Check and format source files. Actions: lint, format, check_security '
            + '(basic pattern scan), get_suggestions. Language auto-detected from extension '
            + '(js/ts -> eslint, py -> black/pyflakes). file_path must be inside allowed dirs.',
        parameters: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['lint', 'format', 'check_security', 'get_suggestions'] },
                file_path: { type: 'string', description: 'File to analyse' },
                language: { type: 'string', enum: ['javascript', 'typescript', 'python'], description: 'Override auto-detection' },
            },
            required: ['action', 'file_path'],
        },
    },
};

const ACTIONS = ['lint', 'format', 'check_security', 'get_suggestions'];

function detectLang(file, override) {
    if (override) return override;
    const ext = path.extname(file).toLowerCase();
    if (ext === '.py') return 'python';
    if (ext === '.ts' || ext === '.tsx') return 'typescript';
    if (ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs') return 'javascript';
    return null;
}

// Cheap, language-agnostic red flags. Not a substitute for a real SAST tool —
// just enough to nudge the agent toward obvious problems.
const SECURITY_PATTERNS = [
    { re: /\beval\s*\(/, msg: 'Use of eval()' },
    { re: /child_process|os\.system|subprocess\.(call|Popen|run)/, msg: 'Shell/process execution' },
    { re: /(password|secret|api[_-]?key|token)\s*[:=]\s*['"][^'"]{6,}/i, msg: 'Possible hard-coded credential' },
    { re: /https?:\/\/[^\s'"]*:[^\s'"@]*@/, msg: 'Credentials embedded in URL' },
    { re: /verify\s*=\s*False|rejectUnauthorized\s*:\s*false/i, msg: 'TLS verification disabled' },
];

const fs = require('fs');

async function securityScan(file) {
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split('\n');
    const issues = [];
    lines.forEach((line, i) => {
        for (const p of SECURITY_PATTERNS) {
            if (p.re.test(line)) issues.push({ line: i + 1, issue: p.msg, code: line.trim().slice(0, 160) });
        }
    });
    return { ok: true, action: 'check_security', file, count: issues.length, issues };
}

async function lintJs(file, fix) {
    const npx = lib.IS_WINDOWS ? 'npx.cmd' : 'npx';
    const argv = ['--yes', 'eslint', file, '--format', 'json'];
    if (fix) argv.push('--fix');
    const res = await lib.execFileP(npx, argv, { timeout: 30000 });
    // ESLint exits 1 when it finds problems — that's not a tool failure.
    let parsed;
    try { parsed = JSON.parse(res.stdout || '[]'); } catch {
        throw new lib.ToolError(res.stderr.trim() || 'ESLint produced no JSON (is it configured?)', 'LINT_ERROR');
    }
    const issues = [];
    for (const f of parsed) {
        for (const m of f.messages || []) {
            issues.push({ line: m.line, column: m.column, severity: m.severity === 2 ? 'error' : 'warning', rule: m.ruleId, message: m.message });
        }
    }
    return { ok: true, action: fix ? 'format' : 'lint', file, count: issues.length, issues };
}

async function pythonTool(file, action) {
    if (action === 'format') {
        const res = await lib.execFileP(lib.pythonBin(), ['-m', 'black', file], { timeout: 30000 });
        if (res.code !== 0) {
            if (/No module named/.test(res.stderr)) throw new lib.ToolError('black is not installed. Run: pip install black', 'MODULE_NOT_FOUND', { install: 'pip install black' });
            throw new lib.ToolError(res.stderr.trim() || 'black failed', 'FORMAT_ERROR');
        }
        return { ok: true, action: 'format', file, output: (res.stderr || res.stdout).trim() };
    }
    // lint via pyflakes
    const res = await lib.execFileP(lib.pythonBin(), ['-m', 'pyflakes', file], { timeout: 30000 });
    if (res.code !== 0 && /No module named/.test(res.stderr)) {
        throw new lib.ToolError('pyflakes is not installed. Run: pip install pyflakes', 'MODULE_NOT_FOUND', { install: 'pip install pyflakes' });
    }
    const issues = (res.stdout || '').trim().split('\n').filter(Boolean).map((l) => {
        const m = /^(.*?):(\d+):(?:(\d+):)?\s*(.*)$/.exec(l);
        return m ? { line: +m[2], column: m[3] ? +m[3] : undefined, message: m[4] } : { message: l };
    });
    return { ok: true, action: 'lint', file, count: issues.length, issues };
}

async function execute(args, ctx) {
    const action = lib.requireAction(args.action, ACTIONS);
    const file = lib.resolvePath(ctx, args.file_path, { label: 'file_path', required: true, mustExist: true });
    const lang = detectLang(file, args.language);

    if (action === 'check_security') return securityScan(file);

    if (!lang) throw new lib.ToolError(`Cannot detect language for ${path.basename(file)} — pass "language"`, 'UNKNOWN_LANGUAGE');

    if (lang === 'python') {
        return pythonTool(file, action === 'format' ? 'format' : 'lint');
    }
    // javascript / typescript
    if (action === 'get_suggestions' || action === 'lint') return lintJs(file, false);
    if (action === 'format') return lintJs(file, true);
    throw new lib.ToolError(`Unhandled action ${action}`, 'BAD_ACTION');
}

module.exports = { name, schema, execute };
