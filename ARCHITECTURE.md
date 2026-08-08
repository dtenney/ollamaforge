# Architecture

## Overview

Ollama Forge is a VS Code extension that provides a fully local AI coding agent powered by Ollama. All inference runs on your machine or LAN — no cloud, no telemetry.

## Project Type

TypeScript / Node.js VS Code Extension

## Entry Points

- `src/main.ts` — VS Code activation, command registration, view providers
- `src/agent.ts` — core agent loop, tool execution, prompt construction
- `webview/webview.html` + `webview/webview.js` — chat UI

## Build Pipeline

```
npm run bundle:prod
  └─ scripts/vendor-hljs.js   → webview/vendor/highlight.bundle.js
  └─ esbuild.js --production  → dist/main.js (all deps bundled)
     └─ native modules copied: tree-sitter, tree-sitter-typescript,
                               tree-sitter-python, better-sqlite3
```

| Script | What it does |
|---|---|
| `npm run vendor` | Rebuild the highlight.js browser bundle |
| `npm run compile` | TypeScript compile (tsc) — for type checking / tests |
| `npm run bundle` | esbuild dev bundle → dist/main.js |
| `npm run bundle:prod` | esbuild production bundle (minified) |
| `npm run deploy` | bundle + copy to local VS Code extension dir |
| `npm run package` | build + vsce package → .vsix |
| `npm test` | compile + vscode-test integration suite |
| `npm run test:unit` | mocha unit tests only |
| `npm run test:coverage` | unit tests with nyc coverage |

## Source Map

```
src/
├── main.ts              # Activation, command wiring, view providers
├── agent.ts               # Agent loop, tool definitions, prompt builder
├── provider.ts            # Webview message handler, chat session glue
├── config.ts              # Settings schema, model presets, getConfig()
├── memoryCore.ts          # 6-tier memory system (SQLite + Qdrant)
├── memoryViewProvider.ts  # Memory sidebar tree view
├── codeGraph.ts           # tree-sitter code graph, scope routing
├── codeIndex.ts           # File relevance indexing
├── context.ts             # Workspace context builder
├── contextCalculator.ts   # Token counting, context window management
├── chatStorage.ts         # SQLite-backed chat session persistence
├── chatExporter.ts        # Markdown / JSON chat export
├── dreamAgent.ts          # Dream cycle: self-review, memory compaction
├── embeddingService.ts    # Qdrant embedding calls
├── environmentProbe.ts    # Shell/tool detection (git, node, python…)
├── gitContext.ts          # git diff, blame, commit context
├── codeReview.ts          # Review request builder
├── docScanner.ts          # Project doc ingestion into memory
├── fileSplitter.ts        # Large file split planning
├── stackHealth.ts         # SSH-based service health checks
├── smartContext.ts        # Import-aware file relevance scoring
├── symbolProvider.ts      # Symbol indexing, fuzzy search
├── inlineCompletionProvider.ts  # Ghost-text completions
├── codeLensProvider.ts    # Code lens actions
├── codeActionsProvider.ts # Quick-fix / refactor actions
├── diffView.ts            # Proposed-change diff viewer
├── promptTemplates.ts     # Reusable prompt template system
├── logger.ts              # File + output channel logging
├── ollamaClient.ts        # Ollama HTTP client (streaming)
├── mcpClient.ts           # MCP server client
└── multiWorkspace.ts      # Per-folder workspace isolation
```

## Key Systems

### Agent Loop (`src/agent.ts`)
The agent receives a user message, builds a prompt with context (files, memory, git diff, etc.), streams a response from Ollama, parses `<tool>` calls from the output, executes them, and feeds results back for the next turn. Continues until the model emits no more tool calls.

Tool execution goes through a middleware chain: trust-level check → approval prompt (if needed) → execution → result injection.

Multi-model routing optionally sends read-only tool turns to a fast/cheap model and critique turns to a larger one.

### Memory System (`src/memoryCore.ts`)
Six tiers, lowest = most important:

| Tier | Storage | Description |
|---|---|---|
| 0 | SQLite | Critical facts (always loaded) |
| 1 | SQLite | Session summaries |
| 2 | SQLite | Project conventions |
| 3 | SQLite | Historical context |
| 4 | Qdrant | Semantic search (vector) |
| 5 | Qdrant | Archive |

Tiers 0–3 load automatically on session start. Tiers 4–5 require Qdrant.

### Code Graph (`src/codeGraph.ts`)
tree-sitter parses TypeScript and Python files into a scope graph. The agent uses this to find the right files/symbols for a given task rather than loading everything into context.

### Dream Cycle (`src/dreamAgent.ts`)
Runs nightly (or on demand). Compacts memory, reviews recent sessions, proposes new agent rules, and optionally runs stack health checks over SSH.

### MCP Client (`src/mcpClient.ts`)
Connects to any MCP-compatible tool server. Config lives in `.ollamaforge/mcp.json` or the `ollamaForge.mcpServers` setting. See [mcp.example.json](mcp.example.json) for server examples.

## Dependencies

| Package | Purpose |
|---|---|
| `@modelcontextprotocol/sdk` | MCP server communication |
| `axios` | HTTP client (Ollama API, web fetch) |
| `better-sqlite3` | Local SQLite for memory and chat storage |
| `tree-sitter` + grammars | Code parsing for the code graph |
| `highlight.js` | Syntax highlighting in the webview (vendored) |

## Webview

The chat UI (`webview/`) is plain HTML/JS — no framework. It communicates with the extension host via `vscode.postMessage` / `onmessage`. The highlight.js bundle is vendored at `webview/vendor/highlight.bundle.js` so it works offline without a CDN.

## Tests

```
src/test/
├── unit/          # Mocha tests, no VS Code API dependency
└── integration/   # vscode-test tests (require Extension Host)
```

Run with `npm run test:unit` (fast, no VS Code needed) or `npm test` (full suite).
