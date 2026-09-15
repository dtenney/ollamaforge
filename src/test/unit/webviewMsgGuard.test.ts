import { strict as assert } from 'assert';
import { isValidWebviewMsg } from '../../webviewMsgGuard';

describe('webviewMsgGuard.isValidWebviewMsg', () => {
    // ── Valid messages ──────────────────────────────────────────────────────
    it('accepts a plain object with a non-empty string command', () => {
        assert.equal(isValidWebviewMsg({ command: 'sendMessage', text: 'hi' }), true);
    });

    it('accepts a command of length 1', () => {
        assert.equal(isValidWebviewMsg({ command: 'x' }), true);
    });

    it('accepts extra fields alongside command', () => {
        assert.equal(isValidWebviewMsg({ command: 'stopGeneration', extra: 42 }), true);
    });

    // ── Invalid: wrong types for the whole message ──────────────────────────
    it('rejects null', () => {
        assert.equal(isValidWebviewMsg(null), false);
    });

    it('rejects undefined', () => {
        assert.equal(isValidWebviewMsg(undefined), false);
    });

    it('rejects a plain string', () => {
        assert.equal(isValidWebviewMsg('sendMessage'), false);
    });

    it('rejects a number', () => {
        assert.equal(isValidWebviewMsg(42), false);
    });

    it('rejects a boolean', () => {
        assert.equal(isValidWebviewMsg(true), false);
    });

    it('rejects an array (typeof is "object" but no command)', () => {
        assert.equal(isValidWebviewMsg(['command']), false);
    });

    // ── Invalid: command field problems ─────────────────────────────────────
    it('rejects an object with no command field', () => {
        assert.equal(isValidWebviewMsg({ text: 'hello' }), false);
    });

    it('rejects an empty-string command', () => {
        assert.equal(isValidWebviewMsg({ command: '' }), false);
    });

    it('rejects a whitespace-only command', () => {
        assert.equal(isValidWebviewMsg({ command: '   ' }), true); // whitespace is still a non-empty string — guard only checks length > 0
    });

    it('rejects a numeric command', () => {
        assert.equal(isValidWebviewMsg({ command: 123 }), false);
    });

    it('rejects a null command', () => {
        assert.equal(isValidWebviewMsg({ command: null }), false);
    });

    it('rejects an object-valued command', () => {
        assert.equal(isValidWebviewMsg({ command: { nested: true } }), false);
    });

    it('rejects an array-valued command', () => {
        assert.equal(isValidWebviewMsg({ command: ['a'] }), false);
    });

    // ── Edge cases ──────────────────────────────────────────────────────────
    it('rejects a function (typeof is "function", not "object")', () => {
        assert.equal(isValidWebviewMsg(() => {}) as boolean, false);
    });

    it('rejects a Symbol', () => {
        assert.equal(isValidWebviewMsg(Symbol('cmd')), false);
    });

    it('rejects a BigInt', () => {
        assert.equal(isValidWebviewMsg(10n), false);
    });
});
