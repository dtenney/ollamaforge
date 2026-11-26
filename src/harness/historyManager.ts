/**
 * historyManager.ts — Context compaction and WIP snapshot management.
 *
 * Extracted from Agent (src/agent.ts) as part of the harness decomposition.
 * Owns: handleAutoCompact, saveDroppedToMemory, buildCompactSummary,
 *       injectPostCompactContext, buildWipSnapshot.
 *
 * Dependencies are injected via HistoryManagerDeps so the class is testable
 * without a full Agent instance.
 */

import { compactHistory } from '../contextCalculator';
import { streamChatRequest } from '../ollamaClient';
import { getConfig } from '../config';
import { logInfo, logWarn } from '../logger';
import type { OllamaMessage } from '../ollamaClient';
import type { TieredMemoryManager } from '../memoryCore';
import type { ActiveTaskState } from '../chatStorage';

// ── Types ─────────────────────────────────────────────────────────────────────

export type PostFn = (msg: object) => void;

/** Session tool counters that the WIP snapshot reports. */
export interface SessionToolCounters {
    read: number;
    edit: number;
    shell: number;
    other: number;
    total: number;
}

/** Tool breakdown tracking (dirty-flag pattern from Agent). */
export interface ToolBreakdownState {
    breakdown: string;
    dirty: boolean;
    last: string;
    lastDirty: boolean;
    lastTotal: number;
    lastRead: number;
    lastEdit: number;
    lastShell: number;
    lastOther: number;
}

/** All mutable state the history manager needs from the Agent. */
export interface HistoryManagerDeps {
    memory: TieredMemoryManager | null;
    currentModel: string;
    currentTaskMessage: string;
    originalTaskMessage: string;
    filesAutoReadThisRun: Set<string>;
    filesEditedThisRun: Set<string>;
    activeTask: ActiveTaskState | null;
    workspaceRoot: string;
    sessionId: string;
    toolCounters: SessionToolCounters;
    toolBreakdown: ToolBreakdownState;
    /** Model context window limit in tokens (from getModelContextLimit). */
    modelLimit: number;
    /** Estimated tokens used by the system prompt. */
    systemPromptTokens: number;
    /** Estimated tokens used by injected memory context. */
    memoryTokens: number;
}

// ── HistoryManager ────────────────────────────────────────────────────────────

export class HistoryManager {
    constructor(private deps: HistoryManagerDeps) {}

    /**
     * Handle automatic context compaction when usage exceeds the threshold.
     * Returns the compacted message array (or the original if compaction failed).
     */
    async handleAutoCompact(
        messages: OllamaMessage[],
        usagePct: number,
        post: PostFn,
    ): Promise<OllamaMessage[]> {
        const d = this.deps;
        const compactResult = compactHistory(messages, 70, d.modelLimit, d.systemPromptTokens, d.memoryTokens);
        const kept = compactResult.kept;
        const dropped = compactResult.dropped;

        if (dropped.length === 0) {
            return messages;
        }

        post({ type: 'info', text: `📦 Context compacted: dropped ${dropped.length} old messages (${usagePct.toFixed(0)}% → ~70%)` });

        // Build WIP snapshot so the agent knows where it left off
        const wipLines = this.buildWipSnapshot(usagePct, messages);
        const wipSnapshot = wipLines.join('\n');

        // Inject post-compact context (task log, WIP snapshot)
        const postCompact = this.injectPostCompactContext(wipSnapshot, wipLines);
        if (postCompact) {
            kept.push({ role: 'system', content: postCompact });
        }

        // Save dropped messages to memory for later retrieval
        this.saveDroppedToMemory(dropped);

        // Add a compact summary marker
        const summary = this.buildCompactSummary(messages.length - kept.length);
        kept.push({ role: 'system', content: summary });

        return kept;
    }

    /**
     * Save dropped messages to memory so they can be retrieved later.
     * Uses the LLM to extract structured facts from the dropped conversation.
     */
    private saveDroppedToMemory(autoDropped: OllamaMessage[]): void {
        const d = this.deps;
        if (!d.memory) { return; }
        const memory = d.memory;

        const droppedText = autoDropped
            .filter(m => m.role === 'user' || m.role === 'assistant')
            .map(m => `${m.role}: ${m.content.slice(0, 500)}`)
            .join('\n');

        const currentModel = d.currentModel || getConfig().model;
        const taskMsgSnap = d.currentTaskMessage;

        (async () => {
            try {
                let rawSummary = '';
                if (droppedText.trim()) {
                    await streamChatRequest(
                        currentModel,
                        [
                            {
                                role: 'system',
                                content: [
                                    'You are a context extractor. Extract structured facts from this conversation.',
                                    'Output ONLY a JSON object with these keys:',
                                    '  "task": what the user was working on (1 sentence)',
                                    '  "completed": array of completed steps',
                                    '  "pending": array of remaining steps',
                                    '  "files": array of file paths mentioned',
                                    '  "decisions": array of key decisions made',
                                    '  "next_step": what to do next (1 sentence)',
                                    'No markdown, no explanation, just the JSON object.',
                                ].join('\n'),
                            },
                            { role: 'user', content: droppedText },
                        ],
                        [],
                        (chunk: string) => { rawSummary += chunk; },
                        { stop: false },
                    );
                }

                const memoryEntry = [
                    `[Auto-compact] Session context saved at ${new Date().toISOString()}`,
                    d.currentTaskMessage ? `Task: ${d.currentTaskMessage}` : '',
                    rawSummary ? `Summary: ${rawSummary}` : '',
                    d.toolCounters.total > 0
                        ? `Tools: ${d.toolCounters.read} reads, ${d.toolCounters.edit} edits, ${d.toolCounters.shell} shell, ${d.toolCounters.other} other (${d.toolCounters.total} total)`
                        : '',
                ].filter(Boolean).join('\n');

                await memory.addEntry(
                    2, // Tier 2 — current work
                    memoryEntry,
                    ['auto-compact', 'session-context'],
                );
                logInfo('HistoryManager: saved compacted context to memory');
            } catch (err) {
                logWarn('HistoryManager: failed to save compacted context: ' + (err instanceof Error ? err.message : String(err)));
            }
        })();
    }

    /**
     * Build a short summary line indicating how many messages were compacted.
     */
    private buildCompactSummary(messagesRemoved: number): string {
        return `[CONTEXT COMPACTED] ${messagesRemoved} earlier messages were removed to stay within the context window. The WIP snapshot above captures the current state. If you need details from the removed messages, use memory_search to retrieve them.`;
    }

    /**
     * Build the post-compact context injection: WIP snapshot + task log.
     * Returns '' if there is no active task to preserve.
     */
    private injectPostCompactContext(wipSnapshot: string, wipLines: string[]): string {
        const d = this.deps;
        if (!d.currentTaskMessage) { return ''; }

        // NOTE: Do NOT inject Tier 2 memory here. auto-compact entries accumulate across
        // sessions and contain next_step / task context from prior unrelated tasks. Injecting
        // them after compaction causes the agent to pursue work from old sessions.
        // The WIP snapshot and task log below are sufficient for current-session continuity.

        // Read task log file — the richest record of what was planned and completed.
        let taskLogContent = '';
        const taskLogId = d.activeTask?.taskId;
        if (taskLogId && d.workspaceRoot) {
            try {
                const taskLogPath = `${d.workspaceRoot}/.ollamaforge/task-logs/${taskLogId}.md`;
                const fs = require('fs');
                if (fs.existsSync(taskLogPath)) {
                    const raw = fs.readFileSync(taskLogPath, 'utf-8');
                    // Keep only the last 80 lines to avoid bloating context
                    const lines = raw.split('\n');
                    taskLogContent = lines.slice(-80).join('\n');
                }
            } catch {
                // Non-fatal — task log is a bonus, not required
            }
        }

        const parts: string[] = [];
        parts.push(wipSnapshot);

        if (taskLogContent) {
            parts.push(`\n[Task Log — last 80 lines]\n${taskLogContent}`);
        }

        parts.push('\n[INSTRUCTION] You are resuming after context compaction. The above snapshot and task log show where you left off. Continue the task from the last completed step. Do NOT restart from scratch.');

        return parts.join('\n');
    }

    /**
     * Build a WIP snapshot capturing the current session state.
     * Returns an array of lines (caller joins them).
     */
    private buildWipSnapshot(usagePct: number, historyBeforeCompact: OllamaMessage[]): string[] {
        const d = this.deps;
        const wipLines: string[] = [];
        wipLines.push(`[WORK IN PROGRESS -- Context was compacted at ${usagePct.toFixed(0)}% usage]`);
        const sessionTask = d.originalTaskMessage || d.currentTaskMessage;
        wipLines.push(`Original task: ${sessionTask}`);
        if (d.currentTaskMessage !== sessionTask) {
            wipLines.push(`Most recent user message: ${d.currentTaskMessage}`);
        }

        if (d.filesAutoReadThisRun.size > 0) {
            wipLines.push(`Files already read: ${[...d.filesAutoReadThisRun].join(', ')}`);
        }
        if (d.filesEditedThisRun.size > 0) {
            wipLines.push(`Files edited: ${[...d.filesEditedThisRun].join(', ')}`);
        }

        // Tool usage summary
        if (d.toolCounters.total > 0) {
            wipLines.push(`Tool usage: ${d.toolCounters.read} reads, ${d.toolCounters.edit} edits, ${d.toolCounters.shell} shell, ${d.toolCounters.other} other (${d.toolCounters.total} total)`);
        }

        // Active task state
        if (d.activeTask) {
            const at = d.activeTask;
            if (at.stepsCompleted.length > 0) {
                wipLines.push(`Steps completed: ${at.stepsCompleted.join('; ')}`);
            }
            if (at.stepsPending.length > 0) {
                wipLines.push(`Steps pending: ${at.stepsPending.join('; ')}`);
            }
            if (at.filesConfirmed.length > 0) {
                wipLines.push(`Files confirmed: ${at.filesConfirmed.join(', ')}`);
            }
        }

        // Last few messages for continuity
        const lastMessages = historyBeforeCompact.slice(-4);
        if (lastMessages.length > 0) {
            wipLines.push('\n[Last messages before compaction]');
            for (const m of lastMessages) {
                const content = m.content.length > 300 ? m.content.slice(0, 300) + '…' : m.content;
                wipLines.push(`${m.role}: ${content}`);
            }
        }

        return wipLines;
    }
}
