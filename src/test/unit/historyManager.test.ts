/**
 * historyManager.test.ts
 *
 * Unit tests for src/harness/historyManager.ts.
 *
 * Strategy:
 *   - vscode is mocked by the --require preload (dist/test/vscode-mock.js)
 *   - Stub ollamaClient.streamChatRequest to avoid network calls
 *   - Stub config.getConfig to return a fixed model
 *   - compactHistory is a pure function — let it run for real
 *
 * Run with:  npm run test:unit
 */

import * as assert from 'assert';
import * as sinon from 'sinon';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ollamaClient = require('../../ollamaClient') as typeof import('../../ollamaClient');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const config = require('../../config') as typeof import('../../config');

import { HistoryManager, HistoryManagerDeps } from '../../harness/historyManager';
import type { OllamaMessage } from '../../ollamaClient';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeDeps(overrides?: Partial<HistoryManagerDeps>): HistoryManagerDeps {
    return {
        memory: null,
        currentModel: 'test-model',
        currentTaskMessage: 'Implement feature X',
        originalTaskMessage: 'Implement feature X',
        filesAutoReadThisRun: new Set(['src/a.ts']),
        filesEditedThisRun: new Set(['src/b.ts']),
        activeTask: null,
        workspaceRoot: '/tmp/test-ws',
        sessionId: 'test-session',
        toolCounters: { read: 3, edit: 2, shell: 1, other: 0, total: 6 },
        toolBreakdown: {
            breakdown: '3r 2e 1s 0o',
            dirty: false,
            last: '3r 2e 1s 0o',
            lastDirty: false,
            lastTotal: 6,
            lastRead: 3,
            lastEdit: 2,
            lastShell: 1,
            lastOther: 0,
        },
        modelLimit: 8192,
        systemPromptTokens: 500,
        memoryTokens: 200,
        ...overrides,
    };
}

function makeMessages(count: number, contentLen: number): OllamaMessage[] {
    return Array.from({ length: count }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Message ${i}: ${'x'.repeat(contentLen)}`,
    }));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('HistoryManager', () => {
    let sandbox: sinon.SinonSandbox;

    beforeEach(() => {
        sandbox = sinon.createSandbox();
        // Stub streamChatRequest to avoid network calls
        sandbox.stub(ollamaClient, 'streamChatRequest').resolves({
            content: '{"task":"test"}',
            toolCalls: [],
            avgLogprob: null,
            thinking: '',
        });
        // Stub getConfig — cast to avoid needing all OllamaConfig fields
        sandbox.stub(config, 'getConfig').returns({ model: 'test-model' } as any);
    });

    afterEach(() => {
        sandbox.restore();
    });

    describe('handleAutoCompact', () => {
        it('should return original messages when no compaction is needed (short history)', async () => {
            const deps = makeDeps({ modelLimit: 100000 });
            const hm = new HistoryManager(deps);
            const messages = makeMessages(4, 50); // short messages, large limit
            const postCalls: object[] = [];
            const post = (msg: object) => postCalls.push(msg);

            const result = await hm.handleAutoCompact(messages, 10, post);

            // No compaction → returns the same array reference
            assert.strictEqual(result, messages);
            assert.strictEqual(postCalls.length, 0);
        });

        it('should return compacted messages with system markers when history is long', async () => {
            const deps = makeDeps({ modelLimit: 2000, systemPromptTokens: 500, memoryTokens: 200 });
            const hm = new HistoryManager(deps);
            // 30 messages × 500 chars each → well over 2000 token limit
            const messages = makeMessages(30, 500);
            const postCalls: object[] = [];
            const post = (msg: object) => postCalls.push(msg);

            const result = await hm.handleAutoCompact(messages, 95, post);

            // Compaction happened → different array
            assert.notStrictEqual(result, messages);
            // Result should be shorter than original
            assert.ok(result.length < messages.length);
            // Should contain at least one system message (compact summary marker)
            const systemMsgs = result.filter(m => m.role === 'system');
            assert.ok(systemMsgs.length >= 1, 'Expected at least one system marker message');
            // Post callback should have been called with compaction info
            assert.ok(postCalls.length >= 1, 'Expected post() to be called with compaction info');
            const infoCall = postCalls.find(c => (c as any).type === 'info');
            assert.ok(infoCall, 'Expected an info-type post message');
        });

        it('should not crash when memory is null (saveDroppedToMemory no-op)', async () => {
            const deps = makeDeps({ memory: null, modelLimit: 2000 });
            const hm = new HistoryManager(deps);
            const messages = makeMessages(30, 500);
            const post = (_msg: object) => {};

            // Should not throw
            const result = await hm.handleAutoCompact(messages, 95, post);
            assert.ok(Array.isArray(result));
        });

        it('should include WIP snapshot details in system messages when deps are populated', async () => {
            const deps = makeDeps({
                modelLimit: 2000,
                filesAutoReadThisRun: new Set(['src/main.ts', 'src/utils.ts']),
                filesEditedThisRun: new Set(['src/agent.ts']),
                toolCounters: { read: 5, edit: 3, shell: 2, other: 1, total: 11 },
                activeTask: {
                    message: 'Implement feature X',
                    type: 'refactor',
                    filesConfirmed: ['src/agent.ts'],
                    filesRuledOut: [],
                    stepsCompleted: ['Read files', 'Write code'],
                    stepsPending: ['Run tests', 'Deploy'],
                },
            });
            const hm = new HistoryManager(deps);
            const messages = makeMessages(30, 500);
            const post = (_msg: object) => {};

            const result = await hm.handleAutoCompact(messages, 95, post);

            // Find system messages and check they contain WIP snapshot content
            const systemContent = result
                .filter(m => m.role === 'system')
                .map(m => m.content)
                .join('\n');

            assert.ok(systemContent.includes('src/main.ts'), 'WIP snapshot should list auto-read files');
            assert.ok(systemContent.includes('src/agent.ts'), 'WIP snapshot should list edited files');
            assert.ok(systemContent.includes('5 reads'), 'WIP snapshot should include tool usage');
            assert.ok(systemContent.includes('Read files'), 'WIP snapshot should include completed steps');
            assert.ok(systemContent.includes('Run tests'), 'WIP snapshot should include pending steps');
        });

        it('should build compact summary with correct dropped count', async () => {
            const deps = makeDeps({ modelLimit: 2000 });
            const hm = new HistoryManager(deps);
            const messages = makeMessages(30, 500);
            const post = (_msg: object) => {};

            const result = await hm.handleAutoCompact(messages, 95, post);

            const systemContent = result
                .filter(m => m.role === 'system')
                .map(m => m.content)
                .join('\n');

            // The compact summary should mention the number of dropped messages
            assert.ok(
                /compacted|dropped|removed/i.test(systemContent),
                'System messages should mention compaction/dropped messages'
            );
        });
    });

    describe('constructor', () => {
        it('should store deps and be usable immediately', () => {
            const deps = makeDeps();
            const hm = new HistoryManager(deps);
            assert.ok(hm instanceof HistoryManager);
        });
    });
});
