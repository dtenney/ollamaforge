# Troubleshooting

## "No models available" / Cannot connect to Ollama

**Symptoms:** Sidebar shows "No models" or an error referencing `ollamaForge.serverUrl`.

**Checks:**
1. Is Ollama running? Test from your machine:
   ```
   curl http://localhost:11434/api/tags
   ```
   If this fails, start Ollama: `ollama serve`

2. If Ollama is on a remote host, set `ollamaForge.serverUrl` to the correct address:
   ```json
   "ollamaForge.serverUrl": "http://192.168.1.100:11434"
   ```

3. Remote Ollama must bind to `0.0.0.0`, not just `127.0.0.1`. Set the environment variable before starting:
   ```
   OLLAMA_HOST=0.0.0.0 ollama serve
   ```

4. Check firewall — port `11434` must be open on the Ollama host.

See [docs/remote-ollama-setup.md](remote-ollama-setup.md) for a full remote setup guide.

---

## Model cold-start / first response is very slow

The first request after Ollama starts loads the model weights into GPU/CPU memory. This is normal and can take 30–90 seconds for large models.

**Fix:** Enable model pre-warming — Ollama Forge pre-warms the configured model 8 seconds after VS Code loads:
- This happens automatically; nothing to configure.
- If cold-start is still a problem, set `ollamaForge.keepAlive` to a longer duration (e.g. `"24h"`) so the model stays loaded between sessions.

---

## Agent stops mid-task / "reached the tool-call limit"

The agent has a per-session tool-call limit (6 in Normal, 9 in Trust, 12 in YOLO mode).

**Fix:**
- Click **"Keep going"** on the turn-limit card, or type `keep going`
- Switch to **Trust** or **YOLO** mode (lock icon in sidebar) for long autonomous tasks — the agent will auto-continue without stopping
- For very long tasks, say "keep going" after each limit card; the agent resumes with full context

---

## Memory / Qdrant errors

**"Qdrant not reachable"** or embedding failures:

1. Check Qdrant is running (replace `<host>` with your Qdrant host):
   ```
   curl http://<host>:6333/healthz
   ```
2. Verify `ollamaForge.memory.qdrantUrl` points to the correct host/port
3. Check `ollamaForge.memory.embeddingUrl` points to your Ollama instance (not a bare hostname — must include `http://` and port)
4. Pull the embedding model if missing:
   ```
   ollama pull nomic-embed-text
   ```

Tiers 0–3 work without Qdrant. Only tiers 4–5 (long-term semantic memory) require it. You can use the extension fully without Qdrant — leave `ollamaForge.memory.qdrantUrl` empty.

---

## Memory database corruption / memory won't load

The memory file is at `.ollamaforge/memory.json` in your workspace.

**Fix:**
1. Run **"Ollama: Run Memory Maintenance"** from the command palette — this compacts and repairs the tier structure
2. If maintenance fails, export a backup first (**"Ollama: Export Memory"**), then clear it (**"Ollama: Clear Memory"**) and re-import
3. As a last resort, delete `.ollamaforge/memory.json` — the extension recreates it on next launch (you lose saved memory entries)

---

## Web search not working

1. Check SearXNG is running:
   ```
   curl "http://localhost:8888/search?q=test&format=json"
   ```
   Should return JSON with a `results` array.

2. SearXNG must have JSON format enabled. In your `searxng/settings.yml`:
   ```yaml
   search:
     formats:
       - html
       - json
   ```

3. Verify `ollamaForge.search.url` is set correctly (no trailing slash).

See [docs/searxng-web-search.md](searxng-web-search.md) for full setup.

---

## Extension not loading / blank sidebar

1. Check the VS Code Output panel: **View → Output**, select **"Ollama Forge"** from the dropdown
2. Reload the window: `Ctrl+Shift+P` → **"Developer: Reload Window"**
3. If the sidebar is blank after reload, open the command palette and run **"Ollama: Open Chat"**

---

## Git Bash not found (Windows)

Shell tools (`run_command`, `shell_read`) require Git Bash on Windows.

**Fix:** Install [Git for Windows](https://git-scm.com/download/win) — Git Bash is included. After install, reload VS Code.

---

## Reporting a bug

Include the agent log when reporting: **Command Palette → "Ollama: Export Agent Log for Review"**. This exports a sanitised log without file contents.
