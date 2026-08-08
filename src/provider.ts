import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { Agent, PostFn } from './agent';
import { fetchModels, rawGet, streamChatRequest, generateChatTitle } from './ollamaClient';
import { getConfig } from './config';
import { getActiveContext, buildContextString } from './context';
import { logInfo, logWarn, logError, channel, toErrorMessage } from './logger';
import { ChatStorage, ChatSession, StoredMessage, deriveTitle, relativeTime, PendingResume } from './chatStorage';
import { appendSessionLog } from './sessionLog';
import { indexWorkspaceFiles, fuzzySearchFiles, buildMentionContext } from './mentions';
import { buildGitDiffContext } from './gitContext';
import { TieredMemoryManager } from './memoryCore';
import { CodeIndexer } from './codeIndex';
import { TemplateManager } from './promptTemplates';
import { SmartContextManager } from './smartContext';
import { SymbolProvider } from './symbolProvider';
import { DiffViewManager } from './diffView';
import { MultiWorkspaceManager } from './multiWorkspace';
import { runDreamCycle } from './dreamAgent';

/** Strip <tool>{...}</tool> blocks using brace-counting for nested JSON.
 *  Also strips <function_calls>/<invoke> Claude-format blocks and bare stray tags. */
/**
 * Strip chat UI artifacts that get pasted in when a user copies text from the
 * chat panel and pastes it back. These are visual labels and icons from the
 * webview rendering layer that confuse the model if sent as user input.
 */
function stripChatUiArtifacts(text: string): string {
    return text
        // Remove standalone role labels that appear as their own line
        .replace(/^(Agent|You)\s*$/gm, '')
        // Remove retry/pin/action button labels
        .replace(/↺\s*Retry\b/g, '')
        .replace(/📌/g, '')
        // Remove thought process header
        .replace(/💭\s*Thought process\s*/g, '')
        // Remove tool call display lines (emoji + tool name + args line)
        .replace(/^[✏️🔍⚡🌐🗂️🌍✓✗🧠📁💾]\s*\w[\w_]*\s*$/gm, '')
        // Remove relative timestamps like "22m ago", "2h ago", "yesterday"
        .replace(/\b\d+[mh]\s+ago\b/g, '')
        .replace(/\byesterday\b/gi, '')
        // Remove "Error HH:MM PM/AM" timestamp lines
        .replace(/^Error\s+\d+:\d+\s*(AM|PM)\s*$/gim, '')
        // Remove timeout error lines
        .replace(/^⏱\s*Request timed out.*$/gm, '')
        // Collapse multiple blank lines left by removals
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function stripToolBlocksFromText(text: string): string {
    let result = text;
    let pos = 0;
    while (pos < result.length) {
        const idx = result.toLowerCase().indexOf('<tool>', pos);
        if (idx === -1) break;
        let depth = 0, jsonEnd = -1;
        for (let i = idx + 6; i < result.length; i++) {
            if (result[i] === '{') depth++;
            else if (result[i] === '}') { depth--; if (depth === 0) { jsonEnd = i + 1; break; } }
        }
        if (jsonEnd === -1) { result = result.slice(0, idx); break; }
        let endPos = jsonEnd;
        const afterJson = result.slice(jsonEnd).match(/^\s*<\/tool>/i);
        if (afterJson) endPos = jsonEnd + afterJson[0].length;
        result = result.slice(0, idx) + result.slice(endPos);
        pos = idx;
    }
    result = result.replace(/<\/tool(?:_call)?>/gi, '');
    // Strip <tool_edit>{...}</tool>, <tool_read>{...}</tool_read>, <tooledit>{...}</tooledit>, etc.
    result = result.replace(/<tool[\w_]+>[\s\S]*?<\/tool[\w_]*>/gi, '');
    result = result.replace(/<tool[\w_]+>[\s\S]*/gi, ''); // unclosed
    // Strip Claude-format invoke blocks (with or without attributes like <invoke name="...">)
    result = result.replace(/<function_calls>[\s\S]*?<\/function_calls>/gi, '');
    result = result.replace(/<invoke(?:\s[^>]*)?>[\s\S]*?<\/invoke>/gi, '');
    result = result.replace(/<\/?function_calls>/gi, '');
    result = result.replace(/<invoke(?:\s[^>]*)?>/gi, '').replace(/<\/invoke>/gi, '');
    // Strip orphaned mixed-format tags (Qwen sometimes emits </parameter></function></tool_call>)
    result = result.replace(/<\/?(?:parameter|function)>/gi, '');
    return result;
}

// ── Message shapes (webview → extension) ─────────────────────────────────────

interface MsgGetModels     { command: 'getModels' }
interface MsgSendMessage   { command: 'sendMessage'; text: string; model: string; trustLevel?: 'normal' | 'trust' | 'yolo'; includeFile: boolean; includeSelection: boolean; mentionedFiles?: string[]; mentionedSymbols?: Array<{ name: string; filePath: string; }>; pinnedFiles?: string[]; }
interface MsgNewChat       { command: 'newChat' }
interface MsgStopGen       { command: 'stopGeneration' }
interface MsgRetryLast     { command: 'retryLast'; model: string }
interface MsgGetContext    { command: 'getContext' }
interface MsgListSessions  { command: 'listSessions' }
interface MsgLoadSession   { command: 'loadSession';   id: string }
interface MsgDeleteSession { command: 'deleteSession'; id: string }
interface MsgClearSessions { command: 'clearAllSessions' }
interface MsgSearchFiles   { command: 'searchFiles'; query: string }
interface MsgSetPreset     { command: 'setPreset'; preset: string; model?: string; temperature?: number }
interface MsgGetTemplates  { command: 'getTemplates' }
interface MsgToggleSmartContext { command: 'toggleSmartContext'; enabled: boolean }

type WebviewMsg =
    | MsgGetModels | MsgSendMessage  | MsgNewChat      | MsgStopGen
    | MsgRetryLast | MsgGetContext   | MsgListSessions  | MsgLoadSession
    | MsgDeleteSession | MsgClearSessions | MsgSearchFiles | MsgSetPreset
    | MsgGetTemplates | MsgToggleSmartContext
    | { command: 'searchSymbols'; query: string }
    | { command: 'updatePins'; pins: string[] }
    | { command: 'updatePinnedFiles'; files: string[] }
    | { command: 'openSettings' }
    | { command: 'openFile'; path: string }
    | { command: 'reviewProject' }
    | { command: 'compactContext' }
    | { command: 'undoLastTool' }
    | { command: 'confirmResponse'; id: string; accepted: boolean }
    | { command: 'confirmResponseAll'; id: string; toolName: string }
    | { command: 'applyCodeBlock'; code: string; lang: string }
    | { command: 'webviewError'; text: string }
    | { command: 'openTab' }
    | { command: 'closeTab'; tabId: string }
    | { command: 'switchTab'; tabId: string }
    | { command: 'submitFeedback'; label: string; msgText: string }
    | { command: 'submitPositiveFeedback'; msgText: string }
    | { command: 'setTrustLevel'; level: 'normal' | 'trust' | 'yolo' };

// ── Serialised session summary sent to the webview ───────────────────────────

interface SessionSummary {
    id: string;
    title: string;
    model: string;
    messageCount: number;
    updatedAt: number;
    relativeTime: string;
}

function toSummary(s: ChatSession): SessionSummary {
    return {
        id:           s.id,
        title:        s.title,
        model:        s.model,
        messageCount: s.messages.length,
        updatedAt:    s.updatedAt,
        relativeTime: relativeTime(s.updatedAt),
    };
}

/**
 * Parse the last N step entries from a task_log markdown file and return their
 * first lines as decision strings for PendingResume.decisions[].
 */
function parseTaskLogEntries(logPath: string, maxEntries: number): string[] {
    const raw = fs.readFileSync(logPath, 'utf8');
    const entries: string[] = [];
    const entryRe = /###\s*\[[^\]]+\]\s*[^\n]*\n([^\n]+)/g;
    let m: RegExpExecArray | null;
    while ((m = entryRe.exec(raw)) !== null) {
        const body = m[1].trim();
        if (body) { entries.push(body); }
    }
    return entries.slice(-maxEntries);
}

/**
 * Read the last N step entries from the most relevant task_log file and return
 * them as decision strings for PendingResume.decisions[].
 *
 * Strategy:
 * 1. If activeTask.taskId is set (agent called task_log this run), use that exact file.
 * 2. Otherwise fall back to the most-recently-modified log.md under .ollamaforge/tasks/.
 *
 * Falls back to [] silently on any error or if no logs exist.
 */
function readTaskLogDecisions(workspaceRoot: string, taskId?: string, maxEntries = 4): string[] {
    try {
        const tasksDir = path.join(workspaceRoot, '.ollamaforge', 'tasks');
        if (!fs.existsSync(tasksDir)) { return []; }

        // Prefer exact file if we know the taskId
        if (taskId) {
            const exactPath = path.join(tasksDir, taskId, 'log.md');
            if (fs.existsSync(exactPath)) { return parseTaskLogEntries(exactPath, maxEntries); }
        }

        // Fallback: most-recently-modified log.md — collect mtime once per path to avoid
        // redundant stat calls inside the comparator (O(N) stats, not O(N log N)).
        const logPaths = fs.readdirSync(tasksDir, { withFileTypes: true })
            .filter(d => d.isDirectory())
            .map(d => {
                const p = path.join(tasksDir, d.name, 'log.md');
                try { const s = fs.statSync(p); return s.isFile() ? { p, mtime: s.mtimeMs } : null; }
                catch { return null; }
            })
            .filter((x): x is { p: string; mtime: number } => x !== null);

        if (logPaths.length === 0) { return []; }

        const newest = logPaths.sort((a, b) => b.mtime - a.mtime)[0].p;

        return parseTaskLogEntries(newest, maxEntries);
    } catch {
        return [];
    }
}

/**
 * Guard against unbounded PendingResume objects in workspaceState.
 * Trims arrays so the total serialised size stays under ~8 KB.
 */
function capPendingResume(r: import('./chatStorage').PendingResume): import('./chatStorage').PendingResume {
    const MAX_ITEMS   = 20;
    const MAX_STR_LEN = 200;
    // For completed/read/decisions: keep the most recent (last N).
    const keepRecent = (arr: string[]) => arr.slice(-MAX_ITEMS).map(s => s.slice(0, MAX_STR_LEN));
    // For pending steps: keep the oldest unfinished (first N) — these are highest priority.
    const keepOldest = (arr: string[]) => arr.slice(0, MAX_ITEMS).map(s => s.slice(0, MAX_STR_LEN));
    return {
        ...r,
        filesRead:      keepRecent(r.filesRead),
        decisions:      keepRecent(r.decisions),
        stepsCompleted: keepRecent(r.stepsCompleted),
        stepsPending:   keepOldest(r.stepsPending),
        skillsUsed:     r.skillsUsed ? keepRecent(r.skillsUsed) : undefined,
    };
}

/**
 * Collect skill filenames that were used this run by scanning list_skills
 * tool results in the agent's recent conversation history.
 */
function extractSkillsFromHistory(agentHistory: import('./ollamaClient').OllamaMessage[]): string[] {
    const skills = new Set<string>();
    // Scan only the last 50 messages — skills used earlier in a very long session
    // are unlikely to still be active, and a full scan could block on large histories.
    const recent = agentHistory.slice(-50);
    for (const msg of recent) {
        if (typeof msg.content === 'string' && msg.content.includes('.ollamaforge/skills/')) {
            const matches = msg.content.matchAll(/\.ollamaforge\/skills\/([\w.\-]+)/g);
            for (const m of matches) { skills.add(m[1]); }
        }
    }
    return [...skills];
}

/**
 * Build a one-line resume summary from the last few messages of a session.
 * Shown as a persistent banner when the session is restored on reload.
 */
function buildResumeSummary(session: ChatSession): string {
    const msgs = session.messages;
    if (!msgs.length) { return ''; }

    const timeAgo = relativeTime(session.updatedAt);

    // If there's a saved pending continuation, surface it directly — it's more precise
    // than trying to guess next steps from message history.
    if (session.pendingContinuation) {
        const r = session.pendingContinuation;
        return `"${session.title}" · ${timeAgo} — ⏸ Paused: ${r.reason}`;
    }

    // Fall back to inferring context from message history
    const lastUser = [...msgs].reverse().find(m => m.role === 'user');
    const lastAsst = [...msgs].reverse().find(m => m.role === 'assistant');

    const topic = lastUser?.content
        ?.replace(/<active-file[\s\S]*?<\/active-file>/g, '')
        ?.replace(/<selection[\s\S]*?<\/selection>/g, '')
        ?.replace(/<mention[\s\S]*?<\/mention>/g, '')
        ?.replace(/<git-diff[\s\S]*?<\/git-diff>/g, '')
        ?.trim()
        ?.slice(0, 120) ?? '';

    // Grab first sentence of last assistant reply for more context
    const asstSnippet = lastAsst?.content
        ?.replace(/```[\s\S]*?```/g, '')
        ?.replace(/\|.*\|/g, '')   // strip tables
        ?.trim()
        ?.match(/^.{10,120}[.!?]/)?.[0] ?? '';

    const parts: string[] = [`"${session.title}" · ${timeAgo}`];
    if (topic) { parts.push(`Last: ${topic}`); }
    if (asstSnippet) { parts.push(asstSnippet); }
    return parts.join(' — ');
}

// ── Tab state ─────────────────────────────────────────────────────────────────

interface TabState {
    id: string;
    agent: Agent;
    session: ChatSession;
    running: boolean;
    /** Draft text the user had typed but not sent when they switched away from this tab. */
    draft: string;
    /** Message queued while agent was running — delivered after current run finishes. */
    pendingMessage?: { text: string; model: string; raw: MsgSendMessage };
    /** Promise for an in-progress pre-continuation compact — drain waits for it. */
    pendingCompact?: Promise<void>;
}

// ── Provider ──────────────────────────────────────────────────────────────────

export class OllamaAgentProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _editorListener?: vscode.Disposable;
    private _selectionListener?: vscode.Disposable;
    private _workspaceListener?: vscode.Disposable;
    private _currentWorkspaceRoot?: string;
    /** Mutex to prevent concurrent workspace changes */
    private _workspaceChanging: boolean = false;
    /** Shared DiffViewManager for applyCodeBlock (reused, not created per call) */
    private _diffViewManager: DiffViewManager = new DiffViewManager();

    // ── Tab management ────────────────────────────────────────────────────────
    private _tabs: Map<string, TabState> = new Map();
    private _activeTabId: string = '';

    /** Active tab — always valid after resolveWebviewView */
    private get _tab(): TabState { return this._tabs.get(this._activeTabId)!; }
    /** Convenience proxies so existing code reads naturally */
    private get _agent(): Agent  { return this._tab.agent; }
    private get _running(): boolean { return this._tab.running; }
    private set _running(v: boolean) {
        this._tab.running = v;
        this._updatePowerSaveBlocker();
    }
    private get currentSession(): ChatSession { return this._tab.session; }
    private set currentSession(s: ChatSession) { this._tab.session = s; }

    // ── Power save blocker ────────────────────────────────────────────────────
    // Prevents the OS from sleeping mid-inference while any tab has a running agent.
    private _powerSaveId: number = -1;

    private _updatePowerSaveBlocker(): void {
        const anyRunning = [...this._tabs.values()].some(t => t.running);
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any
            const { powerSaveBlocker } = require('electron') as any;
            if (anyRunning && (this._powerSaveId === -1 || !powerSaveBlocker.isStarted(this._powerSaveId))) {
                this._powerSaveId = powerSaveBlocker.start('prevent-display-sleep');
                logInfo('[provider] Power save blocker started');
            } else if (!anyRunning && this._powerSaveId !== -1 && powerSaveBlocker.isStarted(this._powerSaveId)) {
                powerSaveBlocker.stop(this._powerSaveId);
                this._powerSaveId = -1;
                logInfo('[provider] Power save blocker released');
            }
        } catch {
            // Not running inside Electron (e.g. tests or remote SSH host) — silently ignore.
        }
    }

    private readonly storage: ChatStorage;
    private readonly memory: TieredMemoryManager | null;
    private readonly templateManager: TemplateManager;
    private readonly smartContext: SmartContextManager;
    private readonly symbolProvider: SymbolProvider;
    /** Cached workspace file index for @mention autocomplete. Rebuilt on new workspace. */
    private _fileIndex: Awaited<ReturnType<typeof indexWorkspaceFiles>> = [];
    /** Current active preset name (persisted in workspace state). */
    private _activePreset: string = 'balanced';
    /** Smart context enabled state (persisted in workspace state). */
    private _smartContextEnabled: boolean = false;
    /** Pinned files (always-in-context, persisted in workspace state). */
    private _pinnedFiles: string[] = [];
    /** Tool names permanently approved by the user — persisted across sessions. */
    private _persistentApprovals: Set<string> = new Set();
    /** Current trust level — controls which tools are auto-approved without confirmation. */
    private _trustLevel: 'normal' | 'trust' | 'yolo' = 'normal';
    /** Listener for file saves to invalidate smart context import cache. */
    private _saveListener?: vscode.Disposable;
    /** Listener for webview messages — disposed on re-resolve to prevent accumulation. */
    private _messageListener?: vscode.Disposable;
    /** Timestamp when the current session was loaded — used to detect stale trust-level sync. */
    private _lastSessionLoadTime: number = 0;

    private readonly codeIndexer: CodeIndexer | null;

    constructor(
        private readonly context: vscode.ExtensionContext,
        memoryManager?: TieredMemoryManager | null,
        private readonly workspaceManager?: MultiWorkspaceManager,
        codeIndexer?: CodeIndexer | null
    ) {
        this.storage = new ChatStorage(context);
        this.memory = memoryManager ?? null;
        this.codeIndexer = codeIndexer ?? null;
        this.templateManager = new TemplateManager(context);
        this.symbolProvider = new SymbolProvider();
        this.smartContext = new SmartContextManager();
        // Restore active preset from workspace state
        this._activePreset = context.workspaceState.get('ollamaForge.activePreset', 'balanced');
        // Restore smart context enabled state
        this._smartContextEnabled = context.workspaceState.get('ollamaForge.smartContextEnabled', false);
        // Restore pinned files
        this._pinnedFiles = context.workspaceState.get('ollamaForge.pinnedFiles', []);
        // Restore persistent tool approvals
        const savedApprovals = context.workspaceState.get<string[]>('ollamaForge.persistentApprovals', []);
        this._persistentApprovals = new Set(savedApprovals);
        // Restore trust level
        const savedTrust = context.workspaceState.get<string>('ollamaForge.trustLevel', 'normal');
        this._trustLevel = (savedTrust === 'trust' || savedTrust === 'yolo') ? savedTrust : 'normal';
        // Bootstrap first tab — agent is created in resolveWebviewView once we have workspaceRoot
        const sessions = this.storage.list();
        const firstSession = sessions[0] ?? this.storage.createNew(getConfig().model);
        const firstTabId = `tab_${Date.now()}`;
        // Temporary placeholder agent — replaced in resolveWebviewView
        this._tabs.set(firstTabId, {
            id: firstTabId,
            agent: null as unknown as Agent,
            session: firstSession,
            running: false,
            draft: '',
        });
        this._activeTabId = firstTabId;
        logInfo(`[provider] Loaded session "${firstSession.title}" (${firstSession.messages.length} msgs)`);
    }

    async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
        this._view = webviewView;

        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        this._currentWorkspaceRoot = workspaceRoot;
        // Wire real agent into the first tab only when it still holds the null placeholder.
        // On subsequent re-resolves (sidebar hide/show) all tabs already have live agents —
        // do NOT replace them or we leak the old agent and destroy restored history.
        if (!this._tab.agent) {
            this._tab.agent = this.makeAgent(workspaceRoot);
        }

        // Listen for workspace folder changes
        this._workspaceListener?.dispose();
        this._workspaceListener = vscode.workspace.onDidChangeWorkspaceFolders(async () => {
            // Prevent concurrent workspace changes
            if (this._workspaceChanging) {
                logInfo('[provider] Workspace change already in progress, skipping');
                return;
            }
            
            const newRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
            if (newRoot !== this._currentWorkspaceRoot) {
                this._workspaceChanging = true;
                try {
                    logInfo(`[provider] Workspace changed: ${this._currentWorkspaceRoot} → ${newRoot}`);
                    this._currentWorkspaceRoot = newRoot;
                    
                    // Stop, dispose, and recreate all tab agents for the new root.
                    // Also reset all sessions so stale workspace context doesn't bleed in.
                    const model = getConfig().model;
                    for (const tab of this._tabs.values()) {
                        tab.agent?.stop();
                        tab.agent?.dispose();
                        tab.running = false;
                        tab.agent = this.makeAgent(newRoot);
                        tab.session = this.storage.createNew(model);
                    }

                    // Clear file index - will be rebuilt on next use
                    this._fileIndex = [];

                    const post = (m: object) => this._view?.webview.postMessage(m);
                    post({ type: 'clearChat' });
                    post({ type: 'tabList', tabs: this.getTabSummaries(), activeTabId: this._activeTabId });
                    logInfo(`[provider] Workspace changed — all tabs reset to new root`);
                } finally {
                    this._workspaceChanging = false;
                }
            }
        });
        this.context.subscriptions.push(this._workspaceListener);

        // Build file index for @mention autocomplete (async, non-blocking)
        if (workspaceRoot) {
            // Start indexing immediately but don't block
            indexWorkspaceFiles(workspaceRoot).then(index => {
                this._fileIndex = index;
                logInfo(`[provider] File index built: ${this._fileIndex.length} files`);
            }).catch(err => {
                logError(`[provider] File indexing failed: ${toErrorMessage(err)}`);
            });

            // Auto-refresh AGENTS.md if stale (non-blocking background run)
            this.maybeRefreshContextFile(workspaceRoot);

            // Run any overdue scheduled tasks (non-blocking)
            this.runOverdueSchedules(workspaceRoot);

            // Dream cycle: consolidate feedback into proposed behavioral rules (rate-limited)
            runDreamCycle(workspaceRoot, this.memory, this.codeIndexer).catch(err =>
                logInfo(`[dream] Cycle error: ${toErrorMessage(err)}`)
            );
        }

        // Restore agent conversation history and task state from the loaded session
        if (this.currentSession.agentHistory.length) {
            this._tab.agent.restoreHistory(this.currentSession.agentHistory);
        }
        if (this.currentSession.activeTask) {
            this._tab.agent.restoreActiveTask(this.currentSession.activeTask);
        }

        webviewView.webview.options = { enableScripts: true };

        // Fix mojibake in token text before sending to webview.
        // Models sometimes echo back double-encoded UTF-8 from system prompt strings:
        // â€" (U+00E2 U+0080 U+0094) → — (em dash)
        // â€™ → ' (right single quote), â€œ → " (left double quote), etc.
        function fixMojibake(s: string): string {
            return s
                .replace(/\u00e2\u0080\u0094/g, '\u2014')   // â€" → em dash
                .replace(/\u00e2\u0080\u0093/g, '\u2013')   // â€" → en dash
                .replace(/\u00e2\u0080\u0099/g, '\u2019')   // â€™ → right single quote
                .replace(/\u00e2\u0080\u0098/g, '\u2018')   // â€˜ → left single quote
                .replace(/\u00e2\u0080\u009c/g, '\u201c')   // â€œ → left double quote
                .replace(/\u00e2\u0080\u009d/g, '\u201d')   // â€  → right double quote
                .replace(/\u00e2\u0086\u0092/g, '\u2192')   // â†' → right arrow
                .replace(/\u00e2\u0086\u0090/g, '\u2190');  // â†  → left arrow
        }

        const post = (m: object) => {
            // Fix mojibake in all string fields, not just token text.
            // Tool previews, error messages, and assistant bubbles can all contain
            // double-encoded UTF-8 from model output.
            const fixAllStrings = (obj: Record<string, unknown>) => {
                for (const key of Object.keys(obj)) {
                    if (typeof obj[key] === 'string') {
                        obj[key] = fixMojibake(obj[key] as string);
                    }
                }
            };
            fixAllStrings(m as Record<string, unknown>);
            this._view?.webview.postMessage(m);
        };

        this._messageListener?.dispose();
        this._messageListener = webviewView.webview.onDidReceiveMessage(async (raw: WebviewMsg) => {
            // Guard: malformed message (missing or non-string command) — log and drop
            if (!raw || typeof raw.command !== 'string') {
                logWarn(`[webview→ext] Received malformed message: ${JSON.stringify(raw)}`);
                return;
            }
            // searchFiles fires on every keystroke — skip logging to avoid spam
            if (raw.command !== 'searchFiles') { logInfo(`[webview→ext] ${raw.command}`); }

            switch (raw.command) {

                // ── Model discovery ───────────────────────────────────────
                case 'getModels': {
                    const models = await fetchModels();
                    post({ type: 'models', models, connected: models.length > 0, defaultModel: getConfig().model });
                    // Webview is now ready — restore session if there are messages.
                    // This fires every time the webview re-initializes (restart, sidebar re-open),
                    // ensuring the chat is never blank even if the initial setTimeout fires too early.
                    if (this.currentSession.messages.length || this.currentSession.pendingContinuation) {
                        const resumeSummary = buildResumeSummary(this.currentSession);
                        post({
                            type: 'sessionLoaded',
                            session: toSummary(this.currentSession),
                            messages: this.currentSession.messages,
                            pinnedMsgIds: this.currentSession.pinnedMsgIds || [],
                            resumeSummary,
                        });
                        logInfo(`[provider] Session restored on getModels: "${this.currentSession.title}" — ${this.currentSession.messages.length} msgs`);
                    }
                    break;
                }

                // ── Trust level ───────────────────────────────────────────
                case 'setTrustLevel': {
                    const lvl = raw.level as string;
                    if (lvl === 'normal' || lvl === 'trust' || lvl === 'yolo') {
                        this._trustLevel = lvl;
                        this.context.workspaceState.update('ollamaForge.trustLevel', lvl);
                        logInfo(`[provider] Trust level set to: ${lvl}`);
                        // Apply immediately to any running agent.
                        // Always clear first so switching to a less-permissive level
                        // doesn't leave stale approvals from the previous level.
                        const COMMAND_TOOLS_LVL = new Set(['run_command', 'run_command_pip', 'run_command_destructive']);
                        for (const tab of this._tabs.values()) {
                            tab.agent.clearAutoApprovals();
                            tab.agent.trustLevel = lvl;
                            // In Normal mode, strip command-execution approvals from persistent set
                            const filteredForLevel = lvl === 'normal'
                                ? [...this._persistentApprovals].filter(t => !COMMAND_TOOLS_LVL.has(t))
                                : [...this._persistentApprovals];
                            tab.agent.seedPersistentApprovals(filteredForLevel);
                            if (lvl === 'trust') {
                                tab.agent.seedPersistentApprovals(['edit_file', 'write_file', 'edit_file_at_line', 'run_command', 'run_command_pip']);
                            } else if (lvl === 'yolo') {
                                tab.agent.seedPersistentApprovals(['edit_file', 'write_file', 'edit_file_at_line', 'run_command', 'run_command_pip', 'run_command_destructive']);
                            }
                        }
                    }
                    break;
                }

                // ── Send a message ────────────────────────────────────────
                case 'sendMessage': {
                    if (this._running) {
                        const qtext = raw.text?.trim() ?? '';
                        // Stop-intent detection: if message starts with a stop word, kill the
                        // current run immediately and queue the remainder as the next prompt.
                        const isStopIntent = /^(stop|cancel|halt|forget it|never mind|wait)\b/i.test(qtext);
                        if (isStopIntent) {
                            this._agent!.stop();
                            this._running = false;
                            post({ type: 'streamEnd' });
                            post({ type: 'agentDone' });
                            logInfo(`[provider] Stop intent detected mid-run — killed generation`);
                            // Clear any previously queued message to avoid double-delivery
                            this._tab.pendingMessage = undefined;
                            // If there's a redirect after the stop word, queue it as the next message.
                            // The finally block in the run loop will drain it once agent.run() resolves.
                            const redirect = qtext.replace(/^(stop|cancel|halt|forget it|never mind|wait)[.,!]?\s*/i, '').trim();
                            if (redirect) {
                                this._tab.pendingMessage = { text: redirect, model: raw.model ?? getConfig().model, raw };
                                post({ type: 'info', text: '⏸ Stopped. Starting redirect...' });
                            } else {
                                post({ type: 'info', text: '⏹ Stopped.' });
                            }
                            break;
                        }
                        // Not a stop — inject as a mid-run note at the next tool boundary,
                        // and also queue it as a follow-up so it becomes the next prompt.
                        // If another message is already queued, the newer one wins (last context wins).
                        if (qtext) {
                            this._agent?.setPendingNote(qtext);
                            this._tab.pendingMessage = { text: qtext, model: raw.model ?? getConfig().model, raw };
                            post({ type: 'info', text: '📌 Note queued — agent will see it at next tool boundary.' });
                        }
                        break;
                    }
                    const displayText = stripChatUiArtifacts(raw.text?.trim() ?? '');
                    const model = raw.model ?? getConfig().model;
                    if (!displayText) { break; }
                    // Sync trust level from webview — only accept upgrades or explicit user changes.
                    // Do NOT downgrade from yolo/trust to normal on sendMessage, because the
                    // webview dropdown may be stale after session load (race condition).
                    if (raw.trustLevel === 'normal' || raw.trustLevel === 'trust' || raw.trustLevel === 'yolo') {
                        const incoming = raw.trustLevel;
                        const current = this._trustLevel;
                        // Only sync if the webview is upgrading the level, or if both are non-normal
                        // (meaning the user explicitly changed it in the UI)
                        const isDowngrade = (current === 'yolo' && incoming !== 'yolo') || (current === 'trust' && incoming === 'normal');
                        // Allow downgrades if session was loaded > 2s ago (user intentionally changed it)
                        const sessionAge = Date.now() - (this._lastSessionLoadTime ?? 0);
                        const allowDowngrade = isDowngrade && sessionAge > 2000;
                        if ((!isDowngrade || allowDowngrade) && incoming !== current) {
                            logInfo(`[provider] Trust level synced from sendMessage: ${current} → ${incoming}`);
                            this._trustLevel = incoming;
                            this._tab.agent.trustLevel = incoming;
                        } else if (isDowngrade && !allowDowngrade) {
                            // Webview is behind (just loaded) — re-send the correct level
                            post({ type: 'trustLevelRestored', level: this._trustLevel });
                        }
                    }
                    // Guard: Ollama is offline — block send and show actionable error
                    if (!model || model === 'No models') {
                        post({ type: 'error', text: '⚠ No models available. Check that Ollama is running on the configured server (ollamaForge.serverUrl) and that models are loaded, then reload.' });
                        break;
                    }
                    // Resume-intent detection: if user says "continue"/"keep going"/etc.
                    // and there's a saved pendingContinuation, prepend it as context so
                    // the agent knows exactly what it was doing before the interruption.
                    // We keep displayText unchanged so the history panel shows what the user typed,
                    // not the injected blob. agentText is what the model actually receives.
                    // Match resume intent anywhere in a short message (≤60 chars) — not anchored,
                    // so "ok continue" and "yeah let's keep going" both match.
                    // "resume" as a bare word can be a noun ("my resume"). Only match it
                    // when preceded by intent words or at the start of the message.
                    // All other phrases are unambiguous verbs/questions so \b is fine for them.
                    const isResumeIntent = displayText.length <= 60 && (
                        /\b(continue|keep going|let'?s (keep going|continue|resume|get back|pick up)|pick up where|go ahead|carry on|get back to (it|this|that)|where were we|what were we doing|back to (it|this|that)|still there|you there)\b/i.test(displayText) ||
                        /(?:^|(?:ok|okay|yes|yeah|yep|please|let'?s|can you|could you)\s+)resume\b/i.test(displayText)
                    );
                    // Capture resume reason BEFORE clearing, so we can annotate the chat log entry.
                    const resumeReason = (isResumeIntent && this.currentSession.pendingContinuation)
                        ? this.currentSession.pendingContinuation.reason
                        : null;
                    const agentText = (isResumeIntent && this.currentSession.pendingContinuation)
                        ? (() => {
                            logInfo(`[provider] Resume intent detected — injecting continuation context`);
                            const r = this.currentSession.pendingContinuation!;
                            const lines = [`[Resuming interrupted task]`, `Reason: ${r.reason}`];
                            if (r.filesRead.length)      { lines.push(`Files already read: ${r.filesRead.join(', ')}`); }
                            if (r.decisions.length)      { lines.push(`Decisions / progress logged:\n${r.decisions.map(d => `  - ${d}`).join('\n')}`); }
                            if (r.stepsCompleted.length) { lines.push(`Steps completed:\n${r.stepsCompleted.map(s => `  ✓ ${s}`).join('\n')}`); }
                            if (r.stepsPending.length)   { lines.push(`Steps still to do:\n${r.stepsPending.map(s => `  • ${s}`).join('\n')}`); }
                            if (r.skillsUsed?.length)    { lines.push(`Skills/scripts active: ${r.skillsUsed.join(', ')}`); }
                            // Inject a live workspace file listing so the model can see what was
                            // already created before the interruption without re-scanning everything.
                            try {
                                const wsRoot = this._currentWorkspaceRoot;
                                if (wsRoot) {
                                    const walk = (dir: string, depth = 0): string[] => {
                                        if (depth > 3) { return []; }
                                        try {
                                            return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
                                                if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === '__pycache__') { return []; }
                                                const rel = path.relative(wsRoot, path.join(dir, e.name)).replace(/\\/g, '/');
                                                return e.isDirectory() ? walk(path.join(dir, e.name), depth + 1) : [rel];
                                            });
                                        } catch { return []; }
                                    };
                                    const files = walk(wsRoot).slice(0, 60);
                                    if (files.length > 0) {
                                        lines.push(`\nFiles currently in workspace:\n${files.map(f => `  ${f}`).join('\n')}`);
                                    }
                                }
                            } catch { /* skip if fs scan fails */ }
                            lines.push(`\nIMPORTANT: The workspace file list above shows what already exists. Do NOT re-create files that are already there. Do NOT re-survey the project from scratch. Look at the existing files, determine what is still missing, and continue the task from where it left off.`);
                            return lines.join('\n');
                        })()
                        : displayText;
                    // Clear pendingContinuation in-memory whenever the user sends any message.
                    // Don't persist here — the run's finally block already upserts on completion,
                    // and if we crash between here and agent.run() the paused state is still on disk.
                    if (this.currentSession.pendingContinuation) {
                        this.currentSession.pendingContinuation = null;
                    }
                    const text = agentText;

                    this._running = true;
                    // Capture the tab that owns this run. If the user switches tabs mid-run,
                    // _activeTabId changes but this closure still writes to the correct tab.
                    const runTab = this._tab;

                    logInfo(`[user] ${text.slice(0, 120)}${text.length > 120 ? '…' : ''}`);


                    // Record user message — store what the user typed. On resume, annotate with
                    // the paused reason so the chat log makes sense when scrolled back to later.
                    const storedText = resumeReason
                        ? `↩ Resumed: ${resumeReason.slice(0, 120)}`
                        : displayText;
                    this.appendToSession({ role: 'user', content: storedText, timestamp: Date.now() });
                    // Propagate model if it changed
                    this.currentSession.model = model;

                    // Build context string for the model
                    const ctx = buildContextString(raw.includeFile, raw.includeSelection);

                    // Resolve @mentioned files (deduplicate against auto-attached file)
                    const autoAttachedFile = raw.includeFile
                        ? vscode.workspace.asRelativePath(vscode.window.activeTextEditor?.document.uri ?? vscode.Uri.parse(''), false)
                        : '';
                    const currentWsRoot = this._currentWorkspaceRoot ?? '';
                    const mentionCtx = raw.mentionedFiles?.length
                        ? buildMentionContext(raw.mentionedFiles, currentWsRoot, new Set([autoAttachedFile]))
                        : '';

                    // Resolve @mentioned symbols
                    let symbolCtx = '';
                    if (raw.mentionedSymbols?.length) {
                        symbolCtx = '\n\n<symbol-mentions>\n';
                        for (const sym of raw.mentionedSymbols) {
                            try {
                                const uri = vscode.Uri.file(path.join(currentWsRoot, sym.filePath));
                                const symbols = await this.symbolProvider.getFileSymbols(uri);
                                const match = symbols.find(s => s.name === sym.name);
                                if (match) {
                                    const content = await this.symbolProvider.getSymbolContent(match);
                                    symbolCtx += `Symbol: ${sym.name} (${sym.filePath})\n\`\`\`\n${content}\n\`\`\`\n\n`;
                                }
                            } catch { /* skip unresolvable symbols */ }
                        }
                        symbolCtx += '</symbol-mentions>';
                    }

                    // Get config for smart context and git diff
                    const cfg = getConfig();

                    // ── Parallel context assembly ─────────────────────────
                    // Smart context, git diff, and symbol resolution are all
                    // independent I/O — run them concurrently.
                    const smartContextFiles: string[] = [];

                    const [smartCtxResult, gitCtx] = await Promise.all([
                        // Smart context: auto-include related files
                        (async (): Promise<string> => {
                            if (!this._smartContextEnabled || !vscode.window.activeTextEditor) { return ''; }
                            const relatedFiles = await this.smartContext.getRelatedFiles(
                                vscode.window.activeTextEditor.document,
                                cfg.maxContextFiles
                            );
                            if (relatedFiles.length === 0) { return ''; }
                            const alreadyIncluded = new Set([autoAttachedFile, ...(raw.mentionedFiles || [])]);
                            const filesToInclude = relatedFiles.filter(f => !alreadyIncluded.has(f.relativePath));
                            if (filesToInclude.length === 0) { return ''; }
                            let sc = '\n\n<smart-context>\n';
                            sc += `Auto-included ${filesToInclude.length} related file(s):\n\n`;
                            await Promise.all(filesToInclude.map(async (file) => {
                                smartContextFiles.push(file.relativePath);
                                try {
                                    const content = await vscode.workspace.fs.readFile(vscode.Uri.file(file.path));
                                    const txt = Buffer.from(content).toString('utf8');
                                    sc += `File: ${file.relativePath} (${file.reason})\n\`\`\`\n${txt.slice(0, 10000)}\n\`\`\`\n\n`;
                                } catch { /* skip unreadable files */ }
                            }));
                            sc += '</smart-context>';
                            post({ type: 'smartContextFiles', files: filesToInclude.map(f => f.relativePath) });
                            return sc;
                        })(),

                        // Git diff context
                        cfg.injectGitDiff && this._currentWorkspaceRoot
                            ? buildGitDiffContext(this._currentWorkspaceRoot, text)
                            : Promise.resolve(''),
                    ]);
                    const smartCtx = smartCtxResult;

                    const fullMessage = ctx || mentionCtx || symbolCtx || smartCtx || gitCtx
                        ? `${text}${ctx}${mentionCtx}${symbolCtx}${smartCtx}${gitCtx}`
                        : text;

                    // Build pinned files context (dedup against mentions, auto-attached, AND smart context)
                    let pinnedCtx = '';
                    if (raw.pinnedFiles?.length && this._currentWorkspaceRoot) {
                        const alreadyIncluded = new Set([
                            autoAttachedFile,
                            ...(raw.mentionedFiles || []),
                            ...smartContextFiles,
                        ]);
                        const uniquePinned = raw.pinnedFiles.filter(f => !alreadyIncluded.has(f));
                        if (uniquePinned.length) {
                            pinnedCtx = buildMentionContext(uniquePinned, this._currentWorkspaceRoot, alreadyIncluded);
                        }
                    }

                    const fullMessageWithPins = pinnedCtx
                        ? `${fullMessage}${pinnedCtx}`
                        : fullMessage;

                    // Wrap post() to capture streamed tokens → save assistant message.
                    // All references use runTab (captured above) so a mid-run tab switch
                    // cannot corrupt the wrong tab's session or flags.
                    let assistantBuf = '';
                    let inThinking = false; // local, not on `this` — tab-safe
                    const isFirstExchange = runTab.session.messages.filter(m => m.role === 'assistant').length === 0;
                    // Track active commands by ID so commandEnd can save a summary to the session.
                    // Map: cmdId -> { cmd, outputBuf }
                    const _activeCmds = new Map<string, { cmd: string; outputBuf: string }>();
                    const trackedPost: PostFn = (m: object) => {
                        // Intercept turnLimit: always re-evaluate canAutoContinue based on trust level.
                        // Normal mode → canAutoContinue=false (show "Keep going?" button).
                        // Trust/YOLO → canAutoContinue=true (show "Continuing…" spinner, auto-resumes).
                        const _tlPm = m as { type: string; canAutoContinue?: boolean };
                        if (_tlPm.type === 'turnLimit') {
                            const autoResuming = this._trustLevel === 'trust' || this._trustLevel === 'yolo';
                            if (runTab.id === this._activeTabId) {
                                post({ ...(m as object), canAutoContinue: autoResuming });
                            }
                            // If Trust/YOLO is overriding a canAutoContinue:false from the agent,
                            // synthesize the continueTask ourselves so the run actually resumes.
                            // (The agent only emits continueTask when it decides canAutoContinue=true.)
                            if (autoResuming && !_tlPm.canAutoContinue) {
                                logInfo(`[provider] Trust/YOLO: synthesizing continueTask for agent-stopped turn limit`);
                                trackedPost({ type: 'continueTask', prompt: 'keep going', model });
                            }
                            return;
                        }
                        // Background tab: suppress streaming/UI events — the webview is showing a
                        // different tab and these messages would corrupt its display. State-tracking
                        // (assistantBuf, session saves) still runs below. When the user switches
                        // back, switchTab sends sessionLoaded which repaints from session.messages.
                        const isBackground = runTab.id !== this._activeTabId;
                        const pm = m as { type: string; text?: string; id?: string; cmd?: string; exitCode?: number; stream?: string };
                        const STREAM_ONLY_TYPES = new Set(['token', 'streamStart', 'thinking', 'contextStats', 'commandStart', 'commandChunk']);
                        if (isBackground && STREAM_ONLY_TYPES.has(pm.type)) {
                            // Still track tokens for session buffer — just don't send to webview
                        } else if (isBackground) {
                            // Non-streaming events (streamEnd, agentDone, error, contextWarning, etc.)
                            // also suppressed — the repaint on tab switch reconstructs everything.
                            // Exception: agentDone/error badge the tab so user knows it finished.
                            if (pm.type === 'agentDone' || pm.type === 'agentError' || pm.type === 'error' || pm.type === 'confirmAction') {
                                post({ type: 'tabBadge', tabId: runTab.id, badge: pm.type === 'agentDone' ? 'done' : 'attention' });
                            }
                        } else {
                            post(m);
                        }
                        if (pm.type === 'token') {
                            const tok = pm.text ?? '';
                            // Strip thinking sentinels and thinking content from session buffer
                            if (tok === '\x01THINK_START\x01') { inThinking = true; }
                            else if (tok === '\x01THINK_END\x01') { inThinking = false; }
                            else if (!inThinking) { assistantBuf += tok; }
                        } else if (pm.type === 'commandStart' && pm.id && pm.cmd) {
                            _activeCmds.set(pm.id, { cmd: pm.cmd, outputBuf: '' });
                        } else if (pm.type === 'commandChunk' && pm.id) {
                            const entry = _activeCmds.get(pm.id);
                            if (entry && entry.outputBuf.length < 4000) {
                                entry.outputBuf += pm.text ?? '';
                            }
                        } else if (pm.type === 'commandEnd' && pm.id !== undefined) {
                            const entry = _activeCmds.get(pm.id);
                            _activeCmds.delete(pm.id!);
                            if (entry) {
                                const ok = (pm.exitCode ?? 0) === 0;
                                const icon = ok ? '✓' : '✗';
                                const outputPreview = entry.outputBuf.trim().slice(0, 1500);
                                const content = `${icon} \`${entry.cmd}\`\n${outputPreview}`;
                                runTab.session.messages.push({ role: 'tool_call', content, timestamp: Date.now() });
                            }
                        } else if (pm.type === 'streamEnd') {
                            if (assistantBuf.trim()) {
                                const clean = stripToolBlocksFromText(assistantBuf)
                                    .replace(/<mention[\s\S]*?<\/mention>\s*/g, '')
                                    .replace(/<git-diff[\s\S]*?<\/git-diff>\s*/g, '')
                                    .replace(/\[wait for result[^\]]*\]/gi, '')
                                    .replace(/\n{3,}/g, '\n\n')
                                    .trim();
                                if (clean) {
                                    runTab.session.messages.push({ role: 'assistant', content: clean, timestamp: Date.now() });
                                    if (runTab.session.title === 'New Chat') {
                                        runTab.session.title = deriveTitle(runTab.session.messages);
                                    }
                                    logInfo(`[assistant] ${clean.slice(0, 120)}${clean.length > 120 ? '…' : ''}`);

                                    // Auto-generate a title after the first assistant response
                                    if (isFirstExchange && runTab.session.title === 'New Chat') {
                                        generateChatTitle(model, text, clean).then((title) => {
                                            if (title && runTab.session.title === 'New Chat') {
                                                runTab.session.title = title;
                                                this.storage.upsert(runTab.session);
                                                post({ type: 'sessionSaved', session: { id: runTab.session.id, title } });
                                                post({ type: 'tabList', tabs: this.getTabSummaries(), activeTabId: this._activeTabId });
                                                logInfo(`[provider] Auto-title: "${title}"`);
                                            }
                                        }).catch(() => {});
                                    }
                                }
                            }
                            assistantBuf = '';
                            inThinking = false;
                            // Sync agent history and task state mid-run so a crash/force-close
                            // doesn't lose the turns already completed in this run.
                            runTab.session.agentHistory = runTab.agent.conversationHistory;
                            runTab.session.activeTask   = runTab.agent.activeTask;
                            this.storage.upsert(runTab.session);
                        } else if (pm.type === 'continueTask') {
                            // Agent exhausted its turn budget mid-task.
                            // Normal: show "Keep going?" prompt in the turn-limit card — user decides.
                            // Trust/YOLO: compact context first, then auto-continue.
                            const ct = m as { type: string; prompt: string; model: string };
                            const continueModel = ct.model || model;
                            const continueText  = ct.prompt || 'keep going';
                            if (this._trustLevel === 'trust' || this._trustLevel === 'yolo') {
                                logInfo(`[provider] Trust/YOLO: compacting then auto-continuing: "${continueText}"`);
                                // Compact in background — don't await so we don't block the event stream.
                                // The continuation is queued; it will fire after agentDone drains pendingMessage.
                                runTab.pendingCompact = runTab.agent.compactContext(25).then(() => {
                                    logInfo('[provider] Pre-continuation compact done');
                                }).catch((e) => {
                                    logWarn(`[provider] Pre-continuation compact failed (continuing anyway): ${toErrorMessage(e)}`);
                                });
                                runTab.pendingMessage = {
                                    text:  continueText,
                                    model: continueModel,
                                    raw:   { command: 'sendMessage', text: continueText, model: continueModel, trustLevel: this._trustLevel, includeFile: false, includeSelection: false },
                                };
                            } else {
                                // Normal mode: the turnLimit card already shows a "Keep going" button.
                                // Don't auto-queue — let the user decide.
                                logInfo(`[provider] Normal mode: turn limit hit, awaiting user input`);
                            }
                            return; // don't forward continueTask to the webview
                        } else if (pm.type === 'confirmAction') {
                            // Agent is pausing for user approval — save rich scratchpad so
                            // resume can inject exactly what was already known/done.
                            const ca = m as { type: string; action: string; detail: string };
                            const task = runTab.agent.activeTask;
                            const wsRoot = this._currentWorkspaceRoot ?? '';
                            runTab.session.pendingContinuation = capPendingResume({
                                reason:         `Waiting for approval: ${ca.action} — ${ca.detail}`.slice(0, 200),
                                filesRead:      task?.filesConfirmed?.slice() ?? [],
                                decisions:      readTaskLogDecisions(wsRoot, task?.taskId),
                                stepsCompleted: task?.stepsCompleted?.slice() ?? [],
                                stepsPending:   task?.stepsPending?.slice()   ?? [],
                                skillsUsed:     extractSkillsFromHistory(runTab.agent.conversationHistory),
                                pausedAt:       new Date().toISOString(),
                            });
                            this.storage.upsert(runTab.session);
                            logInfo(`[provider] pendingContinuation set: ${runTab.session.pendingContinuation.reason.slice(0, 80)}`);
                        } else if (pm.type === 'error') {
                            const errText = (m as { type: string; text: string }).text;
                            runTab.session.messages.push({ role: 'error', content: errText, timestamp: Date.now() });
                            // Save rich scratchpad so user can resume after network drop or crash.
                            const task = runTab.agent.activeTask;
                            const wsRoot = this._currentWorkspaceRoot ?? '';
                            // Preserve the existing reason if we already have one — don't wrap
                            // "Interrupted mid-task: [Resuming interrupted task]: ..." recursively.
                            const existingReason = runTab.session.pendingContinuation?.reason;
                            const lastTask = task?.message?.slice(0, 160) ?? text.slice(0, 160);
                            const errorReason = existingReason ?? `Interrupted mid-task: ${lastTask}`;
                            runTab.session.pendingContinuation = capPendingResume({
                                reason:         errorReason,
                                filesRead:      task?.filesConfirmed?.slice() ?? [],
                                decisions:      readTaskLogDecisions(wsRoot, task?.taskId),
                                stepsCompleted: task?.stepsCompleted?.slice() ?? [],
                                stepsPending:   task?.stepsPending?.slice()   ?? [],
                                skillsUsed:     extractSkillsFromHistory(runTab.agent.conversationHistory),
                                pausedAt:       new Date().toISOString(),
                            });
                            this.storage.upsert(runTab.session);
                        }
                    };

                    const runStart = Date.now();
                    // Save an "in-progress" pendingContinuation at run start so that a window
                    // reload / extension host kill mid-run always leaves a resume state on disk.
                    // Cleared on clean completion below.
                    // Use the existing pendingContinuation reason if this is already a resume,
                    // to avoid wrapping "Interrupted mid-task: [Resuming interrupted task]: ..."
                    // into an ever-deepening nested reason on repeated failures.
                    const runStartReason = runTab.session.pendingContinuation?.reason
                        ?? `Interrupted mid-task: ${text.trim().slice(0, 160)}`;
                    runTab.session.pendingContinuation = {
                        reason:         runStartReason,
                        filesRead:      [],
                        decisions:      [],
                        stepsCompleted: [],
                        stepsPending:   [],
                        pausedAt:       new Date().toISOString(),
                    };
                    this.storage.upsert(runTab.session);
                    try {
                        await runTab.agent.run(fullMessageWithPins, model, trackedPost);
                        // Sync agent history and task state into session after run completes.
                        // Only clear pendingContinuation if the run finished WITHOUT an error —
                        // if an error was posted mid-run (e.g. network drop), pendingContinuation
                        // was already set by the error handler and must NOT be cleared here.
                        runTab.session.agentHistory = runTab.agent.conversationHistory;
                        runTab.session.activeTask   = runTab.agent.activeTask;
                        const hadError = runTab.session.messages.some(
                            m => m.role === 'error' && Date.now() - m.timestamp < 10_000
                        );
                        if (!hadError) {
                            runTab.session.pendingContinuation = null;
                        }
                        this.storage.upsert(runTab.session);
                    } finally {
                        const stats = runTab.agent.runStats;
                        if (this._currentWorkspaceRoot) {
                            appendSessionLog(this._currentWorkspaceRoot, {
                                ts:           new Date(runStart).toISOString(),
                                sessionId:    runTab.session.id,
                                model,
                                task:         text.trim().slice(0, 500),
                                turns:        stats.turns,
                                toolCalls:    stats.toolCalls,
                                guardEvents:  stats.guardEvents,
                                filesChanged: stats.filesChanged,
                                avgLogprob:   stats.avgLogprob,
                                durationMs:   Date.now() - runStart,
                                outcome:      stats.outcome,
                            });
                        }
                        // Guard: stopGeneration may have already set running=false and sent agentDone.
                        // Avoid duplicate agentDone which confuses the webview spinner.
                        const wasRunning = runTab.running;
                        runTab.running = false;
                        if (wasRunning) {
                            if (runTab.id === this._activeTabId) {
                                post({ type: 'agentDone' });
                            } else {
                                // Background tab finished — badge it and update the tab bar spinner
                                post({ type: 'tabBadge', tabId: runTab.id, badge: 'done' });
                            }
                            // Always update tab bar so the spinner clears on the background tab button
                            post({ type: 'tabList', tabs: this.getTabSummaries(), activeTabId: this._activeTabId });
                        }

                        // Drain pending message — post it back to the webview so it
                        // re-sends as a normal sendMessage after agentDone renders.
                        const pending = runTab.pendingMessage;
                        if (pending) {
                            runTab.pendingMessage = undefined;
                            logInfo(`[provider] Draining queued message: "${pending.text.slice(0, 80)}"`);
                            const compactWait = runTab.pendingCompact;
                            runTab.pendingCompact = undefined;
                            const dispatchDelay = compactWait
                                ? compactWait.then(() => new Promise<void>(r => setTimeout(r, 300)))
                                : new Promise<void>(r => setTimeout(r, 300));
                            dispatchDelay.then(() => {
                                post({ type: 'dispatchQueued', msg: pending.raw });
                            });
                        }
                    }
                    break;
                }

                // ── New chat ──────────────────────────────────────────────
                case 'newChat': {
                    this.startNewSession(raw as unknown as { model?: string });
                    post({ type: 'clearChat' });
                    logInfo('[provider] New chat started');
                    break;
                }

                // ── Stop generation ───────────────────────────────────────
                case 'stopGeneration': {
                    if (!this._running) { break; } // already stopped (e.g. stop-intent fired first)
                    this._agent!.stop();
                    this._running = false;
                    // Clear any queued message — a user-initiated stop should not auto-resume.
                    this._tab.pendingMessage = undefined;
                    post({ type: 'streamEnd' });
                    post({ type: 'agentDone' });
                    logInfo('[provider] Generation stopped');
                    break;
                }

                // ── Retry last ────────────────────────────────────────────
                case 'retryLast': {
                    if (this._running) {
                        // Stop any in-flight run before retrying — same as stopGeneration.
                        // This handles the case where the webview reloaded and lost its
                        // agentActive state, making it appear idle while the provider is still running.
                        this._agent?.stop();
                        this._running = false;
                        post({ type: 'streamEnd' });
                    }
                    this._running = true;
                    const retryTab = this._tab; // capture before any async switch
                    const model   = raw.model ?? getConfig().model;
                    const lastMsg = retryTab.agent.retryLast();
                    if (!lastMsg) { retryTab.running = false; break; }
                    // Remove the last assistant + error messages from session
                    this.trimSessionToLastUser();
                    post({ type: 'removeLastAssistant' });
                    logInfo('[provider] Retrying last message…');

                    let assistantBuf2 = '';
                    let inThinking2 = false; // local, not on `this`
                    const retryPost: PostFn = (m: object) => {
                        post(m);
                        const pm = m as { type: string; text?: string };
                        if (pm.type === 'token') {
                            const tok = pm.text ?? '';
                            if (tok === '\x01THINK_START\x01') { inThinking2 = true; }
                            else if (tok === '\x01THINK_END\x01') { inThinking2 = false; }
                            else if (!inThinking2) { assistantBuf2 += tok; }
                        } else if (pm.type === 'streamEnd') {
                            if (assistantBuf2.trim()) {
                                const clean2 = stripToolBlocksFromText(assistantBuf2).replace(/<mention[\s\S]*?<\/mention>\s*/g, '').replace(/<git-diff[\s\S]*?<\/git-diff>\s*/g, '').replace(/\[wait for result[^\]]*\]/gi, '').replace(/\n{3,}/g, '\n\n').trim();
                                if (clean2) { retryTab.session.messages.push({ role: 'assistant', content: clean2, timestamp: Date.now() }); }
                            }
                            assistantBuf2 = '';
                            inThinking2 = false;
                            retryTab.session.agentHistory = retryTab.agent.conversationHistory;
                            retryTab.session.activeTask   = retryTab.agent.activeTask;
                            this.storage.upsert(retryTab.session);
                        }
                    };

                    const retryStart = Date.now();
                    try {
                        await retryTab.agent.run(lastMsg, model, retryPost);
                        retryTab.session.agentHistory = retryTab.agent.conversationHistory;
                        retryTab.session.activeTask   = retryTab.agent.activeTask;
                        this.storage.upsert(retryTab.session);
                    } finally {
                        const retryStats = retryTab.agent.runStats;
                        if (this._currentWorkspaceRoot) {
                            appendSessionLog(this._currentWorkspaceRoot, {
                                ts:           new Date(retryStart).toISOString(),
                                sessionId:    retryTab.session.id,
                                model,
                                task:         `[retry] ${lastMsg.trim().slice(0, 480)}`,
                                turns:        retryStats.turns,
                                toolCalls:    retryStats.toolCalls,
                                guardEvents:  retryStats.guardEvents,
                                filesChanged: retryStats.filesChanged,
                                avgLogprob:   retryStats.avgLogprob,
                                durationMs:   Date.now() - retryStart,
                                outcome:      retryStats.outcome,
                            });
                        }
                        retryTab.running = false;
                        post({ type: 'agentDone' });

                        // Drain any pending message queued during the retry run
                        const retryPending = retryTab.pendingMessage;
                        if (retryPending) {
                            retryTab.pendingMessage = undefined;
                            logInfo(`[provider] Draining queued message after retry: "${retryPending.text.slice(0, 80)}"`);
                            setTimeout(() => {
                                post({ type: 'dispatchQueued', msg: retryPending.raw });
                            }, 150);
                        }
                    }
                    break;
                }

                // ── Context ───────────────────────────────────────────────
                case 'getContext': {
                    post({ type: 'contextUpdate', ...getActiveContext() });
                    break;
                }

                // ── Session management ────────────────────────────────────
                case 'listSessions': {
                    const summaries = this.storage.list().map(toSummary);
                    post({ type: 'sessionList', sessions: summaries, currentId: this.currentSession.id });
                    break;
                }

                case 'loadSession': {
                    const session = this.storage.get(raw.id);
                    if (!session) {
                        post({ type: 'error', text: `Session not found: ${raw.id}` });
                        break;
                    }
                    // Stop any in-flight generation before switching sessions
                    if (this._running) {
                        this._agent?.stop();
                        this._running = false;
                    }
                    this.currentSession = session;
                    this._lastSessionLoadTime = Date.now();
                    // Dispose old agent and rebuild with the saved history
                    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
                    this._tab.agent?.dispose();
                    this._tab.agent = this.makeAgent(root);
                    if (session.agentHistory.length) {
                        this._tab.agent.restoreHistory(session.agentHistory);
                    }
                    if (session.activeTask) {
                        this._tab.agent.restoreActiveTask(session.activeTask);
                    }
                    if (this.memory) {
                        const stats = this.memory.getStats();
                        const total = stats.reduce((sum, s) => sum + s.count, 0);
                        logInfo(`[provider] Session loaded with ${total} memory entries available`);
                    }
                    logInfo(`[provider] Loaded session "${session.title}"`);
                    post({
                        type: 'sessionLoaded',
                        session: toSummary(session),
                        messages: session.messages,
                        pinnedMsgIds: session.pinnedMsgIds || [],
                        resumeSummary: buildResumeSummary(session),
                    });
                    // Re-sync trust level to the webview after session load
                    // (the webview resets its dropdown on sessionLoaded)
                    setTimeout(() => post({ type: 'trustLevelRestored', level: this._trustLevel }), 100);
                    break;
                }

                case 'deleteSession': {
                    this.storage.delete(raw.id);
                    // If we just deleted the active session, start a new one
                    if (raw.id === this.currentSession.id) {
                        this.startNewSession({});
                        post({ type: 'clearChat' });
                    }
                    post({ type: 'sessionList', sessions: this.storage.list().map(toSummary), currentId: this.currentSession.id });
                    break;
                }

                case 'clearAllSessions': {
                    this.storage.clearAll();
                    this.startNewSession({});
                    post({ type: 'clearChat' });
                    post({ type: 'sessionList', sessions: [], currentId: this.currentSession.id });
                    logInfo('[provider] All sessions cleared');
                    break;
                }

                // ── Tab management ────────────────────────────────────────
                case 'openTab': {
                    const newTabId = `tab_${Date.now()}`;
                    const newSession = this.storage.createNew(getConfig().model);
                    const root = this._currentWorkspaceRoot ?? '';
                    this._tabs.set(newTabId, {
                        id: newTabId,
                        agent: this.makeAgent(root),
                        session: newSession,
                        running: false,
                        draft: '',
                    });
                    this._activeTabId = newTabId;
                    // Order: clear content first, then update tab bar
                    post({ type: 'clearChat' });
                    post({ type: 'tabList', tabs: this.getTabSummaries(), activeTabId: this._activeTabId });
                    logInfo(`[provider] Opened new tab: ${newTabId}`);
                    break;
                }

                case 'closeTab': {
                    const closeMsg = raw as { command: 'closeTab'; tabId: string };
                    const tabToClose = this._tabs.get(closeMsg.tabId);
                    if (!tabToClose) { break; }
                    // Stop before dispose to avoid async continuations on a dead agent
                    tabToClose.agent?.stop();
                    tabToClose.agent?.dispose();
                    this._tabs.delete(closeMsg.tabId);
                    // If we closed the active tab, switch to the nearest remaining tab
                    if (this._activeTabId === closeMsg.tabId) {
                        const remaining = [...this._tabs.keys()];
                        if (remaining.length === 0) {
                            // Always keep at least one tab
                            const fallbackId = `tab_${Date.now()}`;
                            const fallbackSession = this.storage.createNew(getConfig().model);
                            const root = this._currentWorkspaceRoot ?? '';
                            this._tabs.set(fallbackId, {
                                id: fallbackId,
                                agent: this.makeAgent(root),
                                session: fallbackSession,
                                running: false,
                                draft: '',
                            });
                            this._activeTabId = fallbackId;
                        } else {
                            // Pick the tab inserted just before the closed one (nearest left neighbor)
                            const allIds = [...this._tabs.keys()];
                            this._activeTabId = allIds[allIds.length - 1];
                        }
                        const active = this._tab;
                        // Order: clear, populate content, then update tab bar
                        post({ type: 'clearChat' });
                        post({
                            type: 'sessionLoaded',
                            session: toSummary(active.session),
                            messages: active.session.messages,
                            pinnedMsgIds: active.session.pinnedMsgIds || [],
                        });
                    }
                    post({ type: 'tabList', tabs: this.getTabSummaries(), activeTabId: this._activeTabId });
                    logInfo(`[provider] Closed tab: ${closeMsg.tabId}`);
                    break;
                }

                case 'switchTab': {
                    const switchMsg = raw as { command: 'switchTab'; tabId: string; draft?: string };
                    if (!this._tabs.has(switchMsg.tabId) || switchMsg.tabId === this._activeTabId) { break; }
                    // Save the outgoing tab's input draft — the agent keeps running in the background
                    const outgoing = this._tab;
                    outgoing.draft = switchMsg.draft ?? '';
                    this._activeTabId = switchMsg.tabId;
                    const incoming = this._tab;
                    // Order: clear content, populate incoming session, then update tab bar highlight
                    post({ type: 'clearChat' });
                    post({
                        type: 'sessionLoaded',
                        session: toSummary(incoming.session),
                        messages: incoming.session.messages,
                        pinnedMsgIds: incoming.session.pinnedMsgIds || [],
                        draft: incoming.draft,
                        agentRunning: incoming.running,
                    });
                    post({ type: 'tabList', tabs: this.getTabSummaries(), activeTabId: this._activeTabId });
                    // Restore context usage bar for the incoming tab
                    const ctxStats = incoming.agent?.getContextStats();
                    if (ctxStats) {
                        post({ type: 'contextStats', percentage: ctxStats.percentage, usedTokens: ctxStats.usedTokens, totalTokens: ctxStats.totalTokens });
                    } else {
                        post({ type: 'contextStats', percentage: 0, usedTokens: 0, totalTokens: 0 });
                    }
                    logInfo(`[provider] Switched to tab: ${switchMsg.tabId}`);
                    break;
                }

                // ── @mention file search ──────────────────────────────────
                case 'searchFiles': {
                    const q = (raw as MsgSearchFiles).query ?? '';
                    const matches = fuzzySearchFiles(this._fileIndex, q, 12);
                    post({ type: 'fileSearchResults', query: q, files: matches.map((f) => ({ rel: f.rel, display: f.display, ext: f.ext })) });
                    break;
                }

                // ── Search symbols ────────────────────────────────────────
                case 'searchSymbols': {
                    const q = (raw as any).query ?? '';
                    const symbols = await this.symbolProvider.getWorkspaceSymbols(q);
                    const results = symbols.slice(0, 12).map(s => ({
                        name: s.name,
                        kind: s.kind,
                        containerName: s.containerName,
                        filePath: vscode.workspace.asRelativePath(s.location.uri),
                        display: this.symbolProvider.formatSymbolForDisplay(s)
                    }));
                    post({ type: 'symbolSearchResults', query: q, symbols: results });
                    break;
                }

                // ── Model preset selection ────────────────────────────────
                case 'setPreset': {
                    const msg = raw as MsgSetPreset;
                    this._activePreset = msg.preset || '';
                    // Persist to workspace state
                    this.context.workspaceState.update('ollamaForge.activePreset', this._activePreset);
                    logInfo(`[provider] Preset changed to: ${this._activePreset || 'custom'}`);
                    break;
                }

                // ── Get templates ─────────────────────────────────────────
                case 'getTemplates': {
                    const templates = this.templateManager.getAll();
                    post({ type: 'templates', templates });
                    break;
                }

                // ── Toggle smart context ──────────────────────────────────
                case 'toggleSmartContext': {
                    const msg = raw as MsgToggleSmartContext;
                    this._smartContextEnabled = msg.enabled;
                    this.context.workspaceState.update('ollamaForge.smartContextEnabled', this._smartContextEnabled);
                    logInfo(`[provider] Smart context ${this._smartContextEnabled ? 'enabled' : 'disabled'}`);
                    break;
                }

                // ── Update pinned files ───────────────────────────────────
                case 'updatePinnedFiles': {
                    const pfMsg = raw as { command: 'updatePinnedFiles'; files: string[] };
                    this._pinnedFiles = pfMsg.files || [];
                    this.context.workspaceState.update('ollamaForge.pinnedFiles', this._pinnedFiles);
                    logInfo(`[provider] Pinned files updated: ${this._pinnedFiles.join(', ') || '(none)'}`);
                    break;
                }

                // ── Pin persistence ───────────────────────────────────────
                case 'updatePins': {
                    const pinMsg = raw as { command: 'updatePins'; pins: string[] };
                    this.currentSession.pinnedMsgIds = pinMsg.pins;
                    this.persistSession();
                    break;
                }

                // ── Open extension settings ──────────────────────────────
                case 'openSettings': {
                    vscode.commands.executeCommand('workbench.action.openSettings', 'ollamaForge');
                    break;
                }

                // ── Open file from chat link ───────────────────────────────
                case 'openFile': {
                    const rawPath = String(raw.path ?? '').trim();
                    if (!rawPath) { break; }
                    // Resolve relative to the first workspace folder
                    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
                    const fileUri = wsRoot
                        ? vscode.Uri.joinPath(wsRoot, rawPath)
                        : vscode.Uri.file(rawPath);
                    try {
                        await vscode.window.showTextDocument(fileUri, { preview: false });
                    } catch {
                        // File may not exist yet — reveal parent folder in explorer instead
                        vscode.window.showWarningMessage(`Could not open "${rawPath}" — file may not exist yet.`);
                    }
                    break;
                }

                // ── Project code review (git diff) ────────────────────────
                case 'reviewProject': {
                    vscode.commands.executeCommand('ollamaForge.reviewChanges');
                    break;
                }

                // ── Manual context compaction ─────────────────────────────
                case 'compactContext': {
                    if (this._running) {
                        post({ type: 'error', text: 'Cannot compact while a response is in progress.' });
                        break;
                    }
                    post({ type: 'compactingStarted' });
                    const result = await this._agent!.compactContext(25, (token) => {
                        post({ type: 'compactSummaryToken', token });
                    });
                    post({
                        type: 'contextCompacted',
                        messagesRemoved: result.removed,
                        newPercentage: result.newPercentage,
                        summary: result.summary,
                    });
                    this.currentSession.agentHistory = this._agent!.conversationHistory;
                    this.currentSession.activeTask   = this._agent!.activeTask;
                    this.persistSession();
                    logInfo(`[provider] Manual compact: removed ${result.removed} messages`);
                    // In Trust/Yolo mode, auto-resume after compact so user doesn't have to say "keep going"
                    if (this._trustLevel !== 'normal' && this._agent!.conversationHistory.length > 0) {
                        logInfo(`[provider] ${this._trustLevel} mode: auto-resuming after manual compact`);
                        const resumeModel = getConfig().model;
                        this._running = true;
                        (async () => {
                            try {
                                await this._agent!.run(
                                    '[SYSTEM: Context was just compacted. Resume the task from where you left off — do not repeat completed steps.]',
                                    resumeModel,
                                    post
                                );
                            } finally {
                                this._running = false;
                                post({ type: 'agentDone' });
                                this.currentSession.agentHistory = this._agent!.conversationHistory;
                                this.persistSession();
                            }
                        })();
                    }
                    break;
                }

                // ── Undo last tool execution ──────────────────────────────
                case 'undoLastTool': {
                    const undoResult = this._agent!.undoLastTool();
                    if (undoResult) {
                        post({ type: 'undoResult', success: true, message: undoResult });
                        logInfo(`[provider] ${undoResult}`);
                    } else {
                        post({ type: 'undoResult', success: false, message: 'Nothing to undo' });
                    }
                    break;
                }

                // ── Apply code block from chat ───────────────────────────────
                case 'applyCodeBlock': {
                    const applyMsg = raw as { command: 'applyCodeBlock'; code: string; lang: string };
                    await this.applyCodeBlock(applyMsg.code, applyMsg.lang);
                    break;
                }

                // ── Inline confirmation response from webview ─────────────────
                case 'confirmResponse': {
                    const crMsg = raw as unknown as { command: 'confirmResponse'; id: string; accepted: boolean };
                    this._agent?.resolveConfirmation(crMsg.accepted);
                    break;
                }

                // ── Batch-approve: accept this AND all future calls to same tool ──
                case 'confirmResponseAll': {
                    const caMsg = raw as unknown as { command: 'confirmResponseAll'; id: string; toolName: string };
                    this._agent?.resolveConfirmationAll(caMsg.toolName);
                    // Persist so future sessions don't ask again
                    this._persistentApprovals.add(caMsg.toolName);
                    this.context.workspaceState.update(
                        'ollamaForge.persistentApprovals',
                        [...this._persistentApprovals]
                    );
                    logInfo(`[provider] Persisted approval for "${caMsg.toolName}"`);
                    break;
                }

                // ── Feedback: user flags a bad response ──────────────────────
                case 'submitFeedback': {
                    if (this._currentWorkspaceRoot) {
                        const dir = path.join(this._currentWorkspaceRoot, '.ollamaforge');
                        if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
                        const feedbackPath = path.join(dir, 'feedback.md');
                        const date = new Date().toISOString().slice(0, 10);
                        const snippet = (raw.msgText || '').replace(/\n/g, ' ').slice(0, 300);
                        const entry = `\n## [${date}] ${raw.label}\n> ${snippet}\n`;
                        fs.appendFileSync(feedbackPath, entry, 'utf8');
                        logInfo(`[feedback] Recorded: ${raw.label}`);
                        post({ type: 'info', text: '📝 Feedback recorded — the agent will learn from this.' });
                    }
                    break;
                }

                // ── Positive feedback: user marks a response as helpful ───────
                case 'submitPositiveFeedback': {
                    if (this._currentWorkspaceRoot) {
                        const dir = path.join(this._currentWorkspaceRoot, '.ollamaforge');
                        if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
                        const feedbackPath = path.join(dir, 'positive_feedback.md');
                        const date = new Date().toISOString().slice(0, 10);
                        const snippet = (raw.msgText || '').replace(/\n/g, ' ').slice(0, 300);
                        const entry = `\n## [${date}] Helpful response\n> ${snippet}\n`;
                        fs.appendFileSync(feedbackPath, entry, 'utf8');
                        logInfo('[feedback] Positive feedback recorded');
                    }
                    break;
                }

                // ── Webview JS error reporting ────────────────────────────────
                case 'webviewError': {
                    const errMsg = raw as { command: 'webviewError'; text: string };
                    logError(errMsg.text);
                    break;
                }
            }
        });

        // Push context updates when the active editor / selection changes
        this._editorListener?.dispose();
        this._editorListener = vscode.window.onDidChangeActiveTextEditor(() => {
            if (webviewView.visible) {
                post({ type: 'contextUpdate', ...getActiveContext() });
            }
        });
        // Track selection listener as a class field to prevent accumulation on re-resolve
        this._selectionListener?.dispose();
        this._selectionListener = vscode.window.onDidChangeTextEditorSelection(() => {
            if (webviewView.visible) {
                post({ type: 'contextUpdate', ...getActiveContext() });
            }
        });
        // Invalidate smart context import cache when files are saved
        this._saveListener?.dispose();
        this._saveListener = vscode.workspace.onDidSaveTextDocument((doc) => {
            this.smartContext.clearCache(doc.uri.fsPath);
        });

        // Track panel visibility so we can auto-restore it after VS Code restarts.
        // Set the flag when visible, clear it when hidden. Persisted in workspaceState
        // so main.ts can read it on the next activation and re-focus the panel.
        const updateWasActive = () => {
            this.context.workspaceState.update('ollamaForge.wasActive', webviewView.visible);
        };
        updateWasActive(); // capture current state immediately on resolve
        webviewView.onDidChangeVisibility(updateWasActive);

        try {
            webviewView.webview.html = await this.buildHtml();
            logInfo('[provider] Webview HTML loaded');

            // Restore tabs into the freshly-loaded webview.
            // Session messages are restored in the getModels handler (triggered by the webview on init)
            // so they are guaranteed to arrive after the webview JS is ready to receive them.
            setTimeout(() => {
                post({ type: 'tabList', tabs: this.getTabSummaries(), activeTabId: this._activeTabId });
                // Restore context bar
                const ctxStats = this._tab.agent?.getContextStats();
                if (ctxStats) {
                    post({ type: 'contextStats', percentage: ctxStats.percentage, usedTokens: ctxStats.usedTokens, totalTokens: ctxStats.totalTokens });
                }
            }, 300); // small delay so the webview JS has time to initialise

            // Restore active preset
            setTimeout(() => {
                post({ type: 'presetRestored', preset: this._activePreset });
                post({ type: 'smartContextRestored', enabled: this._smartContextEnabled });
                post({ type: 'pinnedFilesRestored', files: this._pinnedFiles.map(f => ({ rel: f })) });
                post({ type: 'trustLevelRestored', level: this._trustLevel });
            }, 400);
        } catch (err) {
            logError(`[provider] Failed to build webview: ${toErrorMessage(err)}`);
        }
    }

    /** Called from the `ollamaForge.newChat` command. */
    newChat(): void {
        this.startNewSession({});
        this._view?.webview.postMessage({ type: 'clearChat' });
    }

    /** Called from commands to send a message programmatically (e.g., Explain Selection). */
    sendMessageFromCommand(text: string, includeFile: boolean, includeSelection: boolean): void {
        if (!this._view) {
            logError('[provider] Cannot send message - webview not initialized');
            return;
        }
        
        // Send the message through the webview as if user typed it
        this._view.webview.postMessage({
            type: 'sendFromCommand',
            text,
            includeFile,
            includeSelection
        });
    }

    /** Get the template manager instance. */
    getTemplateManager(): TemplateManager {
        return this.templateManager;
    }

    /** Get current chat messages for export. */
    getCurrentChatMessages(): Array<{ role: 'user' | 'assistant' | 'system'; content: string; timestamp?: number }> {
        return this.currentSession.messages
            .filter(m => m.role === 'user' || m.role === 'assistant')
            .map(msg => ({
                role: msg.role as 'user' | 'assistant' | 'system',
                content: msg.content,
                timestamp: msg.timestamp
            }));
    }

    /** Get current chat title. */
    getCurrentChatTitle(): string {
        return this.currentSession.title || 'Untitled Chat';
    }

    dispose(): void {
        this._editorListener?.dispose();
        this._selectionListener?.dispose();
        this._workspaceListener?.dispose();
        this._saveListener?.dispose();
        this._messageListener?.dispose();
        for (const tab of this._tabs.values()) { tab.agent?.stop(); tab.agent?.dispose(); }
        this._tabs.clear();
        this._diffViewManager.dispose();
    }

    // ── Apply code block from chat ─────────────────────────────────────────

    private async applyCodeBlock(code: string, _lang: string): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('No active editor — open a file first, then click Apply.');
            return;
        }

        const doc = editor.document;
        const original = doc.getText();
        const filePath = doc.uri.fsPath;

        // If there's a selection, replace just the selection; otherwise replace entire file
        const selection = editor.selection;
        const hasSelection = !selection.isEmpty;

        let newContent: string;
        if (hasSelection) {
            const before = original.slice(0, doc.offsetAt(selection.start));
            const after = original.slice(doc.offsetAt(selection.end));
            newContent = before + code + after;
        } else {
            newContent = code;
        }

        // Show diff preview using shared DiffViewManager
        try {
            await this._diffViewManager.showDiffPreview(filePath, original, newContent);
            const choice = await vscode.window.showInformationMessage(
                `Apply changes to ${path.basename(filePath)}?`,
                'Accept', 'Reject'
            );
            if (choice === 'Accept') {
                const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(original.length));
                await editor.edit(eb => eb.replace(fullRange, newContent));
                logInfo(`[provider] Applied code block to ${vscode.workspace.asRelativePath(doc.uri)}`);
            }
            await this._diffViewManager.closeDiffPreview();
        } catch (err) {
            logError(`[provider] Apply code block failed: ${toErrorMessage(err)}`);
        }
    }

    // ── Agent factory ─────────────────────────────────────────────────────────

    /** Clear all persistent approvals — used by the clearApprovals command. */
    clearPersistentApprovals(): void {
        this._persistentApprovals.clear();
        // Also clear from any currently running agent
        for (const tab of this._tabs.values()) {
            tab.agent.clearAutoApprovals();
        }
    }

    /** Create a new Agent and immediately seed persistent approvals into it. */
    private makeAgent(root: string): Agent {
        const agent = new Agent(root, this.memory, this.codeIndexer);
        agent.trustLevel = this._trustLevel;
        // Expose the active agent so the file-save handler in main.ts can reach
        // the code graph for incremental updates without a full circular import.
        (global as any).__ollamaforgeActiveAgent = agent;
        // Persistent approvals are scoped by trust level.
        // run_command / destructive tools must NOT carry over into Normal mode — they require
        // explicit per-session approval there, regardless of what was approved at a higher level.
        const COMMAND_TOOLS = new Set(['run_command', 'run_command_pip', 'run_command_destructive']);
        const filteredApprovals = this._trustLevel === 'normal'
            ? new Set([...this._persistentApprovals].filter(t => !COMMAND_TOOLS.has(t)))
            : new Set(this._persistentApprovals);
        const approvals = filteredApprovals;
        if (this._trustLevel === 'trust') {
            approvals.add('edit_file');
            approvals.add('write_file');
            approvals.add('edit_file_at_line');
            approvals.add('run_command');
            approvals.add('run_command_pip');
        } else if (this._trustLevel === 'yolo') {
            approvals.add('edit_file');
            approvals.add('write_file');
            approvals.add('edit_file_at_line');
            approvals.add('run_command');
            approvals.add('run_command_pip');
            approvals.add('run_command_destructive');
        }
        if (approvals.size) {
            agent.seedPersistentApprovals(approvals);
            logInfo(`[provider] Seeded ${approvals.size} approval(s) (trust=${this._trustLevel}): ${[...approvals].join(', ')}`);
        }
        return agent;
    }

    // ── Session helpers ───────────────────────────────────────────────────────

    private startNewSession(opts: { model?: string }): void {
        const model = opts.model ?? getConfig().model;
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        this._tab.session = this.storage.createNew(model);
        this._tab.agent?.dispose();
        this._tab.agent = this.makeAgent(root);
        if (root && !this._fileIndex.length) {
            indexWorkspaceFiles(root).then(idx => { this._fileIndex = idx; }).catch(() => {});
        }
        logInfo(`[provider] New session: ${this.currentSession.id}`);
        logInfo(`[provider] Workspace root: ${root || '(none)'}`);
    }

    /** Build tab summaries for sending to the webview. */
    private getTabSummaries(): Array<{ tabId: string; title: string; active: boolean; running: boolean }> {
        return [...this._tabs.entries()].map(([id, tab]) => ({
            tabId: id,
            title: tab.session.title,
            active: id === this._activeTabId,
            running: tab.running,
        }));
    }

    private appendToSession(msg: StoredMessage): void {
        this.currentSession.messages.push(msg);
        // Update title once we have the first user message
        if (this.currentSession.title === 'New Chat') {
            this.currentSession.title = deriveTitle(this.currentSession.messages);
        }
    }

    private trimSessionToLastUser(): void {
        // Remove everything after (and including) the last non-user message
        while (
            this.currentSession.messages.length > 0 &&
            this.currentSession.messages[this.currentSession.messages.length - 1].role !== 'user'
        ) {
            this.currentSession.messages.pop();
        }
    }

    /**
     * Check .ollamaforge/schedules/ for any overdue task scripts and run them silently in the background.
     */
    private runOverdueSchedules(workspaceRoot: string): void {
        const schedulesDir = path.join(workspaceRoot, '.ollamaforge', 'schedules');
        if (!fs.existsSync(schedulesDir)) { return; }

        let files: string[];
        try {
            files = fs.readdirSync(schedulesDir).filter(f => f.endsWith('.json') && !f.endsWith('.last_run.json'));
        } catch { return; }

        for (const file of files) {
            try {
                const schPath = path.join(schedulesDir, file);
                const schedule = JSON.parse(fs.readFileSync(schPath, 'utf8')) as {
                    name: string; script_path: string; interval_hours: number; description: string;
                };
                if (!schedule.script_path || !schedule.interval_hours) { continue; }

                // Security: reject absolute paths and path traversal attempts.
                // script_path must be a relative path that stays inside the workspace.
                if (path.isAbsolute(schedule.script_path)) {
                    logWarn(`[schedules] Skipping ${file}: script_path must be relative, got absolute path "${schedule.script_path}"`);
                    continue;
                }
                const scriptAbs = path.resolve(workspaceRoot, schedule.script_path);
                const rootWithSep = workspaceRoot.endsWith(path.sep) ? workspaceRoot : workspaceRoot + path.sep;
                if (scriptAbs !== workspaceRoot && !scriptAbs.startsWith(rootWithSep)) {
                    logWarn(`[schedules] Skipping ${file}: script_path "${schedule.script_path}" resolves outside workspace`);
                    continue;
                }
                // Security: only allow .py, .js, .sh extensions — no arbitrary executables
                const allowedExts = new Set(['.py', '.js', '.sh']);
                const scriptExt = path.extname(scriptAbs).toLowerCase();
                if (!allowedExts.has(scriptExt)) {
                    logWarn(`[schedules] Skipping ${file}: script_path extension "${scriptExt}" is not allowed (use .py, .js, or .sh)`);
                    continue;
                }

                const lastRunPath = path.join(schedulesDir, file.replace('.json', '.last_run.json'));
                let lastRunTs = 0;
                try { lastRunTs = JSON.parse(fs.readFileSync(lastRunPath, 'utf8')).ts ?? 0; } catch { /* never run */ }

                const hoursSince = (Date.now() - lastRunTs) / 3_600_000;
                if (hoursSince < schedule.interval_hours) { continue; }

                logInfo(`[schedules] Running overdue task: ${schedule.name} (${Math.floor(hoursSince)}h since last run)`);

                const { execFile } = require('child_process') as typeof import('child_process');
                const runner = scriptExt === '.py' ? 'python' : scriptExt === '.js' ? 'node' : 'bash';

                execFile(runner, [scriptAbs], { cwd: workspaceRoot, timeout: 300_000 }, (err, stdout, stderr) => {
                    const result = { ts: Date.now(), name: schedule.name, success: !err, stdout: stdout.slice(0, 2000), stderr: stderr.slice(0, 500) };
                    try { fs.writeFileSync(lastRunPath, JSON.stringify(result, null, 2), 'utf8'); } catch { /* ignore */ }

                    // Append result to task_log so the agent can query schedule history via shell_read
                    try {
                        const taskId  = schedule.name.replace(/[^a-z0-9_-]/gi, '_').slice(0, 64);
                        const taskDir = path.join(workspaceRoot, '.ollamaforge', 'tasks', taskId);
                        // Guard: taskDir must stay inside workspaceRoot (no path traversal)
                        if (!taskDir.startsWith(path.join(workspaceRoot, '.ollamaforge', 'tasks') + path.sep)) { throw new Error('Invalid task path'); }
                        if (!fs.existsSync(taskDir)) { fs.mkdirSync(taskDir, { recursive: true }); }
                        const logPath = path.join(taskDir, 'log.md');
                        const ts      = new Date().toISOString().replace('T', ' ').slice(0, 19);
                        if (!fs.existsSync(logPath)) {
                            fs.writeFileSync(logPath, `# Task: ${taskId} (scheduled)\n\nCreated: ${ts}\n`, 'utf8');
                        }
                        const status = err ? 'failed' : 'done';
                        const emoji  = err ? '✗' : '✅';
                        const body   = err
                            ? `Scheduled run failed: ${err.message}${stderr ? `\n  stderr: ${stderr.slice(0, 200)}` : ''}`
                            : `Scheduled run completed. Output: ${stdout.slice(0, 300)}`;
                        fs.appendFileSync(logPath, `\n### [${ts}] ${emoji} ${status.toUpperCase()}\n${body}\n`, 'utf8');
                    } catch { /* log append is best-effort */ }

                    if (err) {
                        logError(`[schedules] ${schedule.name} failed: ${err.message}`);
                    } else {
                        logInfo(`[schedules] ${schedule.name} completed. Output: ${stdout.slice(0, 200)}`);
                    }
                });
            } catch (e) {
                logError(`[schedules] Error processing ${file}: ${toErrorMessage(e)}`);
            }
        }
    }

    /**
     * Check if AGENTS.md (or CLAUDE.md / .ollamaforge.md) in the workspace root is stale.
     * If so, fire a silent background agent run to refresh it.
     * Controlled by `contextFile.autoUpdateDays` (0 = disabled).
     */
    private maybeRefreshContextFile(workspaceRoot: string): void {
        const cfg = getConfig();
        if (!cfg.contextFileAutoUpdateDays || cfg.contextFileAutoUpdateDays <= 0) { return; }

        const candidates = ['.ollamaforge.md', 'AGENTS.md', 'CLAUDE.md'];
        let contextFilePath: string | null = null;
        let ageMsDays = Infinity;

        for (const name of candidates) {
            const p = path.join(workspaceRoot, name);
            try {
                const stat = fs.statSync(p);
                const ageDays = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24);
                if (ageDays < ageMsDays) { ageMsDays = ageDays; contextFilePath = p; }
            } catch { /* file doesn't exist */ }
        }

        const targetFile = contextFilePath ? path.basename(contextFilePath) : 'AGENTS.md';
        const isStale = ageMsDays > cfg.contextFileAutoUpdateDays;
        const isMissing = contextFilePath === null;

        if (!isStale && !isMissing) { return; }

        // Don't run background AGENTS.md refresh while the user has an active session with recent messages.
        // The background agent uses the same model and its task prompt ("Scan this project and generate AGENTS.md")
        // can appear in the foreground model's reasoning when history is long, causing task-bleed spirals.
        // Threshold: ANY existing messages (>= 2 means at least 1 user turn exists). A fresh session
        // has 0 messages. A session loaded from storage with prior turns has >= 2 (user + assistant).
        const sessionMsgCount = this.currentSession?.messages?.length ?? 0;
        if (sessionMsgCount >= 2) {
            logInfo(`[context-file] Auto-refresh deferred — active session with ${sessionMsgCount} messages`);
            return;
        }

        const reason = isMissing ? 'no context file found' : `${targetFile} is ${Math.floor(ageMsDays)} days old`;
        logInfo(`[context-file] Auto-refresh triggered — ${reason} (threshold: ${cfg.contextFileAutoUpdateDays} days)`);

        const REFRESH_PROMPT = `Scan this project and generate (or update) an AGENTS.md file in the workspace root. The file should include:
1. One-paragraph project description (what it does, tech stack)
2. Directory structure overview (key folders and their purpose)
3. Coding conventions you can infer from reading the code (naming, error handling, return formats, DB patterns, etc.)
4. Key domains/modules — one line each explaining what each major file or group of files does
5. Any constraints or rules an AI agent should follow when making changes

Steps:
- Read the root directory listing
- Read package.json or requirements.txt to identify the stack
- Sample 3-5 representative source files to infer conventions
- If AGENTS.md already exists, read it first and update rather than replace
- Write the final file to AGENTS.md in the project root

Be specific and factual — only write what you can confirm from the code, not guesses.`;

        // Run silently in background — use a fresh agent so it doesn't pollute the current session history
        const backgroundAgent = new Agent(workspaceRoot, this.memory, this.codeIndexer);
        const model = cfg.model;
        const silentPost: PostFn = (m) => {
            const msg = m as { type: string; path?: string };
            if (msg.type === 'fileChanged' && msg.path) {
                logInfo(`[context-file] Auto-refresh wrote ${msg.path}`);
                this._view?.webview.postMessage({ type: 'contextFileRefreshed', path: msg.path });
            }
        };
        backgroundAgent.run(REFRESH_PROMPT, model, silentPost).then(() => {
            logInfo('[context-file] Auto-refresh complete');
        }).catch(err => {
            logInfo(`[context-file] Auto-refresh skipped: ${toErrorMessage(err)}`);
        });
    }

    private persistSession(): void {
        this.storage.upsert(this.currentSession);
        this._view?.webview.postMessage({
            type: 'sessionSaved',
            session: toSummary(this.currentSession),
        });
    }

    // ── HTML builder ──────────────────────────────────────────────────────────

    private async buildHtml(): Promise<string> {
        const read = async (rel: string): Promise<string> => {
            const uri = vscode.Uri.joinPath(this.context.extensionUri, rel);
            return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
        };

        // Load vendor bundle — gracefully degrade if missing (first build before vendor step)
        let hljs = '';
        try { hljs = await read('webview/vendor/highlight.bundle.js'); }
        catch { logInfo('[provider] highlight.bundle.js not found — syntax highlighting disabled'); }

        const [html, js] = await Promise.all([
            read('webview/webview.html'),
            read('webview/webview.js'),
        ]);

        const nonce = Array.from({ length: 32 }, () =>
            'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
                .charAt(Math.floor(Math.random() * 62))
        ).join('');

        const webview = this._view!.webview;
        const logoUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'images', 'logo.png')
        ).toString();
        const cspSource = webview.cspSource;

        return html
            .replace(/\{\{nonce\}\}/g, nonce)
            .replace(/\{\{cspSource\}\}/g, cspSource)
            .replace(/\{\{logoUri\}\}/g, logoUri)
            .replace('{{inlineHljs}}', () => hljs)
            .replace('{{inlineScript}}', () => js);
    }
}

// ── Diagnostics ───────────────────────────────────────────────────────────────

export async function runDiagnostics(): Promise<void> {
    channel.show(false);
    logInfo('━━━━━  DIAGNOSTICS  ━━━━━');
    logInfo(`Platform: ${process.platform}  Node: ${process.version}`);
    logInfo(`HTTP_PROXY: ${process.env.HTTP_PROXY ?? process.env.http_proxy ?? '(none)'}`);
    logInfo(`Extension storage: ${vscode.Uri.joinPath(vscode.extensions.getExtension('local-dev.ollama-agent')?.extensionUri ?? vscode.Uri.parse(''), '').fsPath}`);

    try {
        const { status, body } = await rawGet('/', 3000);
        logInfo(`Ollama root → HTTP ${status}: ${body.trim()}`);
    } catch (e) {
        logError(`Ollama unreachable: ${toErrorMessage(e)}`);
    }

    const models = await fetchModels();
    logInfo(`Available models: ${models.join(', ') || '(none)'}`);

    if (models.length) {
        let toks = 0;
        try {
            await streamChatRequest(
                models[0],
                [{ role: 'user', content: 'Say ok.' }],
                [],
                () => toks++,
                { stop: false }
            );
            logInfo(`Stream test OK — ${toks} tokens from ${models[0]}`);
        } catch (e) {
            logError(`Stream test failed: ${toErrorMessage(e)}`);
        }
    }

    logInfo('━━━━━  END  ━━━━━');
    vscode.window.showInformationMessage('Diagnostics done — check Output › Ollama Agent');
}
