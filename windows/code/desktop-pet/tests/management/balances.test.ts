import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,stat,readFile,symlink,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {FinanceCredentials} from '../../management/balance-credentials.js';
import {ProviderBalances,balanceRows,rpcSignature} from '../../management/balances.js';
async function fixture(t:{after(fn:()=>Promise<void>):void}){const parent=resolve('../../.local/balances-32/tmp');await mkdir(parent,{recursive:true});const root=await mkdtemp(join(parent,'balance-'));t.after(()=>rm(root,{recursive:true,force:true}));return {root,credentials:new FinanceCredentials(root)};}
const data={is_available:true,balance_infos:[{currency:'CNY',total_balance:'123.45'},{currency:'USD',total_balance:'6.70'}]};
const response=(v:unknown)=>new Response(JSON.stringify(v),{headers:{'content-type':'application/json'}});
test('RPC signature agrees with official SDK and independent Python vector',()=>{
 const p={Timestamp:'2019-08-23T12:46:24Z',Format:'XML',AccessKeyId:'testid',Action:'DescribeRegions',SignatureMethod:'HMAC-SHA1',SignatureNonce:'3ee8c1b8-83d3-44af-a94f-4e0ad82fd6cf',Version:'2019-09-10',SignatureVersion:'1.0'};
 assert.equal(rpcSignature(p,'testsecret'),'u5GLRDKD9xTcL8TpK+1XvnDlVx8=');
});
test('official fields preserve separate currencies, negative cash and legitimate zero; missing values fail',()=>{
 assert.deepEqual(balanceRows('deepseek',data),[{currency:'CNY',amount:'123.45'},{currency:'USD',amount:'6.70'}]);
 assert.deepEqual(balanceRows('aliyun',{Success:true,Data:{Currency:'CNY',AvailableCashAmount:'-1,234.50',AvailableAmount:'0.00'}}),[{currency:'CNY',amount:'-1234.50',availableCredit:'0.00'}]);
 for(const v of [undefined,null,'','1,2','NaN','1e6',0])assert.throws(()=>balanceRows('aliyun',{Success:true,Data:{Currency:'CNY',AvailableCashAmount:v}}));
 assert.throws(()=>balanceRows('deepseek',{...data,balance_infos:[data.balance_infos[0],data.balance_infos[0]]}));
});
test('snapshot never waits; five-minute cache and ten-second manual cooldown coalesce requests',async t=>{
 const f=await fixture(t);let clock=1000000,calls=0,release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
 const balances=new ProviderBalances({...f,deepseekKey:async()=> 'synthetic-private-key',now:()=>clock,fetch:async(url,init)=>{calls++;assert.equal(url,'https://api.deepseek.com/user/balance');assert.equal(init?.redirect,'error');assert.equal(init?.method,'GET');await gate;return response(data);}});t.after(async()=>balances.close());
 const first=balances.snapshot();assert.equal(first.providers[1]?.status,'loading');for(let i=0;i<50;i++){balances.snapshot();balances.refresh('deepseek');}await new Promise(r=>setImmediate(r));assert.equal(calls,1);release();await balances.settled();
 assert.equal(balances.snapshot().providers[0]?.status,'unconfigured');assert.equal(balances.snapshot().providers[1]?.rows.length,2);await assert.rejects(stat(f.credentials.filename));
 clock+=9999;balances.refresh('deepseek');await balances.settled();assert.equal(calls,1);
 clock++;balances.refresh('deepseek');await balances.settled();assert.equal(calls,2);
 clock+=299999;balances.snapshot();await balances.settled();assert.equal(calls,2);clock++;balances.snapshot();await balances.settled();assert.equal(calls,3);
});
test('failure retains timestamped stale balance without provider error or key; timeout is bounded',async t=>{
 const f=await fixture(t);let fail=false,clock=1000000;
 const b=new ProviderBalances({...f,now:()=>clock,deepseekKey:async()=> 'synthetic-private-key',fetch:async()=>{if(fail)throw Error('synthetic-private-key and raw provider body');return response(data);}});b.snapshot();await b.settled();const old=b.snapshot().providers[1]!.updatedAt;
 fail=true;clock+=10001;b.refresh('deepseek');await b.settled();const result=b.snapshot().providers[1]!;assert.equal(result.status,'error');assert.equal(result.stale,true);assert.equal(result.updatedAt,old);assert.equal(result.rows[0]?.amount,'123.45');assert.ok(!JSON.stringify(result).includes('synthetic-private'));
 const slow=new ProviderBalances({...f,deepseekKey:async()=> 'synthetic-key',timeoutMs:15,fetch:()=>new Promise(()=>{})});slow.snapshot();await slow.settled();assert.equal(slow.snapshot().providers[1]!.status,'error');b.close();slow.close();
});
test('credentials are private atomic configuration, no file before configure, revision conflict rejected',async t=>{
 const f=await fixture(t);assert.equal(await f.credentials.read(),null);await assert.rejects(stat(f.credentials.filename));
 await f.credentials.save(0,'synthetic-key-id','synthetic-key-secret');
 // POSIX expresses privacy through mode bits (0o600). Windows does not: libuv reports 0o666 for a
 // mode-0o600 file because those bits do not carry the ACL that actually protects the file, and that
 // ACL behavior is covered by the Windows suite (private-file policy + broad-read-grant rejection).
 // The portable invariant: strict 0o600 on POSIX, owner read/write bits present on Windows.
 if (process.platform==='win32') assert.equal((await stat(f.credentials.filename)).mode&0o600,0o600);
 else assert.equal((await stat(f.credentials.filename)).mode&0o777,0o600);
 const bytes=await readFile(f.credentials.filename);
 await assert.rejects(f.credentials.save(0,'synthetic-other-id','synthetic-other-secret'),{code:'version_conflict'});assert.deepEqual(await readFile(f.credentials.filename),bytes);
});
if (process.platform==='win32') {
 // FIX61-10 environmental skip: creating a symlink on Windows needs administrator rights or Developer
 // Mode, and this machine has neither (UnauthorizedAccessException on a throwaway link). The case is
 // recorded as SKIPPED — never as passed — and still runs on platforms that can create the link.
 void test('symlinked credential file is rejected [SKIPPED on Windows: symlink privilege unavailable]',{skip: process.platform==='win32' ? 'Windows symlink privilege unavailable on this machine' : false},async t=>{
  const g=await fixture(t),target=join(g.root,'protected');await writeFile(target,'protected');await mkdir(join(g.root,'data/desktop-pet'),{recursive:true});await symlink(target,g.credentials.filename);await assert.rejects(g.credentials.save(0,'synthetic-key-id','synthetic-key-secret'));assert.equal(await readFile(target,'utf8'),'protected');
 });
} else {
 test('symlinked credential file is rejected',async t=>{
  const g=await fixture(t),target=join(g.root,'protected');await writeFile(target,'protected');await mkdir(join(g.root,'data/desktop-pet'),{recursive:true});await symlink(target,g.credentials.filename);await assert.rejects(g.credentials.save(0,'synthetic-key-id','synthetic-key-secret'));assert.equal(await readFile(target,'utf8'),'protected');
 });
}
test('credential replacement clears prior account value and discards late response; fixed Aliyun signed host',async t=>{
 const f=await fixture(t);await f.credentials.save(0,'synthetic-old-id','synthetic-old-secret');let release!:(r:Response)=>void;
 const b=new ProviderBalances({...f,deepseekKey:async()=>null,fetch:async(url,init)=>{const u=new URL(String(url));assert.equal(u.origin,'https://business.aliyuncs.com');assert.equal(init?.redirect,'error');assert.equal(u.searchParams.get('Action'),'QueryAccountBalance');assert.equal(u.searchParams.get('Version'),'2017-12-14');assert.ok(u.searchParams.get('Signature'));assert.ok(!String(url).includes('synthetic-old-secret'));if(u.searchParams.get('AccessKeyId')==='synthetic-old-id')return new Promise<Response>(r=>{release=r;});return response({Success:true,Data:{Currency:'CNY',AvailableCashAmount:'22.00'}});}});
 b.snapshot();while(!release)await new Promise(r=>setImmediate(r));const changed=await b.configureAliyun(1,'synthetic-new-id','synthetic-new-secret');assert.equal(changed.providers[0]!.rows.length,0);await b.settled();release(response({Success:true,Data:{Currency:'CNY',AvailableCashAmount:'999.00'}}));await new Promise(r=>setImmediate(r));assert.equal(b.snapshot().providers[0]!.rows[0]?.amount,'22.00');assert.ok(!JSON.stringify(b.snapshot()).includes('synthetic-new'));b.close();
});
