import {el,button,badge,notice,field,select} from './dom.mjs';
const phases={off:'已关闭',connecting:'正在连接麦克风',waiting:'等待唤醒',listening:'正在听',submitting:'正在提交这一句',replying:'正在回复',paused:'手动语音处理中',error:'唤醒暂不可用'};
const sensitivities=[{value:'standard',label:'标准'},{value:'sensitive',label:'更灵敏'},{value:'strict',label:'更严格'}];
const valid=s=>s&&typeof s.keyword==='string'&&/^\p{Script=Han}{2,12}$/u.test(s.keyword)&&sensitivities.some(o=>o.value===s.sensitivity)&&Number.isInteger(s.silenceMs)&&s.silenceMs>=1000&&s.silenceMs<=3000&&s.silenceMs%500===0;
const copy=s=>({keyword:s.keyword,sensitivity:s.sensitivity,silenceMs:s.silenceMs});
const same=(a,b)=>!!a&&!!b&&a.keyword===b.keyword&&a.sensitivity===b.sensitivity&&a.silenceMs===b.silenceMs;
export function createWakeView(client,render,getHost){
 let current=null,draft=null,base=null,conflict=false,identity=null,epoch=0,active=false,reading=null,writing=null,timer=null,stale=true,error='',message='',composing=false;
 const visible=()=>getHost().page==='models'&&getHost().connection==='online'&&!document.hidden;
 const dirty=()=>draft&&!same(draft,base);
 function stop(){active=false;epoch++;clearTimeout(timer);reading?.controller.abort();reading=null;writing=null;stale=true;}
 function sync(){const h=getHost(),key=JSON.stringify([h.instanceId,h.authEpoch]);if(key!==identity){if(identity!==null&&dirty())conflict=true;stop();identity=key;current=null;error='';}if(!visible()){if(active)stop();return;}if(!active){active=true;queueMicrotask(()=>active&&refresh());}}
 function accept(s){
  if(s?.version!=='0.1.0'||s.instanceId!==getHost().instanceId||!Number.isSafeInteger(s.revision)||s.revision<0||!valid(s.settings)||typeof s.available!=='boolean'||!Number.isSafeInteger(s.session?.generation)||s.session.generation<0||typeof s.session.enabled!=='boolean'||!Object.hasOwn(phases,s.session.phase))throw Error('Invalid wake snapshot');
  if(current&&(s.revision<current.revision||s.session.generation<current.session.generation))return false;
  const next={version:s.version,instanceId:s.instanceId,revision:s.revision,settings:copy(s.settings),available:s.available,detail:typeof s.detail==='string'?s.detail:'',session:{generation:s.session.generation,enabled:s.session.enabled,phase:s.session.phase,detail:typeof s.session.detail==='string'?s.session.detail:''}};
  if(!dirty()){draft=copy(next.settings);base=copy(next.settings);}else if(!same(base,next.settings))conflict=true;
  current=next;stale=false;return true;
 }
 function fail(e,mutation=false){stale=true;error=mutation?'操作结果尚未确认，请刷新核对后再操作。':'暂时无法读取唤醒状态。麦克风是否仍在监听，请以桌面状态为准。';if(e.status===401||e.status===403)getHost().onError({status:e.status,name:'Error'});}
 async function refresh(){if(!active||!visible()||reading||writing)return;clearTimeout(timer);const t={epoch,controller:new AbortController()};reading=t;
  try{const value=await client.request('/api/wake',{signal:t.controller.signal});if(reading===t&&t.epoch===epoch&&visible()&&accept(value))error='';}catch(e){if(reading===t&&e.name!=='AbortError')fail(e);}finally{if(reading===t){reading=null;if(!composing)render();if(active)timer=setTimeout(refresh,2000);}}
 }
 function writable(){return active&&visible()&&current&&!writing;}
 async function write(kind){
  if(!writable()||kind==='save'&&(stale||conflict||!dirty()||!valid(draft))||kind==='enable'&&(stale||conflict||dirty()||!current.available||current.session.enabled)||kind==='disable'&&!current.session.enabled)return;
  const body={instanceId:current.instanceId,expectedRevision:current.revision,...(kind==='save'?{settings:copy(draft)}:{expectedGeneration:current.session.generation,enabled:kind==='enable'})};
  const t={epoch};writing=t;reading?.controller.abort();reading=null;clearTimeout(timer);error='';message=kind==='save'?'正在保存唤醒设置…':kind==='enable'?'正在请求开启，本机麦克风将持续监听…':'正在关闭监听…';render();
  try{const value=await client.request('/api/wake',{method:kind==='save'?'PUT':'POST',body});if(writing!==t||t.epoch!==epoch||!visible())return;
   if(!accept(value))throw Error('Stale response');
   if(kind==='save'){if(!same(current.settings,body.settings))throw Error('Save not confirmed');draft=copy(current.settings);base=copy(current.settings);conflict=false;message='设置已保存。请点击开启，按新设置监听。';}
   else message=current.session.enabled?'已开启本次监听。退出或重启后会关闭。':'监听已关闭。';
  }catch(e){if(writing===t){if(kind==='save')conflict=true;message='';if(e.status===409){stale=true;error='设置或本次监听已变化，请核对最新状态。';}else fail(e,true);}}
  finally{if(writing===t){writing=null;render();refresh();}}
 }
 function edit(key,value){draft={...draft,[key]:value};message='';if(!composing)render();}
 function view(){return el('section',{class:'card wake-settings',id:'wake-settings'},el('div',{class:'section-head'},el('div',{},el('h2',{},'语音唤醒'),el('p',{class:'subtle'},'叫出名字，说完整一句；停顿后自动发送。')),badge(current?phases[current.session.phase]:'正在读取',current?.session.enabled?'info':'muted')),
  el('p',{class:'field-help'},'默认关闭。开启后仅在本机持续监听唤醒词；退出或重启后需重新开启。未唤醒时不会发送云端转写。'),
  current&&el('p',{class:'subtle',id:'wake-current'},'已保存：'+current.settings.keyword+' · '+sensitivities.find(o=>o.value===current.settings.sensitivity).label+' · 静音 '+current.settings.silenceMs/1000+' 秒'),
  current&&!current.available&&notice(current.detail||'本地唤醒模块尚未就绪。','warning'),
  current?.session.detail&&notice(current.session.detail,current.session.phase==='error'?'warning':'muted'),
  error&&notice(error,'warning'),message&&notice(message),
  draft&&el('div',{class:'form-grid'},field('唤醒词','wake-keyword',draft.keyword,v=>edit('keyword',v),{maxLength:12,onCompositionStart:()=>{composing=true;},onCompositionEnd:()=>{composing=false;render();},disabled:!active||!!writing,hint:'2–12 个汉字；“乐正绫”读作 yuè zhèng líng。'}),select('灵敏度','wake-sensitivity',draft.sensitivity,sensitivities,v=>edit('sensitivity',v),{disabled:!active||!!writing}),select('说完后等待多久发送','wake-silence',String(draft.silenceMs),[1000,1500,2000,2500,3000].map(v=>({value:String(v),label:v/1000+' 秒'})),v=>edit('silenceMs',Number(v)),{disabled:!active||!!writing})),
  draft&&!valid(draft)&&notice('请输入 2–12 个汉字，并选择有效的灵敏度和静音时长。','warning'),
  conflict&&notice('本页草稿已保留，请核对已保存值后再保存。','warning'),
  el('div',{class:'actions'},button('刷新唤醒状态',refresh,{id:'wake-refresh',disabled:!active||!!reading||!!writing}),conflict&&button('核对后保留本页修改',()=>{if(!current||stale||writing)return;base=copy(current.settings);conflict=false;render();},{id:'wake-review',disabled:stale||!!writing}),button('保存唤醒设置',()=>write('save'),{id:'wake-save',disabled:!writable()||stale||conflict||!dirty()||!valid(draft)}),button(current?.session.enabled?'关闭监听':'开启本次监听',()=>write(current?.session.enabled?'disable':'enable'),{id:'wake-toggle',class:current?.session.enabled?'':'primary',disabled:!writable()||!current?.session.enabled&&(stale||conflict||dirty()||!current?.available)})),
  el('p',{class:'field-help'},'修改后保存会关闭旧监听，不会自动重新开启。按住语音键仍可直接说话；每次回复后回到等待唤醒。'));
 }
 document.addEventListener('visibilitychange',()=>{sync();render();});window.addEventListener('pagehide',stop);window.addEventListener('pageshow',()=>{sync();render();});
 return {sync,view,refresh,dispose:stop};
}
