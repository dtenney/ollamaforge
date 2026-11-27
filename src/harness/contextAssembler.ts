/**
 * harness/contextAssembler.ts — Phase 1: Context assembly extracted from Agent.run().
 *
 * Builds the complete message array sent to the model:
 *   [system, ...history, memoryNudge?, projectNudge?, ctxBudget?]
 *
 * This is a pure orchestration layer — all the heavy lifting is in the
 * already-extracted helpers (agentPromptBuilder, memoryNudge, contextFanout, etc.).
 * The inline addenda (security scan, plan-first, plan ledger, task anchor,
 * intent strategy, autonomy level) are moved here from run().
 */

import * as path from 'path';
import * as fs from 'fs';
import { OllamaMessage } from '../ollamaClient';
import { getConfig } from '../config';
import { logInfo, logWarn } from '../logger';
import {
    buildSystemPromptAsync,
    buildSmallModelSystemPrompt,
    buildToolBiasNote,
    snapshotContextFileMtimes,
} from '../agentPromptBuilder';
import { buildMemoryNudge as _buildMemoryNudge, buildOrientationAnchor as _buildOrientationAnchor } from '../memoryNudge';
import { classifyIntent, IntentResult } from '../core/promptIntentClassifier';
import { calculateContextStats } from '../contextCalculator';
import { TieredMemoryManager } from '../memoryCore';
import { CodeIndexer } from '../codeIndex';
import type { TurnContext } from './types';

// ── Result type ──────────────────────────────────────────────────────────────

export interface AssembledContext {
    /** The full message array to send to the model. */
    messages: OllamaMessage[];
    /** The system content string (for logging / debugging). */
    systemContent: string;
    /** Memory context block (for reference). */
    memoryContext: string;
    /** Context file mtimes snapshot (for drift detection). */
    contextFileMtimes: Map<string, number>;
}

// ── Main entry point ─────────────────────────────────────────────────────────

/**
 * Assemble the complete context message array for a model call.
 *
 * Replaces the ~1000-line inline block in Agent.run() (lines ~4000–5100).
 * Pure refactor: same inputs, same outputs, no behavior change.
 */
export async function assembleContext(ctx: TurnContext): Promise<AssembledContext> {
    const {
        workspaceRoot,
        lastUserMessage: userMessage,
        history,
        loop,
        services,
        limits,
        postFn,
    } = ctx;

    const cfg = getConfig();

    // ── 1. Base system prompt ────────────────────────────────────────────────
    const _useSlimPrompt = loop.earlyCompactionStalls >= 1;
    let baseSystemContent = cfg.systemPrompt.trim()
        || (_useSlimPrompt || loop.isSmallModel
            ? buildSmallModelSystemPrompt(workspaceRoot)
            : await buildSystemPromptAsync(cfg.autoSaveMemory, workspaceRoot));
    if (_useSlimPrompt) {
        logInfo(`[context] Early-compaction stall #${loop.earlyCompactionStalls} — using slim system prompt`);
    }

    // ── 2. Intent-based context strategy ─────────────────────────────────────
    const intentResult: IntentResult = classifyIntent(userMessage);
    if (!_useSlimPrompt && intentResult.intent !== 'general') {
        logInfo(`[intent] ${intentResult.intent} (confidence=${intentResult.confidence}) — prioritize: ${intentResult.contextPriorities.join(', ')} | skip: ${intentResult.contextSkips.join(', ') || 'none'}`);
        baseSystemContent += `\n\n## CONTEXT STRATEGY (intent: ${intentResult.intent})
Prioritize these context sources: ${intentResult.contextPriorities.join(', ')}.
Skip or de-prioritize: ${intentResult.contextSkips.join(', ') || 'none'}.
Adapt your tool calls accordingly — e.g. if git_diff is skipped, do not call shell_read for git log/diff unless the user explicitly asks.`;
    }

    // ── 3. Snapshot context file mtimes ──────────────────────────────────────
    let contextFileMtimes = new Map<string, number>();
    if (workspaceRoot) {
        contextFileMtimes = snapshotContextFileMtimes(workspaceRoot);
    }

    // ── 4. Security scan addendum ────────────────────────────────────────────
    const isSecurityScan = /\b(security\s*(scan|audit|review|check|vuln[a-z]*|issue|bug|flaw|hole|anal[iy]s[ie]s?)|vuln[a-z]*\s*(scan|check|find|hunt|anal[iy]s[ie]s?|report)|pentest|pen\s+test|cve\s*scan|owasp|injection\s*(check|scan|find)|find\s*(vuln|security)|security\s*(report|risk))\b/i.test(userMessage)
        || /\b(look|check|scan|search|find|review|audit|anal[iy]s[ie])\b.{0,60}\b(security\s*(vuln|issue|bug|flaw|risk|hole|problem|check)|vuln[a-z]*)\b/i.test(userMessage)
        || /\bcheck\s+(for\s+)?(security\s+(issues?|bugs?|vuln[a-z]*|flaws?|risks?|problems?)|vuln[a-z]*)\b/i.test(userMessage);
    if (isSecurityScan) {
        logInfo('[security-scan] Security audit mode activated');
    }
    if (!_useSlimPrompt && isSecurityScan) {
        baseSystemContent += `\n\n## SECURITY AUDIT MODE
You are performing a security vulnerability scan. Your job is to systematically read source files and identify real, exploitable security issues. Follow this process:

**Step 1 -- Enumerate files**: Use shell_read to list all relevant source files (routes, services, models, config).
**Step 2 -- Read each file**: Read files one at a time. For each file, look for:
  - Command injection: user input passed to exec/spawn/shell without sanitization
  - SQL injection: string interpolation in queries instead of parameterized queries
  - Path traversal: unsanitized file paths from user input
  - Hardcoded secrets: API keys, passwords, tokens in source code
  - Insecure deserialization: loading untrusted data with pickle, yaml.load, eval
  - Authentication bypass: missing auth decorators on sensitive routes
  - XSS: user input rendered as HTML without escaping (render_template_string, Markup())
  - SSRF: user-controlled URLs passed to requests.get/http calls
  - Mass assignment: accepting arbitrary fields from request.json/form without filtering
  - Exposed debug endpoints: debug=True, /debug routes, stack traces to users
**Step 3 -- Report findings**: For each finding output:
  - File and line number
  - Vulnerability type and severity (Critical/High/Medium/Low)
  - The exact vulnerable code snippet
  - Why it is exploitable
  - A concrete fix

**Rules**:
- Read the actual code -- do NOT guess or hallucinate findings
- Report ONLY real issues you can see in the code you read
- Skip informational notes -- only report exploitable vulnerabilities
- After reading all files, produce a final summary table: File | Line | Type | Severity
- Use shell_read to read files -- do not ask the user to paste code`;
    }

    // ── 5. Autonomy level addendum ───────────────────────────────────────────
    if (!_useSlimPrompt && loop.trustLevel === 'yolo') {
        baseSystemContent += `\n\n## AUTONOMY MODE: YOLO -- Full autonomous execution
The user has set trust level to YOLO. This means:
- **Never ask "Want me to proceed--, "Should I continue--, "Would you like me to X--** -- just do it.
- **Never stop between steps to confirm** -- complete the entire task end-to-end in one run.
- **Never propose and wait** -- if you have a clear next action, take it immediately.
- **Keep going through a plan until every step is done.** If you wrote a plan with multiple steps, execute ALL of them sequentially without pausing. Only stop when the entire task is complete.`;
    }

    // ── 6. Multi-step task nudge ─────────────────────────────────────────────
    const isPlanTask = /\b(plan|roadmap|milestone|phase|step\s*by\s*step|break\s*down)\b/i.test(userMessage);
    const isReviewTask = /\b(review|audit|check|inspect|examine|look\s+at|go\s+through)\b/i.test(userMessage);
    const _isMultiStepTask = !loop.completionSignaled && (
        isPlanTask
        || isReviewTask
        || /\b(audit|migrate|refactor|rework|overhaul|clean\s*up|go\s+(one\s+by\s+one|through\s+(each|all|them))|one\s+at\s+a\s+time|step\s+by\s+step|systematically|work\s+(through|on)\s+(each|all)|let'?s\s+start\s+from\s+the\s+top|start\s+from\s+the\s+top)\b/i.test(userMessage)
        || /\b(all|every|each)\b.{0,40}\b(file|script|route|function|endpoint)\b/i.test(userMessage)
        || /(\band\s+(then\s+)?fix|\band\s+(then\s+)?update|\band\s+(then\s+)?deploy|\bthen\s+(commit|push|deploy|test|verify))/i.test(userMessage)
    );
    const _taskLogNotYetCalled = !loop.activeTask;
    if (!_useSlimPrompt && _isMultiStepTask && _taskLogNotYetCalled) {
        baseSystemContent += `\n\n## MULTI-STEP TASK — LOG YOUR PLAN FIRST
Before executing anything, call task_plan with action="create" and a "steps" array listing the steps you plan to take (e.g. ["Review X", "Fix Y", "Deploy Z"]). Then call task_plan action="advance" after each step completes. The ledger persists to disk and is re-injected every turn, so you never lose track of what is done vs. pending across context compactions and turn-limit resets.`;
    }

    // ── 7. Plan-first gate ───────────────────────────────────────────────────
    const isPlanFirstRequest = /\b(tell\s+me\s+(what|how)|explain\s+(what|how)|before\s+(you\s+)?(proceed|start|making)|what\s+(are|do)\s+you\s+(going|plan)\s+to\s+do|describe\s+(your|the)\s+plan|how\s+would\s+you\s+approach|what'?s\s+your\s+plan)\b/i.test(userMessage);
    if (isPlanFirstRequest) {
        loop.planFirstMode = true;
        baseSystemContent += `\n\n## ⛔ PLAN-FIRST MODE — DO NOT MAKE ANY CHANGES YET
The user has explicitly asked you to explain what you are going to do BEFORE making any changes.

Your job this turn:
1. Read whatever files you need to understand the task (read_file / search_files are allowed).
2. Write a clear, numbered plan describing exactly what you will change and why.
3. End your response with: "Shall I proceed?" — then STOP. Do not call edit_file or write_file.

The edit_file and write_file tools are BLOCKED until the user replies with a confirmation ("go ahead", "yes", "do it", "proceed", "looks good", or similar). If you call them now, they will be rejected. Present your plan and wait.`;
    } else if (loop.planFirstMode && loop.planConfirmed) {
        loop.planFirstMode = false;
        baseSystemContent += `\n\n## ✅ PLAN-FIRST MODE CLEARED
The plan-first hold from an earlier turn is now lifted. write_file, edit_file, and all other tools are available. Proceed with the task immediately — do not ask for permission again.`;
    } else if (loop.planFirstMode) {
        baseSystemContent += `\n\n## ⛔ PLAN-FIRST MODE — STILL WAITING FOR CONFIRMATION
You already presented your plan. The user has NOT yet confirmed. Do NOT call edit_file or write_file. Answer any questions, then remind the user to say "go ahead" when ready.`;
    }

    // ── 8. Plan ledger injection ─────────────────────────────────────────────
    const _planTaskId = loop.activeTask;
    if (_planTaskId && workspaceRoot) {
        try {
            const _planPath = path.join(workspaceRoot, '.ollamaforge', 'tasks', _planTaskId, 'plan.json');
            if (fs.existsSync(_planPath)) {
                const _ledger = JSON.parse(fs.readFileSync(_planPath, 'utf8'));
                if (Array.isArray(_ledger.steps) && _ledger.steps.length > 0) {
                    const _done = _ledger.steps.filter((s: any) => s.status === 'done').length;
                    const _pending = _ledger.steps.filter((s: any) => s.status === 'pending').length;
                    const _nextIdx = _ledger.steps.findIndex((s: any) => s.status === 'pending');
                    const _lines = _ledger.steps.map((s: any, i: number) => {
                        const mark = s.status === 'done' ? '[x]' : s.status === 'pending' ? '[ ]' : `[${s.status}]`;
                        return `  ${i + 1}. ${mark} ${s.text}${s.note ? ` — ${s.note}` : ''}`;
                    }).join('\n');
                    baseSystemContent += `\n\n## ACTIVE PLAN LEDGER — "${_planTaskId}" (${_done}/${_ledger.steps.length} done, ${_pending} pending)
${_lines}
${_nextIdx !== -1 ? `NEXT STEP: ${_ledger.steps[_nextIdx].text}. Work on it now, then call task_plan action="advance".` : 'All steps resolved. Call task_log status="done" to close out.'}`;
                }
            }
        } catch { /* ledger read failure is non-fatal */ }
    }

    // ── 9. Active task anchor ────────────────────────────────────────────────
    const _anchorTask = loop.currentTaskMessage || loop.originalTaskMessage;
    if (_anchorTask) {
        const _taskNofM = _anchorTask.match(/^\[TASK (\d+)\/(\d+)\]/);
        const _taskScopeNote = _taskNofM
            ? ` This is task ${_taskNofM[1]} of ${_taskNofM[2]}. Complete ONLY this task, then stop. Do NOT start or mention other tasks from other lists.`
            : '';
        baseSystemContent += `\n\n## ACTIVE TASK (persists across compaction)
${_anchorTask}${_taskScopeNote}
Keep working on this task. Do not drift to unrelated work.`;
    }

    // ── 10. Memory context ───────────────────────────────────────────────────
    let memoryContext = '';
    const memory = services.memory;
    if (memory) {
        try {
            const maxTokens = memory.config.maxContextTokens || 4000;
            memoryContext = await memory.buildRelevantContext(userMessage, maxTokens);
            if (memoryContext) {
                logInfo(`[agent] Loaded relevant memory context: ${Math.ceil(memoryContext.length / 4)} tokens`);
                // Annotate file refs with [VERIFY] so the model reads source before answering.
                // Skip if the last assistant turn was a memory write (freshly saved, no contradiction possible).
                const fileRefRx = /\b([\w./-]+\.(?:db|sqlite|sqlite3|json|py|ts|js|yaml|yml|conf|cfg|env|log|txt|csv|sh))\b/gi;
                const lastAssistantMsg = [...history].reverse().find(m => m.role === 'assistant');
                const lastWasMemoryWrite = lastAssistantMsg?.tool_calls?.some((tc: any) => tc.function.name === 'memory_tier_write') ?? false;
                if (!lastWasMemoryWrite && fileRefRx.test(memoryContext)) {
                    memoryContext = memoryContext.replace(
                        /\b([\w./-]+\.(?:db|sqlite|sqlite3|json|py|ts|js|yaml|yml|conf|cfg|env|log|txt|csv|sh))\b/gi,
                        '$1[VERIFY]'
                    );
                    memoryContext += '\n\n[VERIFY] = read the source code that defines this path before using this value — do NOT answer from memory alone.';
                }
            }
        } catch (e) {
            logWarn(`[agent] Memory context build failed: ${e}`);
        }
    }

    // ── 10b. Qdrant offline notice ───────────────────────────────────────────
    if (memory && !(memory as any).isQdrantAvailable) {
        baseSystemContent += `\n\n[MEMORY STATUS] Semantic memory (Tiers 4-5) is OFFLINE — Qdrant/embedding service is unavailable. memory_search will only return local Tier 0-3 results. Do NOT expect past-session solutions or semantic lookups to be available this session.`;
    }

    // ── 10c. Recent-work briefing ────────────────────────────────────────────
    if (memory && !loop.isSmallModel) {
        try {
            const tier3 = memory.getTier(3)
                .filter((e: any) => e.tags?.includes('session-end') || e.tags?.includes('completed'))
                .slice(-2);
            const tier2disc = memory.getTier(2)
                .filter((e: any) => e.tags?.includes('auto-discovery') || e.tags?.includes('stub') || e.tags?.includes('template'))
                .slice(0, 3);
            const tier4recent = memory.getTier(4).slice(-2);
            const recentEntries = [...tier3, ...tier2disc, ...tier4recent].slice(0, 5);
            if (recentEntries.length > 0) {
                const briefing = recentEntries.map((e: any) => `- ${e.content.slice(0, 200)}`).join('\n');
                baseSystemContent += `\n\n## Recent work (from memory)\n${briefing}\nUse this to avoid re-discovering facts already known.`;
                logInfo(`[memory] Injected recent-work briefing: ${recentEntries.length} entries`);
            }
        } catch { /* skip if memory unavailable */ }
    }

    // ── 10d. Resume detection ────────────────────────────────────────────────
    const isResumeIntent = history.length <= 1
        && /\b(continue|resume|pick\s+up|where\s+(were|was|did)\s+we|what\s+(were|was|are)\s+we|carry\s+on|keep\s+going|what('s|\s+is)\s+(left|next|pending|remaining)|still\s+(working|need)|finish(ing|ed)?|where\s+did\s+we|last\s+time)\b/i.test(userMessage);
    if (isResumeIntent && memory) {
        try {
            const sweepEntries = memory.getTier(2)
                .filter((e: any) => e.tags?.includes('sweep-progress') || e.tags?.includes('wip-sync'))
                .slice(-2);
            const sessionEntries = memory.getTier(3)
                .filter((e: any) => e.tags?.includes('session-end') || e.tags?.includes('completed'))
                .slice(-1);
            const resumeEntries = [...sweepEntries, ...sessionEntries];
            if (resumeEntries.length > 0) {
                const resumeLines = resumeEntries.map((e: any) => e.content).join('\n\n---\n');
                baseSystemContent += `\n\n## [RESUME REQUESTED]\nThe user wants to pick up where the last session left off. Here is the persisted state from memory:\n\n${resumeLines}\n\nYour job:\n1. Summarize what was done and what remains in 2-3 sentences\n2. Ask the user if they want to continue with the pending work\n3. If they confirm, proceed with the next pending step immediately — do not re-explain the whole plan`;
                logInfo(`[resume] Injected resume context: ${resumeEntries.length} entries`);
            } else {
                baseSystemContent += `\n\n## [RESUME REQUESTED]\nThe user wants to pick up where the last session left off, but no persisted task state was found in memory. Let the user know you don't have a record of unfinished work, and ask them to describe what they'd like to do.`;
            }
        } catch { /* non-fatal */ }
    }

    // ── 10e. Prior-work existence check ─────────────────────────────────────
    const isImplementTask = /\b(implement|create|add|build|make|set up|write)\b/i.test(userMessage)
        && !/\b(plan|discuss|design|proposal)\b/i.test(userMessage);
    if (memory && isImplementTask) {
        try {
            const kwMatch = userMessage.match(/\b([a-z][a-z0-9_]{3,})\b/gi) ?? [];
            const stopWords = new Set(['the','this','that','with','from','into','for','and','create','make','build','add','implement','write','should','would','could','please','just','need','want']);
            const searchKws = kwMatch.filter(w => !stopWords.has(w.toLowerCase())).slice(0, 5);
            if (searchKws.length >= 2) {
                const priorHits = await memory.searchMemory(searchKws.join(' '), undefined, 5);
                const completedHits = priorHits.filter((h: any) =>
                    h.tags?.includes('completed-feature') || h.tags?.includes('session-end') || h.tags?.includes('completed')
                );
                if (completedHits.length > 0) {
                    const hitLines = completedHits.map((h: any) => `  - ${h.content.slice(0, 150)}`).join('\n');
                    baseSystemContent += `\n\n## [PRIOR WORK DETECTED]\nMemory contains entries suggesting this feature may already be implemented:\n${hitLines}\n\nBEFORE writing any code:\n1. Call memory_search("${searchKws.slice(0,3).join(' ')}") to review the full details\n2. Check the relevant file(s) to confirm whether the feature exists\n3. If it already exists, tell the user what was found and ask if they want changes\n4. Only proceed with new code if the feature is genuinely missing`;
                    logInfo(`[prior-work] Injected existence check: ${completedHits.length} hit(s)`);
                }
            }
        } catch { /* non-fatal */ }
    }

    // ── 10f. Flask/Python filesystem scan ───────────────────────────────────
    if (isImplementTask && workspaceRoot) {
        try {
            const hasPyFs = fs.existsSync(path.join(workspaceRoot, 'requirements.txt'))
                || fs.existsSync(path.join(workspaceRoot, 'pyproject.toml'))
                || fs.existsSync(path.join(workspaceRoot, 'setup.py'));
            const STOP_FS = new Set(['add','insert','fix','update','change','modify','implement',
                'the','a','an','to','in','on','of','for','that','this','and','or','with',
                'from','into','should','would','could','will','can','all','returns',
                'return','json','please','just','need']);
            const fsKws = userMessage.toLowerCase().split(/\W+/)
                .filter(w => w.length > 3 && !STOP_FS.has(w)).slice(0, 6);
            if (hasPyFs && fsKws.length >= 1) {
                const scanDirs = ['app/routes', 'app/services', 'app/views', 'app/blueprints']
                    .map(d => path.join(workspaceRoot, d))
                    .filter(d => fs.existsSync(d));
                interface FsScanHit { relPath: string; matchedRoutes: string[]; matchedFunctions: string[] }
                const fsHits: FsScanHit[] = [];
                for (const scanDir of scanDirs) {
                    let pyFiles: string[];
                    try { pyFiles = fs.readdirSync(scanDir).filter(f => f.endsWith('.py') && f !== '__init__.py'); }
                    catch { continue; }
                    for (const pf of pyFiles) {
                        const pfAbs = path.join(scanDir, pf);
                        let pfContent: string;
                        try { pfContent = fs.readFileSync(pfAbs, 'utf8'); } catch { continue; }
                        const pfLower = pfContent.toLowerCase();
                        if (fsKws.filter(kw => pfLower.includes(kw)).length < 2) { continue; }
                        const matchedRoutes: string[] = [];
                        const matchedFunctions: string[] = [];
                        for (const line of pfContent.split('\n')) {
                            const rm = line.match(/^\s*@\w+\.route\(['"]([^'"]+)['"]/);
                            if (rm) { matchedRoutes.push(rm[1]); }
                            const fm = line.match(/^\s*(?:async\s+)?def\s+(\w+)\s*\(/);
                            if (fm && !fm[1].startsWith('_')) { matchedFunctions.push(fm[1]); }
                        }
                        const relevantRoutes = matchedRoutes.filter(r => fsKws.some(kw => r.toLowerCase().includes(kw)));
                        const relevantFns = matchedFunctions.filter(fn => fsKws.some(kw => fn.toLowerCase().includes(kw)));
                        if (relevantRoutes.length > 0 || relevantFns.length > 0) {
                            const rel = path.relative(workspaceRoot, pfAbs).replace(/\\/g, '/');
                            fsHits.push({ relPath: rel, matchedRoutes: relevantRoutes, matchedFunctions: relevantFns });
                        }
                    }
                }
                if (fsHits.length > 0) {
                    const hitLines = fsHits.map(h => {
                        const parts = [`  File: \`${h.relPath}\``];
                        if (h.matchedRoutes.length > 0) { parts.push(`  Routes: ${h.matchedRoutes.map(r => `\`${r}\``).join(', ')}`); }
                        if (h.matchedFunctions.length > 0) { parts.push(`  Functions: ${h.matchedFunctions.map(f => `\`${f}\``).join(', ')}`); }
                        return parts.join('\n');
                    }).join('\n\n');
                    baseSystemContent += `\n\n## [FEATURE ALREADY EXISTS — FILE SYSTEM SCAN]\n\nBefore writing any code, a scan found existing code matching this task:\n\n${hitLines}\n\nYou MUST:\n1. Read the file(s) listed above\n2. Tell the user exactly what already exists\n3. Only write NEW code if the requested feature is genuinely absent`;
                    logInfo(`[fs-scan] Injected existence warning: ${fsHits.length} hit(s)`);
                }
            }
        } catch { /* non-fatal */ }
    }

    // ── 10g. Session recon ───────────────────────────────────────────────────
    if (ctx.sessionRecon) {
        baseSystemContent += `\n\n${ctx.sessionRecon}`;
    }

    // ── 10h. Task-type-specific suffix ──────────────────────────────────────
    if (loop.isEditTask && loop.editContextInjected) {
        const isFormTaskMsg = /\b(form|template|inline|frontend|html)\b/i.test(userMessage)
            || /\badd\b.{0,40}\b(field|column|input)\b/i.test(userMessage);
        const isBugFixMsg = /\bfix\b/i.test(userMessage) && !/\ball\b|\bevery\b/.test(userMessage);
        const isAddRouteMsg = /\badd\b.{0,30}\broute\b/i.test(userMessage);
        if (isFormTaskMsg) {
            baseSystemContent += `\n\n## TASK TYPE: Add field to form\nThis task requires changes to MULTIPLE files — the HTML template, the JS submit handler, and possibly the backend route. You MUST edit all of them. Do not stop after one file.`;
        } else if (isBugFixMsg) {
            baseSystemContent += `\n\n## TASK TYPE: Bug fix\nRead the error, find the exact line, fix it with edit_file. Do not describe the fix — apply it. One sentence response after the fix: what was wrong and what was changed.`;
        } else if (isAddRouteMsg) {
            baseSystemContent += `\n\n## TASK TYPE: Add route\nCopy the pattern shown in the pre-loaded context exactly. Do not invent a different structure. Call edit_file_at_line once.`;
        }
    }

    // ── 11. Code graph context ───────────────────────────────────────────────
    let graphContext = '';
    const codeGraph = services.codeGraph as any;
    if (codeGraph?.isReady?.()) {
        // ROUTER.md
        try {
            const { loadRouterMd } = await import('../codeGraph');
            const routerMd = loadRouterMd(workspaceRoot);
            if (routerMd) {
                graphContext += `## CODE GRAPH ROUTER\n${routerMd}\n\n`;
            }
        } catch { /* non-fatal */ }

        // Memory/graph cross-reference
        let conflictSymbols: string[] = [];
        if (memory) {
            try {
                const allEntries: Array<{ content: string }> = [];
                for (let t = 0; t <= 3; t++) {
                    for (const e of memory.getTier(t as 0 | 1 | 2 | 3)) {
                        allEntries.push({ content: e.content });
                    }
                }
                if (allEntries.length > 0) {
                    const conflicts = codeGraph.crossReferenceMemory(allEntries);
                    conflictSymbols = conflicts.map((c: any) => c.symbolName);
                    const conflictBlock = codeGraph.formatMemoryConflicts(conflicts);
                    if (conflictBlock) {
                        graphContext += conflictBlock + '\n\n';
                        logInfo(`[codeGraph] Memory/graph conflicts injected: ${conflicts.length} symbols`);
                    }
                }
            } catch { /* skip */ }
        }

        // Scope context
        const scopeQuery = conflictSymbols.length > 0
            ? `${userMessage} ${conflictSymbols.slice(0, 6).join(' ')}`
            : userMessage;
        const scope = codeGraph.buildScopeContext(scopeQuery, 1500);
        if (scope && scope.nodeCount > 0) {
            graphContext += scope.text + '\n\n';
            logInfo(`[codeGraph] Scope context injected: ${scope.nodeCount} nodes, ~${scope.tokenEstimate} tokens`);
        }

        // Drift report
        try {
            const drift = codeGraph.checkDrift(100);
            const driftReport = codeGraph.formatDriftReport(drift);
            if (driftReport) {
                graphContext += driftReport + '\n\n';
                logInfo(`[codeGraph] Drift report injected: ${drift.gone.length} gone, ${drift.ambiguous.length} ambiguous`);
            }
        } catch { /* non-fatal */ }
    }

    // ── 12. Fan-out: codeIndex + memory (unified) ───────────────────────────
    try {
        const { findRelevant } = await import('../contextFanout');
        const fanout = await findRelevant(userMessage, null, services.codeIndex, memory);
        if (fanout.text) {
            graphContext += fanout.text + '\n\n';
            logInfo(`[fanout] Unified context injected: ~${fanout.tokenEstimate} tokens (index=${fanout.sources.index}, memory=${fanout.sources.memory})`);
        }
    } catch (e) {
        logWarn('[fanout] Unified context query failed: ' + String(e));
    }

    // ── 13. Adaptive context: pre-load graph-scored symbol bodies ────────────
    const cgAdaptive = services.codeGraph as any;
    if (cgAdaptive?.isReady?.() && !loop.editContextInjected && userMessage.length > 20) {
        try {
            const topNodes = cgAdaptive.getTopScoredNodes(userMessage, 5);
            const highScoreNodes = topNodes.filter((n: any) => n.score > 1);
            if (highScoreNodes.length > 0) {
                const fileRanges = new Map<string, { start: number; end: number; names: string[] }>();
                for (const n of highScoreNodes) {
                    const existing = fileRanges.get(n.file);
                    if (existing) {
                        existing.start = Math.min(existing.start, n.startLine);
                        existing.end = Math.max(existing.end, n.endLine);
                        existing.names.push(n.name);
                    } else {
                        fileRanges.set(n.file, { start: n.startLine, end: n.endLine, names: [n.name] });
                    }
                }

                const adaptiveParts: string[] = [];
                let adaptiveTokens = 0;
                const ADAPTIVE_TOKEN_CAP = 600;
                const MAX_LINES_PER_FILE = 120;

                for (const [filePath, range] of fileRanges) {
                    if (adaptiveTokens >= ADAPTIVE_TOKEN_CAP) break;
                    try {
                        const fullPath = path.isAbsolute(filePath) ? filePath : path.join(workspaceRoot, filePath);
                        const lines = fs.readFileSync(fullPath, 'utf8').split('\n');
                        const start = Math.max(0, range.start - 1);
                        const end = Math.min(lines.length, range.end);
                        const slice = lines.slice(start, Math.min(end, start + MAX_LINES_PER_FILE));
                        const snippet = slice.map((l: string, i: number) => `  ${start + i + 1}\t${l}`).join('\n');
                        const estTokens = Math.ceil(snippet.length / 4);
                        if (adaptiveTokens + estTokens <= ADAPTIVE_TOKEN_CAP) {
                            adaptiveParts.push(`### ${filePath} (${range.names.join(', ')})\n\`\`\`\n${snippet}\n\`\`\``);
                            adaptiveTokens += estTokens;
                        }
                    } catch { /* file read failure is non-fatal */ }
                }

                if (adaptiveParts.length > 0) {
                    graphContext += `## ADAPTIVE CONTEXT (pre-loaded from code graph)\n${adaptiveParts.join('\n\n')}\n\n`;
                    logInfo(`[adaptive] Pre-loaded ${adaptiveParts.length} file(s), ~${adaptiveTokens} tokens`);
                }
            }
        } catch (e) {
            logWarn('[adaptive] Adaptive context failed: ' + String(e));
        }
    }

    // ── 14. Merge memory + graph into final system string ───────────────────
    // All addenda to baseSystemContent above (10b–10h, sections 2–9) are already
    // appended. Now attach the memory context block and graph context.
    let baseSystemWithMemory = baseSystemContent;
    if (memoryContext) {
        baseSystemWithMemory += `\n\n## Your Persistent Memory\n${memoryContext}

IMPORTANT: Only critical infrastructure is shown above. You have MORE memories stored across tiers 1-5.
- Before answering questions about project setup, conventions, frameworks, past decisions, or known issues -> call memory_search("<topic>")
- Before implementing ANY feature request or code change -> call memory_search("<feature area>") to check existing patterns
Do NOT assume you have no memory — check first.

STALE MEMORY PROTOCOL: After reading any file that contains a fact also mentioned in "## Your Persistent Memory" above — compare them. If they contradict, correct the stale memory entry immediately.

PROACTIVE MEMORY SAVES: When you discover facts you had to look up that you should not need to look up again — save them immediately without being asked.`;
    }

    // ── 15. Graph context appended to system ─────────────────────────────────
    if (graphContext) {
        baseSystemWithMemory += `\n\n${graphContext}`;
    }

    // ── 16. Memory nudge message ─────────────────────────────────────────────
    let memoryNudgeMsg: OllamaMessage | undefined;
    if (loop.userTurnCount > 0 && loop.userTurnCount % limits.memoryNudgeInterval === 0) {
        const nudge = _buildMemoryNudge(loop.userTurnCount, limits.memoryNudgeInterval);
        if (nudge) {
            memoryNudgeMsg = { role: 'user', content: nudge };
        }
    }

    // ── 17. Context budget message ───────────────────────────────────────────
    let ctxBudgetMsg: OllamaMessage | undefined;
    try {
        const stats = calculateContextStats(history, baseSystemWithMemory, memoryContext, loop.currentModel);
        const remainingPct = Math.round((1 - stats.usagePercentage) * 100);
        if (remainingPct < 25) {
            const toolBiasNote = buildToolBiasNote(remainingPct);
            ctxBudgetMsg = { role: 'user', content: `[context: ${remainingPct}% remaining] ${toolBiasNote}` };
        }
    } catch { /* non-fatal */ }

    // ── 18. Assemble final messages ──────────────────────────────────────────
    const messages: OllamaMessage[] = [
        { role: 'system', content: baseSystemWithMemory },
        ...history,
        ...(memoryNudgeMsg ? [memoryNudgeMsg] : []),
        ...(ctxBudgetMsg ? [ctxBudgetMsg] : []),
    ];

    logInfo(`[context] Assembled ${messages.length} messages, system=${baseSystemWithMemory.length} chars, memory=${memoryContext.length} chars, graph=${graphContext.length} chars`);

    return {
        messages,
        systemContent: baseSystemWithMemory,
        memoryContext,
        contextFileMtimes,
    };
}
