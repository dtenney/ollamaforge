import { strict as assert } from 'assert';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { findTestFile } from '../../verification';

describe('verification', () => {

    describe('findTestFile', () => {
        let tmpDir: string;

        beforeEach(() => {
            tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-'));
        });

        afterEach(() => {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('returns null when workspace root is empty', () => {
            assert.equal(findTestFile('/some/file.py', ''), null);
        });

        it('returns null when no test file exists', () => {
            const srcFile = path.join(tmpDir, 'src', 'app.py');
            fs.mkdirSync(path.dirname(srcFile), { recursive: true });
            fs.writeFileSync(srcFile, 'print("hi")');
            assert.equal(findTestFile(srcFile, tmpDir), null);
        });

        it('finds test_<name>.py in the same directory', () => {
            const srcFile = path.join(tmpDir, 'src', 'app.py');
            const testFile = path.join(tmpDir, 'src', 'test_app.py');
            fs.mkdirSync(path.dirname(srcFile), { recursive: true });
            fs.writeFileSync(srcFile, 'print("hi")');
            fs.writeFileSync(testFile, 'def test_app(): pass');
            assert.equal(findTestFile(srcFile, tmpDir), testFile);
        });

        it('finds <name>_test.py in the same directory', () => {
            const srcFile = path.join(tmpDir, 'src', 'app.py');
            const testFile = path.join(tmpDir, 'src', 'app_test.py');
            fs.mkdirSync(path.dirname(srcFile), { recursive: true });
            fs.writeFileSync(srcFile, 'print("hi")');
            fs.writeFileSync(testFile, 'def test_app(): pass');
            assert.equal(findTestFile(srcFile, tmpDir), testFile);
        });

        it('finds test_<name>.py in tests/ at project root', () => {
            const srcFile = path.join(tmpDir, 'src', 'app.py');
            const testFile = path.join(tmpDir, 'tests', 'test_app.py');
            fs.mkdirSync(path.dirname(srcFile), { recursive: true });
            fs.mkdirSync(path.dirname(testFile), { recursive: true });
            fs.writeFileSync(srcFile, 'print("hi")');
            fs.writeFileSync(testFile, 'def test_app(): pass');
            assert.equal(findTestFile(srcFile, tmpDir), testFile);
        });

        it('finds <name>.test.ts in the same directory', () => {
            const srcFile = path.join(tmpDir, 'src', 'app.ts');
            const testFile = path.join(tmpDir, 'src', 'app.test.ts');
            fs.mkdirSync(path.dirname(srcFile), { recursive: true });
            fs.writeFileSync(srcFile, 'export const x = 1;');
            fs.writeFileSync(testFile, 'import { x } from "./app";');
            assert.equal(findTestFile(srcFile, tmpDir), testFile);
        });

        it('finds <name>.spec.ts in the same directory', () => {
            const srcFile = path.join(tmpDir, 'src', 'app.ts');
            const testFile = path.join(tmpDir, 'src', 'app.spec.ts');
            fs.mkdirSync(path.dirname(srcFile), { recursive: true });
            fs.writeFileSync(srcFile, 'export const x = 1;');
            fs.writeFileSync(testFile, 'import { x } from "./app";');
            assert.equal(findTestFile(srcFile, tmpDir), testFile);
        });

        it('finds <name>.test.js in the same directory', () => {
            const srcFile = path.join(tmpDir, 'src', 'app.js');
            const testFile = path.join(tmpDir, 'src', 'app.test.js');
            fs.mkdirSync(path.dirname(srcFile), { recursive: true });
            fs.writeFileSync(srcFile, 'module.exports = 1;');
            fs.writeFileSync(testFile, 'const x = require("./app");');
            assert.equal(findTestFile(srcFile, tmpDir), testFile);
        });

        it('finds test in __tests__ directory for TS', () => {
            const srcFile = path.join(tmpDir, 'src', 'app.ts');
            const testFile = path.join(tmpDir, 'src', '__tests__', 'app.test.ts');
            fs.mkdirSync(path.dirname(srcFile), { recursive: true });
            fs.mkdirSync(path.dirname(testFile), { recursive: true });
            fs.writeFileSync(srcFile, 'export const x = 1;');
            fs.writeFileSync(testFile, 'import { x } from "../app";');
            assert.equal(findTestFile(srcFile, tmpDir), testFile);
        });

        it('prefers same-directory test over tests/ directory', () => {
            const srcFile = path.join(tmpDir, 'src', 'app.py');
            const sameDirTest = path.join(tmpDir, 'src', 'test_app.py');
            const rootTest = path.join(tmpDir, 'tests', 'test_app.py');
            fs.mkdirSync(path.dirname(srcFile), { recursive: true });
            fs.mkdirSync(path.dirname(rootTest), { recursive: true });
            fs.writeFileSync(srcFile, 'print("hi")');
            fs.writeFileSync(sameDirTest, 'def test_app(): pass');
            fs.writeFileSync(rootTest, 'def test_app(): pass');
            // Same directory should be found first
            assert.equal(findTestFile(srcFile, tmpDir), sameDirTest);
        });

        it('returns null for unsupported file extensions', () => {
            const srcFile = path.join(tmpDir, 'README.md');
            fs.writeFileSync(srcFile, '# Hello');
            assert.equal(findTestFile(srcFile, tmpDir), null);
        });

        it('returns null for .rs files (no test pattern defined)', () => {
            const srcFile = path.join(tmpDir, 'main.rs');
            fs.writeFileSync(srcFile, 'fn main() {}');
            assert.equal(findTestFile(srcFile, tmpDir), null);
        });
    });
});
