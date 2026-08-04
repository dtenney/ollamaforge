/**
 * Context calculator for monitoring token usage and model limits.
 * Provides utilities for estimating context size and determining when to compact.
 */

import { OllamaMessage, fetchModelInfo, tokenizeText } from './ollamaClient';
import { logInfo, logWarn, logError, toErrorMessage } from './logger';
import { getConfig } from './config';

/** Message overhead tokens for role and structure */
const MESSAGE_OVERHEAD_TOKENS = 10;

/** Known model context windows (in tokens) */
const MODEL_CONTEXT_LIMITS: Record<string, number> = {
    // Llama models
    'llama2': 4096,
    'llama2:7b': 4096,
    'llama2:13b': 4096,
    'llama3': 8192,
    'llama3:8b': 8192,
    'llama3.1': 128000,
    'llama3.1:8b': 128000,
    'llama3.2': 128000,
    'llama3.2:3b': 128000,
    
    // Qwen models
    'qwen': 8192,
    'qwen:7b': 8192,
    'qwen2': 32768,
    'qwen2:7b': 32768,
    'qwen2.5': 32768,
    'qwen2.5:7b': 32768,
    'qwen2.5-coder': 32768,
    'qwen2.5-coder:7b': 32768,
    'qwen2.5-coder:7b-256k': 262144,

    // Qwen3.5 models
    'qwen3.5': 32768,
    'qwen3.5:27b': 32768,
    'qwen3.5:27b-49k': 49152,

    // Qwen3.6 models
    'qwen3.6': 32768,
    'qwen3.6:27b': 32768,
    'qwen3.6:27b-49k': 49152,
    'qwen3.6:35b-a3b': 32768,
    'qwen3.6:35b-a3b-32k': 32768,
    
    // Phi models
    'phi': 2048,
    'phi3': 4096,
    'phi3:mini': 4096,
    'phi3:medium': 4096,
    
    // Mistral models
    'mistral': 8192,
    'mistral:7b': 8192,
    'mixtral': 32768,
    'mixtral:8x7b': 32768,
    
    // CodeLlama models
    'codellama': 16384,
    'codellama:7b': 16384,
    'codellama:13b': 16384,
    
    // DeepSeek models
    'deepseek-coder': 16384,
    'deepseek-coder:6.7b': 16384,
    'deepseek-r1': 65536,
    'deepseek-r1:8b': 65536,
    'deepseek-r1:32b': 65536,
    
    // Gemma models
    'gemma': 8192,
    'gemma:7b': 8192,
    'gemma2': 8192,
    'gemma2:9b': 8192,

    // Gemma4 models
    'gemma4': 65536,
    'gemma4:12b': 65536,
    'gemma4:26b': 65536,
    'gemma4:26b-65k': 65536,

    // Hermes models (Nous Research — ChatML format, 128K context)
    'hermes3': 131072,
    'hermes3:3b': 131072,
    'hermes3:8b': 131072,
    'hermes3:70b': 131072,
    'hermes3:405b': 131072,
    'hermes': 131072,
};

/** Default context limit for unknown models — 32K is a safe floor for any modern model */
const DEFAULT_CONTEXT_LIMIT = 32768;

/** Cache of resolved context limits from Ollama /api/show (persists for session) */
const resolvedLimitsCache: Map<string, number> = new Map();

/** Models currently being resolved (prevents duplicate concurrent requests) */
const pendingResolutions: Map<string, Promise<number>> = new Map();

/**
 * Get the context window size for a given model.
 * Uses cached value from Ollama if available, otherwise falls back to hardcoded table.
 * Call resolveModelContextLimit() first to populate the cache from Ollama.
 */
export function getModelContextLimit(model: string): number {
    const modelLower = model.toLowerCase();

    // Check resolved cache first (from /api/show)
    if (resolvedLimitsCache.has(modelLower)) {
        return resolvedLimitsCache.get(modelLower)!;
    }

    // Try exact match in hardcoded table
    if (MODEL_CONTEXT_LIMITS[modelLower]) {
        return MODEL_CONTEXT_LIMITS[modelLower];
    }
    
    // Try partial match (e.g., "qwen2.5-coder:7b-instruct" matches "qwen2.5-coder:7b")
    for (const [key, limit] of Object.entries(MODEL_CONTEXT_LIMITS)) {
        if (modelLower.startsWith(key)) {
            return limit;
        }
    }

    // Parse context hint from model name suffix: -32k, -49k, -65k, -128k, -256k, etc.
    // e.g. "somemodel:7b-49k" → 49152, "somemodel:13b-128k" → 131072
    const ctxSuffixMatch = modelLower.match(/-(\d+)k(?:[^a-z]|$)/);
    if (ctxSuffixMatch) {
        const kTokens = parseInt(ctxSuffixMatch[1], 10) * 1024;
        logInfo(`[context] Inferred context limit from model name suffix "-${ctxSuffixMatch[1]}k": ${kTokens} tokens`);
        return kTokens;
    }

    logWarn(`[context] Unknown model "${model}", using default limit of ${DEFAULT_CONTEXT_LIMIT} tokens`);
    return DEFAULT_CONTEXT_LIMIT;
}

/**
 * Query Ollama for the actual context window of a model and cache the result.
 * Safe to call multiple times — deduplicates concurrent requests and caches.
 * Returns the resolved limit (from Ollama or fallback).
 */
export async function resolveModelContextLimit(model: string): Promise<number> {
    const modelLower = model.toLowerCase();

    // User config always wins — check contextWindow override first
    const cfg = getConfig();
    if (cfg.contextWindow && cfg.contextWindow > 0) {
        resolvedLimitsCache.set(modelLower, cfg.contextWindow);
        logInfo(`[context] Using user-configured context window: ${cfg.contextWindow} tokens`);
        return cfg.contextWindow;
    }

    // Already cached
    if (resolvedLimitsCache.has(modelLower)) {
        return resolvedLimitsCache.get(modelLower)!;
    }

    // Already in-flight
    if (pendingResolutions.has(modelLower)) {
        return pendingResolutions.get(modelLower)!;
    }

    const resolution = (async () => {
        try {
            const info = await fetchModelInfo(model);
            if (info?.contextLength && info.contextLength > 0) {
                // Ollama reports the model's loaded num_ctx, which may be artificially low
                // (e.g. user ran `ollama run model` with default 8K instead of model's max).
                // Use the larger of: Ollama's value vs. our hardcoded table / name-suffix hint.
                const tableLimit = getModelContextLimit(model);
                const resolved = Math.max(info.contextLength, tableLimit);
                resolvedLimitsCache.set(modelLower, resolved);
                if (resolved !== info.contextLength) {
                    logInfo(`[context] Resolved ${model} context limit: Ollama=${info.contextLength}, table=${tableLimit} → using ${resolved} tokens`);
                } else {
                    logInfo(`[context] Resolved ${model} context limit from Ollama: ${info.contextLength} tokens`);
                }
                return resolved;
            }
        } catch (err) {
            logWarn(`[context] Failed to resolve context limit for ${model}: ${toErrorMessage(err)}`);
        }

        // Fall back to hardcoded table
        const fallback = getModelContextLimit(model);
        resolvedLimitsCache.set(modelLower, fallback);
        logInfo(`[context] Using fallback context limit for ${model}: ${fallback} tokens`);
        return fallback;
    })();

    pendingResolutions.set(modelLower, resolution);
    try {
        return await resolution;
    } finally {
        pendingResolutions.delete(modelLower);
    }
}

/** Clear the resolved limits cache (useful for testing or when Ollama config changes) */
export function clearContextLimitCache(): void {
    resolvedLimitsCache.clear();
    logInfo('[context] Context limit cache cleared');
}

/**
 * Estimate token count from text.
 * Uses char/3.5 for code-heavy content (lots of short tokens like braces/operators)
 * and char/4 for prose. Detects code by checking for common code characters.
 */
export function estimateTokens(text: string): number {
    if (!text) return 0;
    // Heuristic: if >5% of chars are code-specific punctuation, use tighter ratio
    const codeChars = (text.match(/[{}()\[\];=<>!&|+\-*/^~@#$%]/g) || []).length;
    const ratio = (codeChars / text.length) > 0.05 ? 3.5 : 4;
    return Math.ceil(text.length / ratio);
}

/**
 * Cache for tokenize results on stable content (system prompt, memory).
 * Keyed by content hash (first 64 chars + length) to avoid hashing entire strings.
 */
const _tokenizeCache = new Map<string, number>();
const MAX_TOKENIZE_CACHE = 200;

function _cacheKey(text: string): string {
    // Include length + samples from start, middle, and end to minimize collision risk
    // without hashing the entire string (which would be expensive for large system prompts).
    const mid = Math.floor(text.length / 2);
    return `${text.length}:${text.slice(0, 32)}:${text.slice(mid, mid + 16)}:${text.slice(-16)}`;
}

/**
 * Get accurate token count via Ollama's /api/tokenize endpoint.
 * Use this for compaction decisions where the char/4 heuristic drifts 20-30%
 * for models with large vocabularies (gemma4, qwen3.6).
 *
 * Falls back to estimateTokens if the endpoint is unavailable.
 * Caches results for stable content (system prompt, memory) to avoid repeated calls.
 */
export async function countTokensAccurate(model: string, text: string): Promise<number> {
    if (!text) { return 0; }
    const key = _cacheKey(text);
    if (_tokenizeCache.has(key)) { return _tokenizeCache.get(key)!; }
    const count = await tokenizeText(model, text);
    if (count !== null) {
        if (_tokenizeCache.size >= MAX_TOKENIZE_CACHE) {
            // Evict oldest entry (Map preserves insertion order)
            const first = _tokenizeCache.keys().next().value;
            if (first !== undefined) { _tokenizeCache.delete(first); }
        }
        _tokenizeCache.set(key, count);
        return count;
    }
    return estimateTokens(text); // fallback
}

/** Clear the tokenize cache (e.g. when model changes) */
export function clearTokenizeCache(): void { _tokenizeCache.clear(); }

/**
 * Calculate total tokens in conversation history.
 */
export function calculateHistoryTokens(history: OllamaMessage[]): number {
    let total = 0;
    for (const msg of history) {
        total += estimateTokens(msg.content);
        // Add overhead for role and structure
        total += MESSAGE_OVERHEAD_TOKENS;
    }
    return total;
}

/**
 * Calculate context usage percentage.
 * Returns a value between 0 and 100.
 */
export function calculateContextUsage(
    historyTokens: number,
    systemPromptTokens: number,
    memoryTokens: number,
    modelLimit: number
): number {
    // Guard against invalid model limit
    if (modelLimit <= 0) {
        logWarn(`[context] Invalid model limit: ${modelLimit}, assuming full context`);
        return 100; // Assume full to be safe
    }
    
    const totalTokens = historyTokens + systemPromptTokens + memoryTokens;
    const percentage = (totalTokens / modelLimit) * 100;
    return Math.min(100, Math.max(0, percentage));
}

/**
 * Context usage level for determining alert behavior.
 */
export type ContextLevel = 'safe' | 'warning' | 'critical' | 'overflow';

/**
 * Determine context usage level based on percentage.
 */
export function getContextLevel(percentage: number): ContextLevel {
    if (percentage >= 99) return 'overflow';
    if (percentage >= 90) return 'critical';
    if (percentage >= 70) return 'warning';
    return 'safe';
}

/**
 * Context usage statistics for monitoring.
 */
export interface ContextStats {
    historyTokens: number;
    systemPromptTokens: number;
    memoryTokens: number;
    totalTokens: number;
    modelLimit: number;
    usagePercentage: number;
    level: ContextLevel;
    messagesCount: number;
}

/**
 * Calculate comprehensive context statistics.
 * Uses char-based heuristic for speed — suitable for per-turn monitoring.
 * For compaction decisions use calculateContextStatsAccurate instead.
 */
export function calculateContextStats(
    history: OllamaMessage[],
    systemPrompt: string,
    memoryContext: string,
    model: string
): ContextStats {
    const historyTokens = calculateHistoryTokens(history);
    const systemPromptTokens = estimateTokens(systemPrompt);
    const memoryTokens = estimateTokens(memoryContext);
    const totalTokens = historyTokens + systemPromptTokens + memoryTokens;
    const modelLimit = getModelContextLimit(model);
    const usagePercentage = calculateContextUsage(
        historyTokens,
        systemPromptTokens,
        memoryTokens,
        modelLimit
    );
    const level = getContextLevel(usagePercentage);

    return {
        historyTokens,
        systemPromptTokens,
        memoryTokens,
        totalTokens,
        modelLimit,
        usagePercentage,
        level,
        messagesCount: history.length,
    };
}

/**
 * Accurate context statistics using Ollama's /api/tokenize endpoint.
 * Use this before compaction decisions to avoid false-overflow from heuristic drift
 * (gemma4/qwen3.6 can differ 20-30% from char/4 estimate — CODE_REVIEW_FINDINGS #8).
 * Falls back to heuristic if /api/tokenize is unavailable.
 */
export async function calculateContextStatsAccurate(
    history: OllamaMessage[],
    systemPrompt: string,
    memoryContext: string,
    model: string
): Promise<ContextStats> {
    // Use accurate counts for stable content (system prompt + memory) — these are
    // the largest contributors and most stable across turns (worth the API call + cache).
    const [systemPromptTokens, memoryTokens] = await Promise.all([
        countTokensAccurate(model, systemPrompt),
        countTokensAccurate(model, memoryContext),
    ]);
    // History changes every turn — use heuristic to avoid N tokenize calls per turn
    const historyTokens = calculateHistoryTokens(history);
    const totalTokens = historyTokens + systemPromptTokens + memoryTokens;
    const modelLimit = getModelContextLimit(model);
    const usagePercentage = calculateContextUsage(historyTokens, systemPromptTokens, memoryTokens, modelLimit);
    const level = getContextLevel(usagePercentage);
    logInfo(`[context] Accurate token count: system=${systemPromptTokens} memory=${memoryTokens} history=${historyTokens} total=${totalTokens}/${modelLimit} (${usagePercentage.toFixed(1)}%)`);
    return { historyTokens, systemPromptTokens, memoryTokens, totalTokens, modelLimit, usagePercentage, level, messagesCount: history.length };
}

/**
 * Proportionally shrink large tool-result messages across the history so that more
 * conversation turns can be retained during compaction.
 *
 * Rather than dropping entire messages (oldest-first), this truncates the content
 * of the largest tool/user messages to a proportional share of the available budget.
 * Messages shorter than MIN_SHRINK_CHARS are left untouched.
 *
 * Call this before compactHistory when the history is over budget — it gives the
 * oldest-first drop a lighter load and preserves more turns of recent context.
 *
 * @param history Mutable copy of conversation history (not modified in place — returns new array)
 * @param budgetTokens Target token budget for the history after shrinking
 * @returns New history array with large messages trimmed
 */
export function shrinkLargeToolMessages(
    history: OllamaMessage[],
    budgetTokens: number
): OllamaMessage[] {
    const MIN_SHRINK_CHARS = 800; // Don't shrink messages shorter than this

    // Shallow copy so we don't mutate the original
    const result = history.map(m => ({ ...m }));

    // Calculate current total
    let totalTokens = result.reduce((sum, m) => sum + estimateTokens(m.content) + MESSAGE_OVERHEAD_TOKENS, 0);

    if (totalTokens <= budgetTokens) {
        return result; // Already within budget
    }

    // Identify shrinkable messages (tool/user with large content), sorted largest-first
    const shrinkable = result
        .map((m, idx) => ({ idx, len: m.content.length }))
        .filter(({ len }) => len > MIN_SHRINK_CHARS)
        .sort((a, b) => b.len - a.len);

    const overage = totalTokens - budgetTokens;

    // Distribute the reduction proportionally across the largest messages
    const totalShrinkableChars = shrinkable.reduce((s, { len }) => s + len, 0);
    if (totalShrinkableChars === 0) { return result; }

    for (const { idx, len } of shrinkable) {
        if (totalTokens <= budgetTokens) { break; }
        // How much of the overage is this message responsible for?
        const share = len / totalShrinkableChars;
        const charsToRemove = Math.floor(share * overage * 4); // token → char conversion (×4)
        const newLen = Math.max(MIN_SHRINK_CHARS, len - charsToRemove);
        if (newLen < len) {
            const original = result[idx].content;
            result[idx] = {
                ...result[idx],
                content: original.slice(0, newLen) + '\n[...truncated by context shrink]',
            };
            const saved = estimateTokens(original) - estimateTokens(result[idx].content);
            totalTokens -= saved;
            logInfo(`[context] Proportional shrink: msg[${idx}] ${len}→${newLen} chars, saved ~${saved} tokens`);
        }
    }

    return result;
}

/**
 * Compact conversation history by removing older messages while preserving recent context.
 * Keeps the most recent N messages and removes older ones.
 *
 * @param history Current conversation history
 * @param targetPercentage Target usage percentage after compaction (default: 50%)
 * @param modelLimit Model's context window limit
 * @param systemPromptTokens Tokens used by system prompt
 * @param memoryTokens Tokens used by memory context
 * @returns Compacted history
 */
export function compactHistory(
    history: OllamaMessage[],
    targetPercentage: number,
    modelLimit: number,
    systemPromptTokens: number,
    memoryTokens: number
): OllamaMessage[] {
    if (history.length === 0) {
        return [];
    }
    
    // Calculate target tokens for history (accounting for system prompt and memory)
    const targetTotalTokens = Math.floor((modelLimit * targetPercentage) / 100);
    const targetHistoryTokens = targetTotalTokens - systemPromptTokens - memoryTokens;
    
    if (targetHistoryTokens <= 0) {
        logWarn('[context] Target history tokens is negative, keeping only last message');
        return history.slice(-1);
    }
    
    // Work backwards from the end, keeping messages until we hit the target
    const compacted: OllamaMessage[] = [];
    let currentTokens = 0;
    
    for (let i = history.length - 1; i >= 0; i--) {
        const msg = history[i];
        const msgTokens = estimateTokens(msg.content) + MESSAGE_OVERHEAD_TOKENS;
        
        if (currentTokens + msgTokens > targetHistoryTokens && compacted.length > 0) {
            // Would exceed target, stop here
            break;
        }
        
        compacted.unshift(msg);
        currentTokens += msgTokens;
    }
    
    const removedCount = history.length - compacted.length;
    logInfo(`[context] Compacted history: removed ${removedCount} messages, kept ${compacted.length} (${currentTokens} tokens)`);
    
    return compacted;
}
