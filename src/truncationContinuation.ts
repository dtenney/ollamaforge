/**
 * truncationContinuation.ts — Handle `finish_reason === 'length'` gracefully.
 *
 * Problem: When generation hits the token limit mid-reasoning, the partial
 * block is discarded and the model gets "continue concisely" — which reads as
 * "start over." The model restarts cold, re-runs the same searches.
 *
 * Solution (adapted from Reika's continuation.ts):
 *   - Gate: Is the cut-off block worth carrying? Use selfRepeatRatio — if
 *     degenerate, discard. If real work, carry it.
 *   - Tail: Take the last 6000 chars of the cut-off block. Cut at a paragraph
 *     break, then line break, then raw cut. Prepend a marker.
 *   - Burn ladder: Max 3 consecutive continuations without a tool call or
 *     committed answer. Resets the moment the model does something.
 *   - Novelty check: If a continuation's Jaccard overlap with the previous
 *     round > 0.8, it's repeating, not continuing — stop.
 */

import { selfRepeatRatio, crossRoundSimilarity } from './loopDetector';

// ─── Constants ───────────────────────────────────────────────────────────────

const TAIL_CHARS = 6000; // ~1500 tokens
const MAX_CONSECUTIVE = 3;
const NOVELTY_THRESHOLD = 0.8;
const DEGENERATE_THRESHOLD = 0.35;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ContinuationResult {
    shouldContinue: boolean;
    continuationText: string | null; // the tail to feed back (or null)
    reason: string;
    consecutiveCount: number;
}

export interface ContinuationState {
    consecutiveCount: number;
    lastRoundText: string | null;
}

// ─── Core Logic ──────────────────────────────────────────────────────────────

/**
 * Check if the cut-off block is worth carrying forward.
 * If it's degenerate (high self-repeat), discard it.
 */
export function isWorthCarrying(cutOffText: string): boolean {
    if (cutOffText.length < 200) { return false; } // too short to be meaningful
    const ratio = selfRepeatRatio(cutOffText);
    return ratio < DEGENERATE_THRESHOLD;
}

/**
 * Extract the tail of the cut-off block, cutting at a natural boundary.
 * Priority: paragraph break → line break → raw cut (only in first 25%).
 */
export function extractTail(text: string, maxChars: number = TAIL_CHARS): string {
    if (text.length <= maxChars) { return text; }

    const window = text.slice(-maxChars);

    // Try paragraph break (double newline)
    const paraIdx = window.lastIndexOf('\n\n');
    if (paraIdx > 0) {
        return window.slice(paraIdx + 2);
    }

    // Try line break
    const lineIdx = window.lastIndexOf('\n');
    if (lineIdx > 0) {
        return window.slice(lineIdx + 1);
    }

    // No clean paragraph/line boundary found. Return the full window as-is —
    // we never want to drop the most recent working, so a raw cut at the
    // window start is the safe fallback.
    return window;
}

/**
 * Build the continuation message with the tail and marker.
 */
export function buildContinuationMessage(tail: string, originalLength: number): string {
    const trimmed = originalLength - tail.length;
    const marker = `[${trimmed} chars of your earlier reasoning trimmed to fit — what follows is your most recent working]`;
    return `${marker}\n\n${tail}\n\nContinue from exactly where you left off. Do NOT re-run searches or re-read files you already processed. Pick up the next action.`;
}

/**
 * Check novelty: is this continuation actually new, or just repeating?
 */
export function isNovel(currentText: string, previousText: string | null): boolean {
    if (!previousText) { return true; }
    const sim = crossRoundSimilarity(previousText, currentText);
    return sim < NOVELTY_THRESHOLD;
}

/**
 * Main entry point: decide whether to continue after a truncation.
 */
export function handleTruncation(
    cutOffText: string,
    state: ContinuationState,
): ContinuationResult {
    // Burn ladder: max consecutive continuations
    if (state.consecutiveCount >= MAX_CONSECUTIVE) {
        return {
            shouldContinue: false,
            continuationText: null,
            reason: `Burn ladder exhausted (${MAX_CONSECUTIVE} consecutive continuations). Stopping.`,
            consecutiveCount: state.consecutiveCount,
        };
    }

    // Gate: is it worth carrying?
    if (!isWorthCarrying(cutOffText)) {
        return {
            shouldContinue: false,
            continuationText: null,
            reason: 'Cut-off block is degenerate or too short. Starting fresh.',
            consecutiveCount: state.consecutiveCount,
        };
    }

    // Novelty check
    if (!isNovel(cutOffText, state.lastRoundText)) {
        return {
            shouldContinue: false,
            continuationText: null,
            reason: 'Continuation is repeating the previous round (similarity > 0.8). Stopping.',
            consecutiveCount: state.consecutiveCount,
        };
    }

    // Extract tail and build message
    const tail = extractTail(cutOffText);
    const continuationText = buildContinuationMessage(tail, cutOffText.length);

    return {
        shouldContinue: true,
        continuationText,
        reason: `Carrying ${tail.length} chars of tail (consecutive: ${state.consecutiveCount + 1}/${MAX_CONSECUTIVE}).`,
        consecutiveCount: state.consecutiveCount + 1,
    };
}

/**
 * Reset the continuation state (call after a successful tool call or
 * committed answer).
 */
export function resetContinuationState(state: ContinuationState): void {
    state.consecutiveCount = 0;
    state.lastRoundText = null;
}

/**
 * Update the continuation state after a round.
 */
export function updateContinuationState(state: ContinuationState, roundText: string): void {
    state.lastRoundText = roundText;
}
