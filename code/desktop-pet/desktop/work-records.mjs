import {pendingSummary} from './work-card.mjs';
const phases={awaiting_confirmation:'待确认',forwarding:'正在提交',accepted:'已接收 · 等待结果',completed:'已完成',unknown:'结果待核实',unavailable:'本次未完成'};
const nativePhases={working:'正在处理',approval:'等待在 Harness 中批准',completed:'已完成',failed:'本次未完成',unknown:'结果待核实'};
const node=(tag,text,id)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(id)n.id=id;return n;};
const detail=(title,text)=>{const d=node('details');d.append(node('summary',title),node('pre',text));return d;};

/** Record presentation and explicit reminder controls. It never focuses a backend task or presents a confirmation. */
export class WorkRecords {
  constructor({get,action,onClose,onSelect}){
    this.get=get;this.action=action;this.onClose=onClose;this.onSelect=onSelect;this.state=null;this.returnFocus=null;this.expanded=new Map();this.refreshRequest=null;this.refreshFeedback='';this.refreshTimer=null;this.clearRequest=null;this.clearTimer=null;this.clearFeedback='';this.ignoredReminderFeedback=undefined;
    get('work-records-close').onclick=()=>this.close();
    get('work-records-dialog').addEventListener('cancel',e=>{e.preventDefault();this.close();});
  }
  get isOpen(){return !!this.get('work-records-dialog').open;}
  tab(event){const nodes=[...this.get('work-records-dialog').querySelectorAll('button:not([disabled]), summary, [tabindex="0"]')].filter(n=>n.getClientRects().length);if(!nodes.length)return;event.preventDefault();event.stopPropagation();const at=nodes.indexOf(document.activeElement),next=at<0?0:(at+(event.shiftKey?-1:1)+nodes.length)%nodes.length;nodes[next].focus({preventScroll:true});}
  position(){const r=this.get('drawer').getBoundingClientRect();Object.assign(this.get('work-records-dialog').style,{left:`${r.left+8}px`,top:`${r.top+8}px`,width:`${Math.max(1,r.width-16)}px`,height:`${Math.max(1,r.height-16)}px`});}
  show(origin){if(this.isOpen)return;this.returnFocus=origin??document.activeElement;this.chatScroll=this.get('conversation').scrollTop;this.position();this.get('work-records-dialog').showModal();this.get('work-records-close').focus({preventScroll:true});}
  close(restore=true){if(!this.isOpen)return false;this.get('work-records-dialog').close();if(restore){const origin=this.returnFocus?.id?this.get(this.returnFocus.id):this.returnFocus;const target=origin&&origin.isConnected!==false&&!origin.disabled&&!origin.hidden?origin:this.get('work-records-open')??this.get('text');target?.focus({preventScroll:true});this.get('conversation').scrollTop=this.chatScroll;this.onClose?.();}this.returnFocus=null;return true;}
  refresh(id){
    if(!this.state||this.refreshRequest)return;this.refreshRequest={sequence:this.state.sequence,id};this.refreshFeedback='正在查询最新记录…';
    this.refreshTimer=setTimeout(()=>{this.refreshRequest=null;this.refreshFeedback='暂未收到更新，可再次刷新。';this.render();},8000);
    this.render();this.action({type:'refresh',...(id?{id}:{})});
  }
  eligible(){return this.state?[...(this.state.confirmation?[this.state.confirmation]:[]),...this.state.requests.filter(r=>r.id!==this.state.confirmation?.id)].filter(r=>r.confirmedAt&&r.phase==='unknown'&&!r.reminderCleared):[];}
  clearReminders(records){
    if(this.clearRequest||!records.length)return;const current=this.eligible();
    if(!records.every(item=>current.some(r=>r.id===item.id&&r.version===item.expectedVersion))){this.clearFeedback='记录已变化，请核对后重新选择。';this.render();return;}
    this.clearRequest={records,sequence:this.state.sequence,feedback:this.state.reminderFeedback};this.ignoredReminderFeedback=this.state.reminderFeedback;this.clearFeedback='等待清除提醒的回执…';
    this.clearTimer=setTimeout(()=>{this.clearRequest=null;this.clearFeedback='暂未确认清除结果，请刷新记录后核对。';this.render();},8000);
    this.render();this.action({type:'clear_unknown_reminders',records});
  }
  receive(state){
    this.state=state;
    if(this.clearRequest&&state&&state.sequence>this.clearRequest.sequence){
      const request=this.clearRequest,records=[...(state.confirmation?[state.confirmation]:[]),...state.requests],eligible=this.eligible();
      const cleared=request.records.every(item=>records.some(r=>r.id===item.id&&r.phase==='unknown'&&r.reminderCleared===true));
      const changed=request.records.some(item=>!eligible.some(r=>r.id===item.id&&r.version===item.expectedVersion));
      const freshFeedback=state.reminderFeedback&&state.reminderFeedback!==request.feedback;
      if(cleared||changed||freshFeedback){
        clearTimeout(this.clearTimer);this.clearRequest=null;
        this.clearFeedback=freshFeedback?state.reminderFeedback:cleared?'所选提醒已清除，历史记录保留。':'记录已变化，请核对当前提醒。';
        this.ignoredReminderFeedback=freshFeedback?undefined:state.reminderFeedback;
      }
    }else if(!this.clearRequest&&state&&state.reminderFeedback!==this.ignoredReminderFeedback){this.clearFeedback=state.reminderFeedback||'';this.ignoredReminderFeedback=undefined;}
    if(this.refreshRequest&&state&&state.sequence>this.refreshRequest.sequence){clearTimeout(this.refreshTimer);this.refreshRequest=null;this.refreshFeedback='已收到更新';}
    if(!state){this.ignoredReminderFeedback=undefined;clearTimeout(this.clearTimer);this.clearRequest=null;this.clearFeedback='';clearTimeout(this.refreshTimer);this.refreshRequest=null;this.refreshFeedback='';this.close(false);this.expanded.clear();this.get('work-records-content').replaceChildren();return;}
    this.render();
  }
  render(){
    const state=this.state;if(!state)return;
    const content=this.get('work-records-content'),scroll=content.scrollTop,focused=document.activeElement;
    const items=[];const source=state.sourceInput;
    if(source?.conversation?.length){const conversation=node('section',undefined,'work-conversation');conversation.append(node('h3','任务问答'));for(const m of source.conversation){if(!['user','assistant'].includes(m.role)||typeof m.text!=='string'||m.scope?.characterId!==source.scope?.characterId)continue;const row=node('div');row.className='work-dialogue-row';row.append(node('strong',m.role==='user'?'你':'任务回复'),node('pre',m.text));conversation.append(row);}items.push(conversation);}
    if(state.detail)items.push(detail('处理说明',state.detail));
    const records=[...(state.confirmation?[state.confirmation]:[]),...state.requests.filter(r=>r.id!==state.confirmation?.id)];
    const tools=node('div');tools.className='work-records-tools';const refresh=node('button',this.refreshRequest?'正在刷新…':'刷新记录','work-records-refresh');refresh.type='button';refresh.disabled=!!this.refreshRequest;refresh.onclick=()=>this.refresh();
    const feedback=node('p',`${this.refreshFeedback?this.refreshFeedback+' · ':''}当前显示 ${records.length} 条记录${pendingSummary(state)?' · '+pendingSummary(state):''}`,'work-records-feedback');feedback.setAttribute('role','status');const eligible=this.eligible(),selection=eligible.map(r=>({id:r.id,expectedVersion:r.version})),clear=node('button','清除全部待核对提醒','work-reminders-clear');clear.type='button';clear.disabled=!!this.clearRequest||selection.length===0;clear.onclick=()=>this.clearReminders(selection);const reminder=node('p',this.clearFeedback||'仅清除提醒，任务记录和原结果保留。','work-reminder-feedback');reminder.setAttribute('role','status');tools.append(refresh,clear,feedback,reminder);items.unshift(tools);
    for(const r of records){
      const row=node('details',undefined,`work-record-${r.id}`);row.className='work-record';row.open=this.expanded.get(r.id)?.open??false;this.expanded.set(r.id,row);
      const status=(r.executor==='harness'&&r.nativeStatus?nativePhases[r.nativeStatus]:phases[r.phase])??'结果待核实';row.append(node('summary',`${r.plan?.title??'任务记录'} · ${status}${r.phase==='unknown'&&r.reminderCleared?' · 提醒已清除':''}`));
      row.append(node('p',`执行者：${r.executor==='harness'?'DeepSeek Harness':'Codex'} · 项目：${r.project?.name??'未绑定项目'}`));if(r.target?.title)row.append(node('p',`任务：${r.target.title}`));row.append(node('pre',r.text));
      if(r.plan?.reason)row.append(detail('安排说明',r.plan.reason));
      if(r.result)row.append(node('h4','执行回执'),node('pre',r.result));if(r.detail)row.append(detail('处理详情',r.detail));
      row.append(detail('任务标识',[r.id,r.target?.threadId,r.target?.hostId,r.harnessSessionId].filter(Boolean).join(' · ')));
      if(r.executor==='harness'&&r.confirmedAt&&r.harnessSessionId){const open=node('button','在 Harness 中查看',`work-record-native-${r.id}`);open.type='button';open.onclick=()=>this.action({type:'open_native',id:r.id});row.append(open);}
      if(eligible.some(item=>item.id===r.id)){const clear=node('button','清除此项提醒',`work-reminder-clear-${r.id}`);clear.type='button';clear.disabled=!!this.clearRequest;clear.onclick=()=>this.clearReminders([{id:r.id,expectedVersion:r.version}]);row.append(clear);}
      const select=node('button','在主界面处理此任务',`work-record-select-${r.id}`);select.type='button';select.onclick=()=>{this.onSelect?.(r.id);this.close();};row.append(select);
      const refresh=node('button','刷新这项状态',`work-record-refresh-${r.id}`);refresh.type='button';refresh.disabled=!!this.refreshRequest;refresh.onclick=()=>this.refresh(r.id);row.append(refresh);items.push(row);
    }
    if(!records.length)items.push(node('p',state.pendingCount?`有 ${state.pendingCount} 项任务状态待核对，当前列表尚未返回。请刷新记录。`:'暂时没有工程记录。'));
    content.replaceChildren(...items);content.scrollTop=scroll;
    if(this.isOpen&&focused?.id?.startsWith('work-record-'))this.get(focused.id)?.focus({preventScroll:true});
  }
}
