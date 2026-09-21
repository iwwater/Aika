import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {fixture} from '../management/helpers.js';
import {SqliteMemoryStore,CONFIRMED_RETENTION} from '../../memory/sqlite-store.js';
import {confirmedInvitationPolicy} from '../../companion/invitations.js';
import {SqliteManagementMemoryPort} from '../../memory/management-port.js';
import {lifecycle,none,deferred} from '../memory/lifecycle-fixture.js';
import {scope,message} from '../memory/sqlite-fixture.js';
import {pendingMemoryManagement} from '../../management/pending-memory.js';
import {RoleMemoryLifecycleQueue} from '../../core/memory-lifecycle-queue.js';
import {ManagementSettingsStore} from '../../management/settings-store.js';
import {ManagementRuntime} from '../../management/runtime.js';
import {startManagementServer} from '../../management/server.js';
import type {MemoryTurnPlan,MemoryTurnInput} from '../../contracts/memory-lifecycle.js';

test('real HTTP/SQLite pending recovery is explicit, instance-bound, duplicate-safe and blocks the cancelled late writer',{timeout:5000},async t=>{
 const f=await fixture(t),filename=join(f.c.projectRoot,'pending.sqlite'),store=new SqliteMemoryStore({filename,retention:CONFIRMED_RETENTION,invitations:confirmedInvitationPolicy('Asia/Shanghai')});
 const gate=deferred<MemoryTurnPlan>();let input!:MemoryTurnInput,calls=0;
 const memory=lifecycle(store,async value=>{calls++;input=value;return gate.promise;}),queue=new RoleMemoryLifecycleQueue(memory,()=>{}),runtime=new ManagementRuntime(f.c.sourceRevision);
 const read=(s:ReturnType<typeof scope>,id:string)=>{const record=store.inspect(s,id);return record?.state==='active'?{text:record.text,createdAt:record.message!.createdAt}:undefined;};
 const pending=pendingMemoryManagement(runtime.instanceId,memory,read,(s,id,text)=>queue.enqueueTurn(s,id,text),()=>queue.observePending('companion').snapshot.running+queue.observePending('companion').snapshot.queued>0);
 await memory.append(scope(),[message('turn-1:user','<script>synthetic pending request</script>')]);memory.beginPendingMutation(scope(),'turn-1:user',{request:'uncertain',sources:null});
 const settings=await ManagementSettingsStore.open(join(f.c.projectRoot,'settings.json'),f.c);
 const server=await startManagementServer({uiRoot:'management/ui',settings,memory:new SqliteManagementMemoryPort(store,memory),pendingMemory:pending,snapshot:()=>({apiVersion:1,runtime:runtime.identity(),modules:runtime.modules(),events:[],settings:settings.snapshot(),adapters:[],credentials:[],characters:[]})});
 t.after(async()=>{if(input)gate.resolve(none(input));await server.close();await queue.close();store.close();});
 const headers={Authorization:'Bearer '+server.token,Origin:server.origin,'Content-Type':'application/json'},url=server.origin+'/api/memory-pending';
 assert.equal((await fetch(url)).status,401);const listing=await(await fetch(url,{headers})).json() as ReturnType<typeof pending.list>;
 assert.equal(calls,0);assert.equal(listing.requests.length,1);assert.equal(listing.requests[0]!.preview,'<script>synthetic pending request</script>');assert.ok(listing.requests[0]!.createdAt);
 const post=(action:string,instanceId:string=runtime.instanceId,h=headers)=>fetch(url+'/'+action,{method:'POST',headers:h,body:JSON.stringify({instanceId,id:'turn-1:user'})});
 assert.equal((await post('retry','old-instance')).status,409);assert.equal((await post('retry',runtime.instanceId,{...headers,Origin:'https://foreign.invalid'})).status,403);assert.equal(calls,0);
 assert.equal((await post('retry')).status,200);await new Promise(r=>setImmediate(r));assert.equal(calls,1);assert.equal((await post('retry')).status,409);assert.equal(calls,1);
 assert.equal((await post('cancel')).status,200);gate.resolve(none(input));await queue.drain();assert.deepEqual(memory.pendingMutations('companion'),[]);assert.equal(calls,1);
 assert.equal((await post('retry')).status,409);assert.equal(store.inspect(scope(),'turn-1:user')!.text,'<script>synthetic pending request</script>');
 assert.equal((await fetch(server.origin+'/pending-memory-view.mjs')).status,200);
 // FIX61-10: close explicitly before the after-hooks — the fixture rm (registered first) runs before
 // them on Windows and deletes the still-open SQLite file (EBUSY).
 if(input)gate.resolve(none(input));await queue.drain();await server.close();await queue.close();store.close();
});
