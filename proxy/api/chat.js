'use strict';

// Tiny proxy between the JobApplyAgent site and the LLM API.
// The key lives in an environment variable on the server, never in the browser.
// The browser sends { task, ...fields }; the prompts are built here, so this
// endpoint can't be used as a general-purpose chatbot.

const MODEL = process.env.MODEL || 'claude-sonnet-4-6';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://riya-sharma01.github.io,http://localhost:8000')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const RATE_LIMIT = 20; // requests per IP...
const WINDOW_MS = 10 * 60 * 1000; // ...per 10 minutes
const hits = new Map();

function clip(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

const TASKS = {
  match: {
    maxTokens: 1000,
    build(b) {
      const resume = clip(b.resume, 6000);
      const jd = clip(b.jobDescription, 4000);
      if (!resume || !jd) return null;
      const title = clip(b.jobTitle, 200);
      const company = clip(b.company, 200);
      return [
        'You are a career coach. Compare this resume against this job description.',
        '',
        'RESUME:',
        resume,
        '',
        `JOB DESCRIPTION (${title} at ${company}):`,
        jd,
        '',
        'Respond with ONLY valid JSON, no preamble, in this exact shape:',
        '{"matchScore": <0-100 integer>, "strengths": ["...", "..."], "gaps": ["...", "..."], ' +
          '"summary": "<a tailored 3-4 sentence professional summary for this specific role, written in first person as it would appear at the top of a resume>", ' +
          '"bullets": ["<tailored resume bullet emphasizing relevant experience>", "..."]}',
        'Give 3-5 items for strengths, gaps, and bullets each. Be specific and honest, not generic.',
      ].join('\n');
    },
  },

  prep: {
    maxTokens: 1000,
    build(b) {
      const jd = clip(b.jobDescription, 4000);
      if (!jd) return null;
      const resume = clip(b.resume, 3000);
      const title = clip(b.jobTitle, 200);
      const company = clip(b.company, 200);
      const lines = [
        'You are a career coach preparing a candidate for an interview.',
        '',
        `JOB (${title} at ${company}):`,
        jd,
        '',
      ];
      if (resume) lines.push('CANDIDATE RESUME:', resume, '');
      lines.push(
        'Respond with ONLY valid JSON, no preamble, in this exact shape:',
        '{"talkingPoints": ["<thing to know or mention about this company/role/industry>", "..."], ' +
          '"questions": [{"q": "<likely interview question>", "why": "<what the interviewer is really assessing>", "tip": "<one-line STAR-format answering tip>"}], ' +
          '"questionsToAsk": ["<good question the candidate could ask the interviewer>", "..."]}',
        'Give 4-5 talking points, 6 questions covering a mix of behavioral and role-specific technical questions, and 4 questions to ask.'
      );
      return lines.join('\n');
    },
  },

  feedback: {
    maxTokens: 400,
    build(b) {
      const question = clip(b.question, 500);
      const answer = clip(b.answer, 2000);
      if (!question || !answer) return null;
      return [
        `Interview question: "${question}"`,
        '',
        'Candidate answer:',
        answer,
        '',
        'Give brief, direct feedback (3-5 sentences) on how well this answer follows the STAR format (Situation, Task, Action, Result) and how convincing it is. Suggest one concrete improvement. Plain text only, no JSON, no markdown headers.',
      ].join('\n');
    },
  },
};

function rateLimited(ip, now = Date.now()) {
  const recent = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= RATE_LIMIT) {
    hits.set(ip, recent);
    return true;
  }
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) {
    for (const [key, times] of hits) {
      if (!times.some((t) => now - t < WINDOW_MS)) hits.delete(key);
    }
  }
  return false;
}

async function handler(req, res) {
  const origin = req.headers.origin;
  const allowed = Boolean(origin) && ALLOWED_ORIGINS.includes(origin);

  if (allowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }

  if (req.method === 'OPTIONS') return res.status(allowed ? 204 : 403).end();
  if (!allowed) return res.status(403).json({ error: 'forbidden_origin' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'server_not_configured' });

  const ip =
    String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    (req.socket && req.socket.remoteAddress) ||
    'unknown';
  if (rateLimited(ip)) return res.status(429).json({ error: 'rate_limited' });

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const task = Object.prototype.hasOwnProperty.call(TASKS, body.task) ? TASKS[body.task] : null;
  if (!task) return res.status(400).json({ error: 'bad_task' });

  const prompt = task.build(body);
  if (!prompt) return res.status(400).json({ error: 'bad_input' });

  let upstream;
  try {
    upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: task.maxTokens,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
  } catch (err) {
    return res.status(502).json({ error: 'upstream_unreachable' });
  }

  if (!upstream.ok) {
    // log the status only, never the prompt (it contains someone's resume)
    console.error('upstream status', upstream.status);
    return res.status(502).json({ error: 'upstream_error' });
  }

  const data = await upstream.json();
  const block = (data.content || []).find((b) => b.type === 'text');
  if (!block) return res.status(502).json({ error: 'upstream_empty' });
  return res.status(200).json({ text: block.text });
}

module.exports = handler;
module.exports._hits = hits;
module.exports._TASKS = TASKS;
