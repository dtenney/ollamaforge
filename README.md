<p align="center">
  <img src="images/logo.png" alt="Ollama Forge" width="180" />
</p>

# Ollama Forge

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

## Installation

1. Download `ollamaforge-<version>.vsix` from the [Releases](https://github.com/dtenney/ollamaforge/releases) page
2. In VS Code: **Extensions** → `...` → **Install from VSIX**
3. Or via terminal:
   ```
   code --install-extension ollamaforge-1.0.0.vsix
   ```

## Setup

1. Set `ollamaForge.serverUrl` to your Ollama instance (e.g. `http://localhost:11434` or `http://192.168.1.100:11434`)
2. Select a model from the sidebar dropdown
3. Open a workspace and start chatting

See [docs/remote-ollama-setup.md](docs/remote-ollama-setup.md) for remote Ollama configuration.
See [docs/searxng-web-search.md](docs/searxng-web-search.md) for web search setup.

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

## Building from Source

```bash
git clone https://github.com/dtenney/ollamaforge.git
cd ollamaforge
npm install
npm run bundle:prod
npx vsce package
```

## License

MIT
