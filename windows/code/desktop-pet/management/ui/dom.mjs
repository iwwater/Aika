export function el(tag,attrs={},...children) {
  const node=document.createElement(tag);
  for(const [key,value] of Object.entries(attrs)){
    if(key.startsWith('on'))node.addEventListener(key.slice(2).toLowerCase(),value);
    else if(key==='class')node.className=value;
    else if(key==='text')node.textContent=value;
    else if(key in node)node[key]=value;
    else if(value!==false&&value!=null)node.setAttribute(key,String(value));
  }
  for(const child of children.flat(Infinity))if(child!==null&&child!==undefined&&child!==false)node.append(child instanceof Node?child:document.createTextNode(String(child)));
  return node;
}
export const button=(text,fn,attrs={})=>el('button',{type:'button',onClick:fn,...attrs},text);
export const badge=(text,tone='muted')=>el('span',{class:'badge '+tone},text);
export const notice=(text,tone='muted')=>el('p',{class:'notice '+tone,role:tone==='error'?'alert':'status'},text);
export const card=(title,...children)=>el('section',{class:'card'},el('h2',{},title),...children);
export const time=value=>value?new Date(value).toLocaleString('zh-CN',{hour12:false}):'尚无记录';
export function field(label,id,value,onInput,{type='text',hint='',...attrs}={}) {
  const input=el(type==='textarea'?'textarea':'input',{id,name:id,...(type==='textarea'?{}:{type}),value:value??'',onInput:e=>onInput(e.target.value),...attrs});
  return el('label',{class:'field',htmlFor:id},el('span',{},label),input,hint&&el('small',{},hint));
}
// A single page-owned popup survives shell refreshes. Choices stay in their view's draft.
let picker=null;
const pickerConfig=new WeakMap();
function closePicker(focus=false){
  if(!picker)return;const {trigger,panel}=picker;picker=null;panel.remove();
  trigger.setAttribute('aria-expanded','false');trigger.removeAttribute('aria-activedescendant');
  if(focus&&trigger.isConnected&&!trigger.disabled)trigger.focus({preventScroll:true});
}
function placePicker(){
  if(!picker)return;const {trigger,panel}=picker,r=trigger.getBoundingClientRect();
  const gap=6,margin=12,width=Math.min(Math.max(r.width,200),innerWidth-margin*2);
  const below=innerHeight-r.bottom-gap-margin,above=r.top-gap-margin,up=below<150&&above>below;
  panel.style.width=width+'px';panel.style.maxHeight=Math.max(38,Math.min(280,up?above:below))+'px';
  panel.style.left=Math.max(margin,Math.min(r.left,innerWidth-width-margin))+'px';
  panel.style.top=(up?Math.max(margin,r.top-gap-panel.offsetHeight):Math.max(margin,r.bottom+gap))+'px';
}
function markOption(scroll=false){
  if(!picker)return;const {panel,trigger,active}=picker;
  panel.querySelectorAll('[role=option]').forEach(n=>{n.classList.toggle('is-active',n.dataset.value===active);});
  const option=[...panel.children].find(n=>n.dataset.value===active);
  if(option){trigger.setAttribute('aria-activedescendant',option.id);if(scroll)option.scrollIntoView({block:'nearest'});}
  else trigger.removeAttribute('aria-activedescendant');
}
function renderOptions(){
  if(!picker)return;const {config,panel,id}=picker;
  const signature=JSON.stringify([config.value,config.options]);
  if(signature!==picker.signature){
    const scroll=panel.scrollTop;picker.signature=signature;
    panel.replaceChildren(...config.options.map((o,i)=>el('div',{id:id+'-option-'+i,role:'option','aria-selected':String(String(o.value)===config.value),'aria-disabled':!!o.disabled,'data-value':String(o.value),class:'choice-option',
      onPointerMove:()=>{if(picker&&!o.disabled){picker.active=String(o.value);markOption();}},
      onClick:()=>chooseOption(String(o.value))},el('span',{},o.label),el('span',{'aria-hidden':'true',class:'choice-check'},String(o.value)===config.value?'✓':''))));
    panel.scrollTop=scroll;
  }
  if(!config.options.some(o=>String(o.value)===picker.active&&!o.disabled))picker.active=String(config.options.find(o=>!o.disabled)?.value??'');
  markOption();placePicker();
}
function chooseOption(value){
  if(!picker||picker.trigger.disabled)return;
  const {config}=picker;if(!config.options.some(o=>String(o.value)===value&&!o.disabled))return;
  closePicker(true);if(value!==config.value)config.onChange(value);
}
function openPicker(trigger){
  if(trigger.disabled)return;
  closePicker();const config=pickerConfig.get(trigger),panel=el('div',{id:trigger.id+'-listbox',class:'choice-menu',role:'listbox','aria-labelledby':trigger.id+'-label',onPointerDown:e=>e.preventDefault()});
  picker={id:trigger.id,trigger,config,panel,active:config.value,signature:null};
  // A dialog's top layer must also contain its popup.
  (trigger.closest('dialog')||document.body).append(panel);trigger.setAttribute('aria-expanded','true');renderOptions();markOption(true);trigger.focus({preventScroll:true});
  if(!reduced())panel.animate([{opacity:0,transform:'translateY(-3px)'},{opacity:1,transform:'translateY(0)'}],{duration:120,easing:'ease-out'});
}
function choiceKey(event,trigger){
  const key=event.key;
  if(key==='Escape'){if(picker?.id===trigger.id){event.preventDefault();event.stopPropagation();closePicker(true);}return;}
  if(key==='Tab'){closePicker();return;}
  if(['ArrowDown','ArrowUp','Home','End','Enter',' '].includes(key)){
    event.preventDefault();const wasOpen=picker?.id===trigger.id;if(!wasOpen)openPicker(trigger);if(!picker)return;
    if(key==='Enter'||key===' '){if(wasOpen)chooseOption(picker.active);return;}
    const values=picker.config.options.filter(o=>!o.disabled).map(o=>String(o.value)),i=values.indexOf(picker.active);
    picker.active=key==='Home'?values[0]:key==='End'?values.at(-1):values[Math.max(0,Math.min(values.length-1,i+(key==='ArrowDown'?1:-1)))];markOption(true);return;
  }
  if(key.length===1&&!event.ctrlKey&&!event.metaKey&&!event.altKey){
    event.preventDefault();if(picker?.id!==trigger.id)openPicker(trigger);if(!picker)return;
    const now=Date.now();picker.search=now-(picker.searchAt||0)<700?(picker.search||'')+key:key;picker.searchAt=now;
    const o=picker.config.options.find(o=>!o.disabled&&o.label.toLocaleLowerCase().startsWith(picker.search.toLocaleLowerCase()));if(o){picker.active=String(o.value);markOption(true);}
  }
}
export function select(label,id,value,options,onChange,attrs={}) {
  value=String(value??'');
  const trigger=button([el('span',{class:'choice-value'},options.find(o=>String(o.value)===value)?.label||'请选择'),el('span',{class:'choice-chevron','aria-hidden':'true'},'⌄')],()=>picker?.id===id?closePicker(true):openPicker(trigger),
    {...attrs,id,name:id,value,class:'choice-trigger',role:'combobox','aria-haspopup':'listbox','aria-expanded':'false','aria-controls':id+'-listbox','aria-labelledby':id+'-label',onKeyDown:e=>choiceKey(e,trigger)});
  pickerConfig.set(trigger,{label,value,options,onChange});
  return el('div',{class:'field choice-field'},el('label',{id:id+'-label',htmlFor:id},label),trigger);
}
document.addEventListener('pointerdown',event=>{if(picker&&!picker.panel.contains(event.target)&&!picker.trigger.contains(event.target))closePicker();},true);
document.addEventListener('focusin',event=>{if(picker&&event.target!==picker.trigger&&!picker.panel.contains(event.target))closePicker();});
document.addEventListener('visibilitychange',()=>{if(document.hidden)closePicker();});
window.addEventListener('pagehide',()=>closePicker());
window.addEventListener('resize',placePicker);
document.addEventListener('scroll',placePicker,true);
function restorePicker(root,changed){
  if(!picker)return;
  const trigger=root.querySelector('#'+CSS.escape(picker.id));
  if(changed||!trigger||trigger.disabled||!pickerConfig.has(trigger)){closePicker();return;}
  picker.trigger=trigger;picker.config=pickerConfig.get(trigger);const parent=trigger.closest('dialog')||document.body;if(picker.panel.parentNode!==parent)parent.append(picker.panel);trigger.setAttribute('aria-expanded','true');renderOptions();
}
export function confirmationDialog({id,title,description,confirmLabel,onConfirm,onCancel,disabled=false}){
  return el('dialog',{id,class:'confirm-dialog','data-confirm-dialog':'true','aria-labelledby':id+'-title','aria-describedby':id+'-description',onCancel:e=>{e.preventDefault();onCancel();},onClick:e=>{if(e.target===e.currentTarget){const r=e.currentTarget.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)onCancel();}}},
    el('h2',{id:id+'-title'},title),el('p',{id:id+'-description'},description),el('div',{class:'actions'},button('返回',onCancel,{id:id+'-back','data-dialog-back':'true'}),button(confirmLabel,onConfirm,{id:id+'-confirm',class:'primary',disabled})));
}
export const definition=entries=>el('dl',{class:'definitions'},entries.flatMap(([a,b])=>[el('dt',{},a),el('dd',{},b??'—')]));
export const statuses={ready:'就绪',busy:'处理中',error:'出错',unavailable:'不可用',unknown:'尚未确认',configured:'已配置',missing:'未配置',active:'有效',invalidated:'已失效',deleted:'已删除',expired:'已过期',purged:'已清理',available:'已接入',not_integrated:'尚未接入'};
export const slots={asr:'语音转写',dialogue:'对话大模型',memory_turn:'记忆维护',summary:'摘要',perception:'视频情绪',tts:'语音合成 TTS',admission:'轮次判断'};
export const kinds={memory:'长期记忆',transcript:'对话原文',summary:'会话摘要',keyword_index:'关键词索引',vector_index:'向量索引',context_cache:'上下文缓存'};

// Preserve local reading position across data refreshes, without persisting user content.
const viewStates=new Map();
let activeView=null,activeDetail=null;
const reduced=()=>matchMedia('(prefers-reduced-motion: reduce)').matches;
function stateKey(node,index){
  const scope=node.closest('[data-detail-id]')?.dataset.detailId||'';
  return node.id||node.getAttribute('data-scroll-key')||scope+'/'+node.tagName+'/'+(node.querySelector(':scope > summary')?.textContent||node.className)+'/'+index;
}
export function captureView(root){
  if(activeView===null)return;
  const scrolls=new Map(),disclosures=new Map();
  root.querySelectorAll('[data-scroll-key],.record-list,.text-block,.tablescroll,textarea,dialog').forEach((n,i)=>scrolls.set(stateKey(n,i),[n.scrollLeft,n.scrollTop]));
  root.querySelectorAll('details').forEach((n,i)=>disclosures.set(stateKey(n,i),n.dataset.closing==='true'?false:n.open));
  const f=document.activeElement;
  let focus=f?.dataset.scrollKey?{selector:'[data-scroll-key="'+CSS.escape(f.dataset.scrollKey)+'"]'}:f?.id?{selector:'#'+CSS.escape(f.id)}:f?.dataset.mdRecord?{selector:'[data-md-record="'+CSS.escape(f.dataset.mdRecord)+'"]'}:null;
  if(focus&&f.selectionStart!=null)focus.selection=[f.selectionStart,f.selectionEnd];
  // A refresh can temporarily disable the focused control; retain its caret until enabled.
  const previous=viewStates.get(activeView)?.focus;
  if(!focus&&f===document.body&&previous&&root.querySelector(previous.selector)?.disabled)focus=previous;
  viewStates.set(activeView,{scrolls,disclosures,focus,window:[scrollX,scrollY]});
}
export function restoreView(root,key){
  const changed=activeView!==key,saved=viewStates.get(key),detail=root.querySelector('[data-detail-id]')?.dataset.detailId;
  root.querySelectorAll('.record-list,.text-block,.tablescroll').forEach((n,i)=>{if(!n.hasAttribute('tabindex'))n.tabIndex=0;if(!n.id&&!n.dataset.scrollKey)n.dataset.scrollKey=stateKey(n,i);});
  restorePicker(root,changed);
  // Show the replacement dialog before restoring focus: hidden dialogs cannot receive it.
  root.querySelectorAll('dialog').forEach(dialog=>{if(!dialog.open){dialog.showModal();(dialog.querySelector('[data-dialog-back]')||dialog.querySelector('#task-confirm-back'))?.focus({preventScroll:true});}});
  if(saved){
    root.querySelectorAll('details').forEach((n,i)=>{const open=saved.disclosures.get(stateKey(n,i));if(open!==undefined)n.open=open;});
    root.querySelectorAll('[data-scroll-key],.record-list,.text-block,.tablescroll,textarea,dialog').forEach((n,i)=>{const pos=saved.scrolls.get(stateKey(n,i));if(pos){n.scrollLeft=pos[0];n.scrollTop=pos[1];}});
    const f=saved.focus&&root.querySelector(saved.focus.selector);
    if(f){f.focus({preventScroll:true});if(saved.focus?.selection&&f.setSelectionRange)try{f.setSelectionRange(...saved.focus.selection)}catch{}}
    if(saved.window)window.scrollTo(...saved.window);
  }else if(changed)window.scrollTo(0,0);
  // Animate only navigation/selection changes, never polling or draft renders.
  if(!reduced()){
    if(changed)root.querySelector('.page-content')?.animate([{opacity:.55,transform:'translateY(5px)'},{opacity:1,transform:'translateY(0)'}],{duration:180,easing:'ease-out'});
    else if(detail&&detail!==activeDetail)root.querySelector('[data-detail-id]')?.animate([{opacity:.45,transform:'translateX(7px)'},{opacity:1,transform:'translateX(0)'}],{duration:180,easing:'ease-out'});
  }
  placePicker();
  activeView=key;activeDetail=detail;
  root.querySelectorAll('details').forEach(n=>{
    const summary=n.querySelector(':scope > summary');if(!summary||summary.dataset.disclosureBound)return;summary.dataset.disclosureBound='true';
    const body=el('div',{class:'disclosure-body'});for(const child of [...n.childNodes])if(child!==summary)body.append(child);n.append(body);
    let motion;
    summary.addEventListener('click',event=>{
      if(reduced())return;event.preventDefault();
      const expanding=!n.open||n.dataset.closing==='true';motion?.cancel();n.open=true;n.dataset.closing=String(!expanding);
      const height=body.scrollHeight;
      motion=body.animate(expanding?[{height:'0px',opacity:0},{height:height+'px',opacity:1}]:[{height:height+'px',opacity:1},{height:'0px',opacity:0}],{duration:180,easing:'ease-out'});
      body.style.overflow='clip'; // Only the temporary disclosure transition, never a scrolling region.
      motion.onfinish=()=>{n.open=expanding;delete n.dataset.closing;body.style.overflow='';motion=null;};
      motion.oncancel=()=>{body.style.overflow='';};
    });
  });
}
