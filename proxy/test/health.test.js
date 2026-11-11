'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const handler = require('../api/health.js');

const ORIGIN = 'https://riya-sharma01.github.io';
function makeRes() {
  const res = { statusCode: 200, headers: {}, body: undefined };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.end = () => res;
  return res;
}
const req = (extra = {}) => ({ method: 'GET', headers: { origin: ORIGIN }, ...extra });

beforeEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ADZUNA_APP_ID;
  delete process.env.ADZUNA_APP_KEY;
});

test('reports what is switched on, as yes/no only', async () => {
  let res = makeRes();
  await handler(req(), res);
  assert.deepStrictEqual(res.body, { ok: true, ai: false, adzuna: false });
  process.env.ANTHROPIC_API_KEY = 'secret-value';
  process.env.ADZUNA_APP_ID = 'a';
  process.env.ADZUNA_APP_KEY = 'b';
  res = makeRes();
  await handler(req(), res);
  assert.deepStrictEqual(res.body, { ok: true, ai: true, adzuna: true });
  assert.ok(!JSON.stringify(res.body).includes('secret-value'));
  assert.strictEqual(res.headers['Cache-Control'], 'no-store');
});

test('adzuna needs both keys', async () => {
  process.env.ADZUNA_APP_ID = 'a';
  const res = makeRes();
  await handler(req(), res);
  assert.strictEqual(res.body.adzuna, false);
});

test('rejects other origins and non-GET methods, answers the preflight', async () => {
  let res = makeRes();
  await handler(req({ headers: { origin: 'https://evil.example' } }), res);
  assert.strictEqual(res.statusCode, 403);
  res = makeRes();
  await handler(req({ method: 'POST' }), res);
  assert.strictEqual(res.statusCode, 405);
  res = makeRes();
  await handler(req({ method: 'OPTIONS' }), res);
  assert.strictEqual(res.statusCode, 204);
});
