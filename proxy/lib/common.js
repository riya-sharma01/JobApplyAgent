'use strict';

// Helpers shared by the proxy endpoints (api/chat.js, api/jobs.js).

function parseOrigins() {
  if (process.env.ALLOWED_ORIGINS) {
    return process.env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  }
  const list = ['https://riya-sharma01.github.io'];
  // localhost is only allowed outside production deployments
  if (process.env.VERCEL_ENV !== 'production') list.push('http://localhost:8000');
  return list;
}

const ALLOWED_ORIGINS = parseOrigins();

// Sets CORS headers when the request comes from an allowed origin.
// Returns true if the origin is allowed.
function applyCors(req, res, methods) {
  const origin = req.headers.origin;
  const allowed = Boolean(origin) && ALLOWED_ORIGINS.includes(origin);
  if (allowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', methods);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  return allowed;
}

// Simple in-memory sliding-window limiter, kept per serverless instance.
function makeLimiter(limit, windowMs) {
  const hits = new Map();
  function check(ip, now = Date.now()) {
    const recent = (hits.get(ip) || []).filter((t) => now - t < windowMs);
    if (recent.length >= limit) {
      hits.set(ip, recent);
      return true; // limited
    }
    recent.push(now);
    hits.set(ip, recent);
    if (hits.size > 5000) {
      for (const [key, times] of hits) {
        if (!times.some((t) => now - t < windowMs)) hits.delete(key);
      }
    }
    return false;
  }
  return { check, hits };
}

function clientIp(req) {
  return (
    String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    (req.socket && req.socket.remoteAddress) ||
    'unknown'
  );
}

module.exports = { ALLOWED_ORIGINS, applyCors, makeLimiter, clientIp };
