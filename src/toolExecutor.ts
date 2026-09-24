/**
 * toolExecutor.ts — pure command-routing and output-post-processing logic
 * extracted from Agent.runCommandStreaming / Agent.runShellRead.
 *
 * These functions are stateless: they take plain strings/numbers and return
 * plain values. The Agent class calls them and handles the `this`-bound
 * side-effects (postFn, trackChild, _guardEvents, etc.) itself.
 */

import * as path from 'path';
import { detectShellEnvironment } from './agentShellEnv';
import { logInfo } from './logger';

// ─── Sandbox & SSH helpers ─────────────────────────────────────────────────────

/**
 * Prepend ulimit guards to a command unless it matches a known skip pattern
 * (docker, kubectl, ssh, git, aws, package installs, etc.).
 * Pure — no `this`, no side-effects.
 */
export function applySandbox(cmd: string): string {
    const skipPatterns = [
        /\b(docker|kubectl|helm|terraform|ansible)\b/,
        /\b(pip3?\s+install|npm\s+(install|ci)|apt(-get)?\s+install)\b/,
        /\b(ssh|scp|sftp)\b/,
        /\bgit\b/,  // all git commands — ulimit -v fails on Git Bash (Windows) for any git op
        /\baws\b/,  // AWS CLI on Windows: ulimit breaks the Python-wrapper launcher
    ];
    if (skipPatterns.some(re => re.test(cmd))) {
        return cmd;
    }
    return `ulimit -t 300; ulimit -v 2097152; ulimit -f 512000; ${cmd}`;
}

/**
 * Tokenize a shell command string respecting single and double quotes,
 * without invoking a shell. Whitespace outside quotes splits tokens;
 * whitespace inside quotes is preserved as part of the token.
 * Pure — no `this`, no side-effects.
 */
export function parseSshArgs(raw: string): string[] {
    const tokens: string[] = [];
    const s = raw.trim();
    let i = 0;
    while (i < s.length) {
        while (i < s.length && /[ \t]/.test(s[i])) { i++; }
        if (i >= s.length) { break; }
        let tok = '';
        while (i < s.length && !/[ \t]/.test(s[i])) {
            if (s[i] === '"') {
                i++;
                while (i < s.length && s[i] !== '"') {
                    if (s[i] === '\\' && i + 1 < s.length) { tok += s[++i]; }
                    else { tok += s[i]; }
                    i++;
                }
                if (i < s.length) { i++; }
            } else if (s[i] === "'") {
                i++;
                while (i < s.length && s[i] !== "'") { tok += s[i++]; }
                if (i < s.length) { i++; }
            } else {
                tok += s[i++];
            }
        }
        tokens.push(tok);
    }
    return tokens;
}

// ─── Command routing ───────────────────────────────────────────────────────────

export interface CommandRoute {
    /** The (possibly rewritten) command string to pass to spawn. */
    safeCmd: string;
    /** True when the command should be routed through Git Bash. */
    useBash: boolean;
    /** Resolved bash path (empty string when bash is unavailable). */
    bashPath: string;
    /** True when the command is a bare ssh/scp/sftp (no chaining). */
    isSshCmd: boolean;
    /** True when the ssh/scp/sftp command is chained with && or ;. */
    isSshChained: boolean;
    /** Match groups for `python -c "..."` — null when not a python command. */
    pyMatch: RegExpMatchArray | null;
    /** Shell to use for non-bash, non-python spawns (true = default shell). */
    shell: string | true;
    /** Environment variables for the child process. */
    env: NodeJS.ProcessEnv;
}

/**
 * Resolve how a command should be routed: bash vs python vs ssh vs plain shell.
 * Pure — no `this`, no side-effects beyond a logInfo call.
 */
export function resolveCommandRouting(cmd: string): CommandRoute {
    const winBashPath = process.platform === 'win32' ? detectShellEnvironment().bashPath : '';
    const useBash = !!winBashPath;

    const isSshCmd = /^\s*(ssh|scp|sftp)\s/.test(cmd);
    const isSshChained = isSshCmd && /(?:^|[^&])&&|;/.test(cmd);
    const pyMatch = !isSshCmd ? cmd.trimStart().match(/^(python3?|py)\s+-c\s+"([\s\S]*)"\s*$/) : null;

    let safeCmd = cmd;
    if (!isSshCmd && !pyMatch) {
        safeCmd = cmd.replace(/[\r\n]+/g, ' ').trim();
    }

    // Windows + Git Bash: rewrite bare `aws` → `aws.cmd`
    if (useBash && process.platform === 'win32') {
        safeCmd = safeCmd.replace(/(?<![.\w])aws(?=\s|$)/g, 'aws.cmd');
    }

    // SSH through bash: inject non-interactive options + MSYS_NO_PATHCONV
    if (isSshCmd && useBash) {
        safeCmd = safeCmd.replace(
            /^(\s*(?:ssh|scp|sftp))\s/,
            '$1 -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new '
        );
        if (!safeCmd.trimStart().startsWith('MSYS_NO_PATHCONV')) {
            safeCmd = `MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' ${safeCmd}`;
        }
        logInfo(`[ssh/bash] Injected non-interactive SSH options into: ${safeCmd}`);
    }

    const bashEnv: NodeJS.ProcessEnv = { ...process.env, MSYS_NO_PATHCONV: '1', MSYS2_ARG_CONV_EXCL: '*' };
    const shell: string | true = process.platform !== 'win32'
        ? (process.env.SHELL || '/bin/bash')
        : true;

    return { safeCmd, useBash, bashPath: winBashPath, isSshCmd, isSshChained, pyMatch, shell, env: bashEnv };
}

// ─── Output post-processing nudges ─────────────────────────────────────────────

/**
 * Append behavioural nudges to command output based on exit code and content.
 * Pure string transformation — no `this`, no side-effects.
 *
 * Returns the (possibly augmented) result string.
 */
export function postProcessCommandOutput(
    result: string,
    cmd: string,
    exitCode: number
): string {
    // Missing data/config file nudge
    const missingFilePatterns = [
        /FileNotFoundError[^:]*:\s*(?:\[Errno \d+\]\s*)?[^'\n]*'?([^'\n]+\.(json|ya?ml|env|cfg|conf|ini|toml))/i,
        /Error:.*(?:file|inventory)[^\n]*not found[^\n]*\.(json|ya?ml|env|cfg|conf|ini|toml)/i,
        /(?:file|inventory)[^\n]*not found[^\n]*\.(json|ya?ml|env|cfg|conf|ini|toml)/i,
    ];
    if (missingFilePatterns.some(p => p.test(result))) {
        const missingMatch = result.match(/['"]([^'"]+\.(json|ya?ml|env|cfg|conf|ini|toml))['"]/i)
            ?? result.match(/at\s+(\S+\.(json|ya?ml|env|cfg|conf|ini|toml))/i);
        const missingFile = missingMatch ? path.basename(missingMatch[1]) : 'a required data file';
        result += `\n\n[BLOCKER] The script cannot run because ${missingFile} is missing.\n\nDo NOT try to recreate, copy, or restore this file -- its contents are not yours to guess.\n\nYour only correct action: Tell the user clearly: "${missingFile} is missing and the script cannot run. Do you know where it is or what happened to it-- Then stop. Do not search for .bak or .yaml equivalents. Do not convert other formats. Stop and ask.`;
    }

    // Script-not-found nudge (Python exit code 2)
    if (exitCode === 2 && /can't open file '([^']+\.py)'/i.test(result)) {
        const m = result.match(/can't open file '([^']+\.py)'/i);
        const missingScript = m ? path.basename(m[1]) : 'the script';
        result += `\n\n[SCRIPT MISSING] "${missingScript}" does not exist -- it was never written.\n\nCall write_file NOW to create it. Do NOT run the script again until you have written it with write_file. This is your only next action: write_file with path="${missingScript}" and the full script content.`;
    }

    // Pytest pre-existing failure nudge
    if (/\bpytest\b/.test(cmd) && exitCode !== 0 && /FAILED|ERROR/.test(result)) {
        const failedLines = result.split('\n').filter(l => /^(FAILED|ERROR)/.test(l));
        if (failedLines.length > 0) {
            result += `\n\n[SCOPE NOTE] These failures or errors may be pre-existing and unrelated to your change. Before attempting any fix:\n1. Identify whether each failure existed before your edit (i.e. you did not touch that test or fixture)\n2. If yes -- do NOT modify the test file, fixture, or any code that was already failing. Report it to the user as a pre-existing issue.\n3. Only fix failures that were clearly introduced by your change.`;
        }
    }

    // Audit script progress signal
    if (exitCode === 0 && /audit.*\.py/i.test(cmd)) {
        const activeCount = (result.match(/\bactive\b/g) ?? []).length;
        const inactiveCount = (result.match(/\binactive\b/g) ?? []).length;
        if (activeCount > 0 || inactiveCount > 0) {
            result += `\n\n[PROGRESS] Say to the user now: "Audit complete -- ${activeCount} service${activeCount !== 1 ? 's' : ''} active${inactiveCount > 0 ? `, ${inactiveCount} inactive` : ''}."`;
        }
    }

    return result;
}
