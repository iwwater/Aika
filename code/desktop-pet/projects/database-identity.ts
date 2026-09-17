import {constants,openSync,readSync,closeSync,fstatSync} from 'node:fs';
import {basename,isAbsolute} from 'node:path';
import {ManagementError} from '../contracts/management.js';

export const PROJECT_DATABASE_ID=0x50524a31; // PRJ1; never PET1/PET2.
export const PROJECT_SCHEMA_VERSION=1;
const invalid=()=>{throw new ManagementError('invalid_request','项目索引数据库位置或格式无效。');};
/** Examine only the index file header. Never open companion databases through SQLite. */
export function assertProjectDatabase(filename:string):boolean {
 if(typeof filename!=='string'||!isAbsolute(filename)||filename.includes('\0')||/^companion\.sqlite(?:-(?:wal|shm))?$/i.test(basename(filename)))invalid();
 let fd:number;
 try{fd=openSync(filename,constants.O_RDONLY|constants.O_NOFOLLOW);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;invalid();}
 try{
  if(!fstatSync(fd!).isFile())invalid();
  const header=Buffer.alloc(100),length=readSync(fd!,header,0,100,0);
  if(length===0)invalid();
  if(length!==100||header.subarray(0,16).toString('binary')!=='SQLite format 3\0'||header.readUInt32BE(68)!==PROJECT_DATABASE_ID||header.readUInt32BE(60)!==PROJECT_SCHEMA_VERSION)invalid();
  return true;
 }finally{closeSync(fd!);}
}
