# Agent Harness Decomposition

**Goal:** Break `Agent.run()` (~6,700 lines) and `Agent.executeTool()` (~4,200 lines) into
composable, individually-testable components so the agent becomes a true harness —
swappable model, swappable tools, swappable context strategy — each testable in isolation.

**Current state:**
- `Agent.run()` — lines 2738 → ~9458 (≈6,700 lines), 1,181 `this.` refs, 135 external locals
- `Agent.executeTool()` — lines 10127 → ~14339 (≈4,200 lines), monolithic switch on tool name
- ~100+ private fields on `Agent` (counters, caches, limits, managers) all reachable from both methods
- Already extracted (pure helpers): `agentLoop.ts`, `agentPromptBuilder.ts`, `agentShellEnv.ts`,
  `agentToolJsonRepair.ts`, `loopDetector.ts`, `commandPolicy.ts`, `secretRedaction.ts`,
  `pathPolicy.ts`, `verification.ts`, `buildGate.ts`, `preEdit.ts`, `planFile.ts`,
  `planStepTracker.ts`, `planGrounding.ts`, `memoryNudge.ts`, `projectTracking.ts`,
  `truncationContinuation.ts`, `contextFanout.ts`, `modelRecommendations.ts`
- Harness test: `src/test/unit/agentHarness.test.ts` (1,366 lines) — end-to-end only, no unit isolation

## Phase 0 — Inventory & Contracts

- [x] **0.1** Map every `this.` reference in `run()` to a named category:
      (a) config/limits constants, (b) mutable loop state, (c) service deps (memory, codeIndex, ollama),
      (d) UI/post callbacks, (e) static helpers
- [x] **0.2** Map every `this.` reference in `executeTool()` the same way
- [x] **0.3** Define the `TurnContext` interface — the bag of state the turn loop needs
      (history, stopRef, postFn, model, toolMode, loop counters, service refs, config limits)
- [x] **0.4** Define the `ToolDispatchContext` interface — what `executeTool` needs
      (args, toolName, workspaceRoot, memory, codeIndex, pathPolicy, commandPolicy, etc.)
- [x] **0.5** Write the interfaces in `src/harness/types.ts` (no logic, just types)
- [x] **0.6** Identify all fields mutated by **both** `run()` and `executeTool()` in the same turn
      (e.g. `_mergeEditedSinceLastDelete`, `_failedCommandSignatures`, `_toolCallsThisRun`).
      Assign explicit ownership to either `TurnContext` or `ToolDispatchContext` — fields with
      split ownership are the highest-risk extractions and must be resolved before Phase 1 starts.
      → All shared fields live in `LoopState` (types.ts), owned by `TurnContext.loop`.
- [x] **0.7** Identify the ~25 counters/flags reset at the top of `run()` and decide where
      state-reset logic lives post-refactor (likely `TurnContext` constructor or a `reset()` method)
      → `LoopState` is re-created each `run()` call; `TurnContext` constructor sets it.

## Phase 1 — Extract Context Assembly

- [x] **1.1** Extract the "build system prompt + context" block from `run()` into
      `src/harness/contextAssembler.ts` — takes `TurnContext`, returns `OllamaMessage[]`
      → Done: `assembleContext(ctx: TurnContext): Promise<AssembledContext>` in `src/harness/contextAssembler.ts`
- [x] **1.2** Extract the "compact / trim history" logic into the same module or
      `src/harness/historyManager.ts`
      → Done: `HistoryManager.handleAutoCompact()` in `src/harness/historyManager.ts`, unit-tested in `src/test/unit/historyManager.test.ts` (6 tests passing)
- [x] **1.3** Unit-test: given a fixed history + workspace, assert the assembled message array
      → Done: `src/test/unit/contextAssembler.test.ts` (11 tests passing)
- [ ] **1.4** Wire `run()` to call the new module; verify build + harness tests pass
      **Scope:** `assembleContext()` replaces only the system-prompt + memory + nudge + context-budget
      assembly (approx lines 4269–4900 in current agent.ts). The following blocks stay in `run()`:
      - Sweep detection (lines ~4350–4372) — mutates `this._isSweepTask`, must stay in Agent
      - Max-turns calculation (lines ~4373–4380) — reads config + loop state, stays in Agent
      - Context fanout / adaptive graph context (lines ~4440–4461+) — stays in Agent for now
        (will move to `TurnExecutor` in Phase 2)
      **How to wire:** Build a `TurnContext` from `this.*` fields, call `assembleContext(ctx)`,
      destructure `{ messages, systemContent, memoryContext, contextFileMtimes }` and assign
      to the locals that the existing code downstream already uses. Do not change downstream code.
      **Do not stop if context is running low** — write progress to `plans/agent-harness-decomposition.md`
      checkboxes and a one-line status note at the bottom, then continue in the same session.
      If a single edit is too large, split it: replace the top half of the block first, verify tsc,
      then the bottom half.

## Phase 2 — Extract the Turn Loop

- [ ] **2.1** Extract the core "call model → parse response → dispatch tools → loop" cycle
      into `src/harness/turnExecutor.ts` — a class or function that takes `TurnContext`
      and a `ToolDispatcher` (interface), returns a `TurnResult`
- [ ] **2.2** Extract the "parse tool calls from model output" logic (native + text mode)
      into `src/harness/responseParser.ts`
- [ ] **2.3** Extract the loop-detection / stall / idle-nudge / abort logic into
      `src/harness/loopGuard.ts` (wraps existing `loopDetector.ts` + inline counters)
- [ ] **2.4** Unit-test: scripted model responses → assert tool dispatch order, abort on spiral,
      idle nudge at turn 5, hard break at turn 10
- [ ] **2.5** Wire `run()` to delegate to `TurnExecutor`; verify build + harness tests pass

## Phase 3 — Extract Tool Dispatch

- [ ] **3.1** Extract the `executeTool()` switch into `src/harness/toolDispatcher.ts`
      — a class implementing a `ToolDispatcher` interface, one method per tool
- [ ] **3.2** Extract the "pre-exec allowlist / sandbox / SSH parse" block into
      `src/harness/toolPreprocessor.ts` (wraps existing `commandPolicy.ts`, `pathPolicy.ts`)
- [ ] **3.3** Extract the "post-exec verification / build gate / secret redaction" block into
      `src/harness/toolPostprocessor.ts` (wraps existing `verification.ts`, `buildGate.ts`,
      `secretRedaction.ts`)
- [ ] **3.4** Unit-test: each tool method in isolation with mocked deps
      (read_file, edit_file, shell_read, run_command, memory_*, etc.)
- [ ] **3.5** Wire `TurnExecutor` to use `ToolDispatcher`; verify build + harness tests pass

## Phase 4 — Slim Down Agent

- [ ] **4.1** `Agent.run()` becomes a thin orchestrator:
      build `TurnContext` → create `ContextAssembler` → create `ToolDispatcher` →
      call `TurnExecutor.execute()` → post results
- [ ] **4.2** Move remaining private fields to the appropriate harness modules
      (loop counters → `LoopGuard`, service refs → `TurnContext`, limits → config object)
- [ ] **4.3** `Agent` class should be < 1000 lines (constructor is ~300 lines alone; target is thin orchestration, not arbitrary line count)
- [ ] **4.4** Verify: `npm run bundle`, `npm run test:unit`, `npm run deploy` all pass

## Phase 5 — Harness Test Expansion

- [ ] **5.1** Add unit tests for `ContextAssembler` (fixed workspace → expected messages)
- [ ] **5.2** Add unit tests for `TurnExecutor` (scripted model → expected tool calls)
- [ ] **5.3** Add unit tests for `ToolDispatcher` (each tool, mocked deps)
- [ ] **5.4** Add unit tests for `LoopGuard` (spiral, idle, repeat detection)
- [ ] **5.5** Keep existing `agentHarness.test.ts` as the integration regression suite
- [ ] **5.6** Target: every harness module has ≥ 80% line coverage

## Phase 6 — Swappability (the "harness" payoff)

- [ ] **6.1** `TurnExecutor` accepts a `ModelClient` interface (not `ollamaClient` directly)
      → enables swapping to any local inference backend
- [ ] **6.2** `ToolDispatcher` is registered via a `ToolRegistry` → enables adding/removing
      tools without touching the loop
- [ ] **6.3** `ContextAssembler` accepts a `ContextStrategy` interface → enables swapping
      relevance scoring (smartContext vs codeGraph vs custom)
- [ ] **6.4** Document the harness architecture in `ARCHITECTURE.md`

## Risks & Notes

- **Biggest risk:** `executeTool()` has ~4,200 lines with deeply nested conditionals
  (edit_file string-matching, shell sandbox, SSH, memory tier routing). Phase 3 is the
  hardest phase. Consider splitting it into 3a (read-only tools), 3b (write tools),
  3c (shell/SSH), 3d (memory/meta) to keep each PR reviewable.
- **Do NOT change behavior.** Every extraction must be a pure refactor — same inputs,
  same outputs. The harness tests are the safety net.
- **`TurnContext` scope discipline.** If `TurnContext` ends up with 60+ fields it has become
  a god object — same problem, different name. Flag this during Phase 0 review.
- **Harness test OOM.** `agentHarness.test.ts` already causes heap exhaustion when run
  alongside other tests. Any new harness tests added in Phase 5 must be excluded from the
  parallel test run (`--ignore`) and run separately with `NODE_OPTIONS=--max-old-space-size=4096`.
- **The `plans/run-decomposition.md` referenced in `agentLoop.ts` header does not exist.**
  This file supersedes it.
- **Order matters:** Phase 1 → 2 → 3 must be sequential (each depends on the previous
  interfaces). Phase 4 can start once Phase 3 is wired. Phases 5 and 6 can overlap.

## Working rules for the agent
- **Never stop due to context budget.** Write a one-line status note at the bottom of this file
  and continue. If an edit is too large for one shot, split it into two smaller edits.
- **Track progress here.** Check off items as they complete. Add a `→ status:` note to any
  item that is partially done so the next turn knows where to pick up.
- **Ask one clarifying question max.** If scope is unclear, make a reasonable assumption,
  document it in the plan, and proceed. Do not stop to ask.

## Next action:
Phase 1.4 — wire `assembleContext()` into `run()`. See scope note above.
