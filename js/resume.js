// Resume "reading": splits resume text into sections, bullets, contact info and skills,
// then runs rule-based content checks (impact, brevity, style, structure).
// No page dependencies, so it can be tested with Node (node --test test/resume.test.js).
// In the browser it is exposed as window.ResumeTools.
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ResumeTools = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  const Ats = typeof module === 'object' && module.exports ? require('./ats.js') : root.AtsTools;

  // ---------- word lists ----------

  const STRONG_VERBS = new Set(('accelerated achieved analyzed architected authored automated awarded boosted built championed ' +
    'coached collaborated completed conducted configured consolidated constructed converted coordinated created customized ' +
    'debugged decreased defined delivered deployed designed detected developed devised diagnosed directed documented drove ' +
    'earned eliminated enabled engineered enhanced established evaluated executed expanded extended extracted facilitated fixed ' +
    'formulated generated guided hosted identified implemented improved increased initiated instituted integrated introduced ' +
    'investigated launched led leveraged maintained managed mentored migrated modeled modernized monitored negotiated optimized ' +
    'orchestrated organized overhauled owned partnered pioneered planned presented prioritized produced programmed prototyped ' +
    'published qualified raised ranked rebuilt recommended reduced refactored released replaced researched resolved restructured ' +
    'revamped reviewed rewrote scaled secured selected shipped simplified solved spearheaded standardized streamlined strengthened ' +
    'supervised taught tested trained transformed troubleshot tutored upgraded validated volunteered won wrote').split(' '));

  const IRREGULAR_PAST = new Set('built led ran wrote won made drove taught rebuilt rewrote grew took gave began chose held kept met sold set put cut found got sent spent'.split(' '));

  // Present-tense / base-form openers ("Build a tool"), used to spot mixed tenses.
  const BASE_FORMS = new Set(('build develop design create implement automate lead manage analyze write conduct mentor solve improve ' +
    'optimize integrate deploy test debug maintain collaborate coordinate deliver drive launch migrate refactor reduce increase document ' +
    'research review support train organize plan present achieve ensure').split(' '));

  const WEAK_OPENERS = [
    ['responsible for', 'Say what you did instead: "Led", "Owned", "Managed".'],
    ['responsible', 'Say what you did instead: "Led", "Owned", "Managed".'],
    ['worked on', 'Say what you built or changed: "Built", "Developed", "Improved".'],
    ['worked with', 'Say what you did with it: "Integrated", "Built on", "Automated".'],
    ['worked', 'Say what you built or changed: "Built", "Developed", "Improved".'],
    ['helped', '"Helped" hides your role. Say what you actually did.'],
    ['assisted', '"Assisted" hides your role. Say what you actually did.'],
    ['involved in', 'Say what your part was.'],
    ['participated in', 'Say what your part was.'],
    ['tasked with', 'Start with what you did, not what you were given.'],
    ['duties included', 'List results, not duties.'],
    ['in charge of', '"Led" or "Managed" is stronger.'],
    ['used', '"Used" is vague. Say what you built or achieved with it.'],
    ['utilized', 'Say what you built or achieved with it.'],
    ['handled', 'Say what you actually did: "Resolved", "Processed", "Managed".'],
    ['was', 'Start with an action verb, not "was/were".'],
    ['were', 'Start with an action verb, not "was/were".'],
    ['did', 'Say what you did with a specific verb.'],
    ['made', 'Use a specific verb: "Built", "Created", "Designed".'],
  ];

  const BUZZWORDS = ['team player', 'hard-working', 'hard working', 'hardworking', 'results-driven', 'result-oriented', 'results-oriented',
    'detail-oriented', 'self-motivated', 'self-starter', 'go-getter', 'passionate', 'synergy', 'dynamic', 'think outside the box',
    'proven track record', 'excellent communication', 'fast learner', 'quick learner', 'highly motivated', 'strong work ethic', 'motivated'];

  const NUMBER_WORDS = /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|dozen|hundred|thousand|million)\b/i;
  const STANDALONE_NUMBER = /(?<![A-Za-z0-9_.#-])\d[\d,]*(?:\.\d+)?(?:[kKmMxX%+])?(?![A-Za-z0-9_])/;

  // ---------- sections ----------

  const SECTION_DEFS = [
    ['education', /^education(?:\s*(?:&|and)\s*\w+(?:\s+\w+)?)?$/i],
    ['experience', /^(?:(?:professional|work|relevant|industry)\s+)?(?:experience|internships?|employment(?:\s+history)?)$/i],
    ['projects', /^(?:(?:academic|personal|key|selected|technical)\s+)?projects?$/i],
    ['skills', /^(?:(?:technical|core|key|professional)\s+)?skills?(?:\s*(?:&|and)\s*\w+(?:\s+\w+)?)?$/i],
    ['summary', /^(?:(?:professional|career)\s+)?(?:summary|objective|profile)$/i],
    ['leadership', /^(?:leadership|activities|extracurriculars?|volunteer(?:ing)?)(?:\s*(?:&|and|\/)\s*\w+(?:\s+\w+)?)?$/i],
    ['achievements', /^(?:achievements?|awards?(?:\s*(?:&|and)\s*\w+)?|honou?rs|accomplishments)$/i],
    ['certifications', /^certifications?(?:\s*(?:&|and)\s*\w+)?$/i],
    ['publications', /^publications?$/i],
  ];

  function matchSection(line) {
    const t = line.replace(/[:\s]+$/, '');
    if (t.length > 40) return null;
    for (const [key, re] of SECTION_DEFS) if (re.test(t)) return key;
    return null;
  }

  const BULLET_START = /^(?:[\u2022\u00b7\u2219\u25cf\u25cb\u25e6\u25aa\u25a0\u25a1\u25ab\u2023\u2043]\s*|[-\u2013\u2014*]\s+)(?=\S)/;
  const MONTHS = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
  const DATE_ANY = new RegExp('\\b(?:19|20)\\d{2}\\b|\\b' + MONTHS + '\\s+\\d{2,4}\\b|\\b(?:present|current)\\b', 'i');

  function startsLower(s) {
    return /^[a-z]/.test(s);
  }

  // A line right after a bullet that carries on the same sentence (a wrapped bullet).
  function continuesBullet(prev, line) {
    if (DATE_ANY.test(line) || line.length > 170) return false;
    if (startsLower(line)) return true;
    return prev.length >= 80 && !/[.!?;:]$/.test(prev);
  }

  function parseResume(raw) {
    const lines = String(raw || '').replace(/\r\n?/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean);
    const sections = [];
    let current = { key: 'header', title: 'Header', lines: [], plain: [], bullets: [] };
    sections.push(current);
    for (const l of lines) {
      const key = BULLET_START.test(l) ? null : matchSection(l);
      if (key) {
        current = { key, title: l.replace(/[:\s]+$/, ''), lines: [], plain: [], bullets: [] };
        sections.push(current);
      } else {
        current.lines.push(l);
      }
    }
    for (const s of sections) {
      let last = null;
      for (const l of s.lines) {
        if (BULLET_START.test(l)) {
          last = { text: l.replace(BULLET_START, '').trim(), section: s.key };
          s.bullets.push(last);
        } else if (last && continuesBullet(last.text, l)) {
          last.text += ' ' + l;
        } else {
          last = null;
          s.plain.push(l);
        }
      }
    }

    const text = lines.join('\n');
    const email = (text.match(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i) || [''])[0];
    const linkedin = (text.match(/linkedin\.com\/in\/[\w-]+/i) || [''])[0];
    const github = (text.match(/github\.com\/[\w-]+/i) || [''])[0];
    const urls = (text.match(/https?:\/\/[^\s)|]+|\b[\w-]+\.(?:github\.io|vercel\.app|netlify\.app|dev|me)\b[^\s)|]*/gi) || [])
      .filter((u) => !/linkedin\.com|github\.com\/[\w-]+$/i.test(u));
    const contact = { email, phone: Ats.hasPhone(Ats.normalizeText(text)), linkedin, github, portfolio: urls[0] || '' };

    const skills = [];
    const hasLabel = (l) => /^[^:]{1,40}:\s/.test(l);
    for (const s of sections.filter((x) => x.key === 'skills')) {
      // In a labelled list ("Core CS: a, b, c") a line without a label is the wrapped end of the line above.
      const labelled = s.lines.some(hasLabel);
      const joined = [];
      for (const l of s.lines) {
        if (labelled && joined.length && !hasLabel(l)) joined[joined.length - 1] += ' ' + l;
        else joined.push(l);
      }
      for (const l of joined) {
        const body = l.replace(/^[^:]{1,40}:\s*/, '');
        for (const tok of body.split(/[,;|\u2022]/)) {
          const t = tok.trim();
          if (t && t.length <= 30 && !skills.some((k) => k.toLowerCase() === t.toLowerCase())) skills.push(t);
        }
      }
    }
    const bullets = [].concat(...sections.map((s) => s.bullets));
    return { sections, bullets, contact, skills, lines };
  }

  // ---------- checks ----------

  const wordsOf = (s) => (s.match(/\S+/g) || []).length;
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '...' : s);
  const opener = (b) => (b.text.toLowerCase().match(/^[a-z']+/) || [''])[0];
  const isPast = (w) => w.endsWith('ed') || IRREGULAR_PAST.has(w);

  function weakHint(b) {
    const lower = b.text.toLowerCase();
    for (const [phrase, hint] of WEAK_OPENERS) {
      if (lower === phrase || lower.startsWith(phrase + ' ')) return hint;
    }
    return '';
  }

  function isActionVerb(b) {
    const w = opener(b);
    if (weakHint(b)) return false;
    return STRONG_VERBS.has(w) || IRREGULAR_PAST.has(w) || (w.endsWith('ed') && w.length > 3);
  }

  function hasQuantity(text) {
    const noYears = text.replace(/\b(?:19|20)\d{2}\b/g, '');
    return STANDALONE_NUMBER.test(noYears) || NUMBER_WORDS.test(noYears);
  }

  function dateFormats(sections) {
    const found = {};
    const add = (k) => { found[k] = (found[k] || 0) + 1; };
    for (const s of sections) {
      for (const l of s.plain) {
        let rest = l;
        rest = rest.replace(new RegExp('\\b' + MONTHS + '\\s+(?:19|20)\\d{2}\\b', 'gi'), () => { add('Mon YYYY'); return ' '; });
        rest = rest.replace(/\b(?:0?[1-9]|1[0-2])\s*\/\s*(?:19|20)\d{2}\b/g, () => { add('MM/YYYY'); return ' '; });
        rest = rest.replace(/\b(?:0?[1-9]|1[0-2])\s+(?:19|20)\d{2}\b/g, () => { add('MM YYYY'); return ' '; });
        rest.replace(/\b(?:19|20)\d{2}\b/g, () => { add('YYYY only'); return ' '; });
      }
    }
    return found;
  }

  function check(id, label, pass, note, examples, score) {
    return { id, label, pass, note, examples: examples || [], score: score === undefined ? (pass ? 1 : 0) : score };
  }

  function analyzeResume(raw) {
    const parsed = parseResume(raw);
    const bullets = parsed.bullets;
    const n = bullets.length;
    const enough = n >= 3;
    const wholeText = parsed.lines.join('\n');

    // ----- Impact -----
    const nonAction = bullets.filter((b) => !isActionVerb(b));
    const actionPct = n ? Math.round(((n - nonAction.length) / n) * 100) : 0;
    const verbCheck = check('verbs', 'Bullets start with strong action verbs',
      enough && actionPct >= 80,
      !enough ? 'Fewer than 3 bullets were found, so this could not be judged.'
        : (n - nonAction.length) + ' of ' + n + ' bullets start with an action verb (' + actionPct + '%). Aim for 80% or more.',
      nonAction.slice(0, 6).map((b) => ({ text: clip(b.text, 130), hint: weakHint(b) || 'Start with a specific past-tense verb such as "Built" or "Reduced".' })),
      enough ? Math.min(1, actionPct / 80) : 0);

    const noNumbers = bullets.filter((b) => !hasQuantity(b.text));
    const numPct = n ? Math.round(((n - noNumbers.length) / n) * 100) : 0;
    const numCheck = check('numbers', 'Bullets show numbers or results',
      enough && numPct >= 50,
      !enough ? 'Fewer than 3 bullets were found, so this could not be judged.'
        : (n - noNumbers.length) + ' of ' + n + ' bullets include a number (' + numPct + '%). Aim for half or more.',
      noNumbers.slice(0, 6).map((b) => ({ text: clip(b.text, 130), hint: 'Add scale or a result: how many, how much, how fast, how often.' })),
      enough ? Math.min(1, numPct / 50) : 0);

    const lowerWhole = wholeText.toLowerCase();
    const buzz = [...new Set(BUZZWORDS.filter((w) => new RegExp('\\b' + w.replace(/[-]/g, '[- ]') + '\\b').test(lowerWhole)))];
    const buzzCheck = check('buzzwords', 'No empty buzzwords', buzz.length === 0,
      buzz.length ? 'Found: ' + buzz.join(', ') + '. Recruiters skip these. Show the skill with a result instead.' : 'No overused buzzwords found.',
      buzz.map((w) => ({ text: w, hint: 'Replace with something you did that proves it.' })));

    const counts = {};
    bullets.forEach((b) => { const w = opener(b); if (w) counts[w] = (counts[w] || 0) + 1; });
    const repeated = Object.keys(counts).filter((w) => counts[w] > 2);
    const varietyCheck = check('variety', 'Varied opening verbs', n < 6 || repeated.length === 0,
      n < 6 ? 'Too few bullets to compare.'
        : repeated.length ? repeated.map((w) => '"' + w + '" x' + counts[w]).join(', ') + '. Vary your openers.' : 'Opening verbs are varied.',
      repeated.map((w) => ({ text: '"' + w + '" starts ' + counts[w] + ' bullets', hint: 'Swap a few for synonyms (Built, Developed, Implemented, Designed).' })));

    // ----- Brevity -----
    const lengths = bullets.map((b) => ({ b, w: wordsOf(b.text) }));
    const offLength = lengths.filter((x) => x.w < 8 || x.w > 32);
    const tooLong = lengths.filter((x) => x.w > 40);
    const okPct = n ? Math.round(((n - offLength.length) / n) * 100) : 0;
    const lenCheck = check('length', 'Bullet length is easy to scan',
      enough && okPct >= 80 && tooLong.length === 0,
      !enough ? 'Fewer than 3 bullets were found, so this could not be judged.'
        : (n - offLength.length) + ' of ' + n + ' bullets are between 8 and 32 words. Long bullets get skimmed.',
      offLength.slice(0, 6).map((x) => ({ text: clip(x.b.text, 130), hint: x.w > 32 ? 'Too long (' + x.w + ' words). Split it or cut the detail.' : 'Too short (' + x.w + ' words). Add what you did and the result.' })),
      enough ? Math.min(1, okPct / 80) * (tooLong.length ? 0.7 : 1) : 0);

    const totalCheck = check('count', 'A sensible number of bullets', n >= 8 && n <= 30,
      n + ' bullets in total. ' + (n < 8 ? 'Too few to show your work.' : n > 30 ? 'Too many; keep the strongest.' : 'Within a normal range.'), []);

    // ----- Style -----
    const pronoun = bullets.filter((b) => /(?<![\w/])(?:I|me|my|myself|we|our)(?![\w/'])/.test(b.text));
    const pronounCheck = check('pronouns', 'No "I" or "my" in bullets', pronoun.length === 0,
      pronoun.length ? pronoun.length + ' bullet(s) use first-person words. Resumes drop them.' : 'No first-person wording.',
      pronoun.slice(0, 5).map((b) => ({ text: clip(b.text, 130), hint: 'Remove "I/my/we". Start with the action verb.' })));

    const pastB = bullets.filter((b) => isPast(opener(b)));
    const baseB = bullets.filter((b) => BASE_FORMS.has(opener(b)));
    const minority = pastB.length && baseB.length ? (baseB.length <= pastB.length ? baseB : pastB) : [];
    const tenseCheck = check('tense', 'Consistent verb tense', minority.length === 0,
      minority.length ? 'Your bullets mix past tense ("Built") and base form ("Build").' : 'Verb tense is consistent.',
      minority.slice(0, 5).map((b) => ({ text: clip(b.text, 130), hint: 'Match the other bullets: use past tense for finished work.' })));

    const fmts = dateFormats(parsed.sections);
    const fmtKeys = Object.keys(fmts);
    const dateTotal = fmtKeys.reduce((a, k) => a + fmts[k], 0);
    const dateCheck = check('dates', 'Consistent date format', dateTotal < 3 || fmtKeys.length <= 1,
      dateTotal < 3 ? 'Too few dates to compare.'
        : fmtKeys.length <= 1 ? 'All dates use one format.' : 'Mixed date formats: ' + fmtKeys.map((k) => k + ' x' + fmts[k]).join(', ') + '. Pick one.',
      []);

    // ----- Structure -----
    const keys = new Set(parsed.sections.map((s) => s.key));
    const missing = [];
    if (!keys.has('education')) missing.push('Education');
    if (!keys.has('experience') && !keys.has('projects')) missing.push('Experience or Projects');
    if (!keys.has('skills')) missing.push('Skills');
    const secCheck = check('sections', 'Core sections are present', missing.length === 0,
      missing.length ? 'Missing: ' + missing.join(', ') + '.' : 'Education, experience or projects, and skills are all there.', []);

    const c = parsed.contact;
    const lacks = [];
    if (!c.linkedin) lacks.push('LinkedIn');
    if (!c.github && !c.portfolio) lacks.push('GitHub or portfolio');
    const linkCheck = check('links', 'Profile links are included', lacks.length === 0,
      lacks.length ? 'No ' + lacks.join(' or ') + ' link found. Recruiters for software roles look for these.' : 'LinkedIn and a code/portfolio link are present.', []);

    const skillCheck = check('skills', 'Skills section has enough detail', parsed.skills.length >= 8,
      parsed.skills.length + ' skills listed. ' + (parsed.skills.length >= 8 ? 'Good coverage.' : 'Aim for at least 8 relevant ones, grouped by type.'), []);

    const headerLines = parsed.lines.slice(0, 5).join(' ');
    const topCheck = check('top', 'Contact details are at the top',
      /[\w.+-]+@[\w-]+\.[a-z]{2,}/i.test(headerLines) || Ats.hasPhone(Ats.normalizeText(headerLines)),
      'Recruiters and parsers look for your email and phone in the first few lines.', []);

    const categories = [
      { key: 'impact', title: 'Impact', checks: [verbCheck, numCheck, buzzCheck, varietyCheck] },
      { key: 'brevity', title: 'Brevity', checks: [lenCheck, totalCheck] },
      { key: 'style', title: 'Style', checks: [pronounCheck, tenseCheck, dateCheck] },
      { key: 'structure', title: 'Structure', checks: [secCheck, linkCheck, skillCheck, topCheck] },
    ];
    return { parsed, categories };
  }

  // ---------- score ----------

  // Points per check (they add up to 80); the six basic ATS checks share the other 20.
  const WEIGHTS = { verbs: 10, numbers: 12, buzzwords: 6, variety: 7, length: 10, count: 5, pronouns: 3, tense: 4, dates: 3, sections: 6, links: 5, skills: 5, top: 4 };
  const ATS_POINTS = 20;

  // A transparent estimate: every point comes from a check you can see. It cannot judge
  // how strong your experience is, which is what the AI read is for.
  function scoreResume(analysis, ats) {
    if (!analysis.parsed.lines.length) {
      return { overall: 0, categories: [{ key: 'ats', title: 'ATS basics', percent: 0 }].concat(analysis.categories.map((c) => ({ key: c.key, title: c.title, percent: 0 }))) };
    }
    const cats = analysis.categories.map((cat) => {
      let got = 0;
      let max = 0;
      for (const k of cat.checks) {
        const w = WEIGHTS[k.id] || 0;
        max += w;
        got += w * k.score;
      }
      return { key: cat.key, title: cat.title, points: got, percent: max ? Math.round((got / max) * 100) : 0 };
    });
    const items = (ats && ats.items) || [];
    const atsPoints = items.length ? (ATS_POINTS * items.filter((i) => i.pass).length) / items.length : 0;
    cats.unshift({ key: 'ats', title: 'ATS basics', points: atsPoints, percent: items.length ? Math.round((atsPoints / ATS_POINTS) * 100) : 0 });
    return { overall: Math.round(cats.reduce((a, c) => a + c.points, 0)), categories: cats };
  }

  // ---------- AI review: clean up whatever the model sent back ----------

  function normalizeReview(o) {
    if (!o || typeof o !== 'object') return null;
    const str = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
    const list = (v, n, m) => (Array.isArray(v) ? v.map((x) => str(x, n)).filter(Boolean).slice(0, m) : []);
    const issues = Array.isArray(o.issues)
      ? o.issues
        .map((i) => (i && typeof i === 'object'
          ? { severity: ['high', 'medium', 'low'].includes(i.severity) ? i.severity : 'medium', where: str(i.where, 300), problem: str(i.problem, 300), rewrite: str(i.rewrite, 300) }
          : null))
        .filter((i) => i && i.problem)
        .slice(0, 10)
      : [];
    const out = { summary: str(o.summary, 600), strengths: list(o.strengths, 200, 5), issues, missing: list(o.missing, 200, 5) };
    return out.summary || out.issues.length ? out : null;
  }

  // Small stable fingerprint, used to tell whether a saved AI read still matches the resume.
  function textHash(text) {
    let h = 5381;
    const s = String(text || '');
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36) + ':' + s.length;
  }

  return { parseResume, analyzeResume, matchSection, scoreResume, normalizeReview, textHash };
});
