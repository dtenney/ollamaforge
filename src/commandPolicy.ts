/**
 * commandPolicy.ts — Wave 1 security layer (plan item 1.2).
 *
 * Replaces the brittle inline regex destructive-guard with a config-driven
 * deny / confirm / allow policy plus a network-egress allowlist. The existing
 * regex guard in agent.ts remains as a fallback; this module is the source of
 * truth when present.
 *
 * Design goals:
 *  - deny patterns are ALWAYS enforced, even in YOLO mode (cannot be disabled).
 *  - confirm patterns require an explicit user prompt regardless of trust level.
 *  - allow patterns auto-approve in Trust/YOLO.
 *  - egress allowlist restricts which hosts run_command may reach.
 */

export type PolicyVerdict = 'allow' | 'confirm' | 'deny';

export interface PolicyResult {
    verdict: PolicyVerdict;
    /** Which rule fired (for logging / session_trace). */
    rule: string;
    /** Human-readable reason shown to the user in the confirm prompt. */
    reason: string;
}

export interface CommandPolicyConfig {
    /** Always-blocked patterns. Cannot be disabled by any trust level. */
    deny?: string[];
    /** Require explicit confirmation. */
    confirm?: string[];
    /** Auto-approved in Trust/YOLO. */
    allow?: string[];
    /** Hosts run_command may reach. Empty/undefined = no egress restriction. */
    egressAllowlist?: string[];
}

/** Built-in deny list — always active, cannot be removed by user config. */
const BUILTIN_DENY: RegExp[] = [
    /rm\s+(-[a-z]*\s+)?\/(\s|$)/,                       // rm -rf /
    /rm\s+(-[a-z]*\s+)?~(\s|$)/,                        // rm -rf ~
    /\bmkfs(\.\w+)?\b/,                                 // mkfs.ext4, mkfs.xfs
    /\bdd\s+.*\bof=\/dev\//,                            // dd of=/dev/sda
    /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/,             // fork bomb
    /\bshred\s+.*\/dev\//,                              // shred /dev/...
    /\bchmod\s+(-[a-z]*\s+)?777\s+\/(\s|$)/,            // chmod -R 777 /
    /\bformat\s+[a-z]:/i,                               // format C:
    /\bRemove-Item\s+.*-Recurse\s+.*\/(home|Users)\b/i, // Remove-Item -Recurse /home
    /\bdrop\s+(database|table)\b/i,                     // SQL drop
    /\btruncate\s+table\b/i,                            // SQL truncate
    /\bshutdown\b|\breboot\b|\binit\s+0\b/,             // system power
];

/** Built-in confirm list — always active. */
const BUILTIN_CONFIRM: RegExp[] = [
    /\bgit\s+push\s+.*--force\b/i,                       // git push --force
    /\bgit\s+push\s+.*-f\b/i,                            // git push -f
    /\bgit\s+reset\s+--hard\b/i,                         // git reset --hard
    /\bgit\s+clean\s+(-[a-z]*\s+)?-f/i,                  // git clean -f
    /\bpip3?\s+uninstall\b/i,                            // pip uninstall
    /\bnpm\s+publish\b/i,                                // npm publish
    /\bdocker\s+system\s+prune\b/i,                      // docker prune
    /\bdocker\s+rmi\b/i,                                 // docker rmi
    /\bdrop\s+(table|database)\b/i,                      // SQL drop (also deny)
    /\btruncate\b/i,                                     // truncate
    /\bshred\b/i,                                        // shred
    /\bRemove-Item\b/i,                                  // PowerShell remove
    /\bClear-Content\b/i,                                // PowerShell clear
    /\brm\s+(-[a-z]*f[a-z]*\b)/i,                        // rm -f
    /\brmdir\b/i,                                        // rmdir
    /\bdel\s+\/[fqs]/i,                                  // del /f
    /\bkill\s+-9\b/i,                                    // kill -9
    /\bkillall\b/i,                                       // killall
    /\btaskkill\s+/i,                                     // taskkill
];

/** Built-in allow list — safe, read-only / build / test commands. */
const BUILTIN_ALLOW: RegExp[] = [
    /^\s*(du|df|ls|ll|dir|cat|head|tail|grep|find|stat|file|wc|diff|echo|pwd|id|who|uptime|uname|hostname|ps|top|lsof|netstat|ss|ifconfig|ping)\b/i,
    /^\s*git\s+(status|log|diff|show|branch|remote|config|ls-files|rev-parse|describe|tag|shortlog|blame)\b/i,
    /^\s*(npm|yarn|pnpm)\s+(test|run\s+(build|lint|typecheck|check|dev|start)|run\s+bundle|run\s+vendor|run\s+compile|run\s+deploy|run\s+self-check|run\s+test|run\s+test:unit|run\s+test:coverage|run\s+package)\b/i,
    /^\s*(npx|tsc)\s+.*--noEmit\b/i,
    /^\s*(pytest|python3?\s+-m\s+pytest)\b/i,
    /^\s*(ruff|flake8|pylint|mypy|black\s+--check|isort\s+--check)\b/i,
    /^\s*(eslint|prettier\s+--check)\b/i,
    /^\s*(node|nodejs)\s+.*--version\b/i,
    /^\s*(python3?|node|npm|git|curl|wget)\s+--version\b/i,
    /^\s*which\s+\w+/i,
    /^\s*where\s+\w+/i,
    /^\s*type\s+\w+/i,
];

/** Compile a list of string patterns into RegExp[] (case-insensitive). */
function compile(patterns: string[] | undefined): RegExp[] {
    if (!patterns) return [];
    return patterns
        .map((p) => {
            try {
                return new RegExp(p, 'i');
            } catch {
                return null;
            }
        })
        .filter((r): r is RegExp => r !== null);
}

/**
 * Evaluate a shell command against the policy.
 * Returns the strictest verdict that matches (deny > confirm > allow).
 */
export function evaluateCommand(cmd: string, config?: CommandPolicyConfig): PolicyResult {
    const trimmed = (cmd ?? '').trim();
    if (!trimmed) {
        return { verdict: 'allow', rule: 'empty', reason: 'Empty command' };
    }

    // 1. Built-in deny (always active)
    for (const re of BUILTIN_DENY) {
        if (re.test(trimmed)) {
            return { verdict: 'deny', rule: 'builtin-deny', reason: `Matches built-in deny rule: ${re.source}` };
        }
    }
    // 2. User deny (always active)
    for (const re of compile(config?.deny)) {
        if (re.test(trimmed)) {
            return { verdict: 'deny', rule: 'user-deny', reason: `Matches user deny rule: ${re.source}` };
        }
    }
    // 3. Built-in confirm
    for (const re of BUILTIN_CONFIRM) {
        if (re.test(trimmed)) {
            return { verdict: 'confirm', rule: 'builtin-confirm', reason: `Matches built-in confirm rule: ${re.source}` };
        }
    }
    // 4. User confirm
    for (const re of compile(config?.confirm)) {
        if (re.test(trimmed)) {
            return { verdict: 'confirm', rule: 'user-confirm', reason: `Matches user confirm rule: ${re.source}` };
        }
    }
    // 5. Built-in allow
    for (const re of BUILTIN_ALLOW) {
        if (re.test(trimmed)) {
            return { verdict: 'allow', rule: 'builtin-allow', reason: `Matches built-in allow rule: ${re.source}` };
        }
    }
    // 6. User allow
    for (const re of compile(config?.allow)) {
        if (re.test(trimmed)) {
            return { verdict: 'allow', rule: 'user-allow', reason: `Matches user allow rule: ${re.source}` };
        }
    }
    // 7. Default: allow (the existing regex guard in agent.ts still applies as fallback)
    return { verdict: 'allow', rule: 'default', reason: 'No rule matched' };
}

/**
 * Check whether a command references a network host that is NOT in the egress
 * allowlist. Returns the offending host, or null if the command is clean or
 * no allowlist is configured.
 */
export function checkEgress(cmd: string, allowlist?: string[]): string | null {
    if (!allowlist || allowlist.length === 0) return null;

    // Extract hosts from common network commands
    const hostPatterns: RegExp[] = [
        /(?:curl|wget|scp|sftp|ssh|nc|ncat|netcat)\s+(?:-[a-zA-Z]+\s+)*([a-zA-Z0-9._-]+)(?::\d+)?/,
        /https?:\/\/([a-zA-Z0-9._-]+)/,
        /git\s+(?:clone|push|pull|fetch)\s+(?:https?:\/\/)?([a-zA-Z0-9._-]+)/,
    ];

    const hosts = new Set<string>();
    for (const re of hostPatterns) {
        const m = cmd.match(re);
        if (m && m[1]) hosts.add(m[1].toLowerCase());
    }

    // Localhost / loopback / private ranges are always allowed
    const isLocal = (h: string): boolean =>
        h === 'localhost' ||
        h === '127.0.0.1' ||
        h === '::1' ||
        /^192\.168\./.test(h) ||
        /^10\./.test(h) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(h);

    for (const host of Array.from(hosts)) {
        if (isLocal(host)) continue;
        const allowed = allowlist.some((a) => {
            const aLower = a.toLowerCase();
            // Exact match or wildcard subdomain
            if (aLower === host) return true;
            if (aLower.startsWith('*.')) return host.endsWith(aLower.slice(1));
            return false;
        });
        if (!allowed) return host;
    }
    return null;
}
