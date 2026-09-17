import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexWindowsConnection } from '../../dist/harness/codex-windows.js';
const threadId='11111111-1111-4111-8111-111111111111', turnId='22222222-2222-4222-8222-222222222222', requestId='33333333-3333-4333-8333-333333333333';
async function fixture(t, mode='ok') {
 const dir=await mkdtemp(join(tmpdir(),'aaaagent-codex-')), log=join(dir,'rpc.jsonl');
 const script=`
  const fs=require('fs');const rl=require('readline').createInterface({input:process.stdin});
  const mode=process.env.MOCK_MODE,log=process.env.MOCK_LOG,threadId=${JSON.stringify(threadId)},turnId=${JSON.stringify(turnId)};
  const send=o=>console.log(JSON.stringify(o));
  rl.on('line',line=>{const m=JSON.parse(line);fs.appendFileSync(log,JSON.stringify(m)+'\\n');
   if(!m.method)return;
   if(m.method==='initialized')return;
   if(m.method==='initialize')return send({id:m.id,result:{platformOs:'windows'}});
   if(m.method==='account/read')return send({id:m.id,result:{account:mode==='unauthenticated'?null:{type:'chatgpt'}}});
   if(m.method==='thread/read'||m.method==='thread/resume')return send({id:m.id,result:{thread:{id:mode==='wrong-thread'?'other':threadId,status:{type:mode==='busy'?'active':'idle'},turns:[{id:turnId,status:mode==='interrupted'?'interrupted':'completed',items:[{type:'agentMessage',text:'中文完成'}]}]}}});
   if(m.method==='turn/start'){
    if(mode==='lost')return;
    if(mode==='rejected')return send({id:m.id,error:{code:-1,message:'private server detail'}});
    if(mode==='approval')send({id:'approval',method:'item/commandExecution/requestApproval',params:{}});
    return send({id:m.id,result:{turn:{id:turnId}}});
   }
  });
 `;
 const connection=new CodexWindowsConnection(dir,process.execPath,1000,()=>spawn(process.execPath,['-e',script],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,MOCK_MODE:mode,MOCK_LOG:log}}));
 t.after(async()=>{await connection.close();await rm(dir,{recursive:true,force:true});});
 return {connection,async calls(){return(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse);}};
}
test('Windows app-server authenticates, resumes exact target, starts once and reads exact receipt',async t=>{
 const f=await fixture(t),c=f.connection;
 assert.equal(await c.compatible(),true);assert.deepEqual(await c.discover(threadId),{available:true});
 assert.deepEqual(await c.send(threadId,'Test 中文',requestId),{threadId,turnId,requestId});
 assert.deepEqual(await c.receipt(threadId,turnId),{threadId,turnId,status:'completed',reply:'中文完成'});
 const calls=await f.calls();assert.equal(calls.filter(x=>x.method==='initialize').length,1);
 const start=calls.filter(x=>x.method==='turn/start');assert.equal(start.length,1);assert.equal(start[0].params.threadId,threadId);
 assert.equal(start[0].params.input[0].text,'Test 中文');assert.equal('approvalPolicy'in start[0].params,false);
});
for(const mode of ['lost','rejected'])test('Windows send '+mode+' response stays unknown without retry',async t=>{
 const f=await fixture(t,mode);await assert.rejects(f.connection.send(threadId,'test',requestId),e=>e.code==='unknown_delivery');
 assert.equal((await f.calls()).filter(x=>x.method==='turn/start').length,1);
});
test('Windows compatibility rejects missing account and busy targets without a send',async t=>{
 const unauth=await fixture(t,'unauthenticated');assert.equal(await unauth.connection.compatible(),false);
 const busy=await fixture(t,'busy');assert.deepEqual(await busy.connection.discover(threadId),{available:false});
 await assert.rejects(busy.connection.send(threadId,'test',requestId),e=>e.code==='unavailable');
 assert.equal((await busy.calls()).some(x=>x.method==='turn/start'),false);
});
test('Windows receipt cannot accept another thread or turn',async t=>{
 const wrong=await fixture(t,'wrong-thread');assert.equal((await wrong.connection.receipt(threadId,turnId)).status,'unknown');
 const f=await fixture(t);assert.equal((await f.connection.receipt(threadId,requestId)).status,'unknown');
});
test('Windows interrupted turn stays unknown and invalid IDs fail before RPC',async t=>{
 const f=await fixture(t,'interrupted');assert.equal((await f.connection.receipt(threadId,turnId)).reason,'interrupted');
 await assert.rejects(f.connection.send('../bad','test',requestId),e=>e.code==='invalid_target');
 await assert.rejects(f.connection.send(threadId,'bad\0input',requestId),e=>e.code==='invalid_target');
});
test('Windows bridge declines tool approval instead of silently granting permissions',async t=>{
 const f=await fixture(t,'approval');await f.connection.send(threadId,'test',requestId);
 await f.connection.receipt(threadId,turnId);
 assert.deepEqual((await f.calls()).find(x=>x.id==='approval').result,{decision:'decline'});
});
