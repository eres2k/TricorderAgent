'use strict';
// ============================================================================
// Durable LLM generation manager
// ----------------------------------------------------------------------------
// Makes a single model turn survive the client's connection. The browser starts
// a generation, the SERVER owns the upstream LLM stream, buffers every chunk
// with a monotonic sequence number, and persists a recoverable text floor to
// disk. A client that drops (locked phone, Wi-Fi↔LTE switch, tab switch) simply
// re-subscribes with a cursor and gets the chunks it missed, then resumes live —
// no duplication, no gaps. The generation continues regardless of whether anyone
// is listening, and the final (or partial) message is always persisted.
//
// This module is deliberately transport- and backend-agnostic so it can be unit
// tested in isolation:
//   - `backend(routing, body, { onData, onDone, onError, signal })` performs the
//     actual upstream streaming call (one onData(payloadString) per backend
//     `data:` line, payload already stripped of the "data: " prefix and never
//     "[DONE]"). server.js supplies the real LM Studio implementation.
//   - `store` persists the recoverable floor (default: JSON files on disk).
//
// Concurrency note: Node is single-threaded, so pushFrame()/finalize()/subscribe()
// run to completion without interleaving. That is the entire lock — there is no
// window in which a chunk is neither in the replay buffer nor delivered live, so
// the classic "reconnect at the exact millisecond the stream finishes" race is
// structurally impossible here. See subscribe() / finalize().
// ============================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TERMINAL = new Set(['completed', 'error', 'cancelled', 'interrupted']);

function sha1(s) {
    return crypto.createHash('sha1').update(s || '').digest('hex').slice(0, 12);
}

// --- Default persistence: one JSON file per generation under `dir`. -----------
function fileStore(dir) {
    let ensured = false;
    const ensure = () => { if (!ensured) { fs.mkdirSync(dir, { recursive: true }); ensured = true; } };
    const file = (id) => path.join(dir, `${id}.json`);
    return {
        save(id, obj) {
            try { ensure(); fs.writeFileSync(file(id), JSON.stringify(obj), 'utf8'); } catch { /* best-effort */ }
        },
        load(id) {
            try { return JSON.parse(fs.readFileSync(file(id), 'utf8')); } catch { return null; }
        },
        remove(id) { try { fs.unlinkSync(file(id)); } catch { /* gone */ } },
        list() {
            try { ensure(); return fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)); }
            catch { return []; }
        },
    };
}

// --- One live generation. ----------------------------------------------------
class GenerationSession {
    constructor(opts) {
        this.generationId = opts.generationId;
        this.chatId = opts.chatId || null;
        this.routing = opts.routing || {};
        this.body = opts.body || {};
        this.cfg = opts.cfg;
        this.store = opts.store;
        this.log = opts.log;
        this.onEvict = opts.onEvict;

        this.status = 'queued';
        this.seq = 0;                 // next seq to assign
        this.firstSeq = 0;            // low-water mark held in `frames`
        this.frames = [];             // ring of { seq, type, data }
        this.text = '';               // recoverable assistant-text floor
        this.finishReason = null;
        this.error = null;
        this.subscribers = new Set(); // Set<(frame) => void>
        this.abort = new AbortController();
        this.createdAt = Date.now();
        this.updatedAt = this.createdAt;

        this._sinceCheckpoint = 0;
        this._lastCheckpoint = 0;
        this._idle = null;
        this._evictTimer = null;
        this._toolCallSeen = false;   // widens the idle window (see _armIdle)
    }

    // --- All three of these are synchronous; that is the concurrency lock. ----

    _emit(frame) {
        this.frames.push(frame);
        if (this.frames.length > this.cfg.ringMax) {
            const drop = this.frames.length - this.cfg.ringMax;
            this.frames.splice(0, drop);
            this.firstSeq = this.frames[0].seq;
        }
        for (const write of this.subscribers) {
            try { write(frame); } catch { /* dead socket — its own close handler unsubscribes */ }
        }
    }

    // A raw backend payload (already stripped of "data: ", never "[DONE]").
    pushFrame(payload) {
        if (TERMINAL.has(this.status)) return;
        if (this.status === 'queued') this.status = 'streaming';
        const frame = { seq: this.seq++, type: 'data', data: payload };
        this._accumulate(payload);
        this.updatedAt = Date.now();
        this._emit(frame);
        this._armIdle();
        if (++this._sinceCheckpoint >= this.cfg.checkpointEvery ||
            Date.now() - this._lastCheckpoint >= this.cfg.checkpointMs) {
            this._checkpoint();
        }
    }

    // Idempotent terminal transition (compare-and-set on status). The terminal
    // `end` frame is just the final entry in the same seq'd stream, so replay and
    // live delivery are unified and the finish/attach race cannot drop it.
    finalize(status, extra = {}) {
        if (TERMINAL.has(this.status)) return;   // late duplicate end → ignore
        this.status = status;
        if (extra.finishReason) this.finishReason = extra.finishReason;
        if (extra.reason) this.error = extra.reason;
        this._clearIdle();
        const frame = {
            seq: this.seq++,
            type: 'end',
            data: { status, finishReason: this.finishReason, reason: this.error || null, hash: sha1(this.text) },
        };
        this._emit(frame);
        this._checkpoint(true);
        this._scheduleEvict();
    }

    // Atomic replay-from-cursor + live attach. No `await` between reading the ring
    // and joining the subscriber set, so nothing slips through. Returns unsubscribe.
    subscribe(cursor, write) {
        if (cursor < this.firstSeq - 1) {
            // The client's cursor predates what we still hold in RAM — hand it a
            // snapshot to resync from rather than a gap.
            write({ seq: this.seq, type: 'snapshot', data: { status: this.status, text: this.text, baseSeq: this.seq } });
        } else {
            for (const f of this.frames) if (f.seq > cursor) write(f);
        }
        if (TERMINAL.has(this.status)) return () => {};   // nothing more will ever come
        this.subscribers.add(write);
        if (this._evictTimer) { clearTimeout(this._evictTimer); this._evictTimer = null; }
        return () => { this.subscribers.delete(write); };
    }

    snapshot() {
        return {
            generationId: this.generationId, chatId: this.chatId, status: this.status,
            seq: this.seq, text: this.text, finishReason: this.finishReason, error: this.error,
            updatedAt: this.updatedAt,
        };
    }

    cancel() {
        if (TERMINAL.has(this.status)) return;
        try { this.abort.abort(); } catch { /* already */ }
        this.finalize('cancelled');
    }

    _accumulate(payload) {
        try {
            const parsed = JSON.parse(payload);
            const choice = parsed.choices && parsed.choices[0];
            const delta = choice && choice.delta && choice.delta.content;
            if (typeof delta === 'string') this.text += delta;
            if (choice && choice.delta && choice.delta.tool_calls) this._toolCallSeen = true;
            if (choice && choice.finish_reason) this.finishReason = choice.finish_reason;
        } catch { /* non-JSON keepalive or partial — ignore for the text floor */ }
    }

    _armIdle() {
        this._clearIdle();
        // While the model is generating tool-call arguments, some backends
        // (LM Studio's llama.cpp tool parser) buffer the entire arguments JSON
        // and send nothing until the call completes — a big file write means
        // minutes of silence on a healthy stream. Once a tool_calls delta has
        // been seen, allow the much wider toolIdleMs window.
        const ms = this._toolCallSeen ? this.cfg.toolIdleMs : this.cfg.idleMs;
        this._idle = setTimeout(() => {
            this.error = 'Model went silent — upstream stalled';
            try { this.abort.abort(); } catch { /* */ }
            this.finalize('error', { reason: this.error });
            if (this.log) this.log('WARN', 'DURABLE', `${this.generationId} idle-timeout after ${ms}ms`);
        }, ms);
        if (this._idle.unref) this._idle.unref();
    }
    _clearIdle() { if (this._idle) { clearTimeout(this._idle); this._idle = null; } }

    _checkpoint(final = false) {
        this._sinceCheckpoint = 0;
        this._lastCheckpoint = Date.now();
        this.store.save(this.generationId, {
            generationId: this.generationId, chatId: this.chatId, status: this.status,
            seq: this.seq, text: this.text, finishReason: this.finishReason, error: this.error,
            createdAt: this.createdAt, updatedAt: this.updatedAt, final,
        });
    }

    _scheduleEvict() {
        if (this._evictTimer) clearTimeout(this._evictTimer);
        this._evictTimer = setTimeout(() => {
            if (this.subscribers.size === 0 && this.onEvict) this.onEvict(this.generationId);
        }, this.cfg.evictTtlMs);
        if (this._evictTimer.unref) this._evictTimer.unref();
    }
}

// --- Registry + lifecycle. ---------------------------------------------------
function createDurableManager(opts = {}) {
    const cfg = {
        ringMax: opts.ringMax || 16384,         // generous — never evicts during a live turn
        idleMs: opts.idleMs || 120000,          // abort upstream after this much silence
        toolIdleMs: opts.toolIdleMs || 600000,  // silence allowance once a tool call has started (buffered args)
        checkpointEvery: opts.checkpointEvery || 24,
        checkpointMs: opts.checkpointMs || 1500,
        evictTtlMs: opts.evictTtlMs || 5 * 60000,
    };
    const backend = opts.backend;               // required: performs the upstream call
    const store = opts.store || fileStore(opts.dir || path.join(require('os').homedir(), '.tricorder', 'generations'));
    const log = opts.log || (() => {});

    const sessions = new Map();                 // generationId → GenerationSession

    function get(id) { return sessions.get(id) || null; }

    // Idempotent by generationId: a retried /generate (e.g. the client reconnected
    // before the first response landed) returns the existing session, never a
    // second upstream call.
    function start({ generationId, chatId, routing, body }) {
        const id = generationId || crypto.randomUUID();
        const existing = sessions.get(id);
        if (existing) return existing;

        const session = new GenerationSession({
            generationId: id, chatId, routing, body, cfg, store, log,
            onEvict: (gid) => sessions.delete(gid),
        });
        sessions.set(id, session);
        session._checkpoint();   // write the floor immediately so a crash 1ms in is still recoverable

        // Detached: the request that called start() may already be gone; the loop
        // keeps running and finalizing on its own.
        Promise.resolve().then(() => backend(routing, body, {
            signal: session.abort.signal,
            onData: (payload) => session.pushFrame(payload),
            onDone: () => session.finalize('completed', { finishReason: session.finishReason || 'stop' }),
            onError: (err) => {
                if (session.abort.signal.aborted) return;   // cancel/idle already finalized
                session.finalize('error', { reason: (err && err.message) || String(err) });
            },
        })).catch((err) => {
            if (!session.abort.signal.aborted) session.finalize('error', { reason: (err && err.message) || String(err) });
        });

        return session;
    }

    function getState(id) {
        const live = sessions.get(id);
        if (live) return live.snapshot();
        const disk = store.load(id);
        if (!disk) return null;
        return {
            generationId: id, chatId: disk.chatId || null, status: disk.status,
            seq: disk.seq, text: disk.text, finishReason: disk.finishReason || null,
            error: disk.error || null, updatedAt: disk.updatedAt,
        };
    }

    function cancel(id) {
        const live = sessions.get(id);
        if (live) { live.cancel(); return true; }
        return false;
    }

    // Boot recovery: any session left mid-stream by a crash/restart can't have its
    // upstream resumed, but its checkpointed text is intact. Flip it to
    // `interrupted` so the client surfaces the partial + a "continue" affordance
    // instead of a spinner that never resolves.
    function recoverInterrupted() {
        let n = 0;
        for (const id of store.list()) {
            const disk = store.load(id);
            if (disk && !TERMINAL.has(disk.status)) {
                disk.status = 'interrupted';
                disk.error = disk.error || 'Server restarted mid-generation';
                disk.updatedAt = Date.now();
                store.save(id, disk);
                n++;
            }
        }
        if (n) log('INFO', 'DURABLE', `Recovered ${n} interrupted generation(s) after restart`);
        return n;
    }

    return { start, get, getState, cancel, recoverInterrupted, _sessions: sessions, cfg, TERMINAL };
}

module.exports = { createDurableManager, fileStore, TERMINAL };
