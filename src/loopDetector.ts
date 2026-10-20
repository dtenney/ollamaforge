/**
 * loopDetector.ts — Two-layer loop/spiral detection using k-gram shingles.
 *
 * Replaces/augments the brittle regex in StreamFilter (agentLoop.ts) with
 * calibrated, two-layer detection:
 *
 *   Layer 1 — Intra-block degeneration (selfRepeatRatio):
 *     Shingle text into 8-word k-grams. Measure duplicate fraction.
 *     Healthy: ~0.001. Looping: 0.5+.
 *
 *   Layer 2 — Cross-round rumination (crossRoundSimilarity):
 *     Jaccard overlap of 8-gram sets between consecutive rounds.
 *     Leaky streak: a round at ≥50% of threshold HOLDS the streak.
 *     Fires on sustained streak (≥3 rounds above threshold).
 *
 * Escalating response ladder:
 *   Level 0: nudge (inject "you seem to be repeating yourself")
 *   Level 1: pinned ledger (show what's been done, what's pending)
 *   Level 2: tool withdrawal (restrict to read-only tools)
 *   Level 3: honest stop (abort the turn)
 */

// ─── Shingle Utilities ───────────────────────────────────────────────────────

const K = 8; // k-gram size (words)

/**
 * Normalize text for shingling: lowercase, collapse whitespace.
 */
function normalizeForShingles(text: string): string {
    return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Extract k-gram shingles from text.
 */
export function shingle(text: string, k: number = K): Set<string> {
    const words = normalizeForShingles(text).split(' ').filter(w => w.length > 0);
    const shingles = new Set<string>();
    for (let i = 0; i <= words.length - k; i++) {
        shingles.add(words.slice(i, i + k).join(' '));
    }
    return shingles;
}

/**
 * Compute the self-repeat ratio: fraction of k-grams that are duplicates.
 * Healthy text: ~0.001. Looping text: 0.5+.
 */
export function selfRepeatRatio(text: string, k: number = K): number {
    const words = normalizeForShingles(text).split(' ').filter(w => w.length > 0);
    if (words.length < k) { return 0; }

    const total = words.length - k + 1;
    const seen = new Set<string>();
    let duplicates = 0;

    for (let i = 0; i <= words.length - k; i++) {
        const s = words.slice(i, i + k).join(' ');
        if (seen.has(s)) { duplicates++; }
        seen.add(s);
    }

    return duplicates / total;
}

/**
 * Compute Jaccard similarity between two texts (8-gram sets).
 */
export function crossRoundSimilarity(a: string, b: string, k: number = K): number {
    const sa = shingle(a, k);
    const sb = shingle(b, k);
    if (sa.size === 0 || sb.size === 0) { return 0; }

    let intersection = 0;
    for (const s of sa) {
        if (sb.has(s)) { intersection++; }
    }
    const union = sa.size + sb.size - intersection;
    return union === 0 ? 0 : intersection / union;
}

// ─── Thresholds ──────────────────────────────────────────────────────────────

/**
 * Length-aware abort threshold for selfRepeatRatio.
 *   < 2000 chars → no ratio-based abort (too short to judge)
 *   2000–16000 chars → threshold 0.35
 *   16000–28000 chars → linear interpolation 0.35 → 0.25
 *   ≥ 28000 chars → threshold 0.25
 */
export function getRepeatThreshold(textLength: number): number | null {
    if (textLength < 2000) { return null; }
    if (textLength < 16000) { return 0.35; }
    if (textLength < 28000) {
        const t = (textLength - 16000) / (28000 - 16000);
        return 0.35 - t * 0.10; // 0.35 → 0.25
    }
    return 0.25;
}

/** Cross-round similarity threshold. */
const CROSS_ROUND_THRESHOLD = 0.5;
/** Leaky streak: a round at ≥50% of threshold holds the streak. */
const LEAKY_FRACTION = 0.5;
/** Sustained streak needed to fire. */
const SUSTAINED_STREAK = 3;

// ─── ReasoningTrace ──────────────────────────────────────────────────────────

export interface RoundRecord {
    text: string;
    selfRepeat: number;
    crossSim: number; // similarity to previous round
}

export interface LoopDetectionResult {
    isLooping: boolean;
    level: number; // 0=nudge, 1=ledger, 2=tool withdrawal, 3=stop
    reason: string;
    selfRepeat: number;
    crossSim: number;
    streak: number;
}

/**
 * ReasoningTrace — tracks per-round reasoning text and detects loops.
 * Stateless across rounds (recomputed from history each turn).
 */
export class ReasoningTrace {
    private rounds: RoundRecord[] = [];
    private streak = 0;

    /**
     * Record a round of reasoning/content text.
     * Returns the current loop detection result.
     */
    recordRound(text: string): LoopDetectionResult {
        const selfRepeat = selfRepeatRatio(text);
        const crossSim = this.rounds.length > 0
            ? crossRoundSimilarity(this.rounds[this.rounds.length - 1].text, text)
            : 0;

        this.rounds.push({ text, selfRepeat, crossSim });

        // Keep only last 4 rounds for memory
        if (this.rounds.length > 4) {
            this.rounds = this.rounds.slice(-4);
        }

        return this.evaluate();
    }

    /**
     * Evaluate current loop state based on all recorded rounds.
     */
    evaluate(): LoopDetectionResult {
        const last = this.rounds[this.rounds.length - 1];
        if (!last) {
            return { isLooping: false, level: 0, reason: '', selfRepeat: 0, crossSim: 0, streak: 0 };
        }

        // Pure streak computation: replay over the recorded rounds so that
        // evaluate() is idempotent (no side effects). A firing round increments,
        // a leaky-holding round preserves, a novel round resets.
        let streak = 0;
        for (const r of this.rounds) {
            const t = getRepeatThreshold(r.text.length);
            const firing = (t !== null && r.selfRepeat >= t) || r.crossSim >= CROSS_ROUND_THRESHOLD;
            const leaky = r.crossSim >= CROSS_ROUND_THRESHOLD * LEAKY_FRACTION;
            if (firing) { streak++; }
            else if (leaky) { /* hold */ }
            else { streak = 0; }
        }
        this.streak = streak;

        const threshold = getRepeatThreshold(last.text.length);
        const selfRepeatFiring = threshold !== null && last.selfRepeat >= threshold;

        // Determine if looping
        const isLooping = streak >= SUSTAINED_STREAK || selfRepeatFiring;

        // Escalating response ladder
        let level = 0;
        let reason = '';

        if (isLooping) {
            if (this.streak >= SUSTAINED_STREAK + 2) {
                level = 3; // honest stop
                reason = `Sustained loop detected (${this.streak} rounds). Stopping.`;
            } else if (this.streak >= SUSTAINED_STREAK + 1) {
                level = 2; // tool withdrawal
                reason = `Loop detected (${this.streak} rounds). Restricting to read-only tools.`;
            } else if (this.streak >= SUSTAINED_STREAK) {
                level = 1; // pinned ledger
                reason = `Loop detected (${this.streak} rounds). Reviewing progress ledger.`;
            } else if (selfRepeatFiring) {
                level = 0; // nudge
                reason = `High self-repetition (${(last.selfRepeat * 100).toFixed(1)}%). You seem to be repeating yourself.`;
            }
        }

        return {
            isLooping,
            level,
            reason,
            selfRepeat: last.selfRepeat,
            crossSim: last.crossSim,
            streak: this.streak,
        };
    }

    /** Reset all state (new session or after a tool call). */
    reset(): void {
        this.rounds = [];
        this.streak = 0;
    }

    /** Get the number of recorded rounds. */
    get roundCount(): number {
        return this.rounds.length;
    }
}

// ─── Standalone Detection (for StreamFilter integration) ────────────────────

/**
 * Quick check: is this single text block degenerate (high self-repeat)?
 * Used as a fast pre-filter before the full ReasoningTrace evaluation.
 */
export function isDegenerateBlock(text: string): boolean {
    const threshold = getRepeatThreshold(text.length);
    if (threshold === null) { return false; }
    return selfRepeatRatio(text) >= threshold;
}

/**
 * Build the nudge message for the current loop level.
 */
export function buildLoopNudge(result: LoopDetectionResult): string {
    switch (result.level) {
        case 0:
            return `⚠️ ${result.reason} Try a different approach — re-read the relevant file or search for the exact symbol name.`;
        case 1:
            return `⚠️ ${result.reason}\n\n**Progress so far:**\n${result.reason}\n\nStop repeating the same searches. Pick the next UNCHECKED step from your plan and execute it.`;
        case 2:
            return `🔒 ${result.reason}\n\nOnly read-only tools are available now. Summarize what you've done and what remains, then I'll re-enable full tools.`;
        case 3:
            return `🛑 ${result.reason}\n\nI'm stopping this turn. Please review the plan and try a fundamentally different approach.`;
        default:
            return '';
    }
}
