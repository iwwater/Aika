import {query} from './api.mjs';
import {el,button,badge,notice,field,select,definition,time} from './dom.mjs';
import {createWorkProtocolView} from './work-protocol-view.mjs';

// Forwarding with explicit Codex/Harness executors: this page only prepares, confirms and reads server-owned receipts.
const phases={awaiting_confirmation:'待确认',forwarding:'转发中',accepted:'已接收 · 尚未确认完成',completed:'已完成',unknown:'结果未知',unavailable:'不可用'};
const validTarget=t=>t&&t.hostId==='local'&&typeof t.threadId==='string'&&t.threadId.length>0;
const validProject=p=>p&&typeof p.id==='string'&&typeof p.name==='string'&&Number.isSafeInteger(p.version)&&p.version>0&&typeof p.detailRef?.rootPath==='string'&&(p.detailRef.entryFile===undefined||typeof p.detailRef.entryFile==='string');
const executor=r=>r.executor??'codex';
const executionName=r=>executor(r)==='harness'?'DeepSeek Harness':'Codex';
const validRequest=r=>r&&typeof r.id==='string'&&r.id.length>0&&Number.isSafeInteger(r.version)&&r.version>0&&Object.hasOwn(phases,r.phase)&&typeof r.text==='string'&&['codex','harness'].includes(executor(r))&&(executor(r)==='harness'?r.target===undefined:validTarget(r.target))&&(r.nativeStatus===undefined||Object.hasOwn(nativeLabels,r.nativeStatus))&&(r.plan===undefined||typeof r.plan?.title==='string'&&typeof r.plan?.reason==='string')&&(r.project===undefined||validProject(r.project))&&typeof r.createdAt==='string'&&Number.isFinite(Date.parse(r.createdAt))&&['confirmedAt','harnessSessionId','appTurnId','result','detail'].every(k=>r[k]===undefined||typeof r[k]==='string');
const nativeLabels={working:'正在处理',approval:'等待在 Harness 中批准',completed:'已完成',failed:'本次未完成',unknown:'结果未知'};
const targetKey=t=>t?.hostId+'/'+t?.threadId;
const projectKey=p=>JSON.stringify([p?.id,p?.version,p?.name,p?.source,p?.detailRef.rootPath,p?.detailRef.entryFile]);
export function createTasksView(client,render,getHost){
 const s={snapshot:null,targets:[],targetsReady:false,query:'',target:null,text:'',project:null,projectQuery:'',projects:null,showProjects:false,requests:[],selected:null,confirmation:null,revision:0,lastPrepared:null,error:'',message:'',busy:false,stale:true};
 let epoch=0,identity=null,connection=null,returnFocus='tasks-prepare';
 const reads=new Map(),uncertain=new Set();
 const host=()=>getHost(),online=()=>host().connection==='online';
 const protocolWork=createWorkProtocolView(client,render,online);
 const ready=()=>online()&&!s.stale&&s.snapshot?.connection.harness==='ready'&&s.snapshot.connection.codex==='compatible'&&s.snapshot.connection.preset==='ready';
 const canReview=r=>online()&&!s.stale&&s.snapshot?.connection.harness==='ready'&&s.snapshot.connection.preset==='ready'&&(executor(r)==='harness'||s.snapshot.connection.codex==='compatible');
 const selected=()=>s.requests.find(r=>r.id===s.selected);
 const effectivePhase=r=>uncertain.has(r.id)?'unknown':r.phase;
 const fingerprint=()=>JSON.stringify({text:s.text,target:s.target&&targetKey(s.target),project:s.project&&[s.project.id,s.project.version]});
 const prior=()=>s.lastPrepared?.fingerprint===fingerprint()?s.requests.find(r=>r.id===s.lastPrepared.id):null;
 const allowedPrepare=()=>ready()&&s.targetsReady&&s.target&&!s.busy&&!reads.has('project')&&(!prior()||effectivePhase(prior())==='awaiting_confirmation');
 function cancelReads(){for(const x of reads.values())x.controller.abort();reads.clear();}
 function sync(){const h=host(),next=[h.authEpoch,h.instanceId].join('/');if(identity!==next||connection!==h.connection){identity=next;connection=h.connection;epoch++;cancelReads();s.stale=true;s.targetsReady=false;s.confirmation=null;}}
 function fail(e){if(e.name==='AbortError')return;s.error=[s.error,e.message].filter(Boolean).join('\n');if(e.status===401||e.status===403)host().onError(e);}
 function merge(r){
  const old=s.requests.find(x=>x.id===r.id);if(old&&r.version<old.version)return;if(old&&(old.text!==r.text||executor(old)!==executor(r)||JSON.stringify([old.plan?.title,old.plan?.reason])!==JSON.stringify([r.plan?.title,r.plan?.reason])||(old.target?.title&&old.target.title!==r.target?.title)||targetKey(old.target)!==targetKey(r.target)||projectKey(old.project)!==projectKey(r.project)||(old.harnessSessionId&&old.harnessSessionId!==r.harnessSessionId)||(old.appTurnId&&old.appTurnId!==r.appTurnId)))throw Error('原请求内容、目标或 App 轮次发生变化，回执未采用。');
  // A received exact receipt can resolve a lost HTTP response; an old pending record cannot.
  if(!['awaiting_confirmation','unknown'].includes(r.phase))uncertain.delete(r.id);
  s.requests=[r,...s.requests.filter(x=>x.id!==r.id)].slice(0,50);
 }
 async function read(kind,path,accept,options){
  if(!online())return;reads.get(kind)?.controller.abort();const token={controller:new AbortController(),epoch};reads.set(kind,token);render();
  try{const value=await client.request(path,{...options,signal:token.controller.signal});if(reads.get(kind)===token&&token.epoch===epoch)accept(value);}
  catch(e){if(reads.get(kind)===token&&token.epoch===epoch)fail(e);}
  finally{if(reads.get(kind)===token)reads.delete(kind);render();}
 }
 function loadSnapshot(){
  if(!online()||s.busy)return;s.stale=true;
  return read('snapshot','/api/tasks',data=>{
   if(!data||!Array.isArray(data.requests)||data.requests.length>50||!data.requests.every(validRequest)||new Set(data.requests.map(r=>r.id)).size!==data.requests.length||!['ready','unavailable','authentication_required','incompatible'].includes(data.connection?.harness)||!['compatible','incompatible'].includes(data.connection?.codex)||!['ready','unavailable'].includes(data.connection?.preset))throw Error('转发服务返回了无法识别的状态，请刷新核对。');
   for(const r of [...data.requests].reverse())merge(r);s.snapshot=data;s.stale=false;
   if(s.confirmation){const current=s.requests.find(r=>r.id===s.confirmation.id);if(!current||current.version!==s.confirmation.version||effectivePhase(current)!=='awaiting_confirmation')s.confirmation=null;}
  });
 }
 function loadTargets(){
  if(!online()||s.busy)return;const q=s.query;s.targetsReady=false;
  return read('targets',query('/api/tasks/targets',{query:q}),data=>{
   if(!data||!Array.isArray(data.items)||data.items.length>1000||(data.limit!==undefined&&data.limit!==1000)||!data.items.every(t=>validTarget(t)&&typeof t.title==='string'&&typeof t.projectPath==='string')||new Set(data.items.map(targetKey)).size!==data.items.length)throw Error('现有任务列表无法识别，未启用发送。');
   s.targets=data.items;s.targetsReady=true;
   if(s.target){const current=data.items.find(t=>targetKey(t)===targetKey(s.target));if(current)s.target=current;else{s.target=null;invalidateConfirmation();}}
  });
 }
 async function refresh(){sync();if(!online()||s.busy)return;s.error='';await Promise.all([loadSnapshot(),loadTargets(),protocolWork.refresh()]);}
 function invalidateConfirmation(){s.revision++;s.confirmation=null;}
 function editText(value){const wasPrepared=!!prior();s.text=value;const open=!!s.confirmation;invalidateConfirmation();s.message='';if(open||wasPrepared)render();}
 function chooseTarget(t){if(s.busy)return;s.target=t;invalidateConfirmation();s.error='';s.message='';render();}
 function loadProjects(){if(!online()||s.busy)return;s.showProjects=true;return read('projects',query('/api/projects',{query:s.projectQuery,offset:0,limit:25}),data=>{if(!data||!Array.isArray(data.items)||data.items.length>25||!data.items.every(validProject))throw Error('项目索引暂时无法读取。');s.projects=data;});}
 function chooseProject(id){
  if(s.busy)return;invalidateConfirmation();s.project=null;reads.get('project')?.controller.abort();reads.delete('project');render();if(!id)return;
  return read('project','/api/projects/'+encodeURIComponent(id),p=>{if(!validProject(p)||p.id!==id)throw Error('项目资料回执不匹配。');s.project=p;});
 }
 function openConfirmation(r,trigger){if(!canReview(r)||s.busy||effectivePhase(r)!=='awaiting_confirmation')return;s.confirmation={id:r.id,version:r.version};s.selected=r.id;returnFocus=trigger;render();}
 function closeConfirmation(){s.confirmation=null;render();document.getElementById(returnFocus)?.focus({preventScroll:true});}
 async function prepare(){
  if(!allowedPrepare())return;if(!s.text.trim()||Array.from(s.text).length>20000){s.error='请填写要转发的正文，最多 20000 字。';render();return;}
  const old=prior();if(old){openConfirmation(old,'tasks-prepare');return;}
  const input={text:s.text,target:{hostId:'local',threadId:s.target.threadId},...(s.project?{projectId:s.project.id,projectVersion:s.project.version}:{})},stamp=fingerprint(),generation=s.revision,started=epoch;
  s.busy=true;s.error='';s.message='';render();
  try{
   const r=await client.request('/api/tasks/prepare',{method:'POST',body:input});if(started!==epoch)return;
   if(!validRequest(r)||r.phase!=='awaiting_confirmation'||targetKey(r.target)!==targetKey(input.target)||(input.projectId?(r.project?.id!==input.projectId||r.project?.version!==input.projectVersion):r.project!==undefined))throw Error('待确认记录与所选目标或项目不一致，未启用发送。');
   merge(r);s.lastPrepared={id:r.id,fingerprint:stamp};s.selected=r.id;
   if(generation===s.revision){s.confirmation={id:r.id,version:r.version};returnFocus='tasks-prepare';}
  }catch(e){if(started===epoch){fail(e);if(e.status===409)s.error='项目资料已更新。请重新选择项目并核对后准备发送。';}}
  finally{s.busy=false;render();}
 }
 async function confirm(){
  const r=s.requests.find(x=>x.id===s.confirmation?.id);if(!r||!canReview(r)||s.busy||r.version!==s.confirmation.version||effectivePhase(r)!=='awaiting_confirmation')return;
  const started=epoch,id=r.id,version=r.version;s.busy=true;s.confirmation=null;s.error='';s.message='正在提交确认，尚未确认是否送达。';render();
  try{
   const receipt=await client.request('/api/tasks/confirm',{method:'POST',body:{id,expectedVersion:version}});
   if(started!==epoch){uncertain.add(id);return;}
   if(!validRequest(receipt)||receipt.id!==id||targetKey(receipt.target)!==targetKey(r.target)||receipt.text!==r.text||receipt.version<version)throw Error('转发回执不匹配。');
   merge(receipt);s.message='已取得本次转发回执。';
  }catch(e){
   if(started!==epoch||!e.status||e.status>=500){uncertain.add(id);s.message='';s.error='结果未知，请核对原请求回执。不会自动重新发送，也不会取消工程任务。';}
   else{fail(e);s.message='';if(e.status===409)s.error='确认记录已更新，请刷新后重新核对。';}
  }finally{s.busy=false;render();if(started===epoch&&online())await loadSnapshot();}
 }
 function refreshReceipt(r){if(!online()||s.busy)return;s.error='';return read('receipt','/api/tasks/refresh',value=>{
  if(!validRequest(value)||value.id!==r.id||targetKey(value.target)!==targetKey(r.target)||value.text!==r.text||value.version<r.version)throw Error('原请求回执无法匹配，状态尚未确认。');merge(value);
 },{method:'POST',body:{id:r.id}});}
 function titleFor(target){return target?.title||s.targets.find(t=>targetKey(t)===targetKey(target))?.title||'任务名称暂不可用';}
 function info(r){return definition([['执行者',executionName(r)],...(executor(r)==='codex'?[['现有任务',titleFor(r.target)],['任务标识',r.target.threadId]]:[]),['运行位置','本机（local）'],...(r.project?[['所选项目',r.project.name],['项目版本',r.project.version],['项目目录',r.project.detailRef.rootPath],['文档入口',r.project.detailRef.entryFile||'未填写']]:[['所选项目','未绑定项目']])]);}
 function receiptDetail(){const r=selected();if(!r)return el('p',{class:'empty'},'选择一条转发记录，查看确认内容与回执。');const phase=effectivePhase(r);
  return el('section',{class:'task-receipt','data-detail-id':'task-'+r.id},el('div',{class:'section-head'},el('h2',{},'本次转发'),badge(r.executor==='harness'&&r.nativeStatus?nativeLabels[r.nativeStatus]:phases[phase],phase==='completed'?'success':phase==='unknown'||phase==='unavailable'?'warning':'muted')),info(r),el('details',{},el('summary',{},'已提交的正文'),el('div',{class:'text-block',tabIndex:0,'data-scroll-key':'task-text-'+r.id},r.text)),
   r.executor==='harness'&&r.nativeStatus==='approval'&&notice('这项操作需要你在 Harness 中允许。','warning'),r.detail&&notice(r.detail),phase==='unknown'&&notice('暂时无法确认结果。刷新只核对原请求，不会重新发送。','warning'),
   r.result!==undefined&&el('section',{class:'section-gap'},el('h3',{},'任务返回内容'),el('div',{class:'text-block tall',id:'task-result',tabIndex:0,'data-scroll-key':'task-result-'+r.id},r.result||'（空）'),el('p',{class:'subtle'},'仅在此页查看，不写入陪伴记忆或朗读。')),
   el('div',{class:'actions'},phase==='awaiting_confirmation'&&button('查看并确认',()=>openConfirmation(r,'task-review'),{id:'task-review',disabled:!canReview(r)||s.busy}),button('核对本次回执',()=>refreshReceipt(r),{id:'task-refresh-receipt',disabled:!online()||s.busy||reads.has('receipt')})),
   el('details',{},el('summary',{},'回执信息'),definition([['请求标识',r.id],['记录版本',r.version],['创建时间',time(r.createdAt)],['确认时间',time(r.confirmedAt)],['App 轮次',r.appTurnId||'尚未取得'],['Harness 会话',r.harnessSessionId||'尚未取得']])));
 }
 function confirmation(){const r=s.requests.find(x=>x.id===s.confirmation?.id);if(!r)return null;
  return el('dialog',{id:'task-confirm-dialog',class:'task-confirm','aria-labelledby':'task-confirm-title',onCancel:e=>{e.preventDefault();closeConfirmation();}},el('h2',{id:'task-confirm-title'},'确认执行这项请求？'),info(r),el('h3',{},'发送内容'),el('div',{class:'text-block',id:'task-final-text',tabIndex:0,'data-scroll-key':'task-confirm-text'},r.text),notice('确认一次后由所示执行者开始处理。关闭页面或停止朗读不会取消工程任务。'),el('div',{class:'actions'},button('返回编辑',closeConfirmation,{id:'task-confirm-back'}),button('确认发送',confirm,{id:'task-confirm-send',class:'primary',disabled:!canReview(r)||s.busy})));
 }
 function afterRender(){const dialog=document.getElementById('task-confirm-dialog');if(dialog&&!dialog.open){const focused=document.activeElement;dialog.showModal();if(focused&&dialog.contains(focused))focused.focus({preventScroll:true});else document.getElementById('task-confirm-back')?.focus({preventScroll:true});}}
 function view(){const c=s.snapshot?.connection,pending=reads.has('snapshot')||reads.has('targets'),old=prior();
  const connections=el('div',{class:'task-connections'},...[
   ['Harness',c?({ready:'已就绪',unavailable:'不可用',authentication_required:'需要认证',incompatible:'版本不兼容'})[c.harness]:'尚未核验'],
   ['Codex 桌面任务',c?({compatible:'连接兼容',incompatible:'连接不兼容'})[c.codex]:'尚未核验'],
   ['转发配置',c?({ready:'已就绪',unavailable:'不可用'})[c.preset]:'尚未核验']
  ].map(([label,status])=>el('div',{},el('span',{},label),badge(status))),button('刷新连接与任务',refresh,{id:'tasks-refresh',disabled:!online()||s.busy||pending}));
  const composer=el('section',{class:'task-composer'},el('h2',{},'发送到现有任务'),el('form',{class:'searchbar',onSubmit:e=>{e.preventDefault();if(!s.busy)loadTargets();}},field('查找本机现有任务','tasks-query',s.query,v=>{s.query=v},{maxLength:200}),el('button',{type:'submit',id:'tasks-search',disabled:!online()||s.busy||reads.has('targets')},'查找')),
   el('div',{class:'record-list task-targets',id:'task-targets',tabIndex:0,'aria-label':'现有本机任务'},s.targets.length?s.targets.map(t=>button(el('div',{},el('strong',{},t.title),el('small',{},t.projectPath||'未提供项目目录'),el('small',{},t.threadId)),()=>chooseTarget(t),{id:'task-target-'+t.threadId,'data-task-target':t.threadId,class:'record-row','aria-pressed':targetKey(s.target)===targetKey(t),disabled:s.busy})):el('p',{class:'empty'},reads.has('targets')?'正在查找现有任务…':'没有可选任务，请调整查询或核对连接。')),
   s.target&&el('p',{class:'task-selection'},'已选：'+s.target.title+' · '+s.target.threadId),
   el('section',{class:'task-project-binding'},button(s.showProjects?'收起项目资料':'关联项目资料（可选）',()=>{s.showProjects=!s.showProjects;render();if(s.showProjects)loadProjects();},{id:'task-project-toggle',disabled:s.busy}),s.showProjects&&[el('form',{class:'searchbar',onSubmit:e=>{e.preventDefault();loadProjects();}},field('查找项目','task-project-query',s.projectQuery,v=>{s.projectQuery=v},{maxLength:200}),el('button',{type:'submit',id:'task-project-search',disabled:!online()||s.busy||reads.has('projects')},'查找项目')),
    s.projects&&select('所选项目','task-project',s.project?.id||'',[{value:'',label:'不绑定项目'},...s.projects.items.map(p=>({value:p.id,label:p.name+' · '+p.id})),...(s.project&&!s.projects.items.some(p=>p.id===s.project.id)?[{value:s.project.id,label:s.project.name+' · '+s.project.id}]:[])],chooseProject,{disabled:s.busy}),s.project&&el('p',{class:'subtle'},s.project.detailRef.rootPath+(s.project.detailRef.entryFile?' / '+s.project.detailRef.entryFile:''))]),
   field('要转发的正文','task-text',s.text,editText,{type:'textarea',maxLength:40000,disabled:s.busy,hint:'Idea、规划、架构和执行由所选 Codex 任务处理。'}),
   old&&effectivePhase(old)!=='awaiting_confirmation'&&notice('这份内容已有转发记录，可在右侧核对回执。新消息请修改正文或目标。'),
   el('div',{class:'actions'},button('准备发送',prepare,{id:'tasks-prepare',class:'primary',disabled:!allowedPrepare()})));
  const history=el('section',{class:'task-history'},el('h2',{},'最近转发'),el('p',{class:'subtle'},'最多显示 50 条回执；已接收不代表任务完成。'),
   el('div',{class:'record-list task-request-list',tabIndex:0,'data-scroll-key':'task-requests','aria-label':'最近转发记录'},s.requests.length?s.requests.map(r=>button(el('div',{},el('div',{class:'section-head'},badge(phases[effectivePhase(r)]),el('small',{},time(r.createdAt))),el('p',{},r.text),el('small',{},executionName(r)+(executor(r)==='codex'?' · '+titleFor(r.target):''))),()=>{s.selected=r.id;s.confirmation=null;render();},{id:'task-request-'+r.id,'data-task-request':r.id,class:'record-row','aria-pressed':s.selected===r.id})):el('p',{class:'empty'},'暂无转发记录。')),receiptDetail());
  return el('div',{class:'tasks-page'},el('p',{class:'subtle'},'查看 Codex 与 Harness 的任务回执，也可在此手动发送到已有 Codex 任务。'),s.error&&notice(s.error,'error'),s.message&&notice(s.message),connections,s.stale&&notice('连接状态尚未更新，暂时不能发送。保留本页草稿与上次回执。','warning'),el('div',{class:'task-workspace'},composer,history),confirmation(),protocolWork.view());
 }
 return {sync,refresh,view,afterRender(){afterRender();protocolWork.afterRender();},dispose(){epoch++;cancelReads();protocolWork.dispose();}};
}
