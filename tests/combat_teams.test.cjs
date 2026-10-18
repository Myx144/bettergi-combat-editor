'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../model.js');
const R = require('../conditions.js');
const catalog = require('../catalog.js');
const T = require('../teams.js')(M, R);

const raiden = '10000052', xingqiu = '10000025', bennett = '10000032', xiangling = '10000023';
const yaoyao = '10000077', yelan = '10000060', zhongli = '10000030', ganyu = '10000037';
const rosterA = [raiden, xingqiu, bennett, xiangling];
const rosterB = [raiden, xingqiu, zhongli, ganyu];
const namesFor = roster => roster.map(id => M.character(catalog, id).name);
const source = (actions, extras = {}) => ({Info: {Name: 'Native', Author: 'Author',
  Config: {Shared: {enabled: true}}, PreActions: []}, Actions: actions, ...extras});
const action = (name, index, expression = 'count() = 0', extras = {}) => ({
  Name: name, Index: index, Character: '雷电将军', Action: 'wait(0.1)',
  Condition: {Expression: expression}, MorePriorities: [], EnsureCast: false, Trace: name || 'Unnamed', ...extras
});
const child = (actions = [action('Start', 0)], extras = {}) => M.importStrategy(source(actions, extras), catalog);

function workspace(first = child()) {
  const p = first;
  T.enableTeams(p);
  T.setTeamRoster(p, p.activeTeamId, rosterA, catalog);
  p.name = 'Collection';
  p.author = 'Global author';
  return p;
}

function second(p, incoming = child([action('Other', 0)]), roster = rosterB, options = {}) {
  const plan = T.addTeam(p, catalog, {name: 'Other team', project: incoming, ...options});
  T.setTeamRoster(p, plan.id, roster, catalog);
  return plan;
}

// This evaluator follows the native event contract, including implicit
// (Index, Name) identity, explicit name/index groups and independent triggers.
function replay(strategy, roster, {events = 30, until = 20} = {}) {
  const party = new Set(namesFor(roster).map(name => name.toLowerCase()));
  const history = [], trace = [], declared = new Set(strategy.Actions.map(a => a.Name.toLowerCase()));
  const queue = strategy.Actions.filter(a => !a.Character || party.has(a.Character.toLowerCase()))
    .flatMap(a => [{action: a, priority: a.Index, expression: a.Condition.Expression},
      ...a.MorePriorities.map(entry => ({action: a, priority: entry.Priority, expression: entry.Expression}))])
    .sort((a, b) => a.priority - b.priority);
  let now = 0;
  const number = value => typeof value === 'boolean' ? Number(value) : value;
  const bool = value => typeof value === 'boolean' ? value : number(value) > 0;
  function evaluate(expression, current) {
    const match = (event, target) => (target.index === undefined || event.index === target.index)
      && (target.name === undefined || event.name.toLowerCase() === target.name.toLowerCase());
    const resolve = node => {
      if (!node) return {index: current.Index, name: current.Name};
      if (node.type === 'identifier') {
        if (!declared.has(node.name.toLowerCase())) throw new Error('Unknown action');
        return {name: node.name};
      }
      return {index: Math.trunc(number(value(node)))};
    };
    function value(node) {
      if (node.type === 'number' || node.type === 'bool') return node.value;
      if (node.type === 'unary') return node.operator === '!' ? !bool(value(node.value)) : -number(value(node.value));
      if (node.type === 'binary') {
        const left = value(node.left);
        if (node.operator === '&&') return bool(left) && bool(value(node.right));
        if (node.operator === '||') return bool(left) || bool(value(node.right));
        const right = value(node.right), a = number(left), b = number(right);
        switch (node.operator) {
          case '>': return a > b;
          case '<': return a < b;
          case '=': return Math.abs(a - b) < 0.0001;
          case '+': return a + b;
          case '-': return a - b;
          case '*': return a * b;
          case '/': return b === 0 ? 0 : a / b;
          default: throw new Error('Unknown operator');
        }
      }
      const args = node.args || [], method = node.name.toLowerCase();
      if (method === 'in-party') return args[0]?.type === 'identifier' && party.has(args[0].name.toLowerCase());
      if (['e-ready', 'q-ready'].includes(method)) return true;
      if (['e-cd', 'last-check'].includes(method)) return 0;
      if (method === 'onfield') return !!current.Character;
      if (method === 'low-hp') return false;
      if (method === 't') return now;
      if (method === 'min') return args.length ? Math.min(...args.map(arg => number(value(arg)))) : 0;
      if (method === 'max') return args.length ? Math.max(...args.map(arg => number(value(arg)))) : 0;
      if (['since', 'count', 'last-exec'].includes(method)) {
        const target = resolve(method === 'last-exec' ? args[2] : args[0]);
        const records = history.filter(event => match(event, target));
        if (method === 'count') {
          const start = args[1] ? number(value(args[1])) : 0;
          const end = args[2] ? number(value(args[2])) : now;
          return records.filter(event => event.time >= start && event.time <= end).length;
        }
        const elapsed = records.length ? now - records.at(-1).time : Infinity;
        if (method === 'since') return elapsed;
        if (!args.length) return false;
        const greater = args[1]?.type === 'bool' ? args[1].value : true;
        return !records.length ? greater : greater ? elapsed > number(value(args[0])) : elapsed < number(value(args[0]));
      }
      throw new Error(`Unknown function ${method}`);
    }
    try { return bool(value(R.parse(expression, [...declared]))); }
    catch { return false; }
  }
  while (now < until && history.length < events) {
    const selected = queue.find(entry => evaluate(entry.expression, entry.action));
    if (!selected) { now += 0.1; continue; }
    now += 0.25;
    const current = selected.action;
    history.push({index: current.Index, name: current.Name, time: now});
    trace.push(current.Trace || current.Action);
  }
  return {trace, history};
}

test('legacy projects remain untouched until teams are enabled', () => {
  const p = child(), before = M.clone(p);
  assert.equal(T.hasTeams(p), false);
  assert.deepEqual(T.teamEntries(p), []);
  T.normalizeTeams(p, catalog);
  assert.deepEqual(p, before);
  T.enableTeams(p);
  assert.equal(p.name, before.name);
  assert.deepEqual(p.clips, before.clips);
  assert.equal(T.activeTeam(p).id, 'team1');
  assert.equal(T.activeTeam(p).project.teamPlans, undefined);
});

test('fresh active entries and synchronization preserve edits made after the descriptor snapshot', () => {
  const p = workspace(), old = T.activeTeam(p).project.clips[0].commandOverride;
  p.clips[0].commandOverride = 'wait(0.7)';
  assert.equal(T.activeTeam(p).project.clips[0].commandOverride, old);
  assert.equal(T.teamEntries(p)[0].project.clips[0].commandOverride, 'wait(0.7)');
  assert.equal(T.exportTeams(p, catalog).Actions[0].Action, 'wait(0.7)');
  assert.equal(T.activeTeam(p).project.clips[0].commandOverride, 'wait(0.7)');
});

test('switching plans keeps global name and author while saving independent native drafts', () => {
  const p = workspace(), firstId = p.activeTeamId;
  const plan = second(p);
  p.clips[0].commandOverride = 'wait(0.8)';
  T.switchTeam(p, plan.id);
  assert.equal(p.name, 'Collection');
  assert.equal(p.author, 'Global author');
  assert.equal(p.clips[0].name, 'Other');
  p.clips[0].commandOverride = 'wait(0.9)';
  T.switchTeam(p, firstId);
  assert.equal(p.clips[0].commandOverride, 'wait(0.8)');
  T.switchTeam(p, plan.id);
  assert.equal(p.clips[0].commandOverride, 'wait(0.9)');
});

test('duplicates start disabled and have independent snapshots and monotonic identifiers', () => {
  const p = workspace(), copy = T.addTeam(p, catalog, {duplicate: true});
  assert.equal(copy.enabled, false);
  assert.deepEqual(copy.roster, rosterA);
  copy.project.clips[0].commandOverride = 'wait(3)';
  assert.notEqual(p.clips[0].commandOverride, 'wait(3)');
  const later = T.addTeam(p, catalog);
  assert.equal(later.id, 'team3');
  assert.equal(later.enabled, false);
  assert.deepEqual(later.project.sourceInfo, p.sourceInfo);
  assert.deepEqual(later.project.preActions, p.preActions);
  T.removeTeam(p, copy.id);
  assert.equal(T.addTeam(p, catalog).id, 'team4');
});

test('removing an active plan selects another draft and never removes the last plan', () => {
  const p = workspace(), plan = second(p), removed = p.activeTeamId;
  T.removeTeam(p, removed);
  assert.equal(p.activeTeamId, plan.id);
  assert.equal(p.clips[0].name, 'Other');
  assert.equal(p.name, 'Collection');
  assert.throws(() => T.removeTeam(p, plan.id), /至少保留/);
});

test('rosters add silent tracks without deleting imported non-roster native actors', () => {
  const p = workspace(child([action('Foreign', 0, 'count()=0', {Character: '钟离'})]));
  assert.ok(p.team.includes(zhongli));
  assert.ok(rosterA.every(id => p.team.includes(id)));
  const strategy = T.exportTeams(p, catalog);
  assert.equal(strategy.Actions[0].Character, '钟离');
  assert.deepEqual(T.teamPreview(p, catalog), []);
  assert.throws(() => T.setTeamRoster(p, p.activeTeamId, [raiden, raiden], catalog), /不能重复/);
});

test('changing a roster removes obsolete silent tracks while keeping actual actor drafts', () => {
  const p = workspace();
  T.setTeamRoster(p, p.activeTeamId, rosterB, catalog);
  assert.deepEqual(p.team, rosterB);
  assert.deepEqual(T.activeTeam(p).roster, rosterB);
  assert.equal(p.clips[0].characterId, raiden);
  T.setTeamRoster(p, p.activeTeamId, [xingqiu, bennett, xiangling, zhongli], catalog);
  assert.ok(p.team.includes(raiden));
  assert.ok(p.clips.some(clip => clip.characterId === raiden));
});

test('serialized plans normalize without recursive collections and the active top-level draft wins', () => {
  const p = workspace(), plan = second(p);
  T.switchTeam(p, plan.id);
  p.clips[0].commandOverride = 'wait(0.6)';
  const reopened = M.clone(p);
  T.normalizeTeams(reopened, catalog);
  assert.equal(T.activeTeam(reopened).project.clips[0].commandOverride, 'wait(0.6)');
  assert.ok(reopened.teamPlans.every(entry => !entry.project.teamPlans && !entry.project.activeTeamId));
  const invalid = M.clone(reopened);
  invalid.teamPlans[1].id = invalid.teamPlans[0].id;
  assert.throws(() => T.normalizeTeams(invalid, catalog), /标识/);
});

test('enabled JSON plans require four explicit roster members while disabled drafts remain storable', () => {
  const p = workspace();
  T.setTeamRoster(p, p.activeTeamId, rosterA.slice(0, 3), catalog);
  assert.equal(T.teamGuard(T.teamEntries(p)[0], catalog), 'false');
  assert.ok(T.validateTeams(p, catalog).some(issue => issue.code === 'teams-roster'));
  assert.throws(() => T.exportTeams(p, catalog), /4 名/);
  T.setTeamRoster(p, p.activeTeamId, rosterA, catalog);
  const blank = T.addTeam(p, catalog);
  blank.enabled = false;
  assert.doesNotThrow(() => T.exportTeams(p, catalog));
  assert.equal(T.exportTeams(p, catalog).Info.Config.CombatTimeline.project.teamPlans.length, 2);
});

test('the complete roster guard isolates teams sharing three characters and gates every extra trigger', () => {
  const a = child([action('Shared', 11, 'false', {Trace: 'A', MorePriorities: [{Priority: -7, Expression: 'count()=0'}]})]);
  const p = workspace(a), bRoster = [raiden, xingqiu, bennett, zhongli];
  second(p, child([action('Shared', 11, 'false', {Trace: 'B', MorePriorities: [{Priority: -9, Expression: 'count()=0'}]})]), bRoster);
  const strategy = T.exportTeams(p, catalog);
  assert.deepEqual(replay(strategy, rosterA).trace, ['A']);
  assert.deepEqual(replay(strategy, bRoster).trace, ['B']);
  assert.deepEqual(replay(strategy, rosterB).trace, []);
  assert.ok(strategy.Actions.every(a => a.Condition.Expression.includes('in-party(')
    && a.MorePriorities.every(entry => entry.Expression.includes('in-party('))));
});

test('identical rosters in a different order require selecting a single enabled plan', () => {
  const p = workspace(), plan = second(p, child(), [...rosterA].reverse());
  assert.ok(T.validateTeams(p, catalog).some(issue => issue.code === 'teams-overlap'
    && issue.teamIds.includes(plan.id)));
  assert.throws(() => T.exportTeams(p, catalog), /只启用其中一个/);
  plan.enabled = false;
  assert.doesNotThrow(() => T.exportTeams(p, catalog));
});

test('native priorities, stable declaration ties, extra triggers and unknown fields survive compilation', () => {
  const original = source([
    action('First', 50, 'false', {Trace: 'extra', Extra: {nested: ['keep']},
      Condition: {Expression: 'false', ConditionExtra: 3},
      MorePriorities: [{Priority: -40, Expression: 'count()=0', PriorityExtra: {keep: 1}}]}),
    action('Second', -40, 'count()=0', {Trace: 'main'})
  ], {RootExtra: {keep: ['a', 'b']}});
  const p = workspace(M.importStrategy(original, catalog)), strategy = T.exportTeams(p, catalog);
  assert.deepEqual(strategy.Actions.map(a => a.Index), [50, -40]);
  assert.equal(strategy.Actions[0].MorePriorities[0].Priority, -40);
  assert.deepEqual(strategy.Actions[0].Extra, {nested: ['keep']});
  assert.equal(strategy.Actions[0].Condition.ConditionExtra, 3);
  assert.deepEqual(strategy.Actions[0].MorePriorities[0].PriorityExtra, {keep: 1});
  assert.deepEqual(strategy.RootExtra, original.RootExtra);
  assert.deepEqual(replay(strategy, rosterA).trace, replay(original, rosterA).trace);
  assert.deepEqual(replay(strategy, rosterA).trace, ['extra', 'main']);
});

test('equal Index and Name pairs share implicit self history while same-name different indices do not', () => {
  const original = source([
    action('Pair', 10, 'count()=0', {Trace: 'first'}),
    action('PAIR', 10, 'count()=0', {Trace: 'same-pair'}),
    action('Pair', 20, 'count()=0', {Trace: 'different-index'})
  ]);
  const strategy = T.exportTeams(workspace(M.importStrategy(original, catalog)), catalog);
  assert.equal(strategy.Actions[0].Name, strategy.Actions[1].Name);
  assert.notEqual(strategy.Actions[0].Name, strategy.Actions[2].Name);
  assert.deepEqual(replay(strategy, rosterA).trace, ['first', 'different-index']);
  assert.deepEqual(replay(strategy, rosterA).trace, replay(original, rosterA).trace);
});

test('named history includes all same-name indices while numeric history includes every name at that index', () => {
  const original = source([
    action('Group', 1, 'count()=0', {Trace: 'one'}),
    action('Other', 1, 'count()=0', {Trace: 'two'}),
    action('Group', 2, 'count()=0', {Trace: 'three'}),
    action('Done', 3, 'count(Group)=2 && count(1)=2 && count(2)=1 && count()=0', {Trace: 'done'})
  ]);
  const p = workspace(M.importStrategy(original, catalog));
  second(p, child([action('Group', 1), action('Other', 1)]));
  const strategy = T.exportTeams(p, catalog);
  assert.deepEqual(replay(strategy, rosterA).trace, ['one', 'two', 'three', 'done']);
  assert.deepEqual(replay(strategy, rosterA).trace, replay(original, rosterA).trace);
});

test('count range endpoints and nested history references retain native absolute-time meaning', () => {
  const original = source([
    action('Range', 7, 'count()<2', {Trace: 'record'}),
    action('Range', 8, 'count()=0', {Trace: 'other-index'}),
    action('Done', 9, 'count(7,0.25,0.5)=2 && count(Range,max(0,t()-1),t())=3 && count()=0', {Trace: 'done'})
  ]);
  const strategy = T.exportTeams(workspace(M.importStrategy(original, catalog)), catalog);
  assert.deepEqual(replay(strategy, rosterA).trace, ['record', 'record', 'other-index', 'done']);
  assert.deepEqual(replay(strategy, rosterA).trace, replay(original, rosterA).trace);
  assert.match(strategy.Actions.at(-1).Condition.Expression, /0\.25, 0\.5/);
});

test('since uses the most recent matching group event and last-exec preserves both comparisons', () => {
  const original = source([
    action('Start', 7, 'count()=0', {Trace: 'start'}),
    action('Other', 7, 'count()=0', {Trace: 'other'}),
    action('Soon', 9, 'last-exec(1,false,7) && since(7)<1 && count()=0', {Trace: 'soon'}),
    action('Later', 10, 'last-exec(1,true,7) && !(since(7)<1) && count()=0', {Trace: 'later'})
  ]);
  const strategy = T.exportTeams(workspace(M.importStrategy(original, catalog)), catalog);
  assert.deepEqual(replay(strategy, rosterA).trace, ['start', 'other', 'soon', 'later']);
  assert.deepEqual(replay(strategy, rosterA).trace, replay(original, rosterA).trace);
});

test('last-exec honors native literal-boolean semantics even for a parenthesized false', () => {
  const original = source([
    action('Start', 7, 'count()=0', {Trace: 'start'}),
    action('Other', 7, 'count()=0', {Trace: 'other'}),
    action('Soon', 9, 'last-exec(1,(false),7) && count()=0', {Trace: 'soon'}),
    action('Later', 10, 'last-exec(1,!true,7) && count()=0', {Trace: 'later'})
  ]);
  const strategy = T.exportTeams(workspace(M.importStrategy(original, catalog)), catalog);
  assert.deepEqual(replay(strategy, rosterA).trace, replay(original, rosterA).trace);
  assert.deepEqual(replay(strategy, rosterA).trace, ['start', 'other', 'soon', 'later']);
});

test('native case-insensitive boolean literals retain their meaning during namespacing', () => {
  const p = workspace(child([
    action('Start', 7),
    action('Other', 7),
    action('Soon', 9, 'last-exec(1,FALSE,7) && TRUE && count()=0')
  ]));
  const strategy = T.exportTeams(p, catalog);
  assert.match(strategy.Actions[2].Condition.Expression, /last-exec\(1, false,/);
  assert.match(strategy.Actions[2].Condition.Expression, /\|\|/);
  assert.deepEqual(replay(strategy, rosterA).trace, ['Start', 'Other', 'Soon']);
});

test('empty native names preserve implicit pair history and current-character execution', () => {
  const original = source([
    action('', 3, 'count()=0', {Character: '', Trace: 'generic-one'}),
    action('', 3, 'count()=0', {Character: '', Trace: 'same-pair'}),
    action('', 4, 'count()=0', {Character: '', Trace: 'generic-other'})
  ]);
  const p = workspace(M.importStrategy(original, catalog)), strategy = T.exportTeams(p, catalog);
  assert.ok(strategy.Actions.every(a => a.Character === ''));
  assert.equal(strategy.Actions[0].Name, strategy.Actions[1].Name);
  assert.notEqual(strategy.Actions[0].Name, strategy.Actions[2].Name);
  assert.deepEqual(replay(strategy, rosterA).trace, ['generic-one', 'generic-other']);
  assert.deepEqual(replay(strategy, rosterA).trace, replay(original, rosterA).trace);
});

test('missing numeric indices remain never-executed history through one inert declared sentinel', () => {
  const original = source([
    action('Missing', 1, 'count(99)=0 && since(99)>100 && last-exec(2,true,99) && !last-exec(2,false,99) && count()=0')
  ]);
  const strategy = T.exportTeams(workspace(M.importStrategy(original, catalog)), catalog);
  assert.equal(strategy.Actions.length, 2);
  assert.deepEqual(replay(strategy, rosterA).trace, replay(original, rosterA).trace);
  assert.equal(strategy.Actions[1].Condition.Expression.endsWith('&& false'), true);
});

test('constant signed and fractional indices use native integer truncation', () => {
  const original = source([
    action('Negative', -7, 'count()=0'),
    action('Positive', 1, 'count()=0'),
    action('Done', 3, 'count(-7.9)=1 && count(true)=1 && count(1.9)=1 && count()=0')
  ]);
  const strategy = T.exportTeams(workspace(M.importStrategy(original, catalog)), catalog);
  assert.deepEqual(replay(strategy, rosterA).trace, replay(original, rosterA).trace);
  assert.deepEqual(replay(strategy, rosterA).trace, ['Negative', 'Positive', 'Done']);
});

test('computed historical indices and undeclared action references fail explicitly', () => {
  for (const expression of ['count(1+1)>0', 'since(t())>1', 'last-exec(1,true,1+1)', 'count(Misspelled)=0']) {
    const p = workspace(child([action('Start', 1, expression)]));
    const issues = T.validateTeams(p, catalog);
    assert.ok(issues.some(issue => issue.code === 'teams-export' && issue.teamId === p.activeTeamId));
    assert.throws(() => T.exportTeams(p, catalog), /索引|未知动作/);
  }
});

test('hyphenated names and character arguments are parsed contextually rather than text-replaced', () => {
  const original = source([
    action('雷电将军', 3, 'count()=0'),
    action('Start-E-1', 4, 'count()=0'),
    action('Done', 5, 'e-ready(雷电将军) && count(雷电将军)=1 && count(Start-E-1)=1 && count()=0')
  ]);
  const strategy = T.exportTeams(workspace(M.importStrategy(original, catalog)), catalog);
  assert.match(strategy.Actions.at(-1).Condition.Expression, /e-ready\(雷电将军\)/);
  assert.deepEqual(replay(strategy, rosterA).trace, replay(original, rosterA).trace);
});

test('different unconditional preactions are rejected while identical shared preactions execute only once', () => {
  const p = workspace(), plan = second(p);
  p.preActions = ['雷电将军 skill'];
  assert.ok(T.validateTeams(p, catalog).some(issue => issue.code === 'teams-preActions'));
  assert.throws(() => T.exportTeams(p, catalog), /PreActions/);
  plan.project.preActions = [...p.preActions];
  assert.deepEqual(T.exportTeams(p, catalog).Info.PreActions, ['雷电将军 skill']);
});

test('unknown root, Info and Config conflicts are explicit and case-sensitive', () => {
  const p = workspace(), plan = second(p);
  plan.project.sourceRoot.Unknown = {value: 1};
  plan.project.sourceInfo.UnknownInfo = true;
  plan.project.sourceInfo.Config.Shared = {Enabled: true};
  const codes = T.validateTeams(p, catalog).map(issue => issue.code);
  assert.ok(codes.includes('teams-root'));
  assert.ok(codes.includes('teams-info'));
  assert.ok(codes.includes('teams-config'));
  assert.throws(() => T.exportTeams(p, catalog), /不一致/);
});

test('validation without a catalog retains structural checks without inventing lookup errors', () => {
  const p = workspace(), plan = second(p);
  assert.deepEqual(T.validateTeams(p).filter(issue => issue.severity !== 'warning'), []);
  T.setTeamRoster(p, plan.id, [...rosterA], catalog);
  assert.ok(T.validateTeams(p).some(issue => issue.code === 'teams-overlap'));
  plan.project.preActions = ['雷电将军 skill'];
  assert.ok(T.validateTeams(p).some(issue => issue.code === 'teams-preActions'));
  assert.ok(T.validateTeams(p).every(issue => !/undefined|characters/.test(issue.message)));
});

test('applying shared settings is an explicit metadata choice that preserves each native action draft', () => {
  const p = workspace(), plan = second(p), firstAction = M.clone(p.clips[0]);
  plan.project.preActions = ['雷电将军 skill'];
  plan.project.sourceRoot.ChosenRoot = {keep: [1, 2]};
  plan.project.sourceInfo.ChosenInfo = {keep: true};
  plan.project.sourceInfo.Config = {Chosen: {value: 9}};
  const otherAction = M.clone(plan.project.clips[0]);
  T.applySharedSettings(p, plan.id);
  assert.deepEqual(p.clips[0], firstAction);
  assert.deepEqual(plan.project.clips[0], otherAction);
  assert.equal(p.name, 'Collection');
  assert.equal(p.author, 'Global author');
  const strategy = T.exportTeams(p, catalog);
  assert.deepEqual(strategy.Info.PreActions, ['雷电将军 skill']);
  assert.deepEqual(strategy.ChosenRoot, {keep: [1, 2]});
  assert.deepEqual(strategy.Info.ChosenInfo, {keep: true});
  assert.deepEqual(strategy.Info.Config.Chosen, {value: 9});
});

function compatibleProject() {
  const p = M.emptyProject();
  p.repeat = false;
  const clip = M.addClip(p, catalog, bennett, 'wait', 0);
  clip.name = 'RoleStart';
  clip.foregroundMs = 100;
  p.durationMs = 1000;
  M.configureRole(p, bennett, 'healer');
  M.addRoleCandidate(p, catalog, bennett, yaoyao);
  return p;
}

function fixedSequence(execution = 'process') {
  const p = M.emptyProject();
  Object.assign(p, {repeat: false, durationMs: 5000, execution});
  rosterA.forEach((id, index) => {
    const clip = M.addClip(p, catalog, id, 'wait', index * 1200);
    clip.name = `Step${index + 1}`;
    clip.foregroundMs = 100;
    clip.commandOverride = `wait(0.${index + 1})`;
    clip.sourceAction = {Index: (index + 1) * 10, Trace: `actor${index + 1}`, Preserved: {index}};
  });
  return p;
}

test('process exports scope retained actor pools to the explicit roster without inventing replacement actions', () => {
  const p = workspace(fixedSequence()), originalClips = M.clone(p.clips);
  const replacement = [raiden, xingqiu, bennett, zhongli];
  T.setTeamRoster(p, p.activeTeamId, replacement, catalog);
  assert.equal(p.team.length, 5);
  const selected = T.scopedProject(T.teamEntries(p)[0], catalog);
  assert.deepEqual(selected.team, replacement);
  assert.deepEqual(selected.clips, originalClips.slice(0, 3));
  assert.deepEqual(T.validateTeams(p, catalog).filter(issue => issue.severity !== 'warning'), []);
  assert.deepEqual(T.validateTeams(p).filter(issue => issue.severity !== 'warning'), []);
  const strategy = T.exportTeams(p, catalog);
  assert.ok(strategy.Actions.every(a => !['香菱', '钟离'].includes(a.Character)));
  assert.deepEqual(strategy.Actions.filter(a => a.Trace).map(a => a.Action), ['wait(0.1)', 'wait(0.2)', 'wait(0.3)']);
  assert.deepEqual(replay(strategy, replacement).trace.filter(value => /^actor/.test(value)), ['actor1', 'actor2', 'actor3']);
  assert.deepEqual(p.clips, originalClips);
  assert.equal(strategy.Info.Config.CombatTimeline.project.clips.length, 4);
});

test('a scoped process pool survives native roundtrip and duplication with every retained clip intact', () => {
  const p = workspace(fixedSequence());
  T.setTeamRoster(p, p.activeTeamId, [raiden, xingqiu, bennett, zhongli], catalog);
  const strategy = T.exportTeams(p, catalog), reopened = M.importStrategy(strategy, catalog);
  assert.equal(reopened.team.length, 5);
  assert.deepEqual(reopened.clips, p.clips);
  assert.deepEqual(M.exportStrategy(reopened, catalog).Actions, strategy.Actions);
  const copy = T.addTeam(reopened, catalog, {duplicate: true});
  assert.equal(copy.project.team.length, 5);
  assert.deepEqual(copy.project.clips, p.clips);
  assert.equal(copy.enabled, false);
  T.normalizeTeams(reopened, catalog);
  assert.equal(reopened.teamPlans.find(plan => plan.id === copy.id).project.clips.length, 4);
});

test('timeline exports scope actor pools while retaining the selected clips original absolute positions', () => {
  const p = workspace(fixedSequence('timeline')), positions = p.clips.slice(0, 3).map(clip => clip.startMs);
  const replacement = [raiden, xingqiu, bennett, zhongli];
  T.setTeamRoster(p, p.activeTeamId, replacement, catalog);
  const selected = T.scopedProject(T.teamEntries(p)[0], catalog);
  assert.deepEqual(selected.clips.map(clip => clip.startMs), positions);
  assert.equal(selected.execution, 'timeline');
  const strategy = T.exportTeams(p, catalog);
  assert.ok(strategy.Actions.every(a => a.Character !== '香菱'));
  assert.deepEqual(replay(strategy, replacement).trace.filter(value => /^actor/.test(value)), ['actor1', 'actor2', 'actor3']);
});

test('scoping preserves compatible current owners and filters irrelevant role slots without substituting skill mappings', () => {
  const p = workspace(fixedSequence());
  M.configureRole(p, bennett, 'healer');
  M.addRoleCandidate(p, catalog, bennett, yaoyao);
  M.configureRole(p, xiangling, 'offfield');
  M.addRoleCandidate(p, catalog, xiangling, yelan);
  const replacement = [raiden, xingqiu, yaoyao, zhongli];
  T.setTeamRoster(p, p.activeTeamId, replacement, catalog);
  const selected = T.scopedProject(T.teamEntries(p)[0], catalog);
  assert.deepEqual(selected.team, [raiden, xingqiu, bennett, zhongli]);
  assert.equal(selected.roleSlots.length, 1);
  assert.equal(selected.roleSlots[0].characterId, bennett);
  assert.equal(p.roleSlots.length, 2);
  const strategy = T.exportTeams(p, catalog);
  assert.ok(strategy.Actions.some(a => a.Character === '瑶瑶'));
  assert.ok(strategy.Actions.every(a => !['香菱', '夜兰', '钟离'].includes(a.Character)));
  assert.deepEqual(replay(strategy, replacement).trace.filter(value => /^actor/.test(value)), ['actor1', 'actor2', 'actor3']);
});

test('history references to removed process steps fail clearly instead of rebinding names or indices', () => {
  for (const expression of ['count(Step4)>0', 'since(40)>1', 'last-exec(1,true,Step4)', 'count(40,0,t())=0']) {
    const p = workspace(fixedSequence());
    p.clips[0].condition = expression;
    T.setTeamRoster(p, p.activeTeamId, [raiden, xingqiu, bennett, zhongli], catalog);
    const issues = T.validateTeams(p, catalog);
    assert.ok(issues.some(issue => issue.code === 'teams-reference' && issue.clipIds.includes(p.clips[0].id)));
    assert.throws(() => T.exportTeams(p, catalog), /阵容外动作/);
    assert.throws(() => T.exportTeams(p, catalog, {check: false}), /阵容外动作/);
    assert.equal(p.clips[0].condition, expression);
  }
});

test('a numeric reference is rejected when roster scoping removes only part of its original index group', () => {
  const p = workspace(fixedSequence());
  p.clips[3].priority = p.clips[1].sourceAction.Index;
  p.clips[0].condition = 'count(20)=0';
  T.setTeamRoster(p, p.activeTeamId, [raiden, xingqiu, bennett, zhongli], catalog);
  assert.throws(() => T.exportTeams(p, catalog), /阵容外动作索引 20/);
});

test('a former generated helper index cannot silently rebound to another helper after roster scoping', () => {
  const p = fixedSequence();
  p.clips.forEach((clip, index) => { clip.sourceAction.Index = index; });
  const original = M.exportStrategy(p, catalog, {embedProject: false});
  assert.ok(original.Actions.find(a => a.Index === 4).Name.startsWith('Wait'));
  p.clips[1].condition = 'count(4)>0';
  workspace(p);
  T.setTeamRoster(p, p.activeTeamId, [raiden, xingqiu, bennett, zhongli], catalog);
  assert.throws(() => T.exportTeams(p, catalog), /辅助动作索引.*改用动作名称/);
});

test('case-insensitive native boolean targets cannot conceal a removed numeric step dependency', () => {
  const p = workspace(fixedSequence());
  p.clips[3].sourceAction.Index = 1;
  p.clips[0].condition = 'count(TRUE)=0';
  T.setTeamRoster(p, p.activeTeamId, [raiden, xingqiu, bennett, zhongli], catalog);
  assert.throws(() => T.exportTeams(p, catalog), /阵容外动作索引 1/);
});

test('extra triggers and inactive compatible profiles cannot retain hidden dependencies on removed steps', () => {
  const p = workspace(fixedSequence());
  p.clips[0].morePriorities = [{Priority: -20, Expression: 'count(Step4)>0'}];
  T.setTeamRoster(p, p.activeTeamId, [raiden, xingqiu, bennett, zhongli], catalog);
  assert.throws(() => T.exportTeams(p, catalog), /阵容外动作「Step4」/);
  p.clips[0].morePriorities = [];
  M.configureRole(p, bennett, 'healer');
  M.addRoleCandidate(p, catalog, bennett, yaoyao);
  M.roleSlot(p, bennett).candidates.find(candidate => candidate.characterId === yaoyao)
    .clips[p.clips[2].id] = {condition: 'count(Step4)>0'};
  assert.throws(() => T.exportTeams(p, catalog), /阵容外动作「Step4」/);
});

test('an off-roster generic sequence action requires an explicit owner rather than being silently removed', () => {
  const p = workspace(fixedSequence());
  p.clips[3].useCurrentCharacter = true;
  p.clips[3].sourceAction.Character = '';
  T.setTeamRoster(p, p.activeTeamId, [raiden, xingqiu, bennett, zhongli], catalog);
  assert.throws(() => T.exportTeams(p, catalog), /通用动作.*明确动作归属/);
});

test('original native condition strategies retain every off-roster action and its historical references', () => {
  const p = workspace(child([
    action('Start', 10, 'count(Support)=0'),
    action('Support', 20, 'count()=0', {Character: '香菱'})
  ]));
  T.setTeamRoster(p, p.activeTeamId, [raiden, xingqiu, bennett, zhongli], catalog);
  const selected = T.scopedProject(T.teamEntries(p)[0], catalog);
  assert.deepEqual(selected.clips, p.clips);
  assert.equal(selected.team.length, 5);
  const strategy = T.exportTeams(p, catalog);
  assert.equal(strategy.Actions.length, 2);
  assert.equal(strategy.Actions[1].Character, '香菱');
  assert.doesNotMatch(strategy.Actions[0].Condition.Expression, /count\(Support\)/);
});

test('role compatibility composes with whole-team guards including silent fourth members', () => {
  const p = workspace(compatibleProject()), strategy = T.exportTeams(p, catalog);
  const guard = T.teamGuard(T.teamEntries(p)[0], catalog);
  assert.match(guard, /in-party\(班尼特\) \|\| in-party\(瑶瑶\)/);
  assert.match(guard, /in-party\(香菱\)/);
  assert.ok(strategy.Actions.every(a => a.Condition.Expression.includes(guard)));
  const alternate = [raiden, xingqiu, yaoyao, xiangling];
  assert.ok(replay(strategy, alternate).history.length > 0);
  assert.deepEqual(replay(strategy, [raiden, xingqiu, yaoyao, zhongli]).trace, []);
});

test('overlapping compatibility candidate rosters are detected even when their visible selections differ', () => {
  const p = workspace(compatibleProject());
  const plan = second(p, child(), [raiden, xingqiu, yaoyao, xiangling]);
  T.applySharedSettings(p);
  assert.ok(T.validateTeams(p, catalog).some(issue => issue.code === 'teams-overlap'));
  assert.throws(() => T.exportTeams(p, catalog), /同一套/);
  plan.enabled = false;
  assert.doesNotThrow(() => T.exportTeams(p, catalog));
});

test('shared-character relations include compatible candidates and distinct plan identities', () => {
  const p = workspace(compatibleProject()), plan = second(p, child(), [raiden, xingqiu, yaoyao, zhongli]);
  const relation = T.teamRelations(p).find(entry => entry.characterId === yaoyao);
  assert.deepEqual(relation.teamIds, [p.activeTeamId, plan.id]);
});

test('per-team previews are actual combined actions and label maps keep original display names', () => {
  const p = workspace(), plan = second(p), strategy = T.exportTeams(p, catalog);
  const firstPreview = T.teamPreview(p, catalog, p.activeTeamId);
  const secondPreview = T.teamPreview(p, catalog, plan.id);
  assert.deepEqual(strategy.Actions, [...firstPreview, ...secondPreview]);
  assert.equal(T.teamActionLabels(p, catalog).get(firstPreview[0].Name), 'Start');
  assert.equal(T.teamActionLabels(p, catalog, plan.id).get(secondPreview[0].Name), 'Other');
  assert.equal(firstPreview[0].Index, 0);
  assert.ok(strategy.Actions.every(a => /^[A-Za-z][A-Za-z0-9-]*$/.test(a.Name)));
  plan.enabled = false;
  assert.deepEqual(T.teamPreview(p, catalog, plan.id), secondPreview);
  assert.deepEqual(T.exportTeams(p, catalog).Actions, firstPreview);
});

test('TXT collections retain every draft while TXT exports use only the current plan', () => {
  const a = M.importTextStrategy('雷电将军 skill', catalog), p = workspace(a);
  const plan = second(p, M.importTextStrategy('行秋 burst', catalog));
  T.setTeamRoster(p, p.activeTeamId, [], catalog);
  assert.deepEqual(T.validateTeams(p, catalog), []);
  assert.match(M.exportTextStrategy(p, catalog), /雷电将军/);
  assert.doesNotMatch(M.exportTextStrategy(p, catalog), /行秋/);
  T.switchTeam(p, plan.id);
  assert.match(M.exportTextStrategy(p, catalog), /行秋/);
  assert.equal(p.teamPlans.length, 2);
  assert.throws(() => T.exportTeams(p, catalog), /TXT/);
});

test('enabled TXT drafts cannot be silently skipped from a JSON collection export', () => {
  const p = workspace();
  second(p, M.importTextStrategy('行秋 burst', catalog));
  assert.ok(T.validateTeams(p, catalog).some(issue => issue.code === 'teams-format'));
  assert.throws(() => T.exportTeams(p, catalog), /TXT/);
});

test('embedded collection metadata contains all snapshots and can be omitted for native comparison', () => {
  const p = workspace(), plan = second(p);
  T.switchTeam(p, plan.id);
  const strategy = T.exportTeams(p, catalog), embedded = strategy.Info.Config.CombatTimeline;
  assert.equal(embedded.compilerVersion, 5);
  assert.equal(embedded.project.activeTeamId, plan.id);
  assert.equal(embedded.project.teamPlans.length, 2);
  assert.ok(embedded.project.teamPlans.every(entry => entry.project.teamPlans === undefined));
  const native = T.exportTeams(p, catalog, {embedProject: false});
  assert.equal(native.Info.Config.CombatTimeline, undefined);
  assert.deepEqual(native.Actions, strategy.Actions);
});

test('a collection enforces the native action limit across all enabled plans', () => {
  const p = workspace(), template = M.clone(p.clips[0]);
  p.clips = Array.from({length: 801}, (_, index) => ({...M.clone(template), id: `clip${index + 1}`,
    order: index + 1, declarationOrder: index, name: `Action${index + 1}`, priority: index,
    startMs: index * 100, foregroundMs: 100, effectMs: 0, cooldownMs: 0,
    sourceAction: {...M.clone(template.sourceAction), Name: `Action${index + 1}`, Index: index}}));
  p.durationMs = 100000;
  assert.ok(T.validateTeams(p, catalog).some(issue => issue.code === 'teams-limit'));
  assert.throws(() => T.exportTeams(p, catalog), /800/);
});
