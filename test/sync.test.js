'use strict';
// The proxy and the browser must run exactly the same prompts and job-search code.
// If this fails, run: node tools/sync-shared.js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

for (const name of ['prompts.js', 'jobs-core.js']) {
  test('js/' + name + ' is identical to proxy/lib/' + name, () => {
    const a = fs.readFileSync(path.join(root, 'proxy', 'lib', name), 'utf8');
    const b = fs.readFileSync(path.join(root, 'js', name), 'utf8');
    assert.strictEqual(a, b, 'out of sync: run node tools/sync-shared.js');
  });
}
