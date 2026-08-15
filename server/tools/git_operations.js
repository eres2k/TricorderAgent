/* git_operations — local Git control over a sandboxed repository.
   Implementation: spawn the `git` binary directly (never a shell), so user
   input cannot smuggle pipes/redirects. Only a fixed whitelist of git
   sub-commands is reachable. */

'use strict';

const path = require('path');
const fs = require('fs');
const lib = require('./_lib');

const name = 'git_operations';

// push/pull over slow links routinely exceed 30s; give git a 2-minute budget.
const timeoutMs = 120000;

const schema = {
    type: 'function',
    function: {
        name,
        description: 'Run local Git commands inside a repository (no shell, git binary only). '
            + 'Actions: status, diff, add(files?), commit(message), push(remote?), pull(remote?), '
            + 'branch_create(branch), branch_switch(branch), branch_list, log, stash, '
            + 'merge(branch), rebase_abort. The repo path must be inside the '
            + 'allowed workspace/home directories.',
        parameters: {
            type: 'object',
            properties: {
                repo_path: { type: 'string', description: 'Absolute path to the git repository' },
                action: {
                    type: 'string',
                    enum: ['status', 'diff', 'add', 'commit', 'push', 'pull', 'branch_create',
                        'branch_switch', 'branch_list', 'log', 'stash', 'merge', 'rebase_abort'],
                    description: 'Git operation to perform',
                },
                message: { type: 'string', description: 'Commit message (for commit)' },
                branch: { type: 'string', description: 'Branch name (create/switch/merge)' },
                remote: { type: 'string', description: 'Remote name, default "origin" (push/pull)' },
                files: { type: 'string', description: 'Paths to add, space-separated. Default "." (all)' },
            },
            required: ['repo_path', 'action'],
        },
    },
};

const ACTIONS = ['status', 'diff', 'add', 'commit', 'push', 'pull', 'branch_create',
    'branch_switch', 'branch_list', 'log', 'stash', 'merge', 'rebase_abort'];

// A git branch/remote name may not begin with '-' (would be read as a flag)
// nor contain shell-dangerous characters even though we don't use a shell.
function safeRef(value, label) {
    const v = String(value || '').trim();
    if (!v) throw new lib.ToolError(`${label} is required`, 'MISSING_PARAM');
    if (v.startsWith('-') || /[\s~^:?*[\]\\]/.test(v)) {
        throw new lib.ToolError(`Invalid ${label}: "${v}"`, 'BAD_PARAM');
    }
    return v;
}

async function execute(args, ctx) {
    const action = lib.requireAction(args.action, ACTIONS);
    const repo = lib.resolvePath(ctx, args.repo_path, { label: 'repo_path', required: true, mustExist: true });

    if (!fs.existsSync(path.join(repo, '.git'))) {
        throw new lib.ToolError(`${repo} is not a git repository (no .git directory)`, 'NOT_A_REPO', { repo });
    }

    let gitArgs;
    switch (action) {
        case 'status':       gitArgs = ['status', '--porcelain=v1', '-b']; break;
        case 'diff':         gitArgs = ['diff', '--stat']; break;
        case 'add':          gitArgs = ['add', '--', ...String(args.files || '.').split(/\s+/).filter(Boolean)]; break;
        case 'commit':
            if (!args.message) throw new lib.ToolError('message is required for commit', 'MISSING_PARAM');
            gitArgs = ['commit', '-m', String(args.message)];
            break;
        case 'push':         gitArgs = ['push', safeRef(args.remote || 'origin', 'remote'), 'HEAD']; break;
        case 'pull':         gitArgs = ['pull', safeRef(args.remote || 'origin', 'remote')]; break;
        case 'branch_create': gitArgs = ['checkout', '-b', safeRef(args.branch, 'branch')]; break;
        case 'branch_switch': gitArgs = ['checkout', safeRef(args.branch, 'branch')]; break;
        case 'branch_list':  gitArgs = ['branch', '-a', '--no-color']; break;
        case 'log':          gitArgs = ['log', '--oneline', '-n', '20', '--no-color']; break;
        case 'stash':        gitArgs = ['stash']; break;
        case 'merge':        gitArgs = ['merge', '--no-edit', safeRef(args.branch, 'branch')]; break;
        case 'rebase_abort': gitArgs = ['rebase', '--abort']; break;
        default: throw new lib.ToolError(`Unhandled action ${action}`, 'BAD_ACTION');
    }

    const res = await lib.execFileP('git', ['-C', repo, ...gitArgs], { timeout: timeoutMs });
    const out = (res.stdout || '').trim();
    const err = (res.stderr || '').trim();
    if (res.code !== 0) {
        // Throw so the dispatcher logs the call as failed and returns the
        // structured { error, code, details } payload like every other module.
        throw new lib.ToolError(err || `git ${action} failed`, 'GIT_ERROR', {
            exitCode: res.code,
            output: (out || err || '(no output)').slice(0, 10000),
        });
    }
    return {
        ok: true,
        action,
        repo,
        exitCode: res.code,
        output: (out || err || '(no output)').slice(0, 10000),
    };
}

module.exports = { name, schema, execute, timeoutMs };
