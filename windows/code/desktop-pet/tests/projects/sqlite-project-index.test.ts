import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,readFileSync,writeFileSync,existsSync,readdirSync,symlinkSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import Database from 'better-sqlite3';
import {SqliteProjectIndex} from '../../projects/sqlite-project-index.js';
import {ManagementError} from '../../contracts/management.js';
import type {ProjectIndexSave} from '../../contracts/projects.js';

function fixture(t:TestContext) {
 const parent=resolve(dirname(fileURLToPath(import.meta.url)),'../../../../../.local/harness-bridge-10/tmp');mkdirSync(parent,{recursive:true});
 const root=mkdtempSync(join(parent,'case-')),file=join(root,'project-index.sqlite'),stores:SqliteProjectIndex[]=[];
 const open=()=>{const store=new SqliteProjectIndex(file);stores.push(store);return store;};
 t.after(async()=>{for(const store of stores)await store.close();rmSync(root,{recursive:true,force:true});});return {root,file,open};
}
const save=(name='同名项目'):ProjectIndexSave=>({expectedVersion:0,name,abstract:'轻量摘要',detailRef:{rootPath:'/synthetic/not-read',entryFile:'docs/README.md'},codexTarget:{hostId:'local',threadId:'existing-synthetic-thread'}});
const error=(code:string)=>(value:unknown)=>value instanceof ManagementError&&value.code===code;

test('stable IDs survive rename and restart; same names remain separate and returned objects cannot mutate storage',async t=>{
 const f=fixture(t),store=f.open(),a=await store.save(save()),b=await store.save(save());assert.notEqual(a.id,b.id);
 assert.equal((await store.list({query:'同名'})).total,2);
 const changed=await store.save({...save('新名称'),id:a.id,expectedVersion:1});assert.equal(changed.id,a.id);assert.equal(changed.version,2);
 changed.detailRef.rootPath='/mutated';await store.close();
 const reopened=f.open();assert.equal((await reopened.get(a.id))!.detailRef.rootPath,'/synthetic/not-read');assert.equal((await reopened.get(a.id))!.name,'新名称');assert.ok(await reopened.get(b.id));
});

test('pagination is deterministic and bounded, and search treats SQL and wildcard text literally',async t=>{
 const store=fixture(t).open();for(let n=0;n<31;n++)await store.save(save(n<2?'same':'project '+String(n).padStart(2,'0')));
 const first=await store.list({}),next=await store.list({offset:25});assert.equal(first.limit,25);assert.equal(first.total,31);assert.equal(next.items.length,6);
 assert.equal(new Set([...first.items,...next.items].map(x=>x.id)).size,31);assert.deepEqual(await store.list({}),first);
 assert.equal((await store.list({query:"%' OR 1=1 --"})).total,0);
 await assert.rejects(store.list({limit:101}),error('invalid_request'));await assert.rejects(store.list({offset:-1}),error('invalid_request'));await assert.rejects(store.list({query:'x'.repeat(201)}),error('invalid_request'));
});

test('independent SQLite connections reject stale updates and removals without losing the accepted version',async t=>{
 const f=fixture(t),a=f.open(),row=await a.save(save()),b=f.open();const stale=await b.get(row.id);
 await a.save({...save('accepted'),id:row.id,expectedVersion:row.version});
 await assert.rejects(b.save({...save('lost update'),id:row.id,expectedVersion:stale!.version}),error('version_conflict'));
 await assert.rejects(b.remove(row.id,stale!.version),error('version_conflict'));
 assert.equal((await b.get(row.id))!.name,'accepted');await assert.rejects(b.save({...save(),id:'unknown-id',expectedVersion:1}),error('not_found'));
});

test('removing a card leaves its project document and separate companion data unchanged and cannot be revived by an old save',async t=>{
 const f=fixture(t),doc=join(f.root,'README.md'),companion=join(f.root,'companion.sqlite');writeFileSync(doc,'synthetic project details');
 const db=new Database(companion);db.pragma('application_id = 1346720818');db.exec("CREATE TABLE facts(text TEXT); INSERT INTO facts VALUES('synthetic private fact')");db.close();
 const before=readFileSync(companion),store=f.open(),row=await store.save({...save(),detailRef:{rootPath:f.root,entryFile:'README.md'}});
 assert.deepEqual(await store.remove(row.id,1),{id:row.id,removed:true});assert.equal(await store.get(row.id),null);assert.equal((await store.list({})).total,0);
 await assert.rejects(store.save({...save(),id:row.id,expectedVersion:1}),error('not_found'));
 assert.equal(readFileSync(doc,'utf8'),'synthetic project details');assert.deepEqual(readFileSync(companion),before);
});

test('metadata validation refuses oversized bodies, extra engineering payloads, traversal and URLs without reading project files',async t=>{
 const f=fixture(t),store=f.open();const bad:unknown[]=[
  {...save(),name:' '},{...save(),name:'字'.repeat(121)},{...save(),abstract:'字'.repeat(481)},
  {...save(),executionLog:'private engineering body'}, {...save(),detailRef:{rootPath:'/not/read',contents:'private body'}},
  ...['../secret','docs/../../secret','/absolute','file:///secret','https://example.invalid/a','docs\\..\\secret','%2e%2e/secret','nul\0file'].map(entryFile=>({...save(),detailRef:{rootPath:'/not/read',entryFile}})),
  ...['relative','https://example.invalid','/a/../private','nul\0root'].map(rootPath=>({...save(),detailRef:{rootPath}})),
 ];
 for(const value of bad)await assert.rejects(store.save(value as ProjectIndexSave),error('invalid_request'));
 assert.equal((await store.list({})).total,0);
 const row=await store.save({...save(),name:'字'.repeat(120),abstract:'🧪'.repeat(480),detailRef:{rootPath:join(f.root,'does-not-exist'),entryFile:'docs/README.md'}});
 assert.equal(existsSync(row.detailRef.rootPath),false);assert.ok(await store.get(row.id));
});

test('rejects companion filename, PET2 alias, foreign database and symlink before SQLite sidecar or data changes',async t=>{
 const f=fixture(t),companion=join(f.root,'companion.sqlite');assert.throws(()=>new SqliteProjectIndex(companion),error('invalid_request'));assert.equal(existsSync(companion),false);
 for(const appId of [0x50455432,0x50455431,0]){
  const alias=join(f.root,`alias-${appId}.sqlite`),db=new Database(alias);db.pragma(`application_id = ${appId}`);db.pragma('user_version = 4');db.exec('CREATE TABLE preserved(value TEXT)');db.close();
  const before=readFileSync(alias),files=readdirSync(f.root);assert.throws(()=>new SqliteProjectIndex(alias),error('invalid_request'));assert.deepEqual(readFileSync(alias),before);assert.deepEqual(readdirSync(f.root),files);
 }
 const link=join(f.root,'linked.sqlite');symlinkSync(join(f.root,'alias-0.sqlite'),link);assert.throws(()=>new SqliteProjectIndex(link),error('invalid_request'));
 assert.throws(()=>new SqliteProjectIndex('relative.sqlite'),error('invalid_request'));
});

test('document reference and execution target change independently; close is repeatable and later access unavailable',async t=>{
 const store=fixture(t).open(),row=await store.save(save());
 const updated=await store.save({...save(),id:row.id,expectedVersion:1,codexTarget:{hostId:'remote-control:synthetic',threadId:'another-task'}});
 assert.deepEqual(updated.detailRef,row.detailRef);assert.notDeepEqual(updated.codexTarget,row.codexTarget);
 const withoutTarget=save();delete withoutTarget.codexTarget;const clean=await store.save({...withoutTarget,id:row.id,expectedVersion:2});assert.equal(clean.codexTarget,undefined);assert.deepEqual(clean.detailRef,row.detailRef);
 await store.close();await store.close();await assert.rejects(store.get(row.id),error('unavailable'));
});
