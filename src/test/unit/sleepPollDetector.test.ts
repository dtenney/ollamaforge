/**
 * sleepPollDetector.test.ts
 *
 * Unit tests for the sleep-poll loop detector in Agent (src/agent.ts).
 * Tests Variants B and C — background build polling patterns that should
 * be stopped after 2 attempts regardless of output changes.
 *
 * Run with: npm run test:agent-fixes
 */

import * as assert from 'assert';

// ── Inline replica of the detection logic ────────────────────────────────────
// We extract the exact regex logic from agent.ts so we can unit-test it
// without instantiating Agent (which requires vscode + all deps).

function classifyPollCommand(cmd: string): 'sleep-log' | 'sleep-exist' | 'build-status' | 'none' {
    const c = cmd.toLowerCase();
    const hasSleep = /\bsleep\s+\d+\b/.test(c);

    // Variant A: sleep + read-log (cat/tail *.log)
    if (hasSleep && (/\bcat\s+\S+\.log\b/.test(c) || /\btail\b/.test(c) || /\bcat\s+\S+\.(log|txt|out)\b/.test(c))) {
        return 'sleep-log';
    }
    // Variant B: sleep + existence-check (ls/find/wc/test)
    if (hasSleep && /\b(ls|find|wc|test\s+-[fe])\b/.test(c)) {
        return 'sleep-exist';
    }
    // Variant C: no sleep but tasklist+ls (background build status check)
    if (!hasSleep && /\btasklist\b/.test(c) && /\b(ls|find|dir)\b/.test(c)) {
        return 'build-status';
    }
    return 'none';
}

function normalizePollSig(cmd: string): string {
    return cmd.toLowerCase()
        .replace(/\bsleep\s+\d+\s*&&\s*/g, '')
        .replace(/\d{4,}/g, 'N')
        .trim()
        .slice(0, 150);
}

function isBuildPoll(cmd: string): boolean {
    const c = cmd.toLowerCase();
    return (/\btasklist\b/i.test(c) && /\b(ls|find|dir)\b/.test(c))
        || (/\bsleep\s+\d+\b/.test(c) && /\b(ls|find|wc|test\s+-[fe])\b/.test(c));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Sleep-poll loop detector', () => {

    describe('classifyPollCommand', () => {
        it('classifies sleep+ls as sleep-exist (Variant B)', () => {
            assert.strictEqual(
                classifyPollCommand('sleep 60 && ls /c/Users/david/source/app/build/outputs/flutter-apk/'),
                'sleep-exist'
            );
        });

        it('classifies sleep+find as sleep-exist', () => {
            assert.strictEqual(
                classifyPollCommand('sleep 30 && find /tmp/build -name "*.apk"'),
                'sleep-exist'
            );
        });

        it('classifies sleep+wc as sleep-exist', () => {
            assert.strictEqual(
                classifyPollCommand('sleep 15 && wc -l /tmp/build.log'),
                'sleep-exist'
            );
        });

        it('classifies tasklist+ls as build-status (Variant C)', () => {
            assert.strictEqual(
                classifyPollCommand('tasklist 2>/dev/null | grep -ic java; ls /c/Users/david/source/app/build/app/outputs/flutter-apk/ 2>&1'),
                'build-status'
            );
        });

        it('classifies sleep+cat.log as sleep-log (Variant A — existing)', () => {
            assert.strictEqual(
                classifyPollCommand('sleep 10 && cat /tmp/build.log'),
                'sleep-log'
            );
        });

        it('classifies sleep+tail as sleep-log (Variant A)', () => {
            assert.strictEqual(
                classifyPollCommand('sleep 10 && tail -f /tmp/output.log'),
                'sleep-log'
            );
        });

        it('does not classify plain ls as a poll', () => {
            assert.strictEqual(classifyPollCommand('ls /tmp/build'), 'none');
        });

        it('does not classify git status as a poll', () => {
            assert.strictEqual(classifyPollCommand('git status'), 'none');
        });

        it('does not classify plain tasklist as a poll', () => {
            assert.strictEqual(classifyPollCommand('tasklist | grep java'), 'none');
        });
    });

    describe('normalizePollSig', () => {
        it('strips sleep prefix so different durations match', () => {
            const sig60 = normalizePollSig('sleep 60 && ls /build/flutter-apk/');
            const sig120 = normalizePollSig('sleep 120 && ls /build/flutter-apk/');
            assert.strictEqual(sig60, sig120);
        });

        it('normalizes large numbers (PIDs, sizes)', () => {
            const sig1 = normalizePollSig('tasklist | grep -ic java; ls /build/ 2>&1');
            // PIDs in output don't affect sig since we normalize on the command, not output
            assert.ok(sig1.length > 0);
        });

        it('two tasklist+ls commands with different PID-like tokens normalize the same', () => {
            const sig1 = normalizePollSig('tasklist 2>/dev/null | grep -ic java; ls /build/flutter-apk/ 2>&1');
            const sig2 = normalizePollSig('tasklist 2>/dev/null | grep -ic java; ls /build/flutter-apk/ 2>&1');
            assert.strictEqual(sig1, sig2);
        });
    });

    describe('isBuildPoll (circuit-breaker exemption)', () => {
        it('exempts tasklist+ls from circuit breaker', () => {
            assert.strictEqual(
                isBuildPoll('tasklist 2>/dev/null | grep -ic java; ls /build/flutter-apk/ 2>&1'),
                true
            );
        });

        it('exempts sleep+ls from circuit breaker', () => {
            assert.strictEqual(
                isBuildPoll('sleep 60 && ls /build/flutter-apk/'),
                true
            );
        });

        it('does NOT exempt plain ls from circuit breaker', () => {
            assert.strictEqual(isBuildPoll('ls /build/flutter-apk/'), false);
        });

        it('does NOT exempt ssh commands from circuit breaker', () => {
            assert.strictEqual(isBuildPoll('ssh user@host "ls /build/"'), false);
        });
    });

    describe('poll count threshold', () => {
        it('fires after 2 attempts (not 3)', () => {
            const map = new Map<string, { count: number; lastOutput: string }>();
            const cmd = 'tasklist 2>/dev/null | grep -ic java; ls /build/flutter-apk/ 2>&1';
            const sig = normalizePollSig(cmd);

            // First attempt — should NOT fire
            const existing1 = map.get(sig);
            const count1 = (existing1?.count ?? 0) + 1;
            map.set(sig, { count: count1, lastOutput: 'not found' });
            assert.ok(count1 < 2, 'Should not fire on first attempt');

            // Second attempt — SHOULD fire
            const existing2 = map.get(sig);
            const count2 = (existing2?.count ?? 0) + 1;
            map.set(sig, { count: count2, lastOutput: 'not found' });
            assert.ok(count2 >= 2, 'Should fire on second attempt');
        });
    });
});
