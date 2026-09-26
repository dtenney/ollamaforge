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
 *
 * NOTE: The full loop body (executeTurn) is intentionally NOT extracted here —
 * it is too tightly coupled to run()'s local scope (1,181 `this.` refs, 135
 * external locals). See plans/run-decomposition.md for the phased plan.
 */

import * as path from 'path';

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
