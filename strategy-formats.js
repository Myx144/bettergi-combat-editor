(function(root) {
  'use strict';

  function createFormats(M) {
    const methods = new Set(('skill e burst q attack 普攻 普通攻击 charge 重击 wait after 等待 ready 完成 ' +
      'check 检测 walk 行走 w a s d dash 冲刺 jump j 跳跃 mousedown mouseup click moveby ' +
      'keydown keyup keypress scroll verticalscroll').split(' '));

    function setStrategyFormat(project, format) {
      if (!['txt', 'json'].includes(format)) throw new Error('战斗策略格式无效');
      if ((project.strategyFormat || 'json') === format) return project;
      if (format === 'txt') {
        project.jsonScheduling = {scheduling: project.scheduling, execution: project.execution};
        project.scheduling = 'sequence';
        project.execution = 'process';
      } else {
        const saved = project.jsonScheduling;
        project.scheduling = saved?.scheduling || 'original';
        project.execution = saved?.execution || 'process';
        if (project.team.length > 4) project.scheduling = 'original';
        if (!saved) project.clips.forEach((clip, index) => {
          clip.priority = ['skill', 'burst'].includes(clip.abilityId) ? index : 1000 + index;
          if (!clip.condition && ['skill', 'burst'].includes(clip.abilityId)) {
            clip.condition = clip.abilityId === 'skill' ? 'e-ready()' : 'q-ready()';
          }
        });
      }
      project.strategyFormat = format;
      return project;
    }

    function parseRounds(value) {
      const text = String(value || '').trim();
      if (!text) return [];
      const result = new Set();
      for (const part of text.split(',')) {
        const match = part.trim().match(/^([1-9]\d*)(?:\s*-\s*([1-9]\d*))?$/);
        if (!match) throw new Error('轮次格式应为 1 或 1,3-5');
        const start = Number(match[1]), end = Number(match[2] || match[1]);
        if (end < start || end > 10000 || result.size + end - start + 1 > 10000) {
          throw new Error('轮次范围需递增，最大为 10000');
        }
        for (let round = start; round <= end; round++) result.add(round);
      }
      return [...result].sort((a, b) => a - b);
    }

    function validateCommands(text) {
      const commands = M.parseCommands(text);
      if (!commands.length) throw new Error('动作指令不能为空');
      for (const command of commands) {
        if (!methods.has(command.method)) throw new Error(`BetterGI 不支持指令 ${command.method}`);
        const args = command.args;
        const length = ['walk', '行走'].includes(command.method) ? args[1] : args[0];
        if (['attack', '普攻', '普通攻击', 'charge', '重击', 'dash', '冲刺',
          'wait', 'after', '等待', 'walk', '行走', 'w', 'a', 's', 'd'].includes(command.method)
          && args.length && (!Number.isFinite(Number(length)) || Number(length) < 0)) {
          throw new Error(`指令 ${command.method} 的时长无效`);
        }
        if (['walk', '行走'].includes(command.method)
          && (args.length !== 2 || !['w', 'a', 's', 'd'].includes(args[0]) || !(Number(args[1]) > 0))) {
          throw new Error('walk 需要方向 w/a/s/d 和正数秒数');
        }
        if (['keydown', 'keyup', 'keypress'].includes(command.method)) {
          if (args.length !== 1 || M.operations.keys(args[0]).length !== 1) throw new Error('单条按键指令需要一个按键');
        }
        if (['moveby', 'scroll', 'verticalscroll'].includes(command.method)
          && (args.length !== (command.method === 'moveby' ? 2 : 1)
            || args.some(value => !/^-?\d+$/.test(value)))) throw new Error('转向与滚轮需要整数参数');
        if (['wait', 'after', '等待', 'w', 'a', 's', 'd'].includes(command.method) && args.length !== 1) {
          throw new Error(`指令 ${command.method} 需要秒数参数`);
        }
      }
      return commands;
    }

    function textCommand(clip) {
      let command = M.commandsFor(clip);
      if (clip.abilityId === 'skill' && clip.commandOverride === null) {
        const arguments_ = [clip.hold && 'hold', clip.txtSkillPolicy !== 'direct' && clip.txtSkillPolicy].filter(Boolean);
        command = arguments_.length ? `skill(${arguments_.join(',')})` : 'skill';
        const lock = clip.castInputMs ?? (clip.followAttack ? M.attackStartMs(clip) : M.castLockMs(clip));
        if (clip.protectCast !== false && lock > 0) command += `,wait(${M.seconds(lock)})`;
        if (clip.followAttack && clip.attackAfterMs > 0) command += `,attack(${M.seconds(clip.attackAfterMs)})`;
      }
      if (clip.txtReady) command += ',ready';
      return command;
    }

    function exportTextStrategy(project, catalog, {check = true} = {}) {
      const issues = M.validate(project, catalog).filter(issue => issue.severity !== 'warning');
      if (check && issues.length) throw new Error(issues[0].message);
      const cleanComment = value => String(value || '').replace(/[\r\n]/g, ' ');
      const lines = [`// ${cleanComment(project.name)}`];
      if (project.author) lines.push(`// 作者：${cleanComment(project.author)}`);
      lines.push('// TXT 命令按顺序执行；循环与结束检测由 BetterGI 任务入口控制。', '');
      const rows = M.ordered(project);
      for (let index = 0; index < rows.length; index++) {
        const clip = rows[index], avatar = M.character(catalog, clip.characterId);
        let command = textCommand(clip);
        validateCommands(command);
        const rounds = parseRounds(clip.txtRounds);
        if (rounds.length) command = `round(${String(clip.txtRounds).trim()}),${command}`;
        if (project.txtWaitGaps) {
          const previous = rows[index - 1];
          const gap = clip.startMs - (previous ? M.actionEndOf(previous) : 0);
          if (gap > 0) {
            const prefix = rounds.length ? `round(${String(clip.txtRounds).trim()}),` : '';
            const waiting = previous ? M.character(catalog, previous.characterId) : avatar;
            lines.push(`${waiting.name} ${prefix}wait(${M.seconds(gap)})`);
          }
        }
        lines.push(`${avatar.name} ${command}`);
      }
      return lines.join('\n') + '\n';
    }

    function commandChunks(commands) {
      const chunks = [], pressed = new Set();
      let pending = [];
      for (const command of commands) {
        pending.push(command);
        if (['keydown', 'mousedown'].includes(command.method)) {
          pressed.add(`${command.method === 'keydown' ? 'key' : 'mouse'}:${command.args[0]?.toUpperCase() || 'LEFT'}`);
        } else if (['keyup', 'mouseup'].includes(command.method)) {
          pressed.delete(`${command.method === 'keyup' ? 'key' : 'mouse'}:${command.args[0]?.toUpperCase() || 'LEFT'}`);
        }
        if (!pressed.size) { chunks.push(pending); pending = []; }
      }
      if (pending.length) chunks.push(pending);
      return chunks;
    }

    function importTextStrategy(text, catalog, {name = '导入的 TXT 战斗策略'} = {}) {
      const actions = [], settings = [];
      let title = '', author = '';
      for (const [lineNumber, raw] of String(text).replace(/^\uFEFF/, '').split(/\r?\n|\r/).entries()) {
        const line = raw.trim().replace(/（/g, '(').replace(/）/g, ')').replace(/，/g, ',');
        if (!line) continue;
        if (/^(\/\/|#)/.test(line)) {
          const comment = line.replace(/^(\/\/|#)\s*/, '');
          if (!title) title = comment;
          if (/^作者[：:]/.test(comment)) author = comment.replace(/^作者[：:]\s*/, '');
          continue;
        }
        for (const statement of line.split(';').filter(value => value.trim())) {
          try {
            const match = statement.trim().match(/^(\S+)\s+([\s\S]+)$/);
            if (!match) throw new Error('每行需以角色名和空格开头');
            const avatar = catalog.characters.find(item => item.name === match[1] || item.aliases.includes(match[1]));
            if (!avatar) throw new Error(`无法识别角色“${match[1]}”`);
            for (const part of match[2].split('|').filter(value => value.trim())) {
              const commands = M.parseCommands(part);
              let rounds = '';
              if (commands[0]?.method === 'round') {
                rounds = commands.shift().args.join(',');
                parseRounds(rounds);
              }
              if (!commands.length) continue;
              validateCommands(commands.map(command => command.raw).join(','));
              for (const chunk of commandChunks(commands)) {
                const command = chunk.map(item => item.raw).join(',');
                actions.push({Name: `Step${actions.length + 1}`, Character: avatar.name,
                  Action: command, Index: actions.length, Condition: {Expression: ''}});
                settings.push({rounds, commands: chunk});
              }
            }
          } catch (error) { throw new Error(`第 ${lineNumber + 1} 行：${error.message}`); }
        }
      }
      if (!actions.length) throw new Error('TXT 中没有有效战斗动作');
      const project = M.importStrategy({Info: {Name: title || name, Author: author}, Actions: actions},
        catalog, {strategyFormat: 'txt'});
      M.ordered(project).forEach((clip, index) => {
        clip.txtRounds = settings[index].rounds;
        clip.txtSkillPolicy = settings[index].commands.some(command =>
          ['skill', 'e'].includes(command.method) && command.args.includes('wait')) ? 'wait'
          : settings[index].commands.some(command =>
            ['skill', 'e'].includes(command.method) && command.args.includes('fast')) ? 'fast' : 'direct';
        clip.sourceAction = null;
        clip.ensureCast = false;
        clip.readiness = 'none';
        clip.protectCast = false;
      });
      project.repeat = true;
      project.sourceInfo = {};
      project.sourceRoot = {};
      M.fitLoop(project);
      return project;
    }

    function importDocument(value, catalog, options = {}) {
      if (typeof value !== 'string') return M.importStrategy(value, catalog);
      const text = value.replace(/^\uFEFF/, '').trim();
      if (/^[{[]/.test(text)) return M.importStrategy(JSON.parse(text), catalog);
      return importTextStrategy(value, catalog, options);
    }

    function exportDocument(project, catalog) {
      if (M.isText(project)) {
        const text = exportTextStrategy(project, catalog);
        return {format: 'txt', extension: '.txt', mime: 'text/plain;charset=utf-8', text, strategy: text};
      }
      const strategy = M.exportStrategy(project, catalog);
      return {format: 'json', extension: '.json', mime: 'application/json;charset=utf-8',
        text: JSON.stringify(strategy, null, 2), strategy};
    }

    return {setStrategyFormat, parseRounds, validateCommands, textCommand,
      exportTextStrategy, importTextStrategy, importDocument, exportDocument};
  }

  if (typeof module === 'object' && module.exports) module.exports = createFormats;
  else root.CombatFormatFactory = createFormats;
})(globalThis);
