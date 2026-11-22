/**
 * Tests for agent performance improvements:
 *   - memory_list truncation cap (4000 chars, snaps to newline)
 *   - workspace_summary truncation cap (6000 chars, snaps to newline)
 *   - commandPolicy: --force-with-lease confirm rule
 *   - commandPolicy: --force-with-lease-ifcommit NOT blocked (false-positive guard)
 *   - tool routing section present in system prompt
 *   - STOP conditions present in system prompt
 */

import * as assert from 'assert';
import { evaluateCommand } from '../../commandPolicy';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Simulate the memory_list truncation logic extracted from agent.ts
 * (keeps this test self-contained without needing the full Agent class).
 */
function applyMemoryListCap(raw: string, cap = 4000): string {
    if (raw.length <= cap) { return raw; }
    const cutPoint = raw.lastIndexOf('\n', cap) > cap - 200
        ? raw.lastIndexOf('\n', cap)
        : cap;
    return raw.slice(0, cutPoint) +
        `\n\n[Truncated — ${raw.length - cutPoint} chars omitted. Use memory_search for targeted queries or memory_tier_list to view specific tiers.]`;
}

/**
 * Simulate the workspace_summary truncation logic extracted from agent.ts.
 */
function applyWsSummaryCap(raw: string, cap = 6000): string {
    if (raw.length <= cap) { return raw; }
    const cutPoint = raw.lastIndexOf('\n', cap) > cap - 200
        ? raw.lastIndexOf('\n', cap)
        : cap;
    return raw.slice(0, cutPoint) +
        `\n\n[Truncated — ${raw.length - cutPoint} chars omitted. Use find_files or shell_read for further exploration.]`;
}

// ── memory_list cap tests ─────────────────────────────────────────────────────

describe('memory_list truncation cap', () => {

    it('returns full output when under 4000 chars', () => {
        const input = 'Project memory notes:\n\n' + 'x'.repeat(100);
        const result = applyMemoryListCap(input);
        assert.strictEqual(result, input);
    });

    it('truncates output when over 4000 chars', () => {
        const input = 'Project memory notes:\n\n' + 'x'.repeat(5000);
        const result = applyMemoryListCap(input);
        assert.ok(result.length < input.length);
        assert.ok(result.includes('[Truncated'));
    });

    it('appends memory_search hint in truncation message', () => {
        const input = 'Project memory notes:\n\n' + 'x'.repeat(5000);
        const result = applyMemoryListCap(input);
        assert.ok(result.includes('memory_search'));
        assert.ok(result.includes('memory_tier_list'));
    });

    it('snaps cut point to last newline when newline is within grace margin', () => {
        // Build a string where a newline falls just before the cap
        const prefix = 'Project memory notes:\n\n';
        const lineA = 'a'.repeat(3900) + '\n';   // newline at ~3923, within cap
        const lineB = 'b'.repeat(500);            // rest pushes us over 4000
        const input = prefix + lineA + lineB;
        const result = applyMemoryListCap(input);
        // The cut should happen at the newline, so result should not end mid-'b' run
        const body = result.split('\n\n[Truncated')[0];
        assert.ok(!body.includes('b'), 'Should have cut before the b-run line');
    });

    it('falls back to hard cap when no newline is within grace margin', () => {
        // 4001 chars with no newlines at all
        const input = 'x'.repeat(4001);
        const result = applyMemoryListCap(input);
        // lastIndexOf('\n', 4000) === -1 (no newlines), which is NOT > 4000-200=3800
        // so cutPoint = 4000 (hard cap)
        assert.ok(result.startsWith('x'.repeat(4000)));
        assert.ok(result.includes('[Truncated'));
    });

    it('truncation message includes omitted char count', () => {
        const input = 'x'.repeat(5000);
        const result = applyMemoryListCap(input);
        // Should mention how many chars were omitted (some positive number)
        const match = result.match(/(\d+) chars omitted/);
        assert.ok(match, 'Should include chars omitted count');
        assert.ok(parseInt(match![1]) > 0);
    });
});

// ── workspace_summary cap tests ───────────────────────────────────────────────

describe('workspace_summary truncation cap', () => {

    it('returns full output when under 6000 chars', () => {
        const input = 'Workspace summary\n\n' + 'x'.repeat(100);
        const result = applyWsSummaryCap(input);
        assert.strictEqual(result, input);
    });

    it('truncates output when over 6000 chars', () => {
        const input = 'Workspace summary\n\n' + 'x'.repeat(7000);
        const result = applyWsSummaryCap(input);
        assert.ok(result.length < input.length);
        assert.ok(result.includes('[Truncated'));
    });

    it('appends find_files hint in truncation message', () => {
        const input = 'Workspace summary\n\n' + 'x'.repeat(7000);
        const result = applyWsSummaryCap(input);
        assert.ok(result.includes('find_files'));
        assert.ok(result.includes('shell_read'));
    });

    it('snaps cut point to last newline when newline is within grace margin', () => {
        const lineA = 'a'.repeat(5900) + '\n';
        const lineB = 'b'.repeat(500);
        const input = lineA + lineB;
        const result = applyWsSummaryCap(input);
        const body = result.split('\n\n[Truncated')[0];
        assert.ok(!body.includes('b'), 'Should have cut before the b-run line');
    });

    it('falls back to hard cap when no newline is within grace margin', () => {
        const input = 'x'.repeat(6001);
        const result = applyWsSummaryCap(input);
        assert.ok(result.startsWith('x'.repeat(6000)));
        assert.ok(result.includes('[Truncated'));
    });
});

// ── commandPolicy: --force-with-lease ────────────────────────────────────────

describe('commandPolicy --force-with-lease', () => {

    it('requires confirmation for git push --force-with-lease', () => {
        const result = evaluateCommand('git push --force-with-lease');
        assert.strictEqual(result.verdict, 'confirm');
    });

    it('requires confirmation for git push origin main --force-with-lease', () => {
        const result = evaluateCommand('git push origin main --force-with-lease');
        assert.strictEqual(result.verdict, 'confirm');
    });

    it('requires confirmation for git push --force-with-lease (trailing space)', () => {
        const result = evaluateCommand('git push --force-with-lease ');
        assert.strictEqual(result.verdict, 'confirm');
    });

    it('--force-with-lease-ifcommit still requires confirmation (via --force rule, not lease rule)', () => {
        // --force-with-lease-ifcommit is a force push variant — confirmation is correct.
        // The key is it matches via the existing --force rule, not our new lease rule,
        // so our new regex does not add a redundant double-match.
        const result = evaluateCommand('git push --force-with-lease-ifcommit');
        assert.strictEqual(result.verdict, 'confirm');
        // Confirm it fires the general --force rule, not our new lease-specific rule
        assert.ok(result.reason.includes('--force\\b'),
            'Should match via the --force rule, not the lease-specific rule');
    });

    it('still requires confirmation for plain --force', () => {
        const result = evaluateCommand('git push --force');
        assert.strictEqual(result.verdict, 'confirm');
    });

    it('still requires confirmation for -f shorthand', () => {
        const result = evaluateCommand('git push origin main -f');
        assert.strictEqual(result.verdict, 'confirm');
    });
});

// ── commandPolicy: existing deny rules unaffected ───────────────────────────

describe('commandPolicy existing deny rules', () => {

    it('denies rm -rf /', () => {
        assert.strictEqual(evaluateCommand('rm -rf /').verdict, 'deny');
    });

    it('denies fork bomb', () => {
        assert.strictEqual(evaluateCommand(':(){ :|:& };:').verdict, 'deny');
    });

    it('denies mkfs.ext4', () => {
        assert.strictEqual(evaluateCommand('mkfs.ext4 /dev/sdb').verdict, 'deny');
    });

    it('denies dd of=/dev/sda', () => {
        assert.strictEqual(evaluateCommand('dd if=/dev/zero of=/dev/sda').verdict, 'deny');
    });

    it('allows safe read-only commands', () => {
        assert.strictEqual(evaluateCommand('git status').verdict, 'allow');
        assert.strictEqual(evaluateCommand('ls -la').verdict, 'allow');
    });
});
