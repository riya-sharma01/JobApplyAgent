// Job search shared by the proxy (api/jobs.js) and the browser (when no proxy is connected).
// Every source is fetched, cleaned and normalised to one shape:
//   { title, company, location, url, description, remote, source }
// Source of truth: proxy/lib/jobs-core.js. Run `node tools/sync-shared.js` to copy it to js/.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.JobsCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const MAX_RESULTS = 25;
  const MAX_DESCRIPTION = 6000;
  const FETCH_TIMEOUT_MS = 15000;
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

  function timeoutOpts() {
    return typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) } : {};
  }

  async function getJson(fetchFn, url) {
    const res = await fetchFn(url, timeoutOpts());
    return { status: res.status, ok: res.ok, data: res.ok ? await res.json() : null };
  }

  async function fromArbeitnow(fetchFn) {
    const pages = await Promise.allSettled(
      Array.from({ length: ARBEITNOW_PAGES }, (_, i) =>
        getJson(fetchFn, 'https://www.arbeitnow.com/api/job-board-api?page=' + (i + 1))
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

  async function fromAdzuna(fetchFn, env, q, location, country) {
    const id = env.ADZUNA_APP_ID;
    const key = env.ADZUNA_APP_KEY;
    if (!id || !key) throw new Error('source_not_configured');
    const cc = ADZUNA_COUNTRIES.includes(country) ? country : (env.ADZUNA_COUNTRY || 'in');
    const params = new URLSearchParams({
      app_id: id, app_key: key, results_per_page: '30', 'content-type': 'application/json',
    });
    if (q) params.set('what', q);
    if (location) params.set('where', location);
    const r = await getJson(fetchFn, 'https://api.adzuna.com/v1/api/jobs/' + cc + '/search/1?' + params);
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

  async function fromCompany(fetchFn, slug) {
    if (!SLUG_RE.test(slug || '')) throw new Error('bad_company');
    const gh = await getJson(
      fetchFn,
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
    const lv = await getJson(fetchFn, 'https://api.lever.co/v0/postings/' + slug + '?mode=json');
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


  // One entry point for every source. `deps` = { fetch, env }. Throws Error(code) with one of:
  // bad_source, bad_company, company_not_found, source_not_configured, source_unavailable.
  async function searchJobs(params, deps) {
    const p = params || {};
    const fetchFn = deps.fetch;
    const env = deps.env || {};
    const source = String(p.source || 'arbeitnow');
    const q = String(p.q || '').slice(0, 100);
    const location = String(p.location || '').slice(0, 100);

    let result;
    try {
      if (source === 'arbeitnow') result = await fromArbeitnow(fetchFn);
      else if (source === 'adzuna') result = await fromAdzuna(fetchFn, env, q, location, String(p.country || ''));
      else if (source === 'company') result = await fromCompany(fetchFn, String(p.company || '').trim());
      else throw new Error('bad_source');
    } catch (err) {
      const known = ['bad_source', 'source_unavailable', 'source_not_configured', 'bad_company', 'company_not_found'];
      throw new Error(known.includes(err && err.message) ? err.message : 'source_unavailable');
    }

    const matched = result.prefiltered ? result.jobs : filterAndRank(result.jobs, q, location);
    return { jobs: matched.slice(0, MAX_RESULTS), scanned: result.jobs.length, matched: matched.length, note: result.note || '' };
  }

  return { searchJobs, htmlToText, decodeEntities, filterAndRank, queryGroups };
});
