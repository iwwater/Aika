import Database from 'better-sqlite3';
import {randomUUID} from 'node:crypto';
import {mkdirSync,openSync,closeSync,fchmodSync,constants} from 'node:fs';
import {dirname,isAbsolute} from 'node:path';
import {ManagementError} from '../contracts/management.js';
import type {ProjectEntry,ProjectIndexPort,ProjectIndexQuery,ProjectIndexPage,ProjectIndexSave} from '../contracts/projects.js';
import {assertProjectDatabase,PROJECT_DATABASE_ID,PROJECT_SCHEMA_VERSION} from './database-identity.js';

const invalid=():never=>{throw new ManagementError('invalid_request','项目索引字段无效。');};
function object(value:unknown,keys:readonly string[]):Record<string,unknown> {
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))return invalid();
 return value as Record<string,unknown>;
}
function string(value:unknown,max:number,nonempty=false):string {
 if(typeof value!=='string'||[...value].length>max||value.includes('\0')||(nonempty&&!value.trim()))return invalid();
 return value;
}
function integer(value:unknown,min:number,max=Number.MAX_SAFE_INTEGER):number {
 if(typeof value!=='number'||!Number.isSafeInteger(value)||value<min||value>max)return invalid();return value;
}
function id(value:unknown):string {const result=string(value,100,true);if(!/^[a-zA-Z0-9_-]+$/.test(result))return invalid();return result;}
function path(value:unknown,max:number,absolute:boolean):string {
 const result=string(value,max,true);
 if(isAbsolute(result)!==absolute||result.includes('\\')||/^[a-z][a-z0-9+.-]*:/i.test(result)||result.includes('://')||/[\r\n]/.test(result)||result.split('/').includes('..'))return invalid();
 // References are literal paths. Reject encoded traversal/separators rather than relying on later URL decoding.
 if(/%(?:2e|2f|5c|00)/i.test(result))return invalid();
 return result;
}
function payload(input:ProjectIndexSave):Omit<ProjectEntry,'id'|'version'|'updatedAt'> {
 const value=object(input,['id','expectedVersion','name','abstract','detailRef','codexTarget']);
 const detail=object(value.detailRef,['rootPath','entryFile']);
 const detailRef={rootPath:path(detail.rootPath,4096,true),...(detail.entryFile===undefined?{}:{entryFile:path(detail.entryFile,1024,false)})};
 let codexTarget:ProjectEntry['codexTarget'];
 if(value.codexTarget!==undefined){const target=object(value.codexTarget,['threadId','hostId']);codexTarget={threadId:string(target.threadId,200,true),hostId:string(target.hostId,200,true)};}
 return {name:string(value.name,120,true),abstract:string(value.abstract,480),detailRef,...(codexTarget?{codexTarget}:{})};
}
interface Row {id:string;name:string;abstract:string;detail_json:string;codex_json:string|null;version:number;updated_at:string}
function entry(row:Row):ProjectEntry {return {id:row.id,name:row.name,abstract:row.abstract,detailRef:JSON.parse(row.detail_json),...(row.codex_json===null?{}:{codexTarget:JSON.parse(row.codex_json)}),version:row.version,updatedAt:row.updated_at};}

/** Metadata-only index. No project file reader, model client, task dispatcher or companion store. */
export class SqliteProjectIndex implements ProjectIndexPort {
 private readonly db:Database.Database;
 constructor(filename:string){
  const existed=assertProjectDatabase(filename);let created=false;
  if(!existed){
   mkdirSync(dirname(filename),{recursive:true});
   let fd:number|undefined;
   try{fd=openSync(filename,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY,0o600);created=true;fchmodSync(fd,0o600);}
   catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;assertProjectDatabase(filename);}
   finally{if(fd!==undefined)closeSync(fd);}
  }
  // SQLite may only open the file we created exclusively or already validated, never create a 0644 fallback.
  this.db=new Database(filename,{fileMustExist:true});
  try{
   const app=this.db.pragma('application_id',{simple:true}),schema=this.db.pragma('user_version',{simple:true});
   if(!created){
    if(app!==PROJECT_DATABASE_ID||schema!==PROJECT_SCHEMA_VERSION)throw new ManagementError('invalid_request','项目索引数据库身份或版本不匹配。');
    return; // Do not rewrite headers, schema or permissions of existing user files.
   }
   if(app!==0||schema!==0||(this.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get() as {n:number}).n)invalid();
   this.db.transaction(()=>{
    this.db.pragma(`application_id = ${PROJECT_DATABASE_ID}`);this.db.pragma(`user_version = ${PROJECT_SCHEMA_VERSION}`);
    this.db.exec('CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,abstract TEXT NOT NULL,detail_json TEXT NOT NULL,codex_json TEXT,version INTEGER NOT NULL,updated_at TEXT NOT NULL)');
   }).immediate();
  }catch(error){this.db.close();throw error;}
 }

 private open():void {if(!this.db.open)throw new ManagementError('unavailable','项目索引已关闭。');}
 async list(query:ProjectIndexQuery):Promise<ProjectIndexPage>{
  this.open();const value=object(query,['query','offset','limit']),text=string(value.query??'',200),offset=integer(value.offset??0,0),limit=integer(value.limit??25,1,100);
  return this.db.transaction(()=>{
   const where="(?='' OR id=? OR instr(lower(name),lower(?))>0 OR instr(lower(abstract),lower(?))>0)",args=[text,text,text,text];
   const total=(this.db.prepare(`SELECT count(*) AS n FROM projects WHERE ${where}`).get(...args) as {n:number}).n;
   const rows=this.db.prepare(`SELECT * FROM projects WHERE ${where} ORDER BY name COLLATE NOCASE,id LIMIT ? OFFSET ?`).all(...args,limit,offset) as Row[];
   return {items:rows.map(entry),total,offset,limit};
  })();
 }
 async get(projectId:string):Promise<ProjectEntry|null>{this.open();const row=this.db.prepare('SELECT * FROM projects WHERE id=?').get(id(projectId)) as Row|undefined;return row?entry(row):null;}
 async save(input:ProjectIndexSave):Promise<ProjectEntry>{
  this.open();const data=payload(input),version=integer(input.expectedVersion,0),projectId=input.id===undefined?randomUUID():id(input.id);
  if(input.id===undefined&&version!==0)invalid();if(input.id!==undefined&&version===0)invalid();
  return this.db.transaction(()=>{
   if(input.id!==undefined){const current=this.db.prepare('SELECT version FROM projects WHERE id=?').get(projectId) as {version:number}|undefined;
    if(!current)throw new ManagementError('not_found','没有这个项目索引。');
    if(current.version!==version)throw new ManagementError('version_conflict','项目索引已更新，请刷新后重试。');
   }
   const result:ProjectEntry={id:projectId,...data,version:version+1,updatedAt:new Date().toISOString()};
   this.db.prepare('INSERT INTO projects VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,abstract=excluded.abstract,detail_json=excluded.detail_json,codex_json=excluded.codex_json,version=excluded.version,updated_at=excluded.updated_at').run(projectId,result.name,result.abstract,JSON.stringify(result.detailRef),result.codexTarget?JSON.stringify(result.codexTarget):null,result.version,result.updatedAt);
   return result;
  }).immediate();
 }
 async remove(projectId:string,expectedVersion:number):Promise<{id:string;removed:true}>{
  this.open();id(projectId);integer(expectedVersion,1);
  return this.db.transaction(()=>{
   const current=this.db.prepare('SELECT version FROM projects WHERE id=?').get(projectId) as {version:number}|undefined;
   if(!current)throw new ManagementError('not_found','没有这个项目索引。');
   if(current.version!==expectedVersion)throw new ManagementError('version_conflict','项目索引已更新，请刷新后重试。');
   this.db.prepare('DELETE FROM projects WHERE id=?').run(projectId);return {id:projectId,removed:true as const};
  }).immediate();
 }
 async close():Promise<void>{if(this.db.open)this.db.close();}
}
