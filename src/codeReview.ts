import { getGitDiff, getGitDiffForRange } from './gitContext';
import { logInfo, logWarn } from './logger';

export interface ReviewRequest {
    prompt: string;
    diffSummary: string;
}

/**
 * Build a code review prompt from the current git diff.
 * Returns null if there are no changes or git is unavailable.
 */
export async function buildReviewRequest(root: string): Promise<ReviewRequest | null> {
    const result = await getGitDiff(root);

    if (!result) {
        logWarn('[codeReview] Git not available');
        return null;
    }

    if (result.clean) {
        return null;
    }

    const prompt =
        `Review my uncommitted changes for bugs, inconsistencies, and race conditions. ` +
        `First check project memory for relevant conventions, then for each changed file note:\n` +
        `- Bugs or logic errors (off-by-one, null dereference, wrong condition)\n` +
        `- Race conditions or concurrency issues (shared state, async ordering, missing awaits)\n` +
        `- Inconsistencies with surrounding code (naming, error handling style, patterns)\n` +
        `- Security concerns (injection, path traversal, data exposure)\n` +
        `- Missing error handling at boundaries\n\n` +
        `Be concise and direct. Group findings by file. If everything looks correct, say so.\n\n` +
        `**Changes** (${result.summary}):\n` +
        `\`\`\`diff\n${result.diff}\n\`\`\``;

    logInfo(`[codeReview] Built review prompt — ${result.summary}`);
    return { prompt, diffSummary: result.summary };
}

/**
 * Build a review prompt for a specific commit range.
 */
export async function buildCommitReviewRequest(
    root: string,
    commitRange: string
): Promise<ReviewRequest | null> {
    const result = await getGitDiffForRange(root, commitRange);
    if (!result || result.clean) { return null; }

    const prompt =
        `Review these changes (${commitRange}) for bugs, inconsistencies, and race conditions. ` +
        `First check project memory for relevant conventions, then for each file note:\n` +
        `- Bugs or logic errors (off-by-one, null dereference, wrong condition)\n` +
        `- Race conditions or concurrency issues (shared state, async ordering, missing awaits)\n` +
        `- Inconsistencies with surrounding code (naming, error handling style, patterns)\n` +
        `- Security concerns (injection, path traversal, data exposure)\n` +
        `- Missing error handling at boundaries\n\n` +
        `Be concise and direct. Group findings by file. If everything looks correct, say so.\n\n` +
        `**Changes** (${result.summary}):\n` +
        `\`\`\`diff\n${result.diff}\n\`\`\``;

    return { prompt, diffSummary: result.summary };
}
