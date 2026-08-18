# Deployment — Ollama Forge

## Environment

- **OS**: Windows 11, Git Bash (NOT PowerShell, NOT cmd)
- **Shell**: All `run_command` calls use Git Bash. Never use PowerShell cmdlets.
- **Node**: Required. Verify with `node --version` before any build step.

## Build & Deploy (local development)

```bash
# From workspace root: c:/Users/david/Documents/source/ollamaforge
npm run deploy
```

This single command:
1. Runs `scripts/vendor-hljs.js` (bundles highlight.js)
2. Runs `esbuild.js` (bundles TypeScript → `dist/main.js`)
3. Runs `scripts/self-check.js` (validates output)
4. Copies `dist/main.js`, `webview/`, `package.json` → `%USERPROFILE%/.vscode/extensions/dtenney.ollamaforge-<version>/`

**Do NOT run `tsc` directly** — the project uses esbuild, not tsc for deployment.
**Do NOT use `npm run compile`** for deployment — compile uses tsc and doesn't deploy.

## After Deploy

Reload the VS Code extension host: `Ctrl+Shift+P` → **Developer: Reload Window** (or **Restart Extension Host**).

The extension version is in `package.json` → `"version"`. The deploy target directory is:
```
%USERPROFILE%/.vscode/extensions/dtenney.ollamaforge-<version>/
```

## Common Failures on Windows

| Symptom | Cause | Fix |
|---|---|---|
| `Get-ChildItem: command not found` | PowerShell cmdlet in Git Bash | Use `ls`, `find`, `cat` etc. |
| `npm: command not found` | Node not in Git Bash PATH | Open a new Git Bash or check `which node` |
| `ENOENT dist/main.js` | Build didn't run | Run `npm run bundle` first, then retry |
| `self-check failed` | Syntax/validation error | Read the self-check output, fix the reported file |
| Extension not updated after deploy | Extension host not reloaded | Run Developer: Reload Window in VS Code |
| `Cannot find module` after deploy | Native .node files not copied | Check that `node_modules/better-sqlite3` and `node_modules/tree-sitter` are present in the extension dir |

## Git Workflow

```bash
git add src/ webview/ package.json          # Stage specific files — never git add -A
git commit -m "feat: description"
# Do NOT push unless user explicitly asks
```

## SSH / Remote Hosts

This project has no SSH deploy targets. All deployment is local (VS Code extension directory).
