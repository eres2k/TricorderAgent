/* ============================================
   Tool Index — intent-aware discovery for tool_search
   ------------------------------------------------------------------
   The agent only ever sees a small CORE toolset in its prompt (tiered
   loading); everything else is discovered via `tool_search`. The quality
   of that discovery decides whether the model can find — and correctly
   use — the tools it isn't carrying. Naive substring matching misses
   intent words ("lint" never matches code_linter, "preview" never matches
   dev_server), so this module adds a compact category map with synonym
   keywords on top of name/description matching.

   It is the single source of truth shared by:
     • the browser client  (js/llm.js  → handleToolSearchLocal)
     • the server agent loop (server.js → tool_search case)

   Loaded as a classic <script> in the browser (exposes the top-level
   const, like registry.js) and require()-d under Node (module.exports).
   It registers NO tool schemas, so loadNativeToolDefs() skips it.
   ============================================ */

const TricorderToolIndex = (() => {
    // Ordered category map. Each category lists its member tools by exact
    // `names` and/or a `prefix`, plus `keywords`: intent synonyms the model
    // is likely to search for. Keywords are matched as substrings against the
    // query, so a hit on any one surfaces the whole family. Keep keywords to
    // meaningful intent words — avoid generic verbs like "list"/"get".
    const CATEGORIES = [
        { id: 'web', label: 'WEB', names: ['web_search', 'web_fetch', 'scrape_url', 'http_request', 'fact_check'],
          keywords: 'web internet online browse search google duckduckgo url link webpage page fetch scrape crawl http https api rest request fact check verify news' },
        { id: 'files', label: 'FILES', names: ['read_file', 'write_file', 'file_edit', 'list_directory', 'glob', 'grep', 'search_files', 'read_document', 'list_archive', 'extract_archive_file', 'archive_tool'],
          keywords: 'file files folder directory disk path read write edit save create open glob grep find search document pdf docx xlsx pptx text archive zip tar extract unzip' },
        { id: 'system', label: 'SYSTEM', names: ['run_command', 'system_status', 'sleep', 'tool_search'],
          keywords: 'shell terminal command bash sh powershell cmd run execute cpu gpu ram memory disk temperature process processes status health wait sleep delay discover tools' },
        { id: 'code_exec', label: 'CODE EXECUTION', names: ['code_exec'],
          keywords: 'code execute run python node bash javascript script snippet sandbox docker container compute calculate' },
        { id: 'tasks', label: 'TASKS & REMINDERS', names: ['create_task', 'task_list', 'task_get', 'task_update', 'task_delete', 'send_notification'],
          keywords: 'task tasks reminder remind schedule scheduled automation recurring cron every notify notification alarm alert push' },
        { id: 'todos', label: 'TODOS', names: ['todo_write', 'todo_list'],
          keywords: 'todo todos checklist steps progress plan track' },
        { id: 'planning', label: 'PLANNING', names: ['plan_mode_enter', 'plan_mode_exit', 'ask_user'],
          keywords: 'plan planning approach strategy ask question clarify confirm user input prompt' },
        { id: 'agents', label: 'BACKGROUND AGENTS', names: ['agent_spawn', 'agent_status', 'agent_result'],
          keywords: 'agent agents background subagent spawn parallel long running async job worker task delegate' },
        { id: 'memory', label: 'MEMORY', names: ['memory_store', 'memory_recall'],
          keywords: 'memory remember recall fact facts note notes store save persist forget knowledge about me' },
        { id: 'browser', label: 'BROWSER AUTOMATION', prefix: 'browser_',
          keywords: 'browser headless chromium chrome automation navigate click type fill form login screenshot vision dom scrape interactive' },
        { id: 'process', label: 'PROCESS MANAGER', names: ['process_manager'],
          keywords: 'process processes kill pid ps running stop terminate manage service' },
        { id: 'sqlite', label: 'SQLITE DATABASE', names: ['sqlite_manager'],
          keywords: 'sqlite database db sql query table schema insert select store structured data' },
        { id: 'email', label: 'SEND EMAIL', names: ['send_email'],
          keywords: 'email mail send smtp inbox message notify notification report deliver digest summary attach attachment recipient subject gmail reply schedule daily weekly' },
        { id: 'rss', label: 'RSS READER', names: ['rss_reader'],
          keywords: 'rss feed feeds atom news subscribe headlines articles' },
        { id: 'lint', label: 'CODE LINTER', names: ['code_linter'],
          keywords: 'lint linter eslint pylint format prettier black style check code quality security' },
        { id: 'git_local', label: 'LOCAL GIT', names: ['git_operations'],
          keywords: 'git clone commit branch checkout merge diff status pull push stash local repository' },
        { id: 'devserver', label: 'LOCAL DEV SERVER', names: ['dev_server'],
          keywords: 'dev server serve static http localhost live reload livereload watch preview website page html demo app port hosting share remote public domain link open on phone' },
    ];

    // name → category, built once.
    const _exact = new Map();
    const _prefixes = [];
    for (const c of CATEGORIES) {
        for (const n of c.names || []) _exact.set(n, c);
        if (c.prefix) _prefixes.push(c);
    }
    function categoryOf(name) {
        if (_exact.has(name)) return _exact.get(name);
        for (const c of _prefixes) if (name.startsWith(c.prefix)) return c;
        return null;
    }

    // Common English function words that carry no tool intent — dropped so they
    // can't match a keyword or description by accident ("to", "my", "some", …).
    const STOPWORDS = new Set([
        'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'at', 'by',
        'with', 'from', 'into', 'my', 'me', 'it', 'is', 'be', 'do', 'so', 'as',
        'this', 'that', 'these', 'those', 'your', 'our', 'their', 'can', 'you',
        'i', 'we', 'us', 'please', 'some', 'any', 'all', 'get', 'set', 'use',
    ]);
    function normTerms(query) {
        return String(query || '')
            .toLowerCase()
            .split(/[^a-z0-9_]+/)
            .filter(t => t.length >= 2 && !STOPWORDS.has(t));
    }

    // Pre-tokenise each category's keyword space (keywords + label + id) into a
    // word set, so matching is word-level rather than raw substring — otherwise
    // "off" would match inside "office" and pull in the wrong family.
    for (const c of CATEGORIES) {
        c._tokens = new Set(`${c.keywords} ${c.label.toLowerCase()} ${c.id}`.split(/[^a-z0-9]+/).filter(Boolean));
    }
    // Does a query term intend this token set? Exact match, or a length-guarded
    // prefix match so singular/plural and simple stems still connect
    // ("light"↔"lights", "direction"↔"directions") without short-word collisions.
    function termHitsTokens(term, tokens) {
        if (tokens.has(term)) return true;
        if (term.length < 4) return false;
        for (const tok of tokens) {
            if (tok.length < 4) continue;
            if (tok.startsWith(term) || term.startsWith(tok)) return true;
        }
        return false;
    }

    // Which categories does this query intend?
    function matchedCategories(terms) {
        const hit = new Set();
        for (const c of CATEGORIES) {
            if (terms.some(t => termHitsTokens(t, c._tokens))) hit.add(c.id);
        }
        return hit;
    }

    // Rank tools for a query. `tools` is an array of { name, description }.
    // Returns { matches: [{ name, description, category, score }], total }
    // sorted by score desc; `matches` capped to `top` (default 12).
    function search(tools, query, opts) {
        const top = (opts && opts.top) || 12;
        const terms = normTerms(query);
        if (!terms.length) return { matches: [], total: 0 };
        const cats = matchedCategories(terms);
        const scored = [];
        for (const t of tools || []) {
            const name = (t.name || '').toLowerCase();
            const desc = (t.description || '').toLowerCase();
            let score = 0;
            for (const term of terms) {
                if (name.includes(term)) score += 3;
                if (desc.includes(term)) score += 1;
            }
            const cat = categoryOf(t.name);
            if (cat && cats.has(cat.id)) score += 2; // synonym/intent boost
            if (score > 0) scored.push({ name: t.name, description: t.description || '', category: cat ? cat.id : null, score });
        }
        scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
        return { matches: scored.slice(0, top), total: scored.length };
    }

    // Grouped catalogue for the no-query path. `tools` is an array of
    // { name }. Returns [{ id, label, tools: [name...] }] in CATEGORIES order,
    // plus an OTHER bucket for anything uncategorised (so nothing is hidden).
    function catalogue(tools) {
        const present = new Map(); // categoryId → [names]
        const other = [];
        for (const t of tools || []) {
            const cat = categoryOf(t.name);
            if (!cat) { other.push(t.name); continue; }
            if (!present.has(cat.id)) present.set(cat.id, []);
            present.get(cat.id).push(t.name);
        }
        const groups = [];
        for (const c of CATEGORIES) {
            const names = present.get(c.id);
            if (names && names.length) groups.push({ id: c.id, label: c.label, tools: names });
        }
        if (other.length) groups.push({ id: 'other', label: 'OTHER', tools: other });
        return groups;
    }

    return { CATEGORIES, categoryOf, search, catalogue };
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = TricorderToolIndex;
}
if (typeof window !== 'undefined') {
    window.TricorderToolIndex = TricorderToolIndex;
}
