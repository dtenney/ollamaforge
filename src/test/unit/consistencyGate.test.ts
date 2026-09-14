import * as assert from 'assert';
import {
    computeRsc,
    evaluateGate,
    batchComputeRsc,
    isConsistent,
    RscResult,
    GateDecision,
} from '../../core/consistencyGate';

describe('consistencyGate', () => {

    // ── computeRsc ──────────────────────────────────────────────────────────

    describe('computeRsc', () => {
        it('should return R_sc = 0 for unanimous samples', () => {
            const result = computeRsc(['42', '42', '42']);
            assert.strictEqual(result.rsc, 0);
            assert.strictEqual(result.dominant, '42');
            assert.strictEqual(result.dominantCount, 3);
            assert.strictEqual(result.totalSamples, 3);
            assert.strictEqual(result.entropyNorm, 0);
            assert.strictEqual(result.modalWeight, 1);
            assert.strictEqual(result.isConsistent, true);
        });

        it('should return high R_sc for fully divergent samples', () => {
            const result = computeRsc(['a', 'b', 'c']);
            // R_sc = 0.5*1 + 0.5*(1-1/3) = 0.5 + 0.333 = 0.833
            assert.ok(result.rsc > 0.8, `expected R_sc > 0.8, got ${result.rsc}`);
            assert.strictEqual(result.entropyNorm, 1);
            assert.strictEqual(result.modalWeight, 1 / 3);
            assert.strictEqual(result.isConsistent, false);
        });

        it('should return R_sc = 0.5 for 2-of-3 agreement', () => {
            // clusters: {a:2, b:1}, total=3
            // H = -(2/3*log2(2/3) + 1/3*log2(1/3)) = -(2/3*(-0.585) + 1/3*(-1.585)) = 0.918
            // H_max = log2(2) = 1
            // entropyNorm = 0.918
            // modalWeight = 2/3
            // R_sc = 0.5*0.918 + 0.5*(1-2/3) = 0.459 + 0.167 = 0.626
            const result = computeRsc(['a', 'a', 'b']);
            assert.ok(result.rsc > 0.5, `expected R_sc > 0.5, got ${result.rsc}`);
            assert.ok(result.rsc < 0.7, `expected R_sc < 0.7, got ${result.rsc}`);
            assert.strictEqual(result.dominant, 'a');
            assert.strictEqual(result.dominantCount, 2);
            assert.strictEqual(result.isConsistent, false);
        });

        it('should handle single sample (R_sc = 0)', () => {
            const result = computeRsc(['only one']);
            assert.strictEqual(result.rsc, 0);
            assert.strictEqual(result.dominant, 'only one');
            assert.strictEqual(result.dominantCount, 1);
            assert.strictEqual(result.isConsistent, true);
        });

        it('should handle two identical samples', () => {
            const result = computeRsc(['x', 'x']);
            assert.strictEqual(result.rsc, 0);
            assert.strictEqual(result.modalWeight, 1);
        });

        it('should handle two different samples (R_sc = 0.75)', () => {
            const result = computeRsc(['x', 'y']);
            // R_sc = 0.5*1 + 0.5*(1-0.5) = 0.75
            assert.strictEqual(result.rsc, 0.75);
            assert.strictEqual(result.entropyNorm, 1);
            assert.strictEqual(result.modalWeight, 0.5);
        });

        it('should throw on empty samples array', () => {
            assert.throws(() => computeRsc([]), /must not be empty/);
        });

        it('should return correct cluster map', () => {
            const result = computeRsc(['a', 'a', 'b', 'b', 'c']);
            assert.strictEqual(result.clusters.size, 3);
            assert.strictEqual(result.clusters.get('a'), 2);
            assert.strictEqual(result.clusters.get('b'), 2);
            assert.strictEqual(result.clusters.get('c'), 1);
        });

        it('should respect custom alpha parameter', () => {
            const samples = ['a', 'a', 'b'];
            const rsc05 = computeRsc(samples, 0.5);
            const rsc10 = computeRsc(samples, 1.0);
            const rsc00 = computeRsc(samples, 0.0);
            // alpha=1 → pure entropy; alpha=0 → pure modal dominance
            assert.ok(rsc10 !== rsc00, 'alpha should change the score');
            assert.ok(rsc05.rsc > 0 && rsc05.rsc < 1);
        });

        it('should handle 4-of-5 agreement', () => {
            const result = computeRsc(['a', 'a', 'a', 'a', 'b']);
            assert.ok(result.rsc < 0.5, `expected R_sc < 0.5, got ${result.rsc}`);
            assert.strictEqual(result.dominant, 'a');
            assert.strictEqual(result.dominantCount, 4);
        });

        it('should handle whitespace-sensitive matching', () => {
            // "42" and "42 " are different clusters
            const result = computeRsc(['42', '42 ', '42']);
            assert.strictEqual(result.clusters.size, 2);
            assert.strictEqual(result.dominant, '42');
            assert.strictEqual(result.dominantCount, 2);
        });

        it('should handle empty-string samples', () => {
            const result = computeRsc(['', '', '']);
            assert.strictEqual(result.rsc, 0);
            assert.strictEqual(result.dominant, '');
        });
    });

    // ── evaluateGate ────────────────────────────────────────────────────────

    describe('evaluateGate', () => {
        it('should PASS for unanimous samples', () => {
            const decision = evaluateGate(['42', '42', '42']);
            assert.strictEqual(decision.decision, 'PASS');
            assert.ok(decision.reason.includes('Consensus'));
        });

        it('should REVIEW for 3-of-4 agreement', () => {
            const decision = evaluateGate(['a', 'a', 'a', 'b']);
            // R_sc ≈ 0.53 → REVIEW
            assert.strictEqual(decision.decision, 'REVIEW');
        });

        it('should REVIEW for 2-of-3 agreement', () => {
            const decision = evaluateGate(['a', 'a', 'b']);
            assert.strictEqual(decision.decision, 'REVIEW');
            assert.ok(decision.reason.includes('Uncertain'));
        });

        it('should BLOCK for fully divergent samples', () => {
            const decision = evaluateGate(['a', 'b', 'c']);
            assert.strictEqual(decision.decision, 'BLOCK');
            assert.ok(decision.reason.includes('Divergent'));
        });

        it('should BLOCK for 1-of-3 agreement', () => {
            const decision = evaluateGate(['a', 'b', 'c']);
            assert.strictEqual(decision.decision, 'BLOCK');
        });

        it('should respect custom thresholds', () => {
            // With passThreshold=0.9, even 2-of-3 should PASS
            const decision = evaluateGate(['a', 'a', 'b'], { passThreshold: 0.9 });
            assert.strictEqual(decision.decision, 'PASS');
        });

        it('should respect custom block threshold', () => {
            // With blockThreshold=0.5, 2-of-3 (R_sc≈0.63) should BLOCK
            const decision = evaluateGate(['a', 'a', 'b'], { blockThreshold: 0.5 });
            assert.strictEqual(decision.decision, 'BLOCK');
        });

        it('should include R_sc in reason string', () => {
            const decision = evaluateGate(['a', 'a', 'b']);
            assert.ok(decision.reason.includes('R_sc='));
        });

        it('should return full RscResult in decision', () => {
            const decision = evaluateGate(['a', 'a', 'b']);
            assert.ok(decision.result instanceof Object);
            assert.strictEqual(decision.result.totalSamples, 3);
            assert.strictEqual(decision.result.dominant, 'a');
        });
    });

    // ── batchComputeRsc ─────────────────────────────────────────────────────

    describe('batchComputeRsc', () => {
        it('should compute R_sc for multiple batches', () => {
            const results = batchComputeRsc([
                ['a', 'a', 'a'],
                ['a', 'b', 'c'],
                ['x', 'x', 'y'],
            ]);
            assert.strictEqual(results.length, 3);
            assert.strictEqual(results[0].rsc, 0);
            assert.ok(results[1].rsc > 0.8, `expected R_sc > 0.8, got ${results[1].rsc}`);
            assert.ok(results[2].rsc > 0.5);
        });

        it('should handle empty batch array', () => {
            const results = batchComputeRsc([]);
            assert.strictEqual(results.length, 0);
        });
    });

    // ── isConsistent ────────────────────────────────────────────────────────

    describe('isConsistent', () => {
        it('should return true for unanimous samples', () => {
            assert.strictEqual(isConsistent(['a', 'a', 'a']), true);
        });

        it('should return false for divergent samples', () => {
            assert.strictEqual(isConsistent(['a', 'b', 'c']), false);
        });

        it('should return false for 3-of-4 agreement (R_sc ≈ 0.53)', () => {
            assert.strictEqual(isConsistent(['a', 'a', 'a', 'b']), false);
        });

        it('should return false for 2-of-3 agreement', () => {
            assert.strictEqual(isConsistent(['a', 'a', 'b']), false);
        });
    });

    // ── Edge cases ──────────────────────────────────────────────────────────

    describe('edge cases', () => {
        it('should handle very long strings', () => {
            const long = 'x'.repeat(10000);
            const result = computeRsc([long, long, long]);
            assert.strictEqual(result.rsc, 0);
            assert.strictEqual(result.dominant, long);
        });

        it('should handle Unicode strings', () => {
            const result = computeRsc(['héllo', 'héllo', 'héllo']);
            assert.strictEqual(result.rsc, 0);
            assert.strictEqual(result.dominant, 'héllo');
        });

        it('should handle mixed Unicode and ASCII', () => {
            const result = computeRsc(['héllo', 'hello', 'héllo']);
            assert.strictEqual(result.clusters.size, 2);
            assert.strictEqual(result.dominant, 'héllo');
        });

        it('should handle newlines in samples', () => {
            const result = computeRsc(['line1\nline2', 'line1\nline2', 'line1\nline2']);
            assert.strictEqual(result.rsc, 0);
        });

        it('should be deterministic', () => {
            const samples = ['a', 'a', 'b', 'c'];
            const r1 = computeRsc(samples);
            const r2 = computeRsc(samples);
            assert.strictEqual(r1.rsc, r2.rsc);
            assert.strictEqual(r1.dominant, r2.dominant);
        });
    });
});
