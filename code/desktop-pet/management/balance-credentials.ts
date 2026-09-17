import {constants} from 'node:fs';
import {open,mkdir,lstat,rename,unlink} from 'node:fs/promises';
import {dirname,join,relative} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ManagementError} from '../contracts/management.js';
export interface FinanceCredential {revision:number;accessKeyId:string;accessKeySecret:string}
const valid=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9+/_=-]{8,256}$/.test(v);
/** Product configuration, outside Git. Single backend writer; secrets never enter snapshots. */
export class FinanceCredentials {
  private writes:Promise<unknown>=Promise.resolve();
  readonly filename:string;
  constructor(private readonly root:string){this.filename=join(root,'.local/data/aliyun-balance-credentials.json');}
  private async parent(create=false){
    const parent=dirname(this.filename);if(create)await mkdir(parent,{recursive:true,mode:0o700});
    let current=this.root;for(const part of relative(this.root,parent).split('/')){current=join(current,part);const s=await lstat(current);if(!s.isDirectory()||s.isSymbolicLink())throw Error('Invalid credential directory');}
  }
  async read():Promise<FinanceCredential|null>{
    let file;
    try{await this.parent();file=await open(this.filename,constants.O_RDONLY|constants.O_NOFOLLOW);const info=await file.stat();
      if(!info.isFile()||info.size>4096||(info.mode&0o077)!==0||process.getuid&&info.uid!==process.getuid())throw Error('Invalid credential file');
      const data=JSON.parse(await file.readFile('utf8'));
      if(data.version!==1||!Number.isSafeInteger(data.revision)||data.revision<1||!valid(data.accessKeyId)||!valid(data.accessKeySecret))throw Error('Invalid credential');
      return {revision:data.revision,accessKeyId:data.accessKeyId,accessKeySecret:data.accessKeySecret};
    }catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw new ManagementError('unavailable','本机财务凭据不可读取，请检查文件权限。');}finally{await file?.close();}
  }
  save(expectedRevision:number,accessKeyId:unknown,accessKeySecret:unknown):Promise<FinanceCredential>{
    const job=this.writes.then(async()=>{
      if(!valid(accessKeyId)||!valid(accessKeySecret))throw new ManagementError('invalid_request','请填写有效的 AccessKey ID 和 Secret。');
      await this.parent(true);const previous=await this.read();if(expectedRevision!==(previous?.revision??0))throw new ManagementError('version_conflict','财务凭据刚有更新，请重新打开配置。');
      const value={revision:expectedRevision+1,accessKeyId,accessKeySecret},next=this.filename+'.'+randomUUID()+'.next';
      try{const file=await open(next,'wx',0o600);try{await file.writeFile(JSON.stringify({version:1,...value})+'\n');await file.sync();}finally{await file.close();}await rename(next,this.filename);}finally{await unlink(next).catch(e=>{if(e.code!=='ENOENT')throw e;});}
      return value;
    });this.writes=job.catch(()=>{});return job;
  }
}
