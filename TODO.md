# Parallel Batch — Follow-up Tasks

## High Value
- [x] Unit tests for parallel batch path (SAFE_SHELL_RE, metacharacter guard, _lastReadFilePath snapshot) — 76 tests in src/test/unit/parallelBatch.test.ts
- [x] Audit executeTool for other shared mutable state — only `_lastReadFilePath` was a real race (already fixed). `_trackFileRead`/`_filesReadThisSession` is synchronous and safe. `_toolCallsThisRun` is read-only in parallel paths. No further action needed.

## Medium Value
- [x] Make SAFE_SHELL_RE configurable via ollamaForge.safeShellCommands setting — added to package.json, isSafeShellCommand accepts extraPatterns, call site reads the setting
- [x] Log offending command when shell_read falls through to sequential — now logs the specific unsafe command(s)

## Lower Priority
- [x] Add comment on Agent._middlewares iteration safety in parallel pre-hook loop — added safety note explaining single-threaded iteration, skip-on-unregister behavior, and post-hook snapshot pattern
