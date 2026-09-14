/**
 * Model recommendations & outdated-model warning tracker.
 *
 * Adapted from ollama-vscode/src/recommendations.ts.
 * Warns once per conversation when the user selects a known-outdated model
 * family, and provides helpers to parse server-side recommendations.
 */

export interface ModelRecommendation {
    model: string;
}

export interface OutdatedModelWarningRequest {
    readonly conversationID: number;
}

interface OutdatedModelWarningConversation {
    readonly id: number;
    history: readonly string[];
    readonly warnedModels: Set<string>;
    lastRequestSucceeded: boolean;
}

export class OutdatedModelWarningTracker {
    private readonly conversations = new Map<number, OutdatedModelWarningConversation>();
    private nextConversationID = 1;

    constructor(private readonly maxChats = 100) {}

    beginRequest(
        history: readonly string[],
        hasAssistantResponse: boolean
    ): OutdatedModelWarningRequest {
        const recentConversations = [...this.conversations.values()].reverse();
        const exact = recentConversations.find(c => historiesEqual(c.history, history));
        let conversation = exact
            ? (hasAssistantResponse || !exact.lastRequestSucceeded ? exact : undefined)
            : (hasAssistantResponse ? longestHistoryPrefix(recentConversations, history) : undefined);

        if (!conversation) {
            if (this.conversations.size >= this.maxChats) {
                const oldest = this.conversations.keys().next().value;
                if (oldest !== undefined) {
                    this.conversations.delete(oldest);
                }
            }
            conversation = {
                id: this.nextConversationID++,
                history: [],
                warnedModels: new Set<string>(),
                lastRequestSucceeded: false,
            };
        } else {
            this.conversations.delete(conversation.id);
        }

        conversation.history = [...history];
        conversation.lastRequestSucceeded = false;
        this.conversations.set(conversation.id, conversation);
        return { conversationID: conversation.id };
    }

    hasShown(request: OutdatedModelWarningRequest, model: string): boolean {
        return this.conversations.get(request.conversationID)?.warnedModels.has(warningModelKey(model)) ?? false;
    }

    markShown(request: OutdatedModelWarningRequest, model: string): void {
        this.conversations.get(request.conversationID)?.warnedModels.add(warningModelKey(model));
    }

    finishRequest(request: OutdatedModelWarningRequest, succeeded: boolean): void {
        const conversation = this.conversations.get(request.conversationID);
        if (conversation) {
            conversation.lastRequestSucceeded = succeeded;
        }
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function historiesEqual(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((msg, i) => msg === right[i]);
}

function longestHistoryPrefix(
    conversations: readonly OutdatedModelWarningConversation[],
    history: readonly string[]
): OutdatedModelWarningConversation | undefined {
    let match: OutdatedModelWarningConversation | undefined;
    for (const conversation of conversations) {
        if (
            conversation.history.length > 0 &&
            conversation.history.length < history.length &&
            conversation.history.every((msg, i) => msg === history[i]) &&
            (!match || conversation.history.length > match.history.length)
        ) {
            match = conversation;
        }
    }
    return match;
}

// ── Outdated model detection ─────────────────────────────────────────────────

const outdatedAgentModelFamilies = new Set([
    'codellama',
    'llama3',
    'llama3.1',
    'llama3.2',
    'llama3.3',
    'mistral',
    'qwen2.5',
    'qwen2.5-coder',
    'starcoder',
]);

const outdatedDeepSeekR1Tags = new Set([
    '',
    'latest',
    '1.5b',
    '7b',
    '8b',
    '14b',
    '32b',
]);

export function isOutdatedAgentModel(name: string): boolean {
    const { family, tag } = normalizedModelReference(name);
    if (outdatedAgentModelFamilies.has(family)) {
        return true;
    }
    if (family === 'deepseek-r1' && outdatedDeepSeekR1Tags.has(tag)) {
        return true;
    }
    return false;
}

// ── Server-side recommendation parsing ───────────────────────────────────────

export function parseModelRecommendations(payload: unknown): ModelRecommendation[] {
    if (!isRecord(payload) || !Array.isArray(payload.recommendations)) {
        return [];
    }

    const recommendations: ModelRecommendation[] = [];
    const seen = new Set<string>();
    for (const item of payload.recommendations) {
        if (!isRecord(item) || typeof item.model !== 'string') {
            continue;
        }
        const model = pinnedRecommendationModel(item.model);
        const key = recommendationKey(model);
        if (!model || seen.has(key)) {
            continue;
        }
        seen.add(key);
        recommendations.push({ model });
    }
    return recommendations;
}

export function isRecommendedModel(
    name: string,
    recommendations: readonly ModelRecommendation[]
): boolean {
    const key = recommendationKey(name);
    return recommendations.some(r => recommendationKey(r.model) === key);
}

export function recommendedReplacement<T extends { name: string }>(
    currentModel: string,
    availableModels: readonly T[],
    recommendations: readonly ModelRecommendation[]
): string | undefined {
    const available = new Map(availableModels.map(m => [recommendationKey(m.name), m.name]));
    const currentKey = recommendationKey(currentModel);
    const recommendation = recommendations.find(candidate =>
        recommendationKey(candidate.model) !== currentKey &&
        isCloudModel(candidate.model) === isCloudModel(currentModel)
    );
    if (!recommendation) {
        return undefined;
    }
    return available.get(recommendationKey(recommendation.model)) ?? recommendation.model;
}

// ── Internal utilities ───────────────────────────────────────────────────────

function recommendationKey(name: string): string {
    const normalized = name.trim().toLowerCase();
    return normalized.endsWith(':latest') ? normalized.slice(0, -':latest'.length) : normalized;
}

function pinnedRecommendationModel(name: string): string {
    const model = name.trim();
    const normalized = model.toLowerCase();
    if (normalized === 'gemma4' || normalized === 'gemma4:latest') {
        return 'gemma4:12b';
    }
    return model;
}

function warningModelKey(name: string): string {
    return name.trim().toLowerCase();
}

function normalizedModelReference(name: string): { family: string; tag: string } {
    const pathParts = name.trim().toLowerCase().split('/');
    const reference = pathParts.at(-1) ?? '';
    const separator = reference.indexOf(':');
    const family = separator >= 0 ? reference.slice(0, separator) : reference;
    let tag = separator >= 0 ? reference.slice(separator + 1) : '';
    if (tag === 'cloud') {
        tag = '';
    } else if (tag.endsWith('-cloud')) {
        tag = tag.slice(0, -'-cloud'.length);
    }
    return { family, tag };
}

function isCloudModel(name: string): boolean {
    const tag = name.split(':').at(-1)?.toLowerCase() ?? '';
    return tag === 'cloud' || tag.endsWith('-cloud');
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
