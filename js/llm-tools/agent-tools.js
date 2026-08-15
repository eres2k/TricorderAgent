/* Native tools — Agents & planning: background sub-agents, plan mode,
   and operator questions. Executed server-side via /api/tools/execute. */

TricorderNativeTools.register([
    // --- Background Agent Tools ---
    {
        type: 'function',
        function: {
            name: 'agent_spawn',
            description: 'Spawn a background agent to run a shell command asynchronously. Returns an agent_id for tracking. Use for long-running tasks (builds, tests, downloads) so you can continue working on other things. Poll status with agent_status and get results with agent_result. When it finishes, Tricorder posts the outcome into the chat by itself — never create a scheduled task, reminder or watchdog just to tell the operator that a background agent is done.',
            parameters: {
                type: 'object',
                properties: {
                    command: { type: 'string', description: 'Shell command to run in background' },
                    description: { type: 'string', description: 'Short human-readable description of what this agent does' },
                    timeout: { type: 'number', description: 'Max runtime in seconds (default 300, max 600)' },
                    cwd: { type: 'string', description: 'Working directory for the command (optional)' },
                    notify_when_done: { type: 'boolean', description: 'Announce completion (or failure) proactively in the chat, with the last lines of output. Default true. Agents that finish within 30s are not announced — you are still in the same turn and report those yourself.' }
                },
                required: ['command', 'description']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'agent_status',
            description: 'Check the status of a background agent. Returns running/completed/failed/timeout, runtime, output size, and a tail of the latest stdout/stderr (default 2 KB) so you can see live progress without pulling the full result.',
            parameters: {
                type: 'object',
                properties: {
                    agent_id: { type: 'string', description: 'Agent ID returned by agent_spawn' },
                    tail_bytes: { type: 'number', description: 'Bytes of tail output to include (default 2048, max 16384, 0 to omit)' }
                },
                required: ['agent_id']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'agent_result',
            description: 'Get the full output (stdout+stderr) of a completed background agent. Use tail parameter to get only the last N lines.',
            parameters: {
                type: 'object',
                properties: {
                    agent_id: { type: 'string', description: 'Agent ID returned by agent_spawn' },
                    tail: { type: 'number', description: 'Only return last N lines of output (optional)' }
                },
                required: ['agent_id']
            }
        }
    },
    // --- Planning / Agent control ---
    {
        type: 'function',
        function: {
            name: 'plan_mode_enter',
            description: 'Enter plan mode. In plan mode you may only read, analyze, and propose a plan — no file writes, no commands with side effects. Use at the start of a non-trivial task to draft an approach for operator review.',
            parameters: {
                type: 'object',
                properties: { reason: { type: 'string', description: 'Why you are entering plan mode' } },
                required: []
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'plan_mode_exit',
            description: 'Exit plan mode and resume normal execution. Call after the operator approves the plan.',
            parameters: { type: 'object', properties: {}, required: [] }
        }
    },
    {
        type: 'function',
        function: {
            name: 'ask_user',
            description: 'Ask the operator a clarifying question and stop. Use ONLY when you genuinely cannot proceed without operator input (ambiguous request, missing credentials, destructive decision). After calling this, stop producing tool calls — your next message should display the question to the operator and wait for a reply.',
            parameters: {
                type: 'object',
                properties: {
                    question: { type: 'string', description: 'The question to ask the operator' },
                    choices: { type: 'array', items: { type: 'string' }, description: 'Optional list of suggested answers' }
                },
                required: ['question']
            }
        }
    }
]);
