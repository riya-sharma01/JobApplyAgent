'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { checkATS, itemsToText, htmlToPlain, normalizeText, hasPhone } = require('../js/ats.js');

const pass = (r, label) => r.items.find((i) => i.label.startsWith(label)).pass;
const note = (r, label) => r.items.find((i) => i.label.startsWith(label)).note;

// Builds pdf.js-style text items: a bullet glyph and its text are separate items on one line,
// like a LaTeX resume. y goes down the page as it decreases.
function pdfLine(y, str, opts = {}) {
  const items = [];
  let x = 40;
  if (opts.bullet) {
    items.push({ str: '\u2022', transform: [1, 0, 0, 1, x, y], width: 4 });
    x += 14;
  }
  for (const word of str.split(' ')) {
    items.push({ str: word, transform: [1, 0, 0, 1, x, y], width: word.length * 5 });
    x += word.length * 5 + 3; // 3pt gap = a space with no space character in the stream
  }
  return items;
}

const FILLER = ' word'.repeat(160);

test('itemsToText keeps one line per row and bullets at the start of their line', () => {
  const items = [
    ...pdfLine(760, 'Riya Sharma'),
    ...pdfLine(745, 'Experience'),
    ...pdfLine(730, 'Automated regression workflows across 66 testcases', { bullet: true }),
    ...pdfLine(718, 'Developed reusable scripts', { bullet: true }),
  ];
  assert.deepStrictEqual(itemsToText(items).split('\n'), [
    'Riya Sharma',
    'Experience',
    '\u2022 Automated regression workflows across 66 testcases',
    '\u2022 Developed reusable scripts',
  ]);
});

test('itemsToText honours hasEOL and ignores junk items', () => {
  const items = [
    { str: 'one', transform: [1, 0, 0, 1, 0, 100], width: 15, hasEOL: true },
    { str: 'two', transform: [1, 0, 0, 1, 0, 100], width: 15 },
    null,
    { nope: true },
  ];
  assert.strictEqual(itemsToText(items), 'one\ntwo');
});

test('a resume built from PDF items passes bullets and symbols (the bug you hit)', () => {
  let items = [];
  let y = 780;
  const add = (s, o) => { items = items.concat(pdfLine(y, s, o)); y -= 13; };
  add('Riya Sharma');
  add('riya@example.com | +91-7015783855 | github.com/riya-sharma01');
  add('Education');
  add('B.Tech in Computer Science and Engineering');
  add('Experience');
  for (let i = 0; i < 4; i++) add('Automated regression workflows and wrote reusable scripts ' + i, { bullet: true });
  add('Projects');
  for (let i = 0; i < 4; i++) add('Built a platform with parsing and checks ' + i, { bullet: true });
  add('Technical Skills');
  items = items.concat(pdfLine(y, FILLER.trim()));
  const r = checkATS(itemsToText(items));
  assert.ok(pass(r, 'Bullet'), note(r, 'Bullet'));
  assert.ok(pass(r, 'No unusual'), note(r, 'No unusual'));
  assert.strictEqual(r.score, 100, JSON.stringify(r.items.filter((i) => !i.pass)));
});

test('the old behaviour (everything flattened into one line) is what failed before', () => {
  const flat = 'Riya riya@example.com +91-7015783855 Education Experience Skills ' +
    '\u2022 one \u2022 two \u2022 three \u2022 four ' + FILLER;
  const r = checkATS(flat);
  // still works on flattened pasted text, because bullet glyphs are counted anywhere
  assert.ok(pass(r, 'Bullet'));
  assert.ok(pass(r, 'No unusual'));
});

test('bullet glyphs and ligatures are not "unusual symbols"', () => {
  const text = 'Experience\n\u2022 \ufb01nal \ufb02ow of\ufb03ce \ufb01x\n\u25aa item\n\u25e6 item\n\u2013 dash \u201cquoted\u201d \u2019s\n' + FILLER;
  const r = checkATS(text);
  assert.ok(pass(r, 'No unusual'), note(r, 'No unusual'));
  assert.ok(normalizeText('\ufb01nal \ufb03').startsWith('final'));
});

test('icons and emoji are flagged, and the note names them', () => {
  const r = checkATS('\u2706 +91-7015783855 \u2709 a@b.com \ud83d\udcde call\nEducation\n' + FILLER);
  assert.ok(!pass(r, 'No unusual'));
  const n = note(r, 'No unusual');
  assert.ok(n.includes('\u2706') && n.includes('\u2709'), n);
});

test('accented letters in names are fine', () => {
  const r = checkATS('Jos\u00e9 Mu\u00f1oz\nEducation\n' + FILLER);
  assert.ok(pass(r, 'No unusual'));
});

test('zero or two bullets is not enough, three is', () => {
  assert.ok(!pass(checkATS('Experience\n\u2022 one\n\u2022 two\n' + FILLER), 'Bullet'));
  assert.ok(pass(checkATS('Experience\n\u2022 one\n\u2022 two\n\u2022 three\n' + FILLER), 'Bullet'));
});

test('dash and asterisk list lines count as bullets', () => {
  assert.ok(pass(checkATS('Experience\n- one\n- two\n* three\n' + FILLER), 'Bullet'));
});

test('hasPhone accepts real formats', () => {
  for (const p of ['+91-7015783855', '+91 70157 83855', '7015783855', '(080) 2345 6789', '+1 415 555 0132', '415-555-0132']) {
    assert.ok(hasPhone(p), p);
  }
});

test('hasPhone rejects date ranges, years and scores (the old false positive)', () => {
  for (const t of ['08 2023 -- 06 2027', '09 2023 -- Present', '2023 2024 2025', 'CGPA: 7.87 / 10.0', 'rating 2395 and 700+ problems', '05 2026 -- 07 2026']) {
    assert.ok(!hasPhone(t), t);
  }
});

test('a resume with dates but no phone number fails the phone check', () => {
  const r = checkATS('Riya a@b.com\nEducation\n08 2023 -- 06 2027\nExperience\n05 2026 -- 07 2026\nSkills\n' + FILLER);
  assert.ok(!pass(r, 'Phone'));
});

test('section headers must be on their own lines, not just appear in prose', () => {
  const prose = ['I have experience with education software and skills in projects.', 'Another line', 'Another line', 'Another line', 'Another line'].join('\n');
  assert.ok(!pass(checkATS(prose + FILLER), 'Standard section'));
  const real = ['Education', 'x', 'Technical Skills', 'x', 'Leadership & Activities', 'x', 'Projects'].join('\n');
  const r = checkATS(real + FILLER);
  assert.ok(pass(r, 'Standard section'), note(r, 'Standard section'));
});

test('flattened text falls back to a word search and says so', () => {
  const r = checkATS('Education Experience Skills Projects ' + FILLER);
  assert.ok(pass(r, 'Standard section'));
  assert.ok(note(r, 'Standard section').includes('word search'));
});

test('htmlToPlain keeps Word list items as bullets and decodes entities', () => {
  const html = '<h1>Experience</h1><p>R&amp;D intern</p><ul><li>Built a thing</li><li>Fixed &lt;bugs&gt;</li><li>Shipped it</li></ul>';
  const text = htmlToPlain(html);
  assert.strictEqual(text, 'Experience\nR&D intern\n\u2022 Built a thing\n\u2022 Fixed <bugs>\n\u2022 Shipped it');
  assert.ok(pass(checkATS(text + '\nEducation\nSkills\n' + FILLER), 'Bullet'));
});

test('empty and junk input does not throw', () => {
  for (const v of ['', null, undefined, '   ']) assert.doesNotThrow(() => checkATS(v));
  assert.strictEqual(checkATS('').score, 0);
});
