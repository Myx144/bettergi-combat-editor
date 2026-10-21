'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const M = require('../model.js');
const R = require('../conditions.js');
const catalog = require('../catalog.js');
const id = name => catalog.characters.find(character => character.name === name).id;
const names = ['雷电将军', '行秋', '班尼特', '香菱'];
const header = () => ({Version: 1, Players: [
  {Id: 'host', IsHost: true, Characters: names.slice(0, 2), PreActions: []},
  {Id: 'guest', IsHost: false, Characters: [names[0], names[2]], PreActions: []}
]});
const action = (Name, Player, Character, Index, Expression = '', Action = 'wait(0.1)') =>
  ({Name, Player, Character, Index, Action, Condition: {Expression}, EnsureCast: false, MorePriorities: []});
const native = (Actions = [
  action('First', 'host', names[0], 0), action('First', 'guest', names[0], 0)
]) => ({Info: {Name: 'Multiplayer', Author: 'Test', Config: {}, PreActions: []}, Multiplayer: header(), Actions});
const imported = actions => M.importStrategy(native(actions), catalog);
const errors = p => M.validate(p, catalog).filter(issue => issue.severity !== 'warning');
const output = p => M.exportStrategy(p, catalog, {embedProject: false});

function sequence() {
  const p = {...M.emptyProject(), repeat: false};
  M.configureMultiplayer(p, header());
  for (const player of M.players(p)) M.setPlayerSettings(p, player.Id, {repeat: false, durationMs: 1000});
  M.setPlayerSettings(p, '', {repeat: false, durationMs: 1000});
  return p;
}

function add(p, playerId, character, ability = 'wait', startMs = 0, patch = {}) {
  M.setActivePlayer(p, playerId);
  const clip = M.addClip(p, catalog, id(character), ability, startMs, false);
  M.editClip(p, clip.id, patch, false);
  return p.clips.find(item => item.id === clip.id);
}

// Replay each bound endpoint separately. Histories are completion records,
// matching the native boundary rather than simulating shared game state.
function replay(strategy, limit = 40) {
  const records = [];
  const count = name => records.filter(record => record === name).length;
  const context = vm.createContext({count});
  const queue = R.expand(strategy).map(entry => ({
    ...entry, condition: new vm.Script((entry.expression || 'true')
      .replace(/(?<![<>=!])=(?!=)/g, '===')
      .replace(/count\(([^()]*)\)/g, (_, name) => `count(${JSON.stringify(name.trim())})`))
  }));
  for (let index = 0; index < limit; index++) {
    const next = queue.find(entry => entry.condition.runInContext(context));
    if (!next) break;
    records.push(next.name);
  }
  return records;
}

test('native multiplayer keeps interleaved declarations and duplicate local Name/Index history', () => {
  const value = native([
    action('Same', 'guest', names[0], 7, 'count(Same) < 3'),
    action('Same', 'host', names[0], 7, 'count(Same) < 1'),
    action('After', 'host', names[1], 7, 'count(Same) = 1 && count(After) = 0'),
    action('Tail', 'guest', names[2], -1, 'count(Same) = 3 && count(Tail) = 0')
  ]);
  const p = M.importStrategy(value, catalog);
  assert.deepEqual(output(p).Actions, value.Actions);
  assert.deepEqual(replay(M.playerStrategy(p, catalog, 'host')), ['Same', 'After']);
  assert.deepEqual(replay(M.playerStrategy(p, catalog, 'guest')), ['Same', 'Same', 'Same', 'Tail']);
  const host = p.clips.find(clip => clip.playerId === 'host');
  M.editClip(p, host.id, {startMs: 9000}, false);
  assert.deepEqual(output(p).Actions, value.Actions);
});

test('native header, player, action, priority and condition extensions survive a JSON roundtrip', () => {
  const value = native();
  value.ExtraRoot = {Future: [1, 'x']};
  value.Info.CustomInfo = {Keep: true};
  value.Info.Config.Future = {Nested: true};
  value.Multiplayer.Transport = {Future: [false, 3]};
  value.Multiplayer.Players[0].EnableCombatTargeting = false;
  value.Multiplayer.Players[1].EnableCombatTargeting = null;
  value.Multiplayer.Players[0].FuturePlayer = {Modes: ['x', 'y']};
  value.Actions[0].FutureAction = {Data: [1, 2]};
  value.Actions[0].Condition.FutureCondition = true;
  value.Actions[0].MorePriorities = [{Priority: -8, Expression: 'low-hp', FuturePriority: {Keep: 1}}];
  const p = M.importStrategy(value, catalog);
  assert.deepEqual(output(p), value);
  assert.deepEqual(output(M.importStrategy(M.exportStrategy(p, catalog), catalog)), value);
  assert.equal(M.exportStrategy(p, catalog).Info.Config.CombatTimeline.compilerVersion, 6);
});

test('known multiplayer keys are canonical for UI access without normalizing Id values or unknown fields', () => {
  const value = native();
  value.Multiplayer = {version: 1, players: [
    {id: 'Host', ishost: true, characters: names.slice(0, 2), preactions: [], custom: {Keep: 1}},
    {id: 'host', ishost: false, characters: [names[0], names[2]], enablecombattargeting: false}
  ], extension: 'keep'};
  value.Actions[0].Player = 'Host';
  value.Actions[1].Player = 'host';
  const p = M.importStrategy(value, catalog), list = M.players(p);
  assert.deepEqual(list.map(player => player.Id), ['Host', 'host']);
  assert.deepEqual(list[0].Characters, names.slice(0, 2));
  assert.equal(list[1].EnableCombatTargeting, false);
  assert.equal(Object.hasOwn(list[0], 'EnableCombatTargeting'), false);
  assert.deepEqual(list[0].custom, {Keep: 1});
  assert.equal(p.multiplayer.extension, 'keep');
  assert.deepEqual(errors(p), []);
});

test('shared and player-specific current-character actions never acquire a named runtime actor', () => {
  const actions = [
    action('', '', '', -3, 'low-hp', ''),
    action('Current', 'host', '', 4, 'since > 5', 'keydown(w),wait(0.2),keyup(w)'),
    action('First', 'host', names[0], 1),
    action('First', 'guest', names[0], 1)
  ];
  delete actions[0].Player;
  const p = imported(actions), nativeOutput = output(p);
  assert.deepEqual(nativeOutput.Actions, actions);
  for (const playerId of ['host', 'guest']) {
    const bound = M.playerStrategy(p, catalog, playerId);
    assert.ok(bound.Actions.every(row => !Object.hasOwn(row, 'Player')));
    assert.equal(bound.Actions[0].Character, '');
  }
  assert.equal(p.clips.filter(clip => clip.useCurrentCharacter).length, 2);
});

test('an explicit null native Player retains its shared-current-character semantics and original representation', () => {
  const value = native([action('Shared', null, '', 0, 'count(Shared) < 1')]);
  const p = M.importStrategy(value, catalog);
  assert.equal(p.clips[0].playerId, '');
  assert.deepEqual(output(p).Actions, value.Actions);
  assert.equal(M.playerStrategy(p, catalog, 'guest').Actions.length, 1);
});

test('a player queue preview tolerates empty endpoints and includes shared rules only once', () => {
  const p = sequence();
  const first = add(p, 'host', names[0]);
  first.name = 'Own';
  const shared = M.addCurrentAction(p, catalog, 'wait', 500, {playerId: '', ripple: false});
  shared.name = 'Shared';
  const host = M.playerStrategy(p, catalog, 'host'), guest = M.playerStrategy(p, catalog, 'guest');
  assert.equal(host.Actions.filter(row => row.Name === 'Shared').length, 1);
  assert.equal(guest.Actions.filter(row => row.Name === 'Shared').length, 1);
  assert.ok(!guest.Actions.some(row => row.Name === 'Own'));
  const empty = sequence();
  assert.deepEqual(M.playerStrategy(empty, catalog, 'guest').Actions, []);
});

test('new named actions require an explicit active owner and that players actual roster', () => {
  const p = sequence();
  assert.equal(M.activePlayer(p).Id, 'host');
  M.setActivePlayer(p, 'guest');
  const clip = M.makeClip(p, catalog, id(names[0]), 'wait', 0);
  assert.equal(clip.playerId, 'guest');
  assert.throws(() => M.addClip(p, catalog, id(names[1]), 'skill', 0), /不在玩家/);
  M.setActivePlayer(p, '');
  assert.equal(M.activePlayer(p), null);
  assert.throws(() => M.addClip(p, catalog, id(names[0]), 'skill', 0), /具名角色/);
  assert.throws(() => M.setActivePlayer(p, 'HOST'), /不存在/);
});

test('explicitly assigning owner and character patches only identity in the native source action', () => {
  const p = imported(), clip = p.clips[0], original = M.clone(clip.sourceAction);
  M.assignClipPlayer(p, clip.id, 'guest', {characterId: id(names[2]), currentCharacter: false});
  assert.equal(clip.playerId, 'guest');
  assert.equal(clip.characterId, id(names[2]));
  assert.deepEqual(clip.sourceAction, {...original, Player: 'guest', Character: names[2]});
  assert.throws(() => M.assignClipPlayer(p, clip.id, '', {currentCharacter: false}), /具名角色/);
  M.assignClipPlayer(p, clip.id, '', {currentCharacter: true});
  assert.equal(clip.useCurrentCharacter, true);
  assert.equal(clip.sourceAction.Character, '');
  assert.equal(clip.sourceAction.Name, original.Name);
  assert.deepEqual(clip.sourceAction.Condition, original.Condition);
  assert.throws(() => M.editClip(p, clip.id, {playerId: 'host'}), /归属/);
});

test('a private ripple changes only its own clips and leaves another endpoints exported program unchanged', () => {
  const p = sequence();
  const first = add(p, 'host', names[0], 'wait', 0, {foregroundMs: 200});
  const hostTail = add(p, 'host', names[1], 'wait', 400, {foregroundMs: 200});
  const guest = add(p, 'guest', names[0], 'wait', 0, {foregroundMs: 300});
  M.addCurrentAction(p, catalog, 'wait', 1600, {playerId: '', ripple: false});
  const shared = p.clips.find(clip => clip.playerId === ''), sharedBefore = M.clone(shared);
  const guestBefore = M.playerStrategy(p, catalog, 'guest'), tailBefore = hostTail.startMs;
  M.editClip(p, first.id, {foregroundMs: 800}, true);
  assert.ok(p.clips.find(clip => clip.id === hostTail.id).startMs > tailBefore);
  assert.deepEqual(p.clips.find(clip => clip.id === shared.id), sharedBefore);
  assert.deepEqual(M.playerStrategy(p, catalog, 'guest'), guestBefore);
  assert.equal(p.clips.find(clip => clip.id === guest.id).startMs, 0);
});

test('per-player movement and snapping ignore other players and reject mixed-owner selections atomically', () => {
  const p = sequence();
  const a = add(p, 'host', names[0], 'wait', 0, {foregroundMs: 100});
  const b = add(p, 'guest', names[0], 'wait', 500, {foregroundMs: 100});
  const original = M.clone(p);
  assert.throws(() => M.placeClips(p, [a.id, b.id], 200), /跨玩家/);
  assert.deepEqual(p, original);
  const other = M.clone(p);
  other.clips.find(clip => clip.id === b.id).startMs = 8000;
  assert.deepEqual(M.snapMove(p, [a.id], 410, {thresholdMs: 120}),
    M.snapMove(other, [a.id], 410, {thresholdMs: 120}));
  M.placeClips(p, [a.id], 300);
  assert.equal(p.clips.find(clip => clip.id === b.id).startMs, 500);
});

test('fitLoop and repeat settings update only the active endpoint including the explicit shared scope', () => {
  const p = sequence();
  add(p, 'host', names[0], 'wait', 0, {foregroundMs: 300});
  add(p, 'guest', names[0], 'wait', 0, {foregroundMs: 300});
  M.setPlayerSettings(p, 'host', {repeat: true, durationMs: 9000});
  M.setPlayerSettings(p, 'guest', {repeat: false, durationMs: 7000});
  M.setActivePlayer(p, 'host');
  M.fitLoop(p);
  assert.equal(M.playerSettings(p, 'host').durationMs, 1000);
  assert.deepEqual(M.playerSettings(p, 'guest'), {durationMs: 7000, repeat: false});
  M.setActivePlayer(p, '');
  M.fitLoop(p);
  assert.deepEqual(M.playerSettings(p, 'guest'), {durationMs: 7000, repeat: false});
  assert.equal(p.durationMs, 7000);
});

test('local switch locks and duplicate character cooldowns never serialize different players', () => {
  const p = sequence();
  const a = add(p, 'host', names[0], 'wait', 0, {foregroundMs: 100});
  const b = add(p, 'host', names[1], 'wait', 100, {foregroundMs: 100});
  const c = add(p, 'host', names[0], 'wait', 200, {foregroundMs: 100});
  const guest = add(p, 'guest', names[0], 'wait', 0, {foregroundMs: 100});
  M.setActivePlayer(p, 'host');
  M.repairSchedule(p);
  assert.equal(p.clips.find(clip => clip.id === a.id).startMs, 0);
  assert.equal(p.clips.find(clip => clip.id === b.id).startMs, 100);
  assert.equal(p.clips.find(clip => clip.id === c.id).startMs, 1100);
  assert.equal(p.clips.find(clip => clip.id === guest.id).startMs, 0);
  assert.deepEqual(errors(p), []);
});

test('effect state and previous-cycle state are evaluated within each player even for identical roles', () => {
  const p = sequence();
  const a = add(p, 'host', names[0], 'skill', 0);
  add(p, 'guest', names[0], 'wait', 0);
  M.setPlayerSettings(p, 'host', {durationMs: 30000, repeat: false});
  const host = M.playerStateAt(p, 'host', 500), guest = M.playerStateAt(p, 'guest', 500);
  assert.ok(host.statuses.find(row => row.characterId === a.characterId).skills[0].cooldownMs > 0);
  assert.equal(guest.statuses.find(row => row.characterId === a.characterId).skills[0].cooldownMs, 0);
  assert.equal(M.stateAt(p, 500).players.length, 2);
  assert.ok(M.stateAt(p, 500).statuses.every(row => ['host', 'guest'].includes(row.playerId)));
});

test('shared reference overlap reports each affected endpoint instead of moving private clips', () => {
  const p = sequence();
  add(p, 'host', names[0], 'wait', 0, {foregroundMs: 500});
  add(p, 'guest', names[0], 'wait', 0, {foregroundMs: 500});
  const before = M.clone(p.clips);
  M.addCurrentAction(p, catalog, 'wait', 100, {playerId: '', ripple: true});
  assert.deepEqual(p.clips.filter(clip => clip.playerId), before);
  assert.deepEqual(new Set(errors(p).filter(issue => issue.code === 'overlap').map(issue => issue.playerId)),
    new Set(['host', 'guest']));
});

test('generic process actions preserve empty Character at the beginning and between two named characters', () => {
  const p = sequence();
  const opening = M.addCurrentAction(p, catalog, 'wait', 0, {playerId: 'host', ripple: false});
  add(p, 'host', names[0], 'wait', 500, {foregroundMs: 100});
  const middle = M.addCurrentAction(p, catalog, 'wait', 700, {playerId: 'host', ripple: false});
  add(p, 'host', names[1], 'wait', 1600, {foregroundMs: 100});
  add(p, 'guest', names[0], 'wait', 0);
  M.setPlayerSettings(p, 'host', {durationMs: 2000});
  const rows = output(p).Actions.filter(row => row.Player === 'host');
  for (const clip of [opening, middle]) {
    assert.equal(rows.find(row => row.Name === clip.name).Character, '');
    assert.ok(!rows.some(row => row.Name === `Switch${clip.id}`));
  }
  assert.equal(rows.filter(row => /^Switch/.test(row.Name)).length, 2);
  assert.ok(rows.every(row => row.Player === 'host'));
});

test('shared process commands are derived independently in every endpoint without a global dependency chain', () => {
  const p = sequence();
  const shared = M.addCurrentAction(p, catalog, 'wait', 0, {playerId: '', ripple: false});
  shared.name = 'Shared';
  add(p, 'host', names[0], 'wait', 500);
  add(p, 'guest', names[0], 'wait', 800);
  const rows = output(p).Actions;
  assert.equal(rows.filter(row => row.Name === 'Shared').length, 2);
  assert.deepEqual(rows.filter(row => row.Name === 'Shared').map(row => row.Player), ['host', 'guest']);
  for (const playerId of ['host', 'guest']) {
    const local = M.playerStrategy(p, catalog, playerId), names = local.Actions.map(row => row.Name);
    for (const row of local.Actions) {
      const targets = [...row.Condition.Expression.matchAll(/count\(([^)]+)\)/g)].map(match => match[1]);
      assert.ok(targets.every(target => names.includes(target)));
    }
  }
  assert.equal(p.clips.filter(clip => clip.id === shared.id).length, 1);
});

test('timeline compilation uses each endpoint reference clock and preserves generic commands', () => {
  const p = sequence();
  p.execution = 'timeline';
  const a = add(p, 'host', names[0], 'wait', 200);
  const b = add(p, 'guest', names[0], 'wait', 400);
  const shared = M.addCurrentAction(p, catalog, 'wait', 700, {playerId: '', ripple: false});
  M.setPlayerSettings(p, 'host', {durationMs: 3000, repeat: true});
  M.setPlayerSettings(p, 'guest', {durationMs: 5000, repeat: true});
  const host = M.playerStrategy(p, catalog, 'host'), guest = M.playerStrategy(p, catalog, 'guest');
  assert.ok(host.Actions.find(row => row.Name === a.name).Condition.Expression.includes('* 3 + 0.2'));
  assert.ok(guest.Actions.find(row => row.Name === b.name).Condition.Expression.includes('* 5 + 0.4'));
  for (const local of [host, guest])
    assert.equal(local.Actions.find(row => row.Name === shared.name).Character, '');
});

test('compiler 6 roundtrip retains one shared source while restoring independent process dependencies', () => {
  const p = sequence();
  const shared = M.addCurrentAction(p, catalog, 'wait', 0, {playerId: '', ripple: false});
  add(p, 'host', names[0], 'wait', 500);
  add(p, 'guest', names[0], 'wait', 700);
  M.setPlayerSettings(p, 'host', {durationMs: 9000, repeat: true});
  const before = output(p), saved = M.importStrategy(M.exportStrategy(p, catalog), catalog);
  assert.deepEqual(output(saved), before);
  assert.equal(saved.clips.filter(clip => clip.id === shared.id).length, 1);
  assert.deepEqual(M.playerSettings(saved, 'host'), {durationMs: 9000, repeat: true});
});

test('a generic insert inherits the explicit owner and current-character identity', () => {
  const p = sequence(), anchor = M.addCurrentAction(p, catalog, 'wait', 0, {playerId: 'guest', ripple: false});
  M.setActivePlayer(p, 'host');
  const next = M.insertAfter(p, catalog, anchor.id, 'attack');
  assert.equal(next.playerId, 'guest');
  assert.equal(next.useCurrentCharacter, true);
  assert.equal(next.sourceAction.Character, '');
  assert.equal(M.playerStrategy(p, catalog, 'guest').Actions.find(row => row.Name === next.name).Character, '');
});

test('removing a role deletes only that players named actions while preserving both scopes of generic actions', () => {
  const p = sequence();
  const host = add(p, 'host', names[0]);
  const guest = add(p, 'guest', names[0]);
  const local = M.addCurrentAction(p, catalog, 'wait', 500, {playerId: 'host', ripple: false});
  const shared = M.addCurrentAction(p, catalog, 'wait', 700, {playerId: '', ripple: false});
  M.removeCharacter(p, id(names[0]), {playerId: 'host'});
  assert.ok(!p.clips.some(clip => clip.id === host.id));
  for (const clip of [guest, local, shared]) assert.ok(p.clips.some(row => row.id === clip.id));
  assert.deepEqual(M.players(p)[0].Characters, [names[1]]);
  assert.deepEqual(M.players(p)[1].Characters, [names[0], names[2]]);
  assert.ok(errors(p).some(issue => issue.code === 'multiplayer-characters' && issue.playerId === 'host'));
});

test('player Id rename and swaps explicitly migrate timing and role metadata while preserving native action history', () => {
  const p = sequence(), a = add(p, 'host', names[0]), b = add(p, 'guest', names[0]);
  M.setActivePlayer(p, 'host');
  M.configureRole(p, a.characterId, 'onfield');
  M.setPlayerSettings(p, 'host', {durationMs: 12000, repeat: true});
  M.setPlayerSettings(p, 'guest', {durationMs: 20000, repeat: false});
  const value = M.clone(p.multiplayer);
  [value.Players[0].Id, value.Players[1].Id] = ['guest', 'host'];
  M.configureMultiplayer(p, value);
  M.remapPlayerMetadata(p, {host: 'guest', guest: 'host'});
  M.assignClipPlayer(p, a.id, 'guest');
  M.assignClipPlayer(p, b.id, 'host');
  assert.equal(p.activePlayerId, 'guest');
  assert.equal(p.roleSlots[0].playerId, 'guest');
  assert.deepEqual(M.playerSettings(p, 'guest'), {durationMs: 12000, repeat: true});
  assert.deepEqual(M.playerSettings(p, 'host'), {durationMs: 20000, repeat: false});
  assert.equal(p.clips.find(clip => clip.id === a.id).name, a.name);
  assert.deepEqual(errors(p), []);
});

test('legacy role profiles require explicit player ownership before multiplayer compilation', () => {
  const p = M.emptyProject();
  p.repeat = false;
  const clip = M.addClip(p, catalog, id(names[0]), 'wait', 0, false);
  M.configureRole(p, clip.characterId, 'onfield');
  M.configureMultiplayer(p, header());
  assert.ok(errors(p).some(issue => issue.code === 'multiplayer-player'));
  M.assignClipPlayer(p, clip.id, 'host');
  M.assignRolePlayer(p, p.roleSlots[0].id, 'host');
  assert.equal(M.playerProject(p, 'host').roleSlots[0].role, 'onfield');
  assert.equal(M.playerProject(p, 'guest').roleSlots.length, 0);
  assert.throws(() => M.assignRolePlayer(p, p.roleSlots[0].id, 'guest'), /不同玩家/);
});

test('draft header configuration permits no actions and partial rosters while export requires the full native contract', () => {
  const p = sequence();
  assert.deepEqual(M.validateMultiplayer(p, catalog, {requireActions: false}), []);
  assert.equal(errors(p).filter(issue => issue.code === 'multiplayer-empty').length, 2);
  assert.throws(() => output(p), /尚未配置/);
  const value = header();
  value.Players[1].Characters = [];
  M.configureMultiplayer(p, value);
  M.addCurrentAction(p, catalog, 'wait', 0, {playerId: '', ripple: false});
  assert.ok(errors(p).some(issue => issue.code === 'multiplayer-characters'));
  assert.throws(() => output(p), /需要/);
});

test('invalid headers, action owners, actual characters and targeting values fail explicitly', () => {
  for (const mutate of [
    value => { value.Players[1].Id = 'host'; },
    value => { value.Players[1].Id = ' bad'; },
    value => { value.Players[1].IsHost = true; },
    value => { value.Players[0].IsHost = false; },
    value => { value.Version = 2; },
    value => { value.Players[1].EnableCombatTargeting = 'false'; }
  ]) {
    const value = header();
    mutate(value);
    assert.throws(() => M.configureMultiplayer(M.emptyProject(), value));
  }
  const p = imported();
  p.clips[0].playerId = 'missing';
  assert.ok(errors(p).some(issue => issue.code === 'multiplayer-player'));
  p.clips[0].playerId = 'guest';
  p.clips[0].characterId = id(names[1]);
  assert.ok(errors(p).some(issue => issue.code === 'multiplayer-character'));
  assert.ok(M.validate(p).some(issue => issue.code === 'multiplayer-empty'));
});

test('native named actions must use actual standard names rather than aliases accepted by legacy imports', () => {
  const avatar = catalog.characters.find(character => character.name === names[0]);
  const alias = avatar.aliases.find(name => name !== avatar.name);
  assert.ok(alias);
  const p = imported([action('Alias', 'host', alias, 0), action('Guest', 'guest', names[0], 0)]);
  assert.ok(errors(p).some(issue => issue.code === 'multiplayer-character'));
  M.assignClipPlayer(p, p.clips[0].id, 'host', {characterId: avatar.id});
  assert.deepEqual(errors(p), []);
});

test('three- and four-player rosters follow host-aware native slot counts', () => {
  for (const count of [3, 4]) {
    const p = M.emptyProject(), value = {Version: 1, Players: Array.from({length: count}, (_, index) => ({
      Id: `p${index}`, IsHost: index === 0, Characters: count === 3 && index === 0 ? names.slice(0, 2) : [names[index]],
      PreActions: []
    }))};
    M.configureMultiplayer(p, value);
    assert.deepEqual(M.validateMultiplayer(p, catalog, {requireActions: false}), []);
    value.Players.at(-1).Characters = [];
    M.configureMultiplayer(p, value);
    assert.ok(errors(p).some(issue => issue.code === 'multiplayer-characters'));
  }
});

test('common openings must be current-character commands and player openings may refer only to their own roles', () => {
  const p = imported();
  p.preActions = ['walk(s, 0.2)'];
  M.players(p)[0].PreActions = [`${names[1]} wait(0.1)`];
  assert.deepEqual(errors(p), []);
  p.preActions = [`${names[0]} wait(0.1)`];
  assert.ok(errors(p).some(issue => issue.code === 'multiplayer-preactions' && issue.playerId === ''));
  p.preActions = [];
  M.players(p)[0].PreActions = [`${names[2]} wait(0.1)`];
  assert.ok(errors(p).some(issue => issue.code === 'multiplayer-preactions' && issue.playerId === 'host'));
});

test('TXT requires an explicit player and retains common then own openings with the native current-avatar marker', () => {
  const p = imported([
    action('Shared', '', '', 0, '', 'wait(0.2)'),
    action('Host', 'host', names[1], 1),
    action('Guest', 'guest', names[2], 1)
  ]);
  p.preActions = ['walk(s, 0.2)'];
  M.players(p)[0].PreActions = [`${names[1]} wait(0.4)`];
  M.players(p)[1].PreActions = [`${names[2]} wait(0.5)`];
  assert.throws(() => M.exportTextStrategy(p, catalog), /明确选择/);
  assert.throws(() => M.setStrategyFormat(p, 'txt'), /明确选择/);
  const before = M.clone(p), text = M.exportTextStrategy(p, catalog, {playerId: 'host'});
  assert.ok(text.indexOf('当前角色 walk(s, 0.2)') < text.indexOf(`${names[1]} wait(0.4)`));
  assert.ok(text.includes('当前角色 wait(0.2)'));
  assert.ok(!text.includes(names[2]));
  assert.deepEqual(p, before);
  const reopened = M.importTextStrategy(text, catalog);
  assert.equal(reopened.clips.filter(clip => clip.useCurrentCharacter).length, 2);
  assert.ok(M.exportTextStrategy(reopened, catalog).includes('当前角色'));
});

test('compiler 6 restores independent references while external native header and action edits take precedence', () => {
  const p = imported();
  M.setPlayerSettings(p, 'host', {durationMs: 41000, repeat: false});
  M.editClip(p, p.clips[0].id, {startMs: 1800}, false);
  const encoded = M.exportStrategy(p, catalog), reopened = M.importStrategy(encoded, catalog);
  assert.deepEqual(M.playerSettings(reopened, 'host'), {durationMs: 41000, repeat: false});
  assert.equal(reopened.clips.find(clip => clip.id === p.clips[0].id).startMs, 1800);
  encoded.Multiplayer.Players[0].EnableCombatTargeting = false;
  encoded.Multiplayer.FreshExtension = {Server: true};
  const headerEdit = M.importStrategy(encoded, catalog);
  assert.equal(M.players(headerEdit)[0].EnableCombatTargeting, false);
  assert.deepEqual(output(headerEdit).Multiplayer.FreshExtension, {Server: true});
  encoded.Actions[0].Action = 'wait(0.9)';
  assert.equal(output(M.importStrategy(encoded, catalog)).Actions[0].Action, 'wait(0.9)');
});

test('multiplayer collections cannot silently enter alternative team-plan compilation', () => {
  const p = imported();
  assert.throws(() => M.enableTeams(p), /多人/);
  const legacy = M.emptyProject();
  M.enableTeams(legacy);
  assert.throws(() => M.addTeam(legacy, catalog, {project: p}), /多人/);
  assert.throws(() => M.configureMultiplayer(legacy, header()), /多人/);
  p.teamPlans = [{id: 'team1', project: M.emptyProject(), roster: [], enabled: false}];
  assert.ok(errors(p).some(issue => issue.code === 'multiplayer-mode'));
  assert.throws(() => M.exportStrategy(p, catalog, {check: false}), /多人/);
  assert.throws(() => M.normalizeProject(p, catalog), /多人/);
});

test('normalizing multiplayer retains unique clip IDs, raw extensions and independent duplicate role slots', () => {
  const p = sequence();
  add(p, 'host', names[0]);
  M.configureRole(p, id(names[0]), 'onfield');
  add(p, 'guest', names[0]);
  M.configureRole(p, id(names[0]), 'healer');
  const reopened = M.normalizeProject(JSON.parse(JSON.stringify(p)), catalog);
  assert.equal(new Set(reopened.clips.map(clip => clip.id)).size, 2);
  assert.equal(M.playerProject(reopened, 'host').roleSlots[0].role, 'onfield');
  assert.equal(M.playerProject(reopened, 'guest').roleSlots[0].role, 'healer');
  assert.deepEqual(errors(reopened), []);
});

test('multiplayer applies the 800 native-action limit after independent endpoint expansion', () => {
  const p = imported(Array.from({length: 801}, (_, index) => action(`Step${index}`, '', '', index)));
  assert.throws(() => output(p), /800/);
});
