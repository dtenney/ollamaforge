/**
 * secretRedaction.ts — Wave 1 security layer (plan item 1.3).
 *
 * Redacts high-entropy / known-secret patterns from tool output before it is
 * injected into the model context or written to logs. Prevents credentials
 * that appear in command output (env dumps, .env reads, git config, etc.)
 * from being echoed back into prompts or memory.
 *
 * Applied to: run_command stdout/stderr, web_fetch body, file reads of
 * credential-looking files, and memory_tier_write content.
 */

export interface RedactionResult {
    text: string;
    /** Number of distinct secret spans replaced. */
    count: number;
}

// Patterns that look like embedded credentials. Each replaces the secret value
// with a fixed marker so the model still sees *that* a secret was present.
const SECRET_PATTERNS: { re: RegExp; marker: string }[] = [
    // AWS access key ID
    { re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, marker: '[REDACTED:AWS_KEY_ID]' },
    // AWS secret access key (40-char base64-ish following a key label)
    { re: /\b(?:aws_secret_access_key|secret_access_key|secret_key)\s*[=:]\s*['"]?[A-Za-z0-9/+=]{40}['"]?/gi, marker: '[REDACTED:AWS_SECRET]' },
    // Generic API keys / tokens (labelled)
    { re: /\b(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|secret|token|password|passwd|pwd)\s*[=:]\s*['"]?[A-Za-z0-9_\-\.]{16,}['"]?/gi, marker: '[REDACTED:CREDENTIAL]' },
    // Bearer tokens
    { re: /\bBearer\s+[A-Za-z0-9_\-\.=]{20,}/g, marker: '[REDACTED:BEARER]' },
    // GitHub tokens
    { re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, marker: '[REDACTED:GITHUB_TOKEN]' },
    // Slack tokens
    { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, marker: '[REDACTED:SLACK_TOKEN]' },
    // Private key blocks
    { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, marker: '[REDACTED:PRIVATE_KEY]' },
    // Connection strings with embedded password
    { re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^:\s]+:[^@\s]+@/gi, marker: '[REDACTED:CONNSTR]://' },
    // JWT
    { re: /\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{5,}/g, marker: '[REDACTED:JWT]' },
    // OpenAI-style keys
    { re: /\bsk-[A-Za-z0-9]{20,}\b/g, marker: '[REDACTED:OPENAI_KEY]' },
];

/**
 * Redact secrets from a string. Returns the cleaned text and how many spans
 * were replaced. Safe to call on any string; returns input unchanged if no
 * patterns match.
 */
export function redactSecrets(input: string): RedactionResult {
    if (!input) return { text: input ?? '', count: 0 };
    let text = input;
    let count = 0;
    for (const { re, marker } of SECRET_PATTERNS) {
        // Reset lastIndex for global regexes
        re.lastIndex = 0;
        const replaced = text.replace(re, () => {
            count++;
            return marker;
        });
        if (replaced !== text) text = replaced;
    }
    return { text, count };
}

/**
 * Detect whether a string likely contains a credential (used to hard-block
 * memory_tier_write of secrets). Returns true if any pattern matches.
 */
export function containsSecret(input: string): boolean {
    if (!input) return false;
    for (const { re } of SECRET_PATTERNS) {
        re.lastIndex = 0;
        if (re.test(input)) return true;
    }
    return false;
}
