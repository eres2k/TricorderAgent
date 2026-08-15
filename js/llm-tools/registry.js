/* ============================================
   Native Tool Registry
   Each category file under js/llm-tools/ registers its OpenAI
   function-calling schemas here. js/llm.js consumes the combined
   list as NATIVE_TOOLS. Load order: registry.js first, then the
   category files, then llm.js (see the <script> tags in index.html).
   ============================================ */

const TricorderNativeTools = (() => {
    const _defs = [];
    const _names = new Set();

    // Register an array of OpenAI-format tool definitions
    // ({ type: 'function', function: { name, description, parameters } }).
    // Duplicate names are ignored so a stray double-include can't break
    // backends that require unique tool names.
    function register(defs) {
        for (const def of defs || []) {
            const name = def?.function?.name;
            if (!name || _names.has(name)) continue;
            _names.add(name);
            _defs.push(def);
        }
    }

    return {
        register,
        list() { return _defs.slice(); },
        has(name) { return _names.has(name); },
    };
})();
