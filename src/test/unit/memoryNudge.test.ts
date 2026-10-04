import { strict as assert } from 'assert';
import {
    buildMemoryNudge,
    buildOrientationAnchor,
    INTENT_PATTERNS,
    NEGATIVE_CONTEXT,
    KNOWN_TECHNOLOGIES,
    MAX_MEMORY_WRITES_PER_RESPONSE,
} from '../../memoryNudge';

describe('memoryNudge', () => {

    describe('buildMemoryNudge', () => {
        it('returns empty string when turn count is 0', () => {
            assert.equal(buildMemoryNudge(0, 5), '');
        });

        it('returns empty string when turn count is not a multiple of interval', () => {
            assert.equal(buildMemoryNudge(3, 5), '');
            assert.equal(buildMemoryNudge(7, 5), '');
        });

        it('returns a reminder when turn count is a multiple of interval', () => {
            const result = buildMemoryNudge(5, 5);
            assert.ok(result.includes('memory'));
            assert.ok(result.includes('memory_tier_write'));
        });

        it('returns a reminder at turn 10 with interval 5', () => {
            const result = buildMemoryNudge(10, 5);
            assert.ok(result.length > 0);
        });

        it('returns empty string for interval 1 at turn 0', () => {
            assert.equal(buildMemoryNudge(0, 1), '');
        });

        it('returns reminder for interval 1 at turn 1', () => {
            const result = buildMemoryNudge(1, 1);
            assert.ok(result.length > 0);
        });
    });

    describe('buildOrientationAnchor', () => {
        it('returns empty string when toolCallsCount < 3', () => {
            assert.equal(buildOrientationAnchor('read_file', 1, [], null, 'normal'), '');
            assert.equal(buildOrientationAnchor('read_file', 2, [], null, 'normal'), '');
        });

        it('returns empty string when toolCallsCount is not a multiple of 3', () => {
            assert.equal(buildOrientationAnchor('read_file', 4, [], null, 'normal'), '');
            assert.equal(buildOrientationAnchor('read_file', 5, [], null, 'normal'), '');
        });

        it('returns orientation with files changed', () => {
            const result = buildOrientationAnchor('edit_file', 3, ['src/a.ts', 'src/b.ts'], null, 'normal');
            assert.ok(result.includes('Files edited this run'));
            assert.ok(result.includes('src/a.ts'));
            assert.ok(result.includes('src/b.ts'));
        });

        it('shows only last 3 files when more than 3 changed', () => {
            const files = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'];
            const result = buildOrientationAnchor('edit_file', 6, files, null, 'normal');
            assert.ok(result.includes('c.ts'));
            assert.ok(result.includes('d.ts'));
            assert.ok(result.includes('e.ts'));
            assert.ok(!result.includes('a.ts'));
        });

        it('includes active task completed steps', () => {
            const task = { stepsCompleted: ['step one', 'step two'], stepsPending: [] };
            const result = buildOrientationAnchor('edit_file', 3, [], task as any, 'normal');
            assert.ok(result.includes('Done:'));
            assert.ok(result.includes('step one'));
        });

        it('includes next pending step', () => {
            const task = { stepsCompleted: [], stepsPending: ['implement auth', 'build UI'] };
            const result = buildOrientationAnchor('edit_file', 3, [], task as any, 'normal');
            assert.ok(result.includes('NEXT: implement auth'));
        });

        it('returns generic nudge for non-normal trust with no files or task', () => {
            const result = buildOrientationAnchor('read_file', 3, [], null, 'yolo');
            assert.ok(result.includes('ORIENTATION'));
            assert.ok(result.includes('3 tool calls'));
        });

        it('returns empty string for normal trust with no files or task', () => {
            const result = buildOrientationAnchor('read_file', 3, [], null, 'normal');
            assert.equal(result, '');
        });

        it('appends action nudge for non-normal trust levels', () => {
            const result = buildOrientationAnchor('edit_file', 3, ['a.ts'], null, 'yolo');
            assert.ok(result.includes('act on the NEXT item'));
        });

        it('does not append action nudge for normal trust', () => {
            const result = buildOrientationAnchor('edit_file', 3, ['a.ts'], null, 'normal');
            assert.ok(!result.includes('act on the NEXT item'));
        });
    });

    describe('INTENT_PATTERNS', () => {
        it('detects "we use" pattern', () => {
            assert.ok(INTENT_PATTERNS.some(p => p.test('we use PostgreSQL for the database')));
        });

        it('detects "built with" pattern', () => {
            assert.ok(INTENT_PATTERNS.some(p => p.test('built with React and TypeScript')));
        });

        it('detects "remember" pattern', () => {
            assert.ok(INTENT_PATTERNS.some(p => p.test('remember that the server is at 10.0.1.5')));
        });

        it('detects "always" convention pattern', () => {
            assert.ok(INTENT_PATTERNS.some(p => p.test('always use 4-space indentation')));
        });

        it('does not match random text', () => {
            assert.ok(!INTENT_PATTERNS.some(p => p.test('hello world')));
        });
    });

    describe('NEGATIVE_CONTEXT', () => {
        it('detects "don\'t" negative', () => {
            assert.ok(NEGATIVE_CONTEXT.some(p => p.test("don't use that library")));
        });

        it('detects "instead of" negative', () => {
            assert.ok(NEGATIVE_CONTEXT.some(p => p.test('use X instead of Y')));
        });

        it('detects "without" negative', () => {
            assert.ok(NEGATIVE_CONTEXT.some(p => p.test('deploy without docker')));
        });

        it('does not match positive statements', () => {
            assert.ok(!NEGATIVE_CONTEXT.some(p => p.test('we use PostgreSQL')));
        });
    });

    describe('KNOWN_TECHNOLOGIES', () => {
        it('includes common frameworks', () => {
            assert.ok(KNOWN_TECHNOLOGIES.has('react'));
            assert.ok(KNOWN_TECHNOLOGIES.has('django'));
            assert.ok(KNOWN_TECHNOLOGIES.has('typescript'));
        });

        it('includes databases', () => {
            assert.ok(KNOWN_TECHNOLOGIES.has('postgresql'));
            assert.ok(KNOWN_TECHNOLOGIES.has('redis'));
            assert.ok(KNOWN_TECHNOLOGIES.has('sqlite'));
        });

        it('includes dev tools', () => {
            assert.ok(KNOWN_TECHNOLOGIES.has('docker'));
            assert.ok(KNOWN_TECHNOLOGIES.has('kubernetes'));
            assert.ok(KNOWN_TECHNOLOGIES.has('terraform'));
        });

        it('does not include unknown technologies', () => {
            assert.ok(!KNOWN_TECHNOLOGIES.has('nonexistent-framework'));
        });
    });

    describe('MAX_MEMORY_WRITES_PER_RESPONSE', () => {
        it('is 3', () => {
            assert.equal(MAX_MEMORY_WRITES_PER_RESPONSE, 3);
        });
    });
});
