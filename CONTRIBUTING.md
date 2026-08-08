# Contributing to Ollama Forge

## Local Development Setup

```bash
git clone https://github.com/dtenney/ollamaforge.git
cd ollamaforge
npm install
```

**Run the extension in development:**
1. Open the repo in VS Code
2. Press `F5` to launch the Extension Development Host

**Compile (TypeScript → JS):**
```bash
npm run compile
```

**Bundle for production (esbuild):**
```bash
npm run bundle:prod
```

**Package as VSIX:**
```bash
npx vsce package --no-dependencies
```

**Deploy to local VS Code (for quick testing):**
```bash
npm run deploy
```

## Running Tests

Unit tests run without VS Code or Ollama — fast, no setup required:
```bash
npm run test:unit
```

Agent harness tests (real agent loop, stubbed Ollama):
```bash
npm run test:harness
```

Full integration tests (requires VS Code Extension Host):
```bash
npm test
```

## Project Structure

```
src/
  agent.ts          — Agent loop, tool execution, spiral detection
  provider.ts       — Webview provider, message handling, session management
  memoryCore.ts     — Tiered memory system (tiers 0–5, Qdrant integration)
  config.ts         — Configuration loading and defaults
  mcpConfig.ts      — MCP server configuration and client
  stackHealth.ts    — SSH-based stack health checks
  dreamAgent.ts     — Background memory consolidation cycle
  main.ts           — Extension activation/deactivation
webview/
  webview.html      — Chat UI shell
  webview.js        — Chat UI logic (rendering, message passing)
  memoryPanel.html  — Memory browser panel
```

## Code Style

- TypeScript strict mode — no `any` without a comment explaining why
- No trailing whitespace; Unix line endings (LF)
- Keep functions focused — if a function is doing three things, split it
- Log with `logInfo` / `logWarn` / `logError` (from `logger.ts`), not `console.log`
- Prefer `const` and immutability; avoid mutation of shared state

## Pull Request Guidelines

1. **One thing per PR** — bug fix, feature, or refactor, not all three
2. **Tests** — add or update unit tests for any logic change in `src/`
3. **No breaking config changes** — `ollamaForge.*` setting keys are part of the public API; don't rename or remove them without a migration path
4. **Update CHANGELOG.md** — add an entry under `[Unreleased]` describing what changed and why
5. Keep PRs small and reviewable — large diffs are hard to reason about

## Architecture Notes

- The agent loop (`agent.ts`) is intentionally monolithic — tool dispatch, spiral detection, and context management are tightly coupled by design
- Memory tiers 0–3 are local-only (`workspaceState` + `.ollamaforge/memory.json`); tiers 4–5 require Qdrant
- The webview communicates with the extension host only via `postMessage` — no direct DOM access to VS Code APIs
- Trust levels (Normal/Trust/YOLO) gate tool auto-approval in `provider.ts`, not in `agent.ts`
