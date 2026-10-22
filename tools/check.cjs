'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');
const files = ['editor.js', 'model.js', 'operations.js', 'strategy-formats.js', 'conditions.js', 'rule-editor.js',
  'teams.js', 'team-editor.js', 'multiplayer.js', 'multiplayer-editor.js', 'tree-model.js', 'tree-editor.js', 'roles.js', 'catalog.js', 'cast-timings.js',
  'electron/main.cjs', 'electron/preload.cjs', 'tools/build-catalog.cjs'];
for (const file of files) execFileSync(process.execPath, ['--check', path.join(root, file)], {stdio: 'pipe'});
const page = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
for (const match of page.matchAll(/(?:src|href)="([^"]+)"/g)) {
  const asset = match[1].split('?')[0];
  if (!asset || asset.startsWith('data:')) continue;
  assert.ok(fs.existsSync(path.join(root, asset)), `Missing asset: ${asset}`);
}
for (const file of ['index.html', 'editor.js', 'model.js', 'operations.js', 'strategy-formats.js', 'conditions.js',
  'rule-editor.js', 'teams.js', 'team-editor.js', 'multiplayer.js', 'multiplayer-editor.js', 'tree-model.js', 'tree-editor.js', 'roles.js']) {
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  assert.ok(!/\/web\/api|X-Combat-CSRF|websiteToolbar|combatApplyDialog|bgi_combat_read/.test(text),
    `Website integration leaked into ${file}`);
}
assert.ok(!fs.existsSync(path.join(root, 'website.js')));
assert.deepEqual(require('../cast-timings.js').characters, {});
console.log('Syntax, local assets and standalone release boundary passed.');
