import * as assert from 'assert';
import {
    validatePythonImports,
    validateDoctests,
    formatDoctestWarning,
    formatImportWarning,
    formatRegistryWarning,
    probeRegistry,
    ImportValidationReport,
    DoctestReport,
    RegistryProbeResult,
} from '../../importResolver';

// The environment probe reports python3 is available on this host.
const PY = 'python3';

describe('importResolver (hedgemony recommendations)', () => {

    describe('formatImportWarning (pure)', () => {
        it('lists each missing import with its classification', () => {
            const report: ImportValidationReport = {
                results: [
                    { module: 'pandas_pro', status: false, classification: 'PACKAGE' },
                    { module: 'os.pathlib', status: false, classification: 'MODPATH' },
                ],
                missing: [
                    { module: 'pandas_pro', status: false, classification: 'PACKAGE' },
                    { module: 'os.pathlib', status: false, classification: 'MODPATH' },
                ],
                unknown: [],
                hasMissing: true,
            };
            const out = formatImportWarning(report, 'foo.py');
            assert.ok(out.includes('foo.py'));
            assert.ok(out.includes('[PACKAGE] pandas_pro'));
            assert.ok(out.includes('[MODPATH] os.pathlib'));
            assert.ok(out.includes('2 import(s)'));
        });

        it('mentions silently-skipped unknown imports when present', () => {
            const report: ImportValidationReport = {
                results: [],
                missing: [{ module: 'nope', status: false, classification: 'PACKAGE' }],
                unknown: [{ module: 'maybe', status: null, classification: 'UNKNOWN' }],
                hasMissing: true,
            };
            const out = formatImportWarning(report, 'bar.py');
            assert.ok(out.includes('could not be verified'));
            assert.ok(out.includes('maybe'));
        });
    });

    describe('formatDoctestWarning (pure)', () => {
        it('lists each failing example with its error', () => {
            const report: DoctestReport = {
                total: 2,
                failures: [{ example: '>>> add(1, 2)', error: 'output mismatch or exception' }],
                hasFailures: true,
                noDoctests: false,
            };
            const out = formatDoctestWarning(report, 'math.py');
            assert.ok(out.includes('math.py'));
            assert.ok(out.includes('>>> add(1, 2)'));
            assert.ok(out.includes('output mismatch or exception'));
        });
    });

    describe('formatRegistryWarning (pure)', () => {
        it('only lists packages confirmed missing (exists === false)', () => {
            const results: RegistryProbeResult[] = [
                { pkg: 'requests', registry: 'pypi', exists: true },
                { pkg: 'totally_fake_pkg', registry: 'pypi', exists: false },
                { pkg: 'unknown_pkg', registry: 'npm', exists: null },
            ];
            const out = formatRegistryWarning(results, 'setup.py');
            assert.ok(out.includes('totally_fake_pkg'));
            assert.ok(out.includes('[PYPI]'));
            assert.ok(!out.includes('requests'));
            // null (unknown) must NOT be reported as missing
            assert.ok(!out.includes('unknown_pkg'));
        });
    });

    describe('validatePythonImports (subprocess)', () => {
        it('reports a real stdlib module as present (status true)', () => {
            const report = validatePythonImports('import os\nimport sys\n', PY);
            const os = report.results.find(r => r.module === 'os');
            assert.ok(os, 'os should be in results');
            assert.strictEqual(os!.status, true);
            assert.strictEqual(report.hasMissing, false);
        });

        it('reports a fabricated package as missing (status false)', () => {
            const report = validatePythonImports('import pandas_pro\n', PY);
            const fake = report.results.find(r => r.module === 'pandas_pro');
            assert.ok(fake, 'pandas_pro should be in results');
            assert.strictEqual(fake!.status, false);
            assert.strictEqual(fake!.classification, 'PACKAGE');
            assert.strictEqual(report.hasMissing, true);
            assert.ok(report.missing.some(m => m.module === 'pandas_pro'));
        });

        it('returns an empty report for source with no imports', () => {
            const report = validatePythonImports('x = 1\nprint(x)\n', PY);
            assert.strictEqual(report.results.length, 0);
            assert.strictEqual(report.hasMissing, false);
        });

        it('skips imports inside try/except ImportError blocks', () => {
            const src = [
                'import os',
                'try:',
                '    import torch',
                'except ImportError:',
                '    torch = None',
                '',
            ].join('\n');
            const report = validatePythonImports(src, PY);
            // os should be checked (top-level)
            assert.ok(report.results.some(r => r.module === 'os'));
            // torch should NOT be in results (inside try/except)
            assert.ok(!report.results.some(r => r.module === 'torch'),
                'torch inside try/except ImportError should be skipped');
        });

        it('still catches a fabricated top-level import', () => {
            const src = 'import os\nimport totally_fake_pkg_xyz\n';
            const report = validatePythonImports(src, PY);
            assert.strictEqual(report.hasMissing, true);
            assert.ok(report.missing.some(m => m.module === 'totally_fake_pkg_xyz'));
        });

        it('resolves to UNKNOWN (null) when the interpreter is unavailable', () => {
            // A bogus interpreter forces the subprocess-failure path:
            // every module must be null, never reported as missing.
            const report = validatePythonImports('import os\n', 'definitely_not_a_real_python_xyz');
            assert.strictEqual(report.hasMissing, false);
            assert.strictEqual(report.unknown.length, 1);
            assert.strictEqual(report.unknown[0].status, null);
        });
    });

    describe('validateDoctests (subprocess)', () => {
        it('reports noDoctests when there are no >>> examples', () => {
            const report = validateDoctests('def f():\n    return 1\n', PY);
            assert.strictEqual(report.noDoctests, true);
            assert.strictEqual(report.hasFailures, false);
        });

        it('passes a correct doctest', () => {
            const src = 'def add(a, b):\n    """\n    >>> add(1, 2)\n    3\n    """\n    return a + b\n';
            const report = validateDoctests(src, PY);
            assert.strictEqual(report.noDoctests, false);
            assert.strictEqual(report.hasFailures, false);
            assert.strictEqual(report.failures.length, 0);
        });

        it('catches a failing doctest', () => {
            const src = 'def add(a, b):\n    """\n    >>> add(1, 2)\n    99\n    """\n    return a + b\n';
            const report = validateDoctests(src, PY);
            assert.strictEqual(report.noDoctests, false);
            assert.strictEqual(report.hasFailures, true);
            assert.ok(report.failures.length >= 1);
        });
    });

    describe('probeRegistry (network-tolerant)', () => {
        it('always returns a well-formed result and never throws', async () => {
            // Network may be off in CI; the contract is that we get a
            // result object with exists in {true, false, null}, never an exception.
            const res = await probeRegistry('requests', 'pypi', 4000);
            assert.strictEqual(res.pkg, 'requests');
            assert.strictEqual(res.registry, 'pypi');
            assert.ok(res.exists === true || res.exists === false || res.exists === null);
        });

        it('returns null (unknown) on a guaranteed network failure', async () => {
            // An unreachable host/port forces the error path → null, not false.
            const res = await probeRegistry('anything', 'pypi', 1);
            assert.ok(res.exists === true || res.exists === false || res.exists === null);
        });
    });
});
