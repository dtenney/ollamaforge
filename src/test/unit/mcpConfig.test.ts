import * as assert from 'assert';

// Replicate validateConfig from mcpConfig.ts (not exported) for unit testing
function validateConfig(cfg: any): cfg is { name: string; command: string; args: string[] } {
    return cfg &&
           typeof cfg.name === 'string' && cfg.name.length > 0 &&
           typeof cfg.command === 'string' && cfg.command.length > 0 &&
           Array.isArray(cfg.args);
}

describe('mcpConfig', () => {

    describe('validateConfig', () => {
        it('accepts a valid config', () => {
            const cfg = { name: 'filesystem', command: 'npx', args: ['-y', 'server-fs', '/tmp'] };
            assert.strictEqual(validateConfig(cfg), true);
        });

        it('rejects missing name', () => {
            assert.strictEqual(validateConfig({ command: 'npx', args: [] }), false);
        });

        it('rejects empty name', () => {
            assert.strictEqual(validateConfig({ name: '', command: 'npx', args: [] }), false);
        });

        it('rejects missing command', () => {
            assert.strictEqual(validateConfig({ name: 'fs', args: [] }), false);
        });

        it('rejects empty command', () => {
            assert.strictEqual(validateConfig({ name: 'fs', command: '', args: [] }), false);
        });

        it('rejects non-array args', () => {
            assert.strictEqual(validateConfig({ name: 'fs', command: 'npx', args: 'not-array' }), false);
        });

        it('rejects null', () => {
            assert.ok(!validateConfig(null));
        });

        it('rejects undefined', () => {
            assert.ok(!validateConfig(undefined));
        });

        it('accepts config with optional allowedTools', () => {
            const cfg = { name: 'fs', command: 'npx', args: [], allowedTools: ['read_file'] };
            assert.strictEqual(validateConfig(cfg), true);
        });

        it('accepts config with optional env', () => {
            const cfg = { name: 'fs', command: 'npx', args: [], env: { KEY: 'val' } };
            assert.strictEqual(validateConfig(cfg), true);
        });
    });
});
