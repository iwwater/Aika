// FIX61-11 wiring for FIX61-07: the 模块状态 console page over the already-delivered /api/health routes.
//
// FIX61-07 §"不为定时点灯生成付费请求" is honored by construction: this page only READS the snapshot the
// backend derived from its own observations. It starts no probe and no request of its own beyond the
// snapshot reads below, so before the first conversation most lights legitimately read unknown/degraded.
// That is the deliberate honest state, and the page says so instead of showing an encouraging green.
import {el,button,badge,notice,card,definition,time} from './dom.mjs';

const TONES={ready:'success',checking:'muted',unknown:'muted',disabled:'muted',degraded:'warning',failed:'error'};
const LABELS={ready:'就绪',checking:'检查中',unknown:'尚未确认',disabled:'已停用',degraded:'部分可用',failed:'失败'};
const EVIDENCE=[['configured','已配置'],['reachable','端点已应答'],['operational','实际调用成功'],['selfCheck','本地自检通过']];

export function createHealthView(client,render,getHost){
  let snapshot=null,error='',reading=false,epoch=0,active=false,identity=null,detail=null;
  const visible=()=>getHost().page==='health'&&getHost().connection==='online'&&!document.hidden;
  function stop(){active=false;epoch++;}
  function sync(){const h=getHost(),key=JSON.stringify([h.instanceId,h.authEpoch]);if(key!==identity){stop();identity=key;snapshot=null;detail=null;error='';}if(!visible()){if(active)stop();return;}if(!active){active=true;queueMicrotask(()=>active&&refresh());}}
  function accept(value){
    if(!value||!Number.isSafeInteger(value.configRevision)||value.configRevision<0||typeof value.observedAt!=='string'||!value.modules||typeof value.modules!=='object')throw Error('Invalid health snapshot');
    snapshot=value;return true;
  }
  async function refresh(){if(!active||!visible()||reading)return;const t={epoch};reading=true;
    try{const value=await client.request('/api/health');if(reading&&t.epoch===epoch&&visible()){accept(value);error='';}}
    catch(e){if(e.name!=='AbortError')error=e.status===503?'当前后端尚未接入模块状态。':e.message||'暂时无法读取模块状态。';}
    finally{reading=false;render();}
  }
  /** The per-module route returns the same record plus its repair entry point. */
  async function inspect(module){if(!active||!visible())return;const t={epoch};
    try{const value=await client.request('/api/health/'+encodeURIComponent(module));if(t.epoch===epoch&&visible())detail={module,value};}
    catch(e){if(t.epoch===epoch)error=e.message||'无法读取这个模块的修复建议。';}
    finally{render();}
  }
  const modules=()=>Object.entries(snapshot?.modules??{}).sort((a,b)=>{
    const rank=value=>value.state==='failed'?0:value.state==='degraded'?1:value.state==='unknown'?2:3;
    return rank(a[1])-rank(b[1])||a[0].localeCompare(b[0]);
  });
  function moduleCard(id,module){
    const evidence=EVIDENCE.filter(([key])=>module.evidence?.[key]===true).map(([,label])=>label);
    return card(el('div',{class:'card-title'},module.label??id,badge(LABELS[module.state]??module.state,TONES[module.state]??'muted'),module.stale&&badge('已过期','warning')),
      el('p',{class:'subtle'},'证据：'+(evidence.length?evidence.join(' · '):'（尚无任何证据）')),
      module.reasonCode&&el('p',{class:'subtle'},'原因：'+module.reasonCode),
      module.repairAction&&el('p',{class:'subtle'},'可以这样处理：'+module.repairAction),
      el('small',{},'最近检查：'+time(module.checkedAt)+' · 配置修订 '+module.configRevision),
      el('div',{class:'actions'},button('查看修复入口',()=>inspect(id),{id:'health-inspect-'+id,disabled:reading}),
        id==='asr'&&button('去配置麦克风',()=>{const host=getHost();host.page='models';render();},{id:'health-mic-link'})));
  }
  function view(){
    const list=snapshot?modules():[];
    const green=list.filter(([,m])=>m.state==='ready').length;
    return el('section',{class:'health-page'},
      card('模块状态',el('p',{class:'subtle'},'这里的灯只反映后端已经真实观察到的事实。为了不给用户生成付费请求，本页不会主动探测任何端点——所以首次对话之前，多数模块显示为「尚未确认」或「部分可用」是预期的诚实状态，不代表故障。'),
        snapshot&&el('p',{class:'subtle',id:'health-summary'},'共 '+list.length+' 个模块，其中 '+green+' 个已有实际证据 · 配置修订 '+snapshot.configRevision+' · 快照时间 '+time(snapshot.observedAt)),
        error&&notice(error,'warning'),
        el('div',{class:'actions'},button(reading?'刷新中…':'刷新状态',refresh,{id:'health-refresh',disabled:reading}))),
      detail&&card('修复入口 · '+(detail.value.label??detail.module),
        definition([['模块',detail.module],['原因',detail.value.reasonCode??'（无）'],['修复动作',detail.value.repairAction??'（无）']]),
        el('div',{class:'actions'},button('收起',()=>{detail=null;render();},{id:'health-detail-close'}))),
      snapshot&&el('div',{class:'grid module-grid'},list.map(([id,module])=>moduleCard(id,module))));
  }
  document.addEventListener('visibilitychange',()=>{sync();render();});
  window.addEventListener('pagehide',stop);
  window.addEventListener('pageshow',()=>{sync();render();});
  return {sync,view,refresh,dispose:stop,visible};
}
