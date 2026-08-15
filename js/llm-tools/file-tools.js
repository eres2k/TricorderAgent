/* Native tools — Files: read/write/edit, directory listing, search,
   glob/grep, document extraction, and ZIP archives.
   Executed server-side via /api/tools/execute (see server.js). */

TricorderNativeTools.register([
    {
        type: 'function',
        function: {
            name: 'read_document',
            description: 'Extract the text content from a document file on disk. Supports PDF, Word (DOCX), Excel (XLSX) and PowerPoint (PPTX). For plain-text files (.txt, .md, .csv, code) use read_file instead.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Absolute path to the document file' }
                },
                required: ['path']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'list_archive',
            description: 'List the contents of a ZIP archive file. Returns file names and sizes without extracting.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Absolute path to the ZIP file' }
                },
                required: ['path']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'extract_archive_file',
            description: 'Extract and read a specific text file from inside a ZIP archive.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Absolute path to the ZIP file' },
                    entry: { type: 'string', description: 'Path of the file inside the archive to extract' }
                },
                required: ['path', 'entry']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'read_file',
            description: 'Read a file from disk. Plain text (code, .txt, .md, .csv, .json, …) returned as-is (max 100KB); PDF/DOCX/XLSX/PPTX are auto-extracted to text.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Absolute path to the file to read' }
                },
                required: ['path']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'write_file',
            description: 'Write text content to a file on disk. Creates parent directories if needed. Overwrites existing content unless append=true. Prefer writing to ~/tricorder-workspace/ (code/, data/, downloads/, scratch/). LARGE files (over ~100 lines / ~12000 chars): deliver as SEVERAL sequential calls — first call writes the opening chunk (append omitted), each following call continues EXACTLY where the previous chunk ended with append=true. Oversized single calls are still written but are slow and fragile; truly huge ones (>~400KB) are rejected.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Absolute path to the file to write (prefer ~/tricorder-workspace/)' },
                    content: { type: 'string', description: 'The text content to write' },
                    append: { type: 'boolean', description: 'If true, append content to the end of the file instead of overwriting. Use for every chunk after the first when writing a large file in pieces.' }
                },
                required: ['path', 'content']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'file_edit',
            description: 'Replace a unique substring in a text file. Reads the file, replaces `old_string` with `new_string` exactly once (or everywhere if replace_all=true), and writes back. Fails if old_string is not found, or is not unique when replace_all is false. Use for precise code/config edits without rewriting the whole file.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Absolute path to the file to edit' },
                    old_string: { type: 'string', description: 'The exact text to find (must match verbatim, including whitespace)' },
                    new_string: { type: 'string', description: 'The text to replace it with' },
                    replace_all: { type: 'boolean', description: 'If true, replace every occurrence. If false (default), require exactly one occurrence.' }
                },
                required: ['path', 'old_string', 'new_string']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'list_directory',
            description: 'List a directory: names, types, sizes, modification dates. For folders on disk (ZIPs → list_archive).',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Absolute path to the directory to list (defaults to home directory)' }
                },
                required: []
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'search_files',
            description: 'Search for files by name in a directory tree. Returns matching file paths, types, and sizes. Max 8 levels deep.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Filename pattern to search for (case-insensitive substring match)' },
                    path: { type: 'string', description: 'Root directory to search in (defaults to home directory)' }
                },
                required: ['query']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'glob',
            description: 'Find files by glob pattern (e.g. "**/*.js", "src/**/*.ts", "*.md"). Returns matching absolute file paths sorted by modification time (newest first). Use to locate files by name/extension across a directory tree.',
            parameters: {
                type: 'object',
                properties: {
                    pattern: { type: 'string', description: 'Glob pattern. Supports *, **, ?, and character classes.' },
                    path: { type: 'string', description: 'Root directory to search in (defaults to home directory)' }
                },
                required: ['pattern']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'grep',
            description: 'Search file contents for a regex pattern. Returns matching lines with file path and line numbers. Skips binary files, node_modules, and .git. Use to find code, strings, or definitions across a project.',
            parameters: {
                type: 'object',
                properties: {
                    pattern: { type: 'string', description: 'Regular expression to search for' },
                    path: { type: 'string', description: 'Root directory to search in (defaults to home directory)' },
                    glob: { type: 'string', description: 'Optional glob to filter files (e.g. "*.js", "**/*.{ts,tsx}")' },
                    case_insensitive: { type: 'boolean', description: 'Case-insensitive match (default false)' },
                    max_results: { type: 'number', description: 'Maximum matches to return (default 100, max 500)' }
                },
                required: ['pattern']
            }
        }
    }
]);
