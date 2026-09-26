import { randomBytes } from 'node:crypto';
import { parseWeixinApiJson } from './lossless-json.js';

export const ILINK_ORIGIN = 'https://ilinkai.weixin.qq.com';
export interface WeChatCredentials { token: string; botId: string; userId: string; baseUrl: string }
/** Tencent/openclaw-weixin7c04adc inbound voice fields; never expose media keys in management. */
export interface WeChatVoiceItem {
  media?: { encrypt_query_param?: string; aes_key?: string; encrypt_type?: number; full_url?: string };
  encode_type?: number; bits_per_sample?: number; sample_rate?: number; playtime?: number; text?: string;
}
export interface WeChatMessage {
  message_id?: string; from_user_id?: string; to_user_id?: string; group_id?: string;
  message_type?: number; message_state?: number; context_token?: string; create_time_ms?: number;
  item_list?: { type?: number; text_item?: { text?: string }; voice_item?: WeChatVoiceItem }[];
}
export interface WeChatUpdates { ret?: number; errcode?: number; msgs?: WeChatMessage[]; get_updates_buf?: string; longpolling_timeout_ms?: number }
export interface QrStatus { status: string; bot_token?: string; ilink_bot_id?: string; ilink_user_id?: string; baseurl?: string; redirect_host?: string }
export class WeChatApiError extends Error {
  constructor(readonly kind: 'expired' | 'network' | 'rejected' | 'invalid_response') { super(kind); }
}
/** Credentials may only go to reviewed official Weixin HTTPS origins. Redirects are explicit. */
export function weixinOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash
    || !['/', ''].includes(url.pathname) || !(url.hostname === 'ilinkai.weixin.qq.com' || url.hostname.endsWith('.ilinkai.weixin.qq.com')))
    throw new WeChatApiError('invalid_response');
  return url.origin;
}
export class WeChatApi {
  constructor(private readonly transport: typeof fetch = fetch) {}
  private async request<T>(base: string, path: string, signal: AbortSignal, body?: object, token?: string, timeoutMs = 20000): Promise<T> {
    const headers: Record<string,string> = { 'iLink-App-Id':'bot', 'iLink-App-ClientVersion':String((2<<16)|(4<<8)|9) };
    if (body) Object.assign(headers, { 'Content-Type':'application/json', AuthorizationType:'ilink_bot_token', 'X-WECHAT-UIN':Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64') }, token ? {Authorization:'Bearer '+token} : {});
    try {
      const response = await this.transport(new URL(path,weixinOrigin(base)), {method:body?'POST':'GET',headers,redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]),...(body?{body:JSON.stringify(body)}:{})});
      if (!response.ok) throw new WeChatApiError(response.status===401||response.status===403?'expired':'network');
      if (Number(response.headers.get('content-length'))>2*1024*1024) throw new WeChatApiError('invalid_response');
      const raw=await response.text();if(raw.length>2*1024*1024)throw new WeChatApiError('invalid_response');
      const data=parseWeixinApiJson<Record<string,unknown>>(raw);
      if (!data || typeof data!=='object' || Array.isArray(data)) throw new WeChatApiError('invalid_response');
      if (data.ret===-14 || data.errcode===-14) throw new WeChatApiError('expired');
      if (data.ret!==undefined && data.ret!==0 || data.errcode!==undefined && data.errcode!==0) throw new WeChatApiError('rejected');
      return data as T;
    } catch (error) {
      signal.throwIfAborted();
      if(error instanceof WeChatApiError)throw error;
      throw new WeChatApiError('network'); // Never expose response bodies, request URLs or credentials.
    }
  }
  qr(signal: AbortSignal) { return this.request<{qrcode:string;qrcode_img_content:string}>(ILINK_ORIGIN,'/ilink/bot/get_bot_qrcode?bot_type=3',signal,{local_token_list:[]}); }
  qrStatus(base: string, qr: string, signal: AbortSignal, code?: string) {
    const params=new URLSearchParams({qrcode:qr,...(code?{verify_code:code}:{})});
    return this.request<QrStatus>(base,'/ilink/bot/get_qrcode_status?'+params,signal,undefined,undefined,35000);
  }
  updates(auth: WeChatCredentials, cursor: string, signal: AbortSignal, timeoutMs=35000) {
    return this.request<WeChatUpdates>(auth.baseUrl,'/ilink/bot/getupdates',signal,{get_updates_buf:cursor,base_info:this.baseInfo()},auth.token,timeoutMs+5000);
  }
  send(auth: WeChatCredentials, context: string, text: string, clientId: string, signal: AbortSignal) {
    if(!context)throw new WeChatApiError('rejected');
    return this.request<{ret?:number;message_id?:string}>(auth.baseUrl,'/ilink/bot/sendmessage',signal,{msg:{from_user_id:'',to_user_id:auth.userId,client_id:clientId,message_type:2,message_state:2,context_token:context,item_list:[{type:1,text_item:{text}}]},base_info:this.baseInfo()},auth.token);
  }
  uploadAudioUrl(auth:WeChatCredentials, input:{filekey:string;rawsize:number;rawfilemd5:string;filesize:number;aeskey:string},signal:AbortSignal) {
    return this.request<{upload_param?:string;upload_full_url?:string}>(auth.baseUrl,'/ilink/bot/getuploadurl',signal,{...input,media_type:3,to_user_id:auth.userId,no_need_thumb:true,base_info:this.baseInfo()},auth.token);
  }
  /** Explicit FILE attachment candidate; this method never claims native voice delivery. */
  sendAudioFile(auth:WeChatCredentials,context:string,input:{downloadParam:string;aesHex:string;size:number},clientId:string,signal:AbortSignal){
    if(!context)throw new WeChatApiError('rejected');
    return this.request<{ret?:number;message_id?:string}>(auth.baseUrl,'/ilink/bot/sendmessage',signal,{msg:{from_user_id:'',to_user_id:auth.userId,client_id:clientId,message_type:2,message_state:2,context_token:context,item_list:[{type:4,file_item:{file_name:'语音回复.wav',len:String(input.size),media:{encrypt_query_param:input.downloadParam,aes_key:Buffer.from(input.aesHex).toString('base64'),encrypt_type:1}}}]},base_info:this.baseInfo()},auth.token);
  }
  private baseInfo() { return {channel_version:'2.4.9-beta.0',bot_agent:'DesktopPet/0.1'}; }
}
