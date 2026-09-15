import { strict as assert } from 'assert';
import { formatSimilarityReport } from '../../similarityAnalyzer';
import type { SimilarityReport } from '../../similarityAnalyzer';

describe('similarityAnalyzer.formatSimilarityReport', () => {

    it('returns a "no files" message when both clusters and ungrouped are empty', () => {
        const report: SimilarityReport = {
            mode: 'directory',
            scope: 'src/',
            clusters: [],
            ungrouped: [],
            threshold: 0.7,
        };
        const out = formatSimilarityReport(report);
        assert.ok(out.includes('No indexed files found'));
        assert.ok(out.includes('src/'));
    });

    it('returns a "no clusters" message when only ungrouped files exist', () => {
        const report: SimilarityReport = {
            mode: 'directory',
            scope: 'src/',
            clusters: [],
            ungrouped: ['a.py', 'b.py', 'c.py'],
            threshold: 0.8,
        };
        const out = formatSimilarityReport(report);
        assert.ok(out.includes('No similarity clusters found'));
        assert.ok(out.includes('3 files appear distinct'));
        assert.ok(out.includes('0.8'));
    });

    it('formats a single cluster with one file (singular)', () => {
        const report: SimilarityReport = {
            mode: 'directory',
            scope: 'src/',
            clusters: [{
                label: 'auth',
                files: [{ relPath: 'src/auth.py', score: 0.92 }],
                avgSimilarity: 0.92,
            }],
            ungrouped: [],
            threshold: 0.7,
        };
        const out = formatSimilarityReport(report);
        assert.ok(out.includes('similarity cluster'));
        assert.ok(!out.includes('similarity clusters'));
        assert.ok(out.includes('Cluster 1'));
        assert.ok(out.includes('auth'));
        assert.ok(out.includes('auth.py'));
        assert.ok(out.includes('0.92'));
    });

    it('formats multiple clusters (plural)', () => {
        const report: SimilarityReport = {
            mode: 'directory',
            scope: 'src/',
            clusters: [
                { label: 'auth', files: [{ relPath: 'a.py', score: 0.9 }, { relPath: 'b.py', score: 0.85 }], avgSimilarity: 0.88 },
                { label: 'db', files: [{ relPath: 'c.py', score: 0.95 }], avgSimilarity: 0.95 },
            ],
            ungrouped: [],
            threshold: 0.7,
        };
        const out = formatSimilarityReport(report);
        assert.ok(out.includes('similarity clusters'));
        assert.ok(out.includes('Cluster 1'));
        assert.ok(out.includes('Cluster 2'));
        assert.ok(out.includes('auth'));
        assert.ok(out.includes('db'));
    });

    it('includes ungrouped files section when present', () => {
        const report: SimilarityReport = {
            mode: 'directory',
            scope: 'src/',
            clusters: [
                { label: 'x', files: [{ relPath: 'x.py', score: 0.9 }], avgSimilarity: 0.9 },
            ],
            ungrouped: ['orphan1.py', 'orphan2.py'],
            threshold: 0.7,
        };
        const out = formatSimilarityReport(report);
        assert.ok(out.includes('files with no close matches'));
        assert.ok(out.includes('orphan1.py'));
        assert.ok(out.includes('orphan2.py'));
    });

    it('uses singular "file" for one ungrouped file', () => {
        const report: SimilarityReport = {
            mode: 'directory',
            scope: 'src/',
            clusters: [
                { label: 'x', files: [{ relPath: 'x.py', score: 0.9 }], avgSimilarity: 0.9 },
            ],
            ungrouped: ['solo.py'],
            threshold: 0.7,
        };
        const out = formatSimilarityReport(report);
        assert.ok(out.includes('file with no close matches'));
        assert.ok(!out.includes('files with no close matches'));
    });

    it('reports total file count across clusters + ungrouped', () => {
        const report: SimilarityReport = {
            mode: 'directory',
            scope: 'src/',
            clusters: [
                { label: 'a', files: [{ relPath: '1.py', score: 0.9 }, { relPath: '2.py', score: 0.8 }], avgSimilarity: 0.85 },
                { label: 'b', files: [{ relPath: '3.py', score: 0.9 }], avgSimilarity: 0.9 },
            ],
            ungrouped: ['4.py'],
            threshold: 0.7,
        };
        const out = formatSimilarityReport(report);
        assert.ok(out.includes('4 files'));
    });

    it('handles anchor mode scope', () => {
        const report: SimilarityReport = {
            mode: 'anchor',
            scope: 'src/main.py',
            clusters: [
                { label: 'main', files: [{ relPath: 'src/main.py', score: 1.0 }], avgSimilarity: 1.0 },
            ],
            ungrouped: [],
            threshold: 0.6,
        };
        const out = formatSimilarityReport(report);
        assert.ok(out.includes('src/main.py'));
        assert.ok(out.includes('main'));
    });
});
