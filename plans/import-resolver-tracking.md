# Import Resolver — Tracking Plan

**Branch:** `agent/2026-08-23-agent-triggered-an-error-message`
**Latest commit:** `bd52264` — fix: AST-based import extraction + edit_file import resolver
**Date:** 2026-09-02

## What This Feature Does

Adds a **three-valued Python import validator** that runs after the agent writes or edits a `.py` file. It extracts top-level imports via Python AST and checks each via `importlib.util.find_spec` in a subprocess.

### Three-valued result
| Value | Meaning | Action |
|-------|---------|--------|
| `true` | Module exists in the environment | Silent pass |
| `false` | Module NOT found (hallucinated package) | **WRITE REJECTED** — file restored, agent gets corrective instruction |
| `null` | Could not settle (relative import, timeout, subprocess failure) | Logged silently — never reported as pass |

Design principle: false "invented" rewrites correct code with no way to discover the error, while a missed fabrication still passes tests downstream. Every ambiguous case resolves to silence.

## Files Changed

| File | Change | Purpose |
|------|--------|---------|
| `src/importResolver.ts` | Core import extraction (AST-based) + `find_spec` validation |
| `src/test/unit/importResolver.test.ts` | Unit tests for extraction + validation (397 total) |
| `package.json` | `ollamaForge.registryCheck` boolean setting (default: **false**) |
| `src/config.ts` | Config schema for `registryCheck` |
| `src/agent.ts` | **Wiring:** import resolver in `write_file` (line 11400) AND `edit_file` (line 10847) paths |

## Integration Details (verified 2026-09-02)

- **Import:** `agent.ts` line 29 — `import { validatePythonImports, formatImportWarning, validateDoctests, formatDoctestWarning, probeRegistry, formatRegistryWarning, RegistryProbeResult } from './importResolver'`
- **Call site (write_file):** `agent.ts` line 11400 — inside `case 'write_file'` block
- **Call site (edit_file):** `agent.ts` line 10847 — after `py_compile` check, inside `case 'edit_file'` block
- **Guard:** `rel.endsWith('.py')` — only fires for Python files
- **Behavior on failure:** Restores original file content, returns `WRITE REJECTED` message with corrective instructions
- **Registry probe:** Optional — if `registryCheck` is enabled, missing packages are also checked against PyPI
- **Extraction:** Python AST (`tree.body` only) — imports inside `try/except`, functions, `if` blocks are correctly skipped

## Status

- [x] **Verify wiring:** Import resolver wired in both `write_file` and `edit_file` paths
- [x] **Non-Python files:** Guarded by `rel.endsWith('.py')` — no-op for `.ts`, `.js`, etc.
- [x] **Setting name:** `ollamaForge.registryCheck`, default `false`
- [x] **Relative imports:** Correctly skipped via AST extraction
- [x] **Performance/timeout:** Default 5000ms via `execFileSync` timeout param
- [x] **`try/except ImportError` patterns:** Fixed — AST extraction skips non-top-level imports
- [x] **`edit_file` gap:** Fixed — resolver now runs on `edit_file` for `.py` files
- [x] **Unit test coverage:** 397 tests passing
- [x] **Deploy:** `npm run deploy` completed (12/12 checks passed)
- [ ] **Smoke test (user):** Reload VS Code → write a Python file with a fake import → confirm WRITE REJECTED appears

## Architecture Notes

- Inspired by **hedgemony** (three-valued import validation)
- Uses `execFileSync` with `python3 -c "import importlib.util; ..."` — no extra dependencies
- Classification taxonomy: `PACKAGE` | `MODPATH` | `IMPORT` | `UNKNOWN`
- Only top-level imports are checked (AST `tree.body` — no `try/except`, no conditional imports)
- The `false` result triggers a **WRITE REJECTED** (file restored + agent gets corrective instruction)
- Registry probe (PyPI check) is opt-in via `ollamaForge.registryCheck: true`

## Related Commits (same branch)

| Commit | Description |
|--------|-------------|
| `bd52264` | fix: AST-based import extraction + edit_file import resolver |
| `677a01a` | chore: add importResolver, update config/main/provider |
| `e7dc6b3` | chore: remove self-reflection tracking plan (feature shipped) |
| `5614941` | feat: self-reflection guards — agent prompt checks + webview hallucination detector |
| `f82c70d` | fix: shell_read timeout too short for sleep commands |
| `f8965df` | fix: spiral abort false positives and consecutive abort counter reset |
