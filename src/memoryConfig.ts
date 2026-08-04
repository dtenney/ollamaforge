import * as vscode from 'vscode';
import { getConfig } from './config';

export interface MemoryConfig {
    enabled: boolean;
    qdrantUrl: string;
    embeddingUrl: string;
    embeddingModel: string;
    autoLoadTiers: number[];
    demotionThresholdDays: number;
    promotionAccessCount: number;
    archiveThresholdDays: number;
    maxContextTokens: number;
    semanticSearchLimit: number;
    fallbackToLocal: boolean;
}

/**
 * Get memory configuration with smart URL resolution.
 *
 * Qdrant URL priority:
 * 1. ollamaForge.memory.qdrantUrl (if set)
 * 2. Auto-derived from Ollama server URL with port 6333
 *
 * Embedding URL priority:
 * 1. ollamaForge.memory.embeddingUrl (if set)
 * 2. Ollama baseUrl (default)
 */
export function getMemoryConfig(): MemoryConfig {
    const config = vscode.workspace.getConfiguration('ollamaForge');
    const ollamaConfig = getConfig();
    
    // Resolve Qdrant URL with priority logic
    let qdrantUrl = config.get<string>('memory.qdrantUrl', '').trim();
    if (!qdrantUrl) {
        // Auto-derive from Ollama server URL with port 6333
        try {
            const ollamaUrl = new URL(ollamaConfig.baseUrl);
            qdrantUrl = `http://${ollamaUrl.hostname}:6333`;
        } catch {
            // Fallback if URL parsing fails
            qdrantUrl = 'http://localhost:6333';
        }
    }

    // Resolve Embedding URL — must be an absolute http/https URL.
    // ollamaConfig.baseUrl is already validated by validateBaseUrl() so it's always safe,
    // but a user-supplied memory.embeddingUrl could be blank or malformed.
    const rawEmbeddingUrl = config.get<string>('memory.embeddingUrl', '').trim();
    let embeddingUrl: string;
    if (rawEmbeddingUrl) {
        try {
            const parsed = new URL(rawEmbeddingUrl);
            embeddingUrl = ['http:', 'https:'].includes(parsed.protocol) ? rawEmbeddingUrl : ollamaConfig.baseUrl;
        } catch {
            embeddingUrl = ollamaConfig.baseUrl;
        }
    } else {
        embeddingUrl = ollamaConfig.baseUrl;
    }
    
    return {
        enabled: config.get<boolean>('memory.enabled', true),
        qdrantUrl,
        embeddingUrl,
        embeddingModel: config.get<string>('memory.embeddingModel', 'nomic-embed-text'),
        autoLoadTiers: config.get<number[]>('memory.autoLoadTiers', [0, 1, 2]),
        demotionThresholdDays: config.get<number>('memory.demotionThresholdDays', 30),
        promotionAccessCount: config.get<number>('memory.promotionAccessCount', 5),
        archiveThresholdDays: config.get<number>('memory.archiveThresholdDays', 90),
        maxContextTokens: config.get<number>('memory.maxContextTokens', 1500),
        semanticSearchLimit: config.get<number>('memory.semanticSearchLimit', 5),
        fallbackToLocal: config.get<boolean>('memory.fallbackToLocal', true)
    };
}
