# Security Policy

## Supported Versions

Only the latest release receives security fixes.

| Version | Supported |
|---------|-----------|
| Latest  | ✓ |
| Older   | ✗ |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Report vulnerabilities privately via [GitHub Security Advisories](https://github.com/dtenney/ollamaforge/security/advisories/new).

Include:
- A description of the vulnerability and its potential impact
- Steps to reproduce
- Any relevant logs or screenshots

You can expect an acknowledgement within 48 hours and a fix or status update within 14 days.

## Scope

Ollama Forge runs entirely locally — no telemetry, no cloud services, no external API calls (except to your own Ollama/Qdrant/SearXNG instances). The relevant attack surface is:

- **Webview sandbox** — the chat panel runs in a VS Code webview with CSP enforced
- **Tool execution** — shell commands require explicit user approval (Normal mode) or are gated by trust level
- **MCP servers** — configured by the user; Ollama Forge passes tool calls to MCP servers you specify
- **Local network requests** — connections go only to hosts you configure (`ollamaForge.serverUrl`, `ollamaForge.memory.qdrantUrl`, etc.)
