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
- 2026-09-28: Extracted the parallel read-only batch result-processing loop (~50 lines) from run() into private method `processParallelBatchResults(parallelCalls, settled, post): { attempted, succeeded }`. Applies post-hook middleware, updates the per-path re-read tracker, pushes tool-result messages to history + UI; caller folds returned counts into `batchToolsAttempted`/`batchToolsSucceeded`. `tsc --noEmit` clean.
- 2026-09-28: Extracted the auto-compact block (~79 lines) from run() into private method `handleAutoCompact(contextStats, cfg, systemContent, memoryContext, model, turn, post): Promise<'continue'|'stop'|'break'>`. Maps the inline `return`→`'stop'` and `break`→`'break'` exit paths. `tsc --noEmit` clean.
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

**Recommended next step (smaller, single-session):** Continue extracting self-contained I/O-heavy blocks from within the loop body one at a time. Done so far: auto-compact section (`handleAutoCompact`) and the parallel read-only batch result-processing loop (`processParallelBatchResults`). Next: the stream-filter section, then the sequential tool-dispatch result handling. Each is 50–200 lines; verify with `tsc --noEmit` after each.

**2026-10-02 — Pre-beta readiness review (completed):**
- No personal data (IPs, paths, usernames) in `src/` — all `192.168.1.100` hits are placeholder examples in docs/config.
- No TODO/FIXME/debug artifacts in production code.
- LICENSE (MIT) present. `.gitignore` excludes `.ollamaforge/`, `.claude/`, `plans/`.
- Security layer verified: `commandPolicy.ts` (non-bypassable deny list), `secretRedaction.ts` (credential scrubbing), `pathPolicy.ts`, `webviewMsgGuard.ts`.
- 39 test files, 664+ unit tests, CI gates (audit, coverage, tsc, self-check).
- **Verdict: cleared for supervised beta.** One recommendation: gate YOLO mode behind an explicit acknowledgment before broad sharing.
