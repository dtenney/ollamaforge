// src/verification.ts
// Verification helpers extracted from agent.ts (Phase 2, agent-decomposition-plan.md).
//
// These were private Agent methods. Each is now a standalone function. Methods that
// previously read `this.workspaceRoot` now take it as an explicit parameter; the
// Agent's thin private methods pass `this.workspaceRoot` through, preserving behavior.
//
//   readTerminal(index?)                                  -> string
//   getDiagnostics(root, relPath?)                        -> string
//   syntaxCheck(absPath, workspaceRoot)                   -> string | null
//   findTestFile(absSourcePath, workspaceRoot)            -> string | null
//   shouldRunTests()                                      -> boolean
//   buildModelRelationshipMap(root)                        -> Array<{className, relations}>
//   validateNewContent(newContent, workspaceRoot)         -> string | null

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';

/**
 * Read recent output from a VS Code terminal (shell integration when available).
 */
export function readTerminal(index?: number): string {
    const terminals = vscode.window.terminals;
    if (!terminals.length) { return 'No terminals are open in VS Code.'; }

    const terminal = index !== undefined
        ? terminals[index]
        : vscode.window.activeTerminal ?? terminals[terminals.length - 1];

    if (!terminal) { return `Terminal index ${index} not found. ${terminals.length} terminal(s) open.`; }

    // shellIntegration (VS Code 1.93+) provides recent command output
    const si = (terminal as any).shellIntegration;
    if (si?.executedCommands) {
        try {
            const cmds = Array.from(si.executedCommands as Iterable<any>);
            const recent = cmds.slice(-5);
            const MAX = 8192;
            let output = `Terminal: ${terminal.name}\n`;
            for (const cmd of recent) {
                const text = cmd.output?.trim() ?? '';
                if (text) {
                    output += `\n$ ${cmd.command ?? '(unknown)'}\n${text}\n`;
                }
                if (output.length > MAX) { break; }
            }
            return output.slice(0, MAX) || `Terminal "${terminal.name}" -- no recent output captured.`;
        } catch {
            // Fall through to fallback
        }
    }

    // Fallback: list terminals and suggest run_command
    const list = terminals.map((t, i) => `  [${i}] ${t.name}`).join('\n');
    return `Cannot read terminal output directly (requires VS Code 1.93+ shell integration).\n\nOpen terminals:\n${list}\n\nTip: Use run_command to execute a command and capture its output.`;
}

/**
 * Collect VS Code diagnostics for a file (or the whole workspace).
 */
export function getDiagnostics(root: string, relPath?: string): string {
    const lines: string[] = [];

    // When a specific file is requested, resolve its URI and query directly
    if (relPath) {
        const normalizedRel = relPath.replace(/\\/g, '/');
        const fullPath = path.resolve(root, normalizedRel);
        const uri = vscode.Uri.file(fullPath);
        const diags = vscode.languages.getDiagnostics(uri);
        for (const d of diags) {
            if (d.severity > vscode.DiagnosticSeverity.Warning) { continue; }
            const sev = d.severity === vscode.DiagnosticSeverity.Error ? 'ERROR' : 'WARN';
            lines.push(`${normalizedRel}:${d.range.start.line + 1}:${d.range.start.character + 1} ${sev} ${d.message}`);
        }
        return lines.length ? lines.join('\n') : 'No errors or warnings found.';
    }

    // No specific file -- iterate all diagnostics in the workspace
    const allDiags = vscode.languages.getDiagnostics();
    for (const [uri, diags] of allDiags) {
        const filePath = uri.fsPath;
        if (!filePath.startsWith(root)) { continue; }
        const rel = path.relative(root, filePath).replace(/\\/g, '/');

        for (const d of diags) {
            if (d.severity > vscode.DiagnosticSeverity.Warning) { continue; }
            const sev = d.severity === vscode.DiagnosticSeverity.Error ? 'ERROR' : 'WARN';
            lines.push(`${rel}:${d.range.start.line + 1}:${d.range.start.character + 1} ${sev} ${d.message}`);
        }
        if (lines.length >= 100) { break; }
    }

    return lines.length ? lines.join('\n') : 'No errors or warnings found.';
}

/**
 * Syntax-check a single file (Python via py_compile, TS via tsc --noEmit).
 * Returns an error string on failure, null on success / unsupported.
 */
export function syntaxCheck(absPath: string, workspaceRoot: string): string | null {
    const ext = path.extname(absPath).toLowerCase();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { execFileSync: execFileSyncFn } = require('child_process') as typeof import('child_process');

    if (ext === '.py') {
        try {
            const pythonCmd = process.platform === 'win32' ? 'py' : 'python3';
            try {
                execFileSyncFn(pythonCmd, ['-m', 'py_compile', absPath], {
                    timeout: 5000, stdio: 'pipe', encoding: 'utf8'
                });
            } catch (e1) {
                try {
                    execFileSyncFn('python', ['-m', 'py_compile', absPath], {
                        timeout: 5000, stdio: 'pipe', encoding: 'utf8'
                    });
                } catch (e2: any) {
                    const stderr = (e2.stderr as string | undefined) ?? String(e2);
                    const lines = stderr.split('\n').filter((l: string) => l.trim() && !l.startsWith('Traceback'));
                    return lines.slice(0, 4).join('\n');
                }
            }
            return null;
        } catch {
            return null;
        }
    }

    if (ext === '.ts' || ext === '.tsx') {
        // Run tsc --noEmit scoped to just this file using the project tsconfig if present
        const root = workspaceRoot;
        if (!root) { return null; }
        const tsconfigPath = path.join(root, 'tsconfig.json');
        if (!fs.existsSync(tsconfigPath)) { return null; }
        try {
            execSync(`npx tsc --noEmit --skipLibCheck 2>&1`, {
                cwd: root, timeout: 15000, stdio: 'pipe', encoding: 'utf8'
            });
            return null;
        } catch (e: any) {
            const out = ((e.stdout ?? '') + (e.stderr ?? '')).trim();
            if (!out) { return null; }
            // Filter to only errors that mention this specific file
            const relFile = path.relative(root, absPath).replace(/\\/g, '/');
            const relevantLines = out.split('\n')
                .filter((l: string) => l.includes(relFile) || l.match(/error TS/))
                .slice(0, 5);
            return relevantLines.length > 0 ? relevantLines.join('\n') : null;
        }
    }

    return null;
}

/**
 * Find the test file corresponding to a source file.
 * Returns absolute path if found, null otherwise.
 */
export function findTestFile(absSourcePath: string, workspaceRoot: string): string | null {
    const root = workspaceRoot;
    if (!root) { return null; }

    const ext = path.extname(absSourcePath);
    const base = path.basename(absSourcePath, ext);
    const dir  = path.dirname(absSourcePath);
    const relDir = path.relative(root, dir).replace(/\\/g, '/');

    const candidates: string[] = [];

    if (ext === '.py') {
        // Same directory: test_<name>.py or <name>_test.py
        candidates.push(path.join(dir, `test_${base}.py`));
        candidates.push(path.join(dir, `${base}_test.py`));

        // tests/ sibling at project root
        const rootTests = path.join(root, 'tests', `test_${base}.py`);
        candidates.push(rootTests);
        candidates.push(path.join(root, 'tests', `${base}_test.py`));

        // tests/ sibling relative to file's directory
        const siblingTests = path.join(dir, '..', 'tests', `test_${base}.py`);
        candidates.push(siblingTests);

        // Mirror path under tests/ at project root
        const mirrorPath = path.join(root, 'tests', relDir, `test_${base}.py`);
        candidates.push(mirrorPath);
    } else if (ext === '.ts' || ext === '.js') {
        // <name>.test.ts / <name>.spec.ts in same dir
        candidates.push(path.join(dir, `${base}.test${ext}`));
        candidates.push(path.join(dir, `${base}.spec${ext}`));
        // __tests__ sibling
        candidates.push(path.join(dir, '__tests__', `${base}.test${ext}`));
        candidates.push(path.join(dir, '__tests__', `${base}.spec${ext}`));
    }

    for (const c of candidates) {
        try {
            if (fs.existsSync(c)) { return c; }
        } catch { /* skip */ }
    }
    return null;
}

/** Returns true if autoRunTests is enabled in settings. */
export function shouldRunTests(): boolean {
    try {
        const vscode = require('vscode') as typeof import('vscode');
        return vscode.workspace.getConfiguration('ollamaForge').get<boolean>('autoRunTests', false);
    } catch {
        return false;
    }
}

/**
 * Scan app/models/ for SQLAlchemy ForeignKey and relationship() declarations.
 * Returns a map of className -> human-readable relation strings.
 */
export function buildModelRelationshipMap(root: string): Array<{ className: string; relations: string[] }> {
    const result: Array<{ className: string; relations: string[] }> = [];
    const modelsDir = path.join(root, 'app', 'models');
    if (!fs.existsSync(modelsDir)) { return result; }

    try {
        const files = fs.readdirSync(modelsDir).filter(f => f.endsWith('.py') && f !== '__init__.py');
        for (const f of files) {
            const content = fs.readFileSync(path.join(modelsDir, f), 'utf8');
            const lines = content.split('\n');

            let currentClass = '';
            const classRelations = new Map<string, string[]>();

            for (const line of lines) {
                // Track current class
                const classMatch = line.match(/^class\s+(\w+)\s*[\(:]/);
                if (classMatch) {
                    currentClass = classMatch[1];
                    if (!classRelations.has(currentClass)) { classRelations.set(currentClass, []); }
                    continue;
                }
                if (!currentClass) { continue; }

                const rels = classRelations.get(currentClass)!;

                // db.relationship('OtherModel', ...) or relationship('OtherModel', ...)
                const relMatch = line.match(/(?:db\.)?relationship\(\s*['"](\w+)['"]/);
                if (relMatch) {
                    const target = relMatch[1];
                    const attrMatch = line.match(/^\s+(\w+)\s*=/);
                    const attr = attrMatch ? attrMatch[1] : '';
                    const uselist = /uselist\s*=\s*False/i.test(line) ? '1:1' : '1:many';
                    rels.push(`${target} (${uselist}${attr ? ' via ' + attr : ''})`);
                    continue;
                }

                // db.ForeignKey('table.col') -- infer the referenced table
                const fkMatch = line.match(/(?:db\.)?ForeignKey\(\s*['"](\w+)\./);
                if (fkMatch) {
                    const table = fkMatch[1];
                    const attrMatch = line.match(/^\s+(\w+)\s*=/);
                    const attr = attrMatch ? attrMatch[1] : '';
                    rels.push(`-> ${table}${attr ? ' (' + attr + ')' : ''} [FK]`);
                }
            }

            for (const [cls, rels] of classRelations) {
                if (rels.length > 0) { result.push({ className: cls, relations: rels }); }
            }
        }
    } catch { /* skip */ }

    return result;
}

/**
 * Validate that "from app.X import Y" references in new content resolve to files on disk.
 * Returns a blocking error string if any module is missing, null otherwise.
 */
export function validateNewContent(newContent: string, workspaceRoot: string): string | null {
    const root = workspaceRoot;
    if (!root) { return null; }
    const importRe = /from\s+(app\.[\w.]+)\s+import\s+([\w,\s]+)/g;
    const missing: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = importRe.exec(newContent)) !== null) {
        const modPath = match[1].replace(/\./g, '/');
        const candidates = [
            path.join(root, modPath + '.py'),
            path.join(root, modPath, '__init__.py'),
        ];
        if (!candidates.some(c => fs.existsSync(c))) {
            missing.push(match[1]);
        }
    }
    if (missing.length === 0) { return null; }
    // Try to suggest the correct module for each missing one
    const suggestions: string[] = [];
    for (const m of missing) {
        const lastName = m.split('.').pop() ?? '';
        // Search for the name in known utility files
        const searchDirs = ['app/utils', 'app'];
        let found = '';
        for (const sd of searchDirs) {
            const sdAbs = path.join(root, sd);
            try {
                for (const f of fs.readdirSync(sdAbs)) {
                    if (!f.endsWith('.py')) { continue; }
                    const fContent = fs.readFileSync(path.join(sdAbs, f), 'utf8');
                    if (fContent.includes(`def ${lastName}`) || fContent.includes(`class ${lastName}`)) {
                        const rel2 = sd.replace(/\//g, '.') + '.' + f.replace('.py', '');
                        found = `  - Use \`from ${rel2} import ${lastName}\` instead`;
                        break;
                    }
                }
            } catch { /* skip */ }
            if (found) { break; }
        }
        suggestions.push(`  - ${m}${found ? '\n' + found : ''}`);
    }
    return `Edit blocked: the following module(s) do not exist on disk:\n${suggestions.join('\n')}\nFix the import path and retry edit_file immediately -- do NOT ask the user.`;
}
