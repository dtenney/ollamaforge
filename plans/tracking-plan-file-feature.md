# Tracking Plan File Feature — Tracking Plan

**Date:** 2026-09-02
**Status:** Complete

## What This Feature Does

Instructs the agent to create a markdown tracking plan file (`plans/<slug>.md`) with `- [ ]` checkboxes for any effort with more than four steps. A completion guard blocks the agent from declaring "done" while its own plan file still has unchecked steps.

## Changes Made

| File | Change |
|------|--------|
| `src/agent.ts` line 1398 | System-prompt mandate: create tracking plan file for >4-step efforts |
| `src/agent.ts` line 3076 | `_planStopGuardFiredThisRun` flag (prevents nudge spiral) |
| `src/agent.ts` line 4039 | Reset flag at start of each run |
| `src/agent.ts` lines 7056-7075 | Plan-file completion guard (blocks "done" with unchecked steps) |
| `src/agent.ts` lines 11311-11319 | `write_file` handler: adopt `plans/*.md` as `_activePlanFile` |

## Status

- [x] System-prompt mandate for >4-step tracking plan files
- [x] Completion guard blocks "done" while plan file has unchecked steps
- [x] Per-run flag prevents nudge spiral (fires once per user message)
- [x] `write_file` handler adopts `plans/*.md` as active plan file
- [x] `tsc --noEmit` passes clean
- [x] Wiring verified: `_activePlanFile` set in 3 paths, consumed by guard + update/close logic
