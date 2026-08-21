/**
 * 1.5 Webview postMessage validation — single source of truth for the
 * malformed-message guard. A message is valid only if it is a non-null object
 * whose `command` field is a non-empty string. Anything else is dropped before
 * it reaches the command switch, so a hostile or buggy webview can never
 * dispatch an unrecognised or malformed command.
 *
 * This module has NO dependencies (no `vscode` import) so it can be unit-tested
 * in isolation without the extension host.
 */
export function isValidWebviewMsg(raw: unknown): boolean {
    if (!raw || typeof raw !== 'object') {
        return false;
    }
    const command = (raw as { command?: unknown }).command;
    return typeof command === 'string' && command.length > 0;
}
