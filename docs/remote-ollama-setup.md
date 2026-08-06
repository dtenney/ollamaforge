# Remote Ollama Setup Guide

Connect Ollama Forge to an Ollama instance running on a dedicated server instead of localhost. This gives you GPU-accelerated inference from any machine on your network.

## Why Remote?

- **Dedicated GPU** — Keep your development machine free of GPU memory pressure
- **Shared inference** — Multiple workstations can use the same Ollama server
- **Bigger models** — A server with 24-32GB VRAM can run models your laptop can't
- **Always-on** — Server stays running even when your dev machine sleeps

## Architecture

```
┌─────────────────────┐         HTTP (LAN)         ┌─────────────────────────┐
│  Dev Machine        │ ──────────────────────────► │  AI Server              │
│  (Windows/Mac/Linux)│                             │  (Ubuntu + GPU)         │
│                     │  ollamaForge.serverUrl:        │                         │
│  VS Code +          │  http://192.168.1.100:11434 │  Ollama                 │
│  Ollama Forge        │                             │  RTX 3090/4090/5090     │
│                     │ ◄────────────────────────── │  gemma4 / qwen3 / etc   │
│                     │         Streaming tokens     │                         │
└─────────────────────┘                             └─────────────────────────┘
```

## Server Setup

### 1. Install Ollama on the server

```bash
curl -fsSL https://ollama.com/install.sh | sh
```

### 2. Configure Ollama to listen on all interfaces

By default, Ollama only listens on `127.0.0.1`. To accept connections from your LAN:

```bash
# Create systemd override
sudo mkdir -p /etc/systemd/system/ollama.service.d
sudo tee /etc/systemd/system/ollama.service.d/override.conf << 'EOF'
[Service]
Environment="OLLAMA_HOST=0.0.0.0:11434"
Environment="OLLAMA_ORIGINS=*"
EOF

# Reload and restart
sudo systemctl daemon-reload
sudo systemctl restart ollama
```

### 3. Verify it's listening

```bash
# From the server itself
curl http://localhost:11434/api/tags

# From your dev machine (replace with your server's IP)
curl http://192.168.1.100:11434/api/tags
```

You should see a JSON response listing available models.

### 4. Pull a model

```bash
# On the server
ollama pull gemma4:26b       # 17GB, needs 24GB+ VRAM
ollama pull qwen2.5-coder:7b # 4GB, good starting point
ollama pull llama3.1:8b      # 5GB, general purpose
```

## Extension Configuration

In VS Code, set the remote URL:

```json
// .vscode/settings.json (per-project)
{
  "ollamaForge.serverUrl": "http://192.168.1.100:11434"
}
```

Or globally via Settings UI: search "Ollama" → set **Base URL** to your server's address.

That's it. Ollama Forge will now send all inference requests to your server.

## Security Considerations

**This setup is for trusted LANs only.** Ollama has no built-in authentication.

### Do:
- ✅ Use on a private home/office network
- ✅ Restrict access via firewall rules (only allow your dev machine's IP)
- ✅ Keep the server behind a router/NAT (not exposed to the internet)

### Don't:
- ❌ Expose port 11434 to the public internet
- ❌ Use this over untrusted WiFi without a VPN
- ❌ Share the server IP publicly

### Firewall example (UFW on Ubuntu):

```bash
# Allow only your dev machine
sudo ufw allow from 192.168.1.50 to any port 11434

# Or allow your entire subnet
sudo ufw allow from 192.168.1.0/24 to any port 11434

# Block everything else (default deny)
sudo ufw default deny incoming
sudo ufw enable
```

## Performance

| Setup | Latency | Throughput |
|---|---|---|
| Localhost (same machine) | <1ms | Full GPU speed |
| LAN (Gigabit Ethernet) | 1-3ms | Full GPU speed (network overhead negligible) |
| LAN (WiFi 6) | 5-15ms | Full GPU speed (slightly higher TTFT) |
| Remote (WireGuard VPN) | 20-50ms | Full GPU speed (noticeable TTFT) |

For LLM inference, network latency only affects **time to first token** (TTFT). Once streaming starts, tokens arrive at GPU generation speed regardless of network. On a Gigabit LAN, you won't notice any difference from localhost.

## GPU Pinning (Multi-GPU Servers)

If your server has multiple GPUs, pin Ollama to a specific one:

```bash
# In the systemd override
[Service]
Environment="OLLAMA_HOST=0.0.0.0:11434"
Environment="OLLAMA_ORIGINS=*"
Environment="CUDA_VISIBLE_DEVICES=0"  # Use only GPU 0
```

This leaves other GPUs free for image generation, video encoding, or other workloads.

## Troubleshooting

### "Connection refused" from dev machine
- Verify Ollama is listening: `ss -tlnp | grep 11434` on the server
- Check `OLLAMA_HOST=0.0.0.0` is set (not `127.0.0.1`)
- Check firewall: `sudo ufw status` or `sudo iptables -L`

### "CORS error" in extension
- Set `OLLAMA_ORIGINS=*` in the systemd override
- Restart Ollama after changing environment variables

### Slow first response (cold start)
- First request after idle loads the model into VRAM (~5-15 seconds for large models)
- Set `OLLAMA_KEEP_ALIVE=-1` to keep models loaded permanently
- Or use a preload service that pings Ollama on boot

### Model not found
- Models are stored on the server, not your dev machine
- Pull models on the server: `ollama pull <model>`
- List available: `ollama list`
