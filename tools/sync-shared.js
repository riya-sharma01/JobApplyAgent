// Copies the shared modules from proxy/lib/ (source of truth) to js/ for the browser.
// Usage: node tools/sync-shared.js
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
for (const name of ['prompts.js', 'jobs-core.js']) {
  fs.copyFileSync(path.join(root, 'proxy', 'lib', name), path.join(root, 'js', name));
  console.log('copied proxy/lib/' + name + ' -> js/' + name);
}
