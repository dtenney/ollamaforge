// ── Model list ────────────────────────────────────────────────────────────────

/**
 * @param {string[]} models
 * @param {boolean} connected
 */
/** @type {string} Configured default model from settings */
let defaultModel = '';

function populateModels(models, connected, configuredModel) {
    modelSelect.innerHTML = '';
    if (configuredModel) { defaultModel = configuredModel; }
    if (!connected || !models.length) {
        setStatus('disconnected', 'Ollama not running — run: ollama serve');
        const o = document.createElement('option');
        o.textContent = 'No models';
        o.disabled = true;
        o.selected = true;
        modelSelect.appendChild(o);
        sendBtn.disabled = true;
        return;
    }
    models.forEach((name) => {
        const o = document.createElement('option');
        o.value = name;
        o.textContent = name;
        modelSelect.appendChild(o);
    });

    // Resolve the model to select: settings model first, then active preset,
    // then the first available model. Never silently default to models[0]
    // when the user has configured a different model — that caused the wrong
    // variant (e.g. qwen3.8:27b-128k) to be used instead of the configured one.
    let resolved = '';
    if (defaultModel && models.includes(defaultModel)) {
        resolved = defaultModel;
        // If settings model doesn't match the active preset, switch to custom
        if (currentPreset && MODEL_PRESETS[currentPreset] && MODEL_PRESETS[currentPreset].model !== defaultModel) {
            currentPreset = '';
            presetSelect.value = '';
        }
    } else if (currentPreset && MODEL_PRESETS[currentPreset]) {
        // Only apply preset when settings didn't specify a different model
        const config = MODEL_PRESETS[currentPreset];
        if (models.includes(config.model)) {
            resolved = config.model;
        }
    }
    if (!resolved) {
        resolved = models[0];
        console.warn(`[ollamaforge] Configured model "${defaultModel}" not found on server — falling back to "${resolved}". Available: ${models.join(', ')}`);
    }
    modelSelect.value = resolved;
    
    setStatus('connected', `${models.length} model${models.length > 1 ? 's' : ''} available`);
    sendBtn.disabled = false;
    promptEl.focus();
    updateTokenIndicator();
}

// Update token indicator when model changes (context window changes)
modelSelect.addEventListener('change', () => {
    updateTokenIndicator();
    // Skip if this change was triggered by a preset selection
    if (updatingFromPreset) { return; }
    // If user manually changes model, detect matching preset or set Custom
    updatingFromModel = true;
    const preset = findPresetForModel(modelSelect.value);
    if (preset) {
        currentPreset = preset;
        presetSelect.value = preset;
    } else {
        currentPreset = '';
        presetSelect.value = '';
    }
    vscode.postMessage({ command: 'setPreset', preset: currentPreset });
    updatingFromModel = false;
});

// Handle preset selection
presetSelect.addEventListener('change', () => {
    // Skip if this change was triggered by model selection
    if (updatingFromModel) { return; }
    
    const preset = presetSelect.value;
    currentPreset = preset;
    
    if (preset && MODEL_PRESETS[preset]) {
        const config = MODEL_PRESETS[preset];
        // Set flag to prevent modelSelect change handler from firing
        updatingFromPreset = true;
        modelSelect.value = config.model;
        updatingFromPreset = false;
        vscode.postMessage({ 
            command: 'setPreset', 
            preset,
            model: config.model,
            temperature: config.temperature
        });
    } else {
        vscode.postMessage({ command: 'setPreset', preset: '' });
    }
    
    updateTokenIndicator();
});

// Handle trust level selection
trustSelect.addEventListener('change', () => {
    const level = trustSelect.value;
    trustSelect.className = level === 'yolo' ? 'trust-yolo' : level === 'trust' ? 'trust-trust' : '';
    vscode.postMessage({ command: 'setTrustLevel', level });
    // Update any open confirm cards — "Accept All" is only valid in Normal mode.
    // Cards rendered at the old trust level may show/hide the button incorrectly.
    document.querySelectorAll('.confirm-btn.accept-all').forEach(btn => {
        btn.style.display = level === 'normal' ? '' : 'none';
    });
});

/** Find preset name for a given model, or null if custom */
function findPresetForModel(model) {
    for (const [name, config] of Object.entries(MODEL_PRESETS)) {
        if (config.model === model) { return name; }
    }
    return null;
}

