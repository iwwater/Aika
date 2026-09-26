import {el,button,badge,notice,field,select,definition,time} from './dom.mjs';

const protocols={acp:'ACP Agent',mcp:'MCP 工具'};
const states={prepared:'待确认',dispatched:'已派发',running:'运行中',succeeded:'已完成',failed:'失败',uncertain:'结果未知',cancelled:'已取消'};
const profileFor=(snapshot,protocol)=>snapshot?.profiles?.[protocol];
function editableProfile(profile){if(!profile)return null;const {environmentKeys,...value}=profile;return value;}

export function createWorkProtocolView(client,render,online){
 const s={snapshot:null,available:null,profileText:'{\n  "acp": null,\n  "mcp": null\n}',profileDirty:false,protocol:'acp',title:'本机工程任务',directory:'',instruction:'',tools:[],toolName:'',argumentsText:'{}',grantsText:'[]',selected:null,editorOperation:null,confirming:null,receipt:null,error:'',message:'',busy:false};
 const profiles=()=>s.snapshot?.profiles;
 const current=()=>s.snapshot?.requests?.find(row=>row.request.operationId===s.selected);
 const set=(key,value)=>{s[key]=value;render();};
 function error(e){s.error=e?.message||'工作协议操作未完成。';if(e?.status===401||e?.status===403)render();}
 function load(){
  if(!online())return Promise.resolve();
  return client.request('/api/work-protocol').then(data=>{
   if(!data||!Array.isArray(data.requests)||!data.profiles||!Number.isSafeInteger(data.profiles.revision))throw Error('工作协议状态格式无效。');
   s.snapshot=data;s.available=true;
   if(!s.profileDirty)s.profileText=JSON.stringify({acp:editableProfile(data.profiles.acp)||null,mcp:editableProfile(data.profiles.mcp)||null},null,2);
   if(s.selected&&!data.requests.some(row=>row.request.operationId===s.selected))s.selected=null;
  }).catch(e=>{s.available=false;if(e?.status!==503)error(e);}).finally(render);
 }
 async function saveProfiles(){
  if(!online()||s.busy)return;s.busy=true;s.error='';s.message='';render();
  try{
   const parsed=JSON.parse(s.profileText);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error('配置必须是 JSON 对象。');
   const result=await client.request('/api/work-protocol/profiles',{method:'PUT',body:{expectedRevision:profiles()?.revision??0,profiles:parsed}});
   s.profileDirty=false;s.message='执行器配置已保存并在当前实例生效。';
   await load();if(result?.profiles?.revision!==undefined&&s.snapshot?.profiles?.revision!==result.profiles.revision)throw Error('保存回执版本不匹配。');
  }catch(e){error(e);}finally{s.busy=false;render();}
 }
 async function discoverTools(){
  if(!online()||s.busy||!profiles()?.mcp)return;s.busy=true;s.error='';s.message='只读取 MCP 工具目录，不会调用工具。';render();
  try{const result=await client.request('/api/work-protocol/tools');if(!Array.isArray(result?.tools)||result.tools.length>10000)throw Error('MCP 工具目录格式无效。');s.tools=result.tools;
   if(!s.tools.some(tool=>tool.name===s.toolName))s.toolName=s.tools[0]?.name||'';s.message=`已发现 ${s.tools.length} 个工具；尚未执行任何工具。`;
  }catch(e){error(e);}finally{s.busy=false;render();}
 }
 async function prepare(){
  const profile=profileFor(s.snapshot,s.protocol);if(!online()||s.busy||!profile)return;
  if(!s.title.trim()||!s.instruction.trim()){s.error='请填写任务标题和说明。';render();return;}
  let permissionGrant,toolCall;
  try{permissionGrant=JSON.parse(s.grantsText);if(!Array.isArray(permissionGrant)||permissionGrant.some(x=>typeof x!=='string'))throw Error();
   if(s.protocol==='mcp'){const args=JSON.parse(s.argumentsText);if(!args||typeof args!=='object'||Array.isArray(args))throw Error();toolCall={name:s.toolName,arguments:args};}
  }catch{s.error='MCP 参数必须是 JSON 对象，授权必须是 JSON 字符串数组。';render();return;}
  const target={title:s.title.trim(),...(s.protocol==='acp'&&s.directory.trim()?{directory:s.directory.trim()}:{})};
  s.busy=true;s.error='';s.message='';s.receipt=null;render();
  try{const value=await client.request('/api/work-protocol/prepare',{method:'POST',body:{protocol:s.protocol,executorId:profile.executorId,target,instruction:s.instruction,
    permissionGrant,...(toolCall?{toolCall}:{})}});
   if(!value?.request||value.request.protocol!==s.protocol||value.request.executorId!==profile.executorId||value.request.revision!==1)throw Error('服务端待确认请求与表单不匹配。');
   s.selected=value.request.operationId;s.message='请求已持久化为待确认状态。核对完整目标、正文、工具参数和权限后再执行。';await load();
  }catch(e){error(e);}finally{s.busy=false;render();}
 }
 async function revise(){
  const row=current();if(!row||s.busy||row.receipt||row.dispatchStarted||s.editorOperation!==row.request.operationId)return;
  const profile=profileFor(s.snapshot,s.protocol);if(!profile)return;
  let permissionGrant,toolCall;
  try{permissionGrant=JSON.parse(s.grantsText);if(!Array.isArray(permissionGrant)||permissionGrant.some(x=>typeof x!=='string'))throw Error();
   if(s.protocol==='mcp'){const args=JSON.parse(s.argumentsText);if(!args||typeof args!=='object'||Array.isArray(args))throw Error();toolCall={name:s.toolName,arguments:args};}
  }catch{s.error='MCP 参数或授权格式无效。';render();return;}
  s.busy=true;s.error='';render();
  try{await client.request('/api/work-protocol/revise',{method:'POST',body:{operationId:row.request.operationId,expectedRevision:row.request.revision,
    updates:{protocol:s.protocol,executorId:profile.executorId,target:{title:s.title.trim(),...(s.protocol==='acp'&&s.directory.trim()?{directory:s.directory.trim()}:{})},instruction:s.instruction,permissionGrant,...(toolCall?{toolCall}:{})}}});
   s.message='请求已修订，旧确认版本已失效。请重新核对新版本。';await load();
  }catch(e){error(e);}finally{s.busy=false;render();}
 }
 function loadIntoEditor(){
  const row=current();if(!row||row.forgotten)return;const request=row.request;
  s.protocol=request.protocol;s.title=request.target.title;s.directory=request.target.directory||'';s.instruction=request.instruction;
  s.toolName=request.toolCall?.name||'';s.argumentsText=JSON.stringify(request.toolCall?.arguments||{},null,2);s.grantsText=JSON.stringify(request.permissionGrant||[]);s.editorOperation=request.operationId;
  s.message='已载入当前版本。修改后保存会增加 revision，并使旧确认卡失效。';render();
 }
 async function confirm(){
  const row=current(),request=row?.request;if(!request||s.busy||row.forgotten||row.receipt||row.dispatchStarted)return;
  if(request.executorRevision!==undefined&&request.executorRevision!==profiles()?.revision){s.error='执行器配置已变化，请重新准备并核对。';s.confirming=null;render();return;}
  s.busy=true;s.confirming=null;s.error='';s.message='正在提交这次执行确认。断连时状态会保留为未知，不会自动重发。';render();
  try{const value=await client.request('/api/work-protocol/confirm',{method:'POST',body:{operationId:request.operationId,expectedRevision:request.revision}});
   s.receipt=value.receipt;s.message='已收到本次协议回执。';await load();
  }catch(e){error(e);}finally{s.busy=false;render();}
 }
 async function cancel(){
  const row=current(),request=row?.request;if(!request||s.busy||row.forgotten||!row.dispatchStarted||row.receipt&&['succeeded','failed','cancelled','uncertain'].includes(row.receipt.status))return;
  s.busy=true;s.error='';render();try{const value=await client.request('/api/work-protocol/cancel',{method:'POST',body:{operationId:request.operationId,expectedRevision:request.revision}});s.receipt=value.receipt;s.message='取消请求已取得回执；未确认时会保持未知状态。';await load();}catch(e){error(e);}finally{s.busy=false;render();}
 }
 async function forget(){
  const row=current();if(!row||s.busy)return;
  if(!globalThis.confirm('遗忘将清除 journal 中的任务正文与回执内容，并从 Timeline 移除此来源。外部执行器上的副作用不会因此撤销。'))return;
  s.busy=true;s.error='';render();try{await client.request('/api/work-protocol/forget',{method:'POST',body:{operationId:row.request.operationId}});s.message='本机任务内容已遗忘；外部执行结果不受此操作影响。';s.selected=null;await load();}catch(e){error(e);}finally{s.busy=false;render();}
 }
 function profileEditor(){return el('details',{class:'protocol-profiles'},el('summary',{},'ACP / MCP 执行器配置（本机私密保存）'),el('p',{class:'subtle'},'配置只登记绝对路径命令，不会在保存或启动时运行。连接检查只发现工具；实际任务仅在确认卡确认后派发。环境变量值不会回显；同一 executorId 的配置省略 env 时保留已保存值。'),
  field('执行器配置 JSON','protocol-profiles-json',s.profileText,value=>{s.profileText=value;s.profileDirty=true},{type:'textarea',maxLength:240000,disabled:s.busy,hint:'格式：{ "acp": { "executorId", "label", "command", "args", "cwd"? }, "mcp": { ... , "trustedToolPolicies" } }。'}),
  profiles()?.acp?.environmentKeys?.length>0&&notice('ACP 私密环境变量已保存：'+profiles().acp.environmentKeys.join(', ')),profiles()?.mcp?.environmentKeys?.length>0&&notice('MCP 私密环境变量已保存：'+profiles().mcp.environmentKeys.join(', ')),
  button('保存并应用',saveProfiles,{id:'protocol-profiles-save',class:'primary',disabled:!online()||s.busy}));}
 function requestDetail(){
  const row=current();if(!row)return el('p',{class:'empty'},'选择一条 ACP/MCP 记录以查看确认内容。');const r=row.request,receipt=row.receipt;
  const staleProfile=!row.forgotten&&r.executorRevision!==undefined&&r.executorRevision!==profiles()?.revision;
  return el('section',{class:'task-receipt protocol-request','data-detail-id':'protocol-'+r.operationId},el('div',{class:'section-head'},el('h3',{},r.target.title),badge(row.forgotten?'已遗忘':staleProfile?'配置已变化':receipt?states[receipt.status]||'未知':row.dispatchStarted?'执行中':'待确认',row.forgotten?'muted':staleProfile||receipt?.status!=='succeeded'?'warning':'success')),
   staleProfile&&notice('此请求绑定的执行器配置已变更。请用当前配置重新准备并核对，不会自动改派。','warning'),
   definition([['协议',protocols[r.protocol]||r.protocol],['执行器',r.executorId],['执行器配置版本',r.executorRevision??'旧记录'],['工作目录',r.target.directory||'执行器默认目录'],['请求版本',r.revision],['状态时间',receipt?time(receipt.updatedAt):time(r.requestedAt)]]),
   el('h4',{},'本次确认内容'),el('div',{class:'text-block'},row.forgotten?'内容已按要求遗忘。':r.instruction),
   r.toolCall&&!row.forgotten&&[el('p',{class:'subtle'},'工具：'+r.toolCall.name),el('pre',{class:'protocol-json'},JSON.stringify(r.toolCall.arguments,null,2))],
   r.permissionGrant.length>0&&!row.forgotten&&notice('授权：'+r.permissionGrant.join(', '),'warning'),
   receipt?.summary&&!row.forgotten&&el('section',{},el('h4',{},'执行回执'),el('div',{class:'text-block tall'},receipt.summary)),
   receipt?.error&&notice(receipt.error.message,receipt.status==='failed'?'error':'warning'),
   el('div',{class:'actions'},!row.forgotten&&!row.dispatchStarted&&!receipt&&button('载入编辑',loadIntoEditor,{id:'protocol-load-edit',disabled:!online()||s.busy}),!row.forgotten&&!row.dispatchStarted&&!receipt&&button('保存修订',revise,{id:'protocol-revise',disabled:!online()||s.busy||s.editorOperation!==r.operationId}),!row.forgotten&&!row.dispatchStarted&&!receipt&&!staleProfile&&button('打开确认卡',()=>{s.confirming=r.operationId;render();},{id:'protocol-review',disabled:!online()||s.busy}),row.dispatchStarted&&!receipt&&button('请求取消',cancel,{id:'protocol-cancel',disabled:!online()||s.busy}),!row.forgotten&&button('遗忘本机记录',forget,{id:'protocol-forget',disabled:!online()||s.busy})));
 }
 function confirmation(){
  const row=current(),request=row?.request;if(!request||s.confirming!==request.operationId)return null;
  const staleProfile=request.executorRevision!==undefined&&request.executorRevision!==profiles()?.revision;
  const profile=profileFor(s.snapshot,request.protocol);
  return el('dialog',{id:'protocol-confirm-dialog',class:'task-confirm','aria-labelledby':'protocol-confirm-title',onCancel:e=>{e.preventDefault();s.confirming=null;render();}},
   el('h2',{id:'protocol-confirm-title'},'确认执行这项 '+protocols[request.protocol]+' 请求？'),definition([['执行器',request.executorId],['执行程序',profile?.command||'配置已变化'],['启动参数',JSON.stringify(profile?.args||[])],['执行器工作目录',profile?.cwd||'程序默认目录'],['执行器配置版本',request.executorRevision??'旧记录'],['环境变量键',(profile?.environmentKeys||[]).join(', ')||'无'],['目标',request.target.title],['任务工作目录',request.target.directory||'执行器默认目录'],['请求版本',request.revision]]),
   el('h3',{},request.protocol==='mcp'?'任务说明':'派发正文'),el('div',{class:'text-block',id:'protocol-confirm-instruction'},request.instruction),
   request.toolCall&&[el('h3',{},'工具参数：'+request.toolCall.name),el('pre',{class:'protocol-json'},JSON.stringify(request.toolCall.arguments,null,2))],
   request.permissionGrant.length>0&&notice('本次授权：'+request.permissionGrant.join(', '),'warning'),
   notice('外部副作用仅在确认后发生。断连或进程重启可能留下未知结果，系统不会自动重发。'),
   staleProfile&&notice('当前执行器配置与请求版本不一致；请返回后重新准备。','warning'),
   el('div',{class:'actions'},button('返回',()=>{s.confirming=null;render();},{id:'protocol-confirm-back'}),button('确认执行',confirm,{id:'protocol-confirm-send',class:'primary',disabled:!online()||s.busy||staleProfile})));
 }
 function view(){
  const profile=profileFor(s.snapshot,s.protocol),rows=s.snapshot?.requests||[],mcpTool=s.tools.find(tool=>tool.name===s.toolName);
  const protocolChoice=select('协议','protocol-kind',s.protocol,Object.entries(protocols).map(([value,label])=>({value,label})),value=>{s.protocol=value;s.tools=[];render();},{disabled:s.busy});
  const profileStatus=el('div',{class:'task-connections'},...Object.entries(protocols).map(([key,label])=>el('div',{},el('span',{},label),badge(profileFor(s.snapshot,key)?.label||'未配置',profileFor(s.snapshot,key)?'success':'muted'))),button('刷新协议记录',load,{id:'protocol-refresh',disabled:!online()||s.busy}));
  const composer=el('section',{class:'protocol-composer'},el('h3',{},'新建显式确认任务'),protocolChoice,
   profile&&el('p',{class:'subtle'},'当前执行器：'+profile.label+' · '+profile.command),
   s.protocol==='mcp'&&[button('发现 MCP 工具',discoverTools,{id:'protocol-discover-tools',disabled:!online()||s.busy||!profile}),s.tools.length>0&&select('MCP 工具','protocol-tool',s.toolName,s.tools.map(tool=>({value:tool.name,label:tool.name+(tool.readOnly?' · 本机判定只读':' · 需显式授权')})),value=>set('toolName',value),{disabled:s.busy}),mcpTool&&el('p',{class:'subtle'},mcpTool.description||'服务未提供工具说明。')],
   field('任务标题','protocol-title',s.title,value=>set('title',value),{maxLength:500,disabled:s.busy}),
   s.protocol==='acp'&&field('工作目录（绝对路径，可选）','protocol-directory',s.directory,value=>set('directory',value),{maxLength:2048,disabled:s.busy,hint:'留空时使用执行器配置的工作目录。'}),
   field(s.protocol==='acp'?'派发给 Agent 的完整任务':'本次调用说明','protocol-instruction',s.instruction,value=>set('instruction',value),{type:'textarea',maxLength:20000,disabled:s.busy}),
   s.protocol==='mcp'&&field('工具参数 JSON 对象','protocol-arguments',s.argumentsText,value=>set('argumentsText',value),{type:'textarea',maxLength:65536,disabled:s.busy,hint:'确认卡会原样显示本次参数。'}),
   s.protocol==='mcp'&&field('本次授权 JSON 字符串数组','protocol-grants',s.grantsText,value=>set('grantsText',value),{maxLength:4096,disabled:s.busy,hint:mcpTool?.requiredGrant?'此工具要求：'+mcpTool.requiredGrant:'未配置为只读的工具默认要求 write 授权。'}),
   profile?button('生成待确认卡',prepare,{id:'protocol-prepare',class:'primary',disabled:!online()||s.busy||s.protocol==='mcp'&&!s.toolName}):notice('配置并保存此协议执行器后，才可创建请求。','warning'));
  const history=el('section',{class:'task-history protocol-history'},el('h3',{},'ACP / MCP 记录'),el('p',{class:'subtle'},'待确认任务在本机持久保存；遗忘会擦除本机正文和 Timeline 副本。'),
   el('div',{class:'record-list protocol-record-list',tabIndex:0,'aria-label':'ACP/MCP 工作记录'},rows.length?rows.map(row=>button(el('div',{},el('div',{class:'section-head'},badge(row.forgotten?'已遗忘':row.receipt?states[row.receipt.status]||'未知':row.dispatchStarted?'执行中':'待确认'),el('small',{},row.request.protocol.toUpperCase())),el('p',{},row.forgotten?'内容已遗忘。':row.request.target.title),el('small',{},row.forgotten?'':row.request.executorId)),()=>{s.selected=row.request.operationId;s.confirming=null;render();},{id:'protocol-request-'+row.request.operationId,'data-protocol-request':row.request.operationId,class:'record-row','aria-pressed':s.selected===row.request.operationId})):el('p',{class:'empty'},'暂无 ACP/MCP 任务。')),requestDetail());
  return el('section',{class:'task-protocol card'},el('h2',{},'ACP / MCP 协议工作'),s.available===false&&notice('当前运行实例没有接入协议工作服务。','warning'),s.error&&notice(s.error,'error'),s.message&&notice(s.message),profileStatus,profileEditor(),s.available===false?null:el('div',{class:'task-workspace'},composer,history),confirmation());
 }
 function afterRender(){const dialog=document.getElementById('protocol-confirm-dialog');if(dialog&&!dialog.open)dialog.showModal();}
 return {refresh:load,view,afterRender,dispose(){s.confirming=null;}};
}
