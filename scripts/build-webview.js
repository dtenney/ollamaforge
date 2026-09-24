#!/usr/bin/env node
/**
 * build-webview.js — Concatenates webview/src/*.js into webview/webview.js
 *
 * Order matters: state → models → render → input → search → handlers → main
 * Each file is a plain script (no modules), so concatenation is safe.
 */
const fs = require('fs');
const path = require('path');

const SRC_DIR = path.join(__dirname, '..', 'webview', 'src');
const OUT_FILE = path.join(__dirname, '..', 'webview', 'webview.js');

const ORDER = [
    'state.js',
    'models.js',
    'render.js',
    'input.js',
    'search.js',
    'handlers.js',
    'main.js'
];

let totalLines = 0;
const parts = [];

for (const name of ORDER) {
    const filePath = path.join(SRC_DIR, name);
    if (!fs.existsSync(filePath)) {
        console.error(`✗ Missing: webview/src/${name}`);
        process.exit(1);
    }
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').length;
    totalLines += lines;
    parts.push(`// ═══ ${name} ═══\n` + content.trimEnd() + '\n');
    console.log(`  ✓ ${name} (${lines} lines)`);
}

const output = parts.join('\n');
fs.writeFileSync(OUT_FILE, output, 'utf8');
console.log(`\n✓ webview/webview.js written — ${totalLines} lines from ${ORDER.length} modules`);
