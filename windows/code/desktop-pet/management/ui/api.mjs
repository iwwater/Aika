export class ApiError extends Error {
  constructor(message, status=0, code='unavailable') { super(message); this.status=status; this.code=code; }
}
export class ManagementClient {
  constructor(token, transport=globalThis.fetch.bind(globalThis)) { this.token=token; this.transport=transport; }
  async request(path, {method='GET',body,signal}={}) {
    if(!path.startsWith('/api/'))throw new Error('管理请求必须使用同源接口');
    let response;
    try {response=await this.transport(path,{method,signal,redirect:'error',credentials:'omit',cache:'no-store',headers:{Authorization:`Bearer ${this.token}`,Accept:'application/json',...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});}
    catch(e){if(e.name==='AbortError')throw e;throw new ApiError('无法连接本机服务。当前显示的旧快照不能代表实时状态。')}
    let data;try{data=await response.json()}catch{throw new ApiError('服务返回了无法识别的内容。',response.status)}
    if(!response.ok)throw new ApiError(data?.error?.message||'请求未完成。',response.status,data?.error?.code);
    return data;
  }
}
export function query(path, values) { return path+'?'+new URLSearchParams(values).toString(); }
export const clone=value=>structuredClone(value);
// Rebase only fields actually edited here. Unrelated newer settings stay intact.
export function changes(base,draft,path=[]) {
  if(draft && typeof draft==='object')return [...new Set([...Object.keys(base??{}),...Object.keys(draft)])].flatMap(key=>changes(base?.[key],draft[key],[...path,key]));
  return Object.is(base,draft)?[]:[{path,before:base,after:draft}];
}
export function rebase(base,draft,latest) {
  const merged=clone(latest);
  for(const change of changes(base,draft)){let target=merged;for(const key of change.path.slice(0,-1))target=target[key]??={};const key=change.path.at(-1);if(change.after===undefined)delete target[key];else target[key]=change.after;}
  return merged;
}

export function providerChoice(current, adapter, model) {
  const choice=adapter.choices?.find(c=>c.configuration.model===model);
  if(!choice)return null;
  return {...clone(choice.configuration),credentialRef:current.provider===choice.configuration.provider?current.credentialRef:''};
}
