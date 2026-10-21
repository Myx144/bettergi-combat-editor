(function(root) {
  'use strict';

  function create({model: M, catalog, getProject, change, icons, toast, onSwitch, onExportText}) {
    const $ = id => document.getElementById(id);
    const mount = $('multiplayerControls');
    if (!mount) throw new Error('联机工具缺少 multiplayerControls 容器');
    const html = value => String(value ?? '').replace(/[&<>"']/g, char =>
      ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
    const icon = name => `<i data-lucide="${name}"></i>`;
    const read = (value, field, fallback) => {
      const key = Object.keys(value || {}).find(name => name.toLowerCase() === field.toLowerCase());
      return key === undefined ? fallback : value[key];
    };
    const set = (value, field, content) => {
      for (const key of Object.keys(value)) if (key.toLowerCase() === field.toLowerCase()) delete value[key];
      if (content !== undefined) value[field] = content;
    };
    const character = id => catalog.characters.find(row => row.id === String(id));
    const namedCharacter = name => catalog.characters.find(row => row.name === name);
    const unassigned = '__unassigned__';
    let draft = null, returnFocus = null;

    mount.classList.add('multiplayer-controls');
    mount.innerHTML = `<label id="multiplayerTargetControl" class="multiplayer-target-control" hidden>
        <span>添加至</span><select id="activePlayerTarget" aria-label="当前添加动作目标"></select></label>
      <button id="manageMultiplayer" class="icon-button multiplayer-manage" type="button"
        title="联机玩家设置" aria-label="联机玩家设置">${icon('network')}<span class="multiplayer-button-label">联机</span></button>
      <button id="exportPlayerText" class="icon-button" type="button" title="导出所选玩家 TXT"
        aria-label="导出所选玩家 TXT" hidden>${icon('file-output')}</button>`;

    const dialog = document.createElement('dialog');
    dialog.id = 'multiplayerDialog';
    dialog.className = 'multiplayer-dialog';
    dialog.setAttribute('aria-labelledby', 'multiplayerTitle');
    dialog.innerHTML = `<header class="dialog-heading"><h2 id="multiplayerTitle">联机玩家设置</h2>
        <button class="icon-button" type="button" data-multiplayer-close title="关闭联机设置"
          aria-label="关闭联机设置">${icon('x')}</button></header>
      <div class="multiplayer-configuration-bar">
        <label class="multiplayer-field"><span>人数</span><select id="multiplayerCount" data-mp-focus="count" aria-label="联机人数">
          <option value="2">2 人</option><option value="3">3 人</option><option value="4">4 人</option></select></label>
        <label class="multiplayer-field multiplayer-host-field"><span>房主</span>
          <select id="multiplayerHost" data-mp-focus="host" aria-label="房主玩家"></select></label>
        <output id="multiplayerSlots" class="multiplayer-slot-summary"></output>
      </div>
      <div class="multiplayer-content">
        <p id="multiplayerBlocked" class="multiplayer-blocked" role="alert" hidden></p>
        <div id="multiplayerConfiguration">
          <div id="multiplayerPlayers" class="multiplayer-player-list"></div>
          <section class="multiplayer-common-section">
            <label class="multiplayer-field"><span>公共开场</span>
              <textarea id="multiplayerCommonPreActions" data-mp-focus="common" rows="3" spellcheck="false"
                aria-label="各端公共开场指令" placeholder="wait(0.3)"></textarea></label>
            <p class="multiplayer-field-note">仅填写不指定角色的通用指令；具名角色指令放到对应玩家的开场中。</p>
          </section>
          <section id="multiplayerRoleSection" class="multiplayer-role-section" aria-labelledby="multiplayerRoleTitle" hidden>
            <header class="multiplayer-section-heading"><h3 id="multiplayerRoleTitle">角色定位归属</h3></header>
            <p class="multiplayer-field-note">保留原定位与兼容分支；全部候选和相关具名动作需属于同一端。</p>
            <div id="multiplayerRoles" class="multiplayer-role-list"></div>
          </section>
          <section class="multiplayer-ownership-section" aria-labelledby="multiplayerOwnershipTitle">
            <header class="multiplayer-section-heading"><h3 id="multiplayerOwnershipTitle">动作归属</h3>
              <span id="multiplayerOwnershipCount"></span></header>
            <p id="multiplayerOwnershipNote" class="multiplayer-field-note"></p>
            <div id="multiplayerAssignments" class="multiplayer-assignment-list"></div>
          </section>
        </div>
      </div>
      <footer class="multiplayer-actions">
        <ul id="multiplayerErrors" class="multiplayer-errors" role="alert" hidden></ul>
        <span id="multiplayerDraftStatus" role="status"></span>
        <button type="button" data-multiplayer-close>取消</button>
        <button id="saveMultiplayer" class="primary" type="button">${icon('check')}<span>保存配置</span></button>
      </footer>`;
    document.body.append(dialog);

    function activeRows() { return draft.rows.slice(0, draft.count); }
    function playerLabel(row, index = draft.rows.indexOf(row)) { return row.id || `玩家 ${index + 1}`; }
    function slotCount(row) { return draft.count === 2 || draft.count === 3 && row.key === draft.hostKey ? 2 : 1; }
    function isCurrent(clip) {
      return Boolean(clip.useCurrentCharacter) || read(clip.sourceAction, 'Character', null) === '';
    }
    function lines(text) { return text.split(/\r?\n/).filter(line => line.trim()); }
    function newPlayer(index, native = null) {
      const source = M.clone(native || {});
      const targeting = read(source, 'EnableCombatTargeting', undefined);
      return {key: `player${index + 1}`, source, originalId: native ? read(source, 'Id', '') : '',
        id: read(source, 'Id', ['learner', 'helper', 'player3', 'player4'][index]),
        characters: M.clone(read(source, 'Characters', [])),
        preActionsText: read(source, 'PreActions', []).join('\n'), preActionsChanged: false,
        targeting: targeting == null ? '' : String(targeting), targetingChanged: false};
    }
    function recommend(assignment) {
      const name = character(assignment.characterId)?.name;
      const matches = activeRows().filter(row => row.characters.includes(name));
      return matches.length === 1 ? matches[0].key : unassigned;
    }
    function updateRecommendations() {
      if (!draft.initial) return;
      for (const assignment of draft.assignments) {
        if (!assignment.explicit && !assignment.currentCharacter) assignment.targetKey = recommend(assignment);
      }
      for (const role of draft.roleSlots) {
        if (role.explicit) continue;
        const candidates = role.source.candidates.map(candidate => character(candidate.characterId)?.name);
        const choices = activeRows().filter(row => candidates.every(name => row.characters.includes(name)));
        const owners = new Set(draft.assignments.filter(assignment => !assignment.currentCharacter
          && assignment.characterId === role.source.characterId).map(assignment => assignment.targetKey));
        role.targetKey = choices.length === 1 && (!owners.size || owners.size === 1 && owners.has(choices[0].key))
          ? choices[0].key : owners.size === 1 && choices.some(row => owners.has(row.key))
            ? [...owners][0] : unassigned;
      }
    }
    function blockReason(project) {
      if (M.hasTeams(project)) return '多阵容工程不能同时启用联机。请先打开单一阵容工程。';
      if (M.isText(project)) return '联机策略使用 JSON。请先切换为 JSON，再配置玩家。';
      return '';
    }
    function prepareDraft() {
      const project = getProject(), initial = !M.isMultiplayer(project);
      const header = initial ? {Version: 1, Players: []}
        : M.clone(project.multiplayer || read(project.sourceRoot, 'Multiplayer', {}));
      const natives = initial ? [] : M.players(project);
      const rows = (initial ? [null, null] : natives).map((native, index) => newPlayer(index, native));
      const clips = M.declared(project);
      if (initial) {
        const names = [...new Set(clips.filter(clip => !isCurrent(clip)).map(clip => character(clip.characterId)?.name).filter(Boolean))];
        rows[0].characters = names.slice(0, 2);
        rows[1].characters = names.slice(2, 4);
      }
      const hosts = initial ? [rows[0]] : rows.filter(row => read(row.source, 'IsHost', false));
      draft = {initial, header, rows, count: rows.length, hostKey: hosts.length === 1 ? hosts[0].key : '',
        commonSource: M.clone(project.preActions || []), commonText: (project.preActions || []).join('\n'),
        commonChanged: false, errors: [], changed: false, blocked: blockReason(project),
        activeKey: rows.find(row => row.originalId === project.activePlayerId)?.key || '',
        roleSlots: initial ? (project.roleSlots || []).map((source, index) =>
          ({key: `role${index}`, source: M.clone(source), targetKey: unassigned, explicit: false})) : [],
        assignments: clips.map(clip => {
          const currentCharacter = isCurrent(clip);
          const owner = rows.find(row => row.originalId && row.originalId === clip.playerId);
          return {clipId: clip.id, name: clip.name, priority: M.priorityOf(clip),
            originalCharacterId: currentCharacter ? '' : clip.characterId,
            characterId: currentCharacter ? '' : clip.characterId, currentCharacter,
            targetKey: initial ? currentCharacter ? '' : unassigned
              : clip.playerId ? owner?.key || `missing:${clip.playerId}` : currentCharacter ? '' : unassigned,
            explicit: !initial};
        })};
      updateRecommendations();
    }
    function avatar(name) {
      const row = namedCharacter(name);
      if (!row) return `<span class="multiplayer-avatar-placeholder" aria-hidden="true">${icon('user-round')}</span>`;
      return row.avatar
        ? `<img class="multiplayer-avatar" src="${html(row.avatar)}" alt="" draggable="false">`
        : `<span class="multiplayer-avatar-placeholder" aria-hidden="true">${html(row.name.slice(0, 1))}</span>`;
    }
    function rowFor(key) { return draft.rows.find(row => row.key === key); }
    function markChanged() {
      draft.changed = true;
      $('multiplayerDraftStatus').textContent = '配置尚未保存';
    }
    function refreshPlayerLabels() {
      const active = new Set(activeRows().map(row => row.key));
      for (const select of dialog.querySelectorAll('#multiplayerHost, [data-mp-owner], [data-mp-role-owner]')) {
        for (const option of select.options) {
          const row = rowFor(option.value);
          if (!row) continue;
          option.textContent = !active.has(row.key) ? `已移除：${playerLabel(row)}`
            : `${playerLabel(row)}${select.id !== 'multiplayerHost' && row.key === draft.hostKey ? ' · 房主' : ''}`;
        }
      }
      for (const section of dialog.querySelectorAll('[data-mp-player]')) {
        const row = rowFor(section.dataset.mpPlayer), label = playerLabel(row);
        section.querySelector('.multiplayer-character-slots').setAttribute('aria-label', `${label}的角色`);
        for (const select of section.querySelectorAll('[data-mp-character]'))
          select.setAttribute('aria-label', `${label}的角色${Number(select.dataset.mpSlot) + 1}`);
        section.querySelector('[data-mp-targeting]').setAttribute('aria-label', `${label}索敌设置`);
        section.querySelector('[data-mp-preactions]').setAttribute('aria-label', `${label}的开场指令`);
        const mapping = section.querySelector('.multiplayer-id-mapping');
        mapping.hidden = !row.originalId || row.originalId === row.id;
        mapping.querySelector('[data-mp-mapped-id]').textContent = row.id || '未填写';
      }
    }
    function updateTextDraft(input) {
      let changed = false;
      if (input.dataset.mpId) {
        const row = rowFor(input.dataset.mpId);
        changed = row.id !== input.value;
        row.id = input.value;
        if (changed) refreshPlayerLabels();
      } else if (input.dataset.mpPreactions) {
        const row = rowFor(input.dataset.mpPreactions);
        changed = row.preActionsText !== input.value;
        row.preActionsText = input.value;
        if (changed) row.preActionsChanged = true;
      } else if (input.id === 'multiplayerCommonPreActions') {
        changed = draft.commonText !== input.value;
        draft.commonText = input.value;
        if (changed) draft.commonChanged = true;
      } else return false;
      if (changed) markChanged();
      return true;
    }
    function focusSnapshot() {
      const active = document.activeElement;
      return dialog.contains(active) && active.dataset.mpFocus
        ? {key: active.dataset.mpFocus, start: active.selectionStart, end: active.selectionEnd, scrollTop: active.scrollTop} : null;
    }
    function restoreFocus(saved) {
      if (!saved || !dialog.open) return;
      const input = [...dialog.querySelectorAll('[data-mp-focus]')].find(node => node.dataset.mpFocus === saved.key);
      if (!input) return;
      input.focus({preventScroll: true});
      if (saved.start !== undefined && saved.start !== null) input.setSelectionRange(saved.start, saved.end);
      input.scrollTop = saved.scrollTop;
    }
    function characterOptions(value, selected = []) {
      const extra = value && !namedCharacter(value) ? `<option value="${html(value)}" selected>${html(value)} · 未收录</option>` : '';
      return '<option value="">选择角色</option>' + extra + catalog.characters.map(row =>
        `<option value="${html(row.name)}" ${row.name === value ? 'selected' : ''}
          ${row.name !== value && selected.includes(row.name) ? 'disabled' : ''}>${html(row.name)}</option>`).join('');
    }
    function renderPlayers() {
      $('multiplayerPlayers').innerHTML = activeRows().map((row, index) => {
        const expected = slotCount(row), slots = Math.max(expected, row.characters.length);
        const assigned = draft.assignments.filter(assignment => assignment.targetKey === row.key).length;
        return `<section class="multiplayer-player-row" data-mp-player="${row.key}">
          <header class="multiplayer-player-heading"><h3>玩家 ${index + 1}${row.key === draft.hostKey ? ' · 房主' : ''}</h3>
            <span>${assigned} 个专属动作 · ${row.characters.filter(Boolean).length} / ${expected} 角色</span></header>
          <div class="multiplayer-player-fields">
            <label class="multiplayer-field multiplayer-id-field"><span>玩家 ID</span><input data-mp-id="${row.key}" data-mp-focus="id:${row.key}"
              value="${html(row.id)}" maxlength="64" autocomplete="off" spellcheck="false" aria-label="玩家${index + 1} ID"></label>
            <div class="multiplayer-character-slots" role="group" aria-label="${html(playerLabel(row))}的角色">
              ${Array.from({length: slots}, (_, slot) => `<label class="multiplayer-field ${slot >= expected ? 'multiplayer-extra-slot' : ''}">
                <span>${slot >= expected ? '超额角色，请移除或重新分配' : `角色 ${slot + 1}`}</span>
                <span class="multiplayer-character-field">${avatar(row.characters[slot])}
                  <select data-mp-character="${row.key}" data-mp-slot="${slot}" data-mp-focus="character:${row.key}:${slot}"
                    aria-label="${html(playerLabel(row))}的角色${slot + 1}">
                    ${characterOptions(row.characters[slot] || '', row.characters)}</select></span></label>`).join('')}
            </div>
            <label class="multiplayer-field multiplayer-targeting-field"><span>本端索敌</span>
              <select data-mp-targeting="${row.key}" data-mp-focus="targeting:${row.key}" aria-label="${html(playerLabel(row))}索敌设置">
                ${[['', '继承调用设置'], ['true', '开启'], ['false', '关闭']].map(([value, title]) =>
                  `<option value="${value}" ${value === row.targeting ? 'selected' : ''}>${title}</option>`).join('')}
              </select></label>
          </div>
          <p class="multiplayer-id-mapping" ${row.originalId && row.originalId !== row.id ? '' : 'hidden'}>
            ID 映射：<code>${html(row.originalId)}</code> ${icon('arrow-right')}
            <code data-mp-mapped-id>${html(row.id) || '未填写'}</code> · ${assigned} 个动作随本端更新归属</p>
          <label class="multiplayer-field multiplayer-player-preactions"><span>本端开场</span>
            <textarea data-mp-preactions="${row.key}" data-mp-focus="preactions:${row.key}" rows="2" spellcheck="false"
              aria-label="${html(playerLabel(row))}的开场指令" placeholder="角色名 skill">${html(row.preActionsText)}</textarea></label>
        </section>`;
      }).join('');
    }
    function ownerOptions(assignment) {
      const rows = activeRows(), valid = ['', unassigned, ...rows.map(row => row.key)];
      const missing = !valid.includes(assignment.targetKey) ? rowFor(assignment.targetKey) : null;
      return `<option value="${unassigned}" ${assignment.targetKey === unassigned ? 'selected' : ''}>选择玩家</option>
        <option value="" ${assignment.targetKey === '' ? 'selected' : ''} ${assignment.currentCharacter ? '' : 'disabled'}>各端通用</option>
        ${!valid.includes(assignment.targetKey) ? `<option value="${html(assignment.targetKey)}" selected>
          ${html(missing ? `已移除：${playerLabel(missing)}` : '原玩家已不存在')}</option>` : ''}
        ${rows.map(row => `<option value="${row.key}" ${assignment.targetKey === row.key ? 'selected' : ''}>
          ${html(playerLabel(row))}${row.key === draft.hostKey ? ' · 房主' : ''}</option>`).join('')}`;
    }
    function renderAssignments() {
      const pending = draft.assignments.filter(assignment => assignment.targetKey === unassigned
        || assignment.targetKey && !activeRows().some(row => row.key === assignment.targetKey)).length;
      $('multiplayerOwnershipCount').textContent = `${draft.assignments.length} 个动作${pending ? ` · ${pending} 个待分配` : ''}`;
      $('multiplayerOwnershipNote').textContent = draft.initial
        ? '首次启用，请确认现有动作的玩家归属。通用动作默认由各端分别执行。'
        : '变更玩家或角色名单后，请核对动作归属；动作名与原生优先级保持。';
      $('multiplayerAssignments').innerHTML = draft.assignments.map(assignment => {
        const owner = activeRows().find(row => row.key === assignment.targetKey);
        const outside = !assignment.currentCharacter && owner
          && !owner.characters.includes(character(assignment.characterId)?.name);
        return `<div class="multiplayer-assignment-row ${outside ? 'multiplayer-assignment-outside' : ''}"
          data-mp-assignment="${html(assignment.clipId)}">
          <div class="multiplayer-assignment-identity"><strong>${html(assignment.name || '未命名动作')}</strong>
            <span>Index ${html(assignment.priority)}${outside ? ' · 角色不在该端' : ''}</span></div>
          <label class="multiplayer-field"><span>执行玩家</span><select data-mp-owner="${html(assignment.clipId)}"
            data-mp-focus="owner:${html(assignment.clipId)}" aria-label="${html(assignment.name)}的玩家归属">${ownerOptions(assignment)}</select></label>
          <div class="multiplayer-assignment-character">
            <label class="multiplayer-current-checkbox"><input type="checkbox" data-mp-current="${html(assignment.clipId)}"
              data-mp-focus="current:${html(assignment.clipId)}" ${assignment.currentCharacter ? 'checked' : ''}
              aria-label="${html(assignment.name)}使用当前前台角色"><span>当前前台角色</span></label>
            ${assignment.currentCharacter ? '' : `<select data-mp-action-character="${html(assignment.clipId)}"
              data-mp-focus="actor:${html(assignment.clipId)}" aria-label="${html(assignment.name)}的执行角色">
              ${characterOptions(character(assignment.characterId)?.name || '')}</select>`}
          </div>
        </div>`;
      }).join('') || '<p class="multiplayer-empty-state">尚无动作；保存玩家配置后可添加。</p>';
    }
    function renderRoles() {
      $('multiplayerRoleSection').hidden = !draft.roleSlots.length;
      $('multiplayerRoles').innerHTML = draft.roleSlots.map(role => {
        const name = character(role.source.characterId)?.name || role.source.characterId;
        const label = M.roleDefinitions.find(row => row.id === role.source.role)?.name || '角色定位';
        const candidates = role.source.candidates.map(candidate => character(candidate.characterId)?.name || candidate.characterId);
        return `<div class="multiplayer-role-row"><div><strong>${html(name)} · ${html(label)}</strong>
          <span>候选：${html(candidates.join('、'))}</span></div>
          <label class="multiplayer-field"><span>定位所属玩家</span>
            <select data-mp-role-owner="${role.key}" data-mp-focus="role:${role.key}" aria-label="${html(name)}定位所属玩家">
              ${ownerOptions({targetKey: role.targetKey, currentCharacter: false})}</select></label></div>`;
      }).join('');
    }
    function renderErrors() {
      $('multiplayerErrors').innerHTML = draft.errors.map(message => `<li>${html(message)}</li>`).join('');
      $('multiplayerErrors').hidden = !draft.errors.length;
    }
    function render() {
      if (!draft) return;
      const savedFocus = focusSnapshot(), content = dialog.querySelector('.multiplayer-content'), scrollTop = content.scrollTop;
      $('multiplayerTitle').textContent = draft.initial ? '启用联机' : '联机玩家设置';
      $('multiplayerCount').value = String(draft.count);
      $('multiplayerHost').innerHTML = '<option value="">选择房主</option>' + activeRows().map(row =>
        `<option value="${row.key}" ${row.key === draft.hostKey ? 'selected' : ''}>${html(playerLabel(row))}</option>`).join('');
      $('multiplayerSlots').textContent = draft.count === 2 ? '角色 2 / 2'
        : draft.count === 3 ? '房主 2 · 其他各 1' : '每端 1 名角色';
      $('multiplayerBlocked').textContent = draft.blocked;
      $('multiplayerBlocked').hidden = !draft.blocked;
      $('multiplayerConfiguration').hidden = Boolean(draft.blocked);
      dialog.querySelector('.multiplayer-configuration-bar').hidden = Boolean(draft.blocked);
      $('saveMultiplayer').disabled = Boolean(draft.blocked);
      $('saveMultiplayer').querySelector('span').textContent = draft.initial ? '确认归属并启用' : '保存配置';
      if (!draft.blocked) {
        renderPlayers();
        $('multiplayerCommonPreActions').value = draft.commonText;
        renderRoles();
        renderAssignments();
      }
      $('multiplayerDraftStatus').textContent = draft.changed ? '配置尚未保存' : draft.initial ? '尚未启用联机' : '配置草稿';
      renderErrors();
      content.scrollTop = scrollTop;
      restoreFocus(savedFocus);
      icons();
    }
    function localErrors() {
      const errors = [], rows = activeRows(), ids = new Set();
      if (!rows.some(row => row.key === draft.hostKey)) errors.push('请选择一名房主。');
      for (const row of rows) {
        const label = playerLabel(row);
        if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(row.id))
          errors.push(`${label}：ID 须以英文字母开头，仅含字母、数字、下划线或短横线，最多 64 字符。`);
        if (ids.has(row.id)) errors.push(`玩家 ID「${row.id}」重复；ID 区分大小写。`);
        ids.add(row.id);
        const selected = row.characters.filter(Boolean);
        if (selected.length !== slotCount(row)) errors.push(`${label}需选择 ${slotCount(row)} 名角色，目前为 ${selected.length} 名。`);
        if (new Set(selected).size !== selected.length) errors.push(`${label}的角色不能重复。`);
        for (const name of selected) if (!namedCharacter(name)) errors.push(`${label}的角色「${name}」未在角色库中。`);
      }
      for (const assignment of draft.assignments) {
        const owner = rows.find(row => row.key === assignment.targetKey);
        if (assignment.targetKey !== '' && !owner) {
          errors.push(`动作「${assignment.name}」尚未选择有效的执行玩家。`);
          continue;
        }
        if (!assignment.currentCharacter) {
          const name = character(assignment.characterId)?.name;
          if (!owner) errors.push(`具名动作「${assignment.name}」必须指定玩家。`);
          else if (!name || !owner.characters.includes(name))
            errors.push(`动作「${assignment.name}」的角色${name ? `「${name}」` : ''}不在 ${playerLabel(owner)} 的角色名单中。`);
        }
      }
      for (const role of draft.roleSlots) {
        const owner = rows.find(row => row.key === role.targetKey);
        const name = character(role.source.characterId)?.name || role.source.characterId;
        if (!owner) { errors.push(`请明确选择角色定位「${name}」的执行玩家。`); continue; }
        if (role.source.candidates.some(candidate => !owner.characters.includes(character(candidate.characterId)?.name)))
          errors.push(`定位「${name}」的兼容候选超出 ${playerLabel(owner)} 的名单，请先在单机工程确定角色或移除名单外候选。`);
        const related = draft.assignments.filter(assignment => !assignment.currentCharacter
          && assignment.characterId === role.source.characterId);
        if (related.some(assignment => assignment.targetKey !== role.targetKey))
          errors.push(`定位「${name}」的具名动作不能跨多个玩家，请先统一其明确归属。`);
      }
      return errors;
    }
    function nativeHeader() {
      const header = M.clone(draft.header);
      set(header, 'Version', read(header, 'Version', 1));
      set(header, 'Players', activeRows().map(row => {
        const player = M.clone(row.source);
        set(player, 'Id', row.id);
        set(player, 'IsHost', row.key === draft.hostKey);
        set(player, 'Characters', row.characters.filter(Boolean));
        set(player, 'PreActions', row.preActionsChanged ? lines(row.preActionsText) : M.clone(read(row.source, 'PreActions', [])));
        if (row.targetingChanged)
          set(player, 'EnableCombatTargeting', row.targeting === '' ? undefined : row.targeting === 'true');
        return player;
      }));
      return header;
    }
    function save() {
      if (!draft || draft.blocked) return;
      draft.errors = localErrors();
      if (draft.errors.length) { renderErrors(); return; }
      const header = nativeHeader(), rows = activeRows();
      let succeeded = false, failure = null, validationMessages = [];
      const mappedActive = rows.find(row => row.key === draft.activeKey)?.id || '';
      change(() => {
        try {
          const project = getProject();
          const ids = new Set(draft.assignments.map(assignment => assignment.clipId));
          if (project.clips.length !== ids.size || project.clips.some(clip => !ids.has(clip.id)))
            throw new Error('工程动作已变化，请重新打开联机配置。');
          M.configureMultiplayer(project, header);
          const renamed = rows.filter(row => row.originalId && row.originalId !== row.id);
          if (renamed.length) M.remapPlayerMetadata(project,
            Object.fromEntries(renamed.map(row => [row.originalId, row.id])));
          project.preActions = draft.commonChanged ? lines(draft.commonText) : M.clone(draft.commonSource);
          for (const assignment of draft.assignments) {
            const playerId = rows.find(row => row.key === assignment.targetKey)?.id || '';
            M.assignClipPlayer(project, assignment.clipId, playerId, {currentCharacter: assignment.currentCharacter,
              ...(!assignment.currentCharacter ? {characterId: assignment.characterId} : {})});
          }
          for (const role of draft.roleSlots) {
            const playerId = rows.find(row => row.key === role.targetKey).id;
            M.assignRolePlayer(project, role.source.id, playerId);
          }
          M.setActivePlayer(project, mappedActive);
          const invalid = M.validate(project, catalog).filter(issue => issue.severity !== 'warning' && issue.code !== 'multiplayer-empty');
          if (invalid.length) {
            validationMessages = invalid.map(issue => issue.message);
            throw new Error(validationMessages.join('\n'));
          }
          succeeded = true;
        } catch (reason) { failure = reason; throw reason; }
      });
      if (!succeeded) {
        if (failure) draft.errors = validationMessages.length ? validationMessages : [failure.message];
        renderErrors();
        return;
      }
      dialog.close();
      onSwitch?.({playerId: mappedActive, configured: true});
      paint();
      toast('联机玩家与动作归属已保存');
    }
    function paint() {
      const project = getProject(), multiplayer = M.isMultiplayer(project);
      mount.classList.toggle('is-multiplayer', multiplayer);
      $('multiplayerTargetControl').hidden = !multiplayer;
      $('exportPlayerText').hidden = !multiplayer;
      if (multiplayer) {
        const players = M.players(project), activeId = M.activePlayer(project)?.Id || '';
        $('activePlayerTarget').innerHTML = '<option value="">各端通用</option>' + players.map(player =>
          `<option value="${html(player.Id)}" ${player.Id === activeId ? 'selected' : ''}>${html(player.Id)}${player.IsHost ? ' · 房主' : ''}</option>`).join('');
        $('activePlayerTarget').title = activeId ? `添加至 ${activeId}` : '添加各端通用动作';
        $('exportPlayerText').disabled = !activeId;
        $('exportPlayerText').title = activeId ? `导出 ${activeId} 的 TXT` : '先选择具体玩家，再导出单端 TXT';
      }
      icons();
    }
    function open() {
      returnFocus = document.activeElement;
      prepareDraft();
      render();
      if (!dialog.open) dialog.showModal();
    }
    $('manageMultiplayer').addEventListener('click', open);
    $('activePlayerTarget').addEventListener('change', event => {
      try {
        M.setActivePlayer(getProject(), event.target.value);
        onSwitch?.({playerId: event.target.value});
        paint();
      } catch (reason) { toast(reason.message, true); paint(); }
    });
    $('exportPlayerText').addEventListener('click', () => {
      const player = M.activePlayer(getProject());
      if (player) onExportText?.(player.Id);
    });
    dialog.addEventListener('input', event => {
      if (!draft) return;
      updateTextDraft(event.target);
    });
    dialog.addEventListener('change', event => {
      if (!draft) return;
      const input = event.target;
      // Text blur must not replace controls between a pointer press and its click.
      if (updateTextDraft(input)) return;
      if (input.dataset.mpTargeting) {
        const row = rowFor(input.dataset.mpTargeting);
        if (row.targeting !== input.value) {
          row.targeting = input.value;
          row.targetingChanged = true;
          markChanged();
        }
        return;
      }
      if (input.id === 'multiplayerCount') {
        draft.count = Number(input.value);
        while (draft.rows.length < draft.count) draft.rows.push(newPlayer(draft.rows.length));
        if (!activeRows().some(row => row.key === draft.hostKey)) draft.hostKey = '';
      } else if (input.id === 'multiplayerHost') draft.hostKey = input.value;
      else if (input.dataset.mpCharacter) {
        const row = rowFor(input.dataset.mpCharacter);
        row.characters[Number(input.dataset.mpSlot)] = input.value;
        row.characters = row.characters.filter(Boolean);
      } else if (input.dataset.mpRoleOwner !== undefined) {
        const role = draft.roleSlots.find(row => row.key === input.dataset.mpRoleOwner);
        role.targetKey = input.value;
        role.explicit = true;
      } else if (input.dataset.mpOwner !== undefined) {
        const assignment = draft.assignments.find(row => row.clipId === input.dataset.mpOwner);
        assignment.targetKey = input.value;
        assignment.explicit = true;
      } else if (input.dataset.mpCurrent !== undefined) {
        const assignment = draft.assignments.find(row => row.clipId === input.dataset.mpCurrent);
        assignment.currentCharacter = input.checked;
        assignment.explicit = true;
        if (!input.checked && assignment.targetKey === '') assignment.targetKey = unassigned;
        if (!input.checked && !assignment.characterId) assignment.characterId = assignment.originalCharacterId;
      } else if (input.dataset.mpActionCharacter !== undefined) {
        const assignment = draft.assignments.find(row => row.clipId === input.dataset.mpActionCharacter);
        assignment.characterId = namedCharacter(input.value)?.id || '';
        assignment.explicit = true;
      } else return;
      markChanged();
      updateRecommendations();
      render();
    });
    dialog.addEventListener('click', event => {
      if (event.target.closest('[data-multiplayer-close]')) dialog.close();
    });
    $('saveMultiplayer').addEventListener('click', save);
    dialog.addEventListener('close', () => {
      draft = null;
      if (document.querySelector('dialog[open]')) return;
      (returnFocus?.isConnected ? returnFocus : $('manageMultiplayer')).focus({preventScroll: true});
    });

    paint();
    return {paint, open};
  }

  root.CombatMultiplayerEditor = {create};
})(typeof globalThis === 'object' ? globalThis : this);
