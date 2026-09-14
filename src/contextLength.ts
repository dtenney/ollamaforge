/**
 * contextLength.ts — Context-length checking utilities (ported from ollama-vscode).
 *
 * Ollama's `/api/ps` endpoint reports the context_length actually allocated
 * to each loaded model. If that value is below a minimum threshold, the model
 * will silently truncate long conversations. These helpers let us detect and
 * warn about that condition before the user hits a wall.
 */

/** Minimum context length (tokens) we consider usable. 64K is the floor. */
export const minimumMachineContextLength = 64 * 1024;

interface OllamaProcessModel {
    name?: unknown;
    model?: unknown;
    context_length?: unknown;
}

/**
 * Extract the context_length for a specific model from an `/api/ps` response.
 * Returns undefined if the model isn't loaded or the field is missing.
 */
export function machineContextLength(
    models: readonly unknown[],
    requestedModel: string
): number | undefined {
    const requestedKey = modelKey(requestedModel);

    for (const candidate of models) {
        if (!isRecord(candidate)) { continue; }

        const model = candidate as OllamaProcessModel;
        const matches = [model.name, model.model].some(name =>
            typeof name === 'string' && modelKey(name) === requestedKey
        );
        if (matches && isPositiveInteger(model.context_length)) {
            return model.context_length;
        }
    }

    return undefined;
}

/** Check if the allocated context length is below the usable minimum. */
export function isMachineContextTooSmall(contextLength: number): boolean {
    return contextLength < minimumMachineContextLength;
}

/** Human-readable format: 65536 → "64K", 131072 → "128K", 1000 → "1,000". */
export function formatContextLength(contextLength: number): string {
    return contextLength % 1024 === 0
        ? `${contextLength / 1024}K`
        : contextLength.toLocaleString('en-US');
}

/** Normalize a model name for comparison (strip `:latest`, lowercase). */
function modelKey(name: string): string {
    const normalized = name.trim().toLowerCase();
    return normalized.endsWith(':latest')
        ? normalized.slice(0, -':latest'.length)
        : normalized;
}

function isPositiveInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
