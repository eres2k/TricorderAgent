#!/usr/bin/env node
/**
 * Dependency-free reference check for the browser bundle in js/.
 *
 * Catches ONE bug class, the one that keeps happening: a function is renamed
 * or removed and a call site is left pointing at the old name. That is a
 * runtime ReferenceError which aborts whatever handler it sits in — silent
 * until the feature is exercised. `node --check` and `new Function(src)`
 * both validate PARSING, not identifier resolution, so a rename walks
 * straight through them.
 *
 * Deliberately not a linter. It is not scope-aware: a name declared anywhere
 * in the file counts as declared everywhere in it. That trades false
 * negatives (calling an inner helper from an outer scope stays undetected)
 * for zero false positives, which is the only way a check like this survives
 * — one bogus failure and it gets bypassed forever.
 *
 * Usage: node scripts/check-refs.js       (exit 1 on unresolved references)
 */
'use strict';

const fs = require('fs');
const path = require('path');

const JS_DIR = path.join(__dirname, '..', 'js');

// ── Stripping ────────────────────────────────────────────────────────────
// Comments, strings, template literals and regex literals all contain text
// that looks like code ("refresh(", "x00CODE(") and would otherwise be read
// as calls. Walk the source once, tracking state, and blank them out.
function stripNonCode(src) {
    const out = [];
    let i = 0;
    let prevSignificant = '';
    const REGEX_PRECEDERS = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);
    const KEYWORD_PRECEDERS = /(?:^|[^\w$])(return|typeof|instanceof|in|of|new|delete|void|case|do|else|yield|await)$/;

    while (i < src.length) {
        const c = src[i];
        const next = src[i + 1];

        if (c === '/' && next === '/') {
            while (i < src.length && src[i] !== '\n') { out.push(' '); i++; }
            continue;
        }
        if (c === '/' && next === '*') {
            out.push('  '); i += 2;
            while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
                out.push(src[i] === '\n' ? '\n' : ' '); i++;
            }
            out.push('  '); i += 2;
            continue;
        }
        if (c === '"' || c === "'") {
            const quote = c;
            out.push(' '); i++;
            while (i < src.length) {
                if (src[i] === '\\') { out.push('  '); i += 2; continue; }
                if (src[i] === quote) { out.push(' '); i++; break; }
                out.push(src[i] === '\n' ? '\n' : ' '); i++;
            }
            prevSignificant = 'x'; // a literal is a value, so a following / is division
            continue;
        }
        if (c === '`') {
            // Template literals nest: `a ${ `b ${c}` } d`. Blanking to the
            // first closing backtick would end the OUTER literal early and
            // leave the rest of the file being read as string content — which
            // silently swallows every declaration after it. Track the depth of
            // ${…} interpolations (and of braces inside them) so the literal
            // ends at the backtick that actually closes it.
            //
            // The interpolated expressions are real code, but reading them as
            // code would mean re-entering the tokenizer recursively. Blanking
            // them only costs false negatives, which this check accepts; ending
            // the literal in the right place is what it cannot get wrong.
            out.push(' '); i++;
            let depth = 0;          // nesting of ${ … } we are inside
            let braces = 0;         // { } nesting within the current ${ … }
            while (i < src.length) {
                const ch = src[i];
                if (ch === '\\') { out.push('  '); i += 2; continue; }
                if (ch === '$' && src[i + 1] === '{') {
                    depth++; braces = 0;
                    out.push('  '); i += 2; continue;
                }
                if (depth > 0 && ch === '{') braces++;
                if (depth > 0 && ch === '}') {
                    if (braces === 0) depth--;
                    else braces--;
                }
                if (ch === '`' && depth === 0) { out.push(' '); i++; break; }
                out.push(ch === '\n' ? '\n' : ' '); i++;
            }
            prevSignificant = 'x';
            continue;
        }
        if (c === '/') {
            // Regex literal or division? Decide from what precedes it.
            const before = out.join('').replace(/\s+$/, '');
            const lastChar = before.slice(-1);
            const isRegex = before === ''
                || REGEX_PRECEDERS.has(lastChar)
                || KEYWORD_PRECEDERS.test(before);
            if (isRegex) {
                out.push(' '); i++;
                let inClass = false;
                while (i < src.length) {
                    if (src[i] === '\\') { out.push('  '); i += 2; continue; }
                    if (src[i] === '[') inClass = true;
                    else if (src[i] === ']') inClass = false;
                    else if (src[i] === '/' && !inClass) { out.push(' '); i++; break; }
                    else if (src[i] === '\n') break; // unterminated — bail out
                    out.push(' '); i++;
                }
                while (i < src.length && /[gimsuyd]/.test(src[i])) { out.push(' '); i++; }
                prevSignificant = 'x';
                continue;
            }
        }
        out.push(c);
        if (!/\s/.test(c)) prevSignificant = c;
        i++;
    }
    return out.join('');
}

// ── Declarations ─────────────────────────────────────────────────────────
// Every construct that introduces a binding. Over-collecting here is safe;
// it only makes the check more conservative.
const DECL_PATTERNS = [
    /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)/g,      // function decls & expressions
    /\bclass\s+([A-Za-z_$][\w$]*)/g,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
    /\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g,
    /\b([A-Za-z_$][\w$]*)\s*=>/g,                   // single-param arrow
    /\b([A-Za-z_$][\w$]*)\s*:\s*(?:async\s+)?function/g,   // obj: function(){}
    /\b([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?\([^()]*\)\s*=>/g, // obj: () => {}
    /\b([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{/g,      // object-literal shorthand methods
];

// Only BINDING positions. An earlier version harvested every identifier
// inside any innermost {...}, which quietly registered ordinary call sites as
// declarations and made the whole check a no-op.
const BINDING_GROUPS = [
    /\b(?:const|let|var)\s*\{([^{}]*)\}/g,          // object destructuring
    /\b(?:const|let|var)\s*\[([^[\]]*)\]/g,         // array destructuring
    /\bfunction\s*\*?\s*[\w$]*\s*\(([^()]*)\)/g,    // function params
    /\(([^()]*)\)\s*=>/g,                            // arrow params
    /\bcatch\s*\(([^()]*)\)/g,                       // catch binding
    /\b[A-Za-z_$][\w$]*\s*\(([^()]*)\)\s*\{/g,      // shorthand-method params
    // Multi-declarator lists — `let resolveResult, rejectResult;` binds both,
    // and the single-name pattern above only ever sees the first.
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*(?:\s*,\s*[A-Za-z_$][\w$]*)+)/g,
];

function collectDeclarations(code) {
    const names = new Set();
    for (const re of DECL_PATTERNS) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(code))) names.add(m[1]);
    }
    for (const re of BINDING_GROUPS) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(code))) {
            // Take the identifier each entry BINDS: `a, b = 1, {c: d}` binds
            // a, b and d, so read the last identifier of each comma part.
            for (const part of m[1].split(',')) {
                const ids = part.match(/[A-Za-z_$][\w$]*/g);
                if (!ids) continue;
                names.add(ids[ids.length - 1]);
                names.add(ids[0]); // shorthand `{ foo }` binds foo either way
            }
        }
    }
    return names;
}

// Anything the browser or the language provides. Only bare calls matter —
// `foo.bar()` is skipped by the call regex — so this stays short.
const GLOBALS = new Set([
    // language
    'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function', 'await',
    'new', 'do', 'else', 'try', 'super', 'import', 'yield', 'void', 'delete',
    'instanceof', 'in', 'of', 'case', 'throw', 'class', 'extends', 'async',
    // builtins
    'Math', 'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Date',
    'Promise', 'Set', 'Map', 'WeakMap', 'WeakSet', 'RegExp', 'Error', 'TypeError',
    'RangeError', 'SyntaxError', 'ReferenceError', 'DOMException', 'AggregateError',
    'Symbol', 'Proxy', 'Reflect', 'BigInt', 'Intl', 'Function', 'Option',
    'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'eval',
    // typed arrays & buffers
    'ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'Int8Array', 'Uint8Array',
    'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array',
    'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array',
    'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI',
    'structuredClone', 'queueMicrotask', 'btoa', 'atob', 'require',
    // browser
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
    'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback',
    'fetch', 'alert', 'confirm', 'prompt', 'console', 'document', 'window',
    'navigator', 'localStorage', 'sessionStorage', 'crypto', 'location', 'history',
    'URL', 'URLSearchParams', 'Blob', 'File', 'FileReader', 'FormData', 'Headers',
    'Request', 'Response', 'Image', 'Audio', 'AudioContext', 'MediaRecorder',
    'AbortController', 'AbortSignal', 'CustomEvent', 'Event', 'EventSource',
    'WebSocket', 'Worker', 'Notification', 'IntersectionObserver',
    'MutationObserver', 'ResizeObserver', 'PerformanceObserver',
    'TextDecoder', 'TextEncoder', 'DOMParser', 'XMLHttpRequest', 'matchMedia',
    'getComputedStyle', 'scrollTo', 'open', 'close', 'postMessage', 'atob',
    // audio worklet scope (js/pcm-worklet.js runs off the main thread)
    'registerProcessor', 'AudioWorkletProcessor', 'AudioWorkletNode',
    'AudioBuffer', 'OfflineAudioContext', 'MediaStream',
    // sensor APIs
    'AmbientLightSensor', 'Accelerometer', 'Gyroscope', 'Magnetometer',
    'AbsoluteOrientationSensor', 'RelativeOrientationSensor', 'Geolocation',
]);

/**
 * Core, taking sources directly so it is testable without touching disk.
 * @param {Map<string,string>} sources  file label → raw source
 * @returns {Array<{file,line,name,text}>}
 */
function findUnresolved(sources) {
    // The bundle shares one global scope: index.html loads every file as a
    // classic <script>, so a name declared in one is visible in the others.
    const stripped = new Map();
    const allDeclared = new Set();
    for (const [label, src] of sources) {
        const code = stripNonCode(src);
        stripped.set(label, code);
        for (const n of collectDeclarations(code)) allDeclared.add(n);
    }

    const problems = [];
    for (const [label, code] of stripped) {
        const lines = code.split('\n');
        // A bare `name(` — not `.name(`, not `?.name(`.
        const CALL = /(?<![.\w$?])([A-Za-z_$][\w$]*)\s*\(/g;
        let m;
        while ((m = CALL.exec(code))) {
            const name = m[1];
            if (allDeclared.has(name) || GLOBALS.has(name)) continue;
            const line = code.slice(0, m.index).split('\n').length;
            problems.push({
                file: label,
                line,
                name,
                text: (lines[line - 1] || '').trim().slice(0, 90),
            });
        }
    }
    return problems;
}

function readBundle() {
    const files = [];
    (function walk(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(p);
            else if (entry.name.endsWith('.js')) files.push(p);
        }
    })(JS_DIR);
    const root = path.join(__dirname, '..');
    return new Map(files.map(f => [path.relative(root, f), fs.readFileSync(f, 'utf8')]));
}

function main() {
    const sources = readBundle();
    const problems = findUnresolved(sources);

    if (problems.length === 0) {
        console.log(`check-refs: ${sources.size} files, no unresolved call targets`);
        return 0;
    }
    console.error(`check-refs: ${problems.length} unresolved call target(s)\n`);
    for (const p of problems) {
        console.error(`  ${p.file}:${p.line}  ${p.name}(  —  ${p.text}`);
    }
    console.error('\nEach is a call to a name with no declaration anywhere in js/.');
    console.error('At runtime it throws ReferenceError and aborts its handler.');
    return 1;
}

if (require.main === module) process.exit(main());
module.exports = { stripNonCode, collectDeclarations, findUnresolved, readBundle };
