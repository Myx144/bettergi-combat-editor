(function(root) {
  'use strict';

  const SWITCH_COOLDOWN_MS = 1000;
  const castTimings = typeof module === 'object' && module.exports
    ? require('./cast-timings.js') : root.CombatCastTimings;
  const operations = typeof module === 'object' && module.exports
    ? require('./operations.js') : root.CombatOperations;
  const createFormats = typeof module === 'object' && module.exports
    ? require('./strategy-formats.js') : root.CombatFormatFactory;
  let roleTools, teamTools;
  const clone = value => JSON.parse(JSON.stringify(value));
  const seconds = value => Number((value / 1000).toFixed(3));
  const ms = value => Math.round(Number(value) * 1000);
  const ordered = project => [...project.clips].sort((a, b) => a.startMs - b.startMs || a.order - b.order);
  const declared = project => [...project.clips].sort((a, b) =>
    (a.declarationOrder ?? a.order) - (b.declarationOrder ?? b.order) || a.order - b.order);
  const castLockMs = clip => Number.isFinite(clip.lockOverrideMs)
    ? clip.lockOverrideMs : clip.castTiming?.lockMs ?? null;
  const isCast = clip => ['skill', 'burst'].includes(clip.abilityId);
  const isFixedAction = clip => isCast(clip) || ['combo', 'jump', 'keypress', 'moveby', 'ready', 'check'].includes(clip.abilityId);
  function operationDurationMs(clip) {
    if (clip.abilityId === 'combo' && clip.commandOverride === null) {
      try {
        return Math.max(100, operations.duration(clip.operations, (type, hold) =>
          timingFor(clip.characterId, type, hold)?.lockMs ?? (type === 'burst' ? 1800 : 1000)));
      } catch { return 100; }
    }
    if (clip.abilityId === 'combo') return clip.castEstimateMs || clip.foregroundMs;
    return operations.definitions.find(item => item.id === clip.abilityId)?.foregroundMs ?? clip.foregroundMs;
  }
  const attackStartMs = clip => Number.isFinite(clip.castTiming?.followFrames?.attack)
    ? Math.ceil(clip.castTiming.followFrames.attack / 60 * 1000)
    : castLockMs(clip) ?? clip.castEstimateMs ?? 0;
  const castDurationMs = clip => isCast(clip)
    ? clip.castInputMs ?? castLockMs(clip) ?? clip.castEstimateMs ?? 0
    : isFixedAction(clip) ? operationDurationMs(clip) : clip.foregroundMs;
  const swapEndOf = clip => clip.startMs + (castLockMs(clip) || 0);
  const minimumForegroundMs = clip => Math.max(100, clip.castInputMs ?? castLockMs(clip) ?? 0,
    clip.abilityId === 'combo' && clip.commandOverride === null ? operationDurationMs(clip) : 0,
    isCast(clip) && clip.followAttack ? attackStartMs(clip) + clip.attackAfterMs : 0);
  const endOf = clip => clip.startMs + Math.max(clip.foregroundMs, minimumForegroundMs(clip));
  const actionDurationMs = clip => isFixedAction(clip)
    ? Math.min(endOf(clip) - clip.startMs, Math.max(castDurationMs(clip),
      clip.followAttack ? attackStartMs(clip) + clip.attackAfterMs : 0)) : endOf(clip) - clip.startMs;
  const actionEndOf = clip => clip.startMs + actionDurationMs(clip);
  const snap = (value, step = 100) => Math.max(0, Math.round(value / step) * step);
  const read = (object, key, fallback) => {
    const actual = Object.keys(object || {}).find(name => name.toLowerCase() === key.toLowerCase());
    return actual === undefined ? fallback : object[actual];
  };
  const stableData = value => Array.isArray(value) ? value.map(stableData)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value)
      .sort(([a], [b]) => a.toLowerCase().localeCompare(b.toLowerCase()))
      .map(([key, item]) => [key.toLowerCase(), stableData(item)])) : value;

  function character(catalog, id) {
    const result = catalog.characters.find(item => item.id === String(id));
    if (!result) throw new Error('角色不在当前目录中');
    return result;
  }

  function ability(catalog, characterId, abilityId) {
    const result = abilities(catalog, characterId).find(item => item.id === abilityId);
    if (!result) throw new Error('该角色没有所选技能');
    return result;
  }

  function abilities(catalog, characterId) {
    return [...character(catalog, characterId).skills, ...operations.definitions];
  }

  const isText = project => project.strategyFormat === 'txt';
  const isProcess = project => project.scheduling === 'sequence' && project.execution === 'process';
  const priorityOf = clip => clip.priority ?? read(clip.sourceAction, 'Index', Math.max(0, Math.ceil(clip.order) - 1));
  const prioritiesOf = clip => clip.morePriorities ?? read(clip.sourceAction, 'MorePriorities', []);

  function timingVariants(characterId, abilityId) {
    return (castTimings?.characters?.[String(characterId)] || []).filter(entry => entry.abilityId === abilityId);
  }

  function timingFor(characterId, abilityId, hold = false) {
    return timingVariants(characterId, abilityId).find(entry => entry.hold === hold) || null;
  }

  function emptyProject() {
    return {format: 'betterbgi-combat-timeline', version: 1, name: '未命名战斗流程', author: '',
      durationMs: 24000, repeat: true, scheduling: 'sequence', execution: 'process', team: [], clips: [], nextId: 1,
      preActions: [], sourceInfo: {}, sourceRoot: {}, roleSlots: [], strategyFormat: 'json',
      txtWaitGaps: false};
  }

  function makeClip(project, catalog, characterId, abilityId = 'skill', startMs = 0) {
    const preset = ability(catalog, characterId, abilityId);
    const timing = timingFor(characterId, abilityId);
    const number = project.nextId++;
    const clip = {id: `clip${number}`, name: `片段${number}`, order: number, declarationOrder: number,
      characterId: String(characterId),
      abilityId, startMs: snap(startMs), foregroundMs: timing?.lockMs !== null && timing?.lockMs !== undefined
        ? Math.max(100, timing.lockMs) : preset.foregroundMs,
      effectMs: preset.effectMs, cooldownMs: preset.cooldownMs, effectPolicy: preset.effectPolicy,
      castTiming: timing ? clone(timing) : null, castEstimateMs: preset.foregroundMs,
      lockOverrideMs: null, castInputMs: null, followSourceId: null, effectSource: 'catalog',
      hold: false, followAttack: false, attackAfterMs: 0, ensureCast: !isText(project) && isProcess(project) && abilityId === 'skill',
      condition: !isText(project) && project.scheduling === 'original'
        ? abilityId === 'skill' ? 'e-ready()' : abilityId === 'burst' ? 'q-ready()' : '' : '',
      readiness: !isText(project) && isProcess(project) && ['skill', 'burst'].includes(abilityId) ? abilityId : 'none',
      notReady: abilityId === 'burst' ? 'skip' : 'wait', protectCast: true,
      txtSkillPolicy: 'direct', txtRounds: '', txtReady: false,
      operation: operations.parameters(abilityId), operations: abilityId === 'combo' ? operations.template() : [],
      sourceAction: null, commandOverride: null};
    if (abilityId === 'combo') clip.foregroundMs = operationDurationMs(clip);
    if (!isText(project) && project.scheduling === 'original') {
      clip.priority = isCast(clip)
        ? Math.max(-1, ...project.clips.filter(isCast).map(priorityOf)) + 1 : 1000 + number;
    }
    return clip;
  }

  function addClip(project, catalog, characterId, abilityId, startMs, ripple = true) {
    const plan = teamTools?.hasTeams(project) ? teamTools.activeTeam(project) : null;
    if (plan?.roster.length === 4 && !plan.roster.includes(String(characterId))
      && !(project.roleSlots || []).some(slot => plan.roster.includes(slot.characterId)
        && slot.candidates.some(candidate => candidate.characterId === String(characterId)))) {
      throw new Error('角色不在本队阵容中，请先在队伍管理中调整阵容');
    }
    if (!project.team.includes(String(characterId))) {
      if ((project.roleSlots || []).some(slot => slot.candidates.some(candidate =>
        candidate.characterId === String(characterId)))) throw new Error('该角色已属于兼容定位，请在角色轴旁切换');
      if (!isText(project) && project.scheduling !== 'original' && project.team.length >= 4) throw new Error('队伍最多包含 4 名角色');
      project.team.push(String(characterId));
    }
    const clip = makeClip(project, catalog, characterId, abilityId, startMs);
    project.clips.push(clip);
    if (ripple) repairSchedule(project);
    project.durationMs = Math.max(project.durationMs, ...project.clips.map(endOf));
    return clip;
  }

  function insertAfter(project, catalog, clipId, abilityId, ripple = true) {
    const anchor = project.clips.find(clip => clip.id === clipId);
    if (!anchor) throw new Error('片段不存在');
    const rows = ordered(project), next = rows[rows.indexOf(anchor) + 1];
    const startMs = actionEndOf(anchor);
    const clip = addClip(project, catalog, anchor.characterId, abilityId, startMs, false);
    clip.startMs = startMs;
    if (next && next.startMs <= startMs) clip.order = next.order - 0.5;
    if (rows.some(row => row.sourceAction)) {
      clip.sourceAction = {Index: Math.max(...rows.map((row, index) => read(row.sourceAction, 'Index', index))) + 1};
    }
    if (ripple) repairSchedule(project);
    return clip;
  }

  function separateFollowAttacks(project, catalog) {
    if (project.scheduling !== 'sequence') return project;
    const rows = ordered(project);
    if (!rows.some(clip => isCast(clip) && clip.followAttack && clip.attackAfterMs > 0
      && clip.commandOverride === null)) return project;
    const usedNames = new Set(rows.map(clip => clip.name.toLowerCase()));
    let nextIndex = Math.max(-1, ...rows.map((clip, index) => read(clip.sourceAction, 'Index', index))) + 1;
    rows.forEach((clip, index) => { clip.sourceAction ??= {Index: index}; });
    for (const clip of rows) {
      if (!isCast(clip) || !clip.followAttack || clip.attackAfterMs <= 0 || clip.commandOverride !== null) continue;
      const offset = Math.max(100, attackStartMs(clip)), duration = clip.attackAfterMs;
      const attack = makeClip(project, catalog, clip.characterId, 'attack', clip.startMs + offset);
      attack.startMs = clip.startMs + offset;
      attack.foregroundMs = Math.max(100, duration);
      attack.followSourceId = clip.id;
      attack.sourceAction = {Index: nextIndex++};
      attack.name = `Attack${clip.id}`;
      while (usedNames.has(attack.name.toLowerCase())) attack.name += 'S';
      usedNames.add(attack.name.toLowerCase());
      const next = rows[rows.indexOf(clip) + 1];
      if (next && next.startMs === attack.startMs) attack.order = next.order - 0.5;
      // Input recovery and the later character-switch lock have separate clocks.
      clip.castInputMs = offset;
      clip.foregroundMs = offset;
      clip.followAttack = false;
      clip.attackAfterMs = 0;
      project.clips.push(attack);
    }
    return project;
  }

  function consumeIdleTime(previous, next) {
    if (!previous || previous.characterId !== next.characterId) return;
    const busyEnd = Math.max(actionEndOf(previous), previous.startMs + minimumForegroundMs(previous));
    if (next.startMs < busyEnd || next.startMs >= endOf(previous)) return;
    previous.foregroundMs = next.startMs - previous.startMs;
  }

  function repairSchedule(project, includeCooldown = false, sequence = ordered(project), rippleAfterId = null) {
    let end = 0, releaseEnd = 0, current = null, lastSwitch = null, previous = null;
    let shift = 0, following = false;
    const casts = new Map();
    for (const clip of sequence) {
      if (following) clip.startMs += shift;
      const requested = clip.startMs;
      clip.foregroundMs = Math.max(clip.foregroundMs, minimumForegroundMs(clip));
      let earliest = previous?.characterId === clip.characterId
        ? Math.max(actionEndOf(previous), previous.startMs + minimumForegroundMs(previous))
        : Math.max(end, releaseEnd);
      if (current !== clip.characterId && lastSwitch !== null) {
        earliest = Math.max(earliest, lastSwitch + SWITCH_COOLDOWN_MS);
      }
      const castKey = `${clip.characterId}:${clip.abilityId}`;
      if (includeCooldown && casts.has(castKey)) {
        const previous = casts.get(castKey);
        earliest = Math.max(earliest, previous.startMs + previous.cooldownMs);
      }
      clip.startMs = Math.max(clip.startMs, earliest);
      if (following) shift += clip.startMs - requested;
      if (clip.id === rippleAfterId) following = true;
      consumeIdleTime(previous, clip);
      if (current !== null && current !== clip.characterId) lastSwitch = clip.startMs;
      if (current !== clip.characterId) releaseEnd = 0;
      current = clip.characterId;
      end = endOf(clip);
      releaseEnd = Math.max(releaseEnd, swapEndOf(clip));
      previous = clip;
      casts.set(castKey, clip);
    }
    project.durationMs = Math.max(project.durationMs, end, project.repeat ? minimumLoopMs(project) : 0);
    return project;
  }

  function editClip(project, clipId, patch, ripple = true) {
    const clip = project.clips.find(item => item.id === clipId);
    if (!clip) throw new Error('片段不存在');
    const before = ordered(project);
    const index = before.findIndex(item => item.id === clipId);
    const oldStart = clip.startMs;
    const oldEnd = endOf(clip);
    const movingRuns = ripple && Object.hasOwn(patch, 'startMs')
      ? foregroundRuns(project).filter(run => run.clips.length) : null;
    const movingRun = movingRuns?.find(run => run.clips.some(item => item.id === clipId));
    Object.assign(clip, patch);
    if (Object.hasOwn(patch, 'foregroundMs') && !Object.hasOwn(patch, 'commandOverride')
      && clip.commandOverride !== null && !isFixedAction(clip)) {
      const parsed = operations.fromCommands(parseCommands(clip.commandOverride));
      if (parsed?.length === 1 && parsed[0].type === clip.abilityId) clip.commandOverride = null;
    }
    clip.startMs = Math.max(0, Math.round(clip.startMs));
    clip.foregroundMs = Math.max(minimumForegroundMs(clip), Math.round(clip.foregroundMs));
    clip.effectMs = Math.max(0, Math.round(clip.effectMs));
    clip.cooldownMs = Math.max(0, Math.round(clip.cooldownMs));
    if (ripple && Object.hasOwn(patch, 'foregroundMs')) {
      const delta = endOf(clip) - clip.startMs - (oldEnd - oldStart);
      for (const next of before.slice(index + 1)) next.startMs = Math.max(0, next.startMs + delta);
    }
    if (movingRun?.clips.length === 1) {
      // A whole visit carries later steps after clamping its entry to the preceding locks.
      repairSchedule(project, false, before.slice(0, index + 1));
      const delta = clip.startMs - oldStart;
      for (const next of before.slice(index + 1)) next.startMs += delta;
    }
    if (ripple) {
      const sequence = movingRuns
        ? movingRuns.flatMap(run => ordered({clips: run.clips})) : before;
      repairSchedule(project, false, sequence, movingRuns ? clipId : null);
    }
    else if (Object.hasOwn(patch, 'startMs')) {
      const rows = ordered(project);
      consumeIdleTime(rows[rows.indexOf(clip) - 1], clip);
    }
    if (clip.followSourceId) {
      const parent = project.clips.find(item => item.id === clip.followSourceId);
      if (!parent || clip.startMs < actionEndOf(parent)) clip.followSourceId = null;
    }
    project.durationMs = Math.max(project.durationMs, ...project.clips.map(endOf));
    return clip;
  }

  function removeCharacter(project, characterId) {
    project.team = project.team.filter(id => id !== characterId);
    project.clips = project.clips.filter(clip => clip.characterId !== characterId);
    project.roleSlots = (project.roleSlots || []).filter(slot => slot.characterId !== characterId);
    const plan = teamTools?.hasTeams(project) ? teamTools.activeTeam(project) : null;
    if (plan) plan.roster = plan.roster.filter(id => id !== characterId);
  }

  function moveClips(project, clipIds, deltaMs) {
    const ids = new Set(clipIds);
    const clips = project.clips.filter(clip => ids.has(clip.id));
    if (!clips.length) return;
    const delta = Math.max(Math.round(deltaMs), -Math.min(...clips.map(clip => clip.startMs)));
    for (const clip of clips) clip.startMs += delta;
    for (const clip of clips) {
      const parent = project.clips.find(item => item.id === clip.followSourceId);
      if (clip.followSourceId && (!parent || clip.startMs < actionEndOf(parent))) clip.followSourceId = null;
    }
    const rows = ordered(project);
    for (let i = 1; i < rows.length; i++) {
      if (ids.has(rows[i].id)) consumeIdleTime(rows[i - 1], rows[i]);
    }
    project.durationMs = Math.max(project.durationMs, ...project.clips.map(endOf),
      project.repeat ? minimumLoopMs(project) : 0);
  }

  function placementState(rows) {
    const state = {previous: null, releaseEnd: 0, lastSwitch: null};
    for (const clip of rows) advancePlacement(state, clip);
    return state;
  }

  function earliestPlacement(state, clip) {
    const previous = state.previous;
    if (!previous) return 0;
    const changing = previous.characterId !== clip.characterId;
    return Math.max(changing ? endOf(previous)
      : Math.max(actionEndOf(previous), previous.startMs + minimumForegroundMs(previous)),
    changing ? state.releaseEnd : 0,
    changing && state.lastSwitch !== null ? state.lastSwitch + SWITCH_COOLDOWN_MS : 0);
  }

  function advancePlacement(state, clip) {
    if (state.previous?.characterId !== clip.characterId) {
      if (state.previous) state.lastSwitch = clip.startMs;
      state.releaseEnd = 0;
    }
    state.previous = clip;
    state.releaseEnd = Math.max(state.releaseEnd, swapEndOf(clip));
  }

  // A selection is inserted as one unit. Its internal offsets never depend on
  // which member received the pointer; only unselected successors may ripple.
  function placeClips(project, clipIds, deltaMs, {ripple = true} = {}) {
    const ids = new Set(clipIds), rows = ordered(project);
    const selected = rows.filter(clip => ids.has(clip.id));
    if (!selected.length) return {deltaMs: 0, blocked: false};
    const first = selected[0], oldStart = first.startMs;
    const rest = rows.filter(clip => !ids.has(clip.id));
    const requested = Math.max(0, Math.round(oldStart + deltaMs));
    if (requested === oldStart) return {deltaMs: 0, blocked: false};
    const desiredIndex = rest.findIndex(clip =>
      clip.startMs > requested || clip.startMs === requested && deltaMs < 0);
    const insertion = desiredIndex < 0 ? rest.length : desiredIndex;
    const candidates = [];
    for (let index = 0; index <= rest.length; index++) {
      if (ripple && index !== insertion) continue;
      const prefix = rest.slice(0, index), suffix = rest.slice(index);
      const minimum = earliestPlacement(placementState(prefix), first);
      let start = Math.max(minimum, requested);
      const preview = at => {
        const state = placementState(prefix);
        for (const clip of selected) {
          const moved = {...clip, startMs: clip.startMs + at - oldStart};
          if (moved.startMs < earliestPlacement(state, moved)) return null;
          advancePlacement(state, moved);
        }
        return state;
      };
      let state = preview(start);
      if (!state) continue;
      if (!ripple && suffix.length) {
        const overflow = earliestPlacement(state, suffix[0]) - suffix[0].startMs;
        if (overflow > 0) { start -= overflow; state = preview(start); }
      }
      if (!state || start < minimum || start < 0 || !Number.isFinite(start)
        || !ripple && suffix.length && earliestPlacement(state, suffix[0]) > suffix[0].startMs) continue;
      candidates.push({index, delta: start - oldStart, distance: Math.abs(start - requested)});
    }
    candidates.sort((a, b) => a.distance - b.distance ||
      (deltaMs < 0 ? a.index - b.index : b.index - a.index));
    const candidate = candidates[0];
    if (!candidate) return {deltaMs: 0, blocked: true};
    for (const clip of selected) clip.startMs += candidate.delta;
    const sequence = [...rest.slice(0, candidate.index), ...selected, ...rest.slice(candidate.index)];
    if (ripple) repairSchedule(project, false, sequence, selected.at(-1).id);
    else for (let i = 1; i < sequence.length; i++) consumeIdleTime(sequence[i - 1], sequence[i]);
    for (const clip of project.clips) {
      const parent = project.clips.find(item => item.id === clip.followSourceId);
      if (clip.followSourceId && (!parent || parent.characterId !== clip.characterId
        || clip.startMs < actionEndOf(parent))) clip.followSourceId = null;
    }
    project.durationMs = Math.max(project.durationMs, ...project.clips.map(endOf),
      project.repeat ? minimumLoopMs(project) : 0);
    return {deltaMs: candidate.delta, blocked: false};
  }

  function snapMove(project, clipIds, deltaMs, {anchorId, stepMs = 100, thresholdMs = 0, markers = []} = {}) {
    const ids = new Set(clipIds);
    const clips = ordered(project).filter(clip => ids.has(clip.id));
    if (!clips.length) return {deltaMs: 0, guideMs: null};
    const first = clips[0], last = clips.at(-1);
    const anchor = clips.find(clip => clip.id === anchorId) || first;
    const minimumDelta = -first.startMs;
    const gridDelta = Math.max(minimumDelta, snap(anchor.startMs + deltaMs, stepMs) - anchor.startMs);
    const busyEnd = clip => Math.max(actionEndOf(clip), clip.startMs + minimumForegroundMs(clip));
    let closest = null;
    const consider = (edgeMs, targetMs, guideMs = targetMs) => {
      const delta = targetMs - edgeMs;
      const distance = Math.abs(delta - deltaMs);
      if (delta >= minimumDelta && distance <= thresholdMs && (!closest || distance < closest.distance)) {
        closest = {deltaMs: delta, guideMs, distance};
      }
    };
    const rest = ordered(project).filter(clip => !ids.has(clip.id));
    const proposed = Math.max(0, first.startMs + deltaMs);
    let index = rest.findIndex(clip => clip.startMs > proposed || clip.startMs === proposed && deltaMs < 0);
    if (index < 0) index = rest.length;
    const previous = rest[index - 1], next = rest[index];
    const entry = earliestPlacement(placementState(rest.slice(0, index)), first);
    const leading = () => { if (previous) consider(first.startMs, entry); };
    const trailing = () => {
      if (!next) return;
      const tail = next.characterId === last.characterId ? busyEnd(last) : endOf(last);
      let shift = next.startMs - tail;
      const state = placementState(rest.slice(0, index));
      for (const clip of clips) advancePlacement(state, {...clip, startMs: clip.startMs + shift});
      shift -= Math.max(0, earliestPlacement(state, next) - next.startMs);
      if (first.startMs + shift >= entry) consider(first.startMs, first.startMs + shift, next.startMs);
    };
    if (deltaMs < 0) { leading(); trailing(); } else { trailing(); leading(); }
    for (const marker of new Set([0, project.durationMs, ...markers])) {
      consider(first.startMs, marker);
      consider(busyEnd(last), marker);
    }
    return closest ? {deltaMs: closest.deltaMs, guideMs: closest.guideMs} : {deltaMs: gridDelta, guideMs: null};
  }

  function foregroundRuns(project) {
    const runs = [];
    for (const clip of ordered(project)) {
      let run = runs.at(-1);
      if (!run || run.characterId !== clip.characterId) {
        if (run) run.endMs = clip.startMs;
        run = {id: clip.id, characterId: clip.characterId, startMs: clip.startMs, clips: []};
        runs.push(run);
      }
      run.clips.push(clip);
    }
    const last = runs.at(-1);
    const returning = loopReturn(project);
    if (last) last.endMs = Math.max(endOf(last.clips.at(-1)),
      returning?.startMs ?? project.durationMs);
    if (returning) runs.push({id: 'loop-return', characterId: returning.characterId,
      startMs: returning.startMs, endMs: project.durationMs, clips: []});
    return runs;
  }

  function resizeForegroundRun(project, runId, endMs, ripple = true) {
    const runs = foregroundRuns(project);
    const index = runs.findIndex(run => run.id === runId);
    const run = runs[index], tail = run?.clips.at(-1);
    if (!tail) throw new Error('站场区域不存在');
    const next = runs[index + 1];
    const returning = loopReturn(project);
    const minimum = Math.max(isFixedAction(tail) ? tail.startMs + minimumForegroundMs(tail) : actionEndOf(tail),
      ...run.clips.map(swapEndOf),
      index > 0 && (next || returning) ? run.startMs + SWITCH_COOLDOWN_MS : 0);
    const boundary = Math.max(minimum, Math.round(endMs));
    const delta = boundary - run.endMs;

    if (!isFixedAction(tail)) {
      const following = ripple ? ordered(project).slice(ordered(project).indexOf(tail) + 1) : next?.clips || [];
      for (const clip of following) clip.startMs += delta;
      if (ripple) repairSchedule(project);
      project.durationMs = Math.max(project.durationMs, ...project.clips.map(endOf));
    } else {
      // The shared handle belongs to the visible stay, including its trailing idle gap.
      tail.foregroundMs = Math.max(minimumForegroundMs(tail), run.endMs - tail.startMs);
      if (!ripple && next?.clips.length) {
        for (const clip of next.clips) clip.startMs += delta;
      }
      editClip(project, tail.id, {foregroundMs: boundary - tail.startMs}, ripple);
    }
    if (!next?.clips.length) {
      const minimumDuration = project.repeat ? minimumLoopMs(project)
        : Math.max(1000, ...project.clips.map(endOf));
      project.durationMs = Math.max(minimumDuration,
        boundary + (returning ? SWITCH_COOLDOWN_MS : 0));
    }
    return tail;
  }

  function idleIntervals(run) {
    const intervals = [];
    let cursor = run.startMs;
    for (const clip of run.clips) {
      if (clip.startMs > cursor) intervals.push({startMs: cursor, endMs: clip.startMs});
      cursor = Math.max(cursor, actionEndOf(clip));
    }
    if (run.endMs > cursor) intervals.push({startMs: cursor, endMs: run.endMs});
    return intervals;
  }

  function switches(project, includeOpening = false) {
    let current = null;
    return ordered(project).flatMap(clip => {
      if (clip.characterId === current) return [];
      const opening = current === null;
      current = clip.characterId;
      if (opening && !includeOpening) return [];
      return [{startMs: clip.startMs, characterId: current, clipId: clip.id}];
    });
  }

  function loopReturn(project) {
    const rows = ordered(project), first = rows[0], last = rows.at(-1);
    if (!project.repeat || !first || first.characterId === last.characterId) return null;
    return {startMs: project.durationMs - SWITCH_COOLDOWN_MS,
      characterId: first.characterId, clipId: first.id, fromClipId: last.id};
  }

  function minimumLoopMs(project) {
    const rows = ordered(project);
    let minimum = Math.max(1000, ...rows.map(endOf), ...rows.map(swapEndOf));
    const changes = switches(project);
    if (loopReturn(project)) {
      minimum = Math.max(minimum + SWITCH_COOLDOWN_MS,
        (changes.at(-1)?.startMs || 0) + 2 * SWITCH_COOLDOWN_MS);
    } else if (changes.length > 1) {
      minimum = Math.max(minimum, changes.at(-1).startMs + SWITCH_COOLDOWN_MS - changes[0].startMs);
    }
    return minimum;
  }

  function validate(project, catalog = null, {teams = true} = {}) {
    if (teams && teamTools?.hasTeams(project) && !isText(project)) {
      return teamTools.validateTeams(project, catalog);
    }
    const issues = [];
    const rows = ordered(project);
    const issue = (code, message, clips = []) => issues.push({code, message, clipIds: clips.map(c => c.id)});
    if (!rows.length) issue('empty', '时间轴中还没有技能片段');
    if (!isText(project) && project.scheduling !== 'original' && project.team.length > 4) issue('team', '队伍最多包含 4 名角色');
    const names = new Set();
    for (const clip of rows) {
      if (!project.team.includes(clip.characterId)) issue('team', '片段所属角色不在队伍中', [clip]);
      const emptyNativeName = project.scheduling === 'original' && clip.name === ''
        && read(clip.sourceAction, 'Name', null) === '';
      if (!isText(project) && !emptyNativeName && (!/^[\p{L}][\p{L}\p{N}-]*$/u.test(clip.name) || /^(true|false)$/i.test(clip.name)
        || ['t', 'count', 'since', 'min', 'max', 'e-ready', 'q-ready', 'onfield', 'e-cd', 'low-hp',
          'last-exec', 'battle-time', 'in-party', 'last-check'].includes(clip.name.toLowerCase()))) {
        issue('name', '片段名称需以文字开头，只能包含文字、数字或连字符', [clip]);
      }
      if (!isText(project) && project.scheduling === 'sequence' && names.has(clip.name.toLowerCase())) issue('name', '片段名称不能重复', [clip]);
      if (!isText(project) && (!Number.isInteger(priorityOf(clip))
        || !Array.isArray(prioritiesOf(clip)) || prioritiesOf(clip).some(priority =>
          !Number.isInteger(read(priority, 'Priority', 0))
          || typeof read(priority, 'Expression', null) !== 'string'))) {
        issue('priority', '优先级需要整数，替代条件需要有效表达式', [clip]);
      }
      names.add(clip.name.toLowerCase());
      if (!['none', 'skill', 'burst'].includes(clip.readiness ?? 'none')
        || !['wait', 'skip'].includes(clip.notReady ?? 'wait')) issue('condition', '技能就绪规则无效', [clip]);
      if (clip.followSourceId) {
        const parent = rows.find(item => item.id === clip.followSourceId);
        if (!parent || parent.characterId !== clip.characterId || actionEndOf(parent) > clip.startMs) {
          issue('condition', '前置技能需位于该动作之前', [clip]);
        }
      }
      let validCommand = true;
      try { commandsFor(clip); } catch (error) {
        validCommand = false;
        issue('command', error.message, [clip]);
      }
      if (![clip.startMs, clip.foregroundMs, clip.effectMs, clip.cooldownMs].every(Number.isFinite)
        || clip.startMs < 0 || clip.foregroundMs < 100 || clip.effectMs < 0 || clip.cooldownMs < 0) {
        issue('time', '片段时间无效', [clip]);
      }
      if (validCommand && clip.foregroundMs < minimumForegroundMs(clip)) {
        issue('cast-lock', `技能尚未解除换人锁定，至少占用 ${seconds(minimumForegroundMs(clip))} 秒`, [clip]);
      }
      if (endOf(clip) > project.durationMs) issue('range', '片段超过循环结束位置', [clip]);
      if (clip.castInputMs !== null && clip.castInputMs !== undefined
        && (!isCast(clip) || !Number.isFinite(clip.castInputMs) || clip.castInputMs < 100)) {
        issue('time', '技能输入恢复时间无效', [clip]);
      }
      const departure = rows.find(next => next.startMs > clip.startMs && next.characterId !== clip.characterId);
      if (isCast(clip) && clip.castInputMs !== null && departure && departure.startMs < swapEndOf(clip)) {
        issue('cast-lock', '技能的换人锁定尚未结束', [clip, departure]);
      }
    }
    let occupied = null;
    for (const clip of rows) {
      if (occupied && clip.startMs < endOf(occupied)) {
        issue('overlap', '前台动作重叠，同一时刻只能执行一个角色的动作', [occupied, clip]);
      }
      if (!occupied || endOf(clip) > endOf(occupied)) occupied = clip;
    }
    const changes = switches(project);
    for (let i = 1; i < changes.length; i++) {
      const delta = changes[i].startMs - changes[i - 1].startMs;
      if (delta < SWITCH_COOLDOWN_MS) issue('switch',
        `换人间隔 ${seconds(delta)} 秒，小于硬冷却 1 秒`,
        rows.filter(clip => [changes[i].clipId, changes[i - 1].clipId].includes(clip.id)));
    }
    const groups = new Map();
    for (const clip of rows.filter(item => item.cooldownMs > 0)) {
      const key = `${clip.characterId}:${clip.abilityId}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(clip);
    }
    for (const casts of groups.values()) {
      for (let i = 1; i < casts.length; i++) {
        if (casts[i].startMs - casts[i - 1].startMs < casts[i - 1].cooldownMs) {
          issue('cooldown', '同一技能的再次释放早于冷却结束', [casts[i - 1], casts[i]]);
        }
      }
      if (project.repeat && casts.length) {
        const first = casts[0], last = casts.at(-1);
        if (project.durationMs + first.startMs - last.startMs < last.cooldownMs) {
          issue('cooldown-loop', '下一轮的技能释放早于上一轮冷却结束', [last, first]);
        }
      }
    }
    const returnEntry = loopReturn(project);
    if (returnEntry) {
      const last = changes.at(-1);
      if (returnEntry.startMs < Math.max(...rows.map(endOf)) ||
        (last && returnEntry.startMs - last.startMs < SWITCH_COOLDOWN_MS)) {
        issue('switch-loop', '末尾需留出回到首个角色及其 1 秒换人冷却', [rows.at(-1), rows[0]]);
      }
    } else if (project.repeat && changes.length > 1) {
      const last = changes.at(-1), next = changes[0];
      if (project.durationMs + next.startMs - last.startMs < SWITCH_COOLDOWN_MS) {
        issue('switch-loop', '循环衔接处的换人间隔小于 1 秒',
          rows.filter(clip => [last.clipId, next.clipId].includes(clip.id)));
      }
    }
    if (isProcess(project)) {
      for (const item of issues) {
        if (['cooldown', 'cooldown-loop'].includes(item.code)) {
          item.severity = 'warning';
          item.message += '（参考排布；按步骤执行时请以就绪条件为准）';
        }
      }
    }
    if (!isText(project) && project.scheduling === 'original') {
      for (const item of issues) {
        if (['overlap', 'cooldown', 'cooldown-loop', 'switch', 'switch-loop', 'cast-lock'].includes(item.code)) {
          item.severity = 'warning';
          item.message += '（条件策略的时间位置仅供参考）';
        }
      }
    }
    if (isText(project)) {
      for (const clip of rows) {
        try { api.parseRounds(clip.txtRounds || ''); }
        catch (error) { issue('round', error.message, [clip]); }
        if (!['direct', 'wait', 'fast'].includes(clip.txtSkillPolicy || 'direct')) {
          issue('command', 'TXT 战技策略无效', [clip]);
        }
      }
    }
    return [...issues, ...(roleTools?.validateRoles(project, catalog) || []),
      ...(teams ? teamTools?.validateTeams(project, catalog) || [] : [])];
  }

  function fitLoop(project) {
    repairSchedule(project, !isProcess(project));
    let minimum = minimumLoopMs(project);
    const groups = new Map();
    for (const clip of ordered(project).filter(item => item.cooldownMs > 0)) {
      const key = `${clip.characterId}:${clip.abilityId}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(clip);
    }
    for (const casts of isProcess(project) ? [] : groups.values()) {
      minimum = Math.max(minimum, casts.at(-1).startMs + casts.at(-1).cooldownMs - casts[0].startMs);
    }
    project.durationMs = Math.ceil(minimum / 100) * 100;
    return project;
  }

  function effectEnd(project, clip) {
    const natural = clip.startMs + clip.effectMs;
    if (clip.effectPolicy !== 'onfield') return natural;
    const departure = ordered(project).find(item =>
      item.startMs > clip.startMs && item.characterId !== clip.characterId);
    let end = Math.min(natural, departure?.startMs ?? Infinity);
    if (project.repeat && project.clips.length) {
      const returnEntry = loopReturn(project);
      if (returnEntry && returnEntry.characterId !== clip.characterId) end = Math.min(end, returnEntry.startMs);
      const firstDifferent = ordered(project).find(item => item.characterId !== clip.characterId);
      if (firstDifferent) end = Math.min(end, project.durationMs + firstDifferent.startMs);
    }
    return end;
  }

  function stateAt(project, timeMs, includePreviousCycle = false) {
    const rows = ordered(project);
    const active = rows.filter(clip => clip.startMs <= timeMs).at(-1);
    const returnEntry = loopReturn(project);
    const foregroundId = returnEntry && timeMs >= returnEntry.startMs ? returnEntry.characterId : active?.characterId ||
      (includePreviousCycle && project.repeat ? returnEntry?.characterId || rows.at(-1)?.characterId : null);
    const candidates = includePreviousCycle && project.repeat
      ? [...rows.map(clip => ({clip, offset: -project.durationMs})), ...rows.map(clip => ({clip, offset: 0}))]
      : rows.map(clip => ({clip, offset: 0}));
    const statuses = project.team.map(characterId => {
      const skills = ['skill', 'burst'].map(abilityId => {
        const cast = candidates.filter(entry => entry.clip.characterId === characterId
          && entry.clip.abilityId === abilityId && entry.clip.startMs + entry.offset <= timeMs).at(-1);
        const elapsed = cast ? timeMs - cast.clip.startMs - cast.offset : null;
        const cooldownMs = cast ? Math.max(0, cast.clip.cooldownMs - elapsed) : 0;
        const effectMs = cast ? Math.max(0, effectEnd(project, cast.clip) + cast.offset - timeMs) : 0;
        return {abilityId, cooldownMs, effectMs, elapsedMs: elapsed};
      });
      return {characterId, onfield: characterId === foregroundId, skills};
    });
    return {timeMs, foregroundId, occupiedClipId: active && timeMs < endOf(active) ? active.id : null, statuses};
  }

  function commandsFor(clip) {
    if (clip.commandOverride !== null) return clip.commandOverride;
    if (operations.definitions.some(item => item.id === clip.abilityId)) return operations.commandsFor(clip,
      clip.protectCast === false ? {} : {castWait: operation =>
        timingFor(clip.characterId, operation.type, operation.hold)?.lockMs ?? null});
    const follow = clip.followAttack && clip.attackAfterMs > 0 ? `,attack(${seconds(clip.attackAfterMs)})` : '';
    if (clip.abilityId === 'skill') return (clip.hold ? 'skill(hold)' : 'skill') + follow;
    if (clip.abilityId === 'burst') return 'burst' + follow;
    if (clip.abilityId === 'attack') return `attack(${seconds(clip.foregroundMs)})`;
    if (clip.abilityId === 'charge') return `charge(${seconds(clip.foregroundMs)})`;
    throw new Error('片段技能类型无效');
  }

  function sequenceCondition(project, rows, index, extraCondition = rows[index].condition) {
    const clip = rows[index], previous = rows[index - 1], last = rows.at(-1);
    const own = `count(${clip.name})`;
    const gate = index === 0
      ? (project.repeat ? `${own} = count(${last.name})` : `${own} = 0`)
      : `count(${previous.name}) > ${own}`;
    // Count records are written when a whole action finishes. This prevents
    // a later eligible action from overtaking an earlier scheduled action.
    const earliest = `${own} * ${seconds(project.durationMs)} + ${seconds(clip.startMs)}`;
    const terms = [`(${gate})`, `(!(t() < ${earliest}))`];
    if (clip.guard) terms.push(`(${clip.guard})`);
    if (!project.repeat && index > 0) terms.push(`(${own} = 0)`);
    if (extraCondition.trim()) terms.push(`(${extraCondition.trim()})`);
    return terms.join(' && ');
  }

  function processActions(project, catalog, rows = ordered(project), {layout = null, owners = null} = {}) {
    const usedNames = new Set(rows.map(clip => clip.name.toLowerCase()));
    const indexes = new Map(rows.map((clip, index) => [clip.id, clip.priority ?? read(clip.sourceAction, 'Index', index)]));
    let nextIndex = Math.max(-1, ...indexes.values()) + 1;
    const entries = [], changes = [], clipEntries = new Map();
    let releaseGuards = [];
    const nameFor = prefix => {
      let name = prefix;
      while (usedNames.has(name.toLowerCase())) name += 'S';
      usedNames.add(name.toLowerCase());
      return name;
    };
    const append = (prefix, characterId, action, options = {}) => {
      const entry = {name: options.name ?? nameFor(prefix), characterId, action,
        condition: '', index: options.index ?? nextIndex++, ...options};
      entries.push(entry);
      return entry;
    };
    let current = rows[0]?.characterId;
    if (rows[0]?.startMs > 0) append('WaitOpening', null, `wait(${seconds(rows[0].startMs)})`);
    for (let index = 0; index < rows.length; index++) {
      const clip = rows[index], next = rows[index + 1];
      if (clip.characterId !== current) {
        if (layout) append(`ReleaseBefore${clip.id}`, null, 'wait(0.01)',
          {owner: current, guard: releaseGuards.join(' && ')});
        changes.push(append(`Switch${clip.id}`, clip.characterId, 'wait(0.01)',
          {type: 'switch', guard: layout ? '' : releaseGuards.join(' && ')}));
        releaseGuards = [];
        current = clip.characterId;
      }
      const readiness = clip.readiness === 'skill' ? `e-ready(${character(catalog, clip.characterId).name})`
        : clip.readiness === 'burst' ? `q-ready(${character(catalog, clip.characterId).name})` : '';
      const managedCast = isCast(clip) && clip.commandOverride === null;
      let command = commandsFor(clip);
      if (managedCast) {
        command = clip.abilityId === 'skill' ? clip.hold ? 'skill(hold)' : 'skill' : 'burst,ready';
        const protect = clip.castInputMs ?? (clip.followAttack ? attackStartMs(clip) : castLockMs(clip));
        if (clip.abilityId === 'skill' && clip.protectCast !== false && protect > 0) {
          command += `,wait(${seconds(protect)})`;
        }
      }
      const branchSource = clipEntries.get(clip.followSourceId);
      const entry = append(clip.name, clip.characterId, command, {
        name: clip.name, index: indexes.get(clip.id), clip,
        condition: clip.condition, readiness, ensureCast: clip.ensureCast,
        ...(branchSource ? {branchSource} : {})
      });
      clipEntries.set(clip.id, entry);
      entry.canSkip = Boolean(branchSource?.skipName || clip.notReady === 'skip' && (readiness || clip.condition.trim()));
      if (entry.canSkip || layout?.skipIds.has(clip.id)) {
        entry.skipName = nameFor(`Skip${clip.id}`);
      }
      if (managedCast && clip.protectCast !== false && clip.castInputMs !== null
        && castLockMs(clip) > clip.castInputMs) {
        releaseGuards.push(`!(since(${entry.name}) < ${seconds(castLockMs(clip) - clip.castInputMs)})`);
      }
      if (managedCast && clip.followAttack && clip.attackAfterMs > 0 || layout?.followIds.has(clip.id)) {
        append(`Attack${clip.id}`, clip.characterId,
          clip.followAttack && clip.attackAfterMs > 0 ? `attack(${seconds(clip.attackAfterMs)})` : 'wait(0.01)', {
          branchSource: entry,
          ...(entry.skipName ? {skipName: nameFor(`SkipAttack${clip.id}`)} : {})
        });
        const remainingLock = clip.protectCast === false ? 0
          : Math.max(0, (castLockMs(clip) || 0) - attackStartMs(clip) - clip.attackAfterMs);
        if (remainingLock > 0 || layout?.followReleaseIds.has(clip.id)) {
          append(`Release${clip.id}`, null, `wait(${seconds(Math.max(10, remainingLock))})`, {
          owner: clip.characterId, branchSource: entry,
          ...(entry.skipName ? {skipName: nameFor(`SkipRelease${clip.id}`)} : {})
          });
        }
      }
      const boundary = next?.startMs ?? loopReturn(project)?.startMs ?? project.durationMs;
      let idle = Math.max(0, boundary - actionEndOf(clip));
      const parent = rows.find(row => row.id === clip.followSourceId);
      const remainingLock = parent?.protectCast === false ? 0
        : Math.min(idle, Math.max(0, parent ? swapEndOf(parent) - actionEndOf(clip) : 0));
      if (remainingLock > 0 && branchSource || layout?.sourceReleaseIds.has(clip.id)) {
        const releaseId = layout ? `Source${clip.id}` : parent.id;
        append(`Release${releaseId}`, null, `wait(${seconds(Math.max(10, remainingLock))})`, {
          owner: clip.characterId, canSkip: Boolean(branchSource?.skipName), ...(branchSource ? {branchSource} : {}),
          ...(branchSource?.skipName || layout ? {skipName: nameFor(`SkipRelease${releaseId}`)} : {})
        });
        idle -= remainingLock;
      }
      if (idle > 0 || layout?.idleIds.has(clip.id)) {
        append(`Wait${clip.id}`, null, `wait(${seconds(Math.max(10, idle))})`, {owner: clip.characterId});
      }
    }
    const returning = loopReturn(project);
    if (returning) {
      if (layout) append('ReleaseBeforeLoopReturn', null, 'wait(0.01)',
        {owner: current, guard: releaseGuards.join(' && ')});
      changes.push(append('SwitchLoopReturn', returning.characterId, 'wait(0.01)',
        {type: 'switch', guard: layout ? '' : releaseGuards.join(' && ')}));
    }
    for (let index = 0; index < changes.length; index++) {
      const previous = changes[index - 1] || (project.repeat ? changes.at(-1) : null);
      if (previous) changes[index].guard = [changes[index].guard, `!(since(${previous.name}) < 1)`]
        .filter(Boolean).join(' && ');
    }
    if (returning && entries.length) entries[0].guard = `!(since(${changes.at(-1).name}) < 1)`;
    const completed = entry => entry.skipName
      ? `(count(${entry.name}) + count(${entry.skipName}))` : `count(${entry.name})`;
    const trigger = (entry, condition = entry.condition) =>
      [entry.readiness, condition?.trim()].filter(Boolean).map(term => `(${term})`).join(' && ') || 'true';
    const result = [];
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index], own = completed(entry), previous = entries[index - 1];
      const dependency = index === 0
        ? project.repeat ? `${own} = ${completed(entries.at(-1))}` : `${own} = 0`
        : `${completed(previous)} > ${own}`;
      const gate = [dependency, !project.repeat && `${own} = 0`, entry.guard].filter(Boolean)
        .map(term => `(${term})`).join(' && ');
      const source = clone(entry.clip?.sourceAction || {});
      for (const key of Object.keys(source)) {
        if (/^(name|character|action|condition|index|ensurecast|morepriorities)$/i.test(key)) delete source[key];
      }
      const originalCondition = clone(read(entry.clip?.sourceAction, 'Condition', {}));
      for (const key of Object.keys(originalCondition)) if (/^expression$/i.test(key)) delete originalCondition[key];
      const priorities = clone(entry.clip ? prioritiesOf(entry.clip) : []);
      const alternatives = priorities.map(priority => read(priority, 'Expression', ''));
      for (let priorityIndex = 0; priorityIndex < priorities.length; priorityIndex++) {
        const priority = priorities[priorityIndex];
        for (const key of Object.keys(priority)) if (/^expression$/i.test(key)) delete priority[key];
        priority.Expression = `${gate} && (${trigger(entry, alternatives[priorityIndex])})`;
      }
      const branch = entry.branchSource;
      const expression = branch ? `count(${branch.name}) > count(${entry.name})` : trigger(entry);
      result.push({...source, Name: entry.name,
        Character: entry.characterId ? character(catalog, entry.characterId).name : '',
        Action: entry.action, Condition: {...originalCondition, Expression: `${gate} && (${expression})`},
        Index: entry.index, EnsureCast: entry.ensureCast || false, MorePriorities: priorities});
      owners?.set(entry.name, entry.owner ?? entry.characterId);
      if (entry.skipName) {
        const skip = entry.canSkip === false ? 'false'
          : branch ? `count(${branch.skipName}) > count(${entry.skipName})`
            : `!(${[trigger(entry), ...alternatives.map(condition => trigger(entry, condition))].join(' || ')})`;
        result.push({Name: entry.skipName, Character: '', Action: 'wait(0.01)',
          Condition: {Expression: `${gate} && (${skip})`}, Index: nextIndex++,
          EnsureCast: false, MorePriorities: []});
        owners?.set(entry.skipName, entry.owner ?? entry.characterId);
      }
    }
    return result;
  }

  function exportStrategy(project, catalog, {embedProject = true,
    compilerVersion = null, check = true, teamScope = true} = {}) {
    if (isText(project)) throw new Error('当前为 TXT 模式，请导出 TXT 战斗策略');
    if (teamScope && teamTools?.hasTeams(project)) {
      return teamTools.exportTeams(project, catalog, {embedProject, check});
    }
    compilerVersion ??= roleTools.hasCompatibility(project) ? 4 : 3;
    const issues = validate(project, catalog, {teams: false}).filter(issue => issue.severity !== 'warning');
    if (check && issues.length) throw new Error(issues[0].message);
    const rows = project.scheduling === 'original' ? declared(project) : ordered(project);
    const strategy = clone(project.sourceRoot || {});
    const info = clone(project.sourceInfo || {});
    for (const key of Object.keys(strategy)) if (/^(info|actions)$/i.test(key)) delete strategy[key];
    for (const key of Object.keys(info)) if (/^(name|author|preactions|config)$/i.test(key)) delete info[key];
    const originalConfig = clone(read(project.sourceInfo, 'Config', {}));
    if (originalConfig && typeof originalConfig === 'object') delete originalConfig.CombatTimeline;
    const config = originalConfig && !Array.isArray(originalConfig) && typeof originalConfig === 'object'
      ? originalConfig : {};
    if (embedProject) config.CombatTimeline = {version: 1, compilerVersion, project: clone(project)};
    strategy.Info = {...info, Name: project.name, Author: project.author, PreActions: clone(project.preActions), Config: config};
    if (compilerVersion >= 3 && isProcess(project)) {
      strategy.Actions = compilerVersion >= 4 && roleTools.hasCompatibility(project)
        ? roleTools.compatibleActions(project, catalog) : processActions(project, catalog, rows);
      if (check && strategy.Actions.length > 800) throw new Error('兼容分支导出超过 800 个动作，请减少兼容角色或动作');
      return strategy;
    }
    const indices = new Map(rows.map((clip, index) => [clip.id, clip.priority ?? read(clip.sourceAction, 'Index', index)]));
    let switchIndex = Math.max(-1, ...indices.values()) + 1;
    const usedNames = new Set(rows.map(clip => clip.name));
    const entries = [];
    let current = compilerVersion === 1 ? null : rows[0]?.characterId;
    const switchEntries = [];
    for (const clip of rows) {
      if (project.scheduling === 'sequence' && clip.characterId !== current) {
        let name = `Switch${clip.id}`;
        while (usedNames.has(name)) name += 'S';
        usedNames.add(name);
        const entry = {type: 'switch', name, characterId: clip.characterId,
          startMs: clip.startMs, condition: '', index: switchIndex++};
        switchEntries.push(entry);
        entries.push(entry);
        current = clip.characterId;
      }
      entries.push({...clip, type: 'skill'});
    }
    const returnEntry = compilerVersion >= 2 ? loopReturn(project) : null;
    if (project.scheduling === 'sequence' && returnEntry) {
      let name = 'SwitchLoopReturn';
      while (usedNames.has(name)) name += 'S';
      const entry = {type: 'switch', name, characterId: returnEntry.characterId,
        startMs: returnEntry.startMs, condition: '', index: switchIndex++};
      switchEntries.push(entry);
      entries.push(entry);
      entries[0].guard = `!(since(${name}) < 1)`;
    }
    // A separate switch action records the confirmed switch time. Its history
    // makes the one-second rule hold even when earlier skills run slower than
    // their estimated occupancy and the schedule falls behind.
    for (let i = 0; i < switchEntries.length; i++) {
      const previous = switchEntries[i - 1] || (project.repeat ? switchEntries.at(-1) : null);
      if (previous) switchEntries[i].condition = `!(since(${previous.name}) < 1)`;
    }
    strategy.Actions = entries.map((clip, index) => {
      if (clip.type === 'switch') {
        return {Name: clip.name, Character: character(catalog, clip.characterId).name,
          Action: 'wait(0.01)', Condition: {Expression: sequenceCondition(project, entries, index)},
          Index: clip.index, EnsureCast: false, MorePriorities: []};
      }
      const source = clone(clip.sourceAction || {});
      for (const key of Object.keys(source)) {
        if (/^(name|character|action|condition|index|ensurecast|morepriorities)$/i.test(key)) delete source[key];
      }
      const originalCondition = clone(read(clip.sourceAction, 'Condition', {}));
      for (const key of Object.keys(originalCondition)) if (/^expression$/i.test(key)) delete originalCondition[key];
      const expression = project.scheduling === 'original' ? clip.condition : sequenceCondition(project, entries, index);
      const priorities = clone(prioritiesOf(clip));
      if (project.scheduling === 'sequence') {
        for (const entry of priorities) {
          const prior = read(entry, 'Expression', '');
          for (const key of Object.keys(entry)) if (/^expression$/i.test(key)) delete entry[key];
          entry.Expression = sequenceCondition(project, entries, index, prior);
        }
      }
      const characterName = project.scheduling === 'original'
        ? read(clip.sourceAction, 'Character', character(catalog, clip.characterId).name)
        : character(catalog, clip.characterId).name;
      return {...source, Name: clip.name, Character: characterName,
        Action: commandsFor(clip), Condition: {...originalCondition, Expression: expression},
        Index: indices.get(clip.id),
        EnsureCast: clip.ensureCast, MorePriorities: priorities};
    });
    return strategy;
  }

  function parseCommands(text) {
    const commands = [];
    let depth = 0, start = 0;
    for (let i = 0; i <= text.length; i++) {
      const char = text[i];
      if (char === '(') depth++;
      if (char === ')') depth--;
      if (depth < 0) throw new Error('动作指令括号不匹配');
      if ((char === ',' && depth === 0) || i === text.length) {
        const raw = text.slice(start, i).trim();
        if (raw) {
          const open = raw.indexOf('(');
          if (open >= 0 && !raw.endsWith(')')) throw new Error('动作指令括号不匹配');
          commands.push({method: (open < 0 ? raw : raw.slice(0, open)).trim().toLowerCase(),
            args: open < 0 ? [] : raw.slice(open + 1, -1).split(',').map(value => value.trim()), raw});
        }
        start = i + 1;
      }
    }
    if (depth !== 0) throw new Error('动作指令括号不匹配');
    return commands;
  }

  function normalizeProject(value, catalog, {separateActions = true, allowActorPool = false} = {}) {
    if (value.format !== 'betterbgi-combat-timeline' || value.version !== 1
      || !Array.isArray(value.team) || !Array.isArray(value.clips)) throw new Error('不是支持的时间轴工程');
    const project = {...emptyProject(), ...clone(value)};
    if (!['json', 'txt'].includes(project.strategyFormat)) throw new Error('战斗策略格式无效');
    if (isText(project)) project.scheduling = 'sequence';
    project.execution = isText(project) ? 'process' : value.execution ?? 'timeline';
    if (!['process', 'timeline'].includes(project.execution)) throw new Error('工程调度方式无效');
    project.team = project.team.map(String);
    if ((!isText(project) && project.scheduling !== 'original' && project.team.length > 4
      && !allowActorPool && !teamTools?.hasTeams(value))
      || new Set(project.team).size !== project.team.length) throw new Error('队伍配置无效');
    for (const id of project.team) character(catalog, id);
    const ids = new Set();
    const legacyDeclaration = new Map(ordered(project).map((clip, index) => [clip.id, index]));
    for (const clip of project.clips) {
      clip.declarationOrder ??= legacyDeclaration.get(clip.id);
      character(catalog, clip.characterId);
      if (clip.commandOverride === null || clip.commandOverride === undefined) {
        ability(catalog, clip.characterId, clip.abilityId);
      }
      if (ids.has(clip.id)) throw new Error('工程中的片段标识重复');
      ids.add(clip.id);
      if (![clip.startMs, clip.foregroundMs, clip.effectMs, clip.cooldownMs].every(Number.isFinite)) {
        throw new Error('工程中的时间无效');
      }
      clip.commandOverride ??= null;
      clip.sourceAction ??= null;
      clip.condition ??= '';
      clip.followAttack ??= false;
      clip.attackAfterMs ??= 0;
      clip.readiness ??= 'none';
      clip.notReady ??= 'wait';
      clip.protectCast ??= true;
      clip.txtSkillPolicy ??= 'direct';
      clip.txtRounds ??= '';
      clip.txtReady ??= false;
      clip.operation ??= operations.parameters(clip.abilityId);
      clip.operations ??= clip.abilityId === 'combo' && clip.commandOverride === null ? operations.template() : [];
      if (clip.castTiming === undefined) {
        const timing = timingFor(clip.characterId, clip.abilityId, clip.hold);
        clip.castTiming = timing ? clone(timing) : null;
      }
      clip.lockOverrideMs ??= null;
      clip.castInputMs ??= null;
      clip.followSourceId ??= null;
      const preset = abilities(catalog, clip.characterId).find(skill => skill.id === clip.abilityId);
      clip.castEstimateMs ??= preset?.foregroundMs ?? 0;
      if (!clip.effectSource && preset) {
        clip.effectMs = preset.effectMs;
        clip.effectSource = 'catalog';
      }
    }
    if (!Number.isFinite(project.durationMs) || project.durationMs < 1000) throw new Error('循环长度无效');
    project.nextId = Math.max(project.nextId || 1, project.clips.length + 1,
      ...project.clips.map(clip => (Number(clip.id.replace(/^clip/, '')) || 0) + 1));
    roleTools.normalizeRoles(project, catalog);
    if (separateActions) separateFollowAttacks(project, catalog);
    return teamTools?.normalizeTeams(project, catalog) || project;
  }

  function importStrategy(value, catalog, {strategyFormat = 'json'} = {}) {
    if (value.format === 'betterbgi-combat-timeline') return normalizeProject(value, catalog);
    const info = read(value, 'Info', {});
    const embedded = read(read(info, 'Config', {}), 'CombatTimeline', null);
    if (embedded?.version === 1) {
      const saved = normalizeProject(embedded.project, catalog, {separateActions: false});
      const expected = exportStrategy(saved, catalog,
        {embedProject: false, compilerVersion: embedded.compilerVersion || 1, check: false});
      if (JSON.stringify(stableData(read(value, 'Actions', []))) === JSON.stringify(stableData(expected.Actions))) {
        saved.name = read(info, 'Name', saved.name);
        saved.author = read(info, 'Author', saved.author);
        saved.preActions = clone(read(info, 'PreActions', saved.preActions));
        saved.sourceRoot = clone(value);
        for (const key of Object.keys(saved.sourceRoot)) if (/^(info|actions)$/i.test(key)) delete saved.sourceRoot[key];
        for (const [key, item] of Object.entries(info)) {
          if (!/^(name|author|preactions|config)$/i.test(key)) saved.sourceInfo[key] = clone(item);
        }
        const incomingConfig = clone(read(info, 'Config', {}));
        delete incomingConfig.CombatTimeline;
        const priorConfig = read(saved.sourceInfo, 'Config', {});
        if (JSON.stringify(stableData(incomingConfig)) !== JSON.stringify(stableData(priorConfig))) {
          for (const key of Object.keys(saved.sourceInfo)) if (/^config$/i.test(key)) delete saved.sourceInfo[key];
          saved.sourceInfo.Config = incomingConfig;
        }
        if (teamTools?.hasTeams(saved)) {
          for (const plan of saved.teamPlans) {
            if (plan.id === saved.activeTeamId) continue;
            plan.project.preActions = clone(saved.preActions);
            plan.project.sourceRoot = clone(saved.sourceRoot);
            plan.project.sourceInfo = clone(saved.sourceInfo);
          }
          teamTools.syncTeams(saved);
        }
        return separateFollowAttacks(saved, catalog);
      }
    }
    const actions = read(value, 'Actions', null);
    if (!Array.isArray(actions) || !actions.length) throw new Error('JSON 中没有战斗动作');
    const declarationOrder = new Map(actions.map((action, index) => [action, index]));
    const project = emptyProject();
    project.strategyFormat = strategyFormat;
    project.name = read(info, 'Name', '导入的战斗策略');
    project.author = read(info, 'Author', '');
    project.preActions = clone(read(info, 'PreActions', []));
    project.sourceInfo = clone(info);
    const sourceConfigKey = Object.keys(project.sourceInfo).find(key => /^config$/i.test(key));
    if (sourceConfigKey) delete project.sourceInfo[sourceConfigKey].CombatTimeline;
    project.sourceRoot = clone(value);
    for (const key of Object.keys(project.sourceRoot)) if (/^(info|actions)$/i.test(key)) delete project.sourceRoot[key];
    project.scheduling = strategyFormat === 'txt' ? 'sequence' : 'original';
    project.repeat = false;
    const firstCharacter = actions.map(action => read(action, 'Character', '')).find(name =>
      catalog.characters.some(avatar => avatar.name === name || avatar.aliases.includes(name)));
    let cursor = 0, currentCharacter = firstCharacter || null;
    for (const action of [...actions].sort((a, b) => read(a, 'Index', 0) - read(b, 'Index', 0))) {
      const rawName = read(action, 'Character', '') || currentCharacter || catalog.characters[0]?.name;
      const avatar = catalog.characters.find(item => item.name === rawName || item.aliases.includes(rawName));
      if (!avatar) throw new Error(`无法识别角色“${rawName || '当前角色'}”，请先在原 JSON 指定角色`);
      const text = read(action, 'Action', '');
      const commands = parseCommands(text);
      const first = commands.find(command => !['ready', '完成'].includes(command.method)) || commands[0];
      const modes = {e: 'skill', skill: 'skill', q: 'burst', burst: 'burst', attack: 'attack',
        普攻: 'attack', 普通攻击: 'attack', charge: 'charge', 重击: 'charge',
        walk: 'walk', w: 'walk', a: 'walk', s: 'walk', d: 'walk', dash: 'dash', jump: 'jump', j: 'jump',
        wait: 'wait', after: 'wait', 等待: 'wait', keypress: 'keypress', moveby: 'moveby',
        ready: 'ready', 完成: 'ready', check: 'check', 检测: 'check'};
      const simple = commands.length === 1 || ['skill', 'burst'].includes(modes[first?.method])
        && commands.slice(1).every(command => ['wait', 'after', 'ready', 'attack'].includes(command.method));
      const mode = simple ? modes[first?.method] || 'combo' : 'combo';
      const clip = addClip(project, catalog, avatar.id, mode, cursor, true);
      clip.name = read(action, 'Name', clip.name);
      clip.condition = read(read(action, 'Condition', {}), 'Expression', '');
      clip.sourceAction = clone(action);
      clip.priority = read(action, 'Index', 0);
      clip.declarationOrder = declarationOrder.get(action);
      clip.commandOverride = text;
      if (mode === 'combo') clip.operations = operations.fromCommands(commands) || [];
      clip.useCurrentCharacter = !read(action, 'Character', '');
      if (clip.useCurrentCharacter) {
        clip.effectMs = 0;
        clip.cooldownMs = 0;
        clip.effectPolicy = 'none';
      }
      clip.readiness = 'none';
      clip.ensureCast = false;
      if (mode === 'walk') clip.operation.direction = first.method === 'walk' ? first.args[0] : first.method;
      if (mode === 'keypress') clip.operation.keys = first.args[0];
      if (mode === 'moveby') Object.assign(clip.operation, {x: Number(first.args[0]), y: Number(first.args[1])});
      clip.hold = commands.some(command => ['skill', 'e'].includes(command.method) && command.args.includes('hold'));
      clip.castTiming = clip.useCurrentCharacter ? null : timingFor(clip.characterId, clip.abilityId, clip.hold);
      clip.ensureCast = read(action, 'EnsureCast', false);
      const timed = commands.reduce((sum, command) => {
        const parameter = command.method === 'walk' ? command.args[1] : command.args[0];
        return ['wait', 'after', '等待', 'attack', '普攻', '普通攻击', 'charge', '重击',
          'walk', 'w', 'a', 's', 'd', 'dash'].includes(command.method) && Number.isFinite(Number(parameter))
          ? sum + ms(parameter) : sum;
      }, 0);
      if (timed > 0) clip.foregroundMs = Math.max(100, timed + (['skill', 'burst'].includes(mode) ? clip.foregroundMs : 0));
      if (mode === 'combo') clip.castEstimateMs = clip.foregroundMs;
      currentCharacter = avatar.name;
      cursor = endOf(clip);
    }
    repairSchedule(project);
    project.durationMs = Math.max(1000, cursor, ...project.clips.map(endOf));
    return project;
  }

  function demoProject(catalog) {
    const project = emptyProject();
    project.name = '雷国 · 技能轮转';
    project.team = ['10000052', '10000025', '10000032', '10000023'];
    const clips = [
      ['10000052', 'skill', 0, 900],
      ['10000025', 'burst', 1000, 1300],
      ['10000025', 'skill', 2300, 1000],
      ['10000032', 'burst', 3300, 1200],
      ['10000032', 'skill', 4500, 700],
      ['10000023', 'burst', 5200, 1400],
      ['10000023', 'skill', 6600, 900],
      ['10000052', 'burst', 7500, 7000],
    ];
    for (const [id, mode, start, duration] of clips) {
      const clip = addClip(project, catalog, id, mode, start, false);
      clip.foregroundMs = Math.max(duration, minimumForegroundMs(clip));
    }
    const burst = project.clips.at(-1);
    burst.foregroundMs = Math.max(100, castDurationMs(burst));
    let cursor = actionEndOf(burst);
    for (const [mode, duration] of [['attack', 1500], ['wait', 200], ['attack', 1500], ['attack', 2000]]) {
      const clip = addClip(project, catalog, burst.characterId, mode, cursor, false);
      clip.startMs = cursor;
      clip.foregroundMs = duration;
      cursor += duration;
    }
    project.durationMs = 24000;
    repairSchedule(project);
    return project;
  }

  const api = {SWITCH_COOLDOWN_MS, clone, seconds, ms, ordered, declared, endOf, snap, character, ability, abilities,
    operations, isText, isProcess, priorityOf, prioritiesOf, isFixedAction, operationDurationMs,
    timingVariants, timingFor, castLockMs, castDurationMs, attackStartMs, actionDurationMs, actionEndOf,
    minimumForegroundMs, minimumLoopMs, loopReturn, foregroundRuns, resizeForegroundRun, idleIntervals, moveClips, placeClips, snapMove,
    emptyProject, makeClip, addClip, insertAfter, separateFollowAttacks, editClip, removeCharacter, repairSchedule, fitLoop, switches,
    validate, effectEnd, stateAt, commandsFor, sequenceCondition, processActions, exportStrategy, parseCommands,
    importStrategy, normalizeProject, demoProject};
  const createRoles = typeof module === 'object' && module.exports ? require('./roles.js') : root.CombatRoleFactory;
  roleTools = createRoles(api);
  Object.assign(api, roleTools);
  Object.assign(api, createFormats(api));
  const createTeams = typeof module === 'object' && module.exports ? require('./teams.js') : root.CombatTeamFactory;
  const conditions = typeof module === 'object' && module.exports ? require('./conditions.js') : root.CombatConditions;
  teamTools = createTeams(api, conditions);
  Object.assign(api, teamTools);
  const setFormat = api.setStrategyFormat;
  api.setStrategyFormat = (project, format) => {
    if (!teamTools.hasTeams(project)) return setFormat(project, format);
    teamTools.syncTeams(project);
    setFormat(project, format);
    for (const plan of project.teamPlans) {
      if (plan.id !== project.activeTeamId) setFormat(plan.project, format);
    }
    teamTools.syncTeams(project);
    return project;
  };
  const switchRole = api.switchRoleCharacter;
  api.switchRoleCharacter = (project, catalog, characterId, candidateId) => {
    const before = api.roleSlot(project, characterId).characterId;
    const result = switchRole(project, catalog, characterId, candidateId);
    const plan = teamTools.hasTeams(project) ? teamTools.activeTeam(project) : null;
    if (plan) plan.roster = plan.roster.map(id => id === before ? candidateId : id);
    return result;
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CombatTimeline = api;
})(globalThis);
