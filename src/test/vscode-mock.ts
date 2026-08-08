/**
 * vscode-mock.ts
 *
 * Preload script for headless unit tests.
 * Registers a minimal vscode stub into require.cache so that source modules
 * which import 'vscode' get a no-op object instead of crashing.
 *
 * Usage:
 *   mocha --require dist/test/vscode-mock.js ...test files...
 */

/* eslint-disable @typescript-eslint/no-require-imports */
import Module = require('module');

const stub = {
    workspace: {
        getConfiguration: () => ({
            get: (_key: string, defaultValue?: unknown) => defaultValue,
            update: () => Promise.resolve(),
            has: () => false,
            inspect: () => undefined,
        }),
        workspaceFolders: [],
        onDidChangeConfiguration: () => ({ dispose: () => {} }),
        onDidChangeWorkspaceFolders: () => ({ dispose: () => {} }),
        onDidSaveTextDocument: () => ({ dispose: () => {} }),
        fs: {
            readFile: () => Promise.resolve(Buffer.from('')),
            writeFile: () => Promise.resolve(),
            stat: () => Promise.resolve({ type: 1, size: 0, ctime: 0, mtime: 0 }),
        },
    },
    window: {
        showInformationMessage: () => Promise.resolve(undefined),
        showWarningMessage: () => Promise.resolve(undefined),
        showErrorMessage: () => Promise.resolve(undefined),
        createOutputChannel: () => ({ appendLine: () => {}, show: () => {}, dispose: () => {} }),
        activeTextEditor: undefined,
        onDidChangeActiveTextEditor: () => ({ dispose: () => {} }),
    },
    commands: {
        registerCommand: () => ({ dispose: () => {} }),
        executeCommand: () => Promise.resolve(undefined),
    },
    Uri: {
        file: (p: string) => ({ fsPath: p, scheme: 'file', path: p }),
        parse: (s: string) => ({ fsPath: s, scheme: 'file', path: s }),
    },
    EventEmitter: class {
        event = () => ({ dispose: () => {} });
        fire() {}
        dispose() {}
    },
    ThemeIcon: class { constructor(public id: string) {} },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ExtensionContext: class {},
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ViewColumn: { One: 1, Two: 2, Three: 3, Active: -1 },
    env: { machineId: 'test-machine', sessionId: 'test-session' },
    version: '1.80.0',
};

// Register the stub so any require('vscode') call resolves to it
const resolvedPath = 'vscode';
(Module as any)._resolveFilename = ((original: Function) =>
    function(this: unknown, request: string, ...args: unknown[]) {
        if (request === 'vscode') { return resolvedPath; }
        return original.call(this, request, ...args);
    }
)((Module as any)._resolveFilename);

require.cache[resolvedPath] = {
    id: resolvedPath,
    filename: resolvedPath,
    loaded: true,
    exports: stub,
    paths: [],
    children: [],
    parent: null,
    path: '',
} as any;
