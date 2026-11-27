/**
 * contextBudgetStop.test.ts
 *
 * Unit tests for the context-budget self-stop interceptor in Agent (src/agent.ts).
 * Verifies that "needs a fresh session" / "not enough context" language is correctly
 * detected so the agent can redirect instead of stopping.
 *
 * Run with: npm run test:agent-fixes
 */

import * as assert from 'assert';

// ── Inline replica of the detection regex from agent.ts ──────────────────────

const CONTEXT_BUDGET_SELF_STOP_RE = /\b(needs?\s+a\s+(fresh|new)\s+session|not\s+enough\s+context|context\s+(budget|remaining)\s+is\s+(low|exhausted|too\s+small)|context\s+(is\s+)?(too\s+small|exhausted|running\s+low)|start\s+a\s+new\s+session\s+to|fresh\s+session\s+(needed|required|prompt)|next.session\s+prompt)\b/i;

function isContextBudgetSelfStop(resp: string, toolCallsThisRunCount: number): boolean {
    return CONTEXT_BUDGET_SELF_STOP_RE.test(resp) && toolCallsThisRunCount > 0;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Context-budget self-stop interceptor', () => {

    describe('detection regex', () => {
        const positives = [
            'Needs a fresh session to continue safely.',
            'This needs a new session — not enough context remaining.',
            'Not enough context to complete this safely.',
            'The context budget is exhausted.',
            'Context remaining is exhausted — cannot continue.',
            'You should start a new session to do this safely.',
            'Fresh session needed for the next phase.',
            'Fresh session required before continuing.',
            'Next-session prompt: replace lines 4269–4981.',
            'Next session prompt: "Replace the inline block..."',
            'Context is too small for this edit.',
            'Context is running low — cannot proceed.',
        ];

        for (const text of positives) {
            it(`detects: "${text.slice(0, 60)}"`, () => {
                assert.ok(
                    CONTEXT_BUDGET_SELF_STOP_RE.test(text),
                    `Expected to match: ${text}`
                );
            });
        }

        const negatives = [
            'The context is ready. Let me continue.',
            'I have enough context to proceed.',
            'Starting a new file for the refactor.',
            'Session started successfully.',
            'Context window is 128k tokens.',
            'The budget is set to 50 tool calls.',
            'Let me read the file first.',
        ];

        for (const text of negatives) {
            it(`does NOT detect: "${text.slice(0, 60)}"`, () => {
                assert.ok(
                    !CONTEXT_BUDGET_SELF_STOP_RE.test(text),
                    `Expected NOT to match: ${text}`
                );
            });
        }
    });

    describe('isContextBudgetSelfStop', () => {
        it('fires when matching text + tool calls > 0', () => {
            assert.strictEqual(
                isContextBudgetSelfStop('Needs a fresh session to continue.', 3),
                true
            );
        });

        it('does NOT fire when no tool calls this run (agent just started)', () => {
            assert.strictEqual(
                isContextBudgetSelfStop('Needs a fresh session to continue.', 0),
                false
            );
        });

        it('does NOT fire for normal text without stop language', () => {
            assert.strictEqual(
                isContextBudgetSelfStop('Let me read the file and continue.', 5),
                false
            );
        });

        it('fires case-insensitively', () => {
            assert.strictEqual(
                isContextBudgetSelfStop('NEEDS A FRESH SESSION for this large edit.', 2),
                true
            );
        });

        it('fires on multi-line response containing stop language mid-text', () => {
            const resp = `I have read the file.\nI have identified the block to replace.\nNeeds a fresh session — the replacement is 700 lines.\nNext-session prompt: replace lines 4269-4981.`;
            assert.strictEqual(isContextBudgetSelfStop(resp, 4), true);
        });
    });
});
