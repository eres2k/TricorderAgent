/* ============================================
   Tricorder Agent — Extended Tools Registry
   ------------------------------------------------------------------
   Every module in this directory is { name, schema, execute } plus an
   optional `timeoutMs` override for long-running work. This file
   aggregates them into one dispatch surface for server.js.

   When the tool dispatcher meets a name that is not one of its built-in
   cases it falls through to `execute(name, args, ctx)` here, which adds
   the cross-cutting guarantees every tool call gets:
     - structured { error, code, details? } on failure
     - per-action logging to ~/.tricorder-agent/tool-logs/
     - a hard timeout around every call (module.timeoutMs, default 30 s,
       capped at lib.MAX_TIMEOUT_MS)

   Adding a tool: drop a module in this directory, add it to MODULES,
   classify it in MUTATING_ACTIONS, then run `npm run build:tools` to
   regenerate the browser-side schema mirror.
   ============================================ */

'use strict';

const lib = require('./_lib');

const MODULES = [
    require('./git_operations'),
    require('./process_manager'),
    require('./sqlite_manager'),
    require('./code_linter'),
    require('./archive_tool'),
    require('./dev_server'),
    require('./rss_reader'),
    require('./send_email'),
];

const byName = new Map();
for (const m of MODULES) {
    if (!m || !m.name || typeof m.execute !== 'function' || !m.schema) {
        throw new Error(`Invalid tool module: ${m && m.name}`);
    }
    if (byName.has(m.name)) throw new Error(`Duplicate tool name: ${m.name}`);
    byName.set(m.name, m);
}

const schemas = MODULES.map((m) => m.schema);
const names = [...byName.keys()];

// --- Mutation classification -------------------------------------------------
// Per-action granularity: `true` = every call of the tool mutates state;
// an array lists exactly the actions that mutate (everything else is read-only).
// server.js consults isMutatingCall(name, args) so plan mode (read-only) can
// allow e.g. `git_operations status` while still blocking `git_operations push`.
const MUTATING_ACTIONS = {
    git_operations: ['add', 'commit', 'push', 'pull', 'branch_create', 'branch_switch', 'stash', 'merge', 'rebase_abort'],
    process_manager: ['kill', 'restart_service'],
    // execute_query gets special-cased below: a plain SELECT is read-only.
    sqlite_manager: ['create_db', 'execute_query', 'insert', 'update', 'delete', 'create_table', 'import_csv', 'backup'],
    code_linter: ['format'],
    archive_tool: ['create_zip', 'extract'],
    dev_server: ['start', 'stop'],
    rss_reader: ['add_feed', 'remove_feed', 'get_new_since'],
    // Sending is irreversible and leaves the machine — the sharpest
    // mutation in the registry. check_config only logs in.
    send_email: ['send'],
};

// Raw SQL statements that only read. Anything else (INSERT/UPDATE/DDL/…)
// counts as mutating.
const READONLY_SQL = /^\s*(select|pragma|explain|with)\b/i;

// Contract for server.js: extendedTools.isMutatingCall(name, args) with
// args = the tool-call arguments object (reads args.action).
function isMutatingCall(toolName, args = {}) {
    const spec = MUTATING_ACTIONS[toolName];
    if (spec === undefined) return mutating.includes(toolName); // unknown → legacy fallback
    if (spec === true) return true;
    if (spec === false) return false;
    const action = args && args.action;
    if (!action) return true; // no action yet → fail closed
    if (toolName === 'sqlite_manager' && action === 'execute_query') {
        return !READONLY_SQL.test(String(args.query || ''));
    }
    return spec.includes(action);
}

// Legacy tool-level fallback: tools with at least one mutating action.
const mutating = Object.entries(MUTATING_ACTIONS)
    .filter(([, spec]) => spec === true || (Array.isArray(spec) && spec.length > 0))
    .map(([name2]) => name2);

function has(name) { return byName.has(name); }

// Execute a tool with logging + timeout, always returning either the tool's
// result object or a structured { error, code, details? } payload.
async function execute(name, args = {}, ctx = {}) {
    const mod = byName.get(name);
    if (!mod) return { error: `Unknown tool: ${name}`, code: 'UNKNOWN_TOOL' };
    const started = Date.now();
    const budget = Math.min(mod.timeoutMs || lib.DEFAULT_TIMEOUT_MS, lib.MAX_TIMEOUT_MS);
    try {
        const result = await lib.withTimeout(
            Promise.resolve().then(() => mod.execute(args || {}, ctx)),
            budget,
            name,
        );
        lib.logAction(name, { action: args && args.action, ok: true, ms: Date.now() - started });
        return result;
    } catch (err) {
        const payload = lib.toErrorPayload(err);
        lib.logAction(name, { action: args && args.action, ok: false, ms: Date.now() - started, error: payload.error, code: payload.code });
        return payload;
    }
}

module.exports = { schemas, names, mutating, isMutatingCall, MUTATING_ACTIONS, has, execute, MODULES };
