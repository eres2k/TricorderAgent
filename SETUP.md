# Setup

The short version: run `node server.js`, open <http://localhost:3000>, and
follow the guide it shows you. This document is for when you want to know what
that guide is doing, or you'd rather configure it by hand.

---

## 1. Node

You need **Node.js 20 or newer**. Check with `node --version`.

There is nothing to install after that — no `npm install`, no build step, no
dependencies. The `package.json` exists for the scripts and the metadata.

## 2. A model server

Tricorder Agent talks to one thing: an OpenAI-compatible
`/v1/chat/completions` endpoint. Pick whichever runtime you prefer.

### LM Studio — easiest

1. Install from [lmstudio.ai](https://lmstudio.ai).
2. **Discover** tab → download **Qwen3 8B** (a Q4_K_M quant, ~5 GB).
3. **Developer** tab → **Start Server**. Leave the port at `1234`.
4. Load the model there. Enable tool use if your build shows the toggle.

From a terminal instead:

```bash
lms server start
lms load qwen3-8b
```

### llama.cpp — lean

```bash
llama-server \
  -m qwen3-8b-q4_k_m.gguf \
  -c 16384 \
  --jinja \
  --port 8080
```

**`--jinja` is not optional.** It is what makes llama.cpp apply the model's
chat template, which is what enables tool calling. Without it the server
accepts your requests, ignores the `tools` parameter, and the agent quietly
degrades into a chatbot that describes actions instead of taking them.

`-c` is the context window. 16384 is a comfortable floor for agent work — the
tool schemas and memory block are already a few thousand tokens before the
conversation starts.

### Ollama

```bash
ollama pull qwen3:8b
ollama serve
```

Ollama exposes an OpenAI-compatible API on port `11434`, which is what this
app uses. The native `/api/chat` endpoint is not involved.

---

## 3. Choosing a model

**Qwen3 8B** is what this agent is tuned for: reliable tool calling, explicit
step-by-step reasoning, ~6 GB of VRAM, and it runs on CPU if you're patient.

| Model | Notes |
|---|---|
| **Qwen3 8B** | Recommended. Best behaviour-per-gigabyte for this agent. |
| Qwen3 14B / 30B-A3B | Better at long multi-step work if you have the memory. |
| Llama 3.1 8B Instruct | Solid tool calling, a little more literal. |
| Mistral Small | Good general reasoning. |

The one hard requirement is **function/tool calling**. A model without it will
hold a conversation and never touch a file.

Set which one to use in Settings, or pin it with `LLM_MODEL=qwen3-8b` in
`.env`. Leaving it on `auto` uses whatever the backend reports as loaded,
which is what you want on a single-model setup.

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
LLM_MODEL=qwen3-8b                   # or "auto"
LLM_TIMEOUT_MS=120000                # raise on slow hardware
```

Setting `LLM_BASE_URL` counts as "setup done" and skips the first-run guide —
you've already made the choice it exists to ask about.

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

To check your own backend by hand:

```bash
curl localhost:3000/api/setup/detect      # what's running, and what's loaded
curl localhost:3000/api/ai/capabilities   # model, tools, endpoints
```

---

## 8. Troubleshooting

**"no model server"**
The backend isn't running or isn't where the app is looking. `curl
localhost:3000/api/setup/detect` shows what was probed and what answered.

**It chats but never uses a tool**
Either the model has no tool-calling support, or llama.cpp is running without
`--jinja`. Check that TOOLS shows `ON` in the composer too.

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
`PORT=3001 node server.js`.

**Nothing loads after an update**
A stale service worker. Hard-reload the page (Ctrl/Cmd+Shift+R), or clear the
site's storage.
