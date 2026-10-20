/**
 * planStepTracker.ts — Harness-enforced plan step completion tracking.
 *
 * Problem: The model self-reports "step 3 done" but actually didn't do it.
 * Or it claims all steps done when 2 remain.
 *
 * Solution (adapted from Reika's plantrack.ts):
 *   - Parse the plan into numbered/checkbox steps.
 *   - Check steps off from harness-observed facts (path match, command match).
 *   - Build a progress ledger the model sees each turn.
 *   - Done-gate: block completion while unchecked steps remain.
 *   - All stateless — recomputed from history each turn.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PlanStep {
    index: number;
    text: string;
    checked: boolean;
    // Extracted facts for verification
    filePaths: string[];
    commands: string[];
    codeSnippets: string[];
}

export interface ProgressLedger {
    steps: PlanStep[];
    completed: number;
    total: number;
    pending: PlanStep[];
    ledgerText: string;
}

export interface ToolCallFact {
    tool: string;
    filePath?: string;
    command?: string;
    diff?: string;
    success: boolean;
}

// ─── Step Parsing ────────────────────────────────────────────────────────────

/**
 * Parse a plan file into steps. Handles:
 *   - `- [ ]` / `- [x]` checkboxes
 *   - `1.` / `2.` numbered steps
 *   - `## Section` headers (group steps)
 */
export function parsePlanSteps(planText: string): PlanStep[] {
    const steps: PlanStep[] = [];
    const lines = planText.split('\n');
    let stepIndex = 0;

    for (const line of lines) {
        const trimmed = line.trim();

        // Checkbox: - [ ] or - [x]
        const checkboxMatch = trimmed.match(/^[-*]\s*\[([ xX])\]\s*(.+)$/);
        if (checkboxMatch) {
            const checked = checkboxMatch[1].toLowerCase() === 'x';
            const text = checkboxMatch[2];
            steps.push({
                index: stepIndex++,
                text,
                checked,
                filePaths: extractFileRefs(text),
                commands: extractCommandRefs(text),
                codeSnippets: extractCodeSnippets(text),
            });
            continue;
        }

        // Numbered: 1. or 1)
        const numberedMatch = trimmed.match(/^\d+[.)]\s*(.+)$/);
        if (numberedMatch) {
            const text = numberedMatch[1];
            steps.push({
                index: stepIndex++,
                text,
                checked: false,
                filePaths: extractFileRefs(text),
                commands: extractCommandRefs(text),
                codeSnippets: extractCodeSnippets(text),
            });
            continue;
        }
    }

    return steps;
}

/**
 * Extract file path references from step text.
 */
function extractFileRefs(text: string): string[] {
    const refs: string[] = [];
    // Backticked paths
    const backticked = text.match(/`([^`\n]+\.\w{2,10})`/g) ?? [];
    for (const b of backticked) {
        refs.push(b.slice(1, -1).trim());
    }
    // Bare paths with extensions
    const bare = text.match(/[\w./\\-]+\.\w{2,10}\b/g) ?? [];
    for (const b of bare) {
        if (!refs.includes(b)) { refs.push(b); }
    }
    return refs;
}

/**
 * Extract command references from step text.
 */
function extractCommandRefs(text: string): string[] {
    const refs: string[] = [];
    // Backticked commands
    const backticked = text.match(/`([^`\n]+)`/g) ?? [];
    for (const b of backticked) {
        const cmd = b.slice(1, -1).trim();
        if (/^(npm|npx|node|python|pip|git|bash|sh|go|cargo|make|docker|kubectl|ssh|scp|curl|wget|find|grep|ls|cat|mkdir|mv|cp|rm|tsc|esbuild|vsce|mocha|jest|pytest|ruff|black|flake8|eslint|prettier|rubocop|golangci|cargo|mvn|gradle|dotnet|bundle|gem|composer|pnpm|yarn|bun)\b/.test(cmd)) {
            refs.push(cmd);
        }
    }
    return refs;
}

/**
 * Extract code snippets from step text (inline code that looks like code, not a path/command).
 */
function extractCodeSnippets(text: string): string[] {
    const snippets: string[] = [];
    const backticked = text.match(/`([^`\n]+)`/g) ?? [];
    for (const b of backticked) {
        const s = b.slice(1, -1).trim();
        // Skip paths and commands
        if (s.includes('/') || s.includes('\\')) { continue; }
        if (/^(npm|npx|node|python|pip|git|bash|sh|go|cargo|make|docker)\b/.test(s)) { continue; }
        if (s.length > 3 && s.length < 200) { snippets.push(s); }
    }
    return snippets;
}

// ─── Fact-Based Verification ─────────────────────────────────────────────────

/**
 * Check if a tool call satisfies a step (path match, command match, or content match).
 */
export function stepSatisfiedByFact(step: PlanStep, fact: ToolCallFact): boolean {
    if (!fact.success) { return false; }

    // Path match: a successful edit/write to a file the step names
    if (step.filePaths.length > 0 && fact.filePath) {
        const normalizedFact = fact.filePath.replace(/\\/g, '/').toLowerCase();
        for (const ref of step.filePaths) {
            const normalizedRef = ref.replace(/\\/g, '/').toLowerCase();
            if (normalizedFact.includes(normalizedRef) || normalizedRef.includes(normalizedFact)) {
                return true;
            }
        }
    }

    // Command match: a successful bash run whose command contains the step's quoted command
    if (step.commands.length > 0 && fact.command) {
        const normalizedFact = fact.command.toLowerCase();
        for (const cmd of step.commands) {
            const normalizedCmd = cmd.toLowerCase();
            if (normalizedFact.includes(normalizedCmd)) {
                return true;
            }
        }
    }

    // Content match: a step-quoted code snippet appearing in a successful edit's diff
    if (step.codeSnippets.length > 0 && fact.diff) {
        for (const snippet of step.codeSnippets) {
            if (fact.diff.includes(snippet)) {
                return true;
            }
        }
    }

    return false;
}

/**
 * Verify all steps against observed facts. Returns updated steps with
 * checked status based on harness-observed completion.
 */
export function verifySteps(steps: PlanStep[], facts: ToolCallFact[]): PlanStep[] {
    return steps.map(step => {
        if (step.checked) { return step; } // already done
        for (const fact of facts) {
            if (stepSatisfiedByFact(step, fact)) {
                return { ...step, checked: true };
            }
        }
        return step;
    });
}

// ─── Progress Ledger ─────────────────────────────────────────────────────────

/**
 * Build the progress ledger text for injection into the system prompt.
 */
export function buildProgressLedger(steps: PlanStep[]): ProgressLedger {
    const completed = steps.filter(s => s.checked).length;
    const total = steps.length;
    const pending = steps.filter(s => !s.checked);

    const parts = steps.map(s => {
        const icon = s.checked ? '✓' : '○';
        return `Step ${s.index + 1} ${icon} ${s.text}`;
    });

    const ledgerText = parts.join(', ');

    return { steps, completed, total, pending, ledgerText };
}

/**
 * Build the done-gate message if there are unchecked steps.
 */
export function buildDoneGate(pending: PlanStep[]): string | null {
    if (pending.length === 0) { return null; }

    const remaining = pending.map(s => `  • Step ${s.index + 1}: ${s.text}`).join('\n');
    return `🚫 **Done-gate:** You cannot mark this task complete. ${pending.length} step(s) remain:\n${remaining}\n\nComplete the remaining steps before declaring done.`;
}

// ─── Main Entry Point ────────────────────────────────────────────────────────

export interface PlanTrackingResult {
    ledger: ProgressLedger;
    doneGate: string | null;
    newlyCompleted: PlanStep[];
}

/**
 * Run the full plan tracking check.
 */
export function trackPlanSteps(
    planText: string,
    observedFacts: ToolCallFact[],
): PlanTrackingResult {
    const rawSteps = parsePlanSteps(planText);
    const verifiedSteps = verifySteps(rawSteps, observedFacts);

    const newlyCompleted = verifiedSteps.filter(
        (s, i) => s.checked && !rawSteps[i].checked
    );

    const ledger = buildProgressLedger(verifiedSteps);
    const doneGate = buildDoneGate(ledger.pending);

    return { ledger, doneGate, newlyCompleted };
}
