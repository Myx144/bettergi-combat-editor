'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {webcrypto} = require('node:crypto');

function standalone() {
  const context = vm.createContext({crypto: webcrypto});
  for (const file of ['cast-timings.js', 'operations.js', 'strategy-formats.js', 'roles.js', 'model.js', 'catalog.js'])
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context, {filename: file});
  return {M: context.CombatTimeline, catalog: context.CombatCatalog, context};
}

test('the distributed application has no synthetic test calibrations', () => {
  const {M, context} = standalone();
  assert.equal(Object.keys(context.CombatCastTimings.characters).length, 0);
  assert.equal(M.timingFor('10000052', 'skill'), null);
});

test('the distributed catalog uses its pinned public data source and optional remote images', () => {
  const {catalog} = standalone();
  const manifest = require('../data/catalog-source.json');
  assert.equal(catalog.revision, manifest.revision);
  assert.equal(catalog.characters.length, manifest.characters.length);
  for (const character of catalog.characters) {
    assert.ok(!character.avatar || character.avatar.startsWith('https://enka.network/ui/'));
    assert.equal(character.aliases.length, 2);
  }
});

test('an uncalibrated standalone demo exports and reopens without a timing service', () => {
  const {M, catalog} = standalone();
  const project = M.demoProject(catalog);
  const native = M.exportStrategy(project, catalog);
  const reopened = M.importStrategy(native, catalog);
  assert.equal(reopened.clips.length, project.clips.length);
  assert.equal(reopened.durationMs, project.durationMs);
  assert.equal(native.Info.Config.CombatTimeline.compilerVersion, 3);
  assert.ok(reopened.clips.filter(clip => ['skill', 'burst'].includes(clip.abilityId))
    .every(clip => clip.castTiming === null));
});

test('manual calibration survives a standalone native JSON round trip', () => {
  const {M, catalog} = standalone();
  const project = M.emptyProject();
  project.repeat = false;
  const clip = M.addClip(project, catalog, '10000052', 'skill', 0, false);
  clip.lockOverrideMs = 720;
  clip.foregroundMs = 720;
  M.fitLoop(project);
  const restored = M.importStrategy(M.exportStrategy(project, catalog), catalog);
  assert.equal(restored.clips[0].lockOverrideMs, 720);
});
