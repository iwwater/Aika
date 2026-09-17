import Database from 'better-sqlite3';
import { constants, openSync, closeSync, mkdirSync, lstatSync, realpathSync, fstatSync, readSync } from 'node:fs';
import { dirname, resolve, basename } from 'node:path';
import { createHash } from 'node:crypto';
import type { WeChatCredentials } from './api.js';

export const channelKey = (auth: Pick<WeChatCredentials,'botId'|'userId'>): string => createHash('sha256').update(JSON.stringify([auth.botId,auth.userId])).digest('hex');
const APP_ID=0x50545731;
/** Durable channel metadata only. No message text, contacts, memory or raw HTTP bodies. */
export class WeChatStore {
  private readonly db: Database.Database;
  constructor(readonly filename: string) {
    if(resolve(filename)!==filename || basename(filename)!=='channel.sqlite')throw Error('Invalid channel storage');
    const parent=dirname(filename);mkdirSync(parent,{recursive:true,mode:0o700});
    if(realpathSync(parent)!==parent || !lstatSync(parent).isDirectory())throw Error('Invalid channel directory');
    let created=false,fd:number;
    try{fd=openSync(filename,constants.O_RDWR|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);created=true;}
    catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;fd=openSync(filename,constants.O_RDONLY|constants.O_NOFOLLOW);}
    try{const stat=fstatSync(fd);if(!stat.isFile()||(stat.mode&0o077)!==0||stat.uid!==process.getuid?.())throw Error('Private channel file required');
      if(!created){const h=Buffer.alloc(100);if(readSync(fd,h,0,100,0)!==100||h.readUInt32BE(68)!==APP_ID||h.readUInt32BE(60)!==1)throw Error('Invalid channel database');}
    }finally{closeSync(fd);}
    this.db=new Database(filename,{fileMustExist:true});
    if(created)this.db.transaction(()=>{this.db.pragma('application_id='+APP_ID);this.db.pragma('user_version=1');this.db.exec('CREATE TABLE state(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE seen(channel TEXT NOT NULL,id TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(channel,id));');}).immediate();
  }
  get<T>(key: string): T | undefined { const row=this.db.prepare('SELECT value FROM state WHERE key=?').get(key) as {value:string}|undefined;return row?JSON.parse(row.value):undefined; }
  set(key: string, value: unknown) { this.db.prepare('INSERT INTO state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value)); }
  delete(key: string) { this.db.prepare('DELETE FROM state WHERE key=?').run(key); }
  claim(channel: string,id: string): boolean { return this.db.prepare('INSERT OR IGNORE INTO seen VALUES(?,?,?,?)').run(channel,id,'claimed',new Date().toISOString()).changes===1; }
  finish(channel: string,id: string,status: string) { this.db.prepare('UPDATE seen SET status=? WHERE channel=? AND id=?').run(status,channel,id); }
  seenStatus(channel: string,id: string): string|undefined { return (this.db.prepare('SELECT status FROM seen WHERE channel=? AND id=?').get(channel,id) as {status:string}|undefined)?.status; }
  close() { this.db.close(); }
}
