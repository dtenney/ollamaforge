// ── Send logic ────────────────────────────────────────────────────────────────

/** @param {boolean} on */
function setStreaming(on) {
    streaming = on;
    if (on) { agentActive = true; }
    sendBtn.disabled = on || modelSelect.value === '';
    stopBtn.classList.toggle('visible', on || agentActive);
    scrollBtn.classList.toggle('visible', (on || agentActive) && userScrolledUp);
    if (!on && !agentActive) {
        promptEl.focus();
        scrollBtn.classList.remove('visible');
    }
}

function sendMessage() {
    const text = promptEl.value.trim();
    if (!text || streaming) { return; }

    // Auto-deny any open confirmation cards so the new message proceeds unblocked.
    document.querySelectorAll('.confirm-card:not(.accepted):not(.rejected)').forEach(card => {
        const confirmId = card.id?.replace(/^confirm-/, '');
        if (confirmId) {
            vscode.postMessage({ command: 'confirmResponse', id: confirmId, accepted: false });
        }
        card.classList.add('rejected');
        const actions = card.querySelector('.confirm-actions');
        if (actions) { actions.innerHTML = '<span class="confirm-resolved">❌ Auto-denied (new message sent)</span>'; }
    });
    // Also clear the sticky confirm bar
    const bar = document.getElementById('pending-confirm-bar');
    if (bar) { bar.style.display = 'none'; bar.innerHTML = ''; }

    pushInputHistory(text);
    addUserMessage(text);
    promptEl.value = '';
    autoResize();
    hideMentionDropdown();
    setStreaming(true);
    // Show a waiting bubble immediately so there's no silent gap before streamStart
    startAssistantMessage();

    const filesToSend = mentionedFiles.map((f) => f.rel);
    const symbolsToSend = mentionedSymbols.map((s) => ({ name: s.name, filePath: s.filePath }));
    // Clear mention state after send
    mentionedFiles = [];
    mentionedSymbols = [];
    updateContextBar();
    updateTokenIndicator();

    vscode.postMessage({
        command: 'sendMessage',
        text,
        model: modelSelect.value,
        trustLevel: trustSelect.value,
        includeFile: ctx.includeFile,
        includeSelection: ctx.includeSelection,
        mentionedFiles: filesToSend,
        mentionedSymbols: symbolsToSend,
        pinnedFiles: pinnedFiles.map(f => f.rel),
    });
}

sendBtn.addEventListener('click', sendMessage);

stopBtn.addEventListener('click', () => {
    vscode.postMessage({ command: 'stopGeneration' });
    setStreaming(false);
});

// 4.4 Stop & explain: pause the run and ask the agent to state its current plan.
const pauseExplainBtn = /** @type {HTMLButtonElement} */ (document.getElementById('pause-explain-btn'));
if (pauseExplainBtn) {
    pauseExplainBtn.addEventListener('click', () => {
        vscode.postMessage({ command: 'pauseExplain' });
    });
}

const showTraceBtn = /** @type {HTMLButtonElement} */ (document.getElementById('show-trace-btn'));
if (showTraceBtn) {
    showTraceBtn.addEventListener('click', () => {
        vscode.postMessage({ command: 'showTrace' });
    });
}

promptEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});

// ── Global keyboard shortcuts ─────────────────────────────────────────────────

document.addEventListener('keydown', (e) => {
    // Ctrl+/ — focus the input textarea from anywhere in the panel
    if ((e.ctrlKey || e.metaKey) && e.key === '/') {
        e.preventDefault();
        promptEl.focus();
        promptEl.select();
        return;
    }
    // Escape — stop generation when streaming
    if (e.key === 'Escape' && (streaming || agentActive) && document.activeElement !== promptEl) {
        e.preventDefault();
        vscode.postMessage({ command: 'stopGeneration' });
        setStreaming(false);
        return;
    }
    // Ctrl+K — clear chat (only when not streaming)
    if ((e.ctrlKey || e.metaKey) && e.key === 'k' && !streaming && !agentActive) {
        e.preventDefault();
        vscode.postMessage({ command: 'newChat' });
        clearChat();
        return;
    }
});

// Auto-resize textarea
function autoResize() {
    promptEl.style.height = 'auto';
    promptEl.style.height = `${Math.min(promptEl.scrollHeight, 140)}px`;
}
promptEl.addEventListener('input', () => { autoResize(); updateTokenIndicator(); });

// ── Chat input history (↑/↓ arrow) ───────────────────────────────────────────

/** @type {string[]} */
const inputHistory = [];
let inputHistoryIdx = -1;
let inputHistoryDraft = '';
const MAX_INPUT_HISTORY = 50;

function pushInputHistory(text) {
    if (!text.trim()) { return; }
    // Deduplicate last entry
    if (inputHistory.length && inputHistory[inputHistory.length - 1] === text) { return; }
    inputHistory.push(text);
    if (inputHistory.length > MAX_INPUT_HISTORY) { inputHistory.shift(); }
    inputHistoryIdx = -1;
}

promptEl.addEventListener('keydown', (e) => {
    // Only activate when mention dropdown is hidden
    if (mentionDropdown.style.display !== 'none') { return; }
    if (e.key === 'ArrowUp' && inputHistory.length && inputHistoryIdx !== 0) {
        // Only hijack ArrowUp when navigating history (idx >= 0) or input is empty
        if (inputHistoryIdx === -1 && promptEl.value !== '') { return; }
        e.preventDefault();
        if (inputHistoryIdx === -1) { inputHistoryDraft = promptEl.value; inputHistoryIdx = inputHistory.length; }
        if (inputHistoryIdx > 0) {
            inputHistoryIdx--;
            promptEl.value = inputHistory[inputHistoryIdx];
            autoResize();
        }
        return;
    }
    if (e.key === 'ArrowDown' && inputHistoryIdx >= 0) {
        e.preventDefault();
        inputHistoryIdx++;
        if (inputHistoryIdx >= inputHistory.length) {
            inputHistoryIdx = -1;
            promptEl.value = inputHistoryDraft;
        } else {
            promptEl.value = inputHistory[inputHistoryIdx];
        }
        autoResize();
        return;
    }
});

// ── Slash commands ─────────────────────────────────────────────────────────

const SLASH_COMMANDS = {
    '/test':     { label: '/test',     desc: 'Generate tests for selection or file',   prompt: 'Write comprehensive tests for the following code. Use the project\'s existing test framework.\n\n' },
    '/fix':      { label: '/fix',      desc: 'Fix errors in selection or file',         prompt: 'Find and fix all bugs and errors in the following code. Explain each fix.\n\n' },
    '/review':   { label: '/review',   desc: 'Code review with suggestions',            prompt: 'Review the following code for bugs, security issues, performance problems, and style. Provide specific suggestions.\n\n' },
    '/doc':      { label: '/doc',      desc: 'Add documentation / comments',            prompt: 'Add clear, concise documentation comments to the following code. Use the language\'s standard doc format.\n\n' },
    '/explain':  { label: '/explain',  desc: 'Explain how this code works',             prompt: 'Explain the following code step by step in plain language.\n\n' },
    '/refactor': { label: '/refactor', desc: 'Refactor for clarity and maintainability', prompt: 'Refactor the following code to improve readability, maintainability, and performance. Show the changes.\n\n' },
    '/optimize': { label: '/optimize', desc: 'Optimize for performance',                prompt: 'Optimize the following code for performance. Explain the improvements.\n\n' },
    '/context':  { label: '/context',  desc: 'Generate or update AGENTS.md project context file', prompt: 'Scan this project and generate (or update) an AGENTS.md file in the workspace root. The file should include:\n1. One-paragraph project description (what it does, tech stack)\n2. Directory structure overview (key folders and their purpose)\n3. Coding conventions you can infer from reading the code (naming, error handling, return formats, DB patterns, etc.)\n4. Key domains/modules — one line each explaining what each major file or group of files does\n5. Any constraints or rules the agent should follow when making changes\n\nSteps:\n- Read the root directory listing\n- Read package.json or requirements.txt to identify the stack\n- Sample 3-5 representative source files to infer conventions\n- If AGENTS.md already exists, read it first and update rather than replace\n- Write the final file to AGENTS.md in the project root\n\nBe specific and factual — only write what you can confirm from the code, not guesses.' },
};

const slashDropdown = document.createElement('div');
slashDropdown.id = 'slash-dropdown';
slashDropdown.style.cssText = mentionDropdown.style.cssText;
slashDropdown.style.display = 'none';
document.getElementById('input-container').appendChild(slashDropdown);

let slashResults = [];
let slashSelectedIdx = 0;

function showSlashDropdown(filter) {
    const q = filter.toLowerCase();
    slashResults = Object.values(SLASH_COMMANDS).filter(c => c.label.includes(q) || c.desc.toLowerCase().includes(q));
    slashSelectedIdx = 0;
    slashDropdown.innerHTML = '';
    if (!slashResults.length) { slashDropdown.style.display = 'none'; return; }
    slashResults.forEach((c, i) => {
        const item = document.createElement('div');
        item.className = 'mention-item' + (i === 0 ? ' selected' : '');
        item.innerHTML = `<span class="mention-item-base">${escHtml(c.label)}</span><span class="mention-item-rel">${escHtml(c.desc)}</span>`;
        item.addEventListener('mousedown', (e) => { e.preventDefault(); selectSlashItem(i); });
        slashDropdown.appendChild(item);
    });
    slashDropdown.style.display = 'block';
}

function hideSlashDropdown() { slashDropdown.style.display = 'none'; slashResults = []; }

function updateSlashHighlight() {
    const items = slashDropdown.querySelectorAll('.mention-item');
    items.forEach((el, i) => el.classList.toggle('selected', i === slashSelectedIdx));
    items[slashSelectedIdx]?.scrollIntoView({ block: 'nearest' });
}

function selectSlashItem(idx) {
    const cmd = slashResults[idx];
    if (!cmd) { return; }
    // Replace the /command text with the expanded prompt (or just the command label if no prompt)
    promptEl.value = cmd.prompt ?? (cmd.label + ' ');
    autoResize();
    hideSlashDropdown();
    promptEl.focus();
    // Move cursor to end
    promptEl.selectionStart = promptEl.selectionEnd = promptEl.value.length;
}

// ── Commands panel (/  button) ────────────────────────────────────────────────

const commandsBtn  = /** @type {HTMLButtonElement} */ (document.getElementById('commands-btn'));
const commandsPanel = /** @type {HTMLDivElement}   */ (document.getElementById('commands-panel'));

/** Build and show the commands panel. */
function openCommandsPanel() {
    commandsPanel.innerHTML = '';
    const header = document.createElement('div');
    header.id = 'commands-panel-header';
    header.textContent = 'Commands';
    commandsPanel.appendChild(header);

    Object.values(SLASH_COMMANDS).forEach((cmd, i) => {
        const item = document.createElement('div');
        item.className = 'cmd-item';
        item.innerHTML =
            `<span class="cmd-item-label">${escHtml(cmd.label)}</span>` +
            `<span class="cmd-item-desc">${escHtml(cmd.desc)}</span>`;
        item.addEventListener('click', () => {
            promptEl.value = cmd.prompt ?? (cmd.label + ' ');
            autoResize();
            updateTokenIndicator();
            closeCommandsPanel();
            promptEl.focus();
            promptEl.selectionStart = promptEl.selectionEnd = promptEl.value.length;
        });
        commandsPanel.appendChild(item);
    });

    commandsPanel.style.display = 'block';
    commandsBtn.classList.add('active');
}

function closeCommandsPanel() {
    commandsPanel.style.display = 'none';
    commandsBtn.classList.remove('active');
}

function toggleCommandsPanel() {
    if (commandsPanel.style.display === 'none') {
        openCommandsPanel();
    } else {
        closeCommandsPanel();
    }
}

commandsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleCommandsPanel();
});

// Close panel when clicking outside it
document.addEventListener('click', (e) => {
    if (commandsPanel.style.display !== 'none' &&
        !commandsPanel.contains(/** @type {Node} */ (e.target)) &&
        e.target !== commandsBtn) {
        closeCommandsPanel();
    }
});

// Typing '/' at the start of an empty input also opens the panel
promptEl.addEventListener('keydown', (e) => {
    if (e.key === '/' && promptEl.value === '' && !e.ctrlKey && !e.metaKey) {
        // Let the character land, then open panel and clear the '/'
        setTimeout(() => {
            if (promptEl.value === '/') {
                promptEl.value = '';
                autoResize();
                openCommandsPanel();
            }
        }, 0);
    } else if (e.key === 'Escape' && commandsPanel.style.display !== 'none') {
        e.stopPropagation();
        closeCommandsPanel();
        promptEl.focus();
    }
});

// ── @mention autocomplete ─────────────────────────────────────────────────────

const EXT_ICONS = {
    ts:'🟦', tsx:'🟦', js:'🟨', jsx:'🟨', py:'🐍', rs:'🦀', go:'🐹',
    java:'☕', kt:'🟪', cs:'🔷', cpp:'⚙️', c:'⚙️', rb:'💎', php:'🐘',
    swift:'🍎', sh:'🖥️', bash:'🖥️', css:'🎨', scss:'🎨', html:'🌐',
    json:'📋', yaml:'📋', yml:'📋', md:'📝', sql:'🗄️', xml:'📄',
    toml:'📄', dockerfile:'🐳', lock:'🔒',
};
function fileIcon(ext) { return EXT_ICONS[ext] || '📄'; }

function showMentionDropdown(results) {
    mentionResults = results;
    mentionSelectedIdx = 0;
    mentionDropdown.innerHTML = '';

    if (!results.length) {
        mentionDropdown.style.display = 'none';
        return;
    }

    results.forEach((f, i) => {
        const item = document.createElement('div');
        item.className = 'mention-item' + (i === 0 ? ' selected' : '');
        item.dataset.idx = String(i);
        item.innerHTML =
            `<span class="mention-item-icon">${fileIcon(f.ext)}</span>` +
            `<span class="mention-item-base">${escHtml(f.display)}</span>` +
            `<span class="mention-item-rel">${escHtml(f.rel)}</span>`;
        item.addEventListener('mousedown', (e) => {
            e.preventDefault(); // keep textarea focused
            selectMentionItem(i);
        });
        mentionDropdown.appendChild(item);
    });

    mentionDropdown.style.display = 'block';
}

function hideMentionDropdown() {
    mentionDropdown.style.display = 'none';
    mentionAtStart = -1;
    mentionQuery = '';
    mentionResults = [];
    pinModeActive = false;
}

function selectMentionItem(idx) {
    const file = mentionResults[idx];
    if (!file) { return; }

    // Replace @query in textarea with empty string (the pill takes its place)
    const val = promptEl.value;
    const before = val.slice(0, mentionAtStart);
    const after  = val.slice(mentionAtStart + 1 + mentionQuery.length); // +1 for '@'
    promptEl.value = before + after;
    autoResize();

    // If pin mode, add to pinned files instead of mentioned files
    if (pinModeActive) {
        pinModeActive = false;
        if (!pinnedFiles.some((f) => f.rel === file.rel)) {
            pinnedFiles.push(file);
            vscode.postMessage({ command: 'updatePinnedFiles', files: pinnedFiles.map(f => f.rel) });
        }
        hideMentionDropdown();
        // Restore input to what it was before the @ was injected
        const val2 = promptEl.value;
        const before2 = val2.slice(0, mentionAtStart);
        const after2 = val2.slice(mentionAtStart + 1 + mentionQuery.length);
        promptEl.value = before2 + after2;
        autoResize();
        updateContextBar();
        updateTokenIndicator();
        return;
    }

    // Add to mentioned files (avoid duplicates)
    if (!mentionedFiles.some((f) => f.rel === file.rel)) {
        mentionedFiles.push(file);
        updateContextBar();
    }

    hideMentionDropdown();
    promptEl.focus();
    updateTokenIndicator();
}

function navigateMentionDropdown(direction) {
    if (!mentionResults.length) { return; }
    const items = mentionDropdown.querySelectorAll('.mention-item');
    items[mentionSelectedIdx]?.classList.remove('selected');
    mentionSelectedIdx = (mentionSelectedIdx + direction + mentionResults.length) % mentionResults.length;
    items[mentionSelectedIdx]?.classList.add('selected');
    items[mentionSelectedIdx]?.scrollIntoView({ block: 'nearest' });
}

promptEl.addEventListener('input', () => {
    const val = promptEl.value;
    const pos = promptEl.selectionStart ?? val.length;

    // Check for slash command at start of input
    if (val.startsWith('/') && !val.includes(' ') && !val.includes('\n')) {
        showSlashDropdown(val);
        return;
    }
    hideSlashDropdown();

    // Check if there's an active @ mention being typed
    const before = val.slice(0, pos);
    const atIdx = before.lastIndexOf('@');

    if (atIdx >= 0) {
        const fragment = before.slice(atIdx + 1);
        // Only trigger if no space in the query (space = @mention ended)
        if (!fragment.includes(' ') && !fragment.includes('\n')) {
            mentionAtStart = atIdx;
            mentionQuery = fragment;
            clearTimeout(mentionSearchTimer);
            mentionSearchTimer = setTimeout(() => {
                vscode.postMessage({ command: 'searchFiles', query: fragment });
            }, 150);
            return;
        }
    }

    // No active mention
    hideMentionDropdown();
    pinModeActive = false;
    updateTokenIndicator();
});

promptEl.addEventListener('keydown', (e) => {
    // Slash command dropdown navigation
    if (slashDropdown.style.display !== 'none') {
        if (e.key === 'ArrowDown')  { e.preventDefault(); slashSelectedIdx = (slashSelectedIdx + 1) % slashResults.length; updateSlashHighlight(); return; }
        if (e.key === 'ArrowUp')    { e.preventDefault(); slashSelectedIdx = (slashSelectedIdx - 1 + slashResults.length) % slashResults.length; updateSlashHighlight(); return; }
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); selectSlashItem(slashSelectedIdx); return; }
        if (e.key === 'Tab')        { e.preventDefault(); selectSlashItem(slashSelectedIdx); return; }
        if (e.key === 'Escape')     { hideSlashDropdown(); return; }
    }
    // @mention dropdown navigation
    if (mentionDropdown.style.display !== 'none') {
        if (e.key === 'ArrowDown')  { e.preventDefault(); navigateMentionDropdown(+1); return; }
        if (e.key === 'ArrowUp')    { e.preventDefault(); navigateMentionDropdown(-1); return; }
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); selectMentionItem(mentionSelectedIdx); return; }
        if (e.key === 'Escape')     { hideMentionDropdown(); return; }
        if (e.key === 'Tab')        { e.preventDefault(); selectMentionItem(mentionSelectedIdx); return; }
    }
});

// Hint chips (initial welcome screen)
document.querySelectorAll('.hint-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
        const hint = /** @type {HTMLButtonElement} */ (btn).dataset.hint;
        if (hint) { promptEl.value = hint; sendMessage(); }
    });
});

// ── Template handling ────────────────────────────────────────────────────────────

templateToggleBtn.addEventListener('click', () => {
    templateBarVisible = !templateBarVisible;
    templateBar.style.display = templateBarVisible ? 'block' : 'none';
    if (templateBarVisible) {
        vscode.postMessage({ command: 'getTemplates' });
    }
});

templateSelect.addEventListener('change', () => {
    const name = templateSelect.value;
    if (!name) return;
    
    const template = templates.find(t => t.name === name);
    if (!template) return;
    
    // Substitute variables with proper escaping to prevent corruption
    const values = {
        language: ctx.language || 'code',
        filename: ctx.file ? ctx.file.split('/').pop() : 'file',
        selection: ctx.selectionLines > 0 ? '(selected code)' : '(no selection)',
        error: '(error details)'
    };
    
    let prompt = template.prompt;
    // Sort keys by length (longest first) to prevent partial replacements
    // e.g., replace {languageId} before {language}
    const sortedKeys = Object.keys(values).sort((a, b) => b.length - a.length);
    for (const key of sortedKeys) {
        const value = values[key];
        prompt = prompt.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
    }
    
    promptEl.value = prompt;
    autoResize();
    updateTokenIndicator();
    templateSelect.value = ''; // Reset dropdown
    promptEl.focus();
});

function populateTemplates(templateList) {
    templates = templateList;
    templateSelect.innerHTML = '<option value="">Select a template...</option>';
    
    templateList.forEach(t => {
        const opt = document.createElement('option');
        opt.value = t.name;
        opt.textContent = t.builtin ? `⭐ ${t.name}` : t.name;
        templateSelect.appendChild(opt);
    });
}

// ── Smart context handling ────────────────────────────────────────────────────────────

smartContextToggle.addEventListener('change', () => {
    vscode.postMessage({ 
        command: 'toggleSmartContext', 
        enabled: smartContextToggle.checked 
    });
});

