import { strict as assert } from 'assert';
import {
    isOutdatedAgentModel,
    parseModelRecommendations,
    isRecommendedModel,
    OutdatedModelWarningTracker,
} from '../../modelRecommendations';

describe('modelRecommendations', () => {

    describe('isOutdatedAgentModel', () => {
        it('detects codellama as outdated', () => {
            assert.ok(isOutdatedAgentModel('codellama:13b'));
        });

        it('detects llama3 as outdated', () => {
            assert.ok(isOutdatedAgentModel('llama3:8b'));
        });

        it('detects llama3.1 as outdated', () => {
            assert.ok(isOutdatedAgentModel('llama3.1:70b'));
        });

        it('detects llama3.2 as outdated', () => {
            assert.ok(isOutdatedAgentModel('llama3.2:3b'));
        });

        it('detects mistral as outdated', () => {
            assert.ok(isOutdatedAgentModel('mistral:7b'));
        });

        it('detects qwen2.5 as outdated', () => {
            assert.ok(isOutdatedAgentModel('qwen2.5:7b'));
        });

        it('detects starcoder as outdated', () => {
            assert.ok(isOutdatedAgentModel('starcoder:13b'));
        });

        it('detects deepseek-r1 with no tag as outdated', () => {
            assert.ok(isOutdatedAgentModel('deepseek-r1'));
        });

        it('detects deepseek-r1:latest as outdated', () => {
            assert.ok(isOutdatedAgentModel('deepseek-r1:latest'));
        });

        it('detects deepseek-r1:8b as outdated', () => {
            assert.ok(isOutdatedAgentModel('deepseek-r1:8b'));
        });

        it('does not flag llama3.4 (not in outdated list)', () => {
            assert.ok(!isOutdatedAgentModel('llama3.4:8b'));
        });

        it('does not flag qwen3 (not in outdated list)', () => {
            assert.ok(!isOutdatedAgentModel('qwen3:8b'));
        });

        it('does not flag gemma (not in outdated list)', () => {
            assert.ok(!isOutdatedAgentModel('gemma:7b'));
        });

        it('is case-insensitive', () => {
            assert.ok(isOutdatedAgentModel('LLaMA3:8b'));
        });
    });

    describe('parseModelRecommendations', () => {
        it('returns empty array for null', () => {
            assert.deepEqual(parseModelRecommendations(null), []);
        });

        it('returns empty array for non-object', () => {
            assert.deepEqual(parseModelRecommendations('hello'), []);
        });

        it('returns empty array when recommendations is missing', () => {
            assert.deepEqual(parseModelRecommendations({}), []);
        });

        it('returns empty array when recommendations is not an array', () => {
            assert.deepEqual(parseModelRecommendations({ recommendations: 'bad' }), []);
        });

        it('parses valid recommendations', () => {
            const result = parseModelRecommendations({
                recommendations: [
                    { model: 'llama3.4:8b' },
                    { model: 'qwen3:14b' },
                ]
            });
            assert.equal(result.length, 2);
            assert.equal(result[0].model, 'llama3.4:8b');
            assert.equal(result[1].model, 'qwen3:14b');
        });

        it('skips invalid entries', () => {
            const result = parseModelRecommendations({
                recommendations: [
                    { model: 'valid:1b' },
                    { name: 'not-a-model' },
                    42,
                    null,
                ]
            });
            assert.equal(result.length, 1);
            assert.equal(result[0].model, 'valid:1b');
        });

        it('deduplicates recommendations', () => {
            const result = parseModelRecommendations({
                recommendations: [
                    { model: 'llama3.4:8b' },
                    { model: 'llama3.4:8b' },
                ]
            });
            assert.equal(result.length, 1);
        });
    });

    describe('isRecommendedModel', () => {
        it('returns true when model is in recommendations', () => {
            const recs = [{ model: 'llama3.4:8b' }];
            assert.ok(isRecommendedModel('llama3.4:8b', recs));
        });

        it('returns false when model is not in recommendations', () => {
            const recs = [{ model: 'llama3.4:8b' }];
            assert.ok(!isRecommendedModel('gemma:7b', recs));
        });

        it('returns false for empty recommendations', () => {
            assert.ok(!isRecommendedModel('llama3.4:8b', []));
        });
    });

    describe('OutdatedModelWarningTracker', () => {
        it('tracks warnings per conversation', () => {
            const tracker = new OutdatedModelWarningTracker();
            const req = tracker.beginRequest(['hello'], false);
            assert.ok(!tracker.hasShown(req, 'llama3:8b'));
            tracker.markShown(req, 'llama3:8b');
            assert.ok(tracker.hasShown(req, 'llama3:8b'));
        });

        it('does not show warning for different model', () => {
            const tracker = new OutdatedModelWarningTracker();
            const req = tracker.beginRequest(['hello'], false);
            tracker.markShown(req, 'llama3:8b');
            assert.ok(!tracker.hasShown(req, 'mistral:7b'));
        });

        it('reuses conversation for same history', () => {
            const tracker = new OutdatedModelWarningTracker();
            const req1 = tracker.beginRequest(['hello', 'world'], false);
            tracker.markShown(req1, 'llama3:8b');
            const req2 = tracker.beginRequest(['hello', 'world'], true);
            assert.ok(tracker.hasShown(req2, 'llama3:8b'));
        });

        it('creates new conversation for different history', () => {
            const tracker = new OutdatedModelWarningTracker();
            const req1 = tracker.beginRequest(['hello'], false);
            tracker.markShown(req1, 'llama3:8b');
            const req2 = tracker.beginRequest(['different'], false);
            assert.ok(!tracker.hasShown(req2, 'llama3:8b'));
        });

        it('respects maxChats limit', () => {
            const tracker = new OutdatedModelWarningTracker(2);
            tracker.beginRequest(['a'], false);
            tracker.beginRequest(['b'], false);
            tracker.beginRequest(['c'], false); // should evict oldest
            // All three requests should still work
        });

        it('finishRequest marks success', () => {
            const tracker = new OutdatedModelWarningTracker();
            const req = tracker.beginRequest(['hello'], false);
            tracker.finishRequest(req, true);
            // After success, same history should still match
            const req2 = tracker.beginRequest(['hello'], true);
            assert.ok(req2.conversationID === req.conversationID);
        });
    });
});
