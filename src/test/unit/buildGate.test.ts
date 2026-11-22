import { strict as assert } from 'assert';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { detectTestCommand, runBuildGate } from '../../buildGate';

describe('buildGate', () => {

    describe('detectTestCommand', () => {
        it('returns null when workspaceRoot is empty', () => {
            assert.equal(detectTestCommand(''), null);
        });

        it('returns null when package.json is absent', () => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-'));
            try {
                assert.equal(detectTestCommand(dir), null);
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });

        it('returns "npm test" when scripts.test exists', () => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-'));
            try {
                fs.writeFileSync(path.join(dir, 'package.json'),
                    JSON.stringify({ name: 'x', scripts: { test: 'mocha' } }));
                assert.equal(detectTestCommand(dir), 'npm test');
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });

        it('falls back to "npm run test:unit" when only test:unit exists', () => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-'));
            try {
                fs.writeFileSync(path.join(dir, 'package.json'),
                    JSON.stringify({ name: 'x', scripts: { 'test:unit': 'mocha' } }));
                assert.equal(detectTestCommand(dir), 'npm run test:unit');
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });

        it('returns null when scripts has no test entry', () => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-'));
            try {
                fs.writeFileSync(path.join(dir, 'package.json'),
                    JSON.stringify({ name: 'x', scripts: { build: 'esbuild' } }));
                assert.equal(detectTestCommand(dir), null);
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });

        it('returns null on malformed package.json', () => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-'));
            try {
                fs.writeFileSync(path.join(dir, 'package.json'), '{ not json');
                assert.equal(detectTestCommand(dir), null);
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });
    });

    describe('runBuildGate', () => {
        it('is a no-op (ran=false) when no test command is detected', () => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-'));
            try {
                const res = runBuildGate(dir);
                assert.equal(res.ran, false);
                assert.equal(res.passed, true);
                assert.equal(res.command, null);
                assert.equal(res.feedback, null);
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });

        it('reports passed=true when the test command exits 0', () => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-'));
            try {
                // Use a trivially-passing command via a fake "test" script.
                fs.writeFileSync(path.join(dir, 'package.json'),
                    JSON.stringify({ name: 'x', scripts: { test: 'node -e "process.exit(0)"' } }));
                const res = runBuildGate(dir);
                assert.equal(res.ran, true);
                assert.equal(res.passed, true);
                assert.equal(res.feedback, null);
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });

        it('reports passed=false with feedback when the test command fails', () => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-'));
            try {
                fs.writeFileSync(path.join(dir, 'package.json'),
                    JSON.stringify({ name: 'x', scripts: { test: 'node -e "console.error(\'boom\'); process.exit(1)"' } }));
                const res = runBuildGate(dir);
                assert.equal(res.ran, true);
                assert.equal(res.passed, false);
                assert.ok(res.feedback && res.feedback.includes('FAILED'));
                assert.ok(res.feedback!.includes('boom'));
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });
    });
});
