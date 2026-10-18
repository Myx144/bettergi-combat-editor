(function(root) {
  'use strict';

  function create({model: M, catalog, getProject, change, icons, toast, onSwitch, openQueue}) {
    const $ = id => document.getElementById(id);
    const mount = $('teamControls');
    if (!mount) throw new Error('队伍工具缺少 teamControls 容器');
    const html = value => String(value ?? '').replace(/[&<>"']/g, char =>
      ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
    const icon = name => `<i data-lucide="${name}"></i>`;
    const read = (value, name, fallback) =>
      value?.[Object.keys(value).find(key => key.toLowerCase() === name.toLowerCase())] ?? fallback;
    const singleId = '__current__';
    let error = '', importNotice = '', relationCharacter = '', importing = false;
    let managerReturn = null, relationsReturn = null;

    mount.classList.add('team-controls');
    mount.innerHTML = `<label class="team-current">
      ${icon('users-round')}<select id="currentTeam" aria-label="当前编辑队伍"></select></label>
      <div id="currentTeamRoster" class="team-current-roster" aria-label="当前队伍阵容"></div>
      <div class="team-control-actions">
        <button id="manageTeams" class="icon-button" type="button" title="管理队伍" aria-label="管理队伍">${icon('settings-2')}</button>
        <button id="showTeamRelations" class="icon-button" type="button" title="共享角色关系" aria-label="共享角色关系">${icon('link')}</button>
        <button id="showTeamQueue" class="icon-button" type="button" title="本队优先级队列" aria-label="本队优先级队列">${icon('list-ordered')}</button>
      </div><span id="teamExportScope" class="team-export-scope"></span>`;

    const manager = document.createElement('dialog');
    manager.id = 'teamsDialog';
    manager.className = 'teams-dialog';
    manager.setAttribute('aria-labelledby', 'teamsTitle');
    manager.innerHTML = `<header class="dialog-heading"><h2 id="teamsTitle">队伍管理</h2>
      <button class="icon-button" type="button" data-team-close title="关闭队伍管理" aria-label="关闭队伍管理">${icon('x')}</button></header>
      <div class="team-manager-toolbar">
        <button id="newTeam" type="button">${icon('plus')}<span>新建队伍</span></button>
        <button id="importTeam" type="button">${icon('folder-input')}<span>导入为队伍</span></button>
        <span id="teamsCount"></span>
      </div>
      <div class="team-manager-content"><div id="teamList" class="team-list"></div>
        <ul id="teamCollectionIssues" class="team-issues" aria-label="工程检查"></ul></div>
      <footer class="team-manager-footer"><p id="teamImportNotice" class="team-import-notice" role="status"></p>
        <p id="teamManagerError" class="team-error" role="alert"></p>
        <span id="teamManagerScope" class="team-manager-scope"></span>
        <button type="button" data-team-close>完成</button></footer>`;
    document.body.append(manager);

    const relations = document.createElement('dialog');
    relations.id = 'teamRelationsDialog';
    relations.className = 'team-relations-dialog';
    relations.setAttribute('aria-labelledby', 'teamRelationsTitle');
    relations.innerHTML = `<header class="dialog-heading"><h2 id="teamRelationsTitle">共享角色关系</h2>
      <button class="icon-button" type="button" data-team-close title="关闭共享角色关系" aria-label="关闭共享角色关系">${icon('x')}</button></header>
      <div class="team-relations-toolbar"><label for="teamRelationCharacter">角色</label>
        <select id="teamRelationCharacter" aria-label="查看共享角色"></select>
        <span>各队条件独立</span></div>
      <div id="teamRelationList" class="team-relation-list"></div>`;
    document.body.append(relations);

    const importInput = document.createElement('input');
    importInput.id = 'teamImportInput';
    importInput.type = 'file';
    importInput.accept = '.json,.txt,application/json,text/plain';
    importInput.hidden = true;
    document.body.append(importInput);

    function entries() {
      const project = getProject();
      return M.hasTeams(project) ? M.teamEntries(project) : [{
        id: singleId, name: '队伍 1', enabled: true,
        roster: [...project.team], project
      }];
    }
    function currentId() {
      return M.hasTeams(getProject()) ? getProject().activeTeamId : singleId;
    }
    function character(id) {
      return catalog.characters.find(row => row.id === String(id));
    }
    function avatar(id) {
      const row = character(id);
      if (!row) return '<span class="team-avatar-empty" aria-hidden="true">?</span>';
      return row.avatar
        ? `<img class="team-avatar" src="${html(row.avatar)}" alt="${html(row.name)}" title="${html(row.name)}" draggable="false">`
        : `<span class="team-avatar-empty" title="${html(row.name)}">${html(row.name.slice(0, 1))}</span>`;
    }
    function sharedCharacters() {
      return M.hasTeams(getProject()) ? M.teamRelations(getProject()) : [];
    }
    function storedPlan(project, id) {
      if (!M.hasTeams(project)) M.enableTeams(project);
      const plan = id === singleId ? M.activeTeam(project) : project.teamPlans.find(row => row.id === id);
      if (!plan) throw new Error('该队伍已不存在');
      return plan;
    }
    function mutate(operation) {
      let succeeded = false, failure = null, result;
      change(() => {
        try {
          result = operation(getProject());
          succeeded = true;
        } catch (reason) {
          failure = reason;
          throw reason;
        }
      });
      if (failure) error = failure.message;
      else if (succeeded) error = '';
      paint();
      return {succeeded, result};
    }
    function switchTo(id, characterId = null) {
      const selected = id === singleId ? currentId() : id;
      let teamId = selected;
      const switched = mutate(project => {
        if (M.hasTeams(project)) {
          M.switchTeam(project, selected);
          teamId = project.activeTeamId;
        }
      });
      if (!switched.succeeded) return;
      if (manager.open) manager.close();
      if (relations.open) relations.close();
      onSwitch?.({teamId, ...(characterId ? {characterId} : {})});
    }
    function scopeText() {
      if (M.isText(getProject())) return 'TXT 仅导出当前队伍；工程保留全部队伍';
      return M.hasTeams(getProject())
        ? `JSON 合并导出 ${entries().filter(row => row.enabled).length} 支启用队伍`
        : 'JSON 条件与优先级';
    }
    function formatLabel(project) {
      if (M.isText(project)) return 'TXT · 顺序命令';
      return project.scheduling === 'original' ? 'JSON · 条件与优先级'
        : M.isProcess(project) ? 'JSON · 按步骤推进' : 'JSON · 按计划时刻';
    }
    function offRosterClips(plan) {
      const roster = new Set(plan.roster);
      return plan.project.clips.filter(clip => !clip.useCurrentCharacter && !roster.has(clip.characterId)
        && !(plan.project.scheduling === 'original' && read(clip.sourceAction, 'Character', null) === ''));
    }
    function issues() {
      if (!M.hasTeams(getProject())) return [];
      try { return M.validateTeams(getProject(), catalog); }
      catch (reason) { return [{message: reason.message}]; }
    }
    function issueHtml(issue) {
      return `<li class="${issue.severity === 'warning' ? 'team-issue-warning' : ''}">${html(issue.message)}</li>`;
    }
    function rememberFocus() {
      const active = document.activeElement;
      if (!manager.contains(active)) return null;
      if (active?.dataset.teamName !== undefined)
        return {key: 'teamName', value: active.dataset.teamName, start: active.selectionStart, end: active.selectionEnd};
      if (active?.dataset.teamSlot !== undefined)
        return {key: 'teamSlot', value: active.dataset.teamSlot, team: active.dataset.teamRoster};
      if (active?.dataset.teamEnabled !== undefined)
        return {key: 'teamEnabled', value: active.dataset.teamEnabled};
      return null;
    }
    function restoreFocus(saved) {
      if (!saved || !manager.open) return;
      if (saved.value === singleId) saved.value = currentId();
      if (saved.team === singleId) saved.team = currentId();
      const node = [...manager.querySelectorAll('[data-team-name], [data-team-slot], [data-team-enabled]')]
        .find(row => row.dataset[saved.key] === saved.value
          && (saved.team === undefined || row.dataset.teamRoster === saved.team));
      if (!node) return;
      node.focus({preventScroll: true});
      if (saved.start !== undefined && saved.start !== null) node.setSelectionRange(saved.start, saved.end);
    }
    function paintManager() {
      const savedFocus = rememberFocus();
      const content = manager.querySelector('.team-manager-content'), scrollTop = content.scrollTop;
      const plans = entries(), allIssues = issues();
      const settingsConflict = allIssues.some(issue =>
        ['teams-preActions', 'teams-config', 'teams-root', 'teams-info'].includes(issue.code));
      $('teamsCount').textContent = `${plans.length} 支队伍 · ${plans.filter(row => row.enabled).length} 支启用`;
      $('teamList').innerHTML = plans.map(plan => {
        const offRoster = offRosterClips(plan);
        const rowIssues = allIssues.filter(issue => issue.teamId === plan.id || issue.teamIds?.includes(plan.id));
        const rosterNames = plan.roster.map(id => character(id)?.name || id).join('、');
        return `<section class="team-row ${plan.id === currentId() ? 'is-current-team' : ''}" data-team-row="${html(plan.id)}"
          aria-label="${html(plan.name)}">
          <div class="team-row-heading">
            <label class="team-name-field"><span class="team-field-label">队伍名称${plan.id === currentId() ? ' · 当前' : ''}</span>
              <input data-team-name="${html(plan.id)}" aria-label="${html(plan.name)}的队伍名称"
                maxlength="80" value="${html(plan.name)}" autocomplete="off"></label>
            <label class="team-enabled-field"><input type="checkbox" data-team-enabled="${html(plan.id)}"
              aria-label="启用${html(plan.name)}" ${plan.enabled ? 'checked' : ''}><span>启用</span></label>
            <div class="team-row-actions">
              <button type="button" class="icon-button" data-team-edit="${html(plan.id)}" title="编辑${html(plan.name)}"
                aria-label="编辑${html(plan.name)}">${icon('pencil')}</button>
              <button type="button" class="icon-button" data-team-duplicate="${html(plan.id)}" title="复制${html(plan.name)}"
                aria-label="复制${html(plan.name)}">${icon('copy-plus')}</button>
              <button type="button" class="icon-button team-remove-button" data-team-remove="${html(plan.id)}"
                title="删除${html(plan.name)}" aria-label="删除${html(plan.name)}" ${plans.length < 2 ? 'disabled' : ''}>${icon('trash-2')}</button>
            </div>
          </div>
          <div class="team-roster-editor" role="group" aria-label="${html(plan.name)}的四人阵容">
            ${Array.from({length: 4}, (_, index) => {
              const id = plan.roster[index] || '';
              return `<label class="team-roster-slot"><span class="team-field-label">角色 ${index + 1}</span>
                <select data-team-roster="${html(plan.id)}" data-team-slot="${index}"
                  aria-label="${html(plan.name)}的第${index + 1}名角色">
                  <option value="">选择角色</option>${catalog.characters.map(row =>
                    `<option value="${html(row.id)}" ${row.id === id ? 'selected' : ''}
                      ${row.id !== id && plan.roster.includes(row.id) ? 'disabled' : ''}>${html(row.name)}</option>`).join('')}
                </select></label>`;
            }).join('')}
          </div>
          <div class="team-row-meta"><span>${html(formatLabel(plan.project))}</span>
            <span>${plan.roster.length} / 4 人 · ${plan.project.clips.length} 个动作</span>
            ${offRoster.length ? `<span class="team-outside-roster">${offRoster.length} 个阵容外动作保留，运行时按实际队伍过滤</span>` : ''}
          </div>
          ${settingsConflict ? `<button type="button" class="team-use-settings" data-use-team-settings="${html(plan.id)}"
            title="沿用此队开场与公共配置">${icon('copy-check')}<span>沿用此队开场与公共配置</span></button>` : ''}
          ${plan.roster.length !== 4 && !rowIssues.length
            ? `<p class="team-roster-status ${plan.enabled ? 'team-error' : ''}">四人阵容未完成${plan.roster.length > 4 ? `：目前有 ${plan.roster.length} 人` : ''}</p>` : ''}
          <span class="team-roster-description">${html(rosterNames)}</span>
          ${rowIssues.length ? `<ul class="team-issues">${rowIssues.map(issueHtml).join('')}</ul>` : ''}
        </section>`;
      }).join('');
      const globalIssues = allIssues.filter(issue => !issue.teamId && !issue.teamIds?.length);
      $('teamCollectionIssues').innerHTML = globalIssues.map(issueHtml).join('');
      $('teamCollectionIssues').hidden = !globalIssues.length;
      $('teamManagerError').textContent = error;
      $('teamImportNotice').textContent = importNotice;
      $('teamManagerScope').textContent = scopeText();
      $('importTeam').disabled = importing;
      content.scrollTop = scrollTop;
      restoreFocus(savedFocus);
    }
    function describe(expression, project) {
      if (!expression?.trim()) return '始终成立';
      try {
        const R = root.CombatConditions;
        return R.describe(R.decode(expression, project.clips.map(clip => clip.name)));
      } catch { return expression; }
    }
    function clipConditions(clip, project) {
      const priority = project.scheduling === 'original' ? `P${M.priorityOf(clip)}` : '编译器分配';
      return `<div class="team-relation-condition"><span>主触发 · ${html(priority)}</span>
        <p>${html(describe(clip.condition, project))}</p></div>` +
        M.prioritiesOf(clip).map((priority, index) => `<div class="team-relation-condition">
          <span>额外触发 ${index + 1} · P${html(read(priority, 'Priority', 0))}</span>
          <p>${html(describe(read(priority, 'Expression', ''), project))}</p></div>`).join('');
    }
    function relationClips(plan, characterId) {
      const rows = plan.project.scheduling === 'original' ? M.declared(plan.project) : M.ordered(plan.project);
      const result = rows.filter(clip => !clip.useCurrentCharacter).flatMap(clip => {
        if (clip.characterId === characterId) return [{clip, owner: clip.characterId, compatible: false}];
        const slot = M.roleSlot(plan.project, clip.characterId);
        if (!slot.candidates.some(candidate => candidate.characterId === characterId)) return [];
        return [{clip: M.roleClip(plan.project, catalog, clip, characterId), owner: clip.characterId, compatible: true}];
      });
      return plan.project.scheduling === 'original'
        ? result.sort((left, right) => M.priorityOf(left.clip) - M.priorityOf(right.clip)) : result;
    }
    function paintRelations() {
      const scrollTop = $('teamRelationList').scrollTop;
      const shared = sharedCharacters(), plans = entries();
      if (relationCharacter && !shared.some(row => row.characterId === relationCharacter)) relationCharacter = '';
      $('teamRelationCharacter').innerHTML = '<option value="">全部共享角色</option>' + shared.map(row => {
        const name = character(row.characterId)?.name || row.characterId;
        return `<option value="${html(row.characterId)}" ${relationCharacter === row.characterId ? 'selected' : ''}>${html(name)} · ${row.teamIds.length} 队</option>`;
      }).join('');
      $('teamRelationCharacter').disabled = !shared.length;
      $('teamRelationList').innerHTML = shared.filter(row => !relationCharacter || row.characterId === relationCharacter)
        .map(sharedRow => {
          const avatarRow = character(sharedRow.characterId);
          return `<section class="team-relation-section"><h3>${avatar(sharedRow.characterId)}
            <span>${html(avatarRow?.name || sharedRow.characterId)}</span><small>${sharedRow.teamIds.length} 队</small></h3>
            <table class="team-relation-table"><thead><tr><th scope="col">队伍</th><th scope="col">动作</th>
              <th scope="col">触发条件</th><th scope="col"><span class="team-visually-hidden">编辑队伍</span></th></tr></thead>
              <tbody>${sharedRow.teamIds.map(id => {
                const plan = plans.find(row => row.id === id);
                if (!plan) return '';
                const clips = relationClips(plan, sharedRow.characterId);
                const count = Math.max(1, clips.length);
                const teamCell = `<th scope="rowgroup" rowspan="${count}" class="team-relation-owner">
                  <strong>${html(plan.name)}</strong><small>${plan.id === currentId() ? '当前队伍 · ' : ''}${plan.enabled ? '已启用' : '未启用'}</small></th>`;
                const editCell = `<td rowspan="${count}" class="team-relation-action"><button type="button" class="icon-button"
                  data-relation-team="${html(id)}" data-relation-character="${html(clips[0]?.owner || sharedRow.characterId)}"
                  title="前往${html(plan.name)}的${html(avatarRow?.name || '')}动作"
                  aria-label="前往${html(plan.name)}的${html(avatarRow?.name || '')}动作">${icon('arrow-up-right')}</button></td>`;
                if (!clips.length) return `<tr>${teamCell}<td colspan="2" class="team-relation-empty">该成员没有动作</td>${editCell}</tr>`;
                return clips.map(({clip, owner, compatible}, index) => `<tr>${index ? '' : teamCell}<td class="team-relation-name">${html(clip.name)}
                  ${compatible ? `<small>兼容分支 · 当前${html(character(owner)?.name || owner)}</small>` : ''}</td>
                  <td>${M.isText(plan.project) ? '<span class="team-relation-empty">TXT 顺序命令，无条件优先级</span>'
                    : clipConditions(clip, plan.project)}</td>${index ? '' : editCell}</tr>`).join('');
              }).join('')}</tbody></table></section>`;
        }).join('') || '<p class="team-empty-state">尚无跨队伍共享的角色</p>';
      $('teamRelationList').scrollTop = scrollTop;
    }
    function paint() {
      const plans = entries(), activeId = currentId(), current = plans.find(row => row.id === activeId) || plans[0];
      $('currentTeam').innerHTML = plans.map(plan => `<option value="${html(plan.id)}"
        ${plan.id === activeId ? 'selected' : ''}>${html(plan.name)}${plan.enabled ? '' : ' · 未启用'}</option>`).join('');
      $('currentTeam').title = current?.name || '当前编辑队伍';
      $('currentTeamRoster').innerHTML = (current?.roster || []).slice(0, 4).map(avatar).join('');
      $('currentTeamRoster').title = (current?.roster || []).map(id => character(id)?.name || id).join('、');
      $('teamExportScope').textContent = scopeText();
      $('teamExportScope').title = scopeText();
      mount.classList.toggle('team-format-text', M.isText(getProject()));
      const sharedCount = sharedCharacters().length;
      $('showTeamRelations').disabled = !sharedCount;
      $('showTeamRelations').title = `共享角色关系 · ${sharedCount} 名角色`;
      $('showTeamQueue').disabled = M.isText(getProject());
      $('showTeamQueue').title = M.isText(getProject()) ? 'TXT 使用顺序命令' : '本队优先级队列';
      if (manager.open) paintManager();
      if (relations.open) paintRelations();
      icons();
    }
    function open() {
      error = '';
      importNotice = '';
      managerReturn = document.activeElement;
      paintManager();
      if (!manager.open) manager.showModal();
      icons();
    }
    function openRelations(characterId = null) {
      relationsReturn = document.activeElement;
      relationCharacter = characterId ? String(characterId) : '';
      paintRelations();
      if (!relations.open) relations.showModal();
      icons();
    }
    function focusName(id) {
      const input = [...manager.querySelectorAll('[data-team-name]')].find(node => node.dataset.teamName === id);
      if (!input) return;
      input.focus({preventScroll: true});
      input.select();
      input.closest('.team-row').scrollIntoView({block: 'nearest'});
    }
    function createTeam() {
      const result = mutate(project => {
        if (!M.hasTeams(project)) M.enableTeams(project);
        const plan = M.addTeam(project, catalog, {name: `队伍 ${project.teamPlans.length + 1}`});
        plan.enabled = false;
        if (!M.isText(plan.project)) plan.project.scheduling = 'original';
        M.switchTeam(project, plan.id);
        return plan.id;
      });
      if (!result.succeeded) return;
      onSwitch?.({teamId: result.result});
      paint();
      focusName(result.result);
    }
    $('currentTeam').addEventListener('change', event => switchTo(event.target.value));
    $('manageTeams').addEventListener('click', open);
    $('showTeamRelations').addEventListener('click', () => openRelations());
    $('showTeamQueue').addEventListener('click', () => openQueue?.({teamId: currentId()}));
    $('newTeam').addEventListener('click', createTeam);
    $('importTeam').addEventListener('click', () => { importInput.value = ''; importInput.click(); });
    manager.addEventListener('change', event => {
      const input = event.target;
      if (input.dataset.teamName !== undefined) {
        mutate(project => {
          const plan = storedPlan(project, input.dataset.teamName);
          plan.name = input.value.trim() || plan.name;
        });
      } else if (input.dataset.teamEnabled !== undefined) {
        mutate(project => { storedPlan(project, input.dataset.teamEnabled).enabled = input.checked; });
      } else if (input.dataset.teamRoster !== undefined) {
        const row = input.closest('[data-team-row]');
        const ids = [...row.querySelectorAll('[data-team-roster]')].map(node => node.value).filter(Boolean);
        mutate(project => {
          const plan = storedPlan(project, input.dataset.teamRoster);
          M.setTeamRoster(project, plan.id, ids, catalog);
        });
      }
    });
    manager.addEventListener('click', event => {
      const button = event.target.closest('button');
      if (!button) return;
      if (button.hasAttribute('data-team-close')) { manager.close(); return; }
      if (button.dataset.teamEdit !== undefined) { switchTo(button.dataset.teamEdit); return; }
      if (button.dataset.useTeamSettings !== undefined) {
        const result = mutate(project => M.applySharedSettings(project, button.dataset.useTeamSettings));
        if (result.succeeded) toast('全部队伍已沿用所选开场与公共配置');
      } else if (button.dataset.teamDuplicate !== undefined) {
        const source = entries().find(row => row.id === button.dataset.teamDuplicate);
        if (!source) return;
        const result = mutate(project => {
          if (!M.hasTeams(project)) M.enableTeams(project);
          const plan = M.addTeam(project, catalog, {name: `${source.name} 副本`,
            project: M.clone(source.project), duplicate: true});
          plan.enabled = false;
          M.setTeamRoster(project, plan.id, source.roster, catalog);
          return plan.id;
        });
        if (result.succeeded) {
          focusName(result.result);
          toast('队伍已复制，默认未启用');
        }
      } else if (button.dataset.teamRemove !== undefined) {
        const activeBefore = currentId();
        const result = mutate(project => {
          const plan = storedPlan(project, button.dataset.teamRemove);
          M.removeTeam(project, plan.id);
          return project.activeTeamId;
        });
        if (result.succeeded) {
          if (activeBefore !== result.result) onSwitch?.({teamId: result.result});
          toast('队伍已删除');
        }
      }
    });
    importInput.addEventListener('change', async event => {
      const file = event.target.files[0];
      if (!file || importing) return;
      importing = true;
      error = '';
      importNotice = '';
      paint();
      try {
        const name = file.name.replace(/\.[^.]+$/, '');
        const imported = M.importDocument(await file.text(), catalog, {name});
        const importedPlans = M.hasTeams(imported) ? M.teamEntries(imported)
          : [{name: imported.name || name, enabled: true, project: imported}];
        const result = mutate(project => {
          const format = M.isText(project) ? 'txt' : 'json';
          let converted = 0, preservedSteps = 0;
          if (!M.hasTeams(project)) M.enableTeams(project);
          const ids = importedPlans.map(source => {
            const incoming = M.clone(source.project);
            if ((M.isText(incoming) ? 'txt' : 'json') !== format) {
              if (format === 'json' && !incoming.jsonScheduling) {
                if (incoming.team.length > 4)
                  throw new Error('TXT 包含超过 4 名动作角色，请先拆分为单队后导入 JSON');
                incoming.jsonScheduling = {scheduling: 'sequence', execution: 'process'};
                preservedSteps++;
              }
              M.setStrategyFormat(incoming, format);
              converted++;
            }
            const plan = M.addTeam(project, catalog, {name: source.name, project: incoming});
            plan.enabled = source.enabled !== false;
            if (Array.isArray(source.roster)) M.setTeamRoster(project, plan.id, source.roster, catalog);
            return plan.id;
          });
          if (ids.length) M.switchTeam(project, ids[0]);
          return {ids, converted, preservedSteps, format};
        });
        if (result.succeeded) {
          const imported = result.result;
          if (imported.converted) importNotice = `${imported.converted} 支队伍已转换为本工程 ${imported.format.toUpperCase()}` +
            (imported.preservedSteps ? `；${imported.preservedSteps} 支 TXT 队伍保留按步骤推进` : '；原有 JSON 条件保留在工程中');
          onSwitch?.({teamId: imported.ids[0]});
          toast(`已导入 ${imported.ids.length} 支队伍${imported.converted ? `，统一为 ${imported.format.toUpperCase()}` : ''}`);
        }
      } catch (reason) { error = reason.message; toast(error, true); }
      finally { importing = false; paint(); }
    });
    $('teamRelationCharacter').addEventListener('change', event => {
      relationCharacter = event.target.value;
      paintRelations();
      icons();
    });
    relations.addEventListener('click', event => {
      const button = event.target.closest('button');
      if (!button) return;
      if (button.hasAttribute('data-team-close')) relations.close();
      else if (button.dataset.relationTeam !== undefined)
        switchTo(button.dataset.relationTeam, button.dataset.relationCharacter);
    });
    for (const dialog of [manager, relations]) dialog.addEventListener('close', () => {
      if (document.querySelector('dialog[open]')) return;
      const target = dialog === manager ? managerReturn : relationsReturn;
      (target?.isConnected ? target : $('currentTeam')).focus({preventScroll: true});
    });

    paint();
    return {paint, open, openRelations};
  }

  root.CombatTeamEditor = {create};
})(typeof globalThis === 'object' ? globalThis : this);
