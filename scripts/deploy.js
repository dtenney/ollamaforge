#!/usr/bin/env node
// Deploy the esbuild bundle + webview to the local VS Code extension directory.
// Uses esbuild (not tsc) so all dependencies are bundled into dist/main.js — no node_modules needed.
// Run via: npm run deploy

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const extRoot = path.join(process.env.USERPROFILE, `.vscode/extensions/dtenney.ollamaforge-${pkg.version}`);
const srcRoot = path.join(__dirname, '..');

// --- Pre-flight check ---
try {
    execSync('node scripts/self-check.js', { cwd: srcRoot, stdio: 'inherit' });
} catch {
    console.error('\nPre-flight check failed. Fix issues before deploying.');
    process.exit(1);
}

// --- Copy bundled main.js ---
const distDst = path.join(extRoot, 'dist');
fs.mkdirSync(distDst, { recursive: true });

const mainSrc = path.join(srcRoot, 'dist/main.js');
if (!fs.existsSync(mainSrc)) {
    console.error('ERROR: dist/main.js not found. Run "npm run bundle" first.');
    process.exit(1);
}
fs.copyFileSync(mainSrc, path.join(distDst, 'main.js'));
console.log('Deployed dist/main.js');

// --- Copy webview ---
fs.mkdirSync(path.join(extRoot, 'webview'), { recursive: true });
for (const f of ['webview.js', 'webview.html']) {
    fs.copyFileSync(
        path.join(srcRoot, 'webview', f),
        path.join(extRoot, 'webview', f)
    );
    console.log(`Deployed webview/${f}`);
}

// --- Copy root files ---
for (const f of ['package.json', 'mcp.example.json', 'settings.example.json']) {
    const src = path.join(srcRoot, f);
    if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(extRoot, f));
        console.log(`Deployed ${f}`);
    }
}

console.log('\nDeploy complete. Reload the extension host in VS Code.');
