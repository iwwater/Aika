import type {IncomingMessage} from 'node:http';
import type {BalanceManagement} from '../contracts/balances.js';
import {ManagementError} from '../contracts/management.js';
export async function balanceRoute(req:IncomingMessage,url:URL,balances:BalanceManagement|undefined,body:()=>Promise<Record<string,unknown>>,send:(v:unknown)=>void):Promise<boolean>{
  if(!url.pathname.startsWith('/api/balances'))return false;
  if(!balances)throw new ManagementError('unavailable','当前版本尚未启用官方余额查询。');
  if(req.method==='GET'&&url.pathname==='/api/balances'){send(balances.snapshot());return true;}
  if(req.method==='POST'&&url.pathname==='/api/balances/refresh'){const b=await body();if(b.provider!=='aliyun'&&b.provider!=='deepseek')throw new ManagementError('invalid_request','请选择余额提供方。');send(balances.refresh(b.provider));return true;}
  if(req.method==='PUT'&&url.pathname==='/api/balances/aliyun-credentials'){const b=await body();if(!Number.isSafeInteger(b.expectedRevision)||Number(b.expectedRevision)<0)throw new ManagementError('invalid_request','配置版本无效。');send(await balances.configureAliyun(Number(b.expectedRevision),b.accessKeyId,b.accessKeySecret));return true;}
  throw new ManagementError('not_found','没有这个余额操作。');
}
