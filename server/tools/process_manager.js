/* process_manager — list/kill processes and control services.
   Implementation: PowerShell on Windows, /proc + standard tools on Linux.
   Killing a low-PID (system) process requires confirm=true. */

'use strict';

const lib = require('./_lib');

const name = 'process_manager';

const schema = {
    type: 'function',
    function: {
        name,
        description: 'Manage OS processes and services. Actions: list (filter by name, sort by '
            + 'cpu/ram), kill(pid or name), restart_service(service_name), '
            + 'get_service_status(service_name). Killing a '
            + 'system process (PID < 1000) requires confirm=true.',
        parameters: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['list', 'kill', 'restart_service', 'get_service_status'] },
                pid: { type: 'number', description: 'Target PID (kill)' },
                name: { type: 'string', description: 'Process name filter (list) or target (kill)' },
                service_name: { type: 'string', description: 'Service name (restart_service/get_service_status)' },
                sort: { type: 'string', enum: ['cpu', 'ram', 'name'], description: 'list sort key (default cpu)' },
                limit: { type: 'number', description: 'Max processes to return (default 25)' },
                confirm: { type: 'boolean', description: 'Required to kill a system process (PID < 1000)' },
            },
            required: ['action'],
        },
    },
};

const ACTIONS = ['list', 'kill', 'restart_service', 'get_service_status'];

function safeName(v, label) {
    const s = String(v || '').trim();
    if (!s) throw new lib.ToolError(`${label} is required`, 'MISSING_PARAM');
    // Service/process names: letters, digits, dot, dash, underscore, space.
    if (!/^[\w .\-]+$/.test(s)) throw new lib.ToolError(`Invalid ${label}: "${s}"`, 'BAD_PARAM');
    return s;
}

async function listProcesses(args) {
    const limit = Math.min(Math.max(parseInt(args.limit, 10) || 25, 1), 100);
    const sort = ['cpu', 'ram', 'name'].includes(args.sort) ? args.sort : 'cpu';
    if (lib.IS_WINDOWS) {
        const sortProp = sort === 'ram' ? 'WS' : sort === 'name' ? 'ProcessName' : 'CPU';
        const ps = `Get-Process | Sort-Object ${sortProp} -Descending | Select-Object -First ${limit} `
            + `Id,ProcessName,CPU,@{N='RAM_MB';E={[math]::Round($_.WS/1MB,1)}} | ConvertTo-Json -Compress`;
        const res = await lib.execFileP('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 30000 });
        if (res.code !== 0) throw new lib.ToolError(res.stderr.trim() || 'Get-Process failed', 'PROC_ERROR');
        let rows = JSON.parse(res.stdout.trim() || '[]');
        if (!Array.isArray(rows)) rows = [rows];
        if (args.name) {
            const f = String(args.name).toLowerCase();
            rows = rows.filter((r) => String(r.ProcessName || '').toLowerCase().includes(f));
        }
        return { ok: true, count: rows.length, processes: rows };
    }
    // Linux: ps aux, sorted.
    const sortKey = sort === 'ram' ? '--sort=-rss' : sort === 'name' ? '--sort=comm' : '--sort=-pcpu';
    const res = await lib.execFileP('ps', ['-eo', 'pid,comm,pcpu,rss', sortKey], { timeout: 30000 });
    if (res.code !== 0) throw new lib.ToolError(res.stderr.trim() || 'ps failed', 'PROC_ERROR');
    const lines = res.stdout.trim().split('\n').slice(1);
    let rows = lines.map((l) => {
        const m = l.trim().split(/\s+/);
        return { Id: +m[0], ProcessName: m[1], CPU: +m[2], RAM_MB: Math.round((+m[3]) / 1024 * 10) / 10 };
    });
    if (args.name) {
        const f = String(args.name).toLowerCase();
        rows = rows.filter((r) => String(r.ProcessName || '').toLowerCase().includes(f));
    }
    return { ok: true, count: Math.min(rows.length, limit), processes: rows.slice(0, limit) };
}

async function killProcess(args) {
    let pid = args.pid != null ? parseInt(args.pid, 10) : null;
    if (pid == null && args.name) {
        // Resolve a single matching PID by name first.
        const listed = await listProcesses({ name: safeName(args.name, 'name'), limit: 100 });
        const matches = listed.processes.filter((p) =>
            String(p.ProcessName || '').toLowerCase() === String(args.name).toLowerCase());
        if (matches.length === 0) throw new lib.ToolError(`No process named "${args.name}"`, 'NOT_FOUND');
        if (matches.length > 1) {
            return { ok: false, error: `Ambiguous: ${matches.length} processes named "${args.name}". Pass a pid.`,
                code: 'AMBIGUOUS', details: { pids: matches.map((m) => m.Id) } };
        }
        pid = matches[0].Id;
    }
    if (!Number.isInteger(pid) || pid <= 0) throw new lib.ToolError('A valid pid or name is required', 'MISSING_PARAM');
    if (pid < 1000 && !args.confirm) {
        throw new lib.ToolError(`PID ${pid} looks like a system process. Pass confirm=true to kill it.`, 'CONFIRM_REQUIRED', { pid });
    }
    if (lib.IS_WINDOWS) {
        const res = await lib.execFileP('powershell', ['-NoProfile', '-NonInteractive', '-Command',
            `Stop-Process -Id ${pid} -Force; 'killed'`], { timeout: 30000 });
        if (res.code !== 0) throw new lib.ToolError(res.stderr.trim() || `Failed to kill ${pid}`, 'KILL_FAILED', { pid });
    } else {
        const res = await lib.execFileP('kill', ['-9', String(pid)], { timeout: 10000 });
        if (res.code !== 0) throw new lib.ToolError(res.stderr.trim() || `Failed to kill ${pid}`, 'KILL_FAILED', { pid });
    }
    return { ok: true, action: 'kill', pid };
}

async function serviceAction(args, action) {
    const svc = safeName(args.service_name, 'service_name');
    if (lib.IS_WINDOWS) {
        const cmd = action === 'restart_service'
            ? `Restart-Service -Name '${svc}' -ErrorAction Stop; (Get-Service -Name '${svc}' | Select-Object Name,Status | ConvertTo-Json -Compress)`
            : `Get-Service -Name '${svc}' | Select-Object Name,Status,StartType | ConvertTo-Json -Compress`;
        const res = await lib.execFileP('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], { timeout: 30000 });
        if (res.code !== 0) throw new lib.ToolError(res.stderr.trim() || `Service ${action} failed`, 'SERVICE_ERROR', { service: svc });
        return { ok: true, action, service: svc, status: JSON.parse(res.stdout.trim() || 'null') };
    }
    // Linux: systemctl.
    const sub = action === 'restart_service' ? 'restart' : 'status';
    const res = await lib.execFileP('systemctl', [sub, svc, '--no-pager'], { timeout: 30000 });
    return { ok: res.code === 0, action, service: svc, output: (res.stdout || res.stderr).trim().slice(0, 4000) };
}

async function execute(args, ctx) { // eslint-disable-line no-unused-vars
    const action = lib.requireAction(args.action, ACTIONS);
    switch (action) {
        case 'list': return listProcesses(args);
        case 'kill': return killProcess(args);
        case 'restart_service': return serviceAction(args, 'restart_service');
        case 'get_service_status': return serviceAction(args, 'get_service_status');
        default: throw new lib.ToolError(`Unhandled action ${action}`, 'BAD_ACTION');
    }
}

module.exports = { name, schema, execute };
