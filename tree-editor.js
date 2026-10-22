(function(root) {
  'use strict';

  function create({model: M, conditions: R, treeModel: T, catalog, getProject, getState,
    canvas, scroller, change, icons, toast, select, openRules, selectedAbility, avatarHtml, skillImage}) {
    const html = value => String(value ?? '').replace(/[&<>"']/g, char =>
      ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[char]));
    const icon = name => `<i data-lucide="${name}" aria-hidden="true"></i>`;
    const keyOf = path => path.join('.');
    const pathOf = text => text ? text.split('.').map(Number) : [];
    const expanded = new Set(), collapsed = new Set();
    let chosen = null, dragging = null, suppressedClick = false, ghost = null, scrollFrame = null;
    const materials = [
      ['e-ready','zap','E 就绪'], ['q-ready','sparkles','Q 就绪'], ['low-hp','heart-pulse','低血量'],
      ['since','timer','距上次'], ['count','hash','执行次数'], ['in-party','users-round','队伍角色'],
      ['any','split','任选分组'], ['raw','code-xml','表达式']
    ];
    const scope = () => ({playerId: T.scopeOf(getProject()), catalog});
    const nodeKey = (entry, path) => `${entry.id}#${keyOf(path)}`;
    const active = () => {
      if (!chosen) return null;
      try { return {...T.find(getProject(), chosen.entryId, scope()), path: chosen.path,
        node: T.at(T.tree(getProject(), chosen.entryId, scope()), chosen.path)}; }
      catch { chosen = null; return null; }
    };
    const isOpen = (entry, path) => !collapsed.has(nodeKey(entry, path))
      && (path.length === 0 || expanded.has(nodeKey(entry, path)));

    function axisOffset() {
      const width = scroller.clientWidth || 800;
      return width <= 710 ? Math.max(174, Math.min(240, Math.round(width * .49)))
        : Math.max(270, Math.min(390, Math.round(width * .43)));
    }

    function targetLabel(value, clip) {
      if (value === '' || value == null) return '本动作';
      if (typeof value === 'number') return `编号 ${value}`;
      const other = getProject().clips.find(row => row.name === value
        && (!M.isMultiplayer(getProject()) || !row.playerId || row.playerId === clip.playerId));
      if (!other) return String(value);
      const skill = selectedAbility(other);
      return `${other.useCurrentCharacter ? '通用' : M.character(catalog, other.characterId).name} ${skill.key}`;
    }

    function label(node, clip) {
      if (node.type === 'group') return node.negated ? `不满足 · ${node.mode === 'all' ? '全部' : '任一'}`
        : node.mode === 'all' ? '全部满足' : '任一满足';
      if (node.type === 'raw') return node.warning ? '原生表达式' : node.expression || '始终成立';
      const p = node.params, ref = targetLabel(p.target, clip);
      let text;
      const titles = {always:'始终成立', never:'始终不成立', 'low-hp':'前台血量低', onfield:'本角色在前台'};
      if (titles[node.kind]) text = titles[node.kind];
      else if (['e-ready','q-ready'].includes(node.kind)) text =
        `${p.target ? p.target + ' ' : clip.useCurrentCharacter ? '未指定角色 · ' : ''}${node.kind === 'e-ready' ? 'E' : 'Q'} 就绪`;
      else if (node.kind === 'in-party') text = `队伍包含 ${p.target}`;
      else if (node.kind === 'after') text = `${ref}已先执行`;
      else if (['last-exec','battle-time'].includes(node.kind)) text =
        `${node.kind === 'last-exec' ? `距${ref === '本动作' ? '上次' : ref}` : '战斗时间'} ${p.greater ? '>' : '<'} ${p.value}s`;
      else {
        const prefix = {since: ref === '本动作' ? '距上次' : `距${ref}`, count: ref === '本动作' ? '执行次数' : `${ref}次数`,
          t:'战斗时间', 'e-cd':`${p.target || (clip.useCurrentCharacter ? '未指定角色' : '本角色')} E 冷却`,
          'last-check':'距检查结束'}[node.kind] || node.kind;
        text = `${prefix} ${p.operator} ${p.value}${node.kind === 'count' ? '次' : 's'}`;
      }
      return node.negated ? `不满足 · ${text}` : text;
    }

    function treeHtml(entry, clip, node, path = []) {
      const key = keyOf(path), selected = chosen?.entryId === entry.id && keyOf(chosen.path) === key;
      const group = node.type === 'group', open = group && isOpen(entry, path);
      const kind = group ? open ? 'chevron-down' : 'chevron-right'
        : node.type === 'raw' ? 'code-xml' : R.kinds.find(row => row.name === node.kind)?.icon || 'circle';
      return `<li class="tree-node ${selected ? 'selected' : ''} ${node.negated ? 'negated' : ''}"
        data-tree-group="${group ? html(entry.id) : ''}" data-tree-path="${key}">
        <div class="tree-node-line"><button type="button" class="tree-node-button" data-tree-node="${html(entry.id)}"
          data-node-path="${key}" ${group ? `aria-expanded="${open}"` : ''}
          title="${html(R.describe(node))}">${icon(kind)}<span data-tree-caption="${html(entry.id)}#${key}">${html(label(node, clip))}</span>
          ${group ? `<small>${node.children.length}</small>` : ''}</button></div>
        ${group && open ? `<ul class="tree-children">${node.children.map((child, index) =>
          treeHtml(entry, clip, child, [...path, index])).join('') || '<li class="tree-empty-condition">无附加条件</li>'}</ul>` : ''}
      </li>`;
    }

    function editorHtml() {
      const selected = active();
      if (!selected) return '';
      const {entry, clip, node, path} = selected;
      const field = (name, text, content) => `<label class="tree-param"><span>${text}</span>${content}</label>`;
      const attr = name => `data-tree-param="${name}"`;
      const p = node.params || {}, parts = [];
      const select = (name, text, value, values) => field(name, text,
        `<select ${attr(name)} aria-label="${text}">${values.map(([id, caption]) =>
          `<option value="${html(id)}" ${String(value) === String(id) ? 'selected' : ''}>${html(caption)}</option>`).join('')}</select>`);
      if (node.type === 'group') parts.push(select('mode','组合',node.mode,[['all','全部满足'],['any','任一满足']]));
      if (node.type === 'test') {
        const kind = node.kind;
        const owners = M.isMultiplayer(getProject())
          ? M.players(getProject()).find(player => player.Id === clip.playerId)?.Characters || []
          : catalog.characters.map(character => character.name);
        if (['e-ready','q-ready','e-cd','in-party'].includes(kind)) {
          const values = [['', clip.useCurrentCharacter ? '省略目标（原生默认）' : '本角色'],
            ...owners.map(name => [name,name])];
          if (p.target && !values.some(([name]) => name === p.target)) values.push([p.target,p.target]);
          parts.push(select('target','角色',p.target,values));
        } else if (['since','count','after','last-exec'].includes(kind)) {
          const others = getProject().clips.filter(row => !M.isMultiplayer(getProject()) || !row.playerId || row.playerId === clip.playerId);
          const values = [['','本动作'], ...others.map(row => [row.name,
            `${row.useCurrentCharacter ? '通用' : M.character(catalog,row.characterId).name} · ${selectedAbility(row).key} · ${row.name}`])];
          if (p.target !== '' && p.target !== undefined && !values.some(([name]) => String(name) === String(p.target)))
            values.push([p.target,String(p.target)]);
          parts.push(select('target','动作记录',p.target,values));
        }
        if (Object.hasOwn(p,'operator')) parts.push(select('operator','比较',p.operator,
          [['>=','至少'],['>','大于'],['=','等于'],['<','小于'],['<=','不超过'],['!=','不等于']]));
        if (Object.hasOwn(p,'greater')) parts.push(select('greater','比较',p.greater,[['true','大于'],['false','小于']]));
        if (Object.hasOwn(p,'value')) parts.push(field('value',kind === 'count' ? '次数' : '秒',
          `<input type="number" step="${kind === 'count' ? '1' : '0.1'}" ${attr('value')} value="${html(p.value)}" aria-label="条件数值">`));
      }
      const raw = node.type === 'raw' ? `<textarea id="treeRawExpression" aria-label="原生条件表达式" rows="2" spellcheck="false">${html(node.expression)}</textarea>
        <button type="button" data-tree-apply-raw>${icon('check')}<span>应用表达式</span></button>` : '';
      return `<section class="tree-node-editor tree-controls" aria-label="所选条件参数">
        <div class="tree-editor-title">${icon('sliders-horizontal')}<strong>${html(selectedAbility(clip).name)}</strong>
          <span>${html(entry.primary ? '主触发' : '额外触发')}</span>
          <button type="button" class="icon-button" data-tree-close-node aria-label="收起条件参数" title="收起条件参数">${icon('x')}</button></div>
        <div class="tree-parameters">${parts.join('')}
          <label class="checkbox-label"><input type="checkbox" data-tree-negate ${node.negated ? 'checked' : ''}><span>取反</span></label>
          ${path.length ? `<button type="button" class="icon-button" data-tree-delete-node aria-label="删除所选条件" title="删除所选条件">${icon('trash-2')}</button>` : ''}
          <button type="button" class="icon-button" data-tree-advanced="${html(entry.id)}" aria-label="完整规则与原生参数" title="完整规则与原生参数">${icon('code-xml')}</button>
        </div>${raw}
      </section>`;
    }

    function paint() {
      const state = getState(), project = getProject(), rows = T.entries(project, scope());
      if (chosen && !rows.some(row => row.id === chosen.entryId)) chosen = null;
      const offset = axisOffset(), seconds = Math.ceil(Math.max(project.durationMs + 1000,
        ...project.clips.map(clip => Math.max(M.endOf(clip),clip.startMs+clip.effectMs,clip.startMs+clip.cooldownMs))) / 1000);
      const width = Math.max(scroller.clientWidth, offset + seconds * state.zoom + 28);
      canvas.style.width = `${width}px`;
      canvas.style.setProperty('--tree-axis-offset', `${offset}px`);
      canvas.style.setProperty('--tree-panel-width', `${scroller.clientWidth}px`);
      const step = state.zoom < 16 ? 5 : state.zoom < 32 ? 2 : 1;
      const ticks = Array.from({length:Math.floor(seconds/step)+1},(_,i)=>i*step);
      const multiplayer = M.isMultiplayer(project), player = M.players(project).find(row=>row.Id===project.activePlayerId);
      const title = multiplayer ? player ? `${player.Id}${player.IsHost?' · 房主':''}` : '各端通用' : M.hasTeams(project) ? M.activeTeam(project).name : '条件分支';
      const rootRow = `<div class="tree-root tree-controls"><span class="tree-root-joint">${icon('git-fork')}</span><strong>${html(title)}</strong>
        <span>${rows.length} 个触发</span><button class="icon-button" type="button" data-tree-expand-all title="展开全部条件" aria-label="展开全部条件">${icon('list-tree')}</button>
        <button class="icon-button" type="button" data-tree-collapse-all title="收起全部条件" aria-label="收起全部条件">${icon('fold-vertical')}</button></div>`;
      const content = rows.map((entry,index)=>{
        const clip=project.clips.find(row=>row.id===entry.clipId), ability=selectedAbility(clip);
        const character=M.character(catalog,clip.characterId), same=rows.filter(row=>row.clipId===clip.id).length>1;
        const nativeTree=T.tree(project,entry.id,scope()), selected=state.selection.includes(clip.id);
        const cast=Math.min(M.castDurationMs(clip),M.actionDurationMs(clip));
        const castWidth=cast/1000*state.zoom;
        const compact=[castWidth<135?'compact':'',castWidth<72?'tiny':'',castWidth<34?'micro':''].join(' ');
        const labelText=clip.commandOverride===''?clip.name||'状态标记':ability.name;
        const locked=['skill','burst'].includes(clip.abilityId)&&M.castLockMs(clip)===null;
        const canMove=!multiplayer || !project.activePlayerId || !entry.common;
        const key=html(entry.id), displayCharacter=clip.useCurrentCharacter?'当前角色':character.name;
        const dropId=multiplayer?`player-${clip.playerId||''}-${clip.characterId}`:clip.characterId;
        return `<section class="tree-branch" data-tree-row="${key}" data-track="${html(dropId)}"
          data-player-id="${html(clip.playerId||'')}" data-track-character="${clip.characterId}">
          <div class="tree-branch-side tree-controls">
            <span class="tree-branch-joint"></span>
            <div class="tree-branch-heading"><button type="button" class="icon-button tree-grip" data-tree-drag="${key}"
              draggable="false" ${canMove?'':'disabled'} title="上下拖动调整优先顺序" aria-label="拖动${html(labelText)}的触发分支">${icon('grip-vertical')}</button>
              <span class="tree-branch-rank">${index+1}</span><button type="button" class="tree-branch-owner" data-tree-select="${key}" title="${html(clip.name)} · 优先级 ${entry.priority}">
                <strong>${html(displayCharacter)}<b class="tree-ability-key">${html(ability.key)}</b></strong>
                <span>${html(labelText)}${entry.common?' · 共用':entry.primary?'':' · 额外触发'}</span></button>
              <div class="tree-branch-tools"><button type="button" class="icon-button" data-tree-shift="up" data-tree-entry="${key}"
                ${index===0||!canMove?'disabled':''} title="分支上移" aria-label="分支上移">${icon('arrow-up')}</button>
                <button type="button" class="icon-button" data-tree-shift="down" data-tree-entry="${key}"
                ${index===rows.length-1||!canMove?'disabled':''} title="分支下移" aria-label="分支下移">${icon('arrow-down')}</button></div></div>
            <ul class="tree-condition-root">${treeHtml(entry,clip,nativeTree)}</ul>
            <div class="tree-branch-actions"><button type="button" class="icon-button" data-tree-add-trigger="${key}"
              title="为此动作添加另一种触发条件" aria-label="添加触发分支">${icon('git-branch-plus')}</button>
              ${clip.useCurrentCharacter?'':`<button type="button" class="icon-button" data-quick-add="${clip.characterId}" ${multiplayer?`data-player-id="${html(clip.playerId||'')}"`:''} title="添加${html(displayCharacter)}的动作" aria-label="添加角色动作">${icon('plus')}</button>`}
              ${entry.primary?'':`<button type="button" class="icon-button" data-tree-remove-trigger="${key}" title="移除此额外触发" aria-label="移除额外触发">${icon('trash-2')}</button>`}
              <button type="button" class="icon-button" data-tree-advanced="${key}" title="完整规则" aria-label="完整规则">${icon('ellipsis')}</button>
              <span>${same?`${icon('link-2')}同一动作`:''}</span></div>
          </div>
          <div class="tree-action-lane" data-tree-action="${key}">
            ${ticks.map(value=>`<i class="grid-line ${value%5===0?'major':''}" style="left:${value*state.zoom}px"></i>`).join('')}
            <div class="tree-action-wrapper" style="left:${clip.startMs/1000*state.zoom}px;--tree-action-start:${clip.startMs/1000*state.zoom}px;width:${Math.max(10,M.actionDurationMs(clip)/1000*state.zoom)}px">
              <div class="clip clip-${html(clip.abilityId)} ${compact} ${selected?'selected':''}" data-clip="${clip.id}" tabindex="0" role="button" aria-pressed="${selected}"
                title="${html(displayCharacter+' · '+labelText)} · ${html(clip.name)}" style="width:100%">
                <div class="clip-action ${locked?'pending-cast':''}" data-cast="${clip.id}" style="width:${Math.max(8,cast/1000*state.zoom)}px">
                  ${clip.useCurrentCharacter?`<span class="generic-avatar">${icon('user-round')}</span>`:avatarHtml(character,'clip-avatar')}
                  ${skillImage(ability,'clip-skill-icon')}<span class="clip-title"><strong>${html(labelText)}</strong><small>${html(ability.key)} · ${locked?'待实测':M.seconds(cast)+'s'}</small></span><span class="clip-key" aria-hidden="true">${html(ability.key)}</span></div>
                ${M.isFixedAction(clip)?'':`<span class="clip-resize" data-resize="${clip.id}" title="调整动作时长" role="slider" tabindex="0" aria-label="调整${html(labelText)}时长" aria-valuenow="${M.seconds(clip.foregroundMs)}"></span>`}
              </div>
              ${clip.effectMs>0?`<div class="effect-bar" data-effect="${clip.id}" style="left:0;top:57px;width:${Math.max(3,(M.effectEnd(project,clip)-clip.startMs)/1000*state.zoom)}px"><span>${html(ability.key)} · ${html(labelText)} · ${M.seconds(clip.effectMs)}s</span></div>`:''}
              ${clip.cooldownMs>0?`<div class="cooldown-bar" data-effect="${clip.id}" style="left:0;top:87px;width:${clip.cooldownMs/1000*state.zoom}px" title="冷却 ${M.seconds(clip.cooldownMs)}s"></div>`:''}
            </div>
          </div>
        </section>`;
      }).join('');
      canvas.innerHTML=`<div class="ruler tree-ruler" data-ruler><div class="ruler-label sticky-label">${icon('workflow')}<span>条件分支</span></div>
        ${ticks.map(value=>`<span class="ruler-tick" style="left:${offset+value*state.zoom}px">${value}s</span>`).join('')}
        <div class="ruler-playhead" id="rulerPlayhead" aria-hidden="true"></div></div>
        <div class="tree-palette tree-controls"><span>加条件</span>${materials.map(([kind,mark,title])=>
          `<button type="button" data-tree-material="${kind}" draggable="false" title="添加${title}">${icon(mark)}<span>${title}</span></button>`).join('')}</div>
        ${editorHtml()}${rootRow}<div class="tree-branches">${content||`<div class="tree-empty tree-controls"><span>尚无动作</span><button type="button" data-tree-open-library>${icon('users-round')}角色库</button></div>`}</div>
        ${Number.isFinite(state.drag?.snapMs)?`<div class="snap-guide" style="left:${offset+state.drag.snapMs/1000*state.zoom}px"></div>`:''}
        <div class="playhead" id="playhead" style="left:${offset+state.playheadMs/1000*state.zoom}px"></div>`;
      for (const branch of canvas.querySelectorAll('[data-tree-row]')) {
        const entry=rows.find(row=>row.id===branch.dataset.treeRow),clip=project.clips.find(row=>row.id===entry.clipId);
        branch.style.setProperty('--character-color',M.character(catalog,clip.characterId).color);
        branch.style.setProperty('--effect-color',`${M.character(catalog,clip.characterId).color}19`);
      }
    }

    function choose(id, path = [], toggle = false) {
      const {entry,clip}=T.find(getProject(),id,scope());
      chosen={entryId:id,path};
      const node=T.at(T.tree(getProject(),id,scope()),path),key=nodeKey(entry,path);
      if(toggle&&node.type==='group') {
        if(isOpen(entry,path)){collapsed.add(key);expanded.delete(key);}else{expanded.add(key);collapsed.delete(key);}
      }
      select(clip.id);
    }

    function add(kind, entryId = chosen?.entryId, path = chosen?.path || []) {
      const rows=T.entries(getProject(),scope());
      if(!entryId)entryId=rows.find(row=>row.clipId===getState().selected)?.id||rows[0]?.id;
      if(!entryId){toast('先添加一个角色动作',true);return;}
      let value=T.at(T.tree(getProject(),entryId,scope()),path);
      if(value.type!=='group')path=path.slice(0,-1);
      const entry=T.find(getProject(),entryId,scope()).entry;
      expanded.add(nodeKey(entry,path));collapsed.delete(nodeKey(entry,path));
      change(()=>{const next=T.addNode(getProject(),entryId,path,kind,scope());chosen={entryId,path:next};});
      select(entry.clipId);
    }

    canvas.addEventListener('click',event=>{
      const button=event.target.closest('button');
      if(!button||button.disabled||!button.closest('.tree-controls'))return;
      const d=button.dataset;
      try {
        if(d.treeNode){choose(d.treeNode,pathOf(d.nodePath),true);return;}
        if(d.treeSelect){choose(d.treeSelect);return;}
        if(d.treeShift){const rows=T.entries(getProject(),scope()),index=rows.findIndex(row=>row.id===d.treeEntry);
          const target=rows[index+(d.treeShift==='up'?-1:1)];if(target)change(()=>T.reorder(getProject(),d.treeEntry,target.id,d.treeShift==='down',scope()));return;}
        if(d.treeMaterial){if(!suppressedClick)add(d.treeMaterial);return;}
        if(d.treeAddTrigger){const {clip}=T.find(getProject(),d.treeAddTrigger,scope());
          change(()=>{chosen={entryId:T.addTrigger(getProject(),d.treeAddTrigger,scope()),path:[]};});select(clip.id);return;}
        if(d.treeRemoveTrigger){change(()=>{T.removeTrigger(getProject(),d.treeRemoveTrigger,scope());chosen=null;});return;}
        if(d.treeAdvanced){openRules(T.find(getProject(),d.treeAdvanced,scope()).clip.id);return;}
        if(Object.hasOwn(d,'treeExpandAll')){for(const row of T.entries(getProject(),scope())){
          const visit=(node,path)=>{expanded.add(nodeKey(row,path));collapsed.delete(nodeKey(row,path));node.children?.forEach((child,i)=>visit(child,[...path,i]));};visit(T.tree(getProject(),row.id,scope()),[]);}
          select(getState().selected);return;}
        if(Object.hasOwn(d,'treeCollapseAll')){for(const row of T.entries(getProject(),scope()))collapsed.add(nodeKey(row,[]));select(getState().selected);return;}
        if(Object.hasOwn(d,'treeCloseNode')){chosen=null;select(getState().selected);return;}
        if(Object.hasOwn(d,'treeDeleteNode')){const node=active();if(node)change(()=>{T.removeNode(getProject(),node.entry.id,node.path,scope());chosen=null;});return;}
        if(Object.hasOwn(d,'treeApplyRaw')){const node=active(),text=document.getElementById('treeRawExpression').value;
          if(node)change(()=>T.editNode(getProject(),node.entry.id,node.path,{expression:text},scope()));return;}
        if(Object.hasOwn(d,'treeOpenLibrary'))document.getElementById('libraryToggle').click();
      }catch(error){toast(error.message,true);}
    });

    canvas.addEventListener('change',event=>{
      const input=event.target,d=input.dataset,node=active();if(!node)return;
      try {
        if(Object.hasOwn(d,'treeNegate')){change(()=>T.editNode(getProject(),node.entry.id,node.path,{negated:input.checked},scope()));return;}
        if(!d.treeParam)return;
        const value=d.treeParam==='value'?input.valueAsNumber:d.treeParam==='greater'?input.value==='true'
          :d.treeParam==='target'&&typeof node.node.params?.target==='number'&&input.value===String(node.node.params.target)
            ?node.node.params.target:input.value;
        const patch=d.treeParam==='mode'?{mode:value}:{params:{[d.treeParam]:value}};
        const render=d.treeParam==='mode';
        change(()=>T.editNode(getProject(),node.entry.id,node.path,patch,scope()),{render});
        if(!render){const current=active();if(current){
          const caption=[...canvas.querySelectorAll('[data-tree-caption]')].find(element=>element.dataset.treeCaption===nodeKey(current.entry,current.path));
          if(caption)caption.textContent=label(current.node,current.clip);
        }}
      }catch(error){toast(error.message,true);}
    });

    function clearDrop() {
      canvas.querySelectorAll('.tree-drop-before,.tree-drop-after,.tree-drop-condition').forEach(element=>
        element.classList.remove('tree-drop-before','tree-drop-after','tree-drop-condition'));
    }

    function dropAt(x,y) {
      clearDrop();
      const target=document.elementFromPoint(x,y),row=target?.closest('[data-tree-row]');
      if(!row||!canvas.contains(row))return null;
      const after=y>row.getBoundingClientRect().top+row.getBoundingClientRect().height/2;
      row.classList.add(dragging.kind==='condition'?'tree-drop-condition':after?'tree-drop-after':'tree-drop-before');
      const group=target.closest('[data-tree-group]:not([data-tree-group=""])');
      return {id:row.dataset.treeRow,after,path:group?pathOf(group.dataset.treePath):[]};
    }

    function stopDrag() {
      const last=dragging;dragging=null;
      if(scrollFrame!==null)cancelAnimationFrame(scrollFrame);scrollFrame=null;
      ghost?.remove();ghost=null;clearDrop();canvas.classList.remove('tree-dragging');
      if(last&&canvas.hasPointerCapture(last.pointerId))canvas.releasePointerCapture(last.pointerId);
      if(last?.moved){suppressedClick=true;setTimeout(()=>{suppressedClick=false;},0);}
      return last;
    }

    function scrollDuringDrag() {
      if(!dragging?.moved)return;
      const rect=scroller.getBoundingClientRect(),point=dragging.point;
      if(point.x>=rect.left&&point.x<=rect.right&&point.y>=rect.top&&point.y<=rect.bottom){
        const delta=point.y>rect.bottom-36?10:point.y<rect.top+43?-10:0;
        if(delta){scroller.scrollTop+=delta;dropAt(point.x,point.y);}
      }
      scrollFrame=requestAnimationFrame(scrollDuringDrag);
    }

    canvas.addEventListener('pointerdown',event=>{
      const branch=event.target.closest('[data-tree-drag]'),material=event.target.closest('[data-tree-material]');
      if(event.button!==0||!branch&&!material||branch?.disabled)return;
      stopDrag();
      dragging={...(branch?{kind:'branch',id:branch.dataset.treeDrag}:{kind:'condition',kindName:material.dataset.treeMaterial}),
        pointerId:event.pointerId,start:{x:event.clientX,y:event.clientY},point:{x:event.clientX,y:event.clientY},moved:false,
        caption:material?.textContent||branch.closest('[data-tree-row]').querySelector('.tree-branch-owner').textContent};
    });
    window.addEventListener('pointermove',event=>{
      if(!dragging||event.pointerId!==dragging.pointerId)return;
      dragging.point={x:event.clientX,y:event.clientY};
      if(!dragging.moved&&Math.hypot(event.clientX-dragging.start.x,event.clientY-dragging.start.y)<6)return;
      if(!dragging.moved){
        dragging.moved=true;canvas.setPointerCapture(event.pointerId);canvas.classList.add('tree-dragging');
        ghost=document.createElement('div');ghost.className='tree-drag-ghost';ghost.textContent=dragging.caption;
        document.body.append(ghost);scrollFrame=requestAnimationFrame(scrollDuringDrag);
      }
      event.preventDefault();
      ghost.style.left=`${event.clientX+12}px`;ghost.style.top=`${event.clientY+12}px`;
      dropAt(event.clientX,event.clientY);
    },{passive:false});
    window.addEventListener('pointerup',event=>{
      if(!dragging||event.pointerId!==dragging.pointerId)return;
      const target=dragging.moved?dropAt(event.clientX,event.clientY):null,source=stopDrag();
      if(!target||!source.moved)return;
      if(source.kind==='branch')change(()=>T.reorder(getProject(),source.id,target.id,target.after,scope()));
      else add(source.kindName,target.id,target.path);
    });
    window.addEventListener('pointercancel',event=>{if(event.pointerId===dragging?.pointerId)stopDrag();});
    window.addEventListener('blur',stopDrag);
    window.addEventListener('keydown',event=>{
      if(event.key==='Escape'&&dragging){event.preventDefault();stopDrag();}
    });
    return {paint,axisOffset,reset(){stopDrag();chosen=null;expanded.clear();collapsed.clear();},selectEntry:choose};
  }
  root.CombatTreeEditor={create};
})(globalThis);
