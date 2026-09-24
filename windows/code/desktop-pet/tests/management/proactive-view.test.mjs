import test from 'node:test';
import assert from 'node:assert/strict';

class FakeNode {
  constructor(tag) {
    this.tagName=tag.toUpperCase();this.children=[];this.listeners=new Map();this.attributes=new Map();
    this.checked=false;this.disabled=false;this.value='';this.id='';this.type='';this.className='';this.text='';
  }
  set textContent(value){this.text=String(value);this.children=[];}
  get textContent(){return this.text+this.children.map(child=>child.textContent).join('');}
  addEventListener(type,listener){this.listeners.set(type,listener);}
  setAttribute(name,value){this.attributes.set(name,String(value));}
  append(...nodes){this.children.push(...nodes);}
  click(){return this.listeners.get('click')?.({target:this,currentTarget:this});}
  change(value){return this.listeners.get('change')?.({target:{value,checked:value}});}
}
globalThis.Node=FakeNode;
globalThis.document={createElement:tag=>new FakeNode(tag),createTextNode:value=>{const n=new FakeNode('#text');n.textContent=value;return n;},addEventListener(){}};
globalThis.window={addEventListener(){}};

const {createProactiveView}=await import('../../management/ui/proactive-view.mjs');
function find(node,predicate){if(predicate(node))return node;for(const child of node.children){const result=find(child,predicate);if(result)return result;}return null;}
const savedPolicy={revision:0,enabled:false,dailyMax:2,minIntervalMs:10800000,timezone:'Asia/Shanghai',dndStartHour:22,dndEndHour:8,sourceKinds:['continuity_fact']};

test('主动陪伴设置通过受保护策略 API 保存 opt-in，限制来源与共享仲裁，并不暴露事实正文',async()=>{
  const requests=[];let persisted={...savedPolicy};
  const client={async request(path,options){requests.push({path,options});if(options.method==='POST')return {policy:{...persisted}};
    persisted={...options.body.policy,revision:persisted.revision+1};return {policy:{...persisted}};}};
  const page=createProactiveView(client,()=>{},()=>({pairing:{userId:'local-user',characterId:'companion',characterInstanceId:'companion-default'},connection:'online'}));
  await page.refresh();
  let tree=page.view();
  assert.ok(tree.textContent.includes('默认关闭'));
  assert.ok(tree.textContent.includes('此刻之后新晋升且来源有效的事实或里程碑'));
  assert.ok(tree.textContent.includes('不包含事实原文'));
  assert.ok(tree.textContent.includes('与本地问候共享现有上限'));
  assert.ok(tree.textContent.includes('屏幕 Observation 与日程来源尚未接入'));

  const toggle=find(tree,node=>node.tagName==='INPUT'&&node.type==='checkbox');
  assert.ok(toggle);
  toggle.change(true);
  tree=page.view();
  const save=find(tree,node=>node.tagName==='BUTTON'&&node.textContent==='保存策略');
  assert.ok(save);
  await save.click();
  assert.equal(requests.length,2);
  assert.deepEqual(requests.map(({path,options})=>[path,options.method]),[['/api/proactive/policy','POST'],['/api/proactive/policy','PUT']]);
  const write=requests[1].options.body;
  assert.equal(write.policy.enabled,true);
  assert.deepEqual(write.policy.sourceKinds,['continuity_fact']);
  assert.equal(write.policy.dailyMax,2);
  assert.equal(write.policy.minIntervalMs,10800000);
  assert.ok(!JSON.stringify(tree).includes('用户保存的真实节点正文'));
  assert.ok(page.view().textContent.includes('策略已启用'));
});

test('管理页离线时不读取或保存策略',async()=>{
  let calls=0;
  const page=createProactiveView({async request(){calls++;throw new Error('should not be called');}},()=>{},()=>({pairing:{userId:'local-user',characterId:'companion',characterInstanceId:'companion-default'},connection:'offline'}));
  await page.refresh();
  assert.equal(calls,0);
  assert.ok(page.view().textContent.includes('连接运行中的桌宠'));
});
