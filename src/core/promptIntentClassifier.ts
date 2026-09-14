/**
 * promptIntentClassifier.ts
 *
 * Pure, dependency-free intent classifier for user prompts.
 * Routes prompts to different context-assembly strategies so the
 * agent can skip irrelevant context (e.g. no git diff for "explain
 * this function", no full workspace scan for "find the config file").
 *
 * No VS Code imports — safe to unit-test in isolation.
 */

export type PromptIntent =
    | 'explain'      // "what does this do", "describe", "explain"
    | 'refactor'     // "refactor", "restructure", "move X to Y", "rename"
    | 'create'       // "create", "add", "implement", "write a new"
    | 'debug'        // "fix", "debug", "why is this failing", "error"
    | 'search'       // "find", "where is", "which file", "locate"
    | 'general';     // fallback — full context assembly

export interface IntentResult {
    intent: PromptIntent;
    /** 0–1 confidence; higher = more certain */
    confidence: number;
    /** Context strategies to prioritize (in order) */
    contextPriorities: string[];
    /** Context strategies to skip */
    contextSkips: string[];
}

// ── Pattern tables ──────────────────────────────────────────────────────────

interface IntentRule {
    intent: PromptIntent;
    patterns: RegExp[];
    confidence: number;
    priorities: string[];
    skips: string[];
}

const RULES: IntentRule[] = [
    {
        intent: 'explain',
        patterns: [
            /\b(explain|describe|what does|what is|what's|walk me through|summarize|summarise|overview of|tell me about|how does|how do|how to read)\b/i,
            /\b(read|understand|comprehend)\b.*\b(file|function|class|module|component|method)\b/i,
        ],
        confidence: 0.85,
        priorities: ['active_file', 'symbols', 'imports'],
        skips: ['git_diff', 'workspace_scan', 'recently_modified'],
    },
    {
        intent: 'refactor',
        patterns: [
            /\b(refactor|restructure|reorganize|reorganise|rename|move|extract|split|merge|consolidate|clean up|tidy|simplify)\b/i,
            /\b(move|extract)\b.*\b(from|to|into)\b/i,
            /\b(rename|change)\b.*\b(name|to)\b/i,
        ],
        confidence: 0.80,
        priorities: ['active_file', 'imports', 'symbols', 'similar_files', 'workspace_scan'],
        skips: ['git_blame'],
    },
    {
        intent: 'create',
        patterns: [
            /\b(create|add|implement|write|build|generate|scaffold|make|new)\b.*\b(file|function|class|module|component|endpoint|route|handler|test|script|config|page|view|service|controller)\b/i,
            /\b(add|implement)\b.*\b(feature|support|handling|logic|validation|limiting|authentication|authorization|caching|logging|monitoring|middleware|pipeline|workflow)\b/i,
            /\b(write|create|build)\b.*\b(new|fresh)\b/i,
            /\bimplement\b/i,
        ],
        confidence: 0.75,
        priorities: ['active_file', 'workspace_scan', 'similar_files', 'imports'],
        skips: ['git_diff', 'git_blame'],
    },
    {
        intent: 'debug',
        patterns: [
            /\b(fix|debug|broken|failing|error|crash|exception|bug|issue|problem|not working|doesn't work|won't work|failing|stack ?trace)\b/i,
            /\b(why|what's wrong|what went wrong|how do I fix|how to fix)\b/i,
            /\b(investigate|diagnose|trace|root cause)\b/i,
        ],
        confidence: 0.80,
        priorities: ['active_file', 'git_diff', 'recently_modified', 'imports', 'symbols'],
        skips: ['workspace_scan'],
    },
    {
        intent: 'search',
        patterns: [
            /\b(find|locate|where is|where's|which file|which function|which class|search for|look for|grep)\b/i,
            /\b(what file|where do(es)? (it|this|that) (live|exist|reside))\b/i,
            /\b(list|show me|enumerate)\b.*\b(file|function|class|module|endpoint)\b/i,
        ],
        confidence: 0.70,
        priorities: ['symbols', 'workspace_scan', 'imports'],
        skips: ['git_diff', 'git_blame', 'recently_modified'],
    },
];

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Classify a user prompt into an intent category.
 * Returns the highest-confidence match, or 'general' if nothing matches.
 */
export function classifyIntent(prompt: string): IntentResult {
    const trimmed = prompt.trim();
    if (!trimmed) {
        return { intent: 'general', confidence: 0, contextPriorities: ['active_file', 'workspace_scan'], contextSkips: [] };
    }

    let best: IntentResult | null = null;

    for (const rule of RULES) {
        for (const pattern of rule.patterns) {
            if (pattern.test(trimmed)) {
                const candidate: IntentResult = {
                    intent: rule.intent,
                    confidence: rule.confidence,
                    contextPriorities: rule.priorities,
                    contextSkips: rule.skips,
                };
                if (!best || candidate.confidence > best.confidence) {
                    best = candidate;
                }
                break; // first pattern match in this rule is enough
            }
        }
    }

    if (best) {
        return best;
    }

    // Fallback: general — full context assembly
    return {
        intent: 'general',
        confidence: 0.3,
        contextPriorities: ['active_file', 'workspace_scan', 'git_diff', 'recently_modified', 'imports', 'symbols'],
        contextSkips: [],
    };
}

/**
 * Convenience: just get the intent label.
 */
export function getIntent(prompt: string): PromptIntent {
    return classifyIntent(prompt).intent;
}
