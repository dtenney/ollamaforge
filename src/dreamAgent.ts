/**
 * Dream agent: offline, asynchronous consolidation of interaction logs into
 * proposed behavioral rules.
 *
 * Runs as a background Agent instance (no UI) during low-load times. Reads
 * session logs, feedback entries, and task logs, then produces candidate rules
 * written to .ollamaforge/proposed_rules.md. A VS Code notification prompts
 * the user to review and accept them via the "Ollama Forge: Accept Proposed Rules"
 * command, which merges accepted rules into .ollamaforge/context.md.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { Agent, PostFn } from './agent';
import { getConfig } from './config';
import { getSearchConfig } from './config';
import { logInfo, logError, toErrorMessage } from './logger';
import { rawGet, streamChatRequest } from './ollamaClient';
import { dreamHealthSummary } from './stackHealth';
import { TieredMemoryManager } from './memoryCore';
import { CodeIndexer } from './codeIndex';
import type { SessionLogEntry } from './sessionLog';

// ── Constants ──────────────────────────────────────────────────────────────────

const MIN_NEW_FEEDBACK_ENTRIES = 3;
const MIN_HOURS_BETWEEN_RUNS   = 6;
const MAX_LOG_CHARS            = 16_000;
const MAX_TASK_LOGS            = 10;
const MAX_SESSION_LINES        = 40;
const IN_FLIGHT_GUARD_MINUTES  = 10;

/** Sessions with ≤ this many turns and no guard events are considered efficient */
const EFFICIENT_TURN_THRESHOLD = 3;
/** Sessions with ≥ this many turns or any guard events are considered slow */
const SLOW_TURN_THRESHOLD      = 6;

// ── Dream state ────────────────────────────────────────────────────────────────

interface DreamState {
    last_run_ts: number;
    last_feedback_count: number;
    last_positive_count: number;
}

function readDreamState(workspaceRoot: string): DreamState {
    const p = path.join(workspaceRoot, '.ollamaforge', 'dream_state.json');
    try {
        const s = JSON.parse(fs.readFileSync(p, 'utf8'));
        return { last_run_ts: s.last_run_ts ?? 0, last_feedback_count: s.last_feedback_count ?? 0, last_positive_count: s.last_positive_count ?? 0 };
    } catch {
        return { last_run_ts: 0, last_feedback_count: 0, last_positive_count: 0 };
    }
}

function writeDreamState(workspaceRoot: string, state: DreamState): void {
    const p = path.join(workspaceRoot, '.ollamaforge', 'dream_state.json');
    try { fs.writeFileSync(p, JSON.stringify(state, null, 2), 'utf8'); }
    catch { /* non-fatal */ }
}

// ── Rate gate ──────────────────────────────────────────────────────────────────

interface GateResult {
    run: boolean;
    reason: string;
    currentFeedbackCount: number;
    newFeedbackCount: number;
    currentPositiveCount: number;
}

function shouldRunDream(workspaceRoot: string): GateResult {
    // Guard against concurrent in-flight runs via a lock file written at the
    // START of runDreamCycle() (not at the end), so we detect overlap even
    // if the cycle hasn't produced proposed_rules.md yet.
    const lockPath = path.join(workspaceRoot, '.ollamaforge', 'dream.lock');
    try {
        const stat = fs.statSync(lockPath);
        if ((Date.now() - stat.mtimeMs) < IN_FLIGHT_GUARD_MINUTES * 60 * 1000) {
            return { run: false, reason: 'dream.lock present — another cycle is in flight', currentFeedbackCount: 0, newFeedbackCount: 0, currentPositiveCount: 0 };
        }
        // Lock is stale (older than IN_FLIGHT_GUARD_MINUTES) — a crashed run left it; remove it
        try { fs.unlinkSync(lockPath); } catch { /* best-effort */ }
    } catch { /* lock file doesn't exist — fine, no cycle running */ }

    const state = readDreamState(workspaceRoot);
    const hoursSinceLast = (Date.now() - state.last_run_ts) / 3_600_000;

    // Count negative feedback entries
    let currentFeedbackCount = 0;
    const feedbackPath = path.join(workspaceRoot, '.ollamaforge', 'feedback.md');
    try {
        const content = fs.readFileSync(feedbackPath, 'utf8');
        currentFeedbackCount = (content.match(/^## \[/gm) || []).length;
    } catch { /* no feedback yet */ }

    // Count positive feedback entries (used as signal, not as gate condition)
    let currentPositiveCount = 0;
    const positivePath = path.join(workspaceRoot, '.ollamaforge', 'positive_feedback.md');
    try {
        const content = fs.readFileSync(positivePath, 'utf8');
        currentPositiveCount = (content.match(/^## \[/gm) || []).length;
    } catch { /* no positive feedback yet */ }

    // Clamp to 0 in case feedback was deleted or the count was reset
    const newFeedbackCount = Math.max(0, currentFeedbackCount - state.last_feedback_count);

    if (newFeedbackCount < MIN_NEW_FEEDBACK_ENTRIES) {
        return { run: false, reason: `only ${newFeedbackCount} new feedback entries (need ${MIN_NEW_FEEDBACK_ENTRIES})`, currentFeedbackCount, newFeedbackCount, currentPositiveCount };
    }
    if (hoursSinceLast < MIN_HOURS_BETWEEN_RUNS) {
        return { run: false, reason: `last run was ${hoursSinceLast.toFixed(1)}h ago (need ${MIN_HOURS_BETWEEN_RUNS}h)`, currentFeedbackCount, newFeedbackCount, currentPositiveCount };
    }

    return { run: true, reason: 'conditions met', currentFeedbackCount, newFeedbackCount, currentPositiveCount };
}

// ── Log harvesting ─────────────────────────────────────────────────────────────

function harvestLogs(workspaceRoot: string): string {
    const parts: string[] = [];
    const ollamaDir = path.join(workspaceRoot, '.ollamaforge');

    // 1. Negative feedback entries (problems the user flagged)
    try {
        const content = fs.readFileSync(path.join(ollamaDir, 'feedback.md'), 'utf8');
        parts.push(`## Negative feedback (behaviors the user flagged as problems)\n${content.trim()}`);
    } catch { /* no feedback file */ }

    // 2. Positive feedback entries (responses the user marked helpful)
    try {
        const content = fs.readFileSync(path.join(ollamaDir, 'positive_feedback.md'), 'utf8');
        parts.push(`## Positive feedback (responses the user found helpful — reinforce these patterns)\n${content.trim()}`);
    } catch { /* no positive feedback yet */ }

    // 3. Session quality analysis — bucket into efficient vs slow for contrast
    try {
        const raw = fs.readFileSync(path.join(ollamaDir, 'sessions.jsonl'), 'utf8');
        const lines = raw.trim().split('\n').filter(Boolean).slice(-MAX_SESSION_LINES);

        const efficient: string[] = [];
        const slow: string[] = [];
        const other: string[] = [];

        for (const line of lines) {
            try {
                const e: SessionLogEntry = JSON.parse(line);
                const guards = e.guardEvents?.map(g => g.type).join(', ') || 'none';
                const tools  = e.toolCalls?.map(t => t.name).join(', ') || 'none';
                const summary = `[${e.ts?.slice(0, 10) ?? '?'}] ${e.outcome} | ${e.turns} turns | task:${e.task?.slice(0, 100)} | tools:${tools} | guards:${guards}`;
                const hasGuards = guards !== 'none';
                const turns = e.turns ?? 0;
                if (!hasGuards && turns <= EFFICIENT_TURN_THRESHOLD) {
                    efficient.push(summary);
                } else if (hasGuards || turns >= SLOW_TURN_THRESHOLD) {
                    slow.push(summary);
                } else {
                    other.push(summary);
                }
            } catch { /* skip malformed line */ }
        }

        if (efficient.length) {
            parts.push(`## Efficient sessions (≤${EFFICIENT_TURN_THRESHOLD} turns, no guards — what is working well)\n${efficient.join('\n')}`);
        }
        if (slow.length) {
            parts.push(`## Slow/problematic sessions (≥${SLOW_TURN_THRESHOLD} turns or guards fired — what needs improvement)\n${slow.join('\n')}`);
        }
        if (other.length) {
            parts.push(`## Other sessions\n${other.join('\n')}`);
        }
    } catch { /* no sessions file */ }

    // 4. Recent task logs (most recently modified, capped)
    try {
        const tasksDir = path.join(ollamaDir, 'tasks');
        const subdirs = fs.readdirSync(tasksDir, { withFileTypes: true })
            .filter(e => e.isDirectory())
            .map(e => {
                const logPath = path.join(tasksDir, e.name, 'log.md');
                try { return { logPath, mtime: fs.statSync(logPath).mtimeMs }; }
                catch { return null; }
            })
            .filter((x): x is { logPath: string; mtime: number } => x !== null)
            .sort((a, b) => b.mtime - a.mtime)
            .slice(0, MAX_TASK_LOGS);

        const taskParts: string[] = [];
        for (const { logPath } of subdirs) {
            try {
                const content = fs.readFileSync(logPath, 'utf8').slice(0, 800);
                taskParts.push(content.trim());
            } catch { /* unreadable */ }
        }
        if (taskParts.length) {
            parts.push(`## Recent task logs\n${taskParts.join('\n\n---\n\n')}`);
        }
    } catch { /* no tasks dir */ }

    // 5. Existing learned rules (so the dream agent can identify stale/contradictory ones)
    try {
        const contextPath = path.join(ollamaDir, 'context.md');
        const content = fs.readFileSync(contextPath, 'utf8');
        const rulesIdx = content.indexOf('## Learned Rules');
        if (rulesIdx !== -1) {
            const rulesSection = content.slice(rulesIdx).slice(0, 2000).trim();
            parts.push(`## Currently active learned rules (identify any that are stale, contradicted by new evidence, or should be removed)\n${rulesSection}`);
        }
    } catch { /* no context.md */ }

    // 6. Existing skills (so the dream agent knows what reusable helpers exist)
    try {
        const skillsDir = path.join(ollamaDir, 'skills');
        const skills = fs.readdirSync(skillsDir).filter(f => f.endsWith('.py') || f.endsWith('.sh') || f.endsWith('.js'));
        if (skills.length) {
            const skillList = skills.map(f => {
                try {
                    const header = fs.readFileSync(path.join(skillsDir, f), 'utf8').split('\n').slice(0, 3).join(' | ');
                    return `  - ${f}: ${header.slice(0, 120)}`;
                } catch { return `  - ${f}`; }
            }).join('\n');
            parts.push(`## Available skills (.ollamaforge/skills/)\n${skillList}`);
        }
    } catch { /* no skills dir */ }

    return parts.join('\n\n').slice(0, MAX_LOG_CHARS);
}

// ── Dream agent prompt ─────────────────────────────────────────────────────────

const DREAM_SYSTEM_PROMPT = `\
You are a meta-learning agent for Ollama Forge. Your job is to analyze interaction history \
and produce a set of proposed changes to the agent's behavioral rules. Do NOT write code. Do NOT use tools.

You will receive:
- Negative feedback: responses the user flagged as problematic (second-guessing, verbosity, wrong tools, etc.)
- Positive feedback: responses the user marked as helpful — these patterns should be reinforced
- Session quality analysis: efficient sessions (≤3 turns, no guards) vs slow/problematic ones (≥6 turns or guards fired)
- Recent task logs: step traces from multi-step agent tasks
- Currently active learned rules: the rules already in context.md — review for staleness or contradictions
- Available skills: reusable helper scripts already in .ollamaforge/skills/

From this evidence, produce proposed rule changes. Each output block must be one of:

## Rule: <short imperative title>
<One to three sentences. Describe what the agent should do and cite the evidence. Must be \
grounded in observed patterns — positive OR negative. Should read naturally as a rule in \
a context.md "Learned Rules" section.>

## Remove Rule: <exact title of existing rule to remove>
<One sentence explaining why this rule is now stale, contradicted, or no longer needed.>

Rules you ADD must be:
- Grounded in observed evidence (cite the pattern — both good and bad sessions)
- Actionable (specific enough that an agent can comply without ambiguity)
- Non-redundant (do not restate rules already in the active learned rules section)
- Covering both things to STOP doing (from negative feedback) and things to KEEP doing (from positive feedback)

Rules you REMOVE must match the exact title of an existing rule in the "Currently active learned rules" section.

If you find no actionable changes, output exactly:
NO_NEW_RULES

Do NOT output any preamble, explanation, commentary, or text outside the ## Rule: and ## Remove Rule: blocks.`;

// ── Dream execution ────────────────────────────────────────────────────────────

async function executeDream(
    workspaceRoot: string,
    logContent: string,
    memory: TieredMemoryManager | null,
    codeIndexer: CodeIndexer | null,
    model: string,
): Promise<string> {
    const agent = new Agent(workspaceRoot, memory, codeIndexer);

    let output = '';
    const silentPost: PostFn = (m) => {
        const msg = m as { type: string; text?: string };
        if (msg.type === 'token' && msg.text) { output += msg.text; }
    };

    const userMessage = `${DREAM_SYSTEM_PROMPT}\n\n---\n\nAnalyze the following interaction history and propose behavioral rules:\n\n${logContent}`;
    await agent.run(userMessage, model, silentPost);
    return output;
}

// ── Memory consolidation ───────────────────────────────────────────────────────

const MAX_CONSOLIDATION_ENTRIES = 20;
const CONSOLIDATION_AGE_DAYS    = 14; // only consolidate entries older than this

const CONSOLIDATION_SYSTEM_PROMPT = `\
You are a memory consolidation agent. You will receive a list of memory entries from a \
coding assistant's working memory. Your job is to:

1. MERGE entries that describe the same fact (keep the most specific / recent version).
2. SUMMARIZE clusters of related entries into a single, concise statement.
3. DROP entries that are clearly obsolete, contradicted, or trivially obvious.
4. KEEP entries that are unique, specific, and likely still relevant.

Output ONLY the surviving/merged entries, one per line, starting with "- ".
Do NOT output any preamble, explanation, headers, or numbered lists.
Do NOT include entries that should be dropped.
If all entries should be kept as-is, output them unchanged.`;

/**
 * Run an LLM consolidation pass over stale tier-2 entries.
 * Merged/surviving entries replace the originals; dropped entries are invalidated.
 * Returns number of original entries processed.
 *
 * Safety order: write ALL survivors first, then invalidate originals ONLY if all writes succeeded.
 * A partial write failure leaves originals intact so the next pass can retry — duplicates are
 * preferred over data loss.
 */
async function consolidateMemoryEntries(
    memory: TieredMemoryManager,
    model: string,
): Promise<number> {
    // Gather tier-2 entries older than CONSOLIDATION_AGE_DAYS with 0 search_hits
    const entries = await memory.listByTier(2);
    const nowMs = Date.now();
    const ageCutoffMs = CONSOLIDATION_AGE_DAYS * 24 * 60 * 60 * 1000;

    const candidates = entries.filter(e => {
        if (e.invalidated) { return false; }
        const ageMs = nowMs - new Date(e.lastAccessed).getTime();
        if (ageMs < ageCutoffMs) { return false; }
        const hits = e.accessHistory?.filter(h => h.type === 'search_hit').length ?? 0;
        return hits === 0; // only consolidate entries that were never actively used
    }).slice(0, MAX_CONSOLIDATION_ENTRIES);

    if (candidates.length < 3) {
        logInfo(`[dream] Memory consolidation skipped — only ${candidates.length} stale tier-2 entries (need 3+)`);
        return 0;
    }

    logInfo(`[dream] Running memory consolidation on ${candidates.length} stale tier-2 entries`);

    const inputList = candidates.map(e => `- ${e.content}`).join('\n');
    const prompt = `${CONSOLIDATION_SYSTEM_PROMPT}\n\n---\n\nEntries to consolidate:\n\n${inputList}`;

    // Call Ollama directly (no agent loop — we just want a simple text completion)
    let rawOutput = '';
    try {
        const stopRef = { stop: false };
        await streamChatRequest(
            model,
            [{ role: 'user', content: prompt }],
            [],
            (token) => { rawOutput += token; },
            stopRef,
            { disableThinkingGuards: true }
        );
    } catch (err) {
        logError(`[dream] Memory consolidation LLM call failed: ${toErrorMessage(err)}`);
        return 0;
    }

    // Strip thinking blocks (<think>...</think> or /think markers) before parsing
    const cleaned = rawOutput
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/^\/think\s*$/gm, '')
        .trim();

    // Parse surviving entries (lines starting with "- ")
    const surviving = cleaned.split('\n')
        .map(l => l.replace(/^\s*[-*]\s*/, '').trim())
        .filter(l => l.length > 10 && !l.startsWith('<') && !l.startsWith('['));

    if (surviving.length === 0) {
        logInfo('[dream] Memory consolidation: LLM returned no surviving entries — skipping');
        return 0;
    }

    // ── Safety order: write ALL survivors FIRST, then invalidate originals ───
    // We only invalidate originals if every survivor was successfully written.
    // A partial write failure (e.g. Qdrant down mid-loop) would otherwise cause
    // data loss: some originals invalidated while their replacements were never stored.
    let writeFailures = 0;
    const writtenCount = { n: 0 };
    for (const content of surviving) {
        try {
            await memory.addEntry(2, content, ['consolidated', 'dream-pass'], {
                sourceTool: 'dream_consolidation',
            });
            writtenCount.n++;
        } catch (err) {
            writeFailures++;
            logError(`[dream] Memory consolidation: failed to write survivor: ${toErrorMessage(err)}`);
        }
    }

    if (writtenCount.n === 0) {
        logInfo('[dream] Memory consolidation: no survivors written — skipping invalidation of originals');
        return 0;
    }

    if (writeFailures > 0) {
        // Partial write failure — do NOT invalidate originals to avoid data loss.
        // Next consolidation pass will re-process the same candidates.
        logError(`[dream] Memory consolidation: ${writeFailures} write failure(s) — skipping invalidation to prevent data loss`);
        return 0;
    }

    // All survivors written — safe to batch-invalidate originals
    await memory.invalidateEntries(candidates.map(e => e.id));

    const removed = candidates.length - writtenCount.n;
    logInfo(`[dream] Memory consolidation complete: ${candidates.length} → ${writtenCount.n} entries (${removed} dropped/merged)`);
    return candidates.length;
}

// ── Rule parsing and writing ───────────────────────────────────────────────────

interface ParsedProposals {
    addBlocks: string[];
    removeBlocks: string[];  // each is "## Remove Rule: <title>\n<reason>"
}

function parseProposals(rawOutput: string): ParsedProposals {
    const trimmed = rawOutput.trim();
    if (!trimmed || trimmed === 'NO_NEW_RULES') {
        return { addBlocks: [], removeBlocks: [] };
    }

    // Split on ## Rule: or ## Remove Rule: boundaries
    const blocks = trimmed.split(/(?=^## (?:Remove )?Rule:)/m).map(b => b.trim()).filter(Boolean);
    const addBlocks = blocks.filter(b => b.startsWith('## Rule:'));
    const removeBlocks = blocks.filter(b => b.startsWith('## Remove Rule:'));
    return { addBlocks, removeBlocks };
}

function parseAndWriteRules(workspaceRoot: string, rawOutput: string): { added: number; removed: number } {
    const { addBlocks, removeBlocks } = parseProposals(rawOutput);
    if (addBlocks.length === 0 && removeBlocks.length === 0) {
        return { added: 0, removed: 0 };
    }

    const now = new Date().toISOString();
    const parts: string[] = [
        `<!-- dream-agent: proposed changes generated ${now} -->`,
        `<!-- Accept with command: Ollama Forge: Accept Proposed Rules -->`,
        '',
    ];

    if (addBlocks.length) {
        parts.push('<!-- NEW RULES TO ADD -->', ...addBlocks.map(b => b + '\n'));
    }
    if (removeBlocks.length) {
        parts.push('<!-- EXISTING RULES TO REMOVE -->', ...removeBlocks.map(b => b + '\n'));
    }

    const ollamaDir = path.join(workspaceRoot, '.ollamaforge');
    if (!fs.existsSync(ollamaDir)) { fs.mkdirSync(ollamaDir, { recursive: true }); }
    fs.writeFileSync(path.join(ollamaDir, 'proposed_rules.md'), parts.join('\n'), 'utf8');

    return { added: addBlocks.length, removed: removeBlocks.length };
}

// ── Public entry point ─────────────────────────────────────────────────────────

/**
 * Check if Ollama is currently running an inference (via /api/ps).
 * Returns true if the model is actively generating, meaning the dream cycle
 * should defer to avoid competing for VRAM/inference time.
 */
async function isOllamaActivelyRunning(): Promise<boolean> {
    try {
        const { status, body } = await rawGet('/api/ps', 3000);
        if (status !== 200) { return false; }
        const parsed = JSON.parse(body) as { models?: { name: string; size_vram?: number }[] };
        // /api/ps returns loaded models; size_vram > 0 means the model is occupying GPU memory
        // and is likely mid-inference. A loaded-but-idle model has size_vram = 0.
        return (parsed.models ?? []).some(m => (m.size_vram ?? 0) > 0);
    } catch {
        return false; // If we can't check, don't block the dream cycle
    }
}

export async function runDreamCycle(
    workspaceRoot: string,
    memory: TieredMemoryManager | null,
    codeIndexer: CodeIndexer | null,
): Promise<void> {
    const gate = shouldRunDream(workspaceRoot);
    if (!gate.run) {
        logInfo(`[dream] Skipped — ${gate.reason}`);
        return;
    }

    // Don't compete for VRAM with an active main agent inference
    if (await isOllamaActivelyRunning()) {
        logInfo('[dream] Skipped — Ollama has active inference in progress (will retry next cycle)');
        return;
    }

    logInfo(`[dream] Starting cycle (${gate.newFeedbackCount} new negative feedback entries, ${gate.currentPositiveCount} positive total)`);

    // Write lock file immediately so any concurrent call to shouldRunDream() sees it
    // and bails out. The finally block below removes it regardless of outcome.
    const lockPath = path.join(workspaceRoot, '.ollamaforge', 'dream.lock');
    try { fs.writeFileSync(lockPath, String(Date.now()), 'utf8'); } catch { /* non-fatal */ }

    try {
        const cfg = getConfig();
        const model = cfg.dreamModel || cfg.model;

        // ── Memory consolidation pass (Mnemosyne-inspired) ─────────────────────
        // Runs before rule generation — compresses stale tier-2 entries via LLM.
        if (memory) {
            try {
                await consolidateMemoryEntries(memory, model);
            } catch (err) {
                logError(`[dream] Memory consolidation error (non-fatal): ${toErrorMessage(err)}`);
            }
        }

        const logContent = harvestLogs(workspaceRoot);
        if (!logContent.trim()) {
            logInfo('[dream] No log content to analyze — skipping');
            return;
        }

        let rawOutput: string;
        try {
            rawOutput = await executeDream(workspaceRoot, logContent, memory, codeIndexer, model);
        } catch (err) {
            logError(`[dream] Agent run failed: ${toErrorMessage(err)}`);
            return;
        }

        const { added, removed } = parseAndWriteRules(workspaceRoot, rawOutput);

        // Stack health check — runs after rule generation, appended to notification if issues found
        // Read stack config directly from VS Code since OllamaConfig doesn't expose these fields
        let sshHost = '';
        let composePath = '~/docker-compose.yml';
        let healthCheckEnabled = true;
        try {
            const stackCfg = vscode.workspace.getConfiguration('ollamaForge');
            sshHost = stackCfg.get<string>('stack.sshHost', '').trim();
            composePath = stackCfg.get<string>('stack.composePath', '~/docker-compose.yml').trim();
            healthCheckEnabled = stackCfg.get<boolean>('stack.healthCheckOnDream', true);
        } catch { /* not in a VS Code context — skip */ }
        let healthSummary = '';
        if (healthCheckEnabled && sshHost) {
            const searchCfg = getSearchConfig();
            healthSummary = dreamHealthSummary(sshHost, searchCfg.url, composePath);
            if (healthSummary) {
                logInfo(`[dream] Stack issues detected: ${healthSummary}`);
            }
        }

        // Always update state so we don't re-run on every reload if conditions remain met
        writeDreamState(workspaceRoot, {
            last_run_ts: Date.now(),
            last_feedback_count: gate.currentFeedbackCount,
            last_positive_count: gate.currentPositiveCount,
        });

        if (added === 0 && removed === 0 && !healthSummary) {
            logInfo('[dream] No actionable rule changes proposed');
            return;
        }

        logInfo(`[dream] Proposed ${added} new rule(s), ${removed} removal(s) — notifying user`);

        const ruleSummary = [
            added   ? `${added} new rule${added === 1 ? '' : 's'}` : '',
            removed ? `${removed} rule${removed === 1 ? '' : 's'} to remove` : '',
        ].filter(Boolean).join(' and ');

        const healthNote = healthSummary ? ` | Stack: ${healthSummary}` : '';
        const notifMsg = ruleSummary
            ? `Ollama Forge: Agent proposed ${ruleSummary} based on your feedback.${healthNote} Review and accept to apply.`
            : `Ollama Forge: Stack health issues detected — ${healthSummary}. Run "Check Stack Health" to review.`;

        const choices = ruleSummary ? ['Review', 'Dismiss'] : ['Check Stack Health', 'Dismiss'];
        const choice = await vscode.window.showInformationMessage(notifMsg, ...choices);
        if (choice === 'Review') {
            const rulesPath = path.join(workspaceRoot, '.ollamaforge', 'proposed_rules.md');
            try {
                const doc = await vscode.workspace.openTextDocument(rulesPath);
                await vscode.window.showTextDocument(doc);
            } catch (err) {
                logError(`[dream] Could not open proposed_rules.md: ${toErrorMessage(err)}`);
            }
        } else if (choice === 'Check Stack Health') {
            vscode.commands.executeCommand('ollamaForge.checkStackHealth');
        }
    } finally {
        // Always remove the lock file so crashed/aborted runs don't permanently block future cycles.
        // shouldRunDream() treats stale locks (> IN_FLIGHT_GUARD_MINUTES old) as crashed and removes
        // them automatically, but cleaning up here is faster and more reliable.
        try { fs.unlinkSync(lockPath); } catch { /* already removed or never written */ }
    }
}
