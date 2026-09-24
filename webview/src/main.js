// ── History panel ─────────────────────────────────────────────────────────────

/** @type {string | null} Current active session id (for highlighting in the list) */
let activeSessionId = null;

function openHistoryPanel() {
    historyPanel.classList.add('open');
    historyBtn.classList.add('active');
    vscode.postMessage({ command: 'listSessions' });
}

function closeHistoryPanel() {
    historyPanel.classList.remove('open');
    historyBtn.classList.remove('active');
}

historyBtn.addEventListener('click', () => {
    historyPanel.classList.contains('open') ? closeHistoryPanel() : openHistoryPanel();
});
historyCloseBtn.addEventListener('click', closeHistoryPanel);

historyClearBtn.addEventListener('click', async () => {
    // VS Code webviews don't support confirm(), so we use a simple approach
    vscode.postMessage({ command: 'clearAllSessions' });
    closeHistoryPanel();
});

/**
 * @typedef {{ id: string, title: string, model: string, messageCount: number, updatedAt: number, relativeTime: string }} SessionSummary
 */

/**
 * @param {SessionSummary[]} sessions
 * @param {string | null} currentId
 */
function renderSessionList(sessions, currentId) {
    activeSessionId = currentId;
    historyList.innerHTML = '';

    if (!sessions.length) {
        const empty = document.createElement('div');
        empty.id = 'history-empty';
        empty.innerHTML = '<span style="font-size:24px;opacity:0.4">🕐</span><span>No saved chats yet.<br>Start a conversation to save it here.</span>';
        historyList.appendChild(empty);
        return;
    }

    sessions.forEach((s) => {
        const item = document.createElement('div');
        item.className = 'session-item' + (s.id === currentId ? ' active' : '');
        item.dataset.id = s.id;

        const info = document.createElement('div');
        info.className = 'session-info';

        const title = document.createElement('div');
        title.className = 'session-title';
        title.textContent = s.title;

        const meta = document.createElement('div');
        meta.className = 'session-meta';
        meta.innerHTML =
            `<span>${escHtml(s.relativeTime)}</span>` +
            `<span>${s.messageCount} msg${s.messageCount !== 1 ? 's' : ''}</span>` +
            `<span>${escHtml(s.model.split(':')[0])}</span>`;

        info.appendChild(title);
        info.appendChild(meta);

        const del = document.createElement('button');
        del.className = 'session-delete';
        del.title = 'Delete chat';
        del.textContent = '🗑';
        del.addEventListener('click', (e) => {
            e.stopPropagation();
            vscode.postMessage({ command: 'deleteSession', id: s.id });
        });

        item.appendChild(info);
        item.appendChild(del);

        item.addEventListener('click', () => {
            vscode.postMessage({ command: 'loadSession', id: s.id });
            closeHistoryPanel();
        });

        historyList.appendChild(item);
    });
}

// ── Load a stored session into the chat UI ────────────────────────────────────

/**
 * @param {SessionSummary} session
 * @param {Array<{role: string, content: string, timestamp: number}>} messages
 */
function renderStoredSession(session, messages, savedPins) {
    clearChat();
    activeSessionId = session.id;

    if (!messages.length) { return; }

    messages.forEach((msg) => {
        if (msg.role === 'user') {
            if (msg.content) { addUserMessage(msg.content, msg.timestamp); }
        } else if (msg.role === 'assistant') {
            if (msg.content) { addStoredAssistantMessage(msg.content, msg.timestamp); }
        } else if (msg.role === 'error') {
            addErrorMessage(msg.content);
        } else if (msg.role === 'tool_call') {
            if (msg.content) { addStoredToolCall(msg.content); }
        }
    });

    // Restore pinned messages
    if (savedPins && savedPins.length) {
        pinnedIds = new Set(savedPins);
        messagesEl.querySelectorAll('.message[data-msg-id]').forEach(m => {
            if (pinnedIds.has(m.dataset.msgId)) {
                m.querySelector('.pin-btn')?.classList.add('pinned');
            }
        });
        renderPinnedSection();
    }
}

/**
 * Add a completed assistant message (no streaming — render markdown immediately).
 * @param {string} content
 * @param {number} timestamp
 */
function addStoredAssistantMessage(content, timestamp) {
    hideWelcome();
    const div = document.createElement('div');
    div.className = 'message assistant';
    const ts = timestamp || Date.now();
    const absTime = new Date(ts).toLocaleString();
    const timeStr = relativeTimeStr(ts);
    const cleanContent = stripToolBlocksClient(content);
    div.innerHTML =
        `<div class="msg-header">` +
            `<span class="msg-role">Agent</span>` +
            `<time class="msg-time" data-ts="${ts}" title="${absTime}">${timeStr}</time>` +
            `<div class="msg-actions"><button class="msg-action-btn retry-btn" title="Retry">↺ Retry</button></div>` +
        `</div>` +
        `<div class="msg-content">${renderMarkdown(cleanContent)}</div>`;
    messagesEl.insertBefore(div, scrollBtn);
    assignMsgId(div);
    div.querySelector('.msg-header').appendChild(createPinBtn(div));
}

/**
 * Render a persisted tool-call summary (command + output) in the chat.
 * Content format: "✓ `cmd`\noutput..." or "✗ `cmd`\noutput..."
 * @param {string} content
 */
function addStoredToolCall(content) {
    hideWelcome();
    const lines = content.split('\n');
    const header = lines[0] || '';
    const output = lines.slice(1).join('\n').trim();
    const ok = header.startsWith('✓');
    const icon = ok ? '✓' : '✗';
    const cmdMatch = header.match(/`([^`]+)`/);
    const cmdText = cmdMatch ? cmdMatch[1] : header.replace(/^[✓✗]\s*/, '');

    const div = document.createElement('div');
    div.className = 'cmd-block stored-tool-call';
    div.style.opacity = '0.85';

    const headerEl = document.createElement('div');
    headerEl.className = 'cmd-header';
    headerEl.style.cursor = output ? 'pointer' : 'default';
    headerEl.innerHTML =
        `<span class="cmd-status ${ok ? 'cmd-ok' : 'cmd-err'}">${icon}</span>` +
        `<span class="cmd-name">${escHtml(cmdText)}</span>` +
        (output ? `<span class="cmd-toggle" style="margin-left:auto;font-size:0.75em;opacity:0.6">▶</span>` : '');

    div.appendChild(headerEl);

    if (output) {
        const bodyEl = document.createElement('pre');
        bodyEl.className = 'cmd-output';
        bodyEl.style.display = 'none';
        bodyEl.textContent = output;
        div.appendChild(bodyEl);

        headerEl.addEventListener('click', () => {
            const shown = bodyEl.style.display !== 'none';
            bodyEl.style.display = shown ? 'none' : 'block';
            const toggle = headerEl.querySelector('.cmd-toggle');
            if (toggle) { toggle.textContent = shown ? '▶' : '▼'; }
        });
    }

    messagesEl.insertBefore(div, scrollBtn);
}

// ── Update addUserMessage to accept an optional stored timestamp ──────────────
// (override the existing one)
function addUserMessage(text, timestamp) {
    hideWelcome();
    const div = document.createElement('div');
    div.className = 'message user';
    const ts = timestamp || Date.now();
    const absTime = new Date(ts).toLocaleString();
    div.innerHTML =
        `<div class="msg-header">` +
            `<span class="msg-role">You</span>` +
            `<time class="msg-time" data-ts="${ts}" title="${absTime}">${relativeTimeStr(ts)}</time>` +
        `</div>` +
        `<div class="msg-content">${escHtml(text).replace(/\n/g, '<br>')}</div>`;
    messagesEl.insertBefore(div, scrollBtn);
    assignMsgId(div);
    div.querySelector('.msg-header').appendChild(createPinBtn(div));
    userScrolledUp = false;
    scrollBottom(true);
}

// ── Tab bar ────────────────────────────────────────────────────────────────────

const tabBar = /** @type {HTMLElement} */ (document.getElementById('tab-bar'));
const tabAdd = /** @type {HTMLButtonElement} */ (document.getElementById('tab-add'));

/** @type {Array<{tabId: string, title: string, active: boolean}>} */
let tabList = [];

/**
 * Render the tab bar from the current tabList state.
 */
function renderTabBar() {
    // Remove existing tab buttons (keep the + button)
    tabBar.querySelectorAll('.tab-btn').forEach(el => el.remove());

    tabList.forEach((tab) => {
        const btn = document.createElement('button');
        btn.className = 'tab-btn' + (tab.active ? ' active' : '');
        btn.title = tab.title;
        btn.dataset.tabId = tab.tabId;

        const label = document.createElement('span');
        label.className = 'tab-label';
        // Show a spinner prefix for non-active running tabs so user knows work is happening
        label.textContent = (!tab.active && tab.running ? '⟳ ' : '') + tab.title;

        const closeBtn = document.createElement('button');
        closeBtn.className = 'tab-close';
        closeBtn.title = 'Close tab';
        closeBtn.textContent = '×';
        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            vscode.postMessage({ command: 'closeTab', tabId: tab.tabId });
        });

        btn.appendChild(label);
        btn.appendChild(closeBtn);

        btn.addEventListener('click', () => {
            if (!btn.classList.contains('active')) {
                // Clear any badge on this tab when switching to it
                btn.classList.remove('tab-badge-done', 'tab-badge-attention');
                // Save the current draft before switching so the provider can restore it later
                vscode.postMessage({ command: 'switchTab', tabId: tab.tabId, draft: promptEl.value });
            }
        });

        // Insert before the + button
        tabBar.insertBefore(btn, tabAdd);
    });

    // Always show the bar (so + is always accessible). Tab buttons are only shown when
    // there are 2+ tabs — with a single tab they're redundant and just waste space.
    tabBar.style.display = 'flex';
    const showTabs = tabList.length > 1;
    tabBar.querySelectorAll('.tab-btn').forEach(el => {
        /** @type {HTMLElement} */ (el).style.display = showTabs ? '' : 'none';
    });
}

tabAdd.addEventListener('click', () => {
    vscode.postMessage({ command: 'openTab' });
});

// ── Init ──────────────────────────────────────────────────────────────────────

try {
    setStatus('checking', 'Connecting…');
    // Request models + current editor context
    vscode.postMessage({ command: 'getModels' });
    vscode.postMessage({ command: 'getContext' });
} catch (initErr) {
    const el = document.getElementById('status-text');
    if (el) { el.textContent = 'Init error: ' + initErr.message; el.style.color = '#f44747'; }
    try { vscode.postMessage({ command: 'webviewError', text: '[webview init] ' + initErr.stack }); } catch(_) {}
}
