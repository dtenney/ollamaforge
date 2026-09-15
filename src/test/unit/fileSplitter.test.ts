import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { analyzeFile } from '../../fileSplitter';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTempFile(content: string, ext = '.py'): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'split-test-'));
    const file = path.join(dir, `test${ext}`);
    fs.writeFileSync(file, content, 'utf8');
    return file;
}

function cleanup(file: string) {
    const dir = path.dirname(file);
    fs.rmSync(dir, { recursive: true, force: true });
}

// ── Flask detection ───────────────────────────────────────────────────────────

describe('fileSplitter.analyzeFile', () => {

    describe('Flask blueprint detection', () => {
        it('detects Flask framework and blueprint var', () => {
            const src = `from flask import Blueprint
bp = Blueprint('reports', __name__)

@bp.route('/analytics/data')
def get_data():
    return {'ok': True}

@bp.route('/analytics/summary')
def get_summary():
    return {'ok': True}
`;
            const file = makeTempFile(src);
            try {
                const plan = analyzeFile(file);
                assert.equal(plan.language, 'python');
                assert.equal(plan.framework, 'flask');
                assert.equal(plan.originalBlueprint, 'bp');
                assert.equal(plan.originalBlueprintName, 'reports');
                assert.ok(plan.splits.length >= 1);
            } finally { cleanup(file); }
        });

        it('groups routes by first path segment', () => {
            const src = `from flask import Blueprint
bp = Blueprint('api', __name__)

@bp.route('/analytics/data')
def get_data():
    return 1

@bp.route('/analytics/summary')
def get_summary():
    return 2

@bp.route('/sales/orders')
def get_orders():
    return 3

@bp.route('/sales/revenue')
def get_revenue():
    return 4
`;
            const file = makeTempFile(src);
            try {
                const plan = analyzeFile(file);
                const names = plan.splits.map(s => s.name);
                assert.ok(names.includes('analytics'), `expected 'analytics' in ${names}`);
                assert.ok(names.includes('sales'), `expected 'sales' in ${names}`);
            } finally { cleanup(file); }
        });

        it('assigns blueprintVar to each split', () => {
            const src = `from flask import Blueprint
bp = Blueprint('api', __name__)

@bp.route('/analytics/a')
def a():
    return 1

@bp.route('/analytics/b')
def b():
    return 2
`;
            const file = makeTempFile(src);
            try {
                const plan = analyzeFile(file);
                for (const s of plan.splits) {
                    assert.equal(s.blueprintVar, `${s.name}_bp`);
                }
            } finally { cleanup(file); }
        });

        it('includes header lines (imports + Blueprint) in plan', () => {
            const src = `from flask import Blueprint
bp = Blueprint('api', __name__)

@bp.route('/x/y')
def x():
    return 1

@bp.route('/x/z')
def z():
    return 2
`;
            const file = makeTempFile(src);
            try {
                const plan = analyzeFile(file);
                assert.ok(plan.headerLines.some(l => l.includes('Blueprint')));
                assert.ok(plan.headerLines.some(l => l.includes('from flask')));
            } finally { cleanup(file); }
        });
    });

    // ── Generic Python ────────────────────────────────────────────────────────

    describe('Generic Python (no framework)', () => {
        it('detects python language with no framework', () => {
            const src = `import os
import sys

def helper():
    return 1

def main():
    return helper()
`;
            const file = makeTempFile(src);
            try {
                const plan = analyzeFile(file);
                assert.equal(plan.language, 'python');
                assert.equal(plan.framework, 'none');
            } finally { cleanup(file); }
        });

        it('parses top-level functions', () => {
            const src = `import os

def alpha():
    return 1

def beta():
    return 2
`;
            const file = makeTempFile(src);
            try {
                const plan = analyzeFile(file);
                const allFns = plan.splits.flatMap(s => s.functions);
                assert.ok(allFns.includes('alpha'));
                assert.ok(allFns.includes('beta'));
            } finally { cleanup(file); }
        });
    });

    // ── TypeScript / Express ──────────────────────────────────────────────────

    describe('TypeScript / Express', () => {
        it('detects express framework', () => {
            const src = `import express from 'express';
const router = express.Router();

router.get('/users', (req, res) => {
    res.json([]);
});

router.post('/users', (req, res) => {
    res.json({});
});
`;
            const file = makeTempFile(src, '.ts');
            try {
                const plan = analyzeFile(file);
                assert.equal(plan.framework, 'express');
                assert.ok(['typescript', 'javascript'].includes(plan.language));
            } finally { cleanup(file); }
        });

        it('parses router methods as items', () => {
            const src = `import express from 'express';
const router = express.Router();

router.get('/items', (req, res) => {
    res.json([]);
});

router.post('/items', (req, res) => {
    res.json({});
});
`;
            const file = makeTempFile(src, '.ts');
            try {
                const plan = analyzeFile(file);
                const allFns = plan.splits.flatMap(s => s.functions);
                assert.ok(allFns.some(f => f.includes('GET /items') || f.includes('items')));
            } finally { cleanup(file); }
        });
    });

    // ── Edge cases ────────────────────────────────────────────────────────────

    describe('Edge cases', () => {
        it('handles a file with no functions (empty body)', () => {
            const src = `import os
`;
            const file = makeTempFile(src);
            try {
                const plan = analyzeFile(file);
                assert.equal(plan.splits.length, 0);
            } finally { cleanup(file); }
        });

        it('handles unknown language', () => {
            const src = `;; some lisp code
(defun hello ()
  (format t "hi"))
`;
            const file = makeTempFile(src, '.lisp');
            try {
                const plan = analyzeFile(file);
                assert.equal(plan.language, 'unknown');
                assert.equal(plan.framework, 'none');
                assert.equal(plan.splits.length, 0);
            } finally { cleanup(file); }
        });

        it('generates non-colliding output filenames', () => {
            // Source file is "analytics_api.py" — split named "analytics" would collide
            const src = `from flask import Blueprint
bp = Blueprint('api', __name__)

@bp.route('/analytics/a')
def a():
    return 1

@bp.route('/analytics/b')
def b():
    return 2
`;
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'split-collide-'));
            const file = path.join(dir, 'analytics_api.py');
            fs.writeFileSync(file, src, 'utf8');
            try {
                const plan = analyzeFile(file, dir);
                for (const s of plan.splits) {
                    // The output should NOT be the same as the source filename
                    assert.notEqual(
                        path.basename(s.outputFile),
                        'analytics_api.py',
                        `output ${s.outputFile} collides with source`
                    );
                }
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });

        it('respects workspaceRoot for relative paths', () => {
            const src = `from flask import Blueprint
bp = Blueprint('api', __name__)

@bp.route('/x/a')
def a():
    return 1

@bp.route('/x/b')
def b():
    return 2
`;
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'split-ws-'));
            const sub = path.join(dir, 'routes');
            fs.mkdirSync(sub, { recursive: true });
            const file = path.join(sub, 'api.py');
            fs.writeFileSync(file, src, 'utf8');
            try {
                const plan = analyzeFile(file, dir);
                assert.equal(plan.relPath, 'routes/api.py');
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });
    });
});
