# Setup

The short version:

```bash
npm start
```

On a fresh clone that runs setup first: it finds your model server, sizes the
model to the memory you actually have, proves the backend can call a tool, and
writes `.env` — then starts the server. Open <http://localhost:3000>.

Later runs go straight to the server. `npm run setup` redoes the detection on
demand; `npm start -- --no-setup` skips it.

If you'd rather do it in the browser, `npm run dev` starts the server with no
preamble — the first-run guide asks the same questions. This document is for
when you want to know what any of them is doing, or you'd rather configure it
by hand.

---

## 0. `npm run setup`

`npm start` runs this for you on a first run — "first run" meaning no `.env`
**and** no `LLM_BASE_URL` in the environment, so a container configured through
real environment variables is never interrupted by it. In a non-interactive
shell it runs as `--yes` rather than waiting on a prompt. Opt out with
`npm start -- --no-setup`, `TRICORDER_SKIP_SETUP=1`, or `npm run dev`.

Seven stages, each of which prints what it found and why it matters:

| Stage | What it does |
|---|---|
| **host** | Node version, memory budget, and which optional extras (Docker, Chromium, Python) are present |
| **model** | Which quant fits your machine, and how much context is left after the KV cache |
| **backend** | Probes LM Studio, llama.cpp and Ollama; ranks the loaded models |
| **capability** | A **live request**: tool calling, reasoning depth, vision, context window, embeddings |
| **config** | Writes `.env` — merged into what is already there, never clobbered |
| **workspace** | Creates the sandbox the file tools live in |
| **verify** | Runs the test suite, with `--verify` |

The capability stage is the one worth the wait. *"It chats but never uses a
tool"* is the most common failure in this project, it is invisible until you
ask the agent to actually do something, and it is one HTTP request away from
being caught here instead.

```bash
npm run setup              # interactive where it needs an answer
npm run setup -- --yes     # take the best default for everything
npm run doctor             # diagnose only, write nothing
npm run setup -- --json    # machine-readable report, exit 1 on a problem
```

Other flags: `--verify` (run the tests at the end), `--no-probe` (skip the live
requests), `--url=…` and `--model=…` to override what it detected.

---

## 1. Node

You need **Node.js 20 or newer**. Check with `node --version`.

There is nothing to install after that — no `npm install`, no build step, no
dependencies. The `package.json` exists for the scripts and the metadata.

## 2. A model server

Tricorder Agent talks to one thing: an OpenAI-compatible
`/v1/chat/completions` endpoint. Pick whichever runtime you prefer.

Every command below states its context window explicitly. All three runtimes
default to a window far shorter than Qwen3.8 supports, and an agent on a short
window spends its life being trimmed. `65536` is a good starting point; raise
it toward `262144` if you have the memory (see §3).

### LM Studio — easiest

1. Install from [lmstudio.ai](https://lmstudio.ai).
2. **Discover** tab → download **Qwen3.8-27B** (Q4_K_M, ~16 GB).
3. **Developer** tab → **Start Server**. Leave the port at `1234`.
4. Load the model, raise its context length, enable tool use if your build
   shows the toggle.

From a terminal instead:

```bash
lms get lmstudio-community/Qwen3.8-27B-GGUF
lms server start
lms load qwen3.8-27b --context-length 65536
```

### llama.cpp — lean

```bash
llama-server \
  -hf ggml-org/Qwen3.8-27B-GGUF:Q4_K_M \
  --mmproj-url https://huggingface.co/ggml-org/Qwen3.8-27B-GGUF/resolve/main/mmproj-Qwen3.8-27B-Q8_0.gguf \
  -c 65536 \
  --jinja \
  --port 8080
```

**`--jinja` is not optional.** It is what makes llama.cpp apply the model's
chat template, which is what enables tool calling. Without it the server
accepts your requests, ignores the `tools` parameter, and the agent quietly
degrades into a chatbot that describes actions instead of taking them.

**`--mmproj` is what loads the vision tower.** Qwen3.8-27B is natively
multimodal, but the vision weights live in a separate GGUF. Leave it off and
image turns answer from the text alone without saying so.

Qwen3.8 was trained with multi-token-prediction heads, and the draft model is
published alongside the weights. Roughly doubles decode throughput on accepted
drafts, for about 3 GB:

```bash
  -md-url https://huggingface.co/ggml-org/Qwen3.8-27B-GGUF/resolve/main/mtp-Qwen3.8-27B-Q8_0.gguf \
  --draft-max 4 --draft-min 1
```

### Ollama

```bash
ollama pull qwen3.8:27b
OLLAMA_CONTEXT_LENGTH=65536 ollama serve
```

Ollama exposes an OpenAI-compatible API on port `11434`, which is what this
app uses. The native `/api/chat` endpoint is not involved.

---

## 3. Choosing a model

**Qwen3.8-27B** is what this agent targets. Four properties, all of which this
agent leans on hard:

- **Native tool calling** — the one hard requirement, and the thing it is best at.
- **256K context** natively (extensible to 1M with YaRN), which is what makes a
  fifteen-round tool chain over real files possible.
- **Reasoning depth steerable per request** via `reasoning_effort`
  (`low` / `medium` / `xhigh`), which is what makes the effort tiers in the
  composer mean something rather than being cosmetic.
- **Vision built in** — no second model to load for screenshots and diagrams.

### How much memory

`npm run setup` works this out for you. The arithmetic, if you'd rather see it:

| Quant | Weights | Total with a 64K window |
|---|---|---|
| Q3_K_M | 12.9 GB | ~20 GB |
| **Q4_K_M** | **15.9 GB** | **~23 GB** |
| Q5_K_M | 18.5 GB | ~26 GB |
| Q8_0 | 27.1 GB | ~34 GB |

The KV cache is the part people forget: about 64 KB per token, so a 64K window
costs 4 GB and the full 256K window costs 16 GB — on top of the weights. The
vision tower is another 0.9 GB.

### If it doesn't fit

The agent runs on anything with tool calling. In rough order of how well:

| Model | Notes |
|---|---|
| **Qwen3.8-27B** | What this agent targets. |
| Qwen3.6-27B | Previous generation, same shape. Works well. |
| Llama 3.1 8B Instruct | Solid tool calling, a little more literal, no thinking mode. |
| Mistral Small | Good general reasoning. |

A model *without* tool calling will hold a conversation and never touch a file.

Set which one to use in Settings, or pin it with `LLM_MODEL=qwen3.8-27b` in
`.env`. Leaving it on `auto` uses whatever the backend reports as loaded —
which is what you want on a single-model setup, and a coin flip if you also
have an embedding model loaded.

---

## 4. Configuration

Copy the example and edit what you need:

```bash
cp .env.example .env
```

Everything has a working default. The settings that actually matter:

### The model

```bash
LLM_BASE_URL=http://127.0.0.1:8080   # your server root, no /v1
LLM_MODEL=qwen3.8-27b                # or "auto"
LLM_TIMEOUT_MS=600000                # a 27B model thinking at depth outlives 120s
```

Setting `LLM_BASE_URL` counts as "setup done" and skips the first-run guide —
you've already made the choice it exists to ask about.

`LLM_VISION_MODEL` stays empty on the recommended setup: Qwen3.8-27B handles
images itself, and routing them to a second model would be strictly worse. Set
it only if your chat model is text-only.

### The workspace

```bash
TRICORDER_WORKSPACE=~/tricorder-agent-workspace
```

Created on first start with `code/`, `data/`, `downloads/` and `scratch/`
inside it. File tools default to it, and relative paths resolve against it.

### The file sandbox

By default the agent can touch **only** the workspace and your temp directory.
Not your home directory, not `/etc`, not your projects folder.

To let it work somewhere real:

```bash
ALLOWED_PATHS=/home/me/projects:/home/me/notes    # ; on Windows
```

Or open up the whole home directory, the way a personal install might want:

```bash
ALLOW_HOME=true
```

Either way, credential files stay refused even inside an allowed root: `.ssh`,
`.gnupg`, `.aws`, `.kube`, `.npmrc`, `.netrc`, `.git-credentials`, private
keys, and `.env` files. "The agent may work in my projects folder" should
never quietly mean "and may read the AWS keys that live under it".

### The password

```bash
SITE_PW=something-long
```

Empty means no login, which is fine on a machine only you use. Set it before
you point a domain, a tunnel, or a shared network at this server — it gates the
app, the model proxy, and the preview mount alike.

### Turning capabilities off

```bash
SHELL_ENABLED=false        # removes run_command and /api/exec entirely
CODE_EXEC_ENABLED=false    # removes the Docker sandbox
```

---

## 5. Optional extras

Each unlocks one capability. Missing ones fail with a clear message rather
than a mystery.

| You want | You need |
|---|---|
| `code_exec` — run snippets in a sandbox | Docker running on the host |
| `browser_*` — headless browsing | Chrome or Chromium, and Node 21+ |
| `code_linter` | Python 3, plus whatever linter you want it to call |
| Semantic memory ranking | An embedding model loaded in your backend |

For embeddings, load one alongside your chat model (LM Studio ships
`nomic-embed`); without one, memory ranking falls back to BM25, which works
fine.

---

## 6. Remote access and live previews

The `dev_server` tool serves a workspace directory on `127.0.0.1:<port>` with
live reload — invisible from anywhere but the host. Tricorder Agent re-serves
every running instance under `/preview/<port>/` on its own origin, so the page
the agent is iterating on opens on your phone with no extra port exposed and
no second password.

```
http://127.0.0.1:8100/                    ← host only (what dev_server binds)
https://agent.example.com/preview/8100/   ← same page, behind the site login
https://agent.example.com/preview/        ← index of everything running
```

To set it up:

1. **Set `SITE_PW`.** This is the gate on `/preview/*`. With it empty there is
   no login to pass, so previews are answered **only** for requests originating
   on the host — anything relayed through a tunnel or proxy gets a 403.
2. **Set `PUBLIC_URL`** so `dev_server` results carry a shareable link the
   agent can hand you directly.
3. **Put HTTPS in front** — Cloudflare Tunnel, Caddy, or nginx with certbot.

Behaviour worth knowing:

| | |
|---|---|
| Which ports are reachable | Only ports a live `dev_server` owns. Any other port is a 404 — the mount is not a gateway to your loopback interface. |
| Relative asset URLs | A `<base href="/preview/<port>/">` is injected, so `./app.js` resolves under the prefix. |
| Root-absolute asset URLs | Routed back via the `Referer` header — unless the app serves that path itself, which always wins. |
| Live reload | Works through the proxy. |
| Caching | Previews are `no-store` and skipped by the service worker, so an edit is never masked by a stale copy. |
| Credentials | The session cookie is stripped before the request reaches the preview server. |

---

## 7. Verifying it works

```bash
npm test
```

This boots the real server against a stub model backend and drives a full tool
call through it. If it passes, the agent loop, the tool dispatcher, and the
file sandbox are all intact.

That tests the app. To test **your** backend — the model, the flags it was
launched with, and whether the two together can actually call a tool:

```bash
npm run doctor
```

Same seven stages as `npm run setup`, writing nothing. Exits non-zero when
something is genuinely wrong, so it works in a health check.

To check by hand instead:

```bash
curl localhost:3000/api/setup/detect      # what's running, what's loaded, ranked
curl localhost:3000/api/ai/capabilities   # model, tools, endpoints
```

---

## 8. Troubleshooting

**"no model server"**
The backend isn't running or isn't where the app is looking. `curl
localhost:3000/api/setup/detect` shows what was probed and what answered.

**It chats but never uses a tool**
Either the model has no tool-calling support, or llama.cpp is running without
`--jinja`. Check that TOOLS shows `ON` in the composer too. `npm run doctor`
tells you which of the three it is in one line.

**Image turns answer as if there were no image**
The vision tower isn't loaded. Qwen3.8-27B is natively multimodal, but on
llama.cpp the vision weights are a separate file — pass `--mmproj` (see §2).
`npm run doctor` probes this directly.

**Every effort tier thinks just as hard as MAX**
The backend is ignoring `reasoning_effort`. On llama.cpp that field only
reaches the model through `chat_template_kwargs`, which needs `--jinja`.
`npm run doctor` reports whether the deepest level was accepted.

**"Access denied: … is outside the allowed directories"**
The sandbox doing its job. Add the directory to `ALLOWED_PATHS` if you meant
to grant it.

**A 502 from the proxy**
`LLM_BASE_URL` (or the URL in Settings) points somewhere nothing is listening.
Remember it's the server *root* — `http://127.0.0.1:1234`, not
`http://127.0.0.1:1234/v1`.

**401 / unauthorized from the backend**
`LLM_API_KEY` doesn't match what your backend expects.

**Responses cut off mid-sentence**
The model hit its output limit. Raise the context window (`-c` on llama.cpp),
or let auto-compression handle a long conversation — it's on by default and
the CTX pill shows how full the window is.

**Port 3000 already in use**
Nothing to do — the server steps past a busy default on its own and prints the
port it actually bound in the startup banner. To pin one yourself, set `PORT`
in `.env` (or `PORT=8080 npm start`); a pinned port that is busy stops with an
error rather than moving, since anything you aimed at it would break.

**Nothing loads after an update**
A stale service worker. Hard-reload the page (Ctrl/Cmd+Shift+R), or clear the
site's storage.
