import test from 'node:test';import assert from 'node:assert/strict';import {mkdir,writeFile} from 'node:fs/promises';import {resolve} from 'node:path';import {pathToFileURL} from 'node:url';import {createMemoryDynamicsFixture} from './memory-dynamics-fixture.mjs';
const {webkit}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));const output=resolve(process.env.MANAGEMENT_UI_OUTPUT);await mkdir(output,{recursive:true});
const at='2026-09-19T06:00:00.000Z';
const source=(id='synthetic-user',version=1)=>({id,version});
const scope={characterId:'companion',sessionId:'synthetic-session',turnId:'turn-1',generation:1};
const observation=(subject,label,provenance,intensity=null,confidence=null)=>({subject,label,provenance,intensity,confidence,sources:[source()]});
const empty=subject=>({subject,revision:0,observation:null,updatedAt:null,sourceMessage:null,logicalOrder:null,sessionId:null});
const sustained=(subject,o,revision=1)=>({...empty(subject),revision,observation:o,updatedAt:at,sourceMessage:source(),logicalOrder:1,sessionId:scope.sessionId});
const background=()=>({user:sustained('user',observation('user','sad','user_explicit')),companion:sustained('companion',observation('companion','calm','companion_inference',.3,.8))});
const message=(i,role='user')=>({role,message:source('synthetic-message-'+i),scope:{...scope,turnId:'turn-'+i},logicalOrder:i,recordedAt:at,observations:[role==='user'?observation('user','neutral','audio',0,0):observation('companion','happy','companion_inference',.5,.7)],background:background()});
const analysis=(id,m,status='applied',appliedSubjects=['user'])=>({id,message:m.message,scope:m.scope,completedAt:'2026-09-19T06:05:00.000Z',origin:'background',assessment:{user:observation('user','happy','text_recent_context',null,.7),companion:observation('companion','PRIVATE_NOT_APPLIED','companion_inference')},appliedSubjects,status});

test('emotion UI preserves distinct current, frozen and later records using read-only synthetic HTTP',async t=>{
 const fixture=await createMemoryDynamicsFixture(),browser=await webkit.launch({headless:true}),context=await browser.newContext({viewport:{width:1100,height:1000},reducedMotion:'reduce'}),page=await context.newPage();page.setDefaultTimeout(6000);
 let state={version:'0.1.1',instanceId:'synthetic-memory-instance',characterId:'companion',revision:0,pending:0,user:empty('user'),companion:empty('companion'),messages:[],analyses:[]},mode='',delay=0,gets=0,external=0;
 const requests=[],checks=[],errors=[];page.on('pageerror',e=>errors.push(e.message));await page.addInitScript(()=>{window.deviceCalls=0;navigator.mediaDevices.getUserMedia=()=>{window.deviceCalls++;throw Error('No devices');};});
 await page.route('**/*',route=>{if(new URL(route.request().url()).origin!==new URL(fixture.url).origin){external++;return route.abort();}return route.continue();});
 await page.route('**/api/emotion?*',async route=>{
  const req=route.request(),url=new URL(req.url());assert.equal(req.method(),'GET');assert.equal(req.headers().authorization,'Bearer memory-dynamics-synthetic-session');assert.equal(url.searchParams.get('characterId'),'companion');assert.equal(url.searchParams.get('limit'),'20');
  const offset=Number(url.searchParams.get('offset'));gets++;requests.push({method:req.method(),offset,limit:20});
  const messages=state.messages.slice(offset,offset+20);const value=structuredClone({...state,messages,analyses:state.analyses.filter(a=>messages.some(m=>JSON.stringify(m.message)===JSON.stringify(a.message)&&m.scope.turnId===a.scope.turnId)),total:state.messages.length,offset,limit:20});
  if(mode==='offline')return route.fulfill({status:503,json:{error:{message:'PRIVATE_SERVER_ERROR'}}});
  if(mode==='auth')return route.fulfill({status:401,json:{error:{message:'PRIVATE_SERVER_ERROR'}}});
  if(mode==='old')value.revision=0;if(mode==='instance')value.instanceId='foreign-instance';if(mode==='role')value.characterId='retired';if(mode==='version')value.version='0.1.0';if(mode==='offset')value.offset=999;
  if(mode==='nested-role')value.messages[0].scope.characterId='retired';
  if(mode==='misbound')value.analyses=[analysis('foreign-message',message(999))];
  if(mode==='subject')value.user.observation.subject='companion';
  if(mode==='missing-score')delete value.user.observation.confidence;if(mode==='negative-score')value.user.observation.intensity=-.1;if(mode==='large-score')value.user.observation.confidence=1.1;if(mode==='zero-source')value.user.observation.sources[0].version=0;
  if(delay)await new Promise(r=>setTimeout(r,delay));return route.fulfill({json:value});
 });
 const click=id=>page.locator('#'+id).click(),ready=()=>page.locator('#emotion-refresh:not([disabled])').waitFor();const refresh=async()=>{await ready();await click('emotion-refresh');await ready();};
 const check=async(name,fn)=>{await t.test(name,async()=>{await fn();checks.push(name);});assert.ok(checks.includes(name),'Stopped after failed scenario '+name);};
 try{await page.goto(fixture.url);await click('nav-memory');await click('memory-emotion');await ready();
  await check('empty states show no observation rather than neutral; GET only and no polling',async()=>{
   assert.equal(await page.locator('#emotion-current .emotion-label').allTextContents().then(x=>x.join('|')),'暂无情绪记录|暂无情绪记录');assert.doesNotMatch(await page.locator('#emotion-panel').innerText(),/中性/);assert.match(await page.locator('#emotion-current').innerText(),/未评估/);assert.ok(await page.locator('#emotion-next').isDisabled());
   const before=gets;await page.waitForTimeout(3100);assert.equal(gets,before);
  });
  await check('user and companion differ, unknown/null/zero remain distinct, message speaker stays explicit',async()=>{
   state={...state,...background(),revision:1,messages:[message(1),message(2,'assistant')],pending:1};await refresh();
   assert.match(await page.locator('#emotion-current > [data-emotion-subject=user]').innerText(),/难过.*sad/s);assert.match(await page.locator('#emotion-current > [data-emotion-subject=companion]').innerText(),/平静.*calm/s);
   const row=page.locator('[data-emotion-message=synthetic-message-1]');await row.locator('summary').first().click();assert.match(await row.innerText(),/中性（neutral）/);assert.match(await row.innerText(),/强度\n0\n置信度\n0/);assert.match(await row.innerText(),/音频观察/);assert.match(await page.locator('[data-emotion-message=synthetic-message-2] > summary').innerText(),/桌宠回复/);
   state.user=sustained('user',observation('user','unknown','text_recent_context'));state.revision++;await refresh();assert.match(await page.locator('#emotion-current > [data-emotion-subject=user]').innerText(),/未确定（unknown）/);assert.ok(await row.evaluate(n=>n.open));
   await page.locator('#emotion-current').screenshot({path:resolve(output,'current-wide.png')});
  });
  await check('late analysis stays outside immutable snapshot; independent applied subjects and null assessments',async()=>{
   const row=page.locator('[data-emotion-message=synthetic-message-1] [data-emotion-frozen]');const original=await row.innerText();
   state.analyses=[analysis('later-user',state.messages[0]),analysis('old-result',state.messages[0],'stale',[]),{...analysis('cancelled-result',state.messages[1],'cancelled',[]),assessment:null},{...analysis('invalid-result',state.messages[1],'invalid',[]),assessment:null}];state.user=sustained('user',observation('user','happy','text_recent_context',.4,.9),3);state.revision++;state.pending=0;await refresh();assert.equal(await row.innerText(),original);assert.match(await page.locator('#emotion-current > [data-emotion-subject=user]').innerText(),/开心/);
   assert.match(await page.locator('[data-emotion-analysis=later-user]').innerText(),/后台后续推测/);assert.match(await page.locator('[data-emotion-analysis=old-result]').innerText(),/未应用：已过期/);assert.match(await page.locator('[data-emotion-analysis=cancelled-result]').innerText(),/未应用：已取消/);assert.doesNotMatch(await page.locator('#emotion-panel').innerText(),/PRIVATE_NOT_APPLIED/);
   assert.equal(await page.locator('[data-emotion-frozen] [data-emotion-analysis]').count(),0);
  });
  await check('pagination binds analyses to exact page and source version',async()=>{
   state.messages=Array.from({length:25},(_,i)=>message(i+1,i%2?'assistant':'user'));state.analyses=[analysis('page-one',state.messages[0]),{...analysis('page-two',state.messages[24]),origin:'dialogue'}];state.revision++;await refresh();assert.match(await page.locator('#emotion-page-count').innerText(),/1–20 \/ 25/);
   await click('emotion-next');await ready();assert.equal(requests.at(-1).offset,20);assert.match(await page.locator('#emotion-page-count').innerText(),/21–25 \/ 25/);assert.equal(await page.locator('[data-emotion-analysis=page-one]').count(),0);assert.match(await page.locator('[data-emotion-analysis=page-two]').innerText(),/对话后续分析/);assert.ok(await page.locator('#emotion-next').isDisabled());
   await click('emotion-prev');await ready();assert.equal(requests.at(-1).offset,0);assert.equal(await page.locator('[data-emotion-analysis=page-two]').count(),0);
  });
  await check('old revision, foreign identity/role, misbound analysis and malformed fields never replace valid data',async()=>{
   const expected=await page.locator('#emotion-current').innerText();
   for(const m of ['old','instance','role','nested-role','version','offset','misbound','subject','missing-score','negative-score','large-score','zero-source','offline']){mode=m;await refresh();assert.equal(await page.locator('#emotion-current').innerText(),expected);assert.match(await page.locator('#emotion-panel').innerText(),/上次读取的记录/);assert.ok(await page.locator('#emotion-next').isDisabled());assert.doesNotMatch(await page.locator('#emotion-panel').innerText(),/PRIVATE_SERVER_ERROR/);}
   mode='';await refresh();assert.ok(await page.locator('#emotion-next').isEnabled());
  });
  await check('late prior-page/instance response cannot replace new snapshot; new instance starts revision independently',async()=>{
   delay=300;const before=gets;await page.evaluate(()=>document.getElementById('emotion-refresh').click());await page.waitForFunction(()=>document.getElementById('emotion-refresh').disabled);assert.ok(gets>before);await click('nav-overview');
   state={...state,instanceId:'new-emotion-instance',revision:0,user:empty('user'),companion:empty('companion'),messages:[],analyses:[]};fixture.state.controls.instanceId=state.instanceId;delay=0;await click('refresh');await page.locator('#refresh:not([disabled])').waitFor();await click('nav-memory');await ready();await page.waitForTimeout(350);
   assert.match(await page.locator('#emotion-current').innerText(),/暂无情绪记录/);assert.equal(await page.locator('.emotion-message').count(),0);assert.match(await page.locator('#emotion-snapshot-details').textContent(),/记录版本 0/);
  });
  await check('long labels and refs render as text on 380px; expanded snapshot survives refresh',async()=>{
   state={...state,...background(),revision:1,messages:[message(1)],analyses:[]};state.user.observation.label='<img src=x onerror="window.unsafe=true">合成扩展标签';state.user.observation.sources=[source('long-synthetic-source-'.repeat(10),3)];await refresh();await page.setViewportSize({width:380,height:1000});assert.equal(await page.locator('#emotion-current img').count(),0);assert.equal(await page.evaluate(()=>window.unsafe),undefined);
   const row=page.locator('[data-emotion-message=synthetic-message-1]');await row.locator('summary').first().click();await refresh();assert.ok(await row.evaluate(n=>n.open));assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await row.screenshot({path:resolve(output,'frozen-message-380.png')});
   assert.equal(await page.evaluate(()=>window.deviceCalls),0);assert.equal(external,0);assert.deepEqual(errors,[]);assert.equal(fixture.state.writes.length,0);assert.ok(requests.every(r=>r.method==='GET'));
  });
  await check('unauthorized read clears action availability and never emits server diagnostics',async()=>{mode='auth';await ready();await click('emotion-refresh');await page.locator('input#session').waitFor();assert.ok(await page.locator('#emotion-refresh').isDisabled());assert.match(await page.locator('body').innerText(),/会话已失效/);assert.doesNotMatch(await page.locator('body').innerText(),/PRIVATE_SERVER_ERROR/);});
  assert.equal(checks.length,8);await writeFile(resolve(output,'evidence.json'),JSON.stringify({checks,engine:browser.version(),requests,gets,errors,external,productWrites:0,cloudCalls:0,devices:0,privateDataReads:0,boundary:'Real management UI in isolated WebKit with synthetic HTTP. No emotion persistence, true model inference, installed runtime or user emotion accuracy acceptance.'},null,2));
 }finally{await context.close();await browser.close();await fixture.close();}
});
