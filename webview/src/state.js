// @ts-check
'use strict';

const vscode = acquireVsCodeApi();

// ── Debug: catch and report any JS errors back to the extension ───────────────
window.onerror = function(msg, src, line, col, err) {
    const detail = `[webview error] ${msg} at line ${line}:${col}\n${err?.stack || ''}`;
    try { vscode.postMessage({ command: 'webviewError', text: detail }); } catch(_) {}
    const el = document.getElementById('status-text');
    if (el) { el.textContent = 'JS Error — check Output panel'; el.style.color = '#f44747'; }
    console.error(detail);
};
window.onunhandledrejection = function(event) {
    const reason = event.reason;
    const detail = `[webview unhandled rejection] ${reason?.message || reason}\n${reason?.stack || ''}`;
    try { vscode.postMessage({ command: 'webviewError', text: detail }); } catch(_) {}
    console.error(detail);
};

// ── DOM refs ──────────────────────────────────────────────────────────────────
const messagesEl       = /** @type {HTMLDivElement}     */ (document.getElementById('messages'));
const welcomeEl        = /** @type {HTMLDivElement}     */ (document.getElementById('welcome'));
const promptEl         = /** @type {HTMLTextAreaElement} */ (document.getElementById('prompt'));
const sendBtn          = /** @type {HTMLButtonElement}  */ (document.getElementById('send-btn'));
const stopBtn          = /** @type {HTMLButtonElement}  */ (document.getElementById('stop-btn'));
const presetSelect     = /** @type {HTMLSelectElement}  */ (document.getElementById('preset-select'));
const modelSelect      = /** @type {HTMLSelectElement}  */ (document.getElementById('model-select'));
const trustSelect      = /** @type {HTMLSelectElement}  */ (document.getElementById('trust-select'));
const statusDot        = /** @type {HTMLSpanElement}    */ (document.getElementById('status-dot'));
const statusText       = /** @type {HTMLSpanElement}    */ (document.getElementById('status-text'));
const scrollBtn        = /** @type {HTMLButtonElement}  */ (document.getElementById('scroll-btn'));
const contextBar       = /** @type {HTMLDivElement}     */ (document.getElementById('context-bar'));
const historyBtn       = /** @type {HTMLButtonElement}  */ (document.getElementById('history-btn'));
const historyPanel     = /** @type {HTMLDivElement}     */ (document.getElementById('history-panel'));
const historyList      = /** @type {HTMLDivElement}     */ (document.getElementById('history-list'));
const historyCloseBtn  = /** @type {HTMLButtonElement}  */ (document.getElementById('history-close-btn'));
const historyClearBtn  = /** @type {HTMLButtonElement}  */ (document.getElementById('history-clear-btn'));
const mentionDropdown  = /** @type {HTMLDivElement}     */ (document.getElementById('mention-dropdown'));
const tokenIndicator   = /** @type {HTMLSpanElement}    */ (document.getElementById('token-indicator'));
const templateBar      = /** @type {HTMLDivElement}     */ (document.getElementById('template-bar'));
const templateSelect   = /** @type {HTMLSelectElement}  */ (document.getElementById('template-select'));
const templateToggleBtn = /** @type {HTMLButtonElement} */ (document.getElementById('template-toggle-btn'));
const smartContextToggle = /** @type {HTMLInputElement} */ (document.getElementById('smart-context-toggle'));
const searchBtn        = /** @type {HTMLButtonElement} */ (document.getElementById('search-btn'));
const searchPanel      = /** @type {HTMLDivElement}    */ (document.getElementById('search-panel'));
const searchInput      = /** @type {HTMLInputElement}  */ (document.getElementById('search-input'));
const searchResults    = /** @type {HTMLSpanElement}   */ (document.getElementById('search-results'));
const searchPrevBtn    = /** @type {HTMLButtonElement} */ (document.getElementById('search-prev'));
const searchNextBtn    = /** @type {HTMLButtonElement} */ (document.getElementById('search-next'));
const searchClearBtn   = /** @type {HTMLButtonElement} */ (document.getElementById('search-clear'));
const contextUsageEl   = /** @type {HTMLSpanElement}   */ (document.getElementById('context-usage'));
const compactBtnFooter = /** @type {HTMLButtonElement}  */ (document.getElementById('compact-btn-footer'));
const settingsBtn      = /** @type {HTMLButtonElement}  */ (document.getElementById('settings-btn'));

// ── State ─────────────────────────────────────────────────────────────────────

/** @type {HTMLDivElement | null} */
let currentMsgEl = null;
/** @type {string} */
let currentRaw = '';
let streaming = false;
/** True when the user has manually scrolled away from the bottom. */
let userScrolledUp = false;
/** Tracks whether we're currently inside a thinking block while streaming. */
let inThinkingBlock = false;
let thinkingBuf = '';
/** Last agentStatus turn info — used to restore status bar after toolCall overlay. */
let lastAgentTurn = /** @type {{ turn: number, maxTurns: number } | null} */ (null);

/** Model presets configuration — populated by extension on init (presetRestored message).
 *  Fallback values below are used only if the extension hasn't sent presets yet. */
let MODEL_PRESETS = {
    fast: { model: 'qwen3.8:27b', temperature: 0.5 },
    balanced: { model: 'qwen3.6:35b-a3b-32k', temperature: 0.7 },
    quality: { model: 'qwen3.6:35b-a3b-32k', temperature: 0.8 }
};

/** Current preset selection ('' = custom) */
let currentPreset = 'balanced';

/** Flags to prevent circular preset/model updates */
let updatingFromPreset = false;
let updatingFromModel = false;

/** Context state received from the extension. */
const ctx = {
    /** @type {string | null} */
    file: null,
    fileLines: 0,
    language: '',
    selectionLines: 0,
    includeFile: false,
    includeSelection: true,
};

// ── @mention state ────────────────────────────────────────────────────────────

/** Files the user has explicitly mentioned via @. [{rel, display, ext}] */
/** @type {Array<{rel: string, display: string, ext: string}>} */
let mentionedFiles = [];
let mentionedSymbols = [];
/** Position in textarea where the current @ query started (-1 = not active). */
let mentionAtStart = -1;
/** Current autocomplete query (text after @). */
let mentionQuery = '';
/** Currently highlighted dropdown item index. */
let mentionSelectedIdx = 0;
/** File results from the last searchFiles response. */
/** @type {Array<{rel: string, display: string, ext: string}>} */
let mentionResults = [];

/** Debounce timer for searchFiles — avoids a message per keystroke */
let mentionSearchTimer = null;
/** When true, next mention selection pins the file instead of @mentioning it */
let pinModeActive = false;

// ── Template state ────────────────────────────────────────────────────────────

/** Available templates (built-in + custom). */
/** @type {Array<{name: string, prompt: string, variables: string[], builtin?: boolean}>} */
let templates = [];
/** Whether template bar is visible. */
let templateBarVisible = false;

// ── Smart context state ────────────────────────────────────────────────────────────

/** Smart context files included in last message. */
/** @type {string[]} */
let smartContextFiles = [];

/** @type {Array<{rel: string, display: string, ext: string}>} Pinned files (always-in-context) */
let pinnedFiles = [];

// ── Search state ──────────────────────────────────────────────────────────────

/** Current search query. */
let searchQuery = '';
/** Array of message elements that match search. */
/** @type {HTMLElement[]} */
let searchMatches = [];
/** Current match index. */
let searchCurrentIndex = -1;

// ── Pin state ─────────────────────────────────────────────────────────────────
let pinnedIds = new Set();
let msgIdCounter = 0;
const pinnedSection = document.getElementById('pinned-section');
const pinnedList = document.getElementById('pinned-list');

// ── Token estimation state ────────────────────────────────────────────────────

/** Approximate context window sizes (tokens) for known model families. */
const MODEL_CONTEXT_WINDOWS = {
    'llama2':           4096,
    'llama3':           8192,
    'llama3.1':         8192,
    'llama3.2':         8192,
    'llama3.3':         8192,
    'qwen2.5':          8192,
    'qwen2.5-coder':   32768,
    'qwen3':           32768,
    'phi3':             4096,
    'phi3.5':           8192,
    'phi4':            16384,
    'codellama':       16384,
    'mistral':          8192,
    'mixtral':         32768,
    'gemma2':           8192,
    'gemma3':          32768,
    'gemma4':          131072,
    'deepseek-coder':  16384,
    'deepseek-r1':     32768,
    'starcoder2':      16384,
    'granite-code':     8192,
};

/** Estimate token count using the 4-chars-per-token heuristic. */
function estimateTokens(text) {
    return Math.ceil(text.length / 4);
}

/** Find the approximate context window for the selected model. */
function getContextWindow() {
    const model = modelSelect.value.toLowerCase();
    for (const [prefix, size] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
        if (model.startsWith(prefix)) { return size; }
    }
    return 8192; // safe default
}

/** Update the token indicator in the footer. */
function updateTokenIndicator() {
    if (!tokenIndicator) { return; }
    const promptText = promptEl.value;
    if (!promptText.trim()) {
        tokenIndicator.textContent = '';
        tokenIndicator.className = '';
        return;
    }

    // Estimate: prompt + any mentioned file content (rough chars / 4)
    let totalChars = promptText.length;
    // Add rough estimate for each mentioned file (we don't have content here,
    // use a conservative 500 tokens per mention as placeholder)
    totalChars += mentionedFiles.length * 2000;
    totalChars += pinnedFiles.length * 2000;
    if (ctx.includeFile && ctx.fileLines) { totalChars += ctx.fileLines * 40; }

    const estimated = estimateTokens(totalChars);
    const window = getContextWindow();
    const pct = estimated / window;

    if (pct >= 0.95) {
        tokenIndicator.textContent = `~${estimated.toLocaleString()} / ${window.toLocaleString()} tokens ⚠`;
        tokenIndicator.className = 'over';
    } else if (pct >= 0.75) {
        tokenIndicator.textContent = `~${estimated.toLocaleString()} tokens`;
        tokenIndicator.className = 'warn';
    } else if (estimated > 50) {
        tokenIndicator.textContent = `~${estimated.toLocaleString()} tokens`;
        tokenIndicator.className = '';
    } else {
        tokenIndicator.textContent = '';
        tokenIndicator.className = '';
    }
}

// ── Status helpers ────────────────────────────────────────────────────────────

/** @param {'connected'|'disconnected'|'checking'} state @param {string} text */
function setStatus(state, text) {
    statusDot.className = state;
    statusText.textContent = text;
}

