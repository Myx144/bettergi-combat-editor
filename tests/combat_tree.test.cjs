'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const M = require('../model.js'), R = require('../conditions.js'), catalog = require('../catalog.js');
const T = require('../tree-model.js')(M, R);
const action = (Name, Index, Expression = 'count() < 1', extras = []) => ({Name, Index,
  Character: '班尼特', Action: 'wait(0.1)', Condition: {Expression, FutureCondition: 'kept'},
  EnsureCast: false, MorePriorities: extras, Extension: {name: Name}});
const input = (actions = [action('A', 0), action('B', 1), action('C', 2)]) =>
  ({Info: {Name: 'Tree test', Author: '', PreActions: [], Config: {Other: 1}}, Actions: actions, FutureRoot: true});
const project = value => M.importStrategy(value || input(), catalog);
const output = p => M.exportStrategy(p, catalog, {embedProject: false});
const main = (p, name) => T.entries(p).find(row => row.name === name && row.primary).id;

test('opening tree branches keeps unknown native data, ties and declaration order byte-for-byte', () => {
  const value = input([action('B', 0, '', [{Priority: 0, Expression: 'true', Future: [1]}]), action('A', 0)]);
  const p = project(value), before = JSON.stringify(p);
  const queue = T.entries(p);
  queue.forEach(row => T.tree(p, row.id));
  assert.deepEqual(queue.map(row => row.name), ['B', 'B', 'A']);
  assert.equal(JSON.stringify(p), before);
  assert.deepEqual(output(p), value);
});

test('primary branch reordering leaves native Index, Name, implicit and numeric references intact', () => {
  const value = input([action('A', 7, 'count(7) < 2'), action('B', 7, 'count() < 1'),
    action('C', 9, 'count(7) > 0 && !(since(7) < 1)')]);
  const p = project(value);
  T.reorder(p, main(p, 'C'), main(p, 'A'));
  assert.deepEqual(T.entries(p).map(row => row.name), ['C', 'A', 'B']);
  const native = output(p);
  assert.deepEqual(native.Actions.map(row => [row.Name, row.Index]), value.Actions.map(row => [row.Name, row.Index]));
  assert.equal(native.Actions[0].Condition.Expression, value.Actions[0].Condition.Expression);
  assert.equal(native.Actions[2].Condition.Expression, 'false');
  assert.equal(native.Actions[2].MorePriorities.at(-1).Expression, value.Actions[2].Condition.Expression);
  assert.deepEqual(native.Actions[2].Extension, value.Actions[2].Extension);
  assert.equal(native.Actions[2].Condition.FutureCondition, 'kept');
  const queue = R.expand(native).filter(row => row.expression !== 'false');
  assert.deepEqual(queue.map(row => row.name), ['C', 'A', 'B']);
  assert.equal(queue[0].index, 9);
});

test('successive branch reorders do not add duplicate primary carriers', () => {
  const p = project();
  const a = main(p, 'A'), b = main(p, 'B'), c = main(p, 'C');
  T.reorder(p, c, a);
  const count = M.prioritiesOf(p.clips.find(row => row.name === 'C')).length;
  T.reorder(p, c, b, true);
  T.reorder(p, c, a);
  assert.equal(M.prioritiesOf(p.clips.find(row => row.name === 'C')).length, count);
  assert.deepEqual(T.entries(p).map(row => row.name), ['C', 'A', 'B']);
});

test('dense tied priorities rebalance native trigger positions without renumbering histories', () => {
  const p = project(input([action('A', 0), action('B', 0), action('C', 0)]));
  T.reorder(p, main(p, 'C'), main(p, 'B'));
  assert.deepEqual(T.entries(p).map(row => row.name), ['A', 'C', 'B']);
  assert.deepEqual(output(p).Actions.map(row => row.Index), [0, 0, 0]);
  assert.deepEqual(R.expand(output(p)).filter(row => row.expression !== 'false').map(row => row.name), ['A', 'C', 'B']);
});

test('moved primary expressions remain editable and restore from embedded project metadata', () => {
  const p = project();
  T.reorder(p, main(p, 'C'), main(p, 'A'));
  T.setExpression(p, main(p, 'C'), 'count(9) = 0 || q-ready()');
  const native = M.exportStrategy(p, catalog), reopened = M.importStrategy(native, catalog);
  assert.deepEqual(T.entries(reopened), T.entries(p));
  assert.deepEqual(output(reopened), output(p));
  assert.equal(reopened.clips.find(row => row.name === 'C').condition, 'false');
});

test('the old 0.5 core can import and export a reordered native document', () => {
  const {execFileSync} = require('node:child_process');
  const context = vm.createContext({});
  for (const file of ['vendor/jsep.iife.min.js','cast-timings.js','operations.js','strategy-formats.js',
    'roles.js','conditions.js','teams.js','multiplayer.js','model.js','catalog.js']) {
    const text = execFileSync('git', ['show', `v0.5.0:${file}`], {cwd: path.join(__dirname, '..'), encoding: 'utf8'});
    vm.runInContext(text, context, {filename: file});
  }
  const p = project();
  T.reorder(p, main(p, 'C'), main(p, 'B'));
  const native = M.exportStrategy(p, catalog);
  context.value = JSON.parse(JSON.stringify(native));
  const oldOutput = vm.runInContext('CombatTimeline.exportStrategy(CombatTimeline.importStrategy(value, CombatCatalog), CombatCatalog, {embedProject:false})', context);
  assert.deepEqual(JSON.parse(JSON.stringify(oldOutput)), output(p));
});

test('additional trigger edits share the same action and keep extra unknown fields', () => {
  const p = project(input([action('A', 3, 'e-ready()', [{Priority:-1,Expression:'low-hp()',Unknown:42}])]));
  const primary = main(p, 'A'), extra = T.addTrigger(p, primary);
  assert.equal(p.clips.length, 1);
  T.setExpression(p, extra, 'q-ready()');
  assert.equal(T.find(p, primary).entry.expression, 'e-ready()');
  assert.equal(T.find(p, extra).entry.expression, 'q-ready()');
  assert.equal(M.prioritiesOf(p.clips[0])[0].Unknown, 42);
  T.removeTrigger(p, extra);
  assert.equal(T.entries(p).length, 2);
});

test('removing an earlier extra keeps the moved-primary carrier bound to the original action', () => {
  const p = project(input([action('A', 0), action('B', 2, 'e-ready()', [{Priority:1, Expression:'low-hp()'}])]));
  T.reorder(p, main(p, 'B'), main(p, 'A'));
  const extra = T.entries(p).find(row => row.name === 'B' && !row.primary);
  T.removeTrigger(p, extra.id);
  assert.equal(T.carrier(p.clips.find(row => row.name === 'B')).extraIndex, 0);
  assert.equal(T.find(p, main(p, 'B')).entry.expression, 'e-ready()');
});

test('a stale display marker never overrides an independently edited native expression', () => {
  const p = project();
  T.reorder(p, main(p, 'C'), main(p, 'A'));
  const clip = p.clips.find(row => row.name === 'C');
  clip.condition = 'low-hp()';
  assert.equal(T.carrier(clip), null);
  assert.equal(T.entries(p).find(row => row.id === `${clip.id}/primary`).expression, 'low-hp()');
});

test('AND, OR, negation and raw conditions edit in place without losing sibling groups', () => {
  const p = project(input([action('A', 0, 'e-ready() && (count() = 0 || !(since() < 16))')]));
  const id = main(p, 'A'), decoded = T.tree(p, id);
  assert.equal(decoded.children[1].mode, 'any');
  T.editNode(p, id, [1,1], {params:{value:18}});
  assert.equal(T.tree(p, id).children[1].children[1].params.value, 18);
  assert.equal(T.tree(p, id).children[0].kind, 'e-ready');
  T.addNode(p, id, [1], 'low-hp', {catalog});
  assert.equal(T.tree(p, id).children[1].children[2].kind, 'low-hp');
  T.removeNode(p, id, [1,0]);
  assert.equal(T.tree(p, id).children[1].children.length, 2);
  T.editNode(p, id, [1], {negated:true});
  assert.match(T.find(p,id).entry.expression, /!\(/);
});

function multiplayer() {
  const value = input([
    {...action('A', 0), Player:'host'}, {...action('B', 1), Player:'host'},
    {...action('A', 0), Player:'guest'}, {...action('B', 1), Player:'guest'},
    {...action('Shared', 20), Player:'', Character:''}
  ]);
  value.Multiplayer = {Version:1, Players:[
    {Id:'host',IsHost:true,Characters:['班尼特','香菱']},
    {Id:'guest',IsHost:false,Characters:['班尼特','行秋']}
  ]};
  return project(value);
}

test('tree queues bind the player before expanding common and private triggers', () => {
  const p = multiplayer();
  assert.equal(T.entries(p,{playerId:'host'}).length,3);
  assert.equal(T.entries(p,{playerId:'guest'}).length,3);
  assert.equal(T.entries(p,{playerId:''}).length,1);
});

test('private tree reorders retain remote records, common triggers and duplicate per-player names', () => {
  const p = multiplayer(), scope={playerId:'host'};
  const before = output(p), queue = T.entries(p,scope);
  T.reorder(p,queue[1].id,queue[0].id,false,scope);
  const result = output(p);
  assert.deepEqual(result.Actions.filter(row=>row.Player!=='host'),before.Actions.filter(row=>row.Player!=='host'));
  assert.deepEqual(result.Multiplayer,before.Multiplayer);
  assert.deepEqual(T.entries(p,scope).map(row=>row.name),['B','A','Shared']);
  assert.deepEqual(result.Actions.filter(row=>row.Player==='host').map(row=>row.Index),[0,1]);
});

test('private queues cannot silently move a common branch', () => {
  const p=multiplayer(), scope={playerId:'host'}, rows=T.entries(p,scope), before=JSON.stringify(p);
  assert.throws(()=>T.reorder(p,rows[2].id,rows[0].id,false,scope),/各端通用/);
  assert.equal(JSON.stringify(p),before);
});

test('native priority boundaries and unavailable shared gaps fail atomically', () => {
  const p=multiplayer(), scope={playerId:'host'};
  const common=p.clips.find(row=>!row.playerId);
  common.priority=-2147483648;
  common.declarationOrder=-1;
  const before=JSON.stringify(p), rows=T.entries(p,scope);
  assert.throws(()=>T.reorder(p,rows[2].id,rows[0].id,false,scope),/32 位/);
  assert.equal(JSON.stringify(p),before);
});

test('tree example is ordinary valid JSON and unsupported TXT/process projects remain unchanged', () => {
  const p=T.demo(catalog);
  assert.equal(T.supported(p),true);
  assert.equal(T.entries(p).length,6);
  assert.deepEqual(M.validate(p,catalog).filter(row=>row.severity!=='warning'),[]);
  const process=M.emptyProject(), before=JSON.stringify(process);
  assert.deepEqual(T.entries(process),[]);
  assert.equal(JSON.stringify(process),before);
  p.strategyFormat='txt';
  assert.equal(T.supported(p),false);
  assert.throws(()=>T.addTrigger(p,'bad'),/仅用于/);
});
