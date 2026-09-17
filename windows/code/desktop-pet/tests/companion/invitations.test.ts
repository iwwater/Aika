import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { InvitationPolicy } from '../../contracts/index.js';
import { confirmedInvitationPolicy } from '../../companion/invitations.js';
import { fixture, scope, seed, change, NOW } from '../memory/sqlite-fixture.js';

const candidate=(id:string,eventId='job')=>({id,eventId,text:'今天的工作怎么样？',gesture:'wave',eligibleAt:NOW,expiresAt:'2026-09-10T12:00:00Z'});

test('A15: only a companion event produces a bubble; only a shown invitation click returns voice intent',t=>{
  const f=fixture();t.after(f.cleanup);const store=f.open();seed(store);
  store.invitations.register(scope('companion'),candidate('love'));
  assert.throws(()=>store.invitations.showNext(scope('sweetheart')),/unknown_character/);
  assert.equal(store.invitations.click(scope('companion'),'love'),null);
  const shown=store.invitations.showNext(scope('companion'))!;
  assert.equal(shown.characterId,'companion');assert.equal(shown.status,'shown');assert.ok(!('audio' in shown));
  assert.throws(()=>store.invitations.click(scope('sweetheart'),'love'),/unknown_character/);
  const voice=store.invitations.click(scope('companion'),'love')!;assert.equal(voice.type,'start_voice');assert.equal(voice.scope.characterId,'companion');
  assert.equal(store.invitations.click(scope('companion'),'love'),null);
});

test('A16: daily max and minimum interval are app-wide for companion and survive restart',t=>{
  const f=fixture();t.after(f.cleanup);let store=f.open();seed(store);
  store.invitations.register(scope(),candidate('a'));store.invitations.register(scope('companion'),candidate('b'));store.invitations.register(scope(),candidate('c'));
  assert.equal(store.invitations.showNext(scope())!.id,'a');
  f.setTime('2026-09-06T14:59:59.999Z');assert.equal(store.invitations.showNext(scope('companion')),null);
  store.close();store=f.open();f.setTime('2026-09-06T15:00:00.000Z');assert.equal(store.invitations.showNext(scope('companion'))!.id,'b');
  // Same local day at 23:00: daily 2 remains exhausted even with configurable interval reduced to 0.
  store.invitations.configure({...confirmedInvitationPolicy('Asia/Shanghai'),minIntervalMs:0});assert.equal(store.invitations.showNext(scope()),null);
  store.invitations.configure(confirmedInvitationPolicy('Asia/Shanghai'));
  f.setTime('2026-09-06T16:00:00.000Z');assert.equal(store.invitations.showNext(scope()),null); // next day but 1h only
  f.setTime('2026-09-06T18:00:00.000Z');assert.equal(store.invitations.showNext(scope())!.id,'c');
});

test('A16: ignored event stays suppressed for its local day, including fresh invitation IDs and restart',t=>{
  const f=fixture();t.after(f.cleanup);let store=f.open();seed(store);
  store.invitations.register(scope(),candidate('a'));store.invitations.register(scope(),candidate('same-event-new-id'));
  assert.ok(store.invitations.showNext(scope()));assert.equal(store.invitations.ignore(scope(),'a'),true);
  f.setTime('2026-09-06T15:00:00Z');assert.equal(store.invitations.showNext(scope()),null);
  store.close();store=f.open();assert.equal(store.invitations.showNext(scope()),null);
  f.setTime('2026-09-06T16:00:00Z');assert.equal(store.invitations.showNext(scope())!.id,'same-event-new-id');
});

test('A12/A15: update or forget invalidates persisted invitation payload and click immediately',t=>{
  const f=fixture();t.after(f.cleanup);const store=f.open();seed(store);store.invitations.register(scope(),candidate('a'));
  assert.ok(store.invitations.showNext(scope()));
  store.apply(change({type:'soft_delete',id:'job',expectedVersion:1},'forget'),['raw']);
  const invitation=store.invitations.inspect(scope(),'a')!;assert.equal(invitation.status,'expired');assert.equal(invitation.text,'');
  assert.equal(store.invitations.click(scope(),'a'),null);
  assert.throws(()=>store.invitations.register(scope(),candidate('b')),/active_role_event/);
});

test('A16: two open connections serialize quota checks; changing configuration never resets delivery history',t=>{
  const f=fixture();t.after(f.cleanup);const a=f.open();seed(a);const b=f.open();
  a.invitations.register(scope(),candidate('a'));a.invitations.register(scope('companion'),candidate('b'));
  a.invitations.configure({...confirmedInvitationPolicy('Asia/Shanghai'),dailyMax:1,minIntervalMs:0});
  assert.ok(a.invitations.showNext(scope()));assert.equal(b.invitations.showNext(scope('companion')),null);
  a.invitations.configure({...confirmedInvitationPolicy('Asia/Shanghai'),dailyMax:2,minIntervalMs:0});assert.ok(b.invitations.showNext(scope('companion')));
  f.setTime('2026-09-05T12:00:00Z');a.invitations.register(scope(),candidate('c'));assert.equal(a.invitations.showNext(scope()),null);
});

test('timezone is required, and unconfigured/mismatched policies do not invent a quota',t=>{
  const f=fixture();t.after(f.cleanup);const store=f.open();
  assert.throws(()=>store.invitations.configure({...confirmedInvitationPolicy('Invalid/Zone')}));
  assert.throws(()=>store.invitations.configure({...confirmedInvitationPolicy('Asia/Shanghai'),quotaScope:'per_character'}),/invalid_invitation_policy/);
  for (const timezone of [undefined, null, '']) assert.throws(()=>store.invitations.configure({...confirmedInvitationPolicy('Asia/Shanghai'),timezone} as unknown as InvitationPolicy),/invalid_invitation_policy/);
});

test('A16: two independent processes race for one remaining global invitation slot', {timeout:15000}, async t=>{
  const f=fixture();t.after(f.cleanup);const store=f.open();seed(store);
  store.invitations.register(scope(),candidate('first-bubble'));
  store.invitations.register(scope('companion'),candidate('second-bubble'));
  const policy={...confirmedInvitationPolicy('Asia/Shanghai'),dailyMax:1,minIntervalMs:0};
  store.invitations.configure(policy);store.close();
  const storeModule=new URL('../../memory/sqlite-store.js',import.meta.url).href;
  const children=['companion','companion'].map(characterId=>{
    const child=spawn(process.execPath,['--input-type=module','-e',`
      import {SqliteMemoryStore} from ${JSON.stringify(storeModule)};
      const options=JSON.parse(process.argv[1]);options.clock=()=>${JSON.stringify(NOW)};
      const store=new SqliteMemoryStore(options);
      process.once('message',()=>{
        const result=store.invitations.showNext({characterId:process.argv[2],sessionId:'race',turnId:'race',generation:1});
        console.log(JSON.stringify(result));store.close();process.disconnect();
      });
      process.send('ready');
    `,JSON.stringify({...f.options,invitations:policy}),characterId],{stdio:['ignore','pipe','pipe','ipc']});
    t.after(()=>{if(child.exitCode===null) child.kill();});
    let output='';let error='';child.stdout!.on('data',chunk=>output+=chunk);child.stderr!.on('data',chunk=>error+=chunk);
    const ready=new Promise<void>((resolve,reject)=>{child.once('message',()=>resolve());child.once('error',reject);child.once('exit',code=>{if(code!==0) reject(new Error(error));});});
    const done=new Promise<unknown>((resolve,reject)=>{child.once('error',reject);child.once('close',code=>{if(code!==0) reject(new Error(error));else {try{resolve(JSON.parse(output));}catch(e){reject(e);}}});});
    return {child,ready,done};
  });
  await Promise.all(children.map(child=>child.ready));
  children.forEach(({child})=>child.send('go'));
  const results=await Promise.all(children.map(child=>child.done));
  assert.equal(results.filter(Boolean).length,1);
  t.diagnostic('independent_processes=2 simultaneous_start=true delivered=1 global_daily_max=1');
});
