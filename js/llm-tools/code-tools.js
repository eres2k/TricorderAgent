/* Native tools — Code execution: run a snippet in an ephemeral, sandboxed
   Docker container (no network, memory/CPU capped, auto-removed). Requires
   Docker on the host. Executed server-side via /api/tools/execute. */

TricorderNativeTools.register([
    {
        type: 'function',
        function: {
            name: 'code_exec',
            description: 'Execute a code snippet in an isolated, throwaway Docker container and return its stdout/stderr. The container has NO network access, a memory/CPU cap, and is removed after the run — safe for untrusted or experimental code. Supports python, node (javascript), and bash. Use for calculations, data wrangling, quick scripts, or verifying logic. State does NOT persist between calls; write self-contained snippets. For long-lived files use the workspace file tools instead.',
            parameters: {
                type: 'object',
                properties: {
                    language: { type: 'string', enum: ['python', 'node', 'javascript', 'bash'], description: 'Runtime for the snippet' },
                    code: { type: 'string', description: 'Source code to execute' },
                    stdin: { type: 'string', description: 'Optional standard input piped to the program' },
                    timeout: { type: 'number', description: 'Max runtime in seconds (default 20, max 60)' },
                    network: { type: 'boolean', description: 'Allow network access inside the container (default false — kept off for safety)' }
                },
                required: ['language', 'code']
            }
        }
    }
]);
