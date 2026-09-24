// src/pathPolicy.ts
// Path-safety policy extracted from agent.ts (Phase 2 of the agent.ts split).
//
// Three responsibilities, all about keeping file access inside the workspace:
//   - isOsProtectedPath: hard-block OS system directories (no prompt, ever)
//   - safePath:          resolve a relative path and verify it stays in the
//                        workspace root (including via symlink)
//   - resolvePathWithPolicy: the full outside-workspace policy shared by
//                        read_file and any future tool that accepts an
//                        absolute/external path.
//
// These were `private` methods on Agent. They only depend on `path`, `fs`,
// `vscode`, and a confirmation callback, so they live here as plain functions.
// Agent keeps thin wrappers that bind `this.workspaceRoot` and
// `this.requestConfirmation`.

import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';

/** Hard-block list of OS system directories. Normalised to forward slashes +
 *  lower-case before comparison so it works on both Unix and Windows. */
export function isOsProtectedPath(full: string): boolean {
    const norm = full.replace(/\\/g, '/').toLowerCase();
    const BLOCKED = [
        // Unix system dirs
        '/etc/', '/proc/', '/sys/', '/dev/',
        '/private/etc/', '/private/var/',        // macOS
        '/boot/', '/lib/', '/lib64/', '/usr/lib/',
        // Windows system dirs
        '/windows/system32/', '/windows/syswow64/',
        '/windows/winsxs/', '/windows/servicing/',
    ];
    return BLOCKED.some(b => norm.startsWith(b) || norm === b.slice(0, -1));
}

/** Resolve `rel` against `root` and throw if it escapes the workspace, either
 *  directly or via a symlink. Returns the resolved absolute path. */
export function safePath(root: string, rel: string): string {
    const full = path.resolve(root, rel);
    // Normalize slashes + case on Windows — models often pass forward slashes while
    // vscode.workspace.workspaceFolders[0].uri.fsPath returns backslashes.
    const normalize = (p: string) => {
        let n = p.replace(/\//g, path.sep);
        if (process.platform === 'win32') { n = n.toLowerCase(); }
        return n;
    };
    const fullNorm = normalize(full);
    const rootNorm = normalize(root);
    const rootNormWithSep = rootNorm.endsWith(path.sep) ? rootNorm : rootNorm + path.sep;
    if (fullNorm !== rootNorm && !fullNorm.startsWith(rootNormWithSep)) {
        throw new Error(`Path "${rel}" is outside the workspace`);
    }
    // Resolve symlinks to prevent escaping workspace via symlink
    try {
        const real = fs.realpathSync(full);
        const realNorm = process.platform === 'win32' ? real.toLowerCase() : real;
        const rootReal = fs.realpathSync(root);
        const rootRealNorm = process.platform === 'win32' ? rootReal.toLowerCase() : rootReal;
        const rootRealNormWithSep = rootRealNorm.endsWith(path.sep) ? rootRealNorm : rootRealNorm + path.sep;
        if (realNorm !== rootRealNorm && !realNorm.startsWith(rootRealNormWithSep)) {
            throw new Error(`Path "${rel}" resolves outside the workspace via symlink`);
        }
    } catch (err) {
        // realpathSync throws if file doesn't exist yet -- that's OK
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw err;
        }
    }
    return full;
}

/** Signature for the confirmation prompt Agent uses when a read targets a path
 *  outside the workspace. Mirrors `Agent.requestConfirmation`. */
export type RequestConfirmation = (
    action: string,
    message: string,
    label: string
) => Promise<boolean>;

/** Resolve a raw path against the workspace with the full outside-workspace
 *  policy: OS-protected hard block → user allowlist (allowedExternalReadPaths)
 *  → confirmation prompt. Returns `{ path }` on success, or `{ blocked }` with
 *  a user-facing message. */
export async function resolvePathWithPolicy(
    rawPath: string,
    toolName: string,
    workspaceRoot: string,
    requestConfirmation: RequestConfirmation
): Promise<{ path: string } | { blocked: string }> {
    try {
        return { path: safePath(workspaceRoot, rawPath) };
    } catch {
        const absolute = path.resolve(workspaceRoot, rawPath);
        if (isOsProtectedPath(absolute)) {
            return { blocked: `[${toolName}] Access denied: "${rawPath}" is in an OS-protected directory and cannot be read.` };
        }
        const allowedExternalPaths = vscode.workspace.getConfiguration('ollamaForge')
            .get<string[]>('allowedExternalReadPaths', ['~/.ssh/config']);
        const homeDir = process.env.HOME || process.env.USERPROFILE || '';
        const isAllowed = allowedExternalPaths.some(allowed => {
            const expanded = allowed.startsWith('~') ? path.join(homeDir, allowed.slice(1)) : allowed;
            return path.resolve(expanded).toLowerCase() === absolute.toLowerCase();
        });
        // SSH paths and remote URIs are not local paths — skip the prompt.
        const isRemote = /^[a-z][a-z0-9+\-.]*:\/\//i.test(rawPath);
        if (!isRemote && !isAllowed) {
            const approved = await requestConfirmation(
                'read_outside_workspace',
                `Read file outside workspace: \`${absolute}\`\n\nThis file is not inside the workspace root. Allow?`,
                'read_file_outside'
            );
            if (!approved) {
                return { blocked: `[${toolName}] Access denied: user did not allow reading "${rawPath}" (outside workspace).` };
            }
        }
        return { path: absolute };
    }
}
