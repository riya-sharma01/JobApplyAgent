if(window['pdfjsLib']){
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}
const { checkATS, itemsToText, htmlToPlain, normalizeText } = window.AtsTools;
const { analyzeResume, scoreResume, normalizeReview, textHash } = window.ResumeTools;
const Prompts = window.Prompts;
const JobsCore = window.JobsCore;
let state = { resume: '', jobs: [], tailored: {}, preps: {}, resumeATS: null, aiReview: null };
const STORAGE_KEY = 'jobapplyagent-data';
// Set this to your deployed proxy's URL (see README: "Setting up the AI proxy").
const PROXY_URL = 'https://YOUR-PROXY.vercel.app/api/chat';
// ---------- CONFIG ----------
const OWN_KEY_STORAGE = 'jobapplyagent-ai-key';
const HEALTH_URL = PROXY_URL.replace(/\/chat$/, '/health');
const proxyReady = () => !PROXY_URL.includes('YOUR-PROXY');
const getOwnKey = () => localStorage.getItem(OWN_KEY_STORAGE) || '';
// ---------- /CONFIG ----------
const THEME_STORAGE_KEY = 'jobapplyagent-theme';

function migrateOldKeys(){
  // one-time migration from the app's previous name, "Pipeline"
  if(!localStorage.getItem(STORAGE_KEY) && localStorage.getItem('pipeline-data')){
    localStorage.setItem(STORAGE_KEY, localStorage.getItem('pipeline-data'));
  }
  if(!localStorage.getItem(THEME_STORAGE_KEY) && localStorage.getItem('pipeline-theme')){
    localStorage.setItem(THEME_STORAGE_KEY, localStorage.getItem('pipeline-theme'));
  }
  // remove API keys stored under the older names
  ['jobapplyagent-anthropic-key', 'pipeline-anthropic-key'].forEach(k => localStorage.removeItem(k));
}
migrateOldKeys();

function loadState(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if(raw){
      const parsed = JSON.parse(raw);
      state = Object.assign(state, parsed);
    }
  }catch(e){ /* no saved data yet, or storage unavailable */ }
  state.resumeATS = state.resume ? checkATS(state.resume) : null;
  render();
}

function persist(){
  try{
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }catch(e){ console.error('save failed', e); }
}

// ---------- THEME ----------
function applyTheme(theme){
  document.documentElement.setAttribute('data-theme', theme);
  document.getElementById('themeToggleLabel').textContent = theme === 'dark' ? 'Dark mode' : 'Light mode';
  localStorage.setItem(THEME_STORAGE_KEY, theme);
}
(function initTheme(){
  const saved = localStorage.getItem(THEME_STORAGE_KEY);
  const theme = saved || (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  applyTheme(theme);
})();
document.getElementById('themeToggleBtn').addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme');
  applyTheme(current === 'dark' ? 'light' : 'dark');
});

function switchStage(stage){
  document.querySelectorAll('.stage-btn').forEach(b => b.classList.toggle('active', b.dataset.stage === stage));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + stage));
  render();
}
document.querySelectorAll('.stage-btn').forEach(b => b.addEventListener('click', () => switchStage(b.dataset.stage)));

function uid(){ return 'j' + Math.random().toString(36).slice(2, 10); }
function escapeHtml(s){ return (s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function showToast(message, type){
  const container = document.getElementById('toastContainer');
  const el = document.createElement('div');
  el.className = 'toast' + (type ? ' ' + type : '');
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

async function callProxy(task, payload){
  let response;
  try{
    response = await fetch(PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ task: task }, payload))
    });
  }catch(e){
    throw new Error('NETWORK');
  }
  if(response.status === 429) throw new Error('RATE_LIMITED');
  if(!response.ok) throw new Error('API_ERROR');
  const data = await response.json();
  if(!data || typeof data.text !== 'string') throw new Error('API_ERROR');
  return data.text;
}

// Calls the AI straight from the browser with the person's own key. Same prompts as the proxy.
async function callDirect(task, payload, key){
  const def = Prompts.TASKS[task];
  const prompt = def && def.build(payload);
  if(!prompt) throw new Error('API_ERROR');
  let response;
  try{
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({ model: Prompts.DEFAULT_MODEL, max_tokens: def.maxTokens, messages: [{ role: 'user', content: prompt }] })
    });
  }catch(e){
    throw new Error('NETWORK');
  }
  if(response.status === 401 || response.status === 403) throw new Error('BAD_KEY');
  if(response.status === 429) throw new Error('RATE_LIMITED');
  if(!response.ok) throw new Error('API_ERROR');
  const data = await response.json();
  const block = ((data && data.content) || []).find(b => b.type === 'text');
  if(!block) throw new Error('API_ERROR');
  return block.text;
}

// A key the person saved themselves wins; otherwise the proxy; otherwise AI is off.
async function callApi(task, payload){
  const key = getOwnKey();
  if(key) return callDirect(task, payload, key);
  if(proxyReady()) return callProxy(task, payload);
  throw new Error('NOT_CONFIGURED');
}

async function callApiJson(task, payload, normalize){
  for(let attempt = 0; attempt < 2; attempt++){
    const text = await callApi(task, payload); // network and rate-limit errors stop here, no retry
    try{
      const result = normalize(extractJSON(text));
      if(result) return result;
    }catch(e){ /* unreadable reply: try once more */ }
  }
  throw new Error('BAD_RESPONSE');
}

function apiErrorMessage(e){
  const code = e && e.message;
  if(code === 'NOT_CONFIGURED') return 'AI features are not switched on yet. Add your own AI key in Overview, under "Your AI key" (it stays in this browser), or connect the proxy (see the README).';
  if(code === 'BAD_KEY') return 'The AI service rejected that key. Check it in Overview, under "Your AI key".';
  if(code === 'RATE_LIMITED') return 'Too many AI requests from your network just now. Wait a few minutes and try again.';
  if(code === 'NETWORK') return 'Could not reach the AI service. Check your connection and try again.';
  if(code === 'BAD_RESPONSE') return 'The AI sent back something we could not read, twice. Try again in a moment.';
  return 'Something went wrong reaching the AI. Try again.';
}

function extractJSON(text){
  const cleaned = text.replace(/```json/g, '').replace(/```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if(start === -1 || end === -1) throw new Error('No JSON found in response');
  return JSON.parse(cleaned.slice(start, end + 1));
}

// ---------- RESUME ----------
document.getElementById('resumeFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if(!file) return;
  const statusEl = document.getElementById('fileParseStatus');
  statusEl.innerHTML = '<div class="loading"><span class="dot"></span> Reading ' + escapeHtml(file.name) + '...</div>';
  try{
    const ext = file.name.split('.').pop().toLowerCase();
    let text = '';
    if(ext === 'txt'){
      text = await file.text();
    } else if(ext === 'docx'){
      const buf = await file.arrayBuffer();
      const result = await mammoth.convertToHtml({ arrayBuffer: buf });
      text = htmlToPlain(result.value);
    } else if(ext === 'pdf'){
      const buf = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
      const pages = [];
      for(let p = 1; p <= pdf.numPages; p++){
        const page = await pdf.getPage(p);
        const content = await page.getTextContent();
        pages.push(itemsToText(content.items));
      }
      text = pages.join('\n\n');
    } else {
      throw new Error('unsupported file type');
    }
    text = normalizeText(text).trim();
    if(text.length < 30){
      statusEl.innerHTML = '<span class="error-text">Barely any text came out of that file — it may be a scanned or image-based PDF, which most ATS systems also can\'t read. Try pasting the text directly instead.</span>';
      return;
    }
    document.getElementById('resumeInput').value = text;
    statusEl.textContent = 'Extracted ' + text.split(/\s+/).length + ' words from ' + file.name + '. Review below, then save.';
  }catch(err){
    statusEl.innerHTML = '<span class="error-text">Couldn\'t read that file. Try a different format or paste the text directly.</span>';
  }
});

document.getElementById('saveResumeBtn').addEventListener('click', async () => {
  state.resume = document.getElementById('resumeInput').value.trim();
  state.resumeATS = state.resume ? checkATS(state.resume) : null;
  await persist();
  const note = document.getElementById('resumeSavedNote');
  note.textContent = 'Saved.';
  showToast('Resume saved and checked.', 'success');
  setTimeout(() => note.textContent = '', 2000);
  renderScore();
  renderAiReview();
  renderATSCard();
  renderReview();
  renderOverview();
});

function atsCounts(ats){
  const items = (ats && ats.items) || [];
  return { passed: items.filter(i => i.pass).length, total: items.length };
}

function renderATSCard(){
  const el = document.getElementById('atsCard');
  const ats = state.resume ? checkATS(state.resume) : null;
  if(!ats){ el.innerHTML = ''; return; }
  const c = atsCounts(ats);
  el.innerHTML =
    '<div class="card">' +
      '<h3>Basic ATS checks</h3>' +
      '<div class="score-ring"><span class="num">' + c.passed + '/' + c.total + '</span><span class="lbl">checks passed</span></div>' +
      (ats.items || []).map(i =>
        '<div class="ats-row"><span class="ats-icon ' + (i.pass ? 'pass' : 'warn') + '">' + (i.pass ? '\u2713' : '!') + '</span>' +
        '<div class="body"><div class="lbl">' + escapeHtml(i.label) + '</div><div class="note-text">' + escapeHtml(i.note) + '</div></div></div>'
      ).join('') +
      '<div class="note">These are text and format basics, not a guarantee. They do not check how well you match a specific job, and they cannot see multi-column layouts, tables or images in the original file. For that, keep the file to a single column with no text boxes or graphics.</div>' +
    '</div>';
}

// ---------- RESUME SCORE ----------
function isFlattened(text){
  return text.split('\n').filter(l => l.trim()).length < 8;
}

const FLATTENED_NOTE = 'Your saved resume has lost its line breaks, so it cannot be read properly. Upload the file again (or paste the text with its line breaks) and click Save.';

function renderScore(){
  const el = document.getElementById('scoreCard');
  if(!state.resume){ el.innerHTML = ''; return; }
  if(isFlattened(state.resume)){
    el.innerHTML = '<div class="card"><h3>Resume score</h3><p class="note" style="margin:0; color:var(--ember);">' + FLATTENED_NOTE + '</p></div>';
    return;
  }
  const s = scoreResume(analyzeResume(state.resume), checkATS(state.resume));
  el.innerHTML =
    '<div class="card"><h3>Resume score</h3>' +
      '<div class="score-ring"><span class="num">' + s.overall + '</span><span class="lbl">/ 100 (estimate)</span></div>' +
      s.categories.map(c =>
        '<div class="funnel-row"><span class="funnel-label">' + escapeHtml(c.title) + '</span>' +
        '<div class="funnel-track"><div class="funnel-fill" style="width:' + c.percent + '%"></div></div>' +
        '<span class="funnel-count" style="width:40px;">' + c.percent + '%</span></div>').join('') +
      '<div class="note">Built from the checks below: ATS basics 20 points, Impact 35, Brevity 15, Style 10, Structure 20. It measures wording and structure, not how strong your experience is, and no real ATS or recruiter produces this number. The AI read-through covers the content.</div>' +
    '</div>';
}

// ---------- AI READ-THROUGH ----------
function renderAiReview(){
  const el = document.getElementById('aiReviewResults');
  const saved = state.aiReview;
  const roleEl = document.getElementById('aiRole');
  if(saved && saved.role && !roleEl.value) roleEl.value = saved.role;
  if(!saved || !saved.review){ el.innerHTML = ''; return; }
  const rv = saved.review;
  const stale = saved.hash !== textHash(state.resume);
  const sev = { high: ['High', 'var(--danger)'], medium: ['Medium', 'var(--ember)'], low: ['Low', 'var(--muted)'] };
  const heading = t => '<div style="font-size:12.5px; color:var(--muted); margin:16px 0 6px;">' + t + '</div>';
  el.innerHTML =
    (stale ? '<div class="note" style="color:var(--ember);">Your resume has changed since this read. Run it again for current feedback.</div>' : '') +
    (rv.summary ? '<p style="font-size:14px; margin:14px 0 4px;">' + escapeHtml(rv.summary) + '</p>' : '') +
    (rv.strengths.length ? heading('What works') + '<ul class="plain">' + rv.strengths.map(x => '<li>' + escapeHtml(x) + '</li>').join('') + '</ul>' : '') +
    (rv.issues.length ? heading('What to fix') + rv.issues.map((i, n) =>
      '<div style="border-top:1px solid var(--line); padding:12px 0;">' +
        '<div style="font-size:12px; font-weight:600; color:' + sev[i.severity][1] + ';">' + sev[i.severity][0] + '</div>' +
        (i.where ? '<div style="font-size:12.5px; color:var(--muted); margin:4px 0;">\u201c' + escapeHtml(i.where) + '\u201d</div>' : '') +
        '<div style="font-size:13.5px;">' + escapeHtml(i.problem) + '</div>' +
        (i.rewrite ? '<div style="margin-top:8px; padding:8px 10px; background:var(--panel-2); border-radius:var(--radius); font-size:13.5px;">' + escapeHtml(i.rewrite) + '</div>' +
          '<button class="btn secondary small" style="margin-top:6px;" onclick="copyReviewRewrite(' + n + ')">Copy rewrite</button>' : '') +
      '</div>').join('') : '') +
    (rv.missing.length ? heading('What a recruiter would look for') + '<ul class="plain">' + rv.missing.map(x => '<li>' + escapeHtml(x) + '</li>').join('') + '</ul>' : '') +
    '<div class="note">AI suggestions can be wrong. Keep a rewrite only if it is true, and replace every [placeholder] with a real figure you could back up in an interview.</div>';
}

function copyReviewRewrite(n){
  const issue = state.aiReview && state.aiReview.review && state.aiReview.review.issues[Number(n)];
  if(!issue) return;
  navigator.clipboard.writeText(issue.rewrite)
    .then(() => showToast('Copied to clipboard.', 'success'))
    .catch(() => showToast('Could not copy. Select the text and copy it manually.', 'error'));
}

document.getElementById('aiReviewBtn').addEventListener('click', async () => {
  const statusEl = document.getElementById('aiReviewStatus');
  const btn = document.getElementById('aiReviewBtn');
  if(!state.resume){
    statusEl.innerHTML = '<span class="error-text">Save your resume first.</span>';
    return;
  }
  if(isFlattened(state.resume)){
    statusEl.innerHTML = '<span class="error-text">' + escapeHtml(FLATTENED_NOTE) + '</span>';
    return;
  }
  statusEl.innerHTML = '<div class="loading"><span class="dot"></span> Reading your resume...</div>';
  btn.disabled = true;
  try{
    const role = document.getElementById('aiRole').value.trim();
    const review = await callApiJson('review', { resume: state.resume, targetRole: role }, normalizeReview);
    state.aiReview = { hash: textHash(state.resume), review: review, role: role, at: Date.now() };
    await persist();
    statusEl.textContent = '';
    renderAiReview();
  }catch(e){
    statusEl.innerHTML = '<span class="error-text">' + escapeHtml(apiErrorMessage(e)) + '</span>';
  }finally{
    btn.disabled = false;
  }
});

// ---------- RESUME REVIEW ----------
function renderReview(){
  const el = document.getElementById('reviewCard');
  if(!state.resume){ el.innerHTML = ''; return; }
  if(isFlattened(state.resume)){ el.innerHTML = ''; return; }
  const r = analyzeResume(state.resume);
  const p = r.parsed;
  const yes = '<span class="ats-icon pass">\u2713</span>';
  const no = '<span class="ats-icon warn">!</span>';
  const chip = (label, ok) => '<span class="tag" style="margin-right:6px;">' + (ok ? '\u2713 ' : '\u2013 ') + escapeHtml(label) + '</span>';
  const sectionRows = p.sections.filter(s => s.key !== 'header').map(s =>
    '<div style="display:flex; justify-content:space-between; padding:5px 0; border-bottom:1px solid var(--line); font-size:13.5px;"><span>' +
    escapeHtml(s.title) + '</span><span style="color:var(--muted);">' + (s.bullets.length ? s.bullets.length + ' bullets' : s.lines.length + ' lines') + '</span></div>'
  ).join('');
  let html =
    '<div class="card">' +
      '<h3>How your resume was read</h3>' +
      '<div class="note" style="margin-top:0;">This is what a parser can pull out of your text. If something is missing here, an ATS probably misses it too.</div>' +
      '<div style="margin:12px 0;">' + chip('Email', !!p.contact.email) + chip('Phone', p.contact.phone) + chip('LinkedIn', !!p.contact.linkedin) +
        chip('GitHub', !!p.contact.github) + chip('Portfolio link', !!p.contact.portfolio) + '</div>' +
      '<div style="margin-bottom:12px;">' + (sectionRows || '<span class="note">No section headings were found.</span>') + '</div>' +
      '<div class="lbl" style="font-size:12.5px; color:var(--muted); margin-bottom:6px;">Skills detected (' + p.skills.length + ')</div>' +
      '<div class="tags" style="display:flex; gap:6px; flex-wrap:wrap;">' +
        (p.skills.slice(0, 24).map(k => '<span class="tag">' + escapeHtml(k) + '</span>').join('') || '<span class="note">None found. Add a Skills section with comma-separated skills.</span>') +
      '</div>' +
    '</div>';
  html += r.categories.map(cat => {
    const passed = cat.checks.filter(k => k.pass).length;
    return '<div class="card"><h3>' + escapeHtml(cat.title) + ' <span style="font-family:inherit; font-weight:400; font-size:12.5px; color:var(--muted);">' + passed + ' of ' + cat.checks.length + ' checks passed</span></h3>' +
      cat.checks.map(k =>
        '<div class="ats-row">' + (k.pass ? yes : no) + '<div class="body"><div class="lbl">' + escapeHtml(k.label) + '</div>' +
        '<div class="note-text">' + escapeHtml(k.note) + '</div>' +
        (!k.pass && k.examples.length ? '<ul class="plain" style="margin-top:8px;">' + k.examples.map(e =>
          '<li style="font-size:12.5px;">' + escapeHtml(e.text) + (e.hint ? '<div style="color:var(--ember);">' + escapeHtml(e.hint) + '</div>' : '') + '</li>').join('') + '</ul>' : '') +
        '</div></div>').join('') +
    '</div>';
  }).join('');
  html += '<div class="note">These checks are rule-based and look at wording and structure only. They cannot judge whether your experience is strong, and a clean pass is not a promise of interviews.</div>';
  el.innerHTML = html;
}

// ---------- SCOUT: live search ----------
// With a proxy connected, searches go through it. Without one they run in this browser.
const JOBS_URL = PROXY_URL.replace(/\/chat$/, '/jobs');
let lastResults = [];

const SOURCE_HINTS = {
  arbeitnow: 'Mostly Europe-based and remote tech roles. Good for remote work, thin for India.',
  adzuna: 'Wider listings, including India. It only gives a short preview, so open the posting and paste the full description before using Match & tailor.',
  company: 'Type the name exactly as it appears in the careers URL (boards.greenhouse.io/NAME or jobs.lever.co/NAME). Companies with their own career systems, such as Google or Amazon, cannot be searched this way.'
};

const SEARCH_ERRORS = {
  NETWORK: 'Could not reach the job service. Check your connection and try again.',
  rate_limited: 'Too many searches from your network just now. Wait a few minutes and try again.',
  source_not_configured: 'This source is not switched on for this site yet.',
  source_unavailable: 'That job source did not answer. Try again in a minute, or pick another source.',
  company_not_found: 'No Greenhouse or Lever board found with that name. Check the spelling against the company\'s careers URL.',
  bad_company: 'Use only letters, numbers and hyphens for the company name.',
  forbidden_origin: 'This site is not allowed to use the proxy. Add its address to ALLOWED_ORIGINS on the server.',
  ADZUNA_NEEDS_PROXY: 'Adzuna uses a private key, so it needs the proxy. Pick another source, or connect the proxy (see the README).'
};
const DIRECT_HINT = ' If your browser is blocking direct requests to that site, connecting the proxy gets around it.';

function safeUrl(u){
  try{
    const parsed = new URL(u);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') ? parsed.href : '';
  }catch(e){
    return '';
  }
}

function updateSourceUI(){
  const source = document.getElementById('searchSource').value;
  document.getElementById('companyField').style.display = source === 'company' ? '' : 'none';
  document.getElementById('sourceHint').textContent = SOURCE_HINTS[source] || '';
}
document.getElementById('searchSource').addEventListener('change', updateSourceUI);
updateSourceUI();

function renderSearchResults(){
  document.getElementById('searchResults').innerHTML = lastResults.map((j, i) => {
    const desc = (j.description || '').replace(/\s+/g, ' ').slice(0, 220);
    const link = safeUrl(j.url);
    return '<div class="job-item">' +
      '<div class="top"><div><div class="title">' + escapeHtml(j.title) + '</div>' +
      '<div class="company">' + escapeHtml(j.company) + (j.location ? ' · ' + escapeHtml(j.location) : '') + ' · ' + escapeHtml(j.source) + '</div></div>' +
      '<button class="btn small" onclick="addSearchResult(' + i + ')">Add to pipeline</button></div>' +
      '<div class="desc">' + escapeHtml(desc) + (desc.length >= 220 ? '...' : '') + '</div>' +
      (link ? '<div style="margin-top:8px; font-size:12.5px;"><a href="' + escapeHtml(link) + '" target="_blank" rel="noopener noreferrer">View posting</a></div>' : '') +
      '</div>';
  }).join('');
}

async function runSearch(p){
  if(proxyReady()){
    const params = new URLSearchParams({ source: p.source, q: p.q, location: p.location });
    if(p.source === 'company') params.set('company', p.company);
    let response;
    try{
      response = await fetch(JOBS_URL + '?' + params);
    }catch(e){
      throw new Error('NETWORK');
    }
    let data = null;
    try{ data = await response.json(); }catch(e){ data = null; }
    if(!response.ok) throw new Error((data && data.error) || 'API_ERROR');
    return data;
  }
  if(p.source === 'adzuna') throw new Error('ADZUNA_NEEDS_PROXY');
  try{
    return await JobsCore.searchJobs(p, { fetch: (u, o) => fetch(u, o), env: {} });
  }catch(e){
    const err = new Error((e && e.message) || 'source_unavailable');
    err.direct = true;
    throw err;
  }
}

async function searchJobs(){
  const source = document.getElementById('searchSource').value;
  const keyword = document.getElementById('searchKeyword').value.trim();
  const location = document.getElementById('searchLocation').value.trim();
  const company = document.getElementById('searchCompany').value.trim();
  const statusEl = document.getElementById('searchStatus');
  const resultsEl = document.getElementById('searchResults');
  const btn = document.getElementById('searchJobsBtn');

  if(source === 'company' && !company){
    statusEl.innerHTML = '<span class="error-text">Type a company name first.</span>';
    return;
  }
  lastResults = [];
  resultsEl.innerHTML = '';
  statusEl.innerHTML = '<div class="loading"><span class="dot"></span> Searching...</div>';
  btn.disabled = true;
  try{
    const data = await runSearch({ source: source, q: keyword, location: location, company: company });
    lastResults = Array.isArray(data.jobs) ? data.jobs : [];
    if(lastResults.length){
      statusEl.textContent = 'Showing ' + lastResults.length + (data.matched > lastResults.length ? ' of ' + data.matched : '') +
        ' matches from ' + data.scanned + ' listings.' + (data.note ? ' ' + data.note : '');
      renderSearchResults();
    } else {
      statusEl.textContent = 'Nothing matched in ' + data.scanned + ' listings. Try fewer or simpler words' +
        (source === 'arbeitnow' ? ', or switch to Adzuna or a company page, since this board is mostly Europe and remote tech.' : '.');
    }
  }catch(e){
    const msg = (SEARCH_ERRORS[e && e.message] || 'Search failed. Try again.') + (e && e.direct && e.message === 'source_unavailable' ? DIRECT_HINT : '');
    statusEl.innerHTML = '<span class="error-text">' + escapeHtml(msg) + '</span>';
  }finally{
    btn.disabled = false;
  }
}
document.getElementById('searchJobsBtn').addEventListener('click', searchJobs);

async function addSearchResult(i){
  const j = lastResults[Number(i)];
  if(!j) return;
  const exists = state.jobs.some(x => (j.url && x.url === safeUrl(j.url)) || (x.title === j.title && x.company === j.company));
  if(exists){
    showToast('Already in your pipeline.', 'error');
    return;
  }
  state.jobs.push({
    id: uid(), title: j.title, company: j.company, location: j.location || '',
    url: safeUrl(j.url), description: j.description || '', source: j.source || 'Search', status: 'Saved'
  });
  await persist();
  render();
  showToast('"' + j.title + '" added to your pipeline.', 'success');
}

// ---------- SCOUT: manual add ----------
document.getElementById('addManualBtn').addEventListener('click', async () => {
  const title = document.getElementById('manTitle').value.trim();
  const company = document.getElementById('manCompany').value.trim();
  const url = document.getElementById('manUrl').value.trim();
  const desc = document.getElementById('manDesc').value.trim();
  const note = document.getElementById('manualStatus');
  if(!title || !company || !desc){
    note.innerHTML = '<span class="error-text">Add at least a title, company, and job description.</span>';
    return;
  }
  state.jobs.push({ id: uid(), title, company, location: '', url, description: desc, source: 'Manual', status: 'Saved' });
  await persist();
  document.getElementById('manTitle').value = '';
  document.getElementById('manCompany').value = '';
  document.getElementById('manUrl').value = '';
  document.getElementById('manDesc').value = '';
  note.textContent = 'Added to your pipeline.';
  showToast('"' + title + '" added to your pipeline.', 'success');
  setTimeout(() => note.textContent = '', 2500);
  render();
});

// ---------- MATCH & TAILOR ----------
document.getElementById('matchJobSelect').addEventListener('change', renderMatchResult);

document.getElementById('analyzeBtn').addEventListener('click', async () => {
  const jobId = document.getElementById('matchJobSelect').value;
  const job = state.jobs.find(j => j.id === jobId);
  const statusEl = document.getElementById('matchStatus');
  if(!state.resume){
    statusEl.innerHTML = '<span class="error-text">Save your resume first (Stage 1).</span>';
    return;
  }
  if(!job) return;
  statusEl.innerHTML = '<div class="loading"><span class="dot"></span> Comparing your resume against this role...</div>';
  document.getElementById('analyzeBtn').disabled = true;
  try{
    const text = await callApi('match', {
      resume: state.resume,
      jobTitle: job.title,
      company: job.company,
      jobDescription: job.description
    });
    const parsed = extractJSON(text);
    state.tailored[jobId] = parsed;
    await persist();
    statusEl.innerHTML = '';
    renderMatchResult();
  }catch(e){
    statusEl.innerHTML = '<span class="error-text">' + escapeHtml(apiErrorMessage(e)) + '</span>';
  }
  document.getElementById('analyzeBtn').disabled = false;
});

function renderMatchResult(){
  const jobId = document.getElementById('matchJobSelect').value;
  const result = state.tailored[jobId];
  const el = document.getElementById('matchResult');
  if(!result){ el.innerHTML = ''; return; }
  el.innerHTML =
    '<div class="card">' +
      '<div class="score-ring"><span class="num">' + result.matchScore + '</span><span class="lbl">/ 100 match score</span></div>' +
      '<div class="two-col">' +
        '<div><h3>Strengths</h3><ul class="plain">' + result.strengths.map(s => '<li>' + escapeHtml(s) + '</li>').join('') + '</ul></div>' +
        '<div><h3>Gaps to address</h3><ul class="plain">' + result.gaps.map(s => '<li>' + escapeHtml(s) + '</li>').join('') + '</ul></div>' +
      '</div>' +
    '</div>' +
    '<div class="card">' +
      '<h3>Tailored summary</h3><p style="font-size:14px;">' + escapeHtml(result.summary) + '</p>' +
      '<div class="divider"></div>' +
      '<h3>Bullets to add or emphasize</h3><ul class="plain">' + result.bullets.map(b => '<li>' + escapeHtml(b) + '</li>').join('') + '</ul>' +
      '<div class="icon-btn-row">' +
        '<button class="btn secondary small" onclick="copyTailored(\'' + jobId + '\')">Copy summary + bullets</button>' +
        '<button class="btn secondary small" onclick="downloadTailored(\'' + jobId + '\')">Download as .txt</button>' +
      '</div>' +
    '</div>';
}

function tailoredAsText(jobId){
  const job = state.jobs.find(j => j.id === jobId);
  const result = state.tailored[jobId];
  return 'Tailored for: ' + job.title + ' at ' + job.company + '\n\n' +
    'SUMMARY\n' + result.summary + '\n\n' +
    'BULLETS TO ADD OR EMPHASIZE\n' + result.bullets.map(b => '- ' + b).join('\n');
}

function copyTailored(jobId){
  navigator.clipboard.writeText(tailoredAsText(jobId))
    .then(() => showToast('Copied to clipboard.', 'success'))
    .catch(() => showToast('Could not copy — select and copy manually.', 'error'));
}

function downloadTailored(jobId){
  const job = state.jobs.find(j => j.id === jobId);
  const blob = new Blob([tailoredAsText(jobId)], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'tailored-resume-' + job.company.replace(/[^a-z0-9]/gi, '-').toLowerCase() + '.txt';
  a.click();
  URL.revokeObjectURL(url);
}

// ---------- PREPARE ----------
document.getElementById('prepJobSelect').addEventListener('change', renderPrepResult);

document.getElementById('prepGenBtn').addEventListener('click', async () => {
  const jobId = document.getElementById('prepJobSelect').value;
  const job = state.jobs.find(j => j.id === jobId);
  const statusEl = document.getElementById('prepStatus');
  if(!job) return;
  statusEl.innerHTML = '<div class="loading"><span class="dot"></span> Building interview prep...</div>';
  document.getElementById('prepGenBtn').disabled = true;
  try{
    const text = await callApi('prep', {
      resume: state.resume,
      jobTitle: job.title,
      company: job.company,
      jobDescription: job.description
    });
    const parsed = extractJSON(text);
    state.preps[jobId] = parsed;
    await persist();
    statusEl.innerHTML = '';
    renderPrepResult();
  }catch(e){
    statusEl.innerHTML = '<span class="error-text">' + escapeHtml(apiErrorMessage(e)) + '</span>';
  }
  document.getElementById('prepGenBtn').disabled = false;
});

function renderPrepResult(){
  const jobId = document.getElementById('prepJobSelect').value;
  const prep = state.preps[jobId];
  const el = document.getElementById('prepResult');
  if(!prep){ el.innerHTML = ''; return; }
  el.innerHTML =
    '<div class="card"><h3>Talking points</h3><ul class="plain">' +
      prep.talkingPoints.map(t => '<li>' + escapeHtml(t) + '</li>').join('') + '</ul></div>' +
    '<div class="card"><h3>Likely questions — click one to practice</h3>' +
      prep.questions.map((q, i) => (
        '<div class="qa" id="qa-' + i + '">' +
          '<div class="q" onclick="toggleQA(' + i + ')">' + escapeHtml(q.q) + '</div>' +
          '<div class="why">' + escapeHtml(q.why) + '</div>' +
          '<div class="tip">' + escapeHtml(q.tip) + '</div>' +
          '<div class="practice">' +
            '<textarea id="answer-' + i + '" placeholder="Type your answer here to get feedback..."></textarea>' +
            '<button class="btn small" style="margin-top:8px;" onclick="getFeedback(' + i + ', \'' + jobId + '\')">Get feedback</button>' +
            '<div id="feedback-' + i + '" style="margin-top:8px; font-size:13.5px;"></div>' +
          '</div>' +
        '</div>'
      )).join('') +
    '</div>' +
    '<div class="card"><h3>Questions to ask them</h3><ul class="plain">' +
      prep.questionsToAsk.map(t => '<li>' + escapeHtml(t) + '</li>').join('') + '</ul></div>';
}

function toggleQA(i){
  document.getElementById('qa-' + i).classList.toggle('open');
}

async function getFeedback(i, jobId){
  const answer = document.getElementById('answer-' + i).value.trim();
  const fbEl = document.getElementById('feedback-' + i);
  if(!answer){ fbEl.innerHTML = '<span class="error-text">Write an answer first.</span>'; return; }
  const prep = state.preps[jobId];
  const question = prep.questions[i].q;
  fbEl.innerHTML = '<div class="loading"><span class="dot"></span> Reviewing your answer...</div>';
  try{
    const text = await callApi('feedback', { question: question, answer: answer });
    fbEl.innerHTML = '<p style="color:var(--muted);">' + escapeHtml(text.trim()) + '</p>';
  }catch(e){
    fbEl.innerHTML = '<span class="error-text">' + escapeHtml(apiErrorMessage(e)) + '</span>';
  }
}

// ---------- TRACK ----------
async function updateStatus(jobId, newStatus){
  const job = state.jobs.find(j => j.id === jobId);
  if(job){ job.status = newStatus; await persist(); render(); }
}

async function removeJob(jobId){
  state.jobs = state.jobs.filter(j => j.id !== jobId);
  delete state.tailored[jobId];
  delete state.preps[jobId];
  await persist();
  render();
}

// ---------- CONNECTION STATUS & OWN KEY ----------
let health = { checked: false, reachable: null, ai: null, adzuna: null, code: '' };

async function checkConnection(){
  if(!proxyReady()){
    health = { checked: true, reachable: null, ai: null, adzuna: null, code: '' };
    renderStatus();
    return;
  }
  health = { checked: false, reachable: null, ai: null, adzuna: null, code: '' };
  renderStatus();
  try{
    const r = await fetch(HEALTH_URL);
    let d = null;
    try{ d = await r.json(); }catch(e){ d = null; }
    health = r.ok && d ? { checked: true, reachable: true, ai: !!d.ai, adzuna: !!d.adzuna, code: '' }
                       : { checked: true, reachable: false, ai: null, adzuna: null, code: (d && d.error) || '' };
  }catch(e){
    health = { checked: true, reachable: false, ai: null, adzuna: null, code: '' };
  }
  renderStatus();
}

// Each row: [state, name, text]. state is ok, bad, off or wait.
function statusRows(){
  const rows = [];
  const proxy = proxyReady();
  const up = proxy && health.checked && health.reachable;
  rows.push(['ok', 'Resume reading and score', 'Ready. It runs in your browser and nothing is sent anywhere.']);
  if(!proxy) rows.push(['off', 'Proxy', 'Not connected (optional). Connect it so visitors can use AI without a key of their own. See the README.']);
  else if(!health.checked) rows.push(['wait', 'Proxy', 'Checking...']);
  else if(health.reachable) rows.push(['ok', 'Proxy', 'Connected.']);
  else rows.push(['bad', 'Proxy', health.code === 'forbidden_origin'
    ? 'Found it, but it refused this site. Add this site\'s address to ALLOWED_ORIGINS on the server.'
    : 'Could not reach it. Check PROXY_URL at the top of js/app.js and that the proxy is deployed.']);
  rows.push(['ok', 'Job search', up
    ? 'Ready through the proxy.' + (health.adzuna ? ' Adzuna is on.' : ' Adzuna is off (it needs ADZUNA_APP_ID and ADZUNA_APP_KEY on the server).')
    : 'Ready, straight from your browser (open board and company careers pages). Adzuna needs the proxy.']);
  if(getOwnKey()) rows.push(['ok', 'AI features', 'Ready, using your own key (stored only in this browser).']);
  else if(up && health.ai) rows.push(['ok', 'AI features', 'Ready through the proxy.']);
  else if(up) rows.push(['bad', 'AI features', 'The proxy is up but has no ANTHROPIC_API_KEY set. Add it on the server, or save your own key below.']);
  else rows.push(['off', 'AI features', 'Off. Save your own key below, or connect the proxy.']);
  return rows;
}

function renderStatus(){
  const icon = { ok: ['pass', '\u2713'], bad: ['warn', '!'], off: ['', '\u2013'], wait: ['', '\u2026'] };
  document.getElementById('statusRows').innerHTML = statusRows().map(r =>
    '<div class="ats-row"><span class="ats-icon ' + icon[r[0]][0] + '">' + icon[r[0]][1] + '</span>' +
    '<div class="body"><div class="lbl">' + escapeHtml(r[1]) + '</div><div class="note-text">' + escapeHtml(r[2]) + '</div></div></div>'
  ).join('');
}

function renderOwnKeyNote(){
  document.getElementById('ownKeyNote').textContent = getOwnKey() ? 'A key is saved in this browser.' : 'No key saved.';
}

document.getElementById('saveOwnKeyBtn').addEventListener('click', () => {
  const input = document.getElementById('ownKeyInput');
  const v = input.value.trim();
  if(!v){ showToast('Paste a key first.', 'error'); return; }
  localStorage.setItem(OWN_KEY_STORAGE, v);
  input.value = '';
  showToast('Key saved in this browser.', 'success');
  renderOwnKeyNote();
  renderStatus();
});
document.getElementById('removeOwnKeyBtn').addEventListener('click', () => {
  localStorage.removeItem(OWN_KEY_STORAGE);
  showToast('Key removed.', 'success');
  renderOwnKeyNote();
  renderStatus();
});
document.getElementById('checkStatusBtn').addEventListener('click', checkConnection);
renderOwnKeyNote();
checkConnection();

// ---------- OVERVIEW ----------
function renderOverview(){
  const tailoredCount = Object.keys(state.tailored).length;
  const prepCount = Object.keys(state.preps).length;
  document.getElementById('ovResumeStat').textContent = state.resumeATS ? atsCounts(state.resumeATS).passed + '/' + atsCounts(state.resumeATS).total : '—';
  document.getElementById('ovJobsStat').textContent = state.jobs.length;
  document.getElementById('ovTailoredStat').textContent = tailoredCount;
  document.getElementById('ovPrepStat').textContent = prepCount;
  document.getElementById('countAts').textContent = state.resumeATS ? atsCounts(state.resumeATS).passed + '/' + atsCounts(state.resumeATS).total : '—';

  const statuses = ['Saved','Applied','Interviewing','Offer','Rejected'];
  const counts = {}; statuses.forEach(s => counts[s] = 0);
  state.jobs.forEach(j => { counts[j.status] = (counts[j.status] || 0) + 1; });
  const max = Math.max(1, ...statuses.map(s => counts[s]));
  document.getElementById('funnelChart').innerHTML = statuses.map(s => (
    '<div class="funnel-row"><span class="funnel-label">' + s + '</span>' +
    '<div class="funnel-track"><div class="funnel-fill' + (s === 'Rejected' ? ' rejected' : '') + '" style="width:' + Math.round((counts[s] / max) * 100) + '%"></div></div>' +
    '<span class="funnel-count">' + counts[s] + '</span></div>'
  )).join('');

  let next = '';
  if(!state.resume){
    next = 'Add your resume in Stage 1 — everything else depends on it.';
  } else if(state.resumeATS && state.resumeATS.score < 70){
    next = 'Some basic ATS checks on your resume failed. Fix the flagged items in Stage 1 before applying widely.';
  } else if(state.jobs.length === 0){
    next = 'Scout or manually add a job in Stage 2 to start matching against your resume.';
  } else if(tailoredCount < state.jobs.length){
    next = 'You have ' + (state.jobs.length - tailoredCount) + ' saved job(s) not yet run through Match & tailor — do that before applying.';
  } else if(prepCount < state.jobs.length){
    next = 'Resumes are tailored. Generate interview prep for the remaining job(s) in Stage 4.';
  } else {
    next = 'Everything in your pipeline is tailored and prepped. Keep scouting new roles, and update statuses in Track as you hear back.';
  }
  document.getElementById('nextAction').innerHTML = '<p style="font-size:14px; margin:0;">' + escapeHtml(next) + '</p>';
}

// ---------- RENDER ----------
// ---------- BACKUP ----------
document.getElementById('exportBtn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'jobapplyagent-backup-' + new Date().toISOString().slice(0, 10) + '.json';
  a.click();
  URL.revokeObjectURL(url);
  showToast('Backup downloaded.', 'success');
});

document.getElementById('importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  const statusEl = document.getElementById('importStatus');
  if(!file) return;
  try{
    const text = await file.text();
    const parsed = JSON.parse(text);
    if(typeof parsed !== 'object' || !parsed) throw new Error('bad shape');
    state = Object.assign({ resume:'', jobs:[], tailored:{}, preps:{}, resumeATS:null, aiReview:null }, parsed);
    persist();
    render();
    statusEl.textContent = 'Backup restored.';
    showToast('Backup imported.', 'success');
  }catch(err){
    statusEl.innerHTML = '<span class="error-text">That file doesn\'t look like a valid backup.</span>';
  }
  e.target.value = '';
});

function render(){
  document.getElementById('countJobs').textContent = state.jobs.length;
  document.getElementById('resumeInput').value = state.resume;
  renderScore();
  renderAiReview();
  renderATSCard();
  renderReview();
  renderOverview();

  const hasJobs = state.jobs.length > 0;
  document.getElementById('matchEmpty').style.display = hasJobs ? 'none' : 'block';
  document.getElementById('matchBody').style.display = hasJobs ? 'block' : 'none';
  document.getElementById('prepEmpty').style.display = hasJobs ? 'none' : 'block';
  document.getElementById('prepBody').style.display = hasJobs ? 'block' : 'none';
  document.getElementById('trackEmpty').style.display = hasJobs ? 'none' : 'block';
  document.getElementById('trackBody').style.display = hasJobs ? 'block' : 'none';

  const options = state.jobs.map(j => '<option value="' + j.id + '">' + escapeHtml(j.title) + ' — ' + escapeHtml(j.company) + '</option>').join('');
  const matchSel = document.getElementById('matchJobSelect');
  const prepSel = document.getElementById('prepJobSelect');
  const prevMatch = matchSel.value, prevPrep = prepSel.value;
  matchSel.innerHTML = options;
  prepSel.innerHTML = options;
  if(state.jobs.some(j => j.id === prevMatch)) matchSel.value = prevMatch;
  if(state.jobs.some(j => j.id === prevPrep)) prepSel.value = prevPrep;
  renderMatchResult();
  renderPrepResult();

  const statuses = ['Saved','Applied','Interviewing','Offer','Rejected'];
  document.getElementById('trackTableBody').innerHTML = state.jobs.map(j => {
    const steps = [!!state.tailored[j.id], !!state.preps[j.id], j.status !== 'Saved'];
    const dots = steps.map(on => '<span class="pd' + (on ? ' on' : '') + '"></span>').join('');
    return '<tr><td>' + escapeHtml(j.title) + '</td><td>' + escapeHtml(j.company) + '</td>' +
    '<td><select class="status-select status-' + j.status + '" onchange="updateStatus(\'' + j.id + '\', this.value)" style="width:auto;">' +
      statuses.map(s => '<option value="' + s + '"' + (j.status === s ? ' selected' : '') + '>' + s + '</option>').join('') +
    '</select></td>' +
    '<td><div class="progress-dots" title="Tailored / Prepped / Applied">' + dots + '</div></td>' +
    '<td><button class="btn secondary small" onclick="removeJob(\'' + j.id + '\')">Remove</button></td></tr>';
  }).join('');
}

loadState();
