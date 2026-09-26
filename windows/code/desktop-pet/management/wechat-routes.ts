import type { WeChatAction, WeChatManagement } from '../contracts/wechat.js';
import { ManagementError } from '../contracts/management.js';

export async function wechatRoute(method: string|undefined,channel: WeChatManagement,body: ()=>Promise<Record<string,unknown>>) {
  if(method==='GET')return channel.snapshot();
  if(method!=='POST')throw new ManagementError('not_found','没有这个微信操作。');
  const value=await body();
  if(!['login','verify','start','stop','disconnect','set_reply_mode'].includes(String(value.action))||!Number.isSafeInteger(value.expectedRevision)||Number(value.expectedRevision)<0
    ||Object.keys(value).some(k=>!['action','expectedRevision','code','replyMode'].includes(k))
    ||value.action==='set_reply_mode'&&!['follow_input','text','voice'].includes(String(value.replyMode))
    ||value.action!=='set_reply_mode'&&value.replyMode!==undefined
    ||value.action==='verify'&&(typeof value.code!=='string'||!/^\d{4,12}$/.test(value.code))
    ||value.action!=='verify'&&value.code!==undefined)throw new ManagementError('invalid_request','微信操作无效，请刷新后重试。');
  return channel.action(value as unknown as WeChatAction);
}
