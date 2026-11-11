'use strict';

// Tiny proxy between the JobApplyAgent site and the LLM API.
// The key lives in an environment variable on the server, never in the browser.
// The browser sends { task, ...fields }; the prompts are built here, so this
// endpoint can't be used as a general-purpose chatbot.

const { applyCors, makeLimiter, clientIp } = require('../lib/common');
const { TASKS, DEFAULT_MODEL } = require('../lib/prompts');

const MODEL = process.env.MODEL || DEFAULT_MODEL;
const limiter = makeLimiter(20, 10 * 60 * 1000); // 20 AI requests per IP per 10 minutes

async function handler(req, res) {
  const allowed = applyCors(req, res, 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(allowed ? 204 : 403).end();
  if (!allowed) return res.status(403).json({ error: 'forbidden_origin' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'server_not_configured' });
  if (limiter.check(clientIp(req))) return res.status(429).json({ error: 'rate_limited' });

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
module.exports._hits = limiter.hits;
module.exports._TASKS = TASKS;
