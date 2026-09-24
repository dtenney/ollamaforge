// src/projectTracking.ts
// Project tracking file management — extracted from src/agent.ts.
// Handles PROJECT.md discovery, open-item reading, creation, and stamping.

import * as path from 'path';
import * as fs from 'fs';
import { logInfo, logWarn, toErrorMessage } from './logger';

/**
 * Find the active project tracking file (PROJECT.md or *.project.md) in the workspace root.
 */
export function findProjectFile(workspaceRoot: string | null): string | null {
    if (!workspaceRoot) { return null; }
    const explicit = path.join(workspaceRoot, 'PROJECT.md');
    if (fs.existsSync(explicit)) { return explicit; }
    try {
        const files = fs.readdirSync(workspaceRoot);
        const match = files.find(f => f.toLowerCase().endsWith('.project.md'));
        if (match) { return path.join(workspaceRoot, match); }
    } catch { /* non-fatal */ }
    return null;
}

/**
 * Read the unchecked items from the active project file.
 * Returns a formatted summary of open items by section, or empty if all done.
 */
export function readProjectOpenItems(activeProjectFile: string | null, workspaceRoot: string | null): string {
    const pf = activeProjectFile;
    if (!pf || !fs.existsSync(pf)) { return ''; }
    try {
        const content = fs.readFileSync(pf, 'utf8');
        const rawLines = content.split('\n');
        const openItems: string[] = [];
        let currentSection = '';
        for (const line of rawLines) {
            const sectionMatch = line.match(/^#+\s+(.+)/);
            if (sectionMatch) { currentSection = sectionMatch[1].trim(); }
            if (/^[-*]\s+\[ \]/.test(line)) {
                const item = line.replace(/^[-*]\s+\[ \]\s*/, '').trim();
                openItems.push(currentSection ? `[${currentSection}] ${item}` : item);
            }
        }
        if (openItems.length === 0) { return ''; }
        const relPath = workspaceRoot ? path.relative(workspaceRoot, pf).replace(/\\/g, '/') : pf;
        return `## Open project items (from ${relPath})\n${openItems.map(i => `- [ ] ${i}`).join('\n')}`;
    } catch { return ''; }
}

/**
 * Count unchecked checklist items in a tracking document (item 4.1 — deterministic "done" gate).
 * Returns the list of open items (with their section header) or null if the file is missing
 * or has no unchecked items. Used to hard-block a "done" declaration while items remain open.
 */
export function countTrackingDocOpenItems(docPath: string): string[] | null {
    if (!fs.existsSync(docPath)) { return null; }
    try {
        const content = fs.readFileSync(docPath, 'utf8');
        const openItems: string[] = [];
        let currentSection = '';
        for (const line of content.split('\n')) {
            const sectionMatch = line.match(/^#+\s+(.+)/);
            if (sectionMatch) { currentSection = sectionMatch[1].trim(); }
            if (/^[-*]\s+\[ \]/.test(line)) {
                const item = line.replace(/^[-*]\s+\[ \]\s*/, '').trim();
                openItems.push(currentSection ? `[${currentSection}] ${item}` : item);
            }
        }
        return openItems.length > 0 ? openItems : null;
    } catch { return null; }
}

/**
 * Create PROJECT.md for a new multi-phase project.
 * Returns the file path if created, or null on failure.
 */
export function writeProjectFile(workspaceRoot: string | null, goal: string, phases: string[], streams: string[]): string | null {
    if (!workspaceRoot) { return null; }
    try {
        const filePath = path.join(workspaceRoot, 'PROJECT.md');
        const now = new Date().toISOString().slice(0, 10);
        const fileLines: string[] = [
            `# Project: ${goal.slice(0, 100)}`,
            '',
            `**Created**: ${now}`,
            `**Last updated**: ${now}`,
            '**Status**: in progress',
            '',
        ];
        if (phases.length > 0) {
            fileLines.push('## Phases');
            for (const p of phases) { fileLines.push(`- [ ] ${p}`); }
            fileLines.push('');
        }
        if (streams.length > 0) {
            fileLines.push('## Streams');
            for (const s of streams) { fileLines.push(`- [ ] ${s}`); }
            fileLines.push('');
        }
        fileLines.push('## Notes', '');
        fs.writeFileSync(filePath, fileLines.join('\n'), 'utf8');
        logInfo(`[project] Created PROJECT.md (${phases.length} phases, ${streams.length} streams)`);
        return filePath;
    } catch (err) {
        logWarn(`[project] Could not write PROJECT.md: ${toErrorMessage(err)}`);
        return null;
    }
}

/**
 * Stamp PROJECT.md with "last updated" and a next-action line before the agent stops.
 */
export function stampProjectFile(activeProjectFile: string | null, nextAction: string): void {
    const pf = activeProjectFile;
    if (!pf || !fs.existsSync(pf)) { return; }
    try {
        let pfContent = fs.readFileSync(pf, 'utf8');
        const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
        pfContent = pfContent.replace(/\*\*Last updated\*\*: .*/, `**Last updated**: ${now}`);
        if (nextAction) {
            if (pfContent.includes('**Next action**:')) {
                pfContent = pfContent.replace(/\*\*Next action\*\*: .*/, `**Next action**: ${nextAction}`);
            } else {
                pfContent = pfContent.replace(/\*\*Status\*\*: .*/, `**Status**: in progress\n**Next action**: ${nextAction}`);
            }
        }
        fs.writeFileSync(pf, pfContent, 'utf8');
        logInfo(`[project] Stamped PROJECT.md: next=${nextAction.slice(0, 60)}`);
    } catch { /* silent */ }
}
