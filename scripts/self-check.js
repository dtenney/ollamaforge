#!/usr/bin/env node
/**
 * Self-check: quickly verify the extension environment is healthy.
 * Run via: node scripts/self-check.js
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const checks = [];

// 1. Required source files exist
for (const f of ['src/main.ts', 'src/agent.ts', 'src/provider.ts', 'dist/main.js']) {
    checks.push({ ok: fs.existsSync(path.join(root, f)), file: f });
}

// 2. Webview files present
for (const f of ['webview/webview.html', 'webview/webview.js', 'webview/vendor/highlight.bundle.js']) {
    checks.push({ ok: fs.existsSync(path.join(root, f)), file: f });
}

// 3. package.json is valid JSON
try {
    JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    checks.push({ ok: true, file: 'package.json (valid)' });
} catch {
    checks.push({ ok: false, file: 'package.json (invalid JSON)' });
}

// 4. .ollamaforge directory exists
checks.push({ ok: fs.existsSync(path.join(root, '.ollamaforge')), file: '.ollamaforge/' });

// 5. Node modules present
for (const mod of ['better-sqlite3', 'tree-sitter', 'axios']) {
    checks.push({ ok: fs.existsSync(path.join(root, 'node_modules', mod)), file: `node_modules/${mod}` });
}

// Print results
let pass = 0, fail = 0;
for (const { ok, file } of checks) {
    console.log(ok ? '  ✓' : '  ✗', file);
    ok ? pass++ : fail++;
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

