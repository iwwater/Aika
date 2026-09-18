import { isPrivateFileSync, restrictPrivatePathSync } from '../../core/platform-files.js';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, chmodSync, writeFileSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { ManagedCredentialStore, acquireSetupLock } from '../../management/credential-store.js';
function fixture(t:test.TestContext){const root=realpathSync(mkdtempSync(join(tmpdir(),'self-setup-50-')));t.after(()=>rmSync(root,{recursive:true,force:true}));const project=join(root,'project');mkdirSync(project);return {root,project,directory:join(root,'private','keys')};}
const key='sk-fixture-only';
test('first view creates no credential storage; save returns only reference and preserves old key versions',t=>{
 const f=fixture(t),store=new ManagedCredentialStore(f.project,f.directory);assert.deepEqual(store.entries(),[]);assert.throws(()=>statSync(f.directory));
 const first=store.save({provider:'dashscope',key,expectedRevision:0,operationId:'synthetic-one'});
 assert.equal(first.revision,1);assert.equal(JSON.stringify(first).includes(key),false);
 const file=store.entries()[0]!.file;assert.equal(readFileSync(file,'utf8'),key);assert.equal(isPrivateFileSync(file),true);
 assert.equal(readFileSync(join(f.directory,'registry.json'),'utf8').includes(key),false);
 const next=store.save({provider:'dashscope',key:key+'2',expectedRevision:1,operationId:'synthetic-two'});
 assert.notEqual(next.credentialRef,first.credentialRef);assert.equal(readFileSync(file,'utf8'),key);assert.equal(store.entries().length,2);
});
test('reopened state rejects stale saves, repeats exact completed operation safely, never echoes key in rejection',t=>{
 const f=fixture(t),store=new ManagedCredentialStore(f.project,f.directory);const input={provider:'deepseek' as const,key,expectedRevision:0,operationId:'synthetic-one'};const first=store.save(input);const other=new ManagedCredentialStore(f.project,f.directory);
 assert.deepEqual(other.save(input),first);assert.throws(()=>other.save({...input,operationId:'synthetic-two'}),{code:'version_conflict'});
 assert.throws(()=>other.save({...input,key:key+'changed'}),{code:'version_conflict'});
 try{other.save({...input,key:'invalid-'+key});assert.fail();}catch(error){assert.equal(String(error).includes(key),false);}
 assert.equal(other.entries().length,1);
});
test('credential store rejects project-local paths and unsafe directories without rewriting existing files',{skip:process.platform==='win32'},t=>{
 const f=fixture(t);assert.throws(()=>new ManagedCredentialStore(f.project,join(f.project,'keys')));
 mkdirSync(f.directory,{recursive:true,mode:0o700});chmodSync(f.directory,0o755);const store=new ManagedCredentialStore(f.project,f.directory);
 assert.throws(()=>store.save({provider:'deepseek',key,expectedRevision:0,operationId:'synthetic-one'}),{code:'unavailable'});
 chmodSync(f.directory,0o700);const alias=join(f.root,'linked');symlinkSync(f.directory,alias,'dir');const linked=new ManagedCredentialStore(f.project,alias);
 assert.throws(()=>linked.save({provider:'deepseek',key,expectedRevision:0,operationId:'synthetic-one'}),{code:'unavailable'});
});

test('setup locks recover a verified dead local PID and retain live or malformed owners',t=>{
 const f=fixture(t),file=join(f.root,'session.lock'),scope='first-run:'+f.project;
 const child=spawnSync(process.execPath,['-e',''],{stdio:'pipe'});assert.equal(child.status,0);
 writeFileSync(file,JSON.stringify({pid:child.pid,host:hostname(),scope,instanceId:'synthetic'}),{mode:0o600});
 restrictPrivatePathSync(file);const release=acquireSetupLock(file,scope);assert.equal(JSON.parse(readFileSync(file,'utf8')).pid,process.pid);
 assert.throws(()=>acquireSetupLock(file,scope),{code:'version_conflict'});release();
 writeFileSync(file,'unidentifiable',{mode:0o600});restrictPrivatePathSync(file);assert.throws(()=>acquireSetupLock(file,scope),{code:'unavailable'});assert.equal(readFileSync(file,'utf8'),'unidentifiable');
});
