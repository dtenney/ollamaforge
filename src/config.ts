import * as vscode from 'vscode';

const SECTION = 'ollamaForge';

// ── Model Presets ─────────────────────────────────────────────────────────────

export interface ModelPreset {
    name: string;
    model: string;
    temperature: number;
    description: string;
}

export const MODEL_PRESETS: Record<string, ModelPreset> = {
    fast: {
        name: 'Fast',
        model: 'qwen2.5-coder:7b',
        temperature: 0.5,
        description: 'Quick responses, lower quality'
    },
    balanced: {
        name: 'Balanced',
        model: 'qwen3.6:35b-a3b-32k',
        temperature: 0.7,
        description: 'Good balance of speed and quality'
    },
    quality: {
        name: 'Quality',
        model: 'qwen3.6:35b-a3b-32k',
        temperature: 0.8,
        description: 'Best quality, slower responses'
    }
};

export interface OllamaConfig {
    /** Ollama server URL, e.g. "http://localhost:11434". */
    baseUrl: string;
    /** User-specified context window override (0 = auto-detect from Ollama) */
    contextWindow: number;
    model: string;
    temperature: number;
    systemPrompt: string;
    autoIncludeFile: boolean;
    autoIncludeSelection: boolean;
    /** Maximum number of workspace files to auto-load as context. */
    maxContextFiles: number;
    /** When true, inject a concise git diff into every message for change-aware context. */
    injectGitDiff: boolean;
    /** When true, AI automatically saves important information to memory as it discovers it. */
    autoSaveMemory: boolean;
    /** When true, automatically compact context when it reaches 99% of model's limit. */
    autoCompactContext: boolean;
    /** When true, pass think:true to Ollama for models that support chain-of-thought reasoning (e.g. qwen3). */
    enableThinking: boolean;
    /** Maximum agent turns per session (0 = use built-in defaults per task type). */
    maxTurnsPerSession: number;
    // ── Multi-model routing ────────────────────────────────────────────────────
    /** Model to use for read-only / exploration turns (shell_read, memory_search). Empty = use main model. */
    fastModel: string;
    /** Model to use for the critic review pass after edits. Empty = use main model. */
    criticModel: string;
    /** Enable automatic multi-model routing based on operation type. */
    modelRoutingEnabled: boolean;
    /** Model to use for the dream cycle. Empty = use main model. */
    dreamModel: string;
    /** Days before AGENTS.md is considered stale and auto-refresh is triggered on workspace open. 0 = disabled. */
    contextFileAutoUpdateDays: number;
    /** How long Ollama keeps the model loaded in GPU memory between requests (e.g. "10m", "1h", "0" to unload immediately). */
    keepAlive: string;
    /** reasoning_effort for Qwen3.8+ models: "low", "medium", or "xhigh". Empty = use model default (xhigh). */
    reasoningEffort: string;
}

// ── Model routing helpers ─────────────────────────────────────────────────────

export type OperationType = 'read' | 'write' | 'critic' | 'default';

/**
 * Resolve which model to use for a given operation type.
 * Falls back to the base model when no specialist model is configured.
 */
export function resolveModelForOperation(cfg: OllamaConfig, op: OperationType): string {
    if (!cfg.modelRoutingEnabled) { return cfg.model; }
    switch (op) {
        case 'read':   return cfg.fastModel   || cfg.model;
        case 'critic': return cfg.criticModel || cfg.model;
        default:       return cfg.model;
    }
}

/** Validate that a URL uses only http: or https: scheme (SSRF guard — CWE-918). */
function validateBaseUrl(raw: string): string {
    try {
        const parsed = new URL(raw);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
            return 'http://localhost:11434';
        }
        return raw;
    } catch {
        return 'http://localhost:11434';
    }
}

export function getConfig(): OllamaConfig {
    const c = vscode.workspace.getConfiguration(SECTION);
    const baseUrl = validateBaseUrl(
        (c.get<string>('serverUrl', '').trim().replace(/\/$/, '')) || 'http://localhost:11434'
    );

    return {
        baseUrl,
        contextWindow: c.get<number>('contextWindow', 0),
        model:                c.get<string> ('model',                'qwen3.6:35b-a3b-32k'),
        temperature:          c.get<number> ('temperature',          0.7),
        systemPrompt:         c.get<string> ('systemPrompt',         ''),
        autoIncludeFile:      c.get<boolean>('autoIncludeFile',      false),
        autoIncludeSelection: c.get<boolean>('autoIncludeSelection', true),
        maxContextFiles:      c.get<number> ('maxContextFiles',      5),
        injectGitDiff:        c.get<boolean>('injectGitDiff',        false),
        autoSaveMemory:       c.get<boolean>('memory.autoSave',      false),
        autoCompactContext:   c.get<boolean>('autoCompactContext',   true),
        enableThinking:       c.get<boolean>('enableThinking',       true),
        maxTurnsPerSession:   c.get<number> ('maxTurnsPerSession',   0),
        fastModel:                 c.get<string> ('routing.fastModel',             ''),
        criticModel:               c.get<string> ('routing.criticModel',            ''),
        modelRoutingEnabled:       c.get<boolean>('routing.enabled',                false),
        dreamModel:                c.get<string> ('dreamModel',                     ''),
        contextFileAutoUpdateDays: c.get<number> ('contextFile.autoUpdateDays',     7),
        keepAlive:                 c.get<string> ('keepAlive',                      '10m'),
        reasoningEffort:           c.get<string> ('reasoningEffort',                 ''),
    };
}

export interface SearchConfig {
    /** SearXNG base URL, e.g. "http://192.168.1.100:8888". Empty = disabled. */
    url: string;
    /** Max results per query (default 5). */
    resultsLimit: number;
}

export function getSearchConfig(): SearchConfig {
    const c = vscode.workspace.getConfiguration(SECTION);
    return {
        url:          c.get<string>('search.url', '').trim().replace(/\/$/, ''),
        resultsLimit: c.get<number>('search.resultsLimit', 5),
    };
}


export interface ComfyUIConfig {
    /** Base URL of the ComfyUI server, e.g. "http://192.168.1.100:8188". Empty = disabled. */
    url: string;
}

export function getComfyUIConfig(): ComfyUIConfig {
    const c = vscode.workspace.getConfiguration(SECTION);
    return {
        url: c.get<string>('comfyui.url', '').trim().replace(/\/$/, ''),
    };
}

/** Parse a base URL string into hostname + port for use with http.request. */
export function parseBaseUrl(baseUrl: string): { hostname: string; port: number; protocol: string } {
    try {
        const u = new URL(baseUrl);
        const defaultPort = u.protocol === 'https:' ? 443 : 80;
        return {
            hostname: u.hostname,
            port: u.port ? parseInt(u.port, 10) : defaultPort,
            protocol: u.protocol,
        };
    } catch {
        // Fallback: assume localhost:11434
        return { hostname: 'localhost', port: 11434, protocol: 'http:' };
    }
}
