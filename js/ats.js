// Resume text helpers and the ATS-readiness checker.
// Plain functions with no page dependencies, so they can be tested with Node
// (node --test test/ats.test.js). In the browser they are exposed as window.AtsTools.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AtsTools = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Bullet glyphs that appear at the start of resume lines.
  const BULLET_GLYPHS = '\u2022\u00b7\u2219\u25cf\u25cb\u25e6\u25aa\u25a0\u25a1\u25ab\u2023\u2043';
  // Glyphs that only ever show up as bullets (the middle dot is also used as a separator).
  const STRICT_BULLETS = /[\u2022\u2219\u25cf\u25e6\u25aa\u2023\u2043]/g;
  const SAFE_SYMBOLS = new Set((BULLET_GLYPHS + '\u2013\u2014\u2018\u2019\u201c\u201d\u2026\u00b0\u00d7\u00b1').split(''));
  const ODD_CHAR = /[\p{Extended_Pictographic}\p{Co}\p{Cs}\p{So}\p{Cc}]/u;

  // Ligatures from PDF extraction (fi, fl, ffi...) become normal letters, and soft hyphens go.
  function normalizeText(text) {
    return String(text || '')
      .replace(/\r\n?/g, '\n')
      .normalize('NFKC')
      .replace(/\u00ad/g, '');
  }

  // Turns pdf.js text items into lines. Items carry x/y positions, so a change in y
  // starts a new line. (Joining items with spaces, as before, flattened the whole page
  // into one paragraph and hid every bullet.)
  function itemsToText(items) {
    const lines = [];
    let line = '';
    let lastY = null;
    let lastEnd = null;
    function flush() {
      const clean = line.replace(/[ \t]+/g, ' ').trim();
      if (clean) lines.push(clean);
      line = '';
      lastY = null;
      lastEnd = null;
    }
    for (const it of items || []) {
      if (!it || typeof it.str !== 'string') continue;
      const tr = it.transform || [];
      const x = typeof tr[4] === 'number' ? tr[4] : null;
      const y = typeof tr[5] === 'number' ? tr[5] : null;
      if (lastY !== null && y !== null && Math.abs(y - lastY) > 2.5) flush();
      if (line && x !== null && lastEnd !== null && x - lastEnd > 1.5 && !/\s$/.test(line) && !/^\s/.test(it.str)) {
        line += ' ';
      }
      line += it.str;
      if (y !== null) lastY = y;
      lastEnd = (x !== null ? x : 0) + (it.width || 0);
      if (it.hasEOL) flush();
    }
    flush();
    return lines.join('\n');
  }

  // Converts the HTML mammoth produces for a .docx into plain text, keeping list
  // items as "• " bullets (mammoth's raw-text mode drops the list markers).
  function htmlToPlain(html) {
    return String(html || '')
      .replace(/<li[^>]*>/gi, '\u2022 ')
      .replace(/<\/(p|h[1-6]|li|tr|div)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // Phone numbers are matched by shape. The old check accepted any run of digits and
  // spaces, so a date range like "08 2023 -- 06 2027" counted as a phone number.
  function hasPhone(text) {
    const shapes = [
      /(?:\+|00)\d{1,3}[\s.-]?\(?\d{2,5}\)?[\s.-]?\d{3,5}[\s.-]?\d{0,5}/g,
      /\b\(?\d{3,5}\)?[\s.-]\d{3,5}[\s.-]\d{3,5}\b/g,
      /\b[6-9]\d{9}\b/g,
    ];
    for (const re of shapes) {
      for (const m of text.matchAll(re)) {
        const digits = m[0].replace(/\D/g, '');
        if (digits.length < 10 || digits.length > 13) continue;
        const tokens = m[0].split(/\D+/).filter(Boolean);
        if (tokens.every((t) => /^(19|20)\d\d$/.test(t))) continue; // a run of years
        return true;
      }
    }
    return false;
  }

  const SECTION_LINE = /^(?:(?:professional|work|relevant|technical|academic|key|core|selected)\s+)?(experience|education|skills|projects?|summary|objective|certifications?|achievements?|awards|leadership|internships?|publications|profile)\b.{0,35}$/i;

  function sectionsFound(lines, text) {
    const found = new Set();
    for (const l of lines) {
      if (l.length > 50) continue;
      const m = l.match(SECTION_LINE);
      if (m) found.add(m[1].toLowerCase().replace(/s$/, ''));
    }
    if (lines.length >= 5) return { found: [...found], byLines: true };
    // No line breaks to work with (flattened paste): fall back to a word search.
    const words = ['experience', 'education', 'skills', 'projects', 'summary', 'objective', 'certifications'];
    const lower = text.toLowerCase();
    return { found: words.filter((w) => lower.includes(w)).map((w) => w.replace(/s$/, '')), byLines: false };
  }

  function checkATS(raw) {
    const text = normalizeText(raw);
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    const wordCount = (text.match(/\S+/g) || []).length;
    const items = [];

    const hasEmail = /[\w.+-]+@[\w-]+\.[a-z]{2,}/i.test(text);
    items.push({
      label: 'Email address found', pass: hasEmail,
      note: hasEmail ? 'ATS can extract your contact info.' : 'No email detected. ATS contact-parsing may fail, so add one near the top.',
    });

    const phone = hasPhone(text);
    items.push({
      label: 'Phone number found', pass: phone,
      note: phone ? 'Phone number is parseable.' : 'No phone number detected in a standard format (for example +91-9876543210).',
    });

    const sec = sectionsFound(lines, text);
    const secOk = sec.found.length >= 3;
    items.push({
      label: 'Standard section headers', pass: secOk,
      note: secOk
        ? 'Found: ' + sec.found.join(', ') + '.' + (sec.byLines ? '' : ' (Line breaks were lost, so this was a word search.)')
        : 'Fewer than 3 standard section headers found on their own lines (Experience, Education, Skills...). ATS relies on these to sort your content.',
    });

    const lengthOk = wordCount >= 150 && wordCount <= 1100;
    items.push({
      label: 'Resume length', pass: lengthOk,
      note: wordCount + ' words. ' + (wordCount < 150 ? 'Seems thin for ATS keyword matching.' : wordCount > 1100 ? 'Quite long; consider trimming to 1-2 pages.' : 'A reasonable 1-2 page range.'),
    });

    const lineBullets = lines.filter((l) => new RegExp('^(?:[' + BULLET_GLYPHS + ']\\s*|[-\\u2013\\u2014*]\\s+)\\S').test(l)).length;
    const glyphBullets = (text.match(STRICT_BULLETS) || []).length;
    const bullets = Math.max(lineBullets, glyphBullets);
    items.push({
      label: 'Bullet points detected', pass: bullets >= 3,
      note: bullets >= 3
        ? bullets + ' bullet points found. Good for scannability.'
        : 'Few or no bullet points found. ATS and recruiters both scan bullets faster than paragraphs.',
    });

    const odd = [];
    for (const ch of text) {
      if (ch === '\n' || ch === '\t' || SAFE_SYMBOLS.has(ch)) continue;
      if (ODD_CHAR.test(ch)) odd.push(ch);
    }
    const distinct = [...new Set(odd)];
    items.push({
      label: 'No unusual symbols', pass: odd.length === 0,
      note: odd.length === 0
        ? 'Clean character set.'
        : odd.length + ' icon or special character' + (odd.length === 1 ? '' : 's') + ' found (' + distinct.slice(0, 8).join(' ') + '). Replace icons with plain text, for example write "Email:" instead of an envelope icon.',
    });

    if (wordCount === 0) items.forEach((i) => { i.pass = false; });
    const passCount = items.filter((i) => i.pass).length;
    return { score: Math.round((passCount / items.length) * 100), items, checkedAt: Date.now() };
  }

  return { normalizeText, itemsToText, htmlToPlain, checkATS, hasPhone };
});
