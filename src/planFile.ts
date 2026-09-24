// src/planFile.ts
// Plan-file management extracted from agent.ts (Phase 2, agent-decomposition-plan.md).
//
// The Agent keeps `_activePlanFile` as its source of truth. These functions are
// pure with respect to Agent state: they take the workspace root / active plan
// path / completed steps as arguments and return or mutate only the file on disk.
//
//   writePlanFile(root, task, steps) -> string | null   (created path, or null on failure)
//   updatePlanFile(activePlanFile, stepsCompleted)       (ticks off completed steps)
//   closePlanFile(activePlanFile)                         (marks all steps done)
//
// The Agent's thin private methods assign the returned path to `_activePlanFile`
// and clear it after close, preserving the exact prior behavior.

import * as fs from 'fs';
import * as path from 'path';
import { logInfo, logWarn, toErrorMessage } from './logger';

/**
 * Derive a short filesystem-safe slug from a task description.
 * (Was `Agent.planSlug`.)
 */
export function planSlug(message: string): string {
    const stopWords = new Set(['a','an','the','to','for','of','in','on','at','by','with','and','or','that','this','from','into','please','just','can','you','we','i','my','our']);
    return message
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .split(/\s+/)
        .filter(w => w.length > 2 && !stopWords.has(w))
        .slice(0, 4)
        .join('-') || 'task';
}

/**
 * Create a plan file at plans/<slug>.md.
 * Returns the created file path, or null if it could not be written.
 */
export function writePlanFile(workspaceRoot: string, task: string, steps: string[]): string | null {
    if (!workspaceRoot) { return null; }
    try {
        const plansDir = path.join(workspaceRoot, 'plans');
        if (!fs.existsSync(plansDir)) { fs.mkdirSync(plansDir, { recursive: true }); }
        const slug = planSlug(task);
        const filePath = path.join(plansDir, `${slug}.md`);
        const now = new Date().toISOString().slice(0, 10);
        const stepLines = steps.map(s => `- [ ] ${s}`).join('\n');
        const content = [
            `# Plan: ${task.slice(0, 80)}`,
            ``,
            `**Created**: ${now}`,
            `**Status**: in progress`,
            ``,
            `## Steps`,
            stepLines,
            ``,
            `## Notes`,
            ``,
        ].join('\n');
        fs.writeFileSync(filePath, content, 'utf8');
        logInfo(`[plan] Created plan file: plans/${slug}.md (${steps.length} steps)`);
        return filePath;
    } catch (err) {
        logWarn(`[plan] Could not write plan file: ${toErrorMessage(err)}`);
        return null;
    }
}

/**
 * Tick off completed steps and update the status line of an active plan file.
 * No-ops when `activePlanFile` is null.
 */
export function updatePlanFile(activePlanFile: string | null, stepsCompleted: string[]): void {
    if (!activePlanFile) { return; }
    try {
        let content = fs.readFileSync(activePlanFile, 'utf8');
        // Tick off any step whose text appears in stepsCompleted
        for (const done of stepsCompleted) {
            // Match "- [ ] <something containing the done text>" case-insensitively
            content = content.replace(
                new RegExp(`- \\[ \\] (.*${done.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\n]*)`, 'i'),
                '- [x] $1'
            );
            // Also try matching by filename fragment (e.g. "routes.py" in step text)
            const fileBase = done.replace(/^Edited\s+/i, '').split('/').pop() ?? '';
            if (fileBase) {
                content = content.replace(
                    new RegExp(`- \\[ \\] ([^\n]*${fileBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\n]*)`, 'i'),
                    '- [x] $1'
                );
            }
        }
        // Update status line
        const allDone = !content.includes('- [ ]');
        content = content.replace(/\*\*Status\*\*: .*/, `**Status**: ${allDone ? 'done' : 'in progress'}`);
        fs.writeFileSync(activePlanFile, content, 'utf8');
    } catch { /* silent -- plan update must never interrupt the agent */ }
}

/**
 * Mark an active plan file as complete (all steps done).
 * No-ops when `activePlanFile` is null.
 */
export function closePlanFile(activePlanFile: string | null): void {
    if (!activePlanFile) { return; }
    try {
        let content = fs.readFileSync(activePlanFile, 'utf8');
        content = content.replace(/\*\*Status\*\*: .*/, '**Status**: done');
        // Tick any remaining unchecked boxes
        content = content.replace(/- \[ \] /g, '- [x] ');
        fs.writeFileSync(activePlanFile, content, 'utf8');
        logInfo(`[plan] Closed plan file: ${path.basename(activePlanFile)}`);
    } catch { /* silent */ }
}
