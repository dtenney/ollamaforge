# Code Graph

Ollama Forge maintains a **symbol graph** of your workspace so the agent can navigate large codebases without reading every file from scratch.

---

## How it works

### 1. Parsing — Tree-sitter

When you index the workspace, each `.ts`, `.tsx`, `.js`, `.jsx`, and `.py` file is fed through [Tree-sitter](https://tree-sitter.github.io/tree-sitter/) — a fast, incremental parser that produces a concrete syntax tree. The extension walks the tree and extracts every:

| Symbol kind | Examples |
|-------------|---------|
| `function`  | `function doThing()`, `const foo = () => {}` |
| `method`    | `MyClass.handleRequest` |
| `class`     | `class AgentRunner` |
| `interface` | `interface GraphNode` |
| `enum`      | `enum TrustLevel` |

Each symbol gets:
- a **16-hex-char ID** (`sha256(file:name:startLine)`)
- its **file path**, **start/end line**, and **body text**
- a **keyword string** (camelCase split into words, for full-text search)
- a **MinHash fingerprint** (64 hash values, used for drift detection)

### 2. Storage — SQLite (WAL mode)

Everything is stored in `.ollamaforge/graph.db` in the workspace root — a local SQLite database that is never committed to git (`.gitignore` is updated automatically).

Three tables:

```
nodes      — one row per symbol (id, kind, name, file, lines, body, fingerprint)
edges      — relationships between symbols (calls, imports, contains, extends, exports)
nodes_fts  — SQLite FTS5 virtual table for full-text search over name + keywords
```

The database uses **WAL journal mode** and `synchronous = NORMAL` for fast writes during indexing.

### 3. Incremental updates

When you save a file, the extension schedules a **per-file debounced re-index** (2 second delay). This means:
- Saving `agentRunner.ts` only re-parses that one file
- The old symbols for that file are deleted (edges first, then nodes, to avoid orphans), then the new symbols are inserted
- Saving two files quickly doesn't cancel each other — each file has its own debounce timer

### 4. Query — FTS + neighbour expansion

When the agent calls `graph_query` (or when scope context is pre-loaded into the system prompt), the query goes through:

1. **FTS5 full-text search** — camelCase is split into words (`buildScopeContext` → `build scope context`), then each word is searched with `OR` across all symbol names and keyword strings. Falls back to a `LIKE` search if the FTS query has a syntax error.

2. **Scoring** — results are scored by exact name match (+0.8), case-insensitive match (+0.5), or substring match (+0.2).

3. **One-hop neighbour expansion** — for each matched symbol, the graph fetches its direct `calls`, `imports`, and `contains` neighbours (up to 5 per node), scored at 35% of the parent's score.

4. **Token budget** — results are sorted by score and packed into the output until a character budget is reached (~6000 chars / ~1500 tokens). Grouped by file.

### 5. Drift detection — MinHash

When `graph_status` is called, the extension runs a **drift check** against the last 200 indexed symbols:

- Re-reads each file from disk
- Extracts the current body text at the stored line range
- Computes a new MinHash fingerprint and compares it to the stored one using **Jaccard similarity** (`matching hashes / total hashes`)

| Similarity | Result |
|------------|--------|
| ≥ 0.85 | No change — symbol is current |
| 0.55–0.85 | `ambiguous` — symbol has changed somewhat |
| < 0.55 | `gone` — symbol has been heavily modified or deleted |

If drift is detected, the agent is told to run `graph_index` before relying on graph data.

### 6. Memory cross-reference

The graph can also validate the agent's **tiered memory** entries. When memory is loaded, the extension:
- Extracts identifier-like names from each memory entry (camelCase/PascalCase/snake_case, ≥4 chars)
- Looks them up in the graph
- Computes MinHash similarity between the stored fingerprint and the current file
- Flags conflicts as `changed` or `gone` and injects a warning into the system prompt

This prevents the agent from acting on stale facts like "function `processOrder` is in `orders.ts`" after `processOrder` has been renamed or deleted.

---

## Agent tools

| Tool | What it does |
|------|-------------|
| `graph_index` | Parse and index the whole workspace (or a single file with `scope`). Stores results in `.ollamaforge/graph.db`. |
| `graph_query` | Full-text search + neighbour expansion. Returns matching symbols with file and line numbers, capped at ~1500 tokens. |
| `graph_status` | Show total symbols, file count, last index time, and drift summary. |

The agent is instructed to call `graph_query` **before** `read_file` when locating a function or class — it's faster and avoids reading files that don't contain the symbol.

### Example agent interaction

```
User: Fix the bug in the memory tier write tool

Agent calls: graph_query("memory tier write")

Result:
  ## Code Graph Context
  **src/agent.ts:**
    function memory_tier_write (line 11849–11892)
  **src/memoryCore.ts:**
    method TieredMemoryManager.write (line 340–398)
    method TieredMemoryManager.withLock (line 112–145)

Agent then reads only those specific line ranges — not the entire 15,000-line file.
```

---

## ROUTER.md

`ROUTER.md` is a lightweight project manifest (≤300 tokens) in the workspace root. The agent reads it at the start of every session to orient itself — stack, entry points, key invariants.

If `ROUTER.md` doesn't exist, the extension auto-generates a basic one from `package.json` and detects the stack (VSCode extension, React, Node.js, Python). You can edit it to add project-specific rules the agent should always respect.

The agent will suggest regenerating it if the graph was re-indexed more than 1 hour after `ROUTER.md` was last written.

---

## Native dependencies

The code graph requires two native (compiled) Node.js modules:

| Module | Purpose |
|--------|---------|
| `tree-sitter` | Parser engine |
| `tree-sitter-typescript` | TypeScript/JavaScript grammar |
| `tree-sitter-python` | Python grammar (optional) |
| `better-sqlite3` | SQLite bindings |

These are pre-compiled and bundled in the `.vsix`. If they fail to load (e.g. architecture mismatch), graph features are **silently disabled** — the extension still works, just without graph-assisted navigation. You'll see `Code graph is not available` in the tool response.

---

## File layout

```
.ollamaforge/          ← gitignored, machine-local
  graph.db             ← SQLite symbol database
  memory/              ← tiered memory store
  tasks/               ← task logs and checkpoints

ROUTER.md              ← project manifest (committed, edit freely)
```
