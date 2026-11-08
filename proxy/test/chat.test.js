'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

process.env.ANTHROPIC_API_KEY = 'test-key';
const handler = require('../api/chat.js');

const GOOD_ORIGIN = 'https://riya-sharma01.github.io';

function makeRes() {
  const res = { statusCode: 200, headers: {}, body: undefined, ended: false };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; res.ended = true; return res; };
  res.end = () => { res.ended = true; return res; };
  return res;
}

function makeReq(overrides = {}) {
  return {
    method: 'POST',
    headers: { origin: GOOD_ORIGIN, 'x-forwarded-for': '1.2.3.4' },
    body: { task: 'feedback', question: 'Tell me about a project.', answer: 'I built a thing.' },
    ...overrides,
  };
}

let calls;
beforeEach(() => {
  handler._hits.clear();
  calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'looks good' }] }) };
  };
});

test('rejects a request with no Origin header', async () => {
  const res = makeRes();
  await handler(makeReq({ headers: {} }), res);
  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(calls.length, 0);
});

test('rejects an origin that is not on the allowlist', async () => {
  const res = makeRes();
  await handler(makeReq({ headers: { origin: 'https://evil.example' } }), res);
  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(calls.length, 0);
});

test('answers the CORS preflight for an allowed origin', async () => {
  const res = makeRes();
  await handler(makeReq({ method: 'OPTIONS' }), res);
  assert.strictEqual(res.statusCode, 204);
  assert.strictEqual(res.headers['Access-Control-Allow-Origin'], GOOD_ORIGIN);
});

test('rejects non-POST methods', async () => {
  const res = makeRes();
  await handler(makeReq({ method: 'GET' }), res);
  assert.strictEqual(res.statusCode, 405);
});

test('rejects an unknown task, including prototype names', async () => {
  for (const task of ['nope', 'constructor', '__proto__', undefined]) {
    const res = makeRes();
    await handler(makeReq({ body: { task } }), res);
    assert.strictEqual(res.statusCode, 400, `task=${String(task)}`);
  }
  assert.strictEqual(calls.length, 0);
});

test('rejects missing required fields', async () => {
  const res = makeRes();
  await handler(makeReq({ body: { task: 'match', resume: 'x' } }), res);
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.body.error, 'bad_input');
});

test('feedback: success path calls upstream once and returns the text', async () => {
  const res = makeRes();
  await handler(makeReq(), res);
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.body, { text: 'looks good' });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].opts.headers['x-api-key'], 'test-key');
  const sent = JSON.parse(calls[0].opts.body);
  assert.strictEqual(sent.max_tokens, 400);
});

test('prompts use real newlines, not a literal backslash-n', () => {
  const prompt = handler._TASKS.match.build({
    resume: 'my resume', jobDescription: 'the job', jobTitle: 'SDE', company: 'Acme',
  });
  assert.ok(prompt.includes('\n'));
  assert.ok(!prompt.includes('\\n'));
  assert.ok(prompt.includes('SDE at Acme'));
});

test('long inputs are clipped before being sent', () => {
  const prompt = handler._TASKS.match.build({
    resume: 'r'.repeat(20000), jobDescription: 'j'.repeat(20000),
  });
  assert.ok(prompt.length < 11000);
});

test('rate limit: the 21st request in the window gets 429', async () => {
  let last;
  for (let i = 0; i < 21; i++) {
    last = makeRes();
    await handler(makeReq(), last);
  }
  assert.strictEqual(last.statusCode, 429);
  assert.strictEqual(calls.length, 20);
});

test('rate limit is tracked per IP', async () => {
  for (let i = 0; i < 20; i++) await handler(makeReq(), makeRes());
  const other = makeRes();
  await handler(makeReq({ headers: { origin: GOOD_ORIGIN, 'x-forwarded-for': '9.9.9.9' } }), other);
  assert.strictEqual(other.statusCode, 200);
});

test('upstream failure becomes a 502 and does not leak details', async () => {
  global.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  const res = makeRes();
  await handler(makeReq(), res);
  assert.strictEqual(res.statusCode, 502);
  assert.deepStrictEqual(res.body, { error: 'upstream_error' });
});

test('network error reaching upstream becomes a 502', async () => {
  global.fetch = async () => { throw new Error('boom'); };
  const res = makeRes();
  await handler(makeReq(), res);
  assert.strictEqual(res.statusCode, 502);
});

test('returns 500 if the server has no API key configured', async () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  const res = makeRes();
  await handler(makeReq(), res);
  process.env.ANTHROPIC_API_KEY = saved;
  assert.strictEqual(res.statusCode, 500);
});

test('review: builds a recruiter prompt with the no-invention rule and the target role', () => {
  const prompt = handler._TASKS.review.build({ resume: 'Built a thing', targetRole: 'SDE fresher' });
  assert.ok(prompt.includes('Built a thing') && prompt.includes('SDE fresher'));
  assert.ok(prompt.includes('Never invent facts'));
  assert.ok(prompt.includes('[X%]'));
  assert.ok(!prompt.includes('null') && !prompt.includes('\\n'));
  assert.ok(!handler._TASKS.review.build({ resume: 'x' }).includes('is targeting'));
});

test('review: needs a resume, and clips very long input', () => {
  assert.strictEqual(handler._TASKS.review.build({ resume: '   ' }), null);
  assert.strictEqual(handler._TASKS.review.build({}), null);
  const p = handler._TASKS.review.build({ resume: 'r'.repeat(30000), targetRole: 't'.repeat(500) });
  assert.ok(p.length < 10000);
});

test('review: goes through the full handler with the larger token budget', async () => {
  const res = makeRes();
  await handler(makeReq({ body: { task: 'review', resume: 'Experience\n- Built it', targetRole: 'SDE' } }), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(JSON.parse(calls[0].opts.body).max_tokens, 1600);
});
