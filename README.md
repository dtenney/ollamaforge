<p align="center">
  <img src="images/logo.png" alt="Ollama Forge" width="180" />
</p>

# Ollama Forge

A local AI coding agent for VS Code powered by Ollama. 100% local — no telemetry, no internet required, no subscriptions.

## Features

- **Autonomous agent** — reads, writes, and edits files; runs shell commands; compiles and validates code
- **Multi-tiered memory** — persistent project knowledge via Qdrant semantic search
- **Code graph** — tree-sitter powered scope routing and symbol indexing
- **Dream agent** — nightly self-improvement cycle using session feedback
- **MCP support** — connect external tool servers via Model Context Protocol
- **Multi-workspace** — run independent agent sessions per workspace tab
- **Skills system** — reusable agent scripts in `.ollamaforge/skills/`
- **Trust levels** — Normal (confirm tools), Trust (auto-approve edits), YOLO (fully autonomous)

## Requirements

- [Ollama](https://ollama.ai) running locally or on your network
- A capable model (recommended: `qwen3` or `gemma4` series, 14B+)
- Git Bash (Windows) — required for shell tool execution on Windows

## Optional

- [Qdrant](https://qdrant.tech) for semantic memory search
- [SearXNG](https://searxng.github.io/searxng/) for web search (fully self-hosted)
- [ComfyUI](https://github.com/comfyanonymous/ComfyUI) for image generation

## Setup

1. Install the `.vsix` from the releases page
2. Set `ollamaForge.serverUrl` to your Ollama instance (e.g. `http://192.168.0.29:11434`)
3. Select a model from the sidebar dropdown
4. Open a workspace and start chatting

See [docs/remote-ollama-setup.md](docs/remote-ollama-setup.md) for remote Ollama configuration.
See [docs/searxng-web-search.md](docs/searxng-web-search.md) for web search setup.

## License

MIT
