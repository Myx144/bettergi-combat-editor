(function (root) {
  'use strict';

  const clone = value => JSON.parse(JSON.stringify(value));
  const seconds = value => Number((value / 1000).toFixed(3));
  const definitions = [
    {id: 'walk', name: '走位', key: 'WASD', iconName: 'move', foregroundMs: 500},
    {id: 'dash', name: '冲刺', key: '冲刺', iconName: 'footprints', foregroundMs: 200},
    {id: 'jump', name: '跳跃', key: 'Space', iconName: 'arrow-up-from-line', foregroundMs: 200},
    {id: 'wait', name: '等待', key: '等待', iconName: 'pause', foregroundMs: 500},
    {id: 'ready', name: '等待操作恢复', key: '恢复', iconName: 'circle-check', foregroundMs: 200},
    {id: 'check', name: '检查战斗结束', key: '检测', iconName: 'scan-eye', foregroundMs: 100},
    {id: 'keypress', name: '点按按键', key: '按键', iconName: 'keyboard', foregroundMs: 100},
    {id: 'keyhold', name: '按键长按', key: '长按', iconName: 'keyboard', foregroundMs: 500},
    {id: 'mousehold', name: '鼠标长按', key: '鼠标', iconName: 'mouse', foregroundMs: 500},
    {id: 'moveby', name: '转向', key: '转向', iconName: 'move', foregroundMs: 100},
    {id: 'combo', name: '组合动作', key: '连招', iconName: 'workflow', foregroundMs: 500}
  ].map(item => ({...item, effectMs: 0, cooldownMs: 0, effectPolicy: 'persist', description: ''}));
  const kinds = [
    ['walk', '走位'], ['dash', '冲刺'], ['jump', '跳跃'], ['wait', '等待'],
    ['attack', '普攻'], ['charge', '重击'], ['skill', '战技'], ['burst', '爆发'],
    ['keypress', '点按按键'], ['keyhold', '按键长按'], ['keydown', '按下按键'], ['keyup', '松开按键'],
    ['click', '鼠标点击'], ['mousehold', '鼠标长按'], ['mousedown', '按下鼠标'], ['mouseup', '松开鼠标'],
    ['moveby', '转向'], ['scroll', '滚轮'], ['ready', '等待操作恢复'], ['check', '检查战斗结束']
  ].map(([id, name]) => ({id, name}));
  const keyAliases = {SPACE: 'VK_SPACE', SHIFT: 'VK_LSHIFT', CTRL: 'VK_LCONTROL', CONTROL: 'VK_LCONTROL',
    ALT: 'VK_LMENU', ENTER: 'VK_RETURN', RETURN: 'VK_RETURN', TAB: 'VK_TAB', ESC: 'VK_ESCAPE',
    ESCAPE: 'VK_ESCAPE', UP: 'VK_UP', DOWN: 'VK_DOWN', LEFT: 'VK_LEFT', RIGHT: 'VK_RIGHT',
    BACKSPACE: 'VK_BACK', DELETE: 'VK_DELETE', HOME: 'VK_HOME', END: 'VK_END',
    PAGEUP: 'VK_PRIOR', PAGEDOWN: 'VK_NEXT', WIN: 'VK_LWIN'};
  const namedKeys = new Set(('SPACE SHIFT LSHIFT RSHIFT CONTROL LCONTROL RCONTROL MENU LMENU RMENU ' +
    'RETURN TAB ESCAPE UP DOWN LEFT RIGHT BACK DELETE HOME END PRIOR NEXT INSERT LWIN RWIN ' +
    'CAPITAL NUMLOCK SCROLL LBUTTON RBUTTON MBUTTON XBUTTON1 XBUTTON2 PAUSE PRINT SNAPSHOT ' +
    'OEM_1 OEM_2 OEM_3 OEM_4 OEM_5 OEM_6 OEM_7 OEM_PLUS OEM_MINUS OEM_COMMA OEM_PERIOD').split(' ')
    .map(key => `VK_${key}`));
  const templates = [
    {id: 'forward-dash', name: '前进冲刺', operations: [
      {type: 'keydown', keys: 'W'}, {type: 'dash', durationMs: 200},
      {type: 'wait', durationMs: 300}, {type: 'keyup', keys: 'W'}]},
    {id: 'jump-cancel', name: '普攻接跳跃', operations: [
      {type: 'attack', durationMs: 300}, {type: 'jump'}, {type: 'wait', durationMs: 100}]},
    {id: 'move-skill', name: '走位战技', operations: [
      {type: 'keydown', keys: 'W'}, {type: 'skill', hold: false},
      {type: 'wait', durationMs: 200}, {type: 'keyup', keys: 'W'}]},
    {id: 'custom', name: '自定义动作组', operations: [{type: 'wait', durationMs: 500}]}
  ];

  function keys(value) {
    const entries = Array.isArray(value) ? value : String(value || '').split('+');
    if (!entries.length || entries.length > 8) throw new Error('请选择 1 至 8 个按键');
    return [...new Set(entries.map(entry => {
      const raw = String(entry).trim().toUpperCase();
      const key = keyAliases[raw] || raw;
      if (/^[A-Z]$/.test(key)) return key;
      if (/^(?:VK_)?[0-9]$/.test(key)) return key.startsWith('VK_') ? key : `VK_${key}`;
      if (/^(?:VK_)?F(?:[1-9]|1[0-9]|2[0-4])$/.test(key)) return key.startsWith('VK_') ? key : `VK_${key}`;
      if (namedKeys.has(key) || /^VK_[A-Z]$/.test(key)) return key;
      throw new Error(`无法识别按键“${entry}”`);
    }))];
  }

  function milliseconds(value, minimum = 1) {
    if (!Number.isFinite(value) || value < minimum) throw new Error('动作时长无效');
    return Math.round(value);
  }

  function make(type) {
    if (!kinds.some(kind => kind.id === type)) throw new Error('动作类型无效');
    return {type, durationMs: type === 'dash' ? 200 : 500, direction: 'w', keys: 'W',
      button: 'left', x: 300, y: 0, amount: 1, hold: false};
  }

  function parameters(abilityId) {
    return {direction: 'w', keys: abilityId === 'keypress' ? 'Space' : 'W',
      button: 'left', x: 300, y: 0};
  }

  function template(id = 'forward-dash') {
    const selected = templates.find(item => item.id === id);
    if (!selected) throw new Error('动作模板不存在');
    return selected.operations.map(item => ({...make(item.type), ...clone(item)}));
  }

  function duration(operations, castEstimate = type => type === 'burst' ? 1800 : 1000) {
    return operations.reduce((total, operation) => {
      if (['walk', 'dash', 'wait', 'attack', 'charge', 'keyhold', 'mousehold'].includes(operation.type)) {
        return total + milliseconds(operation.durationMs, operation.type === 'wait' ? 0 : 1);
      }
      if (['skill', 'burst'].includes(operation.type)) return total + castEstimate(operation.type, operation.hold);
      if (operation.type === 'jump') return total + 200;
      return total + (['keypress', 'click', 'moveby', 'scroll'].includes(operation.type) ? 100 : 0);
    }, 0);
  }

  function fromCommands(commands) {
    const aliases = {e: 'skill', q: 'burst', j: 'jump', after: 'wait', 等待: 'wait',
      普攻: 'attack', 普通攻击: 'attack', 重击: 'charge', 完成: 'ready',
      行走: 'walk', 冲刺: 'dash', 跳跃: 'jump', verticalscroll: 'scroll'};
    const result = [];
    for (const command of commands) {
      const type = aliases[command.method] || (['w', 'a', 's', 'd'].includes(command.method) ? 'walk' : command.method);
      if (!kinds.some(kind => kind.id === type)) return null;
      const operation = make(type), args = command.args;
      if (type === 'walk') {
        const directional = ['w', 'a', 's', 'd'].includes(command.method);
        operation.direction = directional ? command.method : args[0];
        operation.durationMs = Math.round(Number(args[directional ? 0 : 1] ?? 0.5) * 1000);
      } else if (['dash', 'wait', 'attack', 'charge'].includes(type)) {
        operation.durationMs = Math.round(Number(args[0] ?? (type === 'dash' ? 0.2 : 0.5)) * 1000);
      } else if (['keypress', 'keyhold', 'keydown', 'keyup'].includes(type)) operation.keys = args[0];
      else if (['mousedown', 'mouseup', 'mousehold', 'click'].includes(type)) operation.button = args[0] || 'left';
      else if (type === 'moveby') Object.assign(operation, {x: Number(args[0]), y: Number(args[1])});
      else if (type === 'scroll') operation.amount = Number(args[0]);
      else if (type === 'skill') operation.hold = args.includes('hold');
      result.push(operation);
    }
    try { compile(result); } catch { return null; }
    return result;
  }

  function compile(operations, {castWait = null} = {}) {
    if (!Array.isArray(operations) || !operations.length || operations.length > 100) {
      throw new Error('动作组需要 1 至 100 个操作');
    }
    const commands = [], pressedKeys = new Set(), pressedMouse = new Set();
    const press = (key, down) => {
      commands.push(`${down ? 'keydown' : 'keyup'}(${key})`);
      if (down) pressedKeys.add(key); else pressedKeys.delete(key);
    };
    const mouse = (button, down) => {
      if (!['left', 'right', 'middle'].includes(button)) throw new Error('鼠标按键无效');
      commands.push(`${down ? 'mousedown' : 'mouseup'}(${button})`);
      if (down) pressedMouse.add(button); else pressedMouse.delete(button);
    };
    for (const operation of operations) {
      const type = operation.type;
      if (!kinds.some(kind => kind.id === type)) throw new Error('动作类型无效');
      if (['walk', 'dash', 'wait', 'attack', 'charge'].includes(type)) {
        const length = seconds(milliseconds(operation.durationMs, type === 'wait' ? 0 : 1));
        if (type === 'walk') {
          if (!['w', 'a', 's', 'd'].includes(operation.direction)) throw new Error('走位方向无效');
          commands.push(`walk(${operation.direction},${length})`);
        } else commands.push(`${type}(${length})`);
      } else if (['keypress', 'keyhold', 'keydown', 'keyup'].includes(type)) {
        const chord = keys(operation.keys);
        if (type === 'keydown' || type === 'keyup') {
          for (const key of type === 'keyup' ? [...chord].reverse() : chord) press(key, type === 'keydown');
        } else {
          const held = chord.filter(key => !pressedKeys.has(key));
          if (type === 'keypress' && chord.length === 1 && held.length === 1) commands.push(`keypress(${chord[0]})`);
          else {
            for (const key of held) press(key, true);
            commands.push(`wait(${seconds(type === 'keyhold' ? milliseconds(operation.durationMs) : 50)})`);
            for (const key of [...held].reverse()) press(key, false);
          }
        }
      } else if (['mousedown', 'mouseup', 'mousehold', 'click'].includes(type)) {
        const button = operation.button;
        if (!['left', 'right', 'middle'].includes(button)) throw new Error('鼠标按键无效');
        if (type === 'click') commands.push(`click(${button})`);
        else {
          const held = pressedMouse.has(button);
          if (type !== 'mousehold' || !held) mouse(button, type !== 'mouseup');
          if (type === 'mousehold') {
            commands.push(`wait(${seconds(milliseconds(operation.durationMs))})`);
            if (!held) mouse(button, false);
          }
        }
      } else if (type === 'moveby') {
        if (![operation.x, operation.y].every(Number.isInteger)) throw new Error('转向偏移需要整数');
        commands.push(`moveby(${operation.x},${operation.y})`);
      } else if (type === 'scroll') {
        if (!Number.isInteger(operation.amount)) throw new Error('滚轮格数需要整数');
        commands.push(`scroll(${operation.amount})`);
      } else if (type === 'skill') {
        commands.push(operation.hold ? 'skill(hold)' : 'skill');
        const length = castWait?.(operation);
        if (length > 0) commands.push(`wait(${seconds(length)})`);
      } else if (type === 'burst' && castWait) commands.push('burst', 'ready');
      else commands.push(type);
    }
    // A held key belongs to this group; another action must not inherit it.
    for (const button of [...pressedMouse].reverse()) mouse(button, false);
    for (const key of [...pressedKeys].reverse()) press(key, false);
    return commands.join(',');
  }

  function commandsFor(clip, options = {}) {
    if (clip.abilityId === 'combo') return compile(clip.operations, options);
    return compile([{...make(clip.abilityId), ...clip.operation, durationMs: clip.foregroundMs}]);
  }

  const api = {definitions, kinds, templates, keys, make, parameters, template, duration,
    fromCommands, compile, commandsFor};
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CombatOperations = api;
})(typeof globalThis === 'object' ? globalThis : this);
