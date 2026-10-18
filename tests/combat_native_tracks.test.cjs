'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../model.js');
const catalog = require('../catalog.js');
const names = ['茜特菈莉', '莱依拉', '蓝砚', '绮良良', '钟离', '迪奥娜'];
const action = (Name, Character, Index, Action = 'e', Expression = 'e-ready && since>15') =>
  ({Name, Character, Index, Action, Condition: {Expression}, EnsureCast: false, MorePriorities: []});
const source = Actions => ({Info: {Name: '原生候选角色测试', Author: '', Config: {}, PreActions: []}, Actions});
const imported = actions => M.importStrategy(source(actions), catalog);

test('a large native pool folds by its primary priorities and retains author separator labels', () => {
  const p = imported([
    action('盾位开盾', '', 10, '', 'false'),
    ...names.map(name => action(`${name}开盾`, name, 10)),
    action('后台技能', '', 30, '', 'false'),
    action('芙宁娜战技', '芙宁娜', 30),
    action('香菱战技', '香菱', 30)
  ]);
  const before = M.clone(p), groups = M.nativeTrackGroups(p);
  assert.equal(groups.length, 3);
  assert.equal(groups[0].id, 'native-common');
  assert.equal(groups[1].name, '盾位开盾');
  assert.deepEqual(groups[1].characterIds.map(id => M.character(catalog, id).name), names);
  assert.equal(groups[2].name, '后台技能');
  assert.equal(groups[2].characterIds.length, 2);
  assert.deepEqual(p, before);
  assert.equal(M.hasCompatibility(p), false);
});

test('an actual four-character strategy keeps all four character tracks at the same priority', () => {
  const p = imported(['雷电将军', '行秋', '班尼特', '香菱'].map(name => action(`${name}战技`, name, 0)));
  const groups = M.nativeTrackGroups(p);
  assert.equal(groups.length, 4);
  assert.ok(groups.every(group => group.characterIds.length === 1));
  assert.equal(new Set(groups.map(group => group.id)).size, 4);
});

test('generic instructions and state markers have a separate track with no invented character', () => {
  const p = imported([
    action('向前靠近', '', 2, 'keydown(w),wait(0.5),keyup(w)', 'since>3'),
    action('红血标记', '', 1, '', 'low-hp && since>3'),
    action('兜底等待', '', 999, 'wait(0.2)', '')
  ]);
  const groups = M.nativeTrackGroups(p);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].id, 'native-common');
  assert.deepEqual(groups[0].characterIds, []);
  assert.deepEqual(new Set(groups[0].clipIds), new Set(p.clips.map(clip => clip.id)));
  assert.ok(p.clips.every(clip => clip.useCurrentCharacter));
  assert.deepEqual(M.exportStrategy(p, catalog, {embedProject: false}).Actions.map(row => row.Character), ['', '', '']);
});

test('each native action belongs to exactly one display group across all priorities', () => {
  const actions = [
    ...names.map(name => action(`${name}开盾`, name, 10)),
    ...names.map(name => action(`${name}爆发`, name, 100, 'q', 'q-ready && since>15')),
    action('红血标记', '', -3, '', 'low-hp && since>3')
  ];
  actions[0].MorePriorities = [{Priority: -100, Expression: 'low-hp && e-ready'}];
  const p = imported(actions), groups = M.nativeTrackGroups(p);
  const ids = groups.flatMap(group => group.clipIds);
  assert.equal(ids.length, p.clips.length);
  assert.equal(new Set(ids).size, p.clips.length);
  assert.equal(groups[1].priority, 10);
  assert.equal(groups[1].clipIds.length, names.length * 2);
  assert.equal(groups[1].characterIds.length, names.length);
});

test('grouping preserves duplicate indices, independent extra triggers and original declaration order', () => {
  const actions = [
    action('当前移动', '', 99, 'dash(0.1)', 'since>2'),
    ...names.map(name => action(`${name}开盾`, name, 10)),
    action('盾位标题', '', 10, '', 'false')
  ];
  actions[1].MorePriorities = [{Priority: 0, Expression: 'low-hp'}];
  actions[2].MorePriorities = [{Priority: -1, Expression: 'since>20 && e-ready', Custom: 'retained'}];
  const native = source(actions), p = M.importStrategy(native, catalog);
  M.nativeTrackGroups(p);
  assert.deepEqual(M.exportStrategy(p, catalog, {embedProject: false}).Actions, native.Actions);
  assert.deepEqual(M.importStrategy(M.exportStrategy(p, catalog), catalog).roleSlots, []);
});

test('only explicitly disabled empty generic actions supply display labels', () => {
  const p = imported([
    action('红血状态', '', -10, '', 'low-hp'),
    action('角色状态', '钟离', -10, '', 'false'),
    ...names.filter(name => name !== '钟离').map(name => action(`${name}开盾`, name, -10))
  ]);
  const group = M.nativeTrackGroups(p).find(item => item.characterIds.length);
  assert.equal(group.name, '优先级 P-10');
  assert.equal(group.priority, -10);
});

test('display groups include off-roster source characters without changing a team plan', () => {
  const p = imported(names.map(name => action(`${name}开盾`, name, 10)));
  M.enableTeams(p);
  const before = M.clone(p);
  const groups = M.nativeTrackGroups(p);
  assert.equal(groups[0].characterIds.length, names.length);
  assert.deepEqual(p, before);
});

test('silent actual roster members retain their own empty track alongside generic actions', () => {
  const p = imported([
    action('班尼特战技', '班尼特', 10),
    action('兜底等待', '', 999, 'wait(0.2)', '')
  ]);
  M.enableTeams(p);
  const silent = catalog.characters.find(character => character.name === '香菱').id;
  M.setTeamRoster(p, M.activeTeam(p).id, [...p.team, silent], catalog);
  const group = M.nativeTrackGroups(p).find(item => item.characterIds.includes(silent));
  assert.ok(group);
  assert.deepEqual(group.clipIds, []);
  assert.equal(group.name, '队伍成员');
});

test('removing a native character preserves every generic action and state marker', () => {
  const actions = [
    action('通用靠近', '', 0, 'keydown(w),wait(0.5),keyup(w)', 'since>3'),
    action('班尼特战技', '班尼特', 10),
    action('红血标记', '', 1, '', 'low-hp && since>3'),
    action('行秋爆发', '行秋', 20, 'q', 'q-ready'),
    action('兜底等待', '', 999, 'wait(0.2)', '')
  ];
  const p = imported(actions);
  const removed = catalog.characters.find(character => character.name === '班尼特').id;
  M.removeCharacter(p, removed);
  assert.deepEqual(M.exportStrategy(p, catalog, {embedProject: false}).Actions,
    actions.filter(row => row.Character !== '班尼特'));
  assert.equal(M.nativeTrackGroups(p).find(group => group.id === 'native-common').clipIds.length, 3);
  assert.ok(p.clips.every(clip => p.team.includes(clip.characterId)));
});

test('removing the last named native character leaves a usable generic-only strategy', () => {
  const actions = [
    action('通用靠近', '', 0, 'dash(0.1)', 'since>3'),
    action('班尼特战技', '班尼特', 10),
    action('兜底等待', '', 999, 'wait(0.2)', '')
  ];
  const p = imported(actions);
  M.removeCharacter(p, p.team[0]);
  assert.equal(M.nativeTrackGroups(p).length, 1);
  assert.deepEqual(M.nativeTrackGroups(p)[0].characterIds, []);
  assert.deepEqual(M.exportStrategy(p, catalog, {embedProject: false}).Actions,
    actions.filter(row => !row.Character));
  assert.deepEqual(M.validate(p, catalog).filter(issue => issue.severity !== 'warning'), []);
});

test('TXT and sequential JSON continue using their existing character and compatibility tracks', () => {
  const p = imported(names.map(name => action(`${name}开盾`, name, 10)));
  p.scheduling = 'sequence';
  assert.deepEqual(M.nativeTrackGroups(p), []);
  p.scheduling = 'original';
  p.strategyFormat = 'txt';
  assert.deepEqual(M.nativeTrackGroups(p), []);
});
