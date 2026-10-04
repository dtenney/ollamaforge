import { strict as assert } from 'assert';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import {
    appendSessionLog,
    appendSessionLogMd,
    appendAgentEvent,
    readAgentEvents,
    SessionLogEntry,
    AgentEvent,
} from '../../sessionLog';

describe('sessionLog', () => {

    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sesslog-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function makeEntry(overrides: Partial<SessionLogEntry> = {}): SessionLogEntry {
        return {
            ts: '2026-10-04T10:00:00.000Z',
            sessionId: 'test-session-1',
            model: 'llama3.4:8b',
            task: 'Fix the login bug',
            turns: 3,
            toolCalls: [{ name: 'read_file', path: 'src/auth.ts' }],
            guardEvents: [],
            filesChanged: ['src/auth.ts'],
            avgLogprob: -0.5,
            durationMs: 1200,
            outcome: 'done',
            ...overrides,
        };
    }

    describe('appendSessionLog', () => {
        it('creates .ollamaforge/sessions.jsonl', () => {
            appendSessionLog(tmpDir, makeEntry());
            const file = path.join(tmpDir, '.ollamaforge', 'sessions.jsonl');
            assert.ok(fs.existsSync(file));
        });

        it('writes valid JSON line', () => {
            appendSessionLog(tmpDir, makeEntry());
            const file = path.join(tmpDir, '.ollamaforge', 'sessions.jsonl');
            const line = fs.readFileSync(file, 'utf8').trim();
            const parsed = JSON.parse(line);
            assert.equal(parsed.sessionId, 'test-session-1');
            assert.equal(parsed.model, 'llama3.4:8b');
            assert.equal(parsed.outcome, 'done');
        });

        it('appends multiple entries', () => {
            appendSessionLog(tmpDir, makeEntry());
            appendSessionLog(tmpDir, makeEntry({ task: 'Second task' }));
            const file = path.join(tmpDir, '.ollamaforge', 'sessions.jsonl');
            const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
            assert.equal(lines.length, 2);
        });

        it('does nothing when workspaceRoot is empty', () => {
            appendSessionLog('', makeEntry());
            // No crash, no file created
        });
    });

    describe('appendSessionLogMd', () => {
        it('creates SESSION_LOG.md with header', () => {
            appendSessionLogMd(tmpDir, makeEntry());
            const file = path.join(tmpDir, '.ollamaforge', 'SESSION_LOG.md');
            assert.ok(fs.existsSync(file));
            const content = fs.readFileSync(file, 'utf8');
            assert.ok(content.includes('# Session Log'));
        });

        it('includes timestamp, outcome, and turns', () => {
            appendSessionLogMd(tmpDir, makeEntry());
            const file = path.join(tmpDir, '.ollamaforge', 'SESSION_LOG.md');
            const content = fs.readFileSync(file, 'utf8');
            assert.ok(content.includes('2026-10-04 10:00'));
            assert.ok(content.includes('done'));
            assert.ok(content.includes('3 turns'));
        });

        it('includes task summary', () => {
            appendSessionLogMd(tmpDir, makeEntry({ task: 'Fix the login bug' }));
            const file = path.join(tmpDir, '.ollamaforge', 'SESSION_LOG.md');
            const content = fs.readFileSync(file, 'utf8');
            assert.ok(content.includes('Fix the login bug'));
        });

        it('includes files changed', () => {
            appendSessionLogMd(tmpDir, makeEntry({ filesChanged: ['a.ts', 'b.ts'] }));
            const file = path.join(tmpDir, '.ollamaforge', 'SESSION_LOG.md');
            const content = fs.readFileSync(file, 'utf8');
            assert.ok(content.includes('a.ts'));
            assert.ok(content.includes('b.ts'));
        });

        it('flags guard events', () => {
            appendSessionLogMd(tmpDir, makeEntry({
                guardEvents: [{ type: 'syntax-error', reason: 'bad syntax' }],
            }));
            const file = path.join(tmpDir, '.ollamaforge', 'SESSION_LOG.md');
            const content = fs.readFileSync(file, 'utf8');
            assert.ok(content.includes('guard'));
        });

        it('uses singular "turn" for 1 turn', () => {
            appendSessionLogMd(tmpDir, makeEntry({ turns: 1 }));
            const file = path.join(tmpDir, '.ollamaforge', 'SESSION_LOG.md');
            const content = fs.readFileSync(file, 'utf8');
            assert.ok(content.includes('1 turn'));
            assert.ok(!content.includes('1 turns'));
        });

        it('escapes pipes in task text', () => {
            appendSessionLogMd(tmpDir, makeEntry({ task: 'task | with pipe' }));
            const file = path.join(tmpDir, '.ollamaforge', 'SESSION_LOG.md');
            const content = fs.readFileSync(file, 'utf8');
            assert.ok(content.includes('\\|'));
        });

        it('does not recreate header on second append', () => {
            appendSessionLogMd(tmpDir, makeEntry());
            appendSessionLogMd(tmpDir, makeEntry({ task: 'Second' }));
            const file = path.join(tmpDir, '.ollamaforge', 'SESSION_LOG.md');
            const content = fs.readFileSync(file, 'utf8');
            const headerCount = content.split('# Session Log').length - 1;
            assert.equal(headerCount, 1);
        });
    });

    describe('appendAgentEvent + readAgentEvents', () => {
        function makeEvent(overrides: Partial<AgentEvent> = {}): AgentEvent {
            return {
                seq: 1,
                ts: '2026-10-04T10:00:00.000Z',
                sessionId: 'sess-1',
                model: 'llama3.4:8b',
                type: 'run_start',
                ...overrides,
            };
        }

        it('writes and reads events', () => {
            appendAgentEvent(tmpDir, makeEvent());
            const events = readAgentEvents(tmpDir, 'sess-1');
            assert.equal(events.length, 1);
            assert.equal(events[0].type, 'run_start');
        });

        it('filters by sessionId', () => {
            appendAgentEvent(tmpDir, makeEvent({ sessionId: 'sess-1' }));
            appendAgentEvent(tmpDir, makeEvent({ sessionId: 'sess-2', seq: 1 }));
            const events = readAgentEvents(tmpDir, 'sess-1');
            assert.equal(events.length, 1);
            assert.equal(events[0].sessionId, 'sess-1');
        });

        it('filters by seq range', () => {
            appendAgentEvent(tmpDir, makeEvent({ seq: 1 }));
            appendAgentEvent(tmpDir, makeEvent({ seq: 2 }));
            appendAgentEvent(tmpDir, makeEvent({ seq: 3 }));
            appendAgentEvent(tmpDir, makeEvent({ seq: 4 }));
            const events = readAgentEvents(tmpDir, 'sess-1', 2, 3);
            assert.equal(events.length, 2);
            assert.equal(events[0].seq, 2);
            assert.equal(events[1].seq, 3);
        });

        it('returns events sorted by seq', () => {
            appendAgentEvent(tmpDir, makeEvent({ seq: 3 }));
            appendAgentEvent(tmpDir, makeEvent({ seq: 1 }));
            appendAgentEvent(tmpDir, makeEvent({ seq: 2 }));
            const events = readAgentEvents(tmpDir, 'sess-1');
            assert.deepEqual(events.map(e => e.seq), [1, 2, 3]);
        });

        it('returns empty array when file does not exist', () => {
            const events = readAgentEvents(tmpDir, 'sess-1');
            assert.deepEqual(events, []);
        });

        it('returns empty array when workspaceRoot is empty', () => {
            const events = readAgentEvents('', 'sess-1');
            assert.deepEqual(events, []);
        });

        it('skips malformed JSON lines', () => {
            appendAgentEvent(tmpDir, makeEvent({ seq: 1 }));
            // Append a bad line
            const file = path.join(tmpDir, '.ollamaforge', 'events.jsonl');
            fs.appendFileSync(file, 'not-json\n', 'utf8');
            appendAgentEvent(tmpDir, makeEvent({ seq: 2 }));
            const events = readAgentEvents(tmpDir, 'sess-1');
            assert.equal(events.length, 2);
        });
    });
});
