(function(root) {
  'use strict';

  function create({model: M, catalog, getProject, change, icons, toast, getSelected}) {
    const R = root.CombatConditions;
    const $ = id => document.getElementById(id);
    const html = value => String(value ?? '').replace(/[&<>"']/g, char =>
      ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
    const icon = name => `<i data-lucide="${name}"></i>`;
    const dialog = $('rulesDialog');
    let current = null, dragging = null, ghost = null, highlighted = null, suppressClick = false;
    const actionNames = () => getProject().clips.map(clip => clip.name);
    const context = () => {
      const clip = getProject().clips.find(row => row.id === current?.clipId);
      return {character: clip ? M.character(catalog, clip.characterId).name : '',
        otherAction: getProject().clips.find(row => row.id !== clip?.id)?.name || ''};
    };
    const locate = id => {
      for (const entry of current?.entries || []) {
        const found = R.find(entry.tree, id);
        if (found) return {...found, entry};
      }
      return null;
    };
    function dirty(entry) { entry.dirty = true; current.changed = true; }
    function closeDrag() {
      ghost?.remove(); ghost = null;
      highlighted?.classList.remove('rule-drop-active'); highlighted = null;
      dialog.classList.remove('condition-dragging');
      dragging = null;
    }
    function open(clipId = null, view = 'edit') {
      const project = getProject(), clip = project.clips.find(row => row.id === clipId);
      current = {clipId: clip?.id || null, view: clip || view === 'queue' ? view : 'guide', category: '技能与角色',
        guide: 'start', changed: false, error: '', entries: clip
          ? R.draft(clip, M.priorityOf(clip), M.prioritiesOf(clip), actionNames()) : [], active: null};
      current.active = current.entries[0]?.tree.id || null;
      paint();
      if (!dialog.open) dialog.showModal();
    }
    const select = (label, value, choices, attributes = '') =>
      `<label class="condition-param"><span>${label}</span><select ${attributes}>${choices.map(([key, text]) =>
        `<option value="${html(key)}" ${String(key) === String(value) ? 'selected' : ''}>${html(text)}</option>`).join('')}</select></label>`;
    function targetChoices(value, character = false, required = false) {
      const choices = required ? [] : [['', character ? '动作所属角色' : '本动作']];
      const list = character ? catalog.characters.map(row => [row.name, row.name])
        : [...new Set(actionNames())].map(name => [name, name]);
      choices.push(...list);
      const encoded = typeof value === 'number' ? `@index:${value}` : value;
      if (!choices.some(([key]) => key === encoded) && encoded !== undefined)
        choices.push([encoded, typeof value === 'number' ? `序号 ${value}` : value || '请选择动作']);
      return {choices, value: encoded};
    }
    function fields(node) {
      if (node.type === 'raw') return `<label class="condition-param condition-source"><span>原生表达式</span>
        <textarea data-rule-input="expression" data-node="${node.id}" spellcheck="false"
          aria-label="自定义条件表达式">${html(node.expression)}</textarea></label>
        ${node.warning ? `<p class="rule-note">${html(node.warning)}。原文保持，修改时会重新检查。</p>` : ''}`;
      const {kind, params: p} = node, parts = [];
      const binding = field => `data-rule-input="${field}" data-node="${node.id}" aria-label="${html(
        {target: '条件目标', operator: '比较关系', value: '条件阈值', greater: '间隔关系'}[field] || field)}"`;
      if (['e-ready', 'q-ready', 'e-cd', 'in-party', 'since', 'count', 'after', 'last-exec'].includes(kind)) {
        const character = ['e-ready', 'q-ready', 'e-cd', 'in-party'].includes(kind);
        const choices = targetChoices(p.target, character, ['in-party', 'after'].includes(kind));
        parts.push(select(character ? '角色' : '动作', choices.value, choices.choices, binding('target')));
      }
      if (Object.hasOwn(p, 'operator') && !['last-exec', 'battle-time'].includes(kind)) {
        parts.push(select('比较', p.operator,
          [['>=', '至少 ≥'], ['>', '大于 >'], ['<=', '不超过 ≤'], ['<', '小于 <'], ['=', '等于 ='], ['!=', '不等于 ≠']], binding('operator')));
      }
      if (Object.hasOwn(p, 'greater')) parts.push(select('比较', p.greater ? 'true' : 'false',
        [['true', '严格大于 >'], ['false', '严格小于 <']], binding('greater')));
      if (Object.hasOwn(p, 'value')) parts.push(`<label class="condition-param condition-number">
        <span>${kind === 'count' ? '次数' : '秒数'}</span><input type="number" step="${kind === 'count' ? '1' : '0.1'}"
          value="${html(p.value)}" ${binding('value')}></label>`);
      if (kind === 'low-hp') parts.push('<p class="rule-note">检查当前前台的低血量标记。</p>');
      if (kind === 'after') parts.push('<p class="rule-note">前置动作的执行记录多于本动作时成立。</p>');
      if (kind === 'since') parts.push('<p class="rule-note">从未执行过时为正无穷，因此“至少”条件在开场也成立。</p>');
      return parts.join('');
    }
    function nodeHtml(node, rootNode = false) {
      if (node.type === 'group') return `<div class="condition-group ${current.active === node.id ? 'active-group' : ''}"
        data-rule-group="${node.id}">
        <div class="condition-group-heading">
          ${!rootNode ? `<button class="icon-button condition-grip" data-rule-drag="${node.id}" type="button"
            title="拖动分组" aria-label="拖动分组">${icon('grip-vertical')}</button>` : ''}
          <div class="segmented condition-relation" role="group" aria-label="分组关系">
            ${[['all', '全部满足'], ['any', '任一满足']].map(([mode, label]) =>
              `<button type="button" data-rule-mode="${mode}" data-node="${node.id}" class="${node.mode === mode ? 'selected' : ''}"
                aria-pressed="${node.mode === mode}">${label}</button>`).join('')}
          </div><span class="condition-group-count">${node.children.length} 项</span>
          <button class="icon-button ${node.negated ? 'selected' : ''}" type="button" data-rule-negate="${node.id}"
            title="对整个分组取反" aria-label="对整个分组取反" aria-pressed="${node.negated}">${icon('circle-slash-2')}</button>
          ${!rootNode ? `<button class="icon-button" type="button" data-rule-remove="${node.id}"
            title="删除分组" aria-label="删除分组">${icon('x')}</button>` : ''}
        </div><div class="condition-group-body" data-rule-drop="${node.id}">
          ${node.children.map((child, index) => `<div class="condition-insert" data-rule-drop="${node.id}" data-drop-index="${index}"></div>
            ${nodeHtml(child)}`).join('')}
          <button type="button" class="condition-drop-zone" data-rule-drop="${node.id}" data-activate-group="${node.id}">
            ${icon('plus')}<span>${node.children.length ? '添加条件' : node.mode === 'all' ? '拖入条件 · 空组无条件成立' : '拖入条件 · 空组不成立'}</span></button>
        </div>
      </div>`;
      const definition = R.kinds.find(item => item.name === node.kind);
      return `<div class="condition-test ${node.negated ? 'negated-test' : ''}" data-condition-node="${node.id}">
        <div class="condition-test-heading">
          <button type="button" class="icon-button condition-grip" data-rule-drag="${node.id}"
            title="拖动条件" aria-label="拖动${html(definition?.title || '自定义条件')}">${icon('grip-vertical')}</button>
          ${icon(definition?.icon || 'code-xml')}<strong>${node.negated ? '非 · ' : ''}${html(definition?.title || '自定义条件')}</strong>
          <button type="button" class="icon-button ${node.negated ? 'selected' : ''}" data-rule-negate="${node.id}"
            title="条件取反" aria-label="条件取反" aria-pressed="${node.negated}">${icon('circle-slash-2')}</button>
          <button type="button" class="icon-button" data-rule-remove="${node.id}" title="删除条件" aria-label="删除条件">${icon('x')}</button>
        </div><div class="condition-parameters">${fields(node)}</div>
      </div>`;
    }
    function paintLibrary() {
      const categories = [...new Set(R.kinds.map(item => item.category))];
      $('conditionCategories').innerHTML = categories.map(category => `<button type="button"
        data-rule-category="${category}" class="${current.category === category ? 'selected' : ''}"
        aria-pressed="${current.category === category}">${category}</button>`).join('');
      $('conditionMaterials').innerHTML = R.kinds.filter(item => item.category === current.category).map(item =>
        `<button type="button" class="condition-material" data-condition-kind="${item.name}"
          title="${html(item.detail || item.title)}"><span class="condition-material-icon">${icon(item.icon)}</span>
          <span><strong>${html(item.title)}</strong><small>${html(item.name === 'after' ? 'count(前置) > count()'
            : ['all', 'any', 'raw', 'always', 'never'].includes(item.name)
              ? {all: '并且', any: '或者', raw: '保留原生语法', always: 'true', never: 'false'}[item.name] : item.signature)}</small></span>
          ${icon('grip-vertical')}</button>`).join('');
    }
    function paintEditor() {
      const project = getProject(), native = project.scheduling === 'original';
      $('ruleLanes').innerHTML = current.entries.map((entry, index) => `<section class="trigger-lane" data-rule-entry="${entry.id}">
        <header class="trigger-lane-heading"><div><h3>${index ? `额外触发 ${index}` : '主触发'}</h3>
          <span>${index ? '独立条件 · 执行同一动作' : '满足时参与优先级竞争'}</span></div>
          <label class="trigger-priority"><span>${native || index ? '优先级' : '编译器分配'}</span>
            ${native || index ? `<input type="number" step="1" min="-2147483648" max="2147483647" value="${html(entry.priority)}"
              data-rule-priority="${entry.id}" aria-label="${index ? `额外触发 ${index} 优先级` : '主触发优先级'}">`
              : '<output data-rule-auto-priority>自动 · 见队列</output>'}</label>
          ${index ? `<button type="button" class="icon-button" data-trigger-remove="${entry.id}"
            title="删除额外触发" aria-label="删除额外触发 ${index}">${icon('trash-2')}</button>` : ''}
        </header>${nodeHtml(entry.tree, true)}
        <details class="trigger-result"><summary>条件表达式</summary><code>${html(safeExpression(entry)) || '(空条件)'}</code></details>
      </section>`).join('') + `<button type="button" id="addRuleTrigger" class="add-trigger">${icon('plus')}<span>添加额外触发</span></button>`;
      $('ruleModeNote').textContent = native
        ? '数值越小越优先。额外触发独立竞争，不会自动叠加主触发条件。'
        : '当前是步骤或计划模式，导出时还会加入步骤依赖；完整结果见优先级队列。';
      $('ruleEditorError').textContent = current.error;
      $('ruleDraftStatus').textContent = current.changed ? '有未应用的条件修改' : '条件保留原始表达式';
    }
    function safeExpression(entry) {
      try { return R.expressionOf(entry); }
      catch (error) { return error.message; }
    }
    function previewStrategy() {
      const project = M.clone(getProject());
      if (current.clipId) {
        const clip = project.clips.find(row => row.id === current.clipId);
        Object.assign(clip, R.patch(current.entries, actionNames(), project.scheduling === 'original'));
      }
      if (M.hasTeams(project)) {
        return {Actions: M.teamPreview(project, catalog, project.activeTeamId)};
      }
      return M.exportStrategy(project, catalog);
    }
    function paintQueue() {
      try {
        const project = getProject(), strategy = previewStrategy();
        const plan = M.hasTeams(project) ? M.activeTeam(project) : null;
        const party = plan?.roster.map(id => M.character(catalog, id).name) || null;
        const queue = R.expand(strategy, party);
        const labels = plan && M.teamActionLabels ? M.teamActionLabels(project, catalog, plan.id) : null;
        const labelOf = name => labels instanceof Map ? labels.get(name) || name : labels?.[name] || name;
        const known = queue.map(row => row.name);
        const description = expression => {
          if (!labels) return R.describe(R.decode(expression, known));
          try {
            const rename = node => {
              if (node.type === 'identifier') return {...node, name: labelOf(node.name)};
              if (node.type === 'unary') return {...node, value: rename(node.value)};
              if (node.type === 'binary') return {...node, left: rename(node.left), right: rename(node.right)};
              if (node.type === 'call') return {...node, args: node.args.map(rename)};
              return node;
            };
            return R.describe(R.decode(R.stringify(rename(R.parse(expression, known))),
              known.map(labelOf)));
          } catch { return R.describe(R.decode(expression, known)); }
        };
        $('priorityQueue').innerHTML = queue.map((row, index) => {
          const character = catalog.characters.find(character => character.name === row.character);
          return `<li class="priority-queue-row" style="--queue-color:${character?.color || '#788798'}">
            <span class="queue-rank">${index + 1}</span><strong class="queue-priority">${row.priority}</strong>
            <div class="queue-rule"><div><strong>${html(labelOf(row.name) || '未命名动作')}</strong><span>${html(row.kind)}</span></div>
              <p>${html(description(row.expression))}</p>
              <details><summary>原生表达式与指令</summary><code>${html(row.expression) || '(空条件，始终成立)'}</code>
                <code>${html(row.command)}</code>${plan ? `<code>Name: ${html(row.name)}</code>` : ''}</details></div>
            <span class="queue-owner">${html(row.character || '沿用当前角色')}<small>Index ${row.index} · 声明 ${row.declaration + 1}</small></span>
          </li>`;
        }).join('') || '<li class="rule-note">尚无动作。</li>';
        $('queueStats').textContent = `${plan ? `${plan.name} · ` : ''}${strategy.Actions.length} 个动作 → ${queue.length} 个排序条目`;
        const fixed = node => {
          if (node.type === 'bool') return node.value;
          if (node.type === 'number') return node.value > 0;
          if (node.type === 'call' && node.name === 'in-party' && party && node.args[0]?.type === 'identifier')
            return party.some(name => name.toLowerCase() === node.args[0].name.toLowerCase());
          if (node.type === 'unary' && node.operator === '!') {
            const value = fixed(node.value);
            return value === null ? null : !value;
          }
          if (node.type === 'binary' && ['&&', '||'].includes(node.operator)) {
            const left = fixed(node.left), right = fixed(node.right);
            return node.operator === '&&' ? left === false || right === false ? false
              : left === true && right === true ? true : null
              : left === true || right === true ? true : left === false && right === false ? false : null;
          }
          return null;
        };
        const unconditional = queue.findIndex(row => {
          try { return fixed(R.parse(row.expression, known)) === true; }
          catch { return false; }
        });
        $('queueWarning').textContent = [
          plan && !plan.enabled ? '当前队伍已停用；此处为本队草稿预览，不参与联合导出。' : '',
          plan && plan.roster.length !== 4 ? '阵容尚未配置完整，当前规则不能参与联合导出。' : '',
          unconditional >= 0 && unconditional < queue.length - 1
            ? `第 ${unconditional + 1} 项没有触发限制；它一旦可执行，后面的条目可能一直轮不到。` : ''
        ].filter(Boolean).join(' ');
      } catch (error) {
        $('priorityQueue').innerHTML = `<li class="form-error">${html(error.message)}</li>`;
        $('queueStats').textContent = '条件修改后可重新检查队列';
        $('queueWarning').textContent = '';
      }
    }
    function guideContent(section) {
      if (section === 'teams') return `<h3>一份 JSON 适配多支队伍</h3>
        <p>在队伍管理中为每支队伍选择完整四人阵容，分别编辑动作、条件与优先级。没有安排动作的成员也属于阵容。启用的队伍一起导出，切换当前队伍只改变编辑对象。</p>
        <h4>同角色，不同打法</h4><p>雷国与万达都可以包含班尼特和香菱，但站场角色、充能与动作依赖不同。关联面板按队伍展示同一角色的规则，不会自动同步或替换。雷神在雷国站场开大，在某些超绽队只放 E；这些差异需要分别配置。</p>
        <h4>实际四人队决定启用哪套规则</h4><p>联合导出给每队的主触发及全部额外触发添加阵容条件，保留原有优先级。历史名称按队伍隔离，队内跨角色的次数、间隔和时间窗口仍然保留。</p>
        <h4>同阵容的两个方案需要选择</h4><p>执行器无法仅凭四人名单知道谁带了哪套装备。两个启用方案可能匹配同一实际队伍时，联合导出会提示冲突；停用其中一套后再导出。不会替玩家猜选哪种打法。</p>
        <h4>开场动作和公共配置只有一份</h4><p>原生 Info.PreActions 不支持队伍条件。导入的各队开场动作或公共配置不同，需要在队伍管理中明确沿用其中一队的设置，或分别导出。队伍专属开场可以由作者改写为带 count 与条件的普通动作，再自行验证。</p>
        <h4>TXT 导出当前队伍</h4><p>TXT 按命令顺序执行，不能承载 JSON 的条件与优先级。工程保留其他队伍，TXT 每次只导出当前队伍。</p>
        <p>配队差异参考 KQM 香菱 4.5、公子 4.0、雷神 5.7 指南；用于说明实际依赖，不代表当前强度排名。完整出处与作者 JSON 实例见开源仓库 docs/multi-team-workflows.md。</p>`;
      if (section === 'functions') return `<h3>原生支持的全部 14 个函数</h3>
        <p>方括号表示可省略的参数，不是实际语法。时间函数统一按秒使用；名字不加引号。</p>
        <div class="function-reference">${R.functions.map(item => `<article><h4>${html(item.title)}</h4>
          <code>${html(item.signature)}</code><p>${html(item.detail)}</p><code class="reference-example">${html(item.example)}</code></article>`).join('')}</div>`;
      if (section === 'priority') return `<h3>优先级的完整顺序</h3>
        <ol><li>先保留 Character 为空或存在于实际队伍中的动作。</li>
          <li>每个动作展开成一个主触发和全部 MorePriorities 额外触发。</li>
          <li>主触发的优先级是 Index，额外触发使用自己的 Priority。数值越小越优先，支持负整数。</li>
          <li>同优先级使用稳定排序：先按 Actions 声明顺序；同动作先主触发，再按额外触发的声明顺序。</li>
          <li>每轮复用一次截图，从队首依次检查；遇到第一个条件成立的条目，先切到指定角色，再执行整个 Action。</li>
          <li>命令执行及有限重试结束后记录一次历史，然后重新从队首检查。没有条目可执行时等待 200ms 再检查。</li></ol>
        <h4>优先级不会在动作中途抢占</h4><p>低血量治疗即使优先级更高，也要等当前 Action 返回后才能重新判断。一个 Action 包含长普攻、等待或多个命令，就会推迟下一次判断。需要及时响应时，应拆成多个较短动作。</p>
        <h4>额外触发不是主条件的子条件</h4><p>主触发为 q-ready()、Index 为 20；额外触发为 low-hp()、Priority 为 -10 时，低血量就会执行该动作，并不会自动要求 Q 就绪。需要两者同时满足，应在额外触发里写 low-hp() &amp;&amp; q-ready()。</p>
        <h4>Index 也参与历史引用</h4><p>按序号查询会合并所有相同 Index 的动作记录，按名字查询会合并同名记录。省略目标时同时匹配本动作的 Index 和 Name。修改 Index 后，原有数字历史引用也需要核对；额外触发被选中时，历史仍记录动作自己的 Index，不记录 Priority。</p>
        <h4>参考轴与声明顺序</h4><p>条件模式拖动只改变可视参考位置，不改原生优先级或同优先级的声明顺序。查看队列可看到实际导出顺序。步骤模式和计划模式由编译器加入依赖条件，额外触发同样受这些依赖约束。</p>`;
      if (section === 'examples') return `<h3>从“什么时候做”开始配置</h3>
        <div class="rule-example"><h4>低血量优先治疗</h4><p>班尼特开大：主优先级 -10，全部满足“前台角色低血量”和“Q 爆发就绪”。低血量检查的是切人前的前台角色。</p>
          <code>low-hp() &amp;&amp; q-ready()</code></div>
        <div class="rule-example"><h4>普通技能不能无限抢占</h4><p>战技：主优先级 10，全部满足“E 战技就绪”和“距动作上次执行至少 15 秒”。since 首次为无穷，因此开场允许执行；15 秒仅为示例，需要按实际角色配置。</p>
          <code>e-ready() &amp;&amp; !(since() &lt; 15)</code></div>
        <div class="rule-example"><h4>执行一次前置，再执行一次后续</h4><p>前置动作名为“行秋开大”。后续普攻条件为“前置动作已执行”。两者的执行次数交替增长，避免后续一直重复。执行记录不证明前置技能成功命中。</p>
          <code>count(行秋开大) &gt; count()</code></div>
        <div class="rule-example"><h4>仅开场一次</h4><p>技能就绪并且本动作执行次数等于 0。若命令失败但已返回，通常也已写入记录，不会自动无限重试。</p>
          <code>q-ready() &amp;&amp; count() = 0</code></div>
        <div class="rule-example"><h4>最近 5 秒的执行次数</h4><p>count 区间是战斗的绝对时间，而不是“最近几秒”的长度。以下表示当前时刻前 5 秒至现在，指定动作至少有一次执行记录。</p>
          <code>count(行秋开大, max(0, t() - 5), t()) &gt; 0</code></div>
        <h4>操作符优先顺序</h4><p>从高到低：括号/函数 → ! 与负号 → * / → + - → &gt; &lt; = → &amp;&amp; → ||。且、或会短路。等号写单个 =；大于等于写 !(a &lt; b)，不等于写 !(a = b)。</p>
        <p>空表达式与 true 都成立，false 不成立。数值大于 0 视为成立，0 和负数不成立；等号浮点误差阈值为 0.0001，除零结果为 0。复杂计算建议用括号明确顺序。</p>`;
      if (section === 'limits') return `<h3>判断到的状态与真实释放</h3>
        <h4>动作执行记录 ≠ 释放成功记录</h4><p>since、count、last-exec 都基于 Action 返回后写入的事件。普通执行异常可能被记录日志后继续，重试耗尽也会继续。不能将 count 增加当成命中、伤害或动画完成。</p>
        <h4>EnsureCast 只做 E 冷却检测和有限重试</h4><p>当前核对的执行器先执行一次 Action；未检测到 E 冷却时，最多额外执行整个 Action 5 次。重试中还会释放按键、普攻/下落处理并等待 200ms。动作里的普攻、移动和等待也会被重做，不只是 E。源码旧注释的“3 次”与当前 retry = 5 不一致。</p>
        <h4>ready 也不是通用成功确认</h4><p>ready 等待操作界面恢复，E/Q 的识别来自各自检测逻辑。编辑器未增加任何执行器回执、无限重试或“成功后才下一步”的新能力。</p>
        <h4>实时条件的边界</h4><p>有低血量标记、Q 就绪、E 剩余冷却、队伍、前台与历史记录。没有精确血量百分比、当前能量数字、元素附着、伤害命中等原生条件。离线队列展示排序与表达式，不伪造游戏实时状态。</p>
        <h4>时间的起点与释放时长</h4><p>t 从求值器创建计时，包含 PreActions。开场动作不写入主动作的 count 历史。各角色的释放锁定需要实测；时间轴的参考时长不能作为真实完成时间。</p>
        <p>本指南按 2026-10-18 所校对的 BetterGI 执行器源码整理。不同版本的函数和重试实现可能变化，请与实际使用版本对应。</p>`;
      return `<h3>先选对策略模式</h3>
        <table><thead><tr><th></th><th>TXT 顺序命令</th><th>JSON 条件策略</th></tr></thead><tbody>
          <tr><th>下一步</th><td>按文本命令顺序</td><td>每次动作后重新挑选</td></tr>
          <tr><th>响应状态</th><td>指令自身支持的等待</td><td>就绪、低血量、历史等条件</td></tr>
          <tr><th>优先级</th><td>无 JSON 优先级</td><td>数字越小越先检查</td></tr>
          <tr><th>时间轴</th><td>命令顺序参考</td><td>条件模式为时长参考</td></tr></tbody></table>
        <h4>一个动作包含什么</h4><dl class="rule-field-reference">
          <div><dt>Name</dt><dd>动作名称，供日志和历史引用。</dd></div>
          <div><dt>Character</dt><dd>执行前切到的角色；留空沿用当前角色，缺席角色的动作会过滤。</dd></div>
          <div><dt>Action</dt><dd>按先后执行的技能、普攻、等待、移动及键鼠命令。</dd></div>
          <div><dt>Index</dt><dd>主触发的优先级，也是按序号查询历史的标识。</dd></div>
          <div><dt>Condition</dt><dd>主触发条件。空条件表示无条件。</dd></div>
          <div><dt>MorePriorities</dt><dd>同一动作的其他独立触发条件，各自带 Priority。</dd></div>
          <div><dt>EnsureCast</dt><dd>E 冷却检查与有限重试开关。</dd></div></dl>
        <h4>每次选择的流程</h4><div class="decision-flow"><span>识别本轮状态</span>${icon('arrow-right')}<span>从小到大检查</span>
          ${icon('arrow-right')}<span>执行第一个成立的动作</span>${icon('arrow-right')}<span>记录后重新选择</span></div>
        <p>例：治疗优先级 -10、战技优先级 10、普攻优先级 100。前台低血量且治疗 Q 就绪时选治疗；否则看战技；再否则看普攻。高优先级条件一直成立时，低优先级可能永远轮不到。</p>
        <h4>配置条件的三个问题</h4><ol><li>由谁执行？指定角色与“当前前台角色”并不是同一个概念。</li>
          <li>何时允许？先拖就绪条件，再按需要叠加时间、次数或前置动作。</li><li>和其他动作谁先？查看全局队列，核对额外触发与同优先级顺序。</li></ol>`;
    }
    function paintGuide() {
      const tabs = [['start', '入门'], ['priority', '优先级'], ['functions', '函数'], ['examples', '示例'],
        ['teams', '多队伍'], ['limits', '执行边界']];
      $('ruleGuideTabs').innerHTML = tabs.map(([key, label]) => `<button type="button" data-guide-section="${key}"
        class="${current.guide === key ? 'selected' : ''}" aria-pressed="${current.guide === key}">${label}</button>`).join('');
      $('ruleGuideContent').innerHTML = guideContent(current.guide);
    }
    function paint() {
      const scroll = $('ruleLanes').scrollTop, queueScroll = $('ruleQueueView').scrollTop;
      const active = document.activeElement, binding = active?.dataset.ruleInput, nodeId = active?.dataset.node;
      const priority = active?.dataset.rulePriority;
      const position = active?.selectionStart;
      const clip = getProject().clips.find(row => row.id === current.clipId);
      $('rulesTitle').textContent = clip ? `${clip.useCurrentCharacter ? '当前前台角色' : M.character(catalog, clip.characterId).name} · ${clip.name || '未命名动作'}`
        : current.view === 'queue' ? 'JSON 优先级队列' : 'JSON 执行指南';
      for (const tab of dialog.querySelectorAll('[data-rules-view]')) {
        tab.classList.toggle('selected', tab.dataset.rulesView === current.view);
        tab.setAttribute('aria-selected', String(tab.dataset.rulesView === current.view));
        tab.disabled = !clip && tab.dataset.rulesView === 'edit';
      }
      $('ruleEditView').hidden = current.view !== 'edit';
      $('ruleQueueView').hidden = current.view !== 'queue';
      $('ruleGuideView').hidden = current.view !== 'guide';
      $('applyRules').hidden = !clip;
      $('ruleDraftStatus').hidden = !clip;
      $('cancelRules').textContent = current.changed ? '取消' : '关闭';
      if (clip) { paintLibrary(); paintEditor(); }
      if (current.view === 'queue') paintQueue();
      if (current.view === 'guide') paintGuide();
      icons();
      $('ruleLanes').scrollTop = scroll;
      $('ruleQueueView').scrollTop = queueScroll;
      const replacement = binding ? dialog.querySelector(`[data-rule-input="${binding}"][data-node="${nodeId}"]`)
        : priority ? dialog.querySelector(`[data-rule-priority="${priority}"]`) : null;
      if (replacement && !dragging) {
        replacement.focus({preventScroll: true});
        if (position !== null && ['textarea', 'text'].includes(replacement.type)) replacement.setSelectionRange(position, position);
      }
    }
    function add(kind, groupId = current.active, index = null) {
      const location = locate(groupId);
      if (location?.node.type !== 'group') return;
      const node = R.make(kind, context());
      location.node.children.splice(index === null ? location.node.children.length : index, 0, node);
      dirty(location.entry);
      current.active = node.type === 'group' ? node.id : groupId;
      current.error = '';
      paint();
    }
    dialog.addEventListener('click', event => {
      if (suppressClick) { suppressClick = false; event.preventDefault(); event.stopPropagation(); return; }
      const button = event.target.closest('button');
      if (!button || !current) return;
      if (button.dataset.rulesView) { current.view = button.dataset.rulesView; paint(); }
      else if (button.dataset.ruleCategory) { current.category = button.dataset.ruleCategory; paintLibrary(); icons(); }
      else if (button.dataset.guideSection) {
        current.guide = button.dataset.guideSection; paintGuide(); icons(); $('ruleGuideContent').scrollTop = 0;
      } else if (button.dataset.conditionKind) add(button.dataset.conditionKind);
      else if (button.dataset.activateGroup) {
        current.active = button.dataset.activateGroup;
        paint();
        if (matchMedia('(max-width: 710px)').matches) $('conditionLibrary').scrollIntoView({block: 'nearest'});
      } else if (button.dataset.ruleMode) {
        const found = locate(button.dataset.node);
        if (found) { found.node.mode = button.dataset.ruleMode; current.active = found.node.id; dirty(found.entry); paint(); }
      } else if (button.dataset.ruleNegate) {
        const found = locate(button.dataset.ruleNegate);
        if (found) { found.node.negated = !found.node.negated; dirty(found.entry); paint(); }
      } else if (button.dataset.ruleRemove) {
        const found = locate(button.dataset.ruleRemove);
        if (found?.parent) {
          found.parent.children = found.parent.children.filter(node => node !== found.node);
          current.active = found.parent.id; dirty(found.entry); paint();
        }
      } else if (button.id === 'addRuleTrigger') {
        const tree = R.group();
        current.entries.push({id: `extra${tree.id}`, priority: current.entries[0].priority - 1,
          original: '', source: {}, tree, dirty: true});
        current.active = tree.id; current.changed = true; paint();
        $('ruleLanes').lastElementChild.scrollIntoView({block: 'nearest'});
      } else if (button.dataset.triggerRemove) {
        current.entries = current.entries.filter(entry => entry.id !== button.dataset.triggerRemove);
        current.active = current.entries[0].tree.id; current.changed = true; paint();
      } else if (button.id === 'applyRules') {
        try {
          const project = getProject();
          const patch = R.patch(current.entries, actionNames(), project.scheduling === 'original');
          const clip = project.clips.find(row => row.id === current.clipId);
          if (!clip) throw new Error('该动作已不存在');
          change(() => {
            if (clip.followSourceId && patch.condition !== clip.condition) clip.followSourceId = null;
            Object.assign(clip, patch);
          });
          dialog.close(); toast('触发条件已应用');
        } catch (error) { current.error = error.message; paintEditor(); icons(); }
      }
    });
    dialog.addEventListener('change', event => {
      const input = event.target;
      if (input.dataset.rulePriority) {
        const entry = current.entries.find(row => row.id === input.dataset.rulePriority);
        entry.priority = input.value === '' ? NaN : Number(input.value); current.changed = true; paint();
      } else if (input.dataset.ruleInput) {
        const found = locate(input.dataset.node), field = input.dataset.ruleInput;
        if (!found) return;
        if (field === 'expression') { found.node.expression = input.value; delete found.node.warning; }
        else found.node.params[field] = field === 'value' ? input.value === '' ? NaN : Number(input.value)
          : field === 'greater' ? input.value === 'true' : field === 'target' && input.value.startsWith('@index:')
            ? Number(input.value.slice(7)) : input.value;
        dirty(found.entry); current.error = ''; paint();
      }
    });
    dialog.addEventListener('pointerdown', event => {
      if (event.button !== 0 || !current || current.view !== 'edit') return;
      const material = event.target.closest('[data-condition-kind]'), handle = event.target.closest('[data-rule-drag]');
      if (!material && !handle) return;
      dragging = {kind: material?.dataset.conditionKind, nodeId: handle?.dataset.ruleDrag,
        x: event.clientX, y: event.clientY, pointerId: event.pointerId, moved: false};
    });
    window.addEventListener('pointermove', event => {
      if (!dragging || event.pointerId !== dragging.pointerId) return;
      if (!dragging.moved && Math.hypot(event.clientX - dragging.x, event.clientY - dragging.y) < 6) return;
      if (!dragging.moved) {
        dragging.moved = true;
        ghost = document.createElement('div');
        ghost.className = 'condition-drag-ghost';
        ghost.textContent = dragging.kind ? R.kinds.find(item => item.name === dragging.kind)?.title
          : R.describe(locate(dragging.nodeId).node);
        dialog.append(ghost); dialog.classList.add('condition-dragging');
      }
      event.preventDefault();
      ghost.style.left = `${event.clientX + 12}px`; ghost.style.top = `${event.clientY + 12}px`;
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-rule-drop]');
      if (target !== highlighted) {
        highlighted?.classList.remove('rule-drop-active');
        highlighted = target; highlighted?.classList.add('rule-drop-active');
      }
      if (target) {
        const lane = $('ruleLanes'), rect = lane.getBoundingClientRect();
        if (event.clientY > rect.bottom - 36) lane.scrollTop += 12;
        if (event.clientY < rect.top + 36) lane.scrollTop -= 12;
      }
    }, {passive: false});
    window.addEventListener('pointerup', event => {
      if (!dragging || event.pointerId !== dragging.pointerId) return;
      const drag = dragging, target = highlighted;
      closeDrag();
      if (!drag.moved) return;
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 0);
      if (!target) return;
      const groupId = target.dataset.ruleDrop;
      const index = target.dataset.dropIndex === undefined ? null : Number(target.dataset.dropIndex);
      if (drag.kind) add(drag.kind, groupId, index);
      else if (R.move(current.entries, drag.nodeId, groupId, index ?? undefined)) {
        current.active = groupId; current.changed = true; paint();
      }
    });
    window.addEventListener('pointercancel', closeDrag);
    dialog.addEventListener('cancel', event => {
      if (dragging) { event.preventDefault(); closeDrag(); }
    });
    dialog.addEventListener('close', () => { closeDrag(); current = null; });
    $('jsonGuide').addEventListener('click', () => open(null, 'guide'));
    document.addEventListener('click', event => {
      const edit = event.target.closest('[data-edit-rules]');
      if (edit) open(edit.dataset.editRules || getSelected()?.id);
    });
    return {open, openGuide: () => open(null, 'guide')};
  }
  root.CombatRuleEditor = {create};
})(window);
