const { start } = require('./lib');
const fs = require('fs'), assert = require('assert');
const RESUME = fs.readFileSync(require('path').join(__dirname, 'fixture-resume.txt'), 'utf8');
const step = (m) => console.log('  ok  ' + m);

(async () => {
  const t = await start(); const { page, world } = t;
  const stage = (n) => page.locator('[data-stage=' + n + ']').click();
  const text = (sel) => page.locator(sel).innerText();
  await page.goto('http://localhost:8099/');

  // ---- resume: paste, save, score, ATS, review ----
  await stage('resume');
  await page.fill('#resumeInput', RESUME);
  await page.click('#saveResumeBtn');
  await page.waitForSelector('#scoreCard .num');
  const score = +(await text('#scoreCard .num'));
  assert.ok(score >= 90 && score <= 100, 'score ' + score);
  assert.ok((await text('#atsCard')).includes('6/6'));
  const cats = await page.locator('#reviewCard h3').allTextContents();
  assert.ok(cats.some((c) => c.startsWith('Impact')) && cats.some((c) => c.startsWith('Structure')), JSON.stringify(cats));
  assert.ok((await text('#reviewCard')).includes('Skills detected (25)'), 'skills count');
  assert.ok(!(await text('#reviewCard')).includes('\nSystems\n'), 'no stray Systems skill');
  step('resume pasted and saved: score ' + score + ', ATS 6/6, 4 review cards, 25 skills');

  // ---- theme toggle ----
  const before = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  await page.click('#themeToggleBtn');
  const after = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  assert.notStrictEqual(before, after); await page.click('#themeToggleBtn');
  step('theme toggle: ' + before + ' -> ' + after);

  // ---- scout: open board, straight from the browser ----
  await stage('scout');
  await page.selectOption('#searchSource', 'arbeitnow');
  await page.fill('#searchKeyword', 'java');
  await page.click('#searchJobsBtn');
  await page.waitForSelector('#searchResults .job-item');
  const titles = await page.locator('#searchResults .title').allTextContents();
  assert.deepStrictEqual(titles.sort(), ['Backend Developer', 'Remote Software Engineer']);
  assert.ok((await text('#searchResults')).includes('View posting'));
  await page.locator('#searchResults .job-item', { hasText: 'Backend Developer' }).locator('button').click();
  assert.strictEqual((await text('#countJobs')).trim(), '1');
  await page.locator('#searchResults .job-item', { hasText: 'Backend Developer' }).locator('button').click(); // duplicate
  assert.strictEqual((await text('#countJobs')).trim(), '1', 'duplicates are skipped');
  step('open board: 2 of 3 listings matched "java", one added, duplicate refused');

  // ---- scout: company board ----
  await page.selectOption('#searchSource', 'company');
  assert.ok(await page.locator('#companyField').isVisible());
  await page.fill('#searchCompany', 'acme'); await page.fill('#searchKeyword', 'software engineer'); await page.fill('#searchLocation', 'bengaluru');
  await page.click('#searchJobsBtn');
  await page.waitForSelector('#searchResults .job-item');
  assert.strictEqual(await page.locator('#searchResults .job-item').count(), 1);
  await page.locator('#searchResults .job-item button').click();
  await page.fill('#searchCompany', 'nosuchco'); await page.click('#searchJobsBtn');
  await page.waitForFunction(() => document.getElementById('searchStatus').innerText.includes('No Greenhouse or Lever board'));
  step('company board: filtered to 1 job; unknown company gives a clear message');

  // ---- scout: Adzuna with no keys, then with keys when the browser blocks the normal request ----
  await page.selectOption('#searchSource', 'adzuna'); await page.fill('#searchKeyword', 'java'); await page.fill('#searchLocation', '');
  await page.click('#searchJobsBtn');
  await page.waitForFunction(() => document.getElementById('searchStatus').innerText.includes('needs free keys'));
  assert.strictEqual(world.adzunaCalls.length, 0);
  await stage('overview');
  await page.fill('#adzunaIdInput', 'my-app-id'); await page.fill('#adzunaKeyInput', 'my-app-key'); await page.click('#saveAdzunaBtn');
  await page.waitForFunction(() => document.getElementById('adzunaNote').innerText.includes('saved'));
  assert.ok((await text('#statusRows')).includes('Adzuna is on (your keys)'));
  await stage('scout'); world.adzunaMode = 'cors-blocked'; world.adzunaCalls.length = 0;
  await page.click('#searchJobsBtn');
  await page.waitForSelector('#searchResults .job-item');
  assert.deepStrictEqual((await page.locator('#searchResults .title').allTextContents()).sort(), ['Java Developer', 'SDE Intern']);
  const kinds = world.adzunaCalls.map((c) => c.type);
  assert.ok(kinds.includes('script'), 'fell back to the sandboxed script: ' + kinds);
  assert.strictEqual(await page.locator('iframe').count(), 0, 'sandbox iframe cleaned up');
  assert.ok((await text('#searchStatus')).includes('short preview'));
  const jsonpUrl = world.adzunaCalls.find((c) => c.type === 'script').url;
  assert.ok(jsonpUrl.includes('app_id=my-app-id') && jsonpUrl.includes('callback=cb') && !jsonpUrl.includes('content-type'), jsonpUrl);
  step('Adzuna: normal request blocked by the browser -> sandboxed fallback returned 2 jobs (' + kinds.join(', ') + ')');

  world.adzunaMode = 'cors-ok'; world.adzunaCalls.length = 0;
  await page.click('#searchJobsBtn'); await page.waitForSelector('#searchResults .job-item');
  assert.ok(!world.adzunaCalls.some((c) => c.type === 'script'), 'no fallback needed when the browser allows it');
  await page.locator('#searchResults .job-item', { hasText: 'Java Developer' }).locator('button').click();
  assert.strictEqual((await text('#countJobs')).trim(), '3');
  step('Adzuna: when the browser allows it, the normal request is used (no fallback)');

  world.adzunaMode = 'bad-keys';
  await page.click('#searchJobsBtn');
  await page.waitForFunction(() => document.getElementById('searchStatus').innerText.includes('rejected the keys'));
  step('Adzuna: rejected keys are named');
  world.adzunaMode = 'cors-blocked';

  // ---- isolation: hostile Adzuna script cannot reach this page ----
  await page.evaluate(() => localStorage.setItem('jobapplyagent-secret', 'TOP-SECRET'));
  world.adzunaMode = 'malicious';
  const leak = await page.evaluate(() => jsonpSandboxed('https://api.adzuna.com/v1/api/jobs/in/search/1?app_id=x&app_key=y'));
  assert.ok(leak.leakStorage.startsWith('blocked:'), 'storage: ' + leak.leakStorage);
  assert.ok(leak.leakDom.startsWith('blocked:'), 'dom: ' + leak.leakDom);
  assert.ok(leak.leakCookie.startsWith('blocked:'), 'cookie: ' + leak.leakCookie);
  step('sandbox isolation: hostile script blocked from storage (' + leak.leakStorage + '), page DOM and cookies');
  world.adzunaMode = 'bad-keys';
  await assert.rejects(page.evaluate(async () => { try { await jsonpSandboxed('https://api.adzuna.com/x?a=1', 3000); } catch (e) { throw new Error(e.message); } }), /JSONP_FAILED/);
  world.adzunaMode = 'cors-blocked';

  // ---- AI: own key, read-through, match, prep, feedback ----
  await stage('overview');
  await page.fill('#ownKeyInput', 'sk-test-123'); await page.click('#saveOwnKeyBtn');
  assert.ok((await text('#statusRows')).includes('Ready, using your own key'));
  await stage('resume'); await page.fill('#aiRole', 'SDE fresher'); await page.click('#aiReviewBtn');
  await page.waitForSelector('#aiReviewResults button');
  assert.ok((await text('#aiReviewResults')).includes('A solid fresher resume'));
  assert.ok((await text('#aiReviewResults')).includes('Wrote reusable [language] scripts'));
  const call = world.anthropic[world.anthropic.length - 1];
  assert.strictEqual(call.key, 'sk-test-123'); assert.strictEqual(call.direct, 'true');
  assert.ok(call.prompt.includes('SDE fresher') && call.prompt.includes('Acme Systems'), 'prompt carries the role and the resume');
  step('AI read-through: key + browser-access header sent, prompt has role and resume, 2 issues shown');

  await stage('match'); await page.click('#analyzeBtn');
  await page.waitForFunction(() => document.getElementById('matchResult').innerText.includes('72'));
  assert.ok((await text('#matchResult')).includes('Java experience'));
  step('Match & tailor: score 72, strengths and bullets shown');
  await stage('prepare'); await page.click('#prepGenBtn');
  await page.waitForSelector('#prepResult .qa');
  await page.locator('#prepResult .qa .q').first().click();
  await page.fill('#answer-0', 'I built a regression tool that cut run time.');
  await page.locator('.qa.open button').click();
  await page.waitForFunction(() => document.getElementById('feedback-0').innerText.includes('STAR'));
  step('Prepare: questions generated, practice answer got feedback');

  // ---- tracker, persistence, backup ----
  await stage('track');
  assert.ok(await page.locator('#trackTableBody tr').count() >= 3);
  await page.locator('#trackTableBody select').first().selectOption('Applied');
  await page.reload(); await page.waitForTimeout(300);
  assert.ok((await text('#countJobs')).trim() >= '3', 'jobs survive a reload');
  await stage('resume');
  assert.ok((await page.inputValue('#resumeInput')).includes('Acme Systems'), 'resume survives a reload');
  assert.ok((await text('#aiReviewResults')).includes('A solid fresher resume'), 'AI read survives a reload');
  await stage('track');
  assert.strictEqual(await page.locator('#trackTableBody select').first().inputValue(), 'Applied');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#exportBtn')]);
  const backup = JSON.parse(fs.readFileSync(await dl.path(), 'utf8'));
  assert.ok(backup.jobs.length >= 3 && backup.resume.includes('Acme Systems') && backup.aiReview);
  assert.ok(!JSON.stringify(backup).includes('sk-test-123'), 'the AI key is not in the backup');
  step('tracker status, resume and AI read survive a reload; backup downloads without the key');

  const real = world.errors.filter((e) => !e.startsWith('console: Failed to load resource'));   // the deliberate 404 / 401 / blocked requests above
  console.log('\nreal script errors during the whole run:', JSON.stringify(real));
  assert.deepStrictEqual(real, []);
  await t.close();
  console.log('REAL BROWSER TEST: all steps passed');
})().catch((e) => { console.error('\nFAIL:', e.message); process.exit(1); });
