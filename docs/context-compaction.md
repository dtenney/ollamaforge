# Context Management & Compaction

Ollama Forge manages the model's context window across a conversation. It monitors
usage every turn, and when usage crosses a threshold it compacts the history —
shrinking large tool outputs, dropping low-value messages, and injecting a
structured summary so the agent can resume without losing direction.

All logic lives in `src/contextCalculator.ts` (pure helpers) and `src/agent.ts`
(the turn-loop orchestration).

## Components

| Function | Role |
|---|---|
| `calculateContextStats` | Fast heuristic (chars/4) per-turn usage monitoring. |
| `calculateContextStatsAccurate` | Uses Ollama `/api/tokenize` for system + memory (cached), heuristic for history. Used to verify before compacting — guards against the 20–30% drift of the char/4 estimate on large-vocabulary models. |
| `getModelContextLimit` | Synchronous lookup of a model's context window (hardcoded table + session cache). |
| `resolveModelContextLimit` | Async resolution from Ollama `/api/show`. Session-cached, with in-flight dedup via `pendingResolutions` (cleaned up in `finally`). |
| `shrinkLargeToolMessages` | Proportionally truncates the largest tool/user messages to fit a token budget. Returns a **new array** (does not mutate the input). |
| `compactHistory` | Score-based compaction. Returns `{ kept, dropped }`. |
| `scoreMessage` | Scores each message by recency + role + decision markers; lowest-value messages are dropped first. |

## Auto-compaction (agent turn loop)

Trigger: heuristic usage **≥ 80%** (`src/agent.ts` ~line 4610).

1. **Verify** with `calculateContextStatsAccurate`. If the accurate count is **< 70%**, skip compaction (the heuristic over-estimated).
2. **Early-compaction stall check** — if context fills before any work is done (turn ≤ 1, 0 edits, 0 tool calls) and this happens twice in a row, stop the run to avoid an unrecoverable "read plan → exhaust context → compact → repeat" loop.
3. **WIP snapshot** — build a work-in-progress snapshot and save it to Tier 2 memory (synchronous).
4. **`performCoreCompaction`**:
   - `shrinkLargeToolMessages` down to a 50% budget (largest messages first).
   - `compactHistory` down to 50%.
   - **Min-remove floor** — force at least 40% of the original message count to be dropped (guarantees forward progress).
   - **Anti-thrash** — if 3 consecutive compactions each saved < 10% of the message count, stop the loop and surface a "context compaction stuck" error.
5. **Re-inject context** — prepend the WIP snapshot + task log (`.ollamaforge/tasks/<id>/log.md`) + recent Tier 2 memory as a new user message so the model resumes with direction.

## Manual compaction

`compactContext(targetPct = 50)` (agent) — async. Runs the same shrink + compact,
then calls the model to produce a **structured JSON summary** with keys:
`task`, `next_step`, `pending_items`, `files_confirmed`, `files_ruled_out`,
`decisions`, `edits_made`, `blockers`. The summary is prepended to the history
and saved to Tier 2 memory.

The provider (`src/provider.ts` ~line 1638) guards this with `if (this._running)` —
manual compaction cannot start while a response is in progress. In Trust/Yolo mode
it auto-resumes the task after compaction.

## State

- `_compactionRatios` — rolling list of per-compaction savings ratios, used by the
  anti-thrash check. Reset on session reset (`src/agent.ts` ~line 2865).
- `resolvedLimitsCache` / `pendingResolutions` — module-level caches in
  `contextCalculator.ts`; `pendingResolutions` is always cleaned up in `finally`.

## Known issues (reviewed 2026-09-24)

1. **Anti-thrash measures message-count savings, not token savings.** *(reviewed — not a real bug)*
   `savingsRatio = messagesRemoved / oldMessageCount`. The concern was that
   `shrinkLargeToolMessages` could save many tokens while removing **zero** messages,
   driving `savingsRatio` to 0 and falsely tripping the "context compaction stuck"
   detector. In practice this cannot happen for any realistic history: the
   **min-remove floor** in `performCoreCompaction` (`src/agent.ts` ~line 17374)
   forces at least `max(floor(oldMessageCount * 0.4), 4)` messages to be dropped
   whenever `oldMessageCount > minAutoRemove`. That guarantees `savingsRatio ≥ 0.4`
   for histories of 10+ messages and `≥ 4/n` (still ≥ 0.10) for 5–9 messages. The
   thrash detector (fires only when 3 consecutive ratios are < 0.10) can therefore
   only trigger for histories of ≤ 4 messages — a degenerate case. No change needed.

2. **`performCoreCompaction` executed with heuristic stats.** *(FIXED 2026-09-24)*
   The compact *decision* was gated on `accurateStats`, but `performCoreCompaction`
   was passed the original heuristic `contextStats`. Its `targetTokens` budget and
   the `systemPromptTokens`/`memoryTokens` handed to `compactHistory` therefore used
   the char/4 estimate, not the accurate counts just computed. **Fix:** the call site
   (`src/agent.ts` ~line 4711) now passes `accurateStats`, so the action matches the
   decision. `modelLimit` is identical either way.

3. **Stale-history window during manual compaction.** *(reviewed — low risk, left as-is)*
   `compactContext` awaits the summary LLM call *before* reassigning
   `this.history` (~line 2344). During that await, `this.history` still holds the
   pre-compaction array. Low risk — the `this._running` guard blocks concurrent
   agent runs — but any code reading `this.history` in that window sees stale data.
   Left as-is; the guard makes it a non-issue in normal operation.
