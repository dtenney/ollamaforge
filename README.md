<p align="center">
  <img src="images/logo.png" alt="Ollama Forge" width="180" />
</p>

# Ollama Forge

[![CI](https://github.com/dtenney/ollamaforge/actions/workflows/ci.yml/badge.svg)](https://github.com/dtenney/ollamaforge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE.txt)

A 100% local AI coding agent for VS Code powered by Ollama. No telemetry, no internet required, no subscriptions.

## Features

- **Autonomous agent** — reads, writes, and edits files; runs shell commands; compiles and validates code
- **Multi-tiered memory** — persistent project knowledge with optional Qdrant semantic search
- **Code graph** — tree-sitter powered scope routing and symbol indexing
- **Dream agent** — nightly self-improvement cycle using session feedback
- **MCP support** — connect external tool servers via Model Context Protocol
- **Multi-workspace** — independent agent sessions per workspace folder
- **Skills system** — reusable agent scripts in `.ollamaforge/skills/`
- **Trust levels** — Normal (confirm tools), Trust (auto-approve edits), YOLO (fully autonomous)
- **Code review** — review uncommitted changes or any commit via the command palette
- **Inline completions** — ghost-text completions as you type
- **Multi-model routing** — route fast/cheap turns to a small model, critiques to a larger one
- **Stack health** — SSH-based service health checks integrated into the dream cycle
- **Chat export** — save sessions as Markdown or JSON

## Requirements

- [Ollama](https://ollama.ai) running locally or on your network
- A capable model (recommended: `qwen3` or `gemma4` series, 14B+)
- Git Bash (Windows) — required for shell tool execution on Windows

## Optional

- [Qdrant](https://qdrant.tech) for semantic memory search (Tiers 4–5)
- [SearXNG](https://searxng.github.io/searxng/) for web search (fully self-hosted, no API key)
- [ComfyUI](https://github.com/comfyanonymous/ComfyUI) for image generation

## Quick Start

1. **Install Ollama** — download from [ollama.ai](https://ollama.ai) and run it
2. **Pull a model** — in a terminal:
   ```
   ollama pull qwen3.8:27b
   ```
3. **Install Ollama Forge** — download `ollamaforge-<version>.vsix` from [Releases](https://github.com/dtenney/ollamaforge/releases), then:
   ```
   code --install-extension ollamaforge-<version>.vsix
   ```
4. **Open a project** in VS Code — the Ollama Forge icon appears in the sidebar
5. **Configure the server** — if Ollama is on another machine, set `ollamaForge.serverUrl` in VS Code Settings (default: `http://localhost:11434`)
6. **Select your model** from the dropdown at the top of the sidebar
7. **Start chatting** — type a message, or open a file and ask the agent to explain or edit it

That's it. No API keys, no accounts, no internet required.

## Installation

1. Download `ollamaforge-<version>.vsix` from the [Releases](https://github.com/dtenney/ollamaforge/releases) page
2. In VS Code: **Extensions** → `...` → **Install from VSIX**
3. Or via terminal:
   ```
   code --install-extension ollamaforge-<version>.vsix
   ```

## Setup

1. Set `ollamaForge.serverUrl` to your Ollama instance (e.g. `http://localhost:11434` or `http://192.168.1.100:11434`)
2. Select a model from the sidebar dropdown
3. Open a workspace and start chatting

See [docs/remote-ollama-setup.md](docs/remote-ollama-setup.md) for remote Ollama configuration.
See [docs/searxng-web-search.md](docs/searxng-web-search.md) for web search setup.
See [mcp.example.json](mcp.example.json) for MCP server configuration (filesystem, git, Postgres, sequential thinking, and more).
See [docs/troubleshooting.md](docs/troubleshooting.md) for common issues (connection errors, cold-start, memory, web search).

## Configuration

Key settings (configure in VS Code Settings or `.vscode/settings.json`):

| Setting | Default | Description |
|---|---|---|
| `ollamaForge.serverUrl` | `http://localhost:11434` | Ollama server URL |
| `ollamaForge.model` | — | Model to use (selected via sidebar) |
| `ollamaForge.contextWindow` | `8192` | Token context window |
| `ollamaForge.temperature` | `0.7` | Sampling temperature |
| `ollamaForge.memory.enabled` | `true` | Enable memory system |
| `ollamaForge.memory.qdrantUrl` | `""` | Qdrant URL for semantic memory |
| `ollamaForge.search.url` | `""` | SearXNG URL for web search |
| `ollamaForge.comfyui.url` | `""` | ComfyUI URL for image generation |
| `ollamaForge.routing.enabled` | `false` | Enable multi-model routing |
| `ollamaForge.enableThinking` | `false` | Enable `<think>` token support (qwen3/deepseek-r1) |
| `ollamaForge.inlineCompletions.enabled` | `false` | Enable ghost-text completions |
| `ollamaForge.stack.sshHost` | `""` | SSH host for stack health checks |

See [settings.example.json](settings.example.json) for the full list with descriptions.

## Commands

Access via the Command Palette (`Ctrl+Shift+P`):

| Command | Description |
|---|---|
| `Ollama: Open Chat` | Open the agent chat panel |
| `Ollama: Review My Changes` | Review uncommitted git changes |
| `Ollama: Review Commit` | Review a specific commit |
| `Ollama: Explain Selection` | Explain highlighted code |
| `Ollama: Generate Code (selection)` | Generate code from selection |
| `Ollama: Scan Project Docs into Memory` | Ingest project docs into memory |
| `Ollama: Run Memory Maintenance` | Compact and maintain memory tiers |
| `Ollama: Export Memory` / `Import Memory` | Backup and restore memory |
| `Ollama: Show Memory Statistics` | View memory tier breakdown |
| `Ollama Forge: Run Dream Cycle` | Trigger the nightly self-improvement cycle |
| `Ollama Forge: Check Stack Health` | Run SSH-based service health checks |
| `Ollama: Export Chat as Markdown` / `JSON` | Save the current chat session |
| `Ollama: Export Agent Log for Review` | Export the agent's activity log |

## Trust Levels

The lock icon in the sidebar cycles through three modes that control how aggressively the agent acts without asking for confirmation.

| Mode | Icon | Behavior |
|---|---|---|
| **Normal** | 🔒 | Every file edit and shell command requires your approval before it runs. Read-only tools (file reads, memory search, web search) are always auto-approved. |
| **Trust** | 🔓 | File edits (`edit_file`, `write_file`) and shell commands (`run_command`) are auto-approved. The agent only pauses for genuinely destructive or ambiguous actions. Retry budget increases from 6 to 9 attempts per session. |
| **YOLO** | ⚡ | All tools including destructive commands (`run_command_destructive`) are auto-approved. The agent runs fully autonomously end-to-end without stopping between steps. Retry budget increases to 12. Only use this when you trust the task fully. |

**Per-tool approvals** — In Normal mode you can approve individual tools for the session ("Accept" on a confirmation prompt) or permanently ("Accept All"). These approvals persist across turns but are scoped: command tools (`run_command`, `run_command_destructive`) approved in Trust/YOLO mode are **not** carried into Normal mode.

**Trust level persists per workspace** — your chosen level is saved in workspace state and restored when you reopen VS Code.

## Building from Source

```bash
git clone https://github.com/dtenney/ollamaforge.git
cd ollamaforge
npm install
npm run bundle:prod
npx vsce package
```

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release history.

## License

MIT
