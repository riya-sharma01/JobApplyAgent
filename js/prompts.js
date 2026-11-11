// Prompt builders for the AI features. They live in one shared file so the proxy and the
// browser (when it uses your own key) always send exactly the same prompts.
// Source of truth: proxy/lib/prompts.js. Run `node tools/sync-shared.js` to copy it to js/.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Prompts = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULT_MODEL = 'claude-sonnet-4-6';

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

    review: {
      maxTokens: 1600,
      build(b) {
        const resume = clip(b.resume, 7000);
        if (!resume) return null;
        const role = clip(b.targetRole, 120);
        return [
          'You are an experienced technical recruiter reviewing the resume of a fresher or early-career software candidate.',
          role ? 'The candidate is targeting: ' + role + '.' : null,
          '',
          'RESUME:',
          resume,
          '',
          'Read the whole resume the way a hiring manager would, and find real problems with content, clarity and credibility, not just formatting. Look for: vague or generic bullets, bullets that describe duties instead of results, missing scale or outcome, unexplained jargon or acronyms, claims that look inflated or cannot be checked, inconsistencies (dates, titles, skills listed but never used in any project), repeated content between projects, weak ordering, and anything a recruiter would stop on.',
          'Rules: Never invent facts, numbers, tools or achievements. When a better version needs a number the resume does not give, use a placeholder such as [X%] or [N users] for the candidate to fill in with a real figure. Keep each rewrite under 30 words and keep only the candidate\'s own facts. If a problem needs information only the candidate has, leave "rewrite" as an empty string.',
          'Respond with ONLY valid JSON, no preamble, in this exact shape:',
          '{"summary": "<2-3 honest sentences: what a recruiter would think after a quick read>", "strengths": ["<specific strength>", "..."], "issues": [{"severity": "high|medium|low", "where": "<the exact bullet or line copied from the resume, or the section name>", "problem": "<what is wrong, in one sentence>", "rewrite": "<improved version, or empty string>"}], "missing": ["<important thing a recruiter would expect but cannot find>"]}',
          'Give 2-4 strengths, at most 8 issues ordered most important first, and at most 3 missing items. Keep every string short.',
        ].filter((line) => line !== null).join('\n');
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

  return { TASKS, clip, DEFAULT_MODEL };
});
