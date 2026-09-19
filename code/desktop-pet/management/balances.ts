import {createHash,createHmac,randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import type {BalanceManagement,BalanceProvider,BalanceRow,BalanceSnapshot,ProviderBalance} from '../contracts/balances.js';
import {FinanceCredentials} from './balance-credentials.js';
const encode=(v:string)=>encodeURIComponent(v).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
export function rpcSignature(parameters:Record<string,string>,secret:string):string{
  const query=Object.keys(parameters).filter(k=>k!=='Signature').sort().map(k=>encode(k)+'='+encode(parameters[k]!)).join('&');
  return createHmac('sha1',secret+'&').update('GET&%2F&'+encode(query)).digest('base64');
}
const amount=(v:unknown):string=>{
  if(typeof v!=='string'||v.length>64||!/^[-+]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(v))throw Error('Invalid amount');
  return v.replaceAll(',','');
};
export function balanceRows(provider:BalanceProvider,data:any):BalanceRow[]{
  if(provider==='deepseek'){
    if(typeof data?.is_available!=='boolean'||!Array.isArray(data.balance_infos)||!data.balance_infos.length||data.balance_infos.length>2)throw Error('Invalid balance');
    const rows=data.balance_infos.map((v:any)=>{if(!['CNY','USD'].includes(v.currency))throw Error('Invalid currency');return {currency:v.currency,amount:amount(v.total_balance)};});
    if(new Set(rows.map((r:BalanceRow)=>r.currency)).size!==rows.length)throw Error('Duplicate currency');return rows;
  }
  if(data?.Success!==true||!['CNY','USD','JPY'].includes(data.Data?.Currency))throw Error('Invalid balance');
  return [{currency:data.Data.Currency,amount:amount(data.Data.AvailableCashAmount),...(data.Data.AvailableAmount===undefined?{}:{availableCredit:amount(data.Data.AvailableAmount)})}];
}
export async function readBalanceKey(filename:string|undefined):Promise<string|null>{
  if(!filename)return null;let f;
  try{f=await open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);const s=await f.stat();if(!s.isFile()||(s.mode&0o077)!==0||s.size>8192||process.getuid&&s.uid!==process.getuid())throw Error('Invalid key');const key=(await f.readFile('utf8')).trim();if(!key||/[\r\n\0]/.test(key))throw Error('Invalid key');return key;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}finally{await f?.close();}
}
interface Options {credentials:FinanceCredentials;deepseekKey:()=>Promise<string|null>;fetch?:typeof fetch;now?:()=>number;ttlMs?:number;timeoutMs?:number;cooldownMs?:number}
type Entry={value:ProviderBalance;attempt:number;generation:number;identity?:string;job?:Promise<void>;abort?:AbortController};
const initial=(provider:BalanceProvider):ProviderBalance=>({provider,status:'idle',configured:false,credentialRevision:0,updatedAt:null,checkedAt:null,stale:false,rows:[],message:null});
/** Snapshot never waits for network; one bounded request per provider, cached for five minutes. */
export class ProviderBalances implements BalanceManagement {
  private entries:Record<BalanceProvider,Entry>={aliyun:{value:initial('aliyun'),attempt:-Infinity,generation:0},deepseek:{value:initial('deepseek'),attempt:-Infinity,generation:0}};
  private closed=false;
  private now:()=>number;
  constructor(private readonly options:Options){this.now=options.now??Date.now;}
  snapshot():BalanceSnapshot{for(const p of ['aliyun','deepseek'] as const)this.kick(p,false);return this.view();}
  private view():BalanceSnapshot{return {providers:Object.values(this.entries).map(e=>({...structuredClone(e.value),stale:!!e.value.updatedAt&&(e.value.status==='error'||this.now()-Date.parse(e.value.updatedAt)>=(this.options.ttlMs??300000))}))};}
  refresh(provider:BalanceProvider):BalanceSnapshot{this.kick(provider,true);return this.view();}
  private kick(provider:BalanceProvider,manual:boolean){
    const entry=this.entries[provider];if(this.closed||entry.job||this.now()-entry.attempt<(manual?(this.options.cooldownMs??10000):(this.options.ttlMs??300000)))return;
    entry.attempt=this.now();entry.value.status='loading';const generation=entry.generation,abort=new AbortController();entry.abort=abort;
    const job=this.read(provider,entry,generation,abort).finally(()=>{if(entry.job===job){delete entry.job;delete entry.abort;}});entry.job=job;
  }
  private async read(provider:BalanceProvider,entry:Entry,generation:number,abort:AbortController){
    let timer:ReturnType<typeof setTimeout>|undefined;
    const current=()=>!this.closed&&entry.generation===generation&&!abort.signal.aborted;
    try{
      const finance=provider==='aliyun'?await this.options.credentials.read():null,key=provider==='deepseek'?await this.options.deepseekKey():null;
      if(!current())return;
      if(provider==='aliyun'?!finance:!key){entry.value={...initial(provider),status:'unconfigured',checkedAt:new Date(this.now()).toISOString()};return;}
      const identity=createHash('sha256').update(provider==='aliyun'?JSON.stringify(finance):key!).digest('hex');
      if(entry.identity!==identity){entry.value={...initial(provider),status:'loading'};entry.identity=identity;}
      entry.value.configured=true;entry.value.credentialRevision=finance?.revision??0;
      let url='https://api.deepseek.com/user/balance';let headers:Record<string,string>={Accept:'application/json'};
      if(finance){const params={Action:'QueryAccountBalance',Format:'JSON',Version:'2017-12-14',AccessKeyId:finance.accessKeyId,SignatureMethod:'HMAC-SHA1',SignatureVersion:'1.0',Timestamp:new Date(this.now()).toISOString().replace(/\.\d{3}Z$/,'Z'),SignatureNonce:randomUUID()};url='https://business.aliyuncs.com/?'+new URLSearchParams({...params,Signature:rpcSignature(params,finance.accessKeySecret)});}
      else headers.Authorization='Bearer '+key;
      const work=(async()=>{const response=await (this.options.fetch??fetch)(url,{method:'GET',headers,redirect:'error',signal:abort.signal});if(!response.ok)throw Error('Provider status');const text=await response.text();if(text.length>65536)throw Error('Response too large');return balanceRows(provider,JSON.parse(text));})();
      const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{reject(Error('timeout'));abort.abort();},this.options.timeoutMs??8000);});
      const rows=await Promise.race([work,timeout]);if(!current())return;
      entry.value={...entry.value,status:'ready',rows,updatedAt:new Date(this.now()).toISOString(),checkedAt:new Date(this.now()).toISOString(),message:null};
    }catch{if(!this.closed&&entry.generation===generation){entry.value={...entry.value,status:'error',checkedAt:new Date(this.now()).toISOString(),message:'暂时无法读取官方余额，请检查凭据、读取权限或网络后刷新。'};}}
    finally{if(timer)clearTimeout(timer);}
  }
  async configureAliyun(expectedRevision:number,accessKeyId:unknown,accessKeySecret:unknown):Promise<BalanceSnapshot>{
    const saved=await this.options.credentials.save(expectedRevision,accessKeyId,accessKeySecret),entry=this.entries.aliyun;
    entry.generation++;entry.abort?.abort();delete entry.job;delete entry.abort;delete entry.identity;entry.attempt=-Infinity;entry.value={...initial('aliyun'),configured:true,credentialRevision:saved.revision};this.kick('aliyun',true);return this.view();
  }
  async settled(){await Promise.all(Object.values(this.entries).map(e=>e.job));}
  close(){this.closed=true;for(const entry of Object.values(this.entries))entry.abort?.abort();}
}
