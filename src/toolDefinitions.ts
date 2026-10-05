// Tool definitions shared across the agent.
// Extracted from agent.ts to avoid circular imports.

import { detectShellEnvironment } from './agentShellEnv';

export const TOOL_DEFINITIONS = [
    {
        type: 'function',
        function: {
            name: 'workspace_summary',
            description: 'Get a full summary of the workspace: file tree, project type, key files (package.json, README), and recently modified files. Call this first to understand the project.',
            parameters: { type: 'object', properties: {}, required: [] },
        },
    },
    {
        type: 'function',
        function: {
            name: 'edit_file',
            description: 'Make a targeted edit to a file by replacing old_string with new_string. WARNING: If you have line numbers from a previous shell_read output, use edit_file_at_line instead -- it never fails on string matching. Use edit_file only when you have NO line numbers. The old_string must match exactly (including whitespace/indentation) -- never construct it from memory. For complete rewrites, set force_overwrite=true and old_string="". On success, returns the edited snippet (±4 lines) so you can verify the result without a follow-up read. new_string must not be empty (use a comment if intentionally removing code). Each edit requires user confirmation. BEFORE CALLING on a new task: confirm you have all required information (auth, URL format, data schema, credentials, pagination). If any assumption is unverifiable, ask the user first.',
            parameters: {
                type: 'object',
                properties: {
                    path:            { type: 'string', description: 'Path relative to workspace root' },
                    old_string:      { type: 'string', description: 'Exact string to replace. Must be unique in the file. Use empty string with force_overwrite=true to replace the entire file.' },
                    new_string:      { type: 'string', description: 'Replacement string.' },
                    force_overwrite: { type: 'boolean', description: 'If true, overwrite the entire file with new_string, ignoring old_string. Use for: (1) corrupted files containing literal \\n characters, or (2) complete rewrites of template/HTML/CSS files where you intend to replace the entire contents.' },
                },
                required: ['path', 'old_string', 'new_string'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'write_file',
            description: 'Write complete file content to disk. Use this instead of edit_file when: (1) creating a new file, (2) the file has broken syntax that prevents old_string matching, (3) doing a full rewrite of a small file (<150 lines). Does not require old_string. Requires user confirmation. For code/scripts: before calling, confirm you have all required information (auth mechanism, URL/endpoint format, data schema, pagination shape, file format). If any are unverifiable, ask the user first -- do not write placeholder code. For documentation, plans, or README files: proceed directly after reading the relevant files -- no pre-confirmation needed. If an existing file might already satisfy the request, ask the user whether to use it or write something new.',
            parameters: {
                type: 'object',
                properties: {
                    path:    { type: 'string',  description: 'Relative path to the file to write' },
                    content: { type: 'string',  description: 'Complete file content to write' },
                    backup:  { type: 'boolean', description: 'If true, copy existing file to <path>.bak before overwriting (default: true for existing files)' },
                },
                required: ['path', 'content'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'edit_file_at_line',
            description: 'PREFERRED edit tool when you have line numbers. After shell_read, you know exact line numbers -- use this instead of edit_file to avoid string-matching failures. Replaces lines start_line through end_line (1-based, inclusive) with new_content. To insert without replacing, set end_line = start_line - 1. No old_string needed -- never fails on whitespace.',
            parameters: {
                type: 'object',
                properties: {
                    path:        { type: 'string',  description: 'Path relative to workspace root' },
                    start_line:  { type: 'number',  description: 'First line to replace (1-based)' },
                    end_line:    { type: 'number',  description: 'Last line to replace (1-based, inclusive). Set to start_line - 1 to insert without replacing.' },
                    new_content: { type: 'string',  description: 'Replacement text. Preserve indentation style of surrounding code.' },
                },
                required: ['path', 'start_line', 'end_line', 'new_content'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'read_file',
            description: 'Read a file from disk. Native -- no shell, works identically on all platforms. Prefer this over shell_read+cat for reading files. Returns content with line numbers. Use offset/limit to read a specific range.',
            parameters: {
                type: 'object',
                properties: {
                    path:   { type: 'string', description: 'Path to the file (absolute or relative to workspace root)' },
                    offset: { type: 'number', description: 'First line to return (1-based). Omit to start from line 1.' },
                    limit:  { type: 'number', description: 'Maximum number of lines to return. Omit to return entire file (up to 2000 lines).' },
                },
                required: ['path'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'search_files',
            description: 'Search file contents using a regex or literal pattern. Native -- no shell, no grep, works identically on all platforms. Returns matching lines with file path and line number. Use glob to restrict to file types.',
            parameters: {
                type: 'object',
                properties: {
                    pattern:   { type: 'string', description: 'Regex or literal string to search for' },
                    directory: { type: 'string', description: 'Directory to search in (default: workspace root)' },
                    glob:      { type: 'string', description: 'File glob filter e.g. "*.py", "*.ts" (default: all text files)' },
                    literal:   { type: 'boolean', description: 'If true, treat pattern as a literal string (no regex). Default: false.' },
                },
                required: ['pattern'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'find_files',
            description: 'Find files matching a glob pattern. Native -- no shell, works identically on all platforms. Prefer this over shell_read+find/ls for locating files.',
            parameters: {
                type: 'object',
                properties: {
                    pattern:   { type: 'string', description: 'Glob pattern e.g. "**/*.py", "src/**/*.ts", "**/test_*.py"' },
                    directory: { type: 'string', description: 'Directory to search in (default: workspace root)' },
                },
                required: ['pattern'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'shell_read',
            description: `Run a read-only shell command that does NOT modify files or state. No confirmation required. PREFER read_file/search_files/find_files for file operations -- use shell_read for: git log, git status, git diff, env, which, node -v, python --version, and other non-file commands. Do NOT use for commands that write, install, build, or delete.${detectShellEnvironment().bashPath ? ' SHELL IS GIT BASH -- use bash commands only (find, grep, cat, ls). NEVER use PowerShell cmdlets (Get-ChildItem, Where-Object, Select-Object, Select-String, Get-Content, ForEach-Object) -- they will fail with "command not found".' : ''} Output is capped at ~24k chars. Result includes [CWD: ...] so you always know the working directory.`,
            parameters: {
                type: 'object',
                properties: {
                    command: { type: 'string', description: 'Read-only shell command to execute' },
                },
                required: ['command'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'gather_context',
            description: `Read 2--8 files IN PARALLEL and return all results in one turn. Use this instead of multiple sequential shell_read calls when you already know upfront which 3+ files you need.${detectShellEnvironment().bashPath ? ' SHELL IS GIT BASH -- each command must use bash syntax (cat, grep, find), never PowerShell cmdlets.' : ''}
QUICKEST USAGE: pass file paths directly as "files": ["path/a.py", "path/b.py", "path/c.py"]
ADVANCED USAGE: pass shell commands as "commands": ["cat a.py", "grep -n def b.py"]
WHEN TO USE:
  - You have 3+ files whose paths are already resolved -> use gather_context (saves N-1 turns)
  - You have 1--2 files -> use shell_read (simpler)
  - The next file path depends on what you find in the current one -> use shell_read (sequential)
  - You need a write/modify command -> use run_command
Max 8 files/commands per call. Total output is capped at 24 000 chars.`,
            parameters: {
                type: 'object',
                properties: {
                    files: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Array of 2--8 file paths to read in parallel. Automatically runs "cat <path>" for each. Use this when you have file paths and want their contents -- simpler than writing cat commands manually.',
                        minItems: 2,
                        maxItems: 8,
                    },
                    commands: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Array of 2--8 read-only shell commands to run in parallel (same rules as shell_read -- no writes, no installs, no deletes). Use when you need grep, find, head, or other commands rather than plain file reads.',
                        minItems: 2,
                        maxItems: 8,
                    },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'system_map_update',
            description: 'Add or update a node or relationship in the cross-workspace system map (~/.ollamaforge/system-map.json). Use this when you learn something about the broader system -- a service, machine, workspace, or how they relate. This is long-term memory that persists across all workspaces and sessions.',
            parameters: {
                type: 'object',
                properties: {
                    action: {
                        type: 'string',
                        enum: ['add_node', 'add_edge'],
                        description: 'add_node -- register a workspace/service/machine/database. add_edge -- record a relationship between two nodes.',
                    },
                    // Node fields
                    id:          { type: 'string', description: 'Unique stable identifier, e.g. "ollamaforge", "my-server", "api-gateway". Use lowercase-kebab-case. Also accepted as "node_id".' },
                    node_id:     { type: 'string', description: 'Alias for "id". Either field is accepted.' },
                    type:        { type: 'string', enum: ['workspace', 'service', 'machine', 'database', 'other'], description: 'Node type.' },
                    label:       { type: 'string', description: 'Human-readable name, e.g. "Ollama Forge Extension".' },
                    description: { type: 'string', description: 'One-line summary of what this node is or does.' },
                    metadata:    { type: 'object', description: 'Key facts: host, port, path, tech, url, etc. Also accepted as "properties".', additionalProperties: { type: 'string' } },
                    properties:  { type: 'object', description: 'Alias for "metadata". Either field is accepted.', additionalProperties: { type: 'string' } },
                    // Edge fields
                    from:         { type: 'string', description: 'Source node id (for add_edge).' },
                    to:           { type: 'string', description: 'Target node id (for add_edge).' },
                    edge_type:    { type: 'string', enum: ['calls', 'deploys_to', 'reads_from', 'writes_to', 'ssh_into', 'hosts', 'depends_on', 'related'], description: 'Relationship type (for add_edge).' },
                    edge_description: { type: 'string', description: 'What this relationship means in one sentence (for add_edge).' },
                },
                required: ['action'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'system_map_query',
            description: 'Query the cross-workspace system map (~/.ollamaforge/system-map.json). Use this before making changes that touch infrastructure, SSH targets, inter-service boundaries, or when the user asks how the broader system fits together. Returns only the matching subgraph -- never the full map unless no filter is given.',
            parameters: {
                type: 'object',
                properties: {
                    node_id:  { type: 'string', description: 'Return the node with this exact id.' },
                    search:   { type: 'string', description: 'Substring search across node ids, labels, descriptions, and metadata values.' },
                    type:     { type: 'string', enum: ['workspace', 'service', 'machine', 'database', 'other'], description: 'Filter by node type.' },
                    related:  { type: 'string', description: 'Return all nodes and edges connected to this node id.' },
                    format:   { type: 'string', enum: ['text', 'mermaid'], description: 'Output format. "text" (default) is readable prose. "mermaid" generates a graph diagram you can paste into a markdown file.' },
                },
                required: [],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'system_map_visualize',
            description: 'Write a Mermaid diagram of the cross-workspace system map to .ollamaforge/system-map.md and open it in VS Code. Use this when the user asks to see, draw, or visualize the system map. The file can be previewed with VS Code\'s built-in Markdown Preview (Ctrl+Shift+V).',
            parameters: {
                type: 'object',
                properties: {
                    filter: { type: 'string', description: 'Optional: restrict the diagram to nodes/edges matching this search term (same as system_map_query search parameter). Omit to show the full map.' },
                },
                required: [],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'run_command',
            description: `Run a shell command that may MODIFY files or state. Requires user confirmation. Use for: running tests, linting, installing dependencies, building, running scripts, npm/pip install, make, etc. For read-only commands (git log, ls, cat, etc.) prefer shell_read instead.${detectShellEnvironment().bashPath ? ' SHELL IS GIT BASH -- use bash/Unix commands. NEVER use PowerShell cmdlets (Get-ChildItem, Set-Content, etc.) for local operations -- use bash equivalents (find, cat, cp, mv, rm, mkdir). SSH/remote commands are fine as-is.' : ''} Destructive operations (rm, delete, overwrite) require prior listing and user confirmation. Dry-run first for any script that moves/renames/deletes files. Result includes [CWD: ...] for orientation.`,
            parameters: {
                type: 'object',
                properties: {
                    command: { type: 'string', description: 'Shell command to execute' },
                },
                required: ['command'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'memory_list',
            description: 'List all saved project memory notes for this workspace. ALWAYS call this tool when user asks "what do you know", "what have you learned", or asks about project knowledge -- do not answer from conversation history alone.',
            parameters: { type: 'object', properties: {}, required: [] },
        },
    },
    {
        type: 'function',
        function: {
            name: 'memory_write',
            description: 'Save a note to persistent project memory. Use this to store important facts, architectural decisions, known issues, or any context that should persist across conversations.',
            parameters: {
                type: 'object',
                properties: {
                    content: { type: 'string', description: 'Note content to save (max 4000 chars)' },
                    tag:     { type: 'string', description: 'Optional tag, e.g. "architecture", "bug", "todo", "decision"' },
                },
                required: ['content'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'memory_delete',
            description: 'Delete a saved project memory note by its id. IMPORTANT: You MUST call memory_list FIRST to get the actual entry IDs -- do not guess or fabricate IDs.',
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: 'Note id from memory_list output' },
                },
                required: ['id'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'memory_search',
            description: 'Search past memories using semantic similarity. Use this to find relevant past solutions, decisions, or context without loading all memories.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'What to search for (e.g., "NFS mount fix", "database connection issue")' },
                    tier: { type: 'number', description: 'Optional: limit search to specific tier (4=references, 5=archive)' },
                    limit: { type: 'number', description: 'Maximum results to return (default: 5)' },
                },
                required: ['query'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'memory_tier_write',
            description: 'Save ONE atomic piece of information to a specific memory tier. When user provides multiple pieces of information, call this tool MULTIPLE TIMES (once per concept). Use appropriate tier: 0=critical (IPs, URLs, ports, paths, credentials), 1=essential (frameworks, tools, deployment processes, hosting), 2=operational (current work, bugs), 3=collaboration (conventions, workflows), 4=references (past solutions).',
            parameters: {
                type: 'object',
                properties: {
                    tier: { type: 'number', description: 'Memory tier (0-5)', enum: [0, 1, 2, 3, 4, 5] },
                    content: { type: 'string', description: 'The actual text to save — must be a non-empty string containing the fact, finding, or decision. Do NOT pass an empty string or a placeholder. ONE focused piece of information (max 4000 chars). Keep it atomic — one concept per entry.' },
                    tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags for categorization (e.g., ["server", "infrastructure"])' },
                },
                required: ['tier', 'content'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'memory_tier_list',
            description: 'List memories from specific tiers. ALWAYS call this tool when user asks to see specific tier memories -- do not answer from conversation history alone. Use to view only relevant tier(s) instead of all memories.',
            parameters: {
                type: 'object',
                properties: {
                    tiers: { type: 'array', items: { type: 'number' }, description: 'Tier numbers to list (e.g., [0, 1] for critical + essential)' },
                },
                required: ['tiers'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'memory_stats',
            description: 'Get memory statistics showing entry count and token usage per tier.',
            parameters: { type: 'object', properties: {}, required: [] },
        },
    },
    {
        type: 'function',
        function: {
            name: 'read_terminal',
            description: 'Read recent output from VS Code integrated terminals. Use this when the user mentions terminal output, errors in their terminal, or when you need to see what a previously-run command produced.',
            parameters: {
                type: 'object',
                properties: {
                    index: { type: 'number', description: 'Terminal index (0-based). Omit to read the active terminal.' },
                },
                required: [],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'get_diagnostics',
            description: 'Get VS Code diagnostics (errors, warnings) for a file or the entire workspace. Use this after editing files to check if your changes introduced any problems, or when the user mentions errors in their code.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'File path relative to workspace root. Omit to get diagnostics for all open files.' },
                },
                required: [],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'web_search',
            description: 'Search the web using SearXNG. Use this to find examples, documentation, libraries, tutorials, current information, or product prices. Returns titles, URLs, and snippets. Requires SearXNG to be configured in settings (ollamaForge.search.url).\n\nFor product pricing: use engines="google shopping,bing shopping" to get structured price data directly in results without needing to fetch pages. For Amazon-specific results use query prefix "site:amazon.com". For AliExpress use "site:aliexpress.com".\n\n**Multi-source rule:** When answering a factual question, recommending a library/tool, explaining how something works, or giving guidance the user will act on — search at least 3 times with different query angles (e.g. official docs, a tutorial site, a forum/community discussion) before forming your answer. Fetch at least one source page with web_fetch to verify the detail is current. Do not rely on a single search result.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Search query (be specific -- e.g. "flask chartjs analytics dashboard example" not just "analytics"). For prices: include the product name and optionally "site:amazon.com" or "site:aliexpress.com".' },
                    limit: { type: 'number', description: 'Max results to return (default: 5, max: 20)' },
                    engines: { type: 'string', description: 'Comma-separated SearXNG engines to use. For product pricing use "google shopping,bing shopping". Omit for general web search.' },
                },
                required: ['query'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'web_fetch',
            description: 'Fetch a web page and return its content as plain text. Use this to read documentation, GitHub READMEs, or any URL the user provides. Strips HTML tags and returns readable text capped at 8000 chars.',
            parameters: {
                type: 'object',
                properties: {
                    url: { type: 'string', description: 'Full URL to fetch (must start with http:// or https://)' },
                },
                required: ['url'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'deep_research',
            description: 'Execute a structured deep research pipeline: fan-out web searches with multiple query angles → fetch top sources → extract key claims → cross-reference for corroboration/contradictions → produce a cited synthesis report. Use this INSTEAD of multiple individual web_search + web_fetch calls when the user asks to "research", "investigate", "find out about", or needs a thorough multi-source answer. Returns a formatted markdown report with inline citations and contradiction flags. Requires SearXNG to be configured.',
            parameters: {
                type: 'object',
                properties: {
                    question:   { type: 'string', description: 'The research question to investigate. Be specific — e.g. "How does KV cache offloading work in vLLM?" not "vLLM"' },
                    maxSources: { type: 'number', description: 'Maximum number of source pages to fetch (default 5, max 10).' },
                },
                required: ['question'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'use_skill',
            description: 'Activate a named skill from the workspace skill library (.ollamaforge/skills/). When active, the agent injects the skill\'s prompt, restricts available tools to the skill\'s allowlist, and optionally switches to the skill\'s model. Pass skill name to activate, or empty string to deactivate. Use when the user asks to "use the X skill" or "switch to X mode".',
            parameters: {
                type: 'object',
                properties: {
                    skill: { type: 'string', description: 'Name of the skill to activate (e.g. "code-review"). Pass empty string to deactivate the current skill.' },
                },
                required: ['skill'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'generate_image',
            description: 'Generate an image from a text prompt using ComfyUI (SDXL). Returns the local file path of the saved PNG. Use this to create diagrams, illustrations, mockups, or visuals for reports. Requires ollamaForge.comfyui.url to be configured.',
            parameters: {
                type: 'object',
                properties: {
                    prompt:          { type: 'string',  description: 'Text description of the image to generate. Be specific and descriptive.' },
                    negative_prompt: { type: 'string',  description: 'Things to avoid in the image (optional). Default negative prompt already excludes blurry/low-quality output.' },
                    width:           { type: 'number',  description: 'Image width in pixels (default 1024).' },
                    height:          { type: 'number',  description: 'Image height in pixels (default 768).' },
                    task_id:         { type: 'string',  description: 'Task ID for saving the image under .ollamaforge/tasks/<task_id>/images/ (optional -- uses "images" if omitted).' },
                },
                required: ['prompt'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'task_checkpoint',
            description: 'Write a checkpoint to .ollamaforge/tasks/<task_id>/checkpoint.json so a long-running script can resume from where it left off if interrupted. Call this after every major stage or every ~1000 rows processed. Also appends a step entry to the task log.',
            parameters: {
                type: 'object',
                properties: {
                    task_id: { type: 'string', description: 'Task identifier (same as used in task_log).' },
                    stage: { type: 'string', description: 'Name of the current stage, e.g. "compare", "fix", "verify".' },
                    offset: { type: 'number', description: 'Row or line number processed so far (so the script can skip ahead on resume).' },
                    state: { type: 'object', description: 'Optional: arbitrary JSON state the script needs to resume correctly (e.g. last seen key, current file path).' },
                },
                required: ['task_id', 'stage', 'offset'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'task_report',
            description: 'Generate an HTML summary report for a completed or validated task and open it in VS Code Simple Browser. Use this after the validation step to give the user a human-readable view of what changed. Include stats table and a sample of rows/items affected.',
            parameters: {
                type: 'object',
                properties: {
                    task_id: { type: 'string', description: 'Task identifier (same as used in task_log).' },
                    title: { type: 'string', description: 'Report title, e.g. "Orders CSV Comparison -- 2026-04-30".' },
                    summary: { type: 'string', description: 'One-paragraph plain-text summary of what the task did and what it found.' },
                    stats: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, value: { type: 'string' } }, required: ['label', 'value'] }, description: 'Key stats to show in a summary table, e.g. [{label: "Rows processed", value: "12,450"}, {label: "Mismatches", value: "37"}].' },
                    sample: { type: 'array', items: { type: 'array', items: { type: 'string' } }, description: 'Optional: sample rows to display as a table. First inner array = headers, remaining = data rows.' },
                },
                required: ['task_id', 'title', 'summary', 'stats'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'workspace_index',
            description: 'Scan one or more file paths or globs and write a concise summary of each large file to .ollamaforge/index/<path>.summary.md. Use this BEFORE trying to read a large file -- check the index first (shell_read the summary) and only call workspace_index if no fresh summary exists. Summaries are skipped if < 7 days old unless force=true.',
            parameters: {
                type: 'object',
                properties: {
                    paths: { type: 'array', items: { type: 'string' }, description: 'File paths or glob patterns to index, relative to workspace root. E.g. ["src/**/*.ts", "data/orders.csv"].' },
                    force: { type: 'boolean', description: 'Re-index even if a fresh summary already exists (default: false).' },
                },
                required: ['paths'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'schedule_task',
            description: 'Persist a recurring task to .ollamaforge/schedules/<name>.json. The extension will automatically run the script when the interval elapses (checked on VS Code startup). Use this for validation scripts, data sync checks, or any task that should repeat on a regular basis.',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Short snake_case name for the schedule, e.g. "daily_csv_validation".' },
                    script_path: { type: 'string', description: 'Path to the script to run, relative to workspace root.' },
                    interval_hours: { type: 'number', description: 'How often to run (in hours). E.g. 24 for daily, 168 for weekly.' },
                    description: { type: 'string', description: 'Human-readable description of what this scheduled task does.' },
                },
                required: ['name', 'script_path', 'interval_hours', 'description'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'delegate_task',
            description: 'Spawn a sub-agent to handle a self-contained subtask in the same workspace. Use this when you are acting as an orchestrator breaking a large task into independent or sequential steps. Each subagent runs its own tool loop and returns a structured result. BEFORE delegating: (1) ensure the prompt is fully self-contained -- no references to "the conversation" or placeholders, (2) include all file paths, URL patterns, and values the subagent will need, (3) state the expected output explicitly. Parallel delegation: emit multiple delegate_task calls in a single turn for independent tasks. Sequential delegation: wait for one result before delegating the next if it depends on the output.',
            parameters: {
                type: 'object',
                properties: {
                    prompt: {
                        type: 'string',
                        description: 'Complete, self-contained task description. Must include all file paths, values, and expected outputs. No placeholders or references to the parent conversation.',
                    },
                    allowed_tools: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Optional whitelist of tool names the subagent may use. Omit to allow all tools. Use ["shell_read", "read_file", "find_files", "search_files", "gather_context"] for read-only research tasks.',
                    },
                    max_turns: {
                        type: 'number',
                        description: 'Maximum tool-call turns before the subagent is stopped (default: 20). Use lower values for simple tasks, higher for complex ones.',
                    },
                    model: {
                        type: 'string',
                        description: 'Model to use for the subagent. Omit to inherit the parent model.',
                    },
                },
                required: ['prompt'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'delegate_task_async',
            description: 'Start a subagent in the background and return a handle immediately -- does NOT block. Use this when you want to do other work (tool calls, edits) while the subagent runs. Call delegate_task_await(handle) when you need the result. IMPORTANT: always call delegate_task_await before your final response -- never leave a handle uncollected. Same prompt rules as delegate_task: fully self-contained, no placeholders.',
            parameters: {
                type: 'object',
                properties: {
                    prompt: {
                        type: 'string',
                        description: 'Complete, self-contained task description. Must include all file paths, values, and expected outputs. No placeholders or references to the parent conversation.',
                    },
                    allowed_tools: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Optional whitelist of tool names the subagent may use. Omit to allow all tools.',
                    },
                    max_turns: {
                        type: 'number',
                        description: 'Maximum tool-call turns before the subagent is stopped (default: 20).',
                    },
                    model: {
                        type: 'string',
                        description: 'Model to use for the subagent. Omit to inherit the parent model.',
                    },
                },
                required: ['prompt'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'delegate_task_await',
            description: 'Collect the result of a background subagent started with delegate_task_async. Blocks until the subagent completes. Returns the same STATUS/OUTPUT/FILES_CHANGED format as delegate_task. Call this before your final response.',
            parameters: {
                type: 'object',
                properties: {
                    handle: {
                        type: 'string',
                        description: 'The handle string returned by delegate_task_async.',
                    },
                },
                required: ['handle'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'task_plan',
            description: 'Maintain a structured plan ledger for a multi-step task. Call once with action="create" to declare the full step list, then action="advance" after each step completes (or action="skip"/"block" with a reason). The ledger persists to .ollamaforge/tasks/<task_id>/plan.json and is injected into your system prompt every turn so you never lose track of what is done vs. pending across context compactions. Use this for any task with 3+ steps. Prefer this over free-form task_log for the step checklist; use task_log for the narrative log.',
            parameters: {
                type: 'object',
                properties: {
                    task_id: { type: 'string', description: 'Short snake_case identifier, e.g. "wave4_plan_ledger". Same id across all calls for this task.' },
                    action: { type: 'string', enum: ['create', 'advance', 'skip', 'block', 'status'], description: 'create = declare the full step list. advance = mark the next pending step done (optionally with a note). skip = mark the next pending step skipped (give a reason). block = mark the next pending step blocked (give the blocker). status = read the current ledger without changing it.' },
                    steps: { type: 'array', items: { type: 'string' }, description: 'Required for action=create. Ordered list of step descriptions, e.g. ["Read existing task_log handler", "Add task_plan tool definition", "Add handler case", "Inject ledger into system prompt", "Verify with tests"].' },
                    note: { type: 'string', description: 'Optional note for the step being advanced/skipped/blocked. Max 200 chars.' },
                },
                required: ['task_id', 'action'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'propose_edit',
            description: 'Stage an edit for review WITHOUT writing it to disk (diff-first mode, item 3.3). Opens a VS Code diff preview of old_string → new_string and queues the change. The user (or apply_staged_edits) decides whether to apply it. Use this for risky or multi-hunk edits to reduce blast radius. Non-destructive by default; set destructive=true only if the change deletes data or is hard to reverse.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'File path relative to workspace root.' },
                    old_string: { type: 'string', description: 'Exact current text to replace (or "" for a pure insertion at top).' },
                    new_string: { type: 'string', description: 'Replacement text.' },
                    destructive: { type: 'boolean', description: 'Set true if the change is hard to reverse (deletes data, drops columns, etc.). Defaults to false.' },
                },
                required: ['path', 'old_string', 'new_string'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'apply_staged_edits',
            description: 'Apply previously staged edits (from propose_edit) to disk. mode="all" applies every staged edit (use in Trust/YOLO for one-click apply-all). mode="select" applies only the given edit_ids. mode="discard" drops the given edit_ids without applying. Returns a per-edit result. Reduces blast radius by letting the user accept/reject hunks individually.',
            parameters: {
                type: 'object',
                properties: {
                    mode: { type: 'string', enum: ['all', 'select', 'discard'], description: 'all = apply every staged edit. select = apply only edit_ids. discard = drop edit_ids without applying.' },
                    edit_ids: { type: 'array', items: { type: 'number' }, description: 'Required for select/discard. The ids returned by propose_edit.' },
                },
                required: ['mode'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'rollback_last_refactor',
            description: 'Roll back the most recent multi-file refactor (item 3.5). Restores every file touched since the last rollback to its pre-edit content (or removes files that were created). count=N rolls back the last N file operations from the undo stack (default 1 = the whole last batch). Use after a refactor that broke something, to restore the prior state before retrying.',
            parameters: {
                type: 'object',
                properties: {
                    count: { type: 'number', description: 'How many recent file operations to roll back (default 1). Each operation is one file edit/create/delete.' },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'ask_user',
            description: 'Ask the user a typed question with options (item 3.7). Renders buttons in the webview. Use when you need to disambiguate a request (e.g. "move X from A to B" — update code vs move files). options: list of 2-6 short choices. allowFreeText: true adds a free-text input below the buttons.',
            parameters: {
                type: 'object',
                properties: {
                    question: { type: 'string', description: 'The question to ask the user.' },
                    options: { type: 'array', items: { type: 'string' }, description: '2-6 short option labels the user can click.' },
                    allowFreeText: { type: 'boolean', description: 'If true, also show a free-text input. Default false.' },
                },
                required: ['question', 'options'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'task_log',
            description: 'Write a structured log entry to the task scratchpad at .ollamaforge/tasks/<task_id>/log.md. Use this to track progress, record script paths, capture output summaries, and note validation results for long-running data tasks. Call at the start of a task (status=started), after each major step (status=step), after validation (status=validated or status=failed), and when done (status=done).',
            parameters: {
                type: 'object',
                properties: {
                    task_id: { type: 'string', description: 'Short snake_case identifier for the task, e.g. "csv_compare_orders_2024". Use the same id across all log entries for a task.' },
                    status: { type: 'string', enum: ['started', 'step', 'validated', 'failed', 'done'], description: 'Stage of the task.' },
                    message: { type: 'string', description: 'What happened. For steps: what script was run and what it produced. For validation: the key numbers (rows processed, errors found, changes made). Max 500 chars.' },
                    script_path: { type: 'string', description: 'Optional: path to the script written/run in this step, relative to workspace root.' },
                },
                required: ['task_id', 'status', 'message'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'save_skill',
            description: 'Save a reusable helper script to .ollamaforge/skills/ so it can be reused across future sessions. Use this when you write a script that solves a recurring problem (e.g. a CSV differ, a log parser, a code search utility). Skills persist permanently and are listed at the start of each dream cycle.',
            parameters: {
                type: 'object',
                properties: {
                    filename: { type: 'string', description: 'Filename including extension, e.g. "compare_csvs.py" or "find_large_files.sh". Use snake_case, no spaces.' },
                    content:  { type: 'string', description: 'Full content of the script. Add a comment block at the top with: description, usage example, and parameters.' },
                    description: { type: 'string', description: 'One-line description of what this skill does, shown in the skills list.' },
                },
                required: ['filename', 'content', 'description'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'list_skills',
            description: 'List all saved skills in .ollamaforge/skills/ with their descriptions. Call this before writing a new script to avoid duplicating an existing skill.',
            parameters: {
                type: 'object',
                properties: {},
                required: [],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'refactor_multi_file',
            description: 'Propose coordinated changes across multiple files. Use this when a refactoring affects multiple files (e.g., renaming a function used in many places, restructuring modules). Shows a preview of all changes before applying.',
            parameters: {
                type: 'object',
                properties: {
                    title: { type: 'string', description: 'Short title for the refactoring (e.g., "Rename getUserData to fetchUserData")' },
                    description: { type: 'string', description: 'Explanation of what changes are being made and why' },
                    changes: {
                        type: 'array',
                        description: 'Array of file changes',
                        items: {
                            type: 'object',
                            properties: {
                                path: { type: 'string', description: 'File path relative to workspace root' },
                                old_content: { type: 'string', description: 'Current file content (must match exactly)' },
                                new_content: { type: 'string', description: 'New file content after refactoring' },
                                description: { type: 'string', description: 'Optional: what changed in this file' },
                            },
                            required: ['path', 'old_content', 'new_content'],
                        },
                    },
                },
                required: ['title', 'description', 'changes'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'graph_index',
            description: 'Index (or re-index) the workspace code graph. Parses TypeScript, JavaScript, and Python files to build a symbol graph (functions, classes, methods) in .ollamaforge/graph.db. Run this after major refactors or when graph_status shows stale data. Optionally restrict to a single file.',
            parameters: {
                type: 'object',
                properties: {
                    scope: { type: 'string', description: 'Optional: path to a specific file to re-index. Default: entire workspace.' },
                },
                required: [],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'graph_query',
            description: 'Query the code graph for symbols related to a topic or identifier. Returns matching functions, classes, and methods with file locations. Use this to find where something is defined or to understand call relationships.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Symbol name or natural language description of what you are looking for.' },
                },
                required: ['query'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'graph_status',
            description: 'Show code graph statistics: total symbols indexed, number of files, when last indexed, and a drift summary (symbols that have changed since indexing).',
            parameters: { type: 'object', properties: {}, required: [] },
        },
    },
    {
        type: 'function',
        function: {
            name: 'impact_analysis',
            description: 'Blast-radius analysis for a symbol. Given a function/class/method name, returns what calls it (callers), what it calls (callees), the distinct files touched, and any test files that reach it. Use this BEFORE editing a symbol to understand what your change will affect.',
            parameters: {
                type: 'object',
                properties: {
                    symbol: { type: 'string', description: 'Name of the function, class, or method to analyze.' },
                    depth: { type: 'number', description: 'Optional: how many hops to walk (default 2). Higher = wider but noisier.' },
                },
                required: ['symbol'],
            },
        },
    },
];


/**
 * Restricted tool set for small models (≤9B params).
 * When file context is pre-injected, small models only need edit_file and run_command.
 * Removing shell_read prevents them from looping on directory discovery.
 */
export const SMALL_MODEL_TOOL_DEFINITIONS = TOOL_DEFINITIONS.filter(t =>
    ['edit_file', 'edit_file_at_line', 'run_command'].includes(t.function.name)
);

