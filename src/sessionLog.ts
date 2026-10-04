import * as fs from 'fs';
import * as path from 'path';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ToolCallRecord {
    name: string;
    /** File path argument if the tool operated on a file. */
    path?: string;
}

export interface GuardEvent {
    /** Short identifier for the guard that fired. */
    type: 'logprob' | 'schema-guard' | 'merge-guard' | 'undef-guard' | 'stub-file'
        | 'import-guard' | 'syntax-error' | 'repeat-guard' | 'scope-guard' | 'command-policy'
        | 'secret-detection';
    /** Human-readable reason string. */
    reason: string;
    /** File affected, if applicable. */
    file?: string;
}

export interface SessionLogEntry {
    /** ISO timestamp of run start. */
    ts: string;
    /** ChatSession.id — ties the log entry back to the stored session. */
    sessionId: string;
    /** Model name used for this run. */
    model: string;
    /** User task message (first 500 chars). */
    task: string;
    /** Number of model turns completed. */
    turns: number;
    /** Every tool call made during the run, in order. */
    toolCalls: ToolCallRecord[];
    /** Every guardrail event that fired during the run. */
    guardEvents: GuardEvent[];
    /** Relative paths of files successfully written/edited. */
    filesChanged: string[];
    /** Average log-probability of last model response, or null if not available. */
    avgLogprob: number | null;
    /** Wall-clock duration of the run in milliseconds. */
    durationMs: number;
    /** How the run ended. */
    outcome: 'done' | 'error' | 'stopped';
    /**
     * If reasoning traces are logged, this flag distinguishes a provider
     * *summary* of thinking (e.g. Anthropic) from the *real* chain-of-thought
     * (e.g. vLLM / Ollama). Without it, analysis silently compares a summary
     * against a full transcript.
     *
     * Source: GVS5H (slee-persis/GVS5H) — `reasoning_is_summary` field in
     * their per-call transcript records.
     */
    reasoningIsSummary?: boolean;
    /** Raw reasoning / thinking text, if the provider returned one. */
    reasoning?: string;
}

// ── Replayable event stream (OpenHands-inspired) ─────────────────────────────
// Every action the agent takes — user message, model response, tool call, tool
// result, guard event — is appended as a numbered event to events.jsonl. Unlike
// sessions.jsonl (one summary per run), this is a fine-grained, ordered,
// replayable trace: "what did the agent do between step 5 and 12?" is a simple
// seq-range read. Sequence numbers are per-run (reset each run) so a run's
// events form a contiguous, ordered block.

export type AgentEventType =
    | 'user_message'
    | 'model_response'
    | 'tool_call'
    | 'tool_result'
    | 'guard'
    | 'run_start'
    | 'run_end';

export interface AgentEvent {
    /** Per-run sequence number (1-based, contiguous within a run). */
    seq: number;
    /** ISO timestamp of the event. */
    ts: string;
    /** ChatSession.id — ties the event back to the stored session. */
    sessionId: string;
    /** Model name in use for this run. */
    model: string;
    type: AgentEventType;
    /** For tool_call / tool_result: the tool name. */
    tool?: string;
    /** For tool_call / tool_result: the file path argument, if any. */
    path?: string;
    /** For guard: the guard type that fired. */
    guardType?: string;
    /** Truncated, human-readable detail (bounded to keep the stream lean). */
    detail?: string;
}

// ── Writers ───────────────────────────────────────────────────────────────────

/**
 * Append one JSON line to <workspaceRoot>/.ollamaforge/sessions.jsonl.
 * Creates the directory if it doesn't exist.
 * Silently swallows any I/O errors — logging must never surface to the user.
 *
 * Scoping: each workspace has its own root, so the file is naturally
 * per-project. Opening a second workspace writes to that workspace's own
 * .ollamaforge/ directory. No cross-workspace overlap is possible.
 */
export function appendSessionLog(workspaceRoot: string, entry: SessionLogEntry): void {
    if (!workspaceRoot) { return; }
    try {
        const dir = path.join(workspaceRoot, '.ollamaforge');
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        const file = path.join(dir, 'sessions.jsonl');
        fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
    } catch {
        // Intentionally silent — disk errors must not interrupt the agent
    }
}

/**
 * Append a one-line human-readable summary to SESSION_LOG.md.
 * This is the markdown audit trail — a per-session YYYY-MM-DD structured log
 * a file a human can open to see what the agent did across sessions without
 * needing to parse sessions.jsonl.
 *
 * Format: `YYYY-MM-DD HH:MM | outcome | N turns | task summary`
 * Files changed are listed if any. Guard events are flagged with ⚠.
 *
 * Race safety: uses append-then-create-if-missing rather than existsSync+write
 * to avoid a TOCTOU window where two concurrent VS Code instances both see the
 * file missing and both attempt to write the header (overwriting each other).
 * `appendFileSync` with flag 'a' creates the file atomically if absent on most
 * platforms; the header-only first write uses flag 'ax' (exclusive create).
 *
 * Pipe characters in task text are escaped to prevent corrupting the pipe-
 * delimited line format.
 */
export function appendSessionLogMd(workspaceRoot: string, entry: SessionLogEntry): void {
    if (!workspaceRoot) { return; }
    try {
        const dir = path.join(workspaceRoot, '.ollamaforge');
        fs.mkdirSync(dir, { recursive: true });

        const ts   = entry.ts.replace('T', ' ').slice(0, 16); // "YYYY-MM-DD HH:MM"
        // Escape pipes and collapse newlines so the pipe-delimited format stays intact
        const task = entry.task.replace(/\n/g, ' ').replace(/\|/g, '\\|').slice(0, 120);
        const changed = entry.filesChanged.length > 0
            ? ` | files: ${entry.filesChanged.slice(0, 3).join(', ')}${entry.filesChanged.length > 3 ? ` +${entry.filesChanged.length - 3} more` : ''}`
            : '';
        const guards = entry.guardEvents.length > 0
            ? ` | ⚠ ${entry.guardEvents.length} guard(s)`
            : '';
        const line = `${ts} | ${entry.outcome} | ${entry.turns} turn${entry.turns === 1 ? '' : 's'} | ${task}${changed}${guards}\n`;

        const file = path.join(dir, 'SESSION_LOG.md');

        // Try to create the file exclusively (fails if it already exists — that's fine).
        // This avoids the TOCTOU window of existsSync → writeFileSync.
        try {
            fs.writeFileSync(file, '# Session Log\n> One line per agent run. Auto-generated by Ollama Forge.\n\n', { flag: 'wx', encoding: 'utf8' });
        } catch {
            // EEXIST = file already present; any other error is suppressed below
        }
        fs.appendFileSync(file, line, 'utf8');
    } catch {
        // Intentionally silent — log errors must never surface to the user
    }
}

/**
 * Append one event to the replayable event stream at
 * <workspaceRoot>/.ollamaforge/events.jsonl.
 *
 * Unlike appendSessionLog (one summary per run), this records every discrete
 * action in order so a run can be replayed or queried by seq range. The caller
 * owns the sequence number (per-run, 1-based) — this function only appends.
 *
 * Silently swallows I/O errors — tracing must never interrupt the agent.
 */
export function appendAgentEvent(workspaceRoot: string, event: AgentEvent): void {
    if (!workspaceRoot) { return; }
    try {
        const dir = path.join(workspaceRoot, '.ollamaforge');
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        const file = path.join(dir, 'events.jsonl');
        fs.appendFileSync(file, JSON.stringify(event) + '\n', 'utf8');
    } catch {
        // Intentionally silent — disk errors must not interrupt the agent
    }
}

/**
 * Read a run's events from the event stream, optionally bounded to a seq range.
 * Returns events in seq order. Used for "what did the agent do between step 5
 * and 12?" queries and replay. Returns [] if the file is absent or unreadable.
 */
export function readAgentEvents(
    workspaceRoot: string,
    sessionId: string,
    fromSeq?: number,
    toSeq?: number,
): AgentEvent[] {
    if (!workspaceRoot) { return []; }
    try {
        const file = path.join(workspaceRoot, '.ollamaforge', 'events.jsonl');
        if (!fs.existsSync(file)) { return []; }
        const out: AgentEvent[] = [];
        for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
            if (!raw.trim()) { continue; }
            let ev: AgentEvent;
            try { ev = JSON.parse(raw); } catch { continue; }
            if (ev.sessionId !== sessionId) { continue; }
            if (fromSeq !== undefined && ev.seq < fromSeq) { continue; }
            if (toSeq !== undefined && ev.seq > toSeq) { continue; }
            out.push(ev);
        }
        return out.sort((a, b) => a.seq - b.seq);
    } catch {
        return [];
    }
}
