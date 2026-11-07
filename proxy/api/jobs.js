'use strict';

// Job search endpoint.
//   GET /api/jobs?source=arbeitnow|adzuna|company&q=...&location=...&company=<slug>
//
// Every source is fetched here, cleaned up and normalised to one shape, so the site
// has a single code path and never has to deal with CORS or messy job-board HTML.
// Normalised job: { title, company, location, url, description, remote, source }

const { applyCors, makeLimiter, clientIp } = require('../lib/common');

const limiter = makeLimiter(60, 10 * 60 * 1000); // 60 searches per IP per 10 minutes
const MAX_RESULTS = 25;
const MAX_DESCRIPTION = 6000;
const FETCH_TIMEOUT_MS = 12000;
const ARBEITNOW_PAGES = 3;
const ADZUNA_COUNTRIES = ['in', 'gb', 'us', 'au', 'ca', 'sg', 'de', 'fr', 'nl'];
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,60}$/i;

// ---------- text cleanup ----------

const NAMED = {
  nbsp: ' ', ndash: '-', mdash: '-', hellip: '...', rsquo: "'", lsquo: "'",
  rdquo: '"', ldquo: '"', bull: '-', middot: '-', copy: '(c)', reg: '(r)', trade: '(tm)',
};

function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => safeChar(parseInt(h, 16), m))
    .replace(/&#(\d+);/g, (m, d) => safeChar(parseInt(d, 10), m))
    .replace(/&(nbsp|ndash|mdash|hellip|rsquo|lsquo|rdquo|ldquo|bull|middot|copy|reg|trade);/gi,
      (m, n) => NAMED[n.toLowerCase()])
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, '&'); // last, so "&amp;lt;" stays "&lt;"
}

function safeChar(code, fallback) {
  try {
    return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : fallback;
  } catch (e) {
    return fallback;
  }
}

function stripTags(s) {
  return s
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|h[1-6]|ul|ol|tr|section)\s*>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, '');
}

// `escaped` is for sources (Greenhouse) that send HTML as entity-escaped text.
function htmlToText(html, escaped) {
  let s = String(html || '');
  if (escaped) s = decodeEntities(s);
  s = decodeEntities(stripTags(s));
  return s
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
    .slice(0, MAX_DESCRIPTION);
}

// ---------- matching ----------

const SYNONYMS = {
  sde: ['software engineer', 'software developer'],
  swe: ['software engineer', 'software developer'],
  developer: ['engineer'],
  engineer: ['developer'],
  frontend: ['front-end', 'front end'],
  backend: ['back-end', 'back end'],
  fullstack: ['full-stack', 'full stack'],
  ml: ['machine learning'],
  ai: ['artificial intelligence', 'machine learning'],
  intern: ['internship', 'trainee'],
  fresher: ['graduate', 'entry level', 'entry-level', 'junior', 'associate'],
  junior: ['entry level', 'entry-level', 'graduate', 'associate'],
  qa: ['quality assurance', 'sdet', 'test'],
  devops: ['site reliability', 'sre'],
};

function queryGroups(q) {
  return String(q || '')
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/)
    .map((t) => t.replace(/^\.+|\.+$/g, ''))
    .filter((t) => t && !/^\d+$/.test(t))
    .map((t) => [t].concat(SYNONYMS[t] || []));
}

// Keeps jobs where every search word (or a synonym) appears, and ranks title hits first.
function filterAndRank(jobs, q, location) {
  const groups = queryGroups(q);
  const loc = String(location || '').trim().toLowerCase();
  const scored = [];
  jobs.forEach((job, index) => {
    if (loc) {
      const jobLoc = (job.location || '').toLowerCase();
      const ok = jobLoc.includes(loc) || (loc.includes('remote') && job.remote);
      if (!ok) return;
    }
    const title = (job.title || '').toLowerCase();
    const rest = ((job.company || '') + ' ' + (job.description || '')).toLowerCase();
    let score = 0;
    for (const alts of groups) {
      if (alts.some((a) => title.includes(a))) score += 3;
      else if (alts.some((a) => rest.includes(a))) score += 1;
      else return; // a search word is missing entirely
    }
    scored.push({ job, score, index });
  });
  scored.sort((x, y) => y.score - x.score || x.index - y.index);
  return scored.map((x) => x.job);
}

// ---------- sources ----------

function dedupe(jobs) {
  const seen = new Set();
  return jobs.filter((j) => {
    const key = j.url || (j.title + '|' + j.company);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  return { status: res.status, ok: res.ok, data: res.ok ? await res.json() : null };
}

async function fromArbeitnow() {
  const pages = await Promise.allSettled(
    Array.from({ length: ARBEITNOW_PAGES }, (_, i) =>
      getJson('https://www.arbeitnow.com/api/job-board-api?page=' + (i + 1))
    )
  );
  const good = pages.filter((p) => p.status === 'fulfilled' && p.value.ok);
  if (!good.length) throw new Error('source_unavailable');
  const jobs = [];
  for (const p of good) {
    for (const j of (p.value.data && p.value.data.data) || []) {
      jobs.push({
        title: j.title || '',
        company: j.company_name || '',
        location: j.location || (j.remote ? 'Remote' : ''),
        url: j.url || '',
        description: htmlToText(j.description),
        remote: Boolean(j.remote),
        source: 'Arbeitnow',
      });
    }
  }
  return { jobs: dedupe(jobs), note: '' };
}

async function fromAdzuna(q, location, country) {
  const id = process.env.ADZUNA_APP_ID;
  const key = process.env.ADZUNA_APP_KEY;
  if (!id || !key) throw new Error('source_not_configured');
  const cc = ADZUNA_COUNTRIES.includes(country) ? country : (process.env.ADZUNA_COUNTRY || 'in');
  const params = new URLSearchParams({
    app_id: id, app_key: key, results_per_page: '30', 'content-type': 'application/json',
  });
  if (q) params.set('what', q);
  if (location) params.set('where', location);
  const r = await getJson('https://api.adzuna.com/v1/api/jobs/' + cc + '/search/1?' + params);
  if (!r.ok) throw new Error('source_unavailable');
  const jobs = ((r.data && r.data.results) || []).map((j) => ({
    title: htmlToText(j.title),
    company: (j.company && j.company.display_name) || '',
    location: (j.location && j.location.display_name) || '',
    url: j.redirect_url || '',
    description: htmlToText(j.description),
    remote: /remote/i.test(String(j.title) + ' ' + String(j.description)),
    source: 'Adzuna',
  }));
  return {
    jobs,
    prefiltered: true, // Adzuna already searched for us
    note: 'Adzuna only sends a short preview of each description. Open the posting and paste the full text before running Match & tailor.',
  };
}

async function fromCompany(slug) {
  if (!SLUG_RE.test(slug || '')) throw new Error('bad_company');
  const gh = await getJson(
    'https://boards-api.greenhouse.io/v1/boards/' + slug + '/jobs?content=true'
  );
  if (gh.ok) {
    const jobs = ((gh.data && gh.data.jobs) || []).map((j) => ({
      title: j.title || '',
      company: slug,
      location: (j.location && j.location.name) || '',
      url: j.absolute_url || '',
      description: htmlToText(j.content, true),
      remote: /remote/i.test(String(j.title) + ' ' + String((j.location && j.location.name) || '')),
      source: 'Greenhouse',
    }));
    return { jobs, note: '' };
  }
  const lv = await getJson('https://api.lever.co/v0/postings/' + slug + '?mode=json');
  if (lv.ok && Array.isArray(lv.data)) {
    const jobs = lv.data.map((j) => ({
      title: j.text || '',
      company: slug,
      location: (j.categories && j.categories.location) || '',
      url: j.hostedUrl || '',
      description: [j.descriptionPlain, ((j.lists || []).map((l) => (l.text || '') + '\n' + htmlToText(l.content))).join('\n'), j.additionalPlain]
        .filter(Boolean).join('\n\n').slice(0, MAX_DESCRIPTION),
      remote: /remote/i.test(String(j.text) + ' ' + String((j.categories && j.categories.location) || '')),
      source: 'Lever',
    }));
    return { jobs, note: '' };
  }
  throw new Error('company_not_found');
}

// ---------- handler ----------

async function handler(req, res) {
  const allowed = applyCors(req, res, 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(allowed ? 204 : 403).end();
  if (!allowed) return res.status(403).json({ error: 'forbidden_origin' });
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });
  if (limiter.check(clientIp(req))) return res.status(429).json({ error: 'rate_limited' });

  const query = req.query || {};
  const source = String(query.source || 'arbeitnow');
  const q = String(query.q || '').slice(0, 100);
  const location = String(query.location || '').slice(0, 100);

  let result;
  try {
    if (source === 'arbeitnow') result = await fromArbeitnow();
    else if (source === 'adzuna') result = await fromAdzuna(q, location, String(query.country || ''));
    else if (source === 'company') result = await fromCompany(String(query.company || '').trim());
    else return res.status(400).json({ error: 'bad_source' });
  } catch (err) {
    const known = ['source_unavailable', 'source_not_configured', 'bad_company', 'company_not_found'];
    if (known.includes(err.message)) {
      const status = err.message === 'bad_company' ? 400 : err.message === 'company_not_found' ? 404 : err.message === 'source_not_configured' ? 503 : 502;
      return res.status(status).json({ error: err.message });
    }
    console.error('jobs error', err && err.name);
    return res.status(502).json({ error: 'source_unavailable' });
  }

  const scanned = result.jobs.length;
  const matched = result.prefiltered ? result.jobs : filterAndRank(result.jobs, q, location);
  res.setHeader('Cache-Control', 'public, s-maxage=300');
  return res.status(200).json({
    jobs: matched.slice(0, MAX_RESULTS),
    scanned,
    matched: matched.length,
    note: result.note || '',
  });
}

module.exports = handler;
module.exports._limiterHits = limiter.hits;
module.exports._util = { htmlToText, decodeEntities, filterAndRank, queryGroups };
