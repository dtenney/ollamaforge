import { strict as assert } from 'assert';
import { toErrorMessage } from '../../logger';

describe('logger', () => {

    describe('toErrorMessage', () => {
        it('extracts message from Error instance', () => {
            assert.equal(toErrorMessage(new Error('something broke')), 'something broke');
        });

        it('extracts message from TypeError', () => {
            assert.equal(toErrorMessage(new TypeError('bad type')), 'bad type');
        });

        it('returns string for string input', () => {
            assert.equal(toErrorMessage('raw string'), 'raw string');
        });

        it('returns "null" for null input', () => {
            assert.equal(toErrorMessage(null), 'null');
        });

        it('returns "undefined" for undefined input', () => {
            assert.equal(toErrorMessage(undefined), 'undefined');
        });

        it('returns string representation for number', () => {
            assert.equal(toErrorMessage(42), '42');
        });

        it('returns string representation for object', () => {
            assert.equal(toErrorMessage({ a: 1 }), '[object Object]');
        });
    });
});
