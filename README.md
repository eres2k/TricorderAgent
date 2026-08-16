# Tricorder Agent

A local-first AI agent that runs entirely on your own machine. It doesn't just
chat — it reads and writes files, runs commands, searches the web, executes
code in a sandbox, and remembers what matters across conversations.

Point it at a model you run yourself (LM Studio, llama.cpp, or Ollama) and it
works. No account, no API key, no data leaving your computer except the web
requests its tools explicitly make.

**Zero npm dependencies.** The whole thing is Node's standard library and
vanilla browser JavaScript. Clone it, run `node server.js`, open a tab.

**[See the full overview →](https://eres2k.github.io/TricorderAgent/)**

![Tricorder Agent mid-task: the operator asks it to find every TODO and write the list to a file. Three tool calls are shown with their arguments and timings — grep and read_file done, write_file running — and an approval card asks permission before the file is written. The composer reads out 103 tokens per second.](docs/screenshot.png)

|  |  |  |  |
|:--|:--|:--|:--|
| **~100 tok/s** | **40** tools | **256K** context | **0** dependencies |
| Qwen3.8-27B on an RTX 5090 | across eight categories | native window | Node stdlib only |

```bash
git clone https://github.com/eres2k/TricorderAgent.git
cd TricorderAgent
npm start
```

That's the whole install. On a fresh clone `npm start` runs setup for you — it
finds your model server, sizes the model to the memory you actually have,
proves the backend can call a tool, and writes `.env` — then boots the server
and opens it in your browser.

Every run after the first skips straight to the server. You can also run
`npm run setup` on its own whenever you want to redo the detection,
`npm start -- --no-setup` to bypass it once, or `npm start -- --no-open` to
keep the browser shut.

Nothing to install beyond Node: no `npm install`, no build step, no
dependencies.

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
| **Scheduling** | recurring multi-step work — cron-style, or "keep checking until X is true", then delete itself |
| **Email** | send results over SMTP, with attachments — how a task reaches you when you aren't watching |
| **Sub-agents** | spawn background agents for long work and collect their results |

It plans before it acts, asks before it writes files or runs commands (you can
turn that off), and shows you every tool call as it happens.

---

## Work that runs without you

The tools above are more interesting once nobody is watching. Ask for something
recurring in plain language and it lands in the Tasks panel:

> *"Every weekday at 07:00, pull the overnight CI failures from my repos, group
> them by which test broke, and email me the summary."*

That is one task doing five things — a schedule, a multi-step tool chain, its
own judgement about grouping, a written artifact, and delivery. It runs whether
or not the browser is open, and it uses the same tool layer and the same
approval rules as a live conversation.

Two kinds of schedule, because "every morning" is not the only shape work
comes in:

| | |
|---|---|
| **Cron** | fixed times — every weekday at 07:00, the 1st of the month, every four hours |
| **Until a condition holds** | *"check every 20 minutes until the deploy is green, then tell me"* — it re-checks, reports progress, and **deletes itself** the moment the condition is true. A watchdog you have to clean up afterwards is a bug. |

Results reach you by email (`send_email`, plain SMTP with attachments), or by
writing a file, or by waiting in the chat. Email is off until you configure
`SMTP_HOST`; set `SMTP_ALLOWED_RECIPIENTS` to your own address and a scheduled
task can never mail anyone else.

---

## Requirements

- **Node.js 20 or newer** — nothing else to install
- **A model server**, one of:
  - [LM Studio](https://lmstudio.ai) — a desktop app, easiest if you're new to this
  - [llama.cpp](https://github.com/ggml-org/llama.cpp) — lean and scriptable
  - [Ollama](https://ollama.com) — one command to pull and run
- **~20 GB of VRAM or unified memory** for the recommended model at Q4_K_M.
  Less is fine — see below.

**Optional**, each unlocking one capability and degrading cleanly when absent:
Docker (for `code_exec`), Chrome/Chromium (for browser automation), Python
(for `code_linter`).

### Which model?

**[Qwen3.8-27B](https://huggingface.co/Qwen/Qwen3.8-27B)** is what this agent
targets, and the four things it is good at are the four things this agent leans
on hardest:

| | |
|---|---|
| **Native tool calling** | The one hard requirement. A model without it will chat and never act. |
| **256K context** | Natively (1M with YaRN) — what makes a fifteen-round tool chain over real files possible. |
| **Steerable reasoning** | `reasoning_effort` at `low` / `medium` / `xhigh`, per request, so the effort tiers in the composer mean something. |
| **Vision built in** | Screenshots and diagrams, with no second model to load. |

A Q4_K_M quant is about 16 GB, so it wants roughly 20 GB of VRAM or unified
memory. It runs on CPU, slowly. Short on memory? Qwen3.6-27B, Llama 3.1 8B and
Mistral Small all work — `npm run setup` will tell you what fits and what it
costs you.

> **llama.cpp users:** you must pass `--jinja`. Without it the server ignores
> the `tools` parameter and the agent silently becomes a chatbot. `--mmproj` is
> what loads the vision tower; without it image turns answer from the text
> alone.
>
> ```bash
> llama-server -hf ggml-org/Qwen3.8-27B-GGUF:Q4_K_M -c 65536 --jinja --port 8080
> ```

---

## Setup

`npm start` does this automatically the first time. Run it directly to redo the
detection later:

```bash
npm run setup
```

Seven stages: it checks the host, works out which quant and context window fit
your memory, probes LM Studio / llama.cpp / Ollama, then sends a **real
request** to confirm the backend can call a tool, reason at depth, and see an
image — before writing `.env`. It merges rather than overwrites, so anything
you have already set survives.

```bash
npm run doctor           # the same diagnosis, writing nothing
npm run setup -- --yes   # non-interactive
npm run setup -- --json  # machine-readable, exit 1 on a problem
```

The launcher treats "no `.env` **and** no `LLM_BASE_URL` in the environment" as
a first run. Containers and service managers that pass configuration as real
environment variables are therefore left alone, and a non-interactive shell
gets `--yes` rather than a prompt nobody can answer. To opt out entirely:
`npm start -- --no-setup`, `TRICORDER_SKIP_SETUP=1`, or `npm run dev` to go
straight to the server.

`npm start` also opens the app once the server is listening — at the port it
actually bound, which matters when a busy 3000 has been stepped past. It stays
shut where a browser would be pointless: a non-interactive shell, an SSH
session, or Linux with no display server. Opt out with `--no-open` or
`TRICORDER_NO_BROWSER=1`; `npm run dev` never opens anything.

Or open the page and let the first-run guide ask the same questions. Or
configure it by hand: copy `.env.example` to `.env` and edit — every setting
has a working default, and [SETUP.md](SETUP.md) explains the ones worth
knowing about.

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
│   ├── model-profiles.js   what each model needs — quants, context, sampling, launch flags
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
├── docs/                   the project page — GitHub Pages serves this
│   ├── index.html          the overview, standalone and self-contained
│   └── screenshot.png
└── scripts/
    ├── start.js            the launcher — version guard, first-run setup, then serve
    ├── setup.js            the setup pipeline — `npm run setup` / `npm run doctor`
    ├── check-refs.js       the reference check
    └── gen-extended-tools.js   schema generator
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
| `PORT` | `3000` | Server port. Set it and it is pinned — busy means an error. Leave it unset and a busy 3000 steps to 3001, 3002, … |
| `LLM_BASE_URL` | `http://127.0.0.1:1234` | Your model server root (no `/v1`) |
| `LLM_MODEL` | `auto` | Model id, or `auto` for whatever is loaded |
| `SITE_PW` | — | Password for the whole site. Empty = no login |
| `TRICORDER_WORKSPACE` | `~/tricorder-agent-workspace` | Where file tools work |
| `ALLOWED_PATHS` | — | Extra directories the agent may touch (`:`-separated) |
| `ALLOW_HOME` | `false` | Grant the whole home directory |
| `SHELL_ENABLED` | `true` | `false` removes `run_command` entirely |
| `CODE_EXEC_ENABLED` | `true` | Docker sandbox for `code_exec` |
| `PUBLIC_URL` | — | Public origin, for shareable preview links |
| `SMTP_HOST` | — | Mail relay for `send_email`. Empty = the tool stays inert |
| `SMTP_USER` / `SMTP_PASS` | — | Credentials. Gmail needs an App Password |
| `SMTP_ALLOWED_RECIPIENTS` | — | Who the agent may mail — address or `@domain`. Empty = anywhere |
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
npm test       # reference check, schema consistency, unit + integration tests
npm run lint   # the reference check on its own
npm run doctor # test your BACKEND rather than the app
```

No test framework to install — it's Node's built-in runner. The suite boots the
real server against a stub model backend and drives a full tool call through
it, so the seam between the browser loop and the executor is covered, not just
each half.

`node --test` is invoked with no path on purpose: it recurses from the working
directory using Node's own test-file convention, which behaves the same on
every version this project supports. A `"tests/**/*.test.js"` glob does not —
the runner only expands globs from Node 22 on, and silently finds nothing on
Node 20.

`npm test` covers the app. `npm run doctor` covers the other half of the
system — the model, the flags it was launched with, and whether the two
together can call a tool, reason at depth, and see an image. Exits non-zero
when something is genuinely wrong, so it works in a health check.

`npm run lint` catches the bug class that keeps happening in a no-build-step
codebase: a function renamed with a call site left behind. `node --check`
passes such code, because it validates parsing rather than identifier
resolution.

---

## Troubleshooting

Start with `npm run doctor` — it diagnoses the first three of these directly.

| Symptom | Fix |
|---|---|
| "no model server" | Is LM Studio / llama.cpp / Ollama actually running? Click the status pill to retry. |
| It chats but never uses tools | The model has no tool-calling support, or llama.cpp was started without `--jinja`. |
| Images are ignored | The vision tower isn't loaded. On llama.cpp, pass `--mmproj`. |
| Every effort tier thinks as hard as MAX | The backend is dropping `reasoning_effort`. On llama.cpp it only reaches the model through the chat template, which needs `--jinja`. |
| "Access denied … outside the allowed directories" | Working. Add the directory to `ALLOWED_PATHS` if you meant it. |
| `code_exec` fails | Docker isn't running. Everything else still works. |
| Browser tools fail | No Chromium found. Set `CHROMIUM_PATH`, and use Node 21+. |
| Replies are slow | Normal for a 27B model on modest hardware. Add the MTP draft model, try a smaller quant, or lower the effort setting in the composer. |
| Model dropdown is empty | Nothing is loaded in the backend — load a model, then reopen Settings. |
| The agent picked your embedding model | `LLM_MODEL=auto` takes whatever the backend lists first. Pin the id, or let `npm run setup` rank them. |

---

## Relationship to Tricorder

This is the public, stripped-down build of a larger private project. The agent
engine, tool layer, and server are the same lineage; the personal integrations
(mail, calendar, messaging, smart home, media generation, speech) are not part
of this build, and neither is anything specific to one person's setup.

## Author

**eres2k** (Erwin Esener) — <erwin.esener@gmail.com>
[github.com/eres2k](https://github.com/eres2k) ·
[Issues](https://github.com/eres2k/TricorderAgent/issues)

## License

MIT — see [LICENSE](LICENSE).
