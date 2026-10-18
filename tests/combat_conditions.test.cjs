'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const R = require('../conditions.js');
const M = require('../model.js');
const catalog = require('../catalog.js');

const tree = (expression, names = []) => R.decode(expression, names);
const ast = (expression, names = []) => R.parse(expression, names);

test('native operators use the executor precedence and single equality', () => {
  const parsed = ast('count() = 0 || t() > 2 && e-cd() + 1 * 3 < 4');
  assert.equal(parsed.operator, '||');
  assert.equal(parsed.left.operator, '=');
  assert.equal(parsed.right.operator, '&&');
  assert.equal(parsed.right.right.left.operator, '+');
  assert.equal(parsed.right.right.left.right.operator, '*');
});

test('negation of readiness, low HP and groups is retained', () => {
  for (const expression of ['!low-hp()', '!q-ready()', '!(e-ready() || q-ready())']) {
    const node = tree(expression), encoded = R.encode(node);
    assert.deepEqual(ast(encoded), ast(expression));
    assert.match(R.describe(node), /不满足/);
  }
});

test('native negated comparisons become editable inclusive and unequal tests', () => {
  for (const [expression, operator] of [
    ['!(since() < 15)', '>='], ['!(t() > 5)', '<='], ['!(count() = 0)', '!=']
  ]) {
    const node = tree(expression).children[0];
    assert.equal(node.kind, expression.includes('since') ? 'since' : expression.includes('count') ? 'count' : 't');
    assert.equal(node.params.operator, operator);
    assert.deepEqual(ast(R.encode(node)), ast(expression));
  }
});

test('all and any groups preserve nested logical structure and precedence', () => {
  const expression = '(e-ready() || q-ready()) && !low-hp()';
  const parsed = tree(expression);
  assert.equal(parsed.mode, 'all');
  assert.equal(parsed.children[0].mode, 'any');
  assert.deepEqual(ast(R.encode(parsed)), ast(expression));
});

test('empty all, empty any and negated empty groups have explicit native meanings', () => {
  assert.equal(R.encode(R.group()), '');
  assert.equal(R.encode(R.group('any')), 'false');
  const node = R.group(); node.negated = true;
  assert.equal(R.encode(node), '!(true)');
  assert.equal(R.encode(R.group('any', [R.group()])), '(true)');
});

test('hyphenated native functions and declared Chinese action names are parsed without changing subtraction', () => {
  const expression = 'since(芙芙-e-开场) - 3 > t() - 5 && !q-ready(雷电将军)';
  const names = ['芙芙-e-开场'];
  assert.deepEqual(ast(R.encode(tree(expression, names)), names), ast(expression, names));
  assert.equal(ast('t()-5').operator, '-');
});

test('windowed count and computed expressions remain opaque but semantically intact when combined', () => {
  const names = ['行秋开大'];
  const expression = 'count(行秋开大, max(0, t() - 5), t()) > 0';
  const parsed = tree(expression, names);
  assert.equal(parsed.children[0].type, 'raw');
  parsed.children.push(R.make('e-ready'));
  const combined = ast(R.encode(parsed), names);
  assert.equal(combined.operator, '&&');
  assert.deepEqual(combined.left, ast(expression, names));
});

test('all fourteen documented functions match the actual native set', () => {
  assert.deepEqual(R.functions.map(item => item.name).sort(),
    ['last-exec', 'q-ready', 'e-ready', 'e-cd', 'low-hp', 'battle-time', 'in-party', 'onfield',
      't', 'since', 'count', 'min', 'max', 'last-check'].sort());
  assert.ok(R.functions.every(item => item.detail && item.example && item.signature));
});

test('every draggable condition generates valid native syntax', () => {
  for (const item of R.kinds) {
    const node = R.make(item.name, {character: '班尼特', otherAction: '行秋开大'});
    assert.doesNotThrow(() => ast(R.encode(node), ['行秋开大']), item.name);
  }
});

test('bare character targets are not confused with numeric historical indices', () => {
  assert.equal(tree('q-ready(3)').children[0].type, 'raw');
  assert.equal(tree('e-cd(3) < 1').children[0].type, 'raw');
  assert.equal(tree('since(-10) > 1').children[0].params.target, -10);
});

test('the prerequisite condition compiles to completion-count relation and never invents success checks', () => {
  const node = R.make('after', {otherAction: '行秋开大'});
  assert.equal(R.encode(node), 'count(行秋开大) > count()');
  assert.equal(tree(R.encode(node), ['行秋开大']).children[0].kind, 'after');
  assert.throws(() => R.encode(R.make('after')), /前置动作/);
});

test('opening and applying unedited rules keeps exact expressions and opaque native metadata', () => {
  const original = '  ( Q-READY() ) || !low-hp()  ';
  const extra = {priority: -5, expression: ' q-ready() && t() < 3 ', vendor: {label: 'keep'}};
  const rows = R.draft({condition: original}, 10, [extra]);
  const patch = R.patch(rows);
  assert.equal(patch.condition, original);
  assert.equal(patch.morePriorities[0].Expression, extra.expression);
  assert.deepEqual(patch.morePriorities[0].vendor, extra.vendor);
  assert.equal(extra.priority, -5);
  assert.ok(Object.hasOwn(extra, 'expression'));
});

test('editing one rule does not rewrite the other rule and retains extension fields', () => {
  const rows = R.draft({condition: 'q-ready()'}, 10, [{Priority: -1, Expression: 'low-hp()', extra: 9}]);
  rows[1].tree.children.push(R.make('q-ready')); rows[1].dirty = true;
  const patch = R.patch(rows);
  assert.equal(patch.condition, 'q-ready()');
  assert.match(patch.morePriorities[0].Expression, /low-hp.*&&.*q-ready/);
  assert.equal(patch.morePriorities[0].extra, 9);
});

test('unsupported imports stay byte-for-byte until edited, invalid edited syntax fails clearly', () => {
  const original = 'q-ready() && t() >= 2';
  const rows = R.draft({condition: original}, 0, []);
  assert.equal(R.patch(rows).condition, original);
  rows[0].dirty = true;
  assert.throws(() => R.patch(rows), /原生比较/);
});

test('JS evaluation constructs are not accepted as native expressions', () => {
  for (const expression of ['window.alert(1)', '(()=>1)()', 'count();alert(1)', '[1,2]', '"x"', 'x ? 1 : 2']) {
    assert.throws(() => ast(expression), expression);
  }
});

test('rule priority is a signed native Int32 and unfilled numeric thresholds cannot be applied', () => {
  const rows = R.draft({condition: ''}, -2147483648, []);
  assert.equal(R.patch(rows).priority, -2147483648);
  for (const priority of [2147483648, -2147483649, 0.5, NaN]) {
    rows[0].priority = priority;
    assert.throws(() => R.patch(rows), /32 位整数/);
  }
  rows[0].priority = 0; rows[0].tree.children.push(R.make('since')); rows[0].dirty = true;
  rows[0].tree.children[0].params.value = NaN;
  assert.throws(() => R.patch(rows), /有限数字/);
});

test('dragging a condition across independent triggers marks both changed and keeps their priorities', () => {
  const rows = R.draft({condition: 'e-ready() && !low-hp()'}, 10, [{Priority: -2, Expression: 'q-ready()'}]);
  const sourceId = rows[0].tree.children[1].id;
  assert.equal(R.move(rows, sourceId, rows[1].tree.id), true);
  assert.equal(rows[0].tree.children.length, 1);
  assert.equal(rows[1].tree.children.length, 2);
  const patch = R.patch(rows);
  assert.equal(patch.priority, 10);
  assert.equal(patch.morePriorities[0].Priority, -2);
  assert.match(patch.morePriorities[0].Expression, /q-ready.*!.*low-hp/);
});

test('reordering within a group adjusts insertion offset and nested groups cannot contain themselves', () => {
  const rows = R.draft({condition: 'e-ready() && q-ready() && low-hp()'}, 0, []);
  const children = rows[0].tree.children, first = children[0];
  assert.equal(R.move(rows, first.id, rows[0].tree.id, 3), true);
  assert.equal(children.at(-1), first);
  const nested = R.group('any', [R.group('all', [R.make('e-ready')])]);
  children.push(nested);
  const before = JSON.stringify(rows);
  assert.equal(R.move(rows, nested.id, nested.children[0].id), false);
  assert.equal(JSON.stringify(rows), before);
});

test('the expanded queue sorts primary and extra entries with stable native ties', () => {
  const queue = R.expand({Actions: [
    {Name: '甲', Character: '行秋', Index: 10, Condition: {Expression: 'a'}, MorePriorities: [
      {Priority: -1, Expression: 'b'}, {Priority: 10, Expression: 'c'}]},
    {Name: '乙', Index: 10, Condition: {Expression: 'd'}, MorePriorities: [
      {Priority: 10, Expression: 'e'}]}
  ]});
  assert.deepEqual(queue.map(row => row.expression), ['b', 'a', 'c', 'd', 'e']);
  assert.equal(queue[0].index, 10);
  assert.equal(queue[0].priority, -1);
});

test('party filtering retains generic actions and removes every entry of an absent character', () => {
  const strategy = {Actions: [
    {Name: '缺席', Character: '班尼特', Index: -10, MorePriorities: [{Priority: -20}]},
    {Name: '通用', Character: '', Index: 100},
    {Name: '队内', Character: '行秋', Index: 10}
  ]};
  assert.deepEqual(R.expand(strategy, ['行秋']).map(row => row.name), ['队内', '通用']);
});

test('queue order follows exported declarations, even after timeline positions move', () => {
  const p = M.importStrategy({Info: {Name: '排序示例'}, Actions: [
    {Name: '甲', Character: '行秋', Action: 'attack(0.3)', Index: 1,
      Condition: {Expression: 'e-ready()'}, MorePriorities: [{Priority: 1, Expression: 'q-ready()'}]},
    {Name: '乙', Character: '班尼特', Action: 'attack(0.3)', Index: 1,
      Condition: {Expression: 'low-hp()'}, MorePriorities: []}
  ]}, catalog);
  p.clips[0].startMs = 6000; p.clips[1].startMs = 0;
  p.durationMs = 12000;
  assert.deepEqual(R.expand(M.exportStrategy(p, catalog)).map(row => row.name), ['甲', '甲', '乙']);
});

test('browser and CommonJS condition parsing have identical native output', () => {
  const context = vm.createContext({});
  for (const file of ['vendor/jsep.iife.min.js', 'conditions.js'])
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context, {filename: file});
  const expression = '!(since() < 15) && !low-hp()';
  assert.equal(context.CombatConditions.encode(context.CombatConditions.decode(expression)), R.encode(tree(expression)));
});
