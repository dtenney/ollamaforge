/**
 * skillLibrary.ts — load, validate, and resolve skill manifests from .ollamaforge/skills/
 *
 * A skill is a JSON file that bundles a prompt, a tool allowlist, and an optional
 * model override. When the agent activates a skill via the `use_skill` tool,
 * the available tool set is restricted to the skill's allowlist and the model
 * is swapped if one is specified.
 */

import * as fs from 'fs';
import * as path from 'path';
import { logInfo, logWarn } from './logger';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SkillManifest {
    name: string;            // unique identifier, e.g. "code-review"
    description: string;     // human-readable description shown in tool list
    prompt: string;          // system-prompt fragment injected when skill is active
    tools: string[];         // allowlist of tool names (empty = all tools)
    model?: string;          // optional model override (e.g. "llama3.1:70b")
    trigger?: string;        // optional single keyword (legacy) — prefer triggers
    triggers?: string[];     // optional list of keywords that auto-activate this skill
}

export interface SkillContext {
    active: boolean;
    skill?: SkillManifest;
}

// ── Loading ───────────────────────────────────────────────────────────────────

const SKILLS_DIR = '.ollamaforge/skills';

/**
 * Load all valid skill manifests from the workspace .ollamaforge/skills/ directory.
 * Returns a map keyed by skill name. Invalid files are logged and skipped.
 */
export function loadSkills(workspaceRoot: string): Map<string, SkillManifest> {
    const skills = new Map<string, SkillManifest>();
    const dir = path.join(workspaceRoot, SKILLS_DIR);

    if (!fs.existsSync(dir)) {
        return skills;
    }

    let entries: string[];
    try {
        entries = fs.readdirSync(dir);
    } catch (e: any) {
        logWarn(`[skillLibrary] Cannot read ${dir}: ${e.message}`);
        return skills;
    }

    for (const entry of entries) {
        if (!entry.endsWith('.json')) { continue; }
        const filePath = path.join(dir, entry);
        try {
            const raw = fs.readFileSync(filePath, 'utf-8');
            const manifest: SkillManifest = JSON.parse(raw);
            const validated = validateManifest(manifest);
            if (validated) {
                skills.set(validated.name, validated);
                logInfo(`[skillLibrary] Loaded skill: ${validated.name}`);
            } else {
                logWarn(`[skillLibrary] Invalid manifest skipped: ${entry}`);
            }
        } catch (e: any) {
            logWarn(`[skillLibrary] Failed to parse ${entry}: ${e.message}`);
        }
    }

    return skills;
}

// ── Validation ────────────────────────────────────────────────────────────────

function validateManifest(m: any): SkillManifest | null {
    if (!m || typeof m !== 'object') { return null; }
    if (typeof m.name !== 'string' || !m.name.trim()) { return null; }
    if (typeof m.description !== 'string' || !m.description.trim()) { return null; }
    if (typeof m.prompt !== 'string' || !m.prompt.trim()) { return null; }
    if (m.tools !== undefined && !Array.isArray(m.tools)) { return null; }
    if (m.model !== undefined && typeof m.model !== 'string') { return null; }
    if (m.trigger !== undefined && typeof m.trigger !== 'string') { return null; }
    if (m.triggers !== undefined && !Array.isArray(m.triggers)) { return null; }

    return {
        name: m.name.trim(),
        description: m.description.trim(),
        prompt: m.prompt,
        tools: Array.isArray(m.tools) ? m.tools.filter((t: any) => typeof t === 'string') : [],
        model: typeof m.model === 'string' ? m.model : undefined,
        trigger: typeof m.trigger === 'string' ? m.trigger : undefined,
        triggers: Array.isArray(m.triggers)
            ? m.triggers.filter((t: any) => typeof t === 'string' && t.trim()).map((t: string) => t.trim())
            : undefined,
    };
}

// ── Resolution ────────────────────────────────────────────────────────────────

/**
 * Get the tool allowlist for an active skill.
 * Returns the skill's tools array, or null if the skill allows all tools.
 */
export function getSkillToolAllowlist(skill: SkillManifest | undefined): string[] | null {
    if (!skill) { return null; }
    if (skill.tools.length === 0) { return null; } // empty = all tools allowed
    return skill.tools;
}

/**
 * Get the model override for an active skill, or undefined to use default.
 */
export function getSkillModelOverride(skill: SkillManifest | undefined): string | undefined {
    if (!skill || !skill.model) { return undefined; }
    return skill.model;
}

/**
 * Check whether a skill's declared triggers match the current user query.
 * Skills with NO triggers always pass (backward-compat — always inject).
 * Skills with triggers only inject when at least one trigger is a
 * case-insensitive substring of the query.
 */
export function matchesSkillTriggers(skill: SkillManifest, query: string): boolean {
    const triggers = skill.triggers ?? (skill.trigger ? [skill.trigger] : []);
    if (triggers.length === 0) { return true; }
    if (!query || query.trim().length === 0) { return false; }
    const haystack = query.toLowerCase();
    return triggers.some(t => {
        const needle = t.toLowerCase().trim();
        return needle.length > 0 && haystack.includes(needle);
    });
}

/**
 * Build a short "(applies to: a, b, c)" hint string for prompt injection.
 * Capped at 8 triggers to avoid prompt bloat.
 */
const TRIGGER_HINT_MAX = 8;

export function formatTriggerHint(skill: SkillManifest): string {
    const triggers = (skill.triggers ?? (skill.trigger ? [skill.trigger] : []))
        .map(t => t.replace(/[<>"&]/g, ''))
        .slice(0, TRIGGER_HINT_MAX);
    if (triggers.length === 0) { return ''; }
    return ` (applies to: ${triggers.join(', ')})`;
}

/**
 * Find a skill by its trigger keyword(s) (case-insensitive substring match).
 * Supports both legacy single `trigger` and new `triggers` array.
 */
export function findSkillByTrigger(skills: Map<string, SkillManifest>, message: string): SkillManifest | undefined {
    const lower = message.toLowerCase();
    for (const skill of skills.values()) {
        const triggers = skill.triggers ?? (skill.trigger ? [skill.trigger] : []);
        if (triggers.some(t => { const n = t.toLowerCase().trim(); return n.length > 0 && lower.includes(n); })) {
            return skill;
        }
    }
    return undefined;
}

/**
 * Build the list of available skill names + descriptions for the tool definition.
 */
export function getSkillList(skills: Map<string, SkillManifest>): { name: string; description: string }[] {
    return Array.from(skills.values()).map(s => ({ name: s.name, description: s.description }));
}
