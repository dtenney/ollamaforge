# Skill Triggers — Multi-Trigger Injection Gate

Steal from openmake_llm: `skill-triggers.ts` pattern.

- [x] 1. Extend `SkillManifest` type: add `triggers?: string[]`, keep `trigger?: string` for backward compat
- [x] 2. Add `matchesSkillTriggers(skill, query)` gate function in skillLibrary.ts
- [x] 3. Add `formatTriggerHint(skill)` for prompt injection (capped at 8)
- [x] 4. Wire gate into agent.ts skill injection path (trigger hints block at line 5188)
- [x] 5. Verify: tsc --noEmit passes
- [x] 6. Update ARCHITECTURE.md if needed

Next action: Update ARCHITECTURE.md to note the trigger-hint feature.
