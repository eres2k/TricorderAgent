/* ============================================
   LLM Integration (LM Studio)
   All requests route through the server proxy (/llm) to avoid CORS.
   LM Studio exposes the OpenAI-compatible /v1/chat/completions endpoint;
   Tricorder drives the in-app tool layer (native function calling).
   ============================================ */

const TricorderLLM = (() => {
    // --- Native Tool Definitions (OpenAI function-calling format) ---
    // Moved to js/llm-tools/*.js — each category file registers its schemas
    // with TricorderNativeTools (js/llm-tools/registry.js), which index.html
    // loads before this file. The model receives these as `tools` in the
    // request and returns structured `tool_calls` in the response.
    // Tricorder executes them via /api/tools/execute and feeds results back.
    const NATIVE_TOOLS = (typeof TricorderNativeTools !== 'undefined')
        ? TricorderNativeTools.list()
        : [];

    // Maximum number of tool-call rounds before forcing a final answer.
    // Prevents infinite loops where the model keeps calling tools.
    // Increased from 8 to 15 for complex multi-step agentic workflows
    // (e.g. research → read → analyze → write → verify chains).
    const MAX_TOOL_ROUNDS = 15;

    // --- Tiered tool loading ---
    // Shipping all ~100 tool schemas on every request costs ~15k prompt tokens
    // and dilutes tool selection. Instead we advertise a small CORE set plus
    // tool_search; the model loads anything else on demand (a tool_search call
    // activates its matches for the rest of the turn). Execution is never
    // restricted — the server can run any registered tool — so a model that
    // already knows a tool name can still call it directly; tiering only trims
    // what we put in the prompt. The active set resets to CORE every turn —
    // plus a short carry-over of tools the model actually CALLED recently
    // (see beginTurnActiveTools) — so a long session can't slowly re-bloat
    // the prompt.
    const _allToolNames = new Set(
        NATIVE_TOOLS.map(t => t && t.function && t.function.name).filter(Boolean)
    );
    // Kept deliberately small (~7): every schema here is paid for on EVERY
    // request, including a bare "hello". Criteria for core membership:
    // bootstraps most tasks (web, file reading, shell), is mandated by the
    // system prompt on casual turns (memory_store), or is the discovery
    // mechanism itself (tool_search). Everything else — file writing/editing,
    // grep/glob, tasks, todos, GitHub, Google, media, agents … — is one
    // tool_search round away, and the carry-over below keeps it attached
    // across the following turns of a session that actually uses it.
    const CORE_TOOL_NAMES = [
        'tool_search',                    // discovery — without it nothing else is reachable
        'web_search', 'web_fetch',        // live data is mandated for public facts; fetch follows search
        'read_file', 'list_directory',    // orientation + reading; read_file auto-extracts PDF/DOCX/…
        'run_command',                    // universal escape hatch: shell + Python scripting
        'memory_store',                   // prompt mandates proactive storing on casual turns
    ].filter(n => _allToolNames.has(n));
    let _activeToolNames = null; // Set of advertised tool names for the current turn (null = uninitialised)

    // Cross-turn carry-over: tools the model actually CALLED recently stay
    // advertised in the following turns (a multi-turn GitHub session shouldn't
    // pay a tool_search round every turn). Only real invocations count — a
    // tool merely loaded via tool_search decays away with the turn. A carried
    // tool that goes unused for TOOL_CARRY_DECAY_TURNS turns is dropped again
    // so the prompt can't slowly re-bloat.
    const TOOL_CARRY_DECAY_TURNS = 2;
    let _turnCounter = 0;
    const _toolLastUsedTurn = new Map(); // toolName → turn index of the last actual call

    function tieredToolsEnabled() {
        return settings.tieredTools !== false;
    }
    function resetActiveTools() {
        _activeToolNames = new Set(CORE_TOOL_NAMES);
        _activeToolNames.add('tool_search'); // discovery must always be reachable
    }
    // Called at the start of every turn: reset to the core set, then re-add
    // recently-used tools (and expire the ones past their decay window).
    function beginTurnActiveTools() {
        _turnCounter++;
        resetActiveTools();
        for (const [name, usedTurn] of _toolLastUsedTurn) {
            if (_turnCounter - usedTurn > TOOL_CARRY_DECAY_TURNS) {
                _toolLastUsedTurn.delete(name);
            } else {
                _activeToolNames.add(name);
            }
        }
    }
    // Record tools the model actually invoked so beginTurnActiveTools can
    // carry them into the next turn.
    function noteToolsUsed(names) {
        for (const n of names || []) {
            if (_allToolNames.has(n)) _toolLastUsedTurn.set(n, _turnCounter);
        }
    }
    function activateTools(names) {
        if (!_activeToolNames) resetActiveTools();
        for (const n of names || []) if (_allToolNames.has(n)) _activeToolNames.add(n);
    }
    // The tool schemas to advertise this request: full catalogue when tiering is
    // off, otherwise the current active set (never empty — an empty toolset
    // would silently disable tool use).
    function getActiveTools() {
        if (!tieredToolsEnabled()) return NATIVE_TOOLS;
        if (!_activeToolNames) resetActiveTools();
        const active = NATIVE_TOOLS.filter(t => t && t.function && _activeToolNames.has(t.function.name));
        return active.length ? active : NATIVE_TOOLS;
    }


    // --- Personas -------------------------------------------------------------
    // NEUTRAL is not a persona, it is the ABSENCE of one (working mode). Every
    // other style is a persona and shares the same machinery: a prompt block, a
    // per-turn reminder, and the looser sampling that a personality needs and
    // neutral must never get. Keeping them in one table is what stops a new
    // persona from being half-wired — comparing against a literal style name in
    // five unrelated places means adding one silently skips its reminder or its
    // sampling.
    const PERSONAS = {
        // No personas ship with the public build: the default agent is neutral
        // and professional, which is the right default for a tool other people
        // will use. The machinery is intact, so adding one is a table entry:
        //
        //   bones: {
        //       label: 'BONES',
        //       // Injected into the system prompt when this style is selected.
        //       prompt: `\n\n## BONES MODE\nYou are Dr. Leonard "Bones" McCoy: …`,
        //       // Repeated once per turn, because a style set 20 turns ago
        //       // drifts away otherwise.
        //       reminder: 'REMINDER: answer in character as BONES. …',
        //   },
        //
        // Whatever you write, keep the hierarchy the neutral prompt sets out:
        // a persona is COMMUNICATION STYLE ONLY. Tool use, safety and
        // correctness must not change with it, and when charm and accuracy
        // collide, accuracy wins.
    };
    const isPersona = (style) => Object.prototype.hasOwnProperty.call(PERSONAS, style);

    // Style labels for UI
    const STYLE_LABELS = { neutral: 'NEUTRAL', ...Object.fromEntries(Object.entries(PERSONAS).map(([k, p]) => [k, p.label])) };
    const STYLE_CYCLE = ['neutral', ...Object.keys(PERSONAS)];

    // --- Settings (loaded from localStorage) ---
    const DEFAULTS = {
        model: '',                                          // model id (empty = whatever the backend has loaded)
        reasoning: false,                                   // legacy — mapped to effort
        effort: 'medium',                                   // 'none' | 'low' | 'medium' | 'max'
        effortScheme: 2,                                    // effort-tier scheme version (v2 = NONE/LOW/MED/MAX, see loadSettings)
        style: 'neutral',                                   // 'neutral' | 'sarcastic' | 'dark_humor' | 'personality'
        // Sampling sent in persona mode. NEUTRAL never sends any, so the backend's
        // per-model defaults apply — every model family has
        // its own recommended settings and they should not be overridden by one
        // app-wide opinion. A persona is the deliberate deviation, so it is spelled
        // out here and editable in Settings. An empty field is not sent either,
        // which lets you loosen only temperature and keep the model's own rest.
        personaSampling: { temperature: 0.9, top_p: 0.95, top_k: '', presence_penalty: '', repeat_penalty: '' },
        lmStudioUrl: '',                                    // model backend URL; empty = use the server's configured LLM_BASE_URL
        internetAccess: true,                               // the native tool layer — on by default; this is an agent
        autoCompress: true,                                  // auto-compress conversation when context nears the limit
        preserveThinking: true,                              // replay the model's own reasoning across tool rounds (Qwen3.8 preserve_thinking)
        confirmCodeChanges: true,                            // ask before executing write_file / file_edit tool calls
        contextWindow: 0,                                    // manual context-window override in tokens (0 = auto-detect)
        sfx: true,                                                // sound effects enabled
        conversational: false,                                    // free-form chat mode (ChatGPT-style, no Tricorder protocol)
        tieredTools: true,                                        // tiered tool loading: ship a small core toolset, load the rest on demand via tool_search
        debugPromptTokens: false,                                 // log a per-section prompt-size breakdown for every request + actual prompt_tokens from usage (enable via TricorderLLM.saveSettings({debugPromptTokens:true}))
        continueInBackground: true,                               // if the app is closed mid-run, finish the task server-side and notify in-app
        measuredTimings: true,                                    // ask the backend for per-chunk `timings` (llama.cpp) so the live counter shows measured tokens/rate instead of a char-based estimate
    };

    let settings = loadSettings();
    let conversationHistory = [];
    let isProcessing = false;

    // Operator "Stop" support. Each turn gets a fresh AbortController; every
    // network call in the agent loop derives its signal from it (via
    // withTurnSignal) so a single stopGeneration() tears the whole turn down —
    // the in-flight model stream, any running tool fetch, and the loop itself.
    let _turnAbort = null;
    function newTurnAbort() {
        _turnAbort = new AbortController();
        // Chunk-approval memory is per turn — a new request asks again.
        _approvedWritePaths.clear();
        return _turnAbort;
    }
    function turnAborted() { return !!(_turnAbort && _turnAbort.signal.aborted); }
    // Combine a per-call signal (idle watchdog / timeout) with the turn-level
    // stop signal. AbortSignal.any is widely supported; degrade to the local
    // signal if it isn't.
    function withTurnSignal(localSignal) {
        if (!_turnAbort) return localSignal;
        try {
            return localSignal ? AbortSignal.any([localSignal, _turnAbort.signal]) : _turnAbort.signal;
        } catch { return localSignal; }
    }
    function stopGeneration() {
        if (!isProcessing || !_turnAbort) return false;
        try { _turnAbort.abort(new DOMException('Stopped by operator', 'AbortError')); } catch { /* already settled */ }
        return true;
    }

    // Idle window for the stream watchdogs once a tool call has started.
    // Some backends (LM Studio's llama.cpp tool parser) buffer the ENTIRE
    // tool-call arguments JSON and send no bytes until the call is complete —
    // a big write_file means minutes of silence on a perfectly healthy stream.
    // The normal 2-minute stall watchdog would kill exactly those generations,
    // so once a tool_calls delta is seen the silent window widens to this.
    const TOOL_ARGS_IDLE_MS = 600000;

    // File-writing tools whose big content field we stream live so the operator
    // can watch the code being written token by token (not just the final file).
    const FILE_WRITE_ARG = { write_file: 'content', file_write: 'content', file_create: 'content', file_edit: 'new_string' };
    // Pull the path and the (still-streaming, possibly unterminated) content value
    // out of a partial tool-call arguments JSON string.
    function extractPartialFileWrite(argsStr, field) {
        if (typeof argsStr !== 'string') return null;
        const out = {};
        const pm = argsStr.match(/"path"\s*:\s*"((?:\\.|[^"\\])*)"/);
        if (pm) { try { out.path = JSON.parse('"' + pm[1] + '"'); } catch { out.path = pm[1]; } }
        const cm = argsStr.match(new RegExp(`"${field}"\\s*:\\s*"`));
        if (cm) {
            let raw = argsStr.slice(cm.index + cm[0].length).replace(/"\s*\}?\s*$/, '');
            out.content = raw
                .replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r')
                .replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        }
        return out;
    }

    // Runtime-only conversational override (voice chat). Never persisted —
    // see the migration note in loadSettings(). null = follow settings.
    let _conversationalOverride = null;
    function isConversational() {
        return _conversationalOverride !== null ? _conversationalOverride : !!settings.conversational;
    }
    function setConversationalOverride(value) {
        _conversationalOverride = (value === null || value === undefined) ? null : !!value;
    }

    // Stable per-conversation id used as the durable-streaming resume key so a
    // generation can be re-attached after a reconnect / chat switch. Regenerated
    // when the conversation is cleared or a saved chat is loaded.
    function newSessionId() {
        const rnd = (typeof crypto !== 'undefined' && crypto.randomUUID)
            ? crypto.randomUUID().slice(0, 8)
            : Math.random().toString(36).slice(2, 10);
        return `tricorder-${Date.now().toString(36)}-${rnd}`;
    }
    let _sessionId = newSessionId();
    let _followUpCtrl = null; // AbortController for the in-flight follow-up suggestion call
    // Snapshot of the last chat request sent to the backend (messages + tools).
    // generateFollowUps() re-sends this as its prompt prefix so the backend's
    // KV/prompt cache gets a pure prefix hit instead of allocating a fresh
    // cache entry for a standalone 2-message prompt — which was evicting the
    // live conversation's cached context (~600 MiB per checkpoint) and forcing
    // the NEXT user turn to re-prefill the whole conversation.
    let _lastChatContext = null;
    let _repoContext = ''; // Injected by repo context dropdown
    let _workspacePath = '~/tricorder-workspace'; // Updated from server on init
    let _platformContext = ''; // Platform/shell/python block injected into system prompt
    let _platformInfo = null;  // Raw payload from /api/system-info (null until fetched)
    let _memoryContext = ''; // Loaded from server memory.json
    let _memoryImprovements = ''; // Extracted chat_improvements rendered as bullet list
    let _memoryEntryCount = 0;    // Total entry count — used to detect new memory writes
    let _memoryLastFetch = 0;
    const MEMORY_REFRESH_MS = 5 * 60 * 1000; // Refresh memory context every 5 min

    // Mood + opinions context — refreshed on the same cadence as memory. Both
    // are injected into the system prompt in COMPACT form (target <300 tokens
    // combined) so they don't bloat the prefill budget or dilute attention.
    // They refresh on an interval, not per-turn, so the KV prefill cache can
    // still be reused across turns within a refresh window.

    // Session token tracking — cumulative prompt + completion tokens
    let _sessionPromptTokens = 0;
    let _sessionCompletionTokens = 0;
    let _contextLength = 0; // Model's context window (fetched from API)
    // Where _contextLength came from: 'backend' (the engine's live per-slot
    // n_ctx), 'props' (config-derived but still the engine's own
    // arithmetic), 'catalog' (a model-list field) or '' (unknown). Surfaced so
    // the meter can say whether its DENOMINATOR is measured — a percentage is
    // only as good as the window it divides by, and a catalog reporting a
    // model's training maximum instead of its loaded window overstates the
    // room left by an order of magnitude.
    let _contextSource = '';
    // real prompt_tokens ÷ our char-based estimate of the same messages, learned
    // from the last usage report. null until the backend has reported once.
    // Deliberately NOT reset per conversation: it describes the tokenizer, not
    // the chat, so a freshly loaded conversation gets an accurate bar
    // immediately, and a model swap self-corrects after one turn.
    let _tokenEstimateRatio = null;
    // The last MEASURED size of this conversation, and the char-based estimate
    // of the very same messages taken at the same instant.
    //   { tokens, estimate }
    // The meter used to scale the whole current estimate by _tokenEstimateRatio,
    // which means every token on screen — including the thousands the backend
    // had already counted exactly — came out of a chars/4 guess. With an anchor
    // only what has been APPENDED since the measurement is estimated: after a
    // turn that is one reply, not the whole conversation, so the ratio's error
    // applies to a few hundred tokens instead of tens of thousands. Cleared
    // whenever the history stops being an extension of what was measured
    // (compression, a loaded chat, a cleared one).
    let _ctxAnchor = null;
    // Generated characters per completion token, learned from the backend's
    // usage report. Needed because nothing client-side can tokenize: the
    // stream's own tokenCount increments once per SSE delta of VISIBLE text,
    // which is neither a token count (speculative decoding packs several
    // tokens into one delta — mean accepted draft length 2.25 on Qwen3.8 MTP)
    // nor inclusive of reasoning. 3.7 is the starting guess for mixed
    // German/English technical prose; one turn of real usage replaces it.
    let _charsPerGenToken = 3.7;

    // Fetch actual workspace path from server
    (async function fetchWorkspacePath() {
        try {
            const res = await fetch('/api/workspace', { signal: AbortSignal.timeout(5000) });
            const data = await res.json();
            if (data.path) _workspacePath = data.path;
        } catch { /* use default */ }
    })();

    // Fetch host platform capabilities (OS, shell, python binary, tools on PATH).
    // Shaped into a compact prompt block so the model knows which syntax to use
    // for shell commands and that Python is the preferred scripting language.
    function formatPlatformContext(info) {
        if (!info || !info.platform) return '';
        const isWin = info.platform === 'win32';
        const label = info.platformLabel || info.platform;
        const tools = info.toolsOnPath ? Object.keys(info.toolsOnPath) : [];
        const lines = [
            `## HOST ENVIRONMENT`,
            `OS: ${label} (${info.platform}/${info.arch}${info.release ? ', ' + info.release : ''}). Host: ${info.hostname || '?'}, user: ${info.user || '?'}.`,
            `Shell: \`${info.shell}\`. Path separator: \`${info.pathSep}\`. File separator: \`${info.fileSep}\`.`,
            `Python: \`${info.pythonBin}\` — PREFERRED scripting language. Write cross-platform Python over shell one-liners whenever it's a toss-up; Python avoids ${isWin ? 'cmd.exe / PowerShell' : 'bash'} quoting and pathing traps.`,
            `Node: ${info.nodeVersion || '?'}. CPUs: ${info.cpus || '?'}. RAM: ${info.totalMemoryGB || '?'} GB.`,
            `Workspace: \`${info.workspace}\`. Home: \`${info.homedir}\`. Tmp: \`${info.tmpdir}\`.`,
        ];
        if (tools.length) {
            lines.push(`Tools on PATH: ${tools.join(', ')}.`);
        }
        if (isWin) {
            lines.push(
                `WINDOWS SHELL RULES:`,
                `- Shell commands run under cmd.exe — use \`dir\`, \`type\`, \`copy\`, \`move\`, \`del\`, \`tasklist\`, \`where\`, \`ipconfig\`. Do NOT assume \`ls\`, \`cat\`, \`grep\`, \`ps\`, \`which\` are present.`,
                `- Paths use backslashes (\`C:\\Users\\...\`). In JSON/JS string literals escape them or use forward slashes (Windows accepts both in most APIs).`,
                `- For anything non-trivial (text processing, JSON parsing, HTTP, file walks, glob, archives), invoke Python via \`${info.pythonBin}\` instead of chaining cmd.exe tools.`,
                `- PowerShell is available as \`powershell\` / \`pwsh\` if you need \`Get-Process\`, \`Get-Service\`, \`Get-ChildItem\`, etc. Prefer Python first, PowerShell second, cmd.exe last.`,
                `- Line endings are CRLF by default; keep that in mind when writing scripts that will be re-read on this host.`,
            );
        } else {
            lines.push(
                `POSIX SHELL RULES: standard bash/sh utilities available (ls, cat, grep, awk, sed, ps). Python still preferred for anything beyond a one-liner.`,
            );
        }
        return lines.join('\n');
    }

    async function fetchPlatformContext() {
        try {
            const res = await fetch('/api/system-info', { signal: AbortSignal.timeout(5000) });
            if (!res.ok) return;
            const data = await res.json();
            _platformInfo = data;
            _platformContext = formatPlatformContext(data);
        } catch { /* silent — prompt still works without platform block */ }
    }
    fetchPlatformContext();

    function loadSettings() {
        try {
            const saved = JSON.parse(localStorage.getItem('tricorder_llm_settings'));
            const merged = { ...DEFAULTS, ...saved };
            // Effort tiers v2: NONE/LOW/MED/MAX, mirroring LM Studio's native
            // reasoning_effort levels now that /v1/chat/completions honours
            // them (tiered values since 0.4.8, "none" since 0.4.19 — see
            // EFFORT_PROFILES). The old scheme was LOW/MED/HIGH/MAX where
            // LOW+MED meant "thinking off"; remap saved values once,
            // preserving relative order. This must key off the RAW saved
            // object: after the DEFAULTS merge every install has a valid
            // v2 effort, so the old keys would be indistinguishable.
            if (saved && saved.effortScheme !== 2) {
                if (saved.effort) {
                    const OLD_TO_NEW = { low: 'none', medium: 'low', high: 'medium', max: 'max' };
                    merged.effort = OLD_TO_NEW[saved.effort] || DEFAULTS.effort;
                } else if (typeof saved.reasoning === 'boolean') {
                    // Pre-tier installs had only a reasoning on/off toggle.
                    merged.effort = saved.reasoning ? 'medium' : 'low';
                }
            }
            merged.effortScheme = 2;
            // The LM Studio MCP layer was removed — native tools are the only
            // tool path now. Drop the orphaned keys from older builds.
            delete merged.mcpServerId;
            delete merged.mcpServers;
            delete merged.nativeToolCalling;
            // The Hermes Agent backend was removed — LM Studio is the only
            // backend now. Strip the old "lmstudio:" model prefix and drop a
            // saved Hermes model id / connection-mode keys from older builds.
            delete merged.mode;
            delete merged.directUrl;
            if (typeof merged.model === 'string' && merged.model.startsWith('lmstudio:')) {
                merged.model = merged.model.slice('lmstudio:'.length);
            } else if (merged.model === 'hermes-agent') {
                merged.model = '';
            }
            delete merged.qwenLanguage;
            // A saved style that names a persona this build doesn't have (an
            // older version's, or one removed from the table) falls back to
            // neutral rather than leaving the UI showing a style that has no
            // prompt behind it.
            if (merged.style && merged.style !== 'neutral' && !isPersona(merged.style)) {
                merged.style = 'neutral';
            }
            // Persona sampling predates the persona table; the setting was
            // never per-persona, so carry the saved values over under the new
            // name instead of resetting them to defaults. Keyed off the RAW
            // saved object: after the DEFAULTS merge personaSampling always
            // exists, so testing `merged` would never fire this.
            if (saved && saved.bonesSampling && !saved.personaSampling) {
                merged.personaSampling = saved.bonesSampling;
            }
            delete merged.bonesSampling;
            // `conversational` is an internal voice-chat flag with no visible
            // toggle. Older builds persisted it via saveSettings, so a voice
            // call that ended uncleanly (tab closed, crash) left it stuck ON
            // forever — silently dropping the Tricorder protocol: no
            // "## Summary", free-form replies, persona quirks. Force it off on
            // load; voice chat now uses a runtime-only override instead.
            merged.conversational = false;
            return merged;
        } catch {
            return { ...DEFAULTS };
        }
    }

    function saveSettings(newSettings) {
        settings = { ...settings, ...newSettings };
        localStorage.setItem('tricorder_llm_settings', JSON.stringify(settings));
    }

    // --- Backend ---
    // LM Studio is the only backend. Chat routes through the server proxy
    // straight to LM Studio (X-LM-Target header) and drives the in-app
    // native tool layer (NATIVE_TOOLS agent loop).
    function getModelId() {
        return settings.model || '';
    }
    // The backend the proxy should forward to. An empty setting means "the one
    // the server was started with" — that is the common case, and hardcoding a
    // default here would silently override a correctly configured .env.
    function getLmStudioUrl() {
        return (settings.lmStudioUrl || '').replace(/\/+$/, '');
    }

    // --- Memory Context: preload from server and inject into system prompt ---
    // GET /api/memory classifies every entry server-side (entry.bucket:
    // seed | live | insight | improvements) so we can budget by bucket. Seed
    // (identity) + live (deliberate memory_store) are durable and always
    // injected; auto-insights are repetitive, so only the freshest few make
    // the cut; improvements get their own section below. The prefix fallback
    // keeps this working against an older server without bucket support.
    const _SEED_PREFIXES = ['operator_', 'agent_', 'workspace_', 'preferred_', 'stack_'];
    const INSIGHT_INJECT_LIMIT = 12;   // newest N auto-insights into the prompt
    // Hard ceiling on the memory block (seed + relevant/live entries alike).
    // 2000 chars ≈ 570 tokens — the block is paid on EVERY request, so it is
    // budgeted like the tool schemas. Entries are ordered seed → live →
    // insights (and seed → relevant on the per-turn path), so the cap drops
    // the least important tail first.
    const MEMORY_CHAR_BUDGET = 2000;
    function classifyMemKey(e) {
        if (e.bucket) return e.bucket === 'insight' ? 'insights' : e.bucket;
        if (e.key === 'chat_improvements') return 'improvements';
        if (e.key?.startsWith?.('chat_insight_')) return 'insights';
        if (e.source?.startsWith?.('chatlog:')) return 'insights';
        if (_SEED_PREFIXES.some(p => e.key?.startsWith?.(p))) return 'seed';
        return 'live';
    }

    // --- Per-turn memory selection (server-side relevance ranking) ---
    // Before each send the user message is scored against the whole memory
    // store via GET /api/memory/relevant; the injected block then carries only
    // the always-on seed core (identity/personal facts) plus the top-K
    // relevant entries — instead of the full budgeted dump. When the endpoint
    // is missing, errors or times out, _turnMemoryContext stays null and
    // buildDynamicContext falls back to today's full injection unchanged.
    let _turnMemoryContext = null;  // null = full-injection fallback
    let _memorySeedLines = [];      // always-on core lines (seed / identity / personal)
    let _memorySeedKeys = new Set();

    // "(Stand: YYYY-MM)" age hint so the model can spot stale facts.
    function _memAgeSuffix(updatedAt) {
        const t = Date.parse(updatedAt || '');
        if (!t) return '';
        const d = new Date(t);
        return ` (as of ${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')})`;
    }
    function formatMemoryLine(e, withAge = false) {
        const tags = e.tags?.length ? ` [${e.tags.join(', ')}]` : '';
        return `- ${e.key}: ${e.value}${tags}${withAge ? _memAgeSuffix(e.updatedAt) : ''}`;
    }

    async function prepareTurnMemory(queryText) {
        _turnMemoryContext = null;
        const q = (typeof queryText === 'string' ? queryText : '').trim();
        // No stored memory or no query text → nothing to rank; keep fallback.
        if (!q || !_memoryContext) return;
        try {
            const res = await fetch(
                `/api/memory/relevant?q=${encodeURIComponent(q.slice(0, 2000))}&k=10`,
                { signal: AbortSignal.timeout(1500) }
            );
            if (!res.ok) return; // 404 (endpoint not deployed) or error → fallback
            const data = await res.json();
            if (!data || !Array.isArray(data.entries)) return;
            // Seed core first, but under the same budget as everything else —
            // an unbounded seed would make the cap below meaningless.
            const lines = [];
            let used = 0;
            for (const l of _memorySeedLines) {
                if (used + l.length > MEMORY_CHAR_BUDGET) break;
                lines.push(l);
                used += l.length + 1;
            }
            for (const e of data.entries) {
                if (!e || !e.key || e.key === 'chat_improvements') continue;
                if (_memorySeedKeys.has(e.key)) continue; // already in the core
                const line = formatMemoryLine(e, true);
                if (used + line.length > MEMORY_CHAR_BUDGET) break;
                used += line.length + 1;
                lines.push(line);
            }
            _turnMemoryContext = lines.join('\n');
        } catch { /* timeout / network — graceful fallback to full injection */ }
    }

    async function refreshMemoryContext() {
        try {
            const res = await fetch('/api/memory', { signal: AbortSignal.timeout(3000) });
            if (!res.ok) return;
            const data = await res.json();
            const prevCount = _memoryEntryCount;
            _memoryEntryCount = data.count || 0;
            if (!data.entries || data.entries.length === 0) {
                _memoryContext = '';
                _memoryImprovements = '';
                _memoryLastFetch = Date.now();
                return;
            }
            // Bucket the entries. chat_improvements gets pulled out into its own
            // section (KNOWN IMPROVEMENTS) rather than rendered as a raw JSON
            // array inside the PERSISTENT MEMORY block.
            const improvements = [];
            const seed = [], live = [], insights = [];
            for (const e of data.entries) {
                const c = classifyMemKey(e);
                if (c === 'improvements') {
                    try {
                        const arr = JSON.parse(e.value);
                        if (Array.isArray(arr)) improvements.push(...arr.filter(Boolean));
                    } catch { /* fall through — treat as opaque */ }
                    continue;
                }
                // Seed prefix OR an explicit identity/personal category marks
                // the always-on core used by the per-turn relevance path.
                if (c === 'seed' || e.category === 'identity' || e.category === 'personal') seed.push(e);
                else if (c === 'insights') insights.push(e);
                else live.push(e);
            }
            // Auto-insights: newest first, then capped — this is the bloat
            // control. (The server also dedups/caps them, but budgeting here
            // keeps the prompt lean regardless of store state.)
            insights.sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
            const ordered = [...seed, ...live, ...insights.slice(0, INSIGHT_INJECT_LIMIT)];
            // Drop exact-duplicate values and respect the char budget.
            const seen = new Set();
            const lines = [];
            let used = 0;
            for (const e of ordered) {
                const norm = String(e.value || '').toLowerCase().replace(/\s+/g, ' ').trim();
                if (!norm || seen.has(norm)) continue;
                seen.add(norm);
                const line = formatMemoryLine(e);
                if (used + line.length > MEMORY_CHAR_BUDGET) break;
                used += line.length + 1;
                lines.push(line);
            }
            _memoryContext = lines.join('\n');
            // Always-on core for the per-turn relevance path (prepareTurnMemory).
            _memorySeedLines = seed.map(e => formatMemoryLine(e, true));
            _memorySeedKeys = new Set(seed.map(e => e.key));
            _memoryImprovements = improvements.length
                ? improvements.map(i => `- ${i}`).join('\n')
                : '';
            _memoryLastFetch = Date.now();

            // Fire event if the count went up — lets the Computer Core flash
            // purple to signal "something new was remembered"
            if (prevCount > 0 && _memoryEntryCount > prevCount) {
                try {
                    window.dispatchEvent(new CustomEvent('tricorder-memory-written', {
                        detail: { count: _memoryEntryCount, delta: _memoryEntryCount - prevCount },
                    }));
                } catch {}
            }
        } catch {
            // Silent fail — memory is supplementary
        }
    }

    // Fetch memory on module load
    refreshMemoryContext();

    // Always route through the server proxy to avoid browser CORS issues.
    function getApiBase() {
        return window.location.origin + '/llm';
    }

    // Override the proxy's target only when the operator picked one explicitly.
    // With no override the server uses its own LLM_BASE_URL. The API key (if
    // any) is injected server-side and never travels through the browser.
    function getExtraHeaders() {
        const target = getLmStudioUrl();
        return target ? { 'X-LM-Target': target } : {};
    }

    // Stable per-conversation key for durable streaming, so a generation can be
    // re-attached after a reconnect / chat switch. Reuses the session id
    // (one per conversation); falls back to a constant so it always returns a key.
    function getDurableChatId() { return _sessionId || 'default'; }

    // Compressed for prompt-token cost (this block is paid on EVERY request).
    // Every rule below is load-bearing; elaboration was cut, behavior wasn't.
    // When editing, run scripts/audit-prompt-tokens.js and keep this under
    // ~1000 tokens.
    const SYSTEM_PROMPT = `You are TRICORDER AGENT — a private AI agent running locally on the operator's own machine. Nothing leaves this device except requests your tools explicitly make. You have real tools and are expected to USE them rather than describing what could be done.

Language: match the operator per turn (reply in the language they wrote in) and mirror their register.

## PRIORITIES (earlier wins)
1. SAFETY  2. HONEST REASONING  3. CORRECT TOOL USE  4. COMPLETENESS  5. STYLE. Style never overrides anything above it.

## SAFETY & HONESTY
NEVER fabricate tool output — no invented terminal sessions, logs, listings, URLs or numbers; fenced blocks are ONLY for code/config you suggest. Sanity-check every tool result before quoting it; flag wrong-looking results. Prefer "I don't know" over guessing. Public live data (prices, news, versions): never answer from memory — web_search, cite URLs, cross-verify important claims (Reuters/Bloomberg/AP/NYT/BBC beat blogs).

LOCAL DATA IS NOT WEB DATA. "My files / my repo / my notes / what I told you" → the matching local tool (read_file, glob, grep, git_operations, memory_recall) — tool_search for it FIRST. web_search cannot see this machine and is a wrong answer, not a fallback.

DESTRUCTIVE actions (delete/overwrite/move, shell mutations, API writes): present a plan with exact files and effects, then WAIT for confirmation. If you lack a tool, say so and suggest the command or integration — never pretend it ran.

## METHOD
Analyze the real goal → plan → execute → reflect after EACH result → synthesize. Batch independent tool calls in ONE turn (parallel by default). ACT, DON'T ASK for non-destructive steps. On tool errors: diagnose in one sentence, fix the input or switch tool; max 2 retries, then report what failed and what's needed. Proactively memory_store operator preferences, names, projects, decisions; apply MEMORY facts silently (weather → known city).

LONG-RUNNING WORK: run it with agent_spawn — Tricorder announces completion or failure in this chat by itself, so NEVER create a task, reminder or mail whose only job is to report that a background agent finished. For something you can only learn by re-checking (a download started by another process, a file that must appear, a service that must come up): create_task action=smart with \`until\` set to the condition — it checks on schedule, reports progress, and deletes itself the moment the condition holds. A watchdog the operator has to clean up afterwards is a bug.

## CODING
Thinking is a scratchpad — the COMPLETE code must land in the visible reply or a tool call; code only in reasoning was never delivered. ONE channel per artifact:
1. LIVE CANVAS — demos/UI/games/visualizations: one self-contained fenced \`html\` (or \`svg\`/\`js\`) block, NO file= attribute, all CSS/JS inline, no external libs. Renders live in chat.
2. FILE BLOCK — files for disk: one fenced block per file, path on the info line (\`\`\`html file=~/tricorder-workspace/code/app.html), complete content any size — streams live, auto-saves on close. Don't also write_file the same content; content must not contain a bare \`\`\` line (then use chunked write_file). Surgical edits → file_edit. Afterwards summarize in 1-3 sentences.
3. CODE EXECUTION — verify by running (run_command/code_exec); report ACTUAL output.
4. PLAIN fenced block + language tag for snippets to copy.
5. LIVE PREVIEW — so the operator can open a file you wrote on their phone/laptop: dev_server start on its directory, then give them the result's public_url (or preview_path). Tricorder re-serves it under /preview/<port>/ on the public domain, behind the site login. Never hand out the 127.0.0.1 URL — host only.
Full runnable code — no \`...\`, no "rest stays the same", never split a file across blocks.

## OUTPUT
Concise; lead with the answer, caveats after. No greetings, filler, sycophancy. Expert depth, opinionated recommendations. Markdown where it helps (headings, lists, tables, fenced code WITH language tags, **bold** takeaways). Embed real images ![desc](url) from tool results when asked to "show" something — never invent URLs.

End non-trivial replies with "## Summary" — 1-3 spoken-friendly sentences (TTS reads it aloud); very short answers are their own summary. The heading is ALWAYS exactly "## Summary" (English), even in German replies, and it is the LAST thing — stop after it. The summary text is written in the operator's language and must read naturally when spoken aloud: plain prose, no markdown, no URLs, no code, and no abbreviations or symbols — spell them out in words (German summaries: "zum Beispiel" statt "z.B.", "circa" statt "ca.", "Prozent" statt "%", "und" statt "&", Zahlen mit Komma als Dezimaltrennzeichen). Inside the Summary you may prefix passages with a hidden delivery cue of the form "[mood: <short description>]" (e.g. "[mood: ruhig und freundlich]", "[mood: dringend]") when a specific emotional delivery fits the content, and again mid-summary if the register shifts. The tags are machine instructions for the speech synthesizer — never shown to the user and never spoken, so don't reference them in prose. Use them sparingly; omit them for neutral content.`;

    // Free-form conversational system prompt (ChatGPT-style).
    // Used when settings.conversational is true. Drops the strict Tricorder
    // protocol (no greetings, mandatory Summary, terse answers) in favor of
    // natural back-and-forth chat.
    const CHAT_SYSTEM_PROMPT = `You are a friendly, helpful AI assistant having a natural conversation with the operator. This is a free-form chat mode — think ChatGPT, not a terminal.

Style:
- Chat naturally. Greetings, acknowledgements, follow-up questions, and small talk are all welcome.
- Match the operator's language (German or English) and register — casual if they're casual, technical if they're technical.
- Responses can be as long or short as the topic deserves. Don't force brevity; don't pad either. In voice chat your reply is read aloud — lead with the answer and keep it to a few spoken sentences unless the operator asks for depth.
- Use markdown (headings, lists, code blocks, tables) when it helps clarity, plain prose when it doesn't.
- When a web search returns images and the topic is visual (a place, person, product, artwork, event), embed 1-2 of them inline with ![title](image) markdown using the exact image URL from the tool result — never invent image URLs.
- Show personality. Be curious, warm, and engaged. Ask clarifying questions when the request is ambiguous.
- Remember the conversation context and refer back to earlier turns naturally.
- Do NOT append a "## Summary" section. Do NOT follow the strict Tricorder response protocol.
- If you're unsure or don't know something, say so plainly — no fabrication.`;

    async function checkConnection() {
        try {
            const res = await fetch(`${getApiBase()}/v1/models`, {
                method: 'GET',
                headers: getExtraHeaders(),
                signal: AbortSignal.timeout(5000)
            });
            if (!res.ok) return false;
            // Verify we got JSON back, not an HTML login page or error page
            const contentType = res.headers.get('content-type') || '';
            if (!contentType.includes('application/json')) return false;
            // Learn the model's context window on first successful connect so
            // the meter shows its bar and auto-compression triggers at the right
            // fraction of the real window — not only after the settings dialog
            // (the lone other caller of the probe) has been opened.
            if (!_contextLength) detectContextLength();
            return true;
        } catch {
            return false;
        }
    }

    // Effort-based inference profiles (Opus-style adaptive thinking)
    //
    // Thinking depth maps straight onto LM Studio's reasoning_effort:
    // /v1/chat/completions honours the tiered values natively since 0.4.8
    // and "none" as an explicit OFF switch since 0.4.19, which also fixed
    // reasoning content being replayed as non-reasoning. With the toggle
    // finally working end-to-end, the tiers no longer need to collapse to
    // a binary on/off — the UI cycle is NONE → LOW → MED → MAX:
    //
    // NONE: Fast — thinking off, lower temp, short output budget
    // LOW:  Light thinking — quick reasoning pass, moderate params
    // MED:  Standard thinking — the default
    // MAX:  Maximum — deepest reasoning, highest budget, interleaved planning
    // maxToolRounds: the agent-loop budget per tier. One flat cap (15) for
    // every tier let an eager agentic model (Muse) burn 25+ tool calls on a
    // one-line follow-up at LOW effort. Low tiers now get a matching tool
    // budget; the absolute ceiling stays MAX_TOOL_ROUNDS.
    const EFFORT_PROFILES = {
        none:   { reasoningEffort: 'none',   temperature: 0.5, top_p: 0.7,  top_k: 15, presence_penalty: 1.2, repeat_penalty: 1.05, max_tokens: 16384,  showThinking: false, interleavedThinking: false, maxToolRounds: 3 },
        low:    { reasoningEffort: 'low',    temperature: 0.7, top_p: 0.8,  top_k: 20, presence_penalty: 1.5, repeat_penalty: 1.05, max_tokens: 32768,  showThinking: true,  interleavedThinking: false, maxToolRounds: 6 },
        medium: { reasoningEffort: 'medium', temperature: 1.0, top_p: 0.95, top_k: 20, presence_penalty: 1.5, repeat_penalty: 1.05, max_tokens: 81920,  showThinking: true,  interleavedThinking: true,  maxToolRounds: 15 },
        max:    { reasoningEffort: 'high',   temperature: 1.0, top_p: 0.95, top_k: 20, presence_penalty: 1.5, repeat_penalty: 1.05, max_tokens: 131072, showThinking: true,  interleavedThinking: true,  maxToolRounds: 15 },
    };
    function toolRoundCap(profile) {
        return Math.min(profile.maxToolRounds || MAX_TOOL_ROUNDS, MAX_TOOL_ROUNDS);
    }

    // --- Model family adapter ---
    // Detect the model family once per request and apply targeted tweaks
    // elsewhere (stops, prompt, parser). Llama 3.x Instruct gets an explicit
    // <tool_call>{json}</tool_call> preamble + <tool_response> result format —
    // far more robust than its brittle native <|python_tag|> convention.
    function getModelFamily() {
        const m = getModelId().toLowerCase();
        if (!m) return 'unknown';
        if (m.includes('qwen'))   return 'qwen';
        if (m.includes('llama'))  return 'llama';
        if (m.includes('mistral') || m.includes('mixtral')) return 'mistral';
        if (m.includes('deepseek')) return 'deepseek';
        if (m.includes('gpt-oss') || m.includes('gpt_oss')) return 'gpt-oss';
        if (m.includes('muse') || m.includes('glimmer')) return 'muse';
        return 'unknown';
    }

    // Muse Glimmer's reasoning-strength levels, keyed by the reasoning_effort
    // value each effort tier already sends. Its template ignores
    // enable_thinking/reasoning_effort — the knob is the reasoning_strength
    // template kwarg (low/medium/high/xhigh), and when it is ABSENT the
    // template appends its own directive defaulting to HIGH, so without this
    // mapping every tier thinks at full strength. There is no OFF value:
    // NONE clamps to the 'low' floor. MAX maps to 'xhigh' (Muse-only level)
    // so the top tier keeps meaning "deepest the model can go".
    const MUSE_REASONING_STRENGTH = { none: 'low', low: 'low', medium: 'medium', high: 'xhigh' };

    // The same idea in two vocabularies, so it is mapped rather than reused.
    //
    // Top level, the tiers speak LM Studio's set — none/low/medium/high —
    // which it honours natively on /v1/chat/completions, "none" being its
    // explicit thinking-OFF switch.
    //
    // Inside the template kwargs they must speak Qwen3.8's set, which is
    // low/medium/xhigh with xhigh the DEFAULT. Neither "none" nor "high"
    // exists there, and an unrecognised value falls back to the default —
    // that is, to the DEEPEST reasoning. Sending "none" was therefore actively
    // dangerous: the thinking-off tier would ask for maximum reasoning if
    // enable_thinking:false were ever not honoured. Mapping it to "low"
    // instead means any fallback degrades to the least reasoning, not the most.
    const QWEN_REASONING_EFFORT = { none: 'low', low: 'low', medium: 'medium', high: 'xhigh' };

    // The TOP-LEVEL reasoning_effort is not free-form either: LM Studio
    // validates it against the levels the LOADED model actually declares, and
    // Qwen3.8 declares low/medium/xhigh — no "high" at all. Sending the
    // OpenAI-standard "high" there is a hard 400, so the MAX tier could not
    // complete a single turn, and a 4xx is (correctly) never retried by the
    // transport. Muse does know "high", but its deepest level is "xhigh" too,
    // and MAX means "the deepest the model can go" — the same call
    // MUSE_REASONING_STRENGTH already makes for the template kwarg.
    // Only "high" moves: "none" is the backend's own thinking-OFF switch
    // rather than a model level, and low/medium exist everywhere.
    const XHIGH_FAMILIES = new Set(['qwen', 'muse']);
    function topLevelReasoningEffort(effort, family) {
        const wire = effort || 'none';
        if (wire === 'high' && XHIGH_FAMILIES.has(family)) return 'xhigh';
        return wire;
    }

    // Safety net for the same rejection on a model the family sniff misses —
    // model ids are free-form, so a Qwen3.8 checkpoint published as
    // an unrecognised model id reads as 'unknown' and would still send "high".
    // When the backend refuses a value, the replacement is remembered under
    // model + refused value, so the failed round-trip happens at most once per
    // model per session and only the value that was actually refused is
    // substituted — the other tiers keep asking for exactly what they mean.
    const EFFORT_WIRE_LEVELS = ['none', 'low', 'medium', 'high', 'xhigh'];
    const _effortFallbacks = new Map();
    const effortFallbackKey = (model, effort) => `${model || ''}\u0000${effort}`;

    function isEffortRejection(status, text) {
        return status === 400 && /reasoning[_\s-]?effort/i.test(text || '');
    }

    // Pick a replacement for a value the backend just refused. Backends name
    // the levels they DO accept in the error message, so prefer those: the
    // deepest one when the refused value was a top tier, the shallowest when
    // it was a low one — a fallback must never turn "think less" into "think
    // more" (the reason QWEN_REASONING_EFFORT maps none→low). With nothing
    // parseable, 'medium' is the one level every reasoning model here knows.
    // ('high' does not match inside 'xhigh' — \b sees no boundary there.)
    function pickEffortFallback(rejected, text) {
        const named = EFFORT_WIRE_LEVELS.filter(level =>
            level !== rejected && new RegExp(`\\b${level}\\b`, 'i').test(text || ''));
        const wantsDeepest = rejected === 'high' || rejected === 'xhigh';
        if (named.length) return wantsDeepest ? named[named.length - 1] : named[0];
        return wantsDeepest ? 'medium' : 'low';
    }

    // Swap in a replacement this model has already refused once.
    function applyEffortFallback(effort, model) {
        return _effortFallbacks.get(effortFallbackKey(model, effort)) || effort;
    }

    // Record the refusal and hand back the value to retry with, or null when
    // there is nothing left to try (already at the fallback, or no value sent).
    function noteEffortRejection(body, text) {
        const rejected = body && body.reasoning_effort;
        if (!rejected) return null;
        const replacement = pickEffortFallback(rejected, text);
        if (replacement === rejected) return null;
        _effortFallbacks.set(effortFallbackKey(body.model, rejected), replacement);
        console.warn(`[llm] backend refused reasoning_effort:"${rejected}" — falling back to "${replacement}"`);
        return replacement;
    }

    // Rewrite a request the backend just refused, in place — the caller re-sends
    // the same body object. Returns false when the refusal was about something
    // other than reasoning_effort, or nothing better is left to try.
    function retryWithFallbackEffort(body, status, text) {
        if (!isEffortRejection(status, text)) return false;
        const replacement = noteEffortRejection(body, text);
        if (!replacement) return false;
        body.reasoning_effort = replacement;
        return true;
    }

    // Qwen documents two sampling sets, and which one applies is decided PER
    // REQUEST by enable_thinking — something a server pinned with --temp /
    // --top-p / --top-k at launch cannot know. Those launch flags describe
    // THINKING mode, so a thinking request is served correctly by NEUTRAL
    // sending nothing at all. A non-thinking request is not: it needs the
    // instruct set, and this is the only place that knows which mode the
    // request is in.
    const NON_THINKING_SAMPLING = {
        temperature: 0.7,
        top_p: 0.8,
        top_k: 20,
        presence_penalty: 1.5,
        repeat_penalty: 1.0,
    };

    // --- Preserved thinking (Qwen3.8) ---------------------------------------
    // Qwen3.8 renders the reasoning of PREVIOUS assistant messages back into
    // the prompt when preserve_thinking is on — the vendor default, and the
    // case it exists for is precisely this agent's tool loop: a fifteen-round
    // chain where round 9 re-derives what round 3 already worked out, because
    // the only thing carried forward was the tool call itself. Vendor guidance
    // calls it out for "decision consistency and reduced redundant reasoning"
    // in agent scenarios, and for KV-cache utilisation.
    //
    // It takes BOTH halves to work. The template flag is one; sending the
    // reasoning back on the assistant message is the other, and this loop used
    // to drop it on the floor (`content` and `tool_calls` only). Neither half
    // alone does anything.
    //
    // Unbounded, both halves together are a context bomb: reasoning at xhigh
    // runs to tens of thousands of tokens in ONE round, and MAX effort allows
    // fifteen of them inside whatever window the operator could afford. So the
    // trace is kept for the most recent rounds only, each clipped from the
    // front (a scratchpad's conclusion is the part worth keeping), and the
    // flag on the wire always describes what was actually sent.
    const PRESERVE_THINKING_FAMILIES = new Set(['qwen']);
    const PRESERVED_THINKING_ROUNDS = 3;
    const PRESERVED_THINKING_CHARS = 6000;

    function preservesThinking() {
        return settings.preserveThinking !== false
            && PRESERVE_THINKING_FAMILIES.has(getModelFamily());
    }

    // Push one round's assistant message onto the agent-loop history, carrying
    // its reasoning when preserved thinking is on, and age out the traces that
    // have fallen out of the window. Returns the pushed message.
    function pushAssistantRound(agentMessages, message, reasoning) {
        const text = String(reasoning || '').trim();
        if (preservesThinking() && text) {
            // Clip from the front: the tail holds the conclusion the next
            // round needs, the head holds the exploration it does not.
            message.reasoning_content = text.length > PRESERVED_THINKING_CHARS
                ? `[…earlier reasoning trimmed…]\n${text.slice(-PRESERVED_THINKING_CHARS)}`
                : text;
        }
        agentMessages.push(message);
        // Walk back from the newest, keeping the first N traces and stripping
        // the rest. Backwards, so the cost is the number KEPT rather than the
        // length of the whole round history on every single round.
        let kept = 0;
        for (let i = agentMessages.length - 1; i >= 0; i--) {
            const m = agentMessages[i];
            if (!m || !m.reasoning_content) continue;
            if (++kept > PRESERVED_THINKING_ROUNDS) delete m.reasoning_content;
        }
        return message;
    }

    // Template kwargs for auxiliary one-shot calls (follow-up suggestions,
    // context compression) that must not think: enable_thinking:false covers
    // Qwen-style hybrids, but Muse ignores it and defaults to HIGH — so its
    // own knob rides along pinned to the 'low' floor (Muse has no off value).
    function noThinkTemplateKwargs() {
        // reasoning_effort rides in the kwargs for the same reason it does in
        // buildRequestBody: llama.cpp only forwards chat_template_kwargs into
        // the template, so the top-level field these callers also send is
        // inert there.
        // 'low', not 'none': see QWEN_REASONING_EFFORT — "none" is not a value
        // Qwen3.8 knows, and an unknown one falls back to its xhigh default.
        // preserve_thinking defaults to ON in Qwen3.8's template. These calls
        // carry no reasoning of their own and want none replayed, so say so
        // rather than relying on the history happening to be clean.
        const kwargs = { enable_thinking: false, reasoning_effort: 'low', preserve_thinking: false };
        if (getModelFamily() === 'muse') kwargs.reasoning_strength = 'low';
        return kwargs;
    }

    // Some chat templates hard-enforce that every `system` message appears at
    // the very beginning of the conversation and raise a Jinja exception
    // otherwise ("System message must be at the beginning"). Qwen3.6's template
    // is one of them: a system-role message pushed *after* the history aborts
    // the whole request with a 400 "Channel Error". For these families, a
    // trailing system reminder must instead ride along as a user-role turn.
    const REQUIRES_LEADING_SYSTEM = new Set(['qwen']);

    // Llama 3.x uses its own special-token alphabet — ChatML stops would never
    // fire. Anchoring on <|eot_id|> keeps streamed turns from running past
    // the assistant boundary when the backend doesn't auto-trim.
    const LLAMA_STOPS  = ['<|eot_id|>', '<|end_of_text|>'];

    // Effort labels for UI
    const EFFORT_LABELS = { none: 'NONE', low: 'LOW', medium: 'MED', max: 'MAX' };
    const EFFORT_CYCLE = ['none', 'low', 'medium', 'max'];


    function getEffort() {
        // Conversational turns (voice chat / free-form ChatGPT-style mode)
        // skip reasoning entirely: the reply must feel instant, so thinking
        // models get the NONE tier regardless of the user's effort setting.
        // This flows through every consumer — buildRequestBody sends
        // enable_thinking:false + reasoning_effort:"none", the stream
        // handler hides the thinking panel, and the agent loop skips its
        // interleaved-thinking prompts.
        if (isConversational()) return 'none';
        return settings.effort || 'medium';
    }

    // Conversational sampling profile. Thinking is already off via the NONE
    // effort tier above, but chat wants livelier sampling than NONE's dry
    // factual settings, and a tighter output budget — spoken replies should
    // be a quick exchange, not an essay the TTS reads for minutes.
    const CHAT_PROFILE = { reasoningEffort: 'none', temperature: 0.7, top_p: 0.9, top_k: 20, presence_penalty: 1.3, repeat_penalty: 1.05, max_tokens: 8192, showThinking: false, interleavedThinking: false };

    // --- Style-based sampling ------------------------------------------------
    // The style toggle used to change only the PROMPT, so neutral and a persona ran
    // identical sampling. They want opposite things from the sampler, and — more
    // importantly — only one of them should have an opinion at all.
    //
    //   NEUTRAL is the working mode (code, extraction, factual answers) and
    //   sends NO sampling fields whatsoever. Good sampling is a property of the
    //   MODEL, not of this app: every family has its own recommended settings,
    //   and a well-configured backend pins them per model (--temp / --top-k / --top-p / --min-p /
    //   --repeat-penalty in its Model Library). Anything sent from here
    //   overrides those server-side defaults, so one app-wide opinion would
    //   silently replace the values tuned for whichever model is loaded. Saying
    //   nothing is what lets each model run the way it wants to.
    //
    //   A PERSONA is the opposite case: there a deliberate
    //   deviation from the model's default IS the point — dry sarcasm and
    //   full-throttle motivation both need room to reach for the less-obvious
    //   word. Persona modes send whatever the operator configured.
    //
    // Fields listed here are the only ones a style may touch; depth, token
    // budget and tool rounds stay with the effort tier.
    // The persona numbers are OPERATOR-CONFIGURABLE (Settings → Backend →
    // PERSONA SAMPLING) rather than baked in, because "how much randomness makes
    // this model characterful instead of incoherent" differs per model and is a
    // matter of taste. Each field may be left empty, which drops it from the
    // request the same way NEUTRAL drops everything — so the operator can loosen
    // only temperature and let the model's own top_p/penalties stand.
    const SAMPLING_FIELDS = ['temperature', 'top_p', 'top_k', 'presence_penalty', 'repeat_penalty'];
    const SAMPLING_BOUNDS = {
        temperature:      { min: 0, max: 2 },
        top_p:            { min: 0, max: 1 },
        top_k:            { min: 0, max: 500, int: true },
        presence_penalty: { min: -2, max: 2 },
        repeat_penalty:   { min: 0, max: 2 },
    };

    function getStyle() {
        const s = settings.style || 'neutral';
        return isPersona(s) ? s : 'neutral';
    }

    // One sampling field from the operator's persona settings: a finite number
    // inside its bounds, or undefined ("don't send this one"). Anything
    // unparseable is treated as unset rather than clamped to a silent default —
    // a typo must not quietly become a real sampling value.
    function personaField(field) {
        const raw = (settings.personaSampling || {})[field];
        if (raw === undefined || raw === null || String(raw).trim() === '') return undefined;
        const n = Number(raw);
        if (!Number.isFinite(n)) return undefined;
        const b = SAMPLING_BOUNDS[field];
        const clamped = Math.min(b.max, Math.max(b.min, n));
        return b.int ? Math.round(clamped) : clamped;
    }

    // profile + style → the sampling actually sent. A field left undefined here
    // is omitted from the request body entirely (not sent as null), which is the
    // difference between "use your default" and "use no penalty". Pure w.r.t.
    // the profile, so tests can assert it without driving a request.
    function applyStyleSampling(profile, style) {
        const out = { ...profile };
        const persona = isPersona(style);
        for (const field of SAMPLING_FIELDS) {
            const v = persona ? personaField(field) : undefined;
            if (v === undefined) delete out[field];
            else out[field] = v;
        }
        return out;
    }

    function getInferenceParams() {
        const base = isConversational()
            ? CHAT_PROFILE
            : (EFFORT_PROFILES[getEffort()] || EFFORT_PROFILES.medium);
        const params = applyStyleSampling(base, getStyle());
        // Thinking-off requests need the instruct sampling set, because the
        // server's launch flags describe thinking mode and cannot vary per
        // request (see NON_THINKING_SAMPLING). A persona's configured values
        // still win — deviating from the model's defaults is the whole point of
        // persona mode — so only fields the style left unset are filled in.
        if (base.reasoningEffort === 'none') {
            for (const field of SAMPLING_FIELDS) {
                if (params[field] === undefined && NON_THINKING_SAMPLING[field] !== undefined) {
                    params[field] = NON_THINKING_SAMPLING[field];
                }
            }
        }
        return params;
    }

    // Style-based personality instructions. Returned as a prompt suffix so the
    // A persona block can be appended in BOTH the strict agent protocol prompt
    // and the free-form conversational prompt — previously the conversational
    // branch returned early and silently dropped the style, so toggling BONES
    // appeared to do nothing whenever conversational mode was active (e.g. left
    // on after a voice-chat session).
    function buildStyleInstructions() {
        const persona = PERSONAS[settings.style || 'neutral'];
        if (!persona) {
            // Neutral is explicitly personality-free, not merely persona-less.
            // Without this block the model improvises personal color on its
            // own (time-of-day remarks, addressing the operator by name,
            // emoji) even though no persona is set.
            return `\n\n## NEUTRAL STYLE
No personality. Strictly factual, professional tone. No personal remarks or comments about the operator, their habits, wellbeing, or the time of day. Do not address the operator by name. No emoji, no jokes, no small talk. Opinions only as technical recommendations.`;
        }
        return persona.prompt;
    }

    // Returns ONLY the stable portion of the prompt (protocol, platform,
    // effort, persona, tool catalogue). Volatile per-turn context — persistent
    // memory, mood, opinions, self-review improvements, active repo — is built
    // separately by buildDynamicContext() and appended as a TRAILING message,
    // not spliced in here. Rationale: those blocks refresh on a 5-minute timer
    // (and whenever new memory is written), so keeping them in the leading
    // system prompt changed the prompt prefix every few minutes and forced
    // LM Studio to re-evaluate the whole 20k+ token conversation from scratch
    // — the intermittent multi-second "analyzing" stall. Keeping this prefix
    // byte-stable lets the prefill cache survive across turns.
    function buildSystemPrompt() {
        // NOTE: the current date deliberately does NOT appear here — it
        // changes daily and would invalidate the prefill cache for the whole
        // conversation at midnight. It rides in the trailing dynamic-context
        // message instead (buildDynamicContext).

        // Free-form conversational mode: drop the strict Tricorder protocol
        // and use a ChatGPT-style prompt. (Memory/mood/opinions ride along in
        // the trailing dynamic-context message, same as the default mode.)
        if (isConversational()) {
            let chatPrompt = CHAT_SYSTEM_PROMPT;
            // Neutral style means no personality even in free-form chat: keep
            // the functional half of the bullet (clarifying questions), drop
            // the warmth/curiosity directive that conflicts with NEUTRAL STYLE.
            if (!isPersona(settings.style || 'neutral')) {
                chatPrompt = chatPrompt.replace(
                    '- Show personality. Be curious, warm, and engaged. Ask clarifying questions when the request is ambiguous.',
                    '- Ask clarifying questions when the request is ambiguous.'
                );
            }
            if (_platformContext) chatPrompt += `\n\n${_platformContext}`;
            // Persona applies here too — a ChatGPT-style chat with BONES on
            // should still sound like BONES.
            chatPrompt += buildStyleInstructions();
            return chatPrompt;
        }

        let prompt = SYSTEM_PROMPT;

        // Host platform (OS, shell, python binary, available tools). Injected
        // early so the model picks the right syntax before it starts planning
        // shell/tool calls further down the prompt.
        if (_platformContext) prompt += `\n\n${_platformContext}`;

        // Effort-based reasoning instructions
        // Since Qwen 3.5 always thinks internally, we steer behavior through
        // prompting: tell it to be concise at low effort, thorough at max.
        const effort = getEffort();
        if (effort === 'max') {
            prompt += `\n\n## MAX-EFFORT CHECKLIST — run literally, no skipping
1. Restate the request in one sentence — confirm the goal.
2. List 2+ approaches, pick one with a one-line reason.
3. Identify information gaps → plan the tool calls that fill them.
4. Fire independent tools in parallel.
5. After each result: plausibility check + reflection (§ Reasoning Protocol).
6. Factual claims: cross-verify 2 independent Tier-1 sources (Reuters/Bloomberg/AP/NYT/BBC). Contradictions → show BOTH with attribution.
7. Enumerate unknowns you could not resolve — state them explicitly.
8. Final answer: conclusion first, then evidence, then caveats.
Do not skip 6-7 to save time. That is what MAX exists for.`;
        } else if (effort === 'none') {
            prompt += `\n\n## FAST MODE
Be extremely concise — one-sentence answers when possible. Skip analysis, skip caveats. Do not use tools unless absolutely necessary. Answer immediately.`;
        } else if (effort === 'low') {
            prompt += `\n\n## LOW EFFORT
Answer from context and MEMORY when possible. Tools only when the answer needs live/external data — then batch what you need into ONE parallel round and answer. Never re-verify with repeated or rephrased lookups of the same thing; the tool budget this turn is a small handful of calls.`;
        }
        // medium: default behavior driven by the base Reasoning Protocol

        prompt += buildStyleInstructions();

        // NOTE: persistent memory, mood, opinions, self-review improvements and
        // the active repo used to be injected here. They now live in the
        // trailing message produced by buildDynamicContext() so this prefix
        // stays cacheable across turns — see the comment on buildSystemPrompt().

        // In-app tool layer enabled: expose it in the prompt.
        // (Compressed: the old per-family TOOL CATEGORIES list duplicated the
        // grouped catalogue tool_search returns on demand, and the standalone
        // ERROR-HANDLING PROTOCOL is folded into § METHOD above.)
        if (settings.internetAccess) {
            if (tieredToolsEnabled()) {
                prompt += `\n\n## TOOLS (tiered loading)
Attached right now: ONLY ${CORE_TOOL_NAMES.join(', ')}. More exist but are NOT attached: file writing/editing, glob/grep, documents/archives, local git, code_exec, browser automation, sqlite, RSS, code linting, dev server (live-reload previews), tasks/todos/reminders, background agents, planning/ask_user, process management, http/scrape/fact_check. Call tool_search with the INTENT first ({"query":"edit file"} → file tools, {"query":"lint"} → code_linter, {"query":"preview a page"} → dev_server); matches become directly callable on your next step. No query → full grouped catalogue. NEVER call a tool name that is not in your current function list — load it first.`;
            }
            prompt += `\n\n## ENVIRONMENT
run_command shell: ${_platformInfo && _platformInfo.platform === 'win32' ? 'cmd.exe — use `dir`/`tasklist`/`where`, not `ls`/`ps`/`which`' : 'POSIX sh'}. Python (\`${(_platformInfo && _platformInfo.pythonBin) || 'python3'}\`) preferred beyond one-liners — small script, run with -u so output streams. Workspace: ${_workspacePath} (code/, data/, downloads/, scratch/) — default cwd and output location; don't repeat the path in replies.
Tools are OpenAI tool_calls; if structured calls are unavailable, fall back to XML:
<tool_call>
<function=tool_name>
<parameter=param_name>value</parameter>
</function>
</tool_call>`;
            // Llama Instruct models get an explicit JSON-in-<tool_call>
            // preamble + tool schemas: a low-ambiguity tool format that's more
            // reliable than Llama's native python-tag convention, and it keeps
            // working even when the backend silently drops tools=[].
            //
            // The schema set is SNAPSHOTTED at turn start: a tool_search
            // mid-turn used to grow the preamble round by round, changing the
            // prompt prefix and forcing a full prefill re-evaluation on every
            // agent round. Tools loaded mid-turn ride along in a trailing
            // message instead (see buildRequestBody) so the prefix stays
            // byte-stable for the whole turn.
            if (usesXmlToolFormat()) {
                if (_xmlPreambleSnapshot === null) {
                    _xmlPreambleSnapshot = buildXmlToolPreamble();
                    _xmlSnapshotToolNames = new Set(
                        getActiveTools().map(t => t.function?.name).filter(Boolean)
                    );
                }
                prompt += _xmlPreambleSnapshot;
            }
        }
        return prompt;
    }

    // Volatile per-turn context: persistent memory, mood, opinions, self-review
    // improvements and the active repo. Returned as a standalone string so the
    // caller can append it as a TRAILING message (after the conversation
    // history) instead of splicing it into the leading system prompt.
    //
    // Why trailing? These blocks refresh every ~5 minutes and whenever new
    // memory is written, so embedding them in the prefix changed the prompt
    // every few minutes and invalidated LM Studio's prefill cache for the
    // entire conversation — a full 20k+ token re-evaluation (~5-8s) before the
    // first token. Kept after the history, the big static system prompt and the
    // history stay byte-identical across turns and remain cached; only this
    // small block (plus the new user turn) is reprocessed. Recency also helps
    // the model actually use these facts (same reasoning as the persona
    // reminder below).
    function buildDynamicContext() {
        const blocks = [];
        // Mood and stored opinions are personality features — they ride along
        // in any persona mode. Neutral means NO personality, so the tone
        // directives (e.g. late-night "suggest sleep") and stance push-back
        // instructions must not reach the model at all.
        const personaOn = isPersona(settings.style || 'neutral');
        // The date changes daily — it lives here (volatile tail) rather than
        // in the system-prompt prefix so the prefix stays byte-stable across
        // days and the prefill cache survives midnight.
        const dateLine = `Current date: ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}.`;
        // Per-turn relevance selection (seed core + top-K matches) when the
        // server endpoint delivered one; otherwise the full budgeted dump.
        const memoryBlock = _turnMemoryContext != null ? _turnMemoryContext : _memoryContext;
        if (isConversational()) {
            // Free-form mode appended these raw (no markdown headers) — keep that.
            if (memoryBlock)         blocks.push(memoryBlock);
            if (_memoryImprovements) blocks.push(_memoryImprovements);
            if (_repoContext)        blocks.push(_repoContext);
            blocks.push(dateLine);
            return blocks.join('\n\n');
        }

        blocks.push(dateLine);
        if (memoryBlock) {
            blocks.push(`## MEMORY (operator facts — apply silently; "(as of YYYY-MM)" = when the fact was last updated)
${memoryBlock}`);
        }
        // Self-review feedback distilled by the chatlog review loop.
        if (_memoryImprovements) {
            blocks.push(`## KNOWN IMPROVEMENTS (self-review feedback from past conversations)
Apply the following behavioural adjustments. The operator has implicitly or explicitly requested these in prior sessions — incorporate them into every response from now on.

${_memoryImprovements}`);
        }
        if (_repoContext) {
            blocks.push(`## ACTIVE GITHUB REPOSITORY\n${_repoContext}`);
        }
        return blocks.join('\n\n');
    }

    // Trim conversation history while preserving tool-call boundaries.
    // Never slice in the middle of an assistant→tool sequence, as orphaned
    // 'tool' messages without their 'assistant' parent cause models to
    // enter an infinite tool-calling loop.
    function trimHistory() {
        // When auto-compression is active, let compressContext() SUMMARIZE
        // older turns rather than hard-dropping them here — otherwise
        // trimHistory deletes the very context compression is meant to preserve,
        // which is why compression appeared not to work. Keep a generous
        // absolute ceiling so history still can't grow unbounded if compression
        // is disabled or failing.
        const cap = settings.autoCompress ? 80 : 20;
        if (conversationHistory.length > cap) {
            conversationHistory = conversationHistory.slice(-cap);
            while (conversationHistory.length > 1) {
                const first = conversationHistory[0];
                if (first.role === 'tool' || (first.role === 'assistant' && first.tool_calls)) {
                    conversationHistory.shift();
                } else {
                    break;
                }
            }
        }
    }

    // Compress history for sending: strip images from old messages, truncate
    // very long assistant replies (code dumps, long explanations) and digest
    // tool results from completed turns. The most recent image-bearing
    // messages (up to MAX_HISTORY_IMAGES) keep their images intact so the
    // model can still answer follow-up questions about a photo sent a few
    // turns ago; only images older than that are replaced with a text stub.
    //
    // Tool results are the big win here: a single turn can persist several
    // 12k-char tool outputs into history, and they were re-sent verbatim on
    // every following turn. Once the turn that consumed them is over, the
    // model only needs a short digest — its own assistant reply already
    // carries the conclusions. Results belonging to the CURRENT exchange
    // (everything from the last real user message on) stay untouched.
    const OLD_TOOL_DIGEST_CHARS = 300;
    // How many of the most recent image-bearing messages keep their image
    // payloads when the history is sent. Bounded because each attached photo
    // is a multi-hundred-KB base64 blob that rides along on EVERY subsequent
    // request; three covers "the picture from a couple of messages ago"
    // without letting a photo-heavy chat drown the prompt.
    const MAX_HISTORY_IMAGES = 3;
    function hasImageContent(msg) {
        return Array.isArray(msg.content) && msg.content.some(p => p.type === 'image_url');
    }
    // XML-format tool results are persisted as user-role <tool_response>
    // turns (see buildXmlToolResponseTurn) — treat those like tool messages.
    function isXmlToolResponseTurn(msg) {
        return msg.role === 'user' && typeof msg.content === 'string'
            && msg.content.trimStart().startsWith('<tool_response>');
    }
    function buildMessages() {
        const msgs = [];
        const lastIdx = conversationHistory.length - 1;
        // Start of the current exchange: the last REAL user message (skipping
        // XML tool-response turns, which are user-role only for the template).
        let lastUserIdx = -1;
        for (let i = lastIdx; i >= 0; i--) {
            const m = conversationHistory[i];
            if (m.role === 'user' && !isXmlToolResponseTurn(m)) { lastUserIdx = i; break; }
        }
        // Indices of the image-bearing messages whose images stay intact:
        // the most recent MAX_HISTORY_IMAGES of them, scanned from the end.
        const keepImageIdx = new Set();
        for (let i = lastIdx; i >= 0 && keepImageIdx.size < MAX_HISTORY_IMAGES; i--) {
            if (hasImageContent(conversationHistory[i])) keepImageIdx.add(i);
        }
        for (let i = 0; i <= lastIdx; i++) {
            const msg = conversationHistory[i];
            const isToolResult = msg.role === 'tool' || isXmlToolResponseTurn(msg);
            if (i < lastIdx && Array.isArray(msg.content) && !keepImageIdx.has(i)) {
                // Replace multimodal content with text-only for older messages
                const textParts = msg.content
                    .filter(p => p.type === 'text')
                    .map(p => p.text)
                    .join('\n');
                msgs.push({ ...msg, content: textParts || '[Image was attached]' });
            } else if (i < lastUserIdx && isToolResult && typeof msg.content === 'string'
                       && msg.content.length > OLD_TOOL_DIGEST_CHARS + 100) {
                // Digest tool results from turns that are already concluded.
                msgs.push({
                    ...msg,
                    content: msg.content.slice(0, OLD_TOOL_DIGEST_CHARS)
                        + '\n…[tool result truncated after turn completion]',
                });
            } else if (i < lastIdx - 1 && msg.role === 'assistant' && typeof msg.content === 'string' && msg.content.length > 1500) {
                // Truncate long assistant replies in older history to save prompt tokens
                // Keep the last exchange intact for continuity
                msgs.push({ ...msg, content: msg.content.substring(0, 1500) + '\n…[truncated]' });
            } else {
                msgs.push(msg);
            }
        }
        return msgs;
    }

    function buildRequestBody(streaming, extraMessages = []) {
        const params = getInferenceParams();
        const family = getModelFamily();
        const messages = [
            { role: 'system', content: buildSystemPrompt() },
            ...buildMessages(),
            ...extraMessages
        ];

        // --- Volatile tail ---
        // Everything below rides AFTER the history so the static system
        // prompt + history stay byte-stable and cacheable across turns (see
        // buildDynamicContext() for the prefill-cache rationale). Families
        // whose chat template rejects non-leading system messages (Qwen)
        // receive these as user-role turns; that is the ONLY reason
        // system-ish content ever appears in a user message.

        // XML tool mode: schemas of tools activated AFTER the turn-start
        // snapshot are appended here instead of growing the preamble in the
        // prompt prefix — mid-turn tool_search loads stay usable without
        // invalidating the prefill cache. (They also ride in body.tools below
        // for backends that honour the structured array.) This stays a
        // SEPARATE message from the dynamic-context block below because it
        // exists only mid-turn in llama-family XML mode and changes round by
        // round, while the dynamic block is stable for the whole turn.
        if (settings.internetAccess && usesXmlToolFormat() && _xmlSnapshotToolNames) {
            const lateSchemas = getActiveTools()
                .filter(t => t && t.function && !_xmlSnapshotToolNames.has(t.function.name))
                .map(t => t.function);
            if (lateSchemas.length) {
                messages.push({
                    role: REQUIRES_LEADING_SYSTEM.has(family) ? 'user' : 'system',
                    content: `Additional tools loaded this turn — callable via the same <tool_call> JSON format:\n<tools>${JSON.stringify(lateSchemas)}</tools>`,
                });
            }
        }

        // Live-context block: current date, persistent memory, mood, opinions,
        // improvements, active repo — plus the persona drift guard, all
        // CONSOLIDATED into ONE trailing message (they used to be two).
        //
        // Persona drift guard: with a multi-thousand-token prefix plus
        // history, local models stop "hearing" a style block buried at the
        // top. A short trailing reminder (recency beats primacy) keeps BONES
        // audible on every turn without re-sending the whole persona. It goes
        // LAST inside this block, which is the LAST message of the request.
        let dynamicContext = buildDynamicContext();
        const activePersona = PERSONAS[settings.style || 'neutral'];
        if (activePersona) {
            dynamicContext = dynamicContext ? `${dynamicContext}\n\n${activePersona.reminder}` : activePersona.reminder;
        }
        if (dynamicContext) {
            messages.push({
                role: REQUIRES_LEADING_SYSTEM.has(family) ? 'user' : 'system',
                content: dynamicContext,
            });
        }

        const body = {
            model: getModelId(),
            messages,
            // Clamped against the backend's real window — the tier's budget is
            // an ambition, not a guarantee the context can hold it.
            max_tokens: clampMaxTokens(params.max_tokens, messages),
            stream: streaming
        };
        // Sampling is added only when the style HAS an opinion. In NEUTRAL the
        // keys are absent from the payload entirely — not null, not 0 — so the
        // backend falls back to its own per-model defaults.
        // (presence_penalty used to be listed in every profile but was never
        // actually sent; it is on the wire now, which is what makes BONES's
        // value real.)
        for (const field of SAMPLING_FIELDS) {
            if (params[field] !== undefined) body[field] = params[field];
        }

        if (family === 'llama') {
            body.stop = LLAMA_STOPS;
        }

        // Request usage stats in the final streaming chunk (OpenAI-compatible)
        if (streaming) {
            body.stream_options = { include_usage: true };
            // ...and ask llama.cpp to MEASURE the stream rather than leaving us
            // to estimate it. With this flag every chunk carries a `timings`
            // object (predicted_n, predicted_per_second, prompt_per_second,
            // cache_n, draft_n/draft_n_accepted); without it the object rides
            // only the final chunk, which is why the live counter had to fall
            // back to counting characters and dividing by a learned
            // chars-per-token. Unknown request fields are ignored by every
            // OpenAI-shaped backend we target — a gateway injects the same flag
            // for llama.cpp anyway, so this only adds anything when Tricorder
            // talks to a llama-server directly.
            if (settings.measuredTimings !== false) body.timings_per_token = true;
        }

        // Native function calling: expose NATIVE_TOOLS as structured OpenAI
        // function schemas so the model drives the in-app agent loop.
        // parseXmlToolCalls() remains as a fallback for models that emit
        // <tool_call> XML instead of structured tool_calls.
        if (settings.internetAccess) {
            body.tools = getActiveTools();
            body.tool_choice = 'auto';
        }

        // Steer thinking depth through reasoning_effort. LM Studio's
        // /v1/chat/completions honours the tiered values (low/medium/high)
        // natively since 0.4.8, and "none" as an explicit thinking OFF
        // switch since 0.4.19 (which also fixed reasoning content being
        // replayed as non-reasoning) — so the effort tiers now map straight
        // onto the API instead of collapsing to a binary on/off. Older
        // builds ignore the field entirely; there the enable_thinking
        // template kwarg (still sent EXPLICITLY in both directions, for
        // llama.cpp-style backends that steer hybrid models through the
        // chat template) is the only lever, and the stream scanner keeps
        // any leaked scratchpad out of the visible reply regardless.
        body.chat_template_kwargs = { enable_thinking: params.reasoningEffort !== 'none' };
        // …sent in the vocabulary the loaded model declares: families whose
        // deepest level is "xhigh" reject a literal "high" outright (see
        // topLevelReasoningEffort), and a value this backend has already
        // refused this session is replaced without paying for the 400 again.
        body.reasoning_effort = applyEffortFallback(
            topLevelReasoningEffort(params.reasoningEffort, family), body.model);
        // …and again INSIDE the template kwargs, translated to Qwen's own
        // vocabulary. LM Studio maps the top-level field natively, but
        // llama.cpp's --jinja path only forwards chat_template_kwargs into the
        // template — so on llama.cpp the top-level value is inert and every
        // thinking tier renders identically. Qwen3.x reads reasoning_effort as
        // a template variable, which is what makes MED actually mean less
        // thinking than MAX; without this a MED turn thinks at full depth
        // (48,970 tokens observed on a single reply). Templates that don't know
        // the variable ignore it.
        body.chat_template_kwargs.reasoning_effort =
            QWEN_REASONING_EFFORT[body.reasoning_effort] || 'medium';
        // …and declare whether the reasoning this request DOES carry (see
        // pushAssistantRound) should be rendered back into the prompt. Sent
        // explicitly in both directions: the model's own default is ON, so
        // "off" has to be stated, and "on" is worth stating next to the
        // messages that depend on it.
        if (PRESERVE_THINKING_FAMILIES.has(family)) {
            body.chat_template_kwargs.preserve_thinking =
                preservesThinking() && params.reasoningEffort !== 'none';
        }
        // Muse Glimmer: ride the family's own knob along in
        // chat_template_kwargs for llama.cpp-style backends that forward
        // template kwargs (LM Studio instead maps reasoning_effort natively
        // since its Muse launch-day build). Unknown kwargs are inert in other
        // templates, but keep this gated so the request states intent clearly.
        if (family === 'muse') {
            body.chat_template_kwargs.reasoning_strength =
                MUSE_REASONING_STRENGTH[params.reasoningEffort] || 'medium';
        }

        logPromptBreakdown(body, extraMessages.length);

        return body;
    }

    // --- Prompt-size debug instrumentation (settings.debugPromptTokens) ---
    // Logs an estimated per-section breakdown when each request is built, and
    // buildStats() logs the ACTUAL prompt_tokens the backend reported next to
    // the estimate once usage arrives. Estimates use chars/3.5 (BPE-ish);
    // the estimate vs. actual delta is the chat template's framing overhead.
    let _lastPromptBreakdown = null;
    function logPromptBreakdown(body, extraCount) {
        if (!settings.debugPromptTokens) return;
        const msgChars = (m) => contentEstChars(m.content);
        const msgs = body.messages || [];
        const system = msgs.length && msgs[0].role === 'system' ? msgChars(msgs[0]) : 0;
        // The volatile tail is everything this request appended after history
        // (dynamic context / late XML schemas) — identified from the back.
        let tail = 0, tailCount = 0;
        for (let i = msgs.length - 1; i > 0; i--) {
            const c = typeof msgs[i].content === 'string' ? msgs[i].content : '';
            if (c.startsWith('Current date:') || c.includes('## MEMORY') || c.startsWith('REMINDER:') || c.startsWith('Additional tools loaded')) {
                tail += msgChars(msgs[i]); tailCount++;
            } else break;
        }
        const history = msgs.slice(1, msgs.length - tailCount).reduce((n, m) => n + msgChars(m), 0);
        const toolsJson = body.tools ? JSON.stringify(body.tools) : '';
        _lastPromptBreakdown = {
            sections: {
                system_prefix: { chars: system, estTokens: Math.ceil(system / 3.5) },
                tools: { count: (body.tools || []).length, chars: toolsJson.length, estTokens: Math.ceil(toolsJson.length / 3.5) },
                history: { messages: msgs.length - 1 - tailCount, chars: history, estTokens: Math.ceil(history / 3.5) },
                volatile_tail: { messages: tailCount, chars: tail, estTokens: Math.ceil(tail / 3.5) },
            },
            estTotal: Math.ceil((system + history + tail + toolsJson.length) / 3.5),
            extraMessages: extraCount,
        };
        console.log('[prompt-tokens] request breakdown (est, chars/3.5):', JSON.stringify(_lastPromptBreakdown.sections),
            `estTotal=${_lastPromptBreakdown.estTotal}`,
            `toolNames=[${(body.tools || []).map(t => t.function?.name).join(', ')}]`);
    }

    function usesXmlToolFormat() {
        return getModelFamily() === 'llama';
    }

    // Turn-scoped snapshot of the XML tool preamble (and the tool names it
    // covers), so the prompt PREFIX stays byte-identical across all rounds of
    // one turn even when tool_search activates more tools mid-turn. Cleared
    // by newPromptTurn() at the start of every turn.
    let _xmlPreambleSnapshot = null;
    let _xmlSnapshotToolNames = null;
    function newPromptTurn() {
        _xmlPreambleSnapshot = null;
        _xmlSnapshotToolNames = null;
    }

    // Build the JSON-in-<tool_call> function-calling preamble: tool schemas
    // inside a <tools>[...]</tools> block in the system prompt, calls emitted
    // as <tool_call>{json}</tool_call>. Llama 3.x Instruct picks up this
    // convention reliably from the in-context schemas + few-shot-shaped
    // instructions — more robust than fighting Llama's brittle native
    // <|python_tag|> tool format, and it keeps working even when the backend
    // doesn't forward a structured `tools` array.
    function buildXmlToolPreamble() {
        const schemas = getActiveTools()
            .filter(t => t && t.function)
            .map(t => t.function);
        // Compact JSON so the preamble doesn't blow the prompt budget.
        const toolsJson = JSON.stringify(schemas);
        return `\n\n## FUNCTION CALLING (XML format)
You are a function-calling AI model. You are provided with function signatures within <tools></tools> XML tags. You may call one or more functions to assist with the user query. Don't make assumptions about what values to plug into functions.

<tools>${toolsJson}</tools>

For each function call, return a JSON object with the function name and arguments inside <tool_call></tool_call> XML tags, EXACTLY in this shape:
<tool_call>
{"name": "<function-name>", "arguments": <args-dict>}
</tool_call>

Multiple parallel calls: emit multiple <tool_call> blocks back-to-back. Tool results will be returned to you inside <tool_response></tool_response> tags. Do NOT fabricate <tool_response> blocks yourself — only the runtime emits those.`;
    }

    // --- Code-change approval gate ---
    // Tools that modify files on disk. When settings.confirmCodeChanges is on
    // and the UI registered an approval handler, each of these calls is shown
    // to the operator with Accept/Deny buttons BEFORE it is executed.
    // Includes file writes plus the other irreversible actions (shell,
    // deletes, git mutations). Mirrors the server's MUTATING_TOOLS guard so a
    // destructive call is never executed silently when the operator asked to
    // confirm changes.
    const CODE_CHANGE_TOOLS = new Set([
        'write_file', 'file_edit', 'run_command', 'code_exec',
        'task_delete', 'git_operations', 'process_manager', 'archive_tool',
    ]);

    // Registered by app.js — receives { id, name, args } and resolves to
    // true (accept), false (deny), or 'always' (accept + stop asking for the
    // rest of this session). No handler = everything auto-approved.
    let _toolApprovalHandler = null;
    function setToolApprovalHandler(fn) {
        _toolApprovalHandler = typeof fn === 'function' ? fn : null;
    }

    // Set once the operator clicks "Always allow": skip the approval gate for
    // every code-changing tool until the page is reloaded or a new
    // conversation is started. Cleared by resetApprovalSession().
    let _approveAllSession = false;
    // Paths whose write the operator already approved this turn. A chunked
    // write is ONE decision: approving the first chunk approves the append
    // continuations and follow-up edits of the same file, so a 10-chunk write
    // doesn't pop 10 approval cards.
    const _approvedWritePaths = new Set();
    function resetApprovalSession() { _approveAllSession = false; _approvedWritePaths.clear(); }

    // Split tool calls into approved/denied by asking the operator about
    // code-changing ones. Non-code tools pass through untouched.
    async function gateCodeChanges(toolCalls, emitStatus = null) {
        if (!settings.confirmCodeChanges || !_toolApprovalHandler || _approveAllSession) {
            return { approved: toolCalls, denied: [] };
        }
        const approved = [];
        const denied = [];
        for (const tc of toolCalls) {
            const name = tc.function?.name || tc.name || '';
            if (!CODE_CHANGE_TOOLS.has(name) || _approveAllSession) {
                approved.push(tc);
                continue;
            }
            let args = {};
            try {
                args = typeof tc.function?.arguments === 'string'
                    ? JSON.parse(tc.function.arguments)
                    : (tc.function?.arguments || {});
            } catch { /* show the card anyway with empty args */ }
            // Continuations of an already-approved file need no new card: an
            // append chunk or a follow-up edit to the same path is part of the
            // write the operator just approved. A fresh overwrite still asks.
            const writePath = typeof args.path === 'string' ? args.path : null;
            if (writePath && _approvedWritePaths.has(writePath) &&
                (name === 'file_edit' || (name === 'write_file' && args.append === true))) {
                approved.push(tc);
                continue;
            }
            // Mark the chip as blocked on the operator instead of leaving it on
            // the ambiguous "waiting…" badge — otherwise a pending approval card
            // (which the operator may not have scrolled to yet) looks like a hang.
            if (emitStatus) {
                emitStatus({
                    phase: 'tool_progress',
                    kind: 'progress',
                    tool: name,
                    tool_call_id: tc.id,
                    awaitingApproval: true,
                });
            }
            let verdict = false;
            try {
                verdict = await _toolApprovalHandler({ id: tc.id, name, args });
            } catch { verdict = false; }
            // "always" → approve this call and stop asking for the rest of the
            // session, so the agent loop doesn't keep popping approval cards.
            if (verdict === 'always') _approveAllSession = true;
            if (verdict) {
                approved.push(tc);
                if (writePath && (name === 'write_file' || name === 'file_edit' || name === 'file_write' || name === 'file_create')) {
                    _approvedWritePaths.add(writePath);
                }
            } else {
                denied.push(tc);
                // Resolve the tool chip in the UI as failed so it doesn't
                // sit on "waiting…" forever.
                if (emitStatus) {
                    emitStatus({
                        phase: 'tool_progress',
                        kind: 'error',
                        tool: name,
                        tool_call_id: tc.id,
                        error: 'denied by operator',
                    });
                }
            }
        }
        return { approved, denied };
    }

    function deniedToolResult(tc) {
        return {
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify({
                error: 'The operator DENIED this change. Do not retry the same modification. Either ask the operator how to proceed or continue the task without this change.',
            }),
        };
    }

    // Save streaming file blocks (```lang file=path … ``` in the reply text)
    // to disk through the standard write_file machinery. Synthesized tool
    // calls mean approval gating, per-tool progress chips, and server-side
    // path checks all apply unchanged. On failure or denial the original
    // fenced block is restored into the visible reply so the code is never
    // lost. Mutates result.text and fileProgress; returns
    // { wrote, failed: [{path, error}] }.
    async function applyFileFences(result, emitStatus, fileProgress, round, announceToolCalls) {
        // Fence ↔ write_file bounce guard: a fence whose content is byte-
        // identical to what this turn already put on disk is a re-delivery,
        // not a change — skip the write (and its approval card) entirely.
        const fences = (result.fileFences || []).filter(f => fileProgress[f.path] !== f.content);
        if (!fences.length) return { wrote: false, failed: [], wrotePaths: [] };
        const calls = fences.map((f, i) => ({
            id: `fence_${round}_${i}_${Date.now()}`,
            type: 'function',
            function: { name: 'write_file', arguments: JSON.stringify({ path: f.path, content: f.content }) },
        }));
        // Route through the turn's cumulative announcer so fence writes join
        // the same AGENT TOOLS list as real tool calls (see the announcer's
        // comment on why per-batch arrays made entries disappear).
        if (announceToolCalls) {
            announceToolCalls(calls);
        } else if (emitStatus) {
            emitStatus({
                phase: 'tool_calling',
                tools: fences.map(f => `write_file: ${f.path}`),
                toolMeta: buildToolMeta(calls.map(c => ({ name: 'write_file', arguments: c.function.arguments }))),
                toolIds: calls.map(c => c.id),
            });
        }
        const results = await executeToolCalls(calls, emitStatus);
        let wrote = false;
        const failed = [];
        const wrotePaths = [];
        for (let i = 0; i < calls.length; i++) {
            const f = fences[i];
            const r = results.find(x => x.tool_call_id === calls[i].id);
            let error = null;
            try { error = JSON.parse(r?.content ?? '{}')?.error || null; } catch { /* non-JSON output = success */ }
            if (error) {
                failed.push({ path: f.path, error: String(error) });
                const marker = `📄 \`${f.path}\``;
                result.text = result.text.includes(marker)
                    ? result.text.replace(marker, f.raw)
                    : `${result.text}\n\n${f.raw}`;
                continue;
            }
            wrote = true;
            wrotePaths.push(f.path);
            fileProgress[f.path] = f.content;
            if (emitStatus) emitStatus({ phase: 'file_stream', name: 'file_block', path: f.path, content: f.content });
        }
        return { wrote, failed, wrotePaths };
    }

    // The agent loop injects synthetic "[System: …]" user turns mid-run to nudge
    // the model (self-correction after errors, interleaved-thinking prompts).
    // Those are scaffolding for a single turn — persisting them re-sends the
    // nudges on every later request and pollutes saved chats. Strip them before
    // committing the round to history; the real tool_calls/results stay.
    function persistableAgentMessages(agentMessages) {
        return agentMessages
            .filter(m =>
                !(m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('[System:'))
            )
            // Preserved thinking is a WITHIN-TURN mechanism (see
            // pushAssistantRound): it stops round 9 re-deriving round 3. Once
            // the turn has landed its answer, the scratchpad has served its
            // purpose and the answer carries the meaning. Left attached, every
            // trace would ride along in every later request forever —
            // buildMessages() replays history verbatim — which is the exact
            // context blowout the round window exists to prevent.
            .map(m => {
                if (!m || !m.reasoning_content) return m;
                const { reasoning_content, ...rest } = m;
                return rest;
            });
    }

    // Interleaved-thinking nudge (medium/max effort): prompt the model to
    // reflect on tool results between rounds. Throttled to every SECOND round
    // (2, 4, 6, …) — the nudge is static, so injecting it after every round
    // added no information — and earlier copies are removed before the next
    // one is pushed so they never accumulate in the request.
    const INTERLEAVED_NUDGE_PREFIX = '[System: Tools returned results';
    function shouldInjectInterleavedNudge(effortProfile, round) {
        return effortProfile.interleavedThinking && round < MAX_TOOL_ROUNDS
            && round > 1 && round % 2 === 0;
    }
    function pushInterleavedNudge(agentMessages, toolNames) {
        for (let i = agentMessages.length - 1; i >= 0; i--) {
            const m = agentMessages[i];
            if (m.role === 'user' && typeof m.content === 'string'
                && m.content.startsWith(INTERLEAVED_NUDGE_PREFIX)) {
                agentMessages.splice(i, 1);
            }
        }
        agentMessages.push({
            role: 'user',
            content: `[System: Tools returned results (${toolNames}). Think step-by-step: What did you learn? Does this change your plan? What should you do next? If you have enough information, provide your final answer.]`
        });
    }

    // Execute tool calls via Tricorder's server-side tool runner.
    //
    // When emitStatus is supplied, we use the SSE streaming endpoint
    // /api/tools/execute-stream so the caller receives live per-tool
    // progress events (bytes downloaded, heartbeat pulses, per-tool
    // done/error). Without emitStatus, or if streaming fails, we fall
    // back to the original blocking JSON endpoint.
    //
    // Progress events are forwarded as:
    //   { phase: 'tool_progress', kind, tool, index, tool_call_id,
    //     elapsedMs, bytes, totalBytes, message, error }
    //
    // Returns an array of { tool_call_id, role: 'tool', content } messages
    // ready to be appended to the conversation for the next LLM round.
    // Guard against runaway tool output. Individual tools cap their own output,
    // but several large results per round — accumulated across up to
    // MAX_TOOL_ROUNDS — can still balloon the prompt and trip a backend context
    // overflow (which itself surfaces as a dropped stream). Cap each result and
    // the per-round total, leaving a hint so the model fetches more narrowly.
    // Head+tail truncation. A plain head-slice loses exactly the part that
    // matters for logs/build output (the error is at the END) and cuts JSON
    // mid-structure; keeping both ends preserves the summary lines at the top
    // AND the tail the model usually needs.
    function headTailTruncate(s, headLen, tailLen, hint) {
        if (s.length <= headLen + tailLen) return s;
        const cut = s.length - headLen - tailLen;
        return s.slice(0, headLen)
            + `\n…[${cut} chars truncated${hint ? ' — ' + hint : ''}]…\n`
            + s.slice(s.length - tailLen);
    }

    // Structure-aware shrink for parseable JSON tool output: cap long arrays
    // (first N entries + a count note) and very long strings instead of
    // cutting the serialized text mid-structure. Returns the pruned JSON
    // string, or null when pruning didn't help enough.
    const JSON_PRUNE_ARRAY_KEEP = 20;
    const JSON_PRUNE_STRING_MAX = 2000;
    function _pruneJsonValue(v, depth = 0) {
        if (typeof v === 'string') {
            return v.length > JSON_PRUNE_STRING_MAX
                ? v.slice(0, JSON_PRUNE_STRING_MAX) + '…[string truncated]'
                : v;
        }
        if (Array.isArray(v)) {
            if (depth > 6) return '[…]';
            const out = v.slice(0, JSON_PRUNE_ARRAY_KEEP).map(x => _pruneJsonValue(x, depth + 1));
            if (v.length > JSON_PRUNE_ARRAY_KEEP) {
                out.push(`…[${v.length - JSON_PRUNE_ARRAY_KEEP} of ${v.length} items truncated — use more specific parameters]`);
            }
            return out;
        }
        if (v && typeof v === 'object') {
            if (depth > 6) return '{…}';
            const out = {};
            for (const k of Object.keys(v)) out[k] = _pruneJsonValue(v[k], depth + 1);
            return out;
        }
        return v;
    }
    function pruneJsonToBudget(raw, budget) {
        const trimmed = raw.trimStart();
        if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
        try {
            const pruned = JSON.stringify(_pruneJsonValue(JSON.parse(raw)));
            return pruned.length <= budget ? pruned : null;
        } catch { return null; }
    }

    function capToolResults(results) {
        const PER_TOOL = 12000;
        const PER_TOOL_HEAD = 8000;
        const PER_TOOL_TAIL = 3000;
        const TOTAL = 40000;
        let used = 0;
        return results.map(r => {
            let c = typeof r.content === 'string' ? r.content : String(r.content ?? '');
            if (c.length > PER_TOOL) {
                // Prefer a structure-aware shrink for JSON payloads; fall back
                // to head+tail so the end of logs/output survives.
                c = pruneJsonToBudget(c, PER_TOOL)
                    ?? headTailTruncate(c, PER_TOOL_HEAD, PER_TOOL_TAIL,
                        'tool output too large — use more specific parameters');
            }
            if (used + c.length > TOTAL) {
                const room = Math.max(0, TOTAL - used);
                c = room > 600
                    ? headTailTruncate(c, Math.floor(room * 0.7), Math.floor(room * 0.3),
                        'combined tool-output budget for this round reached')
                    : c.slice(0, room) + '\n[…truncated: combined tool-output budget for this round reached]';
            }
            used += c.length;
            return { ...r, content: c };
        });
    }

    // Tiered loading: run tool_search in the client so it can ACTIVATE the
    // matched tools for the rest of the turn (the model can only structurally
    // call tools whose schema we put in the next request). Returns a tool-role
    // result message; matched tools are added to the active set as a side effect.
    function shortDesc(d) {
        const s = (d || '').replace(/\s+/g, ' ').trim();
        return s.length > 160 ? s.slice(0, 157) + '…' : s;
    }
    function handleToolSearchLocal(tc) {
        let query = '';
        try { query = String(JSON.parse(tc.function.arguments || '{}').query || '').trim(); }
        catch { /* malformed args → treat as list-all */ }
        const callable = NATIVE_TOOLS
            .filter(t => t.function && t.function.name !== 'tool_search')
            .map(t => ({ name: t.function.name, description: t.function.description || '' }));
        const index = (typeof TricorderToolIndex !== 'undefined') ? TricorderToolIndex : null;
        let content;
        if (!query) {
            // Grouped catalogue: structured map of every tool by category, so the
            // model knows what families exist and which keyword to load. Names
            // only (no schemas) and we DON'T activate anything — that would
            // re-send the full schema set and defeat tiering.
            if (index) {
                const groups = index.catalogue(callable);
                const lines = groups.map(g => `${g.label}: ${g.tools.join(', ')}`);
                content = `${callable.length} tools in ${groups.length} groups. Call tool_search with a keyword (e.g. {"query":"email"}) to load a group's tools:\n${lines.join('\n')}`;
            } else {
                const names = callable.map(t => t.name);
                content = `${names.length} tools available. Call tool_search with a keyword (e.g. {"query":"github"}) to load the ones you need:\n${names.join(', ')}`;
            }
        } else {
            // Intent-aware ranking: matches by name/description AND synonym
            // keywords (so "edit file"→file tools, "lint"→code_linter).
            const TOP = 12;
            const { matches, total } = index
                ? index.search(callable, query, { top: TOP })
                : legacyToolSearch(callable, query, TOP);
            if (!matches.length) {
                content = `No tools matched "${query}". Call tool_search with no query to see the grouped catalogue.`;
            } else {
                activateTools(matches.map(m => m.name));
                const lines = matches.map(m => `- ${m.name}: ${shortDesc(m.description)}`);
                const more = total > matches.length ? `\n(+${total - matches.length} more matched — refine the query if you need others.)` : '';
                content = `Loaded ${matches.length} tool(s) — now directly callable:\n${lines.join('\n')}${more}`;
            }
        }
        return { role: 'tool', tool_call_id: tc.id, content };
    }
    // Fallback ranking if the shared index module failed to load — preserves
    // the original substring behaviour so discovery never goes dark.
    function legacyToolSearch(callable, query, top) {
        const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
        const scored = callable.map(t => {
            const name = t.name.toLowerCase();
            const desc = (t.description || '').toLowerCase();
            let score = 0;
            for (const term of terms) { if (name.includes(term)) score += 2; if (desc.includes(term)) score += 1; }
            return { name: t.name, description: t.description, score };
        }).filter(x => x.score > 0).sort((a, b) => b.score - a.score);
        return { matches: scored.slice(0, top), total: scored.length };
    }

    // Per-turn log of what each tool call actually DID: { name, ok, error }.
    // This is the evidence trail the UI's evidence meter consumes — real
    // execution outcomes, not regex guesses over the reply prose. Reset at
    // the start of every user turn (sendStream / sendMessage).
    let _turnToolEvents = [];

    function recordTurnToolEvents(allToolCalls, results) {
        const nameById = new Map(
            allToolCalls.map(tc => [tc.id, tc.function?.name || tc.name || 'unknown'])
        );
        for (const r of results || []) {
            if (!r || r.role !== 'tool') continue;
            let error = null;
            try { error = JSON.parse(r.content)?.error || null; } catch { /* non-JSON = success payload */ }
            _turnToolEvents.push({
                name: nameById.get(r.tool_call_id) || 'unknown',
                ok: !error,
                error,
            });
        }
    }

    async function executeToolCalls(allToolCalls, emitStatus = null) {
        const results = await executeToolCallsInner(allToolCalls, emitStatus);
        recordTurnToolEvents(allToolCalls, results);
        return results;
    }

    // --- Per-turn repeat-call guard ---
    // Uncertain models re-run the SAME lookup to "double-check" (the observed
    // pattern: web_fetch of one URL twice, back to back). For idempotent read
    // tools an identical call inside one turn is answered from a per-turn
    // cache with an explicit stop notice instead of re-executed — the model
    // gets its answer instantly and is told to move on. Stateful tools are
    // excluded: repeating run_command/git status legitimately re-reads state.
    const REPEATABLE_READ_TOOLS = new Set(['web_fetch', 'web_search']);
    function repeatCallKey(tc) {
        return `${tc.function?.name} ${tc.function?.arguments || ''}`;
    }
    async function executeToolCallsGuarded(toolCalls, emitStatus, repeatCache) {
        if (!repeatCache) return executeToolCalls(toolCalls, emitStatus);
        const fresh = [];
        const replayed = [];
        for (const tc of toolCalls) {
            const key = REPEATABLE_READ_TOOLS.has(tc.function?.name) ? repeatCallKey(tc) : null;
            const prior = key ? repeatCache.get(key) : undefined;
            if (prior !== undefined) {
                replayed.push({
                    role: 'tool',
                    tool_call_id: tc.id,
                    content: `[REPEAT CALL: this exact ${tc.function.name} already ran this turn — cached result below. Do NOT repeat it; if it was insufficient, change the query/URL or answer with what you have.]\n${prior}`,
                });
            } else {
                fresh.push(tc);
            }
        }
        const results = fresh.length ? await executeToolCalls(fresh, emitStatus) : [];
        for (const tc of fresh) {
            if (!REPEATABLE_READ_TOOLS.has(tc.function?.name)) continue;
            const r = results.find(x => x.tool_call_id === tc.id);
            if (!r || typeof r.content !== 'string') continue;
            // Never cache failures — a transient fetch error must stay
            // retryable, only successful lookups are final for the turn.
            let failed = false;
            try { failed = !!JSON.parse(r.content)?.error; } catch { /* non-JSON = success payload */ }
            if (!failed) repeatCache.set(repeatCallKey(tc), r.content);
        }
        return [...results, ...replayed];
    }

    async function executeToolCallsInner(allToolCalls, emitStatus = null) {
        // Actual invocations feed the cross-turn carry-over (tool_search is
        // core anyway and would only pollute the map).
        noteToolsUsed(allToolCalls
            .map(tc => tc.function?.name)
            .filter(n => n && n !== 'tool_search'));
        // Intercept tool_search locally so discovery expands the active toolset.
        // (When tiering is off, let it run server-side like any other tool.)
        let searchResults = [];
        let workCalls = allToolCalls;
        if (tieredToolsEnabled()) {
            const searches = allToolCalls.filter(tc => tc.function?.name === 'tool_search');
            if (searches.length) {
                searchResults = searches.map(handleToolSearchLocal);
                workCalls = allToolCalls.filter(tc => tc.function?.name !== 'tool_search');
            }
        }
        if (workCalls.length === 0) return searchResults;

        // Operator approval for irreversible tools (writes, shell, sends, deletes).
        const { approved: toolCalls, denied } = await gateCodeChanges(workCalls, emitStatus);
        const deniedResults = denied.map(deniedToolResult);
        if (toolCalls.length === 0) return [...deniedResults, ...searchResults];

        if (emitStatus) {
            try {
                const streamed = await executeToolCallsStreaming(toolCalls, emitStatus);
                return [...capToolResults(streamed), ...deniedResults, ...searchResults];
            } catch (err) {
                // Fall through to the blocking endpoint so one broken
                // stream can't take down a tool round.
                console.warn('[tools] streaming tool exec failed, falling back:', err.message);
            }
        }
        // The blocking endpoint emits no per-tool progress, so without these
        // synthetic start/done events the chips would sit on "waiting…" for the
        // whole call and (on error) never resolve at all.
        if (emitStatus) {
            for (const tc of toolCalls) {
                emitStatus({ phase: 'tool_progress', kind: 'start', tool: tc.function?.name || tc.name, tool_call_id: tc.id });
            }
        }
        let res;
        try {
            res = await fetchWithRetry(`${window.location.origin}/api/tools/execute`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...getExtraHeaders() },
                body: JSON.stringify({ tool_calls: toolCalls }),
                signal: withTurnSignal(AbortSignal.timeout(60000))
            });
        } catch (err) {
            if (emitStatus) {
                for (const tc of toolCalls) {
                    emitStatus({ phase: 'tool_progress', kind: 'error', tool: tc.function?.name || tc.name, tool_call_id: tc.id, error: err.message });
                }
            }
            throw err;
        }
        if (!res.ok) {
            const errText = await safeResponseText(res);
            if (emitStatus) {
                for (const tc of toolCalls) {
                    emitStatus({ phase: 'tool_progress', kind: 'error', tool: tc.function?.name || tc.name, tool_call_id: tc.id, error: `HTTP ${res.status}` });
                }
            }
            throw new Error(`Tool execution failed (${res.status}): ${errText}`);
        }
        const data = await res.json();
        const results = (data.results || []).map(r => ({
            role: 'tool',
            tool_call_id: r.tool_call_id,
            content: r.output || r.error || 'No output'
        }));
        if (emitStatus) {
            for (const r of (data.results || [])) {
                let isErr = false;
                try { isErr = !!JSON.parse(r.output || r.error || '{}')?.error; } catch { isErr = !!r.error; }
                emitStatus({
                    phase: 'tool_progress',
                    kind: isErr ? 'error' : 'done',
                    tool_call_id: r.tool_call_id,
                    outputBytes: (r.output || '').length,
                    error: isErr ? 'failed' : undefined,
                });
            }
        }
        return [...capToolResults(results), ...deniedResults, ...searchResults];
    }

    async function executeToolCallsStreaming(toolCalls, emitStatus) {
        // Longer timeout — tools can legitimately run minutes (downloads,
        // fact_check deep mode, archive extraction). The SSE heartbeat keeps
        // the user informed even when the network stack is idle.
        const res = await fetch(`${window.location.origin}/api/tools/execute-stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...getExtraHeaders() },
            body: JSON.stringify({ tool_calls: toolCalls }),
            signal: withTurnSignal(AbortSignal.timeout(600000)),
        });
        if (!res.ok) {
            const errText = await safeResponseText(res);
            throw new Error(`Tool stream failed (${res.status}): ${errText}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let finalResults = null;

        // Parse SSE events of the form:
        //   event: <name>\n
        //   data: <json>\n\n
        const handleEvent = (event, data) => {
            let payload;
            try { payload = JSON.parse(data); } catch { return; }
            switch (event) {
                case 'tool_start':
                    emitStatus({ phase: 'tool_progress', kind: 'start', ...payload });
                    break;
                case 'tool_progress':
                    emitStatus({ phase: 'tool_progress', kind: 'progress', ...payload });
                    break;
                case 'tool_heartbeat':
                    emitStatus({ phase: 'tool_progress', kind: 'heartbeat', ...payload });
                    break;
                case 'tool_done':
                    emitStatus({ phase: 'tool_progress', kind: 'done', ...payload });
                    break;
                case 'tool_error':
                    emitStatus({ phase: 'tool_progress', kind: 'error', ...payload });
                    break;
                case 'done':
                    finalResults = payload.results || [];
                    break;
            }
        };

        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let idx;
            while ((idx = buffer.indexOf('\n\n')) !== -1) {
                const raw = buffer.slice(0, idx);
                buffer = buffer.slice(idx + 2);
                let event = 'message';
                const dataLines = [];
                for (const line of raw.split('\n')) {
                    if (line.startsWith(':')) continue; // SSE comment / keepalive
                    if (line.startsWith('event:')) event = line.slice(6).trim();
                    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
                }
                if (dataLines.length > 0) handleEvent(event, dataLines.join('\n'));
            }
        }

        if (!finalResults) {
            throw new Error('Tool stream ended without final results');
        }
        return finalResults.map(r => ({
            role: 'tool',
            tool_call_id: r.tool_call_id,
            content: r.output || r.error || 'No output'
        }));
    }

    // Convert OpenAI-shaped tool results into the <tool_response> dialect that
    // pairs with the XML tool preamble: a single user turn whose content is one
    // or more <tool_response>{json}</tool_response> blocks. For models driven
    // by the XML preamble this gives markedly cleaner follow-up generations
    // than smuggling results through OpenAI tool-role messages. Returns a
    // single user-role message.
    function buildXmlToolResponseTurn(toolCalls, toolResults) {
        const byId = {};
        for (const r of toolResults) {
            byId[r.tool_call_id] = r.content;
        }
        const blocks = toolCalls.map(tc => {
            const out = byId[tc.id] ?? 'No output';
            // Prefer a parsed object when the tool runner returned valid JSON
            // so the model sees structured data rather than a re-stringified blob.
            let parsed = null;
            try { parsed = JSON.parse(out); } catch { /* leave as string */ }
            const payload = parsed != null
                ? JSON.stringify({ name: tc.function.name, content: parsed })
                : JSON.stringify({ name: tc.function.name, content: String(out) });
            return `<tool_response>\n${payload}\n</tool_response>`;
        }).join('\n');
        return { role: 'user', content: blocks };
    }

    // --- Split-safe streaming tag scanner (shared by both stream paths) ---
    // <think>/<tool_call> tags arrive token-by-token and can be split across
    // SSE deltas ('<th' + 'ink>'). Per-delta includes() checks miss those
    // splits, so reasoning either leaked into the visible reply or never
    // reached the reasoning panel at all — most visibly at LOW/MED effort,
    // where the backend is asked not to think but hybrid models sometimes
    // think anyway, and the scratchpad then arrives as plain content deltas
    // instead of reasoning_content. The scanner buffers unprocessed text,
    // routes complete segments to the right sink (visible / thinking / tool),
    // and holds back only a tail that could still grow into a tag.
    //
    // Thinking-locked models add one more shape: the chat template pre-opens
    // the think block, so the stream never contains '<think>' at all — the
    // first bytes are scratchpad text, terminated by a bare '</think>'. When
    // a closing tag shows up in text mode before any opener was seen,
    // everything routed to the visible sink so far was actually reasoning;
    // the implicitThinkClose sink lets the caller pull it back out of the
    // reply. Fired at most once per stream so a model that merely *mentions*
    // the tag later in a real answer can't wipe the reply twice.
    //
    // SWALLOW_TAGS are dropped outright (stop/control tokens that leak when
    // a stop sequence fires a token late) — including them here means even
    // ones split across deltas never flash on screen.
    // <|eom|>/<|eot|> are Muse Glimmer's channel terminators; they must sit
    // AFTER <|eot_id|> in this list so the tie at an identical buffer index
    // resolves to the longer Llama token instead of leaving a bare '_id|>'.
    const SWALLOW_TAGS = ['<|im_end|>', '<|im_start|>', '<|endoftext|>', '<|eot_id|>', '<|end_of_text|>', '<|eom|>', '<|eot|>'];
    // Muse Glimmer channel-header markers. On a current backend the server
    // splits the channels (to=self → reasoning_content, to=user → content)
    // and none of these ever reach the client — this is the guard for the
    // collapse case (old LM Studio, template-less GGUF, llama.cpp fallback),
    // where the raw '<|start|>assistant to=self<|message|>…' stream would
    // otherwise dump the whole scratchpad plus markers into the visible reply.
    const MUSE_CHANNEL_TAGS = ['<|start|>', '<|message|>'];
    const SCAN_TAGS = ['<think>', '</think>', '<tool_call>', '</tool_call>', '<tool_response>', '</tool_response>', ...MUSE_CHANNEL_TAGS, ...SWALLOW_TAGS];

    function createStreamTagScanner(sinks) {
        let buf = '';
        let mode = 'text'; // 'text' | 'think' | 'tool'
        let sawThinkOpen = false;
        let toolIsResponse = false;
        let chanHeader = null; // buffers '<|start|>…<|message|>' header text
        let chanThink = false; // current think mode was set by a channel header

        const route = (s) => {
            if (!s) return;
            if (chanHeader !== null) {
                // Between '<|start|>' and '<|message|>' the stream carries the
                // channel header ('assistant to=self') — metadata, never
                // content. Real headers are short; past 64 chars this was a
                // literal '<|start|>' in prose, so hand the text back to the
                // real sink instead of eating the rest of the reply.
                chanHeader += s;
                if (chanHeader.length > 64) {
                    const spill = chanHeader;
                    chanHeader = null;
                    route(spill);
                }
                return;
            }
            if (mode === 'think') sinks.think(s);
            else if (mode === 'tool') sinks.toolText(s, toolIsResponse);
            else sinks.text(s);
        };

        const step = (flush) => {
            while (buf) {
                let tagIdx = -1, tag = '';
                for (const t of SCAN_TAGS) {
                    const i = buf.indexOf(t);
                    if (i !== -1 && (tagIdx === -1 || i < tagIdx)) { tagIdx = i; tag = t; }
                }
                if (tagIdx === -1) {
                    // No complete tag — emit everything except a tail that
                    // is still a prefix of a known tag (unless flushing).
                    let hold = 0;
                    if (!flush) {
                        const lastLt = buf.lastIndexOf('<');
                        if (lastLt !== -1 && buf.length - lastLt < 16) {
                            const tail = buf.slice(lastLt);
                            if (SCAN_TAGS.some(t => t.startsWith(tail))) hold = buf.length - lastLt;
                        }
                    }
                    const out = hold ? buf.slice(0, buf.length - hold) : buf;
                    buf = hold ? buf.slice(buf.length - hold) : '';
                    route(out);
                    return;
                }
                route(buf.slice(0, tagIdx));
                buf = buf.slice(tagIdx + tag.length);
                if (SWALLOW_TAGS.includes(tag)) {
                    // dropped — no mode change, except Muse's channel
                    // terminators, which also close any channel routing so the
                    // next message starts from a clean text state.
                    if (tag === '<|eom|>' || tag === '<|eot|>') {
                        chanHeader = null;
                        if (chanThink) { chanThink = false; mode = 'text'; }
                    }
                } else if (tag === '<|start|>') {
                    chanHeader = '';
                } else if (tag === '<|message|>') {
                    if (chanHeader !== null) {
                        // to=user is the final answer; every other recipient
                        // (to=self scratchpad, to=<tool> calls) belongs in the
                        // thinking panel, never the visible reply. A header
                        // with no recipient at all is treated as user-facing.
                        const toUser = !/\bto=/.test(chanHeader) || /\bto=user\b/.test(chanHeader);
                        chanHeader = null;
                        chanThink = !toUser;
                        mode = toUser ? 'text' : 'think';
                    }
                    // stray '<|message|>' with no header: swallow the marker
                } else if (tag === '<think>') {
                    sawThinkOpen = true;
                    mode = 'think';
                } else if (tag === '</think>') {
                    if (mode === 'text' && !sawThinkOpen && sinks.implicitThinkClose) {
                        sawThinkOpen = true; // at most one reclassification per stream
                        sinks.implicitThinkClose();
                    }
                    mode = 'text';
                } else if (tag === '<tool_call>' || tag === '<tool_response>') {
                    mode = 'tool';
                    toolIsResponse = (tag === '<tool_response>');
                    if (sinks.toolOpen) sinks.toolOpen(tag, toolIsResponse);
                } else { // </tool_call> or </tool_response>
                    if (sinks.toolClose) sinks.toolClose(tag, toolIsResponse, mode === 'tool');
                    mode = 'text';
                }
            }
        };

        return {
            push(s) { if (s) { buf += s; step(false); } },
            flush() {
                step(true);
                // Stream ended between '<|start|>' and '<|message|>': release
                // the held text so a literal marker in prose can't silently
                // drop the tail of the reply.
                if (chanHeader !== null) {
                    const spill = chanHeader;
                    chanHeader = null;
                    route(spill);
                }
            },
        };
    }

    // Non-streaming twin of implicitThinkClose: a one-shot completion from a
    // thinking-locked model carries the scratchpad as a bare prefix ending in
    // '</think>' with no opener. Split it off so the reasoning goes to the
    // panel/salvage instead of the visible reply.
    function extractImplicitThink(text) {
        const s = text || '';
        const close = s.indexOf('</think>');
        if (close === -1 || s.lastIndexOf('<think>', close) !== -1) {
            return { text: s, reasoning: '' };
        }
        return {
            text: s.slice(close + '</think>'.length),
            reasoning: s.slice(0, close),
        };
    }

    // Stream a single LLM request and parse the response.
    // Returns { text, toolCalls, reasoningText, finishReason }
    // where toolCalls is an array of accumulated tool_calls from deltas.
    async function streamSingleRequest(body, onChunk, emitStatus, effortRetried = false) {
        // Remember what this turn sent (shallow copy: the agent loop reuses
        // and extends message arrays between rounds). The LAST request of a
        // turn is the one whose tokens sit in the backend's KV cache, and
        // that's exactly the prefix generateFollowUps() wants to reuse.
        if (Array.isArray(body?.messages) && body.messages.length) {
            _lastChatContext = { messages: body.messages.slice(), tools: body.tools || null };
        }
        // Idle-based abort, not a fixed whole-request deadline. A long agentic
        // run (many tool rounds + a big final reply) that keeps streaming
        // tokens must never be killed mid-flight. The previous
        // AbortSignal.timeout(300000) capped the ENTIRE request — body
        // included — at 5 minutes, so longer tasks were cut off even while
        // tokens were still flowing. Now we give a generous window to connect /
        // process the prompt, then abort only if the stream goes SILENT for too
        // long. A healthy stream of any length never trips it.
        const ctrl = new AbortController();
        let _wd = null;
        const armWd = (ms, why) => {
            if (_wd) clearTimeout(_wd);
            _wd = setTimeout(() => ctrl.abort(new DOMException(why, 'TimeoutError')), ms);
        };
        const clearWd = () => { if (_wd) { clearTimeout(_wd); _wd = null; } };
        armWd(300000, 'Model did not start responding — connection timed out');

        let res;
        try {
            const turnSignal = withTurnSignal(ctrl.signal);
            if (typeof TricorderDurableStream !== 'undefined' && TricorderDurableStream.enabled) {
                // Durable path: the server owns the generation, so it survives a
                // client drop (locked phone / network switch / tab switch) and this
                // reader transparently reconnects + resumes by cursor. The wire
                // format is the same SSE (`data: {...}` / `[DONE]`), so the parse
                // loop below is byte-for-byte unchanged.
                res = await TricorderDurableStream.open(body, {
                    signal: turnSignal,
                    headers: getExtraHeaders(),
                    chatId: getDurableChatId(),
                });
            } else {
                res = await fetchWithRetry(`${getApiBase()}/v1/chat/completions`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Cache-Control': 'no-cache',
                        ...getExtraHeaders()
                    },
                    body: JSON.stringify(body),
                    signal: turnSignal
                });
            }
        } catch (err) {
            clearWd();
            throw err;
        }

        if (!res.ok) {
            clearWd();
            const errText = res._text || await safeResponseText(res);
            // A refused reasoning_effort comes back as a 400, which the retry
            // wrapper deliberately does not re-send — so without this the whole
            // turn dies on a value the backend told us how to fix. Rewrite it
            // and send the round once more; the memo keeps it to one round-trip.
            if (!effortRetried && retryWithFallbackEffort(body, res.status, errText)) {
                return streamSingleRequest(body, onChunk, emitStatus, true);
            }
            throw createApiError(res.status, errText);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        // Single accumulator string instead of join()ing a chunk array on
        // every delta — V8 ropes make += cheap, and the repeated joins were
        // O(n²) over the reply length (same fix as the standard streaming path).
        let reply = '';
        let buffer = '';
        let thinkContent = '';
        let toolCallXmlBuffer = '';
        let reasoningText = '';
        let firstTokenSeen = false;
        let summarySeenAt = -1;
        let abortedRepeat = false;
        let tokenCount = 0;
        let firstTokenTime = 0;
        // End of THIS request's generating window. A turn is many requests
        // with tool execution in between, so the turn's wall clock is not the
        // time the model spent generating — see buildStats().
        let lastTokenTime = 0;
        // Characters the model generated INTO native tool calls. Coding runs
        // through write_file, so on a coding round this is most of what the
        // model produces — and usage counts every token of it. Tracked as a
        // running total rather than summed out of toolCallAccum on each tick.
        let toolArgChars = 0;
        let usageData = null; // Captured from final chunk
        // llama.cpp's own measurement of this request, from the `timings`
        // object it attaches to the final chunk (always) and to every chunk
        // (with timings_per_token). Everything the status line wants to show
        // is in here as a measured figure: predicted_n is the exact number of
        // tokens generated so far — reasoning, tool-call arguments and visible
        // text alike — and predicted_per_second is the decode rate the engine
        // clocked, with none of the network, proxy and render latency a
        // client-side wall clock unavoidably folds in. Null against a backend
        // that reports nothing (LM Studio, TabbyAPI), which is what keeps the
        // char-based estimate below as a fallback rather than dead code.
        let timings = null;
        let _fileStreamAt = 0; // throttle for live file-write streaming

        // Accumulate streaming tool_calls deltas (OpenAI format)
        // Each index maps to { id, type, function: { name, arguments } }
        const toolCallAccum = {};
        let finishReason = 'stop';
        let sawToolCallDelta = false;

        // Reasoning panel updates are shown only at HIGH/MAX (showThinking) —
        // at LOW/MED thinking was requested OFF, and if the model thinks
        // anyway the scratchpad must stay out of the visible reply either way.
        // Throttled: this re-scans and re-sends the WHOLE accumulated
        // scratchpad every call, and a Qwen3.8-class model emits reasoning by
        // the tens of thousands of tokens (48,970 in one observed turn, ~190k
        // characters). Unthrottled that is O(n²) in regex passes, string
        // copies and DOM writes — seconds of wasted CPU on desktop and a
        // frozen tab on a phone. 10 Hz is far faster than anyone reads, and
        // the panel is a 24vh auto-scrolled window regardless.
        const THINK_PANEL_INTERVAL_MS = 100;
        let lastThinkEmit = 0;
        let lastRateTick = 0;
        // Global generation ticker: every token this request produces, whatever
        // it is — reasoning, prose, code, tool-call arguments. Kept separate
        // from emitThinkPanel because that one carries the scratchpad TEXT
        // (expensive, reasoning-only, gated on showThinking) while this is two
        // numbers that must keep flowing at every effort tier, so the status
        // line shows a live speed while the model writes code exactly as it
        // does while the model thinks.
        const emitRateTick = (force = false) => {
            const now = Date.now();
            if (!force && now - lastRateTick < THINK_PANEL_INTERVAL_MS) return;
            lastRateTick = now;
            // Measured first. `predicted_n` is the engine's own count of what
            // it has decoded this request, so when the backend reports
            // timings the UI never has to smooth a guess into looking stable
            // — it shows the number llama.cpp would print.
            if (timings && timings.predicted_n > 0) {
                emitStatus({
                    phase: 'gen_progress',
                    tokens: timings.predicted_n,
                    tokPerSec: timings.predicted_per_second > 0
                        ? Math.round(timings.predicted_per_second * 10) / 10
                        : 0,
                    measured: true,
                });
                return;
            }
            const chars = thinkContent.length + reasoningText.length
                + reply.length + (toolCallXmlBuffer || '').length + toolArgChars;
            if (chars > 0) {
                emitStatus({ phase: 'gen_progress', tokens: Math.round(chars / _charsPerGenToken) });
            }
        };
        const emitThinkPanel = (force = false) => {
            if (!(EFFORT_PROFILES[getEffort()] || {}).showThinking) return;
            const now = Date.now();
            if (!force && now - lastThinkEmit < THINK_PANEL_INTERVAL_MS) return;
            lastThinkEmit = now;
            const cleaned = thinkContent.replace(/<\/?think>/g, '').trim();
            // Reasoning tokens, calibrated against the last turn's real usage.
            // NOT tokenCount: that counts visible-text deltas, so during a
            // think phase it barely moves and undercounts by whatever the
            // draft acceptance rate packs into each chunk.
            if (cleaned) {
                emitStatus({
                    phase: 'thinking',
                    content: cleaned,
                    tokens: Math.round(cleaned.length / _charsPerGenToken),
                });
            }
        };

        // One generating window covering BOTH output channels. The backend's
        // completion_tokens counts reasoning as well as visible text, so a
        // window that opened at the first visible token divided a reasoning
        // model's entire output by the tail of its run — on a turn that
        // thinks for 40s and then writes for 4s, by a factor of ten.
        const markGenToken = () => {
            const now = Date.now();
            if (!firstTokenTime) firstTokenTime = now;
            lastTokenTime = now;
        };

        // Split-safe tag routing — the same scanner the standard streaming
        // path uses. Replaces the old per-delta includes() checks, which
        // missed tags split across SSE deltas and let reasoning leak into
        // the visible reply.
        const scanner = createStreamTagScanner({
            think: (seg) => {
                markGenToken();
                thinkContent += seg;
                emitThinkPanel();
                emitRateTick();
            },
            // XML tool calls are re-wrapped with their tags: parseXmlToolCalls
            // (after the stream ends) matches full <tool_call>…</tool_call>
            // blocks in this buffer.
            toolOpen: (tag) => { markGenToken(); toolCallXmlBuffer += tag; },
            toolText: (seg) => { markGenToken(); toolCallXmlBuffer += seg; },
            toolClose: (tag) => { markGenToken(); toolCallXmlBuffer += tag; },
            implicitThinkClose: () => {
                // Stream started INSIDE a pre-opened think block (thinking-
                // locked template): everything "visible" so far is scratchpad.
                if (reply) {
                    thinkContent += (thinkContent ? '\n' : '') + reply;
                    reply = '';
                    summarySeenAt = -1;
                    if (onChunk) onChunk('', '');
                    emitThinkPanel();
                    // No emitRateTick here: this path MOVES text from reply
                    // into thinkContent, so the total character count — and
                    // therefore the global rate — is unchanged.
                }
            },
            text: (seg) => {
                if (!firstTokenSeen) {
                    firstTokenSeen = true;
                    emitStatus({ phase: 'generating' });
                }
                tokenCount++;
                markGenToken();

                reply += seg;
                emitRateTick(); // after the append, so it counts this segment
                if (onChunk) {
                    // Streaming file block (```lang file=path): keep the
                    // code out of the chat bubble and route it to the
                    // live file panel instead — the operator watches the
                    // file grow token by token while the visible reply
                    // shows only a one-line 📄 marker.
                    if (typeof TricorderFileFences !== 'undefined'
                        && TricorderFileFences.mayContainFileBlock(reply)) {
                        const parsed = TricorderFileFences.parse(reply);
                        onChunk(seg, parsed.visible);
                        const open = parsed.files.find(f => !f.complete);
                        if (open && open.path && emitStatus && Date.now() - _fileStreamAt > 120) {
                            _fileStreamAt = Date.now();
                            emitStatus({ phase: 'file_stream', name: 'file_block', path: open.path, content: open.content });
                        }
                    } else {
                        onChunk(seg, reply);
                    }
                }

                // Early repetition detection. The "## Summary" marker is
                // short, so scan only the tail (constant work per token)
                // instead of re-scanning the whole reply.
                if (summarySeenAt === -1) {
                    if (/\n##?\s*(?:SUMMARY|Summary)\s*\n/.test(reply.slice(-64))) summarySeenAt = reply.length;
                }
                if (summarySeenAt > 0 && reply.length > summarySeenAt + 80) {
                    const tail = reply.substring(summarySeenAt).trim();
                    const head = reply.substring(0, summarySeenAt).trim();
                    const anchor = head.split('\n').find(l => l.trim().length >= 30 && !l.trim().startsWith('#'));
                    if (anchor && tail.includes(anchor.trim())) abortedRepeat = true;
                }
            },
        });

        try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            // Data is flowing — reset the idle watchdog. Only a stalled stream
            // aborts, never a long-but-healthy one. Once a tool call has
            // started, the backend may buffer its entire arguments JSON and go
            // silent for minutes (see TOOL_ARGS_IDLE_MS) — allow that.
            if (sawToolCallDelta) armWd(TOOL_ARGS_IDLE_MS, 'Stream stalled during a tool call — no data from the model for 10 minutes');
            else armWd(120000, 'Stream stalled — no data from the model for 2 minutes');

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (line.length < 7) continue;
                const trimmed = line.trim();
                if (!trimmed.startsWith('data: ')) continue;
                const data = trimmed.slice(6);
                if (data === '[DONE]') continue;

                try {
                    const parsed = JSON.parse(data);
                    // Capture usage data (sent in final chunk with stream_options)
                    if (parsed.usage) {
                        usageData = parsed.usage;
                    }
                    // llama.cpp's measurement of this request. Sanity-checked
                    // rather than trusted blind: a proxy that merges streams,
                    // or a backend that reports a zeroed object, must not
                    // replace a working char estimate with a flat zero.
                    if (parsed.timings && parsed.timings.predicted_n >= 0) {
                        const grew = parsed.timings.predicted_n > (timings?.predicted_n || 0);
                        timings = parsed.timings;
                        // A measured token is a token: keep the client's own
                        // generating window open for reasoning and tool-call
                        // rounds that stream no visible text at all. Only on
                        // growth, so the final chunk — which repeats the last
                        // count — doesn't stretch the window past the last
                        // token by however long the tail took to arrive.
                        if (grew) { markGenToken(); emitRateTick(); }
                    }

                    const choice = parsed.choices?.[0];
                    const choiceDelta = choice?.delta;

                    // Capture finish_reason
                    if (choice?.finish_reason) {
                        finishReason = choice.finish_reason;
                    }

                    // Handle tool_calls deltas (native function calling)
                    if (choiceDelta?.tool_calls) {
                        // Arguments are generated tokens like any other, and
                        // usage counts them. Leaving them outside the window
                        // meant a round that only wrote a tool call — a
                        // write_file carrying a whole source file — added its
                        // tokens to the turn and none of its time, which is
                        // what pushed the reported rate above the model's.
                        markGenToken();
                        // Re-arm IMMEDIATELY with the wide window: the header
                        // packet ({name, arguments:""}) is often the last byte
                        // the backend sends before it silently generates the
                        // whole arguments blob — the 2-minute arm from this
                        // read must not be the one in effect during that gap.
                        if (!sawToolCallDelta) {
                            sawToolCallDelta = true;
                            armWd(TOOL_ARGS_IDLE_MS, 'Stream stalled during a tool call — no data from the model for 10 minutes');
                            // Tell the UI what the silence means: the model is
                            // generating tool arguments the backend won't stream.
                            const firstName = choiceDelta.tool_calls[0]?.function?.name || '';
                            if (emitStatus) emitStatus({ phase: 'tool_args_buffering', name: firstName });
                        }
                        for (const tc of choiceDelta.tool_calls) {
                            const idx = tc.index ?? 0;
                            if (!toolCallAccum[idx]) {
                                toolCallAccum[idx] = {
                                    id: tc.id || `call_${idx}_${Date.now()}`,
                                    type: 'function',
                                    function: { name: '', arguments: '' }
                                };
                            }
                            if (tc.id) toolCallAccum[idx].id = tc.id;
                            if (tc.function?.name) {
                                toolCallAccum[idx].function.name += tc.function.name;
                                toolArgChars += tc.function.name.length;
                            }
                            if (tc.function?.arguments) {
                                toolCallAccum[idx].function.arguments += tc.function.arguments;
                                toolArgChars += tc.function.arguments.length;
                            }
                        }
                        emitRateTick();
                        // Live "watch the file being written" — stream the partial
                        // content of a file-writing tool call (throttled) so the
                        // operator sees the code appear, not just the final file.
                        if (emitStatus && Date.now() - _fileStreamAt > 120) {
                            const fwKey = Object.keys(toolCallAccum).find(i => FILE_WRITE_ARG[toolCallAccum[i].function.name]);
                            if (fwKey !== undefined) {
                                _fileStreamAt = Date.now();
                                const acc = toolCallAccum[fwKey];
                                const partial = extractPartialFileWrite(acc.function.arguments, FILE_WRITE_ARG[acc.function.name]);
                                if (partial && (partial.content || partial.path)) {
                                    emitStatus({ phase: 'file_stream', name: acc.function.name, path: partial.path, content: partial.content });
                                }
                            }
                        }
                        continue;
                    }

                    // Reasoning streamed as a dedicated field (Qwen3.5 /
                    // DeepSeek R1 hybrid thinking) — separate from content,
                    // not inside <think> tags. Field name varies by backend.
                    // A delta can carry BOTH reasoning and content, so don't
                    // skip the rest of the chunk.
                    const reasoning = [choiceDelta?.reasoning_content, choiceDelta?.reasoning, choiceDelta?.thinking]
                        .find(v => typeof v === 'string' && v);
                    if (reasoning) {
                        markGenToken();
                        reasoningText += reasoning;
                        thinkContent += reasoning;
                        emitThinkPanel();
                        emitRateTick();
                    }

                    // Visible content — routed through the split-safe scanner
                    // so <think>/<tool_call> blocks (even with tags split
                    // across deltas, or a think block the template pre-opened)
                    // never reach the chat bubble.
                    const delta = choiceDelta?.content;
                    if (typeof delta === 'string' && delta) {
                        scanner.push(delta);
                        if (abortedRepeat) {
                            reader.cancel();
                            break;
                        }
                    }
                } catch { /* skip malformed chunks */ }
            }
            if (abortedRepeat) break;
        }
        } catch (err) {
            // Operator pressed Stop — the in-flight read aborts. Keep whatever
            // streamed so far and return it as a normal (stop) result instead of
            // throwing, so the loop ends cleanly with the partial reply. A real
            // watchdog timeout (or any non-stop error) still propagates.
            if (!turnAborted()) throw err;
        } finally {
            clearWd();
        }

        // Flush the scanner — releases any held-back partial-tag tail.
        scanner.flush();
        // Recalibrate chars-per-token against what the backend actually
        // counted, so the next turn's live meter lines up with the t/s
        // llama.cpp prints instead of drifting ~30% under it. Still worth
        // doing when timings are available: the estimate is what a round
        // shows before the first `timings` object arrives, and what the whole
        // meter falls back to on a backend that reports none.
        if (usageData && usageData.completion_tokens > 0) {
            const genChars = thinkContent.length + reasoningText.length + reply.length
                + (toolCallXmlBuffer || '').length + toolArgChars;
            const perToken = genChars / usageData.completion_tokens;
            // Guard against a truncated stream or a backend reporting nonsense
            // pinning the meter at an absurd rate.
            if (perToken >= 1.5 && perToken <= 8) _charsPerGenToken = perToken;
        }
        // The throttles above can swallow the last <100ms; force a final emit
        // so the panel holds the complete scratchpad and the meter lands on the
        // real total rather than whichever tick happened to be last.
        emitThinkPanel(true);
        emitRateTick(true);
        // The calibrated char estimate for this request, captured before the
        // XML/file-fence passes below start rewriting `reply`. It covers both
        // output channels, so when a proxy does not forward `usage` it beats
        // tokenCount — which counts SSE deltas of VISIBLE text only and so
        // reads a reasoning-heavy turn as a fraction of its real output.
        const estimatedTokens = Math.round(
            (thinkContent.length + reasoningText.length + reply.length
             + (toolCallXmlBuffer || '').length + toolArgChars)
            / _charsPerGenToken);

        let toolCalls = Object.values(toolCallAccum);
        let toolCallSource = toolCalls.length > 0 ? 'native' : null;
        let rawAssistantText = reply;

        // Some models emit tool calls as XML — check all sources including
        // the streaming buffer (suppressed from visible output during streaming)
        if (toolCalls.length === 0) {
            const replyText = reply;
            const allText = (toolCallXmlBuffer || '') + '\n' + (reasoningText || '') + '\n' + (thinkContent || '') + '\n' + replyText;
            if (allText.includes('<tool_call>')) {
                const xmlCalls = parseXmlToolCalls(allText);
                if (xmlCalls.length > 0) {
                    toolCalls = xmlCalls;
                    toolCallSource = 'xml';
                    // Preserve the raw assistant turn (with <tool_call> XML)
                    // so callers that need to replay it verbatim — e.g. the
                    // XML tool-format paths that key off it — can do so.
                    rawAssistantText = (toolCallXmlBuffer && toolCallXmlBuffer.trim())
                        ? toolCallXmlBuffer.trim()
                        : replyText;
                    // Strip any remaining XML tool calls from visible reply text
                    reply = replyText.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim();
                }
            }
        }

        // Streaming file blocks: pull completed ```file=path fences out of the
        // final reply. The visible text keeps a one-line 📄 marker per block;
        // the blocks themselves ride in fileFences for the agent loop to save
        // to disk (through the normal write_file path, approval included). An
        // UNCLOSED block (aborted stream / model forgot the closing fence)
        // stays in the visible text untouched so its code is never lost.
        let visibleText = reply;
        let fileFences = [];
        if (typeof TricorderFileFences !== 'undefined'
            && TricorderFileFences.mayContainFileBlock(visibleText)) {
            const parsed = TricorderFileFences.parse(
                visibleText,
                f => (f.complete && f.path) ? `📄 \`${f.path}\`` : null
            );
            visibleText = parsed.visible;
            fileFences = parsed.files.filter(f => f.complete && f.path);
        }

        return {
            text: visibleText,
            fileFences,
            rawAssistantText,
            toolCallSource,
            toolCalls,
            reasoningText,
            // Union of reasoning_content and inline <think> deltas — the salvage
            // source when the model left the deliverable in its scratchpad.
            thinkText: thinkContent,
            finishReason: toolCalls.length > 0 ? 'tool_calls' : finishReason,
            // …and the raw reason alongside it, because the line above hides
            // "length" behind "tool_calls" exactly when it matters most: a
            // round cut off at the token ceiling mid-write_file still arrives
            // WITH a tool call, so the loop cannot see the truncation from
            // finishReason alone and would treat the fragment as a finished
            // call. (The server refuses to write an unterminated one; this is
            // what lets the loop say why.)
            truncated: finishReason === 'length',
            tokenCount,
            estimatedTokens,
            firstTokenTime,
            // This request's generating window, first token to last. The
            // caller sums these across the turn's rounds so tool execution
            // and prompt re-processing stay out of the rate.
            genMs: (firstTokenTime && lastTokenTime > firstTokenTime) ? lastTokenTime - firstTokenTime : 0,
            usageData,
            // The engine's own measurement of this round, forwarded verbatim
            // so the turn can be summed from measured parts instead of
            // re-derived from a wall clock.
            timings,
        };
    }

    // Retry one agent-loop LLM round with short backoff (2s, 4s) before the
    // whole turn is failed. A transient hiccup (dropped socket, 5xx from a
    // reloading backend) in round N must not discard the tool work of rounds
    // 1..N-1. Hard client-side errors (4xx, operator abort, watchdog timeout)
    // are not retried.
    async function streamSingleRequestWithRetry(body, onChunk, emitStatus) {
        const backoffs = [2000, 4000];
        for (let attempt = 0; ; attempt++) {
            try {
                return await streamSingleRequest(body, onChunk, emitStatus);
            } catch (err) {
                const retryable = !turnAborted()
                    && err?.name !== 'AbortError'
                    && err?.name !== 'TimeoutError'
                    && (err?.status == null || err.status >= 500);
                if (!retryable || attempt >= backoffs.length) throw err;
                console.warn(`[agent] LLM round failed (attempt ${attempt + 1}), retrying:`, err?.message || err);
                if (emitStatus) emitStatus({ phase: 'connecting' });
                await new Promise(r => setTimeout(r, backoffs[attempt]));
                if (turnAborted()) throw err;
            }
        }
    }

    // One non-streaming chat POST, with the same reasoning_effort recovery the
    // streaming path has: a refused value comes back as a 400, which the retry
    // wrapper deliberately does not re-send, so rewrite it and send once more
    // before handing the response back. A failure the retry cannot fix keeps
    // its body text on res._text (reading it here consumes the stream), the
    // same convention the durable-stream path uses.
    async function postChatCompletion(body, timeoutMs) {
        const send = () => fetchWithRetry(`${getApiBase()}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...getExtraHeaders() },
            body: JSON.stringify(body),
            signal: withTurnSignal(AbortSignal.timeout(timeoutMs))
        });
        const res = await send();
        if (res.ok) return res;
        const errText = await safeResponseText(res);
        if (retryWithFallbackEffort(body, res.status, errText)) return send();
        try { res._text = errText; } catch { /* non-extensible response */ }
        return res;
    }

    // Parse XML-style tool calls from model output. Two dialects are accepted:
    //   • JSON form:               <tool_call>{"name":"x","arguments":{...}}</tool_call>
    //   • Qwen3.5 nested-XML:      <tool_call><function=x><parameter=k>v</parameter></function></tool_call>
    // The JSON form is checked first because (a) it's the format the XML tool
    // preamble prompts for, and (b) JSON.parse failure cleanly falls through
    // to the Qwen path so neither dialect blocks the other.
    function parseXmlToolCalls(text) {
        const calls = [];
        const toolCallRegex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
        let match;
        while ((match = toolCallRegex.exec(text)) !== null) {
            const block = match[1].trim();

            // JSON form. Some checkpoints wrap the JSON in a ```json
            // fence — strip it before parsing. Some emit a list of objects in
            // a single block; accept both.
            const jsonCandidate = block
                .replace(/^```(?:json)?\s*/i, '')
                .replace(/\s*```$/i, '')
                .trim();
            if (jsonCandidate.startsWith('{') || jsonCandidate.startsWith('[')) {
                try {
                    const parsed = JSON.parse(jsonCandidate);
                    const items = Array.isArray(parsed) ? parsed : [parsed];
                    let pushed = 0;
                    for (const item of items) {
                        if (!item || typeof item !== 'object') continue;
                        const name = item.name || item.tool || item.function;
                        if (!name) continue;
                        const args = item.arguments ?? item.parameters ?? item.args ?? {};
                        calls.push({
                            id: `call_json_${Date.now()}_${calls.length}`,
                            type: 'function',
                            function: {
                                name,
                                arguments: typeof args === 'string' ? args : JSON.stringify(args)
                            }
                        });
                        pushed++;
                    }
                    if (pushed > 0) continue; // handled — skip Qwen fallback
                } catch { /* fall through to Qwen XML parser */ }
            }

            // Qwen3.5 nested-XML form.
            const funcMatch = block.match(/<function=(\w+)>/);
            if (!funcMatch) continue;
            const funcName = funcMatch[1];
            const params = {};
            const paramRegex = /<parameter=(\w+)>\s*([\s\S]*?)\s*<\/parameter>/g;
            let paramMatch;
            while ((paramMatch = paramRegex.exec(block)) !== null) {
                params[paramMatch[1]] = paramMatch[2].trim();
            }
            calls.push({
                id: `call_xml_${Date.now()}_${calls.length}`,
                type: 'function',
                function: {
                    name: funcName,
                    arguments: JSON.stringify(params)
                }
            });
        }
        return calls;
    }

    // Build the structured metadata array that rides alongside the
    // human-readable `tools` strings in tool_calling status payloads.
    // Tolerates pre-parsed objects, JSON strings, or anything malformed.
    function buildToolMeta(items) {
        return items.map(it => {
            const name = it.name || it.tool || '';
            let args = it.arguments;
            if (typeof args === 'string') {
                try { args = JSON.parse(args); } catch { /* leave as string */ }
            }
            return { name, args: args ?? null };
        });
    }

    // Strip duplicated trailing content from LLM responses.
    // Local models sometimes repeat the entire answer after the Summary section —
    // the model writes the answer, then Summary, then loops back to the start.
    // --- Output hygiene ---
    // ChatML/Llama models occasionally leak control tokens into the
    // visible stream (e.g. when a stop sequence fires a token late). Strip
    // them from anything rendered to the user.
    const CONTROL_TOKEN_RE = /<\|(?:im_start|im_end|endoftext|eot_id|end_of_text|begin_of_text|start_header_id|end_header_id)\|>/g;
    function stripControlTokens(text) {
        return text ? text.replace(CONTROL_TOKEN_RE, '') : text;
    }
    // Some models leak <tool_call>{json}</tool_call> (and
    // <tool_response>…</tool_response>) blocks into their visible text. We
    // surface these live as tool-status chips, so any that slip into the
    // final text are scrubbed here rather than rendered raw.
    function stripToolBlocks(text) {
        return text
            ? text.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
                  .replace(/<tool_response>[\s\S]*?<\/tool_response>/gi, '')
            : text;
    }
    // Build a compact, human-readable preview of tool arguments for the chip,
    // surfacing the single most meaningful field (query, path, url, command…).
    function previewToolArgs(args) {
        if (!args || typeof args !== 'object') return '';
        const PRIORITY = ['query', 'q', 'path', 'file_path', 'filename', 'url',
                          'command', 'cmd', 'pattern', 'expression', 'prompt', 'name', 'text'];
        for (const key of PRIORITY) {
            const v = args[key];
            if (typeof v === 'string' && v.trim()) {
                const s = v.replace(/\s+/g, ' ').trim();
                return s.length > 80 ? s.slice(0, 79) + '…' : s;
            }
        }
        const keys = Object.keys(args);
        return keys.length ? keys.slice(0, 4).join(', ') : '';
    }

    // Parse a complete <tool_call>{json}</tool_call> buffer into { name, arguments }.
    // Tolerant of leading/trailing noise and string-encoded argument blobs.
    // Used only as a fallback when the model isn't emitting structured tool_calls.
    function parseToolCall(buf) {
        if (!buf) return null;
        const inner = buf.replace(/<\/?tool_call>/gi, '').replace(/<\/?tool_response>/gi, '').trim();
        const start = inner.indexOf('{');
        const end = inner.lastIndexOf('}');
        if (start === -1 || end <= start) return null;
        try {
            const obj = JSON.parse(inner.slice(start, end + 1));
            const name = obj.name || obj.tool || obj.function?.name;
            let args = obj.arguments ?? obj.parameters ?? obj.function?.arguments ?? null;
            if (typeof args === 'string') { try { args = JSON.parse(args); } catch { /* keep as-is */ } }
            if (!name) return null;
            return { name, arguments: (args && typeof args === 'object') ? args : null };
        } catch {
            const m = inner.match(/"name"\s*:\s*"([^"]+)"/);
            return m ? { name: m[1], arguments: null } : null;
        }
    }

    // --- Reasoning-code salvage ---
    // Local reasoning models sometimes write the entire deliverable inside the
    // thinking scratchpad and then finish with a stub answer ("done!") or with
    // nothing at all — the code is visible in the reasoning panel but never
    // reaches the reply, the canvas, or a tool call. When the visible reply
    // carries no fenced code but the thinking does, lift the final draft of
    // each code block out of the scratchpad and append it to the reply so the
    // answer actually contains the code (and canvas-eligible blocks render).
    //
    // `visible` may still contain inline <think> blocks (non-streaming paths
    // leave them for formatMessage to render) — those count as scratchpad, not
    // as delivered code.
    function salvageCodeFromThinking(visible, thinking) {
        const raw = visible || '';
        let scratch = String(thinking || '');
        const visibleOnly = raw.replace(/<think>([\s\S]*?)<\/think>/gi, (_, t) => {
            scratch += '\n' + t;
            return '';
        }).trim();
        scratch = scratch.replace(/<\/?think>/gi, '');
        if (!scratch.trim() || visibleOnly.includes('```')) return visible;

        // The model may have run out of tokens mid-block — close a dangling
        // fence so the final (usually most complete) draft is still captured.
        if ((scratch.match(/```/g) || []).length % 2 === 1) scratch += '\n```';

        // Keep only the LAST draft per language: thinking typically contains
        // successive rewrites of the same code, and the last one is the one
        // the model settled on.
        const drafts = new Map(); // lang -> code (last occurrence wins)
        const fenceRe = /```([\w+-]*)[^\S\n]*\n([\s\S]*?)```/g;
        let m;
        while ((m = fenceRe.exec(scratch)) !== null) {
            const code = m[2].replace(/\s+$/, '');
            if (code.trim()) drafts.set((m[1] || '').toLowerCase(), code);
        }
        if (drafts.size === 0) return visible;

        // Substance gate: only salvage real code, not a one-line aside the
        // model was musing about — unless the reply is effectively empty,
        // where anything beats nothing.
        const blocks = [...drafts.entries()];
        const substantial = blocks.some(([, code]) => code.split('\n').length >= 3 || code.length >= 120);
        if (!substantial && visibleOnly.length >= 40) return visible;

        const rendered = blocks
            .map(([lang, code]) => '```' + lang + '\n' + code + '\n```')
            .join('\n\n');
        const kept = raw.trim();
        return kept ? kept + '\n\n' + rendered : rendered;
    }

    function deduplicateResponse(text) {
        if (!text || text.length < 200) return text;

        // Strategy 1: If there's a Summary section, check if content after it
        // repeats content from before it.
        const summaryMatch = text.match(/\n##?\s*(?:Summary|Zusammenfassung)\s*\n/i);
        if (summaryMatch) {
            const summaryEnd = summaryMatch.index + summaryMatch[0].length;
            // Find where the summary text ends (next heading or substantial content repeat)
            const afterSummary = text.substring(summaryEnd).trim();
            const beforeSummary = text.substring(0, summaryMatch.index).trim();

            if (afterSummary.length > 100 && beforeSummary.length > 100) {
                // Check if text after summary restarts the original answer
                // Find a distinctive line from the beginning of the answer
                const earlyLines = beforeSummary.split('\n').filter(l => l.trim().length >= 25);
                for (const anchor of earlyLines.slice(0, 5)) {
                    const trimmed = anchor.trim();
                    if (afterSummary.includes(trimmed)) {
                        // Content after summary repeats the original — find where the summary's
                        // own text ends and the repeat begins, then cut there
                        const repeatStart = afterSummary.indexOf(trimmed);
                        // Keep the summary paragraph(s) but cut the repeated content
                        const summaryText = afterSummary.substring(0, repeatStart).trim();
                        if (summaryText.length > 0) {
                            return beforeSummary + '\n\n' + summaryMatch[0].trim() + '\n' + summaryText;
                        }
                        // Summary was empty before the repeat — just keep up to summary heading
                        return beforeSummary + '\n\n' + summaryMatch[0].trim();
                    }
                }
            }
        }

        // Strategy 2: Generic — find any substantial repeated block
        const lines = text.split('\n');
        let anchor = '';
        for (let i = 0; i < lines.length && i < 20; i++) {
            const l = lines[i].trim();
            if (l.length >= 30 && !l.startsWith('#')) {
                anchor = l;
                break;
            }
        }
        if (!anchor) return text;

        const firstPos = text.indexOf(anchor);
        const secondPos = text.indexOf(anchor, firstPos + anchor.length);
        if (secondPos === -1) return text;

        const block1 = text.substring(firstPos, firstPos + 200).trim();
        const block2 = text.substring(secondPos, secondPos + 200).trim();

        if (block1 === block2) {
            return text.substring(0, secondPos).replace(/\s+$/, '');
        }

        return text;
    }

    // Preload the configured model into VRAM by sending a minimal completion.
    // The backend loads models on first request — this ensures the model is warm
    // and ready by the time the user sends their first message.
    async function preloadModel() {
        try {
            await fetch(`${getApiBase()}/v1/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...getExtraHeaders() },
                body: JSON.stringify({
                    model: getModelId(),
                    messages: [{ role: 'user', content: 'hi' }],
                    max_tokens: 1,
                    stream: false
                }),
                signal: AbortSignal.timeout(30000)
            });
        } catch { /* best effort — model may not be available yet */ }
    }

    // Keep the model loaded in VRAM between messages.  The backend may unload
    // idle models after a timeout, which causes a multi-second reload delay
    // on the next request.  A minimal inference request (not just /v1/models)
    // resets the model's TTL so the backend keeps it loaded.
    //
    // The pinger pauses after ~10 minutes without operator activity (typing,
    // sending, tab becoming visible) — an app left open overnight shouldn't
    // fire a 1-token request every minute forever. Activity resumes it and
    // immediately re-warms the model.
    let _keepAliveTimer = null;
    let _lastUserActivity = Date.now();
    const KEEPALIVE_IDLE_MS = 10 * 60 * 1000;

    async function _keepAlivePing() {
        try {
            await fetch(`${getApiBase()}/v1/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...getExtraHeaders() },
                body: JSON.stringify({
                    model: getModelId(),
                    messages: [{ role: 'user', content: '.' }],
                    max_tokens: 1,
                    stream: false
                }),
                signal: AbortSignal.timeout(10000)
            });
        } catch { /* best effort */ }
    }

    function startKeepAlive() {
        stopKeepAlive();
        _keepAliveTimer = setInterval(() => {
            if (isProcessing) return; // don't interfere with active requests
            if (Date.now() - _lastUserActivity > KEEPALIVE_IDLE_MS) return; // paused while idle
            _keepAlivePing();
        }, 60000); // every 60 seconds
    }

    function stopKeepAlive() {
        if (_keepAliveTimer) {
            clearInterval(_keepAliveTimer);
            _keepAliveTimer = null;
        }
    }

    // Operator-activity signal (typing, pointer, visibility, new turn) — wired
    // up by app.js. Returning from an idle pause re-warms the model right away
    // instead of waiting up to a minute for the next interval tick.
    function noteUserActivity() {
        const wasIdle = Date.now() - _lastUserActivity > KEEPALIVE_IDLE_MS;
        _lastUserActivity = Date.now();
        if (wasIdle && _keepAliveTimer && !isProcessing) _keepAlivePing();
    }

    async function sendMessage(userMessage, imageBase64 = null) {
        if (isProcessing) throw new Error('A request is already in progress. Please wait and try again.');
        isProcessing = true;
        newTurnAbort();
        _turnToolEvents = []; // fresh evidence trail for this turn
        noteUserActivity(); // a new turn is operator activity — resume keep-alive
        // A new turn supersedes any pending follow-up suggestion generation.
        cancelFollowUps();
        // New turn: rebuild the advertised toolset — core set plus tools the
        // model actually called in the last couple of turns (carry-over with decay).
        if (tieredToolsEnabled()) beginTurnActiveTools();
        // New turn: re-snapshot the XML tool preamble for prefix stability.
        newPromptTurn();
        // Refresh memory context if stale
        if (Date.now() - _memoryLastFetch > MEMORY_REFRESH_MS) refreshMemoryContext();

        const msgText = userMessage || '';
        // Rank memory relevance for this turn (fast, hard 1.5s cap; falls back
        // to full injection on any failure — see prepareTurnMemory).
        await prepareTurnMemory(msgText);

        let content;
        if (imageBase64) {
            content = [
                { type: 'text', text: msgText || 'What do you see in this image? Provide a detailed analysis.' },
                { type: 'image_url', image_url: { url: imageBase64 } }
            ];
        } else {
            content = msgText;
        }

        conversationHistory.push({ role: 'user', content });

        trimHistory();

        // Hoisted so the catch below can commit already-executed tool work
        // (calls + results) to history when a later LLM round fails hard.
        const agentMessages = [];

        try {
            let reply;

            // --- In-app tool layer ---
            // Native function calling drives the tool loop directly.
            const useNativeTools = settings.internetAccess;
            if (useNativeTools && !imageBase64) {
                await maybeAutoCompress(null);
                let round = 0;
                let consecutiveErrors = 0;       // track repeated failures
                let toolsUsedThisSession = [];   // track which tools have been called
                const effortProfile = EFFORT_PROFILES[getEffort()] || EFFORT_PROFILES.medium;
                const roundCap = toolRoundCap(effortProfile);
                const repeatCache = new Map();   // per-turn guard for identical web lookups

                while (round < roundCap) {
                    round++;
                    if (turnAborted()) break;
                    const body = buildRequestBody(false, agentMessages);
                    const res = await postChatCompletion(body, 120000);
                    if (!res.ok) throw createApiError(res.status, res._text || await safeResponseText(res));
                    const data = await res.json();
                    const msg = data.choices?.[0]?.message;
                    // Check for structured tool_calls OR XML tool calls anywhere
                    let detectedToolCalls = msg?.tool_calls?.filter(tc => tc.function?.name) || [];
                    if (detectedToolCalls.length === 0) {
                        const allText = (msg?.reasoning_content || '') + '\n' + (msg?.content || '');
                        if (allText.includes('<tool_call>')) {
                            detectedToolCalls = parseXmlToolCalls(allText);
                        }
                    }
                    if (detectedToolCalls.length > 0) {
                        pushAssistantRound(agentMessages,
                            { role: 'assistant', content: msg.content || null, tool_calls: detectedToolCalls },
                            msg?.reasoning_content || msg?.reasoning || '');
                        toolsUsedThisSession.push(...detectedToolCalls.map(tc => tc.function.name));
                        const toolResults = await executeToolCallsGuarded(detectedToolCalls, null, repeatCache);
                        agentMessages.push(...toolResults);

                        // Self-correction: hint the model about errors
                        const errors = toolResults.filter(r => {
                            try { return JSON.parse(r.content)?.error; } catch { return false; }
                        });
                        if (errors.length > 0) {
                            consecutiveErrors++;
                            const errorSummary = errors.map(r => {
                                try { return JSON.parse(r.content).error; } catch { return r.content; }
                            }).join('; ');

                            if (consecutiveErrors >= 3 && round < roundCap) {
                                agentMessages.push({
                                    role: 'user',
                                    content: `[System: ${consecutiveErrors} consecutive tool errors. STOP retrying the same approach. Either use a completely different tool/strategy or provide the best answer you can with the information you already have. Errors: ${errorSummary}]`
                                });
                            } else if (round < roundCap) {
                                agentMessages.push({
                                    role: 'user',
                                    content: `[System: ${errors.length} tool call(s) returned errors: ${errorSummary}. Analyze the errors and either retry with corrected parameters or provide a response without that tool.]`
                                });
                            }
                        } else {
                            consecutiveErrors = 0;

                            // Interleaved thinking: at medium/max effort, prompt the model
                            // to reflect on tool results before its next action.
                            // This mimics Opus 4.6's interleaved thinking where the model
                            // plans between tool calls for better multi-step reasoning.
                            if (shouldInjectInterleavedNudge(effortProfile, round)) {
                                pushInterleavedNudge(agentMessages,
                                    detectedToolCalls.map(tc => tc.function.name).join(', '));
                            }
                        }
                        // Budget guard: one round left — tell the model to land the
                        // answer instead of running into the hard cap (which would
                        // cost an extra forced-final request).
                        if (round === roundCap - 1) {
                            agentMessages.push({
                                role: 'user',
                                content: `[System: Tool budget nearly exhausted (round ${round} of ${roundCap} at this effort level). Give your final answer next — at most ONE more essential tool call.]`
                            });
                        }
                        continue;
                    }
                    {
                        // Split off a bare pre-opened think block (no '<think>'
                        // opener, closing '</think>' only) before it lands in
                        // the visible reply — same shape the stream scanner
                        // reclassifies via implicitThinkClose.
                        const implicit = extractImplicitThink(msg?.content || '');
                        const scratch = [msg?.reasoning_content || msg?.reasoning || '', implicit.reasoning]
                            .filter(s => s && s.trim()).join('\n');
                        reply = salvageCodeFromThinking(implicit.text, scratch)
                            || 'No response generated.';
                    }
                    break;
                }
                if (!reply) {
                    // Provide a nudge message and try one more time for a final answer
                    agentMessages.push({
                        role: 'user',
                        content: `[System: You have used ${round} tool rounds. Please provide your final answer now based on all the information gathered so far. Do NOT make any more tool calls.]`
                    });
                    const body = buildRequestBody(false, agentMessages);
                    try {
                        const res = await postChatCompletion(body, 60000);
                        if (res.ok) {
                            const data = await res.json();
                            reply = data.choices?.[0]?.message?.content || 'Max tool rounds reached — no final answer generated.';
                        } else {
                            reply = 'Max tool rounds reached.';
                        }
                    } catch {
                        reply = 'Max tool rounds reached.';
                    }
                }
                if (agentMessages.length > 0) conversationHistory.push(...persistableAgentMessages(agentMessages));
                conversationHistory.push({ role: 'assistant', content: reply });
                isProcessing = false;
                return reply;
            }
            // Standard OpenAI-compatible completion (tool layer off or an
            // image is attached): send the chat and render the reply.
            const res = await postChatCompletion(buildRequestBody(false), 120000);
            if (!res.ok) throw createApiError(res.status, res._text || await safeResponseText(res));
            const data = await res.json();
            const msgOut = data.choices?.[0]?.message || {};
            const implicitOut = extractImplicitThink(msgOut.content || '');
            reply = salvageCodeFromThinking(
                stripToolBlocks(stripControlTokens(implicitOut.text)).trim(),
                [msgOut.reasoning_content || msgOut.reasoning || '', implicitOut.reasoning]
                    .filter(s => s && s.trim()).join('\n')
            ) || 'No response generated.';
            conversationHistory.push({ role: 'assistant', content: reply });
            isProcessing = false;
            return reply;
        } catch (err) {
            isProcessing = false;
            if (turnAborted()) {
                // Operator pressed Stop — keep the user turn, don't surface an error.
                if (conversationHistory[conversationHistory.length - 1]?.role === 'user') {
                    conversationHistory.push({ role: 'assistant', content: '_(abgebrochen)_' });
                }
                return '';
            }
            // Same recovery as sendStream: executed tool work survives the
            // failure; only a turn with no tool work rolls the user turn back.
            const persistable = persistableAgentMessages(agentMessages);
            if (persistable.length > 0) {
                conversationHistory.push(...persistable);
                conversationHistory.push({ role: 'assistant', content: '_(Fehler — der Turn brach ab, die bereits ausgeführten Tool-Schritte wurden behalten.)_' });
            } else {
                conversationHistory.pop();
            }
            throw err;
        }
    }

    // Status callback types:
    //   { phase: 'connecting' }                     — request sent, waiting for server
    //   { phase: 'thinking', content: '...' }       — inside <think> block (reasoning)
    //   { phase: 'generating' }                     — first real token received
    //   { phase: 'done', stats: { ... } }           — stream complete with perf stats
    //   { phase: 'error', message: '...' }          — something went wrong

    // Last inference stats — exposed for UI display
    let _lastStats = null;

    async function sendStream(userMessage, imageBase64 = null, onChunk, onStatus) {
        if (isProcessing) throw new Error('A request is already in progress. Please wait and try again.');
        isProcessing = true;
        newTurnAbort();
        _turnToolEvents = []; // fresh evidence trail for this turn
        noteUserActivity(); // a new turn is operator activity — resume keep-alive
        // A new turn supersedes any pending follow-up suggestion generation.
        cancelFollowUps();
        // New turn: rebuild the advertised toolset — core set plus tools the
        // model actually called in the last couple of turns (carry-over with decay).
        if (tieredToolsEnabled()) beginTurnActiveTools();
        // New turn: re-snapshot the XML tool preamble for prefix stability.
        newPromptTurn();
        // Refresh memory context if stale
        if (Date.now() - _memoryLastFetch > MEMORY_REFRESH_MS) refreshMemoryContext();

        const emitStatus = (status) => { if (onStatus) onStatus(status); };

        const msgText = userMessage || '';
        // Rank memory relevance for this turn (fast, hard 1.5s cap; falls back
        // to full injection on any failure — see prepareTurnMemory).
        await prepareTurnMemory(msgText);

        let content;
        if (imageBase64) {
            content = [
                { type: 'text', text: msgText || 'Analyze this image in detail.' },
                { type: 'image_url', image_url: { url: imageBase64 } }
            ];
        } else {
            content = msgText;
        }

        conversationHistory.push({ role: 'user', content });

        trimHistory();

        // Watchdog-based abort. A fixed AbortSignal.timeout() governed the whole
        // fetch — body included — so long agentic runs (server-side tool use +
        // big replies) were killed at the 5-minute mark even while tokens were
        // still flowing. Instead: a generous window to connect (prompt processing
        // on a big context can be slow), then abort only if the stream goes
        // SILENT for too long. A healthy stream of any length never trips it.
        const streamCtrl = new AbortController();
        let _watchdog = null;
        const armWatchdog = (ms, why) => {
            if (_watchdog) clearTimeout(_watchdog);
            _watchdog = setTimeout(() => streamCtrl.abort(new DOMException(why, 'TimeoutError')), ms);
        };
        const clearWatchdog = () => { if (_watchdog) { clearTimeout(_watchdog); _watchdog = null; } };

        // Hoisted so the catch below can commit already-executed tool work
        // (calls + results) to history when a later LLM round fails hard.
        const agentMessages = [];

        try {
            const _streamStart = Date.now();
            let _firstTokenTime = 0;
            let _tokenCount = 0;

            // --- In-app tool layer ---
            const useNativeTools = settings.internetAccess;
            // --- Native Function Calling Agent Loop ---
            // Opus-style agentic loop with interleaved thinking:
            // 1. Send request with tool definitions to /v1/chat/completions
            // 2. If model returns tool_calls → execute them → append results
            // 3. At medium/max effort, inject thinking prompt so model reflects between rounds
            // 4. When model returns a text response (no tool_calls) → done
            if (useNativeTools && !imageBase64) {
                // Compress the conversation first when the context window is
                // nearly full — otherwise this turn may not fit at all.
                await maybeAutoCompress(emitStatus);
                emitStatus({ phase: 'connecting' });

                let round = 0;
                let finalText = '';
                let finalThinking = '';
                let wroteFilesViaTool = false;
                // Per-turn reconstruction of file contents written via tools
                // (path → text), fed to the live file panel after every chunk so
                // the operator watches the file grow even when the backend
                // buffers tool-call arguments and streams nothing.
                const _fileProgress = Object.create(null);
                let consecutiveErrors = 0;
                let _lastUsage = null;
                // A turn is many requests. Usage must be SUMMED across them —
                // keeping only the last round's reported the tokens of the
                // final reply as if they were the whole turn. The generating
                // windows are summed too, so the rate divides by the time the
                // model actually generated rather than by the turn's wall
                // clock (which includes every tool call and re-prefill).
                let _turnCompletionTokens = 0;
                let _turnEstimatedTokens = 0;
                let _turnGenMs = 0;
                // Tokens from the rounds we could actually TIME. A backend
                // that buffers a tool call whole (LM Studio sends nothing
                // until the arguments are complete) delivers a round's entire
                // output in one delta: real tokens, no measurable window.
                // Those count toward the turn's total but must stay out of the
                // rate, or they divide by a duration that was never observed.
                let _turnRateTokens = 0;
                let _rounds = 0;
                let _roundsWithUsage = 0;
                // The engine's own measurement, summed over the rounds that
                // reported it. predicted_ms is time llama.cpp spent decoding —
                // it excludes prompt processing, queueing, the network and this
                // proxy, all of which a client-side stopwatch includes and none
                // of which the model was generating during. Summing measured
                // parts is what makes the turn's rate the same number
                // llama-server prints in its own log, instead of an average
                // over everything that happened to be in the way.
                let _turnMeasuredTokens = 0;   // Σ predicted_n
                let _turnMeasuredMs = 0;       // Σ predicted_ms
                let _turnPromptMs = 0;         // Σ prompt_ms — the re-prefill cost of an agent turn
                let _turnPromptTokens = 0;     // Σ prompt_n (freshly processed, cache excluded)
                let _turnCachedTokens = 0;     // Σ cache_n — prompt tokens served from the KV cache
                let _turnDraftTokens = 0;      // Σ draft_n         ) speculative decoding, when a
                let _turnDraftAccepted = 0;    // Σ draft_n_accepted) draft/MTP head is attached
                let _roundsWithTimings = 0;
                // Folds one round's `timings` into the turn. Called from every
                // round site, including the forced-final one, so a turn is
                // never measured from a subset of its rounds.
                const noteTimings = (t) => {
                    if (!t || !(t.predicted_n > 0)) return;
                    _roundsWithTimings++;
                    _turnMeasuredTokens += t.predicted_n;
                    _turnMeasuredMs     += t.predicted_ms > 0 ? t.predicted_ms : 0;
                    _turnPromptMs       += t.prompt_ms > 0 ? t.prompt_ms : 0;
                    _turnPromptTokens   += t.prompt_n > 0 ? t.prompt_n : 0;
                    _turnCachedTokens   += t.cache_n > 0 ? t.cache_n : 0;
                    _turnDraftTokens    += t.draft_n > 0 ? t.draft_n : 0;
                    _turnDraftAccepted  += t.draft_n_accepted > 0 ? t.draft_n_accepted : 0;
                };
                const turnTimings = () => ({
                    tokens: _turnMeasuredTokens,
                    ms: _turnMeasuredMs,
                    promptMs: _turnPromptMs,
                    promptTokens: _turnPromptTokens,
                    cachedTokens: _turnCachedTokens,
                    draftTokens: _turnDraftTokens,
                    draftAccepted: _turnDraftAccepted,
                    // Only every-round coverage makes the sum the whole turn;
                    // a partial sum would be a confident undercount.
                    complete: _rounds > 0 && _roundsWithTimings === _rounds,
                });
                // First round's usage measures the PERSISTENT footprint: system
                // prompt + digested history + the new user message. Later
                // rounds add this turn's tool transcript, which buildMessages()
                // digests down to stubs before the next turn — so the last
                // round's prompt_tokens overstates the conversation size,
                // spikes the context meter after agentic turns, and can trip
                // auto-compression for context the next request won't carry.
                let _baselineUsage = null;
                const effortProfile = EFFORT_PROFILES[getEffort()] || EFFORT_PROFILES.medium;

                // Cumulative tool-chip announcer for the whole turn. The
                // status-panel renderer appends only entries BEYOND the count
                // it has already drawn (status.tools.length > seen), so every
                // tool_calling emission must carry the full turn's arrays.
                // Emitting just the current round's calls — as this loop used
                // to — made any round with fewer calls than the running total
                // invisible in the AGENT TOOLS panel, and mislabeled the rest.
                const _turnToolLabels = [];
                const _turnToolMeta = [];
                const _turnToolIds = [];
                const announceToolCalls = (calls) => {
                    for (const tc of calls) {
                        let args = '';
                        try { args = JSON.parse(tc.function.arguments); args = args.query || args.url || args.path || JSON.stringify(args); } catch { args = tc.function.arguments; }
                        _turnToolLabels.push(`${tc.function.name}: ${args}`);
                        _turnToolIds.push(tc.id);
                    }
                    _turnToolMeta.push(...buildToolMeta(calls.map(tc => ({
                        name: tc.function.name,
                        arguments: tc.function.arguments,
                    }))));
                    emitStatus({
                        phase: 'tool_calling',
                        tools: [..._turnToolLabels],
                        toolMeta: [..._turnToolMeta],
                        toolIds: [..._turnToolIds],
                    });
                };

                const roundCap = toolRoundCap(effortProfile);
                const repeatCache = new Map(); // per-turn guard for identical web lookups
                // Anti-bounce bookkeeping: paths delivered IN FULL this turn
                // (fence or non-append write_file/file_edit) and which of them
                // the model has already been told not to re-emit.
                const _fullWritePaths = new Set();
                const _writeNudged = new Set();

                while (round < roundCap) {
                    round++;
                    if (turnAborted()) break;
                    const body = buildRequestBody(true, agentMessages);

                    // Retried on transient failures so completed tool rounds
                    // aren't thrown away by one backend hiccup.
                    const result = await streamSingleRequestWithRetry(body, onChunk, emitStatus);

                    if (!_firstTokenTime && result.firstTokenTime) _firstTokenTime = result.firstTokenTime;
                    _tokenCount += result.tokenCount;
                    _rounds++;
                    _turnGenMs += result.genMs || 0;
                    _turnEstimatedTokens += result.estimatedTokens || 0;
                    noteTimings(result.timings);
                    if (result.genMs > 0) {
                        _turnRateTokens += result.usageData?.completion_tokens > 0
                            ? result.usageData.completion_tokens
                            : (result.estimatedTokens || 0);
                    }
                    if (result.usageData) {
                        _lastUsage = result.usageData;
                        if (!_baselineUsage) _baselineUsage = result.usageData;
                        if (result.usageData.completion_tokens > 0) {
                            _turnCompletionTokens += result.usageData.completion_tokens;
                            _roundsWithUsage++;
                        }
                    }
                    // Overwrite (not accumulate) every round: salvage may only
                    // pull code from the SAME round that produced the final
                    // text — an earlier round's scratchpad likely describes
                    // code a tool call has since written to disk.
                    finalThinking = result.thinkText || result.reasoningText || '';

                    // Streaming file blocks arrive as reply text, not tool
                    // calls — save them now so the files exist on disk whether
                    // or not the round also made tool calls.
                    let fenceFailures = [];
                    if (result.fileFences && result.fileFences.length) {
                        const fenceOutcome = await applyFileFences(result, emitStatus, _fileProgress, round, announceToolCalls);
                        if (fenceOutcome.wrote) wroteFilesViaTool = true;
                        fenceFailures = fenceOutcome.failed;
                        (fenceOutcome.wrotePaths || []).forEach(p => _fullWritePaths.add(p));
                        if (turnAborted()) break;
                    }

                    if (result.finishReason === 'tool_calls' && result.toolCalls.length > 0) {
                        if (result.toolCalls.some(tc => FILE_WRITE_ARG[tc.function?.name])) wroteFilesViaTool = true;
                        announceToolCalls(result.toolCalls);

                        // Llama Instruct under the XML preamble wants its
                        // assistant turn replayed with the original
                        // <tool_call> blocks intact, and tool results returned
                        // as <tool_response> blocks in a user message. Native
                        // OpenAI tool_calls keep the structured shape so LM
                        // Studio's first-class tool support stays efficient.
                        const xmlToolMode = usesXmlToolFormat() && result.toolCallSource === 'xml';

                        if (xmlToolMode) {
                            // XML mode replays the assistant turn verbatim —
                            // its reasoning is already inside the raw text, so
                            // attaching it again would send it twice.
                            agentMessages.push({
                                role: 'assistant',
                                content: result.rawAssistantText || result.text || ''
                            });
                        } else {
                            pushAssistantRound(agentMessages, {
                                role: 'assistant',
                                content: result.text || null,
                                tool_calls: result.toolCalls
                            }, result.reasoningText);
                        }

                        // Identical-rewrite short-circuit: a full write_file whose
                        // content is byte-identical to what this turn already put
                        // on disk (the write_file ↔ code-fence bounce) is answered
                        // directly with a stop notice instead of hitting the disk
                        // and the approval gate again.
                        const execCalls = [];
                        const skippedWrites = [];
                        for (const tc of result.toolCalls) {
                            let dup = false;
                            if (FILE_WRITE_ARG[tc.function?.name] === 'content') {
                                try {
                                    const a = JSON.parse(tc.function.arguments);
                                    dup = !!(a && a.path && a.append !== true
                                        && typeof a.content === 'string'
                                        && _fileProgress[a.path] === a.content);
                                } catch { /* unparseable — execute normally */ }
                            }
                            if (dup) {
                                skippedWrites.push({
                                    role: 'tool',
                                    tool_call_id: tc.id,
                                    content: JSON.stringify({ ok: true, skipped: 'identical_content', note: 'This exact content is already on disk from this turn — write skipped. Do NOT resend the file; use file_edit for changes.' }),
                                });
                            } else {
                                execCalls.push(tc);
                            }
                        }
                        const toolResults = execCalls.length
                            ? await executeToolCallsGuarded(execCalls, emitStatus, repeatCache)
                            : [];
                        toolResults.push(...skippedWrites);

                        // Chunked-write progress: after each successful file-write
                        // call, replay the file's accumulated content into the live
                        // file panel. This is what makes code delivery VISIBLE when
                        // the backend buffers tool-call arguments (LM Studio): the
                        // file grows on screen chunk by chunk between calls.
                        for (const tc of result.toolCalls) {
                            const field = FILE_WRITE_ARG[tc.function?.name];
                            if (!field) continue;
                            const tr = toolResults.find(r => r.tool_call_id === tc.id);
                            try { if (JSON.parse(tr?.content ?? '{}')?.error) continue; } catch { /* non-JSON — show intent */ }
                            let args = null;
                            try { args = JSON.parse(tc.function.arguments); } catch { continue; }
                            const fp = args?.path;
                            if (!fp || typeof args[field] !== 'string') continue;
                            if (tc.function.name === 'file_edit') {
                                // Mirror the server-side edit on our reconstruction —
                                // only possible when we already track this file.
                                if (typeof _fileProgress[fp] !== 'string') continue;
                                _fileProgress[fp] = args.replace_all
                                    ? _fileProgress[fp].split(args.old_string).join(args.new_string)
                                    : _fileProgress[fp].replace(args.old_string, args.new_string);
                                _fullWritePaths.add(fp);
                            } else {
                                _fileProgress[fp] = (args.append === true && typeof _fileProgress[fp] === 'string')
                                    ? _fileProgress[fp] + args[field]
                                    : args[field];
                                // append:true is a continuation chunk — the file is
                                // only "fully delivered" on a non-append write.
                                if (args.append !== true) _fullWritePaths.add(fp);
                            }
                            emitStatus({ phase: 'file_stream', name: tc.function.name, path: fp, content: _fileProgress[fp] });
                        }

                        if (xmlToolMode) {
                            agentMessages.push(buildXmlToolResponseTurn(result.toolCalls, toolResults));
                        } else {
                            agentMessages.push(...toolResults);
                        }

                        // A failed streaming-file-block write is invisible to
                        // the model (it happened outside its tool calls) —
                        // tell it so the next round can recover instead of
                        // assuming the file exists on disk.
                        if (fenceFailures.length) {
                            agentMessages.push({
                                role: 'user',
                                content: `[System: streaming file block(s) could NOT be saved — ${fenceFailures.map(f => `${f.path}: ${f.error}`).join('; ')}. The code stayed in your reply text only. Recover with write_file (chunked) to a valid path, or continue without the file.]`
                            });
                        }

                        // Self-correction: detect tool errors and hint the model to retry
                        const errors = toolResults.filter(r => {
                            try { return JSON.parse(r.content)?.error; } catch { return false; }
                        });
                        if (errors.length > 0) {
                            consecutiveErrors++;
                            const errorSummary = errors.map(r => {
                                try { return JSON.parse(r.content).error; } catch { return r.content; }
                            }).join('; ');
                            if (consecutiveErrors >= 3 && round < roundCap) {
                                agentMessages.push({
                                    role: 'user',
                                    content: `[System: ${consecutiveErrors} consecutive tool errors. STOP retrying the same approach. Either use a completely different tool/strategy or provide the best answer you can with the information you already have. Errors: ${errorSummary}]`
                                });
                            } else if (round < roundCap) {
                                agentMessages.push({
                                    role: 'user',
                                    content: `[System: ${errors.length} tool call(s) returned errors: ${errorSummary}. Analyze the errors and either retry with corrected parameters or provide a response without that tool.]`
                                });
                            }
                        } else {
                            consecutiveErrors = 0;

                            // Interleaved thinking: at medium/max effort, prompt reflection
                            // between tool rounds — Opus-style planning between actions
                            if (shouldInjectInterleavedNudge(effortProfile, round)) {
                                pushInterleavedNudge(agentMessages,
                                    result.toolCalls.map(tc => tc.function.name).join(', '));
                            }
                        }

                        // Truncated round: the reply hit its output ceiling while
                        // the call was still being emitted, so the arguments are
                        // a fragment. The server refuses to write an unterminated
                        // one, but only this side knows WHY it was cut — say so,
                        // and point at the delivery shape that survives a ceiling
                        // (chunks land one at a time; one giant call loses
                        // everything after the cut).
                        if (result.truncated && round < roundCap) {
                            const cutTools = [...new Set(result.toolCalls
                                .map(tc => tc.function?.name).filter(Boolean))].join(', ');
                            agentMessages.push({
                                role: 'user',
                                content: `[System: that round was CUT OFF at the output token limit while emitting ${cutTools || 'a tool call'} — the call never finished, so it did not run and nothing it was writing reached disk. Do not assume any of it landed: read_file the target first to see what is actually there, then continue from that point in ~100-line chunks (write_file, then append:true for each continuation). Keep each call small enough to finish.]`
                            });
                        }

                        // Anti-bounce nudge (once per file): after a full delivery,
                        // eager models re-send the SAME file through the OTHER
                        // channel next round (write_file ↔ streaming code block,
                        // "let's overwrite with improvements"), rewriting hundreds
                        // of lines per bounce. Recency beats the prompt's CODING
                        // rules, so say it right after the write.
                        const freshWrites = [..._fullWritePaths].filter(p => !_writeNudged.has(p));
                        if (freshWrites.length) {
                            freshWrites.forEach(p => _writeNudged.add(p));
                            agentMessages.push({
                                role: 'user',
                                content: `[System: On disk in full: ${freshWrites.join(', ')}. Do NOT send this file's content again in ANY channel — no repeat write_file, no code block with the full file, no "rewrite with improvements". Modifications go through file_edit (old_string → new_string). Unfinished chunked writes may still continue with append:true. Otherwise: reference the file by path and finish your reply.]`
                            });
                        }

                        // Budget guard: one round left — tell the model to land the
                        // answer instead of running into the hard cap (which would
                        // cost an extra forced-final request).
                        if (round === roundCap - 1) {
                            agentMessages.push({
                                role: 'user',
                                content: `[System: Tool budget nearly exhausted (round ${round} of ${roundCap} at this effort level). Give your final answer next — at most ONE more essential tool call.]`
                            });
                        }

                        // Clear streamed content for the next round
                        if (onChunk) onChunk('', '');
                        if (turnAborted()) break;
                        continue;
                    }

                    finalText = result.text;
                    break;
                }

                // Operator stopped mid-run — finalize with the partial reply,
                // commit the work done so far, and skip the standard fallback.
                if (turnAborted()) {
                    const reply = wroteFilesViaTool
                        ? deduplicateResponse(finalText || '')
                        : salvageCodeFromThinking(deduplicateResponse(finalText || ''), finalThinking);
                    if (onChunk) onChunk('', reply);
                    _lastStats = buildStats(_streamStart, _firstTokenTime, _tokenCount, _lastUsage, _baselineUsage,
                        { completionTokens: _turnCompletionTokens, genMs: _turnGenMs,
                          estimatedTokens: _turnEstimatedTokens, rateTokens: _turnRateTokens,
                          timings: turnTimings(),
                          complete: _rounds > 0 && _roundsWithUsage === _rounds });
                    emitStatus({ phase: 'aborted', stats: _lastStats });
                    if (agentMessages.length > 0) conversationHistory.push(...persistableAgentMessages(agentMessages));
                    conversationHistory.push({ role: 'assistant', content: (reply || '').trim() || '_(abgebrochen)_' });
                    isProcessing = false;
                    return reply;
                }

                // If max rounds reached without a final answer, force one more attempt
                if (!finalText && round >= roundCap) {
                    agentMessages.push({
                        role: 'user',
                        content: `[System: You have used ${round} tool rounds. Please provide your final answer now based on all the information gathered. Do NOT make any more tool calls.]`
                    });
                    const body = buildRequestBody(true, agentMessages);
                    try {
                        const result = await streamSingleRequestWithRetry(body, onChunk, emitStatus);
                        if (result.firstTokenTime) _firstTokenTime = _firstTokenTime || result.firstTokenTime;
                        _tokenCount += result.tokenCount;
                        _rounds++;
                        _turnGenMs += result.genMs || 0;
                        _turnEstimatedTokens += result.estimatedTokens || 0;
                        noteTimings(result.timings);
                        if (result.genMs > 0) {
                            _turnRateTokens += result.usageData?.completion_tokens > 0
                                ? result.usageData.completion_tokens
                                : (result.estimatedTokens || 0);
                        }
                        if (result.usageData) {
                            _lastUsage = result.usageData;
                            if (!_baselineUsage) _baselineUsage = result.usageData;
                            if (result.usageData.completion_tokens > 0) {
                                _turnCompletionTokens += result.usageData.completion_tokens;
                                _roundsWithUsage++;
                            }
                        }
                        if (result.fileFences && result.fileFences.length) {
                            const fenceOutcome = await applyFileFences(result, emitStatus, _fileProgress, round, announceToolCalls);
                            if (fenceOutcome.wrote) wroteFilesViaTool = true;
                        }
                        finalText = result.text;
                        finalThinking = result.thinkText || result.reasoningText || '';
                    } catch { /* fall through with empty */ }
                }

                // Same file-write gate as the standard path: code delivered to
                // disk by a tool must not be re-pasted from the scratchpad.
                const reply = wroteFilesViaTool
                    ? deduplicateResponse(finalText)
                    : salvageCodeFromThinking(deduplicateResponse(finalText), finalThinking);

                // If native agent loop produced a response, return it
                if (reply) {
                    if (onChunk) onChunk('', reply);
                    _lastStats = buildStats(_streamStart, _firstTokenTime, _tokenCount, _lastUsage, _baselineUsage,
                        { completionTokens: _turnCompletionTokens, genMs: _turnGenMs,
                          estimatedTokens: _turnEstimatedTokens, rateTokens: _turnRateTokens,
                          timings: turnTimings(),
                          complete: _rounds > 0 && _roundsWithUsage === _rounds });
                    emitStatus({ phase: 'done', stats: _lastStats });

                    if (agentMessages.length > 0) {
                        conversationHistory.push(...persistableAgentMessages(agentMessages));
                    }
                    conversationHistory.push({ role: 'assistant', content: reply });
                    isProcessing = false;
                    return reply;
                }

                // Native agent loop returned empty — fall through to the
                // standard streaming path below as a last resort.
                console.debug('[Native] Empty response after', round, 'rounds, falling through to standard path');
            }

            // Standard streaming path (OpenAI-compatible), used when the
            // in-app tool layer is off or an image is attached.
            emitStatus({ phase: 'connecting' });

            armWatchdog(120000, 'Model did not respond — connection timed out');
            const res = await fetchWithRetry(`${getApiBase()}/v1/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Cache-Control': 'no-cache',
                    ...getExtraHeaders()
                },
                body: JSON.stringify(buildRequestBody(true)),
                signal: withTurnSignal(streamCtrl.signal)
            });

            if (!res.ok) {
                clearWatchdog();
                throw createApiError(res.status, await safeResponseText(res));
            }

            // Some backends ignore `stream: true` and answer with a plain
            // JSON completion. The SSE parser below sees no "data:" lines for
            // those, silently yields an empty reply, and the caller then fires
            // a SECOND non-streaming request — the user watches a blank bubble
            // for two full generations. Detect JSON up front and render it in
            // one shot instead, including any reasoning the model produced.
            const resContentType = res.headers.get('content-type') || '';
            if (resContentType.includes('application/json')) {
                clearWatchdog();
                const data = await res.json();
                const msg = data.choices?.[0]?.message || {};
                let text = msg.content || data.choices?.[0]?.text || '';
                let reasoningText = msg.reasoning_content || msg.reasoning || '';
                // A thinking-locked template pre-opens the think block: the
                // content then starts with bare scratchpad ending in '</think>'
                // with no opener — split that off as reasoning too.
                const implicit = extractImplicitThink(text);
                if (implicit.reasoning.trim()) {
                    reasoningText += (reasoningText ? '\n' : '') + implicit.reasoning.trim();
                    text = implicit.text;
                }
                // Inline <think> blocks count as reasoning too
                text = text.replace(/<think>([\s\S]*?)<\/think>/gi, (_, t) => {
                    reasoningText += (reasoningText ? '\n' : '') + t.trim();
                    return '';
                });
                if (reasoningText.trim() && (EFFORT_PROFILES[getEffort()] || {}).showThinking) {
                    emitStatus({ phase: 'thinking', content: reasoningText.trim() });
                }
                emitStatus({ phase: 'generating' });
                const oneShotReply = salvageCodeFromThinking(
                    deduplicateResponse(stripToolBlocks(stripControlTokens(text)).trim()),
                    reasoningText
                ) || 'No response generated.';
                if (onChunk) onChunk(oneShotReply, oneShotReply);
                _lastStats = buildStats(_streamStart, Date.now(),
                    data.usage?.completion_tokens || Math.ceil(oneShotReply.length / 4),
                    data.usage || null);
                emitStatus({ phase: 'done', stats: _lastStats });
                conversationHistory.push({ role: 'assistant', content: oneShotReply });
                isProcessing = false;
                return oneShotReply;
            }

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            // Single accumulator string. V8 represents `+=` as a cheap rope, and
            // the consumer needs the full text each chunk anyway — so we keep one
            // running string instead of re-joining an array every token (which was
            // O(n²) over the length of the reply).
            let reply = '';
            let buffer = '';
            let summarySeenAt = -1;
            let abortedRepeat = false;
            let thinkContent = '';
            let firstTokenSeen = false;
            let _streamUsage = null;

            // --- Tool visibility ---
            // Structured tool_calls deltas are surfaced as tool-status chips.
            // Inline <tool_call>/<tool_response> text blocks are a fallback for
            // models that emit XML instead — and are ALWAYS stripped from the
            // visible reply.
            let sawToolCallDelta = false; // a structured tool_calls delta was seen (widens the idle watchdog)
            let toolBuf = '';
            let toolChipCount = 0;        // fallback counter for inline blocks
            const toolLabels = [];        // cumulative chip labels  ("name: detail")
            const toolMetaArr = [];       // cumulative { name, args } aligned to labels
            const toolIds = [];           // cumulative tool-call ids aligned to labels
            const toolIndexById = new Map(); // tool-call id -> chip index
            const toolStartById = new Map(); // tool-call id -> start timestamp

            // Append one tool chip and push the (cumulative) arrays to the UI.
            // The renderer appends entries beyond the count it last saw, so the
            // arrays must stay cumulative and aligned. `rawName` is the bare tool
            // name (kept in meta for file-preview matching); `displayName` may
            // carry an emoji prefix purely for the visible chip label.
            const addToolChip = (rawName, detail, args, id, displayName) => {
                const idx = toolLabels.length;
                const label = displayName || rawName;
                toolLabels.push(detail ? `${label}: ${detail}` : `${label}:`);
                toolMetaArr.push({ name: rawName, args: args || null });
                toolIds.push(id || '');
                if (id) { toolIndexById.set(id, idx); toolStartById.set(id, Date.now()); }
                emitStatus({
                    phase: 'tool_calling',
                    tools: [...toolLabels],
                    toolMeta: [...toolMetaArr],
                    toolIds: [...toolIds],
                });
                return idx;
            };

            // Reasoning panel updates are shown only at HIGH/MAX (showThinking)
            // — at LOW/MED thinking was requested OFF, and if the model thinks
            // anyway the scratchpad stays out of the visible reply either way
            // (it still accumulates in thinkContent for the salvage pass).
            const emitThink = (s) => {
                if (!s) return;
                thinkContent += s;
                if (!(EFFORT_PROFILES[getEffort()] || {}).showThinking) return;
                const cleaned = thinkContent.trim();
                if (cleaned) emitStatus({ phase: 'thinking', content: cleaned });
            };

            const emitVisible = (s) => {
                if (!s) return;
                if (!firstTokenSeen) {
                    firstTokenSeen = true;
                    _firstTokenTime = Date.now();
                    emitStatus({ phase: 'generating' });
                }
                _tokenCount++;
                reply += s;
                if (onChunk) onChunk(s, reply);
                // Early repetition detection. The "## Summary" marker is short,
                // so scan only the tail (constant work per token) instead of
                // re-scanning the whole reply.
                if (summarySeenAt === -1) {
                    if (/\n##?\s*(?:Summary|Zusammenfassung)\s*\n/i.test(reply.slice(-64))) summarySeenAt = reply.length;
                }
                if (summarySeenAt > 0 && reply.length > summarySeenAt + 80) {
                    const tail = reply.substring(summarySeenAt).trim();
                    const head = reply.substring(0, summarySeenAt).trim();
                    const anchor = head.split('\n').find(l => l.trim().length >= 30 && !l.trim().startsWith('#'));
                    if (anchor && tail.includes(anchor.trim())) abortedRepeat = true;
                }
            };

            // Split-safe tag routing via the shared scanner (see
            // createStreamTagScanner) — tags split across deltas and think
            // blocks the template pre-opened never reach the chat bubble.
            const scanner = createStreamTagScanner({
                text: (s) => emitVisible(stripControlTokens(s)),
                think: emitThink,
                toolOpen: () => { toolBuf = ''; },
                toolText: (s) => { toolBuf += s; },
                toolClose: (tag, isResponse, wasInTool) => {
                    if (wasInTool && !isResponse) {
                        const call = parseToolCall(toolBuf);
                        if (call) {
                            toolChipCount++;
                            addToolChip(call.name, previewToolArgs(call.arguments),
                                        call.arguments, `inline_${toolChipCount}`);
                        }
                    }
                    toolBuf = '';
                },
                implicitThinkClose: () => {
                    // Stream started INSIDE a pre-opened think block (thinking-
                    // locked template): everything "visible" so far was
                    // scratchpad — pull it back out of the reply.
                    if (reply) {
                        const scratch = reply;
                        reply = '';
                        summarySeenAt = -1;
                        if (onChunk) onChunk('', '');
                        emitThink(scratch);
                    }
                },
            });

            try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                // Data is flowing — reset the idle watchdog. Only a stalled
                // stream aborts, never a long one. Once a tool call has
                // started, the backend may buffer its entire arguments JSON
                // and go silent for minutes (see TOOL_ARGS_IDLE_MS).
                if (sawToolCallDelta) armWatchdog(TOOL_ARGS_IDLE_MS, 'Stream stalled during a tool call — no data from the model for 10 minutes');
                else armWatchdog(120000, 'Stream stalled — no data from the model for 2 minutes');

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (line.length < 6) continue; // fast skip empty/short lines
                    const trimmed = line.trim();
                    if (!trimmed.startsWith('data:')) continue;
                    const data = trimmed.slice(5).trim();
                    if (data === '[DONE]') continue;

                    try {
                        const parsed = JSON.parse(data);

                        // Capture usage data from final chunk
                        if (parsed.usage) _streamUsage = parsed.usage;

                        const choice = parsed.choices?.[0];
                        const choiceDelta = choice?.delta;

                        // Reasoning streamed as a dedicated field (Qwen3.5 /
                        // DeepSeek R1 hybrid thinking) — separate from
                        // content, not inside <think> tags. Field name varies
                        // by backend. A delta can carry BOTH reasoning and
                        // content, so don't skip the rest of the chunk.
                        const reasoning = [choiceDelta?.reasoning_content, choiceDelta?.reasoning, choiceDelta?.thinking]
                            .find(v => typeof v === 'string' && v);
                        if (reasoning) emitThink(reasoning);

                        // Structured tool_calls (OpenAI-style). Deduped by
                        // id/index so a single call streamed across deltas shows once.
                        const structuredCalls = choiceDelta?.tool_calls;
                        // Re-arm IMMEDIATELY with the wide window: the tool-call
                        // header packet is often the last byte before the backend
                        // silently generates the whole arguments blob — the
                        // 2-minute arm from this read must not govern that gap.
                        if (structuredCalls?.length && !sawToolCallDelta) {
                            sawToolCallDelta = true;
                            armWatchdog(TOOL_ARGS_IDLE_MS, 'Stream stalled during a tool call — no data from the model for 10 minutes');
                        }
                        if (structuredCalls?.length) {
                            for (const t of structuredCalls) {
                                const name = t.function?.name;
                                if (!name) continue;
                                const id = t.id || `sc_${t.index ?? toolLabels.length}`;
                                if (toolIndexById.has(id)) continue;
                                let args = null;
                                if (t.function?.arguments) {
                                    try { args = JSON.parse(t.function.arguments); } catch { /* partial */ }
                                }
                                addToolChip(name, previewToolArgs(args), args, id);
                            }
                        }

                        // Visible content. Some servers stream whole-message
                        // chunks ({message:{content}} or {text}) instead of
                        // OpenAI deltas — accept those shapes too so the bubble
                        // doesn't stay blank against a non-conforming backend.
                        let delta = choiceDelta?.content;
                        if (delta == null) delta = choice?.message?.content ?? choice?.text ?? null;
                        if (typeof delta === 'string' && delta) {
                            scanner.push(delta);
                            if (abortedRepeat) { reader.cancel(); break; }
                        }
                    } catch { /* skip malformed chunks */ }
                }
                if (abortedRepeat) break;
            }
            } catch (streamErr) {
                // The SSE stream was cut mid-flight — proxy/tunnel reset, the
                // backend dropped the connection, a content-decoding failure
                // ("Error in input stream"), or the idle watchdog firing. If
                // tokens already arrived, keep that partial answer instead of
                // discarding the whole turn; only a totally empty stream is a
                // hard error worth surfacing.
                if (!reply.trim()) throw streamErr;
                console.warn('[stream] interrupted, salvaging partial reply:', streamErr?.message || streamErr);
                reply += '\n\n_⚠ Verbindung zum Modell unterbrochen — Teilantwort._';
            }
            clearWatchdog();

            // Flush the decoder (a multi-byte UTF-8 char can be split across the
            // final network chunk) and salvage a trailing SSE line that arrived
            // without a newline terminator — typically the final usage chunk,
            // occasionally the last content token.
            if (!abortedRepeat) {
                buffer += decoder.decode();
                const tail = buffer.trim();
                if (tail.startsWith('data:')) {
                    const data = tail.slice(5).trim();
                    if (data && data !== '[DONE]') {
                        try {
                            const parsed = JSON.parse(data);
                            if (parsed.usage) _streamUsage = parsed.usage;
                            const d = parsed.choices?.[0]?.delta?.content;
                            if (typeof d === 'string' && d) scanner.push(d);
                        } catch { /* truncated line — nothing to salvage */ }
                    }
                }
                // Flush the scanner — releases any held-back partial-tag tail
                scanner.flush();
            }

            // Salvage AFTER dedupe: the appended code must never be eaten by
            // the repeat-cutter, and the scratchpad may echo prose lines the
            // dedupe would otherwise anchor on. Skip salvage when a file-write
            // tool ran this turn — the code was delivered to disk, and lifting
            // the scratchpad draft into the reply would duplicate it.
            const wroteFiles = toolMetaArr.some(t => t && FILE_WRITE_ARG[t.name]);
            const deduped = deduplicateResponse(stripToolBlocks(stripControlTokens(reply)));
            const fullReply = wroteFiles ? deduped : salvageCodeFromThinking(deduped, thinkContent);
            if (onChunk) onChunk('', fullReply);
            _lastStats = buildStats(_streamStart, _firstTokenTime, _tokenCount, _streamUsage);
            emitStatus({ phase: 'done', stats: _lastStats });
            conversationHistory.push({ role: 'assistant', content: fullReply });
            isProcessing = false;
            return fullReply;
        } catch (err) {
            clearWatchdog();
            isProcessing = false;
            // Operator pressed Stop: keep the conversation intact and surface a
            // clean 'aborted' status instead of an error. A placeholder assistant
            // turn keeps history from ending on two consecutive user messages.
            if (turnAborted()) {
                emitStatus({ phase: 'aborted' });
                if (conversationHistory[conversationHistory.length - 1]?.role === 'user') {
                    conversationHistory.push({ role: 'assistant', content: '_(abgebrochen)_' });
                }
                return '';
            }
            // Tool work already executed this turn must survive the failure —
            // same treatment as the abort path above. Only when NOTHING
            // happened yet is the dangling user turn rolled back.
            const persistable = persistableAgentMessages(agentMessages);
            if (persistable.length > 0) {
                conversationHistory.push(...persistable);
                conversationHistory.push({ role: 'assistant', content: '_(Fehler — der Turn brach ab, die bereits ausgeführten Tool-Schritte wurden behalten.)_' });
            } else {
                conversationHistory.pop();
            }
            emitStatus({ phase: 'error', message: err.message });
            throw err;
        }
    }

    // baselineUsage: usage of the turn's FIRST request (persistent history
    // only, before this turn's tool transcript inflated the prompt). It feeds
    // the session context counter so the meter and auto-compression track what
    // the NEXT request will actually carry; usageData (the last request) keeps
    // feeding the per-message stats. Single-request paths pass only usageData.
    // turn: { completionTokens, genMs, timings, complete } accumulated over
    // every round of an agent turn. Absent on the single-request paths, which
    // are one round by definition.
    function buildStats(startTime, firstTokenTime, tokenCount, usageData, baselineUsage = null, turn = null) {
        const totalMs = Date.now() - startTime;
        const ttft = firstTokenTime ? firstTokenTime - startTime : totalMs;
        // Generating time, not wall-clock time. A turn's wall clock includes
        // tool execution and prompt re-processing between rounds; dividing the
        // token count by it reported a fraction of the model's real speed —
        // the more tools a turn used, the further under. Fall back to the
        // single-request measure when no per-round total was collected.
        const genMs = turn?.genMs > 0
            ? turn.genMs
            : (firstTokenTime ? Date.now() - firstTokenTime : totalMs);
        // Which measurement of the turn's output to believe, best first. The
        // engine's per-round `timings.predicted_n` and its `usage`
        // completion_tokens are the same number from the same counter, so
        // either is exact; timings lead because they come with the decode
        // clock the rate below needs, and a round can report them while its
        // usage went missing behind a proxy. Both are only trusted when EVERY
        // round reported — a partial sum is a confident undercount — and
        // usageData is the LAST round alone, so on a multi-round turn it
        // describes the final reply rather than the work. tokenCount is the
        // last resort: it increments once per SSE delta of visible text,
        // which is neither a token count (speculative decoding packs several
        // accepted draft tokens into one delta) nor inclusive of reasoning.
        const generated = (turn?.timings?.complete && turn.timings.tokens > 0)
            ? turn.timings.tokens
            : ((turn?.complete && turn.completionTokens > 0)
                ? turn.completionTokens
                : (turn?.estimatedTokens > 0
                    ? turn.estimatedTokens
                    : (usageData?.completion_tokens > 0 ? usageData.completion_tokens : tokenCount)));
        // Rate over the rounds that could be timed. `generated` is the turn's
        // whole output and is the right number to SHOW, but a round delivered
        // in one buffered delta contributes tokens with no observable window
        // — dividing the full total by the partial time reports a speed the
        // model never ran at.
        const rateTokens = turn?.rateTokens > 0 ? turn.rateTokens : generated;
        // Three sources for the rate, best first:
        //
        //   1. The engine's own decode clock, summed over the turn's rounds.
        //      llama.cpp times the decode loop itself, so `predicted_ms`
        //      excludes prompt processing, queueing, the proxy hop, this
        //      browser's event loop and the render — none of which the model
        //      was generating during, all of which a client stopwatch counts.
        //      Only used when EVERY round reported, for the same reason the
        //      token sum is: a partial sum is a confident wrong answer.
        //   2. The client's own generating window (first token → last token,
        //      summed per round). What a backend that reports no timings
        //      leaves us: honest, but an average over more than generation.
        //   3. Nothing measurable — 0, and the UI omits the segment.
        //
        // The token count follows the same order, so the rate and the count
        // shown beside it always come from the same measurement.
        const m = turn?.timings;
        const measured = !!(m && m.complete && m.tokens > 0 && m.ms > 0);
        const tokPerSec = measured
            ? (m.tokens / (m.ms / 1000))
            : (genMs > 0 ? (rateTokens / (genMs / 1000)) : 0);

        // Accumulate session token counters from API usage data
        if (usageData) {
            _sessionPromptTokens = (baselineUsage || usageData).prompt_tokens || 0;
            // The turn's total, not the last round's — the session counter
            // was losing every intermediate round of every agent turn. Same
            // order of preference as `generated`, so the session total and the
            // per-turn one can never disagree about the same turn.
            _sessionCompletionTokens += measured
                ? m.tokens
                : ((turn?.completionTokens > 0)
                    ? turn.completionTokens
                    : (usageData.completion_tokens || 0));
            // Calibrate the char-based estimator against the tokenizer that just
            // reported real numbers. This runs BEFORE the turn's reply is pushed
            // onto conversationHistory, so the estimate here covers the same
            // messages the baseline request carried and the two are comparable.
            // chars/4 under-reads German by roughly a fifth; the ratio absorbs
            // that along with the chat template's framing overhead.
            const estimate = estimateHistoryTokens();
            if (_sessionPromptTokens > 0 && estimate > 0) {
                const ratio = _sessionPromptTokens / estimate;
                // Ignore implausible ratios instead of poisoning every later
                // reading — a truncated history or a backend reporting nonsense
                // must not permanently skew the meter.
                if (ratio >= 0.5 && ratio <= 3) {
                    _tokenEstimateRatio = ratio;
                    // Same pairing, kept as an anchor: this many real tokens
                    // for this much of the conversation. Only stored when the
                    // ratio passed its sanity band, so a nonsense report can't
                    // pin the meter through the anchor either.
                    _ctxAnchor = { tokens: _sessionPromptTokens, estimate };
                }
            }
            // Close the loop on the per-request breakdown: actual vs estimate
            // (the delta is chat-template framing the estimate can't see).
            if (settings.debugPromptTokens && _lastPromptBreakdown) {
                console.log(`[prompt-tokens] actual prompt_tokens=${usageData.prompt_tokens} (est was ${_lastPromptBreakdown.estTotal}, delta=${(usageData.prompt_tokens || 0) - _lastPromptBreakdown.estTotal})`);
            }
        } else {
            // Fallback: no usage report, so the delta count is all we have.
            _sessionCompletionTokens += tokenCount;
        }

        return {
            totalMs,
            ttftMs: ttft,
            tokens: generated,
            genMs,
            tokPerSec: Math.round(tokPerSec * 10) / 10,
            promptTokens: usageData?.prompt_tokens || 0,
            // Last round only — kept for the callers that reconcile a
            // per-round estimate against it.
            completionTokens: usageData?.completion_tokens || 0,
            // The whole turn, present only when every round reported usage.
            // Measured timings satisfy the same contract and cover rounds a
            // proxy dropped the usage of, so they count here too.
            turnCompletionTokens: measured
                ? m.tokens
                : ((turn?.complete && turn.completionTokens > 0) ? turn.completionTokens : 0),
            sessionPromptTokens: _sessionPromptTokens,
            sessionCompletionTokens: _sessionCompletionTokens,
            contextLength: _contextLength,
            // True when tokPerSec is the engine's decode clock rather than
            // this client's stopwatch — the UI marks the difference instead
            // of presenting a derived average as a measurement.
            measured,
            // Prompt processing, which is what TTFT actually is on a long
            // conversation: `promptTokens` here is what the engine had to
            // process FRESH, `cachedTokens` what the KV cache already held.
            // A turn that re-prefills thousands of tokens because the prompt
            // prefix changed looks identical to a slow model from the
            // outside — these two numbers are the difference.
            promptPerSec: (measured && m.promptMs > 0 && m.promptTokens > 0)
                ? Math.round((m.promptTokens / (m.promptMs / 1000)) * 10) / 10
                : 0,
            promptProcessedTokens: measured ? m.promptTokens : 0,
            cachedTokens: measured ? m.cachedTokens : 0,
            // Speculative decoding's actual yield. The acceptance rate decides
            // whether a draft/MTP head is buying speed or burning VRAM for
            // nothing, and it is measured per turn rather than assumed.
            draftTokens: measured ? m.draftTokens : 0,
            draftAccepted: measured ? m.draftAccepted : 0,
            draftAcceptRate: (measured && m.draftTokens > 0)
                ? Math.round((m.draftAccepted / m.draftTokens) * 1000) / 1000
                : null,
        };
    }

    // ─────────────────────────────────────────────────────────
    //  Context usage & auto-compression
    // ─────────────────────────────────────────────────────────

    // Rough token estimate (~4 chars/token). Used before the backend has
    // reported real usage numbers, and to size the compression summary.
    function estimateTokens(text) {
        return Math.ceil((text || '').length / 4);
    }

    // Char-count a message's content for token estimates. Image parts are
    // counted at a flat cost instead of their base64 length — a 300KB data
    // URL is ~1-2k vision tokens to the model, not the 75k+ that chars/4
    // would claim, and that overestimate used to trip auto-compression.
    const IMAGE_EST_CHARS = 4000; // ≈1k tokens per attached image
    function contentEstChars(content) {
        if (typeof content === 'string') return content.length;
        if (!Array.isArray(content)) return JSON.stringify(content || '').length;
        let chars = 0;
        for (const p of content) {
            if (p.type === 'image_url') chars += IMAGE_EST_CHARS;
            else if (p.type === 'text') chars += (p.text || '').length;
            else chars += JSON.stringify(p).length;
        }
        return chars;
    }

    // Char-count an assembled message array. Split out of
    // estimateHistoryTokens so the max_tokens clamp below can measure the
    // messages a request ACTUALLY carries instead of re-deriving them.
    function estimateMessagesChars(messages) {
        let chars = 0;
        for (const msg of messages || []) {
            chars += contentEstChars(msg.content);
            if (msg.tool_calls) chars += JSON.stringify(msg.tool_calls).length;
            // Preserved thinking (see pushAssistantRound) rides on the message
            // and is rendered into the prompt by the template, so it costs real
            // tokens. Bounded, but not small: three rounds of it is thousands.
            // Missing it here would let the max_tokens clamp overcommit by
            // exactly the amount preserved thinking added.
            if (msg.reasoning_content) chars += msg.reasoning_content.length;
            chars += 16; // per-message chat-template overhead
        }
        return chars;
    }

    // The backend also receives the advertised tool schemas with every request
    // (the active subset under tiered loading, or the full set otherwise).
    function estimateToolSchemaChars() {
        return settings.internetAccess ? JSON.stringify(getActiveTools()).length : 0;
    }

    // Estimate the prompt-token footprint of the NEXT request: system prompt
    // plus the (compressed-for-sending) history. Only used while no real
    // usage data is available yet — real prompt_tokens from the API win.
    function estimateHistoryTokens() {
        let chars = 0;
        try { chars += buildSystemPrompt().length; } catch { /* best effort */ }
        // The volatile context now rides as a trailing message, not in the
        // system prompt — count it here so the estimate stays accurate.
        try { chars += buildDynamicContext().length; } catch { /* best effort */ }
        chars += estimateMessagesChars(buildMessages());
        chars += estimateToolSchemaChars();
        return Math.ceil(chars / 4);
    }

    // Effective context window: manual override > value reported by the
    // backend's model list. 0 = unknown (UI falls back to text-only display).
    function getContextLimit() {
        const manual = parseInt(settings.contextWindow, 10) || 0;
        return manual > 0 ? manual : (_contextLength || 0);
    }

    // An effort tier names an OUTPUT ambition (up to 128k at MAX), but the
    // backend spends prompt + output out of ONE window. Two things make the
    // raw ambition dangerous rather than merely optimistic:
    //
    //   - llama-server divides -c across its slots, so a server started with
    //     `-c 65536 -np 2` advertises n_ctx 32768 per slot through /props —
    //     already smaller than the MAX tier's ask before a single prompt
    //     token, and LOW's 32768 is the whole window on its own.
    //   - under --no-context-shift an overflowing request is a hard failure,
    //     not a graceful drop of the oldest turns.
    //
    // Clamping keeps the tier an upper bound instead of a promise the window
    // cannot keep. An unknown window (limit 0, e.g. a backend that reports no
    // context length) is left alone: guessing a ceiling would be worse than
    // deferring to the backend's own.
    const OUTPUT_TOKEN_FLOOR = 1024; // a reply capped below this is not worth sending
    const CONTEXT_HEADROOM = 512;    // chat-template framing the char estimate misses
    function clampMaxTokens(requested, messages) {
        const limit = getContextLimit();
        if (!(limit > 0) || !(requested > 0)) return requested;
        const estimated = Math.ceil(
            (estimateMessagesChars(messages) + estimateToolSchemaChars()) / 4
        );
        // Real prompt_tokens describe the PREVIOUS request; inside a tool loop
        // the next one is strictly bigger, so keep whichever is more pessimistic.
        const prompt = Math.max(_sessionPromptTokens || 0, estimated);
        const room = limit - prompt - CONTEXT_HEADROOM;
        // The floor deliberately wins over a negative room: a context already
        // past its limit is auto-compression's problem, and asking for a
        // token budget of 0 or less would fail differently (and worse).
        return Math.max(OUTPUT_TOKEN_FLOOR, Math.min(requested, room));
    }

    // Tokens the NEXT request will carry — the number both the meter and
    // auto-compression actually care about.
    //
    // _sessionPromptTokens is a real measurement, but of a request that was
    // built BEFORE this turn's reply was appended, so reading it directly
    // under-reports the conversation by the whole last exchange. On a thinking
    // model the gap is not a rounding error: a turn whose baseline prompt was
    // ~9.1k can leave the slot holding ~25k, and a meter reading 9.1k against a
    // 32k window shows 28% when the truth is 77% — with auto-compression
    // reading the same stale number and therefore never firing.
    //
    // So measure the CURRENT history every time and scale it by the ratio the
    // last real usage report gave us. Cheap enough: the meter re-renders on
    // turn boundaries and chat switches, not per streamed token.
    function currentContextTokens() {
        return contextReading().used;
    }

    // The reading and how much of it is actually measured, in one pass so the
    // meter's number and its honesty marker can never disagree.
    //
    // `estimated` is the fraction of `used` that came from a char count rather
    // than from the backend. It is 0 right after a turn whose reply the
    // backend also counted, and grows only with what has been appended since —
    // which is the point: a meter that says "~" forever teaches the operator to
    // ignore it, and one that drops the "~" while still guessing is worse.
    function contextReading() {
        if (conversationHistory.length === 0) return { used: 0, measured: 0, estimated: 0 };
        const raw = estimateHistoryTokens();
        // The anchor only holds while the history is still an EXTENSION of
        // what was measured. Compression rewrites it, loading a chat replaces
        // it — both shrink the estimate below the anchor's, and both must fall
        // back to scaling rather than add growth to a size that no longer
        // describes this conversation.
        if (_ctxAnchor && _ctxAnchor.estimate > 0 && raw >= _ctxAnchor.estimate) {
            const grown = Math.round((raw - _ctxAnchor.estimate) * (_tokenEstimateRatio || 1));
            return { used: _ctxAnchor.tokens + grown, measured: _ctxAnchor.tokens, estimated: grown };
        }
        const used = _tokenEstimateRatio ? Math.round(raw * _tokenEstimateRatio) : raw;
        return { used, measured: 0, estimated: used };
    }

    // Snapshot for the UI context meter. `used` is the calibrated live estimate;
    // `estimated` stays true until the backend has reported real usage once, so
    // the UI keeps showing "~" while the reading is still a blind chars/4 guess.
    function getContextUsage() {
        const limit = getContextLimit();
        const r = contextReading();
        const used = r.used;
        // Marked estimated while ANY of the reading is a char count — which is
        // the honest bar, and a lower one than "the backend has reported at
        // least once" was.
        const estimated = r.estimated > 0 || !_tokenEstimateRatio;
        return {
            used,
            estimated,
            // What the backend counted, and what is still guessed on top of
            // it. A UI that wants to say how solid the number is has the two
            // halves rather than one boolean.
            measuredTokens: r.measured,
            estimatedTokens: r.estimated,
            limit,
            percent: limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : null,
            remaining: limit > 0 ? Math.max(0, limit - used) : null,
            prompt: _sessionPromptTokens,
            completion: _sessionCompletionTokens,
            compressing: _compressing,
            // Where the DENOMINATOR came from — see _contextSource.
            limitSource: _contextSource,
        };
    }

    // Auto-compression fires when the prompt grows past this fraction of the
    // context window, keeping the most recent messages verbatim.
    const COMPRESS_THRESHOLD = 0.8;
    const COMPRESS_KEEP_RECENT = 4;
    const COMPRESS_MIN_MESSAGES = 6;
    // Auto-compress only when at least this many OLDER turns (past the kept
    // recent window) can actually be summarized. Without it, once usage sits
    // above the threshold — e.g. a small loaded context window where the fixed
    // system-prompt + tool-schema + memory overhead alone exceeds 80% — every
    // single message would re-summarize the same handful of turns (including a
    // previous summary). The operator then sees "it compresses on every
    // message" while context never actually shrinks. Requiring a batch of new
    // older turns makes compression fire only when the conversation has grown
    // enough to be worth folding away.
    const COMPRESS_MIN_SUMMARIZE = 6;
    // Fallback trigger used only when the model's context window can't be
    // auto-detected (LM Studio's OpenAI /v1/models often omits it). Without it,
    // getContextLimit() returns 0 and auto-compression silently never fires —
    // so compression "doesn't work" from the operator's point of view. This
    // absolute budget engages compression on genuinely long conversations.
    const COMPRESS_FALLBACK_TOKENS = 16000;
    let _compressing = false;

    const COMPRESS_SYSTEM_PROMPT = `You compress conversation history. Write a dense summary of the conversation that preserves: the operator's goals and constraints, decisions made, important facts/numbers/paths/URLs, tool actions taken and their key results, and any unfinished work or open questions. Use short bullet points. Match the conversation's language (German or English). Output ONLY the summary — no preamble, no headings, no commentary.`;

    // Split history into [older turns to summarize] + [recent turns kept
    // verbatim]. The kept slice must start on a user turn so we never orphan a
    // 'tool' message or break an assistant→tool sequence (orphaned 'tool'
    // turns send models into infinite tool loops).
    function compressSplit() {
        let keepFrom = Math.max(1, conversationHistory.length - COMPRESS_KEEP_RECENT);
        while (keepFrom > 0 && conversationHistory[keepFrom].role !== 'user') keepFrom--;
        return {
            keepFrom,
            toSummarize: conversationHistory.slice(0, keepFrom),
            kept: conversationHistory.slice(keepFrom),
        };
    }

    // Check usage against the threshold and compress when needed.
    async function maybeAutoCompress(emitStatus = null) {
        if (!settings.autoCompress) return false;
        if (conversationHistory.length < COMPRESS_MIN_MESSAGES) return false;
        const limit = getContextLimit();
        // Same calibrated live reading the meter shows — the stale baseline
        // prompt this used to read is what let a 16k-token reply sail past the
        // threshold without ever tripping it.
        const used = currentContextTokens();
        // Known window → compress at the configured fraction. Unknown window →
        // fall back to an absolute budget so compression still engages instead
        // of silently never firing.
        const trigger = limit > 0 ? limit * COMPRESS_THRESHOLD : COMPRESS_FALLBACK_TOKENS;
        if (used < trigger) return false;
        // Anti-thrash: only fire when enough OLDER history has accumulated to be
        // worth folding away. After a compression the head is a single summary
        // turn, so this stops us from re-summarizing it every message when usage
        // stays high purely from fixed overhead a summary can't reduce.
        if (compressSplit().toSummarize.length < COMPRESS_MIN_SUMMARIZE) return false;
        return compressContext(emitStatus);
    }

    // Replace older history with an LLM-generated summary, keeping the last
    // few messages verbatim. Exposed for the manual "compress now" action.
    async function compressContext(emitStatus = null) {
        if (_compressing || conversationHistory.length < 3) return false;
        _compressing = true;
        try {
            if (emitStatus) emitStatus({ phase: 'compressing' });

            // Keep the most recent messages verbatim; summarize the rest.
            const { toSummarize, kept } = compressSplit();
            if (toSummarize.length === 0) return false;

            const transcript = toSummarize.map(msg => {
                let text = typeof msg.content === 'string'
                    ? msg.content
                    : Array.isArray(msg.content)
                        ? msg.content.filter(p => p.type === 'text').map(p => p.text).join('\n') || '[image]'
                        : JSON.stringify(msg.content || '');
                if (msg.tool_calls) {
                    text += `\n[called tools: ${msg.tool_calls.map(tc => tc.function?.name).filter(Boolean).join(', ')}]`;
                }
                if (text.length > 2000) text = text.substring(0, 2000) + '…';
                return `${msg.role.toUpperCase()}: ${text}`;
            }).join('\n\n');

            const summary = await oneShot(
                `Compress the following conversation history:\n\n${transcript}`,
                { systemPrompt: COMPRESS_SYSTEM_PROMPT, maxTokens: 1024, temperature: 0.3, timeoutMs: 90000 }
            );
            if (!summary) {
                console.warn('[compress] summarization failed — keeping full history');
                return false;
            }

            const beforeTokens = _sessionPromptTokens > 0 ? _sessionPromptTokens : estimateHistoryTokens();
            conversationHistory = [
                {
                    role: 'user',
                    content: `[CONTEXT SUMMARY — earlier conversation was compressed to free up context space. Treat this as accurate history:]\n${summary}`,
                },
                ...kept,
            ];
            // Real usage refreshes with the next turn's prompt_tokens. The
            // anchor goes with it: the history it measured no longer exists.
            _sessionPromptTokens = 0;
            _ctxAnchor = null;
            const afterTokens = estimateHistoryTokens();
            console.info(`[compress] ${toSummarize.length} messages → summary (${beforeTokens} → ~${afterTokens} tokens)`);
            if (emitStatus) {
                emitStatus({
                    phase: 'compressed',
                    beforeTokens,
                    afterTokens,
                    messagesCompressed: toSummarize.length,
                });
            }
            return true;
        } catch (err) {
            console.warn('[compress] failed:', err?.message || err);
            return false;
        } finally {
            _compressing = false;
        }
    }

    function clearHistory() {
        conversationHistory = [];
        _sessionPromptTokens = 0;
        _sessionCompletionTokens = 0;
        _ctxAnchor = null;
        _sessionId = newSessionId();
        _approveAllSession = false; // fresh conversation → ask again
    }

    function setHistory(history) {
        conversationHistory = Array.isArray(history) ? history : [];
        _sessionPromptTokens = 0;
        _sessionCompletionTokens = 0;
        // A loaded chat is a different conversation, and the previous one's
        // measurement would otherwise be added to it verbatim.
        _ctxAnchor = null;
        _sessionId = newSessionId();
    }

    // --- Chat History Persistence ---
    const CHAT_STORAGE_KEY = 'tricorder_chat_history';
    // Pointer to the most-recently active chat. The app boots into a fresh
    // chat; this key is only used to re-open the last conversation when it
    // still has an unconsumed server-side generation to deliver.
    const LAST_CHAT_KEY = 'tricorder_last_chat_id';
    function _rememberLastChat(id) { try { if (id) localStorage.setItem(LAST_CHAT_KEY, id); } catch { /* private mode */ } }

    function _loadChatIndex() {
        try {
            return JSON.parse(localStorage.getItem(CHAT_STORAGE_KEY)) || [];
        } catch { return []; }
    }

    function _saveChatIndex(index) {
        try {
            localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(index));
            return;
        } catch { /* quota — free room and retry */ }
        const removed = _freeChatSpace(null);
        const pruned = removed.length ? index.filter(c => !removed.includes(c.id)) : index;
        try {
            localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(pruned));
        } catch (e) {
            // Never throw out of the send/auto-save path — a QuotaExceededError
            // escaping here ends up rendered as an LLM ERROR in the chat.
            console.warn('[chats] could not persist chat index:', e?.message || e);
        }
    }

    // Free localStorage room by dropping the oldest saved chat (blob + index
    // entry). Saved chats are never pruned otherwise, and conversations with
    // photos carry multi-MB base64 payloads — a handful of them fills the
    // whole origin quota permanently, making EVERY subsequent write throw.
    // Each save also mirrors the chat to the server (_syncChatToServer), so
    // an evicted chat is still recoverable from the server-side chat logs.
    // Returns the evicted chat ids ([] when there was nothing to evict).
    function _freeChatSpace(keepId) {
        const index = _loadChatIndex();
        const oldestFirst = [...index].sort((a, b) =>
            (a.updatedAt || a.createdAt || 0) - (b.updatedAt || b.createdAt || 0));
        const victim = oldestFirst.find(c => c.id !== keepId);
        if (!victim) return [];
        try { localStorage.removeItem(`tricorder_chat_${victim.id}`); } catch { /* ignore */ }
        const remaining = index.filter(c => c.id !== victim.id);
        try { localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(remaining)); } catch { /* ignore */ }
        console.warn(`[chats] localStorage full — evicted oldest chat "${victim.title || victim.id}" (server copy remains)`);
        return [victim.id];
    }

    function getSavedChats() {
        return _loadChatIndex();
    }

    // Persist a chat's message blob, surviving localStorage quota pressure.
    // Conversations with attached photos carry multi-MB base64 images; one
    // oversized setItem used to throw QuotaExceededError and silently kill
    // auto-save for the whole session. On failure, retry with the image
    // payloads stripped (text is what matters for restore/insights).
    function _persistChatBlob(chatId, history) {
        const key = `tricorder_chat_${chatId}`;
        try {
            localStorage.setItem(key, JSON.stringify(history));
            return true;
        } catch { /* quota — retry slimmed */ }
        const slim = history.map(msg => {
            if (Array.isArray(msg.content)) {
                return {
                    ...msg,
                    content: msg.content.map(p => p.type === 'image_url'
                        ? { type: 'text', text: '[Image was attached]' }
                        : p),
                };
            }
            return msg.image ? { ...msg, image: null } : msg;
        });
        const slimJson = JSON.stringify(slim);
        try {
            localStorage.setItem(key, slimJson);
            return true;
        } catch { /* still full — evict old chats and retry */ }
        // The store is chronically full (old chats accumulate forever).
        // Evict oldest chats one at a time until the write fits. Bounded:
        // each round shrinks the index until nothing is left to evict.
        while (_freeChatSpace(chatId).length) {
            try {
                localStorage.setItem(key, slimJson);
                return true;
            } catch { /* keep evicting */ }
        }
        console.warn('[chats] persist failed even after stripping images and evicting old chats');
        return false;
    }

    function saveCurrentChat(title) {
        if (conversationHistory.length === 0) return null;
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const autoTitle = title || _generateChatTitle(conversationHistory);
        const entry = {
            id,
            title: autoTitle,
            createdAt: Date.now(),
            messageCount: conversationHistory.length,
            // Durable-streaming key: lets the app re-attach to a generation that
            // was still running (or finished server-side) when the app closed.
            sessionId: _sessionId,
        };
        // Store messages separately to keep the index lightweight
        _persistChatBlob(id, conversationHistory);
        const index = _loadChatIndex();
        index.unshift(entry); // newest first
        _saveChatIndex(index);
        _rememberLastChat(id);
        // Sync to server (fire-and-forget)
        _syncChatToServer(entry, conversationHistory);
        return entry;
    }

    // Overwrite an already-saved chat in place (same id). Used by the
    // mid-conversation auto-save so repeated saves don't clone the chat
    // into 15 separate entries in the history panel.
    function updateChat(chatId) {
        if (!chatId || conversationHistory.length === 0) return null;
        // Preserve the original createdAt + title if present; just refresh
        // messageCount and the message blob.
        const index = _loadChatIndex();
        const existing = index.find(c => c.id === chatId);
        if (!existing) {
            // Entry vanished (e.g. user deleted it) — fall back to a new save
            return saveCurrentChat();
        }
        existing.messageCount = conversationHistory.length;
        existing.updatedAt = Date.now();
        existing.sessionId = _sessionId;   // keep the resume key fresh
        // Refresh title if it was auto-generated from an earlier short turn
        // and the conversation has grown.
        if (!existing.titleLocked) {
            existing.title = _generateChatTitle(conversationHistory) || existing.title;
        }
        _persistChatBlob(chatId, conversationHistory);
        _saveChatIndex(index);
        _rememberLastChat(chatId);
        _syncChatToServer(existing, conversationHistory);
        return existing;
    }

    function _syncChatToServer(entry, messages) {
        fetch('/api/chatlogs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id: entry.id,
                title: entry.title,
                createdAt: entry.createdAt,
                messageCount: entry.messageCount,
                messages,
            }),
        }).catch(() => {}); // Silent fail — localStorage is primary
    }

    function loadChat(chatId) {
        try {
            const messages = JSON.parse(localStorage.getItem(`tricorder_chat_${chatId}`));
            if (Array.isArray(messages)) {
                conversationHistory = messages;
                _rememberLastChat(chatId);
                return messages;
            }
        } catch {}
        return null;
    }

    function getLastChatId() { try { return localStorage.getItem(LAST_CHAT_KEY) || null; } catch { return null; } }

    // Push a message onto the in-memory history WITHOUT resetting the session
    // (setHistory regenerates _sessionId, which would break resume keys).
    // Used by the launch-time resume path to commit a recovered assistant reply.
    function appendMessage(role, content) { conversationHistory.push({ role, content }); }

    // Read / restore the durable session id, so a chat reopened from history
    // keeps the same generation key for both resume and any follow-up turn.
    function getSessionId() { return _sessionId; }
    function restoreSession(id) { if (id) _sessionId = id; }

    function deleteChat(chatId) {
        localStorage.removeItem(`tricorder_chat_${chatId}`);
        const index = _loadChatIndex().filter(c => c.id !== chatId);
        _saveChatIndex(index);
        // Sync delete to server
        fetch(`/api/chatlogs/${chatId}`, { method: 'DELETE' }).catch(() => {});
    }

    function _generateChatTitle(history) {
        // Use first user message as title, truncated
        const firstUser = history.find(m => m.role === 'user');
        if (!firstUser) return 'Untitled Chat';
        const text = typeof firstUser.content === 'string'
            ? firstUser.content
            : firstUser.content?.find?.(c => c.type === 'text')?.text || '';
        const clean = text.replace(/\[.*?\]\s*/g, '').replace(/```[\s\S]*?```/g, '').trim();
        return clean.length > 60 ? clean.substring(0, 57) + '...' : clean || 'Untitled Chat';
    }

    // Retry fetch on network errors AND transient HTTP 5xx responses (backend
    // reloading a model, proxy hiccup). 4xx responses are returned as-is —
    // they are real errors the caller must handle. Request bodies here are
    // plain strings, so re-sending the same options is safe.
    async function fetchWithRetry(url, options, retries = 2) {
        for (let attempt = 0; attempt <= retries; attempt++) {
            let res;
            try {
                res = await fetch(url, options);
            } catch (err) {
                // Don't retry abort/timeout errors or if out of retries
                if (err.name === 'AbortError' || err.name === 'TimeoutError' || attempt === retries) {
                    if (err instanceof TypeError && err.message.includes('Failed to fetch')) {
                        throw new Error(`Cannot reach LM Studio (${getLmStudioUrl()}). Make sure the Node.js server and LM Studio are running.`);
                    }
                    throw err;
                }
                // Wait before retry: 1s, 2s
                await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
                continue;
            }
            if (res.status >= 500 && attempt < retries && !options?.signal?.aborted) {
                await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
                continue;
            }
            return res;
        }
    }

    function createApiError(status, body) {
        // Carry the HTTP status on the error object so retry logic can tell
        // transient 5xx failures apart from hard 4xx errors.
        const withStatus = (err) => { err.status = status; return err; };
        if (status === 401) {
            return withStatus(new Error('Authentication required. Please refresh the page and log in again.'));
        }
        if (status === 502 || status === 503) {
            return withStatus(new Error('The model backend is not reachable. Start LM Studio / llama.cpp / Ollama, or check the backend URL in Settings.'));
        }
        if (status === 504) {
            return withStatus(new Error('Request timed out. The model may be overloaded — try again or use a smaller model.'));
        }
        // Check if we got HTML instead of JSON (auth redirect or error page)
        if (body && body.trimStart().startsWith('<')) {
            return withStatus(new Error('Received unexpected HTML response. Session may have expired — please refresh the page.'));
        }
        // Detect model load failures (e.g. nvidia/nemotron-3-nano not available)
        try {
            const parsed = JSON.parse(body);
            const errMsg = parsed?.error?.message || '';
            if (errMsg.includes('Failed to load model') || errMsg.includes('Cannot find model')) {
                const modelMatch = errMsg.match(/"([^"]+)"/);
                const modelName = modelMatch ? modelMatch[1] : 'the selected model';
                return withStatus(new Error(`Failed to load ${modelName}. The model may not be downloaded or is incompatible with your hardware. Check LM Studio to verify the model is available.`));
            }
        } catch { /* not JSON, fall through */ }
        return withStatus(new Error(`LLM API error (${status}): ${body || 'Unknown error'}`));
    }

    async function safeResponseText(res) {
        try {
            return await res.text();
        } catch {
            return '';
        }
    }

    // Fetch the model list from LM Studio via the proxy.
    async function _fetchModelList() {
        try {
            const res = await fetch(`${getApiBase()}/v1/models`, {
                method: 'GET',
                headers: getExtraHeaders(),
                signal: AbortSignal.timeout(5000)
            });
            if (!res.ok) return [];
            const contentType = res.headers.get('content-type') || '';
            if (!contentType.includes('application/json')) return [];
            const data = await res.json();
            return data.data || [];
        } catch {
            return [];
        }
    }

    // Probe LM Studio's native /api/v0/models for the active model's context
    // window. The OpenAI-compat /v1/models list omits it, so without this probe
    // getContextLimit() stays 0 → the meter shows no bar and auto-compression
    // falls back to its low absolute budget (compressing far too early on a big
    // window). Reports loaded_context_length (the window the model is actually
    // loaded with) and falls back to the model's max_context_length.
    // Returns the detected length (0 = still unknown). Best-effort, never throws.
    async function detectContextLength() {
        const activeId = getModelId();
        // Some gateways expose a /context endpoint that answers the one
        // engine-neutral question — how big is the window ONE conversation
        // gets right now — and report the PER-SLOT figure. That matters:
        // llama-server divides -c across its slots, so a catalogue entry's
        // context_length can be a multiple of what a single request may fill,
        // and a meter sized off the larger number never warns before the
        // overflow turns into a hard failure. When the endpoint is absent (a
        // plain llama-server, LM Studio) we fall through to the probes below.
        const live = await _lmsApi('/context', { timeout: 4000 });
        if (live && parseInt(live.contextLength, 10) > 0) {
            _contextLength = parseInt(live.contextLength, 10);
            _contextSource = live.source === 'slots' ? 'backend' : (live.source || 'gateway');
            return _contextLength;
        }
        if (!activeId) return _contextLength;
        try {
            const native = await _lmsApi('/api/v0/models');
            const entry = Array.isArray(native?.data)
                ? native.data.find(m => m?.id === activeId) || null
                : null;
            if (entry) {
                _contextLength = entry.loaded_context_length || entry.max_context_length || _contextLength;
                if (_contextLength) _contextSource = 'catalog';
            }
        } catch { /* best effort — leave _contextLength as-is */ }
        // llama.cpp's llama-server has no /api/v0/models. Its GET /props
        // reports the per-slot context the server was actually started with
        // (default_generation_settings.n_ctx) — the real usable window, unlike
        // /v1/models' meta.n_ctx_train, which is the model's TRAINING max and
        // would overstate a smaller loaded window (meter under-reads, auto-
        // compression never fires, llama.cpp rejects the overflowing request).
        if (!_contextLength) {
            const props = await _lmsApi('/props');
            const nCtx = parseInt(props?.default_generation_settings?.n_ctx, 10);
            if (nCtx > 0) { _contextLength = nCtx; _contextSource = 'props'; }
        }
        return _contextLength;
    }

    // Returns an array of LM Studio model ids for the MODEL dropdown.
    async function fetchModels() {
        const models = await _fetchModelList();
        // Capture the context window of the active model when reported
        const activeId = getModelId();
        const active = models.find(m => m.id === activeId) || models[0];
        if (active) {
            _contextLength = active.context_length || active.max_model_len || active.context_window || 0;
            if (_contextLength) _contextSource = 'catalog';
        }
        // LM Studio's OpenAI-compat /v1/models omits context length — probe the
        // native endpoint so the meter and auto-compression know the real window.
        if (!_contextLength) await detectContextLength();
        return models.map(m => m.id).filter(Boolean);
    }

    // ─────────────────────────────────────────────────────────
    //  Model lifecycle — unload/reload for GPU sharing
    // ─────────────────────────────────────────────────────────
    //
    // Some local backends expose a native /api/v0/models endpoint that
    // reports *currently loaded* models (state = "loaded") alongside the
    // catalog. /api/v0/models/unload kicks a specific model out of VRAM,
    // and /api/v0/models/load pulls it back in. We use these (when
    // available) to hand the whole GPU over to ComfyUI during media
    // generation, then reload the LLM so chat resumes instantly. The
    // probe degrades gracefully to a no-op when the endpoint is absent.
    //
    // Remembered set of models we unloaded so we know what to reload
    // after the foreign tenant (ComfyUI) releases the GPU.
    let _evictedModels = [];

    // Probe the backend's native model-management REST API; returns the
    // parsed JSON or null if the endpoint doesn't exist.
    async function _lmsApi(path, options = {}) {
        try {
            const res = await fetch(`${getApiBase()}${path}`, {
                ...options,
                headers: {
                    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
                    ...getExtraHeaders(),
                    ...(options.headers || {}),
                },
                signal: AbortSignal.timeout(options.timeout || 10000),
            });
            if (!res.ok) return null;
            const text = await res.text();
            if (!text) return {};
            try { return JSON.parse(text); } catch { return text; }
        } catch {
            return null;
        }
    }

    // List models currently loaded in the backend's VRAM.
    // Returns an array of { id, state } objects, or [] on failure.
    async function listLoadedModels() {
        // /api/v0/models returns { data: [{ id, state, ... }] } where
        // state is "loaded" / "not-loaded". OpenAI-compat /v1/models
        // doesn't expose state, so we rely on the native endpoint.
        const data = await _lmsApi('/api/v0/models');
        if (!data || !Array.isArray(data.data)) return [];
        return data.data
            .filter(m => m?.state === 'loaded')
            .map(m => ({ id: m.id, type: m.type }));
    }

    // Unload every loaded LLM (and optionally embedding models) from
    // the backend's VRAM. Remembers the set so restoreLoadedModels()
    // can bring them back.
    async function unloadAllLoadedModels({ includeEmbeddings = false } = {}) {
        const loaded = await listLoadedModels();
        const targets = includeEmbeddings
            ? loaded
            : loaded.filter(m => m.type !== 'embeddings');
        if (targets.length === 0) {
            _evictedModels = [];
            return { unloaded: [], supported: loaded.length > 0 };
        }
        const unloaded = [];
        for (const m of targets) {
            const ok = await _lmsApi('/api/v0/models/unload', {
                method: 'POST',
                body: JSON.stringify({ model: m.id }),
                timeout: 30000,
            });
            if (ok !== null) unloaded.push(m);
        }
        _evictedModels = unloaded;
        return { unloaded, supported: true };
    }

    // Reload every model we previously evicted so chat resumes at
    // native speed instead of paying the JIT warmup on the next turn.
    async function restoreLoadedModels() {
        if (_evictedModels.length === 0) return { reloaded: [] };
        const reloaded = [];
        for (const m of _evictedModels) {
            const ok = await _lmsApi('/api/v0/models/load', {
                method: 'POST',
                body: JSON.stringify({ model: m.id }),
                timeout: 120000,   // cold-loading a 30B model can take a while
            });
            if (ok !== null) reloaded.push(m);
        }
        _evictedModels = [];
        return { reloaded };
    }

    // Getter exposed so callers can check whether an eviction is in
    // flight — useful if a chat message arrives mid-generation.
    function hasEvictedModels() {
        return _evictedModels.length > 0;
    }

    // One-shot LLM call — no conversation history, no isProcessing
    // lock, no streaming. For background helpers like song-lyric
    // generation that need to talk to the LLM without touching the
    // chat flow. Returns the response string (stripped of <think>
    // blocks) or null on failure.
    async function oneShot(prompt, {
        systemPrompt = null,
        maxTokens = 2048,
        temperature = 0.8,
        timeoutMs = 120000,
    } = {}) {
        const messages = [];
        if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
        messages.push({ role: 'user', content: prompt });
        try {
            const res = await fetch(`${getApiBase()}/v1/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...getExtraHeaders() },
                body: JSON.stringify({
                    model: getModelId(),
                    messages,
                    temperature,
                    max_tokens: maxTokens,
                    stream: false,
                    chat_template_kwargs: noThinkTemplateKwargs(),
                    // LM Studio ignores chat_template_kwargs but honours
                    // reasoning_effort:"none" as of 0.4.19 Build 2 — unless
                    // this model has already refused that value, in which case
                    // the learned replacement rides instead of a second 400.
                    reasoning_effort: applyEffortFallback('none', getModelId()),
                }),
                signal: AbortSignal.timeout(timeoutMs),
            });
            if (!res.ok) {
                console.warn('[oneShot] HTTP', res.status);
                return null;
            }
            const data = await res.json();
            const text = data.choices?.[0]?.message?.content || '';
            return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
        } catch (err) {
            console.warn('[oneShot] failed:', err?.message || err);
            return null;
        }
    }

    // Cancel any in-flight follow-up suggestion request. Called when a new turn
    // starts so a pending generation can't sit on the backend (serialising the
    // next real reply on a single-GPU server) or render under a stale bubble.
    function cancelFollowUps() {
        if (_followUpCtrl) {
            try { _followUpCtrl.abort(); } catch { /* already settled */ }
            _followUpCtrl = null;
        }
    }

    // Generate 2 smart follow-up questions based on the last exchange.
    //
    // This is an auxiliary round-trip fired after every assistant reply, so it
    // is kept cheap and cancellable:
    //   • trivial exchanges (very short replies) are skipped entirely;
    //   • the prompt is a continuation of the LAST request the turn sent
    //     (same messages + tools + the finished reply + the instruction), so
    //     the backend's prompt/KV cache gets a pure prefix hit and the live
    //     conversation's cached context survives for the next user turn; a
    //     standalone 2-message prompt is the fallback when no last-request
    //     snapshot exists;
    //   • thinking is disabled where the backend honours it, and the token
    //     budget has enough headroom to survive backends that think anyway;
    //   • a timeout AND an AbortController, cancelled by the next turn,
    //     so it never blocks the backend behind a fresh user request;
    //   • parsing is lenient — line-based first, then any "…?" sentences —
    //     so imperfect formatting still yields buttons instead of nothing.
    async function generateFollowUps(userQuestion, assistantReply) {
        const replyText = (assistantReply || '').trim();
        // Don't bother for greetings, acknowledgements or one-liners — there's
        // nothing meaningful to follow up on and it just burns a call.
        if (replyText.length < 40) return [];

        cancelFollowUps();
        const ctrl = new AbortController();
        _followUpCtrl = ctrl;
        // 12s proved too tight in practice: on a busy single-GPU backend this
        // helper queues behind the main turn's KV-cache work, so it regularly
        // got aborted just before answering — and follow-ups silently stopped
        // appearing. 25s still can't block anything (the next turn cancels it).
        const timer = setTimeout(() => { try { ctrl.abort(); } catch {} }, 25000);
        // One string used for both the request and the instruction-echo filter
        // below, so the filter can never drift out of sync with the prompt.
        const FOLLOWUP_SYS = 'Generate exactly 2 short follow-up questions the user might ask next. Output ONLY the 2 questions, one per line. No numbering, no prefixes, no explanations. Plain natural-language prose only — never letter-spacing, hyphenation, scansion or metre notation, even if the conversation uses them. Match the language of the conversation (German or English). Keep each question under 60 characters.';
        try {
            const truncatedReply = replyText.length > 500
                ? replyText.substring(0, 500) + '…'
                : replyText;

            // Cache-friendly continuation: when the exact request of the main
            // turn is known, replay it verbatim — messages AND tools, because
            // the chat template renders tool schemas into the prompt prefix,
            // so omitting them would shift every token and void the cache —
            // then append the finished reply and the instruction. The backend
            // sees a pure prefix extension of the conversation it just
            // generated: prompt processing is a near-total cache hit, and no
            // new top-level prompt-cache entry is allocated. Previously this
            // helper sent a standalone 2-message prompt, which allocated its
            // own cache entry and evicted the live conversation's context
            // checkpoints (~600 MiB each), forcing the next user turn to
            // re-prefill the whole conversation (~2 s extra TTFT). The full
            // reply (not the 500-char digest) rides along in continuation
            // mode — its tokens are already in the cache.
            const ctx = _lastChatContext;
            const continuation = !!(ctx && Array.isArray(ctx.messages) && ctx.messages.length);
            const body = {
                model: getModelId(),
                messages: continuation
                    ? [
                        ...ctx.messages,
                        { role: 'assistant', content: replyText },
                        { role: 'user', content: FOLLOWUP_SYS }
                    ]
                    : [
                        { role: 'system', content: FOLLOWUP_SYS },
                        { role: 'user', content: `Q: ${userQuestion}\nA: ${truncatedReply}` }
                    ],
                temperature: 0.8,
                // Never send the TIERED reasoning_effort values here: on
                // Qwen, low/medium/high all map to "on" and override
                // enable_thinking:false. "none" is different — it's the
                // explicit OFF switch LM Studio honours on
                // /v1/chat/completions since 0.4.19 Build 2 (and the only
                // request-level switch it honours at all; it never
                // forwards chat_template_kwargs). Older builds ignore the
                // field, so sending it is a safe no-op there. A backend that
                // refuses "none" outright gets its learned replacement.
                reasoning_effort: applyEffortFallback('none', getModelId()),
                // Some backends still think anyway (older LM Studio, non-
                // LM-Studio servers, template-locked fine-tunes) — the
                // budget must survive that, or the cap fires mid-thought
                // and content comes back empty (no follow-ups, no error).
                // 512 proved too small: a thinking Qwen3.6 burns 500+
                // reasoning tokens re-verifying the "under 60 characters"
                // constraint char by char and hits finish_reason:"length"
                // before emitting content, leaving only the reasoning-
                // salvage fallback. 1024 lets the thought finish and
                // still fits the 25s abort at a 27B model's ~50 tok/s.
                max_tokens: 1024,
                chat_template_kwargs: noThinkTemplateKwargs(),
                stream: false
            };
            if (continuation && ctx.tools) {
                // Same templated prefix as the main turn — but never let this
                // helper actually call a tool; it only wants two lines of text.
                body.tools = ctx.tools;
                body.tool_choice = 'none';
            }

            const res = await fetch(`${getApiBase()}/v1/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...getExtraHeaders() },
                body: JSON.stringify(body),
                signal: ctrl.signal
            });
            if (!res.ok) {
                console.warn('[FollowUps] LLM returned', res.status);
                return [];
            }
            const data = await res.json();
            const msg = data.choices?.[0]?.message || {};
            // Backends that force thinking may put everything into
            // reasoning_content and leave content empty — fall back to it,
            // but remember the source: reasoning is a scratchpad ("Here's a
            // thinking process:", "*Analyze User Input:**", …), so only
            // actual questions may be salvaged from it, and the drafted
            // questions sit at the END of the thought, not the start.
            const content = (msg.content || '').trim();
            const fromReasoning = !content;
            const text = content || msg.reasoning_content || msg.reasoning || '';
            // Strip think blocks (closed AND unterminated) that some models emit
            const cleaned = text
                .replace(/<think>[\s\S]*?<\/think>/gi, '')
                .replace(/<think>[\s\S]*$/gi, '')
                .trim();
            // Repair letter-spaced lines ("-d-e-r- -f-ü-n-f-t-e- …?"): when the
            // exchange discusses metre/scansion the model sometimes imitates the
            // hyphenated style and joins every letter with "-". If most letters
            // on a line are hyphen-joined single characters, dropping the
            // hyphens restores the words; real hyphenated compounds ("E-Mail")
            // stay far below the ratio threshold.
            const deHyphen = (l) => {
                const joined = (l.match(/[\p{L}\p{N}]-(?=[\p{L}\p{N}])/gu) || []).length;
                const letters = (l.match(/[\p{L}\p{N}]/gu) || []).length;
                return letters > 0 && joined / letters > 0.3 ? l.replace(/-+/g, '') : l;
            };
            const repaired = cleaned.split('\n').map(deHyphen).join('\n');
            // Models sometimes put both questions on one line ("1. …? 2. …?")
            // — split after each "?" so they become separate chips instead of
            // one glued-together chip (or none, when the line exceeds 80 chars).
            const splitMulti = (l) => {
                const t = l.trim();
                const first = t.indexOf('?');
                return (first !== -1 && first < t.length - 1) ? (t.match(/[^?]+\?/g) || [t]) : [t];
            };
            const tidy = (l) => l
                .trim()
                .replace(/^\d+[\.\)]\s*/, '')
                .replace(/^[-•*]\s*/, '')
                .replace(/\*+|`+|__+/g, '')
                .replace(/^[""]|[""]$/g, '')
                .trim();
            // A usable chip must actually BE a question — anything without a
            // trailing "?" is prose/reasoning debris, never a suggestion.
            const isQuestion = (l) => l.length > 5 && l.length < 80 && l.endsWith('?') && !l.startsWith('<');
            // Reject instruction echoes: models — especially when the parse
            // falls back to a reasoning scratchpad — restate the task
            // constraints as questions ("Match language?", "Under 60 chars
            // each?"). A candidate whose words mostly appear in the system
            // prompt is an echo of it, never a real suggestion.
            const sysWords = new Set(FOLLOWUP_SYS.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []);
            const isEcho = (q) => {
                const words = q.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [];
                if (words.length === 0) return true;
                const hits = words.filter(w => sysWords.has(w)).length;
                return hits / words.length >= 0.6;
            };
            const usable = (l) => isQuestion(l) && !isEcho(l);
            let questions = repaired.split('\n').flatMap(splitMulti).map(tidy).filter(usable);
            // Lenient fallback: some models return both questions on one line,
            // or wrap them in prose. Salvage "…?"-terminated sentences.
            if (questions.length === 0 && repaired.includes('?')) {
                questions = (repaired.match(/[^?\n]{5,79}\?/g) || []).map(tidy).filter(usable);
            }
            if (questions.length === 0) {
                console.warn('[FollowUps] No valid questions parsed from:', repaired.substring(0, 200));
            }
            return fromReasoning ? questions.slice(-2) : questions.slice(0, 2);
        } catch (err) {
            // AbortError is expected when the next turn cancels us — stay quiet.
            if (err?.name !== 'AbortError') console.warn('[FollowUps] Failed:', err.message);
            return [];
        } finally {
            clearTimeout(timer);
            if (_followUpCtrl === ctrl) _followUpCtrl = null;
        }
    }

    // Run migration on load
    return {
        checkConnection,
        fetchModels,
        listLoadedModels,
        unloadAllLoadedModels,
        restoreLoadedModels,
        hasEvictedModels,
        preloadModel,
        startKeepAlive,
        stopKeepAlive,
        noteUserActivity,
        sendMessage,
        sendStream,
        stopGeneration,
        oneShot,
        generateFollowUps,
        cancelFollowUps,
        clearHistory,
        setHistory,
        getSavedChats,
        saveCurrentChat,
        updateChat,
        loadChat,
        getLastChatId,
        appendMessage,
        getSessionId,
        restoreSession,
        deleteChat,
        saveSettings,
        setConversationalOverride,
        getApiBase,
        getLmStudioUrl,
        setToolApprovalHandler,
        resetApprovalSession,
        compressContext,
        getContextUsage,
        setRepoContext(ctx) { _repoContext = ctx || ''; },
        EFFORT_LABELS,
        EFFORT_CYCLE,
        STYLE_LABELS,
        STYLE_CYCLE,
        get settings() { return { ...settings }; },
        get isProcessing() { return isProcessing; },
        get history() { return [...conversationHistory]; },
        // Snapshot handed to the server when the app closes mid-run so the task
        // can finish in the background. Returns null when there's nothing worth
        // continuing or the feature is off. lmTarget mirrors the header
        // getExtraHeaders() sends, so the server reaches the SAME backend.
        buildBackgroundHandoff() {
            if (settings.continueInBackground === false) return null;
            if (!isProcessing || !conversationHistory.length) return null;
            // Keep the payload under the ~64 KB sendBeacon/keepalive ceiling by
            // taking the most recent messages that fit.
            const MAX_BYTES = 56 * 1024;
            const recent = conversationHistory.slice(-40);
            const kept = [];
            let bytes = 0;
            for (let i = recent.length - 1; i >= 0; i--) {
                const sz = JSON.stringify(recent[i]).length + 1;
                if (bytes + sz > MAX_BYTES && kept.length) break;
                kept.unshift(recent[i]);
                bytes += sz;
            }
            return {
                messages: kept,
                model: getModelId(),
                lmTarget: getLmStudioUrl(),
            };
        },
        // Evidence trail of the most recent turn — real tool outcomes
        // { name, ok, error } consumed by the UI's evidence meter.
        getTurnToolEvents() { return [..._turnToolEvents]; },
        get lastStats() { return _lastStats; },
        get lastPromptBreakdown() { return _lastPromptBreakdown; },
        // Internals exposed for tests only (tests/tools/tiered_loading.test.js)
        // — the tiered-loading contract: core set → tool_search → activation →
        // schemas in the next request. Not for app code.
        // Internals exposed for tests only (tests/tools/stream_scanner.test.js)
        // — the split-safe think/tool tag routing both stream handlers share.
        _stream: {
            createStreamTagScanner,
            extractImplicitThink,
        },
        _tiering: {
            CORE_TOOL_NAMES,
            beginTurnActiveTools,
            getActiveTools,
            handleToolSearchLocal,
            noteToolsUsed,
            activateTools,
            buildRequestBody,
            clampMaxTokens,
            topLevelReasoningEffort,
            pickEffortFallback,
            retryWithFallbackEffort,
            preservesThinking,
            noThinkTemplateKwargs,
            pushAssistantRound,
            persistableAgentMessages,
            PRESERVED_THINKING_ROUNDS,
            PRESERVED_THINKING_CHARS,
        },
        // Internals exposed for tests only (tests/tools/effort_tiers.test.js)
        // — the per-effort agent budgets and the per-turn repeat-call guard.
        _agentLoop: {
            EFFORT_PROFILES,
            toolRoundCap,
            executeToolCallsGuarded,
        },
        // Internals exposed for tests only (tests/tools/context_usage.test.js)
        // — the calibrated context reading the meter and auto-compression share,
        // plus the usage sink that calibrates it.
        _context: {
            buildStats,
            currentContextTokens,
            contextReading,
            estimateHistoryTokens,
        },
        // Internals exposed for tests only (tests/tools/style_sampling.test.js)
        // — the style→sampling table and the resolved params it produces.
        _sampling: {
            SAMPLING_FIELDS,
            SAMPLING_BOUNDS,
            CHAT_PROFILE,
            applyStyleSampling,
            getInferenceParams,
            getStyle,
            personaField,
        },
        // Internals exposed for tests only (tests/tools/style_sampling.test.js)
        // — the persona table and the prompt block it produces.
        _prompts: {
            PERSONAS,
            isPersona,
            buildStyleInstructions,
        },
        get sessionTokens() {
            const total = _sessionPromptTokens + _sessionCompletionTokens;
            return {
                prompt: _sessionPromptTokens,
                completion: _sessionCompletionTokens,
                total,
                contextLength: _contextLength,
                remaining: _contextLength > 0 ? Math.max(0, _contextLength - _sessionPromptTokens) : null,
            };
        },
    };
})();
