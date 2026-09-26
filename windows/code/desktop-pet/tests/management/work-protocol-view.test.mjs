import test from 'node:test';
import assert from 'node:assert/strict';

class FakeNode {
  constructor(tagName) { this.tagName=tagName.toUpperCase();this.children=[];this.attributes=new Map();this.listeners=new Map();this.dataset={};this.className='';this.value='';this.disabled=false;this.text=''; }
  set textContent(value){this.text=String(value);this.children=[];}
  get textContent(){return this.text+this.children.map(child=>child.textContent).join('');}
  addEventListener(type,listener){this.listeners.set(type,listener);}
  setAttribute(name,value){this.attributes.set(name,String(value));if(name.startsWith('data-'))this.dataset[name.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=String(value);}
  removeAttribute(name){this.attributes.delete(name);}
  append(...nodes){for(const node of nodes){node.parentNode=this;this.children.push(node);}}
  click(){return this.listeners.get('click')?.({target:this,currentTarget:this});}
}
globalThis.Node=FakeNode;
globalThis.document={createElement:tag=>new FakeNode(tag),createTextNode:text=>{const node=new FakeNode('#text');node.textContent=text;return node;},addEventListener(){}};
globalThis.window={addEventListener(){}};
const {createWorkProtocolView}=await import('../../management/ui/work-protocol-view.mjs');

function find(node,predicate){if(predicate(node))return node;for(const child of node.children){const found=find(child,predicate);if(found)return found;}return null;}
function byId(node,id){return find(node,n=>n.attributes?.get('id')===id);}
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('Work 协议页保存执行器后只准备请求；修订后确认卡展示当前版本，点击确认才派发',async()=>{
  const requests=[];let profile={revision:0},workRequest=null,confirmed=false;
  const client={async request(path,options={}){
    requests.push({path,options});
    if(path==='/api/work-protocol')return {profiles:profile,requests:workRequest?[{request:workRequest,dispatchStarted:confirmed,eventPublished:confirmed,forgotten:false,...(confirmed?{receipt:{operationId:workRequest.operationId,status:'succeeded',updatedAt:'2026-09-24T10:00:00.000Z',summary:'fixture result'}}:{})}]:[]};
    if(path==='/api/work-protocol/profiles'){profile={revision:1,acp:{executorId:'fixture-acp',label:'Fixture ACP',command:'C:\\tools\\agent.exe',args:['--profile','safe'],cwd:'C:\\workspace',environmentKeys:['FIXTURE_TOKEN']}};return {profiles:profile};}
    if(path==='/api/work-protocol/prepare'){const b=options.body;workRequest={...b,operationId:'operation-fixture',revision:1,executorRevision:1,requestedAt:'2026-09-24T09:00:00.000Z'};return {request:workRequest};}
    if(path==='/api/work-protocol/revise'){const b=options.body;workRequest={...workRequest,...b.updates,revision:2};return {request:workRequest};}
    if(path==='/api/work-protocol/confirm'){confirmed=true;return {receipt:{operationId:workRequest.operationId,status:'succeeded',updatedAt:'2026-09-24T10:00:00.000Z',summary:'fixture result'}};}
    throw new Error('unexpected API request '+path);
  }};
  let view;const render=()=>{};view=createWorkProtocolView(client,render,()=>true);
  await view.refresh();
  let page=view.view();
  const editor=byId(page,'protocol-profiles-json');assert.ok(editor);
  editor.value=JSON.stringify({acp:{executorId:'fixture-acp',label:'Fixture ACP',command:'C:\\tools\\agent.exe',args:['--profile','safe'],cwd:'C:\\workspace',env:{FIXTURE_TOKEN:'private'}}});
  editor.listeners.get('input')({target:editor});
  await byId(page,'protocol-profiles-save').click();await tick();
  page=view.view();
  for(const [id,value] of [['protocol-title','Reviewable task'],['protocol-directory','C:\\workspace\\repo'],['protocol-instruction','initial task body']]){
    const input=byId(page,id);input.value=value;input.listeners.get('input')({target:input});page=view.view();
  }
  await byId(page,'protocol-prepare').click();await tick();
  assert.equal(confirmed,false,'preparing a card does not start the child process');
  assert.equal(requests.some(x=>x.path==='/api/work-protocol/confirm'),false);
  page=view.view();await byId(page,'protocol-load-edit').click();page=view.view();
  const instruction=byId(page,'protocol-instruction');instruction.value='reviewed task body';instruction.listeners.get('input')({target:instruction});
  page=view.view();await byId(page,'protocol-revise').click();await tick();
  page=view.view();await byId(page,'protocol-review').click();page=view.view();
  assert.ok(page.textContent.includes('C:\\tools\\agent.exe'));
  assert.ok(page.textContent.includes('reviewed task body'));
  assert.ok(page.textContent.includes('执行器配置版本'));
  assert.ok(page.textContent.includes('FIXTURE_TOKEN'));
  assert.equal(confirmed,false,'opening the confirmation card still does not dispatch');
  const send=byId(page,'protocol-confirm-send');assert.ok(send);
  await send.click();await tick();
  assert.equal(confirmed,true);
  const confirmCall=requests.findLast(item=>item.path==='/api/work-protocol/confirm');
  assert.deepEqual(confirmCall.options.body,{operationId:'operation-fixture',expectedRevision:2});
  view.dispose();
});
