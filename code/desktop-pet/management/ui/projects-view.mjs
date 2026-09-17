import {query,rebase} from './api.mjs';
import {el,button,badge,notice,field,definition,time} from './dom.mjs';

// Project index 0.1.0. Only metadata; never fetch project files or send Codex tasks.
const empty=()=>({name:'',abstract:'',rootPath:'',entryFile:'',hostId:'',threadId:''});
const fields=p=>({name:p.name,abstract:p.abstract,rootPath:p.detailRef.rootPath,entryFile:p.detailRef.entryFile??'',hostId:p.codexTarget?.hostId??'',threadId:p.codexTarget?.threadId??''});
const validEntry=p=>p&&typeof p.id==='string'&&p.id.length>0&&typeof p.name==='string'&&typeof p.abstract==='string'&&p.detailRef&&typeof p.detailRef.rootPath==='string'&&(p.detailRef.entryFile===undefined||typeof p.detailRef.entryFile==='string')&&(p.codexTarget===undefined||(p.codexTarget&&typeof p.codexTarget.hostId==='string'&&typeof p.codexTarget.threadId==='string'))&&Number.isSafeInteger(p.version)&&p.version>0&&typeof p.updatedAt==='string'&&Number.isFinite(Date.parse(p.updatedAt));
const freshDraft=p=>({form:p?fields(p):empty(),base:p?fields(p):empty(),version:p?.version??0,latest:p??null,stale:false,conflict:false,conflictSource:null,missing:false,uncertain:false});
const length=s=>Array.from(s).length;
function problem(f){
 if(!f.name.trim()||length(f.name)>120)return '请填写项目名称，最多 120 字。';
 if(length(f.abstract)>480)return '项目摘要最多 480 字。';
 if(!f.rootPath.startsWith('/')||length(f.rootPath)>4096||f.rootPath.includes('\0')||f.rootPath.split(/[\\/]/).includes('..'))return '项目目录应是本机绝对路径，不能包含上级目录跳转。';
 if(f.entryFile&&(f.entryFile.startsWith('/')||f.entryFile.includes('\\')||f.entryFile.includes(':')||f.entryFile.includes('\0')||f.entryFile.split('/').includes('..')||length(f.entryFile)>1024))return '文档入口应是项目内的相对路径，不能包含上级目录或网址。';
 if(Boolean(f.hostId.trim())!==Boolean(f.threadId.trim()))return '关联任务时，请同时填写主机标识和任务标识；也可以同时留空。';
 if(f.hostId.includes('\0')||f.threadId.includes('\0'))return '任务关联信息包含无效字符。';
 return '';
}
export function createProjectsView(client,render,getHost){
 const s={page:null,query:'',appliedQuery:'',offset:0,selected:null,drafts:new Map(),stale:true,error:'',message:'',busy:false,confirmation:null};
 let identity=null,connection=null,epoch=0,sequence=0;
 const reads=new Map();
 const host=()=>getHost(),online=()=>host().connection==='online';
 const draft=()=>s.drafts.get(s.selected);
 const canWrite=()=>online()&&!s.stale&&!s.busy&&draft()&&!draft().stale&&!draft().conflict&&!draft().missing&&!draft().uncertain;
 function invalidate(){for(const r of reads.values())r.controller.abort();reads.clear();sequence++;}
 function sync(){
  const h=host(),next=[h.authEpoch,h.instanceId].join('/');
  if(identity!==next||connection!==h.connection){
   const changed=identity!==null&&identity!==next;identity=next;connection=h.connection;epoch++;invalidate();s.stale=true;s.confirmation=null;
   for(const d of s.drafts.values()){d.stale=true;if(changed){d.conflict=true;d.conflictSource="connection";}}
  }
 }
 function handleError(e){
  if(e.name==='AbortError')return;
  s.error=[s.error,e.message].filter(Boolean).join("\n");
  if(e.status===401||e.status===403)host().onError(e);
 }
 async function read(kind,url,accept,onMissing){
  if(!online())return;reads.get(kind)?.controller.abort();
  const controller=new AbortController(),ticket={controller,id:++sequence,epoch};reads.set(kind,ticket);render();
  try{const data=await client.request(url,{signal:controller.signal});if(reads.get(kind)!==ticket||ticket.epoch!==epoch)return;accept(data);}
  catch(e){if(reads.get(kind)===ticket&&ticket.epoch===epoch){if(e.status===404&&onMissing)onMissing();else handleError(e);}}
  finally{if(reads.get(kind)===ticket)reads.delete(kind);render();}
 }
 function loadList(){
  if(!online()||s.busy)return;const offset=s.offset,q=s.appliedQuery;s.error='';s.stale=true;
  return read('list',query('/api/projects',{query:q,offset,limit:25}),page=>{
   if(!page||!Array.isArray(page.items)||!page.items.every(validEntry)||new Set(page.items.map(x=>x.id)).size!==page.items.length||!Number.isSafeInteger(page.total)||page.total<0||page.offset!==offset||page.limit!==25||page.items.length>25||page.items.length>Math.max(0,page.total-offset))throw Error('项目列表返回了无法识别的内容，请刷新核对。');
   s.page=page;s.stale=false;
   const d=s.drafts.get('new');if(d)d.stale=false;
  });
 }
 function loadSelected(){
  const id=s.selected;if(!id||id==='new'||s.busy)return;
  const d=draft();if(d)d.stale=true;
  return read('detail','/api/projects/'+encodeURIComponent(id),entry=>{
   if(!validEntry(entry)||entry.id!==id)throw Error('项目详情返回了无法识别的内容，请刷新核对。');
   let current=s.drafts.get(id);
   if(!current){current=freshDraft(entry);s.drafts.set(id,current);}
   else{current.latest=entry;current.stale=false;current.missing=false;if(current.version!==entry.version||JSON.stringify(current.base)!==JSON.stringify(fields(entry))){current.conflict=true;current.conflictSource="content";}}
  },()=>{const current=s.drafts.get(id);if(current){current.missing=true;current.stale=true;current.latest=null;}s.confirmation=null;s.error=[s.error,'这张索引卡片已不存在。本页草稿保留，不会自动重新创建。'].filter(Boolean).join('\n');});
 }
 async function refresh(){sync();if(!online()||s.busy)return;await Promise.all([loadList(),loadSelected()]);}
 function select(id){if(s.busy)return;reads.get('detail')?.controller.abort();reads.delete('detail');s.selected=id;s.confirmation=null;s.error='';s.message='';render();loadSelected();}
 function create(){if(!online()||s.busy||s.stale)return;reads.get('detail')?.controller.abort();reads.delete('detail');s.selected='new';s.confirmation=null;s.error='';s.message='';if(!draft())s.drafts.set('new',freshDraft());render();document.getElementById('project-name')?.focus({preventScroll:true});}
 function edit(key,value){const d=draft();if(!d||s.busy)return;d.form[key]=value;const confirming=!!s.confirmation;s.confirmation=null;s.message='';s.error='';if(confirming)render();}
 function review(){const d=draft();if(!d||s.busy||!online()||d.stale||d.missing||(!d.latest&&s.selected!=='new'))return;
  if(d.latest){d.form=rebase(d.base,d.form,fields(d.latest));d.base=fields(d.latest);d.version=d.latest.version;}
  d.conflict=false;d.conflictSource=null; // An uncertain creation still cannot be retried: the API has no idempotency key.
  if(s.selected!=='new')d.uncertain=false;
  s.confirmation=null;s.error='';render();
 }
 async function mutate(kind){
  if(!canWrite())return;const d=draft(),selected=s.selected;
  if(kind==='save'){const issue=problem(d.form);if(issue){s.error=issue;render();return;}}
  if(kind==='remove'&&(!s.confirmation||s.confirmation.id!==selected||s.confirmation.version!==d.version))return;
  const input=kind==='save'?{...(selected==='new'?{}:{id:selected}),expectedVersion:d.version,name:d.form.name.trim(),abstract:d.form.abstract,detailRef:{rootPath:d.form.rootPath,...(d.form.entryFile?{entryFile:d.form.entryFile}:{})},...(d.form.hostId.trim()?{codexTarget:{hostId:d.form.hostId.trim(),threadId:d.form.threadId.trim()}}:{})}:{id:selected,expectedVersion:d.version};
  invalidate();const started=epoch;s.busy=true;s.error='';s.message='';s.confirmation=null;render();
  try{
   const result=await client.request('/api/projects/'+kind,{method:'POST',body:input});
   if(started!==epoch){d.uncertain=true;d.stale=true;return;}
   if(kind==='save'){
    if(!validEntry(result)||(selected!=='new'&&result.id!==selected)||result.version!==input.expectedVersion+1)throw Error('保存回执无法匹配，请核对项目列表。');
    const saved=freshDraft(result);s.drafts.set(result.id,saved);if(selected==='new')s.drafts.delete('new');s.selected=result.id;s.message='项目索引已保存。';
   }else{
    if(result?.id!==selected||result.removed!==true)throw Error('移除回执无法匹配，请核对项目列表。');
    s.drafts.delete(selected);s.selected=null;s.message='已移除索引卡片，项目文件、Codex 任务和陪伴记忆均保留。';
   }
  }catch(e){
   if(started!==epoch){d.uncertain=true;d.stale=true;}
   else if(e.status===409){d.conflict=true;d.conflictSource='content';d.stale=true;s.error='索引版本已变化。草稿已保留，请核对最新内容后继续。';}
   else if(e.status===404){d.missing=true;d.stale=true;s.error='这张索引卡片已不存在。本页草稿保留，不会自动重新创建。';}
   else if(!e.status||e.status>=500){d.uncertain=true;d.stale=true;s.error='尚未确认这次操作是否保存成功。请刷新列表核对，不会自动重复提交。';}
   else handleError(e);
  }finally{
   s.busy=false;render();if(started===epoch&&online()){await loadList();if(d.conflict&&!d.missing)await loadSelected();}
  }
 }
 function details(){
  const d=draft();if(!d)return el('section',{class:'project-detail project-empty'},el('h2',{},s.selected?'正在读取项目…':'选择一个项目'),el('p',{class:'subtle'},'查看资料位置，或添加一张项目索引卡片。'));
  const id=s.selected,newItem=id==='new',locked=s.busy;
  const panel=el('section',{class:'project-detail','data-detail-id':'project-'+id},el('div',{class:'section-head'},el('div',{},el('p',{class:'page-eyebrow'},newItem?'新项目':'项目资料'),el('h2',{},newItem?'添加项目':d.latest?.name||d.form.name)),!newItem&&badge('版本 '+d.version)),
   d.uncertain&&notice('操作结果尚未确认。请核对列表中的卡片；新增草稿不会再次提交，避免重复创建。','warning'),
   d.missing&&notice('索引卡片已不存在，草稿仍保留。','warning'),
   d.stale&&!d.missing&&notice('这是上次读取的内容，请刷新后再保存。','warning'));
  if(d.conflict){
   panel.append(notice(d.conflictSource==='connection'?'连接已更新。请核对最新资料后保留本页改动。':'这张卡片已在其他位置更新。请对照最新资料后保留本页改动。','warning'));
   if(d.latest)panel.append(el('details',{class:'project-comparison'},el('summary',{},'查看最新保存内容'),definition([['名称',d.latest.name],['摘要',d.latest.abstract],['项目目录',d.latest.detailRef.rootPath],['文档入口',d.latest.detailRef.entryFile||'未填写'],['主机标识',d.latest.codexTarget?.hostId||'未填写'],['任务标识',d.latest.codexTarget?.threadId||'未填写'],['版本',d.latest.version]])));
   panel.append(button('已核对，保留我的改动',review,{id:'project-review',disabled:!online()||d.stale||s.busy||d.missing}));
  }
  panel.append(el('div',{class:'project-form'},field('项目名称','project-name',d.form.name,v=>edit('name',v),{maxLength:240,disabled:locked}),field('短摘要','project-abstract',d.form.abstract,v=>edit('abstract',v),{type:'textarea',maxLength:960,disabled:locked,hint:'用几句话说明这个项目，最多 480 字。'}),
   field('项目目录','project-root',d.form.rootPath,v=>edit('rootPath',v),{maxLength:4096,disabled:locked,placeholder:'/path/to/your/project'}),field('文档入口（可选）','project-entry',d.form.entryFile,v=>edit('entryFile',v),{maxLength:1024,disabled:locked,placeholder:'docs/README.md',hint:'填写相对项目目录的位置；这里只保存引用，不读取项目文件。'}),
   el('details',{class:'project-target'},el('summary',{},'关联现有 Codex 任务 · 尚未核验连接'),el('p',{class:'subtle'},'仅保存任务关联，尚未核验连接。'),el('div',{class:'form-grid'},field('主机标识','project-host',d.form.hostId,v=>edit('hostId',v),{disabled:locked}),field('任务标识','project-thread',d.form.threadId,v=>edit('threadId',v),{disabled:locked}))),
   el('div',{class:'actions'},button(s.busy?'处理中…':'保存索引',()=>mutate('save'),{id:'project-save',class:'primary',disabled:!canWrite()}),newItem&&button('放弃这份草稿',()=>{s.confirmation={id,kind:'discard'};render();document.getElementById('project-remove-cancel')?.focus({preventScroll:true});},{id:'project-discard',disabled:s.busy}),!newItem&&button('移除索引卡片',()=>{if(canWrite()){s.confirmation={id,version:d.version,kind:'remove'};render();document.getElementById('project-remove-cancel')?.focus({preventScroll:true});}},{id:'project-remove',disabled:!canWrite()}))));
  if(s.confirmation?.id===id)panel.append(el('section',{class:'md-confirm',role:'group','aria-label':newItem?'确认放弃新建草稿':'确认移除索引卡片',onKeydown:e=>{if(e.key==='Escape'){e.preventDefault();cancelRemove();}}},el('h3',{},newItem?'放弃这份新建草稿？':'移除这张索引卡片？'),el('p',{},newItem?'只清除本页草稿，已经保存的卡片仍保留。操作结果未知时，请先核对列表。':'不删除项目文件、Codex 任务或陪伴记忆。'),el('p',{},d.latest?.name||d.form.name),button(newItem?'确认放弃草稿':'确认移除卡片',()=>{if(newItem){s.drafts.delete('new');s.selected=null;s.confirmation=null;render();document.getElementById('project-new')?.focus({preventScroll:true});}else mutate('remove');},{id:'project-remove-confirm',disabled:newItem?s.busy:!canWrite()}),button(newItem?'保留草稿':'保留卡片',cancelRemove,{id:'project-remove-cancel',disabled:s.busy})));
  if(!newItem)panel.append(el('details',{class:'project-metadata'},el('summary',{},'索引信息'),definition([['稳定标识',id],['最近保存',time(d.latest?.updatedAt)]])));
  return panel;
 }
 function cancelRemove(){s.confirmation=null;render();document.getElementById(s.selected==='new'?'project-discard':'project-remove')?.focus({preventScroll:true});}
 function search(){s.appliedQuery=s.query;s.offset=0;s.confirmation=null;loadList();}
 function view(){
  const pending=reads.has('list')||reads.has('detail');
  const list=el('section',{class:'project-list-pane'},el('div',{class:'project-list-heading'},el('h2',{},'项目'),el('small',{},s.page?`${s.page.total} 张索引卡片`:'尚未读取')),
   el('div',{class:'record-list project-rows',id:'projects-rows','data-scroll-key':'projects-rows',tabIndex:0,'aria-label':'项目索引列表'},s.page?s.page.items.length?s.page.items.map(p=>button(el('div',{},el('div',{class:'project-row-heading'},el('strong',{},p.name),el('small',{},'v'+p.version)),el('p',{},p.abstract||'暂无摘要'),el('small',{class:'project-row-path'},p.detailRef.rootPath)),()=>select(p.id),{id:'project-row-'+p.id,'data-project-id':p.id,class:'record-row','aria-pressed':s.selected===p.id,disabled:s.busy})):el('p',{class:'empty'},'没有符合条件的项目。'):el('p',{class:'empty'},pending?'正在读取项目索引…':'暂时无法读取项目索引。')),
   s.page&&el('div',{class:'actions project-pagination'},button('上一页',()=>{s.offset=Math.max(0,s.offset-25);loadList();},{id:'projects-prev',disabled:!online()||pending||s.busy||s.offset===0}),el('small',{},`${s.page.total?Math.min(s.page.offset+1,s.page.total):0}–${Math.min(s.page.offset+s.page.items.length,s.page.total)} / ${s.page.total}`),button('下一页',()=>{s.offset+=25;loadList();},{id:'projects-next',disabled:!online()||pending||s.busy||s.offset+25>=s.page.total})));
  return el('div',{class:'projects-page'},el('p',{class:'subtle'},'保存项目名称、摘要和资料位置。项目索引与陪伴记忆分开管理。'),
   s.error&&notice(s.error,'error'),s.message&&notice(s.message,'success'),s.stale&&s.page&&notice('以下是上次读取的项目列表，请刷新核对。','warning'),
   el('form',{class:'searchbar',onSubmit:e=>{e.preventDefault();if(online()&&!s.busy)search();}},field('查找项目','projects-query',s.query,v=>{s.query=v},{maxLength:200}),el('div',{class:'actions'},el('button',{id:'projects-search',type:'submit',disabled:!online()||pending||s.busy},'查找'),button('刷新索引',refresh,{id:'projects-refresh',disabled:!online()||pending||s.busy}),button('添加项目',create,{id:'project-new',class:'primary',disabled:!online()||s.stale||s.busy}))),
   el('div',{class:'project-workspace'},list,details()));
 }
 return {sync,refresh,view,dispose(){epoch++;invalidate();}};
}
