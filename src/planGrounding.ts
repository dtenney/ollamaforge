/**
 * planGrounding.ts — Verify that file paths and symbols referenced in a plan
 * actually exist in the codebase before execution begins.
 *
 * Problem: Small models hallucinate file paths and symbol names in plans,
 * then loop 5+ rounds of 0-match greps / failed edits hunting for them.
 *
 * Approach (adapted from Reika's groundcheck.ts):
 *   1. Extract all backticked spans from the plan text (strips code blocks first).
 *   2. Classify each span as a file path or code symbol.
 *   3. Suppress "not found" flags for NEW files (create/scaffold/generate verbs, test/spec files).
 *   4. Verify paths via fs.stat(); verify symbols via bounded workspace scan.
 *   5. If ≥80% of refs are missing AND ≥4 are missing → suppress (greenfield repo).
 *   6. Return an advisory string to inject before execution.
 */

import * as fs from 'fs';
import * as path from 'path';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PlanRef {
    raw: string;
    kind: 'path' | 'symbol';
    found: boolean;
    isNew: boolean; // plan introduces it as new (create/scaffold/generate)
}

export interface GroundingResult {
    refs: PlanRef[];
    missing: PlanRef[];
    advisory: string | null; // null = no advisory needed
}

// ─── Extraction ──────────────────────────────────────────────────────────────

const NEW_FILE_VERBS = /\b(create|scaffold|generate|add|write|implement|build|make|new)\b/i;
const TEST_SPEC_RE = /(^|\/)(test|spec|__tests__|tests|e2e|cypress|playwright)\b/i;

/**
 * Extract backticked spans from plan text.
 * Strips triple-backtick code blocks first to avoid extracting code content.
 */
export function extractPlanRefs(planText: string): string[] {
    // Remove fenced code blocks (```...```)
    const stripped = planText.replace(/```[\s\S]*?```/g, '');
    // Extract single-backtick spans
    const matches = stripped.match(/`([^`\n]+)`/g) ?? [];
    return matches.map(m => m.slice(1, -1).trim()).filter(s => s.length > 1 && s.length < 200);
}

/**
 * Classify a span as a file path or a code symbol.
 */
export function classifyRef(span: string): 'path' | 'symbol' {
    // File path: has a slash and a file extension, or is an absolute path
    if (span.includes('/') || span.includes('\\')) {
        const ext = span.split('.').pop()?.toLowerCase() ?? '';
        if (ext.length >= 2 && ext.length <= 10 && /^[a-z0-9]+$/.test(ext)) {
            return 'path';
        }
    }
    // Windows drive letter path
    if (/^[A-Za-z]:[\\/]/.test(span)) { return 'path'; }
    // Code symbol: camelCase, snake_case, PascalCase with internal cap
    if (/^[a-z]+(?:[A-Z][a-z0-9]*)+$/.test(span)) { return 'symbol'; } // camelCase
    if (/^[a-z]+(?:_[a-z0-9]+)+$/.test(span)) { return 'symbol'; } // snake_case
    if (/^[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+$/.test(span)) { return 'symbol'; } // PascalCase with internal cap
    // Default: treat as path if it has an extension, else symbol
    if (/\.\w{2,10}$/.test(span)) { return 'path'; }
    return 'symbol';
}

/**
 * Check if the plan context suggests this ref is a NEW file (not expected to exist yet).
 */
export function isNewFileRef(span: string, planText: string): boolean {
    // Test/spec files are often new
    if (TEST_SPEC_RE.test(span)) { return true; }
    // Check if the line containing this span has a "new file" verb
    const lines = planText.split('\n');
    for (const line of lines) {
        if (line.includes(span) && NEW_FILE_VERBS.test(line)) { return true; }
    }
    return false;
}

// ─── Verification ────────────────────────────────────────────────────────────

/**
 * Check if a file path exists relative to the workspace root.
 */
export function verifyPath(span: string, workspaceRoot: string): boolean {
    // Try as-is (absolute or relative)
    const candidates = [
        span,
        path.join(workspaceRoot, span),
        path.join(workspaceRoot, span.replace(/\\/g, '/')),
    ];
    for (const c of candidates) {
        try {
            if (fs.statSync(c).isFile()) { return true; }
        } catch { /* not found */ }
    }
    return false;
}

/**
 * Verify a symbol exists in the workspace by scanning source files.
 * Bounded: max 64 MB total, 1 MB per file, short-circuits when found.
 */
export function verifySymbol(span: string, workspaceRoot: string): boolean {
    const MAX_TOTAL = 64 * 1024 * 1024; // 64 MB
    const MAX_FILE = 1 * 1024 * 1024; // 1 MB per file
    let totalRead = 0;
    const exts = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.rb', '.c', '.cpp', '.h', '.cs', '.php', '.sh']);

    function walk(dir: string): boolean {
        if (totalRead > MAX_TOTAL) { return false; }
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
        catch { return false; }

        for (const e of entries) {
            if (totalRead > MAX_TOTAL) { return false; }
            if (e.name.startsWith('.') || e.name === 'node_modules') { continue; }
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (walk(full)) { return true; }
            } else if (e.isFile()) {
                const ext = path.extname(e.name).toLowerCase();
                if (!exts.has(ext)) { continue; }
                try {
                    const stat = fs.statSync(full);
                    if (stat.size > MAX_FILE) { continue; }
                    totalRead += stat.size;
                    const content = fs.readFileSync(full, 'utf-8');
                    // Look for the symbol as a word boundary match
                    const re = new RegExp(`\\b${span.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
                    if (re.test(content)) { return true; }
                } catch { /* skip unreadable */ }
            }
        }
        return false;
    }

    return walk(workspaceRoot);
}

// ─── Main Entry Point ────────────────────────────────────────────────────────

/**
 * Run the full grounding check on a plan text.
 * Returns a GroundingResult with the advisory (or null if no issues).
 */
export function runGroundingCheck(planText: string, workspaceRoot: string): GroundingResult {
    const rawRefs = extractPlanRefs(planText);
    const refs: PlanRef[] = [];

    for (const span of rawRefs) {
        const kind = classifyRef(span);
        const isNew = isNewFileRef(span, planText);

        let found: boolean;
        if (kind === 'path') {
            found = verifyPath(span, workspaceRoot);
        } else {
            found = verifySymbol(span, workspaceRoot);
        }

        refs.push({ raw: span, kind, found, isNew });
    }

    // Missing refs = not found AND not new
    const missing = refs.filter(r => !r.found && !r.isNew);

    // Greenfield suppression: if ≥80% missing AND ≥4 missing, it's a new project
    if (refs.length >= 4 && missing.length >= 4 && (missing.length / refs.length) >= 0.8) {
        return { refs, missing, advisory: null };
    }

    if (missing.length === 0) {
        return { refs, missing, advisory: null };
    }

    // Build advisory
    const names = missing.map(r => `\`${r.raw}\``).join(', ');
    const advisory =
        `⚠️ **Plan grounding check:** These names in the plan were not found in the codebase: ${names}. ` +
        `They may be intended as NEW code, or renamed/misremembered. ` +
        `Before editing, confirm the real names against the actual files — do not loop searching for them if they are not there.`;

    return { refs, missing, advisory };
}
