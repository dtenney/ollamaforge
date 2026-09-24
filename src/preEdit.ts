// src/preEdit.ts
// Pre-edit helpers extracted from agent.ts (Phase 2, agent-decomposition-plan.md).
//
// These were private Agent methods. Each is now a standalone function. Methods that
// previously read `this.workspaceRoot` now take it as an explicit `root` parameter;
// the Agent's thin private methods pass `this.workspaceRoot` through, preserving behavior.
//
//   findFileByName(filename, root)                          -> string | null
//   findEditCandidates(filenameKeywords, extensions, fullServiceName?, root)
//                                                            -> Array<{ relPath, absPath, score }>
//   sweepAddErrorHandling(userMessage, post, root, history) -> Promise<boolean>

import * as path from 'path';
import * as fs from 'fs';
import { logInfo, logWarn, toErrorMessage } from './logger';
import { SKIP_DIRS } from './workspace';
import { OllamaMessage } from './ollamaClient';
import { TieredMemoryManager } from './memoryCore';
import { CodeIndexer } from './codeIndex';

export type PostFn = (msg: object) => void;

/**
 * Walk the workspace and find a file whose basename exactly matches `filename`.
 * Returns the absolute path, or null if not found.
 */
export function findFileByName(filename: string, root: string): string | null {
    const target = filename.toLowerCase();
    const walk = (dir: string): string | null => {
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
        for (const e of entries) {
            if (SKIP_DIRS.has(e.name)) { continue; }
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
                const found = walk(full);
                if (found) { return found; }
            } else if (e.name.toLowerCase() === target) {
                return full;
            }
        }
        return null;
    };
    return walk(root);
}

/**
 * Walk the workspace and find files whose names match the given keywords.
 * Returns candidates scored by filename relevance, sorted descending.
 */
export function findEditCandidates(
    filenameKeywords: string[],
    extensions: string[],
    fullServiceName?: string,   // e.g. "thermal_receipt" -- scores highest on exact basename match
    root?: string
): Array<{ relPath: string; absPath: string; score: number }> {
    const results: Array<{ relPath: string; absPath: string; score: number }> = [];
    if (!root) { return results; }
    const extSet = new Set(extensions.map(e => e.toLowerCase()));

    const walk = (dir: string, depth: number) => {
        if (depth > 8) { return; }
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
            if (SKIP_DIRS.has(entry.name)) { continue; }
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full, depth + 1);
            } else if (entry.isFile()) {
                const ext = path.extname(entry.name).toLowerCase();
                if (!extSet.has(ext)) { continue; }
                const rel = path.relative(root, full).replace(/\\/g, '/');
                const baseLower = entry.name.toLowerCase().replace(/\.\w+$/, '');
                const relLower = rel.toLowerCase();
                let score = 0;
                // Highest priority: basename starts with or equals the full service name
                if (fullServiceName) {
                    if (baseLower === fullServiceName || baseLower === fullServiceName + '_service') { score += 30; }
                    else if (baseLower.startsWith(fullServiceName)) { score += 20; }
                    else if (baseLower.includes(fullServiceName))   { score += 15; }
                }
                // Per-keyword scoring
                for (const kw of filenameKeywords) {
                    if (baseLower === kw)             { score += 10; } // exact match
                    else if (baseLower.startsWith(kw + '_') || baseLower.endsWith('_' + kw)) { score += 8; } // word boundary
                    else if (baseLower.includes(kw))  { score += 5;  } // partial in name
                    else if (relLower.includes(kw))   { score += 2;  } // in path
                }
                // Penalise archive/backup/old dirs -- never the right file
                if (/archive|backup|old.code|\.bak/i.test(relLower)) { score = Math.max(0, score - 20); }
                // Penalise test files -- prefer source/service files for edit tasks
                if (/(?:^|\/)(tests?|__tests?__|spec)\//i.test(relLower) || /[._](test|spec)\.\w+$/.test(relLower)) { score = Math.max(0, score - 6); }
                if (score > 0) { results.push({ relPath: rel, absPath: full, score }); }
            }
        }
    };
    walk(root, 0);
    results.sort((a, b) => b.score - a.score);
    return results;
}

/**
 * Programmatically wrap Python route functions that lack try/except error handling.
 * Operates directly on the file -- no model involvement for the wrapping logic.
 * Returns true if it handled the task (caller should skip the model loop).
 */
export async function sweepAddErrorHandling(
    userMessage: string,
    post: PostFn,
    root: string,
    history: OllamaMessage[]
): Promise<boolean> {
    if (!root) { logInfo('[error-sweep] no workspaceRoot -- skipping'); return false; }

    // Resolve target file from explicit path in message
    const fileMatch = userMessage.match(/\b([\w./\\-]+\.py)\b/i);
    if (!fileMatch) { logInfo('[error-sweep] no .py file found in message -- skipping'); return false; }

    const relPath = fileMatch[1].replace(/\\/g, '/');
    const absPath = path.resolve(root, relPath);
    logInfo(`[error-sweep] target: ${relPath} -> ${absPath} (exists: ${fs.existsSync(absPath)})`);
    if (!fs.existsSync(absPath)) { return false; }

    const originalContent = fs.readFileSync(absPath, 'utf8');
    const lines = originalContent.split('\n');

    // Parse route functions
    // Find each def that is part of a route (has @*.route decorator above it).
    // For each, find its body extent and check if already wrapped in try/except.
    interface RouteFunc {
        defLine: number;       // 0-based index of "def ..." line
        bodyStart: number;     // 0-based index of first body line
        bodyEnd: number;       // 0-based index of last body line (inclusive)
        indent: string;        // indentation of the def line
        hasErrorHandling: boolean;
    }

    const routeFuncs: RouteFunc[] = [];

    for (let i = 0; i < lines.length; i++) {
        const defMatch = lines[i].match(/^(\s*)def\s+\w+\s*\(/);
        if (!defMatch) { continue; }

        // Check if preceded by a @*.route decorator (within 5 lines)
        let isRoute = false;
        for (let k = Math.max(0, i - 5); k < i; k++) {
            if (/^\s*@\w+\.route\(/.test(lines[k])) { isRoute = true; break; }
        }
        if (!isRoute) { continue; }

        const indent = defMatch[1];
        const bodyIndent = indent + '    ';

        // Find body start -- first non-blank, non-docstring line after def
        let bodyStart = i + 1;
        // Skip docstring if present
        if (lines[bodyStart]?.trim().startsWith('"""') || lines[bodyStart]?.trim().startsWith("'''")) {
            const quote = lines[bodyStart].trim().startsWith('"""') ? '"""' : "'''";
            if ((lines[bodyStart].match(new RegExp(quote, 'g')) ?? []).length >= 2) {
                bodyStart++; // single-line docstring
            } else {
                bodyStart++;
                while (bodyStart < lines.length && !lines[bodyStart].includes(quote)) { bodyStart++; }
                bodyStart++; // past closing triple-quote
            }
        }

        // Find body end -- last line before next def/decorator at same or lesser indent
        let bodyEnd = bodyStart;
        for (let j = bodyStart; j < lines.length; j++) {
            const trimmed = lines[j].trim();
            if (trimmed === '') { continue; }
            // Next function/class at same indent level = end of this function
            if (/^(@|\bdef\b|\bclass\b)/.test(trimmed) && !lines[j].startsWith(bodyIndent)) { break; }
            bodyEnd = j;
        }

        // Check if body is already wrapped in try/except
        const hasErrorHandling = /^\s*try\s*:/.test(lines[bodyStart] ?? '');

        routeFuncs.push({ defLine: i, bodyStart, bodyEnd, indent, hasErrorHandling });
    }

    const toWrap = routeFuncs.filter(f => !f.hasErrorHandling);
    if (toWrap.length === 0) {
        // All routes already have error handling -- tell the user
        post({ type: 'streamStart' });
        const msg = `All ${routeFuncs.length} route(s) in \`${relPath}\` already have error handling. No changes needed.`;
        for (const ch of msg) { post({ type: 'token', text: ch }); }
        post({ type: 'streamEnd' });
        history.push({ role: 'assistant', content: msg });
        return true;
    }

    logInfo(`[error-sweep] ${relPath}: ${routeFuncs.length} routes, ${toWrap.length} need wrapping`);

    // Post a visible context read
    const readId = `sweep_read_${Date.now()}`;
    post({ type: 'toolCall', id: readId, name: 'shell_read', args: { command: `cat "${relPath}"` } });
    post({ type: 'toolResult', id: readId, name: 'shell_read', success: true, preview: `${lines.length} lines, ${toWrap.length} routes need error handling` });

    // Apply wraps bottom-up (so line indices stay valid)
    const newLines = [...lines];
    const wrapped: string[] = [];

    for (const fn of [...toWrap].reverse()) {
        const bodyIndent = fn.indent + '    ';
        const bodyLines = newLines.slice(fn.bodyStart, fn.bodyEnd + 1);

        // Indent each body line by 4 more spaces
        const indentedBody = bodyLines.map(l => l === '' ? l : '    ' + l);

        // Build replacement: try: + indented body + except clause
        const tryBlock = [
            `${bodyIndent}try:`,
            ...indentedBody,
            `${bodyIndent}except Exception as e:`,
            `${bodyIndent}    return jsonify({'error': str(e)}), 500`,
        ];

        // Get the function name for reporting
        const fnName = newLines[fn.defLine].match(/def\s+(\w+)/)?.[1] ?? '?';
        wrapped.unshift(fnName); // unshift because we iterate in reverse
        newLines.splice(fn.bodyStart, fn.bodyEnd - fn.bodyStart + 1, ...tryBlock);

        // Post a visible edit
        const editId = `sweep_edit_${Date.now()}_${fn.defLine}`;
        post({
            type: 'toolCall',
            id: editId, name: 'edit_file_at_line',
            args: { path: relPath, start_line: fn.bodyStart + 1, end_line: fn.bodyEnd + 1 }
        });
        post({ type: 'toolResult', id: editId, name: 'edit_file_at_line', success: true, preview: `Wrapped ${fnName} in try/except` });
    }

    // Write the modified file
    fs.writeFileSync(absPath, newLines.join('\n'), 'utf8');
    logInfo(`[error-sweep] Wrote ${newLines.length} lines to ${relPath}`);

    // Summary message
    const summary = `Added error handling to **${wrapped.length}** route(s) in \`${relPath}\`:\n${wrapped.map(n => `- \`${n}\``).join('\n')}\n\n${routeFuncs.length - toWrap.length > 0 ? `${routeFuncs.length - toWrap.length} route(s) already had try/except and were left unchanged.` : ''}`.trim();
    post({ type: 'streamStart' });
    for (const ch of summary) { post({ type: 'token', text: ch }); }
    post({ type: 'streamEnd' });
    history.push({ role: 'assistant', content: summary });
    return true;
}

/**
 * Context object passed to preProcessEditTask -- replaces the `this.*` references
 * that the method had when it was a private Agent method.
 */
export interface PreEditContext {
    root: string;
    memory: TieredMemoryManager | null;
    codeIndexer: CodeIndexer | null;
    activeTask: {
        message: string;
        type: 'add_field' | 'fix_bug' | 'add_route' | 'refactor' | 'query' | 'other';
        filesConfirmed: string[];
        filesRuledOut: string[];
        stepsCompleted: string[];
        stepsPending: string[];
        taskId?: string;
    } | null;
    findFileByName: (filename: string, root: string) => string | null;
    findEditCandidates: (filenameKeywords: string[], extensions: string[], fullServiceName?: string) => Array<{ relPath: string; absPath: string; score: number }>;
    buildModelRelationshipMap: (root: string) => Array<{ className: string; relations: string[] }>;
    walkCallGraph: (seedFn: string, excludeRelPath: string, root: string, maxHops: number, maxNodes: number) => { lines: string[]; maxHop: number };
}

/**
 * Pre-process an edit task: resolve the target file, detect stubs, scan for
 * existing routes/functions/fields, build a caller-impact report, and assemble
 * a rich context injection for the model.
 *
 * Extracted from Agent.preProcessEditTask (Phase 2, agent-decomposition-plan.md).
 * The `this.*` references are now parameterized via the `ctx` argument.
 */
export async function preProcessEditTask(
    userMessage: string,
    post: PostFn,
    ctx: PreEditContext
): Promise<{ injection: string; blocked: string | null; pendingSteps: string[] }> {
        const root = ctx.root;

        // â"€â"€ 1. Extract keywords â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
        const filenameKeywords: string[] = [];

        const serviceMatch = userMessage.match(
            /\b(?:the\s+)?(\w+(?:[\s_-]\w+)*?)\s+(?:service|module|handler|controller|view|model|util|helper|component|route|router|api)\b/i
        );
        if (serviceMatch) {
            const svc = serviceMatch[1].toLowerCase().replace(/\s+/g, '_');
            filenameKeywords.push(svc);
            svc.split(/[_-]/).filter(w => w.length > 2).forEach(w => filenameKeywords.push(w));
        }

        const fileMatch = userMessage.match(/\b([\w./\\-]+\.(?:py|ts|js|go|java|rs|rb|php|c|cpp|cs))\b/i);
        if (fileMatch) {
            filenameKeywords.push(path.basename(fileMatch[1]).replace(/\.\w+$/, '').toLowerCase());
        }

        const STOP = new Set(['add','insert','fix','update','change','modify','implement',
            'the','a','an','to','in','on','of','for','whenever','when','every','time',
            'that','this','so','and','or','with','by','from','at','into','should',
            'would','could','will','can','all','any','some','statement','log','logging',
            'make','sure','please','just','need','want','also','returns','return',
            'list','json','endpoint','function','method']);
        const contentKws = userMessage.toLowerCase().split(/\W+/).filter(w => w.length > 3 && !STOP.has(w)).slice(0, 5);
        if (filenameKeywords.length === 0) { filenameKeywords.push(...contentKws); }

        // â"€â"€ 2. Detect project type â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
        const hasTs = fs.existsSync(path.join(root, 'tsconfig.json')) || fs.existsSync(path.join(root, 'package.json'));
        const hasPy = fs.existsSync(path.join(root, 'pyproject.toml')) || fs.existsSync(path.join(root, 'requirements.txt')) || fs.existsSync(path.join(root, 'setup.py'));
        const extensions = hasPy ? ['.py'] : hasTs ? ['.ts', '.js', '.tsx', '.jsx'] : ['.py', '.ts', '.js', '.go', '.java', '.rs'];

        if (filenameKeywords.length === 0) { return { injection: '', blocked: null, pendingSteps: [] }; }

        const fullServiceName = serviceMatch ? serviceMatch[1].toLowerCase() : undefined;

        // â"€â"€ 3. Resolve target file â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
        // Explicit path beats everything -- resolve directly and skip semantic search
        let targetRelPath: string | null = null;
        let targetContent: string | null = null;

        if (fileMatch) {
            const explicitRel = fileMatch[1].replace(/\\/g, '/');
            const explicitAbs = path.resolve(root, explicitRel);
            if (fs.existsSync(explicitAbs) && fs.statSync(explicitAbs).size <= 150_000) {
                targetRelPath = explicitRel;
                targetContent = fs.readFileSync(explicitAbs, 'utf8');
                logInfo(`[pre-edit] Explicit file: ${explicitRel} (${targetContent.split('\n').length} lines)`);
            } else if (!explicitRel.includes('/') && !explicitRel.includes('\\')) {
                // Bare filename (e.g. "user.py") -- search the workspace for it
                const found = ctx.findFileByName(explicitRel, root);
                if (found) {
                    try {
                        const stat = fs.statSync(found);
                        if (stat.size <= 150_000) {
                            targetContent = fs.readFileSync(found, 'utf8');
                            targetRelPath = path.relative(root, found).replace(/\\/g, '/');
                            logInfo(`[pre-edit] Bare filename resolved: ${targetRelPath}`);
                        }
                    } catch { /* skip */ }
                }
            }
        }

        if (!targetRelPath) {
            // Semantic/keyword search
            logInfo(`[pre-edit] Searching -- keywords: [${filenameKeywords.join(', ')}], exts: [${extensions.join(', ')}]`);
            let candidates: Array<{ relPath: string; absPath: string; score: number }>;
            if (ctx.codeIndexer) {
                const indexResults = await ctx.codeIndexer.findRelevantFiles(userMessage, 5);
                candidates = indexResults.map(r => ({ relPath: r.relPath, absPath: r.absPath, score: Math.round(r.score * 100) }));
                if (candidates.length === 0) {
                    candidates = ctx.findEditCandidates(filenameKeywords, extensions, fullServiceName);
                }
            } else {
                candidates = ctx.findEditCandidates(filenameKeywords, extensions, fullServiceName);
            }

            if (candidates.length === 0) {
                logInfo('[pre-edit] No candidates found -- falling through');
                return { injection: '', blocked: null, pendingSteps: [] };
            }

            // Re-rank: if any candidate's basename exactly matches a filename keyword,
            // always prefer it -- semantic index may rank semantically similar files higher
            // than the exact filename match (e.g. device.py ranked above user.py for "User model")
            const exactMatch = candidates.find(c => {
                const base = path.basename(c.relPath, path.extname(c.relPath)).toLowerCase();
                return filenameKeywords.some(kw => base === kw);
            });
            if (exactMatch) {
                candidates = [exactMatch, ...candidates.filter(c => c !== exactMatch)];
            }

            // Read top candidates, pick highest content-keyword score
            for (const c of candidates.slice(0, 3)) {
                try {
                    const stat = fs.statSync(c.absPath);
                    if (stat.size > 150_000) { continue; }
                    const content = fs.readFileSync(c.absPath, 'utf8');
                    const lower = content.toLowerCase();
                    const hits = contentKws.reduce((acc, w) => {
                        let n = 0, pos = 0;
                        while ((pos = lower.indexOf(w, pos)) !== -1) { n++; pos++; }
                        return acc + n;
                    }, 0);
                    if (!targetRelPath || hits > 0) {
                        targetRelPath = c.relPath;
                        targetContent = content;
                        if (hits > 0) { break; } // good enough
                    }
                } catch { /* skip */ }
            }
        }

        if (!targetRelPath || !targetContent) {
            logInfo('[pre-edit] Could not read target file -- falling through');
            return { injection: '', blocked: null, pendingSteps: [] };
        }

        // â"€â"€ 3b. Proactive stub detection â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
        // If the resolved file is a stub (< 15 lines, no real HTML markers), find the real file
        // and redirect the model BEFORE it ever sees the stub content.
        const isHtmlTarget = /\.html$/i.test(targetRelPath);
        let stubWarning = '';
        let stubRealFile: { relPath: string; content: string } | null = null;
        if (isHtmlTarget) {
            const stubLineCount = targetContent.split('\n').length;
            const hasRealMarkers = /<!DOCTYPE|<html|{%\s*extends|{%\s*block/i.test(targetContent);
            if (stubLineCount < 15 && !hasRealMarkers) {
                logInfo(`[pre-edit] Stub detected: ${targetRelPath} (${stubLineCount} lines, no HTML markers) -- searching for real template`);
                // Extract a keyword from the stub to drive the search
                const stubKw = targetContent.match(/\{\{\s*form\.(\w+)|id=["'](\w+)["']|name=["'](\w+)["']/)?.[1]
                    ?? path.basename(targetRelPath, '.html').replace(/[_-]/g, ' ');
                // Walk app/templates recursively for large HTML files containing the keyword
                const templatesDir = path.join(root, 'app', 'templates');
                if (fs.existsSync(templatesDir)) {
                    const walkHtml = (dir: string): string[] => {
                        const results: string[] = [];
                        try {
                            for (const f of fs.readdirSync(dir)) {
                                const abs = path.join(dir, f);
                                try {
                                    const st = fs.statSync(abs);
                                    if (st.isDirectory()) { results.push(...walkHtml(abs)); }
                                    else if (f.endsWith('.html') && st.size > 5_000) { results.push(abs); }
                                } catch { /* skip */ }
                            }
                        } catch { /* skip */ }
                        return results;
                    };
                    const htmlFiles = walkHtml(templatesDir);
                    for (const absHtml of htmlFiles) {
                        try {
                            const c = fs.readFileSync(absHtml, 'utf8');
                            if (/<!DOCTYPE|<html|{%\s*extends|{%\s*block/i.test(c) && c.toLowerCase().includes(stubKw.toLowerCase())) {
                                const rel = path.relative(root, absHtml).replace(/\\/g, '/');
                                stubRealFile = { relPath: rel, content: c };
                                logInfo(`[pre-edit] Real template found: ${rel}`);
                                break;
                            }
                        } catch { /* skip */ }
                    }
                }
                if (stubRealFile) {
                    const stubOrigPath = targetRelPath;
                    stubWarning = `âš  STUB REDIRECT: "${stubOrigPath}" is a stub placeholder (${stubLineCount} lines, no HTML structure). ` +
                        `The real template is "${stubRealFile.relPath}". ` +
                        `Do NOT edit the stub -- all edits must go to the real file shown below.`;
                    // Swap target to the real file
                    targetRelPath = stubRealFile.relPath;
                    targetContent = stubRealFile.content;
                    logInfo(`[pre-edit] Redirected target from stub to: ${targetRelPath}`);
                    // Update task state machine
                    if (ctx.activeTask) {
                        if (!ctx.activeTask.filesRuledOut.includes(stubOrigPath)) {
                            ctx.activeTask.filesRuledOut.push(stubOrigPath);
                        }
                        if (!ctx.activeTask.filesConfirmed.includes(targetRelPath)) {
                            ctx.activeTask.filesConfirmed.push(targetRelPath);
                        }
                    }
                    // Save discovery to memory
                    if (ctx.memory) {
                        const memNote = `Stub redirect: stub at "${stubOrigPath}" -> real template: "${stubRealFile.relPath}" (${stubRealFile.content.split('\n').length} lines).`;
                        ctx.memory.addEntry(2, memNote, ['stub', 'template', 'auto-discovery']).catch((e) => logWarn(`[memory] background write failed: ${toErrorMessage(e)}`));
                    }
                } else {
                    stubWarning = `âš  STUB WARNING: "${targetRelPath}" appears to be a stub placeholder (${stubLineCount} lines, no HTML structure). ` +
                        `Search app/templates/ for the real template before editing.`;
                }
            }
        }

        // â"€â"€ 4. Research phase -- gather grounded context â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
        // 4a. Models inventory (Python only): scan app/models/ for real class names
        const modelsInventory: Array<{ className: string; relPath: string }> = [];
        if (hasPy) {
            const modelsDir = path.join(root, 'app', 'models');
            if (fs.existsSync(modelsDir)) {
                try {
                    const modelFiles = fs.readdirSync(modelsDir)
                        .filter(f => f.endsWith('.py') && f !== '__init__.py');
                    for (const mf of modelFiles) {
                        try {
                            const mContent = fs.readFileSync(path.join(modelsDir, mf), 'utf8');
                            const classMatches = [...mContent.matchAll(/^class\s+(\w+)\s*[\(:]/gm)];
                            for (const cm of classMatches) {
                                modelsInventory.push({
                                    className: cm[1],
                                    relPath: `app/models/${mf}`,
                                });
                            }
                        } catch { /* skip unreadable */ }
                    }
                } catch { /* skip unreadable dir */ }
                logInfo(`[pre-edit] Models inventory: ${modelsInventory.length} classes from app/models/`);
            }
        } else if (hasTs) {
            // TypeScript inventory: scan src/types/, src/models/, src/interfaces/ for exported interfaces/enums/classes
            const tsDirs = ['src/types', 'src/models', 'src/interfaces', 'types', 'models'].map(d => path.join(root, d));
            for (const tsDir of tsDirs) {
                if (!fs.existsSync(tsDir)) { continue; }
                try {
                    const tsFiles = fs.readdirSync(tsDir).filter(f => f.endsWith('.ts') && !f.endsWith('.d.ts'));
                    for (const tf of tsFiles) {
                        try {
                            const tContent = fs.readFileSync(path.join(tsDir, tf), 'utf8');
                            const re = /^export\s+(?:interface|type|enum|class)\s+(\w+)/gm;
                            const tRelPath = path.relative(root, path.join(tsDir, tf)).replace(/\\/g, '/');
                            for (const m of tContent.matchAll(re)) {
                                modelsInventory.push({ className: m[1], relPath: tRelPath });
                            }
                        } catch { /* skip */ }
                    }
                } catch { /* skip */ }
            }
            logInfo(`[pre-edit] TS types inventory: ${modelsInventory.length} exported types`);
        }

        // 4a-ii. Data model relationship map (Python only, when editing a models file)
        // Scans app/models/ for SQLAlchemy relationships and ForeignKeys.
        // Injected when the target file is inside app/models/ or the user message
        // references a model that has relationships.
        let modelRelMap: Array<{ className: string; relations: string[] }> = [];
        const isModelEdit = targetRelPath.includes('models/') || /\b(model|schema|migration|foreign.?key|relationship)\b/i.test(userMessage);
        if (hasPy && isModelEdit && modelsInventory.length > 0) {
            modelRelMap = ctx.buildModelRelationshipMap(root);
            logInfo(`[pre-edit] Model relationship map: ${modelRelMap.length} models with relations`);
        }

        // 4b. Route/function/field inventory from the target file itself
        const targetLines = targetContent.split('\n');
        const definedRoutes: string[] = [];   // "@bp.route('/path', ...)"
        const definedFunctions: string[] = []; // "def func_name"
        const definedFields: string[] = [];    // "field = db.Column(...)" / "field: Type"
        const importedNames: string[] = [];    // "from X import Y, Z" -> Y, Z

        for (const line of targetLines) {
            // Python Flask route
            const routeMatch = line.match(/^\s*@\w+\.route\(['"]([^'"]+)['"]/);
            if (routeMatch) { definedRoutes.push(routeMatch[1]); }

            // Express: router.get('/path', ...) / app.post('/path', ...)
            const expressMatch = line.match(/(?:router|app)\.\s*(?:get|post|put|patch|delete|all)\s*\(\s*['"`]([^'"`]+)['"`]/);
            if (expressMatch) { definedRoutes.push(expressMatch[1]); }

            // Next.js App Router: export async function GET / POST / PUT / DELETE / PATCH
            const nextMatch = line.match(/^export\s+(?:async\s+)?function\s+(GET|POST|PUT|DELETE|PATCH|HEAD)\s*\(/);
            if (nextMatch) { definedRoutes.push(`[${nextMatch[1]}] (Next.js handler)`); }

            const defMatch = line.match(/^\s*(?:async\s+)?def\s+(\w+)\s*\(/);
            if (defMatch && !defMatch[1].startsWith('_')) { definedFunctions.push(defMatch[1]); }

            // TypeScript: export function / export const foo = / class Foo
            const tsFnMatch = line.match(/(?:export\s+)?(?:async\s+)?function\s+(\w+)|(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\(/);
            if (tsFnMatch) { definedFunctions.push(tsFnMatch[1] || tsFnMatch[2]); }

            // Python SQLAlchemy column: "    field_name = db.Column(...)"
            const pyColMatch = line.match(/^\s{4,}(\w+)\s*=\s*(?:db\.|sa\.)?Column\s*\(/);
            if (pyColMatch) { definedFields.push(pyColMatch[1]); }

            // Python SQLAlchemy relationship: "    field_name = db.relationship(...)"
            const pyRelMatch = line.match(/^\s{4,}(\w+)\s*=\s*(?:db\.|sa\.)?relationship\s*\(/);
            if (pyRelMatch) { definedFields.push(pyRelMatch[1]); }

            // TypeScript class property: "  fieldName: Type" or "  fieldName = value"
            const tsPropMatch = line.match(/^\s{2,4}(\w+)\s*[=:]/);
            if (tsPropMatch && !tsFnMatch && !line.trim().startsWith('//')) {
                definedFields.push(tsPropMatch[1]);
            }

            const importMatch = line.match(/^(?:from\s+\S+\s+import\s+(.+)|import\s+\{([^}]+)\})/);
            if (importMatch) {
                const names = (importMatch[1] || importMatch[2] || '')
                    .split(',').map(s => s.trim().replace(/\s+as\s+\w+/, '').trim()).filter(Boolean);
                importedNames.push(...names);
            }
        }

        // â"€â"€ 4c. Column/field existence check (Fix 1c) â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
        // When task is "add X field/column to form/template", check whether the column
        // already exists in the model file. If it does, redirect: model job is form+JS only.
        let columnExistsNote = '';
        const isAddFieldTask = /\badd\b.{0,40}\b(field|column|input|attribute)\b/i.test(userMessage)
            || /\b(field|column)\b.{0,40}\b(form|template|inline)\b/i.test(userMessage);
        if (isAddFieldTask && hasPy) {
            // Extract the field name from the user message
            const fieldMatch = userMessage.match(
                /\badd\s+(?:a\s+|an\s+)?(?:new\s+)?[`"']?([a-z][a-z0-9_]*(?:[\s_][a-z0-9_]+){0,3})[`"']?\s+(?:field|column|input|attribute)/i
            ) ?? userMessage.match(/[`"']([a-z][a-z0-9_]+)[`"']/i);
            const rawFieldName = fieldMatch?.[1]?.trim().toLowerCase().replace(/\s+/g, '_') ?? '';
            if (rawFieldName.length > 2) {
                // Look in every model file for this column
                const modelsDir = path.join(root, 'app', 'models');
                if (fs.existsSync(modelsDir)) {
                    for (const mf of fs.readdirSync(modelsDir).filter(f => f.endsWith('.py'))) {
                        try {
                            const mc = fs.readFileSync(path.join(modelsDir, mf), 'utf8');
                            // Match: field_name = db.Column(... or field_name = Column(...
                            const colRe = new RegExp(`^\\s{4,}(${rawFieldName})\\s*=\\s*(?:db\\.|sa\\.)?Column\\s*\\(`, 'im');
                            const colMatch = mc.match(colRe);
                            if (colMatch) {
                                columnExistsNote = `[ok] Column \`${colMatch[1]}\` already exists in \`app/models/${mf}\`. ` +
                                    `Do NOT add it to the model again. Your task is to add the form field to the HTML template and the JS submit handler only.`;
                                logInfo(`[pre-edit] Column exists: ${colMatch[1]} in ${mf}`);
                                // Save to memory
                                if (ctx.memory) {
                                    const memNote = `Column \`${colMatch[1]}\` confirmed in app/models/${mf} (checked ${new Date().toLocaleDateString()}).`;
                                    ctx.memory.addEntry(2, memNote, ['schema', 'auto-discovery']).catch((e) => logWarn(`[memory] background write failed: ${toErrorMessage(e)}`));
                                }
                                break;
                            }
                        } catch { /* skip */ }
                    }
                }
            }
        }

        // â"€â"€ 4d. Full-stack breadcrumb for form tasks (Fix 1a) â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
        // When task involves a form field (add/update field in form/template),
        // proactively find the JS submit handler and the backend route that processes the POST.
        // Inject all three file locations so the model knows the full surface area.
        interface FormFile { relPath: string; lineHint: number; snippet: string }
        let formJsHandler: FormFile | null = null;
        let formBackendRoute: FormFile | null = null;
        const isFormTask = /\b(form|template|inline|frontend|html)\b/i.test(userMessage)
            || /\badd\b.{0,40}\b(field|column|input)\b/i.test(userMessage);
        if (isFormTask && hasPy) {
            // Extract entity keyword (e.g. "transaction", "customer") from user message
            const entityKw = userMessage.toLowerCase().match(
                /\b(transaction|customer|cashier|product|inventory|order|invoice|sale|item|vehicle|employee|staff)\b/
            )?.[1] ?? contentKws[0] ?? '';

            // Search JS files for a submit/fetch/ajax call referencing this entity
            const staticDir = path.join(root, 'app', 'static');
            const walkJs = (dir: string): string[] => {
                const out: string[] = [];
                try {
                    for (const f of fs.readdirSync(dir)) {
                        const abs = path.join(dir, f);
                        try {
                            if (fs.statSync(abs).isDirectory()) { out.push(...walkJs(abs)); }
                            else if (/\.(js|ts)$/.test(f) && !/\.min\.js$/.test(f)) { out.push(abs); }
                        } catch { /* skip */ }
                    }
                } catch { /* skip */ }
                return out;
            };
            const jsFiles = fs.existsSync(staticDir) ? walkJs(staticDir) : [];
            for (const jsAbs of jsFiles) {
                try {
                    const jsContent = fs.readFileSync(jsAbs, 'utf8');
                    const jsLines = jsContent.split('\n');
                    // Look for fetch/XMLHttpRequest/$.ajax referencing the entity AND form data
                    const submitIdx = jsLines.findIndex((l, i) => {
                        const lower = l.toLowerCase();
                        return (lower.includes('fetch(') || lower.includes('xmlhttprequest') || lower.includes('$.ajax') || lower.includes('formdata'))
                            && (entityKw ? jsContent.toLowerCase().includes(entityKw) : true)
                            && (jsLines.slice(Math.max(0, i - 5), i + 10).some(ll => /append|formdata|body.*json|submit/i.test(ll)));
                    });
                    if (submitIdx >= 0) {
                        const snippet = jsLines.slice(Math.max(0, submitIdx - 2), Math.min(jsLines.length, submitIdx + 8)).join('\n');
                        formJsHandler = {
                            relPath: path.relative(root, jsAbs).replace(/\\/g, '/'),
                            lineHint: submitIdx + 1,
                            snippet,
                        };
                        logInfo(`[pre-edit] JS submit handler: ${formJsHandler.relPath} ~line ${submitIdx + 1}`);
                        if (ctx.memory) {
                            ctx.memory.addEntry(2,
                                `JS submit handler for ${entityKw || 'form'}: ${formJsHandler.relPath} ~line ${submitIdx + 1}`,
                                ['js-handler', 'form', 'auto-discovery']
                            ).catch((e) => logWarn(`[memory] background write failed: ${toErrorMessage(e)}`));
                        }
                        break;
                    }
                } catch { /* skip */ }
            }

            // Search Python routes for a POST handler referencing the entity
            const routesDir = path.join(root, 'app', 'routes');
            const routesDirAlt = path.join(root, 'app', 'views');
            const routesSearch = [routesDir, routesDirAlt].filter(d => fs.existsSync(d));
            outer: for (const rDir of routesSearch) {
                for (const rf of fs.readdirSync(rDir).filter(f => f.endsWith('.py'))) {
                    try {
                        const rc = fs.readFileSync(path.join(rDir, rf), 'utf8');
                        const rcLines = rc.split('\n');
                        const postIdx = rcLines.findIndex((l, i) => {
                            return /['"]POST['"]/i.test(l)
                                && (entityKw ? rc.toLowerCase().includes(entityKw) : true)
                                && rcLines.slice(Math.max(0, i - 1), i + 3).some(ll => /@\w+\.route/.test(ll));
                        });
                        if (postIdx >= 0) {
                            const snippet = rcLines.slice(Math.max(0, postIdx - 1), Math.min(rcLines.length, postIdx + 8)).join('\n');
                            formBackendRoute = {
                                relPath: path.relative(root, path.join(rDir, rf)).replace(/\\/g, '/'),
                                lineHint: postIdx + 1,
                                snippet,
                            };
                            logInfo(`[pre-edit] Backend POST route: ${formBackendRoute.relPath} ~line ${postIdx + 1}`);
                            if (ctx.memory) {
                                ctx.memory.addEntry(2,
                                    `Backend POST route for ${entityKw || 'form'}: ${formBackendRoute.relPath} ~line ${postIdx + 1}`,
                                    ['route', 'form', 'auto-discovery']
                                ).catch((e) => logWarn(`[memory] background write failed: ${toErrorMessage(e)}`));
                            }
                            break outer;
                        }
                    } catch { /* skip */ }
                }
            }
        }

        // â"€â"€ 4e. Caller/reference impact analysis (transitive, up to 3 hops) â"€â"€â"€â"€â"€â"€â"€â"€
        // Check if user is modifying a specific named function that already exists.
        // Walk the call graph outward: direct callers -> callers of callers -> one more hop.
        // Cap at 3 hops, 20 total nodes to avoid context explosion.
        const callerReport: Array<{ funcName: string; callers: string[]; hopCount: number }> = [];

        if (definedFunctions.length > 0 && root) {
            const isModifyTask = /\b(modify|update|change|refactor|rename|fix|edit|improve|rewrite)\b/i.test(userMessage);
            if (isModifyTask) {
                const mentionedFuncs = definedFunctions.filter(fn =>
                    fn.length > 3 && userMessage.toLowerCase().includes(fn.toLowerCase())
                ).slice(0, 2);

                for (const fn of mentionedFuncs) {
                    const transitiveCallers = ctx.walkCallGraph(fn, targetRelPath, root, 3, 20);
                    if (transitiveCallers.lines.length > 0) {
                        callerReport.push({
                            funcName: fn,
                            callers: transitiveCallers.lines,
                            hopCount: transitiveCallers.maxHop,
                        });
                        logInfo(`[pre-edit] Caller graph: ${fn} -> ${transitiveCallers.lines.length} refs across ${transitiveCallers.maxHop} hop(s)`);
                    }
                }
            }
        }

        // 4c. Pattern example -- find a short representative route/function from the target file
        // Look for a route that returns JSON or a list -- closest to what the user likely wants
        let patternExample = '';
        const patternKws = userMessage.toLowerCase();
        const isJsonTask = /json|api|list|return/.test(patternKws);

        if (hasPy && definedRoutes.length > 0) {
            // Find a route block: from @bp.route to the end of that function
            let bestStart = -1;
            for (let i = 0; i < targetLines.length; i++) {
                const l = targetLines[i];
                if (!l.match(/^\s*@\w+\.route\(/)) { continue; }
                // Prefer JSON-returning routes when user wants JSON
                if (isJsonTask) {
                    const block = targetLines.slice(i, Math.min(i + 30, targetLines.length)).join('\n');
                    if (/jsonify|\.json\(|json\.dumps/.test(block)) { bestStart = i; break; }
                }
                if (bestStart === -1) { bestStart = i; } // fallback: first route
            }
            if (bestStart >= 0) {
                // Capture from @decorator to end of function (next blank line after def + indent reset)
                const blockLines: string[] = [];
                let inFunc = false;
                let funcIndent = '';
                for (let i = bestStart; i < Math.min(bestStart + 40, targetLines.length); i++) {
                    const l = targetLines[i];
                    blockLines.push(l);
                    if (!inFunc && l.match(/^\s*def\s+/)) {
                        inFunc = true;
                        funcIndent = l.match(/^(\s*)/)?.[1] ?? '';
                        continue;
                    }
                    if (inFunc && i > bestStart + 2) {
                        // End when we're back at function indentation level with content (next def or decorator)
                        if (l.trim() && !l.startsWith(funcIndent + ' ') && l.startsWith(funcIndent) && l !== funcIndent) {
                            blockLines.pop(); break;
                        }
                    }
                }
                patternExample = blockLines.join('\n');
            }
        }

        // 4d. Pre-validate: does the user's request reference a model name that doesn't exist?
        const preValidationWarnings: string[] = [];
        if (modelsInventory.length > 0) {
            // Extract capitalised words from the user message (likely model names)
            const mentionedModels = [...userMessage.matchAll(/\b([A-Z][a-zA-Z]{2,})\b/g)].map(m => m[1]);
            for (const name of mentionedModels) {
                // Skip common non-model words
                if (/^(GET|POST|PUT|DELETE|JSON|HTTP|API|URL|SQL|UUID|ID|True|False|None|Flask|Blueprint|Login|User|Admin|Error|Exception|Response|Request|Session)$/.test(name)) { continue; }
                const exists = modelsInventory.some(m => m.className === name);
                if (!exists) {
                    preValidationWarnings.push(
                        `âš  "${name}" is not a known model in app/models/. ` +
                        `Available models: ${modelsInventory.slice(0, 8).map(m => m.className).join(', ')}${modelsInventory.length > 8 ? '...' : ''}.`
                    );
                }
            }
        }

        // â"€â"€ 5. Build numbered file content with window â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
        const FILE_LINE_LIMIT = 600;
        let startIdx = 0;
        let endIdx = targetLines.length;

        if (targetLines.length > FILE_LINE_LIMIT) {
            const kwsForWindow = [...filenameKeywords, ...contentKws].filter(w => w.length > 3);
            const relevantIdxs = targetLines
                .map((l, i) => ({ i, hit: kwsForWindow.some(w => l.toLowerCase().includes(w)) }))
                .filter(x => x.hit).map(x => x.i);
            if (relevantIdxs.length > 0) {
                startIdx = Math.max(0, relevantIdxs[0] - 20);
                endIdx   = Math.min(targetLines.length, relevantIdxs[relevantIdxs.length - 1] + 80);
            } else {
                endIdx = Math.min(targetLines.length, FILE_LINE_LIMIT);
            }
        }

        const numberedLines = targetLines.slice(startIdx, endIdx)
            .map((l, i) => `${String(startIdx + i + 1).padStart(4, ' ')}: ${l}`)
            .join('\n');

        const ext = path.extname(targetRelPath).slice(1) || 'text';
        const windowNote = (startIdx > 0 || endIdx < targetLines.length)
            ? ` [showing lines ${startIdx + 1}--${endIdx} of ${targetLines.length}]`
            : ` [${targetLines.length} lines]`;

        // Post visible tool call for the user
        const preReadId = `pre_edit_read_${Date.now()}`;
        post({ type: 'toolCall', id: preReadId, name: 'shell_read', args: { command: `cat "${targetRelPath}"` } });
        post({ type: 'toolResult', id: preReadId, name: 'shell_read', success: true, preview: `${targetLines.length} lines` });

        // â"€â"€ 5b. Programmatic duplicate pre-check (fires before model is called) â"€
        // Extract the "thing being added" from the user message and check it against
        // already-defined fields/functions/routes.  If found, block immediately --
        // don't rely on the model to self-police.
        const isAddTask = /\badd\b/i.test(userMessage) && !/\b(update|modify|change|refactor|rename|fix|edit|improve|rewrite|extend|remove.*from)\b/i.test(userMessage);
        if (isAddTask && (definedFields.length > 0 || definedFunctions.length > 0 || definedRoutes.length > 0)) {
            // Pull candidate "thing name" from the message:
            // "add a phone_number field" -> ["phone_number", "phone", "number"]
            // "add phone number column" -> ["phone", "number"]
            const addMatch = userMessage.match(/\badd\s+(?:a\s+|an\s+)?(?:new\s+)?([a-z_][a-z0-9_]*(?:\s+[a-z_][a-z0-9_]*){0,3})/i);
            if (addMatch) {
                const rawTokens = addMatch[1].toLowerCase()
                    .replace(/\s+(field|column|property|attribute|relationship|method|function|route|endpoint)\b/gi, '')
                    .trim()
                    .split(/[\s_]+/)
                    .filter(t => t.length > 1);

                // Build candidate names: snake_case joined, and individual tokens
                const snakeJoined = rawTokens.join('_');
                const candidates = [snakeJoined, ...rawTokens];

                const allDefined = [...definedFields, ...definedFunctions, ...definedRoutes];
                const hit = candidates.find(c => allDefined.some(d => d.toLowerCase() === c.toLowerCase()
                    || d.toLowerCase().replace(/_/g, '') === c.toLowerCase().replace(/_/g, '')));

                if (hit) {
                    const matchedDef = allDefined.find(d => d.toLowerCase() === hit.toLowerCase()
                        || d.toLowerCase().replace(/_/g, '') === hit.toLowerCase().replace(/_/g, ''));
                    const msg = `Already exists: \`${matchedDef ?? hit}\` is already defined in \`${targetRelPath}\`. No change needed.`;
                    logInfo(`[pre-edit] Programmatic duplicate block: ${msg}`);
                    return { injection: '', blocked: msg, pendingSteps: [] };
                }
            }
        }

        // â"€â"€ 4f. Auto-save target file resolution to memory (Fix 4a) â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
        if (ctx.memory && targetRelPath) {
            const lineCount = targetContent.split('\n').length;
            const memNote = `Target file for "${userMessage.slice(0, 60)}": ${targetRelPath} (${lineCount} lines, resolved ${new Date().toLocaleDateString()})`;
            ctx.memory.isSemanticDuplicate(targetRelPath, 0.9).then(isDupe => {
                if (!isDupe) {
                    ctx.memory!.addEntry(2, memNote, ['file-resolution', 'auto-discovery']).catch((e) => logWarn(`[memory] background write failed: ${toErrorMessage(e)}`));
                }
            }).catch((e) => logWarn(`[memory] background write failed: ${toErrorMessage(e)}`));
        }

        // â"€â"€ 5c. Static bug scan on target file â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
        // Scan the loaded file for common obvious bugs before the model ever sees it.
        // These are injected as pre-warnings so the model fixes them instead of
        // propagating them or asking the user to clarify.
        const staticBugWarnings: string[] = [];
        if (hasPy) {
            const lines = targetContent.split('\n');
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                const lineNo = i + 1;

                // Pattern: `for x in some_dict_var:` where `some_dict_var` is initialized
                // as an empty dict `{}` earlier in the same function. Classic "iterate empty dict" bug.
                const forInMatch = line.match(/^\s*for\s+(\w+)\s+in\s+(\w+)\s*:/);
                if (forInMatch) {
                    const iterVar = forInMatch[2];
                    // Look back up to 60 lines for the variable being assigned an empty dict/list
                    for (let j = Math.max(0, i - 60); j < i; j++) {
                        const prevLine = lines[j];
                        // e.g. `field_changes = {}` or `field_changes = []`
                        if (new RegExp(`^\\s*${iterVar}\\s*=\\s*(?:\\{\\}|\\[\\])\\s*$`).test(prevLine)) {
                            const listVar = lines.slice(Math.max(0, i - 80), i)
                                .map(l => l.match(/^\s*(\w+)\s*=\s*\[/)?.[1])
                                .filter(Boolean)
                                .pop();
                            staticBugWarnings.push(
                                `âš  BUG at line ${lineNo}: \`for ${forInMatch[1]} in ${iterVar}:\` -- ` +
                                `\`${iterVar}\` is initialized as empty (${prevLine.trim()}) at line ${j + 1}, ` +
                                `so this loop body NEVER executes. Did you mean to iterate a different variable?` +
                                (listVar ? ` Nearby list variable: \`${listVar}\`.` : '')
                            );
                            break;
                        }
                    }
                }
            }
        }

        // â"€â"€ 5d. File-system existence scan â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
        // For create/implement/add tasks: scan app/routes/ and app/services/ for files
        // and function definitions that match the task keywords. If found, block immediately
        // with a [FEATURE ALREADY EXISTS] message. This is purely programmatic -- no model call.
        const isCreateTask = /\b(implement|create|add|build|make|set up|write)\b/i.test(userMessage)
            && !/\b(plan|discuss|design|proposal|update|modify|change|fix|remove|delete)\b/i.test(userMessage);
        if (isCreateTask && hasPy && contentKws.length >= 2) {
            interface FsHit { relPath: string; matchedRoutes: string[]; matchedFunctions: string[] }
            const fsHits: FsHit[] = [];

            // Directories to scan
            const scanDirs = ['app/routes', 'app/services', 'app/views', 'app/blueprints']
                .map(d => path.join(root, d))
                .filter(d => fs.existsSync(d));

            for (const scanDir of scanDirs) {
                let pyFiles: string[];
                try { pyFiles = fs.readdirSync(scanDir).filter(f => f.endsWith('.py') && f !== '__init__.py'); }
                catch { continue; }

                for (const pf of pyFiles) {
                    const pfAbs = path.join(scanDir, pf);
                    let pfContent: string;
                    try { pfContent = fs.readFileSync(pfAbs, 'utf8'); }
                    catch { continue; }

                    // Check if this file is relevant: at least 2 content keywords present
                    const pfLower = pfContent.toLowerCase();
                    const kwHits = contentKws.filter(kw => pfLower.includes(kw));
                    if (kwHits.length < 2) { continue; }

                    const pfLines = pfContent.split('\n');
                    const matchedRoutes: string[] = [];
                    const matchedFunctions: string[] = [];

                    for (const line of pfLines) {
                        const rm = line.match(/^\s*@\w+\.route\(['"]([^'"]+)['"]/);
                        if (rm) { matchedRoutes.push(rm[1]); }
                        const fm = line.match(/^\s*(?:async\s+)?def\s+(\w+)\s*\(/);
                        if (fm && !fm[1].startsWith('_')) { matchedFunctions.push(fm[1]); }
                    }

                    // Only flag if at least one route or function name contains a content keyword
                    const relevantFns = matchedFunctions.filter(fn =>
                        contentKws.some(kw => fn.toLowerCase().includes(kw))
                    );
                    const relevantRoutes = matchedRoutes.filter(r =>
                        contentKws.some(kw => r.toLowerCase().includes(kw))
                    );

                    if (relevantFns.length > 0 || relevantRoutes.length > 0) {
                        const rel = path.relative(root, pfAbs).replace(/\\/g, '/');
                        fsHits.push({ relPath: rel, matchedRoutes: relevantRoutes, matchedFunctions: relevantFns });
                        logInfo(`[fs-scan] Feature match: ${rel} (routes: ${relevantRoutes.join(', ')}, fns: ${relevantFns.join(', ')})`);
                    }
                }
            }

            if (fsHits.length > 0) {
                const hitLines = fsHits.map(h => {
                    const parts: string[] = [`  File: \`${h.relPath}\``];
                    if (h.matchedRoutes.length > 0) { parts.push(`  Routes: ${h.matchedRoutes.map(r => `\`${r}\``).join(', ')}`); }
                    if (h.matchedFunctions.length > 0) { parts.push(`  Functions: ${h.matchedFunctions.map(f => `\`${f}\``).join(', ')}`); }
                    return parts.join('\n');
                }).join('\n\n');

                const msg = `[FEATURE ALREADY EXISTS]\n\nA file-system scan found existing code matching this task:\n\n${hitLines}\n\nBefore writing any new code:\n1. Read the file(s) listed above to confirm what is already implemented\n2. Tell the user what exists and what (if anything) is missing\n3. Only write new code if something is genuinely absent`;
                logInfo(`[fs-scan] Blocking: ${fsHits.length} hit(s) for keywords [${contentKws.join(', ')}]`);
                // Don't return blocked -- inject as warning instead so model can still act if needed
                // (user may want to extend, not re-implement). Inject prominently at top of sections.
                return { injection: `[PRE-LOADED CONTEXT for your task]\n\n## âš  ${msg}\n`, blocked: null, pendingSteps: [] };
            }
        }

        // â"€â"€ 6. Assemble the injection â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
        const sections: string[] = [];

        sections.push(`[PRE-LOADED CONTEXT for your task]`);
        sections.push(`Line numbers are for edit_file_at_line only -- they are NOT part of the file.\n`);

        // Stub redirect warning -- shown first so model cannot miss it
        if (stubWarning) {
            sections.push(`## âš  ${stubWarning}\n`);
        }

        // Column existence note -- shown before file content so model knows the job scope upfront
        if (columnExistsNote) {
            sections.push(`## [ok] Schema check\n${columnExistsNote}\n`);
        }

        // Full-stack form breadcrumb -- all surfaces the model needs to touch
        if (formJsHandler || formBackendRoute) {
            sections.push(`## Full-stack form surface -- you must update ALL of these`);
            sections.push(`The task requires changes across multiple files. Do NOT stop after editing one.`);
            if (formJsHandler) {
                sections.push(`**JS submit handler:** \`${formJsHandler.relPath}\` ~line ${formJsHandler.lineHint}`);
                sections.push(`\`\`\`js\n${formJsHandler.snippet}\n\`\`\``);
            }
            if (formBackendRoute) {
                sections.push(`**Backend POST route:** \`${formBackendRoute.relPath}\` ~line ${formBackendRoute.lineHint}`);
                sections.push(`\`\`\`python\n${formBackendRoute.snippet}\n\`\`\``);
            }
            sections.push('');
        }

        // Models inventory FIRST -- model must see what's available before reading the file
        if (modelsInventory.length > 0) {
            sections.push(`## RULE: You may only import models from this list (scanned from app/models/ on disk)`);
            sections.push(`Do NOT invent or guess model names. If no model here fits the task, stop and explain.`);
            sections.push(modelsInventory.map(m => `  ${m.className}  (${m.relPath})`).join('\n'));
            sections.push('');
        }

        // What already exists in the file
        if (definedRoutes.length > 0 || definedFunctions.length > 0 || definedFields.length > 0) {
            sections.push(`## Already defined in this file -- check for duplicates before adding`);
            if (definedRoutes.length > 0) {
                sections.push(`Routes: ${definedRoutes.map(r => `\`${r}\``).join(', ')}`);
            }
            if (definedFunctions.length > 0) {
                sections.push(`Functions: ${definedFunctions.map(f => `\`${f}\``).join(', ')}`);
            }
            if (definedFields.length > 0) {
                sections.push(`Fields/columns: ${definedFields.map(f => `\`${f}\``).join(', ')}`);
            }
            if (importedNames.length > 0) {
                sections.push(`Currently imported: ${importedNames.slice(0, 20).map(n => `\`${n}\``).join(', ')}`);
            }
            sections.push('');
        }

        // Data model relationship map (when editing models)
        if (modelRelMap.length > 0) {
            sections.push(`\n## Model relationships (from app/models/ scan)`);
            sections.push(`Review before changing model fields -- downstream associations may require migrations or form updates.`);
            for (const { className, relations } of modelRelMap) {
                sections.push(`  ${className}: ${relations.join(' | ')}`);
            }
            sections.push('');
        }

        // Caller impact analysis (transitive)
        if (callerReport.length > 0) {
            sections.push(`\n## Caller impact -- backward compatibility required`);
            for (const { funcName, callers, hopCount } of callerReport) {
                const hopNote = hopCount > 1 ? ` (${hopCount}-hop transitive graph)` : '';
                sections.push(`\`${funcName}\` is referenced from ${callers.length} location(s)${hopNote}:`);
                sections.push(callers.join('\n'));
                sections.push(`Your change must remain compatible with these call sites, or update them in the same session.`);
            }
        }

        // Pattern example
        if (patternExample) {
            sections.push(`## Pattern to follow exactly (copy this structure)`);
            sections.push(`\`\`\`${ext}\n${patternExample}\n\`\`\``);
            sections.push('');
        }

        // Target file
        sections.push(`## Target file: ${targetRelPath}${windowNote}`);
        sections.push(`\`\`\`${ext}\n${numberedLines}\n\`\`\``);

        // Static bug scan warnings -- shown prominently so model fixes them
        if (staticBugWarnings.length > 0) {
            sections.push(`\n## âš  STATIC BUG SCAN -- fix these FIRST before implementing any new code`);
            sections.push(staticBugWarnings.join('\n'));
        }

        // Pre-validation warnings
        if (preValidationWarnings.length > 0) {
            sections.push(`\n## âš  Pre-validation warnings -- resolve before writing code`);
            sections.push(preValidationWarnings.join('\n'));
        }

        // Detect sweep tasks -- "add error handling to all routes", "fix all X missing Y"
        const isSweepTask = /\b(all|every|each|any)\b.{0,40}\b(route|function|endpoint|def)\b/i.test(userMessage)
            || /\b(missing|without|lacks?)\b.{0,50}\b(error|exception|try|handl)/i.test(userMessage)
            || /\b(no\s+error|no\s+try)\b/i.test(userMessage)
            || /\b(add|fix).{0,30}\b(all|every|each|any)\b/i.test(userMessage);

        // â"€â"€ Fix 6b: Task-specific completion checklist â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
        // Build a concrete "done when" checklist based on what we discovered.
        // The model must check every item before declaring the task complete.
        const completionChecks: string[] = [];
        if (isFormTask && !isSweepTask) {
            // Extract the specific field name if we found it
            const fieldNameForChecklist = columnExistsNote.match(/`([a-z_]+)`/)?.[1] ?? contentKws[0] ?? 'the field';
            completionChecks.push(`[ ] HTML input for \`${fieldNameForChecklist}\` added to \`${targetRelPath}\``);
            if (formJsHandler) {
                completionChecks.push(`[ ] JS submit handler in \`${formJsHandler.relPath}\` includes \`${fieldNameForChecklist}\` key`);
            }
            if (formBackendRoute) {
                completionChecks.push(`[ ] Backend route in \`${formBackendRoute.relPath}\` reads \`request.form.get('${fieldNameForChecklist}')\``);
            }
            if (!columnExistsNote) {
                // Column doesn't exist yet -- migration needed
                completionChecks.push(`[ ] Column \`${fieldNameForChecklist}\` added to model file`);
                completionChecks.push(`[ ] User informed: "Run flask db migrate && flask db upgrade"`);
            }
        } else if (/\badd\b.{0,30}\broute\b/i.test(userMessage) && !isSweepTask) {
            completionChecks.push(`[ ] Route function added to \`${targetRelPath}\``);
            completionChecks.push(`[ ] Route is registered on the correct blueprint (not a duplicate path)`);
            completionChecks.push(`[ ] Syntax check passes (no import errors, no undefined names)`);
        } else if (/\bfix\b/i.test(userMessage) && !isSweepTask) {
            completionChecks.push(`[ ] edit_file called and confirmed`);
            completionChecks.push(`[ ] Error pattern no longer present in file`);
            completionChecks.push(`[ ] Syntax check passes`);
        }

        // Instructions
        sections.push(`\n## Your task`);
        if (isSweepTask) {
            sections.push([
                `This is a SWEEP task -- you need to update every route/function in the file that is missing the requested change.`,
                ``,
                `Strategy (IMPORTANT -- follow this exactly):`,
                `1. Read the file with shell_read to get the current content.`,
                `2. Find the FIRST route/function that still needs the change (not already updated).`,
                `3. Call edit_file ONCE for that route, using EXACT text copied from the current file (correct indentation).`,
                `4. After it succeeds, go back to step 2 and find the next one.`,
                `5. When no more remain, output a brief summary: "Updated N routes: [list of function names]."`,
                ``,
                `Rules:`,
                `- Use edit_file (NOT edit_file_at_line) -- line numbers shift after each edit.`,
                `- Copy old_string VERBATIM from the file -- preserve ALL leading spaces/indentation.`,
                `- Do NOT batch all edits from the initial read -- the file changes after each edit.`,
                `- Do NOT stop after the first edit -- keep going until all are updated.`,
                `- No \`pass\` or \`# TODO\` -- complete working code only.`,
                `- Match the style already present in the file.`,
            ].join('\n'));
        } else {
            const isModifyTask = /\b(update|modify|change|refactor|rename|fix|edit|improve|rewrite|extend|add.*to|remove.*from)\b/i.test(userMessage);
            if (isModifyTask) {
                sections.push([
                    `This is a MODIFY task -- you are changing existing code, not adding new code.`,
                    ``,
                    `Run these checks silently, then act:`,
                    `- If the thing to modify does NOT exist in the file -> "Cannot find [name] in ${targetRelPath}. No change made."`,
                    `- If all checks pass -> call edit_file_at_line with path="${targetRelPath}" immediately. No explanation needed.`,
                    ``,
                    `Rules:`,
                    `- Do NOT use the duplicate check -- the item already exists by definition.`,
                    `- MODEL: If adding a new field that references another model, it must be in the RULE list above.`,
                    `- Use start_line/end_line from the line numbers shown.`,
                    `- Match surrounding indentation exactly.`,
                    `- No shell_read -- all context is above.`,
                    `- No \`pass\` or \`# TODO\` -- complete working code only.`,
                ].join('\n'));
            } else {
                sections.push([
                    `Run all validation checks silently (do not narrate them), then:`,
                    `- If a check fails -> output one sentence explaining why, then stop.`,
                    `- If all pass -> call edit_file_at_line with path="${targetRelPath}" immediately. No explanation needed.`,
                    ``,
                    `Checks (run silently):`,
                    `1. DUPLICATE: Is what the user asked already in "Already defined"? If yes -> "Already exists: [name]. No change needed."`,
                    `2. MODEL: Need a DB model? Must be in the RULE list above. If missing -> "Cannot proceed: [Name] not found in app/models/."`,
                    `3. PATTERN: Use same blueprint, decorators, imports as the pattern example.`,
                    `4. FIT: Does this belong in ${targetRelPath}?`,
                    ``,
                    `When editing:`,
                    `  - Use start_line/end_line from the line numbers shown`,
                    `  - Match surrounding indentation`,
                    `  - No shell_read -- all context is above`,
                    `  - No \`pass\` or \`# TODO\` -- complete working code only`,
                ].join('\n'));
            }
        }

        // Fix 6b: Completion checklist appended after task instructions
        if (completionChecks.length > 0) {
            sections.push(`\n## TASK COMPLETE WHEN ALL ARE DONE`);
            sections.push(`Do not declare the task complete until every item is checked:`);
            sections.push(completionChecks.join('\n'));
            if (formJsHandler || formBackendRoute) {
                sections.push(`\nThis task touches multiple files. Edit ALL of them before responding to the user.`);
            }
        }

        // Post reasoning card to UI
        post({
            type: 'reasoningCard',
            targetFile: targetRelPath,
            routes: definedRoutes,
            functions: definedFunctions,
            fields: definedFields,
            modelCount: modelsInventory.length,
            warnings: [...preValidationWarnings, ...(stubWarning ? [stubWarning] : []), ...(columnExistsNote ? [columnExistsNote] : [])],
            hasPattern: !!patternExample,
            isSweep: isSweepTask,
        });

        const injection = sections.join('\n');
        logInfo(`[pre-edit] Injected ${injection.length} chars -- file: ${targetRelPath}, models: ${modelsInventory.length}, routes: ${definedRoutes.length}, callers: ${callerReport.reduce((a, c) => a + c.callers.length, 0)} (${callerReport.reduce((a, c) => Math.max(a, c.hopCount), 0)} hops), warnings: ${preValidationWarnings.length}, stub: ${!!stubWarning}, colExists: ${!!columnExistsNote}, jsHandler: ${!!formJsHandler}, backendRoute: ${!!formBackendRoute}`);
        return { injection, blocked: null, pendingSteps: completionChecks };

}
