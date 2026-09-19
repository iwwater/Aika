import {el,button,badge,notice,field,select,time} from './dom.mjs';

const statuses={discovering:'正在发现聊天',running:'正在整理记忆',paused:'已暂停',failed:'未完成',completed:'已完成'};
const kinds=[{value:'codex-project',label:'本机 Codex 项目'},{value:'text-export',label:'聊天文本导出（JSONL）'}];
const errors={invalid_request:'导入信息无效，请检查项目名称和本机位置。',invalid_state:'任务状态已变化，请刷新后核对。',version_conflict:'任务已在其他位置变化，请按最新进度操作。',source_changed:'原始来源已变化，请核对来源后再操作。',source_unavailable:'无法读取指定来源，请检查本机位置和读取权限。',unsupported_export:'导出格式不受支持，请按页面说明准备文件。',ambiguous_project:'项目匹配不唯一，请填写准确的项目位置。',invalid_source_entry:'来源条目的日期、说话人或正文格式无效。',provider_failed:'记忆整理服务未完成请求，可稍后继续。',provider_timeout:'记忆整理超时，可稍后继续。',commit_conflict:'记忆记录已变化，可刷新后继续。',unavailable:'旧聊天导入暂不可用，请稍后刷新。',budget_exceeded:'当前费用配置不允许继续，请检查模型与费用设置。'};
const finite=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
const count=v=>Number.isSafeInteger(v)&&v>=0;
const text=v=>typeof v==='string'&&v.length>0;
const localPath=p=>typeof p==='string'&&p.length<=4096&&!p.includes('\0')&&(/^(\/|[A-Za-z]:[\\/])/.test(p))&&!/^\/\//.test(p);
const sourceValid=s=>s&&kinds.some(k=>k.value===s.kind)&&text(s.projectName?.trim())&&s.projectName.length<=200&&!s.projectName.includes('\0')&&localPath(s.path);
const sameSource=(a,b)=>a?.kind===b?.kind&&a?.projectName===b?.projectName&&a?.path===b?.path;
const sameConfiguration=(a,b)=>a&&b&&Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(k=>a[k]===b[k]);
const configValid=c=>c&&text(c.model)&&text(c.endpointHost)&&text(c.textExportFormat)&&c.currency==='CNY'&&c.concurrency===1&&['batchMessages','maxInputBytes','maxOutputTokens','timeoutMs'].every(k=>count(c[k])&&c[k]>0)&&['inputMicrosPerToken','outputMicrosPerToken'].every(k=>finite(c[k]))&&(c.budgetMode==='unlimited'&&c.limitMicros===null||c.budgetMode==='bounded'&&finite(c.limitMicros));
const jobValid=j=>j&&text(j.id)&&count(j.revision)&&j.revision>0&&j.characterId==='companion'&&sourceValid(j.source)&&Object.hasOwn(statuses,j.status)&&configValid(j.configuration)&&['discoveredMessages','processedMessages','skippedMessages','totalBatches','completedBatches','importedMemories','estimatedCalls','actualCalls','unknownCostCalls'].every(k=>count(j[k]))&&(j.estimatedMicros===null||finite(j.estimatedMicros))&&finite(j.accountedMicros)&&Array.isArray(j.failures)&&j.failures.every(f=>typeof f?.code==='string')&&Number.isFinite(Date.parse(j.updatedAt))&&Number.isFinite(Date.parse(j.createdAt));
const money=v=>v===null?'尚不能估算':new Intl.NumberFormat('zh-CN',{maximumFractionDigits:6}).format(v/1e6)+' 元';
const definitions=rows=>el('dl',{class:'definitions'},rows.map(([label,value])=>[el('dt',{},label),el('dd',{},value)]));
function configuration(c,id){return el('details',{id,class:'import-config'},el('summary',{},'查看本次模型与费用配置'),definitions([
 ['模型',c.model],['服务',c.endpointHost],['每批消息',c.batchMessages+' 条'],['单批上限',c.maxInputBytes+' 字节输入 / '+c.maxOutputTokens+' 输出 token'],['并发与超时','逐批处理 / '+c.timeoutMs/1000+' 秒'],['计价',`输入 ${c.inputMicrosPerToken} 元 / 百万 token；输出 ${c.outputMicrosPerToken} 元 / 百万 token`],['费用政策',c.budgetMode==='unlimited'?'不设本地上限，持续记账':'当前上限 '+money(c.limitMicros)]
 ]));}

export function createMemoryImportView(client,render,getHost){
 let data=null,identity=null,epoch=0,active=false,reading=null,writing=null,timer=null,stale=true,readError='',actionError='',message='',composing=false;
 let draft={kind:'codex-project',projectName:'',path:''};
 // Retry an uncertain start only after an explicit click, using its original identity.
 const starts=new Map();
 const visible=()=>{const h=getHost();return h.page==='memory'&&h.section==='import'&&h.connection==='online'&&!document.hidden;};
 const redraw=()=>{if(!composing)render();};
 function stop(){active=false;epoch++;clearTimeout(timer);reading?.controller.abort();reading=null;stale=true;composing=false;}
 function sync(){const h=getHost(),key=JSON.stringify([h.instanceId,h.authEpoch]);if(key!==identity){stop();identity=key;data=null;readError='';actionError='';message='';starts.clear();}if(!visible()){if(active)stop();return;}if(!active){active=true;queueMicrotask(()=>active&&refresh());}}
 function accept(value){
  if(value?.instanceId!==getHost().instanceId||!configValid(value.configuration)||!Array.isArray(value.jobs)||!value.jobs.every(jobValid)||new Set(value.jobs.map(j=>j.id)).size!==value.jobs.length)throw Error('Invalid import snapshot');
  if(data&&value.jobs.some(j=>{const old=data.jobs.find(o=>o.id===j.id);return old&&j.revision<old.revision;}))throw Error('Stale import snapshot');
  data=value;stale=false;
 }
 function authError(e){if(e.status===401||e.status===403)getHost().onError({name:'Error',status:e.status});}
 async function refresh(){if(!active||!visible()||reading||writing)return;clearTimeout(timer);const t={epoch,controller:new AbortController()};reading=t;
  try{const value=await client.request('/api/memory-import',{signal:t.controller.signal});if(reading===t&&t.epoch===epoch&&visible()){accept(value);readError='';}}
  catch(e){if(reading===t&&e.name!=='AbortError'){stale=true;readError='暂时无法核对导入状态。以下进度可能已过期，操作已停用，请刷新。';authError(e);}}
  finally{if(reading===t){reading=null;redraw();if(active)timer=setTimeout(refresh,2000);}}
 }
 const writable=()=>active&&visible()&&data?.instanceId===getHost().instanceId&&!stale&&!writing;
 const configurationChanged=j=>!sameConfiguration(j.configuration,data?.configuration);
 const duplicate=()=>data?.jobs.some(j=>sameSource(j.source,draft)&&(['discovering','running'].includes(j.status)||['paused','failed'].includes(j.status)&&!configurationChanged(j)));
 async function write(action,job){
  if(!writable())return;
  if(action==='start'&&(!sourceValid(draft)||duplicate()))return;
  if(action!=='start'&&(!job||!data.jobs.some(j=>j.id===job.id&&j.revision===job.revision)||!(action==='pause'?['discovering','running']:['paused','failed']).includes(job.status)))return;
  if(action==='resume'&&configurationChanged(job))return;
  const key=JSON.stringify(draft);
  let body;
  if(action==='start'){body=starts.get(key)||{instanceId:data.instanceId,operationId:crypto.randomUUID(),characterId:'companion',source:{...draft}};starts.set(key,body);}
  else body={instanceId:data.instanceId,jobId:job.id,expectedRevision:job.revision};
  const t={epoch,identity,controller:new AbortController()};writing=t;reading?.controller.abort();reading=null;clearTimeout(timer);actionError='';message='';render();
  const timeout=setTimeout(()=>t.controller.abort(),15000);
  try{const value=await client.request('/api/memory-import/'+action,{method:'POST',body,signal:t.controller.signal});
   if(t.epoch!==epoch||t.identity!==identity||!visible())return;
   if(!jobValid(value)||action==='start'&&!sameSource(value.source,body.source)||action!=='start'&&(value.id!==body.jobId||value.revision<body.expectedRevision))throw Error('Invalid import receipt');
   const previous=data.jobs.find(j=>j.id===value.id);if(previous&&value.revision<previous.revision)throw Error('Stale receipt');
   data={...data,jobs:[value,...data.jobs.filter(j=>j.id!==value.id)]};
   if(action==='start'){starts.delete(key);message='导入任务已建立。可离开此页，后台会继续处理。';}
   else message='操作已返回，请以任务最新状态为准。';
  }catch(e){if(t.epoch===epoch&&t.identity===identity){stale=true;actionError=e.status>=400&&e.status<500&&errors[e.code]?errors[e.code]:'操作结果尚未确认，请刷新核对。不会自动重发；如需重试开始，将沿用同一次请求。';authError(e);}}
  finally{clearTimeout(timeout);if(writing===t){writing=null;redraw();if(active)refresh();}}
 }
 function edit(key,value){draft={...draft,[key]:value};actionError='';message='';redraw();}
 function jobView(j){const running=['discovering','running'].includes(j.status);return el('article',{class:'card import-job','data-import-job':j.id},
  el('div',{class:'section-head'},el('h3',{},j.source.projectName),badge(statuses[j.status],j.status==='completed'?'success':j.status==='failed'?'warning':'muted')),
  el('p',{class:'subtle'},kinds.find(k=>k.value===j.source.kind).label+' · '+j.source.path),
  j.status==='discovering'?el('p',{},'正在只读发现指定来源，数量和费用估算将随进度更新。'):el('progress',{max:Math.max(1,j.totalBatches),value:j.completedBatches,'aria-label':'已完成批次'}),
  el('div',{class:'md-stats'},[['发现消息',j.discoveredMessages],['处理消息',j.processedMessages],['去重跳过',j.skippedMessages],['写入记忆',j.importedMemories]].map(([label,value])=>el('div',{},el('strong',{},value),el('span',{},label)))),
  el('p',{},`批次 ${j.completedBatches} / ${j.totalBatches} · 预计调用 ${j.estimatedCalls} 次 · 已调用 ${j.actualCalls} 次`),
  definitions([['预计费用',money(j.estimatedMicros)],['本地估算账',money(j.accountedMicros)],['费用未知',j.unknownCostCalls+' 次调用，未按零计入']]),
  j.failures.length>0&&notice([...new Set(j.failures.map(f=>errors[f.code]||'部分内容未处理完成，请检查来源或稍后继续。'))].join(' '),'warning'),
  j.status!=='completed'&&configurationChanged(j)&&notice('模型或费用配置已变化，请按当前配置重新开始导入；已导入的内容会跳过。','warning'),
  configuration(j.configuration,'import-job-config-'+j.id),el('p',{class:'field-help'},'更新于 '+time(j.updatedAt)),
  j.status!=='completed'&&el('div',{class:'actions'},button(running?'暂停导入':'继续导入',()=>write(running?'pause':'resume',j),{'data-import-action':running?'pause':'resume',id:'import-action-'+j.id,disabled:!writable()||!running&&configurationChanged(j)})));
 }
 function view(){return el('div',{class:'memory-import',id:'memory-import-panel'},
  el('section',{class:'card'},el('div',{class:'section-head'},el('div',{},el('h2',{},'导入旧聊天'),el('p',{class:'subtle'},'把过去与陪伴 AI 的聊天整理为长期记忆。')),button('刷新导入进度',refresh,{id:'import-refresh',disabled:!active||!!reading||!!writing})),
   el('p',{class:'field-help'},'选择旧项目或聊天导出，后台会整理其中的记忆。导入期间可以继续聊天。'),
   readError&&notice(readError,'warning'),actionError&&notice(actionError,'warning'),message&&notice(message),
   el('form',{onSubmit:e=>{e.preventDefault();write('start');}},el('div',{class:'form-grid'},
    select('聊天来源','import-kind',draft.kind,kinds,v=>edit('kind',v),{disabled:!!writing}),
    field('旧 AI 项目名称','import-project',draft.projectName,v=>edit('projectName',v),{required:true,maxLength:200,autocomplete:'off',disabled:!!writing,onCompositionStart:()=>{composing=true;},onCompositionEnd:()=>{composing=false;render();}}),
    field(draft.kind==='codex-project'?'本机项目目录（绝对路径）':'本机导出文件（绝对路径）','import-path',draft.path,v=>edit('path',v),{required:true,maxLength:4096,autocomplete:'off',spellcheck:false,disabled:!!writing,onCompositionStart:()=>{composing=true;},onCompositionEnd:()=>{composing=false;render();}})),
    draft.kind==='codex-project'?el('p',{class:'field-help'},'按这个项目目录精确匹配本机 Codex 对话，不扫描其他项目。'):el('p',{class:'field-help import-format'},data?.configuration.textExportFormat||'正在读取支持的导出格式…'),
    data?el('div',{id:'import-current-config'},el('p',{class:'field-help'},'整理模型：'+data.configuration.model+' · '+(data.configuration.budgetMode==='unlimited'?'不设本地费用上限，持续记账':'当前费用上限 '+money(data.configuration.limitMicros))),configuration(data.configuration,'import-config')):notice('正在读取模型与费用配置，读取后才能开始。'),
    el('p',{class:'field-help'},'发现聊天后显示预计费用；实际费用以服务商账单为准。'),
    duplicate()&&notice('同一来源已有未完成导入，请在下方查看进度或继续处理。'),
    el('div',{class:'actions'},el('button',{id:'import-start',class:'primary',type:'submit',disabled:!writable()||!sourceValid(draft)||duplicate()},writing?'正在提交…':'开始后台导入')))),
  el('section',{'aria-label':'导入记录'},el('h2',{},'导入记录'),data?.jobs.length?data.jobs.map(jobView):el('p',{class:'empty'},data?'尚未开始导入。':'读取后显示历史进度。')));
 }
 document.addEventListener('visibilitychange',()=>{sync();redraw();});window.addEventListener('pagehide',stop);window.addEventListener('pageshow',()=>{sync();redraw();});
 return{view,sync,refresh,dispose:stop};
}
