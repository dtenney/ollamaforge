# Project: `src/agent.ts` Decomposition

**Created**: 2026-09-15
**Last updated**: 2026-09-26
**Status**: in progress (item 11 — incremental block extraction underway)

## Goal
Break the 17,140-line `src/agent.ts` into focused modules. No single file > 2,000 lines. Public API of `Agent` unchanged.

## Phases

### Phase 1 — flat helper modules (done)
- [x] 1. `agentShellEnv.ts`
- [x] 2. `agentToolJsonRepair.ts`
- [x] 3. `agentPromptBuilder.ts`
- [x] 4. `planFile.ts`
- [x] 5. `pathPolicy.ts`

### Phase 2 — `this`-bound method clusters (in progress)
- [x] 6. `verification.ts`
- [x] 7. `projectTracking.ts`
- [x] 8. `memoryNudge.ts`
- [x] 9. `preEdit.ts`

### Phase 3 — core loop extraction
- [x] 10. `toolExecutor.ts`
- [ ] 11. `agentLoop.ts`

## Notes
- Pattern: `this`-bound helpers become pure functions taking Agent state as explicit args; Agent keeps thin delegators.
- Static `private static readonly` fields used by a cluster move into the module as exported consts.

## Recent completions
- 2026-09-26: Extracted 5 pure helpers from run() into `src/agentLoop.ts`: `stripXmlArtifacts`, `normalizeArgVal`, `filePathInMsg`, `extractKeywords`, `generateBranchSlug`. Also hardened `provider.ts` compactContext guard (`_running` held across LLM await, Trust/Yolo auto-resume). Committed as 606f8ee. `tsc --noEmit` clean.
- 2026-09-22: Extracted `checkEarlyCompactionStall()` (~22 lines) from run() body into private method. `agent.ts` now 17,327 lines. `tsc --noEmit` clean.
- 2026-09-19: Extracted 3 large case blocks into private methods:
  - `workspace_index` (88 lines) → `executeWorkspaceIndex()`
  - `edit_file_at_line` (136 lines) → `executeEditFileAtLine()`
  - `system_map_update` (157 lines) → `executeSystemMapUpdate()`
  - `agent.ts` now 17,140 lines. Build clean, 0 tsc errors.
- 2026-09-19: Extracted `checkNoveltyFingerprint()` (~55 lines) as private method. All Phase 5 sub-extractions now complete (drift detection, WIP snapshot, compact summary, context budget msg, spiral abort recovery, think-leak rescue, stream filters, novelty fingerprint). `agent.ts` now 17,175 lines. Build clean, 0 tsc errors.

## Item 11 — `agentLoop.ts` (BLOCKED: needs fresh session)
The `run()` method spans ~7,000 lines (line 2578 → ~16,683). Extracting it into
`src/agentLoop.ts` requires reading the full body, defining `TurnContext` + `LoopResult`
types, converting all `break`/`return`/`continue` paths, and verifying compilation.
This needs a full context budget (~100k+ tokens). See `plans/run-decomposition.md`
for exact line numbers and prerequisites.

**Next session prompt:** "Continue the agent decomposition — do item 11, the agentLoop.ts extraction. Start from plans/run-decomposition.md."

## Next action (item 11 — agentLoop.ts)
**Done so far (2026-09-26):** 5 pure string/keyword helpers now live in `agentLoop.ts` (`stripXmlArtifacts`, `normalizeArgVal`, `filePathInMsg`, `extractKeywords`, `generateBranchSlug`). The full loop-body → `executeTurn()` extraction (~4,900 lines, HIGH risk) is still outstanding and needs a fresh session with full context budget (~100k+ tokens). Prerequisites: `TurnContext` type (~15 locals), `LoopResult` discriminated union, all `break`→`return {kind:'stop'}`, all `continue`→`return {kind:'continue'}`. See `plans/run-decomposition.md` for details.

**Recommended next step (smaller, single-session):** Extract the next self-contained I/O-heavy block from within the loop body one at a time — the auto-compact section (~lines 4620–4720), then the tool-result processing section, then the stream-filter section. Each is 50–200 lines; verify with `tsc --noEmit` after each.
