# SearXNG Web Search Integration

Give Ollama Forge real-time web search capabilities using [SearXNG](https://searxng.github.io/searxng/) — a free, self-hosted meta-search engine. No API keys, no rate limits, no privacy concerns.

## What It Enables

With SearXNG configured, the agent gains two tools:

| Tool | What it does |
|---|---|
| `web_search` | Search the web and return titles, URLs, and snippets |
| `web_fetch` | Fetch any URL and return readable plain text (HTML stripped) |

The agent uses these automatically when it needs current information — library docs, API references, error messages, package versions, or anything not in its training data.

## Architecture

```
┌──────────────┐       ┌──────────────┐       ┌─────────────────┐
│  Ollama Forge │──────►│   SearXNG    │──────►│  Google/Bing/    │
│  (VS Code)   │ HTTP  │  (Docker)    │ HTTP  │  DuckDuckGo/etc  │
│              │◄──────│  port 8888   │◄──────│  (meta-search)   │
│              │ JSON  │              │ HTML  │                   │
└──────────────┘       └──────────────┘       └─────────────────┘
```

SearXNG aggregates results from multiple search engines (Google, Bing, DuckDuckGo, etc.) without sending your queries to any single provider. Results are returned as JSON to the extension.

## Setup

### 1. Run SearXNG

**Option A — Native install (recommended for dedicated servers):**

```bash
# Install dependencies
sudo apt install -y python3-dev python3-babel python3-venv \
  uwsgi uwsgi-plugin-python3 git build-essential libxslt-dev \
  zlib1g-dev libffi-dev libssl-dev

# Create user and clone
sudo useradd -r -s /bin/bash -d /usr/local/searxng searxng
sudo mkdir -p /usr/local/searxng
sudo chown searxng:searxng /usr/local/searxng

sudo -u searxng git clone https://github.com/searxng/searxng.git /usr/local/searxng/searxng-src
cd /usr/local/searxng/searxng-src

# Create venv and install
sudo -u searxng python3 -m venv /usr/local/searxng/venv
sudo -u searxng /usr/local/searxng/venv/bin/pip install -e .

# Generate secret and create settings
sudo mkdir -p /etc/searxng
sudo tee /etc/searxng/settings.yml << 'EOF'
use_default_settings: true
server:
  secret_key: "$(openssl rand -hex 32)"
  bind_address: "0.0.0.0"
  port: 8888
search:
  formats:
    - html
    - json
EOF

# Create systemd service
sudo tee /etc/systemd/system/searxng.service << 'EOF'
[Unit]
Description=SearXNG
After=network.target

[Service]
Type=simple
User=searxng
Group=searxng
Environment=SEARXNG_SETTINGS_PATH=/etc/searxng/settings.yml
ExecStart=/usr/local/searxng/venv/bin/python -m searx.webapp
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now searxng
```

**Option B — Docker (quick setup):**

```bash
docker run -d \
  --name searxng \
  --restart unless-stopped \
  -p 8888:8080 \
  -e SEARXNG_SECRET=$(openssl rand -hex 32) \
  searxng/searxng:latest
```

Both options give you SearXNG on port 8888 with JSON output enabled.

**Verify it works:**
```bash
curl -s "http://localhost:8888/search?q=python+requests+library&format=json" | python3 -c "
import json, sys
data = json.load(sys.stdin)
print(f'{len(data[\"results\"])} results')
for r in data['results'][:3]:
    print(f'  - {r[\"title\"]}')"
```

### 2. Configure Ollama Forge

```json
// .vscode/settings.json
{
  "ollamaForge.search.url": "http://localhost:8888",
  "ollamaForge.search.resultsLimit": 5
}
```

If SearXNG runs on a different machine (e.g., your AI server):
```json
{
  "ollamaForge.search.url": "http://192.168.1.100:8888"
}
```

### 3. Test it

Ask the agent something that requires current information:

```
"What's the latest version of React?"
"Find the docs for Python's asyncio.TaskGroup"
"What are the breaking changes in Next.js 15?"
```

The agent will automatically call `web_search`, read the results, and synthesize an answer.

## How the Agent Uses It

The agent decides when to search based on the question. It will search when:

- Asked about library versions, APIs, or documentation
- Asked about current events or recent changes
- It encounters an error message it doesn't recognize
- It needs to verify a fact it's uncertain about
- You explicitly ask it to "search for" or "look up" something

It will NOT search when:
- The answer is clearly in the workspace files
- It's a general coding question it can answer from training
- You're asking about your own project's code

## Configuration Options

| Setting | Default | Description |
|---|---|---|
| `ollamaForge.search.url` | `""` (disabled) | SearXNG base URL. Leave empty to keep the agent fully offline. |
| `ollamaForge.search.resultsLimit` | `5` | Maximum search results returned per query |

## Running on the Same Server as Ollama

The ideal setup: SearXNG and Ollama on the same machine. The agent talks to both over localhost (or LAN if remote):

```bash
# On your AI server
# Ollama (already running)
ollama serve

# SearXNG (native — already running via systemd)
sudo systemctl status searxng

# Or via Docker if you prefer:
# docker run -d --name searxng --restart unless-stopped \
#   -p 8888:8080 \
#   -e SEARXNG_SECRET=$(openssl rand -hex 32) \
#   searxng/searxng:latest
```

Then in VS Code:
```json
{
  "ollamaForge.baseUrl": "http://192.168.1.100:11434",
  "ollamaForge.search.url": "http://192.168.1.100:8888"
}
```

Both inference and search go to the same server. Your dev machine stays lightweight.

### Customizing SearXNG

**Native install:** Edit `/etc/searxng/settings.yml` and restart:
```bash
sudo systemctl restart searxng
```

**Docker:** Mount a config volume:

```bash
mkdir -p searxng-config
cat > searxng-config/settings.yml << 'EOF'
use_default_settings: true
search:
  formats:
    - html
    - json
engines:
  - name: google
    disabled: false
  - name: bing
    disabled: false
  - name: duckduckgo
    disabled: false
  - name: stackoverflow
    disabled: false
  - name: github
    disabled: false
EOF

docker run -d --name searxng --restart unless-stopped \
  -p 8888:8080 \
  -v $(pwd)/searxng-config:/etc/searxng \
  -e SEARXNG_SECRET=$(openssl rand -hex 32) \
  searxng/searxng:latest
```

### Useful engines for developers

| Engine | Why |
|---|---|
| `stackoverflow` | Error messages, how-to questions |
| `github` | Library repos, issues, code examples |
| `npm` / `pypi` | Package search |
| `mdn` | Web API documentation |
| `arch wiki` | Linux system administration |

## Privacy

- ✅ SearXNG is self-hosted — no account, no tracking
- ✅ Queries go from SearXNG to search engines, not from your machine directly
- ✅ No query history stored (unless you configure it)
- ✅ Results are aggregated — no single engine sees all your queries
- ✅ The extension never sends queries anywhere except your SearXNG instance

## Troubleshooting

### "Search unavailable" in agent responses
- Verify SearXNG is running: `curl http://localhost:8888/healthz`
- Check the URL in settings matches the running instance
- Ensure `format=json` works: `curl "http://localhost:8888/search?q=test&format=json"`

### No results returned
- Some engines may be rate-limited on first use
- Try a broader query
- Check SearXNG logs: `docker logs searxng`

### Slow searches
- SearXNG queries multiple engines in parallel — first response wins
- If consistently slow, disable slow engines in `settings.yml`
- Typical response time: 500ms-2s depending on upstream engines

### JSON format not working
- If you compiled SearXNG from source (not Docker), ensure `json` is in `search.formats` in your `settings.yml`
- The Docker image enables JSON by default
