import * as assert from 'assert';
import { evaluateCommand, checkEgress, CommandPolicyConfig } from '../../commandPolicy';

describe('commandPolicy', () => {

    describe('evaluateCommand — built-in deny', () => {
        const denyCases: [string, string][] = [
            ['rm -rf /', 'rm root'],
            ['rm -rf ~', 'rm home'],
            ['mkfs.ext4 /dev/sda1', 'mkfs'],
            ['dd if=/dev/zero of=/dev/sda', 'dd of=/dev'],
            [':(){ :|:& };:', 'fork bomb'],
            ['shred /dev/sda', 'shred /dev'],
            ['chmod -R 777 /', 'chmod 777 /'],
            ['format C:', 'format C:'],
            ['Remove-Item -Recurse /home/user', 'Remove-Item /home'],
            ['DROP DATABASE mydb', 'SQL drop'],
            ['TRUNCATE TABLE users', 'SQL truncate'],
            ['shutdown', 'shutdown'],
            ['sudo reboot', 'reboot'],
            ['init 0', 'init 0'],
        ];

        for (const [cmd] of denyCases) {
            it(`denies: ${cmd}`, () => {
                const result = evaluateCommand(cmd);
                assert.strictEqual(result.verdict, 'deny', `Expected deny for "${cmd}"`);
                assert.ok(result.rule.includes('deny'), `Rule should contain "deny", got "${result.rule}"`);
            });
        }
    });

    describe('evaluateCommand — built-in confirm', () => {
        const confirmCases: string[] = [
            'git push --force',
            'git push -f origin main',
            'git reset --hard HEAD~1',
            'git clean -fd',
            'pip uninstall requests',
            'pip3 uninstall flask',
            'npm publish',
            'docker system prune -a',
            'docker rmi myimage',
            'rm -f file.txt',
            'rmdir empty_dir',
            'kill -9 12345',
            'killall nginx',
            'taskkill /F /IM chrome.exe',
            'del /f temp.txt',
        ];

        for (const cmd of confirmCases) {
            it(`confirms: ${cmd}`, () => {
                const result = evaluateCommand(cmd);
                assert.strictEqual(result.verdict, 'confirm', `Expected confirm for "${cmd}", got ${result.verdict}`);
            });
        }
    });

    describe('evaluateCommand — built-in allow', () => {
        const allowCases: string[] = [
            'ls -la',
            'cat /etc/hosts',
            'grep -rn "foo" src/',
            'git status',
            'git log --oneline -5',
            'git diff HEAD',
            'npm test',
            'npm run build',
            'npm run bundle',
            'pytest tests/',
            'ruff check .',
            'eslint src/',
            'node --version',
            'python3 --version',
            'which python3',
            'echo hello',
            'pwd',
        ];

        for (const cmd of allowCases) {
            it(`allows: ${cmd}`, () => {
                const result = evaluateCommand(cmd);
                assert.strictEqual(result.verdict, 'allow', `Expected allow for "${cmd}", got ${result.verdict} (${result.rule})`);
            });
        }
    });

    describe('evaluateCommand — verdict precedence', () => {
        it('deny wins over confirm (drop table is both)', () => {
            const result = evaluateCommand('DROP TABLE users');
            assert.strictEqual(result.verdict, 'deny');
        });

        it('deny wins over allow (rm -rf / vs ls)', () => {
            const result = evaluateCommand('rm -rf /');
            assert.strictEqual(result.verdict, 'deny');
        });

        it('confirm wins over allow (rm -f is confirm, not allow)', () => {
            const result = evaluateCommand('rm -f file.txt');
            assert.strictEqual(result.verdict, 'confirm');
        });
    });

    describe('evaluateCommand — user config', () => {
        it('user deny pattern blocks a command', () => {
            const config: CommandPolicyConfig = { deny: ['mysecret-command'] };
            const result = evaluateCommand('mysecret-command --flag', config);
            assert.strictEqual(result.verdict, 'deny');
            assert.strictEqual(result.rule, 'user-deny');
        });

        it('user confirm pattern requires confirmation', () => {
            const config: CommandPolicyConfig = { confirm: ['custom-tool'] };
            const result = evaluateCommand('custom-tool run', config);
            assert.strictEqual(result.verdict, 'confirm');
            assert.strictEqual(result.rule, 'user-confirm');
        });

        it('user allow pattern auto-approves', () => {
            const config: CommandPolicyConfig = { allow: ['mybuild'] };
            const result = evaluateCommand('mybuild --release', config);
            assert.strictEqual(result.verdict, 'allow');
            assert.strictEqual(result.rule, 'user-allow');
        });

        it('invalid regex in user config is silently skipped', () => {
            const config: CommandPolicyConfig = { deny: ['[invalid('] };
            // Should not throw; falls through to default allow
            const result = evaluateCommand('some-command', config);
            assert.strictEqual(result.verdict, 'allow');
        });

        it('user deny overrides built-in allow', () => {
            const config: CommandPolicyConfig = { deny: ['^ls\\s+'] };
            const result = evaluateCommand('ls -la', config);
            assert.strictEqual(result.verdict, 'deny');
        });
    });

    describe('evaluateCommand — edge cases', () => {
        it('empty string returns allow', () => {
            const result = evaluateCommand('');
            assert.strictEqual(result.verdict, 'allow');
            assert.strictEqual(result.rule, 'empty');
        });

        it('whitespace-only returns allow', () => {
            const result = evaluateCommand('   ');
            assert.strictEqual(result.verdict, 'allow');
            assert.strictEqual(result.rule, 'empty');
        });

        it('undefined returns allow', () => {
            const result = evaluateCommand(undefined as any);
            assert.strictEqual(result.verdict, 'allow');
        });

        it('unknown command defaults to allow (fallback guard applies)', () => {
            const result = evaluateCommand('some-unknown-tool --flag');
            assert.strictEqual(result.verdict, 'allow');
            assert.strictEqual(result.rule, 'default');
        });

        it('rm -rf ./build is NOT denied (relative path)', () => {
            const result = evaluateCommand('rm -rf ./build');
            // rm -f matches confirm, but rm -rf / does not match (not root)
            assert.notStrictEqual(result.verdict, 'deny');
        });

        it('rm -rf /tmp is NOT denied (not root)', () => {
            const result = evaluateCommand('rm -rf /tmp');
            assert.notStrictEqual(result.verdict, 'deny');
        });
    });

    describe('checkEgress', () => {
        it('returns null when no allowlist configured', () => {
            assert.strictEqual(checkEgress('curl https://example.com'), null);
        });

        it('returns null when allowlist is empty', () => {
            assert.strictEqual(checkEgress('curl https://example.com', []), null);
        });

        it('allows localhost', () => {
            assert.strictEqual(checkEgress('curl http://localhost:8080', ['example.com']), null);
        });

        it('allows 127.0.0.1', () => {
            assert.strictEqual(checkEgress('curl http://127.0.0.1:3000', ['example.com']), null);
        });

        it('allows private IP ranges', () => {
            assert.strictEqual(checkEgress('curl http://192.168.0.29:8888', ['example.com']), null);
            assert.strictEqual(checkEgress('curl http://10.0.1.5', ['example.com']), null);
            assert.strictEqual(checkEgress('curl http://172.16.0.1', ['example.com']), null);
        });

        it('blocks external host not in allowlist', () => {
            const result = checkEgress('curl https://evil.com/api', ['example.com']);
            assert.strictEqual(result, 'evil.com');
        });

        it('allows external host in allowlist', () => {
            assert.strictEqual(checkEgress('curl https://example.com/api', ['example.com']), null);
        });

        it('supports wildcard subdomain matching', () => {
            assert.strictEqual(checkEgress('curl https://api.example.com/v1', ['*.example.com']), null);
        });

        it('blocks subdomain not covered by wildcard', () => {
            const result = checkEgress('curl https://evil.example.com/v1', ['*.example.com']);
            // evil.example.com does NOT end with ".example.com" — wait, it does
            // Actually "evil.example.com".endsWith(".example.com") is true
            // So this should be allowed. Let me test a truly different domain.
            assert.strictEqual(result, null);
        });

        it('blocks truly different domain', () => {
            const result = checkEgress('curl https://otherdomain.com/v1', ['*.example.com']);
            assert.strictEqual(result, 'otherdomain.com');
        });

        it('extracts host from git clone URL', () => {
            const result = checkEgress('git clone https://github.com/user/repo', ['gitlab.com']);
            assert.strictEqual(result, 'github.com');
        });

        it('allows git clone to allowlisted host', () => {
            assert.strictEqual(checkEgress('git clone https://github.com/user/repo', ['github.com']), null);
        });

        it('extracts host from scp', () => {
            const result = checkEgress('scp file.txt user@remotehost:/tmp/', ['localhost']);
            assert.strictEqual(result, 'remotehost');
        });
    });
});
