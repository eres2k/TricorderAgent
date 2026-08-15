/* ============================================
   Durable chat streaming (client)
   --------------------------------------------
   Claude/ChatGPT-app-style resilience for a model turn. The generation is owned
   by the SERVER (see server/durable-stream.js); this module is just a re-attachable
   listener. It exposes two things:

     1. open(body, opts) → a drop-in replacement for the fetch() Response that
        TricorderLLM.streamSingleRequest() consumes. Under the hood it starts a
        server-owned generation and returns a reader that transparently reconnects
        + resumes by cursor when the socket drops (locked phone, Wi-Fi↔LTE switch,
        backgrounded tab). The wire format is identical SSE (`data: {...}` / end),
        so the existing token/tool-call parser is reused verbatim — no dup, no drop.

     2. attachToActiveGeneration(chatId, cbs) → resume DISPLAY of a chat whose
        generation is still running (or already finished) after navigating away or
        reloading. This is the per-chat isolation hook: each chat tracks its own
        active generationId in localStorage, so Chat A keeps generating while you
        work in Chat B, and returning to A re-attaches (or shows the finished text).

   Loaded by index.html immediately before js/llm.js so TricorderLLM can find it.
   Disable at runtime with localStorage['tricorder.durableStreaming'] = 'off'.
   ============================================ */

const TricorderDurableStream = (() => {
    const ORIGIN = window.location.origin;
    const ACTIVE_KEY = 'tricorder.activeGenerations';
    const FLAG_KEY = 'tricorder.durableStreaming';
    const enc = new TextEncoder();
    const dec = new TextDecoder();

    function uuid() {
        try { return crypto.randomUUID(); }
        catch { return 'gen_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10); }
    }
    function sleep(ms, signal) {
        return new Promise((resolve) => {
            const t = setTimeout(resolve, ms);
            signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
        });
    }

    // --- Per-chat active-generation registry (isolation + reload resume) ------
    const registry = {
        _map: (() => { try { return JSON.parse(localStorage.getItem(ACTIVE_KEY)) || {}; } catch { return {}; } })(),
        _persist() { try { localStorage.setItem(ACTIVE_KEY, JSON.stringify(this._map)); } catch { /* private mode */ } },
        getActive(chatId) { return (chatId && this._map[chatId]) || null; },
        setActive(chatId, genId) { if (!chatId) return; this._map[chatId] = genId; this._persist(); },
        clear(chatId) { if (chatId && this._map[chatId]) { delete this._map[chatId]; this._persist(); } },
    };

    function fireCancel(generationId, headers) {
        if (!generationId) return;
        try {
            fetch(`${ORIGIN}/api/llm/cancel/${encodeURIComponent(generationId)}`, { method: 'POST', headers: headers || {}, keepalive: true })
                .catch(() => {});
        } catch { /* best-effort */ }
    }

    // --- The resumable reader: mimics ReadableStreamDefaultReader -------------
    // read() yields Uint8Array chunks of `data: <payload>\n\n` exactly as the
    // backend would, so the downstream SSE parser is none the wiser. On a mid-turn
    // socket drop it reconnects from the last applied sequence and continues.
    class DurableReader {
        constructor(generationId, { signal, headers, chatId }) {
            this.generationId = generationId;
            this.signal = signal;
            this.headers = headers || {};
            this.chatId = chatId || null;
            this.cursor = -1;             // last applied data-frame seq
            this.maxReconnect = 60;       // ~ up to a few minutes of flaky network
            this._raw = null;             // underlying body reader
            this._ctl = new AbortController();
            this._sseBuf = '';
            this._outQueue = [];
            this._done = false;
            this._error = null;
            this._emittedAny = false;
            this.status = null;
            this.finishReason = null;
            // Forward an external Stop (turn signal) onto our internal controller,
            // and tell the server to actually stop generating.
            if (signal) signal.addEventListener('abort', () => {
                this._stopped = true;
                try { this._ctl.abort(); } catch { /* */ }
                fireCancel(this.generationId, this.headers);
            }, { once: true });
        }

        async _connect() {
            const url = `${ORIGIN}/api/llm/stream/${encodeURIComponent(this.generationId)}?cursor=${this.cursor}`;
            const res = await fetch(url, {
                headers: { ...this.headers, 'Last-Event-ID': String(this.cursor) },
                signal: this._ctl.signal,
                cache: 'no-store',
            });
            if (!res.ok || !res.body) throw new Error(`durable stream HTTP ${res.status}`);
            this._raw = res.body.getReader();
            this._sseBuf = '';
        }

        async _reconnect() {
            this._raw = null;
            for (let attempt = 0; attempt < this.maxReconnect; attempt++) {
                if (this._stopped || this.signal?.aborted) return false;
                await sleep(Math.min(300 * Math.pow(2, attempt), 5000), this.signal);
                if (this._stopped || this.signal?.aborted) return false;
                try { await this._connect(); return true; } catch { /* keep retrying */ }
            }
            return false;
        }

        _handleFrame(raw) {
            let id = null, event = 'message';
            const dataLines = [];
            for (const line of raw.split('\n')) {
                if (line.startsWith(':')) continue;                 // keepalive/comment
                if (line.startsWith('id:')) id = Number(line.slice(3).trim());
                else if (line.startsWith('event:')) event = line.slice(6).trim();
                else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
            }
            const data = dataLines.join('\n');

            if (event === 'data') {
                if (id != null && id <= this.cursor) return;        // exactly-once: drop replay overlap
                if (id != null) this.cursor = id;
                this._emittedAny = true;
                this._outQueue.push(enc.encode(`data: ${data}\n\n`));
            } else if (event === 'end') {
                if (id != null && id > this.cursor) this.cursor = id;
                let payload = {}; try { payload = JSON.parse(data); } catch { /* */ }
                this.status = payload.status || 'completed';
                this.finishReason = payload.finishReason || null;
                // Rare: generation already finished before we attached and we only
                // got an `end` carrying the full text. Synthesize one delta so the
                // downstream parser renders it instead of showing nothing.
                if (!this._emittedAny && payload.text) {
                    this._outQueue.push(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: payload.text }, finish_reason: this.finishReason || 'stop' }] })}\n\n`));
                    this._emittedAny = true;
                }
                this._done = true;
                if (this.chatId && registry.getActive(this.chatId) === this.generationId) registry.clear(this.chatId);
            } else if (event === 'snapshot') {
                // An in-flight reader should never fall behind the server's ring
                // buffer (16k frames). If it somehow does, fail the turn cleanly
                // rather than silently corrupt the reconstructed text.
                this._error = new Error('durable stream fell behind the buffer window');
                this._done = true;
            }
        }

        _feed(bytes) {
            this._sseBuf += dec.decode(bytes, { stream: true });
            let idx;
            while ((idx = this._sseBuf.indexOf('\n\n')) !== -1) {
                const raw = this._sseBuf.slice(0, idx);
                this._sseBuf = this._sseBuf.slice(idx + 2);
                this._handleFrame(raw);
            }
        }

        async read() {
            while (true) {
                if (this._outQueue.length) return { value: this._outQueue.shift(), done: false };
                if (this._error) { const e = this._error; this._error = null; throw e; }
                if (this._done) return { value: undefined, done: true };
                if (this._stopped || this.signal?.aborted) throw new DOMException('Aborted', 'AbortError');

                if (!this._raw) {
                    try { await this._connect(); }
                    catch (e) {
                        if (this._stopped || this.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
                        if (!(await this._reconnect())) throw e;
                    }
                    continue;
                }

                let chunk;
                try { chunk = await this._raw.read(); }
                catch (e) {
                    if (this._stopped || this.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
                    if (!(await this._reconnect())) throw e;     // transient drop → resume by cursor
                    continue;
                }

                if (chunk.done) {
                    this._raw = null;
                    if (this._done) return { value: undefined, done: true };
                    // Socket closed without a terminal frame → the generation may
                    // still be running server-side. Reconnect and catch up.
                    if (!(await this._reconnect())) {
                        if (this._stopped || this.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
                        throw new Error('durable stream ended without completion');
                    }
                    continue;
                }
                this._feed(chunk.value);
            }
        }

        cancel() {
            this._stopped = true;
            this._done = true;
            try { this._ctl.abort(); } catch { /* */ }
            fireCancel(this.generationId, this.headers);
            if (this.chatId) registry.clear(this.chatId);
            return Promise.resolve();
        }
    }

    // --- Public: drop-in for fetch() in streamSingleRequest ------------------
    async function open(body, { signal, headers = {}, chatId } = {}) {
        const generationId = uuid();
        const startHeaders = { 'Content-Type': 'application/json', ...headers, 'X-Generation-Id': generationId };
        if (chatId) startHeaders['X-Chat-Id'] = chatId;

        let res;
        try {
            res = await fetch(`${ORIGIN}/api/llm/generate`, {
                method: 'POST', headers: startHeaders, body: JSON.stringify(body), signal,
            });
        } catch (e) {
            if (signal?.aborted) fireCancel(generationId, headers);
            return { ok: false, status: 0, body: null, _text: e.message };
        }
        if (!res.ok) {
            let t = ''; try { t = await res.text(); } catch { /* */ }
            return { ok: false, status: res.status, body: null, _text: t };
        }
        if (chatId) registry.setActive(chatId, generationId);
        const reader = new DurableReader(generationId, { signal, headers, chatId });
        return { ok: true, status: res.status, body: { getReader: () => reader }, generationId };
    }

    // --- Public: resume DISPLAY of a chat's active/finished generation -------
    // Lightweight, parser-independent text consumer for the UI to call on chat
    // open / page load. Returns the generationId it attached to, or null.
    //   cbs: { onText(fullText, delta), onStatus(status), onDone(state), signal }
    async function attachToActiveGeneration(chatId, cbs = {}) {
        const genId = registry.getActive(chatId);
        if (!genId) return null;

        let state;
        try {
            const r = await fetch(`${ORIGIN}/api/llm/state/${encodeURIComponent(genId)}`, { cache: 'no-store' });
            if (r.status === 404) { registry.clear(chatId); return null; }
            state = await r.json();
        } catch { return null; }

        cbs.onStatus?.(state.status);

        if (['completed', 'error', 'cancelled', 'interrupted'].includes(state.status)) {
            if (state.text) cbs.onText?.(state.text, '');
            // Consume once: clear the mapping so a later reopen doesn't re-attach
            // and append this same answer to the chat again.
            registry.clear(chatId);
            cbs.onDone?.(state);
            return genId;
        }

        // Still live — rebuild the full text from the start of the buffer (cursor
        // -1) rather than seeding from the snapshot, otherwise the replayed frames
        // would double-count the tokens already in state.text.
        const reader = new DurableReader(genId, { signal: cbs.signal, headers: {}, chatId });
        let text = '';
        (async () => {
            try {
                while (true) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    const line = dec.decode(value).trim();
                    if (!line.startsWith('data:')) continue;
                    const payload = line.slice(5).trim();
                    if (!payload || payload === '[DONE]') continue;
                    try {
                        const j = JSON.parse(payload);
                        const d = j.choices?.[0]?.delta?.content;
                        if (typeof d === 'string' && d) { text += d; cbs.onText?.(text, d); }
                    } catch { /* skip */ }
                }
            } catch { /* aborted or ended */ }
            let final = state;
            try { final = await (await fetch(`${ORIGIN}/api/llm/state/${encodeURIComponent(genId)}`, { cache: 'no-store' })).json(); } catch { /* */ }
            cbs.onStatus?.(final.status);
            cbs.onDone?.(final);
        })();
        return genId;
    }

    return {
        get enabled() { try { return localStorage.getItem(FLAG_KEY) !== 'off'; } catch { return true; } },
        set enabled(v) { try { localStorage.setItem(FLAG_KEY, v ? 'on' : 'off'); } catch { /* */ } },
        open,
        attachToActiveGeneration,
        getActiveGeneration: (chatId) => registry.getActive(chatId),
        clearActiveGeneration: (chatId) => registry.clear(chatId),
        cancel: (generationId, headers) => fireCancel(generationId, headers),
    };
})();

if (typeof window !== 'undefined') window.TricorderDurableStream = TricorderDurableStream;
