import { strict as assert } from 'assert';
import { repairToolJson, extractJsonStringValue } from '../../agentToolJsonRepair';

describe('agentToolJsonRepair', () => {

    describe('repairToolJson', () => {

        it('returns null when no name field is present', () => {
            assert.equal(repairToolJson('{"arguments":{"command":"ls"}}'), null);
        });

        it('returns null for empty string', () => {
            assert.equal(repairToolJson(''), null);
        });

        it('repairs shell_read with a well-formed command', () => {
            const raw = '{"name":"shell_read","arguments":{"command":"ls -la"}}';
            const result = repairToolJson(raw);
            assert.ok(result);
            const parsed = JSON.parse(result!);
            assert.equal(parsed.name, 'shell_read');
            assert.equal(parsed.arguments.command, 'ls -la');
        });

        it('repairs run_command with a truncated command (no closing brace)', () => {
            const raw = '{"name":"run_command","arguments":{"command":"npm install';
            const result = repairToolJson(raw);
            assert.ok(result);
            const parsed = JSON.parse(result!);
            assert.equal(parsed.name, 'run_command');
            assert.equal(parsed.arguments.command, 'npm install');
        });

        it('repairs shell_read with escaped newlines in command', () => {
            const raw = '{"name":"shell_read","arguments":{"command":"echo \\"hello\\"\\nls"}}';
            const result = repairToolJson(raw);
            assert.ok(result);
            const parsed = JSON.parse(result!);
            assert.equal(parsed.arguments.command, 'echo "hello"\nls');
        });

        it('repairs memory_search with a query', () => {
            const raw = '{"name":"memory_search","arguments":{"query":"project setup"}}';
            const result = repairToolJson(raw);
            assert.ok(result);
            const parsed = JSON.parse(result!);
            assert.equal(parsed.name, 'memory_search');
            assert.equal(parsed.arguments.query, 'project setup');
        });

        it('returns null for memory_search with a truncated query (no closing quote)', () => {
            const raw = '{"name":"memory_search","arguments":{"query":"project setup';
            assert.equal(repairToolJson(raw), null);
        });

        it('repairs workspace_summary (no-arg tool)', () => {
            const raw = '{"name":"workspace_summary","arguments":{}}';
            const result = repairToolJson(raw);
            assert.ok(result);
            const parsed = JSON.parse(result!);
            assert.equal(parsed.name, 'workspace_summary');
            assert.deepEqual(parsed.arguments, {});
        });

        it('repairs memory_list (no-arg tool)', () => {
            const raw = '{"name":"memory_list"}';
            const result = repairToolJson(raw);
            assert.ok(result);
            const parsed = JSON.parse(result!);
            assert.equal(parsed.name, 'memory_list');
            assert.deepEqual(parsed.arguments, {});
        });

        it('repairs memory_tier_write with tier and tags', () => {
            const raw = '{"name":"memory_tier_write","arguments":{"content":"Server IP: 10.0.0.1","tier":0,"tags":["server"]}}';
            const result = repairToolJson(raw);
            assert.ok(result);
            const parsed = JSON.parse(result!);
            assert.equal(parsed.name, 'memory_tier_write');
            assert.equal(parsed.arguments.content, 'Server IP: 10.0.0.1');
            assert.equal(parsed.arguments.tier, 0);
            assert.deepEqual(parsed.arguments.tags, ['server']);
        });

        it('repairs memory_delete with an id', () => {
            const raw = '{"name":"memory_delete","arguments":{"id":"t0_123"}}';
            const result = repairToolJson(raw);
            assert.ok(result);
            const parsed = JSON.parse(result!);
            assert.equal(parsed.name, 'memory_delete');
            assert.equal(parsed.arguments.id, 't0_123');
        });

        it('repairs find_files with a query', () => {
            const raw = '{"name":"find_files","arguments":{"query":"*.py"}}';
            const result = repairToolJson(raw);
            assert.ok(result);
            const parsed = JSON.parse(result!);
            assert.equal(parsed.name, 'find_files');
            assert.equal(parsed.arguments.query, '*.py');
        });

        it('returns null for unknown tool with no path', () => {
            const raw = '{"name":"unknown_tool","arguments":{"foo":"bar"}}';
            assert.equal(repairToolJson(raw), null);
        });

        it('repairs write_file with path and content', () => {
            const raw = '{"name":"write_file","arguments":{"path":"src/test.py","content":"print(\\"hello\\")"}}';
            const result = repairToolJson(raw);
            assert.ok(result);
            const parsed = JSON.parse(result!);
            assert.equal(parsed.name, 'write_file');
            assert.equal(parsed.arguments.path, 'src/test.py');
            assert.equal(parsed.arguments.content, 'print("hello")');
        });

        it('returns null for write_file with truly truncated content (no closing quote)', () => {
            // No closing quote for the content value — repairToolJson cannot determine the boundary
            const raw = '{"name":"write_file","arguments":{"path":"src/app.py","content":"def hello():';
            assert.equal(repairToolJson(raw), null);
        });

        it('returns null for read_file (not a repairable tool)', () => {
            // read_file is not in the repair list — only shell_read, run_command, SIMPLE_TOOLS, write_file, edit_file
            const raw = '{"name":"read_file","arguments":{"path":"src/main.ts"}}';
            assert.equal(repairToolJson(raw), null);
        });

        it('handles edit_file with path, old_string, new_string', () => {
            const raw = '{"name":"edit_file","arguments":{"path":"src/app.ts","old_string":"foo","new_string":"bar"}}';
            const result = repairToolJson(raw);
            assert.ok(result);
            const parsed = JSON.parse(result!);
            assert.equal(parsed.name, 'edit_file');
            assert.equal(parsed.arguments.path, 'src/app.ts');
            assert.equal(parsed.arguments.old_string, 'foo');
            assert.equal(parsed.arguments.new_string, 'bar');
        });
    });

    describe('extractJsonStringValue', () => {
        it('extracts a simple string value', () => {
            const result = extractJsonStringValue('{"key":"hello world"}', 'key');
            assert.equal(result, 'hello world');
        });

        it('extracts a value with escaped quotes', () => {
            const result = extractJsonStringValue('{"key":"say \\"hi\\""}', 'key');
            assert.equal(result, 'say "hi"');
        });

        it('extracts a value with escaped backslash', () => {
            const result = extractJsonStringValue('{"key":"C:\\\\Users\\\\david"}', 'key');
            assert.equal(result, 'C:\\Users\\david');
        });

        it('extracts a value with newline escape', () => {
            const result = extractJsonStringValue('{"key":"line1\\nline2"}', 'key');
            assert.equal(result, 'line1\nline2');
        });

        it('extracts a value with tab escape', () => {
            const result = extractJsonStringValue('{"key":"col1\\tcol2"}', 'key');
            assert.equal(result, 'col1\tcol2');
        });

        it('returns null when key is not found', () => {
            const result = extractJsonStringValue('{"other":"value"}', 'key');
            assert.equal(result, null);
        });

        it('handles empty string value', () => {
            const result = extractJsonStringValue('{"key":""}', 'key');
            assert.equal(result, '');
        });

        it('handles unicode characters', () => {
            const result = extractJsonStringValue('{"key":"héllo wörld"}', 'key');
            assert.equal(result, 'héllo wörld');
        });

        it('handles forward slash escape', () => {
            const result = extractJsonStringValue('{"key":"a\\/b"}', 'key');
            assert.equal(result, 'a/b');
        });

        it('handles backspace and formfeed escapes', () => {
            const result = extractJsonStringValue('{"key":"a\\bb\\fc"}', 'key');
            assert.equal(result, 'a\x08b\x0cc');
        });

        it('preserves unknown escape sequences', () => {
            const result = extractJsonStringValue('{"key":"a\\x41b"}', 'key');
            assert.equal(result, 'a\\x41b');
        });
    });
});
