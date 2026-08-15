/* Native tools — persistent cross-session memory (key-value facts).
   Executed server-side via /api/tools/execute (see server.js). */

TricorderNativeTools.register([
    {
        type: 'function',
        function: {
            name: 'memory_store',
            description: 'Store a fact in persistent cross-session memory. Use proactively for operator preferences, names, project details, decisions.',
            parameters: {
                type: 'object',
                properties: {
                    key: { type: 'string', description: 'Short descriptive key (e.g. "preferred_language")' },
                    value: { type: 'string', description: 'The information to remember' },
                    tags: { type: 'string', description: 'Comma-separated tags (e.g. "preference,language")' }
                },
                required: ['key', 'value']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'memory_recall',
            description: 'Search persistent memory for stored information. Use when answering questions that might involve previously stored context, preferences, or facts.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Search query — matches against keys, values, and tags' }
                },
                required: ['query']
            }
        }
    },
]);
