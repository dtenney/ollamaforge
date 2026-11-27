/**
 * harness/types.ts — Core interfaces for the Agent harness decomposition.
 *
 * These types define the contracts between the harness modules:
 *   - TurnContext: the bag of state the turn loop needs (Phase 2)
 *   - ToolDispatchContext: what executeTool needs (Phase 3)
 *   - ToolDispatcher: the interface the turn loop calls to dispatch tools (Phase 3)
 *   - ModelClient: swappable inference backend (Phase 6)
 *   - ContextStrategy: swappable relevance scoring (Phase 6)
 *
 * No logic lives here — just types.
 */

import type { OllamaMessage, OllamaToolCall, StreamResult } from '../ollamaClient';
import type { ContextLevel } from '../contextCalculator';
import type { PostFn } from '../memoryNudge';
import type { ToolCallRecord } from '../sessionLog';
import type { TieredMemoryManager } from '../memoryCore';
import type { CodeIndexer } from '../codeIndex';
import type { DiffViewManager } from '../diffView';
import type { MultiFileRefactoringManager } from '../multiFileRefactor';
import type { SkillManifest } from '../skillLibrary';

// ── Config / Limits ──────────────────────────────────────────────────────────

/** Immutable configuration limits extracted from Agent private fields. */
export interface AgentLimits {
    maxConsecutiveFailures: number;
    maxHistoryPoisonReverts: number;
    maxSameCommandFailures: number;
    maxSameEditFailures: number;
    maxFileEditFailures: number;
    maxEditSignatureCache: number;
    maxEditStringCache: number;
    maxValidatedFiles: number;
    maxFilesReadSession: number;
    maxConsecutiveRepeats: number;
    maxUnparsedToolTurns: number;
    recentToolSigWindow: number;
    recentToolSigMaxRepeats: number;
    idleTurnNudge: number;
    idleTurnMax: number;
    maxConsecutiveSameToolAction: number;
    maxConsecutiveSameToolDefault: number;
    maxModeSwitchRetries: number;
    maxHistoryMessages: number;
    memoryNudgeInterval: number;
    maxAutoRetries: number;
    maxConsecutiveAborts: number;
    maxUndoStack: number;
}

// ── Loop State (mutable per-run) ─────────────────────────────────────────────

/** Mutable loop state that changes every turn. */
export interface LoopState {
    consecutiveFailures: number;
    lastToolSignature: string;
    consecutiveRepeats: number;
    lastToolName: string;
    consecutiveSameToolCalls: number;
    modeSwitchRetries: number;
    userTurnCount: number;
    autoRetryCount: number;
    lastContextLevel: ContextLevel;
    currentModel: string;
    detectedFakeToolCalls: boolean;
    toolMode: 'native' | 'text';
    trustLevel: 'normal' | 'trust' | 'yolo';
    memoryWritesThisResponse: number;
    totalEditsThisSession: number;
    // Per-run counters
    toolCallsThisRun: ToolCallRecord[];
    editsThisRun: number;
    filesChangedThisRun: string[];
    writtenPathsThisSession: Set<string>;
    filesReadThisSession: Set<string>;
    pathReadCountsThisRun: Map<string, number>;
    failedCommandSignatures: Set<string>;
    recentToolSigs: string[];
    textOnlyFingerprints: string[];
    responseFingerprints: string[];
    // Stall / idle tracking
    idleTurns: number;
    idleNudgeFired: boolean;
    consecutiveAborts: number;
    consecutiveNoWriteRuns: number;
    readOnlyTurnsSinceLastEdit: number;
    unparsedToolTurns: number;
    repeatToolCount: number;
    // Edit tracking
    perFileEditCounts: Map<string, number>;
    failedEditByFile: Map<string, number>;
    lastEditedFilePath: string;
    lastEditedSnippet: string;
    lastAttemptedEditPath: string;
    editFileHardBlocked: boolean;
    editFileLineBlocked: boolean;
    mergeConsecutiveEditFailures: boolean;
    mergeEditedSinceLastDelete: boolean;
    mergeFileReadCounts: Map<string, number>;
    // Plan / task tracking
    activeTask: string;
    currentTaskMessage: string;
    originalTaskMessage: string;
    taskPhase: string;
    isEditTask: boolean;
    isSweepTask: boolean;
    isSmallModel: boolean;
    planFirstMode: boolean;
    planConfirmed: boolean;
    activePlanFile: string;
    pendingPlanSteps: string[];
    lastPlanStepOutput: string;
    totalTaskItems: number;
    currentTaskItemIndex: number;
    pendingTaskItems: string[];
    // Guard / nudge flags
    guardEvents: string[];
    buildGateFired: boolean;
    deployNudgeFiredThisRun: boolean;
    codeReviewFiredThisRun: boolean;
    autoVerifyFiredThisRun: boolean;
    velocityNudgeFiredThisRun: boolean;
    projectNudgeLastTurn: number;
    preflightWriteGateFired: boolean;
    focusedGrepInjectedThisTurn: boolean;
    earlyCompactionStalls: number;
    wrapUpSuggested: boolean;
    completionSignaled: boolean;
    legitimateStopFired: boolean;
    forceStopAfterBatch: boolean;
    // SSH / command tracking
    confirmedSshHosts: Set<string>;
    sshInlineGuardFired: boolean;
    sleepPollSignatures: Set<string>;
    pythonOnelinerFailCount: number;
    enumerationCallCount: number;
    consecutiveEmptyPathReads: number;
    // Misc
    lastReadFilePath: string;
    lastWrittenFilePath: string;
    lastWebFetchTurn: number;
    webFetchImperative: boolean;
    lastResponseAvgLogprob: number;
    lastSystemContent: string;
    lastMemoryContext: string;
    lastContextPct: number;
    lastModel: string;
    currentRunModel: string;
    routedCriticModel: string;
    contextFileMtimes: Map<string, number>;
    contextDriftWarned: boolean;
    compactionRatios: number[];
    runTurnCount: number;
    runStartHistoryLen: number;
    runOutcome: string;
    wasReviewTask: boolean;
    filesAutoReadThisRun: string[];
    lastBatchWasReadOnly: boolean;
    preDraftRecoveryAttempts: number;
    nativeRecoverySuppressCount: number;
    gatherStallCycles: number;
    emptyMemoryWriteCount: number;
    correctedStaleIds: string[];
    recentSearchResultIds: Set<string>;
    autoApprovedTools: Set<string>;
    allowedTools: Set<string>;
    mcpConfirmedTools: Set<string>;
    isCommandApproved: boolean;
    isToolApproved: boolean;
    schemaChangeConfirmed: boolean;
    confirmTimedOut: boolean;
    externalStop: boolean;
    preExecBuf: string;
    preExecCache: Map<string, string>;
    editContextInjected: boolean;
    lastToolDigest: string;
    lastEditNewStringByFile: Map<string, string>;
    lastEditOldStringByFile: Map<string, string>;
    validatedSourceFiles: Set<string>;
    stagedEdits: Map<string, string>;
    stagedEditSeq: number;
    activeProjectFile: string;
    pendingUserNote: string;
    reasoningTrace: string;
    continuationState: unknown;
    // File op tracking
    fileOpStack: unknown[];
    lastFileOp: unknown;
    asyncHandles: Map<string, unknown>;
    asyncHandleCounter: number;
}

// ── Service Dependencies ─────────────────────────────────────────────────────

/** External service references the agent needs. */
export interface ServiceDeps {
    memory: TieredMemoryManager | null;
    codeIndex: CodeIndexer | null;
    codeGraph: unknown; // CodeGraph — avoid circular import
    diffViewManager: DiffViewManager;
    refactorManager: MultiFileRefactoringManager;
    activeSkill: SkillManifest | undefined;
    peerTabContext: string;
}

// ── TurnContext (Phase 2) ────────────────────────────────────────────────────

/**
 * The complete bag of state the turn loop needs.
 * Replaces the 135 external locals + 1,181 `this.` refs in Agent.run().
 */
export interface TurnContext {
    // Identity
    workspaceRoot: string;
    lastUserMessage: string;
    stopRef: { stop: boolean; destroy?: () => void };
    postFn: PostFn;
    /** Session recon string (Python/git/node versions). Built once per Agent instance. */
    sessionRecon?: string;

    // Config
    limits: AgentLimits;
    effectiveMaxRetries: number;

    // State
    history: OllamaMessage[];
    loop: LoopState;
    services: ServiceDeps;

    // Callbacks (UI / confirmation)
    requestConfirmation: (action: string, detail: string, toolName?: string) => Promise<boolean>;
    askUser: (question: string, options: string[], allowFreeText: boolean) => Promise<string>;
    resolveConfirmationAll: (toolName: string) => void;

    // Tool dispatch (injected by Phase 3)
    dispatchTool: (toolName: string, args: Record<string, unknown>) => Promise<string>;

    // Model call (injected by Phase 6)
    callModel: (messages: OllamaMessage[], model: string, onToken: (t: string) => void) => Promise<StreamResult>;
}

// ── ToolDispatchContext (Phase 3) ────────────────────────────────────────────

/**
 * What executeTool() needs. Replaces the 90+ `this.` refs in the 4,200-line method.
 */
export interface ToolDispatchContext {
    workspaceRoot: string;
    postFn: PostFn;
    memory: TieredMemoryManager | null;
    codeIndex: CodeIndexer | null;
    codeGraph: unknown;
    diffViewManager: DiffViewManager;
    refactorManager: MultiFileRefactoringManager;
    activeSkill: SkillManifest | undefined;
    trustLevel: 'normal' | 'trust' | 'yolo';
    toolMode: 'native' | 'text';
    currentRunModel: string;
    routedCriticModel: string;
    isSmallModel: boolean;
    taskPhase: string;
    activeTask: string;
    currentTaskMessage: string;
    activePlanFile: string;
    planConfirmed: boolean;
    isEditTask: boolean;
    isSweepTask: boolean;
    // Loop state (subset relevant to tool dispatch)
    loop: LoopState;
    // Callbacks
    requestConfirmation: (action: string, detail: string, toolName?: string) => Promise<boolean>;
    askUser: (question: string, options: string[], allowFreeText: boolean) => Promise<string>;
    // Sub-agent
    runSubagent: (task: string, model: string) => Promise<string>;
    // Shell
    runCommandStreaming: (cmd: string, cwd: string, cmdId: string) => Promise<string>;
    runShellRead: (cmd: string) => Promise<string>;
    // Path policy
    resolvePathWithPolicy: (rawPath: string, toolName: string) => Promise<{ path: string } | { blocked: string }>;
    // Diagnostics
    getDiagnostics: (filePath: string) => Promise<string>;
    // File ops
    safePath: (rawPath: string) => string;
    // Plan file
    writePlanFile: (content: string) => void;
    updatePlanFile: (content: string) => void;
    closePlanFile: () => void;
    // Misc
    memoryWritesThisResponse: number;
    totalEditsThisSession: number;
    editsThisRun: number;
    filesChangedThisRun: string[];
    writtenPathsThisSession: Set<string>;
    filesReadThisSession: Set<string>;
    failedCommandSignatures: Set<string>;
    perFileEditCounts: Map<string, number>;
    failedEditByFile: Map<string, number>;
    lastEditedFilePath: string;
    lastReadFilePath: string;
    lastWrittenFilePath: string;
    lastWebFetchTurn: number;
    webFetchImperative: boolean;
    validatedSourceFiles: Set<string>;
    stagedEdits: Map<string, string>;
    stagedEditSeq: number;
    fileOpStack: unknown[];
    lastFileOp: unknown;
    asyncHandles: Map<string, unknown>;
    asyncHandleCounter: number;
    allowedTools: Set<string>;
    mcpConfirmedTools: Set<string>;
    isCommandApproved: boolean;
    isToolApproved: boolean;
    schemaChangeConfirmed: boolean;
    confirmTimedOut: boolean;
    externalStop: boolean;
    preExecBuf: string;
    preExecCache: Map<string, string>;
    editContextInjected: boolean;
    lastToolDigest: string;
    lastEditNewStringByFile: Map<string, string>;
    lastEditOldStringByFile: Map<string, string>;
    recentSearchResultIds: Set<string>;
    autoApprovedTools: Set<string>;
    consecutiveEmptyPathReads: number;
    readOnlyTurnsSinceLastEdit: number;
    runTurnCount: number;
    guardEvents: string[];
    buildGateFired: boolean;
    deployNudgeFiredThisRun: boolean;
    codeReviewFiredThisRun: boolean;
    autoVerifyFiredThisRun: boolean;
    velocityNudgeFiredThisRun: boolean;
    projectNudgeLastTurn: number;
    preflightWriteGateFired: boolean;
    focusedGrepInjectedThisTurn: boolean;
    earlyCompactionStalls: number;
    wrapUpSuggested: boolean;
    completionSignaled: boolean;
    legitimateStopFired: boolean;
    forceStopAfterBatch: boolean;
    confirmedSshHosts: Set<string>;
    sshInlineGuardFired: boolean;
    sleepPollSignatures: Set<string>;
    pythonOnelinerFailCount: number;
    enumerationCallCount: number;
    emptyMemoryWriteCount: number;
    correctedStaleIds: string[];
    lastResponseAvgLogprob: number;
    lastSystemContent: string;
    lastMemoryContext: string;
    lastContextPct: number;
    lastModel: string;
    contextFileMtimes: Map<string, number>;
    contextDriftWarned: boolean;
    compactionRatios: number[];
    runOutcome: string;
    wasReviewTask: boolean;
    filesAutoReadThisRun: string[];
    lastBatchWasReadOnly: boolean;
    preDraftRecoveryAttempts: number;
    nativeRecoverySuppressCount: number;
    gatherStallCycles: number;
    activeProjectFile: string;
    pendingUserNote: string;
    reasoningTrace: string;
    continuationState: unknown;
    mergeConsecutiveEditFailures: boolean;
    mergeEditedSinceLastDelete: boolean;
    mergeFileReadCounts: Map<string, number>;
    editFileHardBlocked: boolean;
    editFileLineBlocked: boolean;
    lastAttemptedEditPath: string;
    lastEditedSnippet: string;
    pathReadCountsThisRun: Map<string, number>;
    recentToolSigs: string[];
    textOnlyFingerprints: string[];
    responseFingerprints: string[];
    idleTurns: number;
    idleNudgeFired: boolean;
    consecutiveAborts: number;
    consecutiveNoWriteRuns: number;
    unparsedToolTurns: number;
    repeatToolCount: number;
    // History (for tool result injection)
    history: OllamaMessage[];
    // Stop
    stopRef: { stop: boolean; destroy?: () => void };
}

// ── ToolDispatcher (Phase 3) ─────────────────────────────────────────────────

/**
 * Interface for dispatching tool calls.
 * The turn loop calls this; the implementation routes to per-tool methods.
 */
export interface ToolDispatcher {
    dispatch(toolName: string, args: Record<string, unknown>, ctx: ToolDispatchContext): Promise<string>;
}

// ── ModelClient (Phase 6) ────────────────────────────────────────────────────

/**
 * Swappable inference backend.
 * Currently backed by ollamaClient, but the interface allows any local
 * inference provider (llama.cpp server, vLLM, etc.).
 */
export interface ModelClient {
    stream(
        messages: OllamaMessage[],
        model: string,
        onToken: (token: string) => void,
        options?: { temperature?: number; top_p?: number; num_predict?: number },
    ): Promise<StreamResult>;

    listModels(): Promise<string[]>;
}

// ── ContextStrategy (Phase 6) ────────────────────────────────────────────────

/**
 * Swappable relevance scoring strategy.
 * Currently: smartContext (import-aware) + codeIndex (vector + keyword).
 * Could be: codeGraph-only, memory-only, custom.
 */
export interface ContextStrategy {
    /** Score and rank files relevant to the user's message. */
    findRelevant(userMessage: string, workspaceRoot: string, maxFiles: number): Promise<Array<{ path: string; score: number; reason: string }>>;

    /** Build the system prompt context block. */
    buildContextBlock(relevantFiles: Array<{ path: string; score: number }>, userMessage: string): Promise<string>;
}

// ── TurnResult ───────────────────────────────────────────────────────────────

/** Result of a single turn execution. */
export interface TurnResult {
    /** Final assistant text (after all tool calls resolved). */
    finalText: string;
    /** Number of tool calls made this turn. */
    toolCallCount: number;
    /** Whether the turn was aborted (spiral, user stop, idle max). */
    aborted: boolean;
    /** Reason for abort (if aborted). */
    abortReason?: string;
    /** Whether the agent signaled task completion. */
    completed: boolean;
    /** Total tokens generated (approximate). */
    tokensGenerated: number;
}
