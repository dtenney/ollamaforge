const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const production = process.argv.includes('--production');

// Native modules that esbuild cannot bundle — they are marked external and copied
// into dist/node_modules so VSCode's extension host can load them at runtime.
const NATIVE_EXTERNALS = [
    'tree-sitter',
    'tree-sitter-typescript',
    'tree-sitter-python',
    'better-sqlite3',
];

esbuild.build({
    entryPoints: ['src/main.ts'],
    bundle: true,
    outfile: 'dist/main.js',
    external: ['vscode', ...NATIVE_EXTERNALS],
    format: 'cjs',
    platform: 'node',
    target: 'es2020',
    sourcemap: !production,
    minify: production,
    // Keep readable class/function names even when minified
    keepNames: true,
}).then(() => {
    console.log('✓ Extension bundled → dist/main.js');

    // Copy native module directories into dist/node_modules
    const distNodeModules = path.join(__dirname, 'dist', 'node_modules');
    fs.mkdirSync(distNodeModules, { recursive: true });

    for (const mod of NATIVE_EXTERNALS) {
        const src = path.join(__dirname, 'node_modules', mod);
        const dst = path.join(distNodeModules, mod);
        if (!fs.existsSync(src)) continue;
        copyDirSync(src, dst);
        console.log(`✓ Copied native module: ${mod}`);
    }
}).catch(() => process.exit(1));

function copyDirSync(src, dst) {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const srcPath = path.join(src, entry.name);
        const dstPath = path.join(dst, entry.name);
        if (entry.isDirectory()) {
            copyDirSync(srcPath, dstPath);
        } else {
            fs.copyFileSync(srcPath, dstPath);
        }
    }
}
