import * as assert from 'assert';
import { classifyIntent, getIntent, PromptIntent } from '../../core/promptIntentClassifier';

describe('promptIntentClassifier', () => {
    describe('explain intent', () => {
        it('should classify "explain this function" as explain', () => {
            const result = classifyIntent('explain this function');
            assert.strictEqual(result.intent, 'explain');
            assert.ok(result.confidence >= 0.8);
        });

        it('should classify "what does this file do" as explain', () => {
            const result = classifyIntent('what does this file do?');
            assert.strictEqual(result.intent, 'explain');
        });

        it('should classify "describe the architecture" as explain', () => {
            const result = classifyIntent('describe the architecture of this module');
            assert.strictEqual(result.intent, 'explain');
        });

        it('should skip git_diff and workspace_scan for explain', () => {
            const result = classifyIntent('explain this code');
            assert.ok(result.contextSkips.includes('git_diff'));
            assert.ok(result.contextSkips.includes('workspace_scan'));
        });
    });

    describe('refactor intent', () => {
        it('should classify "refactor this module" as refactor', () => {
            const result = classifyIntent('refactor this module');
            assert.strictEqual(result.intent, 'refactor');
        });

        it('should classify "move the config to a separate file" as refactor', () => {
            const result = classifyIntent('move the config to a separate file');
            assert.strictEqual(result.intent, 'refactor');
        });

        it('should classify "rename this function" as refactor', () => {
            const result = classifyIntent('rename this function to something clearer');
            assert.strictEqual(result.intent, 'refactor');
        });

        it('should prioritize imports and similar_files for refactor', () => {
            const result = classifyIntent('refactor this');
            assert.ok(result.contextPriorities.includes('imports'));
            assert.ok(result.contextPriorities.includes('similar_files'));
        });
    });

    describe('create intent', () => {
        it('should classify "create a new endpoint" as create', () => {
            const result = classifyIntent('create a new endpoint for user registration');
            assert.strictEqual(result.intent, 'create');
        });

        it('should classify "add a test for the payment service" as create', () => {
            const result = classifyIntent('add a test for the payment service');
            assert.strictEqual(result.intent, 'create');
        });

        it('should classify "implement rate limiting" as create', () => {
            const result = classifyIntent('implement rate limiting for the API');
            assert.strictEqual(result.intent, 'create');
        });
    });

    describe('debug intent', () => {
        it('should classify "fix this bug" as debug', () => {
            const result = classifyIntent('fix this bug');
            assert.strictEqual(result.intent, 'debug');
        });

        it('should classify "why is this failing" as debug', () => {
            const result = classifyIntent('why is this failing?');
            assert.strictEqual(result.intent, 'debug');
        });

        it('should classify "there is an error in the build" as debug', () => {
            const result = classifyIntent('there is an error in the build');
            assert.strictEqual(result.intent, 'debug');
        });

        it('should prioritize git_diff for debug', () => {
            const result = classifyIntent('fix the crash');
            assert.ok(result.contextPriorities.includes('git_diff'));
        });
    });

    describe('search intent', () => {
        it('should classify "find the config file" as search', () => {
            const result = classifyIntent('find the config file');
            assert.strictEqual(result.intent, 'search');
        });

        it('should classify "where is the auth middleware" as search', () => {
            const result = classifyIntent('where is the auth middleware defined?');
            assert.strictEqual(result.intent, 'search');
        });

        it('should classify "which function handles the request" as search', () => {
            const result = classifyIntent('which function handles the request?');
            assert.strictEqual(result.intent, 'search');
        });

        it('should skip git_diff and git_blame for search', () => {
            const result = classifyIntent('find the database connection code');
            assert.ok(result.contextSkips.includes('git_diff'));
            assert.ok(result.contextSkips.includes('git_blame'));
        });
    });

    describe('general fallback', () => {
        it('should return general for empty string', () => {
            const result = classifyIntent('');
            assert.strictEqual(result.intent, 'general');
            assert.strictEqual(result.confidence, 0);
        });

        it('should return general for whitespace-only string', () => {
            const result = classifyIntent('   ');
            assert.strictEqual(result.intent, 'general');
        });

        it('should return general for unrecognized prompt', () => {
            const result = classifyIntent('hello there, how are you doing today?');
            assert.strictEqual(result.intent, 'general');
            assert.ok(result.confidence < 0.5);
        });

        it('should include full context priorities for general', () => {
            const result = classifyIntent('hello');
            assert.ok(result.contextPriorities.length >= 3);
        });
    });

    describe('getIntent convenience', () => {
        it('should return the intent label directly', () => {
            assert.strictEqual(getIntent('explain this'), 'explain');
            assert.strictEqual(getIntent('fix the bug'), 'debug');
            assert.strictEqual(getIntent('find the file'), 'search');
        });
    });

    describe('edge cases', () => {
        it('should handle very long prompts', () => {
            const longPrompt = 'Please ' + 'explain '.repeat(100) + 'this code thoroughly';
            const result = classifyIntent(longPrompt);
            assert.strictEqual(result.intent, 'explain');
        });

        it('should be case-insensitive', () => {
            assert.strictEqual(getIntent('EXPLAIN THIS'), 'explain');
            assert.strictEqual(getIntent('Fix The Bug'), 'debug');
        });

        it('should handle prompts with special characters', () => {
            const result = classifyIntent('fix the "null pointer" error in src/main.ts');
            assert.strictEqual(result.intent, 'debug');
        });

        it('should not crash on null-like inputs', () => {
            // TypeScript won't allow null, but test empty
            const result = classifyIntent('');
            assert.ok(result.intent);
        });
    });
});
