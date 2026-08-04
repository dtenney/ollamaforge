import * as vscode from 'vscode';
import { OllamaMessage } from './ollamaClient';
import { logInfo, logError, toErrorMessage } from './logger';

// ── Resume state ──────────────────────────────────────────────────────────────

/**
 * Rich snapshot saved when the agent pauses mid-task (approval wait, network
 * drop, lid close). Injected back as context on resume so the agent doesn't
 * have to re-read files or re-derive decisions it already made.
 */
export interface PendingResume {
    /** Why we paused — "Waiting for approval: ..." or "Interrupted mid-task: ..." */
    reason: string;
    /** Files the agent confirmed as relevant before the pause. */
    filesRead: string[];
    /** Key decisions or conclusions the agent noted before pausing. */
    decisions: string[];
    /** Steps already completed. */
    stepsCompleted: string[];
    /** Steps still to do. */
    stepsPending: string[];
    /** Skill scripts that were active during this task (from save_skill / list_skills). */
    skillsUsed?: string[];
    /** ISO timestamp when the pause occurred. */
    pausedAt: string;
}

// ── Active task state ─────────────────────────────────────────────────────────

/**
 * Serialisable snapshot of the agent's in-progress task state.
 * Persisted in ChatSession so the agent can resume after a VSCode restart
 * without losing knowledge of which files it already confirmed or ruled out.
 */
export interface ActiveTaskState {
    message: string;
    type: 'add_field' | 'fix_bug' | 'add_route' | 'refactor' | 'query' | 'other';
    filesConfirmed: string[];
    filesRuledOut: string[];
    stepsCompleted: string[];
    stepsPending: string[];
    /**
     * The task_id slug the agent used when calling task_log. Set on first task_log
     * call so readTaskLogDecisions can find the exact log file rather than guessing
     * from mtime. Optional for backward-compat with pre-existing sessions.
     */
    taskId?: string;
}

// ── Types ─────────────────────────────────────────────────────────────────────

/** A single renderable message stored per session. */
export interface StoredMessage {
    role: 'user' | 'assistant' | 'error' | 'tool_call';
    content: string;
    timestamp: number;
}

/** One saved chat session. */
export interface ChatSession {
    id: string;
    /** Auto-derived from the first user message. */
    title: string;
    /** Model used in this session. */
    model: string;
    createdAt: number;
    updatedAt: number;
    /** Visual messages — what gets rendered in the chat UI. */
    messages: StoredMessage[];
    /**
     * Full agent conversation history (no system message).
     * Restored when the user re-opens a session so the model has prior context.
     */
    agentHistory: OllamaMessage[];
    /**
     * Snapshot of the agent's active task state machine.
     * Restored on session load so filesConfirmed/filesRuledOut survive a restart.
     * Optional for backward-compat with sessions saved before this field existed.
     */
    activeTask?: ActiveTaskState | null;
    /** IDs of pinned messages (persisted across reloads). */
    pinnedMsgIds?: string[];
    /**
     * Rich resume state saved when a session is interrupted mid-task.
     * Set by the provider on confirmAction pause or network error.
     * Cleared on clean completion or when the user sends a non-resume message.
     * Shown as a "▶ Resume" banner with scratchpad context when restored.
     */
    pendingContinuation?: PendingResume | null;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'ollamaForge.sessions.v2';
/** Legacy key prefix used in globalState (pre-v2 migration). */
const LEGACY_KEY_PREFIX = 'ollamaForge.sessions.v1';
const MAX_SESSIONS = 50;

// ── Storage service ───────────────────────────────────────────────────────────

export class ChatStorage {
    /** In-memory cache of sessions to avoid re-reading workspaceState on every call. */
    private _cache: ChatSession[] | null = null;

    constructor(private readonly context: vscode.ExtensionContext) {
        this.migrateFromGlobalState();
    }

    /**
     * One-time migration: copy sessions from the legacy globalState key
     * (workspace-name-prefixed) into workspaceState, then delete the old key.
     */
    private migrateFromGlobalState(): void {
        // Already have data in workspaceState — nothing to migrate
        const existing = this.context.workspaceState.get<ChatSession[]>(STORAGE_KEY);
        if (existing && existing.length > 0) { return; }

        const workspaceName = vscode.workspace.name || vscode.workspace.workspaceFolders?.[0]?.name || 'default';
        const legacyKey = `${LEGACY_KEY_PREFIX}.${workspaceName}`;
        const legacy = this.context.globalState.get<ChatSession[]>(legacyKey);
        if (!legacy || legacy.length === 0) { return; }

        this.context.workspaceState.update(STORAGE_KEY, legacy);
        this.context.globalState.update(legacyKey, undefined);
        logInfo(`[storage] Migrated ${legacy.length} sessions from globalState to workspaceState`);
    }

    /** All sessions for current workspace, newest-first (maintained by upsert). */
    list(): ChatSession[] {
        if (!this._cache) {
            this._cache = this.context.workspaceState.get<ChatSession[]>(STORAGE_KEY) ?? [];
            // Sort once on initial load; upsert() maintains order after that
            this._cache.sort((a, b) => b.updatedAt - a.updatedAt);
        }
        return [...this._cache];
    }

    /** Retrieve one session by ID. */
    get(id: string): ChatSession | undefined {
        return this.list().find((s) => s.id === id);
    }

    /** Create or update a session. Keeps only the most recent MAX_SESSIONS. */
    upsert(session: ChatSession): void {
        try {
            const rest = this.list().filter((s) => s.id !== session.id);
            const toSave = [{ ...session, updatedAt: Date.now() }, ...rest].slice(0, MAX_SESSIONS);
            this._cache = toSave;
            this.context.workspaceState.update(STORAGE_KEY, toSave);
            logInfo(`[storage] Saved "${session.title}" — ${session.messages.length} messages`);
        } catch (err) {
            logError(`[storage] Failed to save session: ${toErrorMessage(err)}`);
        }
    }

    /** Remove a single session. */
    delete(id: string): void {
        const rest = this.list().filter((s) => s.id !== id);
        this._cache = rest;
        this.context.workspaceState.update(STORAGE_KEY, rest);
        logInfo(`[storage] Deleted session ${id}`);
    }

    /** Wipe every saved session for current workspace. */
    clearAll(): void {
        this._cache = [];
        this.context.workspaceState.update(STORAGE_KEY, []);
        logInfo('[storage] All sessions cleared');
    }

    /** Build an empty session with defaults. */
    createNew(model: string): ChatSession {
        return {
            id:           `s_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            title:        'New Chat',
            model,
            createdAt:    Date.now(),
            updatedAt:    Date.now(),
            messages:     [],
            agentHistory: [],
            activeTask:   null,
        };
    }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

/**
 * Derive a human-readable title from the first user message.
 * Strips injected <active-file> / <selection> context blocks before truncating.
 */
export function deriveTitle(messages: StoredMessage[]): string {
    const first = messages.find((m) => m.role === 'user');
    if (!first) { return 'New Chat'; }
    const clean = first.content
        .replace(/<active-file[\s\S]*?<\/active-file>/g, '')
        .replace(/<selection[\s\S]*?<\/selection>/g, '')
        .replace(/<mention[\s\S]*?<\/mention>/g, '')
        .replace(/<git-diff[\s\S]*?<\/git-diff>/g, '')
        .trim()
        .replace(/\n+/g, ' ');
    if (!clean) { return 'New Chat'; }
    return clean.length > 50 ? clean.slice(0, 47) + '…' : clean;
}

/** Return a relative time string, e.g. "2 hours ago", "yesterday", "Mar 6". */
export function relativeTime(ts: number): string {
    const diff = Date.now() - ts;
    const mins  = Math.floor(diff / 60_000);
    const hours = Math.floor(diff / 3_600_000);
    const days  = Math.floor(diff / 86_400_000);
    if (mins < 1)   { return 'just now'; }
    if (mins < 60)  { return `${mins}m ago`; }
    if (hours < 24) { return `${hours}h ago`; }
    if (days === 1) { return 'yesterday'; }
    if (days < 7)   { return `${days}d ago`; }
    return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
