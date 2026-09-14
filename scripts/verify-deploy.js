#!/usr/bin/env node
/**
 * Post-deploy verification for Ollama Forge.
 * Validates the INSTALLED extension directory (not just build output).
 *
 * Hard checks (fail the run on any miss):
 *   - Extension dir exists at the versioned path
 *   - dist/main.js present, not stale vs source build, and size-matched
 *   - dist/node_modules/ present with all native modules + compiled .node binaries
 *   - Webview assets present (webview.html, webview.js, vendor/highlight.bundle.js)
 *   - package.json present, version matches, main entry correct, commands declared
 *
 * Soft checks (reported, not fatal):
 *   - Load test of dist/main.js under the headless vscode mock
 *
 * Usage:
 *   node scripts/verify-deploy.js            # current version from package.json
 *   node scripts/verify-deploy.js 1.0.4      # a specific version
 *
 * Exit code: 0 on success, 1 if any hard check fails.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const root = path.join(__dirname, '..');

// ── Determine version ───────────────────────────────────────────────────────
let version;
try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    version = process.argv[2] || pkg.version;
} catch (e) {
    console.error('FATAL: cannot read package.json:', e.message);
    process.exit(1);
}

const publisher = 'dtenney';
const extName = 'ollamaforge';
const extDirName = `${publisher}.${extName}-${version}`;
const extDir = path.join(os.homedir(), '.vscode', 'extensions', extDirName);

let hardFail = 0;
let softFail = 0;

function hard(label, ok, detail) {
    const sym = ok ? '\u2713' : '\u2717';
    console.log(`  ${sym} ${label}${detail ? ' \u2014 ' + detail : ''}`);
    if (!ok) hardFail++;
}

function soft(label, ok, detail) {
    const sym = ok ? '\u2713' : '\u26A0';
    console.log(`  ${sym} ${label}${detail ? ' \u2014 ' + detail : ''}`);
    if (!ok) softFail++;
}

console.log(`\nOllama Forge post-deploy verification v${version}`);
console.log(`Extension dir: ${extDir}\n`);

// ── 1. Extension directory exists ───────────────────────────────────────────
const dirExists = fs.existsSync(extDir);
hard('Extension directory exists', dirExists, extDir);
if (!dirExists) {
    console.error('\nFATAL: Extension directory not found. Run "npm run deploy" first.');
    process.exit(1);
}

// ── 2. dist/main.js present and not stale ───────────────────────────────────
const installedMain = path.join(extDir, 'dist', 'main.js');
const sourceMain = path.join(root, 'dist', 'main.js');

const installedMainExists = fs.existsSync(installedMain);
hard('dist/main.js present in extension', installedMainExists);

if (installedMainExists && fs.existsSync(sourceMain)) {
    const installedStat = fs.statSync(installedMain);
    const sourceStat = fs.statSync(sourceMain);
    const sizeMatch = installedStat.size === sourceStat.size;
    hard('dist/main.js size matches source', sizeMatch,
        `installed=${installedStat.size}B source=${sourceStat.size}B`);

    const notStale = installedStat.mtimeMs >= sourceStat.mtimeMs - 1000;
    hard('dist/main.js not stale', notStale,
        `installed=${new Date(installedStat.mtimeMs).toISOString()} source=${new Date(sourceStat.mtimeMs).toISOString()}`);
} else if (!fs.existsSync(sourceMain)) {
    soft('source dist/main.js exists for comparison', false, 'source build not found');
}

// ── 3. Native modules in dist/node_modules ──────────────────────────────────
const nativeModules = [
    'tree-sitter',
    'tree-sitter-typescript',
    'tree-sitter-python',
    'better-sqlite3',
];

const nmDir = path.join(extDir, 'dist', 'node_modules');
const nmExists = fs.existsSync(nmDir);
hard('dist/node_modules/ exists', nmExists);

if (nmExists) {
    for (const mod of nativeModules) {
        const modDir = path.join(nmDir, mod);
        const modExists = fs.existsSync(modDir);
        hard(`native module: ${mod}`, modExists);

        if (modExists) {
            const nodeBinaries = findNodeBinaries(modDir);
            hard(`  .node binary present (${mod})`, nodeBinaries.length > 0,
                nodeBinaries.length > 0 ? nodeBinaries.map(f => path.basename(f)).join(', ') : 'none found');
        }
    }
}

// ── 4. Webview assets ───────────────────────────────────────────────────────
const webviewChecks = [
    'webview/webview.html',
    'webview/webview.js',
    'webview/vendor/highlight.bundle.js',
];
for (const rel of webviewChecks) {
    const p = path.join(extDir, rel);
    hard(`webview asset: ${rel}`, fs.existsSync(p));
}

// ── 5. package.json validation ──────────────────────────────────────────────
const pkgPath = path.join(extDir, 'package.json');
const pkgExists = fs.existsSync(pkgPath);
hard('package.json present', pkgExists);

if (pkgExists) {
    try {
        const extPkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

        hard('version matches', extPkg.version === version,
            `installed=${extPkg.version} expected=${version}`);

        const mainEntry = extPkg.main || '';
        const mainOk = mainEntry === './dist/main.js' || mainEntry === 'dist/main.js';
        hard('main entry correct', mainOk, `"${mainEntry}"`);

        const commands = (extPkg.contributes && extPkg.contributes.commands) || [];
        hard('commands declared', commands.length > 0, `${commands.length} commands`);

        const publisherOk = extPkg.publisher === publisher;
        hard('publisher correct', publisherOk, `"${extPkg.publisher}"`);
    } catch (e) {
        hard('package.json valid JSON', false, e.message);
    }
}

// ── 6. Soft: load test under vscode mock ────────────────────────────────────
console.log('\n  Soft check: load test under vscode-mock\u2026');
try {
    const { execSync } = require('child_process');
    const mockPath = path.join(extDir, 'dist', 'test', 'vscode-mock.js');
    if (fs.existsSync(mockPath)) {
        const mockEsc = mockPath.replace(/\\/g, '\\\\');
        const mainEsc = installedMain.replace(/\\/g, '\\\\');
        const result = execSync(
            `node -e "require('${mockEsc}'); require('${mainEsc}'); console.log('loaded OK')"`,
            { cwd: extDir, timeout: 15000, stdio: 'pipe' }
        );
        soft('load test (vscode-mock)', true, result.toString().trim());
    } else {
        soft('load test (vscode-mock)', false, 'vscode-mock.js not found in extension');
    }
} catch (e) {
    const msg = (e.stderr || e.stdout || e.message || '').toString().trim().split('\n')[0];
    soft('load test (vscode-mock)', false, msg.slice(0, 120));
}

// ── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n${'\u2500'.repeat(50)}`);
if (hardFail === 0) {
    console.log(`\u2713 All hard checks passed${softFail > 0 ? ` (${softFail} soft warnings)` : ''}`);
    console.log('\nExtension is ready. Reload VS Code to activate.\n');
    process.exit(0);
} else {
    console.log(`\u2717 ${hardFail} hard check(s) failed${softFail > 0 ? `, ${softFail} soft warning(s)` : ''}`);
    console.log('\nFix the issues above and re-run: node scripts/verify-deploy.js\n');
    process.exit(1);
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function findNodeBinaries(dir) {
    const results = [];
    function walk(d) {
        let entries;
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.name.endsWith('.node')) results.push(p);
        }
    }
    walk(dir);
    return results;
}
