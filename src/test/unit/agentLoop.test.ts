import * as assert from 'assert';
import {
    stripXmlArtifacts,
    normalizeArgVal,
    filePathInMsg,
    filterCompleteLine,
    isPlanningLine,
    escHtml,
    looksLikePath,
    normalizePath,
    requiredParams,
    isAbsPath,
    isFilePath,
    globToRegex,
    globToRegexDeep,
    extractKeywords,
    generateBranchSlug,
    StreamFilter,
    repairCollapsedArgs,
    getVerifyCommand,
    toolCallDigest,
    stableStringify,
    truncateToolResult,
    levenshtein,
} from '../../agentLoop';

describe('agentLoop', () => {

    // ─── stripXmlArtifacts ───────────────────────────────────────────────
    describe('stripXmlArtifacts', () => {
        it('removes  blocks', () => {
            const input = 'Hello <tool_response>\n{"name": "read_file"}\n</tool_call> world';
            assert.strictEqual(stripXmlArtifacts(input), 'Hello  world');
        });

        it('removes stray  tags', () => {
            assert.strictEqual(stripXmlArtifacts('a  b  c'), 'a  b  c');
        });

        it('removes  blocks', () => {
            const input = 'x  function name="foo"  end';
            assert.strictEqual(stripXmlArtifacts(input), 'x  end');
        });

        it('removes  blocks', () => {
            const input = 'a  name="x"  b';
            assert.strictEqual(stripXmlArtifacts(input), 'a  b');
        });

        it('removes  blocks', () => {
            const input = 'a  param="v"  b';
            assert.strictEqual(stripXmlArtifacts(input), 'a  b');
        });

        it('removes  tags', () => {
            assert.strictEqual(stripXmlArtifacts('a  b  c'), 'a  b  c');
        });

        it('leaves normal text untouched', () => {
            assert.strictEqual(stripXmlArtifacts('hello world'), 'hello world');
        });

        it('handles empty string', () => {
            assert.strictEqual(stripXmlArtifacts(''), '');
        });
    });

    // ─── normalizeArgVal ─────────────────────────────────────────────────
    describe('normalizeArgVal', () => {
        it('returns non-strings as-is', () => {
            assert.strictEqual(normalizeArgVal(42), 42);
            assert.strictEqual(normalizeArgVal(null), null);
            assert.deepStrictEqual(normalizeArgVal([1, 2]), [1, 2]);
        });

        it('trims whitespace', () => {
            assert.strictEqual(normalizeArgVal('  hello  '), 'hello');
        });

        it('strips escaped quotes', () => {
            assert.strictEqual(normalizeArgVal('\\"hello\\"'), 'hello');
        });

        it('strips double quotes', () => {
            assert.strictEqual(normalizeArgVal('"hello"'), 'hello');
        });

        it('strips single quotes', () => {
            assert.strictEqual(normalizeArgVal("'hello'"), 'hello');
        });

        it('does not strip mismatched quotes', () => {
            assert.strictEqual(normalizeArgVal('"hello\''), '"hello\'');
        });
    });

    // ─── filePathInMsg ───────────────────────────────────────────────────
    describe('filePathInMsg', () => {
        it('detects a file path', () => {
            assert.strictEqual(filePathInMsg('see src/main.ts for details'), true);
        });

        it('detects a Windows path', () => {
            assert.strictEqual(filePathInMsg('check C:\\Users\\david\\file.py'), true);
        });

        it('returns false for plain text', () => {
            assert.strictEqual(filePathInMsg('hello world'), false);
        });

        it('detects .json', () => {
            assert.strictEqual(filePathInMsg('update package.json'), true);
        });
    });

    // ─── filterCompleteLine ──────────────────────────────────────────────
    describe('filterCompleteLine', () => {
        it('suppresses sparkle thought-process lines', () => {
            assert.strictEqual(filterCompleteLine('✨ Thought process:'), '');
        });

        it('suppresses markdown thinking headers', () => {
            assert.strictEqual(filterCompleteLine('### Thinking'), '');
        });

        it('suppresses "Let me know" closers', () => {
            assert.strictEqual(filterCompleteLine('Let me know how it runs.'), '');
        });

        it('suppresses "Happy to help"', () => {
            assert.strictEqual(filterCompleteLine('Happy to help'), '');
        });

        it('keeps normal content', () => {
            assert.strictEqual(filterCompleteLine('const x = 1;'), 'const x = 1;');
        });

        it('keeps empty string', () => {
            assert.strictEqual(filterCompleteLine(''), '');
        });
    });

    // ─── isPlanningLine ──────────────────────────────────────────────────
    describe('isPlanningLine', () => {
        it('detects "I will"', () => {
            assert.strictEqual(isPlanningLine('I will now read the file'), true);
        });

        it('detects "let me"', () => {
            assert.strictEqual(isPlanningLine('Let me check that'), true);
        });

        it('detects "looking"', () => {
            assert.strictEqual(isPlanningLine('Looking at the code'), true);
        });

        it('detects "checking"', () => {
            assert.strictEqual(isPlanningLine('Checking the config'), true);
        });

        it('detects "actually"', () => {
            assert.strictEqual(isPlanningLine('Actually that is wrong'), true);
        });

        it('detects "now I"', () => {
            assert.strictEqual(isPlanningLine('Now I see the issue'), true);
        });

        it('returns false for normal output', () => {
            assert.strictEqual(isPlanningLine('const result = compute();'), false);
        });

        it('is case-insensitive', () => {
            assert.strictEqual(isPlanningLine('I WILL do it'), true);
        });
    });

    // ─── escHtml ─────────────────────────────────────────────────────────
    describe('escHtml', () => {
        it('escapes ampersand', () => {
            assert.strictEqual(escHtml('a & b'), 'a &amp; b');
        });

        it('escapes angle brackets', () => {
            assert.strictEqual(escHtml('<tag>'), '&lt;tag&gt;');
        });

        it('escapes quotes', () => {
            assert.strictEqual(escHtml('"hello"'), '&quot;hello&quot;');
        });

        it('handles all at once', () => {
            assert.strictEqual(escHtml('<a href="x">&</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
        });

        it('returns empty for empty', () => {
            assert.strictEqual(escHtml(''), '');
        });
    });

    // ─── looksLikePath ───────────────────────────────────────────────────
    describe('looksLikePath', () => {
        it('detects Windows drive path', () => {
            assert.strictEqual(looksLikePath('C:\\Users\\david'), true);
        });

        it('detects Unix absolute path', () => {
            assert.strictEqual(looksLikePath('/home/user/file.py'), true);
        });

        it('detects tilde path', () => {
            assert.strictEqual(looksLikePath('~/projects/app'), true);
        });

        it('rejects relative path', () => {
            assert.strictEqual(looksLikePath('src/main.ts'), false);
        });

        it('rejects plain text', () => {
            assert.strictEqual(looksLikePath('hello world'), false);
        });
    });

    // ─── normalizePath ───────────────────────────────────────────────────
    describe('normalizePath', () => {
        it('normalizes slashes to platform sep', () => {
            const result = normalizePath('a/b/c');
            assert.strictEqual(result, 'a' + require('path').sep + 'b' + require('path').sep + 'c');
        });

        it('lowercases on Windows', () => {
            if (process.platform === 'win32') {
                assert.strictEqual(normalizePath('C:/Users/DAVID'), 'c:' + require('path').sep + 'users' + require('path').sep + 'david');
            }
        });

        it('handles empty string', () => {
            assert.strictEqual(normalizePath(''), '');
        });
    });

    // ─── requiredParams ──────────────────────────────────────────────────
    describe('requiredParams', () => {
        it('extracts positional params', () => {
            assert.deepStrictEqual(requiredParams('self, name, value'), ['name', 'value']);
        });

        it('excludes keyword args (with =)', () => {
            assert.deepStrictEqual(requiredParams('name, value=42'), ['name']);
        });

        it('excludes *args and **kwargs', () => {
            assert.deepStrictEqual(requiredParams('self, *args, **kwargs'), []);
        });

        it('handles empty string', () => {
            assert.deepStrictEqual(requiredParams(''), []);
        });

        it('handles only self', () => {
            assert.deepStrictEqual(requiredParams('self'), []);
        });
    });

    // ─── isAbsPath ───────────────────────────────────────────────────────
    describe('isAbsPath', () => {
        it('detects Windows absolute', () => {
            assert.strictEqual(isAbsPath('C:\\Windows'), true);
        });

        it('detects Unix absolute', () => {
            assert.strictEqual(isAbsPath('/usr/local/bin'), true);
        });

        it('rejects relative', () => {
            assert.strictEqual(isAbsPath('src/main.ts'), false);
        });
    });

    // ─── isFilePath ──────────────────────────────────────────────────────
    describe('isFilePath', () => {
        it('detects .py', () => {
            assert.strictEqual(isFilePath('main.py'), true);
        });

        it('detects .ts', () => {
            assert.strictEqual(isFilePath('src/agent.ts'), true);
        });

        it('detects .json', () => {
            assert.strictEqual(isFilePath('package.json'), true);
        });

        it('detects absolute path without known ext', () => {
            assert.strictEqual(isFilePath('/usr/local/bin/thing'), true);
        });

        it('rejects plain text', () => {
            assert.strictEqual(isFilePath('hello world'), false);
        });
    });

    // ─── globToRegex ─────────────────────────────────────────────────────
    describe('globToRegex', () => {
        it('matches exact file', () => {
            assert.ok(globToRegex('main.py').test('main.py'));
        });

        it('does not match different file', () => {
            assert.ok(!globToRegex('main.py').test('other.py'));
        });

        it('matches single-star wildcard', () => {
            assert.ok(globToRegex('*.py').test('main.py'));
            assert.ok(!globToRegex('*.py').test('src/main.py'));
        });

        it('matches double-star', () => {
            assert.ok(globToRegex('**/*.py').test('a/b/c/main.py'));
        });
    });

    // ─── globToRegexDeep ─────────────────────────────────────────────────
    describe('globToRegexDeep', () => {
        it('matches exact file', () => {
            assert.ok(globToRegexDeep('src/main.ts').test('src/main.ts'));
        });

        it('double-star-slash matches any depth', () => {
            assert.ok(globToRegexDeep('**/*.py').test('a/b/c/test.py'));
            assert.ok(globToRegexDeep('**/*.py').test('test.py'));
        });

        it('single-star does not cross slashes', () => {
            assert.ok(globToRegexDeep('src/*.ts').test('src/main.ts'));
            assert.ok(!globToRegexDeep('src/*.ts').test('src/sub/main.ts'));
        });

        it('question mark matches single non-slash char', () => {
            assert.ok(globToRegexDeep('file?.ts').test('file1.ts'));
            assert.ok(!globToRegexDeep('file?.ts').test('file12.ts'));
        });

        it('normalizes backslashes', () => {
            assert.ok(globToRegexDeep('src\\main.ts').test('src/main.ts'));
        });

        it('escapes dots', () => {
            assert.ok(globToRegexDeep('v1.0.ts').test('v1.0.ts'));
            assert.ok(!globToRegexDeep('v1.0.ts').test('v1X0.ts'));
        });
    });

    // ─── extractKeywords ─────────────────────────────────────────────────
    describe('extractKeywords', () => {
        it('extracts meaningful words', () => {
            const kws = extractKeywords('How does the authentication middleware work?');
            assert.ok(kws.includes('authenticat') || kws.includes('authenticatio') || kws.includes('middleware'));
        });

        it('filters stop words', () => {
            const kws = extractKeywords('show me how the a is');
            assert.strictEqual(kws.length, 0);
        });

        it('returns at most 3 keywords', () => {
            const kws = extractKeywords('alpha beta gamma delta epsilon zeta');
            assert.ok(kws.length <= 3);
        });

        it('applies stemming (ing)', () => {
            const kws = extractKeywords('implementing the feature');
            assert.ok(kws.some(k => k === 'implement'));
        });

        it('applies stemming (ed)', () => {
            const kws = extractKeywords('configured the system');
            assert.ok(kws.some(k => k === 'configur'));
        });

        it('handles empty string', () => {
            assert.deepStrictEqual(extractKeywords(''), []);
        });
    });

    // ─── generateBranchSlug ──────────────────────────────────────────────
    describe('generateBranchSlug', () => {
        it('lowercases and hyphenates', () => {
            assert.strictEqual(generateBranchSlug('Fix the Login Bug'), 'fix-the-login-bug');
        });

        it('strips special chars', () => {
            assert.strictEqual(generateBranchSlug('Add: feature! v2'), 'add-feature-v2');
        });

        it('caps at 5 words', () => {
            const slug = generateBranchSlug('one two three four five six seven');
            assert.strictEqual(slug, 'one-two-three-four-five');
        });

        it('caps at 40 chars', () => {
            const slug = generateBranchSlug('aaaaaaaa bbbbbbbb cccccccc dddddddd eeeeeeee');
            assert.ok(slug.length <= 40);
        });

        it('handles empty string', () => {
            assert.strictEqual(generateBranchSlug(''), '');
        });
    });

    // ─── StreamFilter ────────────────────────────────────────────────────
    describe('StreamFilter', () => {
        it('passes through normal text', () => {
            const sf = new StreamFilter();
            assert.strictEqual(sf.filter('hello world'), 'hello world');
        });

        it('strips XML artifacts from tokens', () => {
            const sf = new StreamFilter();
            const out = sf.filter('before <tool_response> x </tool_call> after');
            assert.ok(!out.includes('tool_call'));
        });

        it('suppresses thought-process headers', () => {
            const sf = new StreamFilter();
            const out = sf.filter('✨ Thinking\n');
            assert.strictEqual(out, '');
        });

        it('flush returns remaining buffer', () => {
            const sf = new StreamFilter();
            sf.filter('partial');
            // 'partial' was emitted immediately (not suspicious), so flush is empty
            assert.strictEqual(sf.flush(), '');
        });

        it('flush returns buffered suspicious line', () => {
            const sf = new StreamFilter();
            const out = sf.filter('✨ Analysis:');
            // Suspicious prefix, no newline yet, buffered
            assert.strictEqual(out, '');
            const flushed = sf.flush();
            assert.strictEqual(flushed, ''); // filterCompleteLine suppresses it
        });

        it('aborted getter is false initially', () => {
            const sf = new StreamFilter();
            assert.strictEqual(sf.aborted, false);
        });

        it('detects spiral repetition and aborts', () => {
            let aborted = false;
            const sf = new StreamFilter(() => { aborted = true; });
            // Feed enough content to pass the 2000-char threshold
            const filler = 'x'.repeat(2100);
            sf.filter(filler);
            // Now feed a repeated pattern (15+ chars repeated 5+ times)
            const repeated = 'abcdefghij12345'.repeat(6);
            sf.filter(repeated);
            assert.strictEqual(sf.aborted, true);
            assert.strictEqual(aborted, true);
        });

        it('does not abort for normal varied content', () => {
            const sf = new StreamFilter();
            const content = 'The quick brown fox jumps over the lazy dog. '.repeat(50);
            sf.filter(content);
            assert.strictEqual(sf.aborted, false);
        });
    });

    // ─── repairCollapsedArgs ─────────────────────────────────────────────
    describe('repairCollapsedArgs', () => {
        it('returns non-target tools unchanged', () => {
            const args = { foo: 'bar' };
            const result = repairCollapsedArgs('unknown_tool', args, () => {});
            assert.deepStrictEqual(result, args);
        });

        it('coerces numeric offset string to number', () => {
            const args = { path: 'src/main.ts', offset: '10' };
            const result = repairCollapsedArgs('read_file', args, () => {});
            assert.strictEqual(result.offset, 10);
        });

        it('coerces numeric limit string to number', () => {
            const args = { path: 'src/main.ts', limit: '50' };
            const result = repairCollapsedArgs('read_file', args, () => {});
            assert.strictEqual(result.limit, 50);
        });

        it('leaves non-numeric offset alone', () => {
            const args = { path: 'src/main.ts', offset: 'abc' };
            const result = repairCollapsedArgs('read_file', args, () => {});
            assert.strictEqual(result.offset, 'abc');
        });

        it('handles multi-key args without modification', () => {
            const args = { path: 'src/main.ts', offset: 5, limit: 10 };
            const result = repairCollapsedArgs('read_file', args, () => {});
            assert.strictEqual(result.path, 'src/main.ts');
            assert.strictEqual(result.offset, 5);
        });
    });

    // ─── getVerifyCommand ────────────────────────────────────────────────
    describe('getVerifyCommand', () => {
        it('returns pytest for .py', () => {
            assert.ok(getVerifyCommand('src/main.py').includes('pytest'));
        });

        it('returns tsc for .ts', () => {
            assert.ok(getVerifyCommand('src/agent.ts').includes('tsc'));
        });

        it('returns go build for .go', () => {
            assert.ok(getVerifyCommand('main.go').includes('go build'));
        });

        it('returns cargo for .rs', () => {
            assert.ok(getVerifyCommand('lib.rs').includes('cargo'));
        });

        it('returns dotnet for .cs', () => {
            assert.ok(getVerifyCommand('Program.cs').includes('dotnet'));
        });

        it('returns openscad for .scad', () => {
            assert.ok(getVerifyCommand('part.scad').includes('openscad'));
        });

        it('returns json.tool for .json', () => {
            assert.ok(getVerifyCommand('config.json').includes('json.tool'));
        });

        it('returns default for unknown ext', () => {
            assert.ok(getVerifyCommand('file.xyz').includes('project check'));
        });

        it('handles no extension', () => {
            assert.ok(getVerifyCommand('Makefile').includes('project check'));
        });
    });

    // ─── toolCallDigest ──────────────────────────────────────────────────
    describe('toolCallDigest', () => {
        it('returns a 16-char hex string', () => {
            const d = toolCallDigest('read_file', { path: 'src/main.ts' });
            assert.strictEqual(d.length, 16);
            assert.match(d, /^[0-9a-f]{16}$/);
        });

        it('is deterministic', () => {
            const a = toolCallDigest('read_file', { path: 'src/main.ts' });
            const b = toolCallDigest('read_file', { path: 'src/main.ts' });
            assert.strictEqual(a, b);
        });

        it('differs for different args', () => {
            const a = toolCallDigest('read_file', { path: 'a.ts' });
            const b = toolCallDigest('read_file', { path: 'b.ts' });
            assert.notStrictEqual(a, b);
        });

        it('differs for different tool names', () => {
            const a = toolCallDigest('read_file', { path: 'x.ts' });
            const b = toolCallDigest('write_file', { path: 'x.ts' });
            assert.notStrictEqual(a, b);
        });

        it('is order-independent for object keys', () => {
            const a = toolCallDigest('read_file', { path: 'x.ts', offset: 5 });
            const b = toolCallDigest('read_file', { offset: 5, path: 'x.ts' });
            assert.strictEqual(a, b);
        });
    });

    // ─── stableStringify ─────────────────────────────────────────────────
    describe('stableStringify', () => {
        it('returns primitives unchanged', () => {
            assert.strictEqual(stableStringify(42), 42);
            assert.strictEqual(stableStringify('hello'), 'hello');
            assert.strictEqual(stableStringify(null), null);
        });

        it('sorts object keys', () => {
            const result = stableStringify({ b: 1, a: 2, c: 3 }) as Record<string, unknown>;
            assert.deepStrictEqual(Object.keys(result), ['a', 'b', 'c']);
        });

        it('recursively sorts nested objects', () => {
            const result = stableStringify({ z: { b: 1, a: 2 }, a: 1 }) as Record<string, unknown>;
            assert.deepStrictEqual(Object.keys(result), ['a', 'z']);
            assert.deepStrictEqual(Object.keys(result.z as object), ['a', 'b']);
        });

        it('handles arrays', () => {
            const result = stableStringify([3, { b: 1, a: 2 }, 1]) as unknown[];
            assert.strictEqual(result.length, 3);
            assert.deepStrictEqual(Object.keys(result[1] as object), ['a', 'b']);
        });
    });

    // ─── truncateToolResult ──────────────────────────────────────────────
    describe('truncateToolResult', () => {
        const baseOpts = { mergeMode: false, maxChars: 100, headChars: 40, tailChars: 30 };

        it('returns short results unchanged', () => {
            const result = truncateToolResult('hello', 'read_file', '', baseOpts);
            assert.strictEqual(result, 'hello');
        });

        it('truncates long results with head+tail', () => {
            const long = 'A'.repeat(200);
            const result = truncateToolResult(long, 'read_file', '', baseOpts);
            assert.ok(result.includes('chars omitted'));
            assert.ok(result.startsWith('A'.repeat(40)));
            assert.ok(result.endsWith('A'.repeat(30)));
        });

        it('does not double-truncate already truncated results', () => {
            const already = 'head\n\n[TRUNCATED -- 500 lines]\n\ntail';
            const result = truncateToolResult(already, 'read_file', '', baseOpts);
            assert.ok(!result.includes('chars omitted'));
        });

        it('applies merge-mode line cap for shell_read', () => {
            const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
            const result = truncateToolResult(lines, 'shell_read', 'cat file.txt', {
                ...baseOpts, mergeMode: true, mergeMaxLines: 50,
            });
            assert.ok(result.includes('TRUNCATED'));
            assert.ok(result.includes('200 lines'));
        });

        it('applies listing cap for ls output', () => {
            const items = Array.from({ length: 80 }, (_, i) => `file_${i}.txt`).join('\n');
            const result = truncateToolResult(items, 'shell_read', 'ls -la', {
                ...baseOpts, listingSuffix: ' (use find for details)',
            });
            assert.ok(result.includes('LISTING TRUNCATED'));
            assert.ok(result.includes('80 items'));
        });

        it('does not apply listing cap to grep output', () => {
            const items = Array.from({ length: 80 }, (_, i) => `match_${i}`).join('\n');
            const result = truncateToolResult(items, 'shell_read', 'grep -rn foo .', {
                ...baseOpts,
            });
            assert.ok(!result.includes('LISTING TRUNCATED'));
        });
    });

    // ─── levenshtein ─────────────────────────────────────────────────────
    describe('levenshtein', () => {
        it('identical strings → 0', () => {
            assert.strictEqual(levenshtein('hello', 'hello'), 0);
        });

        it('one substitution → 1', () => {
            assert.strictEqual(levenshtein('cat', 'bat'), 1);
        });

        it('one insertion → 1', () => {
            assert.strictEqual(levenshtein('cat', 'cats'), 1);
        });

        it('one deletion → 1', () => {
            assert.strictEqual(levenshtein('cats', 'cat'), 1);
        });

        it('empty to non-empty → length', () => {
            assert.strictEqual(levenshtein('', 'abc'), 3);
        });

        it('completely different → max length', () => {
            assert.strictEqual(levenshtein('abc', 'xyz'), 3);
        });

        it('kitten → sitting = 3', () => {
            assert.strictEqual(levenshtein('kitten', 'sitting'), 3);
        });

        it('is symmetric', () => {
            assert.strictEqual(levenshtein('flaw', 'lawn'), levenshtein('lawn', 'flaw'));
        });
    });
});
