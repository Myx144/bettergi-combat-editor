(function(root) {
  'use strict';

  function create(M, R) {
    const clone = M.clone, read = R.read;
    const MIN = -2147483648, MAX = 2147483647;
    const supported = p => !M.isText(p) && p.scheduling === 'original';
    const owner = clip => clip.playerId || '';
    const scopeOf = (p, options = {}) => options.playerId ?? p.activePlayerId ?? '';
    const canonicalSet = (object, field, value) => {
      for (const key of Object.keys(object)) if (key.toLowerCase() === field.toLowerCase()) delete object[key];
      object[field] = value;
    };

    function carrier(clip) {
      const saved = clip.treePrimary;
      if (!saved || saved.version !== 1 || clip.condition !== 'false') return null;
      const extra = M.prioritiesOf(clip)[saved.extraIndex];
      return extra && read(extra, 'Priority', null) === saved.priority
        && read(extra, 'Expression', '') === saved.expression ? saved : null;
    }

    function entries(p, options = {}) {
      if (!supported(p)) return [];
      const multiplayer = M.isMultiplayer(p), scope = scopeOf(p, options), result = [];
      let ordinal = 0;
      for (const clip of M.declared(p)) {
        const primary = carrier(clip), extras = M.prioritiesOf(clip);
        const visible = !multiplayer || owner(clip) === scope || scope !== '' && owner(clip) === '';
        const common = multiplayer && !owner(clip);
        const add = (index, priority, expression, physical) => {
          if (!visible) return;
          result.push({id: `${clip.id}/${index < 0 ? 'primary' : `extra${index}`}`, clipId: clip.id,
            triggerIndex: index, priority, expression, ordinal: physical, playerId: owner(clip), common,
            primary: index < 0, command: M.commandsFor(clip), name: clip.name,
            runtimeIndex: M.priorityOf(clip)});
        };
        if (!primary) add(-1, M.priorityOf(clip), clip.condition, ordinal);
        ordinal++;
        extras.forEach((extra, index) => {
          if (primary?.extraIndex === index) add(-1, primary.priority, primary.expression, ordinal);
          else add(index, read(extra, 'Priority', 0), read(extra, 'Expression', ''), ordinal);
          ordinal++;
        });
      }
      return result.sort((a, b) => a.priority - b.priority || a.ordinal - b.ordinal);
    }

    function find(p, id, options) {
      if (!supported(p)) throw new Error('树状条件仅用于 JSON 条件与优先级模式');
      const entry = entries(p, options).find(row => row.id === id);
      if (!entry) throw new Error('触发分支已变化，请重新选择');
      return {entry, clip: p.clips.find(clip => clip.id === entry.clipId)};
    }

    function names(p, clip) {
      return p.clips.filter(row => !M.isMultiplayer(p) || !owner(row) || owner(row) === owner(clip))
        .map(row => row.name);
    }

    function patchClip(p, clip, patch) {
      M.editClip(p, clip.id, patch, false);
      return p.clips.find(row => row.id === clip.id);
    }

    function setExpression(p, id, expression, options) {
      const {entry, clip} = find(p, id, options);
      if (typeof expression !== 'string') throw new Error('条件表达式需要是文本');
      if (expression.trim()) R.parse(expression, names(p, clip));
      const saved = carrier(clip);
      if (entry.primary && !saved) return patchClip(p, clip, {condition: expression});
      const extras = clone(M.prioritiesOf(clip));
      const index = entry.primary ? saved.extraIndex : entry.triggerIndex;
      canonicalSet(extras[index], 'Expression', expression);
      return patchClip(p, clip, {morePriorities: extras,
        ...(entry.primary ? {treePrimary: {...saved, expression}} : {})});
    }

    function tree(p, id, options) {
      const {entry, clip} = find(p, id, options);
      return R.decode(entry.expression, names(p, clip));
    }

    function at(node, path) {
      for (const index of path) {
        if (!Array.isArray(node.children) || !node.children[index]) throw new Error('条件节点已变化，请重新选择');
        node = node.children[index];
      }
      return node;
    }

    function editNode(p, id, path, patch, options) {
      const value = tree(p, id, options), node = at(value, path);
      if (patch.params && Object.hasOwn(patch.params, 'value') && !Number.isFinite(patch.params.value))
        throw new Error('条件阈值需要是有限数字');
      if (patch.params) node.params = {...node.params, ...clone(patch.params)};
      for (const field of ['mode', 'negated', 'expression']) if (Object.hasOwn(patch, field)) node[field] = patch[field];
      return setExpression(p, id, R.encode(value), options);
    }

    function addNode(p, id, path, kind, options) {
      const {clip} = find(p, id, options), value = tree(p, id, options), node = at(value, path);
      if (node.type !== 'group') throw new Error('请把条件添加到全部满足或任一满足的分组');
      const name = clip.useCurrentCharacter ? '' : M.character(options?.catalog || root.CombatCatalog
        || (typeof module === 'object' && module.exports ? require('./catalog.js') : null), clip.characterId).name;
      const next = R.make(kind, {character: name, otherAction: names(p, clip).find(item => item !== clip.name) || ''});
      if (next.type === 'group') next.children = [R.make('never'), R.make('never')];
      node.children.push(next);
      setExpression(p, id, R.encode(value), options);
      return [...path, node.children.length - 1];
    }

    function removeNode(p, id, path, options) {
      const value = tree(p, id, options);
      if (!path.length) throw new Error('根分组需保留，可移除其中的条件');
      at(value, path.slice(0, -1)).children.splice(path.at(-1), 1);
      return setExpression(p, id, R.encode(value), options);
    }

    function addTrigger(p, id, options) {
      const {entry, clip} = find(p, id, options), extras = clone(M.prioritiesOf(clip));
      const index = extras.length;
      extras.push({Priority: entry.priority, Expression: entry.expression});
      patchClip(p, clip, {morePriorities: extras});
      return `${clip.id}/extra${index}`;
    }

    function removeTrigger(p, id, options) {
      const {entry, clip} = find(p, id, options);
      if (entry.primary) throw new Error('主触发需保留；可把条件设为始终不成立，或在属性中删除整个动作');
      const extras = clone(M.prioritiesOf(clip)), saved = carrier(clip);
      extras.splice(entry.triggerIndex, 1);
      const patch = {morePriorities: extras};
      if (saved) patch.treePrimary = {...saved,
        extraIndex: saved.extraIndex - Number(entry.triggerIndex < saved.extraIndex)};
      patchClip(p, clip, patch);
    }

    // A native action's Index is also its history identity. A moved primary
    // uses a MorePriorities entry so numeric and implicit history queries survive.
    function ensureCarrier(p, entry) {
      let clip = p.clips.find(row => row.id === entry.clipId);
      if (!entry.primary || carrier(clip)) return;
      const extras = clone(M.prioritiesOf(clip));
      const saved = {version: 1, extraIndex: extras.length, priority: M.priorityOf(clip), expression: clip.condition};
      extras.push({Priority: saved.priority, Expression: saved.expression});
      patchClip(p, clip, {condition: 'false', morePriorities: extras, treePrimary: saved});
    }

    function setPriority(p, entry, priority) {
      if (!Number.isInteger(priority) || priority < MIN || priority > MAX) throw new Error('优先级需要是 32 位整数');
      let clip = p.clips.find(row => row.id === entry.clipId), saved = carrier(clip);
      if (entry.primary && !saved && priority === M.priorityOf(clip)) return;
      if (entry.primary && !saved) { ensureCarrier(p, entry); clip = p.clips.find(row => row.id === entry.clipId); saved = carrier(clip); }
      const extras = clone(M.prioritiesOf(clip));
      canonicalSet(extras[entry.primary ? saved.extraIndex : entry.triggerIndex], 'Priority', priority);
      patchClip(p, clip, {morePriorities: extras,
        ...(entry.primary ? {treePrimary: {...saved, priority}} : {})});
    }

    function reorder(p, sourceId, targetId, after = false, options = {}) {
      const queue = entries(p, options), moved = queue.find(row => row.id === sourceId);
      if (!moved || !queue.some(row => row.id === targetId)) throw new Error('拖动目标已变化，请重新选择');
      if (sourceId === targetId) return p;
      const scope = scopeOf(p, options), multiplayer = M.isMultiplayer(p);
      if (multiplayer && scope && moved.common) throw new Error('各端通用分支请切换到各端通用后调整；它会影响全部玩家');
      const desired = queue.filter(row => row.id !== sourceId);
      desired.splice(desired.findIndex(row => row.id === targetId) + Number(after), 0, moved);
      const ids = desired.map(row => row.id), equal = stage =>
        JSON.stringify(entries(stage, options).map(row => row.id)) === JSON.stringify(ids);
      if (equal(p)) return p;
      const index = ids.indexOf(sourceId), previous = desired[index - 1], next = desired[index + 1];
      const candidates = [previous && next && Math.floor((previous.priority + next.priority) / 2),
        next && next.priority - 1, previous && previous.priority + 1, previous?.priority, next?.priority]
        .filter(value => Number.isInteger(value) && value >= MIN && value <= MAX);
      for (const priority of [...new Set(candidates)]) {
        const stage = clone(p);
        setPriority(stage, moved, priority);
        if (equal(stage)) { Object.assign(p, stage); return p; }
      }
      const stage = clone(p);
      const editable = row => !multiplayer || !scope || !row.common;
      desired.filter(editable).forEach(row => ensureCarrier(stage, row));
      const current = new Map(entries(stage, options).map(row => [row.id, row]));
      const ordered = ids.map(id => current.get(id));
      const fixed = ordered.map((row, position) => !editable(row) ? position : -1).filter(position => position >= 0);
      const assignments = new Map();
      if (!fixed.length) ordered.forEach((row, position) => assignments.set(row.id, position * 1024));
      else {
        const first = fixed[0];
        let nextRow = ordered[first], priority = nextRow.priority;
        for (let i = first - 1; i >= 0; i--) {
          const row = ordered[i];
          priority -= Number(row.ordinal > nextRow.ordinal);
          assignments.set(row.id, priority); nextRow = row;
        }
        let previousRow = ordered[first]; priority = previousRow.priority;
        for (let i = first + 1; i < ordered.length; i++) {
          const row = ordered[i], required = priority + Number(previousRow.ordinal > row.ordinal);
          if (editable(row)) { priority = required; assignments.set(row.id, priority); }
          else {
            if (required > row.priority) throw new Error('这两个共用分支之间没有可插入的原生优先级，请先调整共用分支');
            priority = row.priority;
          }
          previousRow = row;
        }
      }
      for (const row of ordered) if (assignments.has(row.id)) setPriority(stage, row, assignments.get(row.id));
      if (!equal(stage)) throw new Error('此顺序与原生同级声明顺序冲突，请先调整相邻分支');
      Object.assign(p, stage);
      return p;
    }

    function demo(catalog) {
      const action = (Name, Character, Action, Index, expression, MorePriorities = []) =>
        ({Name, Character, Action, Index, Condition: {Expression: expression}, EnsureCast: false, MorePriorities});
      return M.importStrategy({Info: {Name: '树状战斗示例', Author: '', PreActions: [], Config: {}}, Actions: [
        action('RaidenE', '雷电将军', 'skill', 0, 'e-ready() && (count() = 0 || !(since() < 25))'),
        action('XingqiuQ', '行秋', 'burst', 1, 'q-ready() && (count() = 0 || !(since() < 18))'),
        action('BennettQ', '班尼特', 'burst', 2, 'q-ready() && (count() = 0 || !(since() < 12))',
          [{Priority: -10, Expression: 'low-hp() && q-ready()'}]),
        action('XianglingQ', '香菱', 'burst', 3, 'q-ready() && (count() = 0 || !(since() < 20))'),
        action('RaidenAttack', '雷电将军', 'attack(2)', 1000, '')
      ]}, catalog);
    }

    return {supported, scopeOf, entries, find, carrier, tree, at, setExpression, editNode, addNode,
      removeNode, addTrigger, removeTrigger, reorder, demo};
  }
  if (typeof module === 'object' && module.exports) module.exports = create;
  else root.CombatTreeModel = {create};
})(typeof globalThis === 'object' ? globalThis : this);
