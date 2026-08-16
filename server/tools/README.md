# Extended Tools

Eight native agent tools, one self-contained module per file. Each module
exports `{ name, schema, execute }` plus an optional `timeoutMs`:

- **`schema`** — an OpenAI-compatible function-calling definition. The browser
  mirrors these in [`js/llm-tools/extended-tools.js`](../../js/llm-tools/extended-tools.js)
  and sends them to the model. That mirror is GENERATED from these modules
  (`npm run build:tools`), and `tests/tools/consistency.test.js` re-runs the
  generator and fails if the checked-in copy has drifted.
- **`execute(args, ctx)`** — the implementation. `ctx` (supplied by `server.js`)
  carries `sanitizePath`, `isPathAllowed`, `WORKSPACE_DIR`, `HOME_DIR`,
  `IS_WINDOWS` and `pythonBin`. When `ctx` is absent (unit tests) the shared
  library [`_lib.js`](./_lib.js) falls back to equivalent — and equally
  strict — defaults.
- **`timeoutMs`** — optional per-tool budget for the outer guard (default 30 s,
  hard cap 600 s). Raised for slow work: `git_operations` 120 s,
  `archive_tool` 120 s.

### Cross-cutting guarantees (provided by `index.js` + `_lib.js`)

| Requirement | Where |
|---|---|
| Structured errors `{ error, code, details? }` | `_lib.ToolError` / `toErrorPayload`, applied in `index.execute()` |
| Per-action required params (`MISSING_PARAM`) | `_lib.requireParams` + a `REQUIRED_PARAMS` table per module — checked before any subprocess |
| Per-action logging | `~/.tricorder-agent/tool-logs/<tool>.log` and `_all.log` (JSON lines) |
| Path sandboxing | `_lib.resolvePath` → the workspace and tmp by default. `server.js` passes its own stricter `ctx.isPathAllowed`, which also refuses credential files (`.ssh`, `.aws`, `.env`, …) inside otherwise-allowed roots. |
| Timeout (per-tool `timeoutMs`, default 30 s, cap 600 s) | `_lib.withTimeout`, wrapped around every call in `index.execute()`; partial outputs are deleted on timeout where known (archives) |
| Truncated subprocess output | `OUTPUT_TRUNCATED` instead of a cryptic parse error when the 8 MB stdout cap is hit |
| No shell injection | every helper uses `spawn(file, argv)` — never a shell string |

### Persistent Python worker

`_lib.runPython` keeps one long-lived Python process alive and exec()s tool
snippets inside it (params via a stdin-JSON shim, printed JSON captured), so
library imports are paid once per process instead of per call. If the worker dies or misbehaves the
call transparently falls back to a one-shot `python3 -c` spawn and the worker
restarts on the next call. Disable with `TRICORDER_PY_WORKER=0`.

### Integration

`server.js` loads the registry once and dispatches any tool name it doesn't
handle natively to it (tool switch `default` case). Mutation is classified
per action: `extendedTools.isMutatingCall(name, args)` reads `args.action`
(e.g. `git_operations status` is read-only, `push` is not; a raw
`sqlite_manager execute_query` counts as read-only only for
SELECT/PRAGMA/EXPLAIN/WITH). The coarser tool-level `mutating` list remains
exported as a fallback for the legacy `MUTATING_TOOLS` set.

---

## Tools

### 1. `git_operations`
Local Git over a sandboxed repo (git binary only, no shell).
Actions: `status, diff, add, commit, push, pull, branch_create, branch_switch, branch_list, log, stash, merge, rebase_abort`.

```json
{ "repo_path": "~/tricorder-workspace/code/myrepo", "action": "commit", "message": "Fix bug" }
{ "repo_path": "~/proj", "action": "branch_create", "branch": "feature/x" }
{ "repo_path": "~/proj", "action": "push", "remote": "origin" }
```

### 2. `process_manager`
List/kill processes, control services. Killing PID < 1000 needs `confirm: true`.
_PowerShell on Windows, `ps`/`kill`/`systemctl` on Linux._

```json
{ "action": "list", "sort": "ram", "limit": 10 }
{ "action": "kill", "name": "notepad" }
{ "action": "restart_service", "service_name": "Spooler" }
```

### 3. `sqlite_manager`
Actions: `create_db, execute_query, insert, update, delete, create_table, export_csv, import_csv, backup`.
SQL-injection safe: identifiers are validated, values bind through `?` placeholders only.
`backup` writes to `target_path` (`csv_path` kept as backwards-compatible alias).
_Python: stdlib `sqlite3`._

```json
{ "db_path": "~/data/app.db", "action": "create_table", "table": "users", "data": { "id": "INTEGER PRIMARY KEY", "name": "TEXT" } }
{ "db_path": "~/data/app.db", "action": "insert", "table": "users", "data": { "name": "Ada" } }
{ "db_path": "~/data/app.db", "action": "execute_query", "query": "SELECT * FROM users WHERE name = ?", "params": ["Ada"] }
```

### 4. `code_linter`
Actions: `lint, format, check_security, get_suggestions`. Language auto-detected
from the extension (`.js/.ts` → ESLint via `npx`; `.py` → black / pyflakes).
`check_security` is a dependency-free pattern scan.

```json
{ "action": "lint", "file_path": "~/code/app.js" }
{ "action": "format", "file_path": "~/code/script.py" }
{ "action": "check_security", "file_path": "~/code/app.js" }
```

### 5. `archive_tool`
Actions: `create_zip (input_paths and/or input_dir → .zip / .tar.gz / .tgz / .tar
by output extension), extract (zip-slip guarded), list`.
_Python: stdlib `zipfile`/`tarfile`._

```json
{ "action": "create_zip", "input_dir": "~/project", "output_path": "~/project.zip" }
{ "action": "list", "input_path": "~/backup.tar.gz" }
{ "action": "extract", "input_path": "~/backup.zip", "output_dir": "~/restored" }
```

### 6. `dev_server`
Persistent local static-file server with live reload, bound to 127.0.0.1.
Serves a workspace directory, injects an SSE reload client into HTML responses
and broadcasts a debounced reload on every `fs.watch` change under the root —
so the agent starts it once and iterates with `file_edit` while open tabs
(or `browser_navigate`/`browser_vision`) refresh automatically. Servers live
in the Tricorder server process and persist across turns until stopped.
Actions: `start (root?, port?; port 0 = ephemeral, default scans from 8100),
stop (port?; no port stops all), status`.

Every running server is also mounted on the main Tricorder origin at
`preview_path` (`/preview/<port>/`), which puts it behind the site login — so a
page the agent is iterating on is reachable from a phone or the public domain
without exposing a port. Set `PUBLIC_URL` and the results additionally carry a
ready-to-share `public_url`. Only ports a live `dev_server` owns are proxied.
_Pure Node — no dependency._

```json
{ "action": "start", "root": "~/tricorder-workspace/code" }
{ "action": "status" }
{ "action": "stop", "port": 8100 }
```

### 7. `rss_reader`
Actions: `add_feed, remove_feed, get_items, get_new_since, summarize_items, search_feeds, list_feeds`.
Subscriptions persist in `~/.tricorder/rss-feeds.json`; seen-item ids cached per feed.
Feeds are fetched in parallel (6 workers) and cached in the store for 10 minutes.
_Python: feedparser._

```json
{ "action": "add_feed", "feed_url": "https://news.ycombinator.com/rss" }
{ "action": "get_new_since", "feed_url": "https://news.ycombinator.com/rss", "limit": 10 }
{ "action": "search_feeds", "keyword": "rust" }
```

### 8. `send_email`
Actions: `send, check_config`. Speaks SMTP directly over `net`/`tls` — EHLO,
STARTTLS, AUTH LOGIN, MAIL FROM, RCPT TO, DATA — so it stays zero-dependency.
Builds RFC 5322 messages with MIME parts for HTML bodies and attachments;
subjects are RFC 2047 encoded, bodies are dot-stuffed, and `bcc` rides the
envelope only — never the headers, and never the tool result.

Inert until `SMTP_HOST` is set, and `check_config` reports exactly which
variables are missing. `SMTP_ALLOWED_RECIPIENTS` is enforced per address
(whole address, or a bare `@domain`), which is what makes it safe to hand to a
task that runs while nobody is watching. `send` is classified as mutating, so
plan mode blocks it and the approval gate stops it like a file write.
Attachments resolve through the same sandbox as every other path, 10 MB total.

```json
{ "action": "check_config" }
{ "action": "send", "to": ["me@example.com"], "subject": "Nightly report", "body": "Two things happened." }
{ "action": "send", "to": ["me@example.com"], "subject": "Chart", "html": "<p>See attached</p>", "attachments": ["~/tricorder-agent-workspace/data/report.csv"] }
```

## Dependencies

**Node.js:** none. The server stays zero-dependency; only Node's stdlib is used.

Most of these tools need nothing beyond that. The two that reach outside:

| Tool | Wants | Without it |
|---|---|---|
| `git_operations` | `git` on PATH | structured `MODULE_NOT_FOUND`-style error |
| `code_linter` | Python 3 plus the linter you point it at (`npx` for JS, `black`/`pyflakes` for Python) | reports which binary is missing |

Set `TRICORDER_PYTHON` if your interpreter is not `python3` (or `py` on
Windows). A missing dependency surfaces as a structured
`{ "error": "...", "code": "MODULE_NOT_FOUND", "details": { "install": "pip install ..." } }`
so the agent can tell you how to fix it instead of failing opaquely.

## Tests

```bash
npm test          # node --test over tests/**/*.test.js
```

Covers the shared library, the registry contract, the generated
server↔browser schema mirror, `git_operations` and `archive_tool` end to
end, and the platform-independent validation guards of the rest.
