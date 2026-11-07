'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { parseResume, analyzeResume, matchSection } = require('../js/resume.js');

// Plain-text version of a real fresher resume, shaped like the PDF extraction output.
const GOOD = `Riya Sharma
riyasharmasj5@gmail.com | +91-7015783855 | github.com/riya-sharma01 | linkedin.com/in/riyasharma04
Education
National Institute of Technology, Manipur 08 2023 -- 06 2027
B.Tech in Computer Science and Engineering CGPA: 7.87 / 10.0
Experience
Software Engineering Intern -- Siemens EDA 05 2026 -- 07 2026
Automation Engineering | Aprisa Regression Testing
\u2022 Automated regression workflows across 66 benchmark and daily testcases, improving execution consistency and reducing repetitive manual effort.
\u2022 Developed reusable scripts for testcase configuration, execution, result collection, and automated validation.
\u2022 Analyzed regression logs and execution outputs across 66 testcases to troubleshoot failures and identify workflow issues.
\u2022 Built modular automation components to improve maintainability and execution efficiency.
Technical Skills
Languages: Java, Python, C++, JavaScript, SQL
Frameworks: Spring Boot, React, Node.js, Express.js
Databases: MySQL, SQLite
Tools: Git, GitHub, Postman, Linux, VS Code
Projects
JobApplyAgent -- AI-Assisted Job Readiness Platform 09 2026
JavaScript, HTML, CSS, REST APIs, LocalStorage
\u2022 Built a career-management platform covering resume analysis, live job discovery, AI matching, interview preparation, and application tracking across 6 integrated workflows.
\u2022 Implemented client-side parsing for 3 resume formats (PDF, DOCX, TXT) with a heuristic ATS checker evaluating contact details, sections, length, bullets, and special characters.
\u2022 Developed persistent application tracking with 5 pipeline statuses, live job-board integration, JSON backup/restore, responsive UI, and light/dark theme support.
Calculon -- Advanced Mathematics Learning Platform 08 2026
Java, Spring Boot, React, MySQL, D3.js
\u2022 Built and deployed a gamified mathematics learning platform covering 5+ advanced domains through interactive lessons and challenges.
\u2022 Developed Spring Boot REST APIs for user management, lessons, questions, progress tracking, and structured learning data.
\u2022 Created interactive D3.js visualizations for calculus, trigonometry, and linear algebra to improve conceptual understanding.
Leadership & Activities
Qubit Coding Club -- Core Member, NIT Manipur 09 2023 -- Present
\u2022 Conducted six sessions on recursion, trees, and greedy algorithms for 50+ students.
\u2022 Mentored 25 junior members by reviewing Java solutions and explaining logical and edge-case errors.
Achievements
\u2022 Solved 700+ algorithmic problems across LeetCode and GeeksforGeeks.
\u2022 Achieved a 2395 LeetCode contest rating and Guardian Badge.
\u2022 Selected among the top 500 candidates for Amazon Future Engineer Bootcamp Phase 2.`;

const check = (r, id) => r.categories.flatMap((c) => c.checks).find((k) => k.id === id);

test('matchSection recognises real headings and rejects sentences', () => {
  for (const h of ['Education', 'EXPERIENCE', 'Technical Skills', 'Leadership & Activities', 'Work Experience', 'Projects:', 'Awards & Honors', 'Professional Summary']) {
    assert.ok(matchSection(h), h);
  }
  for (const s of ['Experience with Java and Python in production', 'Skills gap analysis tool', 'Education technology startup founder at XYZ']) {
    assert.strictEqual(matchSection(s), null, s);
  }
});

test('parseResume finds the sections, bullets, contact info and skills', () => {
  const p = parseResume(GOOD);
  assert.deepStrictEqual(p.sections.map((s) => s.key),
    ['header', 'education', 'experience', 'skills', 'projects', 'leadership', 'achievements']);
  assert.strictEqual(p.bullets.length, 15);
  assert.strictEqual(p.sections.find((s) => s.key === 'experience').bullets.length, 4);
  assert.strictEqual(p.contact.email, 'riyasharmasj5@gmail.com');
  assert.strictEqual(p.contact.phone, true);
  assert.strictEqual(p.contact.linkedin, 'linkedin.com/in/riyasharma04');
  assert.strictEqual(p.contact.github, 'github.com/riya-sharma01');
  assert.ok(p.skills.includes('Spring Boot') && p.skills.includes('C++') && p.skills.length >= 14, p.skills.join('|'));
  assert.ok(!p.skills.some((s) => /^languages/i.test(s)), 'labels like "Languages:" are not skills');
});

test('entry titles and dates are not mistaken for bullets or merged into them', () => {
  const p = parseResume(GOOD);
  const exp = p.sections.find((s) => s.key === 'experience');
  assert.ok(exp.plain.some((l) => l.startsWith('Software Engineering Intern')));
  const proj = p.sections.find((s) => s.key === 'projects');
  assert.strictEqual(proj.bullets.length, 6);
  assert.ok(proj.plain.some((l) => l.startsWith('Calculon')), 'second project title stays a title');
  assert.ok(!proj.bullets.some((b) => b.text.includes('Calculon')));
});

test('wrapped bullet lines are joined into one bullet', () => {
  const p = parseResume('Experience\n\u2022 Built a very long bullet that wraps onto a second line because it is quite long indeed\nand finishes here with a result of 40%.\n\u2022 Second bullet.');
  assert.strictEqual(p.bullets.length, 2);
  assert.ok(p.bullets[0].text.endsWith('result of 40%.'));
});

test('a strong, quantified resume passes the content checks', () => {
  const r = analyzeResume(GOOD);
  for (const id of ['verbs', 'numbers', 'buzzwords', 'length', 'count', 'pronouns', 'tense', 'dates', 'sections', 'links', 'skills', 'top']) {
    assert.ok(check(r, id).pass, id + ': ' + check(r, id).note);
  }
});

test('even a strong resume gets told about repeated openers ("Built" and "Developed" x3)', () => {
  const v = check(analyzeResume(GOOD), 'variety');
  assert.ok(!v.pass);
  assert.ok(/built/.test(v.note) && /developed/.test(v.note), v.note);
});

const WEAK = `Alex Doe
alex@example.com
Experience
Intern at Foo 2021 - Aug 2022
\u2022 Responsible for testing the website
\u2022 Worked on various tasks and helped the team
\u2022 I built a login page for my team
\u2022 Develop new features for the app
\u2022 Team player and hard-working self-starter who is passionate
\u2022 Assisted with documentation
Education
Some University 03/2019 - 2023`;

test('a weak resume is caught, with the bullets that caused it', () => {
  const r = analyzeResume(WEAK);
  const verbs = check(r, 'verbs');
  assert.ok(!verbs.pass);
  assert.ok(verbs.examples.some((e) => e.text.startsWith('Responsible for') && e.hint.includes('Led')));
  assert.ok(verbs.examples.some((e) => e.text.startsWith('Worked on')));
  assert.ok(!check(r, 'numbers').pass);
  const buzz = check(r, 'buzzwords');
  assert.ok(!buzz.pass && /team player/.test(buzz.note) && /passionate/.test(buzz.note));
  assert.ok(!check(r, 'pronouns').pass);
  assert.ok(check(r, 'pronouns').examples[0].text.startsWith('I built'));
  assert.ok(!check(r, 'tense').pass, 'Develop (base) mixed with past-tense openers');
  assert.ok(!check(r, 'dates').pass);
  assert.ok(!check(r, 'sections').pass && /Skills/.test(check(r, 'sections').note));
  assert.ok(!check(r, 'links').pass);
  assert.ok(!check(r, 'skills').pass);
});

test('the same opening verb used too often is flagged', () => {
  const bullets = Array.from({ length: 6 }, (_, i) => '\u2022 Built feature number ' + (i + 1) + ' for the platform').join('\n');
  const r = analyzeResume('Projects\n' + bullets);
  assert.ok(!check(r, 'variety').pass);
  assert.ok(/built/.test(check(r, 'variety').note));
});

test('numbers: years and tech names with digits do not count as results', () => {
  const r = analyzeResume('Experience\n\u2022 Built a site in 2023 using Web3 and S3 buckets for storage\n\u2022 Built a tool for the team\n\u2022 Built a thing');
  assert.strictEqual(check(r, 'numbers').examples.length, 3);
  const q = analyzeResume('Experience\n\u2022 Reduced load time by 40%\n\u2022 Served 3x more users\n\u2022 Mentored six students');
  assert.ok(check(q, 'numbers').pass);
});

test('bullet length: very long and very short bullets are flagged', () => {
  const long = 'Built ' + 'a very detailed thing '.repeat(10);
  const r = analyzeResume('Experience\n\u2022 ' + long + '\n\u2022 Built it\n\u2022 Built a tool that cut report time by 30% for the team');
  const lenCheck = check(r, 'length');
  assert.ok(!lenCheck.pass);
  assert.ok(lenCheck.examples.some((e) => /Too long/.test(e.hint)) && lenCheck.examples.some((e) => /Too short/.test(e.hint)));
});

test('junk and empty input do not throw', () => {
  for (const v of ['', '   ', null, undefined, 'just one line', '\u2022 \u2022 \u2022']) {
    assert.doesNotThrow(() => analyzeResume(v));
  }
  const r = analyzeResume('');
  assert.strictEqual(r.parsed.bullets.length, 0);
  assert.ok(!check(r, 'sections').pass);
});
