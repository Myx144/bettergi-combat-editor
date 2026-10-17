const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const M = require('../model.js');
const catalog = require('../catalog.js');

const raiden = '10000052', xingqiu = '10000025', bennett = '10000032';

function project(repeat = false) {
  return {...M.emptyProject(), repeat, execution: 'timeline'};
}

function clip(p, id, start, duration = 200, mode = 'skill', options = {}) {
  const result = M.addClip(p, catalog, id, mode, start, false);
  Object.assign(result, {foregroundMs: duration, cooldownMs: 0, effectMs: 0, castTiming: null}, options);
  return result;
}

function codes(p) { return M.validate(p).map(issue => issue.code); }

function recordedDragLayout() {
  const p = project();
  for (const [actor, type, start, duration] of [
    [raiden, 'skill', 0, 600], ['10000150', 'skill', 5300, 1500],
    ['10000039', 'skill', 8300, 250], ['10000039', 'burst', 8600, 900],
    ['10000133', 'charge', 9600, 3800]
  ]) clip(p, actor, start, duration, type);
  p.team = ['10000133', '10000150', raiden, '10000039'];
  p.durationMs = 24400;
  return p;
}

// Execute the emitted native conditions using recorded completion events and
// native priority order. The source uses "=" for equality and bare action names.
function replay(strategy, untilMs, durationFor = () => 100) {
  const history = [];
  const names = Object.fromEntries(strategy.Actions.map(action => [action.Name, action.Name]));
  const actions = [...strategy.Actions].sort((a, b) => a.Index - b.Index);
  let timeMs = 0;
  const count = name => history.filter(event => event.name === name).length;
  const since = name => {
    const last = history.findLast(event => event.name === name);
    return last ? (timeMs - last.completedMs) / 1000 : Infinity;
  };
  const executable = action => {
    const expression = action.Condition.Expression.replace(/(?<![<>=!])=(?!=)/g, '===');
    return vm.runInNewContext(expression, {...names, count, since, t: () => timeMs / 1000});
  };
  while (timeMs < untilMs) {
    const action = actions.find(executable);
    if (!action) { timeMs += 10; continue; }
    const startMs = timeMs;
    timeMs += durationFor(action);
    history.push({name: action.Name, character: action.Character, startMs, completedMs: timeMs,
      switch: action.Name.startsWith('Switch')});
  }
  return history;
}

test('extending stand time never stretches the skill release or its persistent effect', () => {
  const p = project();
  const skill = M.addClip(p, catalog, raiden, 'skill', 0);
  const original = {cast: M.castDurationMs(skill), effect: skill.effectMs, command: M.commandsFor(skill)};
  M.editClip(p, skill.id, {foregroundMs: 5000});
  assert.equal(M.castDurationMs(skill), original.cast);
  assert.equal(M.actionDurationMs(skill), original.cast);
  assert.equal(M.actionEndOf(skill), 600);
  assert.equal(skill.effectMs, original.effect);
  assert.equal(M.commandsFor(skill), original.command);
  assert.equal(M.endOf(skill), 5000);
});

test('stand resizing preserves follow-through attacks and cannot shorten their action span', () => {
  const p = project();
  const skill = M.addClip(p, catalog, raiden, 'burst', 0);
  M.editClip(p, skill.id, {followAttack: true, attackAfterMs: 3000, foregroundMs: 9000});
  assert.equal(M.actionDurationMs(skill), 4850);
  M.editClip(p, skill.id, {foregroundMs: 100});
  assert.equal(skill.foregroundMs, 4850);
  assert.equal(skill.attackAfterMs, 3000);
  assert.equal(M.castDurationMs(skill), 1850);
  assert.equal(M.commandsFor(skill), 'burst,attack(3)');
});

test('continuous same-role skills share one entrance and switching back creates a new entrance', () => {
  const p = project();
  const first = M.addClip(p, catalog, bennett, 'burst', 0, false);
  const second = M.addClip(p, catalog, bennett, 'skill', 2000, false);
  const next = M.addClip(p, catalog, xingqiu, 'burst', 4500, false);
  const returned = M.addClip(p, catalog, bennett, 'attack', 8000, false);
  const runs = M.foregroundRuns(p);
  assert.equal(runs.length, 3);
  assert.deepEqual(runs[0].clips.map(clip => clip.id), [first.id, second.id]);
  assert.equal(runs[0].endMs, next.startMs);
  assert.equal(runs[2].id, returned.id);
});

test('idle gaps include reserved stand time and stop at the next role switch', () => {
  const p = project();
  const skill = M.addClip(p, catalog, raiden, 'skill', 0, false);
  skill.foregroundMs = 3000;
  const attack = M.addClip(p, catalog, raiden, 'attack', 3500, false);
  attack.foregroundMs = 1200;
  M.addClip(p, catalog, xingqiu, 'burst', 7000, false);
  assert.deepEqual(M.idleIntervals(M.foregroundRuns(p)[0]),
    [{startMs: 600, endMs: 3500}, {startMs: 4700, endMs: 7000}]);
  assert.equal(M.stateAt(p, 2500).foregroundId, raiden);
  assert.equal(M.stateAt(p, 7000).foregroundId, xingqiu);
});

test('the shared stay tail shrinks its visible idle gap and ripples from that boundary', () => {
  const p = project();
  const skill = M.addClip(p, catalog, raiden, 'skill', 0, false);
  const next = M.addClip(p, catalog, xingqiu, 'burst', 3000, false);
  const later = M.addClip(p, catalog, bennett, 'burst', 5000, false);
  const fixed = {cast: M.castDurationMs(skill), effect: skill.effectMs, command: M.commandsFor(skill)};
  assert.equal(skill.foregroundMs, 600);
  assert.equal(M.foregroundRuns(p)[0].endMs, 3000);

  M.resizeForegroundRun(p, skill.id, 2500);
  assert.equal(skill.foregroundMs, 2500);
  assert.deepEqual([next.startMs, later.startMs], [2500, 4500]);
  assert.equal(M.foregroundRuns(p)[0].endMs, 2500);
  M.resizeForegroundRun(p, skill.id, 200);
  assert.equal(skill.foregroundMs, 600);
  assert.deepEqual([next.startMs, later.startMs], [600, 2600]);
  assert.equal(M.foregroundRuns(p)[0].endMs, 600);
  M.resizeForegroundRun(p, skill.id, 1000);
  assert.deepEqual([next.startMs, later.startMs], [1000, 3000]);
  assert.equal(M.castDurationMs(skill), fixed.cast);
  assert.equal(skill.effectMs, fixed.effect);
  assert.equal(M.commandsFor(skill), fixed.command);
  assert.deepEqual(M.validate(p), []);
  assert.doesNotThrow(() => M.exportStrategy(p, catalog));
});

test('shrinking a multi-action stay stops at the last release without moving its internal actions', () => {
  const p = project();
  const burst = M.addClip(p, catalog, bennett, 'burst', 0, false);
  const skill = M.addClip(p, catalog, bennett, 'skill', 1500, false);
  const next = M.addClip(p, catalog, xingqiu, 'burst', 4000, false);
  M.resizeForegroundRun(p, burst.id, 2000);
  assert.equal(burst.startMs, 0);
  assert.equal(skill.startMs, 1500);
  assert.equal(next.startMs, 2334);
  assert.equal(M.foregroundRuns(p)[0].endMs, 2334);
  assert.equal(M.castDurationMs(skill), 834);
  assert.deepEqual(M.validate(p), []);
});

test('a stay entered by switching cannot shrink below the next switch cooldown', () => {
  const p = project();
  M.addClip(p, catalog, raiden, 'skill', 0, false);
  const entered = M.addClip(p, catalog, bennett, 'skill', 1000, false);
  const next = M.addClip(p, catalog, xingqiu, 'burst', 3000, false);
  M.resizeForegroundRun(p, entered.id, 1200);
  assert.equal(entered.startMs, 1000);
  assert.equal(next.startMs, 2000);
  assert.equal(entered.foregroundMs, 1000);
  assert.equal(M.castDurationMs(entered), 834);
  assert.deepEqual(M.validate(p), []);
});

test('the shared stay tail preserves configured follow-through attacks when shrinking', () => {
  const p = project();
  const burst = M.addClip(p, catalog, raiden, 'burst', 0, false);
  Object.assign(burst, {followAttack: true, attackAfterMs: 3000, foregroundMs: 7000});
  const next = M.addClip(p, catalog, bennett, 'burst', 8000, false);
  M.resizeForegroundRun(p, burst.id, 2000);
  assert.equal(burst.foregroundMs, 4850);
  assert.equal(next.startMs, 4850);
  assert.equal(burst.attackAfterMs, 3000);
  assert.equal(M.castDurationMs(burst), 1850);
  assert.equal(M.commandsFor(burst), 'burst,attack(3)');
  assert.deepEqual(M.validate(p), []);
});

test('without ripple the stay tail moves only the next stay and preserves its internal spacing', () => {
  const p = project();
  const skill = M.addClip(p, catalog, raiden, 'skill', 0, false);
  const next = M.addClip(p, catalog, xingqiu, 'burst', 3000, false);
  const follow = M.addClip(p, catalog, xingqiu, 'skill', 4500, false);
  const later = M.addClip(p, catalog, bennett, 'burst', 7000, false);
  M.resizeForegroundRun(p, skill.id, 2500, false);
  assert.equal(M.foregroundRuns(p)[0].endMs, 2500);
  assert.deepEqual([next.startMs, follow.startMs, later.startMs], [2500, 4000, 7000]);
  assert.equal(follow.startMs - next.startMs, 1500);
  assert.deepEqual(M.validate(p), []);
});

test('shrinking the final stay adjusts the loop endpoint and keeps its one-second return', () => {
  const p = project(true);
  const first = M.addClip(p, catalog, raiden, 'skill', 0, false);
  const last = M.addClip(p, catalog, xingqiu, 'burst', 3000, false);
  first.cooldownMs = last.cooldownMs = 0;
  p.durationMs = 8000;
  M.resizeForegroundRun(p, last.id, 5000);
  assert.equal(last.foregroundMs, 2000);
  assert.equal(M.foregroundRuns(p)[1].endMs, 5000);
  assert.equal(p.durationMs, 6000);
  assert.equal(M.loopReturn(p).startMs, 5000);
  M.resizeForegroundRun(p, last.id, 3000);
  assert.equal(M.foregroundRuns(p)[1].endMs, 4000);
  assert.equal(p.durationMs, 5000);
  assert.equal(M.loopReturn(p).startMs, 4000);
  assert.equal(M.castDurationMs(last), 667);
  assert.equal(last.effectMs, 15000);
  assert.deepEqual(M.validate(p), []);
});

test('the final non-loop stay shrinks from the visible endpoint rather than the short cast', () => {
  const p = project();
  const skill = M.addClip(p, catalog, raiden, 'skill', 0, false);
  p.durationMs = 5000;
  M.resizeForegroundRun(p, skill.id, 2500);
  assert.equal(p.durationMs, 2500);
  assert.equal(skill.foregroundMs, 2500);
  assert.equal(M.foregroundRuns(p)[0].endMs, 2500);
  assert.equal(M.castDurationMs(skill), 600);
  assert.deepEqual(M.validate(p), []);
});

test('an independent attack has its own duration while the shared handle adjusts only its stay', () => {
  const p = project();
  const attack = clip(p, raiden, 0, 1200, 'attack');
  p.durationMs = 1200;
  M.resizeForegroundRun(p, attack.id, 1800);
  assert.equal(attack.foregroundMs, 1200);
  assert.equal(p.durationMs, 1800);
  M.resizeForegroundRun(p, attack.id, 600);
  assert.equal(attack.foregroundMs, 1200);
  assert.equal(p.durationMs, 1200);
  M.editClip(p, attack.id, {foregroundMs: 600});
  assert.equal(attack.foregroundMs, 600);
  assert.equal(M.actionDurationMs(attack), 600);
  assert.equal(M.commandsFor(attack), 'attack(0.6)');
  assert.deepEqual(M.validate(p), []);
});

test('moving a same-role skill left consumes idle reservation without moving the role boundary', () => {
  const p = project();
  const burst = M.addClip(p, catalog, bennett, 'burst', 0, false);
  burst.foregroundMs = 4000;
  const skill = M.addClip(p, catalog, bennett, 'skill', 4000, false);
  const next = M.addClip(p, catalog, xingqiu, 'burst', 6000, false);
  const original = {cast: M.castDurationMs(burst), effect: burst.effectMs, command: M.commandsFor(burst)};
  M.editClip(p, skill.id, {startMs: 2000});
  assert.equal(skill.startMs, 2000);
  assert.equal(burst.foregroundMs, 2000);
  assert.equal(M.castDurationMs(burst), original.cast);
  assert.equal(burst.effectMs, original.effect);
  assert.equal(M.commandsFor(burst), original.command);
  assert.equal(next.startMs, 6000);
  assert.equal(M.foregroundRuns(p)[0].endMs, 6000);
  assert.deepEqual(M.validate(p), []);
  assert.doesNotThrow(() => M.exportStrategy(p, catalog));
});

test('moving into the preceding release stops at its actual end rather than its idle reservation', () => {
  const p = project();
  const burst = M.addClip(p, catalog, bennett, 'burst', 0, false);
  burst.foregroundMs = 4000;
  const skill = M.addClip(p, catalog, bennett, 'skill', 4000, false);
  const releaseEnd = M.actionEndOf(burst);
  M.editClip(p, skill.id, {startMs: 300});
  assert.equal(skill.startMs, releaseEnd);
  assert.equal(burst.foregroundMs, releaseEnd);
  assert.deepEqual(M.validate(p), []);
});

test('left dragging cannot consume configured follow-through attacks', () => {
  const p = project();
  const burst = M.addClip(p, catalog, raiden, 'burst', 0, false);
  Object.assign(burst, {followAttack: true, attackAfterMs: 3000, foregroundMs: 7000});
  const skill = M.addClip(p, catalog, raiden, 'skill', 7000, false);
  M.editClip(p, skill.id, {startMs: 2500});
  assert.equal(skill.startMs, 4850);
  assert.equal(burst.foregroundMs, 4850);
  assert.equal(burst.attackAfterMs, 3000);
  assert.equal(M.commandsFor(burst), 'burst,attack(3)');
  assert.deepEqual(M.validate(p), []);
});

test('non-ripple movement consumes same-role idle padding while real action overlaps remain errors', () => {
  const p = project();
  const burst = M.addClip(p, catalog, bennett, 'burst', 0, false);
  burst.foregroundMs = 4000;
  const skill = M.addClip(p, catalog, bennett, 'skill', 4000, false);
  const next = M.addClip(p, catalog, xingqiu, 'burst', 6000, false);
  M.editClip(p, skill.id, {startMs: 2000}, false);
  assert.equal(skill.startMs, 2000);
  assert.equal(burst.foregroundMs, 2000);
  assert.equal(next.startMs, 6000);
  assert.deepEqual(M.validate(p), []);
  M.editClip(p, skill.id, {startMs: 300}, false);
  assert.equal(skill.startMs, 300);
  assert.ok(codes(p).includes('overlap'));
  assert.throws(() => M.exportStrategy(p, catalog), /重叠/);
});

test('a different role still waits for the reserved foreground interval', () => {
  const p = project();
  const burst = M.addClip(p, catalog, bennett, 'burst', 0, false);
  burst.foregroundMs = 4000;
  const next = M.addClip(p, catalog, xingqiu, 'burst', 5000, false);
  M.editClip(p, next.id, {startMs: 2000});
  assert.equal(next.startMs, 4000);
  assert.equal(burst.foregroundMs, 4000);
  assert.deepEqual(M.validate(p), []);
});

test('ripple dragging beyond later roles preserves their order and all following gaps', () => {
  const p = recordedDragLayout();
  const before = M.clone(p);
  M.editClip(p, p.clips[1].id, {startMs: 10000});
  assert.deepEqual(M.ordered(p).map(item => item.id), before.clips.map(item => item.id));
  assert.deepEqual(p.clips.map(item => item.startMs), [0, 10000, 13000, 13300, 14300]);
  assert.deepEqual(p.clips.map(item => item.foregroundMs), before.clips.map(item => item.foregroundMs));
  assert.deepEqual(M.validate(p), []);
  assert.doesNotThrow(() => M.exportStrategy(p, catalog));
});

test('successive right and left ripple drags restore the recorded layout and native action order', () => {
  const p = recordedDragLayout();
  const before = M.clone(p);
  const native = M.exportStrategy(p, catalog);
  for (const startMs of [7500, 10000, 5300]) M.editClip(p, p.clips[1].id, {startMs});
  assert.deepEqual(p, before);
  assert.deepEqual(M.exportStrategy(p, catalog).Actions, native.Actions);
});

test('a ripple visit clamps to the preceding release before applying one common following offset', () => {
  const p = recordedDragLayout();
  M.editClip(p, p.clips[1].id, {startMs: 0});
  assert.deepEqual(p.clips.map(item => item.startMs), [0, 600, 3600, 3900, 4900]);
  assert.equal(p.clips[3].startMs - p.clips[2].startMs, 300);
  assert.deepEqual(M.validate(p), []);
});

test('pushing an internal action preserves the next roles internal spacing instead of compressing it', () => {
  const p = project();
  clip(p, raiden, 0, 1850, 'burst');
  clip(p, raiden, 3000, 1000, 'attack');
  const wait = clip(p, raiden, 5000, 500, 'wait');
  const skill = clip(p, '10000039', 6000, 250);
  const burst = clip(p, '10000039', 6300, 900, 'burst');
  const later = clip(p, '10000002', 8000, 3800, 'charge');
  M.editClip(p, wait.id, {startMs: 7000});
  assert.deepEqual(M.ordered(p).map(item => item.id), p.clips.map(item => item.id));
  assert.deepEqual([skill.startMs, burst.startMs, later.startMs], [7500, 7800, 9500]);
  assert.equal(burst.startMs - skill.startMs, 300);
  assert.equal(later.startMs - burst.startMs, 1700);
  assert.deepEqual(M.validate(p), []);
});

test('independent actions can reorder inside their own stay without reordering later roles', () => {
  const p = project();
  const burst = clip(p, raiden, 0, 1850, 'burst');
  const attack = clip(p, raiden, 3500, 1000, 'attack');
  const wait = clip(p, raiden, 5000, 500, 'wait');
  const later = clip(p, '10000039', 7000, 1000);
  M.editClip(p, wait.id, {startMs: 2500});
  assert.deepEqual(M.ordered(p).map(item => item.id), [burst.id, wait.id, attack.id, later.id]);
  assert.equal(attack.startMs, 3500);
  assert.equal(later.startMs, 7000);
  assert.deepEqual(M.validate(p), []);
});

test('a simultaneous visit move and duration edit applies each delta only once', () => {
  const p = recordedDragLayout();
  M.editClip(p, p.clips[1].id, {startMs: 6300, foregroundMs: 2000});
  assert.deepEqual(p.clips.map(item => item.startMs), [0, 6300, 9800, 10100, 11100]);
  assert.equal(p.clips[1].foregroundMs, 2000);
  assert.deepEqual(M.validate(p), []);
});

test('group movement consumes idle padding while preserving spacing and reporting real collisions', () => {
  const p = project();
  const burst = M.addClip(p, catalog, bennett, 'burst', 0, false);
  burst.foregroundMs = 4000;
  const skill = M.addClip(p, catalog, bennett, 'skill', 4000, false);
  const attack = M.addClip(p, catalog, bennett, 'attack', 5500, false);
  const next = M.addClip(p, catalog, xingqiu, 'burst', 8000, false);
  M.moveClips(p, [skill.id, attack.id], -2000);
  assert.equal(skill.startMs, 2000);
  assert.equal(attack.startMs - skill.startMs, 1500);
  assert.equal(burst.foregroundMs, 2000);
  assert.equal(next.startMs, 8000);
  assert.deepEqual(M.validate(p), []);
  M.moveClips(p, [skill.id, attack.id], -1700);
  assert.equal(skill.startMs, 300);
  assert.equal(attack.startMs - skill.startMs, 1500);
  assert.ok(codes(p).includes('overlap'));
});

test('a cross-role selected group magnetizes to a non-grid release boundary with one common offset', () => {
  const p = project();
  const previous = M.addClip(p, catalog, xingqiu, 'skill', 0, false);
  const burst = M.addClip(p, catalog, bennett, 'burst', 3000, false);
  const skill = M.addClip(p, catalog, raiden, 'skill', 4500, false);
  const next = M.addClip(p, catalog, '10000023', 'burst', 7000, false);
  const original = p.clips.map(clip => ({cast: M.castDurationMs(clip), effect: clip.effectMs}));
  const movement = M.snapMove(p, [burst.id, skill.id], -1660,
    {anchorId: skill.id, thresholdMs: 80});
  assert.deepEqual(movement, {deltaMs: -1716, guideMs: 1284});
  M.moveClips(p, [burst.id, skill.id], movement.deltaMs);
  assert.equal(burst.startMs, M.endOf(previous));
  assert.equal(skill.startMs - burst.startMs, 1500);
  assert.equal(next.startMs, 7000);
  assert.equal(M.switches(p)[1].startMs - M.switches(p)[0].startMs, 1500);
  assert.deepEqual(p.clips.map(clip => ({cast: M.castDurationMs(clip), effect: clip.effectMs})), original);
  assert.deepEqual(M.validate(p), []);
  assert.doesNotThrow(() => M.exportStrategy(p, catalog));
});

test('the selected group tail magnetizes to the next role without stretching its skills', () => {
  const p = project();
  const burst = M.addClip(p, catalog, bennett, 'burst', 3000, false);
  const skill = M.addClip(p, catalog, bennett, 'skill', 4500, false);
  const next = M.addClip(p, catalog, raiden, 'burst', 7000, false);
  const movement = M.snapMove(p, [burst.id, skill.id], 1610, {thresholdMs: 80});
  assert.deepEqual(movement, {deltaMs: 1666, guideMs: 7000});
  M.moveClips(p, [burst.id, skill.id], movement.deltaMs);
  assert.equal(M.endOf(skill), next.startMs);
  assert.equal(skill.startMs - burst.startMs, 1500);
  assert.equal(M.castDurationMs(skill), 834);
  assert.deepEqual(M.validate(p), []);
});

test('same-role group magnetism uses the release boundary inside reserved idle time', () => {
  const p = project();
  const previous = M.addClip(p, catalog, bennett, 'burst', 0, false);
  previous.foregroundMs = 4000;
  const skill = M.addClip(p, catalog, bennett, 'skill', 6000, false);
  const attack = M.addClip(p, catalog, bennett, 'attack', 8000, false);
  const movement = M.snapMove(p, [skill.id, attack.id], -5090, {thresholdMs: 80});
  assert.deepEqual(movement, {deltaMs: -5150, guideMs: 850});
  M.moveClips(p, [skill.id, attack.id], movement.deltaMs);
  assert.equal(skill.startMs, M.actionEndOf(previous));
  assert.equal(previous.foregroundMs, 850);
  assert.equal(previous.effectMs, 12000);
  assert.equal(attack.startMs - skill.startMs, 2000);
  assert.deepEqual(M.validate(p), []);
});

test('group grid snapping aligns the grabbed action while excluding the selected group as a target', () => {
  const p = project();
  const burst = M.addClip(p, catalog, bennett, 'burst', 0, false);
  const skill = M.addClip(p, catalog, bennett, 'skill', 0, false);
  burst.startMs = 1284;
  skill.startMs = 2784;
  const ids = [burst.id, skill.id];
  assert.deepEqual(M.snapMove(p, ids, 170, {anchorId: skill.id, thresholdMs: 80}),
    {deltaMs: 216, guideMs: null});
  assert.deepEqual(M.snapMove(p, ids, 50, {anchorId: skill.id, thresholdMs: 80}),
    {deltaMs: 16, guideMs: null});
  M.moveClips(p, ids, 216);
  assert.equal(skill.startMs, 3000);
  assert.equal(burst.startMs, 1500);
});

test('a group can magnetize to the origin, playhead and loop end without crossing zero', () => {
  const p = project();
  p.durationMs = 8000;
  const burst = M.addClip(p, catalog, bennett, 'burst', 3000, false);
  const skill = M.addClip(p, catalog, bennett, 'skill', 4500, false);
  const ids = [burst.id, skill.id];
  assert.deepEqual(M.snapMove(p, ids, -2930, {thresholdMs: 80}), {deltaMs: -3000, guideMs: 0});
  assert.deepEqual(M.snapMove(p, ids, 210, {thresholdMs: 80, markers: [3284]}),
    {deltaMs: 284, guideMs: 3284});
  assert.deepEqual(M.snapMove(p, ids, 2606, {thresholdMs: 80}), {deltaMs: 2666, guideMs: 8000});
  assert.deepEqual(M.snapMove(p, ids, -9000, {thresholdMs: 80}), {deltaMs: -3000, guideMs: null});
});

test('the magnetic threshold follows screen distance and releases outside that distance', () => {
  const p = project();
  M.addClip(p, catalog, xingqiu, 'skill', 0, false);
  const burst = M.addClip(p, catalog, bennett, 'burst', 3000, false);
  const skill = M.addClip(p, catalog, bennett, 'skill', 4500, false);
  const ids = [burst.id, skill.id];
  assert.deepEqual(M.snapMove(p, ids, -1660, {anchorId: skill.id, thresholdMs: 8 / 96 * 1000}),
    {deltaMs: -1716, guideMs: 1284});
  assert.deepEqual(M.snapMove(p, ids, -1660, {anchorId: skill.id, thresholdMs: 8 / 192 * 1000}),
    {deltaMs: -1700, guideMs: null});
});

test('group movement clamps at zero without changing relative spacing or unrelated actions', () => {
  const p = project();
  const first = M.addClip(p, catalog, raiden, 'skill', 500, false);
  const second = M.addClip(p, catalog, xingqiu, 'burst', 3000, false);
  const other = M.addClip(p, catalog, bennett, 'burst', 7000, false);
  M.moveClips(p, [first.id, second.id], -1000);
  assert.equal(first.startMs, 0);
  assert.equal(second.startMs - first.startMs, 2500);
  assert.equal(other.startMs, 7000);
  assert.equal(M.castDurationMs(first), 600);
});

test('group movement exposes collisions without independently shifting the selected roles', () => {
  const p = project();
  const first = M.addClip(p, catalog, raiden, 'skill', 0, false);
  const second = M.addClip(p, catalog, xingqiu, 'burst', 2000, false);
  const other = M.addClip(p, catalog, bennett, 'burst', 4000, false);
  M.moveClips(p, [first.id, second.id], 2500);
  assert.equal(second.startMs - first.startMs, 2000);
  assert.equal(other.startMs, 4000);
  assert.ok(codes(p).includes('overlap'));
  assert.throws(() => M.exportStrategy(p, catalog), /重叠/);
});

test('legacy stretched effects restore their skill duration without moving the saved layout', () => {
  const p = project();
  const skill = M.addClip(p, catalog, bennett, 'burst', 2500, false);
  skill.effectMs = 11700;
  delete skill.effectSource;
  const restored = M.normalizeProject(p, catalog).clips[0];
  assert.equal(restored.effectMs, M.ability(catalog, bennett, 'burst').effectMs);
  assert.equal(restored.effectMs, 12000);
  assert.equal(restored.startMs, 2500);
  assert.equal(restored.foregroundMs, skill.foregroundMs);
});

test('pending release estimates stay distinct from a measured hard lock', () => {
  const unmeasured = catalog.characters.find(character => !M.timingFor(character.id, 'skill'));
  const p = project();
  const skill = M.addClip(p, catalog, unmeasured.id, 'skill', 0);
  assert.equal(M.castLockMs(skill), null);
  assert.equal(M.minimumForegroundMs(skill), 100);
  assert.equal(M.castDurationMs(skill), M.ability(catalog, unmeasured.id, 'skill').foregroundMs);
});

test('the return cooldown is an idle foreground run of the opening role', () => {
  const p = project(true);
  p.durationMs = 4000;
  M.addClip(p, catalog, raiden, 'skill', 0, false);
  M.addClip(p, catalog, xingqiu, 'burst', 1500, false);
  const runs = M.foregroundRuns(p);
  assert.equal(runs[1].endMs, 3000);
  assert.equal(runs[2].characterId, raiden);
  assert.deepEqual(M.idleIntervals(runs[2]), [{startMs: 3000, endMs: 4000}]);
});

test('the demo has four roles, real skill names and a valid repeat boundary', () => {
  const p = M.demoProject(catalog);
  assert.equal(p.team.length, 4);
  assert.equal(p.clips.length, 12);
  assert.deepEqual(M.ordered(p).slice(-4).map(clip => clip.abilityId), ['attack', 'wait', 'attack', 'attack']);
  assert.deepEqual(M.validate(p), []);
  assert.equal(M.ability(catalog, raiden, 'skill').name, '神变·恶曜开眼');
  assert.equal(M.ability(catalog, raiden, 'skill').effectMs, 25000);
  assert.equal(M.ability(catalog, xingqiu, 'skill').cooldownMs, 21000);
});

test('effects and cooldown both tick while their owner is onfield', () => {
  const p = project();
  clip(p, raiden, 0, 3000, 'skill', {effectMs: 25000, cooldownMs: 10000});
  const state = M.stateAt(p, 1500);
  assert.equal(state.foregroundId, raiden);
  assert.equal(state.statuses[0].skills[0].effectMs, 23500);
  assert.equal(state.statuses[0].skills[0].cooldownMs, 8500);
});

test('offfield timers advance on the same global clock after switching', () => {
  const p = project();
  clip(p, raiden, 0, 900, 'skill', {effectMs: 25000, cooldownMs: 10000});
  clip(p, xingqiu, 1000, 1000);
  const state = M.stateAt(p, 2500);
  assert.equal(state.foregroundId, xingqiu);
  const owner = state.statuses.find(value => value.characterId === raiden);
  assert.equal(owner.onfield, false);
  assert.equal(owner.skills[0].effectMs, 22500);
  assert.equal(owner.skills[0].cooldownMs, 7500);
});

test('cooldown starts at release, not at departure or foreground end', () => {
  const p = project();
  clip(p, raiden, 0, 9000, 'skill', {cooldownMs: 10000});
  clip(p, xingqiu, 9000, 500);
  assert.equal(M.stateAt(p, 9500).statuses[0].skills[0].cooldownMs, 500);
  assert.equal(M.stateAt(p, 10000).statuses[0].skills[0].cooldownMs, 0);
});

test('previous-cycle background effects carry through a loop boundary', () => {
  const p = project(true);
  p.durationMs = 20000;
  clip(p, xingqiu, 0, 1000);
  clip(p, raiden, 12000, 1000, 'skill', {effectMs: 25000, cooldownMs: 10000});
  const state = M.stateAt(p, 2000, true);
  const owner = state.statuses.find(value => value.characterId === raiden);
  assert.equal(owner.skills[0].effectMs, 15000);
  assert.equal(owner.skills[0].cooldownMs, 0);
});

test('onfield-only effects end on departure without resetting cooldown', () => {
  const p = project();
  clip(p, raiden, 0, 500, 'burst', {effectMs: 7000, cooldownMs: 18000, effectPolicy: 'onfield'});
  clip(p, xingqiu, 1000, 1000);
  const burst = M.stateAt(p, 1500).statuses[0].skills[1];
  assert.equal(burst.effectMs, 0);
  assert.equal(burst.cooldownMs, 16500);
});

test('a different skill from the same role does not reset switch cooldown', () => {
  const p = project();
  clip(p, raiden, 0);
  clip(p, raiden, 200, 200, 'burst');
  clip(p, xingqiu, 1000);
  assert.ok(!codes(p).includes('switch'));
  assert.equal(M.switches(p).length, 1);
});

test('the opening role starts without a synthetic one-second switch cooldown', () => {
  const p = project();
  clip(p, raiden, 0);
  clip(p, xingqiu, 200);
  assert.deepEqual(M.validate(p), []);
  const native = M.exportStrategy(p, catalog);
  assert.equal(native.Actions[0].Name, p.clips[0].name);
  assert.equal(native.Actions.filter(action => action.Name.startsWith('Switch')).length, 1);
});

test('each subsequent switch also observes the one-second hard cooldown', () => {
  const p = project();
  clip(p, raiden, 0);
  clip(p, xingqiu, 200);
  const third = clip(p, bennett, 1100);
  assert.ok(codes(p).includes('switch'));
  third.startMs = 1200;
  assert.ok(!codes(p).includes('switch'));
});

test('foreground overlap is invalid even for the same role', () => {
  const p = project();
  clip(p, raiden, 0, 1000);
  clip(p, raiden, 900, 1000, 'burst');
  assert.ok(codes(p).includes('overlap'));
});

test('a persistent effect may overlap another role without blocking it', () => {
  const p = project();
  clip(p, raiden, 0, 900, 'skill', {effectMs: 25000});
  clip(p, xingqiu, 1000, 1000, 'burst', {effectMs: 15000});
  assert.deepEqual(M.validate(p), []);
});

test('switch cooldown is checked across the repeat boundary', () => {
  const p = project(true);
  p.durationMs = 2000;
  clip(p, raiden, 0);
  clip(p, xingqiu, 1500);
  assert.ok(codes(p).includes('switch-loop'));
  p.durationMs = 3500;
  assert.ok(!codes(p).includes('switch-loop'));
});

test('a same-role loop boundary does not require an extra switch', () => {
  const p = project(true);
  p.durationMs = 4000;
  clip(p, raiden, 0);
  clip(p, xingqiu, 1000);
  clip(p, raiden, 2000);
  assert.ok(!codes(p).includes('switch-loop'));
});

test('skill cooldown is checked across the repeat boundary', () => {
  const p = project(true);
  p.durationMs = 20000;
  clip(p, raiden, 0, 500, 'skill', {cooldownMs: 21000});
  assert.ok(codes(p).includes('cooldown-loop'));
  M.fitLoop(p);
  assert.equal(p.durationMs, 21000);
  assert.deepEqual(M.validate(p), []);
});

test('automatic spacing counts from switch start, not previous clip end', () => {
  const p = project();
  clip(p, raiden, 0);
  const second = clip(p, xingqiu, 200);
  const third = clip(p, bennett, 400);
  M.repairSchedule(p);
  assert.equal(second.startMs, 200);
  assert.equal(third.startMs, 1200);
});

test('ripple resizing moves later clips and preserves their gaps', () => {
  const p = project();
  const first = clip(p, raiden, 0);
  const second = clip(p, xingqiu, 1000);
  const third = clip(p, bennett, 2500);
  M.editClip(p, first.id, {foregroundMs: 700}, true);
  assert.equal(second.startMs, 1500);
  assert.equal(third.startMs, 3000);
});

test('non-ripple resizing exposes a conflict instead of silently moving other roles', () => {
  const p = project();
  const first = clip(p, raiden, 0);
  const second = clip(p, xingqiu, 1000);
  M.editClip(p, first.id, {foregroundMs: 1500}, false);
  assert.equal(second.startMs, 1000);
  assert.ok(codes(p).includes('overlap'));
  assert.throws(() => M.exportStrategy(p, catalog), /重叠/);
});

test('a fifth role cannot be added to the timeline', () => {
  const p = M.demoProject(catalog);
  assert.throws(() => M.addClip(p, catalog, '10000030', 'skill', 16000), /4/);
  assert.equal(p.team.length, 4);
});

test('native commands keep nested comma arguments intact', () => {
  const commands = M.parseCommands('walk(w, 0.2),skill(hold),attack(2)');
  assert.equal(commands.length, 3);
  assert.deepEqual(commands[0].args, ['w', '0.2']);
  assert.throws(() => M.parseCommands('walk(w,0.2'), /括号/);
  assert.throws(() => M.parseCommands('wait(1))'), /括号/);
});

test('native JSON round-trips project layout and timeline clocks', () => {
  const p = M.demoProject(catalog);
  p.execution = 'timeline';
  const value = M.exportStrategy(p, catalog);
  const reopened = M.importStrategy(JSON.parse(JSON.stringify(value)), catalog);
  assert.deepEqual(reopened, p);
  assert.equal(value.Actions.filter(action => action.Name.startsWith('Switch')).length, 4);
  assert.deepEqual(M.ordered(p).slice(-5).map(clip =>
    value.Actions.find(action => action.Name === clip.name).Action),
  ['burst', 'attack(1.5)', 'wait(0.2)', 'attack(1.5)', 'attack(2)']);
});

test('editing native metadata does not get overwritten by embedded project data', () => {
  const value = M.exportStrategy(M.demoProject(catalog), catalog);
  value.Info.Name = '修改后的工程';
  value.Info.Author = '新的作者';
  value.Info.PreActions = ['雷电将军 skill'];
  value.Info.Config.userSetting = 3;
  const reopened = M.importStrategy(value, catalog);
  assert.equal(reopened.name, '修改后的工程');
  assert.equal(reopened.author, '新的作者');
  assert.deepEqual(reopened.preActions, ['雷电将军 skill']);
  assert.equal(M.exportStrategy(reopened, catalog).Info.Config.userSetting, 3);
});

test('editing a native action takes precedence over stale embedded project data', () => {
  const value = M.exportStrategy(M.demoProject(catalog), catalog);
  const target = value.Actions.find(action => !action.Name.startsWith('Switch'));
  target.Action = 'skill(hold)';
  const reopened = M.importStrategy(value, catalog);
  assert.equal(reopened.scheduling, 'original');
  const exported = M.exportStrategy(reopened, catalog);
  assert.equal(exported.Actions.find(action => action.Name === target.Name).Action, 'skill(hold)');
});

test('import preserves unknown fields, original priority and current-role semantics', () => {
  const value = {customRoot: {keep: true}, info: {name: '旧策略', author: '作者',
    config: {userValue: [1, 2]}, preActions: ['雷电将军 skill'], customInfo: 9},
  actions: [{name: '雷电战技', character: '雷电将军', action: 'skill', index: 77,
    condition: {expression: 'since(77) > 10', extra: 1}, ensureCast: true,
    morePriorities: [{expression: 't() < 1', priority: -1, extra: 2}], customAction: 3},
  {name: '接续普攻', character: '', action: 'attack(2)', index: 78, condition: {expression: 'true'}}]};
  const p = M.importStrategy(value, catalog);
  assert.equal(p.scheduling, 'original');
  const exported = M.exportStrategy(p, catalog, {embedProject: false});
  assert.deepEqual(exported.customRoot, {keep: true});
  assert.equal(exported.Info.customInfo, 9);
  assert.deepEqual(exported.Info.Config.userValue, [1, 2]);
  assert.equal(exported.Actions[0].Index, 77);
  assert.equal(exported.Actions[0].customAction, 3);
  assert.equal(exported.Actions[0].Condition.Expression, 'since(77) > 10');
  assert.equal(exported.Actions[0].Condition.extra, 1);
  assert.equal(exported.Actions[0].MorePriorities[0].extra, 2);
  assert.equal(exported.Actions[1].Character, '');
});

test('extra priorities retain their alternative condition after sequence conversion', () => {
  const p = project();
  const first = clip(p, raiden, 0);
  first.condition = 'e-ready()';
  first.sourceAction = {Index: 91, MorePriorities: [{Expression: 'count() = 0', Priority: 1}]};
  p.scheduling = 'sequence';
  const exported = M.exportStrategy(p, catalog);
  const action = exported.Actions.find(item => item.Name === first.name);
  assert.equal(action.Index, 91);
  assert.ok(exported.Actions.filter(item => item.Name.startsWith('Switch')).every(item => item.Index !== 91));
  assert.match(action.MorePriorities[0].Expression, /count\(\) = 0/);
  assert.doesNotMatch(action.MorePriorities[0].Expression, /e-ready/);
});

test('an eligible later action never overtakes an earlier sequence entry', () => {
  const p = project();
  const first = clip(p, raiden, 5000);
  const second = clip(p, xingqiu, 7000);
  const history = replay(M.exportStrategy(p, catalog), 9000);
  const skills = history.filter(event => !event.switch);
  assert.deepEqual(skills.map(event => event.name), [first.name, second.name]);
  assert.ok(skills[0].startMs >= 5000);
  assert.ok(skills[1].startMs >= 7000);
});

test('slow native actions cannot compress actual switch intervals below one second', () => {
  const p = project();
  clip(p, raiden, 0);
  clip(p, xingqiu, 1000);
  clip(p, bennett, 2000);
  const history = replay(M.exportStrategy(p, catalog), 10000,
    action => action.Name.startsWith('Switch') ? 10 : action.Character === '雷电将军' ? 4000 : 10);
  const changes = history.filter(event => event.switch);
  assert.equal(changes.length, 2);
  for (let i = 1; i < changes.length; i++) {
    assert.ok(changes[i].startMs - changes[i - 1].completedMs >= 1000);
  }
});

test('native repeating sequence stays ordered for three complete cycles', () => {
  const p = project(true);
  p.durationMs = 4000;
  const first = clip(p, raiden, 0);
  const second = clip(p, xingqiu, 1500);
  const history = replay(M.exportStrategy(p, catalog), 12000, action =>
    action.Name.startsWith('Switch') ? 10 : 200);
  assert.deepEqual(history.filter(event => !event.switch).map(event => event.name),
    [first.name, second.name, first.name, second.name, first.name, second.name]);
  const changes = history.filter(event => event.switch);
  for (let i = 1; i < changes.length; i++) {
    assert.ok(changes[i].startMs - changes[i - 1].completedMs >= 1000);
  }
});

test('one-shot export executes each skill at most once', () => {
  const p = project(false);
  const first = clip(p, raiden, 0);
  const second = clip(p, xingqiu, 1000);
  const history = replay(M.exportStrategy(p, catalog), 10000);
  assert.deepEqual(history.filter(event => !event.switch).map(event => event.name), [first.name, second.name]);
});

test('invalid imported projects cannot lose or duplicate team identities silently', () => {
  const p = M.demoProject(catalog);
  p.team.push(p.team[0]);
  assert.throws(() => M.normalizeProject(p, catalog), /队伍/);
});

test('provided calibrations use per-character swap frames instead of a common E duration', () => {
  assert.equal(M.timingFor(raiden, 'skill').swapFrames, 36);
  assert.equal(M.timingFor(raiden, 'skill').lockMs, 600);
  assert.equal(M.timingFor(xingqiu, 'skill').swapFrames, 77);
  assert.equal(M.timingFor(xingqiu, 'skill').lockMs, 1284);
  assert.equal(M.timingFor(raiden, 'burst').lockMs, 1850);
  assert.equal(M.timingFor(raiden, 'burst').locallyMeasured, false);
});

test('press and hold forms keep separate measurement values', () => {
  const forms = M.timingVariants(bennett, 'skill');
  assert.equal(forms.find(entry => entry.label === 'Press').lockMs, 834);
  assert.equal(forms.find(entry => entry.label === 'Hold Lv. 1').lockMs, 1584);
  assert.equal(forms.find(entry => entry.label === 'Hold Lv. 2').lockMs, 5617);
  assert.equal(M.timingFor(bennett, 'skill', true).hold, true);
});

test('E cannot be shortened through its casting lock while normal attacks remain trimmable', () => {
  const p = project();
  const skill = M.addClip(p, catalog, xingqiu, 'skill', 0);
  M.editClip(p, skill.id, {foregroundMs: 100});
  assert.equal(skill.foregroundMs, 1284);
  const attack = M.addClip(p, catalog, raiden, 'attack', 2000);
  M.editClip(p, attack.id, {foregroundMs: 100});
  assert.equal(attack.foregroundMs, 100);
});

test('Q casting lock cannot be cancelled by resizing the foreground span', () => {
  const p = project();
  const burst = M.addClip(p, catalog, raiden, 'burst', 0);
  M.editClip(p, burst.id, {foregroundMs: 100}, false);
  assert.equal(burst.foregroundMs, 1850);
});

test('the first real switch waits for skill release but has no additional opening cooldown', () => {
  const p = project();
  const first = M.addClip(p, catalog, raiden, 'skill', 0);
  const next = M.addClip(p, catalog, xingqiu, 'burst', 0);
  assert.equal(first.foregroundMs, 600);
  assert.equal(next.startMs, 600);
  assert.ok(!codes(p).includes('switch'));
});

test('imported old timing spans are marked invalid until explicitly repaired', () => {
  const p = project();
  const first = M.addClip(p, catalog, xingqiu, 'skill', 0);
  first.foregroundMs = 500;
  delete first.castTiming;
  const imported = M.normalizeProject(p, catalog);
  assert.equal(imported.clips[0].foregroundMs, 500);
  assert.ok(codes(imported).includes('cast-lock'));
  M.repairSchedule(imported);
  assert.equal(imported.clips[0].foregroundMs, 1284);
  assert.ok(!codes(imported).includes('cast-lock'));
});

test('an unmeasured character never inherits a made-up measured casting lock', () => {
  const unmeasured = catalog.characters.find(character => !M.timingFor(character.id, 'skill'));
  assert.ok(unmeasured);
  const p = project();
  const skill = M.addClip(p, catalog, unmeasured.id, 'skill', 0);
  assert.equal(skill.castTiming, null);
  assert.equal(M.castLockMs(skill), null);
});

test('a manual casting calibration affects only the edited role and action', () => {
  const p = project();
  const first = M.addClip(p, catalog, raiden, 'skill', 0);
  const second = M.addClip(p, catalog, xingqiu, 'skill', 2000);
  M.editClip(p, first.id, {lockOverrideMs: 1500, foregroundMs: 100}, false);
  assert.equal(M.castLockMs(first), 1500);
  assert.equal(first.foregroundMs, 1500);
  assert.equal(M.castLockMs(second), 1284);
});

test('loop return switches to the first role in the reserved final second', () => {
  const p = project(true);
  p.durationMs = 2000;
  clip(p, raiden, 0);
  clip(p, xingqiu, 200);
  assert.ok(codes(p).includes('switch-loop'));
  M.fitLoop(p);
  assert.equal(p.durationMs, 2200);
  assert.equal(M.loopReturn(p).startMs, 1200);
  assert.equal(M.stateAt(p, 1300).foregroundId, raiden);
  assert.deepEqual(M.validate(p), []);
});

test('onfield effects end when the last role returns to the opening role', () => {
  const p = project(true);
  p.durationMs = 4000;
  clip(p, raiden, 0);
  const last = clip(p, xingqiu, 1000, 200, 'burst', {effectMs: 5000, effectPolicy: 'onfield'});
  assert.equal(M.effectEnd(p, last), 3000);
  assert.equal(M.stateAt(p, 3500).statuses[1].skills[1].effectMs, 0);
});

test('the next cycle waits for the actual return switch cooldown after slow actions', () => {
  const p = project(true);
  p.durationMs = 2200;
  const first = clip(p, raiden, 0);
  clip(p, xingqiu, 200);
  const history = replay(M.exportStrategy(p, catalog), 12000, action =>
    action.Name.startsWith('Switch') ? 10 : action.Character === '行秋' ? 2400 : 200);
  const returns = history.filter(entry => entry.name === 'SwitchLoopReturn');
  assert.ok(returns.length > 1);
  for (const returned of returns) {
    const next = history.find(entry => entry.name === first.name && entry.startMs > returned.completedMs);
    if (next) assert.ok(next.startMs - returned.completedMs >= 1000);
  }
});

test('compiler version one projects reopen as a timeline without losing old native conditions', () => {
  const p = M.demoProject(catalog);
  const native = M.exportStrategy(p, catalog, {compilerVersion: 1});
  delete native.Info.Config.CombatTimeline.compilerVersion;
  for (const entry of native.Info.Config.CombatTimeline.project.clips) {
    delete entry.castTiming;
    delete entry.lockOverrideMs;
  }
  const imported = M.importStrategy(native, catalog);
  assert.equal(imported.scheduling, 'sequence');
  assert.equal(imported.clips.length, 12);
  assert.ok(imported.clips[0].castTiming);
});
