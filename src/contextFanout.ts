/**
 * contextFanout.ts — unified relevance query across all context stores
 *
 * Fans a single query out to codeGraph (structural symbols), codeIndex (semantic
 * vector search), and tiered memory (facts/conventions) in parallel, then merges
 * and deduplicates results into a single ranked context block.
 *
 * Design goals:
 * - All three stores are queried concurrently (Promise.allSettled)
 * - Each store contributes a capped token budget so no single store dominates
 * - Dedup by content fingerprint prevents the same fact appearing twice
 * - Graceful degradation: any store failure is silent, others still contribute
 * - Output is a single string ready to inject into the system prompt
 */

import * as crypto from 'crypto';
import { logInfo, logWarn } from './logger';
import type { CodeGraph } from './codeGraph';
import type { CodeIndexer } from './codeIndex';
import type { TieredMemoryManager } from './memoryCore';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface FanoutResult {
    /** Combined context block (may be empty string if all stores had no hits) */
    text: string;
    /** Token estimate for the combined block */
    tokenEstimate: number;
    /** Per-store hit counts for logging */
    sources: { graph: number; index: number; memory: number };
}

// ── Token budget split (total ≤ 2000 tokens) ─────────────────────────────────
// codeGraph  — 700  tokens: structural symbols, call edges, exact FTS
// codeIndex  — 600  tokens: semantic file summaries from Qdrant
// memory     — 700  tokens: facts, conventions, past solutions

const BUDGET_GRAPH  = 700;
const BUDGET_INDEX  = 600;
const BUDGET_MEMORY = 700;

// ── Helpers ───────────────────────────────────────────────────────────────────

function fingerprint(text: string): string {
    return crypto.createHash('md5').update(text.slice(0, 200)).digest('hex').slice(0, 12);
}

function trimToTokens(text: string, maxTokens: number): string {
    const maxChars = maxTokens * 4;
    if (text.length <= maxChars) return text;
    return text.slice(0, maxChars) + '\n[... trimmed]';
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Fan a query out to all available context stores and return a merged block.
 *
 * @param query         The user's task message (used for all three stores)
 * @param codeGraph     CodeGraph instance (may be null if Tree-sitter unavailable)
 * @param codeIndex     CodeIndexer instance (may be null if Qdrant unavailable)
 * @param memory        TieredMemoryManager (may be null if memory disabled)
 * @param options       Optional overrides for token budgets
 */
export async function findRelevant(
    query: string,
    codeGraph: CodeGraph | null,
    codeIndex: CodeIndexer | null,
    memory: TieredMemoryManager | null,
    options: {
        budgetGraph?:  number;
        budgetIndex?:  number;
        budgetMemory?: number;
    } = {}
): Promise<FanoutResult> {
    const bg = options.budgetGraph  ?? BUDGET_GRAPH;
    const bi = options.budgetIndex  ?? BUDGET_INDEX;
    const bm = options.budgetMemory ?? BUDGET_MEMORY;

    // ── Fan out all three queries in parallel ─────────────────────────────────
    const [graphResult, indexResult, memoryResult] = await Promise.allSettled([
        // 1. codeGraph structural symbols
        (async (): Promise<string> => {
            if (!codeGraph?.isReady()) return '';
            const scope = codeGraph.buildScopeContext(query, bg);
            return scope?.text ?? '';
        })(),

        // 2. codeIndex semantic file search
        (async (): Promise<string> => {
            if (!codeIndex?.isReady) return '';
            const hits = await codeIndex.findRelevantFiles(query, 5);
            if (hits.length === 0) return '';
            const lines = hits.map(h =>
                `- **${h.relPath}** (score ${Math.round(h.score * 100)}%): ${h.summary}`
            );
            return `## Semantically Relevant Files\n${lines.join('\n')}`;
        })(),

        // 3. tiered memory (Tiers 0-3 local + Tiers 4-5 Qdrant)
        (async (): Promise<string> => {
            if (!memory) return '';
            const hits = await memory.searchMemory(query, undefined, 8);
            if (hits.length === 0) return '';
            const lines = hits
                .slice(0, 8)
                .map(h => `- [T${h.tier}] ${h.content.slice(0, 200)}`);
            return `## Relevant Memory\n${lines.join('\n')}`;
        })(),
    ]);

    // ── Extract values, count hits, log errors ────────────────────────────────
    const graphText  = graphResult.status  === 'fulfilled' ? graphResult.value  : '';
    const indexText  = indexResult.status  === 'fulfilled' ? indexResult.value  : '';
    const memoryText = memoryResult.status === 'fulfilled' ? memoryResult.value : '';

    if (graphResult.status  === 'rejected') logWarn('[fanout] codeGraph query failed: '  + String(graphResult.reason));
    if (indexResult.status  === 'rejected') logWarn('[fanout] codeIndex query failed: '  + String(indexResult.reason));
    if (memoryResult.status === 'rejected') logWarn('[fanout] memory query failed: '     + String(memoryResult.reason));

    // ── Dedup by content fingerprint ──────────────────────────────────────────
    // Prevents the same symbol/fact appearing in both codeGraph and memory
    const seen = new Set<string>();
    const blocks: string[] = [];

    for (const [raw, budget] of [
        [graphText,  bg] as const,
        [indexText,  bi] as const,
        [memoryText, bm] as const,
    ]) {
        if (!raw.trim()) continue;
        const trimmed = trimToTokens(raw, budget);
        const fp = fingerprint(trimmed);
        if (seen.has(fp)) continue;
        seen.add(fp);
        blocks.push(trimmed);
    }

    const text = blocks.join('\n\n');
    const tokenEstimate = Math.ceil(text.length / 4);

    const sources = {
        graph:  graphText  ? (graphText.match(/\n/g)  || []).length : 0,
        index:  indexText  ? (indexText.match(/^-/gm) || []).length : 0,
        memory: memoryText ? (memoryText.match(/^-/gm) || []).length : 0,
    };

    if (text) {
        logInfo(`[fanout] Merged context: graph=${sources.graph}L index=${sources.index}F memory=${sources.memory}M ~${tokenEstimate}tok`);
    }

    return { text, tokenEstimate, sources };
}
