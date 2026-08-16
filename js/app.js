/* ============================================
   Tricorder Agent — UI controller
   ------------------------------------------------------------------
   This file is the thin layer between the DOM and the agent engine in
   js/llm.js. It owns no agent logic: it renders what the engine reports
   and forwards what the operator does.

   The contract with the engine:
     TricorderLLM.sendStream(text, image, onChunk, onStatus)
       onChunk(delta, fullText)   — the reply as it streams
       onStatus({ phase, ... })   — connecting | thinking | generating |
                                    tool_progress | file_stream | done |
                                    error | aborted | compressing
     TricorderLLM.setToolApprovalHandler(fn)
       fn({ id, name, args }) → true | false | 'always'

   Sections: STATE · MESSAGES · TOOLS · APPROVALS · SEND · STATUS ·
             PANEL · SETTINGS · HISTORY · MEMORY · TASKS · BOOT
   ============================================ */

(function () {
    'use strict';

    /* ── STATE ─────────────────────────────────────────────────────────── */

    const $ = (id) => document.getElementById(id);
    const dom = {
        transcript: $('transcript'),
        welcome: $('welcome'),
        input: $('input'),
        send: $('btn-send'),
        stop: $('btn-stop'),
        approvals: $('approvals'),
        statusDot: $('status-dot'),
        statusText: $('status-text'),
        toolsVal: $('tools-val'),
        effortVal: $('effort-val'),
        contextVal: $('context-val'),
        turnStat: $('turn-stat'),
        panel: $('panel'),
        scrim: $('scrim'),
        toast: $('toast'),
        topbar: document.querySelector('.topbar'),
    };

    // The message element currently being streamed into, plus its parts.
    let live = null;
    // tool_call_id → the row element showing that call.
    const toolRows = new Map();
    let backendOnline = false;

    /* ── UTILITIES ─────────────────────────────────────────────────────── */

    function toast(message, ms = 2600) {
        dom.toast.textContent = message;
        dom.toast.hidden = false;
        clearTimeout(toast._t);
        toast._t = setTimeout(() => { dom.toast.hidden = true; }, ms);
    }

    function atBottom() {
        const t = dom.transcript;
        return t.scrollHeight - t.scrollTop - t.clientHeight < 120;
    }

    function scrollDown(force) {
        if (force || atBottom()) dom.transcript.scrollTop = dom.transcript.scrollHeight;
    }

    // Sound is cosmetic: never let a missing/blocked audio context break a turn.
    const SOUNDS = { send: 'tap', done: 'message', alert: 'alert' };
    function beep(kind) {
        if (!TricorderLLM.settings.sfx) return;
        const fn = SOUNDS[kind];
        try { if (fn && TricorderAudio[fn]) TricorderAudio[fn](); } catch { /* optional */ }
    }

    // One-line preview of a tool's arguments — enough to tell two calls apart
    // without dumping a whole file's contents into the transcript.
    function argPreview(args) {
        if (!args || typeof args !== 'object') return '';
        for (const key of ['path', 'query', 'command', 'url', 'pattern', 'key', 'repo_path', 'prompt']) {
            if (typeof args[key] === 'string' && args[key]) {
                const v = args[key];
                return v.length > 90 ? v.slice(0, 90) + '…' : v;
            }
        }
        const json = JSON.stringify(args);
        return json.length > 90 ? json.slice(0, 90) + '…' : json;
    }

    /* ── MESSAGES ──────────────────────────────────────────────────────── */

    function hideWelcome() {
        if (dom.welcome) dom.welcome.hidden = true;
    }

    function addMessage(role, text, { html = false } = {}) {
        hideWelcome();
        const wrap = document.createElement('div');
        wrap.className = `msg ${role}`;
        const label = role === 'user' ? 'You' : role === 'error' ? 'Error' : 'Agent';
        wrap.innerHTML = `<div class="msg-role">${label}</div><div class="msg-body"><div class="md"></div></div>`;
        const md = wrap.querySelector('.md');
        if (html) md.innerHTML = text;
        else md.innerHTML = TricorderMarkdown.render(text);
        dom.transcript.appendChild(wrap);
        scrollDown(true);
        return wrap;
    }

    // Start the assistant message for this turn. Tool rows and the thinking
    // block live inside it so the whole turn reads as one unit.
    function beginLive() {
        hideWelcome();
        const wrap = document.createElement('div');
        wrap.className = 'msg agent';
        wrap.innerHTML = `
            <div class="msg-role">Agent <span class="phase"></span></div>
            <div class="msg-body">
                <details class="think" hidden><summary>Thinking</summary><div class="think-body"></div></details>
                <div class="tools"></div>
                <div class="md"></div>
            </div>`;
        dom.transcript.appendChild(wrap);
        live = {
            wrap,
            phase: wrap.querySelector('.phase'),
            think: wrap.querySelector('.think'),
            thinkBody: wrap.querySelector('.think-body'),
            tools: wrap.querySelector('.tools'),
            md: wrap.querySelector('.md'),
            text: '',
        };
        toolRows.clear();
        scrollDown(true);
        return live;
    }

    function endLive() {
        if (!live) return;
        live.phase.textContent = '';
        // An empty reply with no tool activity would render as a blank card.
        if (!live.text.trim() && !live.tools.children.length) {
            live.md.innerHTML = '<em style="color:var(--text-dim)">No reply.</em>';
        }
        // Collapse the thinking block once the answer is there.
        if (live.think && live.think.open) live.think.open = false;
        live = null;
    }

    /* ── TOOLS ─────────────────────────────────────────────────────────── */

    function toolRow(id, name) {
        if (!live) beginLive();
        let row = toolRows.get(id);
        if (row) return row;
        row = document.createElement('div');
        row.className = 'tool running';
        row.innerHTML = `
            <span class="spin">◍</span>
            <span class="tool-name"></span>
            <span class="tool-arg"></span>
            <span class="tool-state">running</span>`;
        row.querySelector('.tool-name').textContent = name || 'tool';
        live.tools.appendChild(row);
        toolRows.set(id, row);
        scrollDown();
        return row;
    }

    function onToolEvent(status) {
        const id = status.tool_call_id || status.tool || 'tool';
        const row = toolRow(id, status.tool);
        const spin = row.querySelector('.spin');
        const arg = row.querySelector('.tool-arg');
        const state = row.querySelector('.tool-state');

        switch (status.kind) {
            case 'start':
                if (status.args) arg.textContent = argPreview(status.args);
                break;
            case 'progress':
                if (status.message) state.textContent = String(status.message).slice(0, 40);
                else if (status.bytes) state.textContent = `${Math.round(status.bytes / 1024)} KB`;
                break;
            case 'heartbeat':
                state.textContent = `${Math.round((status.elapsedMs || 0) / 1000)}s`;
                break;
            case 'waiting':
                row.className = 'tool waiting';
                spin.classList.remove('spin');
                spin.textContent = '⏸';
                state.textContent = 'needs approval';
                break;
            case 'done':
                row.className = 'tool ok';
                spin.classList.remove('spin');
                spin.textContent = '✓';
                state.textContent = status.elapsedMs ? `${(status.elapsedMs / 1000).toFixed(1)}s` : 'done';
                break;
            case 'error':
                row.className = 'tool fail';
                spin.classList.remove('spin');
                spin.textContent = '✗';
                state.textContent = String(status.error || 'failed').slice(0, 60);
                break;
        }
        scrollDown();
    }

    /* ── APPROVALS ─────────────────────────────────────────────────────── */

    // Resolves to true (run it), false (refuse), or 'always' (stop asking).
    function askApproval({ name, args }) {
        return new Promise((resolve) => {
            beep('alert');
            const card = document.createElement('div');
            card.className = 'approval';
            const detail = args && typeof args === 'object'
                ? JSON.stringify(args, null, 2).slice(0, 4000)
                : String(args || '');
            card.innerHTML = `
                <h4>Allow <code>${TricorderMarkdown.escapeHtml(name)}</code>?</h4>
                <pre></pre>
                <div class="approval-btns">
                    <button class="btn btn-primary" data-verdict="yes">Allow</button>
                    <button class="btn" data-verdict="always">Allow all this session</button>
                    <button class="btn danger" data-verdict="no">Refuse</button>
                </div>`;
            card.querySelector('pre').textContent = detail;
            dom.approvals.appendChild(card);
            scrollDown(true);

            card.addEventListener('click', (ev) => {
                const verdict = ev.target.dataset && ev.target.dataset.verdict;
                if (!verdict) return;
                card.remove();
                resolve(verdict === 'always' ? 'always' : verdict === 'yes');
            });
        });
    }

    /* ── SEND ──────────────────────────────────────────────────────────── */

    function setBusy(busy) {
        dom.send.hidden = busy;
        dom.stop.hidden = !busy;
        // Drives the scanner rail under the topbar. It is the one activity cue
        // visible from across the room, when the transcript is scrolled away
        // or the phone is on a desk.
        dom.topbar?.classList.toggle('busy', busy);
    }

    async function send(text) {
        const message = (text != null ? text : dom.input.value).trim();
        if (!message || TricorderLLM.isProcessing) return;
        if (!backendOnline) {
            toast('No model server. Click the status pill to retry.');
            refreshStatus();
            return;
        }

        dom.input.value = '';
        autoGrow();
        addMessage('user', message);
        beginLive();
        setBusy(true);
        beep('send');

        try {
            await TricorderLLM.sendStream(message, null, onChunk, onStatus);
        } catch (err) {
            endLive();
            addMessage('error', err && err.message ? err.message : String(err));
        } finally {
            setBusy(false);
            endLive();
            refreshContext();
            refreshHistory();
        }
    }

    function onChunk(delta, fullText) {
        if (!live) beginLive();
        live.text = fullText || (live.text + (delta || ''));
        live.md.innerHTML = TricorderMarkdown.render(live.text);
        scrollDown();
    }

    function onStatus(status) {
        if (!status) return;
        if (!live && status.phase !== 'done') beginLive();

        switch (status.phase) {
            case 'connecting':
                live.phase.textContent = '· connecting';
                break;
            case 'compressing':
                live.phase.textContent = '· compressing context';
                break;
            case 'thinking':
                live.phase.textContent = '· thinking';
                if (status.content) {
                    live.think.hidden = false;
                    live.thinkBody.textContent = status.content;
                    live.thinkBody.scrollTop = live.thinkBody.scrollHeight;
                }
                break;
            case 'generating':
                live.phase.textContent = '· writing';
                break;
            case 'gen_progress':
                if (status.tokens) live.phase.textContent = `· ${status.tokens} tokens`;
                break;
            case 'tool_args_buffering':
                live.phase.textContent = `· preparing ${status.name || 'tool'}`;
                break;
            case 'tool_progress':
                live.phase.textContent = '· using tools';
                onToolEvent(status);
                break;
            case 'file_stream':
                // The agent is writing a file; show the growing path as progress.
                live.phase.textContent = `· writing ${status.path || 'file'}`;
                break;
            case 'done':
                live.phase.textContent = '';
                renderStats(status.stats);
                beep('done');
                break;
            case 'aborted':
                live.phase.textContent = '· stopped';
                break;
            case 'error':
                live.phase.textContent = '';
                addMessage('error', status.message || 'The turn failed.');
                break;
        }
    }

    function renderStats(stats) {
        if (!stats) { dom.turnStat.textContent = ''; return; }
        const bits = [];
        if (stats.tokens) bits.push(`${stats.tokens} tok`);
        if (stats.tokensPerSecond) bits.push(`${Number(stats.tokensPerSecond).toFixed(1)} tok/s`);
        if (stats.durationMs) bits.push(`${(stats.durationMs / 1000).toFixed(1)}s`);
        dom.turnStat.textContent = bits.join(' · ');
    }

    /* ── STATUS ────────────────────────────────────────────────────────── */

    async function refreshStatus() {
        dom.statusDot.className = 'dot busy';
        dom.statusText.textContent = 'checking…';
        try {
            const ok = await TricorderLLM.checkConnection();
            backendOnline = !!ok;
            if (!ok) {
                offline();
                return;
            }
            dom.statusDot.className = 'dot online';
            dom.send.disabled = false;
            // "auto" is what the config says, not what is actually answering.
            // Show the real model id so a wrong-model problem is visible at a
            // glance instead of after a confusing reply.
            let label = TricorderLLM.settings.model;
            if (!label) {
                const models = await TricorderLLM.fetchModels().catch(() => []);
                const first = models[0];
                label = (typeof first === 'string' ? first : first && first.id) || 'no model loaded';
            }
            dom.statusText.textContent = label;
            dom.input.placeholder = 'Ask for something. It will use tools.';
        } catch {
            offline();
        }
    }

    // No backend: say so where the operator is about to type, rather than
    // letting them write a paragraph and then meet a stack trace.
    function offline() {
        backendOnline = false;
        dom.statusDot.className = 'dot offline';
        dom.statusText.textContent = 'no model server';
        dom.send.disabled = true;
        dom.input.placeholder = 'No model server — click the status pill to retry, or open Settings.';
    }

    function refreshContext() {
        let usage = null;
        try { usage = TricorderLLM.getContextUsage(); } catch { /* engine not ready */ }
        if (!usage) { dom.contextVal.textContent = '0%'; return; }
        const percent = Math.round(usage.percent || 0);
        dom.contextVal.textContent = `${percent}%`;
        $('btn-context').classList.toggle('warn', percent >= 85);
    }

    function refreshPills() {
        const s = TricorderLLM.settings;
        dom.toolsVal.textContent = s.internetAccess ? 'ON' : 'OFF';
        $('btn-tools').classList.toggle('off', !s.internetAccess);
        dom.effortVal.textContent = (TricorderLLM.EFFORT_LABELS && TricorderLLM.EFFORT_LABELS[s.effort]) || String(s.effort || '').toUpperCase();
    }

    /* ── PANEL ─────────────────────────────────────────────────────────── */

    function openPanel(tab) {
        dom.panel.hidden = false;
        dom.scrim.hidden = false;
        if (tab) selectTab(tab);
    }

    function selectTab(name) {
        document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.tab === name));
        ['settings', 'history', 'memory', 'tasks'].forEach((t) => { $(`tab-${t}`).hidden = t !== name; });
        // Each tab reads live state, so refresh on open rather than on boot —
        // the model list in particular is empty until the backend answers.
        if (name === 'settings') loadSettingsUi();
        if (name === 'history') refreshHistory();
        if (name === 'memory') refreshMemory();
        if (name === 'tasks') refreshTasks();
    }
    function closePanel() {
        dom.panel.hidden = true;
        dom.scrim.hidden = true;
    }

    /* ── SETTINGS ──────────────────────────────────────────────────────── */

    function loadSettingsUi() {
        const s = TricorderLLM.settings;
        $('set-url').value = s.lmStudioUrl || '';
        $('set-effort').value = s.effort || 'medium';
        $('set-context').value = s.contextWindow || '';
        $('set-tools').checked = !!s.internetAccess;
        $('set-confirm').checked = !!s.confirmCodeChanges;
        $('set-compress').checked = !!s.autoCompress;
        // Defaults ON, so an absent value is not "off" — an older saved
        // settings blob predates this key entirely.
        $('set-preserve-thinking').checked = s.preserveThinking !== false;
        $('set-sfx').checked = !!s.sfx;
        refreshModelList();
        refreshInstallInfo();
    }

    async function refreshModelList() {
        const select = $('set-model');
        const current = TricorderLLM.settings.model || '';
        select.innerHTML = '<option value="">auto — first loaded model</option>';
        let models = [];
        try { models = await TricorderLLM.fetchModels(); } catch { /* offline */ }
        for (const m of models) {
            const id = typeof m === 'string' ? m : (m && m.id);
            if (!id) continue;
            const opt = document.createElement('option');
            opt.value = id;
            opt.textContent = id;
            opt.selected = id === current;
            select.appendChild(opt);
        }
        const note = $('set-model-note');
        // Same wording the setup wizard and `npm run setup` use, because it
        // comes from the same scorer — see server/model-profiles.js.
        if (!models.length) note.textContent = 'No models listed — is the backend running?';
        else if (/qwen[-_. ]?3\.8[-_. ]?27b/i.test(current)) note.textContent = 'Qwen3.8-27B — what this agent targets.';
        else if (/qwen[-_. ]?3\.8/i.test(current)) note.textContent = 'Qwen3.8 generation — the right family, a different size.';
        else note.textContent = 'Qwen3.8-27B is what this agent targets. Anything with tool calling works.';
    }

    async function refreshInstallInfo() {
        const dl = $('set-info');
        dl.innerHTML = '';
        let info = {};
        try { info = await (await fetch('/api/setup/state')).json(); } catch { /* offline */ }
        const rows = [
            ['Workspace', info.workspace || '—'],
            ['Platform', info.platform || '—'],
            ['Node', info.nodeVersion || '—'],
            ['Shell tools', info.shellEnabled === false ? 'disabled' : 'enabled'],
            ['Code sandbox', info.codeExecEnabled === false ? 'disabled' : 'enabled (docker)'],
            ['Password', info.authEnabled ? 'set' : 'not set (local only)'],
        ];
        for (const [k, v] of rows) {
            const div = document.createElement('div');
            div.innerHTML = `<dt></dt><dd></dd>`;
            div.querySelector('dt').textContent = k;
            div.querySelector('dd').textContent = v;
            dl.appendChild(div);
        }
    }

    function bindSettings() {
        const save = (patch) => { TricorderLLM.saveSettings(patch); refreshPills(); };

        $('set-url').addEventListener('change', (e) => {
            save({ lmStudioUrl: e.target.value.trim() });
            refreshStatus();
            refreshModelList();
        });
        $('set-model').addEventListener('change', (e) => { save({ model: e.target.value }); refreshStatus(); });
        $('set-effort').addEventListener('change', (e) => save({ effort: e.target.value }));
        $('set-context').addEventListener('change', (e) => save({ contextWindow: parseInt(e.target.value, 10) || 0 }));
        $('set-tools').addEventListener('change', (e) => save({ internetAccess: e.target.checked }));
        $('set-confirm').addEventListener('change', (e) => save({ confirmCodeChanges: e.target.checked }));
        $('set-compress').addEventListener('change', (e) => save({ autoCompress: e.target.checked }));
        $('set-preserve-thinking').addEventListener('change', (e) => save({ preserveThinking: e.target.checked }));
        $('set-sfx').addEventListener('change', (e) => save({ sfx: e.target.checked }));

        $('btn-rerun-setup').addEventListener('click', () => {
            closePanel();
            TricorderSetup.open({ onFinish: () => { loadSettingsUi(); refreshStatus(); refreshPills(); } });
        });
        $('btn-clear-chat').addEventListener('click', () => {
            if (!confirm('Clear this conversation? Saved chats in History are kept.')) return;
            newChat();
            closePanel();
        });
    }

    /* ── HISTORY ───────────────────────────────────────────────────────── */

    function refreshHistory() {
        const list = $('history-list');
        let chats = [];
        try { chats = TricorderLLM.getSavedChats() || []; } catch { /* none yet */ }
        if (!chats.length) {
            list.innerHTML = '<div class="list-empty">No saved conversations yet.</div>';
            return;
        }
        list.innerHTML = '';
        for (const chat of chats) {
            const item = document.createElement('div');
            item.className = 'list-item';
            item.innerHTML = `
                <span class="grow">
                    <span class="title"></span>
                    <span class="sub"></span>
                </span>
                <button type="button" title="Delete">✕</button>`;
            item.querySelector('.title').textContent = chat.title || 'Untitled';
            item.querySelector('.sub').textContent = chat.updatedAt
                ? new Date(chat.updatedAt).toLocaleString()
                : `${chat.messageCount || 0} messages`;
            item.querySelector('.grow').addEventListener('click', () => {
                loadChat(chat.id);
                closePanel();
            });
            item.querySelector('button').addEventListener('click', (ev) => {
                ev.stopPropagation();
                TricorderLLM.deleteChat(chat.id);
                refreshHistory();
            });
            list.appendChild(item);
        }
    }

    function renderHistoryMessages(messages) {
        dom.transcript.querySelectorAll('.msg').forEach((n) => n.remove());
        for (const m of messages || []) {
            if (m.role === 'user') {
                const text = typeof m.content === 'string'
                    ? m.content
                    : (Array.isArray(m.content) ? m.content.filter((p) => p.type === 'text').map((p) => p.text).join(' ') : '');
                if (text) addMessage('user', text);
            } else if (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) {
                addMessage('agent', m.content);
            }
        }
        scrollDown(true);
    }

    function loadChat(id) {
        try {
            TricorderLLM.loadChat(id);
            renderHistoryMessages(TricorderLLM.history);
            hideWelcome();
            refreshContext();
        } catch (err) {
            toast(`Could not load that chat: ${err.message}`);
        }
    }

    function newChat() {
        TricorderLLM.saveCurrentChat();
        TricorderLLM.clearHistory();
        TricorderLLM.resetApprovalSession();
        dom.transcript.querySelectorAll('.msg').forEach((n) => n.remove());
        dom.approvals.innerHTML = '';
        if (dom.welcome) dom.welcome.hidden = false;
        dom.turnStat.textContent = '';
        refreshContext();
        refreshHistory();
    }

    /* ── MEMORY ────────────────────────────────────────────────────────── */

    async function refreshMemory() {
        const list = $('memory-list');
        list.innerHTML = '<div class="list-empty">Loading…</div>';
        let data = { entries: [] };
        try { data = await (await fetch('/api/memory')).json(); } catch { /* offline */ }
        const entries = data.entries || [];
        if (!entries.length) {
            list.innerHTML = '<div class="list-empty">Nothing remembered yet. The agent adds facts as it learns them.</div>';
            return;
        }
        list.innerHTML = '';
        for (const entry of entries) {
            const item = document.createElement('div');
            item.className = 'list-item';
            item.innerHTML = `
                <span class="grow"><span class="title"></span><span class="sub"></span></span>
                <button type="button" title="Forget">✕</button>`;
            item.querySelector('.title').textContent = entry.key;
            item.querySelector('.sub').textContent = entry.value;
            item.querySelector('button').addEventListener('click', async () => {
                await fetch(`/api/memory/${encodeURIComponent(entry.key)}`, { method: 'DELETE' }).catch(() => {});
                refreshMemory();
            });
            list.appendChild(item);
        }
    }

    function bindMemory() {
        $('mem-add').addEventListener('click', async () => {
            const key = $('mem-key').value.trim();
            const value = $('mem-value').value.trim();
            if (!key || !value) { toast('Both a key and a value are needed.'); return; }
            await fetch('/api/memory', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key, value }),
            }).catch(() => {});
            $('mem-key').value = '';
            $('mem-value').value = '';
            refreshMemory();
        });
    }

    /* ── TASKS ─────────────────────────────────────────────────────────── */

    async function refreshTasks() {
        const list = $('tasks-list');
        list.innerHTML = '<div class="list-empty">Loading…</div>';
        let data = { tasks: [] };
        try { data = await (await fetch('/api/tasks/list')).json(); } catch { /* offline */ }
        const tasks = data.tasks || [];
        if (!tasks.length) {
            list.innerHTML = '<div class="list-empty">No scheduled tasks.</div>';
            return;
        }
        list.innerHTML = '';
        for (const task of tasks) {
            const item = document.createElement('div');
            item.className = 'list-item';
            item.innerHTML = `
                <span class="grow"><span class="title"></span><span class="sub"></span></span>
                <button type="button" title="Delete">✕</button>`;
            item.querySelector('.title').textContent = task.name || task.id;
            item.querySelector('.sub').textContent = [
                task.schedule || '',
                task.enabled === false ? 'disabled' : '',
                task.nextRun ? `next ${new Date(task.nextRun).toLocaleString()}` : '',
            ].filter(Boolean).join(' · ');
            item.querySelector('button').addEventListener('click', async () => {
                await fetch(`/api/tasks/delete/${encodeURIComponent(task.id)}`, { method: 'DELETE' }).catch(() => {});
                refreshTasks();
            });
            list.appendChild(item);
        }
    }

    /* ── COMPOSER ──────────────────────────────────────────────────────── */

    function autoGrow() {
        dom.input.style.height = 'auto';
        dom.input.style.height = Math.min(dom.input.scrollHeight, window.innerHeight * 0.4) + 'px';
    }

    function bindComposer() {
        dom.input.addEventListener('input', autoGrow);
        dom.input.addEventListener('keydown', (ev) => {
            // Enter sends; Shift+Enter is a newline. On touch keyboards Enter
            // is usually a newline, so only bind it when a real keyboard is likely.
            if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing && window.matchMedia('(hover: hover)').matches) {
                ev.preventDefault();
                send();
            }
        });
        dom.send.addEventListener('click', () => send());
        dom.stop.addEventListener('click', () => {
            TricorderLLM.stopGeneration();
            toast('Stopping…');
        });

        $('btn-tools').addEventListener('click', () => {
            const next = !TricorderLLM.settings.internetAccess;
            TricorderLLM.saveSettings({ internetAccess: next });
            refreshPills();
            loadSettingsUi();
            toast(next ? 'Tools on — the agent can act.' : 'Tools off — chat only.');
        });

        $('btn-effort').addEventListener('click', () => {
            const cycle = TricorderLLM.EFFORT_CYCLE || ['none', 'low', 'medium', 'max'];
            const current = TricorderLLM.settings.effort || 'medium';
            const next = cycle[(cycle.indexOf(current) + 1) % cycle.length];
            TricorderLLM.saveSettings({ effort: next });
            refreshPills();
            loadSettingsUi();
        });

        $('btn-context').addEventListener('click', async () => {
            if (TricorderLLM.isProcessing) { toast('Busy — try again when the turn is done.'); return; }
            toast('Compressing the conversation…');
            try {
                await TricorderLLM.compressContext();
                toast('Compressed.');
            } catch (err) {
                toast(`Could not compress: ${err.message}`);
            }
            refreshContext();
        });

        document.querySelectorAll('#starters .chip').forEach((chip) => {
            chip.addEventListener('click', () => send(chip.dataset.prompt));
        });
    }

    /* ── BOOT ──────────────────────────────────────────────────────────── */

    function bindShell() {
        $('btn-menu').addEventListener('click', () => openPanel('settings'));
        $('btn-new').addEventListener('click', newChat);
        $('panel-close').addEventListener('click', closePanel);
        dom.scrim.addEventListener('click', closePanel);
        $('status-pill').addEventListener('click', refreshStatus);
        document.querySelectorAll('.tab').forEach((t) => {
            t.addEventListener('click', () => selectTab(t.dataset.tab));
        });
        document.addEventListener('keydown', (ev) => {
            if (ev.key === 'Escape') {
                if (!dom.panel.hidden) closePanel();
                else if (TricorderLLM.isProcessing) TricorderLLM.stopGeneration();
            }
        });
        // Copy buttons inside rendered code blocks (delegated — blocks are
        // re-rendered on every streamed chunk).
        dom.transcript.addEventListener('click', (ev) => {
            if (!ev.target.matches('[data-copy]')) return;
            const pre = ev.target.closest('.code-block').querySelector('code');
            navigator.clipboard.writeText(pre.textContent).then(
                () => toast('Copied.'),
                () => toast('Could not copy.')
            );
        });
    }

    async function boot() {
        bindShell();
        bindComposer();
        bindSettings();
        bindMemory();

        TricorderLLM.setToolApprovalHandler(askApproval);
        loadSettingsUi();
        refreshPills();
        refreshContext();

        // Restore the conversation the tab was in the middle of, if any.
        try {
            if (TricorderLLM.restoreSession && TricorderLLM.restoreSession()) {
                renderHistoryMessages(TricorderLLM.history);
            }
        } catch { /* nothing to restore */ }

        // The setup guide decides for itself whether it is needed.
        await TricorderSetup.maybeRun({
            onFinish: () => { loadSettingsUi(); refreshStatus(); refreshPills(); },
        });

        refreshStatus();
        setInterval(refreshStatus, 30000);

        // Keep the model warm between turns so the first token is fast.
        try { TricorderLLM.startKeepAlive(); } catch { /* optional */ }

        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('/sw.js').catch(() => { /* offline support is a bonus */ });
        }
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
