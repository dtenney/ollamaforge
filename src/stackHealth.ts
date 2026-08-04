/**
 * Stack health: SSH-based health checks, heal actions, and upgrade support
 * for the three local services Ollama Forge depends on:
 *   - Ollama   (LLM inference)
 *   - Qdrant   (vector store)
 *   - SearXNG  (web search)
 *
 * All remote commands run over SSH. No credentials are stored — relies on
 * the user's existing SSH key auth / ssh-agent.
 */

import { execSync, spawnSync } from 'child_process';
import { logInfo, logWarn, logError } from './logger';

// ── Types ─────────────────────────────────────────────────────────────────────

export type HealthStatus = 'ok' | 'degraded' | 'down' | 'unknown';

export interface HealAction {
    id: string;
    label: string;
    command: string;        // SSH command to run on remote host
    destructive: boolean;
}

export interface ComponentStatus {
    name: string;
    status: HealthStatus;
    version?: string;
    details: string;
    issues: string[];
    healActions: HealAction[];
    upgradeCommand?: string; // shown to user verbatim before running
}

export interface StackReport {
    timestamp: number;
    sshHost: string;
    components: ComponentStatus[];
    overallStatus: HealthStatus;
}

// ── SSH helper ────────────────────────────────────────────────────────────────

const SSH_TIMEOUT = 10; // seconds

// Candidate paths for ssh binary — extension host may have a minimal PATH
const SSH_CANDIDATES = [
    '/usr/bin/ssh',
    '/bin/ssh',
    'C:\\Windows\\System32\\OpenSSH\\ssh.exe',
    'ssh', // fallback: rely on PATH
];

function findSsh(): string {
    const { existsSync } = require('fs') as typeof import('fs');
    for (const p of SSH_CANDIDATES) {
        try { if (existsSync(p)) { return p; } } catch { /* skip */ }
    }
    return 'ssh';
}

const SSH_BIN = findSsh();

function ssh(host: string, cmd: string): { stdout: string; stderr: string; ok: boolean } {
    // Use spawnSync with args array to avoid shell quoting issues on Windows OpenSSH.
    // The remote command is passed as a single argument — Windows OpenSSH forwards it
    // directly to the remote shell without local shell interpretation.
    const args = [
        '-o', `ConnectTimeout=${SSH_TIMEOUT}`,
        '-o', 'BatchMode=yes',
        '-o', 'StrictHostKeyChecking=accept-new',
        host,
        cmd,  // passed as a single arg — no local quoting needed
    ];

    const result = spawnSync(SSH_BIN, args, {
        timeout: (SSH_TIMEOUT + 2) * 1000,
        encoding: 'utf8',
        env: { ...process.env, PATH: `/usr/bin:/bin:/usr/local/bin:${process.env.PATH ?? ''}` },
    });

    const stdout = (result.stdout ?? '').trim();
    const stderr = (result.stderr ?? result.error?.message ?? '').trim();
    const ok = result.status === 0 && !result.error;

    if (!ok) {
        logWarn(`[stackHealth] SSH failed — bin: ${SSH_BIN}, host: ${host}, cmd: ${cmd.slice(0, 80)}, err: ${stderr.slice(0, 200)}`);
    }

    return { stdout, stderr, ok };
}

// ── Ollama ────────────────────────────────────────────────────────────────────

export function checkOllama(sshHost: string): ComponentStatus {
    const issues: string[] = [];
    const healActions: HealAction[] = [];

    // Version
    const ver = ssh(sshHost, 'ollama --version 2>/dev/null || echo MISSING');
    const version = ver.ok && !ver.stdout.includes('MISSING') ? ver.stdout.replace(/^ollama\s+version\s+/i, '').trim() : undefined;

    // API health
    const api = ssh(sshHost, 'curl -sf --max-time 5 http://localhost:11434/api/tags');
    if (!api.ok || !api.stdout.includes('"models"')) {
        issues.push('Ollama API not responding on port 11434');
        healActions.push({
            id: 'restart_ollama',
            label: 'Restart Ollama service',
            command: 'sudo systemctl restart ollama',
            destructive: true,
        });
    }

    // Running models
    const ps = ssh(sshHost, 'ollama ps 2>/dev/null');
    const noModels = ps.ok && ps.stdout.trim() === '' || ps.stdout.includes('NAME') && ps.stdout.split('\n').length < 2;
    if (noModels && api.ok) {
        issues.push('No models currently loaded');
        // Not a heal action — models load on demand
    }

    // Disk space for models
    const disk = ssh(sshHost, 'df -h ~/.ollama 2>/dev/null | tail -1 | awk \'{print $5}\'');
    if (disk.ok) {
        const usePct = parseInt(disk.stdout.replace('%', ''), 10);
        if (!isNaN(usePct) && usePct >= 90) {
            issues.push(`Ollama model storage at ${usePct}% capacity`);
            healActions.push({
                id: 'ollama_prune',
                label: 'List unused models (manual review)',
                command: 'ollama list',
                destructive: false,
            });
        }
    }

    let status: HealthStatus = 'ok';
    if (!api.ok) { status = 'down'; }
    else if (issues.length > 0) { status = 'degraded'; }

    const details = status === 'ok'
        ? `Ollama API responding${version ? ` (v${version})` : ''}${noModels ? ', no models loaded' : ''}`
        : issues.join('; ');

    return {
        name: 'ollama',
        status,
        version,
        details,
        issues,
        healActions,
        upgradeCommand: `curl -fsSL https://ollama.com/install.sh | sh`,
    };
}

// ── Qdrant ────────────────────────────────────────────────────────────────────

export function checkQdrant(sshHost: string, composePath: string): ComponentStatus {
    const issues: string[] = [];
    const healActions: HealAction[] = [];

    // Health endpoint
    const health = ssh(sshHost, 'curl -sf --max-time 5 http://localhost:6333/healthz');
    // Qdrant returns "healthz check passed" (plain text), not JSON
    const apiOk = health.ok && (health.stdout.includes('passed') || health.stdout.includes('"ok"') || health.stdout.trim().length > 0);

    if (!apiOk) {
        issues.push('Qdrant API not responding on port 6333');
        healActions.push({
            id: 'restart_qdrant',
            label: 'Restart Qdrant container',
            command: `docker compose -f ${composePath} restart qdrant`,
            destructive: true,
        });
    }

    // Version
    let version: string | undefined;
    if (apiOk) {
        const ver = ssh(sshHost, `curl -sf http://localhost:6333/ | grep -o '"version":"[^"]*"' | head -1 | cut -d'"' -f4`);
        if (ver.ok && ver.stdout) { version = ver.stdout.trim(); }
    }

    // Collection stats
    let collectionCount = 0;
    if (apiOk) {
        const cols = ssh(sshHost, `curl -sf http://localhost:6333/collections | grep -o '"name"' | wc -l | tr -d ' '`);
        if (cols.ok && cols.stdout) {
            collectionCount = parseInt(cols.stdout.trim(), 10) || 0;
            if (collectionCount === 0) {
                issues.push('Qdrant has no collections — memory/embeddings may not be indexed');
                healActions.push({
                    id: 'qdrant_reindex',
                    label: 'Re-index embeddings (triggers workspace reindex)',
                    command: '', // handled in-process, not via SSH
                    destructive: true,
                });
            }
        }
    }

    let status: HealthStatus = 'ok';
    if (!apiOk) { status = 'down'; }
    else if (issues.length > 0) { status = 'degraded'; }

    const details = status === 'ok'
        ? `Qdrant API responding${version ? ` (v${version})` : ''}, ${collectionCount} collection(s)`
        : issues.join('; ');

    return {
        name: 'qdrant',
        status,
        version,
        details,
        issues,
        healActions,
        upgradeCommand: `docker compose -f ${composePath} pull qdrant && docker compose -f ${composePath} up -d qdrant`,
    };
}

// ── SearXNG ───────────────────────────────────────────────────────────────────

export function checkSearxng(sshHost: string, searxngUrl: string, composePath: string): ComponentStatus {
    const issues: string[] = [];
    const healActions: HealAction[] = [];

    if (!searxngUrl) {
        return {
            name: 'searxng',
            status: 'unknown',
            details: 'SearXNG URL not configured (ollamaForge.search.url)',
            issues: ['Not configured'],
            healActions: [],
        };
    }

    // Reachability
    const reach = ssh(sshHost, `curl -sf --max-time 5 "${searxngUrl}/" -o /dev/null -w "%{http_code}"`);
    const reachable = reach.ok && (reach.stdout === '200' || reach.stdout === '302' || reach.stdout === '301');

    if (!reachable) {
        issues.push(`SearXNG not reachable at ${searxngUrl}`);
        healActions.push({
            id: 'restart_searxng',
            label: 'Restart SearXNG container',
            command: `docker compose -f ${composePath} restart searxng`,
            destructive: true,
        });
    }

    // Test search query
    let resultCount = 0;
    if (reachable) {
        const search = ssh(sshHost,
            `curl -sf --max-time 8 "${searxngUrl}/search?q=test&format=json" | grep -o '"url"' | wc -l | tr -d ' '`
        );
        if (search.ok && search.stdout) {
            resultCount = parseInt(search.stdout.trim(), 10) || 0;
        }
        if (resultCount === 0) {
            issues.push('SearXNG test query returned 0 results — engines may be failing');
            healActions.push({
                id: 'searxng_clear_cache',
                label: 'Clear SearXNG cache',
                command: `docker exec searxng sh -c "rm -rf /tmp/searxng* 2>/dev/null; echo done"`,
                destructive: false,
            });
            healActions.push({
                id: 'restart_searxng',
                label: 'Restart SearXNG container',
                command: `docker compose -f ${composePath} restart searxng`,
                destructive: true,
            });
        }
    }

    let status: HealthStatus = 'ok';
    if (!reachable) { status = 'down'; }
    else if (issues.length > 0) { status = 'degraded'; }

    const details = status === 'ok'
        ? `SearXNG reachable, test query returned ${resultCount} result(s)`
        : issues.join('; ');

    return {
        name: 'searxng',
        status,
        details,
        issues,
        healActions,
        upgradeCommand: `docker compose -f ${composePath} pull searxng && docker compose -f ${composePath} up -d searxng`,
    };
}

// ── Aggregate ─────────────────────────────────────────────────────────────────

export function checkAll(sshHost: string, searxngUrl: string, composePath: string): StackReport {
    logInfo(`[stackHealth] Running checks via SSH: ${sshHost}`);

    const components: ComponentStatus[] = [];

    try { components.push(checkOllama(sshHost)); }
    catch (err) { logError(`[stackHealth] Ollama check threw: ${err}`); components.push(errorComponent('ollama', err)); }

    try { components.push(checkQdrant(sshHost, composePath)); }
    catch (err) { logError(`[stackHealth] Qdrant check threw: ${err}`); components.push(errorComponent('qdrant', err)); }

    try { components.push(checkSearxng(sshHost, searxngUrl, composePath)); }
    catch (err) { logError(`[stackHealth] SearXNG check threw: ${err}`); components.push(errorComponent('searxng', err)); }

    const statuses = components.map(c => c.status);
    const overallStatus: HealthStatus =
        statuses.includes('down')    ? 'down'    :
        statuses.includes('degraded')? 'degraded':
        statuses.includes('unknown') ? 'unknown' : 'ok';

    logInfo(`[stackHealth] Overall: ${overallStatus} — ${components.map(c => `${c.name}:${c.status}`).join(', ')}`);

    return { timestamp: Date.now(), sshHost, components, overallStatus };
}

function errorComponent(name: string, err: unknown): ComponentStatus {
    const msg = err instanceof Error ? err.message : String(err);
    return { name, status: 'unknown', details: `Check failed: ${msg}`, issues: [msg], healActions: [] };
}

// ── Report formatting ─────────────────────────────────────────────────────────

const STATUS_ICON: Record<HealthStatus, string> = {
    ok:      '✓',
    degraded:'⚠',
    down:    '✗',
    unknown: '?',
};

export function formatReport(report: StackReport): string {
    const ts = new Date(report.timestamp).toLocaleString();
    const lines: string[] = [
        `# Stack Health Report`,
        `Checked: ${ts} via ${report.sshHost}`,
        `Overall: ${STATUS_ICON[report.overallStatus]} ${report.overallStatus.toUpperCase()}`,
        '',
    ];

    for (const c of report.components) {
        lines.push(`## ${STATUS_ICON[c.status]} ${c.name.charAt(0).toUpperCase() + c.name.slice(1)}`);
        lines.push(`Status: **${c.status}**${c.version ? `  |  Version: ${c.version}` : ''}`);
        lines.push(c.details);
        if (c.issues.length > 0) {
            lines.push('');
            lines.push('**Issues:**');
            for (const issue of c.issues) { lines.push(`- ${issue}`); }
        }
        if (c.healActions.length > 0) {
            lines.push('');
            lines.push('**Available fixes:**');
            for (const a of c.healActions) {
                lines.push(`- ${a.label}${a.destructive ? ' _(requires confirmation)_' : ''}`);
                if (a.command) { lines.push(`  \`${a.command}\``); }
            }
        }
        if (c.upgradeCommand) {
            lines.push('');
            lines.push(`**Upgrade command:** \`${c.upgradeCommand}\``);
        }
        lines.push('');
    }

    return lines.join('\n');
}

// ── SSH heal execution ────────────────────────────────────────────────────────

export interface HealResult {
    actionId: string;
    success: boolean;
    output: string;
}

export function executeHeal(sshHost: string, action: HealAction): HealResult {
    if (!action.command) {
        return { actionId: action.id, success: false, output: 'No command defined for this action — handle in-process.' };
    }
    logInfo(`[stackHealth] Executing heal: ${action.id} — ${action.command}`);
    const result = ssh(sshHost, action.command);
    logInfo(`[stackHealth] Heal result: ${result.ok ? 'ok' : 'failed'} — ${result.stdout || result.stderr}`);
    return {
        actionId: action.id,
        success: result.ok,
        output: result.stdout || result.stderr || '(no output)',
    };
}

// ── Dream cycle summary ───────────────────────────────────────────────────────

/**
 * Run a health check and return a brief summary string suitable for appending
 * to the dream cycle notification. Returns empty string if all ok.
 */
export function dreamHealthSummary(sshHost: string, searxngUrl: string, composePath: string): string {
    if (!sshHost) { return ''; }
    try {
        const report = checkAll(sshHost, searxngUrl, composePath);
        if (report.overallStatus === 'ok') { return ''; }
        const down = report.components.filter(c => c.status === 'down').map(c => c.name);
        const degraded = report.components.filter(c => c.status === 'degraded').map(c => c.name);
        const parts: string[] = [];
        if (down.length)     { parts.push(`${down.join(', ')} DOWN`); }
        if (degraded.length) { parts.push(`${degraded.join(', ')} degraded`); }
        return parts.join('; ');
    } catch (err) {
        logWarn(`[stackHealth] Dream health check failed: ${err}`);
        return '';
    }
}
