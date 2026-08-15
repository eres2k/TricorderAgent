'use strict';

// Guards the streaming file-block parser (js/file-fences.js): fenced
// ```lang file=path blocks must be extracted byte-exact from complete AND
// mid-stream reply text, while ordinary code fences (live canvas, snippets)
// pass through untouched.
const { test } = require('node:test');
const assert = require('node:assert');
const fences = require('../../js/file-fences.js');

test('text without fences passes through unchanged', () => {
    const text = 'Just a normal reply.\nWith two lines.';
    const r = fences.parse(text);
    assert.strictEqual(r.visible, text);
    assert.deepStrictEqual(r.files, []);
});

test('ordinary code fences are not extracted (live canvas stays in chat)', () => {
    const text = 'Demo:\n```html\n<h1>hi</h1>\n```\ndone';
    const r = fences.parse(text);
    assert.strictEqual(r.visible, text);
    assert.deepStrictEqual(r.files, []);
    assert.strictEqual(fences.mayContainFileBlock(text), false);
});

test('complete file block is extracted with exact content and a marker', () => {
    const body = '<!DOCTYPE html>\n<html>\n  <body>x</body>\n</html>';
    const text = `Intro line\n\`\`\`html file=~/tricorder-workspace/code/app.html\n${body}\n\`\`\`\nOutro line`;
    const r = fences.parse(text);
    assert.strictEqual(r.files.length, 1);
    const f = r.files[0];
    assert.strictEqual(f.path, '~/tricorder-workspace/code/app.html');
    assert.strictEqual(f.lang, 'html');
    assert.strictEqual(f.content, body);
    assert.strictEqual(f.complete, true);
    assert.match(r.visible, /Intro line/);
    assert.match(r.visible, /Outro line/);
    assert.match(r.visible, /📄 `~\/tricorder-workspace\/code\/app\.html`/);
    assert.ok(!r.visible.includes('<!DOCTYPE html>'), 'content stripped from visible text');
});

test('quoted path with spaces and path= alias both work', () => {
    const t1 = '```js file="~/my dir/a.js"\n1;\n```';
    const r1 = fences.parse(t1);
    assert.strictEqual(r1.files[0].path, '~/my dir/a.js');
    const t2 = '```py path=/tmp/b.py\nprint(1)\n```';
    const r2 = fences.parse(t2);
    assert.strictEqual(r2.files[0].path, '/tmp/b.py');
    assert.strictEqual(r2.files[0].lang, 'py');
});

test('language is optional', () => {
    const r = fences.parse('``` file=/tmp/x.txt\nhello\n```');
    assert.strictEqual(r.files.length, 1);
    assert.strictEqual(r.files[0].lang, '');
    assert.strictEqual(r.files[0].content, 'hello');
});

test('unclosed block mid-stream yields complete:false with partial content', () => {
    const text = 'Writing now:\n```html file=/tmp/page.html\n<!DOCTYPE html>\n<div>partial';
    const r = fences.parse(text);
    assert.strictEqual(r.files.length, 1);
    assert.strictEqual(r.files[0].complete, false);
    assert.strictEqual(r.files[0].content, '<!DOCTYPE html>\n<div>partial');
    assert.match(r.visible, /📄 `\/tmp\/page\.html` …/);
});

test('markerFn returning null keeps the raw block visible', () => {
    const text = 'a\n```js file=/tmp/x.js\ncode();\n```\nb';
    const r = fences.parse(text, () => null);
    assert.strictEqual(r.visible, text);
    assert.strictEqual(r.files.length, 1);
});

test('marker function receives file and index', () => {
    const text = '```js file=/tmp/a.js\n1;\n```\n```js file=/tmp/b.js\n2;\n```';
    const seen = [];
    fences.parse(text, (f, i) => { seen.push([f.path, i]); return `[${i}]`; });
    assert.deepStrictEqual(seen, [['/tmp/a.js', 0], ['/tmp/b.js', 1]]);
});

test('multiple file blocks with prose in between', () => {
    const text = 'First:\n```css file=/tmp/s.css\nbody{}\n```\nSecond:\n```js file=/tmp/s.js\nlet a=1;\n```\nDone.';
    const r = fences.parse(text);
    assert.strictEqual(r.files.length, 2);
    assert.strictEqual(r.files[0].content, 'body{}');
    assert.strictEqual(r.files[1].content, 'let a=1;');
    assert.match(r.visible, /First:/);
    assert.match(r.visible, /Second:/);
    assert.match(r.visible, /Done\./);
});

test('a plain fence before a file block does not swallow it', () => {
    const text = 'Snippet:\n```bash\nls -la\n```\nNow the file:\n```js file=/tmp/f.js\nx();\n```';
    const r = fences.parse(text);
    assert.strictEqual(r.files.length, 1);
    assert.strictEqual(r.files[0].path, '/tmp/f.js');
    assert.match(r.visible, /ls -la/);
});

test('file= inside a plain fenced block is not treated as a file block', () => {
    const text = 'Example of the syntax:\n````\n```html file=/tmp/x.html\n...\n```\n````\nend';
    // Outer fence opens plain mode; the inner opener line is passed through.
    const r = fences.parse(text);
    assert.strictEqual(r.files.length, 0);
    assert.strictEqual(r.visible, text);
});

test('raw round-trips byte-exact for restore-on-failure', () => {
    const block = '```html file=/tmp/big.html\n<a>\n</a>\n```';
    const text = `pre\n${block}\npost`;
    const r = fences.parse(text);
    assert.strictEqual(r.files[0].raw, block);
    // Restoring the raw block in place of the marker reproduces the original.
    const restored = r.visible.replace('📄 `/tmp/big.html`', r.files[0].raw);
    assert.strictEqual(restored, text);
});

test('large content (beyond old 12k write_file limit) round-trips exactly', () => {
    const body = ('const x = 1; // padding line\n').repeat(900).trimEnd(); // ~25k chars
    const text = `\`\`\`js file=/tmp/large.js\n${body}\n\`\`\``;
    const r = fences.parse(text);
    assert.strictEqual(r.files[0].content, body);
    assert.ok(r.files[0].content.length > 12000);
});

test('CRLF input is normalized to LF', () => {
    const text = '```js file=/tmp/c.js\r\nline1\r\nline2\r\n```\r\nafter';
    const r = fences.parse(text);
    assert.strictEqual(r.files[0].content, 'line1\nline2');
    assert.match(r.visible, /after/);
});

test('closing fence with trailing whitespace still closes', () => {
    const text = '```js file=/tmp/w.js\n1;\n```   ';
    const r = fences.parse(text);
    assert.strictEqual(r.files[0].complete, true);
    assert.strictEqual(r.files[0].content, '1;');
});
