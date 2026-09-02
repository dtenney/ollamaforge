# Self-Reflection Effort — Tracking

Created: 2026-09-02
Status: **Complete**

## Problem
Agent hallucinates causes for tool failures (e.g. claiming a "firewall" blocked a command when the error output said something else). The Dream Agent catches this offline, but the bad behavior already happened in-session.

## Goal
Add a lightweight in-session self-check so the agent verifies its claims against actual tool output before presenting them to the user.

## Design Constraints
- No full reflection loop per turn (too expensive for local Ollama)
- Must work with existing agent loop in `src/agent.ts`
- Should be a prompt-level guard, not a new tool
- Must not add significant latency

## Proposed Approach
1. **Post-tool-result self-check prompt** — after each tool result is injected, add a one-line instruction: "Before stating a cause for any failure, quote the exact error text from the tool output. If the error text does not mention X, do not claim X."
2. **Guard in `appendToken` / `finalizeMessage`** (webview) — detect common hallucination patterns ("firewall", "blocked by", "policy violation") and flag them if the corresponding tool result doesn't contain those words.
3. **Dream Agent rule** — add a Tier 4 memory rule: "Never invent a cause for a tool failure. Quote the exact error text."

## Files to Modify
- [x] `src/agent.ts` — add self-check instruction to tool-result injection prompt (lines 7705 & 7710)
- [x] `webview/webview.js` — hallucination-pattern detector in `finalizeMessage` (checkHallucinationPatterns + CSS warning)
- [x] Memory Tier 4 — add the "never invent causes" rule (id: t4_1788375504136_1le0)

## Status Log
| Date | Change | Status |
|------|--------|--------|
| 2026-09-02 | Tracking file created | ✅ |
| 2026-09-02 | agent.ts self-check prompt (lines 7705 & 7710) | ✅ |
| 2026-09-02 | webview hallucination detector | ✅ |
| 2026-09-02 | Memory Tier 4 rule saved | ✅ |

## Decisions Made
- Lightweight prompt-level guard, NOT a full reflection loop
- No new tool added
- Webview detector is optional / nice-to-have

## Open Questions
- ~~Should the self-check apply to ALL tool results or only `run_command` / `shell_read`?~~ → Applied to ALL tool results (both success and error paths in agent.ts).
- ~~Is a webview-side detector worth the complexity, or is the prompt guard sufficient?~~ → Both implemented. Prompt guard is the primary defense; webview detector is a visual safety net.
