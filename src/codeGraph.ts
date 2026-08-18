/**
 * codeGraph.ts — MEX-style code graph for Ollama Forge
 *
 * Builds a Tree-sitter symbol index into SQLite (.ollamaforge/graph.db).
 * Provides scope routing: given a user query, returns ≤1500 tokens of
 * the most relevant symbols to inject into the system prompt.
 * Provides drift detection via MinHash fingerprints.
 * Cross-references memory entries against the graph to flag stale facts.
 */

import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { logInfo, logError, logWarn } from './logger';

// ── Lazy-loaded native modules (tree-sitter, better-sqlite3) ─────────────────
// These are optional — if native bindings fail, graph features are silently disabled.
// Guard with a promise to prevent parallel-init races in multi-workspace setups.

let Parser: any = null;
let TypeScriptLang: any = null;
let PythonLang: any = null;
let Database: any = null;
let nativeAvailable = false;
let nativeLoadAttempted = false;

function tryLoadNativeModules(): boolean {
    if (nativeLoadAttempted) return nativeAvailable;
    nativeLoadAttempted = true;
    try {
        Parser = require('tree-sitter');
        TypeScriptLang = require('tree-sitter-typescript').typescript;
        Database = require('better-sqlite3');
        nativeAvailable = true;
        try { PythonLang = require('tree-sitter-python'); } catch { /* optional */ }
        logInfo('[CodeGraph] Native modules loaded (tree-sitter + sqlite)');
    } catch (e) {
        logWarn('[CodeGraph] Native modules unavailable — graph features disabled: ' + String(e));
    }
    return nativeAvailable;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GraphNode {
    id: string;
    kind: 'function' | 'method' | 'class' | 'interface' | 'enum' | 'variable';
    name: string;
    file: string;
    startLine: number;
    endLine: number;
    body?: string;
    fingerprint?: string; // JSON-serialized number[]
}

export interface GraphEdge {
    src: string;
    dst: string;
    kind: 'calls' | 'imports' | 'contains' | 'extends' | 'exports';
}

export interface DriftReport {
    moved: Array<{ name: string; file: string; newLocation?: string }>;
    ambiguous: Array<{ name: string; file: string }>;
    gone: Array<{ name: string; file: string }>;
}

export interface ScopeContext {
    text: string;
    tokenEstimate: number;
    nodeCount: number;
}

/** A memory entry whose symbol name appears in the graph but with changed fingerprint */
export interface MemoryGraphConflict {
    symbolName: string;
    memorySnippet: string; // first 80 chars of the memory entry
    currentFile: string;
    currentLine: number;
    status: 'changed' | 'gone';
}

// ── MinHash (K=64) ────────────────────────────────────────────────────────────

function minhash(text: string, k = 64): number[] {
    const shingles = new Set<string>();
    for (let i = 0; i + 3 <= text.length; i++) {
        shingles.add(text.slice(i, i + 3));
    }
    const hashes: number[] = [];
    for (let seed = 0; seed < k; seed++) {
        let min = 0xFFFFFFFF;
        for (const s of shingles) {
            const h = murmur32(s, seed);
            if (h < min) min = h;
        }
        hashes.push(min);
    }
    return hashes;
}

function murmur32(str: string, seed: number): number {
    let h = seed ^ str.length;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x5bd1e995);
        h ^= h >>> 15;
    }
    return h >>> 0;
}

function jaccardFromMinhash(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 0;
    let match = 0;
    for (let i = 0; i < a.length; i++) if (a[i] === b[i]) match++;
    return match / a.length;
}

// ── Node ID ───────────────────────────────────────────────────────────────────

function nodeId(file: string, name: string, startLine: number): string {
    return crypto.createHash('sha256')
        .update(`${file}:${name}:${startLine}`)
        .digest('hex')
        .slice(0, 16);
}

// ── Keyword extraction (camelCase → words for FTS) ───────────────────────────

function extractKeywords(text: string): string {
    return text
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .replace(/[^a-zA-Z0-9 ]/g, ' ')
        .toLowerCase()
        .split(/\s+/)
        .filter(w => w.length > 2)
        .join(' ');
}

// ── Tree-sitter Symbol Extraction ─────────────────────────────────────────────

interface RawSymbol {
    id: string;
    kind: GraphNode['kind'];
    name: string;
    file: string;
    startLine: number;
    endLine: number;
    body: string;
    keywords: string;
}

function extractTypeScript(filePath: string, source: string): RawSymbol[] {
    const parser = new Parser();
    parser.setLanguage(TypeScriptLang);
    const tree = parser.parse(source);
    const symbols: RawSymbol[] = [];

    function getBody(node: any): string {
        return source.slice(node.startIndex, node.endIndex);
    }

    function visit(node: any, className?: string) {
        const type = node.type as string;

        if (type === 'function_declaration' || type === 'function_expression' ||
            type === 'arrow_function') {
            const nameNode = node.childForFieldName?.('name');
            if (nameNode) {
                const name = nameNode.text as string;
                const startLine = node.startPosition.row + 1;
                const endLine = node.endPosition.row + 1;
                const body = getBody(node);
                symbols.push({
                    id: nodeId(filePath, name, startLine),
                    kind: 'function', name, file: filePath, startLine, endLine,
                    body, keywords: extractKeywords(name + ' ' + body.slice(0, 200))
                });
            }
        }

        if (type === 'method_definition' || type === 'method_signature' ||
            type === 'public_field_definition') {
            const nameNode = node.childForFieldName?.('name');
            if (nameNode) {
                const rawName = nameNode.text as string;
                const name = className ? `${className}.${rawName}` : rawName;
                const startLine = node.startPosition.row + 1;
                const endLine = node.endPosition.row + 1;
                const body = getBody(node);
                symbols.push({
                    id: nodeId(filePath, name, startLine),
                    kind: 'method', name, file: filePath, startLine, endLine,
                    body, keywords: extractKeywords(name + ' ' + rawName + ' ' + body.slice(0, 200))
                });
            }
        }

        if (type === 'class_declaration' || type === 'class') {
            const nameNode = node.childForFieldName?.('name');
            if (nameNode) {
                const name = nameNode.text as string;
                const startLine = node.startPosition.row + 1;
                const endLine = node.endPosition.row + 1;
                symbols.push({
                    id: nodeId(filePath, name, startLine),
                    kind: 'class', name, file: filePath, startLine, endLine,
                    body: `class ${name}`,
                    keywords: extractKeywords(name)
                });
                for (const child of node.children ?? []) visit(child, name);
                return;
            }
        }

        if (type === 'interface_declaration') {
            const nameNode = node.childForFieldName?.('name');
            if (nameNode) {
                const name = nameNode.text as string;
                const startLine = node.startPosition.row + 1;
                const endLine = node.endPosition.row + 1;
                symbols.push({
                    id: nodeId(filePath, name, startLine),
                    kind: 'interface', name, file: filePath, startLine, endLine,
                    body: `interface ${name}`,
                    keywords: extractKeywords(name)
                });
            }
        }

        if (type === 'enum_declaration') {
            const nameNode = node.childForFieldName?.('name');
            if (nameNode) {
                const name = nameNode.text as string;
                const startLine = node.startPosition.row + 1;
                const endLine = node.endPosition.row + 1;
                symbols.push({
                    id: nodeId(filePath, name, startLine),
                    kind: 'enum', name, file: filePath, startLine, endLine,
                    body: `enum ${name}`,
                    keywords: extractKeywords(name)
                });
            }
        }

        for (const child of node.children ?? []) visit(child, className);
    }

    visit(tree.rootNode);
    return symbols;
}

function extractPython(filePath: string, source: string): RawSymbol[] {
    if (!PythonLang) return [];
    const parser = new Parser();
    parser.setLanguage(PythonLang);
    const tree = parser.parse(source);
    const symbols: RawSymbol[] = [];

    function getBody(node: any): string {
        return source.slice(node.startIndex, node.endIndex);
    }

    function visit(node: any, className?: string) {
        const type = node.type as string;

        if (type === 'function_definition') {
            const nameNode = node.childForFieldName?.('name');
            if (nameNode) {
                const rawName = nameNode.text as string;
                const name = className ? `${className}.${rawName}` : rawName;
                const startLine = node.startPosition.row + 1;
                const endLine = node.endPosition.row + 1;
                const body = getBody(node);
                symbols.push({
                    id: nodeId(filePath, name, startLine),
                    kind: className ? 'method' : 'function',
                    name, file: filePath, startLine, endLine,
                    body, keywords: extractKeywords(name + ' ' + body.slice(0, 200))
                });
            }
        }

        if (type === 'class_definition') {
            const nameNode = node.childForFieldName?.('name');
            if (nameNode) {
                const name = nameNode.text as string;
                const startLine = node.startPosition.row + 1;
                const endLine = node.endPosition.row + 1;
                symbols.push({
                    id: nodeId(filePath, name, startLine),
                    kind: 'class', name, file: filePath, startLine, endLine,
                    body: `class ${name}`,
                    keywords: extractKeywords(name)
                });
                for (const child of node.children ?? []) visit(child, name);
                return;
            }
        }

        for (const child of node.children ?? []) visit(child, className);
    }

    visit(tree.rootNode);
    return symbols;
}

// ── CodeGraph class ───────────────────────────────────────────────────────────

export class CodeGraph {
    private db: any = null;
    private dbPath: string;
    private insertNode: any = null;
    private insertEdge: any = null;
    private ready = false;
    // Per-file debounce map — prevents saving file A from cancelling pending update for file B
    private saveDebounces = new Map<string, ReturnType<typeof setTimeout>>();

    constructor(private workspaceRoot: string) {
        const dir = path.join(workspaceRoot, '.ollamaforge');
        this.dbPath = path.join(dir, 'graph.db');
    }

    /** Initialize DB — call once at extension startup */
    init(): boolean {
        if (!tryLoadNativeModules()) return false;
        try {
            fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
            this.db = new Database(this.dbPath);
            this.db.pragma('journal_mode = WAL');
            this.db.pragma('synchronous = NORMAL');
            this._initSchema();
            this._prepareStatements();
            this.ready = true;
            logInfo('[CodeGraph] Initialized at ' + this.dbPath);
            return true;
        } catch (e) {
            logError('[CodeGraph] Init failed: ' + String(e));
            return false;
        }
    }

    isReady(): boolean { return this.ready; }

    private _initSchema() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS nodes (
                id TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                name TEXT NOT NULL,
                file TEXT NOT NULL,
                start_line INTEGER NOT NULL,
                end_line INTEGER NOT NULL,
                body TEXT,
                keywords TEXT,
                fingerprint TEXT,
                indexed_at INTEGER DEFAULT (strftime('%s','now'))
            );
            CREATE TABLE IF NOT EXISTS edges (
                src TEXT NOT NULL,
                dst TEXT NOT NULL,
                kind TEXT NOT NULL,
                PRIMARY KEY (src, dst, kind)
            );
            CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts
                USING fts5(name, keywords, file, content='nodes', content_rowid='rowid');
            CREATE TRIGGER IF NOT EXISTS nodes_fts_insert
                AFTER INSERT ON nodes BEGIN
                    INSERT INTO nodes_fts(rowid, name, keywords, file)
                    VALUES (new.rowid, new.name, new.keywords, new.file);
                END;
            CREATE TRIGGER IF NOT EXISTS nodes_fts_delete
                AFTER DELETE ON nodes BEGIN
                    INSERT INTO nodes_fts(nodes_fts, rowid, name, keywords, file)
                    VALUES ('delete', old.rowid, old.name, old.keywords, old.file);
                END;
            CREATE TABLE IF NOT EXISTS meta (
                key TEXT PRIMARY KEY,
                value TEXT
            );
        `);
    }

    private _prepareStatements() {
        // Use INSERT OR IGNORE + UPDATE pattern instead of REPLACE to avoid
        // triggering fts_delete + fts_insert on every re-index (which accumulates
        // duplicate FTS entries). We delete the old row explicitly first, which
        // fires fts_delete cleanly, then insert the new row.
        this.insertNode = this.db.prepare(`
            INSERT INTO nodes
                (id, kind, name, file, start_line, end_line, body, keywords, fingerprint)
            VALUES
                (@id, @kind, @name, @file, @startLine, @endLine, @body, @keywords, @fingerprint)
        `);
        this.insertEdge = this.db.prepare(`
            INSERT OR IGNORE INTO edges (src, dst, kind) VALUES (@src, @dst, @kind)
        `);
    }

    /** Index a single file. Returns number of symbols found. */
    indexFile(filePath: string): number {
        if (!this.ready) return 0;
        const ext = path.extname(filePath).toLowerCase();
        let symbols: RawSymbol[] = [];

        try {
            const source = fs.readFileSync(filePath, 'utf8');
            if (ext === '.ts' || ext === '.tsx' || ext === '.js' || ext === '.jsx') {
                symbols = extractTypeScript(filePath, source);
            } else if (ext === '.py') {
                symbols = extractPython(filePath, source);
            } else {
                return 0;
            }
        } catch (e) {
            logWarn(`[CodeGraph] Failed to parse ${filePath}: ${String(e)}`);
            return 0;
        }

        // Delete old data in a transaction: edges first (while node IDs still
        // exist for the subquery), then nodes. This is the correct order to
        // avoid orphaned edges from a subquery on already-deleted rows.
        const replaceFile = this.db.transaction((rows: RawSymbol[]) => {
            // Collect existing node IDs for this file before deletion
            const oldIds: string[] = this.db.prepare('SELECT id FROM nodes WHERE file = ?')
                .all(filePath)
                .map((r: any) => r.id);

            // Delete edges referencing old nodes
            if (oldIds.length > 0) {
                const placeholders = oldIds.map(() => '?').join(',');
                this.db.prepare(`DELETE FROM edges WHERE src IN (${placeholders}) OR dst IN (${placeholders})`)
                    .run([...oldIds, ...oldIds]);
            }

            // Delete old nodes (triggers fts_delete for each)
            this.db.prepare('DELETE FROM nodes WHERE file = ?').run(filePath);

            // Insert new nodes (triggers fts_insert for each)
            for (const r of rows) {
                const fingerprint = JSON.stringify(minhash(r.body || r.name));
                this.insertNode.run({ ...r, startLine: r.startLine, endLine: r.endLine, fingerprint });
            }
        });

        replaceFile(symbols);
        return symbols.length;
    }

    /** Index entire workspace. Returns total symbols indexed. */
    async indexWorkspace(): Promise<number> {
        if (!this.ready) return 0;

        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) return 0;

        const SKIP = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.ollamaforge', '__pycache__', '.venv', 'venv']);
        let totalSymbols = 0;
        let totalFiles = 0;

        for (const folder of folders) {
            const files = await vscode.workspace.findFiles(
                new vscode.RelativePattern(folder, '**/*.{ts,tsx,js,jsx,py}'),
                `{${[...SKIP].join(',')}}/**`,
                5000
            );

            for (const f of files) {
                const parts = f.fsPath.split(/[\\/]/);
                if (parts.some(p => SKIP.has(p))) continue;
                const count = this.indexFile(f.fsPath);
                totalSymbols += count;
                totalFiles++;
            }
        }

        this.db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('indexed_at', ?)`)
            .run(Date.now().toString());

        logInfo(`[CodeGraph] Indexed ${totalSymbols} symbols across ${totalFiles} files`);
        return totalSymbols;
    }

    /**
     * Schedule incremental re-index of a changed file (debounced 2s per file).
     * Uses a per-file debounce map so saving file A doesn't cancel pending
     * updates for file B.
     */
    scheduleFileUpdate(filePath: string) {
        if (!this.ready) return;
        const ext = path.extname(filePath).toLowerCase();
        if (!['.ts', '.tsx', '.js', '.jsx', '.py'].includes(ext)) return;

        const existing = this.saveDebounces.get(filePath);
        if (existing) clearTimeout(existing);

        const timer = setTimeout(() => {
            this.saveDebounces.delete(filePath);
            this.indexFile(filePath);
            logInfo(`[CodeGraph] Incremental update: ${path.basename(filePath)}`);
        }, 2000);
        this.saveDebounces.set(filePath, timer);
    }

    /**
     * Build scope context for injection into system prompt.
     * Query is the user's message. Budget is max tokens (default 1500 ≈ 6000 chars).
     * Returns null if graph is empty or no relevant symbols found.
     */
    buildScopeContext(query: string, budgetTokens = 1500): ScopeContext | null {
        if (!this.ready) return null;

        const budgetChars = budgetTokens * 4;

        // 1. Prepare FTS query — split camelCase, sanitize
        const ftsQuery = extractKeywords(query)
            .split(' ')
            .filter(w => w.length > 2)
            .slice(0, 8)
            .map(w => `"${w}"`)
            .join(' OR ');

        if (!ftsQuery) return null;

        let ftsResults: any[] = [];
        try {
            ftsResults = this.db.prepare(`
                SELECT n.id, n.kind, n.name, n.file, n.start_line, n.end_line
                FROM nodes_fts f
                JOIN nodes n ON n.rowid = f.rowid
                WHERE nodes_fts MATCH ?
                LIMIT 12
            `).all(ftsQuery);
        } catch {
            // FTS query syntax error — fall back to LIKE search
            const term = query.trim().split(/\s+/)[0].replace(/[%_]/g, '\\$&');
            ftsResults = this.db.prepare(`
                SELECT id, kind, name, file, start_line, end_line
                FROM nodes WHERE name LIKE ? ESCAPE '\\'
                LIMIT 12
            `).all(`%${term}%`);
        }

        // 2. Score candidates
        const queryWords = (query.match(/[a-zA-Z_][a-zA-Z0-9_]*/g) || []);
        const scored = ftsResults.map((r: any) => {
            let score = 1.0;
            for (const w of queryWords) {
                if (r.name === w) score += 0.8;
                else if (r.name.toLowerCase() === w.toLowerCase()) score += 0.5;
                else if (r.name.toLowerCase().includes(w.toLowerCase())) score += 0.2;
            }
            return { ...r, score };
        });

        // 3. One-hop neighbor expansion
        const seen = new Set<string>(scored.map((r: any) => r.id));
        const expanded = [...scored];
        for (const r of scored) {
            try {
                const neighbors = this.db.prepare(`
                    SELECT n.id, n.kind, n.name, n.file, n.start_line, n.end_line
                    FROM edges e
                    JOIN nodes n ON n.id = e.dst
                    WHERE e.src = ? AND e.kind IN ('calls','imports','contains')
                    LIMIT 5
                `).all(r.id);
                for (const n of neighbors) {
                    if (!seen.has(n.id)) {
                        seen.add(n.id);
                        expanded.push({ ...n, score: r.score * 0.35 });
                    }
                }
            } catch { /* ignore */ }
        }

        // 4. Sort by score, apply token budget
        // Track chars accurately — include the file header line in the budget.
        expanded.sort((a: any, b: any) => b.score - a.score);
        const selected: any[] = [];
        let chars = '## Code Graph Context\n'.length;
        const seenFiles = new Set<string>();

        for (const r of expanded) {
            const relFile = path.relative(this.workspaceRoot, r.file).replace(/\\/g, '/');
            const entry = `  ${r.kind} ${r.name} (line ${r.start_line}–${r.end_line})`;
            // Account for the file header line on first occurrence
            const fileHeaderCost = seenFiles.has(relFile) ? 0 : relFile.length + 5; // "**file:**\n"
            if (chars + fileHeaderCost + entry.length + 1 > budgetChars) break;
            if (!seenFiles.has(relFile)) seenFiles.add(relFile);
            selected.push({ ...r, relFile, entry });
            chars += fileHeaderCost + entry.length + 1;
        }

        if (selected.length === 0) return null;

        // 5. Group by file, format output
        const byFile = new Map<string, string[]>();
        for (const r of selected) {
            if (!byFile.has(r.relFile)) byFile.set(r.relFile, []);
            byFile.get(r.relFile)!.push(r.entry);
        }

        const lines: string[] = ['## Code Graph Context'];
        for (const [f, entries] of byFile) {
            lines.push(`**${f}:**`);
            lines.push(...entries);
        }

        const text = lines.join('\n');
        return {
            text,
            tokenEstimate: Math.ceil(text.length / 4),
            nodeCount: selected.length
        };
    }

    /**
     * Check for drift — compare stored fingerprints against current file content.
     * Deduplicates by file so a deleted file produces one GONE entry, not N.
     */
    checkDrift(maxNodes = 200): DriftReport {
        const report: DriftReport = { moved: [], ambiguous: [], gone: [] };
        if (!this.ready) return report;

        try {
            const nodes = this.db.prepare(`
                SELECT id, name, file, start_line, end_line, fingerprint, body
                FROM nodes
                ORDER BY indexed_at DESC
                LIMIT ?
            `).all(maxNodes);

            const fileCache = new Map<string, string | null>(); // null = file deleted
            const goneFiles = new Set<string>(); // deduplicate deleted-file reports

            for (const node of nodes) {
                if (!node.fingerprint) continue;

                // Read current file content (cached; null = deleted)
                if (!fileCache.has(node.file)) {
                    try {
                        fileCache.set(node.file, fs.readFileSync(node.file, 'utf8'));
                    } catch {
                        fileCache.set(node.file, null);
                    }
                }

                const source = fileCache.get(node.file);
                if (source == null) {
                    // File deleted — report once per file, not once per symbol
                    if (!goneFiles.has(node.file)) {
                        goneFiles.add(node.file);
                        report.gone.push({ name: node.name, file: node.file });
                    }
                    continue;
                }

                const lines = source.split('\n');
                const startIdx = Math.max(0, node.start_line - 1);
                const endIdx = Math.min(lines.length, node.end_line);
                const currentBody = lines.slice(startIdx, endIdx).join('\n');

                const storedFp: number[] = JSON.parse(node.fingerprint);
                const currentFp = minhash(currentBody);
                const similarity = jaccardFromMinhash(storedFp, currentFp);

                if (similarity >= 0.85) {
                    // Unchanged — no report needed
                } else if (similarity >= 0.55) {
                    report.ambiguous.push({ name: node.name, file: node.file });
                } else {
                    report.gone.push({ name: node.name, file: node.file });
                }
            }
        } catch (e) {
            logWarn('[CodeGraph] Drift check failed: ' + String(e));
        }

        return report;
    }

    /**
     * Cross-reference memory entries against the code graph.
     * Extracts symbol names mentioned in memory, looks them up in the graph,
     * and flags entries whose referenced symbol has changed significantly.
     *
     * @param memoryEntries - Array of { content: string } memory entries to check
     * @returns Conflicts where a memory entry references a changed/gone symbol
     */
    crossReferenceMemory(memoryEntries: Array<{ content: string }>): MemoryGraphConflict[] {
        if (!this.ready || memoryEntries.length === 0) return [];

        const conflicts: MemoryGraphConflict[] = [];
        const fileCache = new Map<string, string | null>();

        // Extract candidate identifier names from a memory entry
        // Match camelCase/PascalCase/snake_case names ≥4 chars (shorter = too noisy)
        const SYMBOL_RE = /\b([A-Z][a-zA-Z0-9]{3,}|[a-z][a-zA-Z0-9]{3,}[A-Z][a-zA-Z0-9]*|[a-z_]{4,}[a-z0-9])\b/g;

        for (const entry of memoryEntries) {
            const candidates = new Set<string>();
            let m: RegExpExecArray | null;
            SYMBOL_RE.lastIndex = 0;
            while ((m = SYMBOL_RE.exec(entry.content)) !== null) {
                candidates.add(m[1]);
            }

            for (const name of candidates) {
                let node: any;
                try {
                    node = this.db.prepare(`
                        SELECT id, name, file, start_line, end_line, fingerprint
                        FROM nodes WHERE name = ? OR name LIKE ?
                        LIMIT 1
                    `).get(name, `%.${name}`); // also match ClassName.methodName
                } catch { continue; }

                if (!node || !node.fingerprint) continue;

                // Read current file
                if (!fileCache.has(node.file)) {
                    try {
                        fileCache.set(node.file, fs.readFileSync(node.file, 'utf8'));
                    } catch {
                        fileCache.set(node.file, null);
                    }
                }

                const source = fileCache.get(node.file);
                if (source == null) {
                    conflicts.push({
                        symbolName: name,
                        memorySnippet: entry.content.slice(0, 80),
                        currentFile: node.file,
                        currentLine: node.start_line,
                        status: 'gone'
                    });
                    continue;
                }

                const lines = source.split('\n');
                const currentBody = lines
                    .slice(Math.max(0, node.start_line - 1), Math.min(lines.length, node.end_line))
                    .join('\n');

                const storedFp: number[] = JSON.parse(node.fingerprint);
                const currentFp = minhash(currentBody);
                const sim = jaccardFromMinhash(storedFp, currentFp);

                if (sim < 0.55) {
                    conflicts.push({
                        symbolName: name,
                        memorySnippet: entry.content.slice(0, 80),
                        currentFile: node.file,
                        currentLine: node.start_line,
                        status: sim < 0.1 ? 'gone' : 'changed'
                    });
                }
            }
        }

        // Deduplicate by symbolName (same symbol may appear in multiple memories)
        const seen = new Set<string>();
        return conflicts.filter(c => {
            if (seen.has(c.symbolName)) return false;
            seen.add(c.symbolName);
            return true;
        });
    }

    /** Format drift report for system prompt injection (≤200 tokens) */
    formatDriftReport(report: DriftReport): string | null {
        const total = report.moved.length + report.ambiguous.length + report.gone.length;
        if (total === 0) return null;

        const lines = ['## Code Graph Drift Warning'];

        if (total > 8) {
            lines.push(`⚠ ${total} symbols have changed since last graph index. Run \`graph_index\` to refresh.`);
            return lines.join('\n');
        }

        if (report.gone.length > 0) {
            lines.push(`**Gone (${report.gone.length}):** ${report.gone.map(n => n.name).join(', ')}`);
        }
        if (report.ambiguous.length > 0) {
            lines.push(`**Changed (${report.ambiguous.length}):** ${report.ambiguous.map(n => n.name).join(', ')}`);
        }
        if (report.moved.length > 0) {
            lines.push(`**Moved (${report.moved.length}):** ${report.moved.map(n => n.name).join(', ')}`);
        }
        lines.push('Run `graph_index` to refresh.');

        return lines.join('\n');
    }

    /** Format memory/graph conflicts for system prompt injection (≤150 tokens) */
    formatMemoryConflicts(conflicts: MemoryGraphConflict[]): string | null {
        if (conflicts.length === 0) return null;

        const lines = ['## Memory/Code Mismatch'];
        if (conflicts.length > 5) {
            lines.push(`⚠ ${conflicts.length} symbols referenced in memory have changed in code. Verify before using: ${conflicts.map(c => c.symbolName).join(', ')}.`);
        } else {
            for (const c of conflicts) {
                const relFile = path.relative(this.workspaceRoot, c.currentFile).replace(/\\/g, '/');
                lines.push(`- \`${c.symbolName}\` (${relFile}:${c.currentLine}) — ${c.status === 'gone' ? 'deleted or moved' : 'significantly changed'} since last memory write`);
            }
        }
        lines.push('Read the current file before relying on stored memory about these symbols.');
        return lines.join('\n');
    }

    /**
     * Return the top N nodes most relevant to a query, with file + line metadata.
     * Used by the adaptive context allocator to decide which files/ranges to pre-load.
     * Returns empty array if graph not ready or no matches.
     */
    getTopScoredNodes(query: string, limit = 6): Array<{ file: string; startLine: number; endLine: number; name: string; kind: string; score: number }> {
        if (!this.ready) return [];
        try {
            const ftsQuery = extractKeywords(query)
                .split(' ')
                .filter(w => w.length > 2)
                .slice(0, 8)
                .map(w => `"${w}"`)
                .join(' OR ');
            if (!ftsQuery) return [];

            let rows: any[] = [];
            try {
                rows = this.db.prepare(`
                    SELECT n.id, n.kind, n.name, n.file, n.start_line, n.end_line
                    FROM nodes_fts f
                    JOIN nodes n ON n.rowid = f.rowid
                    WHERE nodes_fts MATCH ?
                    LIMIT 20
                `).all(ftsQuery);
            } catch {
                const term = query.trim().split(/\s+/)[0].replace(/[%_]/g, '\\$&');
                rows = this.db.prepare(`
                    SELECT id, kind, name, file, start_line, end_line
                    FROM nodes WHERE name LIKE ? ESCAPE '\\' LIMIT 20
                `).all(`%${term}%`);
            }

            const queryWords = new Set(
                (query.match(/[a-zA-Z_][a-zA-Z0-9_]*/g) || []).map(w => w.toLowerCase()).filter(w => w.length > 2)
            );
            return rows
                .map(r => {
                    const nameLower = r.name.toLowerCase();
                    let score = 0.1;
                    for (const w of queryWords) {
                        if (nameLower === w) score += 3;
                        else if (nameLower.includes(w)) score += 1;
                    }
                    return { file: r.file, startLine: r.start_line, endLine: r.end_line, name: r.name, kind: r.kind, score };
                })
                .sort((a, b) => b.score - a.score)
                .slice(0, limit);
        } catch (e) {
            logWarn('[CodeGraph] getTopScoredNodes failed: ' + String(e));
            return [];
        }
    }

    /**
     * Return relevant symbol bodies from a specific file, scored against a query.
     * Used by read_file to return targeted function/class content instead of a
     * raw truncated slice when the file exceeds the line budget.
     *
     * @param filePath   Absolute path to the file
     * @param query      The user's current task message (for FTS scoring)
     * @param budgetTokens  Max tokens to return (default 800)
     * @returns Formatted string with numbered source lines, or null if graph not ready / no hits
     */
    getRelevantSymbolsForFile(filePath: string, query: string, budgetTokens = 800): string | null {
        if (!this.ready) return null;
        try {
            // Pull all symbols for this file from the graph (already indexed)
            const rows: any[] = this.db.prepare(`
                SELECT kind, name, start_line, end_line, body
                FROM nodes
                WHERE file = ?
                ORDER BY start_line ASC
            `).all(filePath);

            if (rows.length === 0) return null;

            // Score each symbol against the query using simple keyword overlap
            const queryWords = new Set(
                (query.match(/[a-zA-Z_][a-zA-Z0-9_]*/g) || [])
                    .map(w => w.toLowerCase())
                    .filter(w => w.length > 2)
            );

            const scored = rows.map(r => {
                const nameLower = r.name.toLowerCase();
                let score = 0;
                for (const w of queryWords) {
                    if (nameLower === w) score += 3;
                    else if (nameLower.includes(w)) score += 1;
                }
                // Always include at least a base score so all symbols are eligible
                return { ...r, score: score + 0.1 };
            });

            // Sort by score desc, then by line order for ties
            scored.sort((a, b) => b.score - a.score || a.start_line - b.start_line);

            // Read the file once to extract actual current source lines
            let fileLines: string[];
            try {
                fileLines = fs.readFileSync(filePath, 'utf8').split('\n');
            } catch {
                return null;
            }

            const budgetChars = budgetTokens * 4;
            const parts: string[] = [];
            let totalChars = 0;
            const usedRanges: Array<[number, number]> = [];

            for (const sym of scored) {
                const start = Math.max(0, sym.start_line - 1);
                const end   = Math.min(fileLines.length, sym.end_line);
                // Skip if overlaps an already-included range
                if (usedRanges.some(([s, e]) => start < e && end > s)) continue;

                const slice = fileLines.slice(start, end);
                const numbered = slice
                    .map((l, i) => `${String(start + i + 1).padStart(4, ' ')}\t${l}`)
                    .join('\n');
                if (totalChars + numbered.length > budgetChars) break;

                parts.push(`// ${sym.kind} ${sym.name} (lines ${sym.start_line}–${sym.end_line})\n${numbered}`);
                totalChars += numbered.length;
                usedRanges.push([start, end]);
            }

            if (parts.length === 0) return null;

            const rel = path.relative(this.workspaceRoot, filePath).replace(/\\/g, '/');
            return `[Graph-extracted symbols from ${rel} — ${parts.length} of ${rows.length} total, scored for current task]\n\n${parts.join('\n\n')}`;
        } catch (e) {
            logWarn('[CodeGraph] getRelevantSymbolsForFile failed: ' + String(e));
            return null;
        }
    }

    /** Get graph stats for display */
    getStats(): { nodes: number; files: number; indexedAt: number | null } {
        if (!this.ready) return { nodes: 0, files: 0, indexedAt: null };
        try {
            const nodes = (this.db.prepare('SELECT COUNT(*) as cnt FROM nodes').get() as any).cnt;
            const files = (this.db.prepare('SELECT COUNT(DISTINCT file) as cnt FROM nodes').get() as any).cnt;
            const meta = this.db.prepare("SELECT value FROM meta WHERE key = 'indexed_at'").get() as any;
            const indexedAt = meta ? parseInt(meta.value) : null;
            return { nodes, files, indexedAt };
        } catch {
            return { nodes: 0, files: 0, indexedAt: null };
        }
    }

    close() {
        // Cancel all pending debounced updates
        for (const timer of this.saveDebounces.values()) clearTimeout(timer);
        this.saveDebounces.clear();
        if (this.db) {
            try { this.db.close(); } catch { /* ignore */ }
            this.db = null;
            this.ready = false;
        }
    }
}

// ── Git integration ───────────────────────────────────────────────────────────

const GITIGNORE_ENTRY = '.ollamaforge/';
const GITIGNORE_COMMENT = '# Ollama Forge runtime data (graphs, cache, memory) — machine-local, not for git';

/**
 * Ensure `.ollamaforge/` is listed in the workspace `.gitignore`.
 * Creates the file if it doesn't exist. No-ops if the entry is already present.
 * Silent — never throws, never prompts the user.
 */
export function ensureGitignore(workspaceRoot: string): void {
    const gitignorePath = path.join(workspaceRoot, '.gitignore');
    try {
        let content = '';
        if (fs.existsSync(gitignorePath)) {
            content = fs.readFileSync(gitignorePath, 'utf8');
            if (content.split('\n').some(l => l.trim() === GITIGNORE_ENTRY || l.trim() === GITIGNORE_ENTRY.replace(/\/$/, ''))) {
                return;
            }
        }
        const addition = `\n${GITIGNORE_COMMENT}\n${GITIGNORE_ENTRY}\n`;
        fs.writeFileSync(gitignorePath, content + addition, 'utf8');
        logInfo(`[CodeGraph] Added ${GITIGNORE_ENTRY} to ${gitignorePath}`);
    } catch (e) {
        logWarn(`[CodeGraph] Could not update .gitignore at ${gitignorePath}: ${String(e)}`);
    }
}

// ── ROUTER.md loader ──────────────────────────────────────────────────────────

const ROUTER_MAX_CHARS = 1200; // ≈300 tokens

export function loadRouterMd(workspaceRoot: string): string | null {
    const routerPath = path.join(workspaceRoot, 'ROUTER.md');
    if (!fs.existsSync(routerPath)) return null;
    try {
        let content = fs.readFileSync(routerPath, 'utf8').trim();
        if (content.length > ROUTER_MAX_CHARS) {
            content = content.slice(0, ROUTER_MAX_CHARS) + '\n... (truncated — keep ROUTER.md under 300 tokens)';
        }
        return content;
    } catch {
        return null;
    }
}

/**
 * Returns true when ROUTER.md should be regenerated.
 * Condition: the graph was indexed more than 1 hour after ROUTER.md was last written,
 * meaning a significant indexing pass happened since the router was generated.
 * Uses the graph's meta.indexed_at value if a CodeGraph instance is provided.
 */
export function isRouterMdStale(workspaceRoot: string, graph?: CodeGraph): boolean {
    const routerPath = path.join(workspaceRoot, 'ROUTER.md');
    if (!fs.existsSync(routerPath)) return false; // doesn't exist → let caller generate fresh

    try {
        const routerMtime = fs.statSync(routerPath).mtimeMs;
        if (!graph) return false;
        const stats = graph.getStats();
        if (!stats.indexedAt) return false;
        const indexedAtMs = stats.indexedAt; // stored as ms since epoch
        // Stale if graph was indexed more than 1 hour after ROUTER.md was written
        return (indexedAtMs - routerMtime) > 60 * 60 * 1000;
    } catch {
        return false;
    }
}

/** Auto-generate a basic ROUTER.md from workspace structure */
export async function generateRouterMd(workspaceRoot: string): Promise<string> {
    const pkgPath = path.join(workspaceRoot, 'package.json');
    let stack = 'Unknown';
    let description = '';

    try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const deps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
        const hasTsOrJs = deps.includes('typescript') || fs.existsSync(path.join(workspaceRoot, 'tsconfig.json'));
        const hasVscode = deps.includes('@types/vscode');
        const hasReact = deps.some((d: string) => d.includes('react'));
        const hasPy = fs.existsSync(path.join(workspaceRoot, 'setup.py')) || fs.existsSync(path.join(workspaceRoot, 'pyproject.toml'));

        if (hasVscode) stack = 'TypeScript, VSCode Extension API';
        else if (hasReact) stack = 'TypeScript/JavaScript, React';
        else if (hasTsOrJs) stack = 'TypeScript/JavaScript, Node.js';
        else if (hasPy) stack = 'Python';

        description = pkg.description ?? '';
    } catch { /* ignore */ }

    const entryPoints: string[] = [];
    for (const f of ['src/main.ts', 'src/index.ts', 'index.ts', 'main.ts', 'src/main.py', 'main.py']) {
        if (fs.existsSync(path.join(workspaceRoot, f))) entryPoints.push(f);
    }

    const lines = [
        '# Project Router',
        `**Stack:** ${stack}`,
    ];
    if (description) lines.push(`**Description:** ${description}`);
    if (entryPoints.length > 0) lines.push(`**Entry points:** ${entryPoints.join(', ')}`);
    lines.push('**Key invariants:**');
    lines.push('- (Add project-specific invariants here)');

    const content = lines.join('\n');
    try {
        fs.writeFileSync(path.join(workspaceRoot, 'ROUTER.md'), content, 'utf8');
        logInfo('[CodeGraph] Generated ROUTER.md at ' + workspaceRoot);
    } catch { /* ignore */ }
    return content;
}
