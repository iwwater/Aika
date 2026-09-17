import type { IncomingMessage } from 'node:http';
import { isProductCharacter } from '../contracts/character.js';
import { ManagementError } from '../contracts/management.js';
import { MEMORY_POLICY_LIMITS, type MemoryDynamicsManagementPort, type MemoryDynamicsPolicy } from '../contracts/memory-dynamics.js';

const invalid=()=>new ManagementError('invalid_request','记忆管理参数无效，请刷新后重试。');
function character(v:unknown) {if(!isProductCharacter(v))throw invalid();return v;}
function text(v:unknown,max=1000) {if(typeof v!=='string'||v.length>max||v.includes('\0'))throw invalid();return v;}
function required(v:unknown) {const s=text(v,200);if(!s.trim())throw invalid();return s;}
function integer(v:unknown,min=0,max=Number.MAX_SAFE_INTEGER) {if(typeof v!=='number'||!Number.isSafeInteger(v)||v<min||v>max)throw invalid();return v;}
function queryInteger(v:string|null,fallback:number,min:number,max:number) {return v===null?fallback:integer(Number(v),min,max);}
function policy(v:unknown):MemoryDynamicsPolicy {
  if(!v||typeof v!=='object'||Array.isArray(v))throw invalid();
  const data=v as Record<string,unknown>,keys=Object.keys(MEMORY_POLICY_LIMITS);
  if(Object.keys(data).length!==keys.length)throw invalid();
  for(const k of keys){const n=data[k],[min,max]=MEMORY_POLICY_LIMITS[k as keyof typeof MEMORY_POLICY_LIMITS];if(typeof n!=='number'||!Number.isFinite(n)||n<min||n>max)throw invalid();}
  const p=data as unknown as MemoryDynamicsPolicy;
  if(Math.abs(p.baselineWeight+p.activationWeight+p.importanceWeight+p.emotionWeight-1)>1e-9)throw invalid();
  return {...p};
}
/** Called only after the server's same-origin/token checks; never opens SQLite directly. */
export async function memoryDynamicsRoute(req:IncomingMessage,url:URL,port:MemoryDynamicsManagementPort|undefined,
  readBody:()=>Promise<Record<string,unknown>>,respond:(data:unknown)=>void):Promise<boolean> {
  if(!url.pathname.startsWith('/api/memory/'))return false;
  if(!port)throw new ManagementError('unavailable','记忆动态管理尚未接入当前运行版本。');
  const q=url.searchParams,path=url.pathname;
  if(req.method==='GET'&&(path==='/api/memory/dynamics'||path==='/api/memory/traces')){
    const common={characterId:character(q.get('characterId')),offset:queryInteger(q.get('offset'),0,0,1_000_000),limit:queryInteger(q.get('limit'),30,1,100)};
    if(path==='/api/memory/traces')respond(await port.traces(common));
    else {const state=q.get('state')??'active';if(state!=='active'&&state!=='all')throw invalid();respond(await port.snapshot({...common,state,query:text(q.get('query')??'')}));}
    return true;
  }
  if(!['POST','PUT'].includes(req.method??''))return false;
  const b=await readBody(),characterId=character(b.characterId);
  if(req.method==='POST'&&path==='/api/memory/preview'){
    const evaluatedAt=text(b.evaluatedAt,100);if(evaluatedAt!=='now'&&!Number.isFinite(Date.parse(evaluatedAt)))throw invalid();
    respond(await port.preview({characterId,query:text(b.query),evaluatedAt,expectedDataRevision:integer(b.expectedDataRevision),expectedPolicyRevision:integer(b.expectedPolicyRevision),policy:policy(b.policy)}));return true;
  }
  if(req.method==='PUT'&&path==='/api/memory/policy'){
    respond(await port.savePolicy({characterId,expectedRevision:integer(b.expectedRevision),operationId:required(b.operationId),policy:policy(b.policy)}));return true;
  }
  if(req.method==='POST'&&path==='/api/memory/policy/rollback'){
    respond(await port.rollbackPolicy({characterId,expectedRevision:integer(b.expectedRevision),targetRevision:integer(b.targetRevision),operationId:required(b.operationId)}));return true;
  }
  if(req.method==='POST'&&(path==='/api/memory/forget'||path==='/api/memory/restore')){
    const reason=text(b.reason);if(!reason.trim())throw invalid();
    const input={characterId,id:required(b.id),expectedVersion:integer(b.expectedVersion,1),operationId:required(b.operationId),reason};
    respond(await (path.endsWith('/forget')?port.forget(input):port.restore(input)));return true;
  }
  return false;
}
