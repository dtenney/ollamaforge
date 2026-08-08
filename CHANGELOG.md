# Changelog

All notable changes to Ollama Forge are documented here.

## [Unreleased]

---

## [1.0.3] — 2026-08-08

### Fixed
- Compact summary and turn-limit card no longer bleed raw tool XML,
  `[SYSTEM:...]` injections, or `<think>` blocks when the model emits
  a malformed or truncated tool call
- `dispose()` now clears in-flight `delegate_task_async` handles with a
  warning log instead of silently orphaning them
- `withLock()` timeout now logs a warning when it fires so silent lock
  races surface in the log
- Pre-warm and auto-restore `setTimeout` handles registered in
  `context.subscriptions` so they cancel cleanly on extension deactivate
- Webview message handler guards against malformed/missing `command`
  field before entering the switch

### Added
- CI pipeline (GitHub Actions) — unit tests + VSIX build on every push/PR
- Dependabot — weekly npm updates, monthly Actions updates; native binary
  packages (`better-sqlite3`, `tree-sitter*`) fully pinned
- `CONTRIBUTING.md` — dev setup, test commands, project structure, PR guidelines
- `SECURITY.md` — responsible disclosure via GitHub Security Advisories
- `.editorconfig` — LF line endings, consistent indentation
- `.vscode/launch.json` — F5 extension host debug + unit test and harness debug configs
- `docs/troubleshooting.md` — common failure modes with step-by-step fixes
- CHANGELOG and trust level documentation in README
- Quick start guide and MCP server config reference in README
- CI and MIT license badges in README

### Changed
- `vscode-mock.ts` rewired to patch `Module._resolveFilename` with an
  inline stub — no longer depends on a non-existent `node_modules/vscode` package
- `test:unit` now correctly excludes `agentHarness.test.js` (needs live
  Ollama) and includes the vscode mock; `test:coverage` updated to match

---

## [1.0.2] — 2026-08-07

### Fixed
- `scripts/deploy.js` now derives the extension root path from `package.json` version dynamically instead of a hardcoded string
- Error message when no models are available now correctly references `ollamaForge.serverUrl` instead of a generic placeholder

### Changed
- `settings.example.json`: all configuration keys updated from `ollamaAgent.*` (OllamaPilot) to `ollamaForge.*`; example URLs changed to generic `localhost` addresses
- `.gitignore` / `.vscodeignore`: replaced stale `.ollamapilot/` references with `.ollamaforge/` so runtime data is correctly excluded from git and VSIX builds

### Internal
- Added dependency-install and configuration spiral guardrails to agent system prompt
- Turn-limit card mid-task detection fix in webview

---

## [1.0.1] — 2026-08-03

### Fixed
- Retry budget exhaustion on long autonomous runs: `autoRetryCount` now decays by 1 on each successful tool call, so active work earns back budget while genuinely stuck models still burn down toward the limit

---

## [1.0.0] — 2026-08-03

Initial release of **Ollama Forge** — a complete rewrite and rebrand of OllamaPilot.

### Features
- **Tiered memory system** — five tiers from ephemeral session context (tier 0) to long-term semantic storage (tier 4–5 via Qdrant). Automatic promotion/demotion based on access frequency and age
- **Semantic search** — Qdrant vector DB integration for embedding-based memory retrieval (tiers 4–5); keyword fallback for local-only setups (tiers 0–3)
- **Agent loop** — autonomous multi-turn execution with tool approval middleware, spiral detection, history poisoning recovery, and context auto-compaction
- **Trust levels** — Normal, Trust, and YOLO modes controlling which tools are auto-approved and how aggressively the agent proceeds between steps (see [Trust Levels](#trust-levels) in README)
- **MCP support** — connect any Model Context Protocol server via `ollamaForge.mcpServers` or `.ollamaforge/mcp.json`
- **Multi-model routing** — optional fast model for read-only turns and critic model for edit review
- **ComfyUI integration** — `generate_image` tool when a ComfyUI instance is configured
- **Web search** — `web_search` and `web_fetch` tools via a local SearXNG instance
- **Code graph** — workspace symbol indexing and smart context inclusion
- **Stack health** — SSH-based health checks and restart actions for remote docker-compose stacks
- **Dream cycle** — background memory consolidation and summarization
- **Inline completions** — on-demand or automatic ghost-text completions
- **Code lens** — per-function AI actions in the editor gutter
- **Chat export** — export sessions as Markdown or JSON
- **Remote Ollama** — connect to Ollama running on a remote machine or NAS (see `docs/remote-ollama-setup.md`)
- 100% local — no telemetry, no cloud, no API keys required
