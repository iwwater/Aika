import {query,clone} from './api.mjs';
import {el,button,badge,notice,card,field,select,definition,time,statuses,kinds} from './dom.mjs';

// Mirrors the public memory-dynamics 0.1.0 edit limits; scoring belongs to the service.
const parameters=[
  ['baseHalfLifeDays','记忆淡化基准（天）',15,60,1],
  ['emotionHalfLifeDays','情绪淡化基准（天）',3.5,14,.5],
  ['baselineWeight','基础权重',.50,.60,.01],
  ['activationWeight','鲜活度权重',.20,.30,.01],
  ['importanceWeight','重要性权重',.10,.20,.01],
  ['emotionWeight','情绪权重',0,.10,.01],
];
const labels={...kinds,emotion:'情绪记录'};
const omission={hard_gate:'归属、有效性或遗忘检查未通过',no_cue:'没有匹配线索',below_threshold:'低于选入门槛',limit:'超过条数上限',budget:'上下文空间不足'};
const cues={keywords:'关键词',phrase:'完整短语',supported_relation:'有来源支持的事实关系',none:'无线索'};
const traceStatuses={assembled:'已组装 · 未确认用于模型输入',consumed:'已用于模型输入',invalidated:'已失效 · 不再代表有效上下文'};
const pct=n=>Number.isFinite(n)?(n*100).toFixed(1)+'%':'未评估';
const decimal=n=>Number.isFinite(n)?n.toFixed(3):'—';
const reference=s=>s.id+' · v'+s.version;
const validVersion=n=>Number.isSafeInteger(n)&&n>=0;
const validDate=s=>typeof s==='string'&&Number.isFinite(Date.parse(s));
const validSources=xs=>Array.isArray(xs)&&xs.every(x=>typeof x.id==='string'&&validVersion(x.version));
const validCandidates=xs=>Array.isArray(xs)&&xs.every(c=>validSources([c.source])&&['activation','importance','emotion','relevance','priority'].every(k=>Number.isFinite(c[k]))&&Array.isArray(c.matchedTerms)&&c.matchedTerms.every(t=>typeof t==='string')&&c.cueKind in cues&&typeof c.selected==='boolean'&&(c.omission===null||c.omission in omission));
const validPolicy=p=>p&&parameters.every(([k,,lo,hi])=>Number.isFinite(p[k])&&p[k]>=lo&&p[k]<=hi)&&Math.abs(p.baselineWeight+p.activationWeight+p.importanceWeight+p.emotionWeight-1)<=1e-9;
const validPolicyVersion=p=>p&&validVersion(p.revision)&&validDate(p.effectiveAt)&&validPolicy(p.policy)&&(p.restoredFromRevision===null||validVersion(p.restoredFromRevision));
const samePolicy=(a,b)=>parameters.every(([k])=>a?.[k]===b?.[k]);
const textBlock=text=>el('div',{class:'text-block'},text||'（空）');

export function createMemoryDynamicsView(client,render,getHost) {
  const s={data:null,traces:null,query:'',recordState:'active',offset:0,traceOffset:0,selected:null,
    draft:null,basePolicy:null,conflict:false,stale:true,error:'',message:'',preview:null,
    previewQuery:'',horizon:'7',previewGeneration:0,confirmation:null,reason:'',busy:false,lookup:null};
  let contextKey=null,connection=null,epoch=0;
  const requests=new Map(),operationIds=new Map();
  const host=()=>getHost();
  const online=()=>host().connection==='online';
  const dirty=()=>s.draft&&!samePolicy(s.draft,s.basePolicy?.policy);
  const pending=kind=>requests.has(kind);
  function invalidatePreview(){s.preview=null;s.previewGeneration++;requests.get('preview')?.controller.abort();requests.delete('preview');}
  function invalidateReads(){for(const r of requests.values())r.controller.abort();requests.clear();invalidatePreview();}
  function sync(){
    const h=host(),key=[h.authEpoch,h.instanceId,h.character].join('/');
    if(contextKey!==key||connection!==h.connection){
      if(contextKey!==null){if(contextKey!==key){s.data=null;s.traces=null;s.selected=null;}epoch++;invalidateReads();s.stale=true;s.confirmation=null;s.message='';if(s.draft)s.conflict=true;}
      contextKey=key;connection=h.connection;
    }
  }
  function report(e){s.error=e.message||'读取失败，请刷新后重试。';if(e.status===401||e.status===403||!e.status||e.status>=500)host().onError(e);}
  function checkRole(data){if(data?.characterId!==host().character)throw new Error('服务返回了其他角色的数据，已拒绝显示。');}
  function validateSnapshot(data){
    checkRole(data);
    if(!validVersion(data.dataRevision)||!validDate(data.evaluatedAt)||!validPolicyVersion(data.policy)||data.timeZone!=='Asia/Shanghai'||!Array.isArray(data.policyHistory)||!data.policyHistory.every(validPolicyVersion)||!Array.isArray(data.items)||![data.total,data.offset,data.limit].every(validVersion))throw new Error('记忆快照格式不匹配，请刷新或检查服务版本。');
    for(const {record:r,dynamics:d,relatedIds} of data.items){
      if(!r||r.characterId!==host().character||typeof r.id!=='string'||typeof r.text!=='string'||!validVersion(r.version)||!(r.kind in labels)||!['active','invalidated','deleted','expired','purged'].includes(r.state)||!validSources(r.sources)||!Array.isArray(relatedIds)||!relatedIds.every(x=>typeof x==='string'))throw new Error('记忆记录归属或格式不匹配，已拒绝显示。');
      if(d&&(!(r.kind==='memory')||d.recordId!==r.id||d.recordVersion!==r.version||!Number.isFinite(d.activation)||!Number.isFinite(d.emotion)||!validDate(d.evaluatedAt)||!validDate(d.anchorAt)||!validVersion(d.policyRevision)||!Array.isArray(d.lineageIds)||!d.lineageIds.every(x=>typeof x==='string')||!d.traits||!['event','stable_profile','unassessed'].includes(d.traits.category)||![0,.5,1].includes(d.traits.importance)||!validSources(d.traits.evidenceSources)||!d.traits.emotion||!['missing','invalid','observed'].includes(d.traits.emotion.status)||!validSources(d.traits.emotion.sources)||(d.traits.emotion.status==='observed'&&!Number.isFinite(d.traits.emotion.intensity))))throw new Error('记忆动态评估格式不匹配，已拒绝显示。');
    }
  }
  async function read(kind,path,accept){
    sync();if(!online())return;
    requests.get(kind)?.controller.abort();
    const request={controller:new AbortController(),epoch};requests.set(kind,request);s.error='';render();
    try{const data=await client.request(path,{signal:request.controller.signal});sync();if(request.epoch!==epoch||requests.get(kind)!==request)return;accept(data);}
    catch(e){if(request.epoch===epoch&&requests.get(kind)===request&&e.name!=='AbortError')report(e);}
    finally{if(requests.get(kind)===request)requests.delete(kind);render();}
  }
  function loadData(){
    s.stale=true;s.confirmation=null;invalidatePreview();
    return read('data',query('/api/memory/dynamics',{characterId:host().character,query:s.query,state:s.recordState,offset:s.offset,limit:20}),data=>{
      validateSnapshot(data);
      if(s.data&&(data.dataRevision<s.data.dataRevision||data.policy.revision<s.data.policy.revision))throw new Error('读到了较旧的记忆版本，当前结果未被覆盖。');
      if(!s.draft){s.draft=clone(data.policy.policy);s.basePolicy=clone(data.policy);}
      else if(data.policy.revision!==s.basePolicy.revision){if(dirty()||s.conflict)s.conflict=true;else{s.draft=clone(data.policy.policy);s.basePolicy=clone(data.policy);}}
      s.data=data;s.stale=false;
      if(s.selected&&!data.items.some(i=>i.record.id===s.selected))s.selected=null;
    });
  }
  function loadTraces(){
    return read('traces',query('/api/memory/traces',{characterId:host().character,offset:s.traceOffset,limit:10}),data=>{
      checkRole(data);
      if(!Array.isArray(data.records)||![data.total,data.offset,data.limit].every(validVersion)||data.records.some(t=>t.kind!=='actual'||t.scope?.characterId!==host().character||!(t.status in traceStatuses)||!validCandidates(t.candidates)||!validVersion(t.dataRevision)||!validVersion(t.policyRevision)||!validDate(t.evaluatedAt)||!Number.isFinite(t.countedInputTokens)||!Number.isFinite(t.inputTokenBudget)))throw new Error('实际召回轨迹格式或归属不匹配，已拒绝显示。');
      s.traces=data;
    });
  }
  async function load(section){sync();if(s.busy)return;if(section==='traces')return loadTraces();return loadData();}
  function policyProblem(){if(!validPolicy(s.draft))return '请按标注范围填写六个参数，四项权重之和必须为 1。';return '';}
  function writable(){return online()&&!s.stale&&!s.busy&&!pending('data')&&!s.conflict;}
  function changePolicy(key,value){s.draft[key]=value===''?NaN:Number(value);invalidatePreview();s.message='';render();}
  function reviewPolicy(){if(!s.data||s.stale||s.busy)return;s.basePolicy=clone(s.data.policy);s.conflict=false;invalidatePreview();s.message='已按最新版本核对，草稿保留；尚未保存。';render();}
  function operation(body,path){const key=path+JSON.stringify(body);if(!operationIds.has(key))operationIds.set(key,crypto.randomUUID());return {...body,operationId:operationIds.get(key)};}
  async function mutate(path,method,body,accept){
    sync();if(!writable())return;
    const writeEpoch=epoch;s.busy=true;s.error='';s.message='';s.confirmation=null;invalidateReads();render();
    try{
      const result=await client.request(path,{method,body:operation(body,path)});
      sync();if(writeEpoch!==epoch)return;
      accept(result);s.stale=true;s.traces=null;await loadData();
    }catch(e){
      if(writeEpoch===epoch){s.stale=true;s.confirmation=null;if(e.status===409){if(path.includes('/policy'))s.conflict=true;s.error='版本已变化，本次未覆盖。草稿已保留；请刷新并核对最新版本。';await loadData();}else report(e);}
    }finally{s.busy=false;render();}
  }
  function savePolicy(){
    if(policyProblem()||!writable())return;
    const expectedRevision=s.basePolicy.revision,policy=clone(s.draft);
    return mutate('/api/memory/policy','PUT',{characterId:host().character,expectedRevision,policy},result=>{
      if(!validPolicyVersion(result)||result.revision<=expectedRevision||!samePolicy(result.policy,policy)||result.restoredFromRevision!==null)throw new Error('保存回执不匹配，尚未确认成功，请刷新核对。');
      s.basePolicy=clone(result);s.draft=clone(result.policy);s.conflict=false;
      s.message=`策略已保存为版本 ${result.revision}，从 ${time(result.effectiveAt)} 起影响后续演化。`;
    });
  }
  function rollback(target){
    if(!writable())return;
    const expectedRevision=s.basePolicy.revision;
    return mutate('/api/memory/policy/rollback','POST',{characterId:host().character,expectedRevision,targetRevision:target.revision},result=>{
      if(!validPolicyVersion(result)||result.revision<=expectedRevision||result.restoredFromRevision!==target.revision||!samePolicy(result.policy,target.policy))throw new Error('回退回执不匹配，尚未确认成功，请刷新核对。');
      s.basePolicy=clone(result);s.draft=clone(result.policy);s.conflict=false;
      s.message=`已用版本 ${target.revision} 的参数生成新版本 ${result.revision}，从 ${time(result.effectiveAt)} 起生效；没有恢复已遗忘数据。`;
    });
  }
  function recordAction(item,action){
    if(!writable()||!s.reason.trim())return;
    const r=item.record;
    return mutate('/api/memory/'+action,'POST',{characterId:r.characterId,id:r.id,expectedVersion:r.version,reason:s.reason.trim()},result=>{
      if(result?.status!=='applied'||result.characterId!==r.characterId||!validVersion(result.revision)||result.revision<=s.data.dataRevision||!Array.isArray(result.affectedIds)||!result.affectedIds.includes(r.id)||!result.affectedIds.every(x=>typeof x==='string'))throw new Error('处理回执不匹配，尚未确认成功，请刷新核对。');
      if(action==='forget')host().onMemoryForgotten?.(result.affectedIds);
      s.selected=null;s.reason='';s.message=(action==='forget'?'遗忘已确认':'恢复已确认')+`，服务报告 ${result.affectedIds.length} 条记录受影响。`;
    });
  }
  async function runPreview(){
    sync();if(!writable()||policyProblem()||pending('preview'))return;
    invalidatePreview();const generation=s.previewGeneration;
    const body={characterId:host().character,query:s.previewQuery,evaluatedAt:s.horizon==='now'?'now':new Date(Date.now()+Number(s.horizon)*86400000).toISOString(),expectedDataRevision:s.data.dataRevision,expectedPolicyRevision:s.data.policy.revision,policy:clone(s.draft)};
    const request={controller:new AbortController(),epoch};requests.set('preview',request);s.error='';render();
    try{
      const result=await client.request('/api/memory/preview',{method:'POST',body,signal:request.controller.signal});sync();
      if(request.epoch!==epoch||requests.get('preview')!==request||generation!==s.previewGeneration)return;
      checkRole(result);
      if(result.kind!=='preview'||result.dataRevision!==body.expectedDataRevision||result.policyRevision!==body.expectedPolicyRevision||(!validDate(result.evaluatedAt)||(body.evaluatedAt!=='now'&&result.evaluatedAt!==body.evaluatedAt))||!validDate(result.effectiveFrom)||!validCandidates(result.before)||!validCandidates(result.after))throw new Error('试算回执版本或时点不匹配，结果未显示。');
      s.preview={...result,query:body.query};
    }catch(e){if(request.epoch===epoch&&requests.get('preview')===request&&e.name!=='AbortError'){if(e.status===409){s.stale=true;s.error='试算依据已变化，请刷新记忆版本后重新试算。';}else report(e);}}
    finally{if(requests.get('preview')===request)requests.delete('preview');render();}
  }
  function pagination(data,kind){const isTrace=kind==='traces',busy=pending(isTrace?'traces':'data')||s.busy;
    return el('div',{class:'actions md-pagination'},button('上一页',()=>{if(isTrace){s.traceOffset=Math.max(0,s.traceOffset-10);loadTraces();}else{s.offset=Math.max(0,s.offset-20);loadData();}},{id:'md-'+kind+'-prev',disabled:busy||!online()||data.offset===0}),el('small',{},`${data.total?data.offset+1:0}–${Math.min(data.offset+(isTrace?data.records:data.items).length,data.total)} / ${data.total}`),button('下一页',()=>{if(isTrace){s.traceOffset+=10;loadTraces();}else{s.offset+=20;loadData();}},{id:'md-'+kind+'-next',disabled:busy||!online()||data.offset+(isTrace?data.records:data.items).length>=data.total}));
  }
  function search(){return el('form',{class:'card searchbar',onSubmit:e=>{e.preventDefault();s.offset=0;s.selected=null;s.lookup=null;loadData();}},el('div',{class:'form-grid'},field('搜索已保存的内容','md-query',s.query,v=>s.query=v,{maxLength:1000,placeholder:'例如：公园、课程、周末'}),select('内容状态','md-state',s.recordState,[{value:'active',label:'仅有效内容'},{value:'all',label:'包括已失效与已删除'}],v=>{s.recordState=v;s.offset=0;s.selected=null;s.lookup=null;loadData();},{disabled:s.busy})),el('div',{class:'actions'},el('button',{type:'submit',class:'primary',id:'md-search',disabled:!online()||s.busy},pending('data')?'读取中…':'搜索与刷新')));}
  async function locateSource(ref){
    if(!online()||s.busy)return;
    const lookup={id:ref.id,version:ref.version,loading:true};s.lookup=lookup;s.query=ref.id;s.recordState='all';s.offset=0;s.selected=ref.id;s.reason='';
    host().showSection('fragments');await loadData();
    if(s.lookup!==lookup)return;
    lookup.loading=false;const found=s.data?.items.find(i=>i.record.id===ref.id);
    lookup.found=!s.stale&&!!found;lookup.actualVersion=found?.record.version;render();
  }
  function references(refs){return refs.length?el('div',{class:'md-references'},refs.map(ref=>button(ref.version===undefined?ref.id:reference(ref),()=>locateSource(ref),{'data-md-source':ref.id,disabled:!online()||s.busy}))):'无来源引用';}
  function lookupNotice(){const l=s.lookup;if(!l)return null;if(l.loading)return notice('正在定位来源 '+l.id+'…');if(!l.found)return notice('没有取得该标识的来源记录。可能已清理或当前不可见，页面无法确认原因；其他正文匹配不会被当作这条来源。','warning');if(l.version!==undefined&&l.version!==l.actualVersion)return notice(`引用的是版本 ${l.version}，当前可读版本为 ${l.actualVersion}。下方当前正文不代表引用时的旧正文。`,'warning');return notice('已定位来源 '+l.id+'。这里查看当前可读内容，不改写历史召回。');}
  function meter(label,n){return el('div',{class:'md-meter'},el('div',{class:'label-row'},el('span',{},label),el('strong',{},Number.isFinite(n)?pct(n):'—')),Number.isFinite(n)&&el('meter',{min:0,max:1,value:n,'aria-label':label},pct(n)));}
  function detail(){const item=s.data?.items.find(i=>i.record.id===s.selected);if(!item)return el('section',{class:'memory-detail memory-detail-empty'},el('span',{class:'detail-empty-mark','aria-hidden':'true'},'↗'),el('h2',{},'选择一条内容'),el('p',{class:'subtle'},'在这里查看正文、来源与当前状态。'));
    const {record:r,dynamics:d}=item,e=d?.traits.emotion;
    const panel=el('section',{class:'memory-detail','data-detail-id':r.id},el('div',{class:'memory-detail-heading'},el('div',{},el('small',{},labels[r.kind]),el('h2',{},'内容详情')),badge(statuses[r.state])),el('div',{class:'text-block memory-content','data-scroll-key':'content-'+r.id,tabIndex:0,'aria-label':'内容正文'},r.text||'（空）'),el('div',{class:'memory-source-section'},definition([['引用来源',references(r.sources)],['关联记录',references(item.relatedIds.map(id=>({id})))]])),el('details',{class:'memory-metadata'},el('summary',{},'记录信息'),definition([['记录与版本',reference(r)],['保存时间',time(r.createdAt)],['形成方式',({conversation:'来自对话',automatic:'自动维护',manual:'人工纠正'})[r.origin]||r.origin]])));
    if(d)panel.append(el('div',{class:'md-meters'},meter('鲜活度',d.activation),meter('情绪影响',e.status==='observed'?d.emotion:null)),el('details',{class:'memory-metadata'},el('summary',{},'记忆变化详情'),definition([['记忆性质',({event:'事件记忆',stable_profile:'稳定人物事实',unassessed:'尚未评估'})[d.traits.category]],['重要性',({'0':'普通','0.5':'重要','1':'明确要求记住'})[d.traits.importance]],['当前淡化周期',d.halfLifeDays===null?'不按事件周期淡化':d.halfLifeDays+' 天'],['评估时点',time(d.evaluatedAt)],['演化起点',time(d.anchorAt)],['策略版本',d.policyRevision],['最近有效强化日',d.lastReinforcedDay||'尚无强化记录'],['每日去重时区','Asia/Shanghai（北京时间）'],['同源记录',d.lineageIds.join('\n')||'未提供'],['性质与重要性依据',references(d.traits.evidenceSources)]])),el('h3',{},'情绪证据'),el('p',{class:'subtle',id:'md-emotion-evidence'},e.status==='observed'?`有强度观测：${pct(e.intensity)}`:e.status==='invalid'?'情绪信息无效':'暂无有效情绪信息'),... (e.observation?[textBlock(e.observation)]:[]),definition([['情绪来源',references(e.sources)]]));
    else panel.append(notice('该内容没有记忆动态评估；不把缺失数据解释为鲜活度或情绪为零。'));
    if(r.editable&&r.kind!=='emotion')panel.append(el('div',{class:'detail-actions'},button('纠正这条内容',()=>host().openRecord(r),{id:'md-edit-record',disabled:s.stale||s.busy})));
    if(r.kind==='memory'&&['active','deleted'].includes(r.state)){
      const action=r.state==='active'?'forget':'restore',label=action==='forget'?'遗忘这条内容':'恢复这条内容';
      panel.append(el('div',{class:'detail-record-action'},field('处理原因','md-reason',s.reason,v=>{s.reason=v;s.confirmation=null;render();},{maxLength:1000,disabled:!writable()}),button(label,()=>{s.confirmation={kind:action,id:r.id,version:r.version};render();},{id:'md-record-action',disabled:!writable()||!s.reason.trim()})));
      if(s.confirmation?.id===r.id&&s.confirmation.version===r.version)panel.append(el('div',{class:'md-confirm'},notice(action==='forget'?'遗忘后，这条内容和相关检索记录将不再用于对话。相关内容共享来源时可能无法处理，请等待结果确认。':'只能恢复仍在保留期内的内容，彻底清理后无法恢复。请等待结果确认。','warning'),el('p',{},'待处理：'+reference(r)),button('确认'+(action==='forget'?'遗忘':'恢复'),()=>recordAction(item,action),{id:'md-confirm-record',disabled:!writable(),class:'primary'}),button('取消',()=>{s.confirmation=null;render();})));
    }
    return panel;
  }
  function records(section){const data=s.data;
    const intro=section==='fragments'?'点击来源可查看对应内容及版本。内容有关联，不一定存在因果关系。':'记忆会逐渐淡化，但不会因此自动删除。查看、搜索和试算不会让它变得更牢固。';
    const stats=data&&el('div',{class:'md-summary'},el('span',{},el('strong',{},data.total),' 条查询结果'),el('span',{},'本页长期记忆 ',el('strong',{},data.items.filter(i=>i.record.kind==='memory').length)),el('span',{},'有情绪观测 ',el('strong',{},data.items.filter(i=>i.dynamics?.traits.emotion.status==='observed').length)));
    const list=data&&el('section',{class:'memory-list-pane'},el('div',{class:'memory-list-heading'},el('h2',{},'保存的内容'),el('small',{},'选择一条查看详情')),
      el('div',{class:'record-list memory-rows','data-scroll-key':'memory-rows',tabIndex:0,'aria-label':'保存的内容列表'},data.items.length?data.items.map(i=>{
        const r=i.record;return el('button',{type:'button',class:'record-row memory-row','data-md-record':r.id,'aria-pressed':s.selected===r.id,onClick:()=>{s.selected=r.id;s.reason='';s.confirmation=null;s.lookup=null;render();}},el('span',{class:'memory-kind-icon','aria-hidden':'true'},({memory:'记',transcript:'话',summary:'摘',emotion:'情'})[r.kind]||'索'),el('span',{class:'memory-row-body'},el('span',{class:'memory-row-meta'},labels[r.kind],el('span',{},time(r.createdAt))),el('span',{class:'memory-row-copy'},r.text||'暂无正文')),el('span',{class:'memory-row-status'},badge(statuses[r.state]),el('small',{},'v'+r.version)));
      }):el('p',{class:'empty'},'没有符合条件的内容。')),
      pagination(data,'records'));
    return el('div',{class:'memory-browser'},search(),el('div',{class:'memory-list-tools'},stats,el('details',{class:'md-help'},el('summary',{},section==='fragments'?'来源说明':'记忆如何变化'),el('p',{},intro))),lookupNotice(),data?el('div',{class:'memory-workspace'},list,detail()):notice(pending('data')?'正在读取记忆…':'尚未取得记忆快照。'));
  }
  function candidates(rows){return rows.length?el('div',{class:'md-candidates'},rows.map(c=>el('article',{class:'md-candidate'},el('div',{class:'label-row'},button(reference(c.source),()=>locateSource(c.source),{'data-md-source':c.source.id,disabled:!online()||s.busy,title:'查看当前来源；不会替换这条历史或试算结果'}),badge(c.selected?'选入':omission[c.omission]||'未选入',c.selected?'success':'muted')),el('p',{class:'subtle'},`${cues[c.cueKind]} · 匹配：${c.matchedTerms.join('、')||'无'}`),definition([['相关度 C',decimal(c.relevance)],['鲜活度 A',decimal(c.activation)],['重要性 S',decimal(c.importance)],['情绪计算值 E',decimal(c.emotion)],['排序分 P',decimal(c.priority)]])))):el('p',{class:'empty'},'没有候选记录。');}
  function traces(){const data=s.traces;return el('div',{},el('p',{class:'subtle'},'这里是实际检索记录；每条记录会标明是否已用于对话。'),button(pending('traces')?'读取中…':'刷新实际轨迹',loadTraces,{id:'md-traces-refresh',disabled:!online()||pending('traces')||s.busy}),data?el('div',{class:'section-gap'},data.records.length?data.records.map(t=>card(el('div',{class:'card-title'},'轮次 '+t.scope.turnId,badge(traceStatuses[t.status],t.status==='consumed'?'success':t.status==='invalidated'?'warning':'muted')),definition([['轨迹标识',t.id],['实际评估时间',time(t.evaluatedAt)],['会话 / 代次',t.scope.sessionId+' / '+t.scope.generation],['数据 / 策略版本',`${t.dataRevision} / ${t.policyRevision}`],['上下文用量',`${t.countedInputTokens} / ${t.inputTokenBudget} token`]]),el('details',{},el('summary',{},'查看候选与选入原因 · '+t.candidates.length+' 条'),candidates(t.candidates)))):card('实际召回轨迹',el('p',{class:'empty'},'暂时没有已保存的实际轨迹；不会用试算补成历史。')),pagination(data,'traces')):notice(pending('traces')?'正在读取实际轨迹…':'尚未取得实际轨迹。'));}
  function policy(){if(!s.data||!s.draft)return notice('读取记忆快照后可查看策略。');
    const problem=policyProblem(),sum=parameters.slice(2).reduce((n,[k])=>n+s.draft[k],0),p=s.data.policy;
    const edit=card('小幅调整记忆策略',el('p',{class:'subtle'},'保存后影响今后的记忆变化。可以先试算，再决定是否保存。'),definition([['当前策略','版本 '+p.revision],['生效时间',time(p.effectiveAt)]]),el('div',{class:'form-grid'},parameters.map(([key,label,min,max,step])=>field(label,'md-policy-'+key,s.draft[key],v=>changePolicy(key,v),{type:'number',min,max,step,disabled:s.busy,hint:`允许范围 ${min}–${max}`}))),el('p',{id:'md-weight-sum',class:'subtle'},'四项权重之和：'+(Number.isFinite(sum)?sum.toFixed(3):'未填写完整')),problem&&notice(problem,'warning'));
    if(s.conflict)edit.append(notice('设置已被更新，你的修改尚未保存。请刷新并核对最新参数。','warning'),el('div',{class:'tablescroll'},el('table',{},el('thead',{},el('tr',{},el('th',{},'参数'),el('th',{},'本页草稿'),el('th',{},'最新版本 '+p.revision))),el('tbody',{},parameters.map(([k,label])=>el('tr',{},el('th',{},label),el('td',{},String(s.draft[k])),el('td',{},p.policy[k])))))),button('已核对，保留本页参数',reviewPolicy,{id:'md-policy-review',disabled:s.stale||s.busy||!online()}));
    edit.append(el('div',{class:'actions'},button(s.busy?'处理中…':'保存策略',savePolicy,{id:'md-policy-save',class:'primary',disabled:!writable()||!!problem||!dirty()}),button('读取最新版本',loadData,{id:'md-policy-refresh',disabled:!online()||s.busy||pending('data')})),el('details',{},el('summary',{},'固定规则与计算含义'),el('p',{},'鲜活度按半衰期淡化，周期 = 记忆淡化基准 ×（1 + 2 × 重要性）。有效稳定人物事实保持鲜活度 1。'),el('p',{},'仅用户主动重提或确认可强化，同条记忆每天最多一次（北京时间）。排序分 = 相关度 ×（基础权重 + 鲜活度权重 × A + 重要性权重 × S + 情绪权重 × E）。'),el('p',{},'选入门槛为 0.35，普通长期记忆最多 6 条，并受上下文空间限制。相关度是线索覆盖度，不是语义概率。没有有效情绪证据时，E 的零值只作计算回退。')));
    const simulate=card('策略试算',el('p',{class:'subtle'},'仅供试算，不是实际对话记录，也不会改变记忆或保存设置。'),el('div',{class:'form-grid'},field('预测时的检索问题','md-preview-query',s.previewQuery,v=>{s.previewQuery=v;invalidatePreview();render();},{maxLength:1000,placeholder:'输入想检查的问题'}),select('预测时点','md-preview-horizon',s.horizon,[{value:'now',label:'现在'},{value:'1',label:'1 天后'},{value:'7',label:'7 天后'},{value:'30',label:'30 天后'}],v=>{s.horizon=v;invalidatePreview();render();})),button(pending('preview')?'试算中…':'比较当前策略与本页参数',runPreview,{id:'md-preview-run',disabled:!writable()||!!problem||pending('preview')}));
    if(s.preview){const v=s.preview;simulate.append(el('div',{id:'md-preview-result'},definition([['预测问题',v.query||'（未提供线索）'],['冻结的数据 / 策略版本',v.dataRevision+' / '+v.policyRevision],['假设新参数生效于',time(v.effectiveFrom)],['预测到',time(v.evaluatedAt)]]),el('div',{class:'md-compare'},el('section',{},el('h3',{},'沿用当前策略'),candidates(v.before)),el('section',{},el('h3',{},'使用本页参数'),candidates(v.after)))));}
    const history=card('策略历史与回退',notice('回退会替换本页草稿并保存为新版本，今后生效；不会恢复已遗忘的内容。'),s.data.policyHistory.map(h=>el('div',{class:'md-history'},el('div',{},el('strong',{},'版本 '+h.revision),el('p',{class:'subtle'},time(h.effectiveAt)+(h.restoredFromRevision===null?'':' · 参数来自版本 '+h.restoredFromRevision)),el('small',{},parameters.map(([k,label])=>label+' '+h.policy[k]).join(' · '))),button('选择回退',()=>{s.confirmation={kind:'rollback',target:h};render();},{'data-md-rollback':h.revision,disabled:!writable()||h.revision===p.revision}))),s.confirmation?.kind==='rollback'&&el('div',{class:'md-confirm'},notice('确认用版本 '+s.confirmation.target.revision+' 的参数建立新版本？本页未保存参数将被替换。','warning'),button('确认回退',()=>rollback(s.confirmation.target),{id:'md-confirm-rollback',disabled:!writable()}),button('取消',()=>{s.confirmation=null;render();})));
    return el('div',{},edit,simulate,history);
  }
  function maintenance(){const snap=host().snapshot,modules=snap.modules.filter(m=>['memory_turn','summary','retrieval','memory_background','memory'].includes(m.id)),events=snap.events.filter(e=>modules.some(m=>m.id===e.moduleId));
    return el('div',{},card('维护与遗忘状态',el('p',{},'长期记忆不会因淡化而自动删除。对话原文最多保留 30 天、300 MB；删除的长期记忆可在 30 天内申请恢复，彻底清理后无法恢复。'),notice('以下是最近状态，不代表所有维护都已完成；没有记录时显示未知。'),definition([['模块观测快照',time(snap.runtime.observedAt)]]),button('查看全部状态的内容',()=>{s.recordState='all';s.offset=0;host().openSection('dynamics');},{id:'md-show-deleted'}),button('打开维护模型配置',()=>host().openMaintenanceSettings()),button('查看运行记录',()=>host().openEvents())),el('div',{class:'grid'},modules.length?modules.map(m=>card(m.label,badge(statuses[m.status]||m.status,m.status==='error'?'error':'muted'),el('p',{},m.detail),definition([['处理中',m.activeJobs],['调用次数',m.calls],['最近观测',time(m.lastObservedAt)]]),m.lastError&&notice(m.lastError,'error'))):notice('当前快照没有记忆维护模块的观测。')),card('最近维护事件',events.length?events.map(e=>el('article',{class:'md-candidate'},el('strong',{},({completed:'完成',failed:'失败',started:'开始',cancelled:'取消',state:'状态'})[e.kind]||e.kind),el('small',{},' · '+time(e.at)),textBlock(e.message))):el('p',{class:'empty'},'暂无维护记录，尚不能确认是否完成。')));
  }
  function view(section){sync();return el('div',{class:'memory-dynamics'},s.busy&&notice('正在处理，请等待结果；目前尚未确认更改完成。'),s.error&&notice(s.error,'error'),s.message&&notice(s.message,'success'),s.stale&&s.data&&notice('这是上次读取的内容，请刷新后再操作。','warning'),section!=='traces'&&s.data&&el('div',{class:'version-strip'},el('span',{},'记忆数据版本 '+s.data.dataRevision),el('span',{},'策略版本 '+s.data.policy.revision),el('small',{},'评估于 '+time(s.data.evaluatedAt))),section==='policy'?policy():section==='traces'?traces():section==='maintenance'?maintenance():records(section));}
  return {view,load,sync,dispose(){epoch++;invalidateReads();}};
}
