/**
 * agentLoop.ts — Pure helper functions extracted from Agent.run() (src/agent.ts)
 *
 * These are stateless, side-effect-free functions that were previously inlined
 * inside the ~12,500-line run() method. Extracting them here:
 *   - removes them from run()'s local scope (smaller closure, easier to read)
 *   - makes them unit-testable in isolation
 *   - preserves exact behavior (no semantic changes)
 *
 * Extraction log:
 *   2026-09-25: stripXmlArtifacts, normalizeArgVal, filePathInMsg,
 *               filterCompleteLine, isPlanningLine, escHtml, looksLikePath,
 *               normalizePath, requiredParams, isAbsPath, isFilePath,
 *               globToRegex, globToRegexDeep
 *   2026-10-03: toolCallDigest, stableStringify
 *   2026-10-04: truncateToolResult
 *
 * NOTE: The full loop body (executeTurn) is intentionally NOT extracted here —
 * it is too tightly coupled to run()'s local scope (1,181 `this.` refs, 135
 * external locals). See plans/run-decomposition.md for the phased plan.
 */

import * as path from 'path';
import * as crypto from 'crypto';

/**
 * Strip XML/tool-call artifacts that small models sometimes leak into visible
 * text output.
 *
 * NOTE: do NOT strip THINK_START/THINK_END -- webview uses them to switch panels.
 */
export function stripXmlArtifacts(s: string): string {
    return s
        .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
        .replace(/<\/?tool_call>/g, '')
        .replace(/<function_calls>[\s\S]*?<\/function_calls>/g, '')
        .replace(/<\/?function_calls>/g, '')
        .replace(/<invoke(?:\s[^>]*)?>[\s\S]*?<\/invoke>/g, '')
        .replace(/<invoke(?:\s[^>]*)?>/g, '').replace(/<\/invoke>/g, '')
        .replace(/<parameter[^>]*>[\s\S]*?<\/parameter>/g, '')
        .replace(/<\/parameter>/g, '')
        .replace(/<\/?function>/g, '');
}

/**
 * Normalize a tool-call argument value: trim whitespace and strip a single
 * layer of surrounding quotes (double or single) if present. Used to build a
 * canonical signature for loop/repeat detection.
 */
export function normalizeArgVal(v: unknown): unknown {
    if (typeof v !== 'string') { return v; }
    let s = v.trim();
    if (s.startsWith('\\"') && s.endsWith('\\"')) { s = s.slice(2, -2).trim(); }
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) { s = s.slice(1, -1).trim(); }
    return s;
}

/**
 * Detect whether a user message contains a file path (e.g. `src/foo.ts`,
 * `docs/guide.md`). Used by the vague-scope guard to distinguish "improve
 * the codebase" from "improve src/foo.ts".
 */
export function filePathInMsg(msg: string): boolean {
    return /[\w./\\-]+\.\w{2,10}\b/.test(msg);
}

/**
 * Suppress single-line thought-process artifacts ("✨ Thought process:",
 * "## Analysis", "Happy to help", etc.) that the model sometimes emits
 * before a real answer. Returns the line unchanged if it is not a
 * suppressible artifact.
 */
export function filterCompleteLine(line: string): string {
    const SUPPRESS_SINGLE_LINE_RE = /^(?:[✨]\s*(?:Thought\s+process|Thinking|Analysis|My\s+analysis|Reasoning)\s*[:\n]?|#{1,3}\s*(?:Thought\s+process|Thinking|Analysis|Summary|My\s+analysis|Reasoning)\s*$|(?:Let me know (?:how it runs|if you need|if there)|Happy to help|Feel free to ask|Hope (?:this|that) helps)[.!]?)\s*$/i;
    return SUPPRESS_SINGLE_LINE_RE.test(line.trim()) ? '' : line;
}

/**
 * Detect whether a thinking-block line is planning narration ("I'll now…",
 * "Let me check…", "Looking at…") rather than a genuine conclusion.
 * Used by the silent-stall escape to promote only real conclusions.
 */
export function isPlanningLine(l: string): boolean {
    return /^(?:i(?:'ll| will| should| need to| am going to)|let me |looking |checking |searching |reading |the user |wait |actually |now i)/i.test(l);
}

/**
 * Escape HTML special characters (& < > ") for safe insertion into
 * innerHTML / template strings.
 */
export function escHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Heuristic: does this string look like a filesystem path (Windows drive
 * letter, absolute Unix path, or home-relative)?
 */
export function looksLikePath(s: string): boolean {
    return /^[a-zA-Z]:[\\/]|^[/~]/.test(s);
}

/**
 * Normalize a path for cross-platform comparison: unify slashes to the
 * platform separator and lowercase on Windows.
 */
export function normalizePath(p: string): string {
    let n = p.replace(/\//g, path.sep);
    if (process.platform === 'win32') { n = n.toLowerCase(); }
    return n;
}

/**
 * Extract required (positional, non-default) parameter names from a Python
 * function signature parameter string. Filters out `self`, keyword-only
 * (`*`/`**`), and parameters with default values (`=`).
 */
export function requiredParams(paramStr: string): string[] {
    return paramStr.split(',').map(p => p.trim()).filter(p => p && p !== 'self' && !p.includes('=') && !p.startsWith('*') && !p.startsWith('**'));
}

/**
 * Check if a string is an absolute filesystem path (Windows drive letter
 * or Unix root).
 */
export function isAbsPath(l: string): boolean {
    return /^[A-Za-z]:[\\\/]/.test(l) || l.startsWith('/');
}

/**
 * Check if a string looks like a file path: either an absolute path or
 * ends with a known source/config/data file extension.
 */
export function isFilePath(l: string): boolean {
    return /\.(py|ts|js|json|yaml|yml|md|txt|sh|toml|cfg|ini|html|css|sql|go|rs|java|rb|php|c|cpp|h|pyc)$/i.test(l) || isAbsPath(l);
}

/**
 * Convert a simple glob pattern to a RegExp. Supports `*`, `**`, `?`,
 * and literal dots. Used for file-extension and path matching.
 */
export function globToRegex(g: string): RegExp {
    return new RegExp(
        '^' + g.replace(/\./g, '\\.').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/\?/g, '.') + '$'
    );
}

/**
 * Convert a glob pattern to a RegExp with full double-star-slash (any-depth)
 * support. More precise than globToRegex: the double-star-slash sequence
 * becomes an optional path prefix, `*` becomes a single-segment wildcard,
 * and `?` becomes a single non-slash char. Backslashes are normalized to
 * forward slashes first.
 */
export function globToRegexDeep(g: string): RegExp {
    const normalized = g.replace(/\\/g, '/');
    const re = '^' + normalized
        .replace(/\./g, '\\.')
        .replace(/\?/g, '[^/]')
        .replace(/\*\*\//g, '(.+/)?')
        .replace(/\*\*/g, '.*')
        .replace(/\*/g, '[^/]*') + '$';
    return new RegExp(re);
}

/**
 * Extract search keywords from a user message: lowercase, split on
 * non-word chars, filter stop-words and short tokens, then apply simple
 * suffix stemming (ed/ing/tion/s) to improve grep hit rate.
 * Returns up to 3 unique stemmed keywords.
 */
export function extractKeywords(msg: string): string[] {
    const stopWords = new Set(['show','me','how','the','a','an','is','are','does','do','what','where','find','explain','describe','works','work','working','this','that','it','in','on','of','for','to','and','or','with','by','from','at','into','walk','through','implemented','tell','when','happens','happen','using','used','get','make','let','run','use','way','ways','give','want','need','have','has','can','will','would','should','could','been']);
    const kws = msg.toLowerCase().split(/\W+/).filter(w => w.length > 2 && !stopWords.has(w));
    const stemmed = kws.map(w => {
        if (w.endsWith('ed') && w.length > 4) { return w.slice(0, -2); }
        if (w.endsWith('ing') && w.length > 5) { return w.slice(0, -3); }
        if (w.endsWith('tion') && w.length > 6) { return w.slice(0, -4); }
        if (w.endsWith('s') && w.length > 4 && !w.endsWith('ss')) { return w.slice(0, -1); }
        return w;
    });
    return [...new Set(stemmed)].slice(0, 3);
}

/**
 * Generate a short git branch slug from a task description:
 * lowercase, strip non-alphanumeric, take first 5 words, join with
 * hyphens, cap at 40 chars.
 */
export function generateBranchSlug(taskMessage: string): string {
    return taskMessage
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .trim()
        .split(/\s+/)
        .slice(0, 5)
        .join('-')
        .slice(0, 40);
}

/**
 * StreamFilter — encapsulates the per-turn token filtering pipeline that was
 * previously inlined as closures inside Agent.run().
 *
 * Responsibilities:
 *   1. Strip leaked XML/tool-call artifacts from each token.
 *   2. Detect mid-stream spiral (runaway repetition) and signal abort.
 *   3. Buffer and suppress "thought process" header lines that small models
 *      emit before a real answer.
 *   4. Flush any remaining buffered content at end-of-stream.
 *
 * Usage:
 *   const sf = new StreamFilter(() => { agent.stopRef.stop = true; });
 *   const filtered = sf.filter(token);
 *   // ... after stream ends:
 *   const remaining = sf.flush();
 */
export class StreamFilter {
    private _streamLineBuf = '';
    private _spiralBuf = '';
    private _spiralAborted = false;
    private _inToolBlock = false;
    private _toolOpenCount = 0;
    private _toolCloseCount = 0;
    private _spiralCheckCounter = 0;
    private readonly MAX_LINE_BUF = 400;
    private readonly SPIRAL_CHECK_INTERVAL = 25;
    private readonly SUSPECT_PREFIX_RE = /^(?:[\u2728\u{1F914}\u{1F4AD}\u{1F4DD}\u{1F50D}\u{1F4CB}]|#{1,3}\s*(?:Thought|Think|Analysis|Summary|Reasoning)|Let me know|Happy to help|Feel free to ask|Hope (?:this|that) helps)/iu;

    constructor(private onAbort?: () => void) {}

    /** True if the spiral detector has fired (stream should be aborted). */
    get aborted(): boolean { return this._spiralAborted; }

    /**
     * Filter a single streamed token. Returns the visible text (may be empty
     * if the token was suppressed or is still being buffered).
     */
    filter(token: string): string {
        const t = stripXmlArtifacts(token);
        if (!t) { return ''; }

        // Mid-stream spiral abort: stop generation before garbage floods the chat
        if (this.checkSpiralMidStream(t)) {
            if (this.onAbort) { this.onAbort(); }
            return '';
        }

        this._streamLineBuf += t;

        // Fast path: if not in a suppressed block and buffer doesn't look suspicious, emit immediately.
        if (!this.SUSPECT_PREFIX_RE.test(this._streamLineBuf)) {
            const out = this._streamLineBuf;
            this._streamLineBuf = '';
            return out;
        }

        // Hold until we have a complete line or hit the safety limit
        if (!this._streamLineBuf.includes('\n') && this._streamLineBuf.length < this.MAX_LINE_BUF) {
            return ''; // still accumulating
        }

        // Process complete lines
        const parts = this._streamLineBuf.split('\n');
        this._streamLineBuf = parts.pop() ?? '';
        const filtered = parts.map(filterCompleteLine);
        const out = filtered.join('\n');
        return out || (parts.length > 0 ? '\n' : '');
    }

    /**
     * Flush any remaining buffered content (e.g. last line with no trailing \n).
     * Returns the flushed text (empty string if nothing buffered).
     */
    flush(): string {
        if (!this._streamLineBuf) { return ''; }
        const remaining = filterCompleteLine(this._streamLineBuf);
        this._streamLineBuf = '';
        return remaining;
    }

    private checkSpiralMidStream(text: string): boolean {
        if (this._spiralAborted) { return true; }
        this._spiralBuf += text;

        // Track <tool> depth incrementally instead of rescanning the whole buffer.
        if (text.includes('<tool>'))  { this._toolOpenCount  += (text.match(/<tool>/g)  ?? []).length; }
        if (text.includes('</tool>')) { this._toolCloseCount += (text.match(/<\/tool>/g) ?? []).length; }
        this._inToolBlock = this._toolOpenCount > this._toolCloseCount;
        if (this._inToolBlock) { return false; }

        // Wait for enough model-generated content before checking -- tool output
        // echoed in the first ~2000 chars (esp. thinking tokens about SSH/JSON output)
        // can contain repeated tokens and must not trigger abort.
        if (this._spiralBuf.length < 2000) { return false; }

        // Throttle: run expensive checks only every SPIRAL_CHECK_INTERVAL tokens.
        if ((++this._spiralCheckCounter % this.SPIRAL_CHECK_INTERVAL) !== 0) { return false; }

        // Check for inline repetition only in the tail -- avoids false-positives on
        // tool-result data echoed near the start of the response.
        const tail = this._spiralBuf.slice(-600);
        if (/(.{15,60})\1{5,}/.test(tail)) { this._spiralAborted = true; return true; }
        // Check for line repetition: same line 5+ times in recent output (raised from 4
        // to reduce false-positives on SSH/log/JSON output with naturally repeated structure).
        const recentLines = this._spiralBuf.slice(-1200).split('\n').map(l => l.trim()).filter(l => l.length > 15);
        if (recentLines.length >= 8) {
            const freq: Record<string, number> = {};
            for (const l of recentLines) { freq[l] = (freq[l] ?? 0) + 1; }
            if (Object.values(freq).some(c => c >= 5)) { this._spiralAborted = true; return true; }
        }
        return false;
    }
}

/**
 * Repair collapsed-JSON args that small models (qwen3, gemma4) sometimes emit
 * for read_file / shell_read / write_file / edit_file. The model puts all args
 * into a single key's value as a collapsed JSON string.
 *
 * Also coerces numeric offset/limit strings to numbers.
 * Returns the (possibly repaired) args object.
 */
export function repairCollapsedArgs(
    name: string,
    args: Record<string, unknown>,
    logWarn: (msg: string) => void,
): Record<string, unknown> {
    if (name !== 'read_file' && name !== 'shell_read' && name !== 'write_file' && name !== 'edit_file') {
        return args;
    }
    const argKeys = Object.keys(args);
    if (argKeys.length === 1) {
        const soleKey = argKeys[0];
        const soleVal = String(args[soleKey] ?? '');
        if (/,\s*"[\w_]+":\s/.test(soleVal) || /,\s*\\?"[\w_]+"/.test(soleVal)) {
            try {
                const jsonAttempt = `{${JSON.stringify(soleKey)}: ${/^\d+$/.test(soleVal.split(',')[0].trim()) ? soleVal : `"${soleVal.replace(/"/g, '\\"')}"`}}`;
                const reconstructed = JSON.parse(jsonAttempt);
                if (Object.keys(reconstructed).length > 1) {
                    logWarn(`[agent] Repaired collapsed ${name} args from single-key "${soleKey}"`);
                    args = reconstructed;
                }
            } catch {
                try {
                    const unescaped = soleVal.replace(/\\"/g, '"');
                    const fragment = `{${JSON.stringify(soleKey)}: ${unescaped.includes(',') ? unescaped : `"${unescaped}"`}}`;
                    const recovered = JSON.parse(fragment);
                    if (recovered && Object.keys(recovered).length > 1) {
                        logWarn(`[agent] Repaired collapsed ${name} args (fragment method) from "${soleKey}"`);
                        args = recovered;
                    }
                } catch { /* leave as-is */ }
            }
        }
    }
    if (typeof args.offset === 'string' && /^\d+$/.test(args.offset)) { args = { ...args, offset: parseInt(args.offset, 10) }; }
    if (typeof args.limit === 'string' && /^\d+$/.test(args.limit)) { args = { ...args, limit: parseInt(args.limit, 10) }; }
    return args;
}

/**
 * Return the project check command for a given source file extension.
 * Used by the 3.1/3.6 verify-reminder that is appended after successful
 * edit_file / write_file / edit_file_at_line calls.
 */
export function getVerifyCommand(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
    switch (ext) {
        case 'py': return '`python -m pytest -v` (or `ruff check .` if a linter is configured)';
        case 'ts': case 'tsx': return '`npx tsc --noEmit` (or `npm run compile`)';
        case 'js': case 'jsx': return '`npx tsc --noEmit` (or `npm run lint`)';
        case 'go': return '`go build ./...` and `go test ./...`';
        case 'rs': return '`cargo check` and `cargo test`';
        case 'java': return '`mvn compile` (or `gradle build`)';
        case 'rb': return '`bundle exec rspec` (or `ruby -c <file>` for syntax)';
        case 'cs': return '`dotnet build`';
        case 'cpp': case 'cc': case 'c': case 'h': case 'hpp': return '`g++ -fsyntax-only <file>` (or the project build)';
        case 'scad': return '`openscad -o /tmp/check.stl <file>`';
        case 'yaml': case 'yml': return '`python3 -c "import yaml,sys; yaml.safe_load(open(sys.argv[1]))" <file>`';
        case 'json': return '`python3 -m json.tool <file>`';
        case 'sh': case 'sql': return '`bash -n <file>` (sh) or the project DB linter (sql)';
        default: return 'the project check command from your system prompt';
    }
}

/**
 * Compute a short stable digest for a (tool_name, args) pair so that
 * repeated identical calls can be counted.
 */
export function toolCallDigest(name: string, args: Record<string, unknown>): string {
    // Sort keys for a stable canonical form regardless of insertion order.
    const canonical = JSON.stringify({ name, args: stableStringify(args) });
    return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

/** Recursively sort object keys so JSON.stringify is order-independent. */
export function stableStringify(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(stableStringify);
    }
    if (value && typeof value === 'object') {
        const obj = value as Record<string, unknown>;
        const sorted: Record<string, unknown> = {};
        for (const k of Object.keys(obj).sort()) {
            sorted[k] = stableStringify(obj[k]);
        }
        return sorted;
    }
    return value;
}

/**
 * Truncate a tool-result string for history injection.
 *
 * Applies (in order):
 *   1. Merge-mode line cap (shell_read only, when mergeMode is true)
 *   2. Large directory-listing cap (shell_read only, ls/find output)
 *   3. Head+tail char cap (any tool, when result exceeds maxChars)
 *
 * Returns the (possibly truncated) string.
 */
export function truncateToolResult(
    toolResult: string,
    toolName: string,
    command: string,
    opts: {
        mergeMode: boolean;
        maxChars: number;
        headChars: number;
        tailChars: number;
        mergeMaxLines?: number;
        mergeSuffix?: string;
        listingSuffix?: string;
    },
): string {
    let result = toolResult;

    // 1. Merge-mode line cap
    if (opts.mergeMode && toolName === 'shell_read' && result.length > 6000) {
        const lines = result.split('\n');
        const MAX_LINES = opts.mergeMaxLines ?? 120;
        if (lines.length > MAX_LINES) {
            const kept = lines.slice(0, MAX_LINES).join('\n');
            result = kept + `\n\n[TRUNCATED -- file has ${lines.length} lines, showing first ${MAX_LINES}.${opts.mergeSuffix ?? ''}]`;
        }
    }

    // 2. Large directory-listing cap
    if (toolName === 'shell_read' && result.length > 3000) {
        const isListingOutput = /\bls\b|\bfind\b/i.test(command) && !/grep|cat\b|head\b|tail\b|sed\b|awk\b/.test(command);
        if (isListingOutput) {
            const lines = result.split('\n').filter(l => l.trim());
            if (lines.length > 50) {
                const sample = lines.slice(0, 50).join('\n');
                result = sample + `\n\n[LISTING TRUNCATED -- ${lines.length} items total, showing first 50.${opts.listingSuffix ?? ''}]`;
            }
        }
    }

    // 3. Head+tail char cap
    if (result.length > opts.maxChars && !result.includes('[TRUNCATED') && !result.includes('[LISTING TRUNCATED')) {
        const head = result.slice(0, opts.headChars);
        const tail = result.slice(-opts.tailChars);
        const omitted = result.length - opts.headChars - opts.tailChars;
        result = `${head}\n\n[...${omitted} chars omitted...]\n\n${tail}`;
    }

    return result;
}

/**
 * Levenshtein edit distance between two strings.
 * Used for typo detection (filename suggestions, SSH path validation).
 */
export function levenshtein(a: string, b: string): number {
    const m = a.length, n = b.length;
    const dp: number[][] = Array.from({ length: m + 1 }, (_, i) => Array(n + 1).fill(0).map((_, j) => i === 0 ? j : j === 0 ? i : 0));
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
        }
    }
    return dp[m][n];
}
