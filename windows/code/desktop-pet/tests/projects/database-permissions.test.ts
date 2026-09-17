import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,statSync,chmodSync,readFileSync,readdirSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import Database from 'better-sqlite3';
import {createHash} from 'node:crypto';
const digest=(file:string)=>createHash('sha256').update(readFileSync(file)).digest('hex');
import {SqliteProjectIndex} from '../../projects/sqlite-project-index.js';
import {PROJECT_DATABASE_ID} from '../../projects/database-identity.js';
import {ManagementError} from '../../contracts/management.js';
function fixture(t:TestContext){const parent=resolve(dirname(fileURLToPath(import.meta.url)),'../../../../../.local/harness-bridge-10/tmp');mkdirSync(parent,{recursive:true});const directory=mkdtempSync(join(parent,'permissions-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));return directory;}

test('new index stays 0600 under permissive process umasks before and after save/reopen',async t=>{
 const dir=fixture(t);
 for(const mask of [0o022,0]){
  const file=join(dir,`new-${mask}.sqlite`),old=process.umask(mask);let index:SqliteProjectIndex;
  try{index=new SqliteProjectIndex(file);}finally{process.umask(old);}
  try{
   const actual=statSync(file).mode&0o777;assert.equal(actual,0o600,`umask=${mask.toString(8)} actual=${actual.toString(8)}`);
   await index.save({expectedVersion:0,name:'合成索引',abstract:'',detailRef:{rootPath:'/synthetic'}});
   assert.equal(statSync(file).mode&0o777,0o600);
  }finally{await index.close();}
  const reopened=new SqliteProjectIndex(file);await reopened.close();assert.equal(statSync(file).mode&0o777,0o600);
 }
});

test('opening an existing valid index preserves its permissions and data',async t=>{
 const file=join(fixture(t),'existing.sqlite'),index=new SqliteProjectIndex(file);
 const saved=await index.save({expectedVersion:0,name:'已存在',abstract:'已有内容',detailRef:{rootPath:'/synthetic'}});await index.close();chmodSync(file,0o644);
 const before=digest(file);const reopened=new SqliteProjectIndex(file);
 try{assert.deepEqual(await reopened.get(saved.id),saved);}finally{await reopened.close();}
 assert.equal(statSync(file).mode&0o777,0o644);assert.equal(digest(file),before);
});

test('foreign identity and unknown project schema are refused without permission or byte changes',t=>{
 const dir=fixture(t);
 for(const [app,version] of [[0x50455432,4],[PROJECT_DATABASE_ID,2],[PROJECT_DATABASE_ID,0],[0,1]]){
  const file=join(dir,`foreign-${app}-${version}.sqlite`),db=new Database(file);db.pragma(`application_id = ${app}`);db.pragma(`user_version = ${version}`);db.exec('CREATE TABLE preserved(value TEXT)');db.close();chmodSync(file,0o640);
  const before=digest(file),names=readdirSync(dir);
  assert.throws(()=>new SqliteProjectIndex(file),e=>e instanceof ManagementError&&e.code==='invalid_request');
  assert.equal(digest(file),before);assert.equal(statSync(file).mode&0o777,0o640);assert.deepEqual(readdirSync(dir),names);
 }
});
