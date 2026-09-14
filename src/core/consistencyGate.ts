/**
 * consistencyGate.ts
 *
 * Zero-cost epistemic uncertainty quantification for LLM tool-call outputs.
 * Inspired by Spnda (Exact-Match Normalized Entropy, R_sc).
 *
 * Core idea: sample K responses from the model. Cluster by exact match.
 * Compute normalized Shannon entropy over cluster weights. Blend with
 * modal dominance to produce a single 0–1 risk score.
 *
 *   R_sc = α · H_norm + (1 − α) · (1 − w_max),  α = 0.5
 *
 *   R_sc = 0  → unanimous consensus (model is confident)
 *   R_sc → 1  → maximum divergence (model is guessing / hallucinating)
 *
 * No VS Code imports — safe to unit-test in isolation.
 * No dependencies — pure TypeScript standard library.
 */

// ── Types ───────────────────────────────────────────────────────────────────

export interface RscResult {
    /** 0–1 risk score. 0 = unanimous, 1 = maximum divergence. */
    rsc: number;
    /** The most common (dominant) response. */
    dominant: string;
    /** Number of samples that matched the dominant response. */
    dominantCount: number;
    /** Total number of samples. */
    totalSamples: number;
    /** Normalized Shannon entropy (0–1). */
    entropyNorm: number;
    /** Modal weight (fraction of samples in the largest cluster). */
    modalWeight: number;
    /** Cluster breakdown: response → count. */
    clusters: Map<string, number>;
    /** True when the model is sufficiently confident. */
    isConsistent: boolean;
}

export interface GateDecision {
    result: RscResult;
    /** 'PASS' | 'REVIEW' | 'BLOCK' */
    decision: 'PASS' | 'REVIEW' | 'BLOCK';
    /** Human-readable reason. */
    reason: string;
}

// ── Core math ───────────────────────────────────────────────────────────────

/**
 * Compute the R_sc risk score from K sampled responses.
 *
 * @param samples  Array of K response strings (K ≥ 1).
 * @param alpha    Entropy weight (default 0.5).
 */
export function computeRsc(samples: string[], alpha = 0.5): RscResult {
    if (samples.length === 0) {
        throw new Error('computeRsc: samples array must not be empty');
    }

    // 1. Cluster by exact match
    const clusters = new Map<string, number>();
    for (const s of samples) {
        clusters.set(s, (clusters.get(s) ?? 0) + 1);
    }

    const total = samples.length;
    const k = clusters.size;

    // 2. Compute Shannon entropy over cluster weights
    //    H = -Σ w_i · log2(w_i)
    //    H_max = log2(k)  (uniform distribution over k clusters)
    let entropy = 0;
    for (const count of clusters.values()) {
        const w = count / total;
        if (w > 0) {
            entropy -= w * Math.log2(w);
        }
    }

    const hMax = k > 1 ? Math.log2(k) : 1;
    const entropyNorm = hMax > 0 ? entropy / hMax : 0;

    // 3. Modal weight
    let modalWeight = 0;
    let dominant = '';
    let dominantCount = 0;
    for (const [resp, count] of clusters) {
        if (count > dominantCount) {
            dominantCount = count;
            dominant = resp;
        }
        const w = count / total;
        if (w > modalWeight) {
            modalWeight = w;
        }
    }

    // 4. Combine
    const rsc = alpha * entropyNorm + (1 - alpha) * (1 - modalWeight);

    return {
        rsc,
        dominant,
        dominantCount,
        totalSamples: total,
        entropyNorm,
        modalWeight,
        clusters,
        isConsistent: rsc < 0.35,
    };
}

// ── Gate decision ───────────────────────────────────────────────────────────

export interface GateOptions {
    /** R_sc threshold below which the response passes. Default 0.35. */
    passThreshold?: number;
    /** R_sc threshold above which the response is blocked. Default 0.70. */
    blockThreshold?: number;
}

/**
 * Evaluate K sampled responses and produce a gate decision.
 *
 *   PASS   — R_sc < passThreshold  (model is confident)
 *   REVIEW — passThreshold ≤ R_sc < blockThreshold  (uncertain, flag for review)
 *   BLOCK  — R_sc ≥ blockThreshold  (model is diverging, do not execute)
 */
export function evaluateGate(samples: string[], options?: GateOptions): GateDecision {
    const passThreshold = options?.passThreshold ?? 0.35;
    const blockThreshold = options?.blockThreshold ?? 0.70;
    const result = computeRsc(samples);

    if (result.rsc < passThreshold) {
        return {
            result,
            decision: 'PASS',
            reason: `Consensus: ${result.dominantCount}/${result.totalSamples} samples agree (R_sc=${result.rsc.toFixed(3)})`,
        };
    }

    if (result.rsc < blockThreshold) {
        return {
            result,
            decision: 'REVIEW',
            reason: `Uncertain: ${result.dominantCount}/${result.totalSamples} samples agree (R_sc=${result.rsc.toFixed(3)})`,
        };
    }

    return {
        result,
        decision: 'BLOCK',
        reason: `Divergent: ${result.dominantCount}/${result.totalSamples} samples agree (R_sc=${result.rsc.toFixed(3)})`,
    };
}

// ── Batch ───────────────────────────────────────────────────────────────────

/**
 * Compute R_sc for multiple sample sets in one call.
 * Useful for batch-evaluating tool-call candidates.
 */
export function batchComputeRsc(batches: string[][]): RscResult[] {
    return batches.map(samples => computeRsc(samples));
}

// ── Convenience ─────────────────────────────────────────────────────────────

/**
 * Quick boolean: are these K responses consistent?
 * Returns true when R_sc < 0.35.
 */
export function isConsistent(samples: string[]): boolean {
    return computeRsc(samples).isConsistent;
}
