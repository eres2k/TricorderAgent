/* Native tools — Tasks & notifications: scheduled tasks (reminders, smart AI
   tasks, shell automations), notifications, and the agent todo list.
   Executed server-side via /api/tools/execute (see server.js). */

TricorderNativeTools.register([
    {
        type: 'function',
        function: {
            name: 'create_task',
            description: 'Create a task that runs automatically on a schedule. Pick the action:\n' +
                '• "smart" — run an AI instruction each time and deliver the freshly generated result. Best for recurring AI content, e.g. "every weekday at 09:00, summarise what changed in my project repo" → set prompt. The instruction runs with full tool access (files, shell, git, web, memory…) so the output uses real, current data.\n' +
                '• "reminder" — send a fixed message/notification each time → set message.\n' +
                '• "command" — run a shell command → set command.\n' +
                'Schedules: "every 5m", "every 1h", "at 14:30", or a 5-field cron "min hour dom month dow" (e.g. "0 10 * * *" = 10:00 daily, "0 9 * * 1-5" = weekdays 09:00).\n' +
                'A "smart" task can also be a watch: set `until` to the condition it waits for and the task checks on schedule, reports progress, then deletes itself the moment the condition holds — no leftover watchdog in the task list. Do NOT build a watch for a background agent you spawned (agent_spawn announces its own completion in the chat).',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Short task name/title' },
                    action: { type: 'string', enum: ['smart', 'reminder', 'command'], description: 'What the task does when it fires. Defaults to "smart" if a prompt is given, "reminder" if only a message is given, else "command".' },
                    schedule: { type: 'string', description: 'When to run: "every Nm", "every Nh", "at HH:MM", or cron "min hour dom month dow" (e.g. "0 10 * * *" = 10:00 daily, "*/15 * * * *" = every 15 min)' },
                    prompt: { type: 'string', description: 'For action=smart: the instruction to run each time, e.g. "Check the project repo for new commits and summarise what changed".' },
                    message: { type: 'string', description: 'For action=reminder: the exact text to send each time.' },
                    command: { type: 'string', description: 'For action=command: the shell command to run.' },
                    delivery: { type: 'string', enum: ['chat', 'notification', 'both'], description: 'How to deliver reminder/smart output. "chat" posts it straight into the chat window; "notification" raises an in-app notification; "both" (the default) does each, so a result is never lost because no tab was open.' },
                    until: { type: 'string', description: 'For action=smart: makes this a watch task. The condition to wait for, e.g. "the build in ~/project/dist has finished and no .tmp files remain". Each run checks it, reports progress, and once it holds the task reports completion and removes itself.' },
                    onDone: { type: 'string', enum: ['delete', 'disable'], description: 'What happens to a watch task once `until` is met. Default: delete.' }
                },
                required: ['name']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'send_notification',
            description: 'Send a notification to the operator. Can be immediate or scheduled. Supports recurring notifications.',
            parameters: {
                type: 'object',
                properties: {
                    message: { type: 'string', description: 'Notification message text' },
                    triggerIn: { type: 'string', description: 'When to trigger: "now", "5m", "1h", "30s", or ISO date string' },
                    recurring: { type: 'boolean', description: 'If true, notification repeats at the same interval' }
                },
                required: ['message']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'task_list',
            description: 'List all scheduled tasks, reminders, and automations. Returns task id, name, type, status, schedule, and next run time.',
            parameters: { type: 'object', properties: {}, required: [] }
        }
    },
    {
        type: 'function',
        function: {
            name: 'task_get',
            description: 'Get full details of a scheduled task by id.',
            parameters: {
                type: 'object',
                properties: { id: { type: 'string', description: 'Task id' } },
                required: ['id']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'task_update',
            description: 'Update fields of a scheduled task (name, schedule, command, status, or a smart task\'s prompt / a reminder\'s message / the delivery channel).',
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: 'Task id' },
                    name: { type: 'string' },
                    schedule: { type: 'string' },
                    command: { type: 'string' },
                    prompt: { type: 'string', description: 'New instruction for a smart task' },
                    message: { type: 'string', description: 'New message for a reminder task' },
                    delivery: { type: 'string', enum: ['chat', 'notification', 'both'] },
                    until: { type: 'string', description: 'Completion condition for a watch task — the task deletes itself once it holds. Empty string clears it.' },
                    status: { type: 'string', enum: ['pending','paused','done'] }
                },
                required: ['id']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'task_delete',
            description: 'Delete (stop) a scheduled task by id.',
            parameters: {
                type: 'object',
                properties: { id: { type: 'string', description: 'Task id' } },
                required: ['id']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'todo_write',
            description: 'Replace the agent todo list. Use to plan and track multi-step work. Items should have a short content and a status (pending, in_progress, completed). Mark exactly one item as in_progress at a time, update to completed as you finish each step.',
            parameters: {
                type: 'object',
                properties: {
                    items: {
                        type: 'array',
                        description: 'Full replacement list of todo items',
                        items: {
                            type: 'object',
                            properties: {
                                content: { type: 'string' },
                                status: { type: 'string', enum: ['pending','in_progress','completed'] }
                            },
                            required: ['content','status']
                        }
                    }
                },
                required: ['items']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'todo_list',
            description: 'Read the current agent todo list.',
            parameters: { type: 'object', properties: {}, required: [] }
        }
    }
]);
