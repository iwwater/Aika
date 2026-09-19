import {el,button,badge,notice} from './dom.mjs';
const categoryNames={all:'全部',expression:'表情',pose:'姿势',appearance:'外观',idle:'待机'};
let coreReady;
function loadCore(){if(globalThis.Live2DCubismCore)return Promise.resolve();return coreReady??=new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='/presentation-runtime/core.js';script.onload=resolve;script.onerror=()=>{coreReady=null;script.remove();reject(Error('模型运行文件加载失败，请刷新重试。'));};document.head.append(script);});}
const sourceNames={'model-expression':'模型预设','model-motion':'模型动画',procedural:'程序动作'};
export function createPresentationView(client,render) {
  const canvas=el('canvas',{class:'preset-canvas','aria-label':'当前模型真实预览'});
  const stage=el('div',{class:'preset-stage'},canvas), status=el('p',{class:'preset-preview-status',role:'status'},'正在准备模型…');
  let data=null,query='',category='all',selected=null,engine=null,loading=null,active=false,epoch=0,saving=false,error='',message='';
  const resize=new ResizeObserver(()=>engine?.resize());resize.observe(stage);
  async function ensureEngine(){
    if(engine)return engine;if(loading)return loading;const ticket=epoch;
    loading=loadCore().then(()=>import('./presentation-preview.js')).then(m=>m.createPresentationPreview({canvas,onStatus:value=>{
      if(ticket!==epoch)return;const text=typeof value==='string'?value:value?.message;if(text)status.textContent=text;
    },assetBase:new URL('/presentation-assets/',location.href).href,shaderBase:new URL('/presentation-shaders/',location.href).href})).then(value=>{
      if(ticket!==epoch||!active){value.dispose();return null;}engine=value;status.textContent='模型已就绪，选择一项开始预览。';render();return value;
    }).catch(e=>{if(ticket===epoch){status.textContent='模型暂时无法预览';error=e.message;render();}return null;}).finally(()=>{if(ticket===epoch)loading=null;});
    return loading;
  }
  async function refresh(){try{data=await client.request('/api/presentation');error='';render();}catch(e){error=e.message;render();}}
  async function select(preset){if(!preset.previewable)return;const ticket=epoch;error='';const value=await ensureEngine();if(!value||ticket!==epoch||!active)return;
    try{await value.select(preset.id);if(ticket!==epoch||!active)return;selected=preset.id;status.textContent='正在预览：'+preset.label;render();}catch(e){error=e.message;render();}}
  function stop(restore=false){if(restore)engine?.restore();else engine?.stop();selected=null;status.textContent=restore?'已恢复预览模型的默认外观。':'预览已停止。';render();}
  async function toggle(preset,enabled){if(saving||!data||preset.availability!=='automatic')return;saving=true;error='';message='';render();
    const ids=new Set(data.policy.enabledIds);if(enabled)ids.add(preset.id);else ids.delete(preset.id);
    try{data=await client.request('/api/presentation',{method:'PUT',body:{modelId:data.catalog.modelId,expectedRevision:data.policy.revision,enabledIds:[...ids]}});message=`已保存：${preset.label}${enabled?'允许':'不再'}自动使用。`;}
    catch(e){error=e.message;if(e.status===409)await refresh();}finally{saving=false;render();}}
  function activate(){if(active)return;active=true;epoch++;void refresh();queueMicrotask(()=>void ensureEngine());}
  function deactivate(){if(!active)return;active=false;epoch++;engine?.dispose();engine=null;loading=null;selected=null;}
  function view(){
    activate();const items=data?.catalog.items??[],enabled=new Set(data?.policy.enabledIds??[]);
    const filtered=items.filter(p=>(category==='all'||p.category===category)&&(!query||p.label.toLowerCase().includes(query.toLowerCase())));
    const current=items.find(p=>p.id===selected);
    const stats=el('div',{class:'preset-stats'},[[items.length,'现有预设'],[items.filter(p=>p.previewable).length,'可手动预览'],[enabled.size,'允许自动使用']].map(([n,label])=>el('div',{},el('strong',{},n),el('span',{},label))));
    const preview=el('section',{class:'card preset-preview'},el('div',{class:'section-head'},el('div',{},el('h2',{},'AAAAGENT · 预览'),el('p',{class:'subtle'},current?current.label:'选择右侧预设，看看实际表现')),badge('独立预览','info')),stage,status,
      el('div',{class:'actions'},button('停止预览',()=>stop(),{disabled:!engine||!selected}),button('恢复默认',()=>stop(true),{disabled:!engine})),
      el('p',{class:'subtle preset-hint'},'预览不影响聊天，也不会播放声音。'));
    const search=el('input',{id:'preset-search',type:'search',placeholder:'搜索表情或动作',value:query,'aria-label':'搜索表情或动作',onInput:e=>{query=e.target.value;render();}});
    const filters=el('div',{class:'preset-filters',role:'group','aria-label':'预设分类'},Object.entries(categoryNames).map(([id,label])=>button(label,()=>{category=id;render();},{'aria-pressed':category===id,class:category===id?'selected':''})));
    const list=el('section',{class:'card preset-list'},el('div',{class:'section-head'},el('h2',{},'表情与动作'),el('span',{class:'subtle'},filtered.length+' 项')),search,filters,
      el('p',{class:'subtle'},'勾选只控制桌宠自动使用，保存后立即生效。外观配件仅供手动预览。'),
      el('div',{class:'preset-cards'},filtered.map(p=>{
        const allowed=enabled.has(p.id),isSelected=selected===p.id;
        const card=el('article',{class:'preset-card'+(isSelected?' is-selected':''),'data-preset-id':p.id},
          button(el('span',{},el('strong',{},p.label),el('small',{},categoryNames[p.category]+' · '+sourceNames[p.source])),()=>void select(p),{class:'preset-select',disabled:!p.previewable,'aria-pressed':isSelected,'aria-label':'预览 '+p.label}),
          el('div',{class:'preset-card-bottom'},p.availability==='automatic'?el('label',{class:'preset-toggle'},el('input',{type:'checkbox',checked:allowed,disabled:saving,id:'enable-'+p.id,'aria-label':p.label+' 允许自动使用',onChange:e=>void toggle(p,e.target.checked)}),el('span',{},'允许自动使用'),el('b',{'aria-hidden':'true'},allowed?'✓':'×')):badge(p.previewable?'手动预览':'不可预览',p.previewable?'info':'warning')),
          p.reason&&el('p',{class:'preset-reason'},p.reason));return card;
      })),!filtered.length&&notice(data?'没有找到匹配的预设。':'正在读取预设目录…'));
    return el('div',{class:'presentation-page'},stats,error&&notice(error,'error'),message&&notice(message,'success'),saving&&notice('正在保存自动使用设置…'),
      el('div',{class:'preset-layout'},preview,list),data&&el('details',{class:'card preset-details'},el('summary',{},'素材详情'),
        el('p',{},'36个模型表情或外观文件、1个模型待机动画、3项程序动作。数量不等于情绪种类或新生成动画。'),
        el('p',{},'模型版本：'+data.catalog.modelId),el('p',{},'设置版本：'+data.policy.revision),el('p',{},'允许列表按当前模型保存。未开放的外观预设不会交给聊天模型；恢复预览保持现有水印策略。')));
  }
  return {view,deactivate,refresh,dispose(){deactivate();resize.disconnect();}};
}
