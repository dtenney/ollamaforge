import { strict as assert } from 'assert';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { isOsProtectedPath, safePath } from '../../pathPolicy';

describe('pathPolicy', () => {

    describe('isOsProtectedPath', () => {
        it('blocks /etc/passwd', () => {
            assert.ok(isOsProtectedPath('/etc/passwd'));
        });

        it('blocks /proc/self/status', () => {
            assert.ok(isOsProtectedPath('/proc/self/status'));
        });

        it('blocks /sys/kernel', () => {
            assert.ok(isOsProtectedPath('/sys/kernel'));
        });

        it('blocks /dev/null', () => {
            assert.ok(isOsProtectedPath('/dev/null'));
        });

        it('blocks macOS /private/etc/hosts', () => {
            assert.ok(isOsProtectedPath('/private/etc/hosts'));
        });

        it('blocks macOS /private/var/log', () => {
            assert.ok(isOsProtectedPath('/private/var/log'));
        });

        it('blocks /boot/grub', () => {
            assert.ok(isOsProtectedPath('/boot/grub'));
        });

        it('blocks /lib/x86_64', () => {
            assert.ok(isOsProtectedPath('/lib/x86_64'));
        });

        it('blocks /lib64/ld-linux', () => {
            assert.ok(isOsProtectedPath('/lib64/ld-linux'));
        });

        it('blocks /usr/lib/x86_64', () => {
            assert.ok(isOsProtectedPath('/usr/lib/x86_64'));
        });

        // Note: Windows drive-letter paths (C:\Windows\...) are NOT matched by the
        // current BLOCKED list (entries use /windows/... without a drive prefix).
        // These tests document the actual behavior.
        it('does not block Windows drive-letter paths (known limitation)', () => {
            assert.ok(!isOsProtectedPath('C:/Windows/System32/cmd.exe'));
        });

        it('allows a normal workspace path', () => {
            assert.ok(!isOsProtectedPath('/home/user/project/src/main.ts'));
        });

        it('allows a path that merely contains "etc" as a substring', () => {
            assert.ok(!isOsProtectedPath('/home/user/project/etc-config.txt'));
        });

        it('allows /etc as exact match (no trailing slash)', () => {
            // /etc/ is blocked, but /etc itself should also be blocked
            assert.ok(isOsProtectedPath('/etc'));
        });

        it('normalizes backslashes (Unix paths with backslashes)', () => {
            // Backslash normalization works for Unix-style paths
            assert.ok(isOsProtectedPath('/etc\\passwd'));
        });

        it('is case-insensitive', () => {
            assert.ok(isOsProtectedPath('/ETC/PASSWD'));
            assert.ok(isOsProtectedPath('/PROC/SELF'));
        });

        it('allows a path under /usr but not /usr/lib', () => {
            assert.ok(!isOsProtectedPath('/usr/local/bin/node'));
        });
    });

    describe('safePath', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pathpolicy-'));

        after(() => {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('resolves a relative path inside the workspace', () => {
            const result = safePath(tmpDir, 'src/main.ts');
            assert.equal(result, path.resolve(tmpDir, 'src/main.ts'));
        });

        it('resolves a dot path to the workspace root', () => {
            const result = safePath(tmpDir, '.');
            assert.equal(result, path.resolve(tmpDir));
        });

        it('resolves a subdirectory path', () => {
            const result = safePath(tmpDir, 'src/test/unit/file.ts');
            assert.equal(result, path.resolve(tmpDir, 'src/test/unit/file.ts'));
        });

        it('throws for a path that escapes via ..', () => {
            assert.throws(() => safePath(tmpDir, '../../etc/passwd'), /outside the workspace/);
        });

        it('throws for an absolute path outside the workspace', () => {
            assert.throws(() => safePath(tmpDir, '/etc/passwd'), /outside the workspace/);
        });

        it('throws for a path that escapes via mixed ..', () => {
            assert.throws(() => safePath(tmpDir, 'src/../../etc/shadow'), /outside the workspace/);
        });

        it('allows a path that uses .. but stays inside', () => {
            // src/../src/main.ts resolves to src/main.ts which is inside
            const result = safePath(tmpDir, 'src/../src/main.ts');
            assert.equal(result, path.resolve(tmpDir, 'src/main.ts'));
        });

        it('handles forward-slash paths on Windows', () => {
            const result = safePath(tmpDir, 'src/main.ts');
            assert.ok(result.includes('src'));
        });

        it('throws for a clearly outside absolute path', () => {
            const outside = process.platform === 'win32' ? 'C:\\temp\\outside.txt' : '/tmp/outside.txt';
            assert.throws(() => safePath(tmpDir, outside), /outside the workspace/);
        });
    });
});
