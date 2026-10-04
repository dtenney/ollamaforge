import { strict as assert } from 'assert';
import { extractDocVerificationHints, stripSelectStringPrefixes } from '../../agentShellEnv';

describe('agentShellEnv', () => {

    describe('extractDocVerificationHints', () => {
        it('returns empty array for empty string', () => {
            assert.deepEqual(extractDocVerificationHints(''), []);
        });

        it('detects retention period claims', () => {
            const hints = extractDocVerificationHints('The system has a 3-year retention policy for records.');
            assert.ok(hints.some(h => h.includes('3') && h.includes('retention')));
        });

        it('detects day-based retention claims', () => {
            const hints = extractDocVerificationHints('Data is held for 90-day minimum retention.');
            assert.ok(hints.some(h => h.includes('90')));
        });

        it('detects class name references in backticks', () => {
            const hints = extractDocVerificationHints('The `AuditLogService` handles all logging.');
            assert.ok(hints.some(h => h.includes('AuditLogService')));
        });

        it('detects numeric iteration claims', () => {
            const hints = extractDocVerificationHints('The algorithm runs 100,000 iterations per batch.');
            assert.ok(hints.some(h => h.includes('100000') || h.includes('100,000')));
        });

        it('detects file path references', () => {
            const hints = extractDocVerificationHints('See `app/services/payment.py` for details.');
            assert.ok(hints.some(h => h.includes('app/services/payment.py')));
        });

        it('deduplicates class references', () => {
            const hints = extractDocVerificationHints(
                'The `AuditLogService` and `AuditLogService` are used.'
            );
            const matches = hints.filter(h => h.includes('AuditLogService'));
            assert.equal(matches.length, 1);
        });

        it('returns empty for text with no patterns', () => {
            const hints = extractDocVerificationHints('Hello world, this is a simple message.');
            assert.equal(hints.length, 0);
        });
    });

    describe('stripSelectStringPrefixes', () => {
        it('strips "> " match line prefixes', () => {
            const input = '> def hello():\n>     return 1';
            assert.equal(stripSelectStringPrefixes(input), 'def hello():\n    return 1');
        });

        it('strips 2-space context line prefixes', () => {
            const input = '  context line\n  another context';
            assert.equal(stripSelectStringPrefixes(input), 'context line\nanother context');
        });

        it('preserves blank lines', () => {
            const input = '> code\n\n> more';
            assert.equal(stripSelectStringPrefixes(input), 'code\n\nmore');
        });

        it('handles mixed match and context lines', () => {
            const input = '  before\n> match\n  after';
            assert.equal(stripSelectStringPrefixes(input), 'before\nmatch\nafter');
        });

        it('returns empty string for empty input', () => {
            assert.equal(stripSelectStringPrefixes(''), '');
        });

        it('handles single line', () => {
            assert.equal(stripSelectStringPrefixes('> hello'), 'hello');
        });
    });
});
