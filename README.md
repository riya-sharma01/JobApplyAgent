# JobApplyAgent — career control room

A small static website for running your job search: resume upload + ATS readiness
checking, job scouting, AI-assisted resume tailoring per job, interview prep with
practice feedback, application tracking, and full data export/import. The site is plain
HTML, CSS and JavaScript with no build step; the one server-side piece is a ~100-line
serverless proxy (`proxy/`) that keeps the LLM API key out of the browser.

## Files

```
jobapplyagent-site/
├── index.html          structure
├── css/styles.css      all styling (light + dark theme)
├── js/app.js           page behavior
├── js/ats.js           resume text extraction + basic ATS checks (no page dependencies)
├── js/resume.js        resume parser + content review (impact, brevity, style, structure)
├── js/prompts.js       AI prompts (copy of proxy/lib/prompts.js, see "Shared code")
├── js/jobs-core.js     job search logic (copy of proxy/lib/jobs-core.js)
├── test/               tests for the js/ files
├── tools/sync-shared.js  copies the shared files from proxy/lib/ to js/
├── favicon.svg         icon (also used as the sidebar logo)
├── proxy/              serverless function that holds the API key (deployed separately)
│   ├── api/chat.js     AI calls (match, prep, feedback, resume review)
│   ├── api/jobs.js     job search (Arbeitnow, Adzuna, company boards)
│   ├── api/health.js   tells the site what is switched on (yes/no only)
│   ├── lib/            common.js, prompts.js, jobs-core.js
│   └── test/           tests for both endpoints
├── .github/workflows/  GitHub Pages deploy (manual trigger)
├── LICENSE
└── README.md
```

## Features

- **Resume** — upload a .pdf/.docx/.txt or paste text; extracted client-side (pdf.js,
  mammoth.js). Runs six basic ATS checks (contact info, section headers, length, bullets,
  unusual characters), shows how the resume was read (sections, links, skills), and reviews
  the content: strong verbs, numbers, buzzwords, bullet length, tense, dates, missing
  sections, pointing at the exact bullets that need work. These checks are rule-based and
  add up to a transparent score out of 100 (an estimate, with a per-category breakdown).
  An optional **AI read-through** reads the whole resume like a hiring manager and flags
  content problems with suggested rewrites. It never invents numbers: where one is needed
  it leaves a placeholder such as [X%] for you to fill in truthfully.
- **Scout** — live search across three sources (an open Europe/remote board, Adzuna for
  India and worldwide, or one company's Greenhouse/Lever careers page), or add any listing
  (LinkedIn, a company careers page, anywhere) by hand. Works without a server, except
  Adzuna.
- **Match & tailor** — Claude compares your resume against a saved job: match score,
  strengths, gaps, a tailored summary, and bullets to add — copyable or downloadable.
- **Prepare** — generates company/role talking points and likely interview questions
  with STAR-format tips; practice answers inline and get feedback.
- **Track** — status per job (Saved/Applied/Interviewing/Offer/Rejected) with a visual
  progress indicator, plus a live funnel chart and "next best action" on the Overview tab.
- **Backup** — export your full data as JSON, import it back on another device.
- **Light/dark theme** — toggle at the bottom of the sidebar, preference remembered.

## Deploying it for real

**GitHub Pages** (what this repo is set up for)
1. Push this folder to a GitHub repo.
2. Repo Settings → Pages → Source → "GitHub Actions".
3. To publish, go to the Actions tab → "Deploy to GitHub Pages" → Run workflow. It is
   manual on purpose, so pushing code never changes the live site by itself. It publishes
   only `index.html`, `css/`, `js/` and `favicon.svg`.
4. Your site is live at `https://<username>.github.io/<repo-name>/`.

**Local, no deployment**
```
python3 -m http.server 8000
```
Then open `http://localhost:8000`.

## Tests

```
node --test test/ats.test.js     # resume extraction + basic ATS checks
node --test test/resume.test.js  # resume parser + content review
node --test test/sync.test.js    # js/ copies match proxy/lib/
cd proxy && npm test             # proxy endpoints
```

## Two ways to run it

The site works in two modes. The **Overview** tab has a "What's working" card that shows
which one you are in and what is on or off.

**1. No server (works as soon as the site loads).** Resume reading, the score, the
tracker and backups run in your browser. Job search runs straight from your browser
against the open board and company careers pages. For the AI features, paste your own
key under "Your AI key" on the Overview tab. It is stored only in that browser and sent
only to the AI provider. Adzuna search needs the proxy. If a job site blocks direct browser
requests you get a clear message, and connecting the proxy fixes it.

**2. With the proxy (for visitors).** A small serverless function holds the key, so
visitors can use the AI features without a key of their own. Set it up below.

## Connecting the proxy

Match & tailor, Prepare and the resume AI read-through need an LLM. With the proxy, the browser never sees an API key: it sends
`{task, resume, job...}` to the proxy, and the proxy builds the prompt and makes the call.
Because the prompts live on the server, the endpoint can't be used as a general chatbot.
If a visitor saves their own key it is used first, and the proxy is the fallback.

1. Get an API key at [console.anthropic.com](https://console.anthropic.com/settings/keys)
   and **set a monthly spend limit on it**. That limit is your real backstop.
2. Deploy `proxy/` to Vercel: import this repo and set **Root Directory** to `proxy`.
   Environment variables:
   - `ANTHROPIC_API_KEY` (required)
   - `ALLOWED_ORIGINS` (optional, comma-separated; defaults to
     `https://riya-sharma01.github.io`, plus `http://localhost:8000` outside production)
   - `MODEL` (optional)
   - `ADZUNA_APP_ID` and `ADZUNA_APP_KEY` (optional; free keys from
     [developer.adzuna.com](https://developer.adzuna.com). Without them the Adzuna source
     shows "not switched on" and the other two sources still work.)
3. Copy the deployed URL (`https://<project>.vercel.app/api/chat`) into `PROXY_URL` at
   the top of `js/app.js`, commit, and deploy the site.

Local development: run `vercel dev` inside `proxy/`, set `PROXY_URL` to
`http://localhost:3000/api/chat`, and serve the site on port 8000.

What the proxy does and doesn't protect against:

- CORS allowlist: other websites can't call it from a browser. It does **not** stop
  someone using curl, since the `Origin` header can be faked.
- Rate limit: 20 requests per IP per 10 minutes, kept in memory. It's best-effort,
  because serverless instances restart and reset the counter.
- Size caps on every field, a fixed model, and a fixed `max_tokens` per task.
- It never logs prompts, since they contain resumes.

Tests: `cd proxy && npm test` (Node's built-in runner, no dependencies).

## Shared code

The prompts and the job-search logic must behave the same in the proxy and in the browser,
so each is written once in `proxy/lib/` and copied to `js/`. After editing either file in
`proxy/lib/`, run `node tools/sync-shared.js`. The test `node --test test/sync.test.js`
fails if the copies drift apart.

## What's real vs. what's a heuristic

- **Job search** runs through the proxy. Arbeitnow (reads 3 pages) is Europe-heavy and
  remote tech. Adzuna covers India but returns only a short description preview. The
  company option reads public Greenhouse/Lever boards, so it can't search companies with
  their own career systems (Google, Amazon, Meta). None of this covers LinkedIn or Indeed:
  add those listings manually.
- **ATS checks and resume review** are rule-based and read extracted text only. They are not a
  recruiter's opinion or a real ATS's verdict. It can't see the
  original file's layout — a two-column PDF or one with text boxes can still break a
  real ATS even if the extracted text passes every check here.
- **Match score, tailored bullets, interview questions** are generated by Claude reading
  your resume and the job description — a useful second opinion, not a certified score
  or real intelligence about a specific company's actual interview process.

## Data & privacy

Everything you enter is stored in your browser's local storage under the key
`jobapplyagent-data`. Job search terms go to the proxy and on to the job source you picked. When you use Match & tailor or
Prepare, your resume text and the job description go to the proxy and on to the LLM
provider; the proxy doesn't store them. Clearing browser data erases your data, so export
a backup first if that matters to you. If you save your own AI key, it is kept in the same
local storage, so use a key with a low spend limit and never on a shared computer.

## License

MIT — see `LICENSE`.

