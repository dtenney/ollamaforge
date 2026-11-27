/**
 * greetingReset.test.ts
 *
 * Unit tests for the greeting-reset detection and legitimateStop interaction fix.
 *
 * Key bug fixed: when agent output "What would you like to work on?" after real work,
 * `endsWithQuestion` was setting `isLegitimateStop = true`, blocking the correction injection.
 * Fix: `isLegitimateStop` now excludes `isAgentGreetingReset` from the endsWithQuestion path.
 *
 * Run with: npm run test:agent-fixes
 */

import * as assert from 'assert';

// ── Inline replica of detection logic from agent.ts ───────────────────────────

const GREETING_RESET_RE = /\b(ready to help(?: with)?|what would you like(?: me)? to(?: work on| do|help)|how can i (?:help|assist)(?: you)?(?:\s+(?:today|now))?[.?]?|what would you like(?: to do)? next[.?]?)\b/i;

const ENDS_WITH_QUESTION_RE = /\?[\s"'`]*$/;

function isAgentGreetingReset(resp: string, toolCallsThisRunCount: number): boolean {
    return GREETING_RESET_RE.test(resp.trim()) && toolCallsThisRunCount > 2;
}

function endsWithQuestion(resp: string): boolean {
    return ENDS_WITH_QUESTION_RE.test(resp.trim());
}

function isLegitimateStop(resp: string, toolCallsThisRunCount: number, isPlanningNarration: boolean): boolean {
    const greetingReset = isAgentGreetingReset(resp, toolCallsThisRunCount);
    const question = endsWithQuestion(resp);
    // KEY FIX: endsWithQuestion is legitimate UNLESS it's a greeting reset
    return (question && !isPlanningNarration && !greetingReset);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Greeting-reset detection', () => {

    describe('GREETING_RESET_RE', () => {
        const positives = [
            'Dev server is reachable. What would you like to work on?',
            'Ready to help with the next task.',
            'What would you like me to do next?',
            'How can I help you today?',
            'How can I assist you now?',
            'What would you like to do next?',
        ];

        for (const text of positives) {
            it(`detects greeting reset: "${text.slice(0, 60)}"`, () => {
                assert.ok(GREETING_RESET_RE.test(text.trim()), `Expected to match: ${text}`);
            });
        }

        const negatives = [
            'The deployment is complete. Should I run the tests?',
            'I found 3 issues. Would you like me to fix them?',
            'The file was updated. Can you review the changes?',
            'Build succeeded. Ready to deploy?',
        ];

        for (const text of negatives) {
            it(`does NOT detect as greeting reset: "${text.slice(0, 60)}"`, () => {
                assert.ok(!GREETING_RESET_RE.test(text.trim()), `Expected NOT to match: ${text}`);
            });
        }
    });

    describe('isAgentGreetingReset', () => {
        it('fires when greeting text + more than 2 tool calls this run', () => {
            assert.strictEqual(
                isAgentGreetingReset('What would you like to work on?', 5),
                true
            );
        });

        it('does NOT fire with <= 2 tool calls (agent just started)', () => {
            assert.strictEqual(
                isAgentGreetingReset('What would you like to work on?', 2),
                false
            );
        });

        it('does NOT fire for legitimate task-completion questions', () => {
            assert.strictEqual(
                isAgentGreetingReset('The deploy is done. Should I run the smoke tests?', 5),
                false
            );
        });
    });

    describe('isLegitimateStop — greeting reset overrides endsWithQuestion', () => {
        it('greeting reset + endsWithQuestion → NOT a legitimate stop (correction should fire)', () => {
            const resp = 'Dev server is reachable and repo is up to date. What would you like to work on?';
            // This was the bug: endsWithQuestion=true was making this a legitimate stop
            assert.strictEqual(
                isLegitimateStop(resp, 5, false),
                false,
                'Greeting reset should NOT be a legitimate stop even though it ends with ?'
            );
        });

        it('real task question + endsWithQuestion → IS a legitimate stop', () => {
            const resp = 'I found 3 test failures. Should I fix them?';
            assert.strictEqual(
                isLegitimateStop(resp, 5, false),
                true,
                'Real task question should be a legitimate stop'
            );
        });

        it('greeting reset with 0 tool calls → IS a legitimate stop (agent just started)', () => {
            // With 0 tool calls, isAgentGreetingReset is false, so endsWithQuestion wins
            const resp = 'What would you like to work on?';
            assert.strictEqual(
                isLegitimateStop(resp, 0, false),
                true,
                'Fresh session greeting is a legitimate stop'
            );
        });

        it('planning narration suppresses legitimate stop regardless', () => {
            const resp = 'I will now read the file. Should I proceed?';
            assert.strictEqual(
                isLegitimateStop(resp, 5, true /* isPlanningNarration */),
                false
            );
        });
    });
});
