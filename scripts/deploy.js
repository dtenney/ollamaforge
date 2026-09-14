#!/usr/bin/env node
/**
 * Deploy the Ollama Forge extension to the local VS Code extensions directory.
 * Run via: node scripts/deploy.js
 *
 * Steps:
 *   1. Verify dist/main.js exists (bundle must have run first)
 *   2. Copy dist/, webview/, package.json → ~/.vscode/extensions/dtenney.ollamaforge-<version>/
 *   3. Run scripts/self-check.js
 *   4. Exit 0 on success, 1 on failure
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

let skippedLocked = 0;
const { execSync } = require('child_process');

const root = path.join(__dirname, '..');

// ── Read version from package.json ──────────────────────────────────────────
let pkg;
try {
    pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
} catch (e) {
    console.error('FATAL: cannot read package.json:', e.message);
    process.exit(1);
}

const version = pkg.version;
const publisher = pkg.publisher;
const extName = pkg.name;
const extDirName = `${publisher}.${extName}-${version}`;
const extDir = path.join(os.homedir(), '.vscode', 'extensions', extDirName);

console.log(`\nOllama Forge deploy v${version}`);
console.log(`Target: ${extDir}\n`);

// ── 1. Verify build output ──────────────────────────────────────────────────
const distMain = path.join(root, 'dist', 'main.js');
if (!fs.existsSync(distMain)) {
    console.error('FATAL: dist/main.js not found. Run "npm run bundle" first.');
    process.exit(1);
}
console.log('✓ dist/main.js exists');

// ── 2. Copy files to extension directory ────────────────────────────────────
fs.mkdirSync(extDir, { recursive: true });

// Copy dist/
const distSrc = path.join(root, 'dist');
const distDst = path.join(extDir, 'dist');
copyDir(distSrc, distDst);
console.log('✓ dist/ copied');

// Copy webview/
const webviewSrc = path.join(root, 'webview');
const webviewDst = path.join(extDir, 'webview');
if (fs.existsSync(webviewSrc)) {
    copyDir(webviewSrc, webviewDst);
    console.log('✓ webview/ copied');
} else {
    console.warn('⚠ webview/ not found in source — skipping');
}

// Copy package.json
fs.copyFileSync(path.join(root, 'package.json'), path.join(extDir, 'package.json'));
console.log('✓ package.json copied');

// Copy images/ (icon, sidebar icon)
const imagesSrc = path.join(root, 'images');
const imagesDst = path.join(extDir, 'images');
if (fs.existsSync(imagesSrc)) {
    copyDir(imagesSrc, imagesDst);
    console.log('✓ images/ copied');
}

// Copy .vscodeignore if present (not strictly needed for local install)
// Copy README.md, LICENSE if present
for (const f of ['README.md', 'LICENSE', 'CHANGELOG.md']) {
    const src = path.join(root, f);
    if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(extDir, f));
    }
}

// ── 3. Run self-check ───────────────────────────────────────────────────────
console.log('\nRunning self-check…');
try {
    execSync('node scripts/self-check.js', { cwd: root, stdio: 'inherit' });
    console.log('✓ self-check passed\n');
} catch (e) {
    console.error('\n✗ self-check failed');
    process.exit(1);
}

// ── Done ────────────────────────────────────────────────────────────────────
console.log(`\n✓ Deploy complete: ${extDir}`);
console.log('  Reload VS Code extension host to activate (Ctrl+Shift+P → Developer: Reload Window)\n');
process.exit(0);

// ── Helpers ─────────────────────────────────────────────────────────────────
function copyDir(src, dst) {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const srcPath = path.join(src, entry.name);
        const dstPath = path.join(dst, entry.name);
        if (entry.isDirectory()) {
            copyDir(srcPath, dstPath);
        } else {
            try {
                fs.copyFileSync(srcPath, dstPath);
            } catch (e) {
                if (e.code === 'EBUSY' || e.code === 'EPERM') {
                    skippedLocked++;
                    console.warn(`  \u26A0 skipped (locked): ${path.relative(root, dstPath)}`);
                } else {
                    throw e;
                }
            }
        }
    }
}
