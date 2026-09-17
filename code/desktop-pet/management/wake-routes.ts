import { ManagementError } from '../contracts/management.js';
import type { WakeManagement } from '../contracts/wake.js';
export async function wakeRoute(method:string|undefined, port:WakeManagement, body:()=>Promise<Record<string,unknown>>){
  if(method==='GET')return port.snapshot();
  const b=await body();
  if(typeof b.instanceId!=='string'||!Number.isSafeInteger(b.expectedRevision))throw new ManagementError('invalid_request','请使用当前语音唤醒设置版本。');
  if(method==='PUT')return port.save(b.instanceId,b.expectedRevision as number,b.settings);
  if(method==='POST'){
    if(!Number.isSafeInteger(b.expectedGeneration)||typeof b.enabled!=='boolean')throw new ManagementError('invalid_request','请使用当前监听状态。');
    return port.enable(b.instanceId,b.expectedRevision as number,b.expectedGeneration as number,b.enabled);
  }
  throw new ManagementError('not_found','没有这个语音唤醒操作。');
}
