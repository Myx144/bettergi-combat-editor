(function(root) {
  'use strict';

  function createTeams(M, R) {
    const collectionFields = ['teamPlans', 'activeTeamId', 'nextTeamId'];
    const record = value => !!value && typeof value === 'object' && !Array.isArray(value);
    const read = M.read || ((value, key, fallback) => {
      const actual = Object.keys(value || {}).find(name => name.toLowerCase() === key.toLowerCase());
      return actual === undefined ? fallback : value[actual];
    });
    const clone = M.clone;
    const isText = project => project.strategyFormat === 'txt';
    const int32 = value => Number.isInteger(value) && value >= -2147483648 && value <= 2147483647;
    const hasTeams = project => Array.isArray(project.teamPlans) && project.teamPlans.length > 0;
    const without = (value, keys) => {
      const result = clone(value || {});
      for (const key of Object.keys(result)) if (keys.includes(key.toLowerCase())) delete result[key];
      return result;
    };
    const set = (value, key, content) => {
      for (const existing of Object.keys(value)) if (existing.toLowerCase() === key.toLowerCase()) delete value[existing];
      value[key] = content;
    };
    const canonical = value => Array.isArray(value) ? value.map(canonical)
      : record(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
    const equal = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
    const rules = () => R || root.CombatConditions;
    function literalNumber(node) {
      if (node?.type === 'number') return node.value;
      if (node?.type === 'bool') return Number(node.value);
      if (node?.type === 'identifier' && /^(true|false)$/i.test(node.name)) return Number(/^true$/i.test(node.name));
      if (node?.type === 'unary' && node.operator === '-') {
        const value = literalNumber(node.value);
        return value === null ? null : -value;
      }
      return null;
    }

    function snapshot(project) {
      if (!record(project)) throw new Error('队伍工程无效');
      return clone(Object.fromEntries(Object.entries(project).filter(([key]) => !collectionFields.includes(key))));
    }

    function activeTeam(project) {
      return hasTeams(project) ? project.teamPlans.find(plan => plan.id === project.activeTeamId) || null : null;
    }

    function teamEntries(project) {
      if (!hasTeams(project)) return [];
      return project.teamPlans.map(plan => ({...plan, roster: [...(plan.roster || [])],
        project: snapshot(plan.id === project.activeTeamId ? project : plan.project)}));
    }

    const inferredRoster = project => (project.team || []).length <= 4 ? [...project.team] : [];

    function enableTeams(project) {
      if (M.isMultiplayer?.(project)) throw new Error('多人玩家与多套阵容不能联合使用，请先保留为独立工程');
      if (hasTeams(project)) return project;
      if (project.teamPlans !== undefined && !Array.isArray(project.teamPlans)) throw new Error('队伍列表无效');
      const saved = snapshot(project);
      project.teamPlans = [{id: 'team1', name: '队伍1', enabled: saved.clips.length > 0,
        roster: inferredRoster(saved), project: saved}];
      project.activeTeamId = 'team1';
      project.nextTeamId = 2;
      return project;
    }

    function syncTeams(project) {
      if (!hasTeams(project)) return project;
      const plan = activeTeam(project);
      if (!plan) throw new Error('当前队伍不存在');
      plan.project = snapshot(project);
      return project;
    }

    function switchTeam(project, id) {
      const target = project.teamPlans?.find(plan => plan.id === id);
      if (!target) throw new Error('队伍不存在');
      syncTeams(project);
      const saved = snapshot(target.project);
      const shared = {teamPlans: project.teamPlans, activeTeamId: id, nextTeamId: project.nextTeamId,
        name: project.name, author: project.author};
      for (const key of Object.keys(project)) delete project[key];
      Object.assign(project, saved, shared);
      return project;
    }

    function addTeam(project, catalog, {name, project: incoming, duplicate = false} = {}) {
      if (M.isMultiplayer?.(incoming || {})) throw new Error('多人玩家工程不能作为多套阵容中的一个队伍');
      enableTeams(project);
      syncTeams(project);
      let saved;
      if (incoming) saved = snapshot(incoming);
      else if (duplicate) saved = snapshot(project);
      else {
        saved = M.emptyProject();
        Object.assign(saved, {strategyFormat: project.strategyFormat, scheduling: project.scheduling,
          execution: project.execution, preActions: clone(project.preActions || []),
          sourceInfo: clone(project.sourceInfo || {}), sourceRoot: clone(project.sourceRoot || {})});
      }
      saved = M.normalizeProject(saved, catalog, {allowActorPool: true});
      let number = Number.isInteger(project.nextTeamId) && project.nextTeamId > 0 ? project.nextTeamId : 1;
      while (project.teamPlans.some(plan => plan.id === `team${number}`)) number++;
      const plan = {id: `team${number}`, name: String(name || `队伍${number}`), enabled: !duplicate && saved.clips.length > 0,
        roster: duplicate && !incoming ? [...activeTeam(project).roster] : inferredRoster(saved), project: saved};
      project.teamPlans.push(plan);
      project.nextTeamId = number + 1;
      return plan;
    }

    function removeTeam(project, id) {
      if (!project.teamPlans?.some(plan => plan.id === id)) throw new Error('队伍不存在');
      if (project.teamPlans.length === 1) throw new Error('至少保留一个队伍');
      if (project.activeTeamId === id) switchTeam(project, project.teamPlans.find(plan => plan.id !== id).id);
      project.teamPlans = project.teamPlans.filter(plan => plan.id !== id);
      return project;
    }

    function slotChoices(plan) {
      const slots = Array.isArray(plan.project.roleSlots) ? plan.project.roleSlots : [];
      return (plan.roster || []).map(id => {
        const slot = slots.find(item => item.characterId === id
          || Array.isArray(item.candidates) && item.candidates.some(candidate => candidate.characterId === id));
        return slot && Array.isArray(slot.candidates) && slot.candidates.length
          ? slot.candidates.map(candidate => candidate.characterId) : [id];
      });
    }

    function setTeamRoster(project, id, ids, catalog) {
      const plan = project.teamPlans?.find(item => item.id === id);
      if (!plan) throw new Error('队伍不存在');
      if (!Array.isArray(ids) || ids.length > 4) throw new Error('队伍最多包含 4 名角色');
      const roster = ids.map(String);
      if (new Set(roster).size !== roster.length) throw new Error('队伍角色不能重复');
      for (const member of roster) M.character(catalog, member);
      const saved = plan.id === project.activeTeamId ? project : snapshot(plan.project);
      const represented = new Set((saved.roleSlots || []).flatMap(slot => slot.candidates.map(candidate => candidate.characterId)));
      const actors = new Set([...saved.clips.map(clip => clip.characterId),
        ...(saved.roleSlots || []).map(slot => slot.characterId)]);
      saved.team = saved.team.filter(member => roster.includes(member) || actors.has(member));
      for (const member of roster) {
        if (!saved.team.includes(member) && !represented.has(member)) saved.team.push(member);
      }
      plan.roster = roster;
      plan.project = snapshot(saved);
      return project;
    }

    function normalizeTeams(project, catalog) {
      if (project.teamPlans === undefined) return project;
      if (!Array.isArray(project.teamPlans)) throw new Error('队伍列表无效');
      if (!project.teamPlans.length) return project;
      const ids = new Set();
      for (const plan of project.teamPlans) {
        if (!record(plan) || typeof plan.id !== 'string' || !plan.id || ids.has(plan.id)) throw new Error('队伍标识无效或重复');
        ids.add(plan.id);
      }
      project.activeTeamId ??= project.teamPlans[0].id;
      if (!ids.has(project.activeTeamId)) throw new Error('当前队伍不存在');
      for (const plan of project.teamPlans) {
        const saved = snapshot(plan.id === project.activeTeamId ? project : plan.project);
        if (M.isMultiplayer?.(saved)) throw new Error('多人玩家与多套阵容不能联合使用，请分别保存工程');
        plan.project = M.normalizeProject(saved, catalog, {allowActorPool: true});
        plan.name = typeof plan.name === 'string' && plan.name.trim() ? plan.name : '未命名队伍';
        plan.enabled ??= true;
        if (typeof plan.enabled !== 'boolean') throw new Error('队伍启用状态无效');
        plan.roster ??= inferredRoster(plan.project);
        if (!Array.isArray(plan.roster) || plan.roster.length > 4
          || new Set(plan.roster.map(String)).size !== plan.roster.length) throw new Error('队伍角色配置无效');
        plan.roster = plan.roster.map(String);
        for (const id of plan.roster) M.character(catalog, id);
      }
      let next = Number.isInteger(project.nextTeamId) && project.nextTeamId > 0 ? project.nextTeamId : 1;
      while (ids.has(`team${next}`)) next++;
      project.nextTeamId = next;
      return project;
    }

    function applySharedSettings(project, fromTeamId = project.activeTeamId) {
      if (!hasTeams(project)) return project;
      syncTeams(project);
      const source = project.teamPlans.find(plan => plan.id === fromTeamId);
      if (!source) throw new Error('队伍不存在');
      const shared = {preActions: clone(source.project.preActions || []),
        sourceInfo: clone(source.project.sourceInfo || {}), sourceRoot: clone(source.project.sourceRoot || {})};
      for (const plan of project.teamPlans) {
        for (const [field, value] of Object.entries(shared)) plan.project[field] = clone(value);
      }
      for (const [field, value] of Object.entries(shared)) project[field] = clone(value);
      return syncTeams(project);
    }

    function teamRelations(project) {
      const members = new Map();
      for (const plan of teamEntries(project)) {
        for (const id of new Set(slotChoices(plan).flat())) {
          if (!members.has(id)) members.set(id, []);
          members.get(id).push(plan.id);
        }
      }
      return [...members].filter(([, teamIds]) => teamIds.length > 1)
        .map(([characterId, teamIds]) => ({characterId, teamIds}));
    }

    function teamGuard(plan, catalog) {
      if (plan.roster?.length !== 4) return 'false';
      return slotChoices(plan).map(ids => {
        const terms = ids.map(id => `in-party(${M.character(catalog, id).name})`);
        return terms.length === 1 ? terms[0] : `(${terms.join(' || ')})`;
      }).join(' && ');
    }

    function overlap(left, right) {
      const a = slotChoices(left), b = slotChoices(right);
      if (a.length !== 4 || b.length !== 4) return null;
      const usedSlots = new Set(), usedCharacters = new Set(), chosen = [];
      const visit = index => {
        if (index === 4) return [...chosen];
        for (let other = 0; other < 4; other++) {
          if (usedSlots.has(other)) continue;
          const common = a[index].filter(id => b[other].includes(id) && !usedCharacters.has(id));
          for (const id of common) {
            usedSlots.add(other); usedCharacters.add(id); chosen.push(id);
            const result = visit(index + 1);
            if (result) return result;
            usedSlots.delete(other); usedCharacters.delete(id); chosen.pop();
          }
        }
        return null;
      };
      return visit(0);
    }

    function metadata(project) {
      const config = read(project.sourceInfo, 'Config', {});
      return {root: without(project.sourceRoot, ['info', 'actions']),
        info: without(project.sourceInfo, ['name', 'author', 'preactions', 'config']),
        config: record(config) ? without(config, ['combattimeline']) : clone(config),
        preActions: clone(project.preActions || [])};
    }

    function metadataIssues(plans) {
      if (plans.length < 2) return [];
      const first = metadata(plans[0].project), issues = [];
      for (const plan of plans.slice(1)) {
        const other = metadata(plan.project);
        for (const [field, path] of [['root', 'JSON 顶层扩展字段'], ['info', 'Info 扩展字段'],
          ['config', 'Info.Config'], ['preActions', 'Info.PreActions']]) {
          if (!equal(first[field], other[field])) issues.push({code: `teams-${field}`, clipIds: [],
            teamIds: [plans[0].id, plan.id],
            message: `「${plans[0].name}」与「${plan.name}」的 ${path} 不一致，请统一后联合导出`});
        }
      }
      return issues;
    }

    const prefixFor = id => `Team${[...id].map(character => character.codePointAt(0).toString(16)).join('X')}`;

    function scopedProject(plan, catalog = null) {
      const saved = snapshot(plan.project);
      if (isText(saved) || saved.scheduling !== 'sequence') return saved;
      const slots = saved.roleSlots || [];
      const owners = new Set((plan.roster || []).map(id => slots.find(slot =>
        slot.characterId === id || slot.candidates.some(candidate => candidate.characterId === id))?.characterId || id));
      const removed = saved.clips.filter(clip => !owners.has(clip.characterId));
      saved.team = [...owners];
      saved.clips = saved.clips.filter(clip => owners.has(clip.characterId));
      saved.roleSlots = slots.filter(slot => owners.has(slot.characterId));
      if (removed.length) {
        const removedNames = new Set(removed.map(clip => clip.name.toLowerCase()));
        const removedIndexes = new Set(removed.map(M.priorityOf));
        const selectedIndexes = new Set(saved.clips.map(M.priorityOf));
        const allNames = plan.project.clips.map(clip => clip.name);
        const fail = (message, clip) => {
          const error = new Error(message);
          error.code = 'teams-reference';
          error.clipIds = clip ? [clip.id] : [];
          throw error;
        };
        for (const clip of removed) {
          if (clip.useCurrentCharacter || clip.sourceAction && read(clip.sourceAction, 'Character', null) === '') {
            fail(`通用动作「${clip.name || clip.id}」没有固定角色，不能按阵容外动作裁剪，请先明确动作归属`, clip);
          }
        }
        const target = (node, clip) => {
          if (!node) return;
          const number = literalNumber(node);
          if (node.type === 'identifier' && number === null) {
            if (removedNames.has(node.name.toLowerCase())) {
              fail(`动作「${clip.name}」引用了阵容外动作「${node.name}」，请调整历史条件或恢复该角色`, clip);
            }
            return;
          }
          if (number !== null && removedIndexes.has(Math.trunc(number))) {
            fail(`动作「${clip.name}」引用了阵容外动作索引 ${Math.trunc(number)}，请调整历史条件或恢复该角色`, clip);
          }
          if (number !== null && !selectedIndexes.has(Math.trunc(number))) {
            fail(`动作「${clip.name}」使用了未对应剩余步骤的索引 ${Math.trunc(number)}，阵容裁剪会改变辅助动作索引，请改用动作名称`, clip);
          }
        };
        const inspect = (node, clip) => {
          if (node.type === 'call') {
            const method = node.name.toLowerCase();
            if (['count', 'since'].includes(method)) target(node.args[0], clip);
            if (method === 'last-exec') target(node.args[2], clip);
            for (const argument of node.args) inspect(argument, clip);
          } else if (node.type === 'unary') inspect(node.value, clip);
          else if (node.type === 'binary') { inspect(node.left, clip); inspect(node.right, clip); }
        };
        const check = clip => {
          const expressions = [clip.condition, ...M.prioritiesOf(clip).map(priority => read(priority, 'Expression', ''))];
          for (const expression of expressions) {
            if (expression?.trim()) inspect(rules().parse(expression, allNames), clip);
          }
        };
        for (const clip of saved.clips) {
          check(clip);
          const slot = saved.roleSlots.find(item => item.characterId === clip.characterId);
          for (const candidate of slot?.candidates || []) {
            if (candidate.clips?.[clip.id]) check({...clip, ...clone(candidate.clips[clip.id])});
          }
        }
      }
      return catalog ? M.normalizeProject(saved, catalog, {separateActions: false}) : saved;
    }

    function namespace(plan, strategy, catalog) {
      const actions = read(strategy, 'Actions', []), names = actions.map(action => read(action, 'Name', ''));
      const pairs = new Map(), byName = new Map(), byIndex = new Map();
      const prefix = prefixFor(plan.id), guard = teamGuard(plan, catalog);
      const append = (map, key, name) => {
        if (!map.has(key)) map.set(key, []);
        if (!map.get(key).includes(name)) map.get(key).push(name);
      };
      const emitted = actions.map(action => {
        const name = read(action, 'Name', ''), index = read(action, 'Index', 0);
        if (!int32(index)) throw new Error('动作优先级需要是 32 位整数');
        const key = JSON.stringify([index, name.toLowerCase()]);
        if (!pairs.has(key)) pairs.set(key, `${prefix}Action${pairs.size + 1}`);
        const renamed = pairs.get(key);
        append(byName, name.toLowerCase(), renamed);
        append(byIndex, index, renamed);
        return renamed;
      });
      let missing = false;
      const identifier = name => ({type: 'identifier', name});
      const call = (name, args) => ({type: 'call', name, args});
      const combine = (operator, entries) => entries.slice(1).reduce((left, right) =>
        ({type: 'binary', operator, left, right}), entries[0]);
      const targets = node => {
        if (node.type === 'identifier') {
          const group = byName.get(node.name.toLowerCase());
          if (!group) throw new Error(`条件引用未知动作「${node.name}」`);
          return group;
        }
        const number = literalNumber(node);
        if (number === null || !Number.isFinite(number)) throw new Error('历史条件目标需使用动作名称或固定数字索引，暂不支持计算索引');
        const index = Math.trunc(number);
        if (!int32(index)) throw new Error('历史条件索引需要是 32 位整数');
        if (byIndex.has(index)) return byIndex.get(index);
        missing = true;
        return [`${prefix}Missing`];
      };
      function rewrite(node) {
        if (node.type === 'unary') return {...node, value: rewrite(node.value)};
        if (node.type === 'binary') return {...node, left: rewrite(node.left), right: rewrite(node.right)};
        if (node.type !== 'call') return node;
        const method = node.name.toLowerCase(), args = node.args;
        if (['since', 'count'].includes(method) && args.length) {
          const group = targets(args[0]);
          const tail = method === 'count' ? args.slice(1).map(rewrite) : args.slice(1);
          const values = group.map(name => call(method, [identifier(name), ...tail]));
          return method === 'count' ? combine('+', values) : values.length === 1 ? values[0] : call('min', values);
        }
        if (method === 'last-exec' && args.length >= 3) {
          const greater = !(args[1].type === 'bool' && args[1].value === false);
          return combine(greater ? '&&' : '||', targets(args[2]).map(name =>
            call(method, [rewrite(args[0]), args[1], identifier(name), ...args.slice(3)])));
        }
        return {...node, args: args.map(rewrite)};
      }
      const expression = source => {
        const parser = rules();
        if (!parser?.parse || !parser?.stringify) throw new Error('条件解析器尚未加载');
        const nativeBooleans = node => {
          if (node.type === 'identifier' && /^(true|false)$/i.test(node.name)) return {type: 'bool', value: /^true$/i.test(node.name)};
          if (node.type === 'unary') return {...node, value: nativeBooleans(node.value)};
          if (node.type === 'binary') return {...node, left: nativeBooleans(node.left), right: nativeBooleans(node.right)};
          if (node.type === 'call') return {...node, args: node.args.map(nativeBooleans)};
          return node;
        };
        const translated = parser.stringify(rewrite(nativeBooleans(parser.parse(source || '', names))));
        return `(${guard}) && (${translated})`;
      };
      const result = actions.map((action, index) => {
        const output = clone(action), condition = clone(read(action, 'Condition', {}));
        set(condition, 'Expression', expression(read(condition, 'Expression', '')));
        set(output, 'Name', emitted[index]);
        set(output, 'Condition', condition);
        const alternatives = clone(read(action, 'MorePriorities', []));
        for (const priority of alternatives) {
          if (!int32(read(priority, 'Priority', 0))) throw new Error('额外触发优先级需要是 32 位整数');
          set(priority, 'Expression', expression(read(priority, 'Expression', '')));
        }
        set(output, 'MorePriorities', alternatives);
        return output;
      });
      const labels = new Map(emitted.map((name, index) => [name, names[index] || '未命名动作']));
      if (missing) {
        result.push({Name: `${prefix}Missing`, Character: '', Action: 'wait(0.01)', Index: 0,
          Condition: {Expression: `(${guard}) && false`}, MorePriorities: [], EnsureCast: false});
        labels.set(`${prefix}Missing`, '无执行记录');
      }
      return {actions: result, labels};
    }

    function compile(plan, catalog) {
      if (M.isMultiplayer?.(plan.project)) throw new Error('多人玩家工程不能与多套阵容联合编译');
      const strategy = M.exportStrategy(scopedProject(plan, catalog), catalog,
        {embedProject: false, check: false, teamScope: false});
      return {strategy, ...namespace(plan, strategy, catalog)};
    }

    function validateTeams(project, catalog) {
      if (!hasTeams(project) || isText(project)) return [];
      const issues = [], issue = (code, message, plan, clipIds = []) =>
        issues.push({code, message, clipIds, ...(plan ? {teamId: plan.id} : {})});
      let plans;
      try { plans = teamEntries(project).filter(plan => plan.enabled); }
      catch (error) { issue('teams-config', error.message); return issues; }
      if (!plans.length) issue('teams-enabled', '请至少启用一个队伍后联合导出');
      let total = 0;
      for (const plan of plans) {
        if (M.isMultiplayer?.(plan.project)) {
          issue('multiplayer-mode', `「${plan.name}」是多人玩家工程，不能与多套阵容联合导出`, plan);
          continue;
        }
        if (isText(plan.project)) {
          issue('teams-format', `「${plan.name}」是 TXT 策略，请停用或切换为 JSON 后联合导出`, plan);
          continue;
        }
        if (plan.roster.length !== 4 || new Set(plan.roster).size !== 4) {
          issue('teams-roster', `「${plan.name}」需要明确选择 4 名队伍角色后联合导出`, plan);
        }
        try {
          if (catalog) for (const id of plan.roster) M.character(catalog, id);
          const choices = slotChoices(plan);
          if (choices.some((ids, index) => choices.slice(0, index).some(previous =>
            previous.some(id => ids.includes(id))))) {
            issue('teams-roster', `「${plan.name}」的兼容角色不能同时占用两个队伍位置`, plan);
          }
          const childIssues = M.validate(scopedProject(plan, catalog), catalog, {teams: false});
          for (const entry of childIssues) issues.push({...entry, teamId: plan.id, message: `「${plan.name}」：${entry.message}`});
          if (catalog && !childIssues.some(entry => entry.severity !== 'warning')) total += compile(plan, catalog).actions.length;
        } catch (error) { issue(error.code || 'teams-export', `「${plan.name}」：${error.message}`, plan, error.clipIds); }
      }
      try { issues.push(...metadataIssues(plans)); }
      catch (error) { issue('teams-config', error.message); }
      for (let left = 0; left < plans.length; left++) {
        for (let right = left + 1; right < plans.length; right++) {
          const roster = overlap(plans[left], plans[right]);
          if (roster) issues.push({code: 'teams-overlap', clipIds: [], teamIds: [plans[left].id, plans[right].id],
            message: `「${plans[left].name}」与「${plans[right].name}」可匹配同一套 4 人队伍，请只启用其中一个方案`});
        }
      }
      if (total > 800) issue('teams-limit', '联合导出超过 800 个动作，请停用部分队伍或减少动作');
      return issues;
    }

    function exportTeams(project, catalog, {embedProject = true, check = true} = {}) {
      if (M.isMultiplayer?.(project)) throw new Error('多人玩家与多套阵容不能联合导出，请分别保存工程');
      if (!hasTeams(project)) return M.exportStrategy(project, catalog, {embedProject, check, teamScope: false});
      if (isText(project)) throw new Error('TXT 策略请按当前队伍导出 TXT 文件');
      syncTeams(project);
      const issues = check ? validateTeams(project, catalog).filter(issue => issue.severity !== 'warning') : [];
      if (issues.length) throw new Error(issues[0].message);
      const plans = teamEntries(project).filter(plan => plan.enabled && !isText(plan.project));
      if (!plans.length) throw new Error('没有已启用的 JSON 队伍');
      const compiled = plans.map(plan => compile(plan, catalog));
      const strategy = clone(compiled[0].strategy);
      set(strategy, 'Actions', compiled.flatMap(entry => entry.actions));
      const info = clone(read(strategy, 'Info', {})), config = without(read(info, 'Config', {}), ['combattimeline']);
      set(info, 'Name', project.name);
      set(info, 'Author', project.author);
      if (embedProject) config.CombatTimeline = {version: 1, compilerVersion: 5, project: clone(project)};
      set(info, 'Config', config);
      set(strategy, 'Info', info);
      return strategy;
    }

    function teamPreview(project, catalog, teamId = project.activeTeamId) {
      const plan = teamEntries(project).find(entry => entry.id === teamId);
      if (!plan || isText(plan.project)) return [];
      const characters = new Set(slotChoices(plan).flat().map(id => M.character(catalog, id).name.toLowerCase()));
      return compile(plan, catalog).actions.filter(action => {
        const character = read(action, 'Character', '');
        return !character || characters.has(character.toLowerCase());
      });
    }

    function teamActionLabels(project, catalog, teamId = project.activeTeamId) {
      const plan = teamEntries(project).find(entry => entry.id === teamId);
      return !plan || isText(plan.project) ? new Map() : compile(plan, catalog).labels;
    }

    return {hasTeams, enableTeams, teamEntries, activeTeam, syncTeams, switchTeam, addTeam, removeTeam,
      setTeamRoster, normalizeTeams, applySharedSettings, teamRelations, teamGuard, validateTeams, exportTeams, teamPreview,
      teamActionLabels, scopedProject};
  }

  if (typeof module === 'object' && module.exports) module.exports = createTeams;
  else root.CombatTeamFactory = createTeams;
})(typeof globalThis !== 'undefined' ? globalThis : this);
