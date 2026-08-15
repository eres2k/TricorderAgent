/* ============================================
   Model profiles — what this agent knows about the models it runs on
   ------------------------------------------------------------------
   One place for the facts that are otherwise scattered across the setup
   wizard, the docs and three README files: how big each quant is, how much
   context the weights actually support, which sampling set the vendor
   recommends, what the reasoning_effort vocabulary is, and the exact command
   that starts the thing.

   The agent's REQUEST shaping lives in js/llm.js and stays there — that code
   runs in the browser and adapts per turn. This module is the PROVISIONING
   side: it answers "what should I download, and how do I launch it", which is
   a question asked once, on the host, before any of that matters.

   Zero dependencies, no I/O, no side effects — pure data and arithmetic, so
   scripts/setup.js and the /api/setup routes can both read from it and the
   tests can assert on it without booting anything.
   ============================================ */

'use strict';

const GIB = 1024 ** 3;

// ── Quant ladder ────────────────────────────────────────────────────────────
// Sizes are the real file sizes published on Hugging Face, not estimates, so
// "will this fit" is answered with the number the download actually costs.
// `quality` is an ordering hint for picking the best one that fits, not a
// benchmark score.
const QWEN38_27B_QUANTS = [
    { name: 'UD-Q2_K_XL',  bytes: 10676423744, quality: 1, note: 'Smallest usable. Noticeably weaker at long tool chains.' },
    { name: 'UD-IQ3_XXS',  bytes: 11913559104, quality: 2, note: 'Fits 12 GB cards with a short context.' },
    { name: 'Q3_K_M',      bytes: 13818690528, quality: 3, note: 'Last stop before quality falls off.' },
    { name: 'IQ4_XS',      bytes: 15705861088, quality: 4, note: 'Near-Q4 quality, about 1.4 GB smaller.' },
    { name: 'Q4_K_M',      bytes: 17106775008, quality: 5, note: 'The default. Best quality per gigabyte.' },
    { name: 'UD-Q4_K_XL',  bytes: 17923394624, quality: 6, note: 'Dynamic 4-bit — Q4 size, closer to Q5 behaviour.' },
    { name: 'Q5_K_M',      bytes: 19834055648, quality: 7, note: 'Worth it if you have the headroom.' },
    { name: 'Q6_K',        bytes: 22884408288, quality: 8, note: 'Diminishing returns start here.' },
    { name: 'Q8_0',        bytes: 29047086048, quality: 9, note: 'Effectively lossless against BF16.' },
    { name: 'BF16',        bytes: 53808281952, quality: 10, note: 'Full precision. Datacentre cards only.' },
];

// Companion GGUFs. Both are optional and both are worth having: without the
// mmproj the vision tower is simply absent (the model answers text-only), and
// without the MTP draft you leave the model's own speculative decoder on the
// table — it was trained with multi-token prediction heads.
const QWEN38_27B_COMPANIONS = {
    mmproj: { file: 'mmproj-F16.gguf',            bytes: 927607488,  purpose: 'vision', note: 'Image and video understanding.' },
    mtp:    { file: 'mtp-Qwen3.8-27B-Q8_0.gguf',  bytes: 3164006688, purpose: 'speculative decoding', note: 'The model\'s own MTP draft head.' },
};

const QWEN38_27B = {
    id: 'qwen3.8-27b',
    label: 'Qwen3.8-27B',
    family: 'qwen',
    params: '27B dense (+ vision encoder)',
    released: '2026-08-05',
    // Model ids are free-form — LM Studio, Ollama, and a hand-converted GGUF
    // all name the same weights differently. Match on the version + size,
    // tolerating every separator a publisher has used: `Qwen3.8-27B`,
    // `qwen3.8:27b` (Ollama's tag form), `qwen3.8_27b`, `Qwen 3.8 27B`.
    match: /qwen[-_.: ]?3\.8[-_.: ]?27b/i,
    // Anything from the 3.8 line, including the MoE. Used to say "this is the
    // right generation, just not the size this profile describes".
    familyMatch: /qwen[-_.: ]?3\.8/i,

    contextNative: 262144,
    contextMax: 1000000,          // with YaRN RoPE scaling, vendor-documented
    // Reasoning and the final answer get separate budgets on backends that
    // support the split. Both are vendor recommendations for agentic work.
    outputBudget: { reasoning: 262144, final: 131072 },

    // Two sampling sets, selected per request by whether thinking is on. The
    // browser agent loop already switches between them; they live here too so
    // a llama-server pinned at launch can be pinned to the RIGHT one.
    sampling: {
        thinking: { temperature: 1.0, top_p: 0.95, top_k: 20, min_p: 0.0, presence_penalty: 0.0, repeat_penalty: 1.0 },
        instruct: { temperature: 0.7, top_p: 0.80, top_k: 20, min_p: 0.0, presence_penalty: 1.5, repeat_penalty: 1.0 },
    },

    // The vocabulary the model DECLARES. There is no "high" and no "none":
    // an unrecognised value falls back to the default, which is the deepest
    // level — so anything that means "think less" has to map to 'low', never
    // to an invented name. js/llm.js enforces the same mapping on the wire.
    reasoningEfforts: ['low', 'medium', 'xhigh'],
    defaultReasoningEffort: 'xhigh',

    capabilities: {
        toolCalling: true,
        thinking: true,          // on by default, disable per request
        preserveThinking: true,  // historical reasoning retained across turns
        vision: true,            // native — no separate LLM_VISION_MODEL needed
        video: true,
        mtp: true,               // trained with multi-token prediction heads
    },

    // KV cache cost per token, estimated from the published architecture:
    // 64 layers laid out as 16 × (3 × Gated DeltaNet → 1 × Gated Attention),
    // so only 16 layers hold a growing KV cache. Each has 4 KV heads at head
    // dimension 256 → 1024 dims for K and 1024 for V, at 2 bytes each in f16:
    //   16 layers × (1024 + 1024) × 2 bytes = 65,536 bytes per token.
    // The DeltaNet layers carry a fixed-size recurrent state instead, which is
    // why a 256K window is affordable at all. An estimate, not a measurement —
    // it exists to size `-c` sensibly, and it errs high.
    kvBytesPerToken: 65536,

    quants: QWEN38_27B_QUANTS,
    companions: QWEN38_27B_COMPANIONS,

    repos: {
        weights: 'Qwen/Qwen3.8-27B',
        gguf: 'unsloth/Qwen3.8-27B-GGUF',
        ggufAlt: 'ggml-org/Qwen3.8-27B-GGUF',   // ships the mmproj AND the MTP draft
        lmstudio: 'lmstudio-community/Qwen3.8-27B-GGUF',
        ollama: 'qwen3.8:27b',
        ollamaMlx: 'qwen3.8:27b-mlx',           // Apple Silicon
    },

    why: 'Native tool calling, 256K context, vision, and reasoning depth that '
       + 'is actually steerable per request — the four things this agent leans on hardest.',
};

// Everything else this agent has been run against. Kept deliberately thin:
// enough to recognise the model and say something true about it, not a
// catalogue. `contextNative` here is the architecture's own limit; what the
// backend actually loaded is detected live and always wins.
const OTHER_PROFILES = [
    {
        id: 'qwen3.8-moe', label: 'Qwen3.8-2.4T-A95B', family: 'qwen',
        match: /qwen[-_.: ]?3\.8[-_.: ]?2\.4t/i,
        contextNative: 262144, reasoningEfforts: ['low', 'medium', 'xhigh'],
        capabilities: { toolCalling: true, thinking: true, vision: false, mtp: true },
        note: 'Same generation, datacentre scale. Text only.',
    },
    {
        id: 'qwen3.6-27b', label: 'Qwen3.6-27B', family: 'qwen',
        match: /qwen[-_.: ]?3\.6[-_.: ]?27b/i,
        contextNative: 262144, reasoningEfforts: ['low', 'medium', 'xhigh'],
        capabilities: { toolCalling: true, thinking: true, vision: true, mtp: false },
        note: 'The previous generation. Works well; 3.8 is a clear step up on agentic work.',
    },
    {
        id: 'qwen3', label: 'Qwen3 (original)', family: 'qwen',
        match: /qwen[-_. ]?3[-_. ]?(?!\.)\d*b/i,
        contextNative: 32768, reasoningEfforts: ['low', 'medium', 'high'],
        capabilities: { toolCalling: true, thinking: true, vision: false, mtp: false },
        note: 'What this agent shipped with. Still fine for light work.',
    },
    {
        id: 'muse', label: 'Muse Glimmer', family: 'muse',
        match: /muse|glimmer/i,
        contextNative: 131072, reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
        capabilities: { toolCalling: true, thinking: true, vision: false, mtp: false },
        note: 'Steered through reasoning_strength rather than reasoning_effort.',
    },
    {
        id: 'llama3', label: 'Llama 3.x Instruct', family: 'llama',
        match: /llama[-_. ]?3/i,
        contextNative: 131072, reasoningEfforts: [],
        capabilities: { toolCalling: true, thinking: false, vision: false, mtp: false },
        note: 'Solid tool calling, no thinking mode. Uses the XML tool fallback.',
    },
    {
        id: 'mistral', label: 'Mistral / Mixtral', family: 'mistral',
        match: /mistral|mixtral|magistral/i,
        contextNative: 32768, reasoningEfforts: [],
        capabilities: { toolCalling: true, thinking: false, vision: false, mtp: false },
        note: 'Good general reasoning, more literal about instructions.',
    },
];

const RECOMMENDED = QWEN38_27B;
const ALL_PROFILES = [QWEN38_27B, ...OTHER_PROFILES];

// ── Lookup ──────────────────────────────────────────────────────────────────

// Which profile describes this model id? Null when nothing matches — an
// unknown model is a perfectly valid answer, not an error.
function profileFor(modelId) {
    const id = String(modelId || '');
    if (!id) return null;
    return ALL_PROFILES.find((p) => p.match.test(id)) || null;
}

// Score a loaded model against the recommended one, 0-100. Used to sort the
// dropdown in the setup wizard so the best available choice is preselected
// rather than whatever the backend happened to list first.
//
// The scale, and what each band means to the agent:
//   100  the recommended model
//    80  same generation, different size
//    60  a profile we know, with tool calling and thinking
//    40  a profile we know, tool calling only
//    20  unrecognised — probably works, nothing is promised
//     0  recognisably not a chat model (embeddings, rerankers, TTS)
const NON_CHAT = /(^|[-_/])(embed|embedding|bge|gte|e5|rerank|reranker|whisper|tts|clip|vae|sd[-_]?xl|stable[-_]?diffusion)/i;

function scoreModel(modelId) {
    const id = String(modelId || '');
    if (!id) return { id, score: 0, tier: 'unusable', note: 'no model id' };
    if (NON_CHAT.test(id)) {
        return { id, score: 0, tier: 'unusable', note: 'Not a chat model — this one cannot drive the agent loop.' };
    }
    if (RECOMMENDED.match.test(id)) {
        return { id, score: 100, tier: 'recommended', profile: RECOMMENDED.id, note: `${RECOMMENDED.label} — what this agent targets.` };
    }
    if (RECOMMENDED.familyMatch.test(id)) {
        return { id, score: 80, tier: 'good', profile: 'qwen3.8', note: 'Qwen3.8 generation — the right family, a different size.' };
    }
    const profile = profileFor(id);
    if (profile) {
        const caps = profile.capabilities || {};
        const score = caps.thinking ? 60 : 40;
        return { id, score, tier: score >= 60 ? 'good' : 'workable', profile: profile.id, note: profile.note || profile.label };
    }
    return { id, score: 20, tier: 'unknown', note: 'Unrecognised model. It will work if it supports tool calling.' };
}

// Rank a backend's model list, best first. Ties keep the backend's own order,
// which is usually "most recently loaded".
function rankModels(models) {
    return (models || [])
        .map((m, i) => ({ ...scoreModel(m), order: i }))
        .sort((a, b) => (b.score - a.score) || (a.order - b.order))
        .map(({ order, ...rest }) => rest);
}

// ── Sizing ──────────────────────────────────────────────────────────────────

const gib = (bytes) => bytes / GIB;
const round1 = (n) => Math.round(n * 10) / 10;

// How much memory a given context window costs on top of the weights.
function kvCacheBytes(profile, contextTokens) {
    const perToken = (profile && profile.kvBytesPerToken) || 0;
    return perToken * Math.max(0, contextTokens || 0);
}

// Pick the best quant that fits in `budgetGiB`, leaving room for the KV cache
// at `contextTokens` plus a working-set reserve.
//
// `reserveGiB` is not padding for its own sake: the runtime, the compute
// buffers and (on a unified-memory Mac) the rest of the desktop all live in
// the same pool. Undersizing this is how a model loads and then thrashes.
function planQuant(profile, {
    budgetGiB,
    contextTokens = 32768,
    vision = true,
    mtp = false,
    reserveGiB = 2,
} = {}) {
    const quants = (profile && profile.quants) || [];
    if (!quants.length || !(budgetGiB > 0)) {
        return { fits: false, quant: null, reason: 'no quant ladder for this model' };
    }
    const companions = (profile.companions || {});
    const extras = (vision && companions.mmproj ? gib(companions.mmproj.bytes) : 0)
                 + (mtp && companions.mtp ? gib(companions.mtp.bytes) : 0);
    const kv = gib(kvCacheBytes(profile, contextTokens));
    const overhead = extras + kv + reserveGiB;
    const forWeights = budgetGiB - overhead;

    const fitting = quants.filter((q) => gib(q.bytes) <= forWeights);
    const best = fitting[fitting.length - 1] || null;

    return {
        fits: !!best,
        quant: best,
        quantGiB: best ? round1(gib(best.bytes)) : null,
        totalGiB: best ? round1(gib(best.bytes) + overhead) : null,
        breakdown: {
            weightsBudgetGiB: round1(forWeights),
            kvCacheGiB: round1(kv),
            companionsGiB: round1(extras),
            reserveGiB,
        },
        reason: best ? null
            : `${round1(budgetGiB)} GB is not enough — the smallest quant needs `
              + `${round1(gib(quants[0].bytes) + overhead)} GB at ${contextTokens.toLocaleString('en-US')} context.`,
    };
}

// The inverse: given a quant and a memory budget, how much context fits?
// Rounded down to a power-of-two-ish step because backends prefer round
// numbers and nobody wants `-c 37291`.
const CONTEXT_STEPS = [8192, 16384, 32768, 65536, 131072, 262144];

function planContext(profile, { budgetGiB, quantBytes, vision = true, mtp = false, reserveGiB = 2 } = {}) {
    if (!profile || !(budgetGiB > 0) || !(quantBytes > 0)) return { contextTokens: 0, capped: false };
    const companions = profile.companions || {};
    const extras = (vision && companions.mmproj ? gib(companions.mmproj.bytes) : 0)
                 + (mtp && companions.mtp ? gib(companions.mtp.bytes) : 0);
    const forKv = budgetGiB - gib(quantBytes) - extras - reserveGiB;
    if (!(forKv > 0)) return { contextTokens: 0, capped: false };

    const affordable = (forKv * GIB) / profile.kvBytesPerToken;
    const native = profile.contextNative || CONTEXT_STEPS[CONTEXT_STEPS.length - 1];
    const usable = CONTEXT_STEPS.filter((s) => s <= affordable && s <= native);
    const contextTokens = usable[usable.length - 1] || 0;
    return { contextTokens, capped: contextTokens >= native, affordableTokens: Math.floor(affordable) };
}

// The floor below which this agent stops being an agent. The tool schemas and
// the memory block are a few thousand tokens before the conversation starts,
// and a single file read can be several thousand more.
const MIN_USEFUL_CONTEXT = 16384;

// ── Launch commands ─────────────────────────────────────────────────────────

// The exact command for one runtime, sized to the plan. Returned as an array
// of { title, code, note } so the CLI and the browser wizard render the same
// instructions from the same source.
function launchPlan(backendId, plan = {}) {
    const profile = plan.profile || RECOMMENDED;
    const ctx = plan.contextTokens || 32768;
    const quant = (plan.quant && plan.quant.name) || 'Q4_K_M';
    const port = plan.port || null;

    if (backendId === 'lmstudio') {
        return [{
            title: 'Download and serve',
            code: `lms get ${profile.repos.lmstudio}\nlms server start\nlms load ${profile.id} --context-length ${ctx}`,
            note: 'Or use the Discover tab in the app, then Developer → Start Server. '
                + 'Leave tool use enabled; LM Studio maps reasoning_effort natively.',
        }];
    }

    if (backendId === 'ollama') {
        return [{
            title: 'Pull and serve',
            code: `ollama pull ${profile.repos.ollama}\nOLLAMA_CONTEXT_LENGTH=${ctx} ollama serve`,
            note: 'Ollama exposes the OpenAI-compatible API on port 11434, which is what this app uses. '
                + 'Without OLLAMA_CONTEXT_LENGTH it defaults to a much shorter window than the model supports.',
        }];
    }

    if (backendId === 'llamacpp') {
        const p = port || 8080;
        const steps = [{
            title: 'Serve',
            code: [
                'llama-server \\',
                `  -hf ${profile.repos.ggufAlt}:${quant} \\`,
                `  -c ${ctx} \\`,
                '  --jinja \\',
                `  --port ${p}`,
            ].join('\n'),
            note: '--jinja is not optional. It applies the model\'s chat template, which is what '
                + 'enables tool calling; without it the server accepts the request, ignores the '
                + 'tools parameter, and the agent quietly degrades into a chatbot.',
        }];
        if (plan.vision !== false) {
            steps.push({
                title: 'Add vision',
                code: `  --mmproj-url https://huggingface.co/${profile.repos.ggufAlt}/resolve/main/mmproj-Qwen3.8-27B-Q8_0.gguf`,
                note: 'Append to the command above. Without the mmproj the vision tower is absent '
                    + 'and image turns silently answer from the text alone.',
            });
        }
        if (plan.mtp) {
            steps.push({
                title: 'Add speculative decoding',
                code: [
                    `  -md-url https://huggingface.co/${profile.repos.ggufAlt}/resolve/main/${profile.companions.mtp.file} \\`,
                    '  --draft-max 4 --draft-min 1',
                ].join('\n'),
                note: 'Append to the command above. This is the model\'s own multi-token-prediction '
                    + 'head — roughly 2× decode throughput on accepted drafts, at the cost of '
                    + `${round1(gib(profile.companions.mtp.bytes))} GB.`,
            });
        }
        return steps;
    }

    return [];
}

// ── Env defaults ────────────────────────────────────────────────────────────

// The .env this model wants, given a backend and a plan. Only keys whose right
// answer DEPENDS on the model appear here — everything else keeps its default.
function envDefaults(profile, { backendUrl, modelId } = {}) {
    const env = {};
    if (backendUrl) env.LLM_BASE_URL = backendUrl;
    env.LLM_MODEL = modelId || 'auto';
    // A 27B model thinking at xhigh can run for minutes before the first token
    // of a non-streamed server-side generation arrives. The stock 120s reads as
    // a dead connection on anything without a fast GPU.
    env.LLM_TIMEOUT_MS = '600000';
    // Native vision: routing image turns to a second model would be strictly
    // worse, so the override stays empty on purpose.
    if (profile && profile.capabilities && profile.capabilities.vision) env.LLM_VISION_MODEL = '';
    return env;
}

module.exports = {
    RECOMMENDED,
    ALL_PROFILES,
    QWEN38_27B,
    MIN_USEFUL_CONTEXT,
    CONTEXT_STEPS,
    profileFor,
    scoreModel,
    rankModels,
    kvCacheBytes,
    planQuant,
    planContext,
    launchPlan,
    envDefaults,
    gib,
};
