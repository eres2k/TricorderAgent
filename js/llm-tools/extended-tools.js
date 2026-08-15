/* Native tools — Extended toolbelt.

   GENERATED FILE — do not edit by hand.
   Run `npm run build:tools` after changing any schema in server/tools/.

   These mirror the authoritative schemas in server/tools/<name>.js VERBATIM.
   The browser sends them to the model as `tools`; the server executes them
   through the tool dispatcher's default case → the server/tools registry.
   tests/tools/consistency.test.js asserts the two stay in lockstep.

   This file is also require()-able under Node (it module.exports the array). */

(function () {
    'use strict';

    const EXTENDED_TOOL_SCHEMAS = [
        {
            "type": "function",
            "function": {
                "name": "git_operations",
                "description": "Run local Git commands inside a repository (no shell, git binary only). Actions: status, diff, add(files?), commit(message), push(remote?), pull(remote?), branch_create(branch), branch_switch(branch), branch_list, log, stash, merge(branch), rebase_abort. The repo path must be inside the allowed workspace/home directories.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "repo_path": {
                            "type": "string",
                            "description": "Absolute path to the git repository"
                        },
                        "action": {
                            "type": "string",
                            "enum": [
                                "status",
                                "diff",
                                "add",
                                "commit",
                                "push",
                                "pull",
                                "branch_create",
                                "branch_switch",
                                "branch_list",
                                "log",
                                "stash",
                                "merge",
                                "rebase_abort"
                            ],
                            "description": "Git operation to perform"
                        },
                        "message": {
                            "type": "string",
                            "description": "Commit message (for commit)"
                        },
                        "branch": {
                            "type": "string",
                            "description": "Branch name (create/switch/merge)"
                        },
                        "remote": {
                            "type": "string",
                            "description": "Remote name, default \"origin\" (push/pull)"
                        },
                        "files": {
                            "type": "string",
                            "description": "Paths to add, space-separated. Default \".\" (all)"
                        }
                    },
                    "required": [
                        "repo_path",
                        "action"
                    ]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "process_manager",
                "description": "Manage OS processes and services. Actions: list (filter by name, sort by cpu/ram), kill(pid or name), restart_service(service_name), get_service_status(service_name). Killing a system process (PID < 1000) requires confirm=true.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": {
                            "type": "string",
                            "enum": [
                                "list",
                                "kill",
                                "restart_service",
                                "get_service_status"
                            ]
                        },
                        "pid": {
                            "type": "number",
                            "description": "Target PID (kill)"
                        },
                        "name": {
                            "type": "string",
                            "description": "Process name filter (list) or target (kill)"
                        },
                        "service_name": {
                            "type": "string",
                            "description": "Service name (restart_service/get_service_status)"
                        },
                        "sort": {
                            "type": "string",
                            "enum": [
                                "cpu",
                                "ram",
                                "name"
                            ],
                            "description": "list sort key (default cpu)"
                        },
                        "limit": {
                            "type": "number",
                            "description": "Max processes to return (default 25)"
                        },
                        "confirm": {
                            "type": "boolean",
                            "description": "Required to kill a system process (PID < 1000)"
                        }
                    },
                    "required": [
                        "action"
                    ]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "sqlite_manager",
                "description": "Operate on a local SQLite database. Actions: create_db, execute_query(query, params — use ? placeholders), insert(table,data), update(table,data,where?), delete(table,where?), create_table(table,data), export_csv(table), import_csv(table,csv_path), backup(target_path?). db_path must be inside the allowed directories.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "db_path": {
                            "type": "string",
                            "description": "Path to the .db file"
                        },
                        "action": {
                            "type": "string",
                            "enum": [
                                "create_db",
                                "execute_query",
                                "insert",
                                "update",
                                "delete",
                                "create_table",
                                "export_csv",
                                "import_csv",
                                "backup"
                            ]
                        },
                        "query": {
                            "type": "string",
                            "description": "SQL with ? placeholders (execute_query)"
                        },
                        "params": {
                            "type": "array",
                            "description": "Values bound to the ? placeholders"
                        },
                        "table": {
                            "type": "string",
                            "description": "Table name (insert/update/delete/create_table/export_csv/import_csv)"
                        },
                        "data": {
                            "type": "object",
                            "description": "Column->value map (insert/update) or column->type map (create_table)"
                        },
                        "where": {
                            "type": "object",
                            "description": "Column->value equality filter (update/delete)"
                        },
                        "csv_path": {
                            "type": "string",
                            "description": "CSV file path (export_csv/import_csv)"
                        },
                        "target_path": {
                            "type": "string",
                            "description": "Destination .db path (backup; auto-named if omitted)"
                        }
                    },
                    "required": [
                        "db_path",
                        "action"
                    ]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "code_linter",
                "description": "Check and format source files. Actions: lint, format, check_security (basic pattern scan), get_suggestions. Language auto-detected from extension (js/ts -> eslint, py -> black/pyflakes). file_path must be inside allowed dirs.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": {
                            "type": "string",
                            "enum": [
                                "lint",
                                "format",
                                "check_security",
                                "get_suggestions"
                            ]
                        },
                        "file_path": {
                            "type": "string",
                            "description": "File to analyse"
                        },
                        "language": {
                            "type": "string",
                            "enum": [
                                "javascript",
                                "typescript",
                                "python"
                            ],
                            "description": "Override auto-detection"
                        }
                    },
                    "required": [
                        "action",
                        "file_path"
                    ]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "archive_tool",
                "description": "Work with archives (zip, tar, tar.gz/tgz). Actions: create_zip(input_paths or input_dir, output_path — format follows the output extension: .zip or .tar.gz), extract(input_path, output_dir?), list(input_path). All paths must be inside the allowed directories.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": {
                            "type": "string",
                            "enum": [
                                "create_zip",
                                "extract",
                                "list"
                            ]
                        },
                        "input_path": {
                            "type": "string",
                            "description": "Archive to extract/list"
                        },
                        "input_paths": {
                            "type": "array",
                            "items": {
                                "type": "string"
                            },
                            "description": "Files to archive (create_zip)"
                        },
                        "input_dir": {
                            "type": "string",
                            "description": "Directory to archive recursively (create_zip)"
                        },
                        "output_path": {
                            "type": "string",
                            "description": "Destination archive (.zip, .tar.gz, .tgz, .tar) (create_zip)"
                        },
                        "output_dir": {
                            "type": "string",
                            "description": "Extraction destination (default: alongside the archive)"
                        }
                    },
                    "required": [
                        "action"
                    ]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "dev_server",
                "description": "Persistent local static-file dev server with live reload. Actions: start(root?, port?) serves a directory at http://127.0.0.1:<port>/ and auto-reloads open browser tabs whenever a file under the root changes — start it once, then iterate with file_edit/write_file and view via browser_navigate + browser_vision; stop(port?) stops one server (or all when no port is given); status lists running servers. The server persists across turns until stopped. Every running server is also reachable through Tricorder itself at the returned preview_path (/preview/<port>/), behind the site login — give the operator public_url (or preview_path) so they can open the page from another device; the 127.0.0.1 URL only works on the host.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": {
                            "type": "string",
                            "enum": [
                                "start",
                                "stop",
                                "status"
                            ]
                        },
                        "root": {
                            "type": "string",
                            "description": "Directory to serve (default <workspace>/code)"
                        },
                        "port": {
                            "type": "number",
                            "description": "Port to listen on (default: first free port from 8100; 0 picks an ephemeral port)"
                        }
                    },
                    "required": [
                        "action"
                    ]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "rss_reader",
                "description": "Aggregate RSS/Atom feeds. Actions: add_feed(feed_url), remove_feed(feed_url), get_items(feed_url), get_new_since(feed_url — items unseen since last check), summarize_items(feed_url — titles only), search_feeds(keyword — across subscribed feeds), list_feeds. Results are cached for 10 minutes.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": {
                            "type": "string",
                            "enum": [
                                "add_feed",
                                "remove_feed",
                                "get_items",
                                "get_new_since",
                                "summarize_items",
                                "search_feeds",
                                "list_feeds"
                            ]
                        },
                        "feed_url": {
                            "type": "string",
                            "description": "Feed URL (add/remove/get_items/get_new_since/summarize_items)"
                        },
                        "since": {
                            "type": "string",
                            "description": "ISO date for get_new_since (optional; defaults to last check)"
                        },
                        "limit": {
                            "type": "number",
                            "description": "Max items (default 20)"
                        },
                        "keyword": {
                            "type": "string",
                            "description": "Search term (search_feeds)"
                        }
                    },
                    "required": [
                        "action"
                    ]
                }
            }
        }
    ];

    if (typeof TricorderNativeTools !== 'undefined' && TricorderNativeTools.register) {
        TricorderNativeTools.register(EXTENDED_TOOL_SCHEMAS);
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = EXTENDED_TOOL_SCHEMAS;
    }
})();
