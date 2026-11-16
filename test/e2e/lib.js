const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..', '..'); // the site folder
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

const ARB = { data: [
  { title: 'Backend Developer', company_name: 'Acme GmbH', location: 'Berlin', remote: false, url: 'https://arb.example/1', description: '<p>Build APIs with Java &amp; SQL.</p><ul><li>Spring Boot</li></ul>' },
  { title: 'Remote Software Engineer', company_name: 'Globex', location: 'Anywhere', remote: true, url: 'https://arb.example/2', description: 'Work on Java services.' },
  { title: 'Office Manager', company_name: 'Foo', location: 'Munich', remote: false, url: 'https://arb.example/3', description: 'No code.' } ] };
const GH = { jobs: [
  { title: 'Software Engineer, New Grad', location: { name: 'Bengaluru' }, absolute_url: 'https://gh.example/1', content: '&lt;p&gt;Join us &amp;amp; build.&lt;/p&gt;' },
  { title: 'Recruiter', location: { name: 'Delhi' }, absolute_url: 'https://gh.example/2', content: '&lt;p&gt;People&lt;/p&gt;' } ] };
const ADZ = { results: [
  { title: 'Java Developer', company: { display_name: 'Zeta Tech' }, location: { display_name: 'Pune, Maharashtra' }, description: 'Short <b>preview</b> of the role', redirect_url: 'https://adz.example/1' },
  { title: 'SDE Intern', company: { display_name: 'Omega' }, location: { display_name: 'Bengaluru, Karnataka' }, description: 'Intern role', redirect_url: 'https://adz.example/2' } ] };
const REVIEW = { summary: 'A solid fresher resume with real projects.', strengths: ['Clear internship', 'Good links'], issues: [
  { severity: 'high', where: 'Authored reusable scripts for 4 stages', problem: 'Does not say what the scripts are written in.', rewrite: 'Wrote reusable [language] scripts for 4 test stages.' },
  { severity: 'low', where: 'Professional Summary', problem: 'Too long for a fresher.', rewrite: '' } ], missing: ['No deployed demo link on projects'] };
const MATCH = { matchScore: 72, strengths: ['Java experience'], gaps: ['No Kubernetes'], summary: 'Backend-focused student with Java and testing experience.', bullets: ['Built REST APIs in Spring Boot'] };
const PREP = { talkingPoints: ['Know the product'], questions: [{ q: 'Tell me about a project you shipped.', why: 'Ownership', tip: 'Use STAR' }], questionsToAsk: ['What does onboarding look like?'] };

async function start() {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
    const f = path.join(ROOT, p);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'text/plain' }); fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => server.listen(8099, r));
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
  const world = { adzunaMode: 'cors-blocked', anthropic: [], adzunaCalls: [], errors: [] };
  const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
  await ctx.route('**/*', async (route) => {
    const req = route.request(); const url = new URL(req.url());
    if (url.hostname === 'localhost') return route.continue();
    const json = (status, body, cors = true) => route.fulfill({ status, contentType: 'application/json', headers: cors ? CORS : {}, body: JSON.stringify(body) });
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    if (url.hostname === 'cdnjs.cloudflare.com') {
      const body = url.pathname.includes('mammoth') ? 'window.mammoth={convertToHtml:async()=>({value:""})};' : 'window.pdfjsLib={GlobalWorkerOptions:{},getDocument:()=>({promise:Promise.reject(new Error("stub"))})};';
      return route.fulfill({ status: 200, contentType: 'application/javascript', body });
    }
    if (url.hostname.includes('fonts.')) return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
    if (url.hostname.endsWith('arbeitnow.com')) return json(200, ARB);
    if (url.hostname === 'boards-api.greenhouse.io') return json(url.pathname.includes('/acme/') ? 200 : 404, url.pathname.includes('/acme/') ? GH : {});
    if (url.hostname === 'api.adzuna.com') {
      world.adzunaCalls.push({ type: req.resourceType(), url: req.url() });
      if (req.resourceType() === 'script') {
        const cb = url.searchParams.get('callback');
        if (world.adzunaMode === 'bad-keys') return route.fulfill({ status: 401, contentType: 'application/javascript', body: '{"exception":"AUTH_FAIL"}' });
        if (world.adzunaMode === 'malicious') {
          return route.fulfill({ status: 200, contentType: 'application/javascript', body:
            "var a='none',b='none',c='none';try{a=String(parent.localStorage.getItem('jobapplyagent-data'))}catch(e){a='blocked:'+e.name}" +
            "try{b=String(parent.document.title)}catch(e){b='blocked:'+e.name}try{c=String(top.document.cookie)}catch(e){c='blocked:'+e.name}" +
            cb + '({results:[],leakStorage:a,leakDom:b,leakCookie:c});' });
        }
        return route.fulfill({ status: 200, contentType: 'application/javascript', body: cb + '(' + JSON.stringify(ADZ) + ');' });
      }
      if (world.adzunaMode === 'cors-ok') return json(200, ADZ);
      if (world.adzunaMode === 'bad-keys') return json(401, { exception: 'AUTH_FAIL' });
      return route.abort('failed'); // what the page sees when the browser refuses a cross-origin request
    }
    if (url.hostname === 'api.anthropic.com') {
      const body = JSON.parse(req.postData() || '{}'); const prompt = (body.messages && body.messages[0].content) || '';
      world.anthropic.push({ key: req.headers()['x-api-key'], direct: req.headers()['anthropic-dangerous-direct-browser-access'], model: body.model, max_tokens: body.max_tokens, prompt });
      let text = 'Good STAR structure. Add a concrete result with a number.';
      if (prompt.includes('experienced technical recruiter')) text = JSON.stringify(REVIEW);
      else if (prompt.includes('Compare this resume against this job description')) text = JSON.stringify(MATCH);
      else if (prompt.includes('preparing a candidate for an interview')) text = JSON.stringify(PREP);
      return json(200, { content: [{ type: 'text', text }] });
    }
    return route.fulfill({ status: 404, body: 'unexpected host ' + url.hostname });
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => world.errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') world.errors.push('console: ' + m.text()); });
  return { server, browser, ctx, page, world, close: async () => { await browser.close(); server.close(); } };
}
module.exports = { start };
