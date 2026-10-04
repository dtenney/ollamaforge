import { strict as assert } from 'assert';
import {
    minimumMachineContextLength,
    machineContextLength,
    isMachineContextTooSmall,
    formatContextLength,
} from '../../contextLength';

describe('contextLength', () => {

    describe('minimumMachineContextLength', () => {
        it('is 64K (65536)', () => {
            assert.equal(minimumMachineContextLength, 65536);
        });
    });

    describe('machineContextLength', () => {
        it('finds context_length by model name', () => {
            const models = [
                { name: 'llama3:8b', context_length: 131072 },
                { name: 'nomic-embed-text', context_length: 8192 },
            ];
            assert.equal(machineContextLength(models, 'llama3:8b'), 131072);
        });

        it('finds context_length by model field', () => {
            const models = [
                { model: 'mistral:7b', context_length: 32768 },
            ];
            assert.equal(machineContextLength(models, 'mistral:7b'), 32768);
        });

        it('strips :latest tag when matching', () => {
            const models = [
                { name: 'llama3:latest', context_length: 131072 },
            ];
            assert.equal(machineContextLength(models, 'llama3'), 131072);
        });

        it('is case-insensitive', () => {
            const models = [
                { name: 'LLaMA3:8B', context_length: 131072 },
            ];
            assert.equal(machineContextLength(models, 'llama3:8b'), 131072);
        });

        it('returns undefined for unknown model', () => {
            const models = [
                { name: 'llama3:8b', context_length: 131072 },
            ];
            assert.equal(machineContextLength(models, 'gpt4'), undefined);
        });

        it('returns undefined for empty models array', () => {
            assert.equal(machineContextLength([], 'llama3'), undefined);
        });

        it('skips entries with non-integer context_length', () => {
            const models = [
                { name: 'llama3', context_length: 'not-a-number' },
            ];
            assert.equal(machineContextLength(models, 'llama3'), undefined);
        });

        it('skips entries with zero context_length', () => {
            const models = [
                { name: 'llama3', context_length: 0 },
            ];
            assert.equal(machineContextLength(models, 'llama3'), undefined);
        });

        it('skips entries with negative context_length', () => {
            const models = [
                { name: 'llama3', context_length: -1 },
            ];
            assert.equal(machineContextLength(models, 'llama3'), undefined);
        });

        it('skips non-object entries', () => {
            const models = [
                'not-an-object',
                null,
                42,
                { name: 'llama3', context_length: 131072 },
            ];
            assert.equal(machineContextLength(models, 'llama3'), 131072);
        });

        it('skips array entries', () => {
            const models = [
                ['not', 'an', 'object'],
                { name: 'llama3', context_length: 131072 },
            ];
            assert.equal(machineContextLength(models, 'llama3'), 131072);
        });

        it('matches first entry when multiple models have same name', () => {
            const models = [
                { name: 'llama3', context_length: 32768 },
                { name: 'llama3', context_length: 131072 },
            ];
            assert.equal(machineContextLength(models, 'llama3'), 32768);
        });
    });

    describe('isMachineContextTooSmall', () => {
        it('returns true for 32K', () => {
            assert.ok(isMachineContextTooSmall(32768));
        });

        it('returns true for 8K', () => {
            assert.ok(isMachineContextTooSmall(8192));
        });

        it('returns false for 64K (exact minimum)', () => {
            assert.ok(!isMachineContextTooSmall(65536));
        });

        it('returns false for 128K', () => {
            assert.ok(!isMachineContextTooSmall(131072));
        });

        it('returns false for 256K', () => {
            assert.ok(!isMachineContextTooSmall(262144));
        });

        it('returns true for 1 token', () => {
            assert.ok(isMachineContextTooSmall(1));
        });

        it('returns true for 0', () => {
            assert.ok(isMachineContextTooSmall(0));
        });
    });

    describe('formatContextLength', () => {
        it('formats 65536 as 64K', () => {
            assert.equal(formatContextLength(65536), '64K');
        });

        it('formats 131072 as 128K', () => {
            assert.equal(formatContextLength(131072), '128K');
        });

        it('formats 8192 as 8K', () => {
            assert.equal(formatContextLength(8192), '8K');
        });

        it('formats 32768 as 32K', () => {
            assert.equal(formatContextLength(32768), '32K');
        });

        it('formats non-K values with locale string', () => {
            assert.equal(formatContextLength(1000), '1,000');
        });

        it('formats 1024 as 1K', () => {
            assert.equal(formatContextLength(1024), '1K');
        });

        it('formats 0 as 0K', () => {
            assert.equal(formatContextLength(0), '0K');
        });

        it('formats 1000000 as 1,000,000', () => {
            assert.equal(formatContextLength(1000000), '1,000,000');
        });
    });
});
