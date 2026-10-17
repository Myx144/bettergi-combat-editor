'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const M = require('../model.js');
const catalog = require('../catalog.js');
const bennett = '10000032', yaoyao = '10000077', xingqiu = '10000025', yelan = '10000060';
const logical = name => name.replace(/Role\d+C\d+S*$/, '');

function fixture(repeat = false) {
  const p = {...M.emptyProject(), repeat, durationMs: 15000};
  const e = M.addClip(p, catalog, bennett, 'skill', 0);
  M.addClip(p, catalog, bennett, 'attack', M.endOf(e) + 250);
  const q = M.addClip(p, catalog, xingqiu, 'burst', Math.max(...p.clips.map(M.endOf)) + 1000);
  M.addClip(p, catalog, xingqiu, 'wait', M.endOf(q));
  M.configureRole(p, bennett, 'healer');
  M.addRoleCandidate(p, catalog, bennett, yaoyao);
  M.configureRole(p, xingqiu, 'offfield');
  M.addRoleCandidate(p, catalog, xingqiu, yelan);
  M.fitLoop(p);
  return p;
}

function replay(strategy, party, {untilMs = 60000, eReady = () => true, qReady = () => true,
  durationFor = null, stop = () => false} = {}) {
  const history = [], present = new Set(party);
  let timeMs = 0;
  const context = vm.createContext({
    count: (name, start = 0, end = Infinity) => history.filter(event => event.name === name
      && event.completedMs >= start * 1000 && event.completedMs <= end * 1000).length,
    since: name => {
      const last = history.findLast(event => event.name === name);
      return last ? (timeMs - last.completedMs) / 1000 : Infinity;
    },
    inParty: name => present.has(name),
    eReady: name => present.has(name) && eReady(name, timeMs),
    qReady: name => present.has(name) && qReady(name, timeMs),
    eCd: () => 0, min: Math.min, max: Math.max
  });
  const expression = source => new vm.Script(source
    .replace(/\bin-party\b/g, 'inParty').replace(/\be-ready\b/g, 'eReady')
    .replace(/\bq-ready\b/g, 'qReady').replace(/\be-cd\b/g, 'eCd')
    .replace(/(?<![<>=!])=(?!=)/g, '===')
    .replace(/\b(count|since|inParty|eReady|qReady|eCd)\(([^()]*)\)/g, (_, method, raw) => {
      const [name, ...args] = raw.split(',').map(value => value.trim());
      return `${method}(${JSON.stringify(name)}${args.length ? ',' + args.join(',') : ''})`;
    }));
  const entries = strategy.Actions.filter(action => !action.Character || present.has(action.Character))
    .flatMap(action => [{action, priority: action.Index, condition: expression(action.Condition.Expression)},
      ...action.MorePriorities.map(priority => ({action,
        priority: priority.Priority ?? priority.Index ?? action.Index, condition: expression(priority.Expression)}))])
    .sort((a, b) => a.priority - b.priority);
  const duration = action => M.parseCommands(action.Action).reduce((sum, command) => {
    const value = command.method === 'walk' ? command.args[1]
      : ['wait', 'attack', 'charge', 'dash'].includes(command.method) ? command.args[0] : null;
    return sum + (value === null ? 40 : Math.round(Number(value) * 1000));
  }, 0);
  while (timeMs < untilMs && history.length < 500) {
    const entry = entries.find(candidate => candidate.condition.runInContext(context));
    if (!entry) { timeMs += 10; continue; }
    const action = entry.action, startMs = timeMs;
    timeMs += Math.max(1, durationFor ? durationFor(action) : duration(action));
    history.push({name: action.Name, logical: logical(action.Name), character: action.Character, startMs, completedMs: timeMs});
    if (stop(history)) break;
  }
  return history;
}

test('a role slot retains its identity and both profiles when switching characters', () => {
  const p = fixture(), before = M.clone(p), slotId = M.roleSlot(p, bennett).id;
  M.switchRoleCharacter(p, catalog, bennett, yaoyao);
  assert.equal(p.team[0], yaoyao);
  assert.equal(M.roleSlot(p, yaoyao).id, slotId);
  assert.deepEqual(p.clips.map(clip => clip.id), before.clips.map(clip => clip.id));
  assert.ok(p.clips.filter(clip => before.clips.find(old => old.id === clip.id).characterId === bennett)
    .every(clip => clip.characterId === yaoyao));
  M.switchRoleCharacter(p, catalog, yaoyao, bennett);
  assert.deepEqual(p.clips, before.clips);
  assert.equal(p.durationMs, before.durationMs);
});

test('an alternative uses its own talent data and never inherits the source calibration or hold form', () => {
  const p = fixture(), e = p.clips[0];
  Object.assign(e, {lockOverrideMs: 5432, foregroundMs: 5432, hold: true});
  const expected = M.ability(catalog, yaoyao, 'skill');
  const alternate = M.roleClip(p, catalog, e, yaoyao);
  assert.equal(alternate.lockOverrideMs, null);
  assert.equal(alternate.castInputMs, null);
  assert.equal(alternate.hold, false);
  assert.equal(alternate.cooldownMs, expected.cooldownMs);
  assert.equal(alternate.effectMs, expected.effectMs);
  assert.equal(alternate.castTiming?.lockMs ?? null, M.timingFor(yaoyao, 'skill')?.lockMs ?? null);
});

test('edits to one branch survive switch, persistence and reimport without leaking to the other branch', () => {
  const p = fixture(), source = M.clone(p.clips[0]);
  M.switchRoleCharacter(p, catalog, bennett, yaoyao);
  M.editClip(p, p.clips[0].id, {hold: true, lockOverrideMs: 1234, foregroundMs: 1234});
  M.editClip(p, p.clips[1].id, {foregroundMs: 731});
  M.switchRoleCharacter(p, catalog, yaoyao, bennett);
  assert.equal(p.clips[0].lockOverrideMs, source.lockOverrideMs);
  assert.equal(p.clips[0].hold, source.hold);
  const reopened = M.normalizeProject(JSON.parse(JSON.stringify(p)), catalog);
  M.switchRoleCharacter(reopened, catalog, bennett, yaoyao);
  assert.equal(reopened.clips[0].lockOverrideMs, 1234);
  assert.equal(reopened.clips[0].hold, true);
  assert.equal(reopened.clips[1].foregroundMs, 731);
});

test('branch changes preserve later role action spacing and explicit idle gaps', () => {
  const p = fixture(), before = M.clone(p);
  const later = before.clips.filter(clip => clip.characterId === xingqiu);
  M.switchRoleCharacter(p, catalog, bennett, yaoyao);
  assert.equal(p.clips[1].startMs - M.endOf(p.clips[0]), before.clips[1].startMs - M.endOf(before.clips[0]));
  assert.equal(p.clips[3].startMs - p.clips[2].startMs, later[1].startMs - later[0].startMs);
  assert.deepEqual(M.validate(p, catalog).filter(issue => issue.severity !== 'warning'), []);
});

test('new actions get a fresh character-specific profile in an existing alternative', () => {
  const p = fixture();
  const extra = M.insertAfter(p, catalog, p.clips[1].id, 'burst');
  M.switchRoleCharacter(p, catalog, bennett, yaoyao);
  const clip = p.clips.find(clip => clip.id === extra.id);
  assert.equal(clip.characterId, yaoyao);
  assert.equal(clip.cooldownMs, M.ability(catalog, yaoyao, 'burst').cooldownMs);
});

test('one character cannot occupy two slots or be re-added as a fifth timeline role', () => {
  const p = fixture();
  assert.throws(() => M.addRoleCandidate(p, catalog, xingqiu, yaoyao), /另一个定位/);
  assert.throws(() => M.addClip(p, catalog, yaoyao, 'skill', 9000), /兼容定位/);
  assert.throws(() => M.removeRoleCandidate(p, bennett, bennett), /先切换/);
  M.removeRoleCandidate(p, bennett, yaoyao);
  assert.equal(M.roleSlot(p, bennett).candidates.length, 1);
});

test('removing a timeline role removes its compatibility slot without changing another slot', () => {
  const p = fixture();
  M.removeCharacter(p, bennett);
  assert.equal(p.roleSlots.length, 1);
  assert.equal(p.roleSlots[0].characterId, xingqiu);
  assert.ok(p.clips.every(clip => clip.characterId === xingqiu));
});

test('compatibility is explicit process execution and switching to a legacy clock blocks export', () => {
  const p = fixture();
  p.execution = 'timeline';
  assert.throws(() => M.exportStrategy(p, catalog), /按步骤推进/);
  assert.throws(() => M.addRoleCandidate(p, catalog, bennett, '10000014'), /按步骤推进/);
});

test('the same JSON executes the original pair or the replacement pair exactly once', () => {
  const p = fixture(), strategy = M.exportStrategy(p, catalog);
  assert.equal(strategy.Info.Config.CombatTimeline.compilerVersion, 4);
  for (const [first, second] of [['班尼特', '行秋'], ['瑶瑶', '夜兰']]) {
    const history = replay(strategy, [first, second]);
    for (const clip of p.clips) {
      const executions = history.filter(event => event.logical === clip.name);
      assert.equal(executions.length, 1, `${first}/${second}: ${clip.name}`);
      assert.equal(executions[0].character, clip.characterId === bennett ? first : second);
    }
  }
  assert.equal(new Set(strategy.Actions.map(action => action.Name)).size, strategy.Actions.length);
  assert.equal(new Set(strategy.Actions.map(action => action.Index)).size, strategy.Actions.length);
});

test('candidate priority selects just one present character consistently across all of its actions', () => {
  const p = fixture();
  M.moveRoleCandidate(p, bennett, yaoyao, -1);
  const history = replay(M.exportStrategy(p, catalog), ['班尼特', '瑶瑶', '行秋']);
  assert.equal(history.some(event => event.character === '班尼特'), false);
  assert.equal(history.filter(event => p.clips.slice(0, 2).some(clip => clip.name === event.logical))
    .every(event => event.character === '瑶瑶'), true);
});

test('no flow starts when a required role has no compatible character in the party', () => {
  const strategy = M.exportStrategy(fixture(), catalog);
  assert.deepEqual(replay(strategy, ['班尼特'], {untilMs: 1000}), []);
  assert.deepEqual(replay(strategy, ['行秋'], {untilMs: 1000}), []);
});

test('an unready higher-priority E waits instead of opportunistically running a lower-priority character', () => {
  const p = fixture();
  const history = replay(M.exportStrategy(p, catalog), ['班尼特', '瑶瑶', '行秋'],
    {eReady: (name, timeMs) => name !== '班尼特' || timeMs >= 2300});
  assert.equal(history.find(event => event.logical === p.clips[0].name).startMs, 2300);
  assert.equal(history.some(event => event.character === '瑶瑶'), false);
});

test('alternative priorities cannot bypass role selection or step dependencies', () => {
  const p = fixture();
  p.clips[0].sourceAction = {Index: 30, MorePriorities: [{Priority: -100, Expression: 'true', Extra: 'kept'}]};
  const strategy = M.exportStrategy(p, catalog);
  const history = replay(strategy, ['班尼特', '瑶瑶', '行秋']);
  assert.equal(history.filter(event => event.logical === p.clips[0].name).length, 1);
  assert.equal(history.some(event => event.character === '瑶瑶'), false);
  assert.ok(strategy.Actions.filter(action => action.MorePriorities.length)
    .every(action => action.MorePriorities[0].Extra === 'kept'));
});

test('three loops combine skipped and completed alternative Q records without running both candidates', () => {
  const p = fixture(true), strategy = M.exportStrategy(p, catalog);
  const tail = logical(strategy.Actions.at(-1).Name);
  const history = replay(strategy, ['瑶瑶', '夜兰'], {qReady: () => false,
    stop: events => events.filter(event => event.logical === tail).length === 3});
  assert.equal(history.filter(event => event.logical === p.clips[0].name).length, 3);
  assert.equal(history.filter(event => event.logical === `Skip${p.clips[2].id}`).length, 3);
  assert.equal(history.some(event => event.logical === p.clips[2].name), false);
  assert.equal(history.filter(event => event.logical === p.clips[3].name).length, 3);
});

test('each alternative compiles its own calibrated skill input and leaves unknown locks unknown', () => {
  const p = fixture();
  M.switchRoleCharacter(p, catalog, bennett, yaoyao);
  M.editClip(p, p.clips[0].id, {lockOverrideMs: 1234, foregroundMs: 1234});
  M.switchRoleCharacter(p, catalog, yaoyao, bennett);
  const strategy = M.exportStrategy(p, catalog);
  const cast = strategy.Actions.filter(action => logical(action.Name) === p.clips[0].name);
  assert.match(cast.find(action => action.Character === '瑶瑶').Action, /wait\(1\.234\)/);
  assert.ok(!cast.find(action => action.Character === '班尼特').Action.includes('1.234'));
});

test('switches retain their real one-second cooldown even when alternative actions finish early', () => {
  const p = fixture(true), strategy = M.exportStrategy(p, catalog);
  const history = replay(strategy, ['瑶瑶', '夜兰'], {untilMs: 16000, durationFor: () => 20});
  const switches = history.filter(event => event.logical.startsWith('Switch'));
  assert.ok(switches.length > 3);
  for (let i = 1; i < switches.length; i++) assert.ok(switches[i].startMs - switches[i - 1].completedMs >= 1000);
  assert.equal(history.find(event => event.logical === p.clips[0].name).startMs, 0);
});

test('native export reopens the compatible project and all branch-specific operations', () => {
  const p = fixture();
  M.switchRoleCharacter(p, catalog, bennett, yaoyao);
  M.editClip(p, p.clips[1].id, {foregroundMs: 938});
  M.switchRoleCharacter(p, catalog, yaoyao, bennett);
  const strategy = M.exportStrategy(p, catalog);
  const reopened = M.importStrategy(JSON.parse(JSON.stringify(strategy)), catalog);
  assert.deepEqual(reopened.team, p.team);
  assert.deepEqual(reopened.roleSlots, p.roleSlots);
  assert.deepEqual(M.exportStrategy(reopened, catalog).Actions, strategy.Actions);
  M.switchRoleCharacter(reopened, catalog, bennett, yaoyao);
  assert.equal(reopened.clips[1].foregroundMs, 938);
});

test('fixed-character projects still emit compiler three and keep the old native action layout', () => {
  const p = M.demoProject(catalog);
  assert.equal(M.exportStrategy(p, catalog).Info.Config.CombatTimeline.compilerVersion, 3);
  M.configureRole(p, p.team[0], 'onfield');
  assert.equal(M.exportStrategy(p, catalog).Info.Config.CombatTimeline.compilerVersion, 3);
});

test('malformed stored alternatives cannot carry invalid durations or duplicate role ownership', () => {
  const p = fixture();
  const bad = M.clone(p);
  bad.roleSlots[0].candidates[1].clips[p.clips[0].id] = {abilityId: 'skill', foregroundMs: -200};
  assert.throws(() => M.normalizeProject(bad, catalog), /参数无效/);
  const duplicate = M.clone(p);
  duplicate.roleSlots[1].candidates.push(M.clone(duplicate.roleSlots[0].candidates[1]));
  assert.throws(() => M.normalizeProject(duplicate, catalog), /两个定位/);
});

test('a replacement may use E where the source uses Q and wait for its own readiness', () => {
  const p = fixture();
  M.switchRoleCharacter(p, catalog, xingqiu, yelan);
  const clip = p.clips[2];
  Object.assign(clip, {abilityId: 'skill', readiness: 'skill', notReady: 'wait', ensureCast: true,
    followAttack: false, lockOverrideMs: 300, foregroundMs: 300});
  M.switchRoleCharacter(p, catalog, yelan, xingqiu);
  const strategy = M.exportStrategy(p, catalog);
  const alternate = strategy.Actions.find(action => logical(action.Name) === clip.name && action.Character === '夜兰');
  assert.match(alternate.Action, /^skill,wait\(0\.3\)$/);
  assert.equal(alternate.EnsureCast, true);
  const history = replay(strategy, ['瑶瑶', '夜兰'],
    {eReady: (name, timeMs) => name !== '夜兰' || timeMs >= 7000, qReady: () => false});
  const started = history.find(event => event.logical === clip.name).startMs;
  assert.ok(started >= 7000 && started < 7010);
  assert.equal(history.some(event => event.logical === `Skip${clip.id}`), false);
});

test('keyboard and wait parameters are stored separately in each compatible character', () => {
  const p = fixture();
  M.switchRoleCharacter(p, catalog, bennett, yaoyao);
  Object.assign(p.clips[1], {abilityId: 'walk', foregroundMs: 654,
    operation: {direction: 's'}, commandOverride: null});
  M.switchRoleCharacter(p, catalog, yaoyao, bennett);
  const native = M.exportStrategy(p, catalog);
  const actions = native.Actions.filter(action => logical(action.Name) === p.clips[1].name);
  assert.match(actions.find(action => action.Character === '班尼特').Action, /^attack/);
  assert.equal(actions.find(action => action.Character === '瑶瑶').Action, 'walk(s,0.654)');
});

test('a short detached attack retains the source-specific switch lock with no undefined skip references', () => {
  const p = fixture();
  const e = p.clips[0], attack = p.clips[1];
  Object.assign(e, {lockOverrideMs: 2400, castInputMs: 200, foregroundMs: 200});
  Object.assign(attack, {followSourceId: e.id, startMs: 200, foregroundMs: 100});
  p.clips[2].startMs = 3200;
  p.clips[3].startMs = 6000;
  M.fitLoop(p);
  const strategy = M.exportStrategy(p, catalog);
  assert.ok(strategy.Actions.every(action => !action.Condition.Expression.includes('undefined')));
  const history = replay(strategy, ['班尼特', '行秋'], {durationFor: () => 20});
  const departure = history.find(event => event.logical === `Switch${p.clips[2].id}`);
  const cast = history.find(event => event.logical === e.name);
  assert.ok(departure.startMs - cast.completedMs >= 2200);
});

test('inactive empty tracks do not introduce a new required-party condition', () => {
  const p = fixture();
  p.team.push('10000023');
  const history = replay(M.exportStrategy(p, catalog), ['班尼特', '行秋']);
  assert.equal(history.filter(event => event.logical === p.clips[0].name).length, 1);
});

test('history conditions resolve names without case sensitivity and numeric references across alternatives', () => {
  const p = fixture();
  p.clips[0].name = 'StartE';
  p.clips[0].sourceAction = {Index: 42};
  p.clips[1].condition = 'count(starte)>0 && count(42)>0 && !(since(STARTE)<0)';
  const history = replay(M.exportStrategy(p, catalog), ['瑶瑶', '夜兰']);
  assert.equal(history.filter(event => event.logical === p.clips[1].name).length, 1);
});

test('time-ranged execution counts retain their start and end arguments across alternatives', () => {
  const p = fixture();
  p.clips[0].name = 'StartE';
  p.clips[1].condition = 'count(StartE,0,30)>0 && count(StartE,30,40)=0';
  const value = M.exportStrategy(p, catalog);
  assert.ok(value.Actions.filter(action => logical(action.Name) === p.clips[1].name)
    .every(action => action.Condition.Expression.includes('count(StartERole1C2,0,30)')
      && action.Condition.Expression.includes('count(StartERole1C2,30,40)')));
  const history = replay(value, ['瑶瑶', '夜兰']);
  assert.equal(history.filter(event => event.logical === p.clips[1].name).length, 1);
});

test('computed or missing history indices are reported instead of referring to unrelated expanded actions', () => {
  const p = fixture();
  p.clips[1].condition = 'count(1+1)>0';
  assert.throws(() => M.exportStrategy(p, catalog), /动作名称或固定索引/);
  p.clips[1].condition = 'since(500)>0';
  assert.throws(() => M.exportStrategy(p, catalog), /找不到动作索引 500/);
});
