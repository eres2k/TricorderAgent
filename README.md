# Tricorder Agent

A local-first AI agent that runs entirely on your own machine. It doesn't just
chat — it reads and writes files, runs commands, searches the web, executes
code in a sandbox, and remembers what matters across conversations.

Point it at a model you run yourself (LM Studio, llama.cpp, or Ollama) and it
works. No account, no API key, no data leaving your computer except the web
requests its tools explicitly make.

**Zero npm dependencies.** The whole thing is Node's standard library and
vanilla browser JavaScript. Clone it, run `node server.js`, open a tab.

```bash
git clone https://github.com/eres2k/TricorderAgent.git
cd TricorderAgent
node server.js
```

Then open <http://localhost:3000>. A setup guide walks you through connecting a
model the first time you open it.

---

## What it can actually do

| | |
|---|---|
| **Files** | read, write, edit, glob, grep — plus PDF/DOCX/XLSX text extraction and zip handling |
| **Shell** | run commands with live streaming output |
| **Web** | search, fetch pages, scrape structured data, cross-check claims against multiple sources |
| **Code** | run Python/Node/Bash in a throwaway, network-isolated Docker container |
| **Git** | status, diff, commit, branch, merge — on local repositories |
| **Browser** | drive headless Chromium: navigate, click, type, read the page visually |
| **Previews** | serve a page it just wrote on a live-reload dev server and hand you the link |
| **Databases** | create and query SQLite |
| **Memory** | remember facts about you and your projects, ranked by relevance and injected into its own prompt |
| **Scheduling** | cron-style tasks and reminders that run without you |
| **Sub-agents** | spawn background agents for long work and collect their results |

It plans before it acts, asks before it writes files or runs commands (you can
turn that off), and shows you every tool call as it happens.

---

## Requirements

- **Node.js 20 or newer** — nothing else to install
- **A model server**, one of:
  - [LM Studio](https://lmstudio.ai) — a desktop app, easiest if you're new to this
  - [llama.cpp](https://github.com/ggml-org/llama.cpp) — lean and scriptable
  - [Ollama](https://ollama.com) — one command to pull and run

**Optional**, each unlocking one capability and degrading cleanly when absent:
Docker (for `code_exec`), Chrome/Chromium (for browser automation), Python
(for `code_linter`).

### Which model?

**Qwen3 8B** is the recommended default — it calls tools reliably, reasons
step by step, and fits in about 6 GB of VRAM (or runs on CPU, slower). A
Q4_K_M quant is roughly a 5 GB download.

Anything with solid tool-calling works: Qwen3 14B or 30B-A3B if you have the
memory, Llama 3.1 8B, Mistral Small. A model *without* tool-calling support
will chat but never act.

> **llama.cpp users:** you must pass `--jinja`. Without it the server ignores
> the `tools` parameter and the agent silently becomes a chatbot.
>
> ```bash
> llama-server -m qwen3-8b-q4_k_m.gguf -c 16384 --jinja --port 8080
> ```

---

## Setup

Run it and open the page — the first-run guide detects what you have running,
tells you exactly what to install if nothing is, and lets you pick a model.
Nothing else is required.

To configure it by hand instead, copy `.env.example` to `.env` and edit. Every
setting has a working default; [SETUP.md](SETUP.md) explains the ones worth
knowing about.

```bash
cp .env.example .env
node server.js
```

---

## Security — read this before exposing it

This is an agent with a shell on your machine. That is the point, and it is
also the risk. The defaults are chosen for a laptop you are the only user of:

- **Files are sandboxed** to the agent workspace (`~/tricorder-agent-workspace`)
  and your temp directory. Nothing else is readable, including your home
  directory. Widen it deliberately with `ALLOWED_PATHS`, or `ALLOW_HOME=true`.
- **Credential files stay off limits** even inside an allowed root: `.ssh`,
  `.aws`, `.gnupg`, `.npmrc`, `.git-credentials`, `.env` files, private keys.
- **There is no login by default.** Set `SITE_PW` in `.env` before you point a
  domain, a tunnel, or an untrusted network at this server. It gates the app,
  the model proxy, and previews alike.
- **Shell access can be removed** entirely with `SHELL_ENABLED=false`.
- **File writes and shell commands ask first**, in the chat, showing you the
  exact arguments. Turn it off in Settings once you trust it.

If you put this on the internet: set `SITE_PW`, put HTTPS in front of it, and
consider `SHELL_ENABLED=false` and `CODE_EXEC_ENABLED=false`.

---

## How it fits together

```
browser                          server (node, no deps)          your machine
─────────────────────────        ──────────────────────          ────────────
js/llm.js    agent loop  ──────► /llm/*   reverse proxy  ──────► model backend
             streaming,          /api/tools/execute      ──────► files, shell,
             tool calls,                                          web, docker,
             context mgmt        memory · tasks · agents          chromium
js/app.js    the UI
```

The **browser drives the agent loop**. It streams the conversation to your
model, decides which tools to call, and asks the server to run them. The server
is the hands: it executes tools, holds memory and scheduled tasks on disk, and
proxies the model so the browser never fights CORS and never sees an API key.

```
├── server.js               the whole server — one file, sectioned, with a map at the top
├── server/
│   ├── tools/              extended tools, one self-contained module each
│   ├── backends.js         LM Studio / llama.cpp / Ollama detection
│   ├── preview-proxy.js    re-serves dev_server previews behind the site login
│   └── durable-stream.js   generations that survive a dropped connection
├── index.html              the app shell
├── css/app.css             one stylesheet
├── js/
│   ├── llm.js              the agent loop — streaming, tools, context, memory
│   ├── llm-tools/          tool schemas the model sees, one file per category
│   ├── app.js              the UI
│   ├── setup.js            the first-run guide
│   └── markdown.js         reply rendering
├── tests/                  node:test, no test framework to install
└── scripts/                reference check + schema generator
```

### Adding a tool

1. Write `server/tools/my_tool.js` exporting `{ name, schema, execute }`.
2. Add it to `MODULES` and `MUTATING_ACTIONS` in `server/tools/index.js`.
3. Run `npm run build:tools` to regenerate what the browser advertises.
4. `npm test` fails if the two sides drift.

---

## Configuration

The settings you're most likely to touch. See `.env.example` for all of them.

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3000` | Server port |
| `LLM_BASE_URL` | `http://127.0.0.1:1234` | Your model server root (no `/v1`) |
| `LLM_MODEL` | `auto` | Model id, or `auto` for whatever is loaded |
| `SITE_PW` | — | Password for the whole site. Empty = no login |
| `TRICORDER_WORKSPACE` | `~/tricorder-agent-workspace` | Where file tools work |
| `ALLOWED_PATHS` | — | Extra directories the agent may touch (`:`-separated) |
| `ALLOW_HOME` | `false` | Grant the whole home directory |
| `SHELL_ENABLED` | `true` | `false` removes `run_command` entirely |
| `CODE_EXEC_ENABLED` | `true` | Docker sandbox for `code_exec` |
| `PUBLIC_URL` | — | Public origin, for shareable preview links |
| `LOG_LEVEL` | `INFO` | `DEBUG` · `INFO` · `WARN` · `ERROR` |

---

## Using it from other apps

Whatever else runs on your machine can borrow the same model pipeline over
HTTP — same model resolution, same reasoning-token stripping, same
truncation detection the app itself gets.

```bash
curl -X POST localhost:3000/api/ai/chat \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Summarise this in one line: ...","max_tokens":100}'
```

`GET /api/ai/capabilities` lists every endpoint, the live model, and the tool
set, so a client can discover the surface instead of hardcoding it. Streaming
lives at `/llm/v1/chat/completions` (standard OpenAI shape, with resume).

---

## Testing

```bash
npm test     # reference check, schema consistency, unit + integration tests
npm run lint # the reference check on its own
```

No test framework to install — it's Node's built-in runner. The suite boots the
real server against a stub model backend and drives a full tool call through
it, so the seam between the browser loop and the executor is covered, not just
each half.

`npm run lint` catches the bug class that keeps happening in a no-build-step
codebase: a function renamed with a call site left behind. `node --check`
passes such code, because it validates parsing rather than identifier
resolution.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| "no model server" | Is LM Studio / llama.cpp / Ollama actually running? Click the status pill to retry. |
| It chats but never uses tools | The model has no tool-calling support, or llama.cpp was started without `--jinja`. |
| "Access denied … outside the allowed directories" | Working. Add the directory to `ALLOWED_PATHS` if you meant it. |
| `code_exec` fails | Docker isn't running. Everything else still works. |
| Browser tools fail | No Chromium found. Set `CHROMIUM_PATH`, and use Node 21+. |
| Replies are slow | Normal for a large model on modest hardware. Try a smaller quant, or lower the effort setting in the composer. |
| Model dropdown is empty | Nothing is loaded in the backend — load a model, then reopen Settings. |

---

## Relationship to Tricorder

This is the public, stripped-down build of a larger private project. The agent
engine, tool layer, and server are the same lineage; the personal integrations
(mail, calendar, messaging, smart home, media generation, speech) are not part
of this build, and neither is anything specific to one person's setup.

## License

MIT — see [LICENSE](LICENSE).
