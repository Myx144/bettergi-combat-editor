(function() {
  'use strict';

  const M = window.CombatTimeline;
  const Ops = window.CombatOperations;
  const catalog = window.CombatCatalog;
  const $ = id => document.getElementById(id);
  const html = value => String(value ?? '').replace(/[&<>"']/g, char =>
    ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
  const icon = name => `<i data-lucide="${name}"></i>`;
  const time = value => M.seconds(value).toFixed(1);
  let storageKey = 'betterbgi.combat-timeline.v1';
  const palette = {雷: '#8972b2', 水: '#428cac', 火: '#c56b55', 风: '#499b87',
    草: '#829b43', 岩: '#b49438', 冰: '#62a5b3'};
  const state = {project: null, selected: null, selection: [], libraryFocus: '10000052', libraryAbility: 'skill',
    search: '', element: '', zoom: 48, snap: true, step: 100, ripple: true, playing: false,
    playheadMs: 0, cycle: 1, speed: 1, hasLooped: false, undo: [], redo: [], drag: null,
    draggingCharacter: null, quickAdd: null, toastTimer: null, lastFrame: null,
    roster: null, ownedOnly: false, roleSwitcher: null};
  const mobileLayout = matchMedia('(max-width: 710px)');
  const mobileControls = [
    ['projectHeading', 'mobileProjectSlot'], ['strategyModeControl', 'mobileFormatSlot'], ['executionMode', 'mobileModeSlot'],
    ['libraryToggle', 'mobileLibrarySlot'], ['inspectorToggle', 'mobileInspectorSlot'],
    ['fitLoop', 'mobileFitLoopSlot'], ['undo', 'mobileUndoSlot'], ['redo', 'mobileRedoSlot'],
    ['zoomOut', 'mobileZoomOutSlot'], ['zoom', 'mobileZoomSlot'], ['zoomIn', 'mobileZoomInSlot'],
    ['fitView', 'mobileFitViewSlot'], ['snapToggle', 'mobileSnapSlot'], ['snapStep', 'mobileStepSlot'],
    ['rippleControl', 'mobileRippleSlot']
  ].map(([id, slot]) => {
    const node = $(id), marker = document.createComment(id);
    node.before(marker);
    return {node, marker, slot: $(slot)};
  });
  let isMobile = null, mobilePreviewKey = null;

  if (!M || !catalog) {
    $('timelineCanvas').textContent = '角色资料未能加载，请检查 catalog.js。';
    return;
  }

  try {
    const saved = localStorage.getItem(storageKey);
    state.project = saved ? M.normalizeProject(JSON.parse(saved), catalog) : M.demoProject(catalog);
  } catch {
    state.project = M.demoProject(catalog);
  }
  state.selected = state.project.clips[0]?.id || null;
  state.selection = state.selected ? [state.selected] : [];

  function icons() { window.lucide?.createIcons(); }
  function avatarHtml(character, className = '') {
    return character.avatar
      ? `<img src="${html(character.avatar)}" alt="${html(character.name)}" data-fallback="${html(character.name.slice(0, 1))}" class="${className}" draggable="false">`
      : `<span class="avatar-fallback ${className}" aria-label="${html(character.name)}">${html(character.name.slice(0, 1))}</span>`;
  }
  function skillImage(skill, className = '') {
    return skill.icon
      ? `<img src="${html(skill.icon)}" alt="" data-fallback="${html(skill.key)}" class="${className}" draggable="false">`
      : skill.iconName ? `<span class="${className} operation-icon">${icon(skill.iconName)}</span>`
        : `<span class="${className}">${html(skill.key)}</span>`;
  }
  function selectedClip() { return state.project.clips.find(clip => clip.id === state.selected); }
  function selectedClips() { return M.ordered(state.project).filter(clip => state.selection.includes(clip.id)); }
  function isSelected(id) { return state.selection.includes(id); }
  function setSelection(ids, primary = ids.at(-1)) {
    const valid = new Set(state.project.clips.map(clip => clip.id));
    state.selection = [...new Set(ids)].filter(id => valid.has(id));
    state.selected = state.selection.includes(primary) ? primary : state.selection[0] || null;
  }
  function selectedAbility(clip) {
    const skill = M.ability(catalog, clip.characterId, clip.abilityId);
    return clip.abilityId === 'attack' ? {...skill, name: '普攻'} : skill;
  }
  function labelWidth() { return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--label-width')); }
  function trackHeight() { return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--track-height')); }
  function clipHeight() { return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--clip-height')); }
  function syncMobileLayout() {
    if (isMobile === mobileLayout.matches) return;
    isMobile = mobileLayout.matches;
    for (const {node, marker, slot} of mobileControls) {
      if (isMobile) slot.append(node);
      else marker.after(node);
    }
    closePanels();
    closeQuickAdd();
    mobilePreviewKey = null;
  }
  function position(clientX) {
    return Math.max(0, (clientX - $('timelineCanvas').getBoundingClientRect().left - labelWidth()) / state.zoom * 1000);
  }
  function snapped(value) { return M.snap(value, state.snap ? state.step : 50); }
  function css(character) { return `--character-color:${character.color};--effect-color:${character.color}19`; }

  function toast(message, error = false) {
    clearTimeout(state.toastTimer);
    $('toast').textContent = message;
    $('toast').classList.toggle('error', error);
    $('toast').hidden = false;
    state.toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3400);
  }

  function persist() {
    try {
      localStorage.setItem(storageKey, JSON.stringify(state.project));
      $('saveState').textContent = '草稿已保存';
    } catch {
      $('saveState').textContent = '未保存草稿';
    }
  }

  function checkpoint(before) {
    if (JSON.stringify(before) === JSON.stringify(state.project)) return;
    state.undo.push(before);
    if (state.undo.length > 60) state.undo.shift();
    state.redo = [];
    persist();
  }

  function change(operation) {
    const before = M.clone(state.project);
    try {
      operation();
      checkpoint(before);
      paint();
    } catch (error) {
      state.project = before;
      toast(error.message, true);
      paint();
    }
  }

  function undo() {
    if (!state.undo.length) return;
    pause();
    state.redo.push(M.clone(state.project));
    state.project = state.undo.pop();
    setSelection(state.selection.length ? state.selection : [state.project.clips[0]?.id]);
    persist();
    paint();
  }

  function redo() {
    if (!state.redo.length) return;
    pause();
    state.undo.push(M.clone(state.project));
    state.project = state.redo.pop();
    setSelection(state.selection.length ? state.selection : [state.project.clips[0]?.id]);
    persist();
    paint();
  }

  function paintLibrary() {
    const query = state.search.trim().toLocaleLowerCase();
    const owned = new Map((state.roster?.characters || []).map(character => [String(character.id), character]));
    const list = catalog.characters.filter(character => (!state.element || state.element === character.element)
      && (!state.ownedOnly || !state.roster || owned.has(character.id))
      && [character.name, character.element, ...character.aliases].join(' ').toLocaleLowerCase().includes(query));
    $('catalogCount').textContent = `${state.ownedOnly && state.roster ? list.length : catalog.characters.length} 名`;
    $('elementFilters').innerHTML = ['', '火', '水', '风', '雷', '草', '冰', '岩'].map(element =>
      `<button type="button" data-element="${element}" class="${state.element === element ? 'selected' : ''}"
        style="--element:${palette[element] || '#7e8c9e'}" aria-label="${element || '全部'}元素"
        aria-pressed="${state.element === element}">${element || '全部'}</button>`).join('');
    for (const button of $('libraryMode').querySelectorAll('[data-mode]')) {
      const selected = button.dataset.mode === state.libraryAbility;
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-pressed', String(selected));
    }
    $('characterList').innerHTML = list.map(character => `
      <article class="character-tile ${state.libraryFocus === character.id ? 'selected' : ''}
        ${state.project.team.includes(character.id) ? 'in-team' : ''}" draggable="true"
        data-character="${character.id}" role="listitem" style="${css(character)}">
        <button class="character-select" type="button" data-select-character="${character.id}"
          title="${html(character.name)}" aria-label="选择${html(character.name)}">
          ${avatarHtml(character)}<span class="character-name">${html(character.name)}
            ${owned.has(character.id) ? `<small class="character-owned">等级 ${html(owned.get(character.id).level)}</small>` : ''}</span>
        </button>
        <button type="button" class="character-add" data-add-character="${character.id}"
          title="添加${html(character.name)}的技能" aria-label="添加${html(character.name)}的技能">${icon('plus')}</button>
      </article>`).join('') || '<div class="muted">没有匹配的角色</div>';
    const focus = catalog.characters.find(character => character.id === state.libraryFocus) || catalog.characters[0];
    $('librarySelection').style.cssText = css(focus);
    $('librarySelection').innerHTML = `<div class="library-selection-heading">
      <strong>${html(focus.name)}</strong><span class="element-tag">${focus.element} · ${focus.weapon}</span></div>
      ${focus.skills.slice(0, 2).map(skill => `<div class="skill-summary"><span class="skill-badge">${skillImage(skill)}</span>
        <div><strong>${html(skill.name)}</strong><small>${skill.key} · 冷却 ${time(skill.cooldownMs)}s
          ${skill.effectMs ? ` · 持续 ${time(skill.effectMs)}s` : ''}</small></div></div>`).join('')}`;
  }

  function closeRoleSwitcher(focus = false) {
    const id = state.roleSwitcher?.characterId;
    state.roleSwitcher = null;
    $('roleSwitcher').hidden = true;
    for (const button of document.querySelectorAll('[data-role-toggle]')) button.setAttribute('aria-expanded', 'false');
    if (focus && id) document.querySelector(`[data-role-toggle="${id}"]`)?.focus({preventScroll: true});
  }

  function openRoleSwitcher(characterId) {
    if (state.roleSwitcher?.characterId === characterId) { closeRoleSwitcher(true); return; }
    pause();
    closePanels();
    closeQuickAdd();
    state.roleSwitcher = {characterId, adding: false, search: ''};
    paintRoleSwitcher();
    document.querySelector(`[data-role-toggle="${characterId}"]`)?.setAttribute('aria-expanded', 'true');
    $('rolePosition').focus({preventScroll: true});
  }

  function paintRoleCandidates() {
    const open = state.roleSwitcher;
    if (!open || !open.adding) return;
    const slot = M.roleSlot(state.project, open.characterId);
    const selected = new Set(slot.candidates.map(candidate => candidate.characterId));
    const occupied = new Set(state.project.team.filter(id => id !== slot.characterId)
      .flatMap(id => M.roleSlot(state.project, id).candidates.map(candidate => candidate.characterId)));
    const owned = new Set((state.roster?.characters || []).map(character => String(character.id)));
    const query = open.search.trim().toLocaleLowerCase();
    const choices = catalog.characters.filter(character => !selected.has(character.id)
      && (!state.roster || !state.ownedOnly || owned.has(character.id))
      && [character.name, character.element, character.weapon, ...character.aliases].join(' ').toLocaleLowerCase().includes(query));
    $('roleCandidateList').innerHTML = choices.map(character => `<button type="button"
      data-role-add="${character.id}" ${occupied.has(character.id) ? 'disabled' : ''}
      title="${occupied.has(character.id) ? '已属于其他定位' : `添加并切换到${html(character.name)}`}">
        ${avatarHtml(character)}<span><strong>${html(character.name)}</strong>
          <small>${occupied.has(character.id) ? '其他定位' : `${html(character.element)} · ${html(character.weapon)}`}</small></span>
        ${icon('plus')}</button>`).join('') || '<p class="muted role-empty">没有匹配的角色</p>';
    icons();
  }

  function paintRoleSwitcher() {
    const open = state.roleSwitcher;
    if (!open) return;
    if (!state.project.team.includes(open.characterId)) { closeRoleSwitcher(); return; }
    const slot = M.roleSlot(state.project, open.characterId);
    const panel = $('roleSwitcher');
    const rows = M.ordered(state.project).filter(clip => clip.characterId === slot.characterId);
    panel.innerHTML = `<header class="role-switcher-heading"><strong>角色分支</strong>
      <span class="muted">${slot.candidates.length} 个</span>
      <button class="icon-button" type="button" data-role-close aria-label="收起角色分支" title="收起">${icon('x')}</button></header>
      <label class="role-position field"><span>定位</span><select id="rolePosition" aria-label="角色定位">
        ${M.roleDefinitions.map(role => `<option value="${role.id}" ${slot.role === role.id ? 'selected' : ''}>${role.name}</option>`).join('')}
      </select></label>
      <div class="role-tree"><span class="role-tree-root" aria-hidden="true">${icon('git-fork')}</span>
        <div class="role-branch-list">${slot.candidates.map((candidate, index) => {
          const character = M.character(catalog, candidate.characterId);
          const variants = rows.map(clip => M.roleClip(state.project, catalog, clip, candidate.characterId));
          const total = variants.reduce((sum, clip) => sum + M.actionDurationMs(clip), 0);
          const pending = variants.some(clip => ['skill', 'burst'].includes(clip.abilityId) && M.castLockMs(clip) === null);
          return `<div class="role-branch-item" style="${css(character)}">
            <button type="button" class="role-branch ${candidate.characterId === slot.characterId ? 'selected' : ''}"
              data-role-select="${candidate.characterId}" aria-pressed="${candidate.characterId === slot.characterId}"
              title="切换到${html(character.name)}的动作轴">
              ${avatarHtml(character)}<span class="role-branch-content"><span class="role-branch-name">
                <strong>${html(character.name)}</strong><small>优先 ${index + 1}</small></span>
                <span class="role-mini-axis" aria-hidden="true">${variants.map(clip => {
                  const skill = M.ability(catalog, candidate.characterId, clip.abilityId);
                  return `<i style="flex-grow:${M.actionDurationMs(clip) / Math.max(1, total)}"
                    title="${html(skill.name)}">${html(skill.key)}</i>`;
                }).join('')}</span><small>${variants.length} 步 · ${time(total)}s${pending ? ' · 含待实测' : ''}</small></span>
              ${candidate.characterId === slot.characterId ? icon('check') : icon('chevron-right')}
            </button><div class="role-branch-commands">
              <button type="button" class="icon-button" data-role-up="${candidate.characterId}" ${index === 0 ? 'disabled' : ''}
                title="提高${html(character.name)}优先级" aria-label="提高${html(character.name)}优先级">${icon('chevron-up')}</button>
              <button type="button" class="icon-button" data-role-down="${candidate.characterId}" ${index === slot.candidates.length - 1 ? 'disabled' : ''}
                title="降低${html(character.name)}优先级" aria-label="降低${html(character.name)}优先级">${icon('chevron-down')}</button>
              <button type="button" class="icon-button" data-role-remove="${candidate.characterId}" ${candidate.characterId === slot.characterId ? 'disabled' : ''}
                title="移除${html(character.name)}的兼容分支" aria-label="移除${html(character.name)}的兼容分支">${icon('x')}</button>
            </div></div>`;
        }).join('')}</div></div>
      <footer class="role-switcher-actions"><button type="button" data-role-adding
        aria-expanded="${open.adding}" ${M.isProcess(state.project) ? '' : 'disabled'}>${icon('plus')}<span>兼容角色</span></button>
        ${M.isProcess(state.project) ? '' : '<button type="button" data-role-process>按步骤推进</button>'}
      </footer>
      ${open.adding ? `<div class="role-candidate-picker"><label class="search-field">${icon('search')}
        <input id="roleCandidateSearch" type="search" value="${html(open.search)}" aria-label="搜索兼容角色" placeholder="搜索兼容角色"></label>
        <div id="roleCandidateList" class="role-candidate-list"></div></div>` : ''}`;
    panel.hidden = false;
    if (open.adding) paintRoleCandidates();
    icons();
    if (!isMobile) {
      const anchor = document.querySelector(`[data-role-toggle="${open.characterId}"]`)?.getBoundingClientRect();
      if (!anchor) { closeRoleSwitcher(); return; }
      panel.style.left = `${Math.max(10, Math.min(anchor.right + 9, innerWidth - panel.offsetWidth - 10))}px`;
      panel.style.top = `${Math.max(10, Math.min(anchor.top - 50, innerHeight - panel.offsetHeight - 10))}px`;
    } else {
      panel.style.left = '';
      panel.style.top = '';
    }
  }

  function paintTimeline() {
    const project = state.project;
    const conditional = !M.isText(project) && project.scheduling === 'original';
    const rowHeight = trackHeight(), actionHeight = clipHeight();
    const connectionY = 75 + actionHeight / 2;
    const rows = M.ordered(project);
    const runs = M.foregroundRuns(project);
    const runForClip = new Map(runs.flatMap(run => run.clips.map(clip => [clip.id, run])));
    const issues = M.validate(project, catalog);
    const errors = issues.filter(issue => issue.severity !== 'warning');
    const invalid = new Set(errors.flatMap(issue => issue.clipIds));
    const axisMs = Math.max(project.durationMs + 1000, ...rows.map(clip =>
      Math.max(M.endOf(clip), clip.startMs + clip.effectMs, clip.startMs + clip.cooldownMs)));
    const seconds = Math.ceil(axisMs / 1000);
    const width = labelWidth() + seconds * state.zoom + 34;
    $('timelineCanvas').style.width = `${Math.max(width, $('timelineScroller').clientWidth)}px`;
    const tickStep = state.zoom < 16 ? 5 : state.zoom < 32 ? 2 : 1;
    const ticks = Array.from({length: Math.floor(seconds / tickStep) + 1}, (_, i) => i * tickStep);
    const grid = ticks.map(value => `<i class="grid-line ${value % 5 === 0 ? 'major' : ''}"
      style="left:${value * state.zoom}px"></i>`).join('');
    const ruler = `<div class="ruler" data-ruler><div class="ruler-label sticky-label">${icon('layers-3')}<span>角色 / 技能</span></div>
      ${ticks.map(value => `<span class="ruler-tick" style="left:${labelWidth() + value * state.zoom}px">${value}s</span>`).join('')}</div>`;
    const returnEntry = conditional ? null : M.loopReturn(project);
    const switchStrip = `<div class="switch-strip"><div class="sticky-label">${conditional ? '条件调度' : '换人冷却'}</div>
      ${(conditional ? [] : M.switches(project)).map((entry, i, changes) => `<span class="switch-window
        ${i > 0 && entry.startMs - changes[i - 1].startMs < 1000 ? 'invalid' : ''}"
        style="left:${labelWidth() + entry.startMs / 1000 * state.zoom}px;width:${state.zoom}px"
        title="${html(M.character(catalog, entry.characterId).name)} · ${time(entry.startMs)}s">换人</span>`).join('')}
        ${returnEntry ? `<span class="switch-window loop-return-window" data-loop-cooldown
          style="left:${labelWidth() + returnEntry.startMs / 1000 * state.zoom}px;width:${state.zoom}px"
          title="回到${html(M.character(catalog, returnEntry.characterId).name)}，末尾保留 1 秒换人冷却">回切 · 1s</span>` : ''}</div>`;
    const links = conditional ? [] : rows.flatMap((clip, index) => {
      const next = rows[index + 1];
      if (next && next.characterId !== clip.characterId) return [{from: clip, to: next, loop: false}];
      if (!next && project.repeat) return [{from: clip, to: rows[0], loop: true}];
      return [];
    });
    const nextLink = new Map(links.map(link => [link.from.id, link]));
    const tracks = project.team.map((id, index) => {
      const character = M.character(catalog, id);
      const role = M.roleSlot(project, id);
      const roleName = M.roleDefinitions.find(item => item.id === role.role).name;
      const clips = rows.filter(clip => clip.characterId === id);
      const renderClip = (clip, run) => {
        const skill = selectedAbility(clip);
        const castMs = Math.min(M.castDurationMs(clip), M.endOf(clip) - clip.startMs);
        const castSize = castMs / 1000 * state.zoom;
        const actionSize = M.actionDurationMs(clip) / 1000 * state.zoom;
        const compact = castSize < 135 ? 'compact' : '';
        const tiny = castSize < 72 ? 'tiny' : '';
        const micro = castSize < 34 ? 'micro' : '';
        const lock = M.castLockMs(clip);
        const entrance = run.clips[0].id === clip.id;
        const pending = ['skill', 'burst'].includes(clip.abilityId) && lock === null;
        const canTrim = !M.isFixedAction(clip);
        const title = `${character.name} · ${skill.name}\n${time(clip.startMs)}–${time(M.endOf(clip))}s` +
          (lock !== null ? `\n释放换人锁定 ${M.seconds(lock)}s` : ['skill', 'burst'].includes(clip.abilityId) ? '\n释放锁定待实测' : '');
        const effectSize = Math.max(0, M.effectEnd(project, clip) - clip.startMs) / 1000 * state.zoom;
        const effectTop = actionHeight + (clip.abilityId === 'burst' ? 32 : 8);
        const cooldownTop = rowHeight - (clip.abilityId === 'burst' ? 23 : 33);
        const left = (clip.startMs - run.startMs) / 1000 * state.zoom;
        return `<div class="clip clip-${html(clip.abilityId)} ${compact} ${tiny} ${micro} ${entrance ? '' : 'no-avatar'} ${isSelected(clip.id) ? 'selected' : ''}
          ${invalid.has(clip.id) ? 'invalid' : ''}" data-clip="${clip.id}" tabindex="0" role="button"
          aria-pressed="${isSelected(clip.id)}"
          aria-label="${html(title.replace('\n', '，'))}" title="${html(title)}"
          style="left:${left}px;width:${Math.max(8, actionSize)}px">
          <div class="clip-action ${pending ? 'pending-cast' : ''}" data-cast="${clip.id}"
            style="width:${castSize}px" title="${pending ? '释放时长待实测' : `动作时长 ${M.seconds(castMs)} 秒`}">
            ${entrance ? avatarHtml(character, 'clip-avatar') : ''}${skillImage(skill, 'clip-skill-icon')}
            <span class="clip-title"><strong>${html(skill.name)}</strong><small>${skill.key}
              · ${pending ? '待实测' : `${time(castMs)}s`}</small></span>
            <span class="clip-key" aria-hidden="true">${skill.key}</span>
          </div>
          ${lock > 0 ? `<span class="clip-lock" data-lock="${clip.id}" style="width:${Math.min(lock, clip.foregroundMs) / 1000 * state.zoom}px"
            title="释放期间不能切人：${M.seconds(lock)} 秒">${icon('lock-keyhole')}</span>` : ''}
          ${canTrim ? `<span class="clip-resize" data-resize="${clip.id}" role="slider" tabindex="0"
            aria-label="${html(character.name)}${html(skill.name)}动作时长" aria-valuemin="${M.seconds(M.minimumForegroundMs(clip))}"
            aria-valuenow="${M.seconds(clip.foregroundMs)}" title="调整动作时长"></span>` : ''}
        </div>
        ${clip.effectMs > 0 ? `<div class="effect-bar ${clip.effectPolicy === 'onfield' ? 'onfield-effect' : ''}"
          data-effect="${clip.id}" title="${html(skill.name)} · 持续 ${time(clip.effectMs)}s${clip.effectPolicy === 'onfield' ? ' · 退场结束' : ''}"
          style="left:${left}px;top:${effectTop}px;width:${Math.max(3, effectSize)}px">
          <span>${skill.key} · ${html(skill.name)} · ${time(clip.effectMs)}s</span>
        </div>` : ''}
        ${clip.cooldownMs > 0 ? `<div class="cooldown-bar" data-effect="${clip.id}"
          style="left:${left}px;top:${cooldownTop}px;width:${clip.cooldownMs / 1000 * state.zoom}px"
          title="${skill.key} 冷却 ${time(clip.cooldownMs)}s"></div>` : ''}`;
      };
      const body = runs.filter(run => run.characterId === id).map(run => {
        const tail = run.clips.at(-1), link = tail && nextLink.get(tail.id);
        const direction = link && project.team.indexOf(link.to.characterId) > index ? 'arrow-down-right'
          : link && project.team.indexOf(link.to.characterId) < index ? 'arrow-up-right' : 'arrow-right';
        return `<div class="onfield-run" data-onfield-run="${run.id}"
          style="left:${run.startMs / 1000 * state.zoom}px;width:${Math.max(0, run.endMs - run.startMs) / 1000 * state.zoom}px"
          title="${html(character.name)}站场 ${time(run.startMs)}–${time(run.endMs)}s">
          ${M.idleIntervals(run).map(interval => `<div class="idle-interval" data-idle-gap="${run.id}"
            data-idle-start="${interval.startMs}" data-idle-end="${interval.endMs}"
            style="left:${(interval.startMs - run.startMs) / 1000 * state.zoom}px;width:${(interval.endMs - interval.startMs) / 1000 * state.zoom}px"
            title="无动作站场 ${time(interval.endMs - interval.startMs)}s">
            ${run.clips.length && (interval.endMs - interval.startMs) / 1000 * state.zoom > 85 ? '无动作站场' : ''}</div>`).join('')}
          ${run.clips.map(clip => renderClip(clip, run)).join('')}
          ${tail ? `<span class="clip-resize run-resize ${!M.isFixedAction(tail) && M.actionEndOf(tail) >= run.endMs ? 'separate-handle' : ''}"
            data-resize="${tail.id}" data-run-resize="${run.id}"
            role="slider" tabindex="0" aria-label="${html(character.name)}末尾站场预留"
            aria-valuemin="${M.seconds(M.minimumForegroundMs(tail))}" aria-valuenow="${M.seconds(run.endMs - tail.startMs)}"
            title="调整末尾站场预留${link ? ` · 下一位${html(M.character(catalog, link.to.characterId).name)}` : ''}"
            ${link ? `data-next-character="${link.to.characterId}"` : ''}>${link ? icon(direction) : ''}</span>`
            : `<div class="loop-target run-return-target">${avatarHtml(character)}<span>回切</span></div>`}
        </div>`;
      }).join('');
      return `<section class="track ${clips.some(clip => isSelected(clip.id)) ? 'selected-track' : ''}"
        data-track="${id}" style="${css(character)}">
        <div class="track-label sticky-label" draggable="true" data-team-drag="${id}">
          <div class="track-heading"><button class="track-add-source" draggable="true" data-track-avatar="${id}"
            type="button" title="拖入${html(character.name)}的技能" aria-label="拖入${html(character.name)}的技能">${avatarHtml(character, 'track-avatar')}</button>
            <div class="track-name">${html(character.name)}<span class="track-index">${
              role.candidates.length > 1 || role.role !== 'flex' ? html(roleName) : `角色 ${index + 1}`}</span></div></div>
          <div class="track-states" data-states="${id}"><span>E 就绪</span><span>Q 就绪</span></div>
          <button class="icon-button track-role-toggle ${role.candidates.length > 1 ? 'has-branches' : ''}"
            data-role-toggle="${id}" type="button" aria-expanded="${state.roleSwitcher?.characterId === id}"
            aria-controls="roleSwitcher" title="${html(character.name)} · 角色定位与兼容分支"
            aria-label="展开${html(character.name)}的兼容分支">${icon('git-fork')}
            ${role.candidates.length > 1 ? `<span>${role.candidates.length}</span>` : ''}</button>
          <button class="icon-button track-add" data-quick-add="${id}" type="button"
            title="快速添加${html(character.name)}的技能" aria-label="快速添加${html(character.name)}的技能">${icon('plus')}</button>
          <button class="icon-button track-remove" data-remove-character="${id}" type="button"
            title="移除${html(character.name)}" aria-label="移除${html(character.name)}">${icon('x')}</button>
        </div><div class="track-body">${grid}${body}</div>
      </section>`;
    }).join('');
    const height = 65 + project.team.length * rowHeight;
    const connections = `<svg class="switch-connections" width="${width}" height="${height}" aria-hidden="true">
      <defs><marker id="switchArrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5"
        orient="auto-start-reverse"><path d="M0 0 L8 4 L0 8 Z" fill="#758399"></path></marker></defs>
      ${links.map(link => {
        const x1 = labelWidth() + runForClip.get(link.from.id).endMs / 1000 * state.zoom;
        const x2 = labelWidth() + (link.loop ? returnEntry?.startMs ?? project.durationMs : link.to.startMs) / 1000 * state.zoom;
        const y1 = connectionY + project.team.indexOf(link.from.characterId) * rowHeight;
        const y2 = connectionY + project.team.indexOf(link.to.characterId) * rowHeight;
        return `<path class="switch-link ${isSelected(link.from.id) ? 'selected' : ''}" data-link-from="${link.from.id}"
          data-link-to="${link.to.id}" data-loop-link="${link.loop}" d="M ${x1} ${y1} C ${x1 + 14} ${y1}, ${x2 - 14} ${y2}, ${x2} ${y2}"
          marker-end="url(#switchArrow)"></path>`;
      }).join('')}</svg>`;
    const loopTarget = !conditional && rows.length && project.repeat && !returnEntry ? `<div class="loop-target"
      style="left:${labelWidth() + project.durationMs / 1000 * state.zoom}px;top:${connectionY - 17 + project.team.indexOf(rows[0].characterId) * rowHeight}px">
      ${icon('repeat-2')}<span>下一轮</span></div>` : '';
    $('timelineCanvas').innerHTML = ruler + switchStrip + tracks + connections + loopTarget +
      (!project.team.length ? `<div class="empty-timeline">${icon('users-round')}<span>尚未添加角色</span></div>` : '') +
      `<div class="loop-shade" style="left:${labelWidth() + project.durationMs / 1000 * state.zoom}px;right:0"></div>
      <div class="loop-end" style="left:${labelWidth() + project.durationMs / 1000 * state.zoom}px">
        <button class="loop-end-handle" data-loop-resize type="button" title="调整循环结束位置" aria-label="调整循环结束位置">${icon('flag')}</button></div>
      ${Number.isFinite(state.drag?.snapMs) ? `<div class="snap-guide" data-snap-guide="${state.drag.snapMs}"
        aria-hidden="true" style="left:${labelWidth() + state.drag.snapMs / 1000 * state.zoom}px"></div>` : ''}
      <div class="playhead" id="playhead" style="left:${labelWidth() + state.playheadMs / 1000 * state.zoom}px"></div>`;
    const overviewRows = conditional ? M.declared(project).sort((a, b) => M.priorityOf(a) - M.priorityOf(b)) : rows;
    $('sequenceLabel').textContent = conditional ? '规则优先级' : M.isText(project) ? '命令顺序' : '动作顺序';
    $('sequenceList').innerHTML = overviewRows.map((clip, index) => {
      const character = M.character(catalog, clip.characterId), skill = selectedAbility(clip);
      return `${index && !conditional ? icon('chevron-right').replace('data-lucide', 'class="sequence-arrow" data-lucide') : ''}
        <button type="button" class="sequence-item ${isSelected(clip.id) ? 'selected' : ''}" data-sequence="${clip.id}"
          style="${css(character)}" title="${html(character.name)} · ${html(skill.name)}">
          ${index === 0 || overviewRows[index - 1].characterId !== clip.characterId ? avatarHtml(character) : ''}
          <span><strong>${['attack', 'wait'].includes(clip.abilityId) ? html(skill.name) : html(skill.key)}</strong>
            <small>${conditional ? `P${M.priorityOf(clip)}` : `${time(clip.startMs)}s`}</small></span></button>`;
    }).join('');
    paintSelection();
    $('validationStatus').innerHTML = errors.length ? `${icon('circle-alert')}<span>${errors.length} 项待调整</span>`
      : issues.length ? `${icon('info')}<span>${issues.length} 项参考提示</span>`
      : `${icon('circle-check')}<span>排轴检查通过</span>`;
    $('validationStatus').classList.toggle('has-issues', errors.length > 0);
    $('validationStatus').classList.toggle('has-warnings', !errors.length && issues.length > 0);
    $('exportStrategy').disabled = errors.length > 0;
    $('executionMode').value = executionMode();
    $('previewStatus').textContent = M.isText(project) ? 'TXT · 命令顺序参考'
      : M.isProcess(project) ? 'JSON · 按步骤执行'
        : project.scheduling === 'original' ? 'JSON · 条件策略参考' : 'JSON · 计划时刻预览';
    $('durationLabel').textContent = M.isProcess(project) || project.scheduling === 'original' ? '秒 · 参考' : '秒';
    $('fitLoop').title = M.isProcess(project) ? '整理动作间隔与换人边界' : '按冷却整理排轴';
    $('loopDuration').value = M.seconds(project.durationMs);
    $('repeatToggle').checked = project.repeat;
    paintPlayhead();
  }

  function paintSelection() {
    for (const clip of $('timelineCanvas').querySelectorAll('[data-clip]')) {
      const selected = isSelected(clip.dataset.clip);
      clip.classList.toggle('selected', selected);
      clip.setAttribute('aria-pressed', String(selected));
    }
    for (const item of $('sequenceList').querySelectorAll('[data-sequence]')) {
      item.classList.toggle('selected', isSelected(item.dataset.sequence));
    }
    for (const track of $('timelineCanvas').querySelectorAll('[data-track]')) {
      track.classList.toggle('selected-track', state.project.clips.some(clip =>
        clip.characterId === track.dataset.track && isSelected(clip.id)));
    }
    for (const link of $('timelineCanvas').querySelectorAll('[data-link-from]')) {
      link.classList.toggle('selected', isSelected(link.dataset.linkFrom));
    }
    $('projectStats').textContent = `${state.project.team.length}${
      M.isText(state.project) || state.project.scheduling === 'original' ? ' 角色候选' : ' / 4 角色'} · ${state.project.clips.length} 个片段` +
      (state.selection.length > 1 ? ` · 已选 ${state.selection.length} 个` : '');
    paintMobilePreview();
  }

  function paintMobilePreview(readout = null) {
    if (!isMobile) return;
    const rows = M.ordered(state.project);
    const clip = state.playing
      ? rows.find(item => item.id === readout?.occupiedClipId) ||
        rows.filter(item => item.startMs <= state.playheadMs).at(-1)
      : selectedClip() || rows[0];
    const key = JSON.stringify([clip, rows.length, clip && rows.indexOf(clip), state.selection.length]);
    if (key === mobilePreviewKey) return;
    mobilePreviewKey = key;
    const preview = $('mobilePreviewIdentity');
    if (!clip) {
      preview.style.cssText = '';
      preview.innerHTML = `${icon('clapperboard')}<div class="mobile-preview-text"><strong>尚未添加动作</strong></div>`;
    } else {
      const character = M.character(catalog, clip.characterId), skill = selectedAbility(clip);
      const duration = M.castDurationMs(clip), pending = ['skill', 'burst'].includes(clip.abilityId) && M.castLockMs(clip) === null;
      preview.style.cssText = css(character);
      preview.innerHTML = `${avatarHtml(character, 'mobile-preview-avatar')}
        <div class="mobile-preview-text"><strong>${html(character.name)} · ${html(skill.name)}</strong>
        <small>动作 ${rows.indexOf(clip) + 1} / ${rows.length} · 参考 ${time(clip.startMs)}s · ${
          pending ? '释放待实测' : `${M.seconds(duration)}s`}${state.selection.length > 1 ? ` · 选中 ${state.selection.length} 项` : ''}</small></div>
        ${skillImage(skill, 'mobile-preview-skill')}`;
    }
    icons();
  }

  function numberField(label, property, value, min = 0, title = '', readonly = false) {
    return `<label class="field"><span>${label}</span><div class="field-unit"><input type="number"
      data-property="${property}" value="${M.seconds(value)}" min="${min}" step="${property === 'foregroundMs' ? '0.001' : '0.1'}"
      aria-label="${label}" ${readonly ? 'readonly aria-readonly="true"' : ''}
      ${title ? `title="${title}"` : ''}><span>秒</span>${readonly ? icon('lock-keyhole') : ''}</div></label>`;
  }

  function timingFields(clip) {
    if (!['skill', 'burst', 'charge'].includes(clip.abilityId)) return '';
    const variants = M.timingVariants(clip.characterId, clip.abilityId);
    const timing = clip.castTiming, lock = M.castLockMs(clip);
    const label = value => value.replace(/^Cast$/, '施放').replace(/^(Press|Tap)$/, '点按')
      .replace(/Hold Lv\. 1/, '长按一段').replace(/Hold Lv\. 2/, '长按二段').replace(/^Hold$/, '长按');
    return `<section class="inspector-section"><h3>释放锁定</h3>
      ${variants.length ? `<label class="field"><span>技能形态</span><select data-property="castVariantId" aria-label="技能形态">
        ${!timing ? '<option value="">待实测</option>' : ''}
        ${variants.map(entry => `<option value="${entry.id}" ${entry.id === timing?.id ? 'selected' : ''}>${html(label(entry.label))}</option>`).join('')}
      </select></label>` : ''}
      <div class="casting-measurement ${lock === null ? 'pending' : ''}">
        <div>${icon(lock === null ? 'circle-help' : 'lock-keyhole')}<strong>${lock === null ? '锁定时间待实测' : `最早可切人 ${M.seconds(lock)} 秒`}</strong>
          ${timing?.sourceUrl ? `<a href="${html(timing.sourceUrl)}" target="_blank" rel="noreferrer" title="查看帧测原始记录"
            aria-label="查看帧测原始记录">${icon('external-link')}</a>` : ''}</div>
        <small>${Number.isFinite(clip.lockOverrideMs) ? '手工校准值' : timing?.lockMs !== null && timing?.lockMs !== undefined
          ? `${timing.swapFrames} 帧 / ${timing.fps} FPS · 公开帧测，本机待复测` : '此角色形态尚无换人帧测记录'}</small>
      </div>
      <label class="field"><span>校准锁定值</span><div class="field-unit"><input type="number" data-property="lockOverrideMs"
        aria-label="校准锁定值" value="${clip.lockOverrideMs === null ? '' : M.seconds(clip.lockOverrideMs)}"
        placeholder="${lock === null ? '待实测' : M.seconds(lock)}" min="0" step="0.001"><span>秒</span></div></label>
      ${timing?.notes ? `<p class="timing-note">${html(timing.notes)}</p>` : ''}
    </section>`;
  }

  function executionMode() {
    return state.project.scheduling === 'original' ? 'original'
      : state.project.execution === 'process' ? 'process' : 'timeline';
  }

  function setExecutionMode(mode) {
    if (M.isText(state.project)) return;
    change(() => {
      if (mode !== 'original' && state.project.team.length > 4) throw new Error('步骤编排最多使用 4 个角色，请先调整角色候选');
      state.project.scheduling = mode === 'original' ? 'original' : 'sequence';
      if (mode !== 'original') state.project.execution = mode;
    });
  }

  function schedulingControl() {
    if (M.isText(state.project)) return `<div class="execution-state">TXT · 顺序命令</div>
      <label class="checkbox-label"><input id="txtWaitGaps" type="checkbox"
        ${state.project.txtWaitGaps ? 'checked' : ''}><span>空隙导出为等待</span></label>`;
    const mode = executionMode();
    return `<label class="field"><span>执行方式</span><select id="schedulingMode" aria-label="调度方式">
      <option value="process" ${mode === 'process' ? 'selected' : ''}>按步骤推进</option>
      <option value="timeline" ${mode === 'timeline' ? 'selected' : ''}>按计划时刻</option>
      <option value="original" ${mode === 'original' ? 'selected' : ''}>条件与优先级</option>
    </select></label>${state.project.scheduling === 'original'
      ? '<div class="execution-state">原触发条件与优先级保留</div>'
      : M.isProcess(state.project) ? '<div class="execution-state">步骤完成后推进 · 空白站场为相对等待</div>' : ''}`;
  }

  function executionFields(clip) {
    if (M.isText(state.project)) return `<section class="inspector-section"><h3>TXT 命令衔接</h3>
      ${schedulingControl()}
      ${clip.abilityId === 'skill' ? `<label class="field"><span>战技未就绪时</span><select data-property="txtSkillPolicy" aria-label="TXT 战技策略">
        <option value="direct" ${(clip.txtSkillPolicy || 'direct') === 'direct' ? 'selected' : ''}>直接尝试施放 · skill</option>
        <option value="wait" ${clip.txtSkillPolicy === 'wait' ? 'selected' : ''}>等待冷却 · skill(wait)</option>
        <option value="fast" ${clip.txtSkillPolicy === 'fast' ? 'selected' : ''}>跳过战技 · skill(fast)</option>
      </select></label>` : ''}
      <label class="checkbox-label"><input type="checkbox" data-property="txtReady"
        ${clip.txtReady ? 'checked' : ''}><span>之后等待操作界面恢复 · ready</span></label>
      ${clip.abilityId === 'skill' ? `<label class="checkbox-label"><input type="checkbox" data-property="protectCast"
        ${clip.protectCast !== false ? 'checked' : ''}><span>追加已校准的释放等待</span></label>` : ''}
      <label class="field"><span>限定轮次 · 仅一键战斗</span><input data-property="txtRounds" aria-label="TXT 限定轮次"
        value="${html(clip.txtRounds || '')}" placeholder="所有轮次，例如 1,3-5"></label>
      ${M.hasCompatibility(state.project) ? '<div class="execution-state">TXT 导出当前选中的角色分支</div>' : ''}
    </section>`;
    const priorities = M.prioritiesOf(clip), native = state.project.scheduling === 'original';
    return `<section class="inspector-section"><h3>JSON 条件与分支</h3>${schedulingControl()}
      ${native ? `<label class="field"><span>动作优先级 · 数字越小越优先</span><input type="number" step="1"
        data-property="priority" aria-label="动作优先级" value="${M.priorityOf(clip)}"></label>` : ''}
      ${M.isProcess(state.project) && clip.followSourceId ? `<label class="checkbox-label"><input type="checkbox" data-property="followSourceId"
        checked><span>前置技能未执行时跳过</span></label>` : ''}
      ${M.isProcess(state.project) ? `<label class="field"><span>就绪条件</span><select data-property="readiness" aria-label="就绪条件">
        <option value="none" ${clip.readiness === 'none' ? 'selected' : ''}>无技能就绪条件</option>
        <option value="skill" ${clip.readiness === 'skill' ? 'selected' : ''}>E · 战技可用</option>
        <option value="burst" ${clip.readiness === 'burst' ? 'selected' : ''}>Q · 爆发可用</option>
      </select></label><label class="field"><span>条件未满足</span><select data-property="notReady" aria-label="条件未满足">
        <option value="wait" ${clip.notReady === 'wait' ? 'selected' : ''}>等待后执行</option>
        <option value="skip" ${clip.notReady === 'skip' ? 'selected' : ''}>跳过此步骤</option>
      </select></label>` : ''}
      <label class="field"><span>触发条件</span><textarea data-property="condition" aria-label="触发条件"
        spellcheck="false" placeholder="无额外条件">${html(clip.condition)}</textarea></label>
      <div class="condition-tools">
        <select id="conditionJoin" class="condition-join" aria-label="条件关系"><option value="and">并且</option><option value="or">或者</option><option value="replace">替换</option></select>
        <select id="conditionPreset" aria-label="添加原生条件"><option value="">添加原生条件</option>
          <option value="e-ready()">E 战技就绪</option><option value="q-ready()">Q 爆发就绪</option>
          <option value="low-hp()">当前前台低血量</option><option value="!low-hp()">当前前台血量正常</option>
          <option value="onfield()">本角色在前台</option>
          <option value="in-party(${html(M.character(catalog, clip.characterId).name)})">本角色在队中</option>
          <option value="!(since() &lt; ${Math.max(1, M.seconds(clip.cooldownMs))})">距上次执行达到冷却</option>
          ${M.ordered(state.project).filter(row => row.id !== clip.id).map(row =>
            `<option value="count(${html(row.name)}) &gt; count()">已执行 ${html(row.name)}</option>`).join('')}
        </select>
      </div>
      <div class="priority-heading"><span>替代触发条件与优先级</span><button type="button" class="icon-button"
        data-priority-add title="添加替代条件" aria-label="添加替代条件">${icon('plus')}</button></div>
      ${priorities.map((entry, index) => {
        const get = (field, fallback) => entry[Object.keys(entry).find(key => key.toLowerCase() === field.toLowerCase())] ?? fallback;
        return `<div class="priority-rule">
          <input type="number" step="1" value="${get('Priority', 0)}" data-priority-field="Priority" data-priority-index="${index}" aria-label="替代优先级 ${index + 1}">
          <textarea spellcheck="false" data-priority-field="Expression" data-priority-index="${index}"
            aria-label="替代条件 ${index + 1}">${html(get('Expression', ''))}</textarea>
          <button type="button" class="icon-button" data-priority-remove="${index}" title="删除替代条件"
            aria-label="删除替代条件 ${index + 1}">${icon('x')}</button></div>`;
      }).join('')}
      ${clip.abilityId === 'skill' ? `<label class="checkbox-label"><input type="checkbox" data-property="ensureCast"
        ${clip.ensureCast ? 'checked' : ''}><span>战技冷却检查与有限重试</span></label>` : ''}
      ${M.isProcess(state.project) && (clip.abilityId === 'skill' || clip.abilityId === 'combo')
        ? `<label class="checkbox-label"><input type="checkbox" data-property="protectCast"
          ${clip.protectCast !== false ? 'checked' : ''}><span>等待已校准的释放锁定</span></label>` : ''}
    </section>`;
  }

  function paintMode() {
    const format = M.isText(state.project) ? 'txt' : 'json';
    for (const button of $('strategyModeControl').querySelectorAll('[data-strategy-format]')) {
      const selected = button.dataset.strategyFormat === format;
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-pressed', String(selected));
    }
    $('executionMode').hidden = format === 'txt';
    $('exportStrategy').querySelector('span').textContent = `导出战斗 ${format.toUpperCase()}`;
    $('exportStrategy').title = `导出战斗 ${format.toUpperCase()}`;
    $('repeatLabel').textContent = format === 'txt' || state.project.scheduling === 'original' ? '预览循环' : '循环';
    $('newFormat').value = format;
  }

  function operationInputs(operation, index = null, characterId = null) {
    const binding = field => `data-operation-field="${field}" ${index === null ? '' : `data-operation-index="${index}"`}`;
    const select = (label, field, choices) => `<label class="field"><span>${label}</span><select ${binding(field)}
      aria-label="${label}${index === null ? '' : ` ${index + 1}`}">${choices.map(([value, text]) =>
        `<option value="${value}" ${operation[field] === value ? 'selected' : ''}>${html(text)}</option>`).join('')}</select></label>`;
    const numeric = (label, field, value, unit = '', minimum = null) => `<label class="field"><span>${label}</span>
      <div class="field-unit"><input type="number" ${binding(field)} value="${value}" ${minimum === null ? '' : `min="${minimum}"`}
      step="${field === 'durationMs' ? '0.05' : '1'}" aria-label="${label}${index === null ? '' : ` ${index + 1}`}">
      ${unit ? `<span>${unit}</span>` : ''}</div></label>`;
    const parts = [];
    if (operation.type === 'walk') parts.push(select('方向', 'direction',
      [['w', 'W · 前'], ['a', 'A · 左'], ['s', 'S · 后'], ['d', 'D · 右']]));
    if (['keypress', 'keyhold', 'keydown', 'keyup'].includes(operation.type)) {
      parts.push(`<label class="field"><span>按键</span><input type="text" ${binding('keys')}
        aria-label="按键${index === null ? '' : ` ${index + 1}`}" value="${html(operation.keys)}"
        placeholder="W + Shift" autocomplete="off" spellcheck="false"></label>`);
    }
    if (['click', 'mousehold', 'mousedown', 'mouseup'].includes(operation.type)) {
      parts.push(select('鼠标按键', 'button', [['left', '左键'], ['right', '右键'], ['middle', '中键']]));
    }
    if (operation.type === 'moveby') parts.push(`<div class="field-grid">
      ${numeric('水平偏移', 'x', operation.x, 'px')}${numeric('垂直偏移', 'y', operation.y, 'px')}</div>`);
    if (operation.type === 'scroll') parts.push(numeric('滚轮格数', 'amount', operation.amount));
    if (index !== null && ['walk', 'dash', 'wait', 'attack', 'charge', 'keyhold', 'mousehold'].includes(operation.type)) {
      parts.push(numeric('持续', 'durationMs', M.seconds(operation.durationMs), '秒', operation.type === 'wait' ? 0 : 0.01));
    }
    if (operation.type === 'skill') parts.push(`<label class="checkbox-label"><input type="checkbox"
      ${binding('hold')} ${operation.hold ? 'checked' : ''} aria-label="长按战技 ${index + 1}"><span>长按战技</span></label>`);
    if (['skill', 'burst'].includes(operation.type)) {
      const timing = M.timingFor(characterId, operation.type, operation.hold);
      parts.push(`<div class="operation-cast-note">${timing?.lockMs != null
        ? `释放锁定 ${M.seconds(timing.lockMs)} 秒` : '释放锁定待实测'}</div>`);
    }
    return parts.join('');
  }

  function operationFields(clip) {
    if (!Ops.definitions.some(item => item.id === clip.abilityId)) return '';
    if (clip.abilityId !== 'combo') {
      const fields = operationInputs({...clip.operation, type: clip.abilityId});
      return fields ? `<section class="inspector-section"><h3>操作参数</h3>${fields}</section>` : '';
    }
    const rows = clip.operations || [];
    return `<section class="inspector-section combo-section"><div class="section-heading"><h3>组合动作</h3>
      <button type="button" class="icon-button" data-operation-add title="添加操作" aria-label="添加操作">${icon('plus')}</button></div>
      ${clip.commandOverride !== null ? '<div class="execution-state">原指令保留</div>' : ''}
      <div class="operation-list">${rows.map((operation, index) => `<div class="operation-row" data-operation-row="${index}">
        <div class="operation-row-heading"><span class="operation-number">${index + 1}</span>
          <select data-operation-field="type" data-operation-index="${index}" aria-label="操作类型 ${index + 1}">
            ${Ops.kinds.map(kind => `<option value="${kind.id}" ${kind.id === operation.type ? 'selected' : ''}>${kind.name}</option>`).join('')}
          </select><div class="operation-row-tools">
            <button type="button" class="icon-button" data-operation-up="${index}" title="上移" aria-label="上移操作 ${index + 1}"
              ${index === 0 ? 'disabled' : ''}>${icon('arrow-up')}</button>
            <button type="button" class="icon-button" data-operation-down="${index}" title="下移" aria-label="下移操作 ${index + 1}"
              ${index === rows.length - 1 ? 'disabled' : ''}>${icon('arrow-down')}</button>
            <button type="button" class="icon-button" data-operation-remove="${index}" title="删除操作" aria-label="删除操作 ${index + 1}"
              ${rows.length === 1 ? 'disabled' : ''}>${icon('x')}</button>
          </div></div><div class="operation-parameters">${operationInputs(operation, index, clip.characterId)}</div></div>`).join('')}</div>
      <div class="combo-template-tools"><select id="comboTemplate" aria-label="动作组模板">${Ops.templates.map(template =>
        `<option value="${template.id}">${template.name}</option>`).join('')}</select>
        <button type="button" class="icon-button" data-operation-template title="替换动作组" aria-label="替换动作组">${icon('replace')}</button></div>
      <output class="operation-command" aria-label="组合动作指令">${html(M.commandsFor(clip))}</output>
    </section>`;
  }

  function paintInspector() {
    const selection = selectedClips();
    if (selection.length > 1) {
      $('inspectorTitle').textContent = '多选片段';
      $('inspectorContent').innerHTML = `<div class="inspector-section selection-heading">
        ${icon('square-dashed-mouse-pointer')}<strong>已选择 ${selection.length} 个片段</strong></div>
        <section class="inspector-section">
          ${numberField('整体开始时刻', 'selectionStartMs', selection[0].startMs)}
          <div class="selection-items">${selection.map(clip => {
            const character = M.character(catalog, clip.characterId), skill = selectedAbility(clip);
            return `<button type="button" data-select-single="${clip.id}" class="selection-item">
              ${avatarHtml(character)}<span><strong>${html(character.name)} · ${skill.key}</strong>
                <small>${time(clip.startMs)}s · ${html(skill.name)}</small></span></button>`;
          }).join('')}</div>
        </section>
        <div class="inspector-actions"><button type="button" data-duplicate-selection>${icon('copy-plus')}<span>复制所选</span></button>
          <button type="button" class="danger-button" data-delete-selection>${icon('trash-2')}<span>删除所选</span></button></div>`;
      return;
    }
    const clip = selectedClip();
    if (!clip) {
      $('inspectorTitle').textContent = '工程属性';
      $('inspectorContent').innerHTML = `<div class="no-selection"><div class="selection-icon">${icon('clapperboard')}</div>
        <h3>${html(state.project.name)}</h3>
        <label class="field"><span>作者</span><input id="projectAuthor" value="${html(state.project.author)}" maxlength="80"></label>
        ${schedulingControl()}
        ${!M.isText(state.project) ? `<label class="field"><span>开场动作</span><textarea id="preActions" spellcheck="false"
          aria-label="开场动作">${html(state.project.preActions.join('\n'))}</textarea></label>` : ''}
      </div>`;
      return;
    }
    const character = M.character(catalog, clip.characterId);
    const preset = selectedAbility(clip);
    const canFollow = ['skill', 'burst'].includes(clip.abilityId);
    $('inspectorTitle').textContent = '片段属性';
    $('inspectorContent').innerHTML = `<div class="inspector-identity" style="${css(character)}">
      ${avatarHtml(character)}<div><strong>${html(character.name)}</strong><small>${html(preset.name)}</small></div></div>
      <section class="inspector-section"><h3>角色动作</h3>
        <label class="field"><span>动作</span><select data-property="abilityId" aria-label="技能">
          <optgroup label="技能">${character.skills.map(skill => `<option value="${skill.id}" ${skill.id === clip.abilityId ? 'selected' : ''}>
            ${html(skill.key)} · ${html(skill.name)}</option>`).join('')}</optgroup>
          <optgroup label="操作">${Ops.definitions.map(operation => `<option value="${operation.id}"
            ${operation.id === clip.abilityId ? 'selected' : ''}>${html(operation.name)}</option>`).join('')}</optgroup></select></label>
        <label class="field"><span>片段名称</span><input data-property="name" aria-label="片段名称" value="${html(clip.name)}" maxlength="80"></label>
        <div class="field-grid">${numberField('开始时刻', 'startMs', clip.startMs)}
          ${numberField(M.isFixedAction(clip) ? '站场预留' : '动作时长', 'foregroundMs', clip.foregroundMs,
            M.seconds(M.minimumForegroundMs(clip)), '不改变其他动作的时长')}</div>
        ${canFollow ? `<label class="field fixed-duration"><span>释放时长</span><output data-cast-duration>
          ${M.castLockMs(clip) === null ? '待实测' : `${M.seconds(M.castDurationMs(clip))} 秒`}${icon('lock-keyhole')}</output></label>` : ''}
        ${clip.abilityId === 'skill' ? `<label class="checkbox-label"><input type="checkbox" data-property="hold"
          ${clip.hold ? 'checked' : ''}><span>长按战技</span></label>` : ''}
        <div class="append-actions" role="group" aria-label="插入下一动作">
          <button type="button" data-append-action="attack" title="在当前动作后插入普攻">${icon('plus')}${icon('swords')}<span>普攻</span></button>
          <button type="button" data-append-action="wait" title="在当前动作后插入等待">${icon('plus')}${icon('timer')}<span>等待</span></button>
        </div>
      </section>
      ${operationFields(clip)}
      ${rosterDetails(character.id)}
      ${timingFields(clip)}
      ${character.skills.some(skill => skill.id === clip.abilityId) ? `<section class="inspector-section"><h3>持续与冷却</h3>
        <div class="field-grid">${numberField('持续效果', 'effectMs', clip.effectMs, 0, '固定技能持续时间', true)}
          ${numberField('技能冷却', 'cooldownMs', clip.cooldownMs)}</div>
        <label class="field"><span>效果退场规则</span><select data-property="effectPolicy" aria-label="效果退场规则">
          <option value="persist" ${clip.effectPolicy === 'persist' ? 'selected' : ''}>退场后继续</option>
          <option value="onfield" ${clip.effectPolicy === 'onfield' ? 'selected' : ''}>退场时结束</option></select></label>
        <div class="parameter-origin">基础天赋参数 · 命座与冷却缩减可调整</div>
      </section>` : ''}
      ${executionFields(clip)}
      <details class="advanced-properties"><summary>动作与技能资料</summary>
        <label class="field"><span>动作指令</span><textarea data-property="commandOverride" aria-label="动作指令"
          spellcheck="false">${html(M.commandsFor(clip))}</textarea></label>
        <div class="skill-description">${html(preset.description)}</div>
      </details>
      <div class="inspector-actions"><button type="button" data-duplicate="${clip.id}">${icon('copy-plus')}<span>复制片段</span></button>
        <button type="button" class="danger-button" data-delete="${clip.id}">${icon('trash-2')}<span>删除</span></button></div>`;
  }

  function paint() {
    setSelection(state.selection, state.selected);
    paintMode();
    const active = document.activeElement;
    const focusProperty = active?.dataset.property;
    const focusOperation = active?.dataset.operationField;
    const focusOperationIndex = active?.dataset.operationIndex;
    const focusId = active?.id;
    const selectionStart = active?.selectionStart;
    const libraryScroll = $('characterList').scrollTop;
    $('projectName').value = state.project.name;
    $('undo').disabled = !state.undo.length;
    $('redo').disabled = !state.redo.length;
    paintLibrary();
    $('characterList').scrollTop = libraryScroll;
    paintTimeline();
    paintInspector();
    paintRoleSwitcher();
    icons();
    const replacement = focusOperation
      ? $('inspectorContent').querySelector(`[data-operation-field="${focusOperation}"]${focusOperationIndex === undefined
        ? ':not([data-operation-index])' : `[data-operation-index="${focusOperationIndex}"]`}`)
      : focusProperty ? $('inspectorContent').querySelector(`[data-property="${focusProperty}"]`) : focusId ? $(focusId) : null;
    if (replacement && !state.drag) {
      replacement.focus({preventScroll: true});
      if (selectionStart != null && ['text', 'search'].includes(replacement.type)) {
        replacement.setSelectionRange(selectionStart, selectionStart);
      }
    }
  }

  function paintPlayhead() {
    if ($('playhead')) $('playhead').style.left = `${labelWidth() + state.playheadMs / 1000 * state.zoom}px`;
    const totalSeconds = Math.floor(state.playheadMs / 1000);
    const fraction = Math.floor(state.playheadMs % 1000 / 100);
    $('timeReadout').textContent = `${String(Math.floor(totalSeconds / 60)).padStart(2, '0')}:${String(totalSeconds % 60).padStart(2, '0')}.${fraction}`;
    $('cycleReadout').textContent = `第 ${state.cycle} 轮`;
    const readout = M.stateAt(state.project, state.playheadMs, state.hasLooped);
    for (const status of readout.statuses) {
      const track = $('timelineCanvas').querySelector(`[data-track="${status.characterId}"]`);
      track?.classList.toggle('onfield', status.onfield);
      const counters = $('timelineCanvas').querySelector(`[data-states="${status.characterId}"]`);
      if (counters) counters.innerHTML = status.skills.map(skill => `<span class="${skill.effectMs > 0 ? 'active-effect' : ''}">
        ${skill.abilityId === 'skill' ? 'E' : 'Q'} ${skill.cooldownMs > 0 ? `CD ${time(skill.cooldownMs)}s` : '就绪'}
        ${skill.effectMs > 0 ? ` · ${time(skill.effectMs)}s` : ''}</span>`).join('');
    }
    window.combatEditorReadout = readout;
    paintMobilePreview(readout);
  }

  function pause() {
    state.playing = false;
    state.lastFrame = null;
    $('play').classList.remove('playing');
    $('play').innerHTML = icon('play');
    $('play').setAttribute('aria-label', '播放排轴预览');
    icons();
  }

  function frame(timestamp) {
    if (!state.playing) return;
    if (state.lastFrame !== null) state.playheadMs += (timestamp - state.lastFrame) * state.speed;
    state.lastFrame = timestamp;
    if (state.playheadMs >= state.project.durationMs) {
      if (state.project.repeat) {
        const cycles = Math.floor(state.playheadMs / state.project.durationMs);
        state.cycle += cycles;
        state.playheadMs %= state.project.durationMs;
        state.hasLooped = true;
      } else {
        state.playheadMs = state.project.durationMs;
        pause();
      }
    }
    paintPlayhead();
    if (state.playing) requestAnimationFrame(frame);
  }

  function play() {
    if (state.playing) { pause(); return; }
    if (!state.project.clips.length) { toast('先添加一个角色技能'); return; }
    if (state.playheadMs >= state.project.durationMs) state.playheadMs = 0;
    state.playing = true;
    state.lastFrame = null;
    $('play').classList.add('playing');
    $('play').innerHTML = icon('pause');
    $('play').setAttribute('aria-label', '暂停排轴预览');
    icons();
    requestAnimationFrame(frame);
  }

  function openPanel(name) {
    const panel = $(name === 'library' ? 'libraryPanel' : 'inspectorPanel');
    const wasOpen = panel.classList.contains('open');
    closeQuickAdd();
    closePanels();
    if (wasOpen) return;
    panel.classList.add('open');
    $('panelBackdrop').hidden = false;
    $(name === 'library' ? 'libraryToggle' : 'inspectorToggle').setAttribute('aria-expanded', 'true');
  }

  function closePanels() {
    $('libraryPanel').classList.remove('open');
    $('inspectorPanel').classList.remove('open');
    $('mobileAdjustPanel').classList.remove('open');
    $('panelBackdrop').hidden = true;
    $('libraryToggle').setAttribute('aria-expanded', 'false');
    $('inspectorToggle').setAttribute('aria-expanded', 'false');
    $('mobileAdjust').setAttribute('aria-expanded', 'false');
  }

  function quickInsertionMs(characterId) {
    const clip = selectedClip();
    if (clip?.characterId === characterId) return M.actionEndOf(clip);
    if (state.playheadMs > 0) return state.playheadMs;
    return Math.max(0, ...state.project.clips.filter(item => item.characterId === characterId).map(M.endOf));
  }

  function openQuickAdd(characterId, at, x, y, tab = 'skills') {
    pause();
    closePanels();
    const character = M.character(catalog, characterId);
    const anchor = selectedClip();
    const afterId = anchor?.characterId === characterId && Math.abs(at - M.actionEndOf(anchor)) < 1 ? anchor.id : null;
    state.quickAdd = {characterId, startMs: afterId ? at : snapped(at), afterId, x, y, tab};
    const menu = $('quickAddMenu');
    menu.style.cssText = css(character);
    menu.innerHTML = `<div class="quick-add-heading">${avatarHtml(character)}
      <div><strong>${html(character.name)}</strong><small>${time(state.quickAdd.startMs)}s</small></div>
      <button class="icon-button" data-close-quick type="button" aria-label="关闭快速添加" title="关闭">${icon('x')}</button></div>
      <div class="append-actions quick-common-actions" role="group" aria-label="常用动作">
        <button type="button" data-quick-common="attack">${icon('swords')}<span>普攻</span>${icon('plus')}</button>
        <button type="button" data-quick-common="wait">${icon('timer')}<span>等待</span>${icon('plus')}</button>
      </div>
      <div class="segmented quick-add-tabs" role="group" aria-label="动作类别">
        ${[['skills', '技能'], ['operations', '操作'], ['combos', '连招']].map(([id, label]) =>
          `<button type="button" data-quick-tab="${id}" class="${tab === id ? 'selected' : ''}"
            aria-pressed="${tab === id}">${label}</button>`).join('')}</div>
      <div class="quick-skill-list ${tab === 'operations' ? 'quick-operation-list' : ''}">${
        tab === 'combos' ? Ops.templates.map(template => `<button type="button" data-quick-template="${template.id}">
          <span class="quick-skill-icon">${icon('workflow')}</span><span class="quick-skill-name">
            <strong>${html(template.name)}</strong><small>${template.operations.length} 项操作</small></span></button>`).join('')
          : (tab === 'skills' ? character.skills : Ops.definitions.filter(item => item.id !== 'combo')).map(skill => {
        const timing = M.timingFor(characterId, skill.id);
        return `<button type="button" data-quick-skill="${skill.id}">
          <span class="quick-skill-icon">${skillImage(skill)}</span><span class="quick-skill-name">
            <strong>${tab === 'skills' ? `${html(skill.key)} · ` : ''}${html(skill.name)}</strong>
            <small>${['skill', 'burst'].includes(skill.id) ? timing?.lockMs !== null && timing?.lockMs !== undefined
              ? `${M.seconds(timing.lockMs)}s` : '释放待实测' : `${time(skill.foregroundMs)}s`}</small></span></button>`;
      }).join('')}</div>`;
    menu.hidden = false;
    $('mobileAdd').setAttribute('aria-expanded', 'true');
    icons();
    if (!isMobile) {
      const rect = menu.getBoundingClientRect();
      menu.style.left = `${Math.max(12, Math.min(x, innerWidth - rect.width - 12))}px`;
      menu.style.top = `${Math.max(12, Math.min(y, innerHeight - rect.height - 12))}px`;
    }
    menu.querySelector('[data-quick-skill], [data-quick-template]')?.focus({preventScroll: true});
  }

  function closeQuickAdd() {
    state.quickAdd = null;
    $('quickAddMenu').hidden = true;
    $('mobileAdd').setAttribute('aria-expanded', 'false');
  }

  function selectClip(id, scroll = false, mode = 'replace') {
    setSelection(mode === 'toggle' ? isSelected(id) ? state.selection.filter(value => value !== id) : [...state.selection, id]
      : mode === 'add' ? [...state.selection, id] : [id], id);
    paintTimeline();
    paintInspector();
    icons();
    if (scroll && selectedClip()) {
      const clip = selectedClip();
      const x = clip.startMs / 1000 * state.zoom;
      $('timelineScroller').scrollTo({left: Math.max(0, x - 70)});
      $('timelineCanvas').querySelector(`[data-track="${clip.characterId}"]`)?.scrollIntoView({block: 'nearest', inline: 'nearest'});
    }
  }

  function addCharacter(id, at = null, mode = state.libraryAbility, templateId = null, afterId = null) {
    change(() => {
      const start = at ?? (state.playheadMs > 0 ? state.playheadMs : Math.max(0, ...state.project.clips.map(M.endOf)));
      const clip = afterId ? M.insertAfter(state.project, catalog, afterId, mode, state.ripple)
        : M.addClip(state.project, catalog, id, mode, snapped(start), state.ripple);
      if (templateId) {
        const operations = Ops.template(templateId);
        M.editClip(state.project, clip.id, {operations,
          foregroundMs: M.operationDurationMs({...clip, operations})}, state.ripple);
      }
      setSelection([clip.id]);
      state.libraryFocus = id;
    });
    closePanels();
    if (selectedClip()) selectClip(state.selected, true);
  }

  function updateClip(property, value) {
    if (property === 'effectMs') return;
    if (property === 'selectionStartMs') {
      const clips = selectedClips();
      if (clips.length) change(() => M.placeClips(state.project, state.selection, value - clips[0].startMs, {ripple: state.ripple}));
      return;
    }
    const clip = selectedClip();
    if (!clip) return;
    change(() => {
      if (property === 'startMs') {
        const result = M.placeClips(state.project, [clip.id], value - clip.startMs, {ripple: state.ripple});
        if (result.blocked) throw new Error('此位置无法容纳当前动作与换人冷却');
        return;
      }
      let patch = {[property]: value};
      if (property === 'abilityId') {
        const preset = M.ability(catalog, clip.characterId, value);
        const timing = M.timingFor(clip.characterId, value);
        patch = {abilityId: value, foregroundMs: preset.foregroundMs, effectMs: preset.effectMs,
          cooldownMs: preset.cooldownMs, effectPolicy: preset.effectPolicy, hold: false,
          followAttack: false, attackAfterMs: 0, commandOverride: null,
          castTiming: timing ? M.clone(timing) : null, castEstimateMs: preset.foregroundMs,
          lockOverrideMs: null, castInputMs: null, followSourceId: null, effectSource: 'catalog'};
        Object.assign(patch, {operation: Ops.parameters(value), operations: value === 'combo' ? Ops.template() : [],
          readiness: !M.isText(state.project) && M.isProcess(state.project) && ['skill', 'burst'].includes(value) ? value : 'none',
          notReady: value === 'burst' ? 'skip' : 'wait', ensureCast: !M.isText(state.project) && M.isProcess(state.project) && value === 'skill',
          protectCast: true});
        if (timing?.lockMs !== null && timing?.lockMs !== undefined) {
          patch.foregroundMs = Math.max(100, timing.lockMs);
        }
        if (value === 'combo') patch.foregroundMs = M.operationDurationMs({...clip, ...patch});
      }
      if (['castVariantId', 'hold'].includes(property)) {
        const timing = property === 'castVariantId'
          ? M.timingVariants(clip.characterId, clip.abilityId).find(entry => entry.id === value)
          : M.timingFor(clip.characterId, clip.abilityId, value);
        patch = {castTiming: timing ? M.clone(timing) : null, lockOverrideMs: null, castInputMs: null,
          hold: property === 'hold' ? value : timing?.hold || false, commandOverride: null};
        const base = timing?.lockMs ?? selectedAbility(clip).foregroundMs;
        patch.foregroundMs = Math.max(100, base) + (clip.followAttack ? clip.attackAfterMs : 0);
      }
      if (property === 'followSourceId') patch.followSourceId = value ? clip.followSourceId : null;
      if (property === 'lockOverrideMs') patch.castInputMs = null;
      if (property === 'hold') patch.commandOverride = null;
      if (clip.followSourceId && ['condition', 'readiness', 'notReady'].includes(property)) patch.followSourceId = null;
      if (property === 'operation') patch.commandOverride = null;
      if (['txtSkillPolicy', 'protectCast'].includes(property) && clip.abilityId === 'skill'
        && clip.commandOverride !== null && M.parseCommands(clip.commandOverride).length === 1) patch.commandOverride = null;
      if (property === 'txtRounds') M.parseRounds(value);
      if (property === 'commandOverride') M.parseCommands(value);
      M.commandsFor({...clip, ...patch});
      M.editClip(state.project, clip.id, patch, state.ripple);
    });
  }

  function editOperations(operation) {
    const clip = selectedClip();
    if (clip?.abilityId !== 'combo') return;
    change(() => {
      const rows = M.clone(clip.operations || []);
      operation(rows);
      Ops.compile(rows);
      const idleMs = Math.max(0, clip.foregroundMs - M.castDurationMs(clip));
      const patch = {operations: rows, commandOverride: null, ensureCast: false};
      patch.foregroundMs = M.operationDurationMs({...clip, ...patch}) + idleMs;
      M.editClip(state.project, clip.id, patch, state.ripple);
    });
  }

  function assignCopyIndex(copy, count) {
    const indices = state.project.clips.map(M.priorityOf).filter(Number.isFinite);
    const source = M.clone(copy.sourceAction || {});
    for (const key of Object.keys(source)) if (/^index$/i.test(key)) delete source[key];
    source.Index = Math.max(state.project.clips.length + count, ...indices) + 1;
    copy.sourceAction = source;
    copy.priority = source.Index;
  }

  function duplicateClip(id) {
    const source = state.project.clips.find(clip => clip.id === id);
    change(() => {
      const copied = M.makeClip(state.project, catalog, source.characterId, source.abilityId, M.endOf(source));
      const ownId = copied.id, ownName = copied.name, ownOrder = copied.order;
      Object.assign(copied, M.clone(source), {id: ownId, name: ownName, order: ownOrder,
        declarationOrder: copied.declarationOrder, startMs: M.endOf(source)});
      assignCopyIndex(copied, 1);
      state.project.clips.push(copied);
      if (state.ripple) M.repairSchedule(state.project);
      setSelection([copied.id]);
    });
  }

  function deleteClip(id) {
    change(() => {
      state.project.clips = state.project.clips.filter(clip => clip.id !== id);
      for (const clip of state.project.clips) if (clip.followSourceId === id) clip.followSourceId = null;
      setSelection(state.selection.filter(value => value !== id));
    });
  }

  function duplicateSelection() {
    const sources = selectedClips();
    if (!sources.length) return;
    if (sources.length === 1) { duplicateClip(sources[0].id); return; }
    change(() => {
      const delta = Math.max(...sources.map(M.endOf)) - sources[0].startMs;
      const copies = sources.map(source => {
        const copy = M.makeClip(state.project, catalog, source.characterId, source.abilityId, source.startMs + delta);
        Object.assign(copy, M.clone(source), {id: copy.id, name: copy.name, order: copy.order,
          declarationOrder: copy.declarationOrder, startMs: source.startMs + delta});
        assignCopyIndex(copy, sources.length);
        state.project.clips.push(copy);
        return copy.id;
      });
      const replacements = new Map(sources.map((source, index) => [source.id, copies[index]]));
      for (const id of copies) {
        const copy = state.project.clips.find(clip => clip.id === id);
        if (replacements.has(copy.followSourceId)) copy.followSourceId = replacements.get(copy.followSourceId);
      }
      state.project.durationMs = Math.max(state.project.durationMs, ...state.project.clips.map(M.endOf));
      setSelection(copies);
    });
  }

  function deleteSelection() {
    const ids = new Set(state.selection);
    if (!ids.size) return;
    change(() => {
      state.project.clips = state.project.clips.filter(clip => !ids.has(clip.id));
      for (const clip of state.project.clips) if (ids.has(clip.followSourceId)) clip.followSourceId = null;
      setSelection([]);
    });
  }

  function canvasPoint(event) {
    const canvas = $('timelineCanvas').getBoundingClientRect();
    const viewport = $('timelineScroller').getBoundingClientRect();
    return {x: Math.max(viewport.left + labelWidth(), event.clientX) - canvas.left,
      y: Math.max(65, event.clientY - canvas.top)};
  }

  function paintMarquee() {
    const drag = state.drag;
    if (drag?.kind !== 'marquee') return;
    let box = $('timelineCanvas').querySelector('.selection-box');
    if (!box) {
      box = document.createElement('div');
      box.className = 'selection-box';
      box.setAttribute('aria-hidden', 'true');
      $('timelineCanvas').append(box);
    }
    Object.assign(box.style, {left: `${drag.rect.left}px`, top: `${drag.rect.top}px`,
      width: `${drag.rect.right - drag.rect.left}px`, height: `${drag.rect.bottom - drag.rect.top}px`});
  }

  function beginPointer(event) {
    if (event.button !== 0 || event.target.closest('.track-label')) return;
    const resize = event.target.closest('[data-resize]');
    const loopResize = event.target.closest('[data-loop-resize]');
    const clipElement = event.target.closest('[data-clip]');
    const effect = event.target.closest('[data-effect]');
    const ruler = event.target.closest('[data-ruler]');
    const id = resize?.dataset.resize || clipElement?.dataset.clip || effect?.dataset.effect;
    closeQuickAdd();
    if (id) {
      event.preventDefault();
      pause();
      $('timelineCanvas').focus({preventScroll: true});
      const previous = [...state.selection];
      const modifier = event.ctrlKey || event.metaKey;
      const wasSelected = isSelected(id);
      if (resize) setSelection([id]);
      else if (modifier) setSelection(wasSelected ? previous.filter(value => value !== id) : [...previous, id], id);
      else if (event.shiftKey) setSelection([...previous, id], id);
      else if (!wasSelected) setSelection([id]);
      else state.selected = id;
      const clip = state.project.clips.find(item => item.id === id);
      const run = resize?.dataset.runResize
        ? M.foregroundRuns(state.project).find(item => item.id === resize.dataset.runResize) : null;
      state.drag = {kind: resize ? 'resize' : clipElement && isSelected(id) ? 'move' : 'select',
        clipId: id, x: event.clientX, pointer: event.pointerId, before: M.clone(state.project),
        scrollLeft: $('timelineScroller').scrollLeft, clientX: event.clientX, clientY: event.clientY,
        selectionBefore: previous, ids: [...state.selection],
        collapseSelection: !resize && !modifier && !event.shiftKey && wasSelected && previous.length > 1,
        runId: run?.id, runEndMs: run?.endMs,
        startMs: clip.startMs, durationMs: clip.foregroundMs, snapMs: null, moved: false};
      $('timelineCanvas').setPointerCapture(event.pointerId);
      paintTimeline();
      paintInspector();
      icons();
    } else if (loopResize) {
      event.preventDefault();
      pause();
      state.drag = {kind: 'loop', x: event.clientX, pointer: event.pointerId, before: M.clone(state.project),
        scrollLeft: $('timelineScroller').scrollLeft, clientX: event.clientX, clientY: event.clientY,
        durationMs: state.project.durationMs, moved: false};
      $('timelineCanvas').setPointerCapture(event.pointerId);
    } else if (ruler && !event.target.closest('.sticky-label')) {
      event.preventDefault();
      pause();
      state.drag = {kind: 'seek', pointer: event.pointerId};
      state.playheadMs = position(event.clientX);
      paintPlayhead();
      $('timelineCanvas').setPointerCapture(event.pointerId);
    } else if (!event.target.closest('.ruler, .switch-strip, .loop-target') && event.pointerType !== 'touch') {
      event.preventDefault();
      pause();
      $('timelineCanvas').focus({preventScroll: true});
      const point = canvasPoint(event);
      const bounds = $('timelineCanvas').getBoundingClientRect();
      const previous = [...state.selection];
      const base = event.shiftKey || event.ctrlKey || event.metaKey ? previous : [];
      setSelection(base);
      state.drag = {kind: 'marquee', pointer: event.pointerId, origin: point,
        selectionBefore: previous, base,
        rect: {left: point.x, top: point.y, right: point.x, bottom: point.y},
        boxes: [...$('timelineCanvas').querySelectorAll('[data-clip]')].map(element => {
          const rect = element.getBoundingClientRect();
          return {id: element.dataset.clip, left: rect.left - bounds.left, right: rect.right - bounds.left,
            top: rect.top - bounds.top, bottom: rect.bottom - bounds.top};
        }), moved: false};
      $('timelineCanvas').setPointerCapture(event.pointerId);
      paintSelection();
      paintInspector();
      icons();
    }
  }

  function pointerMove(event) {
    const drag = state.drag;
    if (!drag || drag.pointer !== event.pointerId) return;
    drag.clientX = event.clientX;
    drag.clientY = event.clientY;
    if (drag.kind === 'seek') {
      state.playheadMs = position(event.clientX);
      paintPlayhead();
      return;
    }
    if (drag.kind === 'select') return;
    if (drag.kind === 'marquee') {
      const point = canvasPoint(event);
      drag.moved = drag.moved || Math.hypot(point.x - drag.origin.x, point.y - drag.origin.y) > 3;
      drag.rect = {left: Math.min(point.x, drag.origin.x), top: Math.min(point.y, drag.origin.y),
        right: Math.max(point.x, drag.origin.x), bottom: Math.max(point.y, drag.origin.y)};
      const ids = drag.moved ? drag.boxes.filter(box => box.left < drag.rect.right && box.right > drag.rect.left
        && box.top < drag.rect.bottom && box.bottom > drag.rect.top).map(box => box.id) : [];
      setSelection([...drag.base, ...ids]);
      paintMarquee();
      paintSelection();
      paintInspector();
      icons();
      return;
    }
    const pixelDelta = event.clientX - drag.x + $('timelineScroller').scrollLeft - drag.scrollLeft;
    if (Math.abs(pixelDelta) < 3 && !drag.moved) return;
    drag.moved = true;
    const delta = pixelDelta / state.zoom * 1000;
    state.project = M.clone(drag.before);
    if (pixelDelta === 0) {
      drag.snapMs = null;
    } else if (drag.kind === 'loop') {
      state.project.durationMs = Math.max(1000, snapped(drag.durationMs + delta));
    } else if (drag.kind === 'move') {
      const movement = state.snap ? M.snapMove(state.project, drag.ids, delta,
        {anchorId: drag.clipId, stepMs: state.step, thresholdMs: 8 / state.zoom * 1000, markers: [state.playheadMs]})
        : {deltaMs: Math.round(delta / 50) * 50, guideMs: null};
      drag.snapMs = movement.guideMs;
      const result = M.placeClips(state.project, drag.ids, movement.deltaMs, {ripple: state.ripple});
      drag.blocked = result.blocked;
      if (result.deltaMs !== movement.deltaMs) drag.snapMs = null;
    } else if (drag.kind === 'resize' && drag.runId) {
      const step = state.snap ? state.step : 50;
      const endMs = drag.runEndMs + Math.round(delta / step) * step;
      if (endMs !== drag.runEndMs) M.resizeForegroundRun(state.project, drag.runId, endMs, state.ripple);
    } else {
      const step = state.snap ? state.step : 50;
      const patch = {foregroundMs: Math.max(100, drag.durationMs + Math.round(delta / step) * step)};
      M.editClip(state.project, drag.clipId, patch, state.ripple);
    }
    paintTimeline();
    paintInspector();
    icons();
  }

  function finishPointer(event) {
    if (!state.drag || state.drag.pointer !== event.pointerId) return;
    pointerMove(event);
    const drag = state.drag;
    state.drag = null;
    if (drag.moved && drag.before) checkpoint(drag.before);
    if (!drag.moved && drag.collapseSelection) setSelection([drag.clipId]);
    if (drag.blocked) toast('当前组合的间隔不足以容纳换人冷却，请调整组合内的动作间隔', true);
    $('timelineCanvas').querySelector('.selection-box')?.remove();
    if ($('timelineCanvas').hasPointerCapture(event.pointerId)) $('timelineCanvas').releasePointerCapture(event.pointerId);
    paint();
  }

  function cancelPointer() {
    const drag = state.drag;
    if (!drag) return;
    if (drag.before) state.project = drag.before;
    if (drag.selectionBefore) setSelection(drag.selectionBefore);
    state.drag = null;
    if ($('timelineCanvas').hasPointerCapture(drag.pointer)) $('timelineCanvas').releasePointerCapture(drag.pointer);
    paint();
  }

  function updateZoom(value, clientX = null) {
    const scroller = $('timelineScroller');
    const cursor = clientX === null ? scroller.clientWidth / 2
      : Math.max(labelWidth(), Math.min(scroller.clientWidth, clientX - scroller.getBoundingClientRect().left));
    const anchor = (scroller.scrollLeft + cursor - labelWidth()) / state.zoom;
    state.zoom = Math.max(8, Math.min(320, Math.round(value)));
    $('zoom').value = state.zoom;
    paintTimeline();
    icons();
    scroller.scrollLeft = Math.max(0, anchor * state.zoom + labelWidth() - cursor);
  }

  function fitView() {
    updateZoom(($('timelineScroller').clientWidth - labelWidth() - 26) / M.seconds(state.project.durationMs));
    $('timelineScroller').scrollLeft = 0;
  }

  function exportObject() { return M.exportStrategy(state.project, catalog); }
  function exportArtifact() { return M.exportDocument(state.project, catalog); }
  function filename(suffix) {
    return (state.project.name.replace(/[\\/:*?"<>|]/g, '-').trim() || '战斗流程') + suffix;
  }
  function downloadJson(value, suffix) {
    downloadText(JSON.stringify(value, null, 2), suffix, 'application/json;charset=utf-8');
  }
  function downloadText(text, suffix, mime = 'text/plain;charset=utf-8') {
    const blob = new Blob([text], {type: mime});
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename(suffix);
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function showJson() {
    try {
      const document = exportArtifact();
      $('jsonText').value = document.text;
      $('sourceTitle').textContent = `战斗 ${document.format.toUpperCase()}`;
      $('downloadJson').querySelector('span').textContent = `下载 ${document.format.toUpperCase()}`;
      $('jsonMode').textContent = document.format === 'txt' ? 'TXT · 顺序命令'
        : 'JSON · ' + {process: '按步骤推进', timeline: '按计划时刻', original: '条件与优先级'}[executionMode()];
      $('jsonCount').textContent = `${document.format === 'txt' ? state.project.clips.length : document.strategy.Actions.length} 个动作`;
      $('jsonError').textContent = '';
      $('jsonDialog').showModal();
    } catch (error) {
      showIssues();
      toast(error.message, true);
    }
  }

  function showIssues() {
    const issues = M.validate(state.project);
    $('issuesList').innerHTML = issues.length ? issues.map(issue => `<button type="button" class="issue-item
      ${issue.severity === 'warning' ? 'warning' : ''}" data-issue-clip="${html(issue.clipIds[0] || '')}">
      ${icon(issue.severity === 'warning' ? 'info' : 'circle-alert')}<span>${html(issue.message)}</span></button>`).join('')
      : `<div class="issues-good">${icon('circle-check')} 排轴检查通过</div>`;
    $('repairIssues').disabled = !issues.some(issue => issue.severity !== 'warning');
    if (!$('issuesDialog').open) $('issuesDialog').showModal();
    icons();
  }

  function loadObject(value) {
    const project = M.importDocument(value, catalog);
    pause();
    change(() => {
      state.project = project;
      setSelection(project.clips[0] ? [project.clips[0].id] : []);
      state.playheadMs = 0;
      state.cycle = 1;
      state.hasLooped = false;
    });
    $('timelineScroller').scrollLeft = 0;
    window.dispatchEvent(new CustomEvent('combat:project-loaded'));
    toast(M.isText(project) ? 'TXT 策略已打开' : project.scheduling === 'original' ? '已导入，保留原触发条件' : '时间轴工程已打开');
  }

  $('characterSearch').addEventListener('input', event => {
    state.search = event.target.value;
    paintLibrary();
    icons();
  });
  $('elementFilters').addEventListener('click', event => {
    const button = event.target.closest('[data-element]');
    if (!button) return;
    state.element = button.dataset.element;
    paintLibrary();
    icons();
  });
  $('libraryMode').addEventListener('click', event => {
    const button = event.target.closest('[data-mode]');
    if (!button) return;
    state.libraryAbility = button.dataset.mode;
    paintLibrary();
    icons();
  });
  $('characterList').addEventListener('click', event => {
    const add = event.target.closest('[data-add-character]');
    if (add) { addCharacter(add.dataset.addCharacter); return; }
    const select = event.target.closest('[data-select-character]');
    if (select) {
      state.libraryFocus = select.dataset.selectCharacter;
      paintLibrary();
      icons();
    }
  });
  $('characterList').addEventListener('dragstart', event => {
    const tile = event.target.closest('[data-character]');
    if (!tile) return;
    state.draggingCharacter = {id: tile.dataset.character, mode: state.libraryAbility};
    event.dataTransfer.setData('application/x-combat-character', tile.dataset.character);
    event.dataTransfer.setData('text/plain', tile.dataset.character);
    event.dataTransfer.effectAllowed = 'copy';
  });
  $('characterList').addEventListener('dragend', () => {
    state.draggingCharacter = null;
    document.querySelector('.drop-marker')?.remove();
  });
  $('timelineCanvas').addEventListener('dragstart', event => {
    const avatar = event.target.closest('[data-track-avatar]');
    if (avatar) {
      state.draggingCharacter = {id: avatar.dataset.trackAvatar, source: 'track'};
      event.dataTransfer.setData('application/x-combat-track-character', avatar.dataset.trackAvatar);
      event.dataTransfer.setData('text/plain', avatar.dataset.trackAvatar);
      event.dataTransfer.effectAllowed = 'copy';
      return;
    }
    const label = event.target.closest('[data-team-drag]');
    if (!label) return;
    event.dataTransfer.setData('application/x-combat-team', label.dataset.teamDrag);
    event.dataTransfer.effectAllowed = 'move';
  });
  $('timelineCanvas').addEventListener('dragover', event => {
    if (!event.dataTransfer.types.some(type =>
      ['application/x-combat-character', 'application/x-combat-track-character', 'application/x-combat-team'].includes(type))) return;
    event.preventDefault();
    if (!state.draggingCharacter) return;
    let marker = $('timelineCanvas').querySelector('.drop-marker');
    if (!marker) { marker = document.createElement('div'); marker.className = 'drop-marker'; $('timelineCanvas').append(marker); }
    marker.style.left = `${labelWidth() + snapped(position(event.clientX)) / 1000 * state.zoom}px`;
    event.dataTransfer.dropEffect = 'copy';
  });
  $('timelineCanvas').addEventListener('drop', event => {
    const id = event.dataTransfer.getData('application/x-combat-character');
    const trackCharacter = event.dataTransfer.getData('application/x-combat-track-character');
    const team = event.dataTransfer.getData('application/x-combat-team');
    if (!id && !team && !trackCharacter) return;
    event.preventDefault();
    document.querySelector('.drop-marker')?.remove();
    if (trackCharacter) {
      openQuickAdd(trackCharacter, position(event.clientX), event.clientX + 8, event.clientY + 8);
      state.draggingCharacter = null;
    } else if (id) {
      addCharacter(id, position(event.clientX), state.draggingCharacter?.mode || state.libraryAbility);
      state.draggingCharacter = null;
    } else {
      const target = event.target.closest('[data-track]')?.dataset.track;
      if (target && target !== team) change(() => {
        const list = state.project.team.filter(value => value !== team);
        list.splice(list.indexOf(target), 0, team);
        state.project.team = list;
      });
    }
  });
  $('timelineCanvas').addEventListener('dragend', () => {
    state.draggingCharacter = null;
    $('timelineCanvas').querySelector('.drop-marker')?.remove();
  });
  $('timelineCanvas').addEventListener('pointerdown', beginPointer);
  $('timelineCanvas').addEventListener('pointermove', pointerMove);
  $('timelineCanvas').addEventListener('pointerup', finishPointer);
  $('timelineCanvas').addEventListener('pointercancel', cancelPointer);

  $('inspectorContent').addEventListener('change', event => {
    const input = event.target;
    if (input.readOnly) return;
    if (input.id === 'conditionPreset') {
      const clip = selectedClip();
      if (!clip || !input.value) return;
      const join = $('conditionJoin').value;
      updateClip('condition', !clip.condition.trim() || join === 'replace' ? input.value
        : `(${clip.condition.trim()}) ${join === 'or' ? '||' : '&&'} (${input.value})`);
    } else if (input.dataset.priorityField) {
      const clip = selectedClip();
      if (!clip) return;
      const rows = M.clone(M.prioritiesOf(clip)), index = Number(input.dataset.priorityIndex);
      const key = input.dataset.priorityField, entry = rows[index];
      for (const field of Object.keys(entry)) if (field.toLowerCase() === key.toLowerCase()) delete entry[field];
      entry[key] = key === 'Priority' ? Number(input.value) : input.value;
      updateClip('morePriorities', rows);
    } else if (input.dataset.operationField) {
      const field = input.dataset.operationField;
      const value = input.type === 'checkbox' ? input.checked : field === 'durationMs' ? M.ms(input.value)
        : ['x', 'y', 'amount'].includes(field) ? Number(input.value) : input.value;
      if (input.dataset.operationIndex !== undefined) {
        const index = Number(input.dataset.operationIndex);
        editOperations(rows => {
          rows[index] = field === 'type' ? Ops.make(value) : {...rows[index], [field]: value};
        });
      } else {
        const clip = selectedClip();
        if (clip) updateClip('operation', {...clip.operation, [field]: value});
      }
    } else if (input.dataset.property) {
      const property = input.dataset.property;
      const value = input.type === 'checkbox' ? input.checked
        : property === 'lockOverrideMs' ? input.value === '' ? null : M.ms(input.value)
        : ['startMs', 'foregroundMs', 'effectMs', 'cooldownMs', 'attackAfterMs', 'selectionStartMs'].includes(property)
          ? M.ms(input.value) : property === 'priority' ? Number(input.value) : input.value;
      updateClip(property, value);
    } else if (input.id === 'schedulingMode') setExecutionMode(input.value);
    else if (input.id === 'txtWaitGaps') change(() => { state.project.txtWaitGaps = input.checked; });
    else if (input.id === 'projectAuthor') change(() => { state.project.author = input.value; });
    else if (input.id === 'preActions') change(() => { state.project.preActions = input.value.split('\n').filter(line => line.trim()); });
  });
  $('roleSwitcher').addEventListener('input', event => {
    if (event.target.id !== 'roleCandidateSearch' || !state.roleSwitcher) return;
    state.roleSwitcher.search = event.target.value;
    paintRoleCandidates();
  });
  $('roleSwitcher').addEventListener('change', event => {
    if (event.target.id !== 'rolePosition' || !state.roleSwitcher) return;
    const id = state.roleSwitcher.characterId, value = event.target.value;
    change(() => M.configureRole(state.project, id, value));
  });
  $('roleSwitcher').addEventListener('click', event => {
    event.stopPropagation();
    const open = state.roleSwitcher;
    if (!open) return;
    if (event.target.closest('[data-role-close]')) { closeRoleSwitcher(true); return; }
    if (event.target.closest('[data-role-process]')) { setExecutionMode('process'); return; }
    if (event.target.closest('[data-role-adding]')) {
      open.adding = !open.adding;
      paintRoleSwitcher();
      if (open.adding) $('roleCandidateSearch').focus({preventScroll: true});
      return;
    }
    const add = event.target.closest('[data-role-add]'), select = event.target.closest('[data-role-select]');
    const remove = event.target.closest('[data-role-remove]');
    const up = event.target.closest('[data-role-up]'), down = event.target.closest('[data-role-down]');
    if (add || select) {
      const target = add?.dataset.roleAdd ?? select.dataset.roleSelect;
      let switched = false;
      pause();
      change(() => {
        if (add) M.addRoleCandidate(state.project, catalog, open.characterId, target);
        M.switchRoleCharacter(state.project, catalog, open.characterId, target);
        open.characterId = target;
        switched = true;
      });
      if (switched) {
        closeRoleSwitcher();
        paintTimeline();
        icons();
        document.querySelector(`[data-role-toggle="${target}"]`)?.focus({preventScroll: true});
      }
    } else if (remove) {
      change(() => M.removeRoleCandidate(state.project, open.characterId, remove.dataset.roleRemove));
    } else if (up || down) {
      change(() => M.moveRoleCandidate(state.project, open.characterId,
        up?.dataset.roleUp ?? down.dataset.roleDown, up ? -1 : 1));
    }
  });
  document.addEventListener('pointerdown', event => {
    if (state.roleSwitcher && !event.target.closest('#roleSwitcher, [data-role-toggle]')) closeRoleSwitcher();
  });
  document.addEventListener('click', event => {
    const priorityAdd = event.target.closest('[data-priority-add]');
    const priorityRemove = event.target.closest('[data-priority-remove]');
    if ((priorityAdd || priorityRemove) && selectedClip()) {
      const rows = M.clone(M.prioritiesOf(selectedClip()));
      if (priorityAdd) {
        const ability = selectedClip().abilityId;
        rows.push({Priority: M.priorityOf(selectedClip()) - 1, Expression: 'low-hp()' +
          (ability === 'skill' ? ' && e-ready()' : ability === 'burst' ? ' && q-ready()' : '')});
      }
      else rows.splice(Number(priorityRemove.dataset.priorityRemove), 1);
      updateClip('morePriorities', rows);
      return;
    }
    const roleToggle = event.target.closest('[data-role-toggle]');
    if (roleToggle) { openRoleSwitcher(roleToggle.dataset.roleToggle); return; }
    const quickAdd = event.target.closest('[data-quick-add]');
    const appendAction = event.target.closest('[data-append-action]');
    const quickCommon = event.target.closest('[data-quick-common]');
    const quickSkill = event.target.closest('[data-quick-skill]');
    const quickTab = event.target.closest('[data-quick-tab]');
    const quickTemplate = event.target.closest('[data-quick-template]');
    if (quickTab && state.quickAdd) {
      const {characterId, startMs, x, y} = state.quickAdd;
      openQuickAdd(characterId, startMs, x, y, quickTab.dataset.quickTab);
      return;
    }
    if (appendAction && selectedClip()) {
      const clip = selectedClip();
      addCharacter(clip.characterId, null, appendAction.dataset.appendAction, null, clip.id);
      return;
    }
    if (quickCommon && state.quickAdd) {
      const {characterId, startMs, afterId} = state.quickAdd;
      closeQuickAdd();
      addCharacter(characterId, startMs, quickCommon.dataset.quickCommon, null, afterId);
      return;
    }
    if (quickAdd) {
      const rect = quickAdd.getBoundingClientRect();
      const id = quickAdd.dataset.quickAdd;
      openQuickAdd(id, quickInsertionMs(id), rect.right + 7, rect.top);
      return;
    }
    if (quickSkill && state.quickAdd) {
      const {characterId, startMs, afterId} = state.quickAdd;
      closeQuickAdd();
      addCharacter(characterId, startMs, quickSkill.dataset.quickSkill, null, afterId);
      return;
    }
    if (quickTemplate && state.quickAdd) {
      const {characterId, startMs, afterId} = state.quickAdd;
      closeQuickAdd();
      addCharacter(characterId, startMs, 'combo', quickTemplate.dataset.quickTemplate, afterId);
      return;
    }
    const operationAdd = event.target.closest('[data-operation-add]');
    const operationRemove = event.target.closest('[data-operation-remove]');
    const operationUp = event.target.closest('[data-operation-up]');
    const operationDown = event.target.closest('[data-operation-down]');
    const operationTemplate = event.target.closest('[data-operation-template]');
    if (operationAdd) { editOperations(rows => rows.push(Ops.make('wait'))); return; }
    if (operationRemove) { editOperations(rows => rows.splice(Number(operationRemove.dataset.operationRemove), 1)); return; }
    if (operationUp || operationDown) {
      const index = Number(operationUp?.dataset.operationUp ?? operationDown.dataset.operationDown);
      const to = index + (operationUp ? -1 : 1);
      editOperations(rows => { [rows[index], rows[to]] = [rows[to], rows[index]]; });
      return;
    }
    if (operationTemplate) {
      const rows = Ops.template($('comboTemplate').value);
      editOperations(operations => { operations.splice(0, operations.length, ...rows); });
      return;
    }
    const withinQuickAdd = event.composedPath().some(node => node.id === 'quickAddMenu' || node.id === 'mobileAdd');
    if (event.target.closest('[data-close-quick]') || !withinQuickAdd) closeQuickAdd();
    const remove = event.target.closest('[data-remove-character]');
    const duplicate = event.target.closest('[data-duplicate]');
    const deleteButton = event.target.closest('[data-delete]');
    const sequence = event.target.closest('[data-sequence]');
    const close = event.target.closest('[data-close-dialog]');
    const closePanel = event.target.closest('[data-close-panel]');
    const issue = event.target.closest('[data-issue-clip]');
    const single = event.target.closest('[data-select-single]');
    if (remove) change(() => {
      M.removeCharacter(state.project, remove.dataset.removeCharacter);
      setSelection(state.selection);
    });
    else if (event.target.closest('[data-duplicate-selection]')) duplicateSelection();
    else if (event.target.closest('[data-delete-selection]')) deleteSelection();
    else if (single) selectClip(single.dataset.selectSingle, true);
    else if (duplicate) duplicateClip(duplicate.dataset.duplicate);
    else if (deleteButton) deleteClip(deleteButton.dataset.delete);
    else if (sequence) selectClip(sequence.dataset.sequence, true,
      event.ctrlKey || event.metaKey ? 'toggle' : event.shiftKey ? 'add' : 'replace');
    else if (close) $(close.dataset.closeDialog).close();
    else if (closePanel) closePanels();
    else if (issue) {
      $('issuesDialog').close();
      if (issue.dataset.issueClip) selectClip(issue.dataset.issueClip, true);
    }
  });

  $('projectName').addEventListener('change', event => change(() => { state.project.name = event.target.value.trim() || '未命名战斗流程'; }));
  $('undo').addEventListener('click', undo);
  $('redo').addEventListener('click', redo);
  $('snapToggle').addEventListener('click', () => {
    state.snap = !state.snap;
    $('snapToggle').classList.toggle('selected', state.snap);
    $('snapToggle').setAttribute('aria-pressed', String(state.snap));
  });
  $('snapStep').addEventListener('change', event => { state.step = Number(event.target.value); });
  $('rippleToggle').addEventListener('change', event => { state.ripple = event.target.checked; });
  $('executionMode').addEventListener('change', event => setExecutionMode(event.target.value));
  $('strategyModeControl').addEventListener('click', event => {
    const button = event.target.closest('[data-strategy-format]');
    if (!button || button.getAttribute('aria-pressed') === 'true') return;
    pause();
    closeQuickAdd();
    closeRoleSwitcher();
    change(() => M.setStrategyFormat(state.project, button.dataset.strategyFormat));
    toast(M.isText(state.project) ? 'TXT 模式 · JSON 条件保留在工程中' : 'JSON 模式 · 条件设置已恢复');
    window.dispatchEvent(new CustomEvent('combat:format-changed', {detail: {format: state.project.strategyFormat}}));
  });
  $('zoom').addEventListener('input', event => updateZoom(Number(event.target.value)));
  $('zoomIn').addEventListener('click', () => updateZoom(state.zoom + 12));
  $('zoomOut').addEventListener('click', () => updateZoom(state.zoom - 12));
  $('fitView').addEventListener('click', fitView);
  $('timelineScroller').addEventListener('wheel', event => {
    if (!event.deltaY && !event.deltaX) return;
    event.preventDefault();
    const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
    if (event.ctrlKey || event.metaKey) {
      updateZoom(state.zoom + (delta < 0 ? 12 : -12), event.clientX);
      return;
    }
    const scroller = $('timelineScroller');
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2
      ? event.altKey ? scroller.clientHeight : scroller.clientWidth : 1;
    if (event.altKey) scroller.scrollTop += delta * unit;
    else scroller.scrollLeft += delta * unit;
    const drag = state.drag;
    if (drag && ['move', 'resize', 'loop'].includes(drag.kind)) {
      pointerMove({pointerId: drag.pointer, clientX: drag.clientX, clientY: drag.clientY});
    }
  }, {passive: false});
  $('libraryToggle').addEventListener('click', () => openPanel('library'));
  $('inspectorToggle').addEventListener('click', () => openPanel('inspector'));
  $('mobileAdd').addEventListener('click', () => {
    if (state.quickAdd) { closeQuickAdd(); return; }
    const characterId = selectedClip()?.characterId || state.project.team[0];
    if (!characterId) { openPanel('library'); return; }
    openQuickAdd(characterId, quickInsertionMs(characterId), 0, 0);
  });
  $('mobileAdjust').addEventListener('click', () => {
    const wasOpen = $('mobileAdjustPanel').classList.contains('open');
    closeQuickAdd();
    closePanels();
    if (!wasOpen) {
      $('mobileAdjustPanel').classList.add('open');
      $('mobileAdjust').setAttribute('aria-expanded', 'true');
    }
  });
  $('panelBackdrop').addEventListener('click', closePanels);
  $('play').addEventListener('click', play);
  $('stop').addEventListener('click', () => {
    pause();
    state.playheadMs = 0;
    state.cycle = 1;
    state.hasLooped = false;
    paintPlayhead();
    $('timelineScroller').scrollLeft = 0;
  });
  $('playbackSpeed').addEventListener('change', event => { state.speed = Number(event.target.value); });
  $('loopDuration').addEventListener('change', event => change(() => { state.project.durationMs = Math.max(1000, M.ms(event.target.value)); }));
  $('repeatToggle').addEventListener('change', event => change(() => { state.project.repeat = event.target.checked; }));
  $('fitLoop').addEventListener('click', () => {
    change(() => M.fitLoop(state.project));
    toast(M.isProcess(state.project) ? '已整理动作间隔与换人边界' : '已按前台占用、换人间隔和技能冷却整理');
  });
  $('validationStatus').addEventListener('click', showIssues);
  $('repairIssues').addEventListener('click', () => {
    change(() => M.fitLoop(state.project));
    $('issuesDialog').close();
    toast('已整理排轴');
  });
  $('newProject').addEventListener('click', () => $('newDialog').showModal());
  $('createEmpty').addEventListener('click', () => {
    const format = $('newFormat').value;
    const project = {...M.emptyProject(), name: $('newName').value.trim() || '新的战斗流程'};
    if (format === 'txt') M.setStrategyFormat(project, 'txt');
    else project.scheduling = 'original';
    loadObject(project);
    $('newDialog').close();
  });
  $('createDemo').addEventListener('click', () => {
    const format = $('newFormat').value, project = M.demoProject(catalog);
    if (format === 'txt') M.setStrategyFormat(project, 'txt');
    loadObject(project);
    $('newDialog').close();
  });
  $('saveProject').addEventListener('click', () => {
    downloadJson(state.project, '.combat-timeline.json');
    toast('工程文件已导出');
  });
  $('importProject').addEventListener('click', () => {
    $('importInput').value = '';
    $('importInput').click();
  });
  $('importInput').addEventListener('change', async event => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      const project = M.importDocument(await file.text(), catalog, {name: file.name.replace(/\.[^.]+$/, '')});
      loadObject(project);
    }
    catch (error) { toast(error.message, true); }
  });
  $('showJson').addEventListener('click', showJson);
  $('exportStrategy').addEventListener('click', () => {
    try {
      const document = exportArtifact();
      downloadText(document.text, document.extension, document.mime);
      toast(`战斗 ${document.format.toUpperCase()} 已导出`);
    }
    catch (error) { toast(error.message, true); }
  });
  $('downloadJson').addEventListener('click', () => {
    try {
      const text = $('jsonText').value;
      const project = M.importDocument(text, catalog);
      if (M.isText(project)) downloadText(text, '.txt');
      else downloadText(text, '.json', 'application/json;charset=utf-8');
    } catch (error) { $('jsonError').textContent = error.message; }
  });
  $('applyJson').addEventListener('click', () => {
    try {
      loadObject($('jsonText').value);
      $('jsonDialog').close();
    } catch (error) { $('jsonError').textContent = error.message; }
  });
  $('copyJson').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('jsonText').value);
      toast('策略源码已复制');
    } catch {
      $('jsonText').focus();
      $('jsonText').select();
      toast('已选中策略源码');
    }
  });
  document.addEventListener('keydown', event => {
    const target = event.target;
    if (event.key === 'Escape') {
      if (state.roleSwitcher) { event.preventDefault(); closeRoleSwitcher(true); return; }
      if (state.quickAdd) { event.preventDefault(); closeQuickAdd(); $('timelineCanvas').focus(); return; }
      if (state.drag) { event.preventDefault(); cancelPointer(); return; }
      if (isMobile && document.querySelector('.side-panel.open')) { event.preventDefault(); closePanels(); return; }
    }
    const editable = ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable;
    if (editable || state.roleSwitcher || document.querySelector('dialog[open]')) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      event.shiftKey ? redo() : undo();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      redo();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      setSelection(M.ordered(state.project).map(clip => clip.id));
      paintSelection();
      paintInspector();
      icons();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'd') {
      event.preventDefault();
      duplicateSelection();
    } else if (event.key === 'Escape') {
      setSelection([]);
      paintSelection();
      paintInspector();
      icons();
    } else if (['+', '=', '-'].includes(event.key)) {
      event.preventDefault();
      updateZoom(state.zoom + (event.key === '-' ? -12 : 12));
    } else if ((event.ctrlKey || event.metaKey) && event.key === '0') {
      event.preventDefault();
      fitView();
    } else if (event.code === 'Space' && target.tagName !== 'BUTTON') {
      event.preventDefault();
      play();
    } else if (['Delete', 'Backspace'].includes(event.key) && state.selection.length) {
      event.preventDefault();
      deleteSelection();
    } else if (['ArrowLeft', 'ArrowRight'].includes(event.key) && target.dataset.resize && selectedClip()) {
      event.preventDefault();
      updateClip('foregroundMs', Math.max(100, selectedClip().foregroundMs +
        (event.key === 'ArrowRight' ? state.step : -state.step)));
    }
  });
  document.addEventListener('error', event => {
    if (event.target.tagName !== 'IMG') return;
    const image = event.target;
    const fallback = document.createElement('span');
    fallback.className = `${image.className} ${image.alt ? 'avatar-fallback' : 'skill-fallback'}`;
    fallback.textContent = image.dataset.fallback || image.alt.slice(0, 1);
    if (image.alt) fallback.setAttribute('aria-label', image.alt);
    image.replaceWith(fallback);
  }, true);
  window.addEventListener('resize', () => {
    syncMobileLayout();
    if (!isMobile) closeQuickAdd();
    if (window.innerWidth > 980) closePanels();
    paintTimeline();
    icons();
  });
  function rosterDetails(characterId) {
    const character = state.roster?.characters?.find(row => String(row.id) === characterId);
    if (!character) return '';
    const weapon = character.weapon;
    return `<section class="inspector-section roster-details"><h3>账号角色资料</h3>
      <dl><div><dt>等级</dt><dd>${html(character.level)} / ${html(character.max_level || 90)}</dd></div>
        ${weapon ? `<div><dt>武器</dt><dd>${html(weapon.name)} · 等级 ${html(weapon.level)}</dd></div>` : ''}
        ${(character.skills || []).map(skill => `<div><dt>${html(skill.name)}</dt><dd>等级 ${html(skill.level)}</dd></div>`).join('')}
      </dl></section>`;
  }
  function setDraftKey(key) {
    if (key === storageKey) return;
    pause();
    storageKey = key;
    try {
      const saved = localStorage.getItem(storageKey);
      state.project = saved ? M.normalizeProject(JSON.parse(saved), catalog) : M.demoProject(catalog);
    } catch { state.project = M.demoProject(catalog); }
    setSelection(state.project.clips[0] ? [state.project.clips[0].id] : []);
    state.undo = []; state.redo = []; state.playheadMs = 0; state.cycle = 1; state.hasLooped = false;
    state.roster = null; state.ownedOnly = false;
    paint(); persist();
  }
  window.combatEditor = {apiVersion: 1, state, model: M, catalog, paint, loadObject, addCharacter, updateClip,
    selectClip, exportObject, exportArtifact, notify: toast, setDraftKey,
    getProject() { return M.clone(state.project); },
    setOwnedOnly(value) { state.ownedOnly = Boolean(value); paint(); },
    setRoster(record, ownedOnly = true) {
      state.roster = record ? M.clone(record) : null; state.ownedOnly = Boolean(ownedOnly);
      if (record?.characters?.length) state.libraryFocus = String(record.characters[0].id);
      paint();
    },
    seek(timeMs) { pause(); state.playheadMs = timeMs; paintPlayhead(); }};
  syncMobileLayout();
  paint();
  persist();
})();
