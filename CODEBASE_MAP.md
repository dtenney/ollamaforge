# OllamaForge Codebase Map

> Auto-generated tracking file — last updated 2026-10-28
> Branch: main | Current dirty files: src/agent.ts, src/agentPromptBuilder.ts, src/logger.ts, src/memoryNudge.ts, src/provider.ts, webview/src/render.js, webview/webview.js
> Deleted: src/decodeRate.ts, src/toolDefinitions.ts, src/toolExecutor.ts

---

## File Tree

```
ollamaforge/
├── src/                                  # TypeScript extension source
│   ├── agent.ts                  (17612) # Core agent loop — prompt → stream → XML tool parse → middleware → loop
│   ├── agentLoop.ts               ( 489) # Turn/iteration management extracted from agent.ts
│   ├── agentPromptBuilder.ts      ( 750) # Builds system + memory + codeGraph context blocks for each turn
│   ├── agentShellEnv.ts           ( 288) # Shell environment detection & safe command allowlist
│   ├── agentToolJsonRepair.ts     ( 256) # Repairs malformed JSON in tool call blocks from LLM output
│   ├── chatExporter.ts            ( 151) # Exports chat history to markdown/JSON
│   ├── chatStorage.ts             ( 219) # Persists chat sessions to disk
│   ├── codeActionsProvider.ts     ( 157) # VS Code CodeActionProvider (quick-fix lightbulb integration)
│   ├── codeGraph.ts               (1420) # Tree-sitter code graph → symbols in SQLite + FTS5 + MinHash drift
│   ├── codeIndex.ts               ( 627) # Incremental file indexer (2s debounce, feeds codeGraph)
│   ├── codeLensProvider.ts        (  75) # VS Code CodeLens — inline action buttons above functions
│   ├── codeReview.ts              (  64) # Code review workflow helper
│   ├── commandPolicy.ts           ( 247) # Safe/destructive command classification for trust gating
│   ├── config.ts                  ( 198) # Settings schema, model presets, default values
│   ├── context.ts                 (  63) # VS Code extension context singleton
│   ├── contextCalculator.ts       ( 571) # Token counting & budget management per turn
│   ├── contextFanout.ts           ( 153) # Fan-out context across multiple files/symbols
│   ├── contextLength.ts           (  70) # Model context-window size lookup table
│   ├── deepResearch.ts            ( 435) # Multi-step deep research workflow (iterative sub-queries)
│   ├── diffView.ts                (  59) # Shows inline diffs in VS Code diff editor
│   ├── docScanner.ts              ( 742) # Scans and indexes documentation files (md, txt)
│   ├── dreamAgent.ts              ( 607) # Dream cycle — session analysis → rule proposals → context.md
│   ├── embeddingService.ts        ( 197) # Embedding generation via Ollama (for Qdrant semantic search)
│   ├── environmentProbe.ts        ( 317) # Detects runtime environment (OS, shell, tools available)
│   ├── fileSplitter.ts            ( 508) # Splits large files into chunk windows for context budget
│   ├── gitContext.ts              ( 311) # Git status/diff/log context injection
│   ├── importResolver.ts          ( 417) # Resolves TS/JS imports to actual file paths
│   ├── inlineCompletionProvider.ts(  89) # VS Code inline completion (ghost text)
│   ├── logger.ts                  ( 109) # Structured logger (file + output channel)
│   ├── loopDetector.ts            ( 253) # Detects agent loops (repeated tool calls / stuck patterns)
│   ├── main.ts                    (1383) # VS Code activation, command registration, view providers
│   ├── markdownIngest.ts          ( 156) # Ingests markdown docs into memory/context
│   ├── mcpClient.ts               ( 259) # MCP protocol client (connects to external MCP servers)
│   ├── mcpConfig.ts               ( 202) # MCP server config loader (mcp.json)
│   ├── memoryConfig.ts            (  79) # Memory system configuration (tier settings)
│   ├── memoryCore.ts              (1625) # 6-tier memory system (SQLite tiers 0-3, Qdrant tiers 4-5)
│   ├── memoryNudge.ts             ( 755) # Prompts agent to persist important facts to memory
│   ├── memoryViewProvider.ts      (  94) # VS Code WebviewViewProvider for the memory panel
│   ├── mentions.ts                ( 202) # @-mention parsing (files, symbols, memory refs in prompts)
│   ├── modelRecommendations.ts    ( 228) # Suggests models based on task type and hardware
│   ├── multiFileRefactor.ts       ( 299) # Orchestrates refactors spanning multiple files
│   ├── multiWorkspace.ts          (  94) # Multi-root workspace support
│   ├── ollamaClient.ts            (1056) # Ollama HTTP client — streaming chat, generate, embeddings
│   ├── pathPolicy.ts              ( 119) # Enforces allowed/blocked path rules for file tool ops
│   ├── planFile.ts                ( 113) # Reads/writes .ollamaforge/PLAN.md (agent task plan)
│   ├── planGrounding.ts           ( 194) # Grounds agent responses against the active plan
│   ├── planStepTracker.ts         ( 258) # Tracks completion of individual plan steps
│   ├── preEdit.ts                 (1223) # Pre-edit validation: backup, syntax check, safety checks
│   ├── projectTracking.ts         ( 130) # PROJECT.md read/write for high-level project state
│   ├── promptTemplates.ts         ( 256) # Named prompt templates (system, task, tool-result wrappers)
│   ├── provider.ts                (2398) # Webview message handler — chat glue between UI and agent
│   ├── qdrantClient.ts            ( 282) # Qdrant vector DB client (tiers 4-5 memory, semantic search)
│   ├── secretRedaction.ts         (  78) # Redacts secrets/keys from logs and LLM context
│   ├── sessionLog.ts              ( 225) # Writes SESSION_LOG.md for dream cycle input
│   ├── similarityAnalyzer.ts      ( 375) # MinHash / Jaccard similarity for drift detection
│   ├── skillLibrary.ts            ( 172) # Named reusable skill definitions (stored in memory)
│   ├── smartContext.ts            ( 265) # Smart context selection — ranks most relevant files/symbols
│   ├── stackHealth.ts             ( 417) # Checks project health (lint, build, test status)
│   ├── symbolProvider.ts          ( 212) # VS Code DocumentSymbolProvider & WorkspaceSymbolProvider
│   ├── systemMap.ts               ( 376) # Generates system map / ROUTER.md from code graph
│   ├── transcriptLogger.ts        (  74) # Logs raw LLM transcripts for debugging
│   ├── truncationContinuation.ts  ( 162) # Handles mid-response truncation → continuation prompt
│   ├── verification.ts            ( 322) # Post-edit verification (re-reads file, checks consistency)
│   ├── webviewMsgGuard.ts         (  17) # Type guard for webview message payloads
│   ├── workspace.ts               ( 343) # Workspace root resolution and file access helpers
│   │
│   ├── core/                             # Shared low-level utilities
│   │   ├── consistencyGate.ts     ( 177) # Validates agent output consistency before applying
│   │   └── promptIntentClassifier.ts(147)# Classifies prompt intent (code/explain/plan/etc.)
│   │
│   └── test/
│       ├── README.md
│       ├── runTests.ts                   # Mocha test runner entry point
│       ├── vscode-mock.ts                # VS Code API mock for unit tests
│       ├── integration/
│       │   ├── extension.test.ts         # Extension activation integration tests
│       │   └── index.ts                  # Integration suite entry
│       └── unit/                         # Unit tests (one per source module)
│           ├── agent.test.ts
│           ├── agentHarness.test.ts
│           ├── agentLoop.test.ts
│           ├── agentShellEnv.test.ts
│           ├── agentToolJsonRepair.test.ts
│           ├── chatExporter.test.ts
│           ├── chatStorage.test.ts
│           ├── codeActionsProvider.test.ts
│           ├── codeLensProvider.test.ts
│           ├── codeReview.test.ts
│           ├── commandPolicy.test.ts
│           ├── config.test.ts
│           ├── consistencyGate.test.ts
│           ├── context.test.ts
│           ├── contextCalculator.test.ts
│           ├── contextFanout.test.ts
│           ├── contextLength.test.ts
│           ├── diffView.test.ts
│           ├── docScanner.test.ts
│           ├── e2e.test.ts
│           ├── fileSplitter.test.ts
│           ├── gitContext.test.ts
│           ├── importResolver.test.ts
│           ├── logger.test.ts
│           ├── mcpClient.test.ts
│           ├── mcpConfig.test.ts
│           ├── memoryCore.test.ts
│           ├── memoryNudge.test.ts
│           ├── mentions.test.ts
│           ├── modelRecommendations.test.ts
│           ├── multiWorkspace.test.ts
│           ├── ollamaClient.test.ts
│           ├── parallelBatch.test.ts
│           ├── pathPolicy.test.ts
│           ├── planFile.test.ts
│           ├── projectTracking.test.ts
│           ├── promptIntentClassifier.test.ts
│           ├── promptTemplates.test.ts
│           ├── provider.test.ts
│           ├── secretRedaction.test.ts
│           ├── sessionLog.test.ts
│           ├── similarityAnalyzer.test.ts
│           ├── skillLibrary.test.ts
│           ├── smartContext.test.ts
│           ├── stackHealth.test.ts
│           ├── symbolProvider.test.ts
│           ├── systemMap.test.ts
│           ├── verification.test.ts
│           ├── webviewMsgGuard.test.ts
│           └── workspace.test.ts
│
├── webview/                              # Browser-side chat UI (vanilla JS, no framework)
│   ├── webview.html                      # Main chat panel HTML shell
│   ├── webview.js                        # Entry bundle — loaded by webview.html
│   ├── memoryPanel.html                  # Memory viewer panel HTML
│   ├── src/
│   │   ├── main.js                       # Webview init, VS Code API acquisition, event wiring
│   │   ├── state.js                      # Client-side state (messages, models, settings)
│   │   ├── render.js                     # Message rendering — markdown, code blocks, tool calls
│   │   ├── handlers.js                   # Handles messages from extension host
│   │   ├── input.js                      # Input bar — submit, @-mentions, slash commands
│   │   ├── models.js                     # Model selector UI
│   │   └── search.js                     # In-chat search
│   └── vendor/
│       └── highlight.bundle.js           # highlight.js bundled for syntax highlighting
│
├── .github/
│   ├── workflows/
│   │   ├── CI.yml                        # Test + lint on push/PR
│   │   └── release.yml                   # VSIX build + marketplace publish
│   └── dependabot.yml                    # Dependency update automation
│
├── .ollamaforge/                         # Runtime data dir (gitignored)
│   ├── context.md                        # Accepted dream-cycle rules (persisted agent context)
│   ├── SESSION_LOG.md                    # Rolling session log (dream cycle input)
│   ├── agent.log                         # Raw agent log
│   ├── CROSS_POLLINATION.md              # Cross-project insight notes
│   ├── graph.db                          # SQLite code graph + FTS5 index
│   └── index/                            # Per-file summary index (*.summary.md)
│
├── package.json                          # Extension manifest, scripts, dependencies
├── package-lock.json
├── tsconfig.json                         # TS config for src/
├── tsconfig.webview.json                 # TS config for webview/ (if used)
├── esbuild.js                            # Build script — bundles src/ and webview/
├── mcp.example.json                      # Example MCP server config
├── settings.example.json                 # Example user settings
├── ARCHITECTURE.md                       # Architecture overview doc
├── CHANGELOG.md                          # Version history
├── CONTRIBUTING.md                       # Contributor guide
├── DEPLOYMENT.md                         # Deployment / publish guide
├── PROJECT.md                            # High-level project goals/status
├── README.md                             # User-facing readme
├── ROUTER.md                             # ≤300-token project manifest for agent orientation
├── SECURITY.md                           # Security policy
├── LICENSE
├── .gitignore
├── .gitattributes
├── .vscodeignore                         # Files excluded from VSIX package
└── .editorconfig
```

---

## Agent Pipeline (data flow)

```
User message (webview)
  └─► provider.ts         — receives vscode message, builds turn context
        └─► agent.ts       — core loop
              ├─ agentPromptBuilder.ts   — system prompt + memory tiers + code graph
              ├─ ollamaClient.ts         — streams tokens from Ollama
              ├─ agentToolJsonRepair.ts  — repairs malformed <tool> XML/JSON
              ├─ commandPolicy.ts        — classifies shell commands (safe/destructive)
              ├─ pathPolicy.ts           — enforces file path allowlist
              ├─ preEdit.ts              — backup + syntax check before file writes
              ├─ verification.ts         — post-edit consistency check
              ├─ loopDetector.ts         — detects stuck/looping patterns
              ├─ memoryNudge.ts          — triggers memory writes when facts emerge
              └─ agentLoop.ts            — turn counter, max-turn enforcement
```

## Memory System (memoryCore.ts)

```
Tier 0  SQLite  — Critical facts (always loaded)
Tier 1  SQLite  — Essential framework facts (session start)
Tier 2  SQLite  — Operational/project conventions (session start)
Tier 3  SQLite  — Collaboration guidelines (on-demand)
Tier 4  Qdrant  — Past solutions / patterns (semantic search)
Tier 5  Qdrant  — Deep historical archive (semantic search)
Backup  .ollamaforge/memory.json  — cross-session JSON fallback
```

## Trust Levels

| Level  | Symbol | Behavior                          | Max turns |
|--------|--------|-----------------------------------|-----------|
| Normal | 🔒     | Confirms every edit/command       | 6         |
| Trust  | 🔓     | Confirms destructive ops only     | 9         |
| YOLO   | ⚡     | No confirmations                  | 12        |

---

## Currently Modified (as of this session)

| File | Status |
|------|--------|
| src/agent.ts | modified |
| src/agentPromptBuilder.ts | modified |
| src/logger.ts | modified |
| src/memoryNudge.ts | modified |
| src/provider.ts | modified |
| webview/src/render.js | modified |
| webview/webview.js | modified |
| src/decodeRate.ts | **deleted** |
| src/toolDefinitions.ts | **deleted** |
| src/toolExecutor.ts | **deleted** |
