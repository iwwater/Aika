const labels={idle:'工程记录',classifying:'正在整理任务',clarifying:'还需补充一句',selecting:'正在准备安排',confirming:'请确认这项安排',sending:'正在提交',working:'已接收 · 等待结果',completed:'已完成',failed:'本次未完成',unknown:'结果待核实'};
const phases={awaiting_confirmation:'待确认',forwarding:'正在提交',accepted:'已接收 · 等待结果',completed:'已完成',unknown:'结果待核实',unavailable:'本次未完成'};
const targetKey=t=>t?JSON.stringify([t.hostId,t.threadId]):'';
const projectKey=p=>p?JSON.stringify([p.id,p.version]):'';
const executorName=executor=>executor==='harness'?'DeepSeek Harness':'Codex';
const nativeLabels={working:'正在处理',approval:'等待在 Harness 中批准',completed:'已完成',failed:'本次未完成',unknown:'结果待核实'};
const receiptLabel=r=>r.executor==='harness'&&r.nativeStatus?nativeLabels[r.nativeStatus]??phases[r.phase]:phases[r.phase];
const working=new Set(['classifying','clarifying','selecting','confirming','sending','working']);

// Summarize confirmed receipt states; unknown never implies ongoing execution.
export function pendingSummary(state){
 const rows=[...(state.confirmation?[state.confirmation]:[]),...state.requests.filter(r=>r.id!==state.confirmation?.id)].filter(r=>r.confirmedAt&&!(r.phase==='unknown'&&r.reminderCleared));
 const waiting=rows.filter(r=>['forwarding','accepted'].includes(r.phase)&&!['unknown','failed','completed'].includes(r.nativeStatus)).length;
 const unknown=rows.filter(r=>r.phase==='unknown'||(['forwarding','accepted'].includes(r.phase)&&r.nativeStatus==='unknown')).length;
 const total=Number.isSafeInteger(state.pendingCount)&&state.pendingCount>=0?state.pendingCount:waiting+unknown;
 const missing=Math.max(0,total-waiting-unknown);
 return [waiting?`等待结果 ${waiting} 项`:'',unknown?`待核对 ${unknown} 项`:'',missing?`${waiting+unknown?'另 ':''}${missing} 项状态待核对`:''].filter(Boolean).join(' · ');
}

/** Plans and receipts stay in this side channel; editing can never send a task. */
export class WorkCard {
  constructor({get,send,open,onToggle,onRecords,onState}){this.get=get;this.send=send;this.open=open;this.onToggle=onToggle;this.onRecords=onRecords;this.onState=onState;this.reset();}
  reset(){this.state=null;this.sequence=-1;this.allowFocus=false;this.expanded=false;this.pending=false;this.pendingAction=null;this.edit=null;this.clarify=null;this.records=null;this.moreActions=null;this.dialogue=null;this.presentedBinding=null;this.recordFocusId=null;this.renderedKey=null;this.confirmed=new Set();this.replanned=new Set();this.fullTexts=new Map();this.titles=new Map();this.identities=new Map();this.onState?.(null);this.render();}
  input(preserve=false){this.recordFocusId=null;this.allowFocus=false;if(!preserve)this.expanded=false;this.render();}
  focusRecord(id){this.forgetBinding();this.input();this.recordFocusId=id;this.action({type:'focus',id});}
  currentBinding(){
    const s=this.state,d=s?.draft,c=s?.confirmation;
    if(this.pending||this.edit||!d?.id||!Number.isSafeInteger(d.version)||d.version<1)return;
    const binding={draftId:d.id,draftVersion:d.version};
    if(s.stage==='clarifying'&&!c)return binding;
    if(s.stage!=='confirming'||!c?.id||!Number.isSafeInteger(c.version)||c.version<1||c.phase!=='awaiting_confirmation'||c.confirmedAt||this.confirmed.has(`${c.id}:${c.version}`)||this.replanned.has(`${c.id}:${c.version}`))return;
    return {...binding,requestId:c.id,requestVersion:c.version};
  }
  bindingKey(b){return b?JSON.stringify([b.draftId,b.draftVersion,b.requestId??null,b.requestVersion??null]):null;}
  inputBinding(){return this.presentedBinding&&this.bindingKey(this.presentedBinding)===this.bindingKey(this.currentBinding())?{...this.presentedBinding}:undefined;}
  presented(binding=this.currentBinding()){if(binding&&this.bindingKey(binding)===this.bindingKey(this.currentBinding()))this.presentedBinding={...binding};}
  forgetBinding(){this.presentedBinding=null;}
  routedWork(){this.allowFocus=true;this.expanded=true;this.render();}
  get active(){return this.state?.requests.find(r=>r.id===this.state.activeRequestId);}
  get focused(){return this.allowFocus&&this.state?.focus==='work'&&working.has(this.state.stage)&&!['approval','completed','failed','unknown'].includes(this.active?.nativeStatus);}
  receive(state){
    if(!state||!Number.isSafeInteger(state.sequence)||state.sequence<=this.sequence||!Object.hasOwn(labels,state.stage)||!['work','companion'].includes(state.focus)||!Array.isArray(state.requests))return false;
    for(const t of state.draft?.targets??[])if(typeof t.title==='string'&&t.title.trim())this.titles.set(targetKey(t),t.title);
    if(this.edit&&(state.draft?.id!==this.edit.draftId||state.draft?.version!==this.edit.version||state.confirmation?.id!==this.edit.confirmationId||state.confirmation?.version!==this.edit.confirmationVersion)){
      if(this.pendingAction==='reprepare'&&state.confirmation?.phase==='awaiting_confirmation'||!this.edit.dirty)this.edit=null;
      else this.edit.stale=true;
    }
    this.sequence=state.sequence;this.state=structuredClone(state);this.pending=false;this.pendingAction=null;if(this.bindingKey(this.presentedBinding)!==this.bindingKey(this.currentBinding()))this.forgetBinding();
    if(state.stage==='confirming'&&state.confirmation?.phase==='awaiting_confirmation'&&!state.confirmation.confirmedAt)this.confirmed.delete(`${state.confirmation.id}:${state.confirmation.version}`);
    if(this.recordFocusId&&(state.activeRequestId===this.recordFocusId||state.confirmation?.id===this.recordFocusId)){this.recordFocusId=null;this.expanded=true;this.allowFocus=true;}
    this.onState?.(this.state);this.render();return true;
  }
  action(action){
    if(['refresh','focus','open_native','clear_unknown_reminders'].includes(action.type)){this.send({channel:'work_action',action});return;}
    if(this.pending)return;
    if(action.type==='confirm'){
      const c=this.state?.confirmation;
      if(this.edit||this.state?.stage!=='confirming'||c?.phase!=='awaiting_confirmation'||c.confirmedAt||c.id!==action.id||c.version!==action.expectedVersion)return;
      const key=`${action.id}:${action.expectedVersion}`;if(this.confirmed.has(key)||this.replanned.has(key))return;this.confirmed.add(key);
    }
    this.forgetBinding();this.pending=true;this.pendingAction=action.type;this.send({channel:'work_action',action});this.render();
  }
  replanPrepared(draft,confirmation){
    const s=this.state,d=s?.draft,c=s?.confirmation;
    if(this.pending||this.edit||s?.stage!=='confirming'||!d||!c||d.id!==draft.id||d.version!==draft.version||c.id!==confirmation.id||c.version!==confirmation.version||c.phase!=='awaiting_confirmation'||c.confirmedAt||!d.text.trim())return;
    const key=`${c.id}:${c.version}`;if(this.confirmed.has(key)||this.replanned.has(key))return;
    this.replanned.add(key);this.action({type:'replan',draftId:d.id,expectedVersion:d.version,text:d.text});
  }
  beginEdit(){
    const {draft:d,confirmation:c}=this.state;
    if(!d||!c||c.phase!=='awaiting_confirmation'||this.pending)return;
    this.forgetBinding();this.edit={draftId:d.id,version:d.version,confirmationId:c.id,confirmationVersion:c.version,text:c.text,executor:c.executor??d.executor??'codex',target:targetKey(c.target),project:projectKey(c.project),dirty:false,stale:false};this.render();
  }
  saveEdit(){
    const e=this.edit,s=this.state,d=s?.draft;
    if(!e||e.stale||!d||d.id!==e.draftId||d.version!==e.version||!e.text.trim()||this.pending)return;
    const c=s.confirmation,targets=[...(d.targets??[]),...(c?.target?[c.target]:[])];
    const target=targets.find(t=>targetKey(t)===e.target);
    if(e.executor==='codex'&&!target)return;
    const projects=[...(d.projects??[]),...(c?.project?[c.project]:[])],project=projects.find(p=>projectKey(p)===e.project);
    if(e.project&&!project)return;
    this.action({type:'reprepare',draftId:e.draftId,expectedVersion:e.version,text:e.text.trim(),executor:e.executor,...(e.executor==='codex'?{target:{threadId:target.threadId,hostId:target.hostId}}:{}),...(project?{projectId:project.id,projectVersion:project.version}:{})});
  }
  render(){
    const badge=this.get('work-badge'),card=this.get('work-card'),actions=this.get('work-actions'),s=this.state;actions.replaceChildren();actions.hidden=true;
    if(!s){this.get('drawer').dataset.workOpen='false';badge.hidden=true;card.hidden=true;card.replaceChildren();return;}
    const recordsButton=()=>{const b=document.createElement('button');b.id='work-records-open';b.type='button';b.textContent='工程记录';b.setAttribute('aria-haspopup','dialog');b.onclick=()=>this.onRecords?.(b);return b;};
    const active=this.active,hasCard=!!(s.draft||s.confirmation||active)||['classifying','selecting','sending'].includes(s.stage),processCurrent=hasCard&&(['classifying','selecting','sending','working'].includes(s.stage)||(s.stage==='clarifying'&&!!s.draft)||(s.stage==='confirming'&&s.confirmation?.phase==='awaiting_confirmation'&&!s.confirmation.confirmedAt)),currentLabel=active?.executor==='harness'&&active.nativeStatus&&s.focus==='work'?receiptLabel(active):labels[s.stage];
    const pending=pendingSummary(s),mutedUnknown=s.stage==='unknown'&&!pending&&!processCurrent,visible=!!pending||processCurrent||(s.stage!=='idle'&&!mutedUnknown),hasHistory=s.requests.length>0||!!s.confirmation;
    badge.hidden=!visible;badge.textContent=s.stage==='completed'?'已完成'+(pending?` · ${pending}`:''):pending&&s.focus==='companion'?pending:currentLabel+(pending?` · ${pending}`:'');badge.setAttribute('aria-expanded',String(processCurrent&&this.expanded));badge.setAttribute('aria-controls',processCurrent?'work-card':'work-records-dialog');badge.setAttribute('aria-haspopup',processCurrent?'false':'dialog');
    const caption=document.createElement('span');caption.textContent=badge.textContent;const symbol=document.createElement('span');symbol.className='work-symbol';symbol.setAttribute('aria-hidden','true');badge.replaceChildren(symbol,caption);badge.dataset.focused=String(this.focused);
    badge.onclick=()=>{if(!processCurrent){this.allowFocus=false;this.expanded=false;this.render();this.open();this.onRecords?.(badge);return;}this.allowFocus=true;this.expanded=true;this.open();this.action({type:'focus'});this.render();this.onToggle?.();};
    card.hidden=!visible||!this.expanded||!hasCard;this.get('drawer').dataset.workOpen=String(!card.hidden);if(card.hidden){card.replaceChildren();if(visible||hasHistory){if(processCurrent){const reopen=document.createElement('button');reopen.id='work-reopen';reopen.type='button';reopen.textContent='查看任务与输入';reopen.onclick=badge.onclick;actions.append(reopen);}actions.append(recordsButton());actions.hidden=false;}return;}
    const scroller=this.get('conversation')??card,scrollTop=scroller.scrollTop,focusedElement=document.activeElement;
    const focus=focusedElement?.id,selection=[focusedElement?.selectionStart,focusedElement?.selectionEnd];
    const node=(tag,text,id)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(id)n.id=id;return n;};
    const button=(text,id,fn)=>{const b=node('button',text,id);b.type='button';b.disabled=this.pending&&!id.startsWith('work-refresh');b.onclick=fn;return b;};
    const taskBody=(text,id,key)=>{const box=node('div'),pre=node('pre',text,id),expanded=this.fullTexts.get(key)??false;pre.className=text.length>180&&!expanded?'work-body-preview':'';box.append(pre);if(text.length>180||id==='work-confirm-body'){const more=button(expanded?'收起全文':'查看任务全文',`work-full-${key}`,()=>{this.fullTexts.set(key,!expanded);this.render();if(id){const body=this.get(id),area=this.get('conversation');area.scrollTop+=(body.getBoundingClientRect().top-area.getBoundingClientRect().top);}});more.className='work-full-toggle';more.setAttribute('aria-expanded',String(expanded));if(id==='work-confirm-body')actions.append(more);else box.append(more);}return box;};
    const details=(title,text)=>{const d=node('details');d.append(node('summary',title),node('p',text));return d;};
    const nativeView=r=>{
      if(r.executor!=='harness'||!r.confirmedAt||!r.harnessSessionId)return null;
      const block=node('div');block.className='work-native';
      if(r.nativeStatus==='approval')block.append(node('p','这项操作需要你在 Harness 中允许。'));
      block.append(button('在 Harness 中查看',`work-native-${r.id}`,()=>this.action({type:'open_native',id:r.id})));return block;
    };
    const targetView=r=>{
      const block=node('div');block.className='work-target-name';block.append(node('p',`执行者：${executorName(r.executor)}`));
      if((r.executor??'codex')==='codex'){
        const t=r.target,title=t?.title||this.titles.get(targetKey(t));block.append(node('p',`任务：${title||'任务名称暂不可用'}`));
      }
      block.append(node('p',r.project?`项目：${r.project.name}`:'项目：未绑定项目'));return block;
    };
    const heading=node('div');heading.className='work-heading';heading.append(node('strong',currentLabel),recordsButton(),button('收起','work-hide',()=>{this.input();this.onToggle?.();}));const children=[heading],d=s.draft,c=s.confirmation;
    if(['clarifying','confirming'].includes(s.stage))children.push(node('p','按住发言键确认或补充','work-voice-hint'));
    if(c){
      if(c.plan?.title)children.push(node('h3',c.plan.title,'work-plan-title'));
      const summary=node('div',undefined,'work-plan-summary');summary.append(node('span',`执行者：${executorName(c.executor)}`),node('span',`项目：${c.project?.name??'未绑定项目'}`));summary.setAttribute('title',`${executorName(c.executor)} · ${c.project?.name??'未绑定项目'}`);actions.append(summary);
      const preview=node('section');preview.className='work-confirmation';preview.append(targetView(c),taskBody(c.text,'work-confirm-body',`${c.id}-${c.version}`));
      if(s.stage==='confirming'){
        const confirm=button('确认执行','work-confirm',()=>this.action({type:'confirm',id:c.id,expectedVersion:c.version}));confirm.disabled=this.pending||!!this.edit||c.phase!=='awaiting_confirmation'||!!c.confirmedAt||this.confirmed.has(`${c.id}:${c.version}`)||this.replanned.has(`${c.id}:${c.version}`);actions.append(confirm);
        if(d){const edit=button(this.edit?'取消修改':'修改','work-edit',()=>{if(this.edit){this.edit=null;this.render();}else this.beginEdit();});edit.setAttribute('aria-expanded',String(!!this.edit));edit.setAttribute('aria-controls','work-edit-form');actions.append(edit);}
        if(d&&c.phase==='awaiting_confirmation'&&!c.confirmedAt){const replan=button('重新整理','work-replan',()=>this.replanPrepared(d,c));replan.disabled=this.pending||!!this.edit||!d.text.trim()||this.confirmed.has(`${c.id}:${c.version}`)||this.replanned.has(`${c.id}:${c.version}`);actions.append(replan);}
        actions.append(button('暂不执行','work-dismiss',()=>{this.expanded=false;this.allowFocus=false;this.edit=null;this.action({type:'dismiss',...(d?{draftId:d.id}:{})});}));
      }
      const native=nativeView(c);if(native)preview.append(native);children.push(preview);
      if(this.edit&&d){
        const e=this.edit,form=node('section',undefined,'work-edit-form');form.className='work-edit-form';
        const changed=()=>{e.dirty=true;const save=this.get('work-save');if(save)save.disabled=this.pending||e.stale||!e.text.trim()||e.executor==='codex'&&!e.target;};
        const field=(title,id,options,value,onchange)=>{const wrapper=node('div'),label=node('label',title);label.setAttribute('for',id);const select=node('select',undefined,id);select.disabled=this.pending||e.stale;for(const [value,title]of options){const o=node('option',title);o.value=value;select.append(o);}select.value=value;select.onchange=()=>{onchange(select.value);changed();};wrapper.append(label,select);return {wrapper,select};};
        if(e.stale)form.append(node('p','这项安排已经更新。请取消修改后查看新卡片；当前编辑不会覆盖新版本。','work-edit-conflict'));
        const choices=node('div');choices.className='work-choices';
        const executor=field('执行者','work-executor',[['codex','Codex'],['harness','DeepSeek Harness']],e.executor,value=>{e.executor=value;this.render();});choices.append(executor.wrapper);
        const projects=[...(d.projects??[])];if(c.project&&!projects.some(p=>projectKey(p)===projectKey(c.project)))projects.push(c.project);
        const project=field('关联项目','work-project',[['','不关联项目'],...projects.map(p=>[projectKey(p),p.name])],e.project,value=>{e.project=value;});choices.append(project.wrapper);form.append(choices);
        if(e.executor==='codex'){
          const targets=[...(d.targets??[])];if(c.target&&!targets.some(t=>targetKey(t)===targetKey(c.target)))targets.push(c.target);
          const target=field('执行任务','work-target',[['','请选择任务'],...targets.map(t=>[targetKey(t),t.title||this.titles.get(targetKey(t))||'任务名称暂不可用'])],e.target,value=>{e.target=value;});form.append(target.wrapper);
        }
        const label=node('label','请求内容');label.setAttribute('for','work-text');const editor=node('textarea',undefined,'work-text');editor.rows=3;editor.value=e.text;editor.disabled=this.pending||e.stale;editor.oninput=()=>{e.text=editor.value;changed();};form.append(label,editor);
        const save=button('更新确认卡','work-save',()=>this.saveEdit());save.disabled=this.pending||e.stale||!e.text.trim()||e.executor==='codex'&&!e.target;actions.append(save);form.append(node('p','保存后重新核对并确认，此步骤不会执行任务。'));children.push(form);
      }
    }else if(d&&!['classifying','sending','working','completed','unknown'].includes(s.stage)){
      children.push(node('p',d.question||'请补充你希望完成的事，我会重新整理安排。'));
      const label=node('label','补充或改写请求');label.setAttribute('for','work-clarify-text');const editor=node('textarea',undefined,'work-clarify-text');editor.rows=3;editor.value=this.clarify?.id===d.id&&this.clarify.version===d.version?this.clarify.text:d.text;editor.disabled=this.pending;editor.oninput=()=>{this.clarify={id:d.id,version:d.version,text:editor.value};};
      children.push(label,editor,button('重新整理','work-replan',()=>{const text=editor.value.trim();if(text)this.action({type:'replan',draftId:d.id,expectedVersion:d.version,text});}),button('暂不执行','work-dismiss',()=>{this.expanded=false;this.allowFocus=false;this.action({type:'dismiss',draftId:d.id});}));
    }
    if(!c&&active){const row=node('section');row.className='work-record';if(active.plan?.title)row.append(node('h3',active.plan.title));row.append(targetView(active));const native=nativeView(active);if(native)row.append(native);children.push(row);}
    if(s.detail)children.push(node('p','暂未完成，可修改安排或在工程记录中核对详情。','work-notice'));
    children.push(button('刷新状态','work-refresh',()=>this.action({type:'refresh'})));
    if(this.pending)children.push(node('p','正在处理，请稍候…','work-pending'));
    const key=JSON.stringify([s.stage,d?.id,d?.version,c?.id,c?.version,!!this.edit]);card.replaceChildren(...children);scroller.scrollTop=scrollTop;this.renderedKey=key;const items=Array.from(actions.children),summary=items.find(n=>n.id==='work-plan-summary'),primary=items.find(n=>n.id==='work-confirm'),secondary=items.filter(n=>['work-replan','work-dismiss'].includes(n.id));
    const remaining=items.filter(n=>n!==summary&&n!==primary&&!secondary.includes(n));
    if(this.edit){if(primary)primary.hidden=true;for(const n of remaining)if(n.className==='work-full-toggle')n.hidden=true;}
    if(secondary.length){const menu=node('details',undefined,'work-more-actions');menu.open=this.moreActions?.open??false;this.moreActions=menu;menu.append(node('summary','更多'),...secondary);menu.hidden=!!this.edit;remaining.push(menu);}
    actions.replaceChildren(...(summary?[summary]:[]),...(primary?[primary]:[]),...remaining);actions.hidden=actions.children.length===0;
    if(focus&&this.edit){const restored=this.get(focus);if(restored&&['work-text','work-executor','work-project','work-target'].includes(focus)){restored.focus({preventScroll:true});if(restored.setSelectionRange&&Number.isInteger(selection[0]))restored.setSelectionRange(...selection);}}
  }
}
