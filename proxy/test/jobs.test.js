'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const handler = require('../api/jobs.js');
const { htmlToText, queryGroups, filterAndRank } = handler._util;

const ORIGIN = 'https://riya-sharma01.github.io';

function makeRes() {
  const res = { statusCode: 200, headers: {}, body: undefined };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.end = () => res;
  return res;
}

function makeReq(query = {}, extra = {}) {
  return {
    method: 'GET',
    headers: { origin: ORIGIN, 'x-forwarded-for': '1.2.3.4' },
    query,
    ...extra,
  };
}

// mock fetch: routes by URL substring -> { status, body }
let calls;
function mockFetch(routes) {
  calls = [];
  global.fetch = async (url) => {
    calls.push(String(url));
    for (const [needle, reply] of routes) {
      if (String(url).includes(needle)) {
        const r = typeof reply === 'function' ? reply(String(url)) : reply;
        return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
      }
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

beforeEach(() => {
  handler._limiterHits.clear();
  delete process.env.ADZUNA_APP_ID;
  delete process.env.ADZUNA_APP_KEY;
});

const ARB_PAGE_1 = {
  data: [
    { title: 'Senior Software Developer', company_name: 'Acme', location: 'Berlin', remote: false, url: 'https://x/1', description: '<p>Build things &amp; ship.</p><ul><li>Java</li><li>SQL</li></ul>' },
    { title: 'Office Manager', company_name: 'Foo', location: 'Munich', remote: false, url: 'https://x/2', description: '<p>No code here</p>' },
  ],
};
const ARB_PAGE_2 = {
  data: [
    { title: 'Backend Engineer (Remote)', company_name: 'Bar', location: 'Anywhere', remote: true, url: 'https://x/3', description: 'Work with Java and databases.' },
    { title: 'Designer', company_name: 'Baz', location: 'Hamburg', remote: false, url: 'https://x/4', description: 'We mention software developer tools in passing.' },
  ],
};

test('rejects an origin that is not allowed', async () => {
  const res = makeRes();
  await handler(makeReq({}, { headers: { origin: 'https://evil.example' } }), res);
  assert.strictEqual(res.statusCode, 403);
});

test('rejects non-GET methods and unknown sources', async () => {
  let res = makeRes();
  await handler(makeReq({}, { method: 'POST' }), res);
  assert.strictEqual(res.statusCode, 405);
  res = makeRes();
  await handler(makeReq({ source: 'linkedin' }), res);
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.body.error, 'bad_source');
});

test('arbeitnow: reads several pages, survives one failing page, uses synonyms', async () => {
  mockFetch([
    ['page=1', { status: 200, body: ARB_PAGE_1 }],
    ['page=2', { status: 200, body: ARB_PAGE_2 }],
    ['page=3', { status: 500, body: null }],
  ]);
  const res = makeRes();
  await handler(makeReq({ source: 'arbeitnow', q: 'SDE' }), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(calls.length, 3);
  const titles = res.body.jobs.map((j) => j.title);
  // "SDE" expands to software developer/engineer, so the title hit ranks first
  assert.strictEqual(titles[0], 'Senior Software Developer');
  assert.ok(!titles.includes('Office Manager'));
  assert.strictEqual(res.body.scanned, 4);
  assert.strictEqual(res.headers['Cache-Control'], 'public, s-maxage=300');
});

test('arbeitnow: descriptions come back as clean text', async () => {
  mockFetch([['page=', { status: 200, body: ARB_PAGE_1 }]]);
  const res = makeRes();
  await handler(makeReq({ source: 'arbeitnow', q: 'developer' }), res);
  const d = res.body.jobs[0].description;
  assert.ok(d.includes('Build things & ship.'));
  assert.ok(d.includes('- Java'));
  assert.ok(!/<[a-z]/i.test(d));
  assert.ok(!d.includes('&amp;'));
});

test('arbeitnow: location filter, including remote', async () => {
  mockFetch([['page=', { status: 200, body: ARB_PAGE_2 }]]);
  let res = makeRes();
  await handler(makeReq({ source: 'arbeitnow', q: '', location: 'india' }), res);
  assert.strictEqual(res.body.jobs.length, 0);
  res = makeRes();
  await handler(makeReq({ source: 'arbeitnow', q: '', location: 'remote' }), res);
  assert.deepStrictEqual(res.body.jobs.map((j) => j.title), ['Backend Engineer (Remote)']);
});

test('arbeitnow: every page failing is reported as unavailable', async () => {
  mockFetch([['page=', { status: 500, body: null }]]);
  const res = makeRes();
  await handler(makeReq({ source: 'arbeitnow', q: 'java' }), res);
  assert.strictEqual(res.statusCode, 502);
  assert.strictEqual(res.body.error, 'source_unavailable');
});

test('adzuna: 503 when keys are not configured', async () => {
  mockFetch([]);
  const res = makeRes();
  await handler(makeReq({ source: 'adzuna', q: 'java' }), res);
  assert.strictEqual(res.statusCode, 503);
  assert.strictEqual(res.body.error, 'source_not_configured');
  assert.strictEqual(calls.length, 0);
});

test('adzuna: builds the request, normalises results, defaults the country', async () => {
  process.env.ADZUNA_APP_ID = 'id1';
  process.env.ADZUNA_APP_KEY = 'key1';
  mockFetch([['adzuna.com', { status: 200, body: { results: [
    { title: 'Java Developer', company: { display_name: 'Zeta' }, location: { display_name: 'Pune, Maharashtra' }, description: 'Short <b>preview</b>', redirect_url: 'https://adz/1' },
  ] } }]]);
  const res = makeRes();
  await handler(makeReq({ source: 'adzuna', q: 'java developer', location: 'Pune', country: 'zz' }), res);
  assert.strictEqual(res.statusCode, 200);
  assert.ok(calls[0].includes('/jobs/in/search/1'), calls[0]); // unknown country falls back to India
  assert.ok(calls[0].includes('what=java+developer') && calls[0].includes('where=Pune'));
  assert.deepStrictEqual(res.body.jobs[0], {
    title: 'Java Developer', company: 'Zeta', location: 'Pune, Maharashtra',
    url: 'https://adz/1', description: 'Short preview', remote: false, source: 'Adzuna',
  });
  assert.ok(res.body.note.includes('preview'));
});

test('company: rejects slugs that could change the request path', async () => {
  mockFetch([]);
  for (const bad of ['', '../etc', 'a/b', 'x?y=1', 'a b']) {
    const res = makeRes();
    await handler(makeReq({ source: 'company', company: bad }), res);
    assert.strictEqual(res.statusCode, 400, JSON.stringify(bad));
  }
  assert.strictEqual(calls.length, 0);
});

test('company: Greenhouse board with entity-escaped HTML', async () => {
  mockFetch([['boards-api.greenhouse.io/v1/boards/acme/jobs', { status: 200, body: { jobs: [
    { title: 'Software Engineer, New Grad', location: { name: 'Bengaluru' }, absolute_url: 'https://gh/1', content: '&lt;p&gt;Join us &amp;amp; build.&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Python&lt;/li&gt;&lt;/ul&gt;' },
    { title: 'Recruiter', location: { name: 'Delhi' }, absolute_url: 'https://gh/2', content: '&lt;p&gt;People&lt;/p&gt;' },
  ] } }]]);
  const res = makeRes();
  await handler(makeReq({ source: 'company', company: 'acme', q: 'software engineer', location: 'bengaluru' }), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.jobs.length, 1);
  assert.strictEqual(res.body.jobs[0].source, 'Greenhouse');
  assert.ok(res.body.jobs[0].description.includes('Join us & build.'));
  assert.ok(res.body.jobs[0].description.includes('- Python'));
});

test('company: falls back to Lever when there is no Greenhouse board', async () => {
  mockFetch([
    ['boards-api.greenhouse.io', { status: 404, body: null }],
    ['api.lever.co/v0/postings/acme', { status: 200, body: [
      { text: 'Backend Engineer', categories: { location: 'Remote - India' }, hostedUrl: 'https://lever/1', descriptionPlain: 'Build APIs.', lists: [{ text: 'Requirements', content: '<li>Java</li>' }], additionalPlain: 'Great team.' },
    ] }],
  ]);
  const res = makeRes();
  await handler(makeReq({ source: 'company', company: 'acme', q: 'backend' }), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.jobs[0].source, 'Lever');
  assert.ok(res.body.jobs[0].description.includes('Build APIs.'));
  assert.ok(res.body.jobs[0].description.includes('Requirements'));
  assert.strictEqual(res.body.jobs[0].remote, true);
});

test('company: 404 when neither Greenhouse nor Lever knows the slug', async () => {
  mockFetch([]);
  const res = makeRes();
  await handler(makeReq({ source: 'company', company: 'nope-co' }), res);
  assert.strictEqual(res.statusCode, 404);
  assert.strictEqual(res.body.error, 'company_not_found');
});

test('a network failure becomes source_unavailable, not a crash', async () => {
  global.fetch = async () => { throw new Error('boom'); };
  const res = makeRes();
  await handler(makeReq({ source: 'company', company: 'acme' }), res);
  assert.strictEqual(res.statusCode, 502);
});

test('htmlToText handles tags, lists, entities and double-encoding', () => {
  assert.strictEqual(htmlToText('<p>A &amp; B</p><p>C&nbsp;D</p>'), 'A & B\nC D');
  assert.strictEqual(htmlToText('<ul><li>x</li><li>y</li></ul>'), '- x\n- y');
  assert.strictEqual(htmlToText('&lt;p&gt;hi &amp;amp; bye&lt;/p&gt;', true), 'hi & bye');
  assert.strictEqual(htmlToText('<script>alert(1)</script>safe'), 'safe');
  assert.strictEqual(htmlToText('&#8217;&#x41;'), '\u2019A');
});

test('queryGroups keeps tech tokens and drops bare numbers', () => {
  assert.deepStrictEqual(queryGroups('C++ node.js 2').map((g) => g[0]), ['c++', 'node.js']);
  assert.ok(queryGroups('sde')[0].includes('software engineer'));
});

test('filterAndRank needs every search word, and ranks title hits first', () => {
  const jobs = [
    { title: 'Designer', company: 'a', description: 'java and sql', location: '' },
    { title: 'Java Developer', company: 'b', description: 'sql', location: '' },
    { title: 'Cook', company: 'c', description: 'pasta', location: '' },
  ];
  assert.deepStrictEqual(filterAndRank(jobs, 'java sql', '').map((j) => j.title), ['Java Developer', 'Designer']);
  assert.strictEqual(filterAndRank(jobs, '', '').length, 3);
});

test('rate limit: the 61st search in the window gets 429', async () => {
  mockFetch([['page=', { status: 200, body: ARB_PAGE_1 }]]);
  let last;
  for (let i = 0; i < 61; i++) {
    last = makeRes();
    await handler(makeReq({ source: 'arbeitnow', q: 'java' }), last);
  }
  assert.strictEqual(last.statusCode, 429);
});

test('arbeitnow: the same listing on two pages is only returned once', async () => {
  mockFetch([['page=', { status: 200, body: ARB_PAGE_1 }]]); // all 3 pages return identical data
  const res = makeRes();
  await handler(makeReq({ source: 'arbeitnow', q: '' }), res);
  assert.strictEqual(res.body.scanned, 2);
  assert.strictEqual(res.body.jobs.length, 2);
});
