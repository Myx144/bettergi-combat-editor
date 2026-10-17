(function (root) {
  'use strict';

  function createRoles(M) {
    const roleDefinitions = [
      {id: 'flex', name: '自由位'}, {id: 'onfield', name: '站场输出'},
      {id: 'offfield', name: '后台输出'}, {id: 'buffer', name: '增益辅助'},
      {id: 'healer', name: '治疗'}, {id: 'shield', name: '护盾'},
      {id: 'control', name: '聚怪控制'}, {id: 'application', name: '元素附着'}
    ];
    const profileFields = ['abilityId', 'foregroundMs', 'effectMs', 'cooldownMs', 'effectPolicy',
      'castTiming', 'castEstimateMs', 'lockOverrideMs', 'castInputMs', 'effectSource',
      'hold', 'followAttack', 'attackAfterMs', 'followSourceId', 'ensureCast', 'condition',
      'readiness', 'notReady', 'protectCast', 'operation', 'operations', 'sourceAction', 'commandOverride'];
    const profileOf = clip => Object.fromEntries(profileFields.filter(key => clip[key] !== undefined)
      .map(key => [key, M.clone(clip[key])]));
    const hasCompatibility = project => (project.roleSlots || []).some(slot => slot.candidates.length > 1);

    function roleSlot(project, characterId) {
      const id = String(characterId);
      return (project.roleSlots || []).find(slot => slot.id === id || slot.characterId === id)
        || {id: `role${id}`, characterId: id, role: 'flex', candidates: [{characterId: id, clips: {}}]};
    }

    function ensureSlot(project, characterId) {
      const slot = roleSlot(project, characterId);
      if (!project.team.includes(slot.characterId)) throw new Error('定位所属角色不在当前队伍中');
      project.roleSlots ??= [];
      if (!project.roleSlots.includes(slot)) project.roleSlots.push(slot);
      return slot;
    }

    function configureRole(project, characterId, role) {
      if (!roleDefinitions.some(item => item.id === role)) throw new Error('角色定位无效');
      const slot = ensureSlot(project, characterId);
      slot.role = role;
      return slot;
    }

    function addRoleCandidate(project, catalog, characterId, candidateId) {
      if (!M.isProcess(project)) throw new Error('角色兼容需要使用“按步骤推进”');
      const id = M.character(catalog, candidateId).id;
      const slot = roleSlot(project, characterId);
      if (slot.candidates.some(candidate => candidate.characterId === id)) return ensureSlot(project, characterId);
      if (project.team.some(member => member !== slot.characterId &&
        roleSlot(project, member).candidates.some(candidate => candidate.characterId === id))) {
        throw new Error('该角色已属于另一个定位，不能同时占用两个位置');
      }
      const saved = ensureSlot(project, characterId);
      saved.candidates.push({characterId: id, clips: {}});
      return saved;
    }

    function removeRoleCandidate(project, characterId, candidateId) {
      const slot = ensureSlot(project, characterId);
      if (slot.characterId === candidateId) throw new Error('请先切换到另一个角色，再移除此分支');
      slot.candidates = slot.candidates.filter(candidate => candidate.characterId !== candidateId);
    }

    function moveRoleCandidate(project, characterId, candidateId, direction) {
      const slot = ensureSlot(project, characterId);
      const index = slot.candidates.findIndex(candidate => candidate.characterId === candidateId);
      const target = index + Math.sign(direction);
      if (index < 0 || target < 0 || target >= slot.candidates.length) return;
      [slot.candidates[index], slot.candidates[target]] = [slot.candidates[target], slot.candidates[index]];
    }

    function roleClip(project, catalog, clip, candidateId) {
      if (candidateId === clip.characterId) return M.clone(clip);
      const slot = roleSlot(project, clip.characterId);
      const candidate = slot.candidates.find(item => item.characterId === candidateId);
      if (!candidate) throw new Error('角色不在此定位的兼容分支中');
      const saved = candidate.clips?.[clip.id];
      if (saved) return {...M.clone(clip), ...M.clone(saved), characterId: candidateId};
      const preset = M.ability(catalog, candidateId, clip.abilityId);
      const cast = ['skill', 'burst'].includes(clip.abilityId);
      const timing = cast ? M.timingFor(candidateId, clip.abilityId, false) : null;
      const result = {...M.clone(clip), characterId: candidateId,
        effectMs: preset.effectMs, cooldownMs: preset.cooldownMs, effectPolicy: preset.effectPolicy,
        effectSource: 'catalog', castTiming: timing ? M.clone(timing) : null,
        castEstimateMs: preset.foregroundMs, lockOverrideMs: null, castInputMs: null,
        hold: false, foregroundMs: cast ? Math.max(100, timing?.lockMs ?? preset.foregroundMs) : clip.foregroundMs};
      if (clip.abilityId === 'combo' && clip.commandOverride === null) result.foregroundMs = M.operationDurationMs(result);
      result.foregroundMs = Math.max(result.foregroundMs, M.minimumForegroundMs(result));
      return result;
    }

    function switchRoleCharacter(project, catalog, characterId, candidateId) {
      const slot = ensureSlot(project, characterId);
      if (slot.characterId === candidateId) return slot;
      const current = slot.candidates.find(candidate => candidate.characterId === slot.characterId);
      if (!slot.candidates.some(candidate => candidate.characterId === candidateId)) {
        throw new Error('请先添加该角色的兼容分支');
      }
      const rows = M.ordered(project);
      const replacements = new Map(rows.filter(clip => clip.characterId === slot.characterId)
        .map(clip => [clip.id, roleClip(project, catalog, clip, candidateId)]));
      current.clips = Object.fromEntries(rows.filter(clip => clip.characterId === slot.characterId)
        .map(clip => [clip.id, profileOf(clip)]));
      let shift = 0;
      for (const clip of rows) {
        const before = M.endOf(clip) - clip.startMs;
        clip.startMs += shift;
        const replacement = replacements.get(clip.id);
        if (replacement) {
          Object.assign(clip, profileOf(replacement), {characterId: candidateId});
          clip.foregroundMs = Math.max(clip.foregroundMs, M.minimumForegroundMs(clip));
          shift += M.endOf(clip) - clip.startMs - before;
        }
      }
      project.team = project.team.map(id => id === slot.characterId ? candidateId : id);
      slot.characterId = candidateId;
      project.durationMs = Math.max(1000, project.durationMs + shift);
      M.repairSchedule(project, false, rows, rows[0]?.id);
      return slot;
    }

    function normalizeRoles(project, catalog) {
      if (!Array.isArray(project.roleSlots)) throw new Error('角色定位配置无效');
      const slotIds = new Set(), members = new Set(), candidates = new Set();
      for (const slot of project.roleSlots) {
        if (!slot || typeof slot.id !== 'string' || slotIds.has(slot.id)
          || !project.team.includes(slot.characterId) || members.has(slot.characterId)
          || !roleDefinitions.some(role => role.id === slot.role)
          || !Array.isArray(slot.candidates) || !slot.candidates.length
          || !slot.candidates.some(candidate => candidate.characterId === slot.characterId)) {
          throw new Error('角色定位配置无效');
        }
        slotIds.add(slot.id); members.add(slot.characterId);
        for (const candidate of slot.candidates) {
          M.character(catalog, candidate.characterId);
          if (candidates.has(candidate.characterId)) throw new Error('同一角色不能属于两个定位');
          candidates.add(candidate.characterId);
          if (!candidate.clips || typeof candidate.clips !== 'object' || Array.isArray(candidate.clips)) {
            throw new Error('兼容角色的动作配置无效');
          }
          for (const [id, profile] of Object.entries(candidate.clips)) {
            if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new Error('兼容角色的动作配置无效');
            candidate.clips[id] = profileOf(profile);
          }
        }
      }
      for (const id of project.team.filter(id => !members.has(id))) {
        if (candidates.has(id)) throw new Error('兼容角色已占用其他队伍位置');
      }
      for (const clip of project.clips) {
        for (const candidate of roleSlot(project, clip.characterId).candidates) {
          const variant = roleClip(project, catalog, clip, candidate.characterId);
          M.ability(catalog, variant.characterId, variant.abilityId);
          if (![variant.foregroundMs, variant.effectMs, variant.cooldownMs].every(Number.isFinite)
            || variant.foregroundMs < 100 || variant.effectMs < 0 || variant.cooldownMs < 0
            || !['none', 'skill', 'burst'].includes(variant.readiness)
            || !['wait', 'skip'].includes(variant.notReady)
            || variant.lockOverrideMs !== null && (!Number.isFinite(variant.lockOverrideMs) || variant.lockOverrideMs < 100)) {
            throw new Error('兼容角色的动作参数无效');
          }
          M.commandsFor(variant);
        }
      }
      return project;
    }

    function validateRoles(project, catalog) {
      const issues = [];
      if (hasCompatibility(project) && !M.isProcess(project)) {
        issues.push({code: 'role-mode', message: '多角色兼容需要使用“按步骤推进”', clipIds: []});
      }
      if (catalog && project.roleSlots?.length) {
        try { normalizeRoles(M.clone(project), catalog); }
        catch (error) { issues.push({code: 'role-config', message: error.message, clipIds: []}); }
      }
      return issues;
    }

    function selectors(slot, catalog) {
      return slot.candidates.map((candidate, index) => ({
        characterId: candidate.characterId, name: M.character(catalog, candidate.characterId).name,
        guard: [`in-party(${M.character(catalog, candidate.characterId).name})`,
          ...slot.candidates.slice(0, index).map(previous =>
            `!in-party(${M.character(catalog, previous.characterId).name})`)].join(' && ')
      }));
    }

    // Only function arguments are rewritten; action names and arithmetic stay intact.
    function rewriteCondition(source, groups, indexes, characterSlots) {
      const target = raw => {
        const value = raw.trim();
        if (!value) return null;
        if (/^(?:-?\d+(?:\.\d+)?|true|false)$/i.test(value)) {
          const number = /^(true|false)$/i.test(value) ? Number(value.toLowerCase() === 'true') : Math.trunc(Number(value));
          const names = indexes.get(String(number));
          if (!names) throw new Error(`兼容条件找不到动作索引 ${value}，请使用动作名称`);
          return names;
        }
        if (!/^[\p{L}][\p{L}\p{N}-]*$/u.test(value)) {
          throw new Error('多角色兼容的历史条件请使用动作名称或固定索引');
        }
        return groups.get(value.toLowerCase()) || null;
      };
      function rewrite(text) {
        const pattern = /([\p{L}][\p{L}\p{N}-]*)\s*\(/gu;
        let result = '', offset = 0, match;
        while ((match = pattern.exec(text))) {
          let depth = 1, end = pattern.lastIndex, start = end;
          const arguments_ = [];
          for (; end < text.length && depth; end++) {
            if (text[end] === '(') depth++;
            else if (text[end] === ')') depth--;
            if ((text[end] === ',' && depth === 1) || depth === 0) {
              arguments_.push(text.slice(start, end).trim()); start = end + 1;
            }
          }
          if (depth) break;
          const method = match[1], lower = method.toLowerCase();
          const args = arguments_.map(rewrite);
          const names = ['count', 'since'].includes(lower) && arguments_.length ? target(arguments_[0]) : null;
          let value = `${method}(${args.join(',')})`;
          if (names && ['count', 'since'].includes(lower)) {
            const range = args.length > 1 ? ',' + args.slice(1).join(',') : '';
            value = lower === 'count' ? `(${names.map(name => `count(${name}${range})`).join(' + ')})`
              : names.length === 1 ? `since(${names[0]})` : `min(${names.map(name => `since(${name})`).join(',')})`;
          } else if (lower === 'last-exec' && arguments_.length >= 3 && target(arguments_[2])) {
            const greater = arguments_[1].toLowerCase() !== 'false';
            value = `(${target(arguments_[2]).map(name =>
              `last-exec(${args[0]},${greater},${name})`).join(greater ? ' && ' : ' || ')})`;
          } else if (['e-ready', 'q-ready', 'e-cd'].includes(lower) && characterSlots.has(arguments_[0]?.toLowerCase())) {
            const choices = characterSlots.get(arguments_[0].toLowerCase());
            value = lower === 'e-cd' ? `(${choices.map(choice =>
              `((${choice.guard}) * e-cd(${choice.name}))`).join(' + ')})`
              : `(${choices.map(choice => `((${choice.guard}) && ${method}(${choice.name}))`).join(' || ')})`;
          }
          result += text.slice(offset, match.index) + value;
          offset = end; pattern.lastIndex = end;
        }
        return result + text.slice(offset);
      }
      return rewrite(source);
    }

    function compatibleActions(project, catalog) {
      const slots = project.team.filter(id => project.clips.some(clip => clip.characterId === id))
        .map(id => roleSlot(project, id));
      const versions = [];
      for (const slot of slots) {
        for (const candidate of slot.candidates) {
          const concrete = M.clone(project);
          if (candidate.characterId !== slot.characterId) {
            switchRoleCharacter(concrete, catalog, slot.characterId, candidate.characterId);
          }
          concrete.roleSlots = [];
          versions.push({slot, candidate, project: concrete});
        }
      }
      const layout = {skipIds: new Set(), followIds: new Set(), followReleaseIds: new Set(),
        sourceReleaseIds: new Set(), idleIds: new Set()};
      for (const version of versions) {
        const rows = M.ordered(version.project);
        for (const [index, clip] of rows.entries()) {
          if (clip.notReady === 'skip' && (clip.readiness !== 'none' || clip.condition.trim())) layout.skipIds.add(clip.id);
          if (clip.followSourceId) layout.skipIds.add(clip.id);
          if (clip.followAttack && clip.attackAfterMs > 0) {
            layout.followIds.add(clip.id);
            if ((M.castLockMs(clip) || 0) > M.attackStartMs(clip) + clip.attackAfterMs) layout.followReleaseIds.add(clip.id);
          }
          const boundary = rows[index + 1]?.startMs ?? M.loopReturn(version.project)?.startMs ?? version.project.durationMs;
          const idle = Math.max(0, boundary - M.actionEndOf(clip));
          if (idle > 0) layout.idleIds.add(clip.id);
          if (clip.followSourceId && idle > 0) layout.sourceReleaseIds.add(clip.id);
        }
      }
      const owners = new Map();
      const base = M.processActions(project, catalog, M.ordered(project), {layout, owners});
      const byCandidate = new Map();
      for (const version of versions) {
        const actions = M.processActions(version.project, catalog, M.ordered(version.project), {layout});
        if (actions.length !== base.length || actions.some((action, index) => action.Name !== base[index].Name)) {
          throw new Error('兼容分支的步骤结构不一致，请检查动作顺序');
        }
        byCandidate.set(`${version.slot.id}:${version.candidate.characterId}`,
          new Map(actions.map(action => [action.Name, action])));
      }
      const groups = new Map(), indexes = new Map(), result = [];
      const usedNames = new Set(base.map(action => action.Name.toLowerCase()));
      const required = slots.map(slot => `(${selectors(slot, catalog).map(choice => `in-party(${choice.name})`).join(' || ')})`)
        .join(' && ');
      const characterSlots = new Map();
      for (const slot of slots) {
        const choices = selectors(slot, catalog);
        for (const choice of choices) characterSlots.set(choice.name.toLowerCase(), choices);
      }
      for (const [index, action] of base.entries()) {
        const slot = slots.find(item => item.characterId === owners.get(action.Name));
        const choices = slot ? selectors(slot, catalog) : [{guard: '', characterId: null}];
        const names = [];
        for (const [candidateIndex, choice] of choices.entries()) {
          const emitted = M.clone(slot ? byCandidate.get(`${slot.id}:${choice.characterId}`).get(action.Name) : action);
          let name = action.Name;
          if (choices.length > 1) {
            name += `Role${slots.indexOf(slot) + 1}C${candidateIndex + 1}`;
            while (usedNames.has(name.toLowerCase())) name += 'S';
            usedNames.add(name.toLowerCase());
          }
          names.push(name);
          emitted.Name = name; emitted.Index = result.length;
          emitted.roleGuard = [choice.guard, index === 0 && required].filter(Boolean).join(' && ');
          result.push(emitted);
        }
        groups.set(action.Name.toLowerCase(), names);
        const key = String(action.Index);
        indexes.set(key, [...(indexes.get(key) || []), ...names]);
      }
      for (const action of result) {
        const guard = action.roleGuard;
        delete action.roleGuard;
        const rewrite = expression => [rewriteCondition(expression, groups, indexes, characterSlots),
          guard && `(${guard})`].filter(Boolean).join(' && ');
        action.Condition.Expression = rewrite(action.Condition.Expression);
        for (const priority of action.MorePriorities) priority.Expression = rewrite(priority.Expression);
      }
      return result;
    }

    return {roleDefinitions, roleSlot, configureRole, addRoleCandidate, removeRoleCandidate,
      moveRoleCandidate, roleClip, switchRoleCharacter, hasCompatibility, normalizeRoles,
      validateRoles, compatibleActions};
  }

  if (typeof module === 'object' && module.exports) module.exports = createRoles;
  else root.CombatRoleFactory = createRoles;
})(typeof globalThis !== 'undefined' ? globalThis : this);
