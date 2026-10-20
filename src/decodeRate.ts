/**
 * decodeRate.ts — Compute and smooth model decode rate (tokens/sec).
 *
 * Ollama's API returns `eval_count` and `eval_duration` in the response.
 * We use those directly (equivalent to engine-reported timing).
 *
 * - Reject samples: < 16 tokens, < 200 ms window, rate outside 0.1–10000 tok/s.
 * - EMA smoothing (α=0.3) over accepted samples.
 */

export interface DecodeRateSample {
    tokens: number;
    durationMs: number;
    rate: number; // tokens/sec
}

export interface DecodeRateState {
    ema: number | null; // smoothed rate
    lastSample: DecodeRateSample | null;
    totalSamples: number;
}

const ALPHA = 0.3;
const MIN_TOKENS = 16;
const MIN_DURATION_MS = 200;
const MIN_RATE = 0.1;
const MAX_RATE = 10000;

/**
 * Create a fresh decode rate state.
 */
export function createDecodeRateState(): DecodeRateState {
    return { ema: null, lastSample: null, totalSamples: 0 };
}

/**
 * Compute decode rate from Ollama response fields.
 * Returns null if the sample is rejected.
 */
export function computeDecodeRate(
    evalCount: number | undefined,
    evalDuration: number | undefined, // in nanoseconds (Ollama convention)
): DecodeRateSample | null {
    if (evalCount === undefined || evalDuration === undefined) { return null; }
    if (evalCount < MIN_TOKENS) { return null; }

    const durationMs = evalDuration / 1_000_000; // ns → ms
    if (durationMs < MIN_DURATION_MS) { return null; }

    const rate = (evalCount - 1) / (durationMs / 1000); // -1: first token is free
    if (rate < MIN_RATE || rate > MAX_RATE) { return null; }

    return { tokens: evalCount, durationMs, rate };
}

/**
 * Update the EMA-smoothed decode rate with a new sample.
 */
export function updateDecodeRate(state: DecodeRateState, sample: DecodeRateSample | null): DecodeRateState {
    if (!sample) { return state; }

    const newEma = state.ema === null
        ? sample.rate
        : ALPHA * sample.rate + (1 - ALPHA) * state.ema;

    return {
        ema: newEma,
        lastSample: sample,
        totalSamples: state.totalSamples + 1,
    };
}

/**
 * Format the decode rate for display in the status bar.
 */
export function formatDecodeRate(state: DecodeRateState): string {
    if (state.ema === null) { return ''; }
    return `${state.ema.toFixed(1)} tok/s`;
}

/**
 * Reset the decode rate state (new session).
 */
export function resetDecodeRate(state: DecodeRateState): DecodeRateState {
    return createDecodeRateState();
}
