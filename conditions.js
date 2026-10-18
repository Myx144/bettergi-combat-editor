(function(root) {
  'use strict';

  const parser = typeof module === 'object' && module.exports ? require('./vendor/jsep.cjs') : root.jsep;
  const clone = value => JSON.parse(JSON.stringify(value));
  const read = (value, field, fallback) =>
    value?.[Object.keys(value).find(key => key.toLowerCase() === field.toLowerCase())] ?? fallback;
  const functions = [
    {name: 'e-ready', signature: 'e-ready([角色名])', title: 'E 战技就绪', category: '技能与角色', icon: 'zap',
      detail: '省略角色时检查动作所属角色。读取可跨战斗保留的 E 冷却记录；没有记录时也会视为就绪，不等于确认技能释放成功。', example: 'e-ready()'},
    {name: 'q-ready', signature: 'q-ready([角色名])', title: 'Q 爆发就绪', category: '技能与角色', icon: 'sparkles',
      detail: '省略角色时检查动作所属角色。合并侧边栏与前台 Q 图标识别，每轮缓存结果；不是精确能量数值。', example: 'q-ready(班尼特)'},
    {name: 'low-hp', signature: 'low-hp()', title: '前台角色低血量', category: '技能与角色', icon: 'heart-pulse',
      detail: '检查此刻前台角色的低血量识别结果。不是动作所属角色的后台血量，也不能传入百分比阈值。', example: 'low-hp() && q-ready()'},
    {name: 'onfield', signature: 'onfield()', title: '本角色在前台', category: '技能与角色', icon: 'user-round',
      detail: '动作 Character 指定的角色在前台时成立；Character 为空时不成立。条件判断发生在自动切人之前。', example: 'onfield() && !low-hp()'},
    {name: 'in-party', signature: 'in-party(角色名)', title: '角色在队伍中', category: '技能与角色', icon: 'users-round',
      detail: '指定角色存在于实际队伍。名字使用原生识别的角色名，不加引号。缺席角色的指定动作本身也会先被过滤。', example: 'in-party(行秋)'},
    {name: 'e-cd', signature: 'e-cd([角色名])', title: 'E 剩余冷却', category: '时间与记录', icon: 'timer',
      detail: '返回 E 跟踪器的剩余冷却秒数。省略角色指动作所属角色；没有记录时返回 0。', example: 'e-cd() < 0.5'},
    {name: 'since', signature: 'since([动作名或序号])', title: '距动作上次执行', category: '时间与记录', icon: 'history',
      detail: '返回距动作执行记录的秒数。从未执行是正无穷。省略目标严格匹配本动作的 Index 和 Name；数字查序号，名字查所有同名记录。', example: '!(since() < 15)'},
    {name: 'count', signature: 'count([目标[, 起点[, 终点]]])', title: '动作执行次数', category: '时间与记录', icon: 'hash',
      detail: '返回时间区间内的执行记录条数。默认目标为本动作，起点 0、终点 t()；区间包含两端，使用开战后的绝对秒数。记录不是命中或成功释放次数。', example: 'count(行秋开大) > count()'},
    {name: 't', signature: 't()', title: '战斗计时', category: '时间与记录', icon: 'clock-3',
      detail: '返回求值器创建后经过的秒数；求值器先于 PreActions 创建，因此包含开场动作所用的时间。', example: 't() < 10'},
    {name: 'last-check', signature: 'last-check()', title: '距上次战斗检查', category: '时间与记录', icon: 'scan-eye',
      detail: '距最近一次战斗结束检查的秒数。开始主战斗循环时重置，原生结束检查或 check 指令会更新它；不是距上次截图。', example: 'last-check() > 3'},
    {name: 'last-exec', signature: 'last-exec(秒数[, true/false[, 目标]])', title: '执行间隔判断', category: '兼容与计算', icon: 'repeat-2',
      detail: 'true 或省略表示严格大于秒数，false 表示严格小于。从未执行分别返回 true / false。目标省略、数字、名字的语义与 since 一致。', example: 'last-exec(15,true)'},
    {name: 'battle-time', signature: 'battle-time(秒数[, true/false])', title: '旧式战斗计时', category: '兼容与计算', icon: 'clock-4',
      detail: '当前实现按秒比较战斗计时，true 或省略为严格大于，false 为严格小于。源码中的“毫秒”旧注释与当前计算不一致。新条件建议用 t()。', example: 'battle-time(10,false)'},
    {name: 'min', signature: 'min(数值表达式, ...)', title: '取最小值', category: '兼容与计算', icon: 'minimize-2',
      detail: '取参数的最小数值，无参数返回 0。可组合 since、count、t 等，再与阈值比较。', example: 'min(since(行秋开大), since(班尼特开大)) > 3'},
    {name: 'max', signature: 'max(数值表达式, ...)', title: '取最大值', category: '兼容与计算', icon: 'maximize-2',
      detail: '取参数的最大数值，无参数返回 0。首次 since 为正无穷，混合计算时要考虑该值。', example: 'max(e-cd(行秋), e-cd(班尼特)) < 1'}
  ];
  const names = new Set(functions.map(item => item.name));
  const operators = {'||': 1, '&&': 2, '>': 3, '<': 3, '=': 3, '+': 4, '-': 4, '*': 5, '/': 5};
  parser.removeAllBinaryOps();
  for (const [operator, precedence] of Object.entries(operators)) parser.addBinaryOp(operator, precedence);
  parser.removeAllUnaryOps();
  parser.addUnaryOp('!');
  parser.addUnaryOp('-');
  let serial = 0;
  const identify = node => ({id: `condition${++serial}`, negated: false, ...node});
  const group = (mode = 'all', children = []) => identify({type: 'group', mode, children});

  // Map the native hyphenated identifiers to parser-safe names. Parsing is done by jsep.
  function parse(expression, actionNames = []) {
    const known = new Set([...names, ...actionNames.map(String)].map(name => name.toLowerCase()));
    const aliases = new Map(), reversed = new Map();
    let translated = '', offset = 0;
    while (offset < expression.length) {
      const character = expression[offset];
      if (/\s/u.test(character)) { translated += character; offset++; continue; }
      if (/\p{L}/u.test(character)) {
        const start = offset++;
        while (offset < expression.length && /[\p{L}\p{N}]/u.test(expression[offset])) offset++;
        if (expression[offset] === '-') {
          let end = offset + 1;
          while (end < expression.length && /[\p{L}\p{N}-]/u.test(expression[end])) end++;
          while (end > offset && !known.has(expression.slice(start, end).toLowerCase())) end--;
          if (end > offset) offset = end;
        }
        const word = expression.slice(start, offset);
        if (word === 'true' || word === 'false') translated += word;
        else {
          if (!aliases.has(word)) {
            const alias = `_native${aliases.size}`;
            aliases.set(word, alias);
            reversed.set(alias, word);
          }
          translated += aliases.get(word);
        }
      } else if (/[0-9.]/.test(character)) {
        const start = offset++;
        while (offset < expression.length && /[0-9.]/.test(expression[offset])) offset++;
        const number = expression.slice(start, offset);
        if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(number)) throw new Error('数字格式无效');
        translated += number;
      } else if (expression.startsWith('&&', offset) || expression.startsWith('||', offset)) {
        translated += expression.slice(offset, offset + 2); offset += 2;
      } else if ('(),!+-*/><='.includes(character)) {
        const pair = expression.slice(offset, offset + 2);
        if (['>=', '<=', '==', '!='].includes(pair)) throw new Error('原生比较使用 >、<、=；大于等于请写 !(左侧 < 右侧)');
        translated += character; offset++;
      } else throw new Error(`原生条件不支持字符 ${character}`);
    }
    if (!translated.trim()) return {type: 'bool', value: true};
    const convert = node => {
      if (node.type === 'Literal' && ['number', 'boolean'].includes(typeof node.value)) {
        if (typeof node.value === 'number' && !Number.isFinite(node.value)) throw new Error('数值需要是有限数字');
        return {type: typeof node.value === 'boolean' ? 'bool' : 'number', value: node.value};
      }
      if (node.type === 'Identifier' && reversed.has(node.name)) return {type: 'identifier', name: reversed.get(node.name)};
      if (node.type === 'CallExpression' && node.callee.type === 'Identifier') {
        const name = reversed.get(node.callee.name);
        if (!names.has(name?.toLowerCase())) throw new Error(`未知原生函数 ${name || node.callee.name}`);
        return {type: 'call', name: name.toLowerCase(), args: node.arguments.map(convert)};
      }
      if (node.type === 'UnaryExpression' && ['!', '-'].includes(node.operator))
        return {type: 'unary', operator: node.operator, value: convert(node.argument)};
      if (node.type === 'BinaryExpression' && Object.hasOwn(operators, node.operator))
        return {type: 'binary', operator: node.operator, left: convert(node.left), right: convert(node.right)};
      throw new Error('该结构无法作为原生条件解析');
    };
    return convert(parser(translated));
  }

  function stringify(node) {
    if (node.type === 'number' || node.type === 'bool') return String(node.value);
    if (node.type === 'identifier') return node.name;
    if (node.type === 'call') return `${node.name}(${node.args.map(stringify).join(', ')})`;
    if (node.type === 'unary') return `${node.operator}(${stringify(node.value)})`;
    return `(${stringify(node.left)} ${node.operator} ${stringify(node.right)})`;
  }

  const call = (node, name, min = 0, max = min) => node?.type === 'call'
    && node.name === name && node.args.length >= min && node.args.length <= max;
  const numeric = node => node?.type === 'number' ? node.value
    : node?.type === 'unary' && node.operator === '-' && node.value.type === 'number' ? -node.value.value : null;
  const target = node => !node ? '' : node.type === 'identifier' ? node.name : numeric(node);
  function atom(node, negateComparison = false) {
    const test = (kind, params = {}) => identify({type: 'test', kind, params});
    for (const kind of ['e-ready', 'q-ready', 'in-party']) {
      if (call(node, kind, kind === 'in-party' ? 1 : 0, 1)
        && (!node.args[0] || node.args[0].type === 'identifier'))
        return test(kind, {target: target(node.args[0])});
    }
    for (const kind of ['low-hp', 'onfield']) if (call(node, kind)) return test(kind);
    if (node.type === 'bool') return test(node.value ? 'always' : 'never');
    for (const kind of ['last-exec', 'battle-time']) {
      if (call(node, kind, 1, kind === 'last-exec' ? 3 : 2) && numeric(node.args[0]) !== null
        && (!node.args[1] || node.args[1].type === 'bool') && target(node.args[2]) !== null) {
        return test(kind, {value: numeric(node.args[0]), greater: node.args[1]?.value !== false,
          target: target(node.args[2])});
      }
    }
    if (node.type === 'binary') {
      const {left, right} = node;
      const inverse = {'<': '>=', '>': '<=', '=': '!='};
      const operator = negateComparison ? inverse[node.operator] : node.operator;
      if (!operator || !['<', '>', '=', '>=', '<=', '!='].includes(operator)) return null;
      if (!negateComparison && node.operator === '>' && call(left, 'count', 1) && call(right, 'count')
        && target(left.args[0]) !== null) return test('after', {target: target(left.args[0])});
      if (numeric(right) !== null) {
        for (const kind of ['since', 'count', 't', 'e-cd', 'last-check']) {
          if (call(left, kind, 0, ['since', 'e-cd', 'count'].includes(kind) ? 1 : 0)
            && target(left.args[0]) !== null && (kind !== 'e-cd' || !left.args[0] || left.args[0].type === 'identifier')) return test(kind,
              {target: target(left.args[0]), operator, value: numeric(right)});
        }
      }
    }
    return null;
  }

  function fromAst(ast) {
    if (ast.type === 'binary' && ['&&', '||'].includes(ast.operator)) {
      const mode = ast.operator === '&&' ? 'all' : 'any', children = [];
      const append = child => {
        const node = fromAst(child);
        if (node.type === 'group' && node.mode === mode && !node.negated) children.push(...node.children);
        else children.push(node);
      };
      append(ast.left); append(ast.right);
      return group(mode, children);
    }
    if (ast.type === 'unary' && ast.operator === '!') {
      const comparison = ast.value.type === 'binary' ? atom(ast.value, true) : null;
      if (comparison) return comparison;
      const node = fromAst(ast.value);
      node.negated = !node.negated;
      return node;
    }
    return atom(ast) || identify({type: 'raw', expression: stringify(ast)});
  }

  function decode(expression, actionNames = []) {
    if (!expression.trim()) return group();
    try {
      const node = fromAst(parse(expression, actionNames));
      return node.type === 'group' && !node.negated ? node : group('all', [node]);
    } catch (error) {
      return group('all', [identify({type: 'raw', expression, warning: error.message})]);
    }
  }

  const comparisonText = {'>': '大于', '<': '小于', '=': '等于', '>=': '至少', '<=': '不超过', '!=': '不等于'};
  function make(kind, context = {}) {
    if (['all', 'any'].includes(kind)) return group(kind);
    if (kind === 'raw') return identify({type: 'raw', expression: 'true'});
    if (['min', 'max'].includes(kind)) return identify({type: 'raw', expression: `${kind}(since(), 5) > 3`});
    const params = ['e-ready', 'q-ready', 'e-cd', 'since', 'count'].includes(kind) ? {target: ''} : {};
    if (kind === 'in-party') params.target = context.character || '班尼特';
    if (kind === 'after') params.target = context.otherAction || '';
    if (['since', 't', 'last-check', 'last-exec', 'battle-time', 'count', 'e-cd'].includes(kind))
      Object.assign(params, {operator: kind === 'count' ? '=' : kind === 'e-cd' ? '<' : '>=',
        value: kind === 'count' ? 0 : kind === 'e-cd' ? 0.5 : kind === 'last-check' ? 3 : 15});
    if (['last-exec', 'battle-time'].includes(kind)) Object.assign(params, {greater: true, target: ''});
    return identify({type: 'test', kind, params});
  }

  function encode(node, top = true) {
    let expression;
    if (node.type === 'group') {
      const parts = node.children.map(child => encode(child, false));
      expression = parts.length ? parts.map(part => `(${part})`).join(node.mode === 'all' ? ' && ' : ' || ')
        : top && node.mode === 'all' && !node.negated ? '' : node.mode === 'all' ? 'true' : 'false';
    } else if (node.type === 'raw') expression = node.expression.trim() || 'true';
    else {
      const {kind, params: p} = node;
      const ref = p.target === undefined || p.target === '' ? '' : String(p.target);
      if (['always', 'never'].includes(kind)) expression = String(kind === 'always');
      else if (kind === 'after') {
        if (!ref) throw new Error('请选择前置动作');
        expression = `count(${ref}) > count()`;
      } else if (['e-ready', 'q-ready', 'in-party', 'low-hp', 'onfield'].includes(kind)) expression = `${kind}(${ref})`;
      else if (['last-exec', 'battle-time'].includes(kind)) {
        expression = `${kind}(${p.value},${p.greater}${kind === 'last-exec' && ref ? `,${ref}` : ''})`;
      } else {
        const lhs = `${kind}(${ref})`, op = p.operator;
        expression = ['>=', '<=', '!='].includes(op)
          ? `!(${lhs} ${({'>=': '<', '<=': '>', '!=': '='})[op]} ${p.value})`
          : `${lhs} ${op} ${p.value}`;
      }
    }
    return node.negated ? `!(${expression || 'true'})` : expression;
  }

  function describe(node) {
    let text;
    if (node.type === 'group') text = node.children.length
      ? node.children.map(describe).map(part => `「${part}」`).join(node.mode === 'all' ? ' 并且 ' : ' 或者 ')
      : node.mode === 'all' ? '无附加条件' : '永不触发';
    else if (node.type === 'raw') text = node.expression || '无附加条件';
    else {
      const {kind, params: p} = node, ref = p.target === '' || p.target === undefined ? '本动作' : p.target;
      const owner = p.target ? p.target : '本角色';
      const titles = {'e-ready': `${owner} E 就绪`, 'q-ready': `${owner} Q 就绪`,
        'in-party': `${p.target}在队伍中`, 'low-hp': '当前前台角色低血量', onfield: '动作所属角色在前台',
        after: `${ref}的执行次数多于本动作`, always: '始终成立', never: '始终不成立'};
      if (Object.hasOwn(titles, kind)) text = titles[kind];
      else if (['last-exec', 'battle-time'].includes(kind)) text =
        `${kind === 'last-exec' ? `距${ref}上次执行` : '战斗计时'}${p.greater ? '大于' : '小于'} ${p.value} 秒`;
      else {
        const label = {since: `距${ref}上次执行`, count: `${ref}执行次数`, t: '战斗计时',
          'e-cd': `${owner} E 剩余冷却`, 'last-check': '距上次战斗结束检查'}[kind] || kind;
        text = `${label}${comparisonText[p.operator]} ${p.value}${kind === 'count' ? ' 次' : ' 秒'}`;
      }
    }
    return node.negated ? `不满足（${text}）` : text;
  }

  function find(tree, id, parent = null) {
    if (tree.id === id) return {node: tree, parent};
    for (const child of tree.children || []) {
      const found = find(child, id, tree);
      if (found) return found;
    }
    return null;
  }

  function draft(clip, priority, extras, actionNames = []) {
    return [{id: 'primary', priority, original: clip.condition, source: null, dirty: false,
      tree: decode(clip.condition, actionNames)}, ...extras.map(entry => ({
      id: `trigger${++serial}`, priority: read(entry, 'Priority', 0), original: read(entry, 'Expression', ''),
      source: clone(entry), dirty: false, tree: decode(read(entry, 'Expression', ''), actionNames)
    }))];
  }

  const expressionOf = entry => entry.dirty ? encode(entry.tree) : entry.original;
  function patch(entries, actionNames = [], editPriority = true) {
    if (!entries.length) throw new Error('主触发条件不存在');
    for (const entry of entries) {
      if (!Number.isInteger(entry.priority) || entry.priority < -2147483648 || entry.priority > 2147483647)
        throw new Error('优先级需要是 32 位整数，可使用负数');
      if (entry.dirty) {
        const validate = node => {
          if (node.type === 'test' && Object.hasOwn(node.params, 'value') && !Number.isFinite(node.params.value))
            throw new Error('条件阈值需要是有限数字');
          for (const child of node.children || []) validate(child);
        };
        validate(entry.tree);
        parse(expressionOf(entry), actionNames);
      }
    }
    return {...(editPriority ? {priority: entries[0].priority} : {}), condition: expressionOf(entries[0]),
      morePriorities: entries.slice(1).map(entry => {
        const result = clone(entry.source || {});
        for (const key of Object.keys(result)) if (/^(expression|priority)$/i.test(key)) delete result[key];
        return {...result, Priority: entry.priority, Expression: expressionOf(entry)};
      })};
  }

  function move(entries, nodeId, destinationId, index) {
    const destinationEntry = entries.find(entry => find(entry.tree, destinationId));
    const sourceEntry = entries.find(entry => find(entry.tree, nodeId));
    const destination = destinationEntry && find(destinationEntry.tree, destinationId)?.node;
    const source = sourceEntry && find(sourceEntry.tree, nodeId);
    if (!source?.parent || destination?.type !== 'group' || find(source.node, destinationId)) return false;
    let offset = Number.isInteger(index) ? index : destination.children.length;
    const oldIndex = source.parent.children.indexOf(source.node);
    if (source.parent === destination && oldIndex < offset) offset--;
    source.parent.children.splice(oldIndex, 1);
    destination.children.splice(Math.max(0, Math.min(offset, destination.children.length)), 0, source.node);
    sourceEntry.dirty = destinationEntry.dirty = true;
    return true;
  }

  function expand(strategy, party = null) {
    const queue = [], roster = party && new Set(party.map(name => name.toLowerCase()));
    for (const [declaration, action] of read(strategy, 'Actions', []).entries()) {
      const character = read(action, 'Character', '');
      if (roster && character && !roster.has(character.toLowerCase())) continue;
      const base = {declaration, name: read(action, 'Name', ''), character, index: read(action, 'Index', 0),
        command: read(action, 'Action', ''), ensureCast: read(action, 'EnsureCast', false)};
      queue.push({...base, kind: '主触发', priority: base.index,
        expression: read(read(action, 'Condition', {}), 'Expression', '')});
      read(action, 'MorePriorities', []).forEach((entry, index) => queue.push({...base,
        kind: `额外触发 ${index + 1}`, priority: read(entry, 'Priority', 0), expression: read(entry, 'Expression', '')}));
    }
    return queue.sort((left, right) => left.priority - right.priority);
  }

  const api = {functions, kinds: [...functions,
    {name: 'after', title: '前置动作已执行', category: '时间与记录', icon: 'list-checks'},
    {name: 'all', title: '全部满足分组', category: '组合条件', icon: 'list-check'},
    {name: 'any', title: '任一满足分组', category: '组合条件', icon: 'split'},
    {name: 'always', title: '始终成立', category: '组合条件', icon: 'check'},
    {name: 'never', title: '始终不成立', category: '组合条件', icon: 'ban'},
    {name: 'raw', title: '自定义表达式', category: '组合条件', icon: 'code-xml'}],
  parse, stringify, decode, make, group, encode, describe, find, draft, expressionOf, patch, move, expand, read};
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CombatConditions = api;
})(typeof globalThis === 'object' ? globalThis : this);
