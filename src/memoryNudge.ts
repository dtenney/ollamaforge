// src/memoryNudge.ts
// Memory nudge, orientation anchor, and auto-extraction — extracted from src/agent.ts.
// Faithful extraction: patterns, logic, and filtering match the original Agent class methods.

import * as path from 'path';
import * as fs from 'fs';
import { logInfo, logWarn, toErrorMessage } from './logger';
import { TieredMemoryManager } from './memoryCore';
import { GARBAGE_PATTERNS } from './docScanner';
import type { ActiveTaskState } from './chatStorage';

// ── Static regex patterns (moved from Agent class) ──────────────────────────

/** Phrases that indicate the user is stating a project fact (not just mentioning something) */
export const INTENT_PATTERNS: RegExp[] = [
    /\b(?:we|i|our project|this project|the project)\s+(?:use|uses|using|run|runs|running|deploy|deploys|host|hosts)\s+/i,
    /\b(?:built with|written in|powered by|running on|deployed (?:on|to|at|via)|hosted (?:on|at))\s+/i,
    /\b(?:the|our)\s+(?:server|database|db|api|app|service|backend|frontend)\s+(?:is|runs|lives)\s+(?:at|on)\s+/i,
    /\b(?:remember|save|note|store)\s*(?:that|:)?\s+/i,
    /\b(?:always|never|convention|standard|rule)\s*(?::|--)?\s+/i,
];

/** Negative context -- if these surround a keyword, skip it */
export const NEGATIVE_CONTEXT: RegExp[] = [
    /\b(?:don'?t|doesn'?t|not|never|no longer|instead of|unlike|without|avoid|removed|dropped|migrated (?:away|from))\s+/i,
    /\b(?:compared to|versus|vs\.?|alternative to|rather than)\s+/i,
];

/** IP pattern that excludes version-like strings (X.Y.Z where all < 100) */
export const IP_WITH_CONTEXT = /\b(?:(?:server|host|address|ip|connect(?:ion)?|running|deployed|at|on)\s+(?:is\s+)?)?(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d?)\.)(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){2}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)(?::\d{2,5})?\b/gi;

/** URL pattern that requires infrastructure context */
export const URL_WITH_CONTEXT = /\b(?:(?:server|api|endpoint|service|deployed|hosted|running|available|connect)\s+(?:at|on|is)\s+)?https?:\/\/[^\s"'<>)\]]+/gi;

/** Port pattern that requires explicit "on port" / "port:" context */
export const PORT_WITH_CONTEXT = /\b(?:(?:on|listening|running|connect)\s+)?port\s+(\d{2,5})\b/gi;

/** Serial/device port pattern: /dev/ttyUSB0, /dev/ttyACM1, /dev/serial0, COM3, etc. */
export const SERIAL_PORT_WITH_CONTEXT = /(?:(?:serial|uart|device|port|connect(?:ed)?(?:\s+(?:to|via))?|flash(?:ing)?|upload(?:ing)?)\s+(?:(?:is|at|on|via|to|over)\s+)?)?(?:\/dev\/(?:tty(?:USB|ACM|S|AMA|serial)\d*|serial\d*|rfcomm\d*)|COM\d+)\b/gi;

/** Baud rate pattern: "baud rate 115200", "at 9600 baud", "baudrate=115200" */
export const BAUD_RATE_WITH_CONTEXT = /\b(?:baud(?:\s*rate)?|speed)\s*(?:is\s*|[:=]\s*)?(\d{2,7})\b|\b(\d{2,7})\s+baud\b/gi;

/** Known technology names (used only with intent context) */
export const KNOWN_TECHNOLOGIES = new Set([
    'react', 'vue', 'angular', 'svelte', 'next.js', 'nuxt', 'express', 'fastify', 'koa', 'hapi',
    'django', 'flask', 'fastapi', 'rails', 'spring', 'laravel', 'symfony', 'gin', 'echo', 'fiber',
    'typescript', 'javascript', 'python', 'rust', 'golang', 'java', 'kotlin', 'swift', 'ruby', 'php',
    'node.js', 'nodejs', 'deno', 'bun',
    'postgresql', 'postgres', 'mysql', 'mariadb', 'mongodb', 'redis', 'sqlite', 'dynamodb', 'cassandra',
    'docker', 'kubernetes', 'k8s', 'terraform', 'ansible', 'nginx', 'apache', 'caddy', 'traefik',
    'webpack', 'vite', 'esbuild', 'rollup', 'parcel', 'turbopack',
    'jest', 'mocha', 'pytest', 'vitest', 'cypress', 'playwright',
    'eslint', 'prettier', 'ruff', 'black', 'flake8', 'pylint', 'mypy',
    'prisma', 'sequelize', 'typeorm', 'drizzle', 'sqlalchemy', 'alembic',
    'graphql', 'grpc', 'rest', 'websocket',
    'tailwind', 'bootstrap', 'material-ui', 'chakra',
    'celery', 'rabbitmq', 'kafka', 'nats',
    'sentry', 'datadog', 'grafana', 'prometheus',
    'gunicorn', 'uvicorn', 'pm2', 'supervisor',
]);

/** Cap on memory writes per response to prevent flooding */
export const MAX_MEMORY_WRITES_PER_RESPONSE = 3;

// ── autoExtractFacts ────────────────────────────────────────────────────────

/**
 * Scan ONLY the user message for extractable facts.
 * Requires intent context ("we use X", "server is at X") -- bare keyword mentions are ignored.
 * Skips negative context ("we don't use X", "instead of X").
 *
 * Faithful extraction of Agent.autoExtractFacts (agent.ts lines 14173–14313).
 */
export async function autoExtractFacts(
    memory: TieredMemoryManager | null,
    workspaceRoot: string,
    userMessage: string,
    _assistantResponse: string,
): Promise<void> {
    if (!memory) { return; }

    // Only extract from user message -- assistant responses are too noisy
    const text = userMessage;
    if (text.length < 10) { return; } // Too short to contain meaningful facts

    // Quick pre-check: skip if no extractable patterns exist at all
    const hasAnyPattern = INTENT_PATTERNS.some(p => p.test(text))
        || IP_WITH_CONTEXT.test(text)
        || URL_WITH_CONTEXT.test(text)
        || PORT_WITH_CONTEXT.test(text)
        || SERIAL_PORT_WITH_CONTEXT.test(text)
        || BAUD_RATE_WITH_CONTEXT.test(text);
    // Reset lastIndex after test() calls on global regexes
    IP_WITH_CONTEXT.lastIndex = 0;
    URL_WITH_CONTEXT.lastIndex = 0;
    PORT_WITH_CONTEXT.lastIndex = 0;
    SERIAL_PORT_WITH_CONTEXT.lastIndex = 0;
    BAUD_RATE_WITH_CONTEXT.lastIndex = 0;
    if (!hasAnyPattern) { return; }

    const existingContext = memory.buildContext([0, 1, 2, 3, 4], 8000).toLowerCase();
    const saves: Array<{ tier: 0|1|2|3|4|5; content: string; tags: string[] }> = [];

    // Check if user message has any intent signals at all
    const hasIntent = INTENT_PATTERNS.some(p => p.test(text));
    // Check for negative context
    const hasNegative = (surrounding: string) =>
        NEGATIVE_CONTEXT.some(p => p.test(surrounding));

    // ── Extract IPs with context ─────────────────────────────────────────────
    IP_WITH_CONTEXT.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = IP_WITH_CONTEXT.exec(text)) !== null) {
        // Extract just the IP portion
        const ipMatch = match[0].match(/(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d?)\.)(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){2}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)(?::\d{2,5})?/);
        if (!ipMatch) { continue; }
        const ip = ipMatch[0];
        // Skip loopback, link-local, and version-like patterns
        if (ip.startsWith('127.') || ip.startsWith('0.') || ip.startsWith('169.254.')) { continue; }
        // Skip if it looks like a version number (all octets < 20)
        const octets = ip.split('.').map(Number);
        if (octets.every(o => o < 20)) { continue; }
        if (existingContext.includes(ip)) { continue; }
        // Check surrounding text for negative context
        const start = Math.max(0, match.index - 30);
        const surrounding = text.slice(start, match.index + match[0].length + 10);
        if (hasNegative(surrounding)) { continue; }
        saves.push({ tier: 0, content: `IP: ${ip}`, tags: ['ip', 'infrastructure'] });
    }

    // ── Extract URLs with context ────────────────────────────────────────────
    URL_WITH_CONTEXT.lastIndex = 0;
    while ((match = URL_WITH_CONTEXT.exec(text)) !== null) {
        const url = match[0].replace(/^.*?(https?:)/, '$1'); // Strip leading context words
        if (url.length < 10 || url.length > 200) { continue; }
        // Skip Ollama default, localhost dev servers, github/docs links
        if (/localhost:11434/.test(url)) { continue; }
        if (/github\.com|stackoverflow\.com|docs\.|npmjs\.com|pypi\.org/.test(url)) { continue; }
        if (existingContext.includes(url.toLowerCase())) { continue; }
        const start = Math.max(0, match.index - 30);
        const surrounding = text.slice(start, match.index + match[0].length + 10);
        if (hasNegative(surrounding)) { continue; }
        saves.push({ tier: 0, content: `URL: ${url}`, tags: ['url', 'infrastructure'] });
    }

    // ── Extract ports with context ───────────────────────────────────────────
    PORT_WITH_CONTEXT.lastIndex = 0;
    while ((match = PORT_WITH_CONTEXT.exec(text)) !== null) {
        const port = match[1];
        if (!port || existingContext.includes(`port ${port}`) || existingContext.includes(`:${port}`)) { continue; }
        const start = Math.max(0, match.index - 30);
        const surrounding = text.slice(start, match.index + match[0].length + 10);
        if (hasNegative(surrounding)) { continue; }
        saves.push({ tier: 0, content: `Port: ${port}`, tags: ['port', 'infrastructure'] });
    }

    // ── Extract SSH user@host credentials ────────────────────────────────────
    // Matches: ssh user@ip, scp user@ip, ssh -i key user@ip, user@ip:/path
    const sshPattern = /\b(?:ssh|scp|sftp)\b[^@\n]{0,40}?\b([a-z][a-z0-9_-]{0,30})@((?:\d{1,3}\.){3}\d{1,3})\b/gi;
    let sshMatch: RegExpExecArray | null;
    while ((sshMatch = sshPattern.exec(text)) !== null) {
        const user = sshMatch[1];
        const ip = sshMatch[2];
        // Skip generic/placeholder names
        if (/^(root|admin|user|test|localhost|example)$/.test(user)) { continue; }
        const sshFact = `SSH: ${user}@${ip}`;
        if (existingContext.includes(`${user}@${ip}`)) { continue; }
        saves.push({ tier: 0, content: sshFact, tags: ['ssh', 'infrastructure', 'credentials'] });
        // Also write to context.md if it doesn't already have this host
        try {
            const contextPath = path.join(workspaceRoot, '.ollamaforge', 'context.md');
            const existing = fs.existsSync(contextPath) ? fs.readFileSync(contextPath, 'utf8') : '';
            if (!existing.includes(`${user}@${ip}`)) {
                const hostLine = `\n- \`${ip}\` -- SSH: \`ssh ${user}@${ip}\` (auto-detected from conversation)`;
                const updated = existing.includes('## Known remote hosts')
                    ? existing.replace(/## Known remote hosts\n/, `## Known remote hosts\n${hostLine}`)
                    : existing.trimEnd() + `\n\n## Known remote hosts\n${hostLine}\n`;
                fs.writeFileSync(contextPath, updated, 'utf8');
                logInfo(`[auto-memory] Wrote SSH host to context.md: ${user}@${ip}`);
            }
        } catch { /* non-critical */ }
    }

    // ── Extract serial/device ports ──────────────────────────────────────────
    SERIAL_PORT_WITH_CONTEXT.lastIndex = 0;
    while ((match = SERIAL_PORT_WITH_CONTEXT.exec(text)) !== null) {
        // Extract just the device path (COM3 or /dev/ttyXXX)
        const devMatch = match[0].match(/(?:\/dev\/(?:tty(?:USB|ACM|S|AMA|serial)\d*|serial\d*|rfcomm\d*)|COM\d+)/i);
        if (!devMatch) { continue; }
        const devPath = devMatch[0];
        if (existingContext.includes(devPath.toLowerCase())) { continue; }
        const surrounding = text.slice(Math.max(0, match.index - 40), match.index + match[0].length + 40);
        if (hasNegative(surrounding)) { continue; }
        saves.push({ tier: 0, content: `Serial port: ${devPath}`, tags: ['serial', 'device', 'infrastructure'] });
    }

    // ── Extract baud rates ───────────────────────────────────────────────────
    BAUD_RATE_WITH_CONTEXT.lastIndex = 0;
    while ((match = BAUD_RATE_WITH_CONTEXT.exec(text)) !== null) {
        const baud = match[1] ?? match[2];
        if (!baud) { continue; }
        // Only save common baud rates (avoid false positives like "115200 files")
        const VALID_BAUDS = new Set(['300','1200','2400','4800','9600','14400','19200','38400','57600','115200','230400','460800','921600']);
        if (!VALID_BAUDS.has(baud)) { continue; }
        if (existingContext.includes(`baud`) && existingContext.includes(baud)) { continue; }
        const surrounding = text.slice(Math.max(0, match.index - 40), match.index + match[0].length + 40);
        if (hasNegative(surrounding)) { continue; }
        saves.push({ tier: 0, content: `Baud rate: ${baud}`, tags: ['baud', 'serial', 'device', 'infrastructure'] });
    }

    // ── Extract technology keywords (only with intent context) ───────────────
    if (hasIntent) {
        const wordsInMsg = text.toLowerCase().split(/[\s,;:()\[\]{}"'`]+/);
        for (const word of wordsInMsg) {
            if (!KNOWN_TECHNOLOGIES.has(word)) { continue; }
            if (existingContext.includes(word)) { continue; }
            const wordIdx = text.toLowerCase().indexOf(word);
            if (wordIdx === -1) { continue; }
            const surroundStart = Math.max(0, wordIdx - 40);
            const surrounding = text.slice(surroundStart, wordIdx + word.length + 20);
            if (hasNegative(surrounding)) { continue; }
            if (!saves.some(s => s.content.toLowerCase().includes(word))) {
                saves.push({ tier: 1, content: `Technology: ${word}`, tags: ['technology'] });
            }
        }
    }

    // Cap at MAX_MEMORY_WRITES_PER_RESPONSE and filter through garbage patterns + semantic dedup
    const toSave = saves
        .filter(s => !GARBAGE_PATTERNS.some(p => p.test(s.content)))
        .slice(0, MAX_MEMORY_WRITES_PER_RESPONSE);
    for (const entry of toSave) {
        try {
            // Semantic dedup check before saving
            const isDupe = await memory.isSemanticDuplicate(entry.content, 0.80);
            if (isDupe) {
                logInfo(`[auto-memory] Semantic-deduped: ${entry.content.slice(0, 80)}`);
                continue;
            }
            await memory.addEntry(entry.tier, entry.content, entry.tags);
            logInfo(`[auto-memory] Saved to Tier ${entry.tier}: ${entry.content.slice(0, 80)}`);
        } catch (err) {
            logWarn(`[auto-memory] Failed to save: ${toErrorMessage(err)}`);
        }
    }
}

// ── buildMemoryNudge ────────────────────────────────────────────────────────

/**
 * Build a memory nudge message to inject periodically.
 * Returns the nudge string, or empty string if not due yet.
 *
 * Faithful extraction of Agent.buildMemoryNudge (agent.ts line 14673).
 */
export function buildMemoryNudge(userTurnCount: number, interval: number): string {
    if (userTurnCount % interval !== 0) { return ''; }
    if (userTurnCount === 0) { return ''; }
    return '\n\n[SYSTEM REMINDER: Review this conversation for any new facts worth saving to memory — including: IPs, URLs, ports, SSH credentials, serial ports (/dev/ttyUSB0 etc.), baud rates, device names/configs, tool paths (e.g. ~/.local/bin/esphome), firmware locations, conventions, or decisions. If you found anything new, call memory_tier_write now (tier 0 for device/infra facts, tier 1 for tools/processes, tier 3 for conventions). Do not mention this reminder to the user.]';
}

// ── buildOrientationAnchor ──────────────────────────────────────────────────

/**
 * Build a brief orientation anchor to inject periodically during long tool-call runs.
 *
 * Faithful extraction of Agent.buildOrientationAnchor (agent.ts line 14684).
 */
export function buildOrientationAnchor(
    _lastToolName: string,
    toolCallsCount: number,
    filesChanged: string[],
    activeTask: ActiveTaskState | null,
    trustLevel: string,
): string {
    // Only inject periodically to avoid bloating context
    if (toolCallsCount < 3 || toolCallsCount % 3 !== 0) { return ''; }

    const parts: string[] = [];

    // What was just done
    if (filesChanged.length > 0) {
        const recent = filesChanged.slice(-3);
        parts.push(`Files edited this run: ${recent.join(', ')}`);
    }

    // Active task orientation
    if (activeTask) {
        if (activeTask.stepsCompleted.length > 0) {
            parts.push(`Done: ${activeTask.stepsCompleted.slice(-3).join(', ')}`);
        }
        if (activeTask.stepsPending.length > 0) {
            const next = activeTask.stepsPending[0];
            parts.push(`NEXT: ${next}`);
        }
    }

    // If no structured steps, nudge the model to check the plan file or work tracker
    if (parts.length === 0 && trustLevel !== 'normal') {
        return '\n\n[ORIENTATION] You have made ' + toolCallsCount + ' tool calls. Do NOT summarize progress. Act on the NEXT item immediately. If unsure what is next, read the work tracker or plan file.';
    }

    if (parts.length === 0) { return ''; }

    return '\n\n[ORIENTATION] ' + parts.join(' | ') + (trustLevel !== 'normal' ? ' -- act on the NEXT item now, do not summarize.' : '');
}

// ── autoLearnCorrection ─────────────────────────────────────────────────────

/** Post function type (avoids circular import from agent.ts) */
export type PostFn = (msg: object) => void;

/**
 * Detect a user correction/preference and auto-save it as a Tier 3 convention.
 * Faithful extraction of Agent.autoLearnCorrection (agent.ts line 13669).
 */
export async function autoLearnCorrection(
    userMessage: string,
    memory: TieredMemoryManager,
    postFn: PostFn,
    dedupSet: Set<string>,
): Promise<void> {
    const msg = userMessage.trim();
    if (msg.length > 400) { return; }

    const lower = msg.toLowerCase();

    const prohibitionMatch = lower.match(
        /^(?:please\s+)?(?:don'?t|do not|stop|never|avoid|no more|quit|cease)\s+(.{8,120})$/
    );

    const preferenceMatch = lower.match(
        /^(?:please\s+)?use\s+(.{4,60}?)(?:\s+(?:not|instead of|rather than)\s+(.{4,60}))?(?:\s*,\s*.+)?$/
    );

    const softCorrectionMatch = lower.match(
        /^(?:no[,.]?\s+|actually[,.]?\s+|wait[,.]?\s+)(?:please\s+)?(.{8,120})$/
    );

    let ruleText: string | null = null;

    if (prohibitionMatch) {
        const body = prohibitionMatch[1].replace(/^avoid\s+/, '').trimEnd().replace(/\.$/, '');
        ruleText = `Convention: avoid ${body}`;
    } else if (preferenceMatch) {
        const prefer = preferenceMatch[1].trimEnd();
        const avoid = preferenceMatch[2]?.trimEnd();
        ruleText = avoid
            ? `Convention: use ${prefer} instead of ${avoid}`
            : `Convention: prefer ${prefer}`;
    } else if (softCorrectionMatch) {
        ruleText = `Convention: ${softCorrectionMatch[1].trimEnd().replace(/\.$/, '')}`;
    }

    if (!ruleText) { return; }

    const ruleKey = ruleText.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
    if (dedupSet.has(ruleKey)) { return; }

    try {
        const isDupe = await memory.isSemanticDuplicate(ruleText, 0.82);
        if (isDupe) {
            logInfo(`[auto-learn] Rule already in memory (semantic dupe): "${ruleText.slice(0, 60)}"`);
            return;
        }
    } catch { /* Qdrant unavailable — write anyway */ }

    try {
        await memory.addEntry(3, ruleText, ['auto-learned', 'convention']);
        dedupSet.add(ruleKey);
        logInfo(`[auto-learn] Learned Tier 3 convention: "${ruleText.slice(0, 80)}"`);
        postFn({ type: 'info', text: `📌 Learned: ${ruleText}` });
    } catch (err) {
        logWarn(`[auto-learn] Failed to write convention: ${toErrorMessage(err)}`);
    }
}

// ── preProcessPathUpdate ────────────────────────────────────────────────────

/** Minimal stop-ref shape (avoids importing the full Agent type) */
export interface StopRef { stop: boolean; destroy?: () => void }

/** Tool executor signature (avoids circular import from agent.ts) */
export type ExecuteToolFn = (tool: string, args: Record<string, unknown>, toolId?: string) => Promise<string>;

/**
 * Detect Python files that were moved into subdirectories and fix their
 * relative imports. Faithful extraction of Agent.preProcessPathUpdate
 * (agent.ts line 14329).
 */
export async function preProcessPathUpdate(
    userMessage: string,
    workspaceRoot: string,
    stopRef: StopRef,
    post: PostFn,
    executeTool: ExecuteToolFn,
): Promise<string> {
    // Strip injected context blocks (active-file, smart-context, mention, git-diff, symbol-mentions,
    // selection, pins, etc.) so the keyword test only sees the user-typed text.
    // Without this, any message in a Python workspace fires hasPathKeyword=true because the
    // injected active-file context contains "from X import Y" and file paths.
    const userTypedText = userMessage.replace(/<(active-file|smart-context|mention|git-diff|symbol-mentions|selection|pinned-files)[^>]*>[\s\S]*?<\/\1>/g, '').trim();
    const msg = userTypedText.toLowerCase();
    // Must specifically be about import paths / file locations -- not general code edits
    const hasPathKeyword = /\b(import path|import location|module path|reorganiz|moved|new folder|new director)\b/i.test(msg)
        || (/\b(path|import|reference)\b/i.test(msg)
            && /\b(update|fix|point|adjust|rewrite)\b/i.test(msg)
            && /(\.(py|ts|js|tsx|jsx|md)\b|from\s+[\w./]+\s+import\b|import\s+[\w./]+|[/\\][\w./]+\.(py|ts|js|tsx|jsx|md))/.test(msg));
    logInfo(`[pre-process] hasPathKeyword=${hasPathKeyword} userTyped="${userTypedText.slice(0, 80)}"`);
    if (!hasPathKeyword) { return ''; }

    const root = workspaceRoot;
    if (!root) { return ''; }

    logInfo('[pre-process] Path-update intent detected -- running programmatic edit pipeline');

    // Step 1: Find and read the recommendations doc
    const DOC_CANDIDATES = [
        'docs/ORGANIZATION_RECOMMENDATIONS.md',
        'docs/RECOMMENDATIONS.md',
        'docs/REORGANIZATION.md',
        'ORGANIZATION_RECOMMENDATIONS.md',
        'RECOMMENDATIONS.md',
    ];
    const docPathMatch = userMessage.match(/\b([\w./\\-]+\.md)\b/i);
    if (docPathMatch) {
        DOC_CANDIDATES.unshift(docPathMatch[1].replace(/\\/g, '/'));
    }

    let docContent = '';
    let docPath = '';
    for (const candidate of DOC_CANDIDATES) {
        try {
            const full = path.resolve(root, candidate);
            if (fs.existsSync(full)) {
                docContent = fs.readFileSync(full, 'utf8');
                docPath = candidate;
                break;
            }
        } catch { /* skip */ }
    }

    if (!docContent) {
        logInfo('[pre-process] No recommendations doc found, skipping pipeline');
        return '';
    }

    const docToolId = `t_${Date.now()}_pre1`;
    post({ type: 'toolCall', id: docToolId, name: 'shell_read', args: { command: `cat "${docPath}"` } });
    post({ type: 'toolResult', id: docToolId, name: 'shell_read', success: true, preview: `Read ${docPath} (${docContent.split('\n').length} lines)` });

    // Step 2: Build a map of old_import -> new_import by scanning the actual filesystem.
    //
    // A mapping is ONLY generated when ALL three conditions hold:
    //   a) The file exists at the NEW path (subdir/module.py) -- the move already happened
    //   b) The OLD import path (parent.module) does NOT resolve to any file on disk --
    //      i.e., parent/module.py does not exist at the top-level anymore
    //   c) At least one source file in the project contains "from <old_import>" --
    //      i.e., there are actually stale imports to fix
    //
    // This prevents generating bogus double-nested paths like app.routes.admin.admin.X
    // when the file is already at app/routes/admin/X.py (old path still works as-is).
    const moduleMap = new Map<string, string>();

    // Extract parent directories mentioned in the doc (e.g., "routes/", "models/", "services/")
    const parentDirs = new Set<string>();
    const parentDirRegex = /\b((?:app[\/\\])?(?:routes|models|services|templates))[\/\\]/g;
    let m: RegExpExecArray | null;
    while ((m = parentDirRegex.exec(docContent)) !== null) {
        let dir = m[1].replace(/\\/g, '/');
        if (!dir.startsWith('app/')) { dir = 'app/' + dir; }
        parentDirs.add(dir);
    }
    if (parentDirs.size === 0) {
        for (const d of ['app/routes', 'app/models', 'app/services']) {
            if (fs.existsSync(path.resolve(root, d))) { parentDirs.add(d); }
        }
    }

    logInfo(`[pre-process] Scanning parent directories: ${[...parentDirs].join(', ')}`);

    for (const parentDir of parentDirs) {
        const parentFull = path.resolve(root, parentDir);
        if (!fs.existsSync(parentFull)) { continue; }
        try {
            const entries = fs.readdirSync(parentFull, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === '__pycache__') { continue; }
                const subDirFull = path.resolve(parentFull, entry.name);
                try {
                    const subFiles = fs.readdirSync(subDirFull).filter((f: string) => f.endsWith('.py') && f !== '__init__.py');
                    for (const pyFile of subFiles) {
                        const moduleName = pyFile.replace(/\.py$/, '');
                        const parentDotted = parentDir.replace(/\//g, '.');
                        const oldImport = `${parentDotted}.${moduleName}`;
                        const newImport = `${parentDotted}.${entry.name}.${moduleName}`;

                        // Condition (a): new file exists on disk
                        const newFilePath = path.resolve(root, parentDir, entry.name, pyFile);
                        if (!fs.existsSync(newFilePath)) { continue; }

                        // Condition (b): old file does NOT exist at parent level anymore
                        // (if it still exists there, the old import still works -- nothing to fix)
                        const oldFilePath = path.resolve(root, parentDir, pyFile);
                        if (fs.existsSync(oldFilePath)) { continue; }

                        moduleMap.set(oldImport, newImport);
                    }
                } catch { /* skip unreadable subdirs */ }
            }
        } catch { /* skip */ }
    }

    if (moduleMap.size === 0) {
        logInfo('[pre-process] No module relocations detected (files may not have been moved yet, or imports are already correct)');
        return '__NO_MOVES_DETECTED__';
    }

    logInfo(`[pre-process] Built module map: ${moduleMap.size} relocated modules`);

    // Step 3: Scan .py files directly for stale imports (fast -- no child processes)
    const searchToolId = `t_${Date.now()}_pre2`;
    interface ImportEdit { lineNum: number; oldLine: string; oldImport: string; newImport: string }
    const editsPerFile = new Map<string, ImportEdit[]>();

    post({ type: 'toolCall', id: searchToolId, name: 'shell_read', args: { command: `grep -rn "from ..." . (scanning .py files for ${moduleMap.size} old import patterns)` } });

    // Build a set of old import strings for fast lookup
    const oldImportStrings = new Map<string, string>(); // "from X" -> newImport
    for (const [oldImport, newImport] of moduleMap) {
        oldImportStrings.set(`from ${oldImport}`, newImport);
    }

    // Recursively find all .py files, skipping irrelevant directories
    const SKIP_SCAN_DIRS = new Set([
        'node_modules', '.git', '__pycache__', 'dist', 'build', 'venv', '.venv',
        'env', '.env', '.tox', '.mypy_cache', '.pytest_cache', 'htmlcov',
        '.eggs', 'migrations', 'logs', '.cache', 'archive', 'tests', 'test',
    ]);
    const pyFiles: string[] = [];
    const MAX_SCAN_DEPTH = 8;
    const MAX_PY_FILES = 500;
    const collectPyFiles = (dir: string, depth: number) => {
        if (depth > MAX_SCAN_DEPTH || pyFiles.length >= MAX_PY_FILES) { return; }
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (pyFiles.length >= MAX_PY_FILES) { break; }
                if (entry.isDirectory() && !entry.isSymbolicLink()) {
                    if (!SKIP_SCAN_DIRS.has(entry.name)) {
                        collectPyFiles(path.resolve(dir, entry.name), depth + 1);
                    }
                } else if (entry.name.endsWith('.py')) {
                    pyFiles.push(path.resolve(dir, entry.name));
                }
            }
        } catch { /* skip unreadable dirs */ }
    };
    collectPyFiles(root, 0);
    logInfo(`[pre-process] Scanning ${pyFiles.length} .py files for stale imports`);

    for (const fullPath of pyFiles) {
        if (stopRef.stop) { break; }
        try {
            const fileContent = fs.readFileSync(fullPath, 'utf8');
            const relPath = path.relative(root, fullPath).replace(/\\/g, '/');
            const fileLines = fileContent.split('\n');
            for (let i = 0; i < fileLines.length; i++) {
                const line = fileLines[i];
                for (const [oldStr, newImport] of oldImportStrings) {
                    if (!line.includes(oldStr)) { continue; }
                    // Skip if already points to new location
                    if (line.includes(`from ${newImport}`)) { continue; }
                    // Skip __init__.py in target subdirectories (they use relative imports)
                    const subDirName = newImport.split('.').slice(-2, -1)[0];
                    if (relPath.endsWith('__init__.py') && relPath.includes(`${subDirName}/`)) { continue; }
                    if (!editsPerFile.has(relPath)) { editsPerFile.set(relPath, []); }
                    editsPerFile.get(relPath)!.push({
                        lineNum: i + 1,
                        oldLine: line.trim(),
                        oldImport: oldStr.replace('from ', ''),
                        newImport,
                    });
                    break; // One match per line
                }
            }
        } catch { /* skip unreadable files */ }
    }

    const totalEdits = [...editsPerFile.values()].reduce((sum, edits) => sum + edits.length, 0);
    post({ type: 'toolResult', id: searchToolId, name: 'shell_read', success: true, preview: `Found ${totalEdits} stale imports across ${editsPerFile.size} files` });

    if (editsPerFile.size === 0) {
        logInfo('[pre-process] No stale imports found -- imports may already be up to date');
        return '__IMPORTS_ALREADY_CORRECT__';
    }

    logInfo(`[pre-process] Found ${totalEdits} stale imports in ${editsPerFile.size} files -- executing edits`);

    // Step 4: Execute edits programmatically via edit_file (with diff preview + confirmation)
    let successCount = 0;
    let failCount = 0;
    const editSummary: string[] = [];

    for (const [filePath, edits] of editsPerFile) {
        if (stopRef.stop) { break; }
        try {
            const full = path.resolve(root, filePath);
            if (!fs.existsSync(full)) { continue; }
            let content = fs.readFileSync(full, 'utf8');

            const seen = new Set<string>();
            for (const edit of edits) {
                // Use the FULL line as old_string to guarantee uniqueness.
                // Using just the prefix (e.g., "from app.routes.admin") would match
                // lines already updated to "from app.routes.admin.health" etc.
                const oldStr = edit.oldLine;
                const newStr = edit.oldLine.replace(`from ${edit.oldImport}`, `from ${edit.newImport}`);
                if (seen.has(oldStr)) { continue; }
                seen.add(oldStr);

                if (!content.includes(oldStr)) {
                    logInfo(`[pre-process] Skipping ${filePath}: "${oldStr}" not found (may have been edited already)`);
                    continue;
                }

                const editToolId = `t_${Date.now()}_pre_e${successCount + failCount}`;
                post({ type: 'toolCall', id: editToolId, name: 'edit_file', args: { path: filePath, old_string: oldStr, new_string: newStr } });

                try {
                    const result = await executeTool('edit_file', {
                        path: filePath,
                        old_string: oldStr,
                        new_string: newStr,
                    }, editToolId);

                    if (result.includes('cancelled')) {
                        post({ type: 'toolResult', id: editToolId, name: 'edit_file', success: false, preview: result });
                        failCount++;
                    } else {
                        post({ type: 'toolResult', id: editToolId, name: 'edit_file', success: true, preview: result.slice(0, 200) });
                        successCount++;
                        editSummary.push(`[done] ${filePath}: ${oldStr} -> ${newStr}`);
                        content = fs.readFileSync(full, 'utf8');
                    }
                } catch (err) {
                    const errMsg = toErrorMessage(err);
                    post({ type: 'toolResult', id: editToolId, name: 'edit_file', success: false, preview: errMsg });
                    failCount++;
                    editSummary.push(`✗ ${filePath}: ${oldStr} -- ${errMsg}`);
                }
            }
        } catch (err) {
            logWarn(`[pre-process] Failed to process ${filePath}: ${toErrorMessage(err)}`);
            failCount++;
        }
    }

    logInfo(`[pre-process] Pipeline complete: ${successCount} edits applied, ${failCount} failed`);

    // Step 5: Validate that every new import path resolves to a real file on disk.
    // For any that don't, search the project for a file with the same name (renamed/moved elsewhere).
    const validationLines: string[] = [];
    const newImportsApplied = new Set<string>();
    for (const edits of editsPerFile.values()) {
        for (const edit of edits) { newImportsApplied.add(edit.newImport); }
    }

    if (newImportsApplied.size > 0) {
        // Helper: find all .py files under root matching a given base name
        const findByName = (baseName: string): string[] => {
            const results: string[] = [];
            const walk = (dir: string) => {
                let entries: fs.Dirent[];
                try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
                for (const e of entries) {
                    if (e.name.startsWith('.') || e.name === '__pycache__') { continue; }
                    const full = path.join(dir, e.name);
                    if (e.isDirectory()) { walk(full); }
                    else if (e.isFile() && e.name === `${baseName}.py`) {
                        results.push(path.relative(root, full).replace(/\\/g, '/'));
                    }
                }
            };
            walk(root);
            return results;
        };

        const broken: string[] = [];
        const renamed: string[] = [];

        for (const newImport of newImportsApplied) {
            const filePath = newImport.replace(/\./g, '/') + '.py';
            const fullPath = path.resolve(root, filePath);
            if (fs.existsSync(fullPath)) { continue; } // [done] confirmed -- skip

            // File not found at expected path -- search by base name
            const baseName = newImport.split('.').pop() ?? '';
            const matches = findByName(baseName);

            if (matches.length > 0) {
                // Found under a different path -- likely renamed or in different subdir
                const matchList = matches.map(m => `\`${m.replace(/\//g, '.').replace(/\.py$/, '')}\``).join(', ');
                renamed.push(`[warn]  \`${newImport}\` -- file not at expected path. Found as: ${matchList}`);
            } else {
                broken.push(`✗  \`${newImport}\` -- not found anywhere in project (may be deleted or not yet created)`);
            }
        }

        if (renamed.length > 0 || broken.length > 0) {
            validationLines.push(``, `## Import Validation Issues`, ``);
            validationLines.push(...renamed, ...broken);
            validationLines.push(``, `Note: The above imports were updated but the target files could not be confirmed on disk. They may have been renamed -- check the paths above and correct the imports manually if needed.`);
        }
    }

    const summary = [
        `[system: Import path update pipeline completed programmatically.]`,
        ``,
        `## Results`,
        `- **${successCount}** imports updated successfully`,
        failCount > 0 ? `- **${failCount}** edits failed or were cancelled` : '',
        `- **${editsPerFile.size}** files were affected`,
        ``,
        `## Changes Made`,
        ...editSummary,
        ...validationLines,
        ``,
        `Tell the user what was done. List the files that were updated and summarize the import path changes.`,
        validationLines.length > 0 ? `Also highlight the validation issues found -- imports that point to missing files, with any close matches shown.` : '',
        failCount > 0 ? `Also mention the ${failCount} edit(s) that failed and suggest the user review them manually.` : '',
        `Do NOT call any more tools -- the work is done.`,
    ].filter(Boolean).join('\n');

    return summary;
}
