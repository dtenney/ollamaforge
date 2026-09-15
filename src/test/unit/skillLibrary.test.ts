import * as assert from 'assert';
import {
    getSkillToolAllowlist,
    getSkillModelOverride,
    matchesSkillTriggers,
    formatTriggerHint,
    findSkillByTrigger,
    SkillManifest,
} from '../../skillLibrary';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSkill(overrides: Partial<SkillManifest> = {}): SkillManifest {
    return {
        name: 'test-skill',
        description: 'A test skill',
        prompt: 'You are a test skill.',
        tools: ['read_file', 'edit_file'],
        ...overrides,
    };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('skillLibrary', () => {

    describe('getSkillToolAllowlist', () => {
        it('returns null for undefined skill', () => {
            assert.strictEqual(getSkillToolAllowlist(undefined), null);
        });

        it('returns null when tools array is empty (all tools allowed)', () => {
            const skill = makeSkill({ tools: [] });
            assert.strictEqual(getSkillToolAllowlist(skill), null);
        });

        it('returns the tools array when non-empty', () => {
            const skill = makeSkill({ tools: ['read_file', 'search_files'] });
            assert.deepStrictEqual(getSkillToolAllowlist(skill), ['read_file', 'search_files']);
        });
    });

    describe('getSkillModelOverride', () => {
        it('returns undefined for undefined skill', () => {
            assert.strictEqual(getSkillModelOverride(undefined), undefined);
        });

        it('returns undefined when no model set', () => {
            const skill = makeSkill({ model: undefined });
            assert.strictEqual(getSkillModelOverride(skill), undefined);
        });

        it('returns the model string when set', () => {
            const skill = makeSkill({ model: 'llama3.1:70b' });
            assert.strictEqual(getSkillModelOverride(skill), 'llama3.1:70b');
        });
    });

    describe('matchesSkillTriggers', () => {
        it('returns true when skill has no triggers (always matches)', () => {
            const skill = makeSkill({ trigger: undefined, triggers: undefined });
            assert.strictEqual(matchesSkillTriggers(skill, 'anything'), true);
        });

        it('returns false for empty query when triggers exist', () => {
            const skill = makeSkill({ triggers: ['refactor'] });
            assert.strictEqual(matchesSkillTriggers(skill, ''), false);
            assert.strictEqual(matchesSkillTriggers(skill, '   '), false);
        });

        it('matches when query contains a trigger (case-insensitive)', () => {
            const skill = makeSkill({ triggers: ['Refactor'] });
            assert.strictEqual(matchesSkillTriggers(skill, 'please refactor this'), true);
        });

        it('matches legacy single trigger field', () => {
            const skill = makeSkill({ trigger: 'debug', triggers: undefined });
            assert.strictEqual(matchesSkillTriggers(skill, 'I need to debug this'), true);
        });

        it('does not match when no trigger is in the query', () => {
            const skill = makeSkill({ triggers: ['refactor', 'migrate'] });
            assert.strictEqual(matchesSkillTriggers(skill, 'just read this file'), false);
        });

        it('matches if ANY trigger is present', () => {
            const skill = makeSkill({ triggers: ['refactor', 'migrate', 'deploy'] });
            assert.strictEqual(matchesSkillTriggers(skill, 'deploy to prod'), true);
        });
    });

    describe('formatTriggerHint', () => {
        it('returns empty string when no triggers', () => {
            const skill = makeSkill({ trigger: undefined, triggers: undefined });
            assert.strictEqual(formatTriggerHint(skill), '');
        });

        it('formats triggers into a hint string', () => {
            const skill = makeSkill({ triggers: ['refactor', 'migrate'] });
            assert.strictEqual(formatTriggerHint(skill), ' (applies to: refactor, migrate)');
        });

        it('caps at 8 triggers', () => {
            const triggers = Array.from({ length: 12 }, (_, i) => `t${i}`);
            const skill = makeSkill({ triggers });
            const hint = formatTriggerHint(skill);
            // Should contain only first 8
            assert.ok(hint.includes('t7'));
            assert.ok(!hint.includes('t8'));
        });

        it('strips HTML special chars from triggers', () => {
            const skill = makeSkill({ triggers: ['<script>alert</script>'] });
            const hint = formatTriggerHint(skill);
            assert.ok(!hint.includes('<'));
            assert.ok(!hint.includes('>'));
        });
    });

    describe('findSkillByTrigger', () => {
        it('returns undefined when no skills match', () => {
            const skills = new Map<string, SkillManifest>();
            skills.set('a', makeSkill({ name: 'a', triggers: ['alpha'] }));
            assert.strictEqual(findSkillByTrigger(skills, 'nothing here'), undefined);
        });

        it('finds a skill by trigger keyword', () => {
            const skills = new Map<string, SkillManifest>();
            skills.set('review', makeSkill({ name: 'review', triggers: ['code review'] }));
            const found = findSkillByTrigger(skills, 'do a code review please');
            assert.strictEqual(found?.name, 'review');
        });

        it('returns undefined for empty map', () => {
            const skills = new Map<string, SkillManifest>();
            assert.strictEqual(findSkillByTrigger(skills, 'anything'), undefined);
        });
    });
});
