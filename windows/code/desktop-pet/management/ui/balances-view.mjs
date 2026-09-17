import {el,button,badge,notice,field,time} from './dom.mjs';
const labels={idle:'尚未查询',loading:'更新中',ready:'官方余额',error:'查询失败',unconfigured:'待配置'};
export function createBalancesView(client,render,host){
 let snapshot=null,identity=null,base=null,timer=null,polls=0,editing=false,keyId='',secret='',error='',saving=false,epoch=0,lastToken=null;
 function clear(){keyId='';secret='';editing=false;error='';}
 function deactivate(){epoch++;clear();clearTimeout(timer);timer=null;polls=0;saving=false;}
 function accept(data,schedule=true){if(data&&Array.isArray(data.providers)){snapshot={providers:data.providers.map(value=>{const old=snapshot?.providers.find(p=>p.provider===value.provider);return old&&(value.credentialRevision<old.credentialRevision||(value.credentialRevision===old.credentialRevision&&value.checkedAt&&old.checkedAt&&value.checkedAt<old.checkedAt))?old:value;})};if(schedule){polls=0;poll();}}}
 function poll(){if(timer||host().page!=='overview'||host().connection!=='online'||!snapshot?.providers.some(p=>p.status==='loading')||polls>=12)return;timer=setTimeout(async()=>{timer=null;polls++;const stamp=epoch;try{const data=await client.request('/api/balances');if(stamp!==epoch)return;accept(data,false);}catch{if(stamp!==epoch)return;error='余额状态暂时无法读取，其他功能仍可使用。';}render();poll();},1000);}
 function sync(){const current=host().snapshot,next=current?.runtime.instanceId;
   if(identity!==next||lastToken!==client.token){identity=next;lastToken=client.token;deactivate();snapshot=null;base=null;}
   if(host().connection!=='online'){deactivate();return;}
   if(base!==current?.balances){base=current?.balances;if(base)accept(base);}
   poll();
 }
 async function refresh(provider){if(saving)return;const stamp=++epoch;clearTimeout(timer);timer=null;error='';try{const data=await client.request('/api/balances/refresh',{method:'POST',body:{provider}});if(stamp!==epoch)return;accept(data);}catch{if(stamp!==epoch)return;error='余额刷新未完成，请稍后再试。';}render();}
 async function save(){if(saving)return;const stamp=++epoch;clearTimeout(timer);timer=null;const expectedRevision=snapshot?.providers.find(p=>p.provider==='aliyun')?.credentialRevision??0;
   const body={expectedRevision,accessKeyId:keyId,accessKeySecret:secret};keyId='';secret='';saving=true;render();
   try{const data=await client.request('/api/balances/aliyun-credentials',{method:'PUT',body});if(stamp!==epoch)return;accept(data);clear();}catch{if(stamp!==epoch)return;error='凭据未保存，请刷新配置后检查输入；密钥不会回显。';}finally{body.accessKeyId='';body.accessKeySecret='';if(stamp===epoch){saving=false;render();}}
 }
 function view(){const online=host().connection==='online';
  return el('section',{class:'balances-section'},el('div',{class:'balance-grid'},['aliyun','deepseek'].map(provider=>{
   const value=snapshot?.providers.find(p=>p.provider===provider)??{status:'idle',rows:[],updatedAt:null,configured:false,stale:false};
   return el('section',{class:'card balance-card',id:'balance-'+provider},el('div',{class:'card-title'},el('h2',{},provider==='aliyun'?'阿里云现金余额':'DeepSeek 可用余额'),badge(value.stale?'上次余额 · 已过期':labels[value.status]??'暂不可用',value.status==='error'?'warning':'muted')),
    value.rows.length?value.rows.map(row=>el('div',{},el('div',{class:'balance-amount'},el('span',{class:'balance-currency'},row.currency),row.amount),row.availableCredit!==undefined&&el('p',{class:'subtle'},'可用额度：'+row.currency+' '+row.availableCredit))):el('div',{class:'balance-empty'},value.status==='unconfigured'?'待配置凭据':value.status==='error'?'暂时无法取得余额':'尚无官方余额'),
    el('p',{class:'subtle'},'更新时间：'+time(value.updatedAt)),value.message&&notice(value.message,'warning'),
    el('div',{class:'actions'},button(value.status==='loading'?'更新中…':'刷新余额',()=>refresh(provider),{id:'balance-refresh-'+provider,disabled:!online||saving||value.status==='loading'}),provider==='aliyun'&&button(value.configured?'更新财务凭据':'配置财务凭据',()=>{clear();editing=true;render();},{id:'balance-configure',disabled:!online||saving})),
    el('small',{class:'subtle'},provider==='aliyun'?'来自阿里云账户；现金余额与可用额度分别展示。':'来自 DeepSeek；各币种分别展示，含有效赠送余额。'));
  })),error&&notice(error,'warning'),
  editing&&el('form',{class:'card finance-form',onSubmit:e=>{e.preventDefault();save();}},el('h2',{},'阿里云财务只读凭据'),el('p',{},'在本机保存具有余额查询权限的 RAM AccessKey。百炼 API Key 不能代替财务凭据；不要在聊天中发送密钥。'),
   field('AccessKey ID','finance-key-id',keyId,v=>{keyId=v},{type:'password',required:true,autocomplete:'off',maxLength:256,disabled:saving}),
   field('AccessKey Secret','finance-secret',secret,v=>{secret=v},{type:'password',required:true,autocomplete:'new-password',maxLength:256,disabled:saving}),
   el('small',{class:'subtle'},'所需只读权限：bss:DescribeAcccount。凭据仅在本机后端保存，不回显；此操作不会创建云账号或修改权限。'),
   el('div',{class:'actions'},el('button',{type:'submit',id:'finance-save',class:'primary',disabled:!online||saving},saving?'保存中…':'保存并查询'),button('取消',()=>{clear();render();},{id:'finance-cancel',disabled:saving}))));
 }
 return {sync,view,deactivate};
}
