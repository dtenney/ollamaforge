/**
 * contextAssembler.test.ts
 *
 * Unit tests for src/harness/contextAssembler.ts.
 *
 * Strategy:
 *   - vscode is mocked by the --require preload (dist/test/vscode-mock.js)
 *   - Stub all external deps (getConfig, buildSystemPromptAsync, classifyIntent,
 *     snapshotContextFileMtimes, calculateContextStats) to isolate assembly logic
 *   - Assert on the shape and content of the returned message array
 *
 * Run with:  npm run test:unit
 */

import * as assert from 'assert';
import * as sinon from 'sinon';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const config = require('../../config') as typeof import('../../config');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const promptBuilder = require('../../agentPromptBuilder') as typeof import('../../agentPromptBuilder');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const intentClassifier = require('../../core/promptIntentClassifier') as typeof import('../../core/promptIntentClassifier');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const contextCalc = require('../../contextCalculator') as typeof import('../../contextCalculator');

import { assembleContext } from '../../harness/contextAssembler';
import type { TurnContext } from '../../harness/types';
import type { OllamaMessage } from '../../ollamaClient';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTurnContext(overrides?: Partial<TurnContext>): TurnContext {
    return {
        workspaceRoot: '/tmp/test-ws',
        lastUserMessage: 'Fix the bug in main.ts',
        stopRef: { stop: false },
        postFn: (_msg: unknown) => {},
        limits: {
            maxConsecutiveFailures: 5,
            maxHistoryPoisonReverts: 3,
            maxSameCommandFailures: 3,
            maxSameEditFailures: 3,
            maxFileEditFailures: 5,
            maxEditSignatureCache: 50,
            maxEditStringCache: 50,
            maxValidatedFiles: 20,
            maxFilesReadSession: 50,
            maxConsecutiveRepeats: 3,
            maxUnparsedToolTurns: 3,
            recentToolSigWindow: 5,
            recentToolSigMaxRepeats: 3,
            idleTurnNudge: 5,
            idleTurnMax: 10,
            maxConsecutiveSameToolAction: 3,
            maxConsecutiveSameToolDefault: 5,
            maxModeSwitchRetries: 2,
            maxHistoryMessages: 100,
            memoryNudgeInterval: 10,
            maxAutoRetries: 3,
            maxConsecutiveAborts: 2,
            maxUndoStack: 20,
        },
        effectiveMaxRetries: 3,
        history: [
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi there' },
        ],
        loop: {
            consecutiveFailures: 0,
            lastToolSignature: '',
            consecutiveRepeats: 0,
            lastToolName: '',
            consecutiveSameToolCalls: 0,
            modeSwitchRetries: 0,
            userTurnCount: 1,
            autoRetryCount: 0,
            lastContextLevel: 'safe',
            currentModel: 'test-model',
            detectedFakeToolCalls: false,
            toolMode: 'native',
            trustLevel: 'trust',
            memoryWritesThisResponse: 0,
            totalEditsThisSession: 0,
            toolCallsThisRun: [],
            editsThisRun: 0,
            filesChangedThisRun: [],
            writtenPathsThisSession: new Set(),
            filesReadThisSession: new Set(),
            pathReadCountsThisRun: new Map(),
            failedCommandSignatures: new Set(),
            recentToolSigs: [],
            textOnlyFingerprints: [],
            responseFingerprints: [],
            idleTurns: 0,
            idleNudgeFired: false,
            consecutiveAborts: 0,
            consecutiveNoWriteRuns: 0,
            readOnlyTurnsSinceLastEdit: 0,
            unparsedToolTurns: 0,
            repeatToolCount: 0,
            perFileEditCounts: new Map(),
            failedEditByFile: new Map(),
            lastEditedFilePath: '',
            lastEditedSnippet: '',
            lastAttemptedEditPath: '',
            editFileHardBlocked: false,
            editFileLineBlocked: false,
            mergeConsecutiveEditFailures: false,
            mergeEditedSinceLastDelete: false,
            mergeFileReadCounts: new Map(),
            activeTask: '',
            currentTaskMessage: 'Fix the bug in main.ts',
            originalTaskMessage: 'Fix the bug in main.ts',
            taskPhase: 'implement',
            isEditTask: false,
            isSweepTask: false,
            isSmallModel: false,
            planFirstMode: false,
            planConfirmed: false,
            activePlanFile: '',
            pendingPlanSteps: [],
            lastPlanStepOutput: '',
            totalTaskItems: 0,
            currentTaskItemIndex: 0,
            pendingTaskItems: [],
            guardEvents: [],
            buildGateFired: false,
            deployNudgeFiredThisRun: false,
            codeReviewFiredThisRun: false,
            autoVerifyFiredThisRun: false,
            velocityNudgeFiredThisRun: false,
            projectNudgeLastTurn: 0,
            preflightWriteGateFired: false,
            focusedGrepInjectedThisTurn: false,
            earlyCompactionStalls: 0,
            wrapUpSuggested: false,
            completionSignaled: false,
            legitimateStopFired: false,
            forceStopAfterBatch: false,
            confirmedSshHosts: new Set(),
            sshInlineGuardFired: false,
            sleepPollSignatures: new Set(),
            pythonOnelinerFailCount: 0,
            enumerationCallCount: 0,
            consecutiveEmptyPathReads: 0,
            lastReadFilePath: '',
            lastWrittenFilePath: '',
            lastWebFetchTurn: 0,
            webFetchImperative: false,
            lastResponseAvgLogprob: 0,
            lastSystemContent: '',
            lastMemoryContext: '',
            lastContextPct: 100,
            lastModel: 'test-model',
            currentRunModel: 'test-model',
            routedCriticModel: '',
            contextFileMtimes: new Map(),
            contextDriftWarned: false,
            compactionRatios: [],
            runTurnCount: 0,
            runStartHistoryLen: 2,
            runOutcome: '',
            wasReviewTask: false,
            filesAutoReadThisRun: [],
            lastBatchWasReadOnly: false,
            preDraftRecoveryAttempts: 0,
            nativeRecoverySuppressCount: 0,
            gatherStallCycles: 0,
            emptyMemoryWriteCount: 0,
            correctedStaleIds: [],
            recentSearchResultIds: new Set(),
            autoApprovedTools: new Set(),
            allowedTools: new Set(),
            mcpConfirmedTools: new Set(),
            isCommandApproved: false,
            isToolApproved: false,
            schemaChangeConfirmed: false,
            confirmTimedOut: false,
            externalStop: false,
            preExecBuf: '',
            preExecCache: new Map(),
            editContextInjected: false,
            lastToolDigest: '',
            lastEditNewStringByFile: new Map(),
            lastEditOldStringByFile: new Map(),
            validatedSourceFiles: new Set(),
            stagedEdits: new Map(),
            stagedEditSeq: 0,
            activeProjectFile: '',
            pendingUserNote: '',
            reasoningTrace: '',
            continuationState: null,
            fileOpStack: [],
            lastFileOp: null,
            asyncHandles: new Map(),
            asyncHandleCounter: 0,
        },
        services: {
            memory: null,
            codeIndex: null,
            codeGraph: null,
            diffViewManager: {} as any,
            refactorManager: {} as any,
            activeSkill: undefined,
            peerTabContext: '',
        },
        requestConfirmation: async () => true,
        askUser: async () => 'ok',
        resolveConfirmationAll: () => {},
        dispatchTool: async () => '',
        callModel: async () => ({ content: '', toolCalls: [], avgLogprob: null, thinking: '' }),
        ...overrides,
    };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('contextAssembler.assembleContext', () => {
    let sandbox: sinon.SinonSandbox;
    let stubGetConfig: sinon.SinonStub;
    let stubClassifyIntent: sinon.SinonStub;
    let stubCalcStats: sinon.SinonStub;

    beforeEach(() => {
        sandbox = sinon.createSandbox();
        // Stub config
        stubGetConfig = sandbox.stub(config, 'getConfig').returns({
            systemPrompt: 'You are a test assistant.',
            autoSaveMemory: false,
            model: 'test-model',
        } as any);
        // Stub prompt builder
        sandbox.stub(promptBuilder, 'buildSystemPromptAsync').resolves('BASE_SYSTEM_PROMPT');
        sandbox.stub(promptBuilder, 'buildSmallModelSystemPrompt').returns('SLIM_PROMPT');
        sandbox.stub(promptBuilder, 'buildToolBiasNote').returns('Use read-only tools.');
        sandbox.stub(promptBuilder, 'snapshotContextFileMtimes').returns(new Map());
        // Stub intent classifier — return 'general' to skip intent addendum
        stubClassifyIntent = sandbox.stub(intentClassifier, 'classifyIntent').returns({
            intent: 'general',
            confidence: 0.9,
            contextPriorities: [],
            contextSkips: [],
        });
        // Stub context stats — return healthy usage so no budget message
        stubCalcStats = sandbox.stub(contextCalc, 'calculateContextStats').returns({
            usagePercentage: 0.5,
            systemPromptTokens: 100,
            historyTokens: 200,
            memoryTokens: 50,
            totalTokens: 350,
            modelLimit: 8192,
            level: 'safe',
            messagesCount: 2,
        });
    });

    afterEach(() => {
        sandbox.restore();
    });

    it('should return a message array starting with a system message', async () => {
        const ctx = makeTurnContext();
        const result = await assembleContext(ctx);

        assert.ok(Array.isArray(result.messages));
        assert.ok(result.messages.length >= 2, 'Should have system + at least one history message');
        assert.strictEqual(result.messages[0].role, 'system');
        assert.ok(result.messages[0].content.includes('test assistant'), 'System prompt should contain the configured text');
    });

    it('should include the history messages after the system message', async () => {
        const ctx = makeTurnContext();
        const result = await assembleContext(ctx);

        // messages[1] and messages[2] should be the history
        assert.strictEqual(result.messages[1].role, 'user');
        assert.strictEqual(result.messages[1].content, 'Hello');
        assert.strictEqual(result.messages[2].role, 'assistant');
        assert.strictEqual(result.messages[2].content, 'Hi there');
    });

    it('should return systemContent matching the system message content', async () => {
        const ctx = makeTurnContext();
        const result = await assembleContext(ctx);

        assert.strictEqual(result.systemContent, result.messages[0].content);
    });

    it('should return an empty memoryContext when memory is null', async () => {
        const ctx = makeTurnContext({
            services: {
                memory: null,
                codeIndex: null,
                codeGraph: null,
                diffViewManager: {} as any,
                refactorManager: {} as any,
                activeSkill: undefined,
                peerTabContext: '',
            },
        });
        const result = await assembleContext(ctx);

        assert.strictEqual(result.memoryContext, '');
    });

    it('should return an empty contextFileMtimes map when workspaceRoot is empty', async () => {
        const ctx = makeTurnContext({ workspaceRoot: '' });
        const result = await assembleContext(ctx);

        assert.ok(result.contextFileMtimes instanceof Map);
        assert.strictEqual(result.contextFileMtimes.size, 0);
    });

    it('should add a context budget message when remaining < 25%', async () => {
        // Override calculateContextStats to return high usage
        stubCalcStats.returns({
            usagePercentage: 0.85, // 15% remaining
            systemPromptTokens: 5000,
            historyTokens: 2000,
            memoryTokens: 100,
            totalTokens: 7100,
            modelLimit: 8192,
            level: 'critical',
            messagesCount: 2,
        });

        const ctx = makeTurnContext();
        const result = await assembleContext(ctx);

        // Last message should be the context budget nudge
        const lastMsg = result.messages[result.messages.length - 1];
        assert.strictEqual(lastMsg.role, 'user');
        assert.ok(lastMsg.content.includes('context'), 'Should mention context budget');
        assert.ok(lastMsg.content.includes('15%'), 'Should show remaining percentage');
    });

    it('should NOT add a context budget message when remaining >= 25%', async () => {
        // Default stub returns 50% usage → 50% remaining → no budget msg
        const ctx = makeTurnContext();
        const result = await assembleContext(ctx);

        const lastMsg = result.messages[result.messages.length - 1];
        // Should be a history message, not a budget nudge
        assert.ok(!lastMsg.content.includes('% remaining'), 'Should not have budget message at 50% remaining');
    });

    it('should use slim prompt when earlyCompactionStalls >= 1', async () => {
        // Empty systemPrompt so the || falls through to buildSmallModelSystemPrompt
        stubGetConfig.returns({
            systemPrompt: '',
            autoSaveMemory: false,
            model: 'test-model',
        } as any);

        const ctx = makeTurnContext();
        ctx.loop.earlyCompactionStalls = 1;

        const result = await assembleContext(ctx);

        assert.ok(result.messages[0].content.includes('SLIM_PROMPT'), 'Should use slim prompt after compaction stall');
    });

    it('should add intent context strategy for non-general intents', async () => {
        stubClassifyIntent.returns({
            intent: 'debug',
            confidence: 0.85,
            contextPriorities: ['git_diff', 'error_logs'],
            contextSkips: ['memory_search'],
        });

        const ctx = makeTurnContext();
        const result = await assembleContext(ctx);

        assert.ok(result.messages[0].content.includes('CONTEXT STRATEGY'), 'Should include intent strategy block');
        assert.ok(result.messages[0].content.includes('debug'), 'Should mention the intent');
        assert.ok(result.messages[0].content.includes('git_diff'), 'Should list prioritized sources');
    });

    it('should add security audit mode for security-related messages', async () => {
        const ctx = makeTurnContext({
            lastUserMessage: 'Please do a security scan of the codebase',
        });
        const result = await assembleContext(ctx);

        assert.ok(result.messages[0].content.includes('SECURITY AUDIT MODE'), 'Should activate security audit mode');
    });

    it('should NOT add security audit mode for non-security messages', async () => {
        const ctx = makeTurnContext({
            lastUserMessage: 'Fix the bug in main.ts',
        });
        const result = await assembleContext(ctx);

        assert.ok(!result.messages[0].content.includes('SECURITY AUDIT MODE'), 'Should not activate security mode');
    });
});
