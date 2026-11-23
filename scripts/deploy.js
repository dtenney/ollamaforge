#!/usr/bin/env node
/**
 * Deploy Ollama Forge to the local VS Code extension directory.
 * Copies build artifacts (dist/, webview/, package.json, static files)
 * to ~/.vscode/extensions/dtenney.ollamaforge-<version>/
 *
 * Usage: node scripts/deploy.js
 * Exit code: 0 on success, 1 on failure.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const root = path.join(__dirname, '..');

// ── Read version ─────────────────────────────────────────────────────────────
let version;
try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    version = pkg.version;
} catch (e) {
    console.error('FATAL: cannot read package.json:', e.message);
    process.exit(1);
}

const publisher = 'dtenney';
const extName = 'ollamaforge';
const extDirName = `${publisher}.${extName}-${version}`;
const extDir = path.join(os.homedir(), '.vscode', 'extensions', extDirName);

console.log(`\nOllama Forge deploy v${version}`);
console.log(`Target: ${extDir}\n`);

// ── Ensure extension directory exists ────────────────────────────────────────
if (!fs.existsSync(extDir)) {
    fs.mkdirSync(extDir, { recursive: true });
    console.log(`  ✓ Created extension directory`);
} else {
    console.log(`  ✓ Extension directory exists`);
}

// ── Copy function ────────────────────────────────────────────────────────────
function copyFile(src, dest) {
    const srcPath = path.join(root, src);
    const destPath = path.join(extDir, dest);
    if (!fs.existsSync(srcPath)) {
        console.log(`  ⚠ SKIP ${src} (not found)`);
        return false;
    }
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.copyFileSync(srcPath, destPath);
    console.log(`  ✓ ${src} → ${dest}`);
    return true;
}

function copyDir(src, dest) {
    const srcPath = path.join(root, src);
    const destPath = path.join(extDir, dest);
    if (!fs.existsSync(srcPath)) {
        console.log(`  ⚠ SKIP ${src}/ (not found)`);
        return false;
    }
    fs.mkdirSync(destPath, { recursive: true });
    // Recursive copy (skip locked files gracefully)
    let skipped = 0;
    function walk(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const s = path.join(dir, entry.name);
            const d = path.join(destPath, path.relative(srcPath, s));
            if (entry.isDirectory()) {
                fs.mkdirSync(d, { recursive: true });
                walk(s);
            } else {
                try {
                    fs.copyFileSync(s, d);
                    // Sync mtime so verify-deploy staleness check passes
                    const srcStat = fs.statSync(s);
                    fs.utimesSync(d, srcStat.atime, srcStat.mtime);
                } catch (e) {
                    if (e.code === 'EBUSY' || e.code === 'EPERM') {
                        skipped++;
                        console.log(`  ⚠ skipped (locked): ${path.relative(root, d)}`);
                    } else {
                        throw e;
                    }
                }
            }
        }
    }
    walk(srcPath);
    console.log(`  ✓ ${src}/ → ${dest}/`);
    return true;
}

// ── Copy build artifacts ─────────────────────────────────────────────────────
let failures = 0;

// Core bundle
if (!copyFile('dist/main.js', 'dist/main.js')) failures++;

// Source maps (optional)
copyFile('dist/main.js.map', 'dist/main.js.map');

// Native modules (tree-sitter, better-sqlite3, etc.)
if (fs.existsSync(path.join(root, 'dist', 'node_modules'))) {
    if (!copyDir('dist/node_modules', 'dist/node_modules')) failures++;
} else {
    console.log(`  ⚠ dist/node_modules/ not found — native modules may be missing`);
}

// Webview
if (!copyDir('webview', 'webview')) failures++;

// package.json
if (!copyFile('package.json', 'package.json')) failures++;

// Static files (nice to have in the extension dir)
const staticFiles = [
    'README.md',
    'LICENSE.txt',
    'ARCHITECTURE.md',
    'DEPLOYMENT.md',
    'CHANGELOG.md',
    'CODEBASE_MAP.md',
    'mcp.example.json',
    'settings.example.json',
];
for (const f of staticFiles) {
    copyFile(f, f); // non-fatal
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log('');
if (failures > 0) {
    console.log(`✗ ${failures} critical file(s) failed to copy. Run "npm run bundle" first.`);
    process.exit(1);
} else {
    console.log(`✓ Deploy complete. Run "node scripts/verify-deploy.js" to validate.`);
    console.log(`  Then reload VS Code: Ctrl+Shift+P → Developer: Reload Window`);
}
