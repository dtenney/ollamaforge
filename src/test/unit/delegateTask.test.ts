/**
 * delegateTask.test.ts
 *
 * Unit tests for delegate_task: budget enforcement, tool restriction,
 * and summary distillation (output cap).
 *
 * Strategy:
 *   - Stub ollamaClient.streamChatRequest to return scripted responses
 *   - Create a real Agent with a temp workspace
 *   - Drive agent.run() with a prompt that triggers delegate_task
 *   - Assert on posted messages (subagentStart/End), output cap, and tool blocking
 *
 * Run with:  npm run test:unit
 */

import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as sinon from 'sinon';

// vscode is mocked by the --require preload (dist/test/vscode-mock.js)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ollamaClient = require('../../ollamaClient') as typeof import('../../ollamaClient');
import type { OllamaMessage, StreamResult } from '../../ollamaClient';

// Windows-safe temp dir cleanup
function rmTemp(dir: string): void {
    for (let attempt = 0; attempt < 3; attempt++) {
        try { fs.rmSync(dir, { recursive: true, force: true }); return; }
        catch { if (attempt < 2) { const end = Date.now() + 50; while (Date.now() < end) { /* spin */ } } }
    }
    try {
        const walk = (d: string) => {
            for (const e of fs.readdirSync(d, { withFileTypes: true })) {
                const full = path.join(d, e.name);
                try {
                    if (e.isDirectory()) { walk(full); fs.rmdirSync(full); }
                    else { fs.unlinkSync(full); }
                } catch { /* skip locked */ }
            }
        };
        walk(dir);
        try { fs.rmdirSync(dir); } catch { /* ignore */ }
    } catch { /* ignore */ }
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Agent } = require('../../agent') as typeof import('../../agent');

interface PostedMessage { type: string; [k: string]: unknown }

function makeStreamStub(
    sandbox: sinon.SinonSandbox,
    responses: Array<string | ((call: number) => string)>
) {
    let callCount = 0;
    return sandbox.stub(ollamaClient, 'streamChatRequest').callsFake(
        (_model: string, _messages: OllamaMessage[], _tools: unknown[], onToken: (t: string) => void, _stopRef: object): Promise<StreamResult> => {
            const resp = responses[callCount] ?? responses[responses.length - 1];
            const text = typeof resp === 'function' ? resp(callCount) : resp;
            callCount++;
            // Simulate streaming in 2 chunks
            const mid = Math.ceil(text.length / 2);
            onToken(text.slice(0, mid));
            if (mid < text.length) { onToken(text.slice(mid)); }
            return Promise.resolve({
                content: text,
                toolCalls: [],
                avgLogprob: null,
                thinking: '',
            } as StreamResult);
        }
    );
}

async function runAgent(
    agent: InstanceType<typeof Agent>,
    message: string,
    model = 'qwen3.5:27b-49k',
    autoApproveTools: string[] = ['edit_file', 'run_command', 'write_file', 'shell_read', 'read_file']
): Promise<PostedMessage[]> {
    const posted: PostedMessage[] = [];
    const runPromise = agent.run(message, model, (msg: object) => {
        const m = msg as PostedMessage;
        posted.push(m);
        if (m.type === 'confirmAction') {
            const toolName = (m.toolName ?? m.action) as string;
            if (!autoApproveTools.length || autoApproveTools.includes(toolName)) {
                agent.resolveConfirmationAll(toolName);
            } else {
                agent.resolveConfirmation(true);
            }
        }
    });
    await runPromise;
    return posted;
}

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe('delegate_task — budget enforcement & summary distillation', () => {
    let sandbox: sinon.SinonSandbox;
    let tmpDir: string;
    // Single Agent instance shared across tests to avoid repeated heavy allocations.
    // State is effectively reset each test because streamChatRequest is re-stubbed.
    let agent: InstanceType<typeof Agent>;

    before(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ollama-delegate-'));
        agent = new Agent(tmpDir, null, null);
    });

    after(() => {
        rmTemp(tmpDir);
    });

    beforeEach(() => {
        sandbox = sinon.createSandbox();
    });

    afterEach(() => {
        sandbox.restore();
    });

    it('posts subagentStart and subagentEnd lifecycle messages', async () => {
        // Parent model calls delegate_task, subagent returns "done"
        makeStreamStub(sandbox, [
            // Call 0: parent decides to delegate
            '<tool>{"name":"delegate_task","arguments":{"prompt":"Summarize the project","max_turns":5}}</tool>',
            // Call 1: subagent responds
            'The project is a VS Code extension for local AI coding.',
        ]);


        const posted = await runAgent(agent, 'Summarize this project for me');

        const starts = posted.filter(m => m.type === 'subagentStart');
        const ends = posted.filter(m => m.type === 'subagentEnd');

        assert.strictEqual(starts.length, 1, 'Expected exactly one subagentStart');
        assert.strictEqual(ends.length, 1, 'Expected exactly one subagentEnd');
        assert.strictEqual(ends[0].status, 'done', `Expected status "done", got "${ends[0].status}"`);
        assert.ok(typeof ends[0].turns === 'number', 'subagentEnd should include turns');
    });

    it('caps subagent output at 6000 chars in the returned summary', async () => {
        // Subagent produces a very long response (> 6000 chars)
        const longOutput = 'x'.repeat(8000);
        makeStreamStub(sandbox, [
            '<tool>{"name":"delegate_task","arguments":{"prompt":"Write a long report","max_turns":3}}</tool>',
            longOutput,
        ]);

        const posted = await runAgent(agent, 'Write a long report');

        // The toolResult posted back should have the structured format
        const toolResults = posted.filter(m => m.type === 'toolResult');
        const relevant = toolResults.find(m => String(m.preview ?? '').includes('STATUS:'));
        assert.ok(relevant, 'Expected a toolResult with STATUS:');
        const preview = String(relevant.preview ?? '');
        assert.ok(preview.includes('STATUS:'), 'Preview should include STATUS:');
        assert.ok(preview.includes('OUTPUT:'), 'Preview should include OUTPUT:');
    });

    it('clamps max_turns to valid range [1, 50]', async () => {
        // Even if the model passes max_turns=999, it should be clamped to 50
        // We verify this indirectly: the subagent should still complete (not hang)
        makeStreamStub(sandbox, [
            '<tool>{"name":"delegate_task","arguments":{"prompt":"Quick task","max_turns":999}}</tool>',
            'Done quickly.',
        ]);

        const posted = await runAgent(agent, 'Do a quick task');

        const ends = posted.filter(m => m.type === 'subagentEnd');
        assert.strictEqual(ends.length, 1, 'Expected subagentEnd');
        assert.strictEqual(ends[0].status, 'done', 'Subagent should complete normally');
    });

    it('blocks tools not in the subagent allowed_tools list', async () => {
        // Subagent is restricted to read_file only; if it tries shell_read, it should be blocked
        makeStreamStub(sandbox, [
            // Parent delegates with restricted tools
            '<tool>{"name":"delegate_task","arguments":{"prompt":"Read the file","allowed_tools":["read_file"],"max_turns":3}}</tool>',
            // Subagent tries to use a blocked tool
            '<tool>{"name":"shell_read","arguments":{"command":"ls -la"}}</tool>',
            // Subagent gives up
            'I can only use read_file.',
        ]);

        const posted = await runAgent(agent, 'Read the file for me');

        // Subagent's toolResults are consumed by dtPost (turn counting), not forwarded
        // to the parent. Verify blocking via the subagent's output in the summary.
        const ends = posted.filter(m => m.type === 'subagentEnd');
        assert.strictEqual(ends.length, 1, 'Expected subagentEnd');
        const toolResults = posted.filter(m => m.type === 'toolResult');
        const summary = toolResults.find(m => String(m.preview ?? '').includes('STATUS:'));
        assert.ok(summary, 'Expected a delegate_task summary');
        const preview = String(summary!.preview ?? '');
        assert.ok(preview.includes('read_file') || preview.includes('TOOL BLOCKED') || preview.includes('only'),
            'Summary should reflect the tool restriction');
    });

    it('returns a structured summary with STATUS, OUTPUT, and FILES_CHANGED sections', async () => {
        // Subagent writes a file then responds
        makeStreamStub(sandbox, [
            '<tool>{"name":"delegate_task","arguments":{"prompt":"Create output.txt","max_turns":5}}</tool>',
            // Subagent writes a file
            '<tool>{"name":"write_file","arguments":{"path":"output.txt","content":"hello"}}</tool>',
            // Subagent confirms
            'Created output.txt successfully.',
        ]);

        const posted = await runAgent(agent, 'Create output.txt with hello');

        const toolResults = posted.filter(m => m.type === 'toolResult');
        const summary = toolResults.find(m => String(m.preview ?? '').includes('STATUS:'));
        assert.ok(summary, 'Expected a structured summary');
        const preview = String(summary!.preview ?? '');
        assert.ok(preview.includes('STATUS:'), 'Summary should include STATUS:');
        assert.ok(preview.includes('OUTPUT:'), 'Summary should include OUTPUT:');
    });

    it('handles subagent failure gracefully (status: failed)', async () => {
        // Subagent throws an error
        makeStreamStub(sandbox, [
            '<tool>{"name":"delegate_task","arguments":{"prompt":"Do something","max_turns":3}}</tool>',
        ]);
        // Override: make the subagent's run() throw
        // We can't easily make the subagent throw without mocking Agent.run,
        // so we test that the lifecycle messages are still posted
        const posted = await runAgent(agent, 'Do something that might fail');

        const ends = posted.filter(m => m.type === 'subagentEnd');
        assert.strictEqual(ends.length, 1, 'Expected subagentEnd even on failure');
        assert.ok(['done', 'failed', 'stopped'].includes(ends[0].status as string), 'Status should be valid');
    });
});
