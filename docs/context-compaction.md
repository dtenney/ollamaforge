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

## Known issues (reviewed 2026-09-22)

1. **Anti-thrash measures message-count savings, not token savings.**
   `savingsRatio = messagesRemoved / oldMessageCount`. But `shrinkLargeToolMessages`
   can save a large number of tokens while removing **zero** messages. In that case
   `savingsRatio` is 0 and the anti-thrash detector can falsely report "context
   compaction stuck" even though the token budget was met. Consider measuring token
   savings (before/after) instead of message count.

2. **`performCoreCompaction` executes with heuristic stats.**
   The compact *decision* is gated on `accurateStats`, but `performCoreCompaction`
   is passed the original heuristic `contextStats` (~line 4645). Its `targetTokens`
   budget and the `systemPromptTokens`/`memoryTokens` handed to `compactHistory`
   therefore use the char/4 estimate, not the accurate counts just computed. The
   `modelLimit` is identical either way, so this is a minor budget inaccuracy, not a
   crash — but it is inconsistent with the "verify with accurate counts" intent.

3. **Stale-history window during manual compaction.**
   `compactContext` awaits the summary LLM call *before* reassigning
   `this.history` (~line 2344). During that await, `this.history` still holds the
   pre-compaction array. Low risk — the `this._running` guard blocks concurrent
   agent runs — but any code reading `this.history` in that window sees stale data.
