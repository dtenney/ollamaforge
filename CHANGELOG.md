# Changelog

All notable changes to Ollama Forge are documented here.

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
