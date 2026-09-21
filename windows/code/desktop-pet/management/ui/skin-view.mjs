// FIX61-11 wiring for FIX61-05: the 外观 / 换肤 console page.
//
// The page is a thin client over /api/skins. It resolves nothing itself: a preview image is fetched from
// the registry route the backend published, and a switch is a revision-checked POST. The page states the
// boundary the SPEC requires — a skin changes APPEARANCE ONLY, never identity, voice, knowledge or Memory.
import {el,button,badge,notice,card,field} from './dom.mjs';

/** The same id shape the store accepts, checked here so an invalid id never becomes a request. */
const ID=/^[a-z0-9][a-z0-9-]{1,48}$/;
const tone=skin=>skin.origin==='builtin'?'muted':'info';
const kib=bytes=>Math.max(1,Math.round(bytes/1024))+' KiB';

export function createSkinView(client,render,getHost){
  let state=null,error='',message='',reading=false,writing=false,epoch=0,active=false,identity=null;
  let draftId='',draftLabel='',draftSource='',conflict=false;
  const visible=()=>getHost().page==='skins'&&getHost().connection==='online'&&!document.hidden;
  const revision=()=>state?.state?.revision??0;
  function stop(){active=false;epoch++;}
  function sync(){const h=getHost(),key=JSON.stringify([h.instanceId,h.authEpoch]);if(key!==identity){if(identity!==null&&state)conflict=true;stop();identity=key;state=null;error='';}if(!visible()){if(active)stop();return;}if(!active){active=true;queueMicrotask(()=>active&&refresh());}}
  /** Only a response that names this API version is accepted; an older backend must not be driven blind. */
  function accept(value){
    if(!value||value.apiVersion!==1)throw Error('Unsupported skin API');
    const s=value.state;
    if(!s||s.schemaVersion!==1||!Number.isSafeInteger(s.revision)||s.revision<0||typeof s.activeSkinId!=='string'||!Array.isArray(s.skins))throw Error('Invalid skin state');
    if(state&&s.revision<state.state.revision)return false;
    if(state&&s.revision!==state.state.revision)conflict=false;
    state={apiVersion:1,state:s};return true;
  }
  async function refresh(){if(!active||!visible()||reading||writing)return;const t={epoch};reading=true;
    try{const value=await client.request('/api/skins');if(reading&&t.epoch===epoch&&visible()){accept(value);error='';}}
    catch(e){if(e.name!=='AbortError'){error=e.status===503?'当前后端尚未接入外观换肤。':e.message||'暂时无法读取外观列表。';}}
    finally{reading=false;render();}
  }
  async function write(path,body,ok){if(!active||!visible()||writing)return;const t={epoch};writing=true;error='';message='正在处理外观操作…';render();
    try{const value=await client.request(path,{method:'POST',body});if(t.epoch!==epoch||!visible())return;accept(value);message=ok;}
    catch(e){if(e.status===409){conflict=true;error='外观登记已在其它位置变化，请刷新后重试。';await refresh();}else error=e.message||'外观操作未完成。';message='';}
    finally{writing=false;render();}
  }
  const busy=()=>writing||!active||!visible()||conflict;
  function rows(){
    const list=state?.state.skins??[];
    return el('div',{class:'grid'},list.map(skin=>{
      const isActive=skin.skinId===state.state.activeSkinId;
      const preview=el('img',{class:'skin-preview',alt:'',loading:'lazy',
        src:'/api/skins/'+encodeURIComponent(skin.skinId)+'/asset/'+encodeURIComponent(skin.modelEntry)});
      // A rig file is not an image: the preview is decorative only, and its failure is never an error.
      preview.onerror=()=>{preview.removeAttribute('src');preview.hidden=true;};
      return card(el('div',{class:'card-title'},skin.label,badge(skin.origin==='builtin'?'内建':'已导入',tone(skin)),isActive&&badge('当前外观','success')),
        preview,
        el('p',{class:'subtle'},skin.skinId+' · '+skin.capabilities.textures+' 纹理 · '+skin.capabilities.expressions+' 预设 · '+skin.capabilities.motions+' 动作 · '+kib(skin.bytes)),
        el('p',{class:'subtle'},skin.capabilities.presets==='authored'?'自带已核对预设目录':'无已核对预设目录：不会自动播放任何动作'),
        el('p',{class:'subtle'},'指纹 '+skin.modelFingerprint.slice(0,12)+'…（换肤不会改变程序版本校验）'),
        el('div',{class:'actions'},
          button(isActive?'已是当前外观':'切换到这个外观',()=>write('/api/skins/'+encodeURIComponent(skin.skinId)+'/activate',{expectedRevision:revision()},'外观已切换为 '+skin.label+'。'),
            {id:'skin-activate-'+skin.skinId,class:isActive?'':'primary',disabled:busy()||isActive}),
          skin.origin==='imported'&&button('删除',()=>write('/api/skins/'+encodeURIComponent(skin.skinId)+'/remove',{expectedRevision:revision()},'模型包已删除。'),
            {id:'skin-remove-'+skin.skinId,disabled:busy()||isActive})));
    }));
  }
  function form(){
    return el('form',{class:'card',onSubmit:e=>{e.preventDefault();
      const source=draftSource.trim(),id=draftId.trim();
      if(!source)return;
      if(id&&!ID.test(id)){error='模型包标识只能使用小写字母、数字和连字符（2–49 位）。';render();return;}
      const body={source};if(id)body.skinId=id;if(draftLabel.trim())body.label=draftLabel.trim();
      void write('/api/skins/import',body,'模型包已导入并登记。');
    }},
      el('h2',{},'导入本地模型包'),
      el('p',{class:'subtle'},'只导入你已经获得授权的 Cubism 3/4/5 model3 目录；不会下载、不会复制到商店，也不会改变角色人格、语音、知识库或记忆。'),
      field('模型包目录','skin-source',draftSource,v=>{draftSource=v;},{placeholder:'例如 D:\\models\\my-rig（本机绝对路径）',disabled:busy()}),
      field('模型包标识（可选）','skin-id',draftId,v=>{draftId=v;},{placeholder:'小写字母、数字、连字符',disabled:busy()}),
      field('显示名称（可选）','skin-label',draftLabel,v=>{draftLabel=v;},{disabled:busy()}),
      el('div',{class:'actions'},el('button',{type:'submit',id:'skin-import',class:'primary',disabled:busy()||!draftSource.trim()},writing?'正在导入…':'导入并登记')));
  }
  function view(){
    const list=state?.state.skins??[];
    const activeSkin=list.find(skin=>skin.skinId===state.state.activeSkinId);
    return el('section',{class:'skin-page'},
      card('外观 / 换肤',el('p',{class:'subtle'},'这里只更换外观。换肤不会改变 characterId、身份、语音、知识库或长期记忆；0.7 Character Pack 会另行把角色与外观绑定。'),
        state&&el('p',{class:'subtle',id:'skin-active'},'当前外观：'+(activeSkin?.label??state.state.activeSkinId)+'（'+(activeSkin?.origin==='builtin'?'内建':'已导入')+'）· 登记修订 '+state.state.revision),
        state&&!list.length&&notice('还没有可用的模型包。','warning'),
        error&&notice(error,'warning'),message&&notice(message,'success'),
        conflict&&notice('本页显示的可能已过期，请刷新后再操作。','warning'),
        el('div',{class:'actions'},button(reading?'刷新中…':'刷新外观列表',refresh,{id:'skin-refresh',disabled:reading||writing}))),
      state&&el('div',{},rows()),
      form());
  }
  document.addEventListener('visibilitychange',()=>{sync();render();});
  window.addEventListener('pagehide',stop);
  window.addEventListener('pageshow',()=>{sync();render();});
  return {sync,view,refresh,dispose:stop,visible};
}
