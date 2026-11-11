'use strict';

// Job search endpoint.
//   GET /api/jobs?source=arbeitnow|adzuna|company&q=...&location=...&company=<slug>
//
// Every source is fetched here, cleaned up and normalised to one shape, so the site
// has a single code path and never has to deal with CORS or messy job-board HTML.
// Normalised job: { title, company, location, url, description, remote, source }

const { applyCors, makeLimiter, clientIp } = require('../lib/common');
const core = require('../lib/jobs-core');

const limiter = makeLimiter(60, 10 * 60 * 1000); // 60 searches per IP per 10 minutes

const STATUS = { bad_source: 400, bad_company: 400, company_not_found: 404, source_not_configured: 503, source_unavailable: 502 };

async function handler(req, res) {
  const allowed = applyCors(req, res, 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(allowed ? 204 : 403).end();
  if (!allowed) return res.status(403).json({ error: 'forbidden_origin' });
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });
  if (limiter.check(clientIp(req))) return res.status(429).json({ error: 'rate_limited' });

  try {
    const out = await core.searchJobs(req.query || {}, { fetch: (u, o) => fetch(u, o), env: process.env });
    res.setHeader('Cache-Control', 'public, s-maxage=300');
    return res.status(200).json(out);
  } catch (err) {
    return res.status(STATUS[err.message] || 502).json({ error: STATUS[err.message] ? err.message : 'source_unavailable' });
  }
}

module.exports = handler;
module.exports._limiterHits = limiter.hits;
module.exports._util = { htmlToText: core.htmlToText, decodeEntities: core.decodeEntities, filterAndRank: core.filterAndRank, queryGroups: core.queryGroups };
