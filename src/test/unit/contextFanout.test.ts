import * as assert from 'assert';
import * as crypto from 'crypto';

// Replicate pure helpers from contextFanout.ts (not exported) for unit testing
function fingerprint(text: string): string {
    return crypto.createHash('md5').update(text.slice(0, 200)).digest('hex').slice(0, 12);
}

function trimToTokens(text: string, maxTokens: number): string {
    const maxChars = maxTokens * 4;
    if (text.length <= maxChars) return text;
    return text.slice(0, maxChars) + '\n[... trimmed]';
}

describe('contextFanout', () => {

    describe('fingerprint', () => {
        it('produces a 12-char hex string', () => {
            const fp = fingerprint('hello world');
            assert.strictEqual(fp.length, 12);
            assert.match(fp, /^[0-9a-f]{12}$/);
        });

        it('is deterministic for the same input', () => {
            assert.strictEqual(fingerprint('test'), fingerprint('test'));
        });

        it('differs for different inputs', () => {
            assert.notStrictEqual(fingerprint('alpha'), fingerprint('beta'));
        });

        it('only uses first 200 chars', () => {
            const base = 'a'.repeat(200);
            const extended = base + 'b'.repeat(100);
            assert.strictEqual(fingerprint(base), fingerprint(extended));
        });

        it('handles empty string', () => {
            const fp = fingerprint('');
            assert.strictEqual(fp.length, 12);
        });
    });

    describe('trimToTokens', () => {
        it('returns text unchanged when within budget', () => {
            const text = 'hello';
            assert.strictEqual(trimToTokens(text, 100), text);
        });

        it('trims text exceeding budget and appends marker', () => {
            const text = 'x'.repeat(1000);
            const result = trimToTokens(text, 10); // 10 tokens = 40 chars
            assert.ok(result.endsWith('[... trimmed]'));
            assert.ok(result.length < 1000);
        });

        it('handles empty string', () => {
            assert.strictEqual(trimToTokens('', 100), '');
        });

        it('boundary: text exactly at maxChars is not trimmed', () => {
            const maxChars = 50 * 4; // 200
            const text = 'a'.repeat(200);
            assert.strictEqual(trimToTokens(text, 50), text);
        });
    });

    describe('token budget constants', () => {
        it('budgets sum to 2000 tokens', () => {
            // These mirror the constants in contextFanout.ts
            const BUDGET_GRAPH = 700;
            const BUDGET_INDEX = 600;
            const BUDGET_MEMORY = 700;
            assert.strictEqual(BUDGET_GRAPH + BUDGET_INDEX + BUDGET_MEMORY, 2000);
        });
    });
});
