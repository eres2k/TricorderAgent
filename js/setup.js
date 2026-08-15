/* ============================================
   First-run setup guide
   ------------------------------------------------------------------
   The hardest part of a local-first agent is the first ten minutes: is a
   model server running, on what port, with what loaded? This wizard asks
   the server (/api/setup/*) instead of asking the user to guess.

   Four steps:
     1. Pick a runtime      — LM Studio, llama.cpp, or "already running"
     2. Follow instructions — exact commands for that runtime
     3. Connect             — probe, list models, pick one
     4. Done                — a short tour of what the agent can do

   It shows itself when the server reports setup was never completed AND no
   backend URL was configured in .env. Settings → "Run setup guide again"
   brings it back at any time.

   Exposes: TricorderSetup.maybeRun() / .open() / .isOpen()
   ============================================ */

const TricorderSetup = (() => {
    'use strict';

    const el = {};
    let state = null;
    let onFinish = null;

    // Per-runtime instructions, written for the model this agent targets:
    // Qwen3.8-27B. Every command below sizes the context deliberately — the
    // stock window on each of these runtimes is far shorter than the model
    // supports, and a 27B agentic model on an 8K window spends its whole life
    // being trimmed.
    //
    // `npm run setup` prints the same instructions from server/model-profiles.js
    // with the quant sized to the memory the host actually has. This copy is
    // the version for someone who arrived in the browser first.
    const RUNTIMES = [
        {
            id: 'lmstudio',
            name: 'LM Studio',
            blurb: 'A desktop app with a model browser. Easiest if you have never run a local model.',
            url: 'http://127.0.0.1:1234',
            steps: [
                'Download and install LM Studio from <a href="https://lmstudio.ai" target="_blank" rel="noopener noreferrer">lmstudio.ai</a>.',
                'Open the <strong>Discover</strong> tab and download <strong>Qwen3.8-27B</strong> — the Q4_K_M quant is about 16 GB and is the best quality per gigabyte.',
                'Go to the <strong>Developer</strong> tab and press <strong>Start Server</strong>. Leave the port at 1234.',
                'Load the model, raise its context length (65536 is a good starting point), and turn on <strong>tool use</strong> if your build offers the toggle.',
            ],
            code: 'lms get lmstudio-community/Qwen3.8-27B-GGUF\nlms server start\nlms load qwen3.8-27b --context-length 65536',
            codeNote: 'Or, if you prefer the command line:',
        },
        {
            id: 'llamacpp',
            name: 'llama.cpp',
            blurb: 'The reference C++ runtime. Lean, fast, and scriptable — best if you are comfortable in a terminal.',
            url: 'http://127.0.0.1:8080',
            steps: [
                'Install llama.cpp (<code>brew install llama.cpp</code>, your package manager, or a release build from <a href="https://github.com/ggml-org/llama.cpp" target="_blank" rel="noopener noreferrer">GitHub</a>).',
                'Start the server with the command below — <code>-hf</code> downloads the GGUF on first run.',
                '<strong><code>--jinja</code> is required</strong>: it applies the model\'s chat template, which is what enables tool calling. Without it the agent chats but never acts.',
                '<code>--mmproj</code> loads the vision tower. Leave it off and image turns silently answer from the text alone.',
            ],
            code: 'llama-server \\\n  -hf ggml-org/Qwen3.8-27B-GGUF:Q4_K_M \\\n  --mmproj-url https://huggingface.co/ggml-org/Qwen3.8-27B-GGUF/resolve/main/mmproj-Qwen3.8-27B-Q8_0.gguf \\\n  -c 65536 \\\n  --jinja \\\n  --port 8080',
            codeNote: 'Start it like this:',
        },
        {
            id: 'ollama',
            name: 'Ollama',
            blurb: 'One command to pull and run a model. Good if you already use it for other things.',
            url: 'http://127.0.0.1:11434',
            steps: [
                'Install Ollama from <a href="https://ollama.com" target="_blank" rel="noopener noreferrer">ollama.com</a>.',
                'Pull the model, then leave the server running.',
                '<code>OLLAMA_CONTEXT_LENGTH</code> matters: the default window is a fraction of what Qwen3.8 supports, and the agent notices immediately.',
                'Ollama exposes an OpenAI-compatible API on port 11434, which is what this app uses.',
            ],
            code: 'ollama pull qwen3.8:27b\nOLLAMA_CONTEXT_LENGTH=65536 ollama serve',
            codeNote: 'Then run:',
        },
    ];

    // What the server recommends, filled in from /api/setup/detect so this
    // wizard and `npm run setup` never disagree about which model to name.
    let recommended = null;

    let step = 0;
    let runtime = RUNTIMES[0];
    let chosenUrl = '';
    let chosenModel = '';
    let probeResult = null;

    function h(html) { return html; }

    function stepsBar() {
        return `<div class="setup-steps">${[0, 1, 2, 3]
            .map((i) => `<i class="${i < step ? 'done' : i === step ? 'now' : ''}"></i>`)
            .join('')}</div>`;
    }

    /* ── Step 1: pick a runtime ───────────────────────────────────────── */
    function renderPick() {
        el.sub.textContent = 'Tricorder Agent needs a model running on your machine. Pick how you want to run it.';
        el.body.innerHTML = stepsBar() + h(`
            <h3>How do you want to run the model?</h3>
            <p>All three speak the same API, so you can change your mind later in Settings.</p>
            ${RUNTIMES.map((r) => `
                <button class="backend ${r.id === runtime.id ? 'is-selected' : ''}" type="button" data-runtime="${r.id}">
                    <span class="grow">
                        <span class="name">${r.name}</span>
                        <span class="meta">${r.blurb}</span>
                    </span>
                </button>`).join('')}
            <p style="margin-top:14px">Already have something running? Choose whichever matches, or just press
               Next twice — step 3 scans for it either way.</p>
        `);
        el.body.querySelectorAll('[data-runtime]').forEach((btn) => {
            btn.addEventListener('click', () => {
                runtime = RUNTIMES.find((r) => r.id === btn.dataset.runtime) || RUNTIMES[0];
                renderPick();
            });
        });
        el.next.textContent = 'Next';
        el.next.disabled = false;
    }

    /* ── Step 2: instructions ─────────────────────────────────────────── */
    function renderInstall() {
        el.sub.textContent = `Set up ${runtime.name}, then come back to this tab.`;
        el.body.innerHTML = stepsBar() + h(`
            <h3>Set up ${runtime.name}</h3>
            <ol>${runtime.steps.map((s) => `<li>${s}</li>`).join('')}</ol>
            <p>${runtime.codeNote}</p>
            <pre>${TricorderMarkdown.escapeHtml(runtime.code)}</pre>
            <p><strong>Which model?</strong> This agent targets <strong>Qwen3.8-27B</strong> — native tool
               calling, a 256K context window, vision, and reasoning depth that is steerable per
               request. A Q4_K_M quant is about 16 GB, so it wants roughly 20 GB of VRAM or unified
               memory; it runs on CPU, slowly.</p>
            <p>Short on memory? Anything with solid tool-calling still works — Qwen3.6-27B, a smaller
               Qwen3.8, Llama 3.1 8B, or Mistral Small. A model <em>without</em> tool calling will hold a
               conversation and never touch a file.</p>
            <p class="setup-tip">Prefer the terminal? <code>npm run setup</code> does all of this from the
               host: it sizes the quant and the context window to the memory you actually have, then
               proves the model can call a tool before you open a chat.</p>
        `);
        el.next.textContent = 'It is running — connect';
        el.next.disabled = false;
    }

    /* Model dropdown, ordered by how well each loaded model suits this agent.
       The server scores them (server/model-profiles.js) so the ranking and the
       wording match what `npm run setup` prints on the host. A backend that
       predates the scoring, or one probed before it existed, just falls back to
       the raw list. */
    function modelOptions(backend, selected) {
        const ranked = backend.ranked && backend.ranked.length
            ? backend.ranked
            : (backend.models || []).map((id) => ({ id }));
        return ranked.map((r) => {
            const label = r.tier && r.tier !== 'unknown' ? `${r.id} — ${r.tier}` : r.id;
            return `<option value="${TricorderMarkdown.escapeHtml(r.id)}" ${r.id === selected ? 'selected' : ''}>${TricorderMarkdown.escapeHtml(label)}</option>`;
        }).join('');
    }

    /* One line about the model that is actually selected — the score's own
       reasoning where we have it, and the recommendation where we do not. */
    function modelNote(backend, selected) {
        const entry = (backend.ranked || []).find((r) => r.id === selected);
        if (entry && entry.note) return entry.note;
        if (recommended) return `Any model with tool-calling support works. ${recommended.label} is what this agent targets.`;
        return 'Any model with tool-calling support works.';
    }

    /* ── Step 3: connect ──────────────────────────────────────────────── */
    async function renderConnect() {
        el.sub.textContent = 'Looking for a model server…';
        el.body.innerHTML = stepsBar() + `<h3>Connecting</h3><p>Scanning the usual ports…</p>`;
        el.next.disabled = true;

        let found;
        try {
            const res = await fetch('/api/setup/detect');
            found = await res.json();
        } catch (err) {
            found = { backends: [], error: err.message };
        }

        recommended = found.recommended || recommended;
        const list = (found.backends || []);
        const online = list.filter((b) => b.online);
        // Prefer the runtime the user picked; otherwise anything that answered.
        const preferred = online.find((b) => b.id === runtime.id) || online[0] || null;
        if (preferred) {
            chosenUrl = preferred.url;
            // Preselect the BEST loaded model, not the first one the backend
            // happened to list. With a chat model and an embedding model both
            // loaded — the normal LM Studio setup — "first" is a coin flip, and
            // landing on the embedding model looks like the agent is broken.
            chosenModel = chosenModel || (preferred.best && preferred.best.id) || (preferred.models && preferred.models[0]) || '';
            probeResult = preferred;
        }

        el.sub.textContent = preferred
            ? 'Found it. Pick the model you want to use.'
            : 'Nothing answered yet — that usually just means the server is not started.';

        el.body.innerHTML = stepsBar() + h(`
            <h3>${preferred ? 'Found a model server' : 'No model server yet'}</h3>
            ${list.map((b) => `
                <button class="backend ${b.url === chosenUrl ? 'is-selected' : ''}" type="button"
                        data-url="${b.url}" ${b.online ? '' : 'disabled'}>
                    <span class="grow">
                        <span class="name">${b.label}</span>
                        <span class="meta">${b.url}${b.online
                            ? ` · ${b.models.length} model${b.models.length === 1 ? '' : 's'}`
                            : ` · ${b.hint || 'not running'}`}</span>
                    </span>
                    <span class="badge ${b.online ? 'up' : 'down'}">${b.online ? 'ONLINE' : 'OFFLINE'}</span>
                </button>`).join('')}

            <label class="field" style="margin-top:16px">
                <span class="label">Or enter an address yourself</span>
                <input id="setup-url" type="url" value="${chosenUrl || runtime.url}" spellcheck="false">
                <small>Point at the server root, without <code>/v1</code>.</small>
            </label>

            ${preferred && preferred.models.length ? `
            <label class="field">
                <span class="label">Model</span>
                <select id="setup-model">
                    ${modelOptions(preferred, chosenModel)}
                </select>
                <small>${TricorderMarkdown.escapeHtml(modelNote(preferred, chosenModel))}</small>
            </label>` : preferred ? `
            <p style="color:var(--red)">The server answered but reports no loaded model.
               Load one and press <strong>Scan again</strong>.</p>` : `
            <p>Start ${runtime.name} using the instructions on the previous step, then press
               <strong>Scan again</strong>. You can also skip this and set the address later in Settings.</p>`}

            <div class="row-btns">
                <button id="setup-rescan" class="btn btn-ghost" type="button">Scan again</button>
                <button id="setup-test" class="btn btn-ghost" type="button">Test this address</button>
            </div>
            <p id="setup-test-out" style="margin-top:10px"></p>
        `);

        el.body.querySelectorAll('[data-url]').forEach((btn) => {
            btn.addEventListener('click', () => {
                chosenUrl = btn.dataset.url;
                chosenModel = '';
                renderConnect();
            });
        });
        const urlInput = el.body.querySelector('#setup-url');
        const modelSelect = el.body.querySelector('#setup-model');
        if (urlInput) urlInput.addEventListener('input', () => { chosenUrl = urlInput.value.trim(); });
        if (modelSelect) modelSelect.addEventListener('change', () => { chosenModel = modelSelect.value; });
        el.body.querySelector('#setup-rescan').addEventListener('click', renderConnect);
        el.body.querySelector('#setup-test').addEventListener('click', async () => {
            const out = el.body.querySelector('#setup-test-out');
            out.textContent = 'Testing…';
            try {
                const res = await fetch('/api/setup/test', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url: (urlInput && urlInput.value) || chosenUrl }),
                });
                const data = await res.json();
                if (data.online) {
                    chosenUrl = data.url;
                    out.innerHTML = `<span style="color:var(--green)">Reachable — ${data.models.length} model(s): ${data.models.slice(0, 4).map(TricorderMarkdown.escapeHtml).join(', ') || 'none loaded'}</span>`;
                    if (!chosenModel && data.models.length) chosenModel = data.models[0];
                    el.next.disabled = false;
                } else {
                    out.innerHTML = `<span style="color:var(--red)">Not reachable — ${TricorderMarkdown.escapeHtml(data.error || 'no response')}</span>`;
                }
            } catch (err) {
                out.innerHTML = `<span style="color:var(--red)">${TricorderMarkdown.escapeHtml(err.message)}</span>`;
            }
        });

        el.next.textContent = 'Finish';
        el.next.disabled = !preferred;
    }

    /* ── Step 4: done ─────────────────────────────────────────────────── */
    function renderDone() {
        el.sub.textContent = 'You are set up.';
        el.body.innerHTML = stepsBar() + h(`
            <h3>Ready</h3>
            <p>Connected to <code>${TricorderMarkdown.escapeHtml(chosenUrl)}</code>${chosenModel ? ` running <code>${TricorderMarkdown.escapeHtml(chosenModel)}</code>` : ''}.</p>
            <h3 style="margin-top:20px">What it can do</h3>
            <ul>
                <li><strong>Files</strong> — read, write, edit, glob and grep inside its workspace.</li>
                <li><strong>Shell</strong> — run commands and watch the output stream in.</li>
                <li><strong>Web</strong> — search, fetch pages, scrape structured data, cross-check claims.</li>
                <li><strong>Code</strong> — run Python/Node/Bash in a throwaway Docker container, lint, use git.</li>
                <li><strong>Previews</strong> — serve a page it just wrote and hand you a link.</li>
                <li><strong>Memory</strong> — remember facts about you across conversations.</li>
                <li><strong>Background agents</strong> — spawn sub-agents and scheduled tasks.</li>
            </ul>
            <p>It asks before writing files or running commands. You can turn that off in Settings,
               but leaving it on is a good idea while you learn what it does.</p>
        `);
        el.next.textContent = 'Start using it';
        el.next.disabled = false;
        el.back.hidden = true;
        el.skip.hidden = true;
    }

    const RENDERERS = [renderPick, renderInstall, renderConnect, renderDone];

    function draw() {
        el.back.hidden = step === 0 || step === 3;
        el.skip.hidden = step === 3;
        RENDERERS[step]();
    }

    async function finish() {
        try {
            await fetch('/api/setup/complete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: chosenUrl, model: chosenModel }),
            });
        } catch { /* the local settings below still apply */ }
        // Mirror the choice into the browser settings the agent loop reads.
        const patch = {};
        if (chosenUrl) patch.lmStudioUrl = chosenUrl;
        if (chosenModel) patch.model = chosenModel;
        if (Object.keys(patch).length) TricorderLLM.saveSettings(patch);
        close();
        if (onFinish) onFinish();
    }

    function close() {
        el.root.hidden = true;
        step = 0;
    }

    function open(opts = {}) {
        onFinish = opts.onFinish || null;
        step = 0;
        chosenUrl = (state && state.url) || '';
        chosenModel = (state && state.model) || '';
        el.root.hidden = false;
        draw();
    }

    function isOpen() { return !el.root.hidden; }

    function bind() {
        el.root = document.getElementById('setup');
        el.body = document.getElementById('setup-body');
        el.sub = document.getElementById('setup-sub');
        el.next = document.getElementById('setup-next');
        el.back = document.getElementById('setup-back');
        el.skip = document.getElementById('setup-skip');

        el.next.addEventListener('click', () => {
            if (step === 3) { finish(); return; }
            step = Math.min(step + 1, 3);
            draw();
        });
        el.back.addEventListener('click', () => { step = Math.max(step - 1, 0); draw(); });
        el.skip.addEventListener('click', () => {
            // "Skip" is a real answer: don't nag on every reload.
            fetch('/api/setup/complete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: '', model: '' }),
            }).catch(() => {});
            close();
            if (onFinish) onFinish();
        });
    }

    // Show the wizard only when the server says setup was never completed.
    // A configured LLM_BASE_URL in .env counts as completed — that operator
    // already made the choice this wizard exists to ask about.
    async function maybeRun(opts = {}) {
        bind();
        try {
            const res = await fetch('/api/setup/state');
            state = await res.json();
        } catch {
            state = { completed: true };  // server unreachable: don't block the UI
        }
        if (!state.completed) open(opts);
        return state;
    }

    return { maybeRun, open, close, isOpen, get state() { return state; } };
})();
