'use strict';

// GET /api/health: tells the site which parts of the proxy are switched on.
// It reports only yes/no, never any secret.

const { applyCors } = require('../lib/common');

async function handler(req, res) {
  const allowed = applyCors(req, res, 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(allowed ? 204 : 403).end();
  if (!allowed) return res.status(403).json({ error: 'forbidden_origin' });
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    ok: true,
    ai: Boolean(process.env.ANTHROPIC_API_KEY),
    adzuna: Boolean(process.env.ADZUNA_APP_ID && process.env.ADZUNA_APP_KEY),
  });
}

module.exports = handler;
