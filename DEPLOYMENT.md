# Deployment — Ollama Forge

## Environment

- **OS**: Windows 11, Git Bash (NOT PowerShell, NOT cmd)
- **Shell**: All `run_command` calls use Git Bash. Never use PowerShell cmdlets.
- **Node**: Required. Verify with `node --version` before any build step.

## Build & Deploy (local development)

```bash
# From workspace root (wherever you cloned the repo)
npm run deploy
```

This single command:
1. Runs `scripts/vendor-hljs.js` (bundles highlight.js)
2. Runs `esbuild.js` (bundles TypeScript → `dist/main.js`, copies native modules → `dist/node_modules/`)
3. Runs `scripts/self-check.js` (validates output)
4. Copies `dist/main.js`, `webview/`, `package.json` → `%USERPROFILE%/.vscode/extensions/dtenney.ollamaforge-<version>/`
5. Runs `scripts/verify-deploy.js` (in-depth post-deploy validation — see below)

**Do NOT run `tsc` directly** — the project uses esbuild, not tsc for deployment.
**Do NOT use `npm run compile`** for deployment — compile uses tsc and doesn't deploy.

## Post-Deploy Verification

`npm run deploy` ends by running `scripts/verify-deploy.js`, which validates the
installed extension in depth. Hard checks (fail the run on any miss):

- Extension dir exists at the versioned path
- `dist/main.js` present, not stale vs the source build, and size-matched
- `dist/node_modules/` present with all native modules (`tree-sitter`,
  `tree-sitter-typescript`, `tree-sitter-python`, `better-sqlite3`) and their
  compiled `.node` binaries
- Webview assets present (`webview.html`, `webview.js`, `vendor/highlight.bundle.js`)
- `package.json` present, version matches, `main` entry correct, commands declared

It also runs a soft load test of `dist/main.js` under the headless vscode mock
(reported, not fatal — the mock is minimal).

Run it standalone any time:

    node scripts/verify-deploy.js            # current version
    node scripts/verify-deploy.js 1.0.4      # a specific version
    # or: npm run verify:deploy

Exit code is 0 on success, 1 if any hard check fails.

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

## SSH Remote Execution on Windows Git Bash (known platform issue)

Nested/inline quoting in `ssh user@host '...'` commands breaks frequently on this platform. Do NOT burn cycles retrying quoting variations. Rules:

1. **Keep the remote command simple.** Single-quoted, no nested double quotes, no variables, no backslashes, no multi-line inline scripts.
2. **Preferred pattern — scp then run:**
   ```bash
   scp deploy.sh user@host:~/
   ssh user@host 'bash ~/deploy.sh'
   ```
   This avoids all nested-quoting problems. If the script takes arguments, use simple unquoted args only: `ssh user@host 'bash ~/deploy.sh --flag'`.
3. **MSYS path mangling:** Git Bash rewrites arguments that look like Unix paths (e.g. `/tmp/x` becomes `C:/Program Files/Git/tmp/x`). If a path arrives mangled on the remote side, prefix the command with `MSYS_NO_PATHCONV=1`.
4. **`~` expands on the REMOTE shell**, not locally — always use `~/...` in the remote command, never a local Windows path.
5. **Two quoting failures = stop.** If a quoted ssh command fails twice, do not try a third quoting arrangement — switch to the scp-then-run pattern above.
