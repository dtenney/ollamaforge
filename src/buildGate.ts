// buildGate.ts — deterministic build/test verification gate.
//
// Purpose: when the agent declares "done" (isLegitimateStop, no tool call), run the
// project's test suite ONCE. If it fails, hand the failure tail back to the model so
// it fixes the regression instead of stopping on a broken build. This is harness
// logic, not a prompt nudge — it works regardless of model size.
//
// The cap (max 1 extra pass) is enforced by the caller (Agent._buildGateFired); this
// module is pure: detect the command, run it, report pass/fail + a feedback tail.

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

export interface BuildGateResult {
    /** True if a test command was found AND executed. */
    ran: boolean;
    /** True if the test command exited 0. */
    passed: boolean;
    /** The command that was run (e.g. "npm test"), or null if none detected. */
    command: string | null;
    /** On failure: a trimmed tail of the output to feed back to the model. Null on pass. */
    feedback: string | null;
}

/**
 * Detect the project's test command from package.json scripts.
 * Prefers `test`, falls back to `test:unit`. Returns null if package.json is absent
 * or has no test script (in which case the gate is a no-op).
 */
export function detectTestCommand(workspaceRoot: string): string | null {
    if (!workspaceRoot) { return null; }
    try {
        const pkgPath = path.join(workspaceRoot, 'package.json');
        if (!fs.existsSync(pkgPath)) { return null; }
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const scripts = pkg.scripts;
        if (scripts && typeof scripts === 'object') {
            if (typeof scripts.test === 'string' && scripts.test.trim()) { return 'npm test'; }
            if (typeof scripts['test:unit'] === 'string' && scripts['test:unit'].trim()) { return 'npm run test:unit'; }
        }
    } catch {
        // malformed package.json — treat as no test command
    }
    return null;
}

/**
 * Run the detected test command once and report the result.
 * Never throws — all failures are captured into the result so the caller can decide.
 */
export function runBuildGate(workspaceRoot: string, timeoutMs = 120_000): BuildGateResult {
    const command = detectTestCommand(workspaceRoot);
    if (!command) {
        return { ran: false, passed: true, command: null, feedback: null };
    }

    let stdout = '';
    let stderr = '';
    let exitCode = 0;
    try {
        const out = execSync(command, {
            cwd: workspaceRoot,
            timeout: timeoutMs,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            // Don't inherit a TTY; keep output deterministic.
            shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
        });
        stdout = typeof out === 'string' ? out : String(out);
    } catch (err: unknown) {
        const e = err as { status?: number | null; stdout?: Buffer | string; stderr?: Buffer | string };
        exitCode = typeof e.status === 'number' ? e.status : 1;
        stdout = e.stdout ? (typeof e.stdout === 'string' ? e.stdout : e.stdout.toString()) : '';
        stderr = e.stderr ? (typeof e.stderr === 'string' ? e.stderr : e.stderr.toString()) : '';
    }

    const passed = exitCode === 0;
    if (passed) {
        return { ran: true, passed: true, command, feedback: null };
    }

    // Build a compact failure tail (last ~40 lines) to feed back to the model.
    const combined = [stdout, stderr].filter(Boolean).join('\n');
    const lines = combined.split('\n');
    const tail = lines.slice(-40).join('\n').trim();
    const feedback =
        `[system: Build/test gate — "${command}" FAILED (exit ${exitCode}). ` +
        `You declared done, but the test suite is red. Fix the failure and re-run before stopping.\n\n` +
        `--- test output (tail) ---\n${tail || '(no output captured)'}\n--- end ---`;
    return { ran: true, passed: false, command, feedback };
}
