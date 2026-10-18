'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../model.js');
const catalog = require('../catalog.js');
const raiden = '10000052', xingqiu = '10000025', bennett = '10000032', xiangling = '10000023';

function project(format = 'json') {
  const p = {...M.emptyProject(), repeat: false, durationMs: 12000};
  if (format === 'txt') M.setStrategyFormat(p, format);
  return p;
}

function attack(p, characterId, startMs, foregroundMs = 600) {
  const clip = M.addClip(p, catalog, characterId, 'attack', startMs, false);
  clip.foregroundMs = foregroundMs;
  return clip;
}

const blocking = p => M.validate(p).filter(issue => issue.severity !== 'warning');

test('TXT is a real text artifact and never serializes JSON conditions or estimates as waits', () => {
  const p = project('txt');
  const clip = M.addClip(p, catalog, '10000002', 'skill', 3000, false);
  Object.assign(clip, {condition: 'low-hp()', readiness: 'skill', ensureCast: true,
    castTiming: null, castEstimateMs: 1234, protectCast: true, foregroundMs: 1234});
  const document = M.exportDocument(p, catalog);
  assert.equal(document.extension, '.txt');
  assert.equal(document.mime, 'text/plain;charset=utf-8');
  assert.match(document.text, /神里绫华 skill\n/);
  assert.doesNotMatch(document.text, /wait\(|low-hp|e-ready|EnsureCast|CombatTimeline|Actions/);
  assert.throws(() => M.exportStrategy(p, catalog), /TXT/);
});

test('TXT exposes native E wait/fast, recovery, explicit movement and independent attack/wait commands', () => {
  const p = project('txt');
  const skill = M.addClip(p, catalog, raiden, 'skill', 0, false);
  Object.assign(skill, {hold: true, txtSkillPolicy: 'wait', txtReady: true, protectCast: false});
  const walk = M.addClip(p, catalog, raiden, 'walk', 2000, false);
  Object.assign(walk, {foregroundMs: 400, operation: {...walk.operation, direction: 's'}});
  attack(p, raiden, 3000, 700);
  const wait = M.addClip(p, catalog, raiden, 'wait', 4000, false);
  wait.foregroundMs = 200;
  const text = M.exportTextStrategy(p, catalog);
  assert.match(text, /skill\(hold,wait\),ready/);
  assert.match(text, /walk\(s,0.4\)/);
  assert.match(text, /attack\(0.7\)\n.*wait\(0.2\)/);
  skill.txtSkillPolicy = 'fast';
  assert.match(M.exportTextStrategy(p, catalog), /skill\(hold,fast\)/);
});

test('TXT only turns layout gaps into explicit relative waits when requested', () => {
  const p = project('txt');
  attack(p, raiden, 1000, 500);
  attack(p, raiden, 2200, 500);
  assert.doesNotMatch(M.exportTextStrategy(p, catalog), /wait\(/);
  p.txtWaitGaps = true;
  const text = M.exportTextStrategy(p, catalog);
  assert.match(text, /wait\(1\)/);
  assert.match(text, /wait\(0.7\)/);
  assert.doesNotMatch(text, /wait\(9.3\)/);
});

test('TXT calibrated casting protection is explicit and does not invent an unknown lock', () => {
  const p = project('txt');
  const clip = M.addClip(p, catalog, raiden, 'skill', 0, false);
  Object.assign(clip, {lockOverrideMs: 733, foregroundMs: 733});
  assert.match(M.exportTextStrategy(p, catalog), /skill,wait\(0.733\)/);
  clip.lockOverrideMs = null;
  clip.castTiming = null;
  assert.doesNotMatch(M.exportTextStrategy(p, catalog), /wait\(/);
});

test('a TXT layout wait belongs to the preceding character and does not switch early', () => {
  const p = project('txt');
  attack(p, raiden, 0, 500);
  attack(p, xingqiu, 2000, 500);
  p.txtWaitGaps = true;
  assert.match(M.exportTextStrategy(p, catalog), /雷电将军 attack\(0.5\)\n雷电将军 wait\(1.5\)\n行秋 attack/);
});

test('TXT imports character commands, semicolons and round sections without flattening macro holds', () => {
  const text = '// 测试流程\r\n// 作者：Creator\r\n' +
    '雷电将军 e(wait),attack(0.5),wait(0.2),attack(0.4);行秋 q,ready\n' +
    '班尼特 round(1,3-5),e(fast)|round(2),keydown(W),dash(0.2),wait(0.3),keyup(W)\n';
  const p = M.importDocument(text, catalog);
  assert.equal(p.strategyFormat, 'txt');
  assert.equal(p.name, '测试流程');
  assert.equal(p.author, 'Creator');
  assert.deepEqual(p.clips.slice(0, 6).map(clip => clip.abilityId),
    ['skill', 'attack', 'wait', 'attack', 'burst', 'ready']);
  assert.equal(p.clips.at(-1).abilityId, 'combo');
  assert.equal(p.clips.at(-1).commandOverride, 'keydown(W),dash(0.2),wait(0.3),keyup(W)');
  assert.equal(p.clips.at(-1).txtRounds, '2');
  const exported = M.exportTextStrategy(p, catalog);
  assert.match(exported, /round\(1,3-5\),e\(fast\)/);
  assert.match(exported, /round\(2\),keydown\(W\),dash\(0.2\),wait\(0.3\),keyup\(W\)/);
  assert.deepEqual(blocking(p), []);
});

test('generic TXT can contain more than four candidate characters and retain their order', () => {
  const characters = catalog.characters.slice(0, 7);
  const p = M.importTextStrategy(characters.map(character => `${character.name} attack(0.3)`).join('\n'), catalog);
  assert.equal(p.team.length, 7);
  assert.equal(M.normalizeProject(p, catalog).team.length, 7);
  assert.deepEqual(M.ordered(p).map(clip => clip.characterId), characters.map(character => character.id));
  assert.equal(M.exportTextStrategy(p, catalog).split('\n').filter(line => line && !line.startsWith('//')).length, 7);
});

test('format switching retains JSON conditions, priorities, calibration and scheduling independently', () => {
  const p = project();
  const clip = M.addClip(p, catalog, raiden, 'skill', 0, false);
  Object.assign(clip, {condition: 'e-ready() && !low-hp()', priority: -4, lockOverrideMs: 800,
    foregroundMs: 800, morePriorities: [{Priority: -10, Expression: 'low-hp()'}]});
  M.setStrategyFormat(p, 'txt');
  clip.txtSkillPolicy = 'fast';
  M.setStrategyFormat(p, 'json');
  assert.equal(p.scheduling, 'sequence');
  assert.equal(p.execution, 'process');
  assert.equal(clip.condition, 'e-ready() && !low-hp()');
  assert.equal(clip.priority, -4);
  assert.equal(clip.lockOverrideMs, 800);
  assert.equal(clip.txtSkillPolicy, 'fast');
  assert.deepEqual(clip.morePriorities, [{Priority: -10, Expression: 'low-hp()'}]);
  assert.deepEqual(M.importDocument(M.exportDocument(p, catalog).text, catalog), p);
});

test('native JSON condition mode retains a healing priority branch rather than compiling a forced rotation', () => {
  const p = project();
  p.scheduling = 'original';
  const heal = M.addClip(p, catalog, bennett, 'burst', 0, false);
  Object.assign(heal, {priority: -10, condition: 'low-hp() && q-ready()',
    morePriorities: [{Priority: 15, Expression: 'q-ready() && !(since() < 15)'}]});
  const normal = attack(p, raiden, 3000, 800);
  normal.condition = 'onfield()';
  const strategy = M.exportStrategy(p, catalog, {embedProject: false});
  assert.equal(strategy.Actions.length, 2);
  assert.equal(strategy.Actions[0].Index, -10);
  assert.equal(strategy.Actions[0].Condition.Expression, heal.condition);
  assert.deepEqual(strategy.Actions[0].MorePriorities, heal.morePriorities);
  assert.doesNotMatch(JSON.stringify(strategy), /Skipclip|SwitchLoopReturn|count\(|t\(\)/);
  assert.ok(M.priorityOf(normal) > M.priorityOf(heal));
});

test('JSON retains declaration-order priority ties across import, reference dragging and reimport', () => {
  const native = {Info: {Name: '声明顺序'}, Actions: [
    {Name: '高位替代', Character: '雷电将军', Action: 'attack(0.4)', Index: 30,
      Condition: {Expression: 'false'}, MorePriorities: [{Priority: 0, Expression: 'true'}]},
    {Name: '主条件', Character: '行秋', Action: 'attack(0.5)', Index: 0,
      Condition: {Expression: 'true'}, MorePriorities: []}
  ]};
  const firstEligible = strategy => strategy.Actions.flatMap(action => [
    {name: action.Name, priority: action.Index, condition: action.Condition.Expression},
    ...action.MorePriorities.map(priority => ({name: action.Name, priority: priority.Priority,
      condition: priority.Expression}))
  ]).sort((a, b) => a.priority - b.priority).find(entry => entry.condition === 'true').name;
  const p = M.importStrategy(native, catalog);
  assert.equal(M.ordered(p)[0].name, '主条件');
  assert.equal(firstEligible(M.exportStrategy(p, catalog)), '高位替代');
  const reference = M.ordered(p).at(-1);
  M.placeClips(p, [reference.id], -reference.startMs);
  const exported = M.exportStrategy(p, catalog);
  assert.deepEqual(exported.Actions.map(action => action.Name), native.Actions.map(action => action.Name));
  assert.equal(firstEligible(exported), firstEligible(native));
  const reopened = M.importStrategy(exported, catalog);
  assert.equal(firstEligible(M.exportStrategy(reopened, catalog)), firstEligible(native));
});

test('legacy embedded condition projects without declaration metadata retain their saved layout and native order', () => {
  const p = project();
  p.scheduling = 'original';
  attack(p, raiden, 4000);
  attack(p, xingqiu, 1000);
  const native = M.exportStrategy(p, catalog);
  native.Actions.sort((a, b) => M.ordered(p).findIndex(clip => clip.name === a.Name)
    - M.ordered(p).findIndex(clip => clip.name === b.Name));
  for (const clip of native.Info.Config.CombatTimeline.project.clips) delete clip.declarationOrder;
  const reopened = M.importStrategy(native, catalog);
  assert.deepEqual(reopened.clips.map(clip => clip.startMs), p.clips.map(clip => clip.startMs));
  assert.deepEqual(M.exportStrategy(reopened, catalog).Actions, native.Actions);
});

test('TXT project normalization always restores command sequencing, including old conflicting preview settings', () => {
  const p = project('txt');
  attack(p, raiden, 0);
  p.execution = 'timeline';
  p.scheduling = 'original';
  const restored = M.normalizeProject(p, catalog);
  assert.equal(restored.execution, 'process');
  assert.equal(restored.scheduling, 'sequence');
  assert.ok(M.isProcess(restored));
});

test('TXT malformed inputs report their line and unsupported native methods', () => {
  assert.throws(() => M.importTextStrategy('雷电将军 walk(w,no)', catalog), /第 1 行/);
  assert.throws(() => M.importTextStrategy('雷电将军 teleport(4)', catalog), /不支持指令 teleport/);
  assert.throws(() => M.importTextStrategy('雷电将军 round(5-2),e', catalog), /轮次范围/);
  assert.throws(() => M.importTextStrategy('Nobody e', catalog), /无法识别角色/);
  assert.deepEqual(M.parseRounds('1,3-5,4'), [1, 3, 4, 5]);
});

test('a role clip can be inserted before another role, including the opening at zero', () => {
  const p = project();
  const first = attack(p, raiden, 0);
  const moved = attack(p, xiangling, 2000);
  const last = attack(p, xingqiu, 4000);
  const result = M.placeClips(p, [moved.id], -2100);
  assert.equal(result.blocked, false);
  assert.equal(moved.startMs, 0);
  assert.deepEqual(M.ordered(p).map(clip => clip.id), [moved.id, first.id, last.id]);
  assert.deepEqual(blocking(p), []);
});

test('rightward insert passes another role instead of pushing it in the old order', () => {
  const p = project();
  const moved = attack(p, raiden, 0);
  const second = attack(p, bennett, 2000);
  const third = attack(p, xingqiu, 4000);
  M.placeClips(p, [moved.id], 3100);
  assert.deepEqual(M.ordered(p).map(clip => clip.id), [second.id, moved.id, third.id]);
  assert.equal(second.startMs, 2000);
  assert.equal(moved.startMs, 3100);
  assert.deepEqual(blocking(p), []);
});

test('group insertion pushes colliding successors with one common selected offset and no stacking', () => {
  const p = project();
  attack(p, raiden, 0);
  const first = attack(p, bennett, 3000);
  const second = attack(p, xingqiu, 4500);
  const next = attack(p, xiangling, 7000);
  const following = attack(p, xiangling, 8200);
  const nextGap = following.startMs - next.startMs;
  M.placeClips(p, [second.id, first.id], 2000);
  assert.equal(first.startMs, 5000);
  assert.equal(second.startMs, 6500);
  assert.equal(second.startMs - first.startMs, 1500);
  assert.ok(next.startMs >= 7500);
  assert.equal(following.startMs - next.startMs, nextGap);
  assert.deepEqual(blocking(p), []);
});

test('noncontiguous selection is inserted together without leaving an unselected action stacked inside it', () => {
  const p = project();
  const first = attack(p, raiden, 0);
  const middle = attack(p, bennett, 1500);
  const last = attack(p, xingqiu, 3000);
  M.placeClips(p, [first.id, last.id], 500);
  assert.equal(last.startMs - first.startMs, 3000);
  assert.deepEqual(M.ordered(p).map(clip => clip.id), [first.id, last.id, middle.id]);
  assert.deepEqual(blocking(p), []);
});

test('non-ripple dragging clamps a group into a free gap and leaves all other clips fixed', () => {
  const p = project();
  const prior = attack(p, raiden, 0);
  const first = attack(p, bennett, 3000);
  const last = attack(p, bennett, 4200);
  const next = attack(p, xingqiu, 6500);
  M.placeClips(p, [first.id, last.id], 2300, {ripple: false});
  assert.equal(prior.startMs, 0);
  assert.equal(next.startMs, 6500);
  assert.equal(last.startMs - first.startMs, 1200);
  assert.ok(M.endOf(last) <= next.startMs || first.startMs >= M.endOf(next));
  assert.deepEqual(blocking(p), []);
});

test('non-ripple placement reserves the cooldown from the entry switch before its next role', () => {
  const p = project();
  const prior = attack(p, raiden, 0, 300);
  const moved = attack(p, bennett, 1500, 300);
  const next = attack(p, xingqiu, 3500, 300);
  M.placeClips(p, [moved.id], 1600, {ripple: false});
  assert.equal(prior.startMs, 0);
  assert.equal(moved.startMs, 2500);
  assert.equal(next.startMs, 3500);
  assert.deepEqual(blocking(p), []);
});

test('a group too tightly spaced for a newly introduced switch is rejected atomically', () => {
  const p = project();
  const first = attack(p, raiden, 0, 300);
  const second = attack(p, bennett, 500, 300);
  attack(p, xingqiu, 3000, 300);
  const before = M.clone(p);
  assert.equal(M.placeClips(p, [first.id, second.id], 4500).blocked, true);
  assert.deepEqual(p, before);
});

test('group snapping only considers its chronological neighbors and excludes selected interior edges', () => {
  const p = project();
  const previous = attack(p, raiden, 0, 700);
  const first = attack(p, bennett, 3000);
  const last = attack(p, xingqiu, 4500);
  attack(p, xiangling, 8000);
  const snap = M.snapMove(p, [last.id, first.id], -2260, {anchorId: last.id, thresholdMs: 80});
  assert.equal(snap.guideMs, 700);
  M.placeClips(p, [first.id, last.id], snap.deltaMs);
  assert.equal(first.startMs, M.endOf(previous));
  assert.equal(last.startMs - first.startMs, 1500);
  assert.deepEqual(blocking(p), []);
});

test('the group trailing magnet reserves one second after its final entry switch', () => {
  const p = project();
  attack(p, raiden, 0);
  const first = attack(p, bennett, 3000);
  const last = attack(p, xingqiu, 4500);
  const next = attack(p, xiangling, 7000);
  const movement = M.snapMove(p, [first.id, last.id], 1470, {thresholdMs: 80});
  assert.deepEqual(movement, {deltaMs: 1500, guideMs: 7000});
  M.placeClips(p, [first.id, last.id], movement.deltaMs);
  assert.equal(next.startMs, 7000);
  assert.equal(last.startMs, 6000);
  assert.deepEqual(blocking(p), []);
});

test('single and group reordering never changes calibrated release or effect lengths', () => {
  const p = project();
  const a = M.addClip(p, catalog, raiden, 'skill', 0, false);
  const b = M.addClip(p, catalog, bennett, 'burst', 3000, false);
  const c = M.addClip(p, catalog, xingqiu, 'skill', 5000, false);
  const parameters = p.clips.map(clip => [M.castLockMs(clip), M.castDurationMs(clip), clip.effectMs, clip.cooldownMs]);
  M.placeClips(p, [c.id], -5000);
  M.placeClips(p, [c.id, a.id], 9000);
  assert.deepEqual(p.clips.map(clip =>
    [M.castLockMs(clip), M.castDurationMs(clip), clip.effectMs, clip.cooldownMs]), parameters);
  assert.ok(b.startMs >= 0);
  assert.deepEqual(blocking(p), []);
});
