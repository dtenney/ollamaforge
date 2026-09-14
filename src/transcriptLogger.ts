import * as fs from 'fs';
import * as path from 'path';

/**
 * transcriptLogger.ts — per-call raw transcript logging for Ollama Forge.
 *
 * Pattern borrowed from GVS5H (steal-plan item 4): every Ollama call is
 * appended as one JSONL line to .ollamaforge/transcripts/transcript.jsonl.
 * This gives a complete, replayable record of what the model saw and said —
 * invaluable for debugging weak-model failures and regrading.
 *
 * Design:
 *  - One JSON object per line (JSONL) — append-only, cheap to tail/grep.
 *  - Rolling size cap so the file never grows unbounded (data is never lost
 *    silently — we truncate from the head, keeping the most recent calls).
 *  - Fully synchronous + best-effort: a logging failure must NEVER break a
 *    live inference call, so every fs op is wrapped in try/catch.
 *  - No vscode dependency — works in the extension host and in tests.
 */

const MAX_TRANSCRIPT_BYTES = 5 * 1024 * 1024; // 5 MB rolling cap
const TRUNCATE_TO_BYTES = MAX_TRANSCRIPT_BYTES / 2; // keep most recent ~2.5 MB

let _transcriptPath: string | null = null;

/**
 * Initialize the transcript sink. Call once at activation with the workspace
 * root. Safe to call multiple times (idempotent).
 */
export function initTranscriptLogger(workspaceRoot: string): void {
    try {
        const dir = path.join(workspaceRoot, '.ollamaforge', 'transcripts');
        if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
        _transcriptPath = path.join(dir, 'transcript.jsonl');
        // Roll if over cap — keep the most recent half so the newest calls survive.
        try {
            if (fs.statSync(_transcriptPath).size > MAX_TRANSCRIPT_BYTES) {
                const existing = fs.readFileSync(_transcriptPath, 'utf8');
                fs.writeFileSync(_transcriptPath, existing.slice(-TRUNCATE_TO_BYTES), 'utf8');
            }
        } catch { /* ignore stat errors */ }
    } catch { _transcriptPath = null; }
}

/** A single logged Ollama call. All fields optional except ts + endpoint. */
export interface TranscriptEntry {
    ts: string;
    endpoint: string;
    model: string;
    messages_in?: number;
    content?: string;
    thinking?: string;
    tool_calls?: unknown[];
    avg_logprob?: number | null;
    duration_ms?: number;
    status?: 'ok' | 'guard' | 'error';
    error?: string;
}

/**
 * Append one transcript entry as a JSONL line. Best-effort — never throws.
 * Truncates long content/thinking so a single runaway call can't bloat the file.
 */
export function logTranscript(entry: TranscriptEntry): void {
    if (!_transcriptPath) { return; }
    try {
        const capped: TranscriptEntry = {
            ...entry,
            content: entry.content ? entry.content.slice(0, 8000) : undefined,
            thinking: entry.thinking ? entry.thinking.slice(0, 8000) : undefined,
        };
        fs.appendFileSync(_transcriptPath, JSON.stringify(capped) + '\n', 'utf8');
    } catch { /* best-effort — never break inference */ }
}
