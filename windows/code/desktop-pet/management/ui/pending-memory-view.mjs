import {el,button,notice,confirmationDialog} from './dom.mjs';
export function createPendingMemoryView(client,render,state){
 let data=null,error='',loading=false,writing=false,sequence=0,confirmation=null,returnFocus=null;
 const current=()=>state().snapshot?.runtime.instanceId;
 async function load(){const instance=current(),seq=++sequence;if(!instance||state().connection!=='online')return;loading=true;error='';render();try{const value=await client.request('/api/memory-pending');if(seq!==sequence||instance!==current())return;if(value.instanceId!==instance||!Array.isArray(value.requests))throw Error('服务已变化，请刷新页面后核对。');data=value;}catch(e){if(seq===sequence)error=e.message;}finally{if(seq===sequence){loading=false;render();}}}
 const rowKey=row=>JSON.stringify(row);
 function valid(c){return !!c&&state().page==='memory'&&state().section===c.section&&state().connection==='online'&&current()===c.instance&&data?.instanceId===c.instance&&data.requests.some(row=>row.id===c.id&&rowKey(row)===c.rowKey)&&!(c.action==='retry'&&data.busy);}
 function close(){returnFocus=confirmation?.trigger||null;confirmation=null;render();}
 function sync(){if(confirmation&&!valid(confirmation)){confirmation=null;returnFocus=null;}}
 function afterRender(){if(returnFocus){document.getElementById(returnFocus)?.focus({preventScroll:true});returnFocus=null;}}
 function act(row,action){if(writing||data?.instanceId!==current()||state().connection!=='online')return;
  const text=action==='retry'?(state().snapshot?.accounting?.mode==='unlimited'?'重新处理会再次调用当前记忆模型，费用会继续记录，不设本地费用上限。现在重新处理这项未完成请求？':'重新处理会再次调用当前记忆模型，费用计入原累计预算。现在重新处理这项未完成请求？'):'撤销只解除这项未完成请求的临时隔离。尚未删除的个人资料可能重新用于回复；已经遗忘的内容不会恢复。确定撤销？';
  confirmation={id:row.id,rowKey:rowKey(row),instance:current(),section:state().section,action,text,trigger:'pending-'+action+'-'+row.id};render();
 }
 async function confirm(){
  const c=confirmation;if(writing||!valid(c)){close();return;}confirmation=null;writing=true;error='';render();
  try{await client.request('/api/memory-pending/'+c.action,{method:'POST',body:{instanceId:c.instance,id:c.id}});await load();}catch(e){error=e.message;}finally{writing=false;returnFocus=c.trigger;render();}
 }
 function view(){sync();const value=data?.instanceId===current()?data:null;return el('section',{class:'card','aria-label':'未完成的记忆请求'},el('div',{class:'label-row'},el('h2',{},'未完成的记忆请求'),button(loading?'读取中…':'刷新请求',load,{id:'pending-memory-refresh',disabled:loading||writing||state().connection!=='online'})),
  error&&notice(error,'warning'),!value?el('p',{class:'subtle'},'刷新后查看待处理或未完成的请求。'):value.requests.length?el('div',{},notice('这些请求尚未完成。处理期间，已有个人资料暂不用于回复；聊天仍可继续。'),value.requests.map(row=>el('div',{class:'card'},el('p',{},({forget:'遗忘请求',correction:'个人资料修改',uncertain:'待确认的记忆请求'})[row.intent]||'记忆请求',' · ',row.status==='failed'?'上次未完成':'待处理'),el('p',{},row.preview),row.createdAt&&el('small',{},new Date(row.createdAt).toLocaleString('zh-CN')),el('div',{class:'actions'},button('重新处理',()=>act(row,'retry'),{id:'pending-retry-'+row.id,'data-pending-retry':row.id,disabled:writing||value.busy||state().connection!=='online'}),button('撤销未完成请求',()=>act(row,'cancel'),{id:'pending-cancel-'+row.id,'data-pending-cancel':row.id,disabled:writing||state().connection!=='online'})))),value.busy&&el('p',{class:'subtle'},'后台还有任务，结束后可刷新并选择重新处理。')):el('p',{class:'subtle'},'当前没有未完成的记忆请求。'),confirmation&&confirmationDialog({id:'pending-memory-dialog',title:confirmation.action==='retry'?'重新处理这项请求？':'撤销未完成请求？',description:confirmation.text,confirmLabel:confirmation.action==='retry'?'重新处理':'确认撤销',onConfirm:confirm,onCancel:close,disabled:writing||!valid(confirmation)}));
 }
 return{load,view,sync,afterRender};
}
