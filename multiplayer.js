(function(root) {
  'use strict';

  function createMultiplayer(M, R) {
    const base = {...M}, clone = M.clone;
    const read = (value, field, fallback) => {
      const key = Object.keys(value || {}).find(name => name.toLowerCase() === field.toLowerCase());
      return key === undefined ? fallback : value[key];
    };
    const record = value => !!value && typeof value === 'object' && !Array.isArray(value);
    const header = p => p.multiplayer ?? read(p.sourceRoot, 'Multiplayer', null);
    const isMultiplayer = p => header(p) !== null && header(p) !== undefined;
    const players = p => Array.isArray(read(header(p), 'Players', null)) ? read(header(p), 'Players', []) : [];
    const actionOwner = action => read(action, 'Player', '') ?? '';
    const owner = clip => clip.playerId ?? actionOwner(clip.sourceAction);
    const playerId = player => read(player, 'Id', '');
    const activePlayer = p => players(p).find(player => playerId(player) === p.activePlayerId) || null;
    const catalogFor = explicit => explicit || (typeof module === 'object' && module.exports
      ? require('./catalog.js') : root.CombatCatalog);
    const canonical = value => Array.isArray(value) ? value.map(canonical) : record(value)
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
    const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
    const set = (value, field, content) => {
      for (const key of Object.keys(value)) if (key.toLowerCase() === field.toLowerCase()) delete value[key];
      value[field] = content;
    };
    const without = (value, fields) => Object.fromEntries(Object.entries(clone(value || {}))
      .filter(([key]) => !fields.includes(key.toLowerCase())));
    const getPlayer = (p, id) => {
      const result = players(p).find(player => playerId(player) === id);
      if (!result) throw new Error(`玩家「${id}」不存在`);
      return result;
    };
    const settingsFields = ['durationMs', 'repeat'];

    function canonicalHeader(value) {
      const result = clone(value);
      const canonicalKeys = (object, keys) => {
        for (const field of keys) {
          if (Object.keys(object).some(key => key.toLowerCase() === field.toLowerCase()))
            set(object, field, read(object, field, null));
        }
      };
      canonicalKeys(result, ['Version', 'Players']);
      result.Version ??= 1;
      for (const player of result.Players) {
        canonicalKeys(player, ['Id', 'IsHost', 'Characters', 'PreActions', 'EnableCombatTargeting']);
        player.IsHost ??= false;
        player.Characters ??= [];
      }
      return result;
    }

    function plain(p) {
      const result = without(p, ['multiplayer', 'activeplayerid', 'playersettings',
        'teamplans', 'activeteamid', 'nextteamid']);
      result.sourceRoot = without(result.sourceRoot, ['multiplayer']);
      return result;
    }

    function playerSettings(p, id = p.activePlayerId) {
      return {durationMs: p.playerSettings?.[id]?.durationMs ?? p.durationMs,
        repeat: p.playerSettings?.[id]?.repeat ?? p.repeat};
    }

    function ensureSettings(p) {
      p.playerSettings ??= {};
      for (const id of ['', ...players(p).map(playerId)]) {
        p.playerSettings[id] = {...playerSettings(p, id), ...p.playerSettings[id]};
      }
    }

    function updateDuration(p) {
      const values = ['', ...players(p).map(playerId)].map(id => playerSettings(p, id).durationMs);
      p.durationMs = Math.max(1000, ...values);
    }

    function setPlayerSettings(p, id, patch) {
      if (id !== '') getPlayer(p, id);
      ensureSettings(p);
      if (patch.durationMs !== undefined && (!Number.isFinite(patch.durationMs) || patch.durationMs < 1000))
        throw new Error('本端循环长度至少为 1 秒');
      if (patch.repeat !== undefined && typeof patch.repeat !== 'boolean') throw new Error('本端循环状态无效');
      for (const field of settingsFields) if (patch[field] !== undefined) p.playerSettings[id][field] = patch[field];
      updateDuration(p);
      return p;
    }

    function characterIds(player, catalog) {
      return read(player, 'Characters', []).map(name => catalog.characters.find(item => item.name === name)?.id).filter(Boolean);
    }

    function updateTeam(p, catalog) {
      p.team = [...new Set([...players(p).flatMap(player => characterIds(player, catalog)),
        ...p.clips.map(clip => clip.characterId)])];
    }

    function basicHeaderIssues(value) {
      const issues = [];
      const issue = message => issues.push({code: 'multiplayer-header', message, clipIds: []});
      const list = read(value, 'Players', null);
      if (!record(value) || read(value, 'Version', 1) !== 1 || !Array.isArray(list)
        || list.length < 2 || list.length > 4 || list.some(player => !record(player))) {
        issue('多人 JSON 需要 Version=1 及 2 至 4 名玩家');
        return issues;
      }
      const ids = list.map(player => read(player, 'Id', ''));
      if (ids.some(id => typeof id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id))
        || new Set(ids).size !== ids.length) issue('玩家 Id 必须以英文字母开头、最多 64 字符并且唯一，Id 区分大小写');
      if (list.some(player => read(player, 'IsHost', false) !== true && read(player, 'IsHost', false) !== false)
        || list.filter(player => read(player, 'IsHost', false) === true).length !== 1) issue('多人配置必须恰好有一名房主');
      for (const player of list) {
        const expected = list.length === 2 || list.length === 3 && read(player, 'IsHost', false) ? 2 : 1;
        const characters = read(player, 'Characters', []);
        if (!Array.isArray(characters) || characters.length > expected
          || characters.some(name => typeof name !== 'string' || !name.trim())
          || new Set(characters).size !== characters.length) issue(`玩家「${playerId(player)}」的角色列表无效或超过 ${expected} 个槽位`);
        if (!Array.isArray(read(player, 'PreActions', []))) issue(`玩家「${playerId(player)}」的开场指令需要是数组`);
        const targeting = read(player, 'EnableCombatTargeting', null);
        if (targeting !== null && typeof targeting !== 'boolean') issue(`玩家「${playerId(player)}」的索敌设置需要是继承、开启或关闭`);
      }
      return issues;
    }

    function configureMultiplayer(p, value) {
      if (base.hasTeams?.(p)) throw new Error('多人玩家与多套阵容不能联合使用，请先保留为独立工程');
      const issues = basicHeaderIssues(value);
      if (issues.length) throw new Error(issues[0].message);
      p.multiplayer = canonicalHeader(value);
      p.activePlayerId ??= playerId(players(p)[0]);
      for (const clip of p.clips) clip.playerId ??= read(clip.sourceAction, 'Player', '');
      ensureSettings(p);
      updateTeam(p, catalogFor());
      return p;
    }

    function setActivePlayer(p, id) {
      if (id !== '') getPlayer(p, id);
      p.activePlayerId = id;
      return p;
    }

    function remapPlayerMetadata(p, mapping) {
      const entries = Object.entries(mapping || {}), targets = new Set();
      for (const [, id] of entries) {
        getPlayer(p, id);
        if (targets.has(id)) throw new Error('多个玩家的编辑设置不能合并到同一个 Id');
        targets.add(id);
      }
      const saved = clone(p.playerSettings || {}), next = clone(saved);
      for (const [id] of entries) delete next[id];
      for (const [oldId, id] of entries) if (saved[oldId]) next[id] = saved[oldId];
      p.playerSettings = next;
      for (const slot of p.roleSlots || []) {
        if (Object.hasOwn(mapping, slot.playerId)) slot.playerId = mapping[slot.playerId];
      }
      if (Object.hasOwn(mapping, p.activePlayerId)) p.activePlayerId = mapping[p.activePlayerId];
      if (p.activePlayerId !== '' && !players(p).some(player => playerId(player) === p.activePlayerId))
        p.activePlayerId = playerId(players(p)[0]);
      ensureSettings(p);
      updateDuration(p);
      return p;
    }

    function playerProject(p, id, {includeShared = true} = {}) {
      const catalog = catalogFor(), player = id === '' ? null : getPlayer(p, id);
      const result = plain(p), ids = player ? characterIds(player, catalog) : [];
      result.clips = result.clips.filter(clip => owner(clip) === id || includeShared && id !== '' && owner(clip) === '');
      result.roleSlots = (result.roleSlots || []).filter(slot => slot.playerId === id);
      result.team = [...ids];
      Object.assign(result, playerSettings(p, id));
      result.preActions = [...clone(p.preActions || []), ...clone(read(player, 'PreActions', []))];
      let current = ids[0] || result.clips[0]?.characterId || catalog.characters[0]?.id;
      for (const clip of base.ordered(result)) {
        if (clip.useCurrentCharacter) clip.characterId = current;
        else current = clip.characterId;
        if (!result.team.includes(clip.characterId)) result.team.push(clip.characterId);
        if (clip.sourceAction) clip.sourceAction = without(clip.sourceAction, ['player']);
      }
      return result;
    }

    function commit(p, id, scoped, {settings = true} = {}) {
      const before = new Set(p.clips.filter(clip => owner(clip) === id).map(clip => clip.id));
      const next = new Map(scoped.clips.map(clip => [clip.id, clip]));
      p.clips = p.clips.flatMap(clip => {
        if (owner(clip) !== id) return [clip];
        const updated = next.get(clip.id);
        if (!updated) return [];
        updated.playerId = id;
        if (updated.useCurrentCharacter && clip.useCurrentCharacter) updated.characterId = clip.characterId;
        return [updated];
      });
      for (const clip of scoped.clips) if (!before.has(clip.id)) {
        clip.playerId = id;
        p.clips.push(clip);
      }
      p.roleSlots = [...(p.roleSlots || []).filter(slot => slot.playerId !== id),
        ...(scoped.roleSlots || []).map(slot => { slot.playerId = id; return slot; })];
      p.nextId = Math.max(p.nextId, scoped.nextId);
      if (settings) {
        ensureSettings(p);
        p.playerSettings[id] = {...p.playerSettings[id], durationMs: scoped.durationMs, repeat: scoped.repeat};
      }
      updateTeam(p, catalogFor());
      updateDuration(p);
      return p;
    }

    function mutate(p, id, callback, options) {
      const view = playerProject(p, id, {includeShared: false});
      const result = callback(view);
      commit(p, id, view, options);
      return result;
    }

    function selectionOwner(p, ids) {
      const clips = p.clips.filter(clip => ids.includes(clip.id));
      const owners = new Set(clips.map(owner));
      if (owners.size > 1) throw new Error('请在同一玩家或各端通用轨内选择动作，跨玩家整组拖拽需分别调整');
      return clips.length ? owner(clips[0]) : p.activePlayerId || '';
    }

    function assertCharacter(p, id, characterId, catalog) {
      if (!id) throw new Error('具名角色动作需要明确选择执行玩家，各端通用请新建当前角色动作');
      const player = getPlayer(p, id), name = base.character(catalog, characterId).name;
      if (!read(player, 'Characters', []).includes(name)) throw new Error(`角色「${name}」不在玩家「${id}」的可操作角色中`);
    }

    function currentClip(clip) {
      Object.assign(clip, {useCurrentCharacter: true, effectMs: 0, cooldownMs: 0, effectPolicy: 'none',
        castTiming: null, lockOverrideMs: null, castInputMs: null, readiness: 'none', protectCast: false});
      return clip;
    }

    function assignClipPlayer(p, clipId, id, options = {}) {
      const clip = p.clips.find(item => item.id === clipId);
      if (!clip) throw new Error('片段不存在');
      if (id !== '') getPlayer(p, id);
      const catalog = catalogFor();
      const current = options.currentCharacter ?? (options.characterId ? false : !!clip.useCurrentCharacter);
      if (!current) assertCharacter(p, id, options.characterId || clip.characterId, catalog);
      else if (id === '' && options.characterId) throw new Error('各端通用动作不能指定角色');
      clip.playerId = id;
      clip.sourceAction ??= {};
      set(clip.sourceAction, 'Player', id);
      if (current) {
        currentClip(clip);
        set(clip.sourceAction, 'Character', '');
      } else {
        clip.useCurrentCharacter = false;
        clip.characterId = String(options.characterId || clip.characterId);
        set(clip.sourceAction, 'Character', base.character(catalog, clip.characterId).name);
      }
      updateTeam(p, catalog);
      return p;
    }

    function assignRolePlayer(p, slotId, id, options = {}) {
      const player = getPlayer(p, id), catalog = catalogFor();
      const matches = (p.roleSlots || []).filter(slot => slot.id === slotId
        && (options.fromPlayerId === undefined || slot.playerId === options.fromPlayerId));
      if (matches.length !== 1) throw new Error('定位标识不存在或属于多个玩家，请明确原执行玩家');
      const slot = matches[0], allowed = read(player, 'Characters', []);
      if (slot.candidates.some(candidate => !allowed.includes(base.character(catalog, candidate.characterId).name)))
        throw new Error(`该定位包含玩家「${id}」可操作名单以外的兼容角色，请先明确调整兼容分支`);
      const clips = p.clips.filter(clip => !clip.useCurrentCharacter && clip.characterId === slot.characterId
        && (slot.playerId === undefined || owner(clip) === slot.playerId));
      if (clips.some(clip => owner(clip) !== id))
        throw new Error('同一定位的动作已分配到不同玩家，请先明确调整动作和定位归属');
      if ((p.roleSlots || []).some(other => other !== slot && other.playerId === id && other.id === slot.id))
        throw new Error('目标玩家已有相同标识的角色定位');
      slot.playerId = id;
      return p;
    }

    function addCurrentAction(p, catalog, abilityId = 'wait', startMs = 0,
      {playerId: id = p.activePlayerId || '', ripple = true} = {}) {
      if (!isMultiplayer(p)) throw new Error('当前角色通用轨需要先配置多人玩家');
      if (id !== '') getPlayer(p, id);
      return mutate(p, id, view => {
        const placeholder = view.team[0] || players(p).flatMap(player => characterIds(player, catalog))[0]
          || catalog.characters[0]?.id;
        const clip = currentClip(base.makeClip(view, catalog, placeholder, abilityId, startMs));
        Object.assign(clip, {playerId: id, condition: '', ensureCast: false, sourceAction: {Player: id, Character: ''}});
        view.clips.push(clip);
        if (!view.team.includes(placeholder)) view.team.push(placeholder);
        if (ripple) base.repairSchedule(view);
        view.durationMs = Math.max(view.durationMs, ...view.clips.map(base.endOf));
        return clip;
      });
    }

    function preLines(actions, allowed, catalog, label) {
      if (!Array.isArray(actions)) throw new Error(`${label}开场指令需要是数组`);
      const result = [];
      for (const raw of actions) {
        if (typeof raw !== 'string' || !raw.trim()) throw new Error(`${label}开场指令不能为空`);
        for (const text of raw.split(/[\r\n;]+/).map(line => line.trim()).filter(Boolean)) {
          if (/^(\/\/|#)/.test(text)) continue;
          let depth = 0, separator = -1;
          for (let index = 0; index < text.length; index++) {
            if (text[index] === '(') depth++;
            else if (text[index] === ')') depth--;
            else if (text[index] === ' ' && depth === 0) { separator = index; break; }
          }
          const prefix = separator > 0 ? text.slice(0, separator) : '当前角色';
          const commands = separator > 0 ? text.slice(separator + 1).trim() : text;
          const avatar = catalog?.characters.find(item => item.name === prefix || item.aliases.includes(prefix));
          const name = avatar?.name || prefix;
          if (name !== '当前角色' && !allowed.includes(name)) throw new Error(`${label}开场指令引用了其他玩家的角色「${prefix}」`);
          if (!commands || !base.parseCommands(commands).length) throw new Error(`${label}开场指令不能为空`);
          result.push(`${name} ${commands}`);
        }
      }
      return result;
    }

    function validateMultiplayer(p, catalog = null, {requireActions = true} = {}) {
      const issues = basicHeaderIssues(header(p));
      const issue = (code, message, id, clipIds = []) => issues.push({code, message, clipIds,
        ...(id === undefined ? {} : {playerId: id})});
      if (base.hasTeams?.(p)) issue('multiplayer-mode', '多人玩家与多套阵容不能联合导出，请分别保存工程');
      if (issues.some(entry => entry.code === 'multiplayer-header')) return issues;
      try { preLines(p.preActions || [], [], catalog, '共用'); }
      catch (error) { issue('multiplayer-preactions', error.message, ''); }
      const ids = new Set(players(p).map(playerId));
      for (const slot of p.roleSlots || []) if (!ids.has(slot.playerId))
        issue('multiplayer-player', `角色定位「${slot.id}」尚未指定有效的执行玩家`, slot.playerId);
      for (const clip of p.clips) {
        const id = owner(clip);
        if (typeof id !== 'string' || id !== '' && !ids.has(id)) {
          issue('multiplayer-player', `动作「${clip.name}」的执行玩家「${id}」不存在`, id, [clip.id]);
        } else if (!clip.useCurrentCharacter) {
          if (!id) issue('multiplayer-player', `具名动作「${clip.name}」必须指定执行玩家`, id, [clip.id]);
          else if (catalog) {
            const name = catalog.characters.find(avatar => avatar.id === clip.characterId)?.name;
            const actual = p.scheduling === 'original' ? read(clip.sourceAction, 'Character', name) : name;
            if (actual !== name || !read(getPlayer(p, id), 'Characters', []).includes(actual))
              issue('multiplayer-character', `动作「${clip.name}」需使用玩家「${id}」名单内的标准中文角色名`, id, [clip.id]);
          }
        }
      }
      for (const player of players(p)) {
        const id = playerId(player), list = read(player, 'Characters', []);
        const expected = players(p).length === 2 || players(p).length === 3 && read(player, 'IsHost', false) ? 2 : 1;
        if (list.length !== expected || catalog && list.some(name => !catalog.characters.some(item => item.name === name)))
          issue('multiplayer-characters', `玩家「${id}」需要 ${expected} 个标准中文角色名`, id);
        try { preLines(read(player, 'PreActions', []), list, catalog, `玩家「${id}」`); }
        catch (error) { issue('multiplayer-preactions', error.message, id); }
        const local = playerProject(p, id);
        for (const slot of local.roleSlots) {
          if (catalog && slot.candidates.some(candidate => !list.includes(
            catalog.characters.find(avatar => avatar.id === candidate.characterId)?.name)))
            issue('multiplayer-character', `玩家「${id}」的兼容分支包含可操作名单以外的角色`, id);
        }
        if (!local.clips.length) {
          if (requireActions) issue('multiplayer-empty', `玩家「${id}」尚未配置可执行动作`, id);
          continue;
        }
        for (const entry of base.validate(local, catalog, {teams: false})) {
          issues.push({...entry, playerId: id, message: `玩家「${id}」：${entry.message}`});
        }
      }
      return issues;
    }

    function nativeHeader(p) {
      return clone(header(p));
    }

    function exportMultiplayer(p, catalog, {embedProject = true, check = true} = {}) {
      if (base.hasTeams?.(p)) throw new Error('多人玩家与多套阵容不能联合导出，请分别保存工程');
      if (base.isText(p)) throw new Error('多人 TXT 必须明确选择一名玩家导出');
      const issues = check ? validateMultiplayer(p, catalog).filter(entry => entry.severity !== 'warning') : [];
      if (issues.length) throw new Error(issues[0].message);
      let strategy;
      if (p.scheduling === 'original') {
        const view = plain(p);
        view.roleSlots = [];
        strategy = base.exportStrategy(view, catalog, {embedProject: false, check: false, teamScope: false});
        base.declared(p).forEach((clip, index) => {
          const id = owner(clip);
          if (id || Object.keys(clip.sourceAction || {}).some(key => /^player$/i.test(key)))
            set(strategy.Actions[index], 'Player', id === '' && read(clip.sourceAction, 'Player', '') === null ? null : id);
          else for (const key of Object.keys(strategy.Actions[index])) if (/^player$/i.test(key)) delete strategy.Actions[index][key];
          if (clip.useCurrentCharacter) set(strategy.Actions[index], 'Character', '');
        });
      } else {
        const view = plain(p);
        view.clips = [];
        view.team = [];
        view.roleSlots = [];
        strategy = base.exportStrategy(view, catalog, {embedProject: false, check: false, teamScope: false});
        strategy.Actions = players(p).flatMap(player => {
          const id = playerId(player), local = playerProject(p, id);
          return base.exportStrategy(local, catalog, {embedProject: false, check: false, teamScope: false})
            .Actions.map(action => { set(action, 'Player', id); return action; });
        });
      }
      set(strategy, 'Multiplayer', nativeHeader(p));
      if (check && strategy.Actions.length > 800) throw new Error('多人导出超过 800 个动作，请减少动作');
      if (embedProject) strategy.Info.Config.CombatTimeline = {version: 1, compilerVersion: 6, project: clone(p)};
      return strategy;
    }

    function playerStrategy(p, catalog, id, {check = false} = {}) {
      const player = getPlayer(p, id), strategy = exportMultiplayer(p, catalog, {embedProject: false, check});
      const result = without(strategy, ['multiplayer']);
      result.Info.PreActions = [...clone(p.preActions || []), ...clone(read(player, 'PreActions', []))];
      result.Actions = strategy.Actions.filter(action => !read(action, 'Player', '') || read(action, 'Player', '') === id)
        .map(action => without(action, ['player']));
      return result;
    }

    function normalizeMultiplayer(value, catalog, options = {}) {
      const saved = clone(value), source = header(value);
      const issues = basicHeaderIssues(source);
      if (issues.length) throw new Error(issues[0].message);
      const native = canonicalHeader(source);
      if (base.hasTeams?.(saved)) throw new Error('多人玩家与多套阵容不能联合使用，请分别保存工程');
      const slots = clone(saved.roleSlots || []), single = plain(saved);
      single.roleSlots = [];
      const result = base.normalizeProject(single, catalog, {...options, separateActions: false, allowActorPool: true});
      result.multiplayer = native;
      result.activePlayerId = saved.activePlayerId ?? playerId(read(native, 'Players', [])[0]);
      result.playerSettings = clone(saved.playerSettings || {});
      result.roleSlots = slots;
      for (const clip of result.clips) clip.playerId = owner(clip);
      ensureSettings(result);
      for (const player of players(result)) {
        const id = playerId(player), local = playerProject(result, id, {includeShared: false});
        base.normalizeRoles(local, catalog);
        if (options.separateActions !== false) base.separateFollowAttacks(local, catalog);
        commit(result, id, local, {settings: false});
      }
      updateTeam(result, catalog);
      return result;
    }

    function importMultiplayer(value, catalog) {
      const sourceHeader = read(value, 'Multiplayer', null);
      const issues = basicHeaderIssues(sourceHeader);
      if (issues.length) throw new Error(issues[0].message);
      const native = canonicalHeader(sourceHeader);
      const info = read(value, 'Info', {}), config = read(info, 'Config', {}), embedded = read(config, 'CombatTimeline', null);
      if (embedded?.version === 1 && embedded.compilerVersion === 6) {
        const saved = normalizeMultiplayer(embedded.project, catalog, {separateActions: false});
        const expected = exportMultiplayer(saved, catalog, {embedProject: false, check: false});
        if (equal(expected.Actions, read(value, 'Actions', []))) {
          saved.multiplayer = clone(native);
          saved.name = read(info, 'Name', saved.name);
          saved.author = read(info, 'Author', saved.author);
          saved.preActions = clone(read(info, 'PreActions', []));
          saved.sourceRoot = without(value, ['info', 'actions']);
          saved.sourceInfo = clone(info);
          saved.sourceInfo.Config = without(config, ['combattimeline']);
          return saved;
        }
      }
      const actions = read(value, 'Actions', null);
      if (!Array.isArray(actions) || !actions.length) throw new Error('JSON 中没有战斗动作');
      const p = base.emptyProject();
      Object.assign(p, {multiplayer: clone(native), name: read(info, 'Name', '导入的多人策略'),
        author: read(info, 'Author', ''), preActions: clone(read(info, 'PreActions', [])),
        sourceRoot: without(value, ['info', 'actions']), sourceInfo: clone(info),
        scheduling: 'original', repeat: false, clips: [], playerSettings: {}});
      p.sourceInfo.Config = without(config, ['combattimeline']);
      const records = new Map(), durations = new Map();
      const groups = [...new Set([...players(p).map(playerId), '', ...actions.map(actionOwner)])];
      for (const id of groups) {
        const indices = actions.map((action, index) => ({action, index})).filter(entry => actionOwner(entry.action) === id);
        if (!indices.length) continue;
        const source = {Info: {...clone(info), Config: without(config, ['combattimeline'])}, Actions: indices.map(entry => entry.action)};
        const local = base.importStrategy(source, catalog);
        durations.set(id, local.durationMs);
        for (const clip of local.clips) {
          const index = indices[clip.declarationOrder].index;
          Object.assign(clip, {id: `clip${index + 1}`, order: index + 1, declarationOrder: index, playerId: id});
          records.set(index, clip);
        }
      }
      p.clips = actions.map((_, index) => records.get(index));
      p.nextId = actions.length + 1;
      for (const player of players(p)) p.playerSettings[playerId(player)] = {
        durationMs: Math.max(1000, durations.get(playerId(player)) || 1000, durations.get('') || 0), repeat: false};
      p.playerSettings[''] = {durationMs: durations.get('') || 1000, repeat: false};
      p.activePlayerId = playerId(players(p)[0]);
      updateTeam(p, catalog);
      updateDuration(p);
      return p;
    }

    function exportPlayerText(p, catalog, id, options = {}) {
      if (!id) throw new Error('多人 TXT 导出必须明确选择一名玩家');
      const player = getPlayer(p, id), local = playerProject(p, id);
      if (options.check !== false) {
        const issues = validateMultiplayer(p, catalog, {requireActions: false}).filter(issue =>
          issue.severity !== 'warning' && (issue.playerId === undefined || issue.playerId === '' || issue.playerId === id));
        if (issues.length) throw new Error(issues[0].message);
      }
      const lines = [...preLines(p.preActions || [], [], catalog, '共用'),
        ...preLines(read(player, 'PreActions', []), read(player, 'Characters', []), catalog, `玩家「${id}」`)];
      const text = base.exportTextStrategy(local, catalog, options);
      const split = text.indexOf('\n\n');
      const prefix = text.slice(0, split + 2);
      return prefix + '// 从多人 JSON 导出本端；条件、优先级与有限重试不保留。\n'
        + (lines.length ? lines.join('\n') + '\n' : '') + text.slice(split + 2);
    }

    const wrapped = {};
    wrapped.makeClip = (p, catalog, characterId, abilityId = 'skill', startMs = 0) => {
      if (!isMultiplayer(p)) return base.makeClip(p, catalog, characterId, abilityId, startMs);
      const id = p.activePlayerId || '';
      assertCharacter(p, id, characterId, catalog);
      const view = playerProject(p, id, {includeShared: false});
      const clip = base.makeClip(view, catalog, characterId, abilityId, startMs);
      clip.playerId = id;
      p.nextId = view.nextId;
      return clip;
    };
    wrapped.addClip = (p, catalog, characterId, abilityId, startMs, ripple = true) => {
      if (!isMultiplayer(p)) return base.addClip(p, catalog, characterId, abilityId, startMs, ripple);
      const id = p.activePlayerId || '';
      assertCharacter(p, id, characterId, catalog);
      return mutate(p, id, view => base.addClip(view, catalog, characterId, abilityId, startMs, ripple));
    };
    wrapped.insertAfter = (p, catalog, clipId, abilityId, ripple = true) => {
      if (!isMultiplayer(p)) return base.insertAfter(p, catalog, clipId, abilityId, ripple);
      const clip = p.clips.find(item => item.id === clipId);
      if (!clip) throw new Error('片段不存在');
      const id = owner(clip);
      return mutate(p, id, view => {
        const result = base.insertAfter(view, catalog, clipId, abilityId, false);
        if (clip.useCurrentCharacter) {
          currentClip(result);
          result.condition = '';
          result.ensureCast = false;
          result.sourceAction = {...result.sourceAction, Player: id, Character: ''};
        }
        if (ripple) base.repairSchedule(view);
        return result;
      });
    };
    wrapped.editClip = (p, clipId, patch, ripple = true) => {
      if (!isMultiplayer(p)) return base.editClip(p, clipId, patch, ripple);
      const clip = p.clips.find(item => item.id === clipId);
      if (!clip) throw new Error('片段不存在');
      if (patch.playerId !== undefined && patch.playerId !== owner(clip)) throw new Error('更改执行玩家请使用明确的动作归属操作');
      if (patch.characterId !== undefined && !clip.useCurrentCharacter)
        assertCharacter(p, owner(clip), patch.characterId, catalogFor());
      const result = mutate(p, owner(clip), view => base.editClip(view, clipId, patch, ripple));
      if (patch.characterId !== undefined && !result.useCurrentCharacter) {
        result.sourceAction ??= {};
        set(result.sourceAction, 'Character', base.character(catalogFor(), result.characterId).name);
      }
      return result;
    };
    wrapped.removeCharacter = (p, characterId, {playerId: id = p.activePlayerId || ''} = {}) => {
      if (!isMultiplayer(p)) return base.removeCharacter(p, characterId);
      if (!id) throw new Error('各端通用轨没有具名角色可删除');
      const player = getPlayer(p, id), name = base.character(catalogFor(), characterId).name;
      mutate(p, id, view => {
        const generic = view.clips.filter(clip => clip.useCurrentCharacter);
        base.removeCharacter(view, characterId);
        for (const clip of generic) if (!view.clips.some(item => item.id === clip.id)) view.clips.push(clip);
      });
      set(player, 'Characters', read(player, 'Characters', []).filter(item => item !== name));
      updateTeam(p, catalogFor());
      return p;
    };
    for (const name of ['moveClips', 'placeClips', 'snapMove']) {
      wrapped[name] = (p, ids, ...args) => {
        if (!isMultiplayer(p)) return base[name](p, ids, ...args);
        const id = selectionOwner(p, ids);
        return name === 'snapMove' ? base[name](playerProject(p, id, {includeShared: false}), ids, ...args)
          : mutate(p, id, view => base[name](view, ids, ...args));
      };
    }
    wrapped.repairSchedule = (p, includeCooldown = false, sequence, rippleAfterId = null) => {
      if (!isMultiplayer(p)) return base.repairSchedule(p, includeCooldown, sequence, rippleAfterId);
      const id = sequence?.length ? selectionOwner(p, sequence.map(clip => clip.id)) : p.activePlayerId || '';
      mutate(p, id, view => base.repairSchedule(view, includeCooldown,
        sequence ? sequence.map(clip => view.clips.find(item => item.id === clip.id)).filter(Boolean) : undefined, rippleAfterId));
      return p;
    };
    wrapped.fitLoop = p => {
      if (!isMultiplayer(p)) return base.fitLoop(p);
      mutate(p, p.activePlayerId || '', view => base.fitLoop(view));
      return p;
    };
    wrapped.resizeForegroundRun = (p, runId, endMs, ripple = true) => {
      if (!isMultiplayer(p)) return base.resizeForegroundRun(p, runId, endMs, ripple);
      const id = p.clips.find(clip => clip.id === runId);
      return mutate(p, id ? owner(id) : p.activePlayerId || '', view => base.resizeForegroundRun(view, runId, endMs, ripple));
    };
    wrapped.separateFollowAttacks = (p, catalog) => {
      if (!isMultiplayer(p)) return base.separateFollowAttacks(p, catalog);
      for (const player of players(p)) mutate(p, playerId(player), view => base.separateFollowAttacks(view, catalog));
      return p;
    };
    for (const name of ['loopReturn', 'minimumLoopMs']) wrapped[name] = (p, ...args) =>
      base[name](isMultiplayer(p) ? playerProject(p, p.activePlayerId || '') : p, ...args);
    for (const name of ['switches', 'foregroundRuns']) wrapped[name] = (p, ...args) => {
      if (!isMultiplayer(p)) return base[name](p, ...args);
      return ['', ...players(p).map(playerId)].flatMap(id =>
        base[name](playerProject(p, id, {includeShared: false}), ...args).map(item => ({...item, playerId: id})));
    };
    wrapped.effectEnd = (p, clip) => {
      if (!isMultiplayer(p)) return base.effectEnd(p, clip);
      const local = playerProject(p, owner(clip));
      return base.effectEnd(local, local.clips.find(item => item.id === clip.id) || clip);
    };
    function playerStateAt(p, id, timeMs, previous = false) {
      const value = base.stateAt(playerProject(p, id), timeMs, previous);
      return {...value, playerId: id, statuses: value.statuses.map(status => ({...status, playerId: id}))};
    }
    wrapped.stateAt = (p, timeMs, previous = false) => {
      if (!isMultiplayer(p)) return base.stateAt(p, timeMs, previous);
      const endpoints = players(p).map(player => playerStateAt(p, playerId(player), timeMs, previous));
      const current = endpoints.find(endpoint => endpoint.playerId === p.activePlayerId)
        || base.stateAt(playerProject(p, ''), timeMs, previous);
      return {...current, players: endpoints, statuses: endpoints.flatMap(endpoint => endpoint.statuses)};
    };
    wrapped.nativeTrackGroups = p => {
      if (!isMultiplayer(p)) return base.nativeTrackGroups(p);
      return ['', ...players(p).map(playerId)].flatMap(id => base.nativeTrackGroups(
        playerProject(p, id, {includeShared: false})).map(group => ({...group, id: `${id}:${group.id}`, playerId: id})));
    };
    wrapped.roleSlot = (p, characterId, {playerId: id = p.activePlayerId || ''} = {}) => {
      if (!isMultiplayer(p)) return base.roleSlot(p, characterId);
      return (p.roleSlots || []).find(slot => slot.playerId === id && (slot.id === characterId || slot.characterId === characterId))
        || {...base.roleSlot(playerProject(p, id, {includeShared: false}), characterId), playerId: id};
    };
    for (const name of ['configureRole', 'removeRoleCandidate', 'moveRoleCandidate', 'switchRoleCharacter', 'addRoleCandidate']) {
      wrapped[name] = (p, ...args) => {
        if (!isMultiplayer(p)) return base[name](p, ...args);
        const id = p.activePlayerId || '';
        if (!id) throw new Error('各端通用轨不能配置具名角色定位');
        if (name === 'addRoleCandidate') {
          const candidateId = args[2];
          assertCharacter(p, id, candidateId, args[0]);
        }
        return mutate(p, id, view => base[name](view, ...args));
      };
    }
    wrapped.roleClip = (p, catalog, clip, candidateId) => base.roleClip(
      isMultiplayer(p) ? playerProject(p, owner(clip), {includeShared: false}) : p, catalog, clip, candidateId);
    wrapped.setStrategyFormat = (p, format) => {
      if (!isMultiplayer(p)) return base.setStrategyFormat(p, format);
      if (format === 'txt') throw new Error('多人 TXT 必须明确选择一名玩家导出，工程继续保留 JSON');
      return base.setStrategyFormat(p, format);
    };

    return {...wrapped, isMultiplayer, players, activePlayer, setActivePlayer, configureMultiplayer, remapPlayerMetadata,
      assignClipPlayer, assignRolePlayer,
      playerProject, playerSettings, setPlayerSettings, addCurrentAction, playerStrategy, playerStateAt,
      validateMultiplayer, normalizeMultiplayer, importMultiplayer, exportMultiplayer, exportPlayerText};
  }

  if (typeof module === 'object' && module.exports) module.exports = createMultiplayer;
  else root.CombatMultiplayerFactory = createMultiplayer;
})(typeof globalThis !== 'undefined' ? globalThis : this);
