import { strict as assert } from 'assert';
import { redactSecrets, containsSecret } from '../../secretRedaction';

// Build test values from parts so the full pattern never appears as a literal
// in this source file (which would itself trigger redaction).
const AWS_KEY = 'AKIA' + 'IOSFODNN7EXAMPLE';
const AWS_SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const API_KEY = 'abcdef1234567890abcdef1234567890';
const PASSWORD = 'SuperSecret1234567890';
const BEARER = 'eyJhbGciOiJIUzI1NiJ9.abc123def456ghi789';
const GH_TOKEN = 'ghp_' + 'ABCDEFGHIJKLMNOP' + 'QRSTUVWXYZabcdefghij';
// Built from char codes so no Slack token pattern appears in source
const SLACK = String.fromCharCode(120,111,120,98,45,49,50,51,52,53,54,55,56,57,48,45,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112);
const PEM = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----';
const CONNSTR = 'postgres://admin:secretpass123@db.example.com:5432/mydb';
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
const OPENAI = 'sk-abc123def456ghi789jkl012mno345';

describe('secretRedaction', () => {

    describe('redactSecrets', () => {

        it('returns empty string unchanged', () => {
            const r = redactSecrets('');
            assert.equal(r.text, '');
            assert.equal(r.count, 0);
        });

        it('returns null as empty string', () => {
            const r = redactSecrets(null as any);
            assert.equal(r.text, '');
            assert.equal(r.count, 0);
        });

        it('leaves normal text unchanged', () => {
            const input = 'Hello world, this is a normal log line.';
            const r = redactSecrets(input);
            assert.equal(r.text, input);
            assert.equal(r.count, 0);
        });

        it('redacts AWS access key ID', () => {
            const input = 'key=' + AWS_KEY;
            const r = redactSecrets(input);
            assert.ok(r.text.includes('[REDACTED:AWS_KEY_ID]'));
            assert.ok(!r.text.includes(AWS_KEY));
            assert.equal(r.count, 1);
        });

        it('redacts AWS secret access key', () => {
            const input = 'aws_secret_access_key = ' + AWS_SECRET;
            const r = redactSecrets(input);
            assert.ok(r.text.includes('[REDACTED:AWS_SECRET]'));
            assert.ok(!r.text.includes(AWS_SECRET));
        });

        it('redacts labelled API key', () => {
            const input = 'api_key: ' + API_KEY;
            const r = redactSecrets(input);
            assert.ok(r.text.includes('[REDACTED:CREDENTIAL]'));
            assert.ok(!r.text.includes(API_KEY));
        });

        it('redacts password= value', () => {
            const input = 'password=' + PASSWORD;
            const r = redactSecrets(input);
            assert.ok(r.text.includes('[REDACTED:CREDENTIAL]'));
            assert.ok(!r.text.includes(PASSWORD));
        });

        it('redacts Bearer token', () => {
            const input = 'Authorization: Bearer ' + BEARER;
            const r = redactSecrets(input);
            assert.ok(r.text.includes('[REDACTED:BEARER]') || r.text.includes('[REDACTED:JWT]'));
            assert.ok(!r.text.includes(BEARER));
        });

        it('redacts GitHub token', () => {
            const input = 'export GITHUB_TOKEN=' + GH_TOKEN;
            const r = redactSecrets(input);
            assert.ok(!r.text.includes(GH_TOKEN));
        });

        it('redacts Slack token', () => {
            const input = SLACK;
            const r = redactSecrets(input);
            assert.ok(r.text.includes('[REDACTED:SLACK_TOKEN]'));
            assert.ok(!r.text.includes(SLACK));
        });

        it('redacts PEM private key block', () => {
            const r = redactSecrets(PEM);
            assert.ok(r.text.includes('[REDACTED:PRIVATE_KEY]'));
            assert.ok(!r.text.includes('MIIEpAIBAAKCAQEA'));
        });

        it('redacts connection string with password', () => {
            const r = redactSecrets(CONNSTR);
            assert.ok(r.text.includes('[REDACTED:CONNSTR]'));
            assert.ok(!r.text.includes('secretpass123'));
        });

        it('redacts JWT', () => {
            const r = redactSecrets(JWT);
            assert.ok(r.text.includes('[REDACTED:JWT]'));
            assert.ok(!r.text.includes(JWT));
        });

        it('redacts OpenAI-style key', () => {
            const input = OPENAI;
            const r = redactSecrets(input);
            assert.ok(r.text.includes('[REDACTED:OPENAI_KEY]'));
            assert.ok(!r.text.includes(OPENAI));
        });

        it('handles multiple secrets in one string', () => {
            const input = 'key=' + AWS_KEY + ' and password=' + PASSWORD;
            const r = redactSecrets(input);
            assert.ok(r.text.includes('[REDACTED:AWS_KEY_ID]'));
            assert.ok(r.text.includes('[REDACTED:CREDENTIAL]'));
            assert.ok(r.count >= 2);
        });

        it('does not false-positive on short values', () => {
            const input = 'password=abc';
            const r = redactSecrets(input);
            assert.equal(r.text, input);
            assert.equal(r.count, 0);
        });

        it('does not false-positive on normal code', () => {
            const input = 'const x = 42; function foo() { return x + 1; }';
            const r = redactSecrets(input);
            assert.equal(r.text, input);
            assert.equal(r.count, 0);
        });
    });

    describe('containsSecret', () => {

        it('returns false for empty string', () => {
            assert.equal(containsSecret(''), false);
        });

        it('returns false for null', () => {
            assert.equal(containsSecret(null as any), false);
        });

        it('returns false for normal text', () => {
            assert.equal(containsSecret('Hello world, no secrets here.'), false);
        });

        it('returns true for AWS key', () => {
            assert.equal(containsSecret(AWS_KEY), true);
        });

        it('returns true for password= value', () => {
            assert.equal(containsSecret('password=' + PASSWORD), true);
        });

        it('returns true for Bearer token', () => {
            assert.equal(containsSecret('Bearer ' + BEARER), true);
        });

        it('returns true for GitHub token', () => {
            assert.equal(containsSecret(GH_TOKEN), true);
        });

        it('returns true for private key block', () => {
            assert.equal(containsSecret(PEM), true);
        });

        it('returns true for connection string', () => {
            assert.equal(containsSecret(CONNSTR), true);
        });

        it('returns true for JWT', () => {
            assert.equal(containsSecret(JWT), true);
        });

        it('returns true for OpenAI key', () => {
            assert.equal(containsSecret(OPENAI), true);
        });

        it('returns false for short password value', () => {
            assert.equal(containsSecret('password=abc'), false);
        });
    });
});
