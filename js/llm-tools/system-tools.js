/* Native tools — System: shell commands, system status, tool discovery,
   and sleep. Executed server-side via /api/tools/execute (see server.js). */

TricorderNativeTools.register([
    {
        type: 'function',
        function: {
            name: 'run_command',
            description: 'Execute a shell command; output streams live, returns stdout+stderr+exit code. Allowed: git, python(3), node, npm, pip, docker, nvidia-smi + common file/system/network commands. Interpreters (bash/sh/zsh/powershell/pwsh/cmd/python/python3/node) may carry arbitrary one-liners (`python3 -c "..."`, `cmd /c ...`); deleting files works ONLY that way (bare rm/del is rejected). Run Python with -u. Jobs >5 min → agent_spawn.',
            parameters: {
                type: 'object',
                properties: {
                    command: { type: 'string', description: 'The shell command to execute' },
                    timeout: { type: 'number', description: 'ms, default 15000, max 300000 — raise for installs/builds' },
                    cwd: { type: 'string', description: 'Working directory (default ~/tricorder-workspace)' }
                },
                required: ['command']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'system_status',
            description: 'Get current system status: CPU usage, RAM, disk space, GPU utilization, VRAM, temperature, top processes. Use to check system health or resource availability.',
            parameters: {
                type: 'object',
                properties: {},
                required: []
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'tool_search',
            description: 'Discover and load tools missing from your current function list. Search by intent — synonyms work ("edit file"→file tools, "lint"→code_linter, "preview a page"→dev_server, "remember"→memory). Matches become directly callable. No query = full grouped catalogue.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Intent or keyword (e.g. "send email", "pdf"). Omit to list everything by category.' }
                },
                required: []
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'sleep',
            description: 'Pause for N milliseconds. Use sparingly — e.g. polling, rate limiting, waiting for a background task.',
            parameters: {
                type: 'object',
                properties: { ms: { type: 'number', description: 'Milliseconds to sleep (max 30000)' } },
                required: ['ms']
            }
        }
    }
]);
