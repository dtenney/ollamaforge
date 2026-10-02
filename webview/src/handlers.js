// ── Message handler (extension → webview) ────────────────────────────────────

/** @type {Record<string, (msg: any) => void>} */
const msgHandlers = {

    models: (msg) => {
        populateModels(msg.models, msg.connected, msg.defaultModel);
    },

    streamStart: (msg) => {
        // Only create a new bubble if sendMessage() hasn't already created one
        if (!currentMsgEl) { startAssistantMessage(); }
    },

    token: (msg) => {
        appendToken(msg.text);
    },

    streamEnd: (msg) => {
        finalizeMessage();
        setStreaming(false);
    },

    agentStatus: (msg) => {
        // Update the status bar with current turn progress or sub-agent activity.
        // phase: 'thinking' = main loop turn N/MAX, 'subagent' = waiting on a sub-agent.
        if (msg.phase === 'subagent') {
            const preview = msg.subagentPrompt ? ` — ${String(msg.subagentPrompt).slice(0, 50)}…` : '';
            statusText.textContent = `🤖 Sub-agent running${preview}`;
        } else if (msg.turn && msg.maxTurns) {
            lastAgentTurn = { turn: msg.turn, maxTurns: msg.maxTurns };
            statusText.textContent = `⚙ Agent turn ${msg.turn}/${msg.maxTurns}`;
        }
    },

    agentDone: (msg) => {
        agentActive = false;
        stopBtn.classList.remove('visible');
        scrollBtn.classList.remove('visible');
        sendBtn.disabled = modelSelect.value === '';
        promptEl.focus();
        // Restore status bar to connection state
        statusText.textContent = modelSelect.value ? '● Connected' : 'No model selected';
        // Clear any stale pending-confirm bar when agent finishes
        { const b = document.getElementById('pending-confirm-bar'); if (b) { b.style.display = 'none'; b.innerHTML = ''; } }
        // Sweep tool cards still showing a spinner (toolCall with no matching toolResult)
        document.querySelectorAll('.tool-card:not(.success):not(.error) .dots').forEach(dots => {
            dots.remove();
        });
    },

    stoppedByUser: (_msg) => { /* stop is shown inline — no bar needed */ },

    sessionTrace: (msg) => {
        renderTracePanel(msg);
    },

    info: (msg) => {
        // Warning-level info (starts with ⚠️) gets a persistent markdown bubble — the user needs
        // time to read it and act on it. Everything else gets the transient fading note.
        if (/^⚠/.test((msg.text || '').trim())) {
            appendWarningBubble(msg.text);
        } else {
            appendSystemNote(msg.text);
        }
    },

    dispatchQueued: (msg) => {
        // Extension is re-sending a queued message after the previous run finished.
        // Re-post it directly to the extension — bypass the normal send path so we
        // don't need to re-render the input or touch prompt state.
        // Guard: if agentDone hasn't arrived yet, retry after a short delay rather than dropping.
        if (msg.msg) {
            const doDispatch = () => {
                if (!agentActive) {
                    setStreaming(true);
                    startAssistantMessage();
                    vscode.postMessage(msg.msg);
                } else {
                    // agentDone not yet processed -- retry once more after another tick
                    setTimeout(doDispatch, 200);
                }
            };
            doDispatch();
        }
    },

    toolCall: (msg) => {
        // If a waiting bubble exists with no content yet, remove it — tool cards replace it.
        // We re-add a "still working" stub after the tool card so the user can see activity.
        if (currentMsgEl && !currentRaw) { currentMsgEl.remove(); currentMsgEl = null; }
        addToolCard(msg.id, msg.name, msg.args);
        // Show tool name in status bar so the user always sees what the agent is doing,
        // even when the model emits no narration text before the tool call.
        const toolIcon = TOOL_ICONS[msg.name] || '🔧';
        const toolLabel = String(msg.args?.command ?? msg.args?.query ?? msg.args?.path ?? msg.args?.search ?? '').slice(0, 50);
        statusText.textContent = `${toolIcon} ${msg.name}${toolLabel ? ` — ${toolLabel}` : ''}`;
    },

    toolResult: (msg) => {
        updateToolCard(msg.id, msg.success, msg.preview ?? '', msg.fullResult ?? '');
        // Restore turn-progress status after tool completes (overwritten by toolCall handler)
        if (agentActive && lastAgentTurn) {
            statusText.textContent = `⚙ Agent turn ${lastAgentTurn.turn}/${lastAgentTurn.maxTurns}`;
        }
    },

    runEnd: (msg) => {
        // Safety-net cleanup fired from inside agent.run() before provider posts agentDone.
        // agentDone arrives immediately after and is fully idempotent, so no harm if both fire.
        // Guard on agentActive so a late-arriving runEnd after agentDone is a no-op.
        if (agentActive) {
            agentActive = false;
            stopBtn.classList.remove('visible');
            scrollBtn.classList.remove('visible');
            sendBtn.disabled = modelSelect.value === '';
            setStreaming(false);
            statusText.textContent = modelSelect.value ? '● Connected' : 'No model selected';
        }
        // Sweep any tool cards that are still showing a spinner (toolCall dispatched but
        // no toolResult arrived — e.g. agent hit isPostEditSummary and broke out early).
        document.querySelectorAll('.tool-card:not(.success):not(.error) .dots').forEach(dots => {
            dots.remove();
        });
    },

    error: (msg) => {
        addErrorMessage(msg.text);
        agentActive = false;
        setStreaming(false);
        statusText.textContent = modelSelect.value ? '● Connected' : 'No model selected';
    },

    timeoutRetry: (msg) => {
        addTimeoutRetryCard(msg.attempt, msg.delayS);
    },

    turnLimit: (msg) => {
        addTurnLimitCard(msg.text, msg.canAutoContinue, msg.longSession);
        agentActive = false;
        setStreaming(false);
        statusText.textContent = modelSelect.value ? '● Connected' : 'No model selected';
    },

    clearChat: (msg) => {
        clearChat();
        activeSessionId = null; // reset until sessionLoaded or sessionSaved arrives
        // Clear the input box and input history state when switching tabs
        promptEl.value = '';
        autoResize();
        inputHistoryIdx = -1;
        inputHistoryDraft = '';
    },

    removeLastAssistant: (msg) => {
        removeLastAssistantMsg();
    },

    commandStart: (msg) => {
        addCommandBlock(msg.id, msg.cmd);
    },

    commandChunk: (msg) => {
        appendCommandChunk(msg.id, msg.text, msg.stream);
    },

    commandEnd: (msg) => {
        finalizeCommandBlock(msg.id, msg.exitCode);
    },

    subagentStart: (msg) => {
        addSubagentCard(msg.id, msg.prompt);
    },

    subagentChunk: (msg) => {
        appendSubagentChunk(msg.id, msg.text);
    },

    subagentTool: (msg) => {
        updateSubagentTool(msg.id, msg.name);
    },

    subagentEnd: (msg) => {
        finalizeSubagentCard(msg.id, msg.status, msg.turns, msg.filesChanged);
    },

    reasoningCard: (msg) => {
        addReasoningCard(msg);
    },

    planCard: (msg) => {
        addPlanCard(msg);
    },

    planProgress: (msg) => {
        addPlanProgress(msg);
    },

    planComplete: (msg) => {
        addPlanComplete();
    },

    fileChanged: (msg) => {
        addFileToast(msg.path, msg.action);
    },

    modeSwitch: (msg) => {
        addModeNotice(msg.model);
    },

    tabList: (msg) => {
        tabList = msg.tabs || [];
        renderTabBar();
    },

    tabBadge: (msg) => {
        // A background tab finished or needs attention — add a dot to its button
        const badgeBtn = tabBar.querySelector(`.tab-btn[data-tab-id="${CSS.escape(msg.tabId)}"]`);
        if (badgeBtn && !badgeBtn.classList.contains('active')) {
            badgeBtn.classList.remove('tab-badge-done', 'tab-badge-attention');
            badgeBtn.classList.add(msg.badge === 'done' ? 'tab-badge-done' : 'tab-badge-attention');
        }
    },

    sessionList: (msg) => {
        renderSessionList(msg.sessions, msg.currentId);
    },

    sessionLoaded: (msg) => {
        renderStoredSession(msg.session, msg.messages, msg.pinnedMsgIds);
        // Always land at the bottom of the conversation when a tab is (re)loaded.
        // userScrolledUp/streaming state is stale from the previous tab, so force it.
        // Defer to rAF so the browser has finished layout before we read scrollHeight.
        userScrolledUp = false;
        scrollBtn.classList.remove('visible');
        // Scroll directly (bypasses scrollBottom gating) — once after layout
        // (rAF) and again after late messages (trustLevelRestored, tabList) settle.
        requestAnimationFrame(() => {
            messagesEl.scrollTop = messagesEl.scrollHeight;
            setTimeout(() => { messagesEl.scrollTop = messagesEl.scrollHeight; }, 150);
        });
        if (msg.resumeSummary) { showResumeBanner(msg.resumeSummary); }
        // Restore the draft the user had typed in this tab before switching away
        if (msg.draft !== undefined) {
            promptEl.value = msg.draft;
            autoResize();
        }
        // Restore agent-active state if this tab still has a running agent
        if (msg.agentRunning) {
            agentActive = true;
            stopBtn.classList.add('visible');
            setStreaming(false); // show stop btn but don't animate send btn (we're not streaming right now)
            // Show a subtle status line so user knows agent is between turns (not stuck)
            setStatus('running', 'Agent working in background…');
            // Reattach the in-progress assistant bubble so the user sees the
            // live output that was suppressed while this tab was in the background.
            // Subsequent 'token' events append to currentRaw and re-render.
            if (msg.liveBuffer && msg.liveBuffer.trim()) {
                startAssistantMessage(); // also resets inThinkingBlock, thinkingBuf
                currentRaw = msg.liveBuffer;
                const content = currentMsgEl?.querySelector('.msg-content');
                if (content) {
                    let display = stripToolBlocksClient(msg.liveBuffer);
                    display = display.replace(/\btool>\s*/gi, '').replace(/<\/tool(?:_call)?>/gi, '').replace(/<\/?(?:parameter|function)>/gi, '');
                    // Strip THINK sentinel blocks from the restored buffer — they've already
                    // been processed server-side and would render as garbage if left in.
                    display = display.replace(/\x01THINK_START\x01[\s\S]*?\x01THINK_END\x01/g, '');
                    display = display.replace(/\x01THINK_(?:START|END|HEADLINE)\x01[^\n]*/g, '');
                    content.innerHTML = renderMarkdown(display.trim());
                }
                scrollBottom();
            }
        }
    },

    sessionSaved: (msg) => {
        // Update active session id and refresh title in history panel if open
        activeSessionId = msg.session.id;
        if (msg.session.title && historyPanel.classList.contains('open')) {
            const titleEl = historyList.querySelector(`.session-item[data-id="${CSS.escape(msg.session.id)}"] .session-title`);
            if (titleEl) { titleEl.textContent = msg.session.title; }
        }
    },

    contextUpdate: (msg) => {
        ctx.file           = msg.file ?? null;
        ctx.fileLines      = msg.fileLines ?? 0;
        ctx.language       = msg.language ?? '';
        ctx.selectionLines = msg.selectionLines ?? 0;
        if (!ctx.file)           { ctx.includeFile = false; }
        if (!ctx.selectionLines) { ctx.includeSelection = false; }
        updateContextBar();
        updateTokenIndicator();
    },

    fileSearchResults: (msg) => {
        // Only apply if the query matches the current active mention
        if (msg.query === mentionQuery) {
            showMentionDropdown(msg.files ?? []);
        }
    },

    presetRestored: (msg) => {
        // Store presets sent from the extension (replaces stale hardcoded values)
        if (msg.presets && typeof msg.presets === 'object') {
            MODEL_PRESETS = msg.presets;
        }
        // Restore preset selection from workspace state, but settings model takes priority
        if (msg.preset && MODEL_PRESETS[msg.preset]) {
            const config = MODEL_PRESETS[msg.preset];
            // Only restore preset if it doesn't conflict with the settings-configured model
            if (!defaultModel || defaultModel === config.model) {
                currentPreset = msg.preset;
                presetSelect.value = msg.preset;
                const modelExists = Array.from(modelSelect.options).some(opt => opt.value === config.model);
                if (modelExists && (modelSelect.value === config.model || modelSelect.value === '')) {
                    modelSelect.value = config.model;
                }
            } else {
                // Settings model differs from preset — stay on custom
                currentPreset = '';
                presetSelect.value = '';
            }
        }
    },

    sendFromCommand: (msg) => {
        // Handle programmatic message send (e.g., from Explain Selection)
        promptEl.value = msg.text;
        ctx.includeFile = msg.includeFile ?? false;
        ctx.includeSelection = msg.includeSelection ?? false;
        updateContextBar();
        sendMessage();
    },

    templates: (msg) => {
        populateTemplates(msg.templates ?? []);
    },

    smartContextRestored: (msg) => {
        smartContextToggle.checked = msg.enabled ?? false;
    },

    trustLevelRestored: (msg) => {
        const lvl = msg.level ?? 'normal';
        trustSelect.value = lvl;
        trustSelect.className = lvl === 'yolo' ? 'trust-yolo' : lvl === 'trust' ? 'trust-trust' : '';
    },

    pinnedFilesRestored: (msg) => {
        pinnedFiles = (msg.files ?? []).map(f => ({
            rel: f.rel,
            display: f.rel.split('/').pop() || f.rel,
            ext: (f.rel.split('.').pop() || '').toLowerCase()
        }));
        updateContextBar();
    },

    smartContextFiles: (msg) => {
        smartContextFiles = msg.files ?? [];
        // Show notification about included files
        if (smartContextFiles.length > 0) {
            const fileList = smartContextFiles.join(', ');
            console.log(`[smart-context] Auto-included: ${fileList}`);
        }
    },

    compactingStarted: (msg) => {
        // Create a placeholder that summary tokens will stream into
        const el = document.createElement('div');
        el.id = 'compaction-in-progress';
        el.className = 'msg system-msg compaction-summary';
        const lbl = document.createElement('span');
        lbl.className = 'system-label';
        lbl.textContent = '📦 Compacting — generating summary…';
        const body = document.createElement('div');
        body.className = 'summary-body';
        body.style.fontStyle = 'italic';
        body.style.opacity = '0.7';
        el.appendChild(lbl);
        el.appendChild(body);
        messagesEl.insertBefore(el, scrollBtn);
        scrollBottom();
        if (compactBtnFooter) { compactBtnFooter.textContent = 'Compacting…'; compactBtnFooter.disabled = true; }
    },

    compactSummaryToken: (msg) => {
        const el = document.getElementById('compaction-in-progress');
        if (el) {
            const body = el.querySelector('.summary-body');
            if (body) { body.textContent += msg.token; scrollBottom(); }
        }
    },

    contextWarning: (msg) => {
        if (msg.level === 'warning') {
            addContextToast('suggest',
                `Context at ${Math.round(msg.percentage)}% — good time to compact or start a new chat.`);
        } else {
            addContextToast('warning',
                `Context at ${Math.round(msg.percentage)}% — responses may be truncated soon.`);
        }
    },

    contextCompacted: (msg) => {
        if (compactBtnFooter) { compactBtnFooter.textContent = 'Compact'; compactBtnFooter.disabled = false; }
        // Find or create the compaction card
        let card = document.getElementById('compaction-in-progress');
        if (!card) {
            card = document.createElement('div');
            card.id = 'compaction-in-progress';
            card.className = 'msg system-msg compaction-summary';
            const lbl = document.createElement('span');
            lbl.className = 'system-label';
            card.appendChild(lbl);
            const body = document.createElement('div');
            body.className = 'summary-body';
            card.appendChild(body);
            messagesEl.insertBefore(card, scrollBtn);
        }
        // Update label
        const lbl = card.querySelector('.system-label');
        if (lbl) { lbl.textContent = `📦 Compacted — ${msg.messagesRemoved} message${msg.messagesRemoved !== 1 ? 's' : ''} removed. Context now at ${Math.round(msg.newPercentage)}%.`; }
        // Render summary as markdown if present
        const body = card.querySelector('.summary-body');
        if (body) {
            if (msg.summary) {
                body.style.fontStyle = '';
                body.style.opacity = '';
                body.innerHTML = renderMarkdown(msg.summary);
            } else {
                body.remove();
            }
        }
        scrollBottom();
        updateTokenIndicator();
    },

    contextOverflow: (msg) => {
        addContextToast('overflow',
            `Context overflow — oldest messages were dropped. ${msg.dropped} messages removed.`);
        updateTokenIndicator();
    },

    contextStats: (msg) => {
        updateTokenIndicator();
    },

    undoResult: (msg) => {
        addUndoCard(msg);
    },

    confirmAction: (msg) => {
        addConfirmCard(msg.id, msg.action, msg.detail, msg.toolName, msg.trustLevel);
    },

    askUser: (msg) => {
        addAskCard(msg.id, msg.question, msg.options || [], Boolean(msg.allowFreeText));
    },

    autoApproved: (msg) => {
        // Show a small toast for batch-approved actions (no buttons needed)
        const autoIcons = { run: '⚡', write: '💾', rename: '🔄', delete: '🗑️', edit: '✏️' };
        const autoIcon = autoIcons[msg.action] || '✅';
        addFileToastSimple(autoIcon, `Auto-approved: ${msg.detail}`);
    },

    dismissConfirmation: (msg) => {
        // Agent was stopped or a new turn started — dismiss any open confirmation cards
        const openCards = messagesEl.querySelectorAll('.confirm-card:not(.accepted):not(.rejected)');
        openCards.forEach(card => {
            card.classList.add('rejected');
            const actions = card.querySelector('.confirm-actions');
            if (actions) { actions.innerHTML = '<span class="confirm-resolved">⏹ Dismissed</span>'; }
        });
        // Clear sticky bar
        const pendingBarDismiss = document.getElementById('pending-confirm-bar');
        if (pendingBarDismiss) { pendingBarDismiss.style.display = 'none'; pendingBarDismiss.innerHTML = ''; }
    }
};

window.addEventListener('message', (event) => {
    const handler = msgHandlers[event.data.type];
    if (handler) { handler(event.data); }
});
