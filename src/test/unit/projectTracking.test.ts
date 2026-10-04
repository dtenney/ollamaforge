import { strict as assert } from 'assert';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { findProjectFile, readProjectOpenItems, countTrackingDocOpenItems } from '../../projectTracking';

describe('projectTracking', () => {

    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'projtrack-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    describe('findProjectFile', () => {
        it('returns null when workspace root is null', () => {
            assert.equal(findProjectFile(null), null);
        });

        it('returns null when no project file exists', () => {
            assert.equal(findProjectFile(tmpDir), null);
        });

        it('finds PROJECT.md in the workspace root', () => {
            const pf = path.join(tmpDir, 'PROJECT.md');
            fs.writeFileSync(pf, '# Project\n- [ ] task');
            assert.equal(findProjectFile(tmpDir), pf);
        });

        it('finds a .project.md file', () => {
            const pf = path.join(tmpDir, 'myapp.project.md');
            fs.writeFileSync(pf, '# Project\n- [ ] task');
            assert.equal(findProjectFile(tmpDir), pf);
        });

        it('prefers PROJECT.md over .project.md', () => {
            const explicit = path.join(tmpDir, 'PROJECT.md');
            const alt = path.join(tmpDir, 'other.project.md');
            fs.writeFileSync(explicit, '# Explicit');
            fs.writeFileSync(alt, '# Alt');
            assert.equal(findProjectFile(tmpDir), explicit);
        });

        it('is case-insensitive for .project.md extension', () => {
            const pf = path.join(tmpDir, 'MYAPP.PROJECT.MD');
            fs.writeFileSync(pf, '# Project');
            assert.equal(findProjectFile(tmpDir), pf);
        });

        it('ignores non-.md files', () => {
            fs.writeFileSync(path.join(tmpDir, 'PROJECT.txt'), 'not a project file');
            assert.equal(findProjectFile(tmpDir), null);
        });
    });

    describe('readProjectOpenItems', () => {
        it('returns empty string when file is null', () => {
            assert.equal(readProjectOpenItems(null, tmpDir), '');
        });

        it('returns empty string when file does not exist', () => {
            assert.equal(readProjectOpenItems(path.join(tmpDir, 'nope.md'), tmpDir), '');
        });

        it('returns empty string when all items are checked', () => {
            const pf = path.join(tmpDir, 'PROJECT.md');
            fs.writeFileSync(pf, '# Tasks\n- [x] done thing\n- [x] another done');
            assert.equal(readProjectOpenItems(pf, tmpDir), '');
        });

        it('returns open items with section headers', () => {
            const pf = path.join(tmpDir, 'PROJECT.md');
            fs.writeFileSync(pf, [
                '# Project',
                '## Backend',
                '- [ ] implement auth',
                '- [x] setup db',
                '## Frontend',
                '- [ ] build UI',
            ].join('\n'));
            const result = readProjectOpenItems(pf, tmpDir);
            assert.ok(result.includes('implement auth'));
            assert.ok(result.includes('build UI'));
            assert.ok(result.includes('[Backend]'));
            assert.ok(result.includes('[Frontend]'));
            assert.ok(!result.includes('setup db'));
        });

        it('includes the relative path in the header', () => {
            const pf = path.join(tmpDir, 'PROJECT.md');
            fs.writeFileSync(pf, '- [ ] task');
            const result = readProjectOpenItems(pf, tmpDir);
            assert.ok(result.includes('PROJECT.md'));
        });

        it('handles items without section headers', () => {
            const pf = path.join(tmpDir, 'PROJECT.md');
            fs.writeFileSync(pf, '- [ ] standalone task');
            const result = readProjectOpenItems(pf, tmpDir);
            assert.ok(result.includes('standalone task'));
        });

        it('handles * bullet style', () => {
            const pf = path.join(tmpDir, 'PROJECT.md');
            fs.writeFileSync(pf, '* [ ] star bullet task');
            const result = readProjectOpenItems(pf, tmpDir);
            assert.ok(result.includes('star bullet task'));
        });
    });

    describe('countTrackingDocOpenItems', () => {
        it('returns null when file does not exist', () => {
            assert.equal(countTrackingDocOpenItems(path.join(tmpDir, 'nope.md')), null);
        });

        it('returns empty array when all items are checked', () => {
            const pf = path.join(tmpDir, 'PLAN.md');
            fs.writeFileSync(pf, '- [x] done\n- [x] also done');
            const result = countTrackingDocOpenItems(pf);
            assert.ok(result === null || result.length === 0);
        });

        it('returns open items when some are unchecked', () => {
            const pf = path.join(tmpDir, 'PLAN.md');
            fs.writeFileSync(pf, [
                '## Steps',
                '- [x] step one',
                '- [ ] step two',
                '- [ ] step three',
            ].join('\n'));
            const result = countTrackingDocOpenItems(pf);
            assert.ok(result);
            assert.equal(result!.length, 2);
            assert.ok(result!.some(i => i.includes('step two')));
            assert.ok(result!.some(i => i.includes('step three')));
        });

        it('includes section context in open items', () => {
            const pf = path.join(tmpDir, 'PLAN.md');
            fs.writeFileSync(pf, [
                '## Phase 1',
                '- [ ] alpha',
                '## Phase 2',
                '- [ ] beta',
            ].join('\n'));
            const result = countTrackingDocOpenItems(pf);
            assert.ok(result);
            assert.ok(result!.some(i => i.includes('Phase 1')));
            assert.ok(result!.some(i => i.includes('Phase 2')));
        });
    });
});
