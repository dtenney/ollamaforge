/**
 * Shell environment detection and prompt-building helpers.
 * Extracted from agent.ts (Phase 1 decomposition).
 */
import { execSync } from 'child_process';
import { logInfo, logWarn } from './logger';

export interface ShellEnvironment {
    os: 'windows' | 'macos' | 'linux';
    shell: string;           // e.g. 'bash', 'powershell', 'cmd', 'zsh'
    /** Short label for prompts, e.g. "Windows (bash/Git Bash)" */
    label: string;
    /** Python executable name (e.g. 'python3', 'python') -- empty string if not found */
    pythonCmd: string;
    /** Full path to bash executable (Git Bash on Windows), empty if not found */
    bashPath: string;
    /** Find files by name */
    findCmd: string;
    /** Search text in files */
    grepCmd: string;
    /** List directory tree */
    treeCmd: string;
    /** Create directories */
    mkdirCmd: string;
    /** Move/rename files */
    moveCmd: string;
    /** View file contents */
    catCmd: string;
}

export interface FilePlan {
    relPath: string;
    action: 'create' | 'modify';
    description: string;
}

let _cachedShellEnv: ShellEnvironment | null = null;

/** Git Bash is required on Windows. PowerShell routing is not supported. */

export function extractDocVerificationHints(docContent: string): string[] {
    const hints: string[] = [];

    // Numeric retention/period claims
    // e.g. "3-year retention", "5 years minimum", "90-day hold", "15 days"
    const retentionMatches = docContent.matchAll(
        /(\d+)[\s-]*(year|month|day|hour)s?[\s-]*(?:minimum\s+)?(?:retention|hold|period|record|reporting|threshold)/gi
    );
    for (const m of retentionMatches) {
        hints.push(`- Retention/period claim: "${m[0].trim()}" -- grep source for the actual value: grep -rn "${m[1]}" app/ --include="*.py" | grep -i "retention\\|days\\|year\\|threshold"`);
    }

    // Also catch "X-year" / "X year" standalone phrases near retention context
    const yearPhrases = docContent.matchAll(/\b(\d+)[\s-]year\b.*?(?:retention|records?|minimum)/gi);
    for (const m of yearPhrases) {
        const days = parseInt(m[1]) * 365;
        hints.push(`- Year-based claim: "${m[0].slice(0, 60).trim()}" -- Python code often stores this as days in timedelta(). Run BOTH:\n  1. grep -rn "timedelta(days=" app/ --include="*.py" | grep -v "pycache"\n  2. grep -rn "${days}" app/ --include="*.py" | grep -v "pycache"\n  The actual days value in code is the source of truth -- use that value, not the doc's year claim.`);
    }

    // Class/function name claims
    // Backtick or inline code references to class/function names
    const codeRefs = [...docContent.matchAll(/`([A-Z][a-zA-Z]+(?:Service|Manager|Encryption|Storage|Validator|Helper|Audit|Log)[a-zA-Z]*)`/g)];
    const uniqueRefs = [...new Set(codeRefs.map(m => m[1]))].slice(0, 6);
    for (const ref of uniqueRefs) {
        hints.push(`- Class/function "${ref}" -- verify it exists: grep -r "class ${ref}\\|def ${ref}" app/ --include="*.py"`);
    }

    // Specific numeric config values
    // e.g. "100,000 iterations", "$500", "15 days", "24-hour"
    const numericClaims = [...docContent.matchAll(/\b(\d{2,}(?:,\d{3})*)\s*(iterations?|days?|hours?|requests?)\b/gi)];
    for (const m of numericClaims.slice(0, 4)) {
        const rawNum = m[1].replace(/,/g, '');
        hints.push(`- Numeric claim: "${m[0].trim()}" -- grep for ${rawNum} in source: grep -r "${rawNum}" app/ --include="*.py"`);
    }

    // File path claims
    // e.g. references to specific file paths in backticks
    const filePaths = [...docContent.matchAll(/`(app\/[a-zA-Z0-9_\/\.]+\.py)`/g)];
    const uniquePaths = [...new Set(filePaths.map(m => m[1]))].slice(0, 4);
    for (const p of uniquePaths) {
        hints.push(`- File path "${p}" -- verify it exists: shell_read Get-Item '${p}'`);
    }

    return hints;
}

/**
 * Strip PowerShell Select-String -Context output prefixes so the model
 * sees exact file content suitable for use in edit_file old_string.
 * - Match lines are prefixed with "> " -> strip 2 chars
 * - Context lines get 2 extra spaces prepended by Select-String -> strip 2 chars
 * - Blank lines have no prefix -> leave as-is
 */
export function stripSelectStringPrefixes(text: string): string {
    return text.split('\n').map(line => {
        if (line.startsWith('> ')) { return line.slice(2); }   // match line
        if (line.length >= 2 && line[0] === ' ' && line[1] === ' ') { return line.slice(2); } // context line
        return line; // blank or separator line
    }).join('\n');
}

export function detectShellEnvironment(): ShellEnvironment {
    if (_cachedShellEnv) { return _cachedShellEnv; }

    const platform = process.platform;
    const isWin = platform === 'win32';
    const isMac = platform === 'darwin';

    let shell = '';
    let bashPath = '';
    if (isWin) {
        // Prefer bash (Git Bash) over PowerShell on Windows -- gives full Unix tooling.
        // Probe common Git Bash install paths, then fall back to `where bash`.
        const bashCandidates = [
            'C:\\Program Files\\Git\\bin\\bash.exe',
            'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
            'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
        ];
        for (const candidate of bashCandidates) {
            try {
                execSync(`"${candidate}" -c "echo ok"`, { stdio: 'pipe', timeout: 3000 });
                bashPath = candidate;
                break;
            } catch { /* not at this path */ }
        }
        if (!bashPath) {
            // Try PATH lookup as last resort
            try {
                const found = execSync('where bash', { stdio: 'pipe', timeout: 3000 }).toString().trim().split('\n')[0].trim();
                if (found && found.toLowerCase().endsWith('.exe')) {
                    execSync(`"${found}" -c "echo ok"`, { stdio: 'pipe', timeout: 3000 });
                    bashPath = found;
                }
            } catch { /* bash not in PATH */ }
        }
        shell = 'bash';
        if (bashPath) {
            logInfo(`[shell-env] Git Bash found: ${bashPath}`);
        } else {
            logWarn('[shell-env] Git Bash not found on Windows -- install Git for Windows. Commands will fail without it.');
        }
    } else {
        // Unix: check SHELL env var, fall back to detection
        const envShell = process.env.SHELL || '';
        if (envShell.includes('zsh')) { shell = 'zsh'; }
        else if (envShell.includes('fish')) { shell = 'fish'; }
        else { shell = 'bash'; }
    }

    // Detect Python executable -- try python3 first (Unix convention), then python (Windows/venvs)
    let pythonCmd = '';
    for (const candidate of ['python3', 'python']) {
        try {
            const out = execSync(`${candidate} --version`, { stdio: 'pipe', timeout: 3000 }).toString().trim();
            if (/python\s+3\./i.test(out)) { pythonCmd = candidate; break; }
        } catch { /* not found */ }
    }
    if (pythonCmd) {
        logInfo(`[shell-env] Python detected: ${pythonCmd}`);
    } else {
        logWarn('[shell-env] Python 3 not found -- Python-based file ops will fall back to shell');
    }

    const osName: ShellEnvironment['os'] = isWin ? 'windows' : isMac ? 'macos' : 'linux';

    if (isWin) {
        _cachedShellEnv = {
            os: 'windows',
            shell: 'bash',
            pythonCmd,
            bashPath,
            label: 'Windows (bash/Git Bash)',
            findCmd: "find . -name '*pattern*' -not -path '*__pycache__*'",
            grepCmd: "grep -rn 'text' --include='*.py' .",
            treeCmd: 'find folder -type f | head -50',
            mkdirCmd: 'mkdir -p folder1 folder2',
            moveCmd: 'mv old/path new/path',
            catCmd: 'cat file.txt',
        };
    } else {
        _cachedShellEnv = {
            os: osName,
            shell,
            pythonCmd,
            bashPath: '',
            label: `${isMac ? 'macOS' : 'Linux'} (${shell})`,
            findCmd: "find . -name '*pattern*' -not -path '*__pycache__*'",
            grepCmd: "grep -rn 'text' --include='*.py' .",
            treeCmd: 'find folder -type f | head -50',
            mkdirCmd: 'mkdir -p folder1 folder2',
            moveCmd: 'mv old/path new/path',
            catCmd: 'cat file.txt',
        };
    }

    logInfo(`[shell-env] Detected: ${_cachedShellEnv.label} (shell=${shell}, os=${osName}, python=${pythonCmd || 'none'})`);
    return _cachedShellEnv;
}

/** Build Python-first examples tailored to the detected environment */
export function buildShellExamples(env: ShellEnvironment, workspaceRoot?: string): string {
    const ws = workspaceRoot ? workspaceRoot.replace(/\\/g, '/') : '.';
    const py = env.pythonCmd || 'python3';
    const hasPython = !!env.pythonCmd;

    const nativeSection = hasPython
        ? `## Native file tools -- NO shell, works on ALL platforms
- Read a file:               read_file -> {"path": "src/tasks.py"}
- Read specific lines:       read_file -> {"path": "src/tasks.py", "offset": 10, "limit": 50}
- Find files by pattern:     find_files -> {"pattern": "**/*.py"}
- Search code for a symbol:  search_files -> {"pattern": "def create_task", "glob": "*.py"}
- Search literal string:     search_files -> {"pattern": "import sqlite3", "literal": true}`
        : '';

    const gitSection = `## Shell -- use ONLY for git and non-file queries
- Git status/log/diff:       shell_read -> git status  |  git log --oneline -20  |  git diff
- Environment/version:       shell_read -> ${py} --version  |  node -v  |  which pip`;

    const fallbackSection = env.os === 'windows'
        ? `## run_command shell notes (Git Bash -- Unix syntax only)
⚠ NEVER use PowerShell cmdlets -- shell is Git Bash. These fail with "command not found":
  Get-ChildItem, Get-Content, Set-Content, Select-Object, Select-String, Where-Object
Use bash: find, cat, grep, ls, cp, mv, rm, mkdir -p` : '';

    return `Your PRIMARY tools for file operations are read_file, search_files, and find_files -- native, no shell, identical on all platforms. Host: **${env.label}**. Workspace: ${ws}
Use shell_read ONLY for git commands and environment queries. Use run_command ONLY for state-changing operations (install, build, run scripts).

${nativeSection}

${gitSection}

${fallbackSection}

ALWAYS use full absolute paths from search results -- never guess relative paths.
PREFER targeted searches over broad directory sweeps.`;
}

/** Build Python-first examples for text-mode (XML tool) instructions */
export function buildTextModeShellExamples(env: ShellEnvironment, workspaceRoot?: string): string {
    const ws = workspaceRoot ? workspaceRoot.replace(/\\/g, '/') : '.';
    const py = env.pythonCmd || 'python3';
    const hasPython = !!env.pythonCmd;

    const pythonExamples = `CRITICAL -- Python-First Approach (works on ALL platforms):
Host: **${env.label}**. Workspace root: ${ws}
${hasPython ? `Python available: **${py}** -- use it for ALL file discovery and reading.` : `Python NOT detected -- use platform shell commands below instead.`}

EXAMPLE - Find the payment service code:
<tool>{"name": "shell_read", "arguments": {"command": "${py} -c \\"import pathlib; [print(p) for p in pathlib.Path('${ws}').rglob('*payment*') if '__pycache__' not in str(p)]\\""}}</tool>

EXAMPLE - Search for where process_payment is defined (with line numbers):
<tool>{"name": "shell_read", "arguments": {"command": "${py} -c \\"import pathlib,re;\\n[print(f'{p}:{i+1}: {l.rstrip()}') for p in pathlib.Path('${ws}').rglob('*.py') if '__pycache__' not in str(p) for i,l in enumerate(p.read_text(errors='ignore').splitlines()) if re.search(r'def process_payment', l)]\\""}}</tool>

EXAMPLE - Read a file (use full path from search result):
<tool>{"name": "shell_read", "arguments": {"command": "${py} -c \\"print(open('/full/path/payment_service.py').read())\\""}}</tool>

EXAMPLE - Read lines 474--580 of a file:
<tool>{"name": "shell_read", "arguments": {"command": "${py} -c \\"lines=open('/full/path/file.py').readlines(); print(''.join(lines[473:580]))\\""}}</tool>

EXAMPLE - List files in a directory:
<tool>{"name": "shell_read", "arguments": {"command": "${py} -c \\"import pathlib; [print(p) for p in sorted(pathlib.Path('${ws}/app').rglob('*.py')) if '__pycache__' not in str(p)]\\""}}</tool>

EXAMPLE - Create a directory and move a file:
<tool>{"name": "run_command", "arguments": {"command": "${py} -c \\"import shutil,pathlib; pathlib.Path('${ws}/app/routes/admin').mkdir(parents=True,exist_ok=True); shutil.move('${ws}/app/routes/admin.py','${ws}/app/routes/admin/')\\""}}</tool>

EXAMPLE - Create a new source file:
Use write_file -- NEVER use echo or shell redirection (collapses newlines):
<tool>{"name": "write_file", "arguments": {"path": "${ws}/app/services/new_service.py", "content": "# full file content here"}}</tool>

CRITICAL: When a search returns a path, use that EXACT full path in the next call -- do NOT guess.
CRITICAL: NEVER use echo, Add-Content, Set-Content, or shell redirection to write source files -- use write_file or edit_file.`;

    if (hasPython) { return pythonExamples; }

    // Python not available -- fall back to shell (Git Bash on Windows, native bash/sh on Unix)
    const shellFallback = `\n\nPython not found -- using shell fallback:
EXAMPLE - Find files: <tool>{"name": "shell_read", "arguments": {"command": "find '${ws}' -type f -name '*payment*' -not -path '*__pycache__*'"}}</tool>
EXAMPLE - Search code: <tool>{"name": "shell_read", "arguments": {"command": "grep -rn 'def process_payment' --include='*.py' '${ws}'"}}</tool>
EXAMPLE - Read file: <tool>{"name": "shell_read", "arguments": {"command": "cat '/full/path/payment_service.py'"}}</tool>
EXAMPLE - Read line range: <tool>{"name": "shell_read", "arguments": {"command": "sed -n '474,580p' '/full/path/file.py'"}}</tool>`;

    return pythonExamples + shellFallback;
}
