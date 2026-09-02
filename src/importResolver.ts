/**
 * importResolver.ts — Three-valued import validation (inspired by hedgemony)
 *
 * After the agent writes or edits a Python file, we extract every top-level
 * import and ask the interpreter (via `importlib.util.find_spec`) whether each
 * module actually exists. The result is three-valued:
 *
 *   true   — module resolved successfully (exists in the environment)
 *   false  — module NOT found (ModuleNotFoundError) → hallucinated package
 *   null   — could not settle (find_spec returned None, subprocess failed,
 *            timeout, or the module is a relative import) → NEVER reported
 *            as a pass. Logged silently.
 *
 * The asymmetry is the insight: a false "invented" rewrites correct code with
 * no way to discover the error, while a missed fabrication still passes tests
 * downstream. So every ambiguous case resolves to silence.
 *
 * Only `false` results trigger a user-visible warning. `null` is logged but
 * silent. This is ~40 lines of logic + one subprocess call.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logInfo, logWarn } from './logger';

export type ImportStatus = true | false | null;

export interface ImportCheckResult {
    /** The module name that was checked (e.g. "pandas_pro", "os.pathlib") */
    module: string;
    /** Three-valued result: true=exists, false=missing, null=unknown */
    status: ImportStatus;
    /** Human-readable classification (hedgemony taxonomy) */
    classification: 'PACKAGE' | 'MODPATH' | 'IMPORT' | 'UNKNOWN';
}

export interface ImportValidationReport {
    /** All checks performed */
    results: ImportCheckResult[];
    /** Only the `false` results — these are the hallucinated imports */
    missing: ImportCheckResult[];
    /** Only the `null` results — logged but silent */
    unknown: ImportCheckResult[];
    /** True if at least one import was confirmed missing */
    hasMissing: boolean;
}

/**
 * Extract top-level import module names from Python source code.
 * Handles:
 *   import foo
 *   import foo.bar.baz
 *   from foo import bar
 *   from foo.bar import baz
 *   from . import foo        (relative — skipped, returns null)
 *   from .foo import bar     (relative — skipped, returns null)
 *
 * Does NOT handle:
 *   import foo as f          (we extract "foo", ignore the alias)
 *   try/except imports       (we still check the module name)
 *   conditional imports      (we still check the module name)
 */
function extractImportModules(source: string): string[] {
    const modules = new Set<string>();

    // Match: import foo, import foo.bar, import foo as f
    const importRe = /^\s*import\s+([\w.]+)(?:\s+as\s+\w+)?/gm;
    let m: RegExpExecArray | null;
    while ((m = importRe.exec(source)) !== null) {
        modules.add(m[1]);
    }

    // Match: from foo import bar, from foo.bar import baz
    // Skip relative imports (from . import x, from .foo import x)
    const fromRe = /^\s*from\s+([\w.]+)\s+import\s+/gm;
    while ((m = fromRe.exec(source)) !== null) {
        const mod = m[1];
        // Skip relative imports (they start with a dot, but our regex
        // already excludes dots — this is a safety check)
        if (!mod.startsWith('.')) {
            modules.add(mod);
        }
    }

    return Array.from(modules);
}

/**
 * Classify a missing import using the hedgemony 6-class taxonomy.
 * We only handle the 3 import-related classes (PACKAGE, MODPATH, IMPORT).
 * ATTR, KWARG, ARITY require runtime introspection and are out of scope here.
 */
function classifyMissing(module: string): 'PACKAGE' | 'MODPATH' | 'IMPORT' {
    const parts = module.split('.');
    if (parts.length === 1) {
        // Single-level import: "pandas_pro" → PACKAGE
        return 'PACKAGE';
    }
    // Multi-level: "os.pathlib" → MODPATH (submodule doesn't exist)
    // "numpy.tensor" → IMPORT (top-level exists, but the name is wrong)
    // We can't distinguish without checking the top-level, so default to MODPATH
    return 'MODPATH';
}

/**
 * Validate Python imports in a source string using the three-valued resolver.
 *
 * @param source    Python source code to check
 * @param pyCmd     Python executable (e.g. "python3", "python")
 * @param timeoutMs Subprocess timeout in milliseconds (default 5000)
 * @returns ImportValidationReport with per-module results
 */
export function validatePythonImports(
    source: string,
    pyCmd: string = 'python3',
    timeoutMs: number = 5000
): ImportValidationReport {
    const modules = extractImportModules(source);

    if (modules.length === 0) {
        return { results: [], missing: [], unknown: [], hasMissing: false };
    }

    // Build a Python script that checks each module via importlib.util.find_spec
    // and prints a JSON array of [module, status] pairs.
    // status: 1 = found, 0 = not found, -1 = unknown (find_spec returned None)
    const moduleList = JSON.stringify(modules);
    const pyScript = `
import importlib.util, json, sys
modules = ${moduleList}
results = []
for mod in modules:
    try:
        spec = importlib.util.find_spec(mod)
        if spec is not None:
            results.append([mod, 1])
        else:
            # find_spec returns None (not an exception) for a missing TOP-LEVEL
            # package — that is a confirmed hallucination. For a SUBMODULE
            # (a.b.c) a None spec is ambiguous (parent may be a namespace
            # package), so it stays unknown.
            if '.' in mod:
                results.append([mod, -1])
            else:
                results.append([mod, 0])
    except ModuleNotFoundError:
        results.append([mod, 0])
    except Exception:
        results.append([mod, -1])
print(json.dumps(results))
`;

    let parsed: [string, number][];
    try {
        const stdout = execFileSync(pyCmd, ['-c', pyScript], {
            encoding: 'utf8',
            timeout: timeoutMs,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        parsed = JSON.parse(stdout.trim());
    } catch (err: unknown) {
        // Subprocess failed (timeout, python not found, syntax error, etc.)
        // All modules are UNKNOWN — never reported as a pass.
        logWarn(`[importResolver] subprocess failed: ${err instanceof Error ? err.message : String(err)}`);
        const allUnknown: ImportCheckResult[] = modules.map(mod => ({
            module: mod,
            status: null,
            classification: 'UNKNOWN',
        }));
        return {
            results: allUnknown,
            missing: [],
            unknown: allUnknown,
            hasMissing: false,
        };
    }

    const results: ImportCheckResult[] = parsed.map(([mod, status]) => {
        if (status === 1) {
            return { module: mod, status: true, classification: 'UNKNOWN' };
        } else if (status === 0) {
            return { module: mod, status: false, classification: classifyMissing(mod) };
        } else {
            return { module: mod, status: null, classification: 'UNKNOWN' };
        }
    });

    const missing = results.filter(r => r.status === false);
    const unknown = results.filter(r => r.status === null);

    if (missing.length > 0) {
        logWarn(`[importResolver] ${missing.length} missing import(s): ${missing.map(m => m.module).join(', ')}`);
    }
    if (unknown.length > 0) {
        logInfo(`[importResolver] ${unknown.length} unknown import(s) (silently skipped): ${unknown.map(u => u.module).join(', ')}`);
    }

    return {
        results,
        missing,
        unknown,
        hasMissing: missing.length > 0,
    };
}

/**
 * Format the validation report as a user-visible warning string.
 * Only called when `report.hasMissing` is true.
 */
// ── Doctest contract checking (hedgemony Rec #2) ─────────────────────────────

export interface DoctestResult {
    /** The doctest example that failed (e.g. ">>> add(1, 2)") */
    example: string;
    /** The error or mismatch description */
    error: string;
}

export interface DoctestReport {
    /** Total doctest examples found */
    total: number;
    /** Examples that failed */
    failures: DoctestResult[];
    /** True if at least one doctest failed */
    hasFailures: boolean;
    /** True if no doctests were found (nothing to check) */
    noDoctests: boolean;
}

/**
 * Extract `>>>` doctest examples from Python source and run them in a
 * subprocess. Returns a report of any failures.
 *
 * Strategy: write the source to a temp file, then run
 *   python3 -m doctest <tempfile> --report-failures
 * with a 5-second timeout. If the file has no doctests, doctest exits 0
 * with no output.
 */
export function validateDoctests(
    source: string,
    pyCmd: string = 'python3',
    timeoutMs: number = 5000
): DoctestReport {
    // Quick check: does the source even contain doctest examples?
    if (!source.includes('>>>')) {
        return { total: 0, failures: [], hasFailures: false, noDoctests: true };
    }

    // Write source to a temp file so doctest can run against it
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctest-'));
    const tmpFile = path.join(tmpDir, 'module_under_test.py');
    fs.writeFileSync(tmpFile, source, 'utf8');

    try {
        // doctest.testfile does NOT execute the module body, so top-level
        // names (functions, classes) are undefined and every example fails
        // with NameError. Load the module first, then run doctests on it.
        const pyDoctest = [
            'import sys, doctest',
            `sys.path.insert(0, ${JSON.stringify(tmpDir)})`,
            'import module_under_test as _m',
            'r = doctest.testmod(_m, verbose=False)',
            'print(f"DOCTEST {r.failed} {r.attempted}")',
            'sys.exit(1 if r.failed else 0)',
        ].join('\n');
        const result = execFileSync(pyCmd, ['-c', pyDoctest], {
            encoding: 'utf8',
            timeout: timeoutMs,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        // doctest exited 0 — all passed
        return { total: countDoctestExamples(source), failures: [], hasFailures: false, noDoctests: false };
    } catch (err: unknown) {
        // doctest exited non-zero — parse the failure output
        const output = err instanceof Error && 'stdout' in err
            ? String((err as any).stdout ?? '') + String((err as any).stderr ?? '')
            : (err instanceof Error ? err.message : String(err));

        const failures: DoctestResult[] = [];
        // Parse lines like:
        //   Failed example:
        //       >>> add(1, 2)
        //   Expected:
        //       3
        //   Got:
        //       4
        const exampleRe = /Failed example:\s*\n\s*(>>> .+)/g;
        let m: RegExpExecArray | null;
        while ((m = exampleRe.exec(output)) !== null) {
            failures.push({ example: m[1].trim(), error: 'output mismatch or exception' });
        }
        // Fallback: if we couldn't parse specific examples, report the raw error
        if (failures.length === 0 && output.trim()) {
            failures.push({ example: '(doctest failure)', error: output.trim().slice(0, 200) });
        }

        logWarn(`[importResolver] doctest: ${failures.length} failure(s) in ${tmpFile}`);
        return {
            total: countDoctestExamples(source),
            failures,
            hasFailures: failures.length > 0,
            noDoctests: false,
        };
    } finally {
        // Clean up temp file
        try { fs.unlinkSync(tmpFile); fs.rmdirSync(tmpDir); } catch { /* ignore */ }
    }
}

function countDoctestExamples(source: string): number {
    const matches = source.match(/^>>> /gm);
    return matches ? matches.length : 0;
}

/**
 * Format doctest failures as a user-visible warning string.
 */
export function formatDoctestWarning(report: DoctestReport, filePath: string): string {
    const lines: string[] = [];
    lines.push(`WARNING -- ${filePath} has ${report.failures.length} doctest example(s) that FAIL:`);
    lines.push('');
    for (const f of report.failures) {
        lines.push(`  ${f.example}`);
        lines.push(`    → ${f.error}`);
    }
    lines.push('');
    lines.push('The function signature looks right but the behavior is wrong.');
    lines.push('Fix the implementation to match the documented examples, or correct the examples if they are wrong.');
    return lines.join('\n');
}

export function formatImportWarning(report: ImportValidationReport, filePath: string): string {
    const lines: string[] = [];
    lines.push(`WARNING -- ${filePath} contains ${report.missing.length} import(s) that do not exist in this environment:`);
    lines.push('');
    for (const m of report.missing) {
        lines.push(`  [${m.classification}] ${m.module}`);
    }
    lines.push('');
    lines.push('These are likely hallucinated package names. Do NOT retry write_file with the whole file.');
    lines.push('Instead:');
    lines.push('1. Verify the correct package name (check docs or `pip list`)');
    lines.push('2. edit_file to replace ONLY the bad import line(s)');
    lines.push('3. run_command "python3 -c \\"import <correct_module>\\"" to confirm');
    lines.push('');
    if (report.unknown.length > 0) {
        lines.push(`Note: ${report.unknown.length} import(s) could not be verified (silently skipped): ${report.unknown.map(u => u.module).join(', ')}`);
    }
    return lines.join('\n');
}

// ── Registry probe (hedgemony Rec #4) ────────────────────────────────────────
// Opt-in (ollamaForge.registryCheck). Probes PyPI/npm to confirm a package
// name exists. Network is OFF by default.

export interface RegistryProbeResult {
    pkg: string;
    registry: 'pypi' | 'npm';
    /** true=found, false=not found, null=unknown (network error/timeout) */
    exists: boolean | null;
}

function httpGetStatus(url: string, timeoutMs: number): Promise<number> {
    const mod = url.startsWith('https') ? require('https') : require('http');
    return new Promise<number>((resolve) => {
        const req = mod.get(url, (res: any) => {
            resolve(res.statusCode ?? 0);
            res.resume();
        });
        req.on('error', () => resolve(0));
        req.setTimeout(timeoutMs, () => { req.destroy(); resolve(0); });
    });
}

/**
 * Probe PyPI/npm for a package name. Returns null (unknown) on any network
 * failure — never reported as "not found".
 */
export async function probeRegistry(pkg: string, registry: 'pypi' | 'npm', timeoutMs = 3000): Promise<RegistryProbeResult> {
    const url = registry === 'pypi'
        ? `https://pypi.org/pypi/${encodeURIComponent(pkg)}/json`
        : `https://registry.npmjs.org/${encodeURIComponent(pkg)}`;
    const status = await httpGetStatus(url, timeoutMs);
    if (status === 200) return { pkg, registry, exists: true };
    if (status === 404) return { pkg, registry, exists: false };
    return { pkg, registry, exists: null }; // network error / timeout → unknown
}

export function formatRegistryWarning(results: RegistryProbeResult[], filePath: string): string {
    const missing = results.filter(r => r.exists === false);
    const lines: string[] = [];
    lines.push(`WARNING -- ${filePath} references ${missing.length} package(s) not found on the registry:`);
    lines.push('');
    for (const m of missing) {
        lines.push(`  [${m.registry.toUpperCase()}] ${m.pkg}`);
    }
    lines.push('');
    lines.push('These may be typos. Verify the correct name before installing.');
    return lines.join('\n');
}
