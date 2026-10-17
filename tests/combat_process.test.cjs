'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const M = require('../model.js');
const Ops = require('../operations.js');
const catalog = require('../catalog.js');
const raiden = '10000052', xingqiu = '10000025', bennett = '10000032';

function project(repeat = false) {
  return {...M.emptyProject(), repeat, durationMs: 1000};
}

function add(p, type, options = {}, characterId = raiden, at = null) {
  const start = at ?? Math.max(0, ...p.clips.map(M.endOf));
  const clip = M.addClip(p, catalog, characterId, type, start, false);
  Object.assign(clip, options);
  p.durationMs = Math.max(p.durationMs, ...p.clips.map(M.endOf));
  return clip;
}

function finish(p) {
  M.fitLoop(p);
  assert.deepEqual(M.validate(p).filter(issue => issue.severity !== 'warning'), []);
  return M.exportStrategy(p, catalog);
}

// Replay the emitted priority conditions against completion records, with
// controllable readiness and action latency. This is not a game simulation.
function replay(strategy, {untilMs = 30000, durationFor = null, eReady = () => true,
  qReady = () => true, stop = () => false} = {}) {
  const history = [];
  let timeMs = 0;
  const count = name => history.filter(event => !name || event.name === name).length;
  const context = vm.createContext({count, t: () => timeMs / 1000,
    since: name => {
      const last = history.findLast(event => event.name === name);
      return last ? (timeMs - last.completedMs) / 1000 : Infinity;
    },
    eReady: name => eReady({name, timeMs, history, count}),
    qReady: name => qReady({name, timeMs, history, count})});
  const expression = source => {
    const code = source.replace(/\be-ready\b/g, 'eReady').replace(/\bq-ready\b/g, 'qReady')
      .replace(/(?<![<>=!])=(?!=)/g, '===')
      .replace(/\b(count|since|eReady|qReady)\(([^()]*)\)/g, (_, method, name) =>
        `${method}(${name.trim() ? JSON.stringify(name.trim()) : ''})`);
    return new vm.Script(code || 'true');
  };
  const candidates = strategy.Actions.flatMap(action => [
    {action, index: action.Index, condition: expression(action.Condition.Expression)},
    ...action.MorePriorities.map(priority => ({action, index: priority.Index ?? action.Index,
      condition: expression(priority.Expression)}))
  ]).sort((a, b) => a.index - b.index);
  const naturalDuration = action => M.parseCommands(action.Action).reduce((total, command) => {
    const length = ['wait', 'attack', 'charge', 'dash'].includes(command.method) ? command.args[0]
      : command.method === 'walk' ? command.args[1] : null;
    return total + (length === null ? command.method === 'skill' ? 80 : command.method === 'burst' ? 350 : 20
      : Math.round(Number(length) * 1000));
  }, 0);
  while (timeMs < untilMs && history.length < 300) {
    const candidate = candidates.find(item => item.condition.runInContext(context));
    if (!candidate) { timeMs += 10; continue; }
    const action = candidate.action, startMs = timeMs;
    timeMs += Math.max(1, durationFor ? durationFor(action, history) : naturalDuration(action));
    history.push({name: action.Name, character: action.Character, startMs, completedMs: timeMs});
    if (stop(history)) break;
  }
  return history;
}

test('new projects use process execution and old projects keep their timeline clock', () => {
  assert.equal(M.emptyProject().execution, 'process');
  const old = M.demoProject(catalog);
  delete old.execution;
  const reopened = M.normalizeProject(old, catalog);
  assert.equal(reopened.execution, 'timeline');
  assert.match(M.exportStrategy(reopened, catalog).Actions[0].Condition.Expression, /t\(\)/);
});

test('process export uses completion dependencies and explicit relative idle waits', () => {
  const p = project();
  const first = add(p, 'skill');
  const second = add(p, 'walk', {foregroundMs: 500}, raiden, M.actionEndOf(first) + 700);
  const value = finish(p);
  assert.ok(value.Actions.every(action => !action.Condition.Expression.includes('t()')));
  const pause = value.Actions.find(action => action.Name === `Wait${first.id}`);
  assert.equal(pause.Action, 'wait(0.7)');
  assert.equal(pause.Character, '');
  assert.match(value.Actions.find(action => action.Name === second.name).Condition.Expression,
    new RegExp(`count\\(${pause.Name}\\) > count\\(${second.name}\\)`));
});

test('an unavailable E waits and a later ready action cannot overtake it', () => {
  const p = project();
  const first = add(p, 'skill');
  const second = add(p, 'walk');
  const history = replay(finish(p), {eReady: ({timeMs}) => timeMs >= 2800});
  const cast = history.find(event => event.name === first.name);
  const walk = history.find(event => event.name === second.name);
  assert.equal(cast.startMs, 2800);
  assert.ok(walk.startMs >= cast.completedMs);
  assert.equal(history.filter(event => event.name === first.name).length, 1);
  assert.equal(history.filter(event => event.name === second.name).length, 1);
});

test('relative waiting is preserved after an unexpectedly slow skill', () => {
  const p = project();
  const first = add(p, 'skill');
  const next = add(p, 'dash', {}, raiden, M.endOf(first) + 500);
  const history = replay(finish(p), {durationFor: action =>
    action.Name === first.name ? 6000 : action.Action === 'wait(0.5)' ? 500 : 100});
  assert.equal(history.find(event => event.name === next.name).startMs, 6500);
});

test('unready Q can be skipped and its following attack is skipped with it', () => {
  const p = project();
  const burst = add(p, 'burst', {followAttack: true, attackAfterMs: 500});
  burst.foregroundMs = M.minimumForegroundMs(burst);
  const walk = add(p, 'walk');
  const value = finish(p), history = replay(value, {qReady: () => false});
  assert.equal(history.some(event => event.name === burst.name), false);
  assert.ok(history.some(event => event.name === `Skip${burst.id}`));
  assert.ok(history.some(event => event.name === `SkipAttack${burst.id}`));
  assert.equal(history.some(event => event.name === `Attack${burst.id}`), false);
  assert.ok(history.some(event => event.name === walk.name));
});

test('Q configured to wait holds the step until Q readiness changes', () => {
  const p = project();
  const burst = add(p, 'burst', {notReady: 'wait'});
  const next = add(p, 'jump');
  const value = finish(p);
  assert.equal(value.Actions.some(action => action.Name.startsWith('Skip')), false);
  const history = replay(value, {qReady: ({timeMs}) => timeMs >= 4200});
  assert.equal(history.find(event => event.name === burst.name).startMs, 4200);
  assert.ok(history.find(event => event.name === next.name).startMs > 4200);
});

test('a repeating rotation combines executed and skipped completions for three cycles', () => {
  const p = project(true);
  const opening = add(p, 'skill');
  const burst = add(p, 'burst', {followAttack: true, attackAfterMs: 400});
  burst.foregroundMs = M.minimumForegroundMs(burst);
  const walk = add(p, 'walk', {}, xingqiu);
  const value = finish(p), tail = value.Actions.at(-1).Name;
  const history = replay(value, {qReady: ({count}) => count(opening.name) % 2 === 1,
    stop: history => history.filter(event => event.name === tail).length === 3});
  assert.deepEqual(history.filter(event => [burst.name, `Skip${burst.id}`].includes(event.name))
    .map(event => event.name), [burst.name, `Skip${burst.id}`, burst.name]);
  assert.equal(history.filter(event => event.name === walk.name).length, 3);
  assert.equal(history.filter(event => event.name === `Attack${burst.id}`).length, 2);
  assert.equal(history.filter(event => event.name === `SkipAttack${burst.id}`).length, 1);
});

test('extra conditions can skip a step without fabricating a successful skill record', () => {
  const p = project();
  const first = add(p, 'skill', {readiness: 'none', condition: 'false', notReady: 'skip'});
  const next = add(p, 'jump');
  const history = replay(finish(p));
  assert.equal(history.some(event => event.name === first.name), false);
  assert.ok(history.some(event => event.name === `Skip${first.id}`));
  assert.ok(history.some(event => event.name === next.name));
});

test('alternative priorities preserve their condition while respecting readiness and order', () => {
  const p = project();
  const first = add(p, 'skill', {condition: 'false', sourceAction:
    {Index: 8, MorePriorities: [{Index: -10, Expression: 'true', Extra: 'retained'}]}});
  const next = add(p, 'dash');
  const value = finish(p);
  const action = value.Actions.find(action => action.Name === first.name);
  assert.equal(action.MorePriorities[0].Extra, 'retained');
  assert.match(action.MorePriorities[0].Expression, /e-ready/);
  const history = replay(value, {eReady: ({timeMs}) => timeMs >= 1700});
  assert.equal(history.find(event => event.name === first.name).startMs, 1700);
  assert.ok(history.find(event => event.name === next.name).startMs > 1700);
});

test('process switches keep the real one-second guard under variable action latency', () => {
  const p = project(true);
  add(p, 'attack', {foregroundMs: 100});
  add(p, 'attack', {foregroundMs: 1000}, xingqiu);
  add(p, 'attack', {foregroundMs: 1000}, bennett);
  const value = finish(p);
  assert.equal(value.Actions[0].Name.startsWith('Switch'), false);
  const history = replay(value, {untilMs: 12000, durationFor: () => 80});
  const switches = history.filter(event => event.name.startsWith('Switch'));
  assert.ok(switches.length >= 6);
  for (let index = 1; index < switches.length; index++) {
    assert.ok(switches[index].startMs - switches[index - 1].completedMs >= 1000);
  }
  const first = p.clips[0].name;
  const returns = history.filter(event => event.name.startsWith('SwitchLoopReturn'));
  for (const returning of returns) {
    const opening = history.find(event => event.name === first && event.startMs > returning.completedMs);
    if (opening) assert.ok(opening.startMs - returning.completedMs >= 1000);
  }
});

test('generated names avoid case-insensitive collisions and indices remain unique', () => {
  const p = project();
  add(p, 'skill', {notReady: 'skip'});
  add(p, 'walk', {name: 'skipclip1', sourceAction: {Index: 18}});
  const value = finish(p);
  const names = value.Actions.map(action => action.Name.toLowerCase());
  assert.equal(new Set(names).size, names.length);
  assert.ok(value.Actions.some(action => action.Name === 'Skipclip1S'));
  assert.equal(new Set(value.Actions.map(action => action.Index)).size, value.Actions.length);
});

test('process cooldown conflicts are reference warnings and do not lengthen the rotation', () => {
  const p = project(true);
  add(p, 'skill');
  const value = finish(p);
  assert.ok(p.durationMs < 21000);
  assert.ok(M.validate(p).some(issue => issue.code === 'cooldown-loop' && issue.severity === 'warning'));
  assert.ok(value.Actions.length);
  p.execution = 'timeline';
  assert.throws(() => M.exportStrategy(p, catalog), /冷却/);
});

test('managed E retry contains the cast and protection, with its attack in a separate action', () => {
  const p = project();
  const skill = add(p, 'skill', {followAttack: true, attackAfterMs: 800});
  skill.foregroundMs = M.minimumForegroundMs(skill);
  const value = finish(p), action = value.Actions.find(action => action.Name === skill.name);
  assert.equal(action.EnsureCast, true);
  assert.doesNotMatch(action.Action, /attack/);
  assert.match(action.Action, /^skill,wait\(/);
  const follow = value.Actions.find(action => action.Name === `Attack${skill.id}`);
  assert.equal(follow.Action, 'attack(0.8)');
  assert.equal(follow.EnsureCast, false);
});

test('a short follow attack retains the remaining cast lock and skips it with an unready skill', () => {
  const p = project();
  const skill = add(p, 'skill', {followAttack: true, attackAfterMs: 200, notReady: 'skip',
    lockOverrideMs: 2000, castTiming: {lockMs: 2000, followFrames: {attack: 30}}});
  skill.foregroundMs = M.minimumForegroundMs(skill);
  const next = add(p, 'walk', {}, xingqiu);
  const value = finish(p), release = value.Actions.find(action => action.Name === `Release${skill.id}`);
  assert.equal(release.Action, 'wait(1.3)');
  assert.equal(release.EnsureCast, false);
  const history = replay(value);
  const cast = history.find(event => event.name === skill.name);
  const switching = history.find(event => event.name === `Switch${next.id}`);
  assert.ok(switching.startMs - cast.startMs >= 2000);
  const skipped = replay(value, {eReady: () => false});
  assert.equal(skipped.some(event => event.name === release.Name), false);
  assert.ok(skipped.some(event => event.name === `SkipRelease${skill.id}`));
  assert.ok(skipped.some(event => event.name === next.name));
});

test('managed Q uses native recovery and an unknown E has no invented cast-protection time', () => {
  const p = project();
  const burst = add(p, 'burst');
  const value = finish(p);
  assert.equal(value.Actions.find(action => action.Name === burst.name).Action, 'burst,ready');
  const unknown = catalog.characters.find(character => M.timingFor(character.id, 'skill')?.lockMs == null);
  const other = project(), skill = add(other, 'skill', {}, unknown.id);
  const exported = finish(other).Actions.find(action => action.Name === skill.name);
  assert.equal(exported.Action, 'skill');
  assert.equal(M.castLockMs(skill), null);
});

test('movement, dash, jump, key holds and camera motion compile to native commands', () => {
  const p = project();
  const walk = add(p, 'walk', {foregroundMs: 750, operation: {...Ops.parameters('walk'), direction: 's'}});
  const dash = add(p, 'dash', {foregroundMs: 300});
  const jump = add(p, 'jump');
  const keys = add(p, 'keyhold', {foregroundMs: 400, operation: {...Ops.parameters('keyhold'), keys: 'W + Shift'}});
  const turn = add(p, 'moveby', {operation: {...Ops.parameters('moveby'), x: -320, y: 12}});
  const value = finish(p);
  const body = clip => value.Actions.find(action => action.Name === clip.name).Action;
  assert.equal(body(walk), 'walk(s,0.75)');
  assert.equal(body(dash), 'dash(0.3)');
  assert.equal(body(jump), 'jump');
  assert.equal(body(keys), 'keydown(W),keydown(VK_LSHIFT),wait(0.4),keyup(VK_LSHIFT),keyup(W)');
  assert.equal(body(turn), 'moveby(-320,12)');
});

test('native movement aliases import as editable operations', () => {
  const rows = Ops.fromCommands(M.parseCommands('行走(a,0.6),冲刺(0.2),跳跃,verticalscroll(-1)'));
  assert.deepEqual(rows.map(row => row.type), ['walk', 'dash', 'jump', 'scroll']);
  assert.equal(rows[0].direction, 'a');
  assert.equal(Ops.compile(rows), 'walk(a,0.6),dash(0.2),jump,scroll(-1)');
});

test('a held movement key survives nested chord holds until the group ends', () => {
  const operations = [
    {...Ops.make('keydown'), keys: 'W'},
    {...Ops.make('keyhold'), keys: 'Ctrl + W', durationMs: 300},
    Ops.make('dash')
  ];
  const commands = M.parseCommands(Ops.compile(operations));
  const pressed = new Set();
  let checkedDash = false;
  for (const command of commands) {
    if (command.method === 'keydown') pressed.add(command.args[0]);
    if (command.method === 'keyup') pressed.delete(command.args[0]);
    if (command.method === 'dash') {
      assert.deepEqual([...pressed], ['W']);
      checkedDash = true;
    }
  }
  assert.equal(checkedDash, true);
  assert.equal(pressed.size, 0);
});

test('mouse and keyboard down events are balanced even without explicit up rows', () => {
  const operations = [
    {...Ops.make('mousedown'), button: 'right'},
    {...Ops.make('mousehold'), button: 'right', durationMs: 200},
    {...Ops.make('keydown'), keys: 'W + D'},
    Ops.make('wait')
  ];
  const commands = M.parseCommands(Ops.compile(operations));
  assert.deepEqual(commands.slice(-3).map(command => command.raw), ['mouseup(right)', 'keyup(D)', 'keyup(W)']);
  const wait = commands.findIndex(command => command.raw === 'wait(0.2)');
  assert.notEqual(commands[wait + 1].method, 'mouseup');
});

test('invalid key parameters produce an editor issue and block native export', () => {
  const p = project();
  const clip = add(p, 'keyhold', {operation: {...Ops.parameters('keyhold'), keys: 'UnknownKey'}});
  const issues = M.validate(p);
  assert.ok(issues.some(issue => issue.code === 'command' && issue.clipIds.includes(clip.id)));
  assert.throws(() => M.exportStrategy(p, catalog), /无法识别按键/);
});

test('combo release length stays fixed inside longer stand time and shrinking cannot cut its inputs', () => {
  const p = project();
  const combo = add(p, 'combo');
  const length = M.castDurationMs(combo), body = M.commandsFor(combo);
  M.editClip(p, combo.id, {foregroundMs: length + 1500});
  assert.equal(M.castDurationMs(combo), length);
  assert.equal(M.commandsFor(combo), body);
  assert.equal(M.idleIntervals(M.foregroundRuns(p)[0])[0].startMs, combo.startMs + length);
  M.resizeForegroundRun(p, combo.id, 0);
  assert.equal(combo.foregroundMs, length);
  assert.equal(M.commandsFor(combo), body);
});

test('a combo protects known per-character E locks without enabling whole-group retries', () => {
  const p = project();
  const combo = add(p, 'combo', {operations: Ops.template('move-skill')}, bennett);
  combo.foregroundMs = M.operationDurationMs(combo);
  const value = finish(p), action = value.Actions.find(action => action.Name === combo.name);
  const lock = M.timingFor(bennett, 'skill').lockMs;
  assert.match(action.Action, new RegExp(`skill,wait\\(${M.seconds(lock)}\\)`));
  assert.equal(action.EnsureCast, false);
  assert.equal(action.Action.endsWith('keyup(W)'), true);
});

test('creator keyboard actions import as operations while native conditions and empty role are retained', () => {
  const original = {Info: {Name: '键盘策略', Author: 'creator', Config: {nativeFlag: true}}, extraRoot: 9,
    Actions: [
      {Name: '准备', Character: '', Action: 'keydown(W),dash(0.2),wait(0.3),keyup(W)',
        Condition: {Expression: 'count() = 0', Tag: 'keep'}, Index: 0, EnsureCast: false, MorePriorities: [], Extra: 1},
      {Name: '技能', Character: '班尼特', Action: 'skill,wait(0.4)',
        Condition: {Expression: 'e-ready(班尼特)'}, Index: 7, EnsureCast: true, MorePriorities: []}
    ]};
  const p = M.importStrategy(original, catalog), out = M.exportStrategy(p, catalog);
  assert.equal(p.scheduling, 'original');
  assert.equal(p.clips[0].abilityId, 'combo');
  assert.deepEqual(p.clips[0].operations.map(operation => operation.type), ['keydown', 'dash', 'wait', 'keyup']);
  assert.equal(p.clips[0].characterId, bennett);
  assert.deepEqual(out.Actions, original.Actions);
  assert.equal(out.Info.Config.nativeFlag, true);
  assert.equal(out.extraRoot, 9);
});

test('native walking and jump imports do not get mislabeled as normal attacks', () => {
  const value = {Info: {}, Actions: [
    {Name: '走位', Character: '行秋', Action: 'walk(a,0.75)', Condition: {Expression: ''}, Index: 0},
    {Name: '跳跃', Character: '', Action: 'jump', Condition: {Expression: ''}, Index: 1}
  ]};
  const p = M.importStrategy(value, catalog);
  assert.equal(p.clips[0].abilityId, 'walk');
  assert.equal(p.clips[0].operation.direction, 'a');
  assert.equal(p.clips[0].foregroundMs, 750);
  assert.equal(p.clips[1].abilityId, 'jump');
  assert.equal(M.exportStrategy(p, catalog).Actions[1].Character, '');
});

test('process project metadata reopens without flattening keyboard groups or readiness rules', () => {
  const p = project(true);
  add(p, 'combo', {operations: Ops.template('forward-dash')});
  add(p, 'burst', {notReady: 'wait'}, xingqiu);
  const exported = finish(p);
  assert.equal(exported.Info.Config.CombatTimeline.compilerVersion, 3);
  assert.deepEqual(M.importStrategy(JSON.parse(JSON.stringify(exported)), catalog), p);
});

test('old compiler version two metadata remains a legacy timeline when reopened', () => {
  const p = M.demoProject(catalog);
  p.execution = 'timeline';
  const exported = M.exportStrategy(p, catalog, {compilerVersion: 2});
  delete exported.Info.Config.CombatTimeline.project.execution;
  const reopened = M.importStrategy(exported, catalog);
  assert.equal(reopened.execution, 'timeline');
  assert.equal(reopened.scheduling, 'sequence');
  assert.deepEqual(M.exportStrategy(reopened, catalog, {compilerVersion: 2}).Actions, exported.Actions);
});

test('process export uses standard native action fields and no fabricated success API', () => {
  const value = finish(M.demoProject(catalog));
  for (const action of value.Actions) {
    assert.deepEqual(Object.keys(action).sort(), ['Action', 'Character', 'Condition', 'EnsureCast', 'Index', 'MorePriorities', 'Name']);
    assert.doesNotMatch(action.Condition.Expression, /success|result|timeout/i);
    assert.ok(M.parseCommands(action.Action).length);
  }
  assert.ok(value.Actions.some(action => action.Condition.Expression.includes('count(')));
});

test('normal attacks and waits are individual steps in their timeline and native execution order', () => {
  const p = project();
  const attacks = [add(p, 'attack', {foregroundMs: 300}), add(p, 'wait', {foregroundMs: 200}),
    add(p, 'attack', {foregroundMs: 400}), add(p, 'attack', {foregroundMs: 500})];
  const value = finish(p);
  assert.deepEqual(value.Actions.filter(action => attacks.some(clip => clip.name === action.Name))
    .map(action => action.Action), ['attack(0.3)', 'wait(0.2)', 'attack(0.4)', 'attack(0.5)']);
  assert.deepEqual(replay(value).filter(event => attacks.some(clip => clip.name === event.name))
    .map(event => event.name), attacks.map(clip => clip.name));
  const run = M.foregroundRuns(p)[0];
  assert.equal(run.clips.length, 4);
  assert.equal(M.foregroundRuns(p).length, 1);
});

test('inserting a wait between adjacent attacks retains the requested order and ripples the later attack', () => {
  const p = project();
  const first = add(p, 'attack', {foregroundMs: 400});
  const last = add(p, 'attack', {foregroundMs: 300});
  const wait = M.insertAfter(p, catalog, first.id, 'wait');
  assert.deepEqual(M.ordered(p).map(clip => clip.id), [first.id, wait.id, last.id]);
  assert.equal(wait.startMs, 400);
  assert.equal(last.startMs, 900);
  M.editClip(p, wait.id, {foregroundMs: 200});
  const middle = M.insertAfter(p, catalog, wait.id, 'attack');
  M.editClip(p, middle.id, {foregroundMs: 100});
  assert.deepEqual(M.ordered(p).map(clip => clip.abilityId), ['attack', 'wait', 'attack', 'attack']);
  assert.equal(last.startMs, 700);
  assert.equal(first.foregroundMs, 400);
  finish(p);
});

test('moving and trimming an attack do not change its earlier Q or the wait duration', () => {
  const p = project();
  const burst = add(p, 'burst');
  const attack = add(p, 'attack', {foregroundMs: 1000}, raiden, 3500);
  const wait = add(p, 'wait', {foregroundMs: 200}, raiden, 5000);
  const cast = M.clone(burst);
  M.editClip(p, attack.id, {startMs: 3000});
  assert.deepEqual(burst, cast);
  M.editClip(p, attack.id, {foregroundMs: 500});
  assert.deepEqual(burst, cast);
  assert.equal(wait.foregroundMs, 200);
  assert.equal(M.commandsFor(attack), 'attack(0.5)');
  finish(p);
});

test('old follow-attack projects split without changing their character effects or later roles', () => {
  const p = project();
  const burst = add(p, 'burst', {followAttack: true, attackAfterMs: 3000, foregroundMs: 6000});
  const next = add(p, 'walk', {}, xingqiu, 7000);
  p.durationMs = 9000;
  const original = M.clone(p), reopened = M.normalizeProject(p, catalog);
  assert.deepEqual(p, original);
  const saved = reopened.clips.find(clip => clip.id === burst.id);
  const attack = reopened.clips.find(clip => clip.abilityId === 'attack');
  assert.equal(saved.followAttack, false);
  assert.equal(saved.attackAfterMs, 0);
  assert.equal(saved.foregroundMs, M.attackStartMs(burst));
  assert.equal(saved.effectMs, 7000);
  assert.equal(attack.startMs, burst.startMs + M.attackStartMs(burst));
  assert.equal(attack.foregroundMs, 3000);
  assert.equal(reopened.clips.find(clip => clip.id === next.id).startMs, 7000);
  assert.equal(reopened.durationMs, 9000);
  assert.deepEqual(M.normalizeProject(reopened, catalog), reopened);
});

test('old native metadata is compared before splitting so saved timing and custom metadata reopen correctly', () => {
  const p = project();
  const skill = add(p, 'skill', {followAttack: true, attackAfterMs: 900});
  skill.foregroundMs = M.minimumForegroundMs(skill);
  add(p, 'walk', {}, xingqiu, 4000);
  p.sourceRoot = {CreatorProperty: {enabled: true}};
  p.sourceInfo = {Description: 'Native metadata', Config: {Extra: [1, 2]}};
  const old = M.exportStrategy(p, catalog);
  const reopened = M.importStrategy(old, catalog);
  assert.equal(reopened.scheduling, 'sequence');
  assert.equal(reopened.execution, 'process');
  assert.equal(reopened.clips.length, p.clips.length + 1);
  assert.deepEqual(reopened.sourceRoot, p.sourceRoot);
  assert.deepEqual(reopened.sourceInfo, p.sourceInfo);
  assert.equal(reopened.clips.find(clip => clip.abilityId === 'attack').foregroundMs, 900);
  const native = M.exportStrategy(reopened, catalog);
  assert.equal(new Set(native.Actions.map(action => action.Index)).size, native.Actions.length);
  assert.deepEqual(M.importStrategy(native, catalog), reopened);
});

test('a migrated Q still skips its old attack when unready while new independent attacks run normally', () => {
  const p = project();
  const burst = add(p, 'burst', {followAttack: true, attackAfterMs: 400});
  burst.foregroundMs = M.minimumForegroundMs(burst);
  const other = add(p, 'attack', {foregroundMs: 300});
  const reopened = M.normalizeProject(p, catalog), value = finish(reopened);
  const inherited = reopened.clips.find(clip => clip.followSourceId === burst.id);
  const history = replay(value, {qReady: () => false});
  assert.equal(history.some(event => event.name === inherited.name), false);
  assert.ok(history.some(event => event.name === `Skip${inherited.id}`));
  assert.ok(history.some(event => event.name === other.name));
});

test('splitting a short follow attack preserves the later switch lock in scheduling, resizing and export', () => {
  const p = project();
  const skill = add(p, 'skill', {followAttack: true, attackAfterMs: 200, notReady: 'skip',
    lockOverrideMs: 2000, castTiming: {lockMs: 2000, followFrames: {attack: 30}}});
  skill.foregroundMs = M.minimumForegroundMs(skill);
  const next = add(p, 'walk', {}, xingqiu);
  const reopened = M.normalizeProject(p, catalog);
  const cast = reopened.clips.find(clip => clip.id === skill.id);
  const attack = reopened.clips.find(clip => clip.abilityId === 'attack');
  assert.equal(cast.foregroundMs, 500);
  assert.equal(M.castLockMs(cast), 2000);
  assert.equal(attack.startMs, 500);
  assert.equal(attack.foregroundMs, 200);
  M.resizeForegroundRun(reopened, cast.id, 0);
  assert.equal(M.foregroundRuns(reopened)[0].endMs, 2000);
  assert.equal(attack.foregroundMs, 200);
  M.moveClips(reopened, [next.id], -1000);
  assert.ok(M.validate(reopened).some(issue => issue.code === 'cast-lock'));
  M.repairSchedule(reopened);
  assert.equal(reopened.clips.find(clip => clip.id === next.id).startMs, 2000);
  const value = finish(reopened), history = replay(value);
  assert.ok(history.find(event => event.name === `Switch${next.id}`).startMs -
    history.find(event => event.name === cast.name).startMs >= 2000);
  const skipped = replay(value, {eReady: () => false});
  assert.equal(skipped.some(event => event.name === attack.name), false);
  assert.equal(skipped.some(event => event.name === `Release${skill.id}`), false);
  assert.ok(skipped.some(event => event.name === next.name));
});

test('moving an old follow attack before its skill detaches the inherited skip rule', () => {
  const p = project();
  const burst = add(p, 'burst', {followAttack: true, attackAfterMs: 300}, raiden, 3000);
  burst.foregroundMs = M.minimumForegroundMs(burst);
  const reopened = M.normalizeProject(p, catalog);
  const attack = reopened.clips.find(clip => clip.abilityId === 'attack');
  M.editClip(reopened, attack.id, {startMs: 0});
  assert.equal(attack.startMs, 0);
  assert.equal(attack.followSourceId, null);
  assert.equal(reopened.clips.find(clip => clip.id === burst.id).startMs, 3000);
  const history = replay(finish(reopened), {qReady: () => false});
  assert.ok(history.some(event => event.name === attack.name));
});

test('an inserted attack keeps distinct native indices after an old project has been expanded', () => {
  const p = project();
  const skill = add(p, 'skill', {followAttack: true, attackAfterMs: 500});
  skill.foregroundMs = M.minimumForegroundMs(skill);
  const reopened = M.normalizeProject(p, catalog);
  const inherited = reopened.clips.find(clip => clip.abilityId === 'attack');
  const wait = M.insertAfter(reopened, catalog, inherited.id, 'wait');
  M.insertAfter(reopened, catalog, wait.id, 'attack');
  const value = finish(reopened);
  assert.equal(new Set(value.Actions.map(action => action.Index)).size, value.Actions.length);
});

test('resizing an imported attack or wait recompiles only that action and retains its creator conditions', () => {
  const native = {Info: {Name: 'Atomic actions'}, Actions: [
    {Name: 'A', Character: '雷电将军', Action: ' 普攻(0.8) ', Condition: {Expression: 'true'},
      Index: 7, MorePriorities: [], EnsureCast: false, CreatorField: 'retained'},
    {Name: 'Pause', Character: '', Action: '等待(0.2)', Condition: {Expression: 'count(A) > count(Pause)'},
      Index: 8, MorePriorities: [], EnsureCast: false}
  ]};
  const p = M.importStrategy(native, catalog);
  assert.deepEqual(M.exportStrategy(p, catalog).Actions, native.Actions);
  M.editClip(p, p.clips[0].id, {foregroundMs: 300});
  M.editClip(p, p.clips[1].id, {foregroundMs: 500});
  const value = M.exportStrategy(p, catalog);
  assert.equal(value.Actions[0].Action, 'attack(0.3)');
  assert.equal(value.Actions[1].Action, 'wait(0.5)');
  for (let i = 0; i < native.Actions.length; i++) {
    assert.deepEqual(value.Actions[i].Condition, native.Actions[i].Condition);
    assert.equal(value.Actions[i].Index, native.Actions[i].Index);
    assert.equal(value.Actions[i].Character, native.Actions[i].Character);
  }
  assert.equal(value.Actions[0].CreatorField, 'retained');
});
