import {el,button,badge,notice,field,definition,time,select} from './dom.mjs';

const labels={disconnected:'未连接',starting:'正在连接',waiting_scan:'等待扫码',scanned:'已扫码，等待确认',need_verification:'需要验证码',connected:'已连接',paused:'已暂停',expired:'二维码已过期',error:'连接遇到问题'};
const descriptions={disconnected:'连接后，可以在微信里聊天、安排任务并查看结果。',starting:'正在准备连接，请稍候。',waiting_scan:'请用希望聊天或发指令的微信扫码，并在微信中确认。',scanned:'已收到扫码，请在微信中完成确认。',need_verification:'请填写本次微信验证要求的验证码。',connected:'已连接绑定的微信，可以发送文字或语音，聊天或安排任务。',paused:'已暂停收发。启用后继续接收绑定用户的新消息。',expired:'请刷新二维码，然后重新扫码。',error:'暂时无法连接微信。请刷新状态，或重新扫码连接。'};
const deliveries={none:'尚无回复',accepted:'微信服务已接受，尚未确认用户收到',unknown:'是否发送成功尚未确认',failed:'发送失败，请检查连接后在微信中重试'};
const replyModes={follow_input:'跟随输入',text:'始终文字',voice:'始终语音'};
const validTime=v=>v===null||(typeof v==='string'&&Number.isFinite(Date.parse(v)));
const validImage=v=>typeof v==='string'&&v.length<2_000_000&&/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(v);
function snapshot(data){
 if(!data||data.apiVersion!=='0.2'||!Object.hasOwn(replyModes,data.replyMode)||!Number.isSafeInteger(data.revision)||data.revision<0||!Object.hasOwn(labels,data.status)||typeof data.enabled!=='boolean'||typeof data.detail!=='string'||!validTime(data.lastInputAt)||!validTime(data.lastOutputAt)||!Object.hasOwn(deliveries,data.lastDelivery)||!(data.boundUser===null||(data.boundUser&&typeof data.boundUser.userId==='string'&&typeof data.boundUser.botId==='string'))||!(data.qr===null||(data.qr&&validImage(data.qr.imageDataUrl)&&typeof data.qr.expiresAt==='string'&&validTime(data.qr.expiresAt))))throw Error('Invalid snapshot');
 // Keep only the public fields; never retain unexpected credential-bearing properties.
 return {replyMode:data.replyMode,revision:data.revision,status:data.status,enabled:data.enabled,boundUser:data.boundUser?{userId:data.boundUser.userId,botId:data.boundUser.botId}:null,qr:data.qr?{imageDataUrl:data.qr.imageDataUrl,expiresAt:data.qr.expiresAt}:null,lastInputAt:data.lastInputAt,lastOutputAt:data.lastOutputAt,lastDelivery:data.lastDelivery};
}
export function createWeChatView(client,render,getHost){
 let current=null,highest=-1,identity=null,active=false,epoch=0,timer=null,reading=null,writing=null,stale=true,error='',code='',replyDraft=null,replyBase=null,replyConflict=false,replyMessage='';
 const visible=()=>getHost().page==='wechat'&&getHost().connection==='online'&&!document.hidden;
 function clearSecrets(){code='';const input=document.getElementById('wechat-code');if(input)input.value='';if(current)current.qr=null;document.getElementById('wechat-qr')?.removeAttribute('src');}
 function stop(){active=false;epoch++;clearTimeout(timer);timer=null;reading?.controller.abort();reading=null;writing=null;stale=true;clearSecrets();}
 function schedule(){clearTimeout(timer);if(active)timer=setTimeout(()=>{expire();refresh();schedule();},2000);}
 function expire(){if(current?.qr&&Date.parse(current.qr.expiresAt)<=Date.now()){current.qr=null;render();}}
 function sync(){
  const h=getHost(),next=JSON.stringify([h.authEpoch,h.instanceId]);
  if(identity!==next){if(identity!==null&&replyDraft!==null&&replyDraft!==replyBase)replyConflict=true;stop();identity=next;current=null;highest=-1;error='';}
  if(!visible()){if(active)stop();return;}
  if(!active){active=true;queueMicrotask(()=>{if(active)refresh();});}
 }
 function accept(data){const next=snapshot(data);if(next.revision<highest)return false;highest=next.revision;current=next;stale=false;
  if(replyDraft===null||replyDraft===replyBase){replyDraft=next.replyMode;replyBase=next.replyMode;}else if(replyBase!==next.replyMode)replyConflict=true;
  if(next.status!=='need_verification')code='';
  if(!['waiting_scan','scanned'].includes(next.status)||Date.parse(next.qr?.expiresAt)<=Date.now())next.qr=null;
  return true;
 }
 function fail(e,mutation=false){stale=true;clearSecrets();error=mutation?'这次操作的结果尚未确认。正在读取最新状态，请核对后再操作。':'暂时无法读取微信状态，请稍后刷新。';
  if(e.status===401||e.status===403)getHost().onError({status:e.status,name:'Error'});
 }
 async function refresh(){
  if(!active||!visible()||reading||writing)return;schedule();const ticket={epoch,controller:new AbortController()};reading=ticket;render();
  try{const data=await client.request('/api/wechat',{signal:ticket.controller.signal});if(reading!==ticket||ticket.epoch!==epoch||!visible())return;if(accept(data))error='';}
  catch(e){if(reading===ticket&&ticket.epoch===epoch&&e.name!=='AbortError')fail(e);}
  finally{if(reading===ticket){reading=null;render();schedule();}}
 }
 function allowed(action){if(!active||!visible()||stale||writing||!current)return false;
  if(action==='set_reply_mode')return Object.hasOwn(replyModes,replyDraft)&&!replyConflict&&replyDraft!==current.replyMode;
  if(action==='verify')return current.status==='need_verification';
  if(action==='login')return ['disconnected','expired','error','waiting_scan','scanned','need_verification'].includes(current.status)||(current.status==='paused'&&!current.boundUser);
  if(action==='start')return !!current.boundUser&&!current.enabled;
  if(action==='stop')return current.enabled||['starting','waiting_scan','scanned','need_verification'].includes(current.status);
  return action==='disconnect'&&(current.status!=='disconnected'||!!current.boundUser);
 }
 async function act(action){
  if(!allowed(action))return;
  let value=action==='verify'?code.trim():'';if(action==='verify'&&!value){error='请填写验证码。';render();return;}
  const body={action,expectedRevision:current.revision,...(action==='verify'?{code:value}:action==='set_reply_mode'?{replyMode:replyDraft}:{})};value='';
  const ticket={epoch};writing=ticket;reading?.controller.abort();reading=null;clearTimeout(timer);if(action!=='set_reply_mode')clearSecrets();else replyMessage='正在保存回复方式…';error='';render();
  try{const data=await client.request('/api/wechat',{method:'POST',body});if(writing!==ticket||ticket.epoch!==epoch||!visible())return;const accepted=accept(data);if(action==='set_reply_mode'&&accepted){if(current.replyMode===body.replyMode){replyDraft=current.replyMode;replyBase=current.replyMode;replyConflict=false;replyMessage='回复方式已保存，将用于新收到的消息。';}else{replyConflict=true;replyMessage='回复方式未确认保存，请核对当前设置。';}}}
  catch(e){if(writing===ticket&&ticket.epoch===epoch){if(action==='set_reply_mode'){replyConflict=true;replyMessage='保存结果尚未确认，请核对当前设置后再操作。';}if(e.status===409){stale=true;error='连接状态已变化，已读取最新状态。请核对后重新选择操作。';}else fail(e,true);}}
  finally{if(body.code)body.code='';if(writing===ticket){writing=null;render();refresh();}}
 }
 function view(){
  const state=current?.status,hasQR=active&&!stale&&current?.qr&&Date.parse(current.qr.expiresAt)>Date.now(),expired=state==='waiting_scan'&&!hasQR&&!stale;
  const page=el('section',{class:'wechat-page'},el('div',{class:'section-head'},el('div',{},el('p',{class:'page-eyebrow'},'微信个人 Bot'),el('h2',{},'在微信里，继续聊')),button('刷新连接状态',refresh,{id:'wechat-refresh',disabled:!active||!!reading||!!writing})),el('p',{class:'subtle'},'用希望聊天或发指令的微信扫码。连接的是官方个人 Bot，支持绑定用户的文字和语音消息。'));
  if(error)page.append(notice(error,'error'));
  if(stale&&current)page.append(notice('这是上次读取的连接状态，正在等待更新。','warning'));
  const panel=el('section',{class:'card wechat-connection'},el('div',{class:'section-head'},el('h3',{},'微信连接'),el('span',{id:'wechat-status','aria-live':'polite'},badge(expired?'二维码已过期':labels[state]||'正在读取状态…',state==='connected'&&!stale?'success':'muted'))),el('p',{class:'subtle'},descriptions[expired?'expired':state]||'请稍候。'));
  if(hasQR)panel.append(el('div',{class:'wechat-scan'},el('img',{id:'wechat-qr',src:current.qr.imageDataUrl,alt:'微信连接二维码',width:224,height:224,draggable:false,referrerPolicy:'no-referrer'}),el('small',{},'有效至 '+time(current.qr.expiresAt))));
  if(state==='need_verification'&&active&&!stale)panel.append(el('form',{class:'wechat-verify',autocomplete:'off',onSubmit:e=>{e.preventDefault();act('verify');}},field('验证码','wechat-code',code,v=>{code=v;},{type:'password',autocomplete:'off',spellcheck:false,maxLength:256,disabled:!!writing}),el('button',{type:'submit',id:'wechat-verify',class:'primary',disabled:!allowed('verify')},'提交验证')));
  panel.append(el('div',{class:'actions'},
   (['disconnected','expired','error','waiting_scan','scanned','need_verification'].includes(state)||(state==='paused'&&!current?.boundUser))&&button(state==='disconnected'?'生成连接二维码':'刷新二维码',()=>act('login'),{id:'wechat-login',class:'primary',disabled:!allowed('login')}),
   current?.boundUser&&!current.enabled&&button('启用微信',()=>act('start'),{id:'wechat-start',class:'primary',disabled:!allowed('start')}),
   (current?.enabled||['starting','waiting_scan','scanned','need_verification'].includes(state))&&button('暂停微信',()=>act('stop'),{id:'wechat-stop',disabled:!allowed('stop')}),
   state&&state!=='disconnected'&&button('断开连接',()=>act('disconnect'),{id:'wechat-disconnect',disabled:!allowed('disconnect')}),
   writing&&el('span',{class:'subtle',role:'status'},'正在处理…')));
  page.append(panel);
  if(current){
   const settings=el('section',{class:'card wechat-account',id:'wechat-reply-settings'},el('h3',{},'回复方式'),el('p',{class:'subtle',id:'wechat-reply-current'},'当前：'+replyModes[current.replyMode]),
    select('希望怎样回复','wechat-reply-mode',replyDraft,Object.entries(replyModes).map(([value,label])=>({value,label})),value=>{replyDraft=value;replyMessage='';render();},{disabled:!active||stale||!!writing}),
    el('div',{class:'field-help'},el('p',{},'跟随输入：语音回音频文件，文字回文字。选择“始终文字”可关闭语音回复。'),el('p',{},'保存后用于新消息；已安排任务的后续通知保持原方式。')),
    replyConflict&&notice('设置已变化或保存结果未确认。请核对当前方式；本页选择已保留。','warning'),
    replyMessage&&notice(replyMessage),
    el('div',{class:'actions'},replyConflict&&button('已核对，保留本页选择',()=>{if(!active||stale||writing)return;replyBase=current.replyMode;replyConflict=false;replyMessage='请保存你选择的回复方式。';render();},{id:'wechat-reply-review',disabled:!active||stale||!!writing}),button('保存回复方式',()=>act('set_reply_mode'),{id:'wechat-reply-save',class:'primary',disabled:!allowed('set_reply_mode')})));
   page.append(settings);
  }
  if(current?.boundUser)page.append(el('section',{class:'card wechat-account'},el('h3',{},'当前绑定'),definition([['微信用户',current.boundUser.userId],['个人 Bot',current.boundUser.botId],['最近收到',time(current.lastInputAt)],['最近回复',time(current.lastOutputAt)],['回复状态',deliveries[current.lastDelivery]]])));
  page.append(el('p',{class:'subtle wechat-note'},'暂停后保留绑定；断开后需要重新扫码。微信消息不会让电脑出声，任务执行仍需你确认。'));
  return page;
 }
 document.addEventListener('visibilitychange',()=>{sync();render();});
 window.addEventListener('pagehide',stop);
 window.addEventListener('pageshow',()=>{sync();render();});
 return {sync,refresh,view};
}
