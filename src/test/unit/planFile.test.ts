import { strict as assert } from 'assert';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { planSlug, writePlanFile, updatePlanFile, closePlanFile } from '../../planFile';

describe('planFile', () => {

    describe('planSlug', () => {
        it('creates a slug from a task description', () => {
            const slug = planSlug('Add user authentication to the login page');
            assert.ok(slug.length > 0);
            assert.ok(!slug.includes(' '));
            assert.ok(slug.includes('user'));
            assert.ok(slug.includes('auth'));
        });

        it('removes stop words', () => {
            const slug = planSlug('the quick brown fox');
            assert.ok(!slug.includes('the'));
            assert.ok(slug.includes('quick'));
            assert.ok(slug.includes('brown'));
            assert.ok(slug.includes('fox'));
        });

        it('removes punctuation', () => {
            const slug = planSlug('Fix: the bug! in src/app.ts');
            assert.ok(!slug.includes(':'));
            assert.ok(!slug.includes('!'));
            assert.ok(!slug.includes('.'));
        });

        it('limits to 4 words', () => {
            const slug = planSlug('one two three four five six seven eight');
            const parts = slug.split('-');
            assert.ok(parts.length <= 4);
        });

        it('returns "task" for empty input', () => {
            assert.equal(planSlug(''), 'task');
        });

        it('returns "task" for all stop words', () => {
            assert.equal(planSlug('the a an to for of'), 'task');
        });

        it('lowercases the result', () => {
            const slug = planSlug('Hello World Test');
            assert.equal(slug, slug.toLowerCase());
        });

        it('handles special characters', () => {
            const slug = planSlug('Fix #123: update config.yaml');
            assert.ok(!slug.includes('#'));
            assert.ok(!slug.includes(':'));
            assert.ok(!slug.includes('.'));
        });
    });

    describe('writePlanFile', () => {
        let tmpDir: string;

        beforeEach(() => {
            tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'planfile-'));
        });

        afterEach(() => {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('creates a plan file in the plans directory', () => {
            const result = writePlanFile(tmpDir, 'Test task', ['step one', 'step two']);
            assert.ok(result);
            assert.ok(result!.includes('plans'));
            assert.ok(fs.existsSync(result!));
        });

        it('returns null for empty workspace root', () => {
            assert.equal(writePlanFile('', 'Test', ['step']), null);
        });

        it('returns null for null workspace root', () => {
            assert.equal(writePlanFile(null as any, 'Test', ['step']), null);
        });

        it('includes all steps as unchecked checkboxes', () => {
            const result = writePlanFile(tmpDir, 'Test task', ['alpha', 'beta', 'gamma']);
            const content = fs.readFileSync(result!, 'utf8');
            assert.ok(content.includes('- [ ] alpha'));
            assert.ok(content.includes('- [ ] beta'));
            assert.ok(content.includes('- [ ] gamma'));
        });

        it('includes a status line', () => {
            const result = writePlanFile(tmpDir, 'Test task', ['step']);
            const content = fs.readFileSync(result!, 'utf8');
            assert.ok(content.includes('**Status**: in progress'));
        });

        it('includes the task title', () => {
            const result = writePlanFile(tmpDir, 'My Important Task', ['step']);
            const content = fs.readFileSync(result!, 'utf8');
            assert.ok(content.includes('My Important Task'));
        });

        it('creates the plans directory if it does not exist', () => {
            const plansDir = path.join(tmpDir, 'plans');
            assert.ok(!fs.existsSync(plansDir));
            const result = writePlanFile(tmpDir, 'Test', ['step']);
            assert.ok(result);
            assert.ok(fs.existsSync(plansDir));
        });
    });

    describe('updatePlanFile', () => {
        let tmpDir: string;
        let planPath: string;

        beforeEach(() => {
            tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'planfile-'));
            planPath = writePlanFile(tmpDir, 'Test task', ['step one', 'step two', 'step three'])!;
        });

        afterEach(() => {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('ticks off a completed step', () => {
            updatePlanFile(planPath, ['step one']);
            const content = fs.readFileSync(planPath, 'utf8');
            assert.ok(content.includes('- [x] step one'));
            assert.ok(content.includes('- [ ] step two'));
        });

        it('ticks off multiple completed steps', () => {
            updatePlanFile(planPath, ['step one', 'step two']);
            const content = fs.readFileSync(planPath, 'utf8');
            assert.ok(content.includes('- [x] step one'));
            assert.ok(content.includes('- [x] step two'));
            assert.ok(content.includes('- [ ] step three'));
        });

        it('updates status to done when all steps complete', () => {
            updatePlanFile(planPath, ['step one', 'step two', 'step three']);
            const content = fs.readFileSync(planPath, 'utf8');
            assert.ok(content.includes('**Status**: done'));
        });

        it('keeps status as in progress when some steps remain', () => {
            updatePlanFile(planPath, ['step one']);
            const content = fs.readFileSync(planPath, 'utf8');
            assert.ok(content.includes('**Status**: in progress'));
        });

        it('no-ops when activePlanFile is null', () => {
            // Should not throw
            updatePlanFile(null, ['step one']);
        });

        it('no-ops when activePlanFile is empty string', () => {
            updatePlanFile('', ['step one']);
        });

        it('matches steps case-insensitively', () => {
            updatePlanFile(planPath, ['STEP ONE']);
            const content = fs.readFileSync(planPath, 'utf8');
            assert.ok(content.includes('- [x] step one'));
        });
    });

    describe('closePlanFile', () => {
        let tmpDir: string;
        let planPath: string;

        beforeEach(() => {
            tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'planfile-'));
            planPath = writePlanFile(tmpDir, 'Test task', ['step one', 'step two'])!;
        });

        afterEach(() => {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('marks all steps as done', () => {
            closePlanFile(planPath);
            const content = fs.readFileSync(planPath, 'utf8');
            assert.ok(!content.includes('- [ ]'));
            assert.ok(content.includes('- [x] step one'));
            assert.ok(content.includes('- [x] step two'));
        });

        it('sets status to done', () => {
            closePlanFile(planPath);
            const content = fs.readFileSync(planPath, 'utf8');
            assert.ok(content.includes('**Status**: done'));
        });

        it('no-ops when activePlanFile is null', () => {
            closePlanFile(null);
        });

        it('no-ops when activePlanFile is empty string', () => {
            closePlanFile('');
        });
    });
});
