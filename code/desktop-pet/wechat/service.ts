import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { qrImage } from './qr.js';
import { ManagementError } from '../contracts/management.js';
import type { WeChatAction, WeChatManagement, WeChatSnapshot, WeChatInputSource, WeChatReplyMode } from '../contracts/wechat.js';
import type { WorkInputBinding } from '../contracts/desktop-work.js';
import { ILINK_ORIGIN, WeChatApi, WeChatApiError, weixinOrigin, type WeChatCredentials, type WeChatVoiceItem } from './api.js';
import { channelKey, WeChatStore } from './store.js';

export interface WeChatReplyContext { source: WeChatInputSource; replyMode: WeChatReplyMode }
export interface WeChatInput { text: string; messageId: string; createdAt?: number; replyContext?: WeChatReplyContext }
export interface WeChatConversation {
  capture(): WorkInputBinding | undefined;
  receive(input: WeChatInput, binding: WorkInputBinding | undefined, signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}
export type WeChatSend = (text: string, key: string, context?: WeChatReplyContext) => Promise<boolean>;
export interface WeChatMediaPorts {
  transcribe?: (item: WeChatVoiceItem, channel: string, signal: AbortSignal) => Promise<string>;
  sendVoice?: (auth: WeChatCredentials, contextToken: string, text: string, clientId: string, signal: AbortSignal) => Promise<void>;
}
export type WeChatConversationFactory = (key: string, send: WeChatSend) => Promise<WeChatConversation>;
const digest = (v: string) => createHash('sha256').update(v).digest('hex');
const validString = (v: unknown, max=1000): v is string => typeof v==='string' && v.length>0 && v.length<=max && !v.includes('\0');

/** One bound personal Bot peer. Inbound claims/cursor survive restart; no execution retries. */
export class WeChatService implements WeChatManagement {
  private state: WeChatSnapshot = {apiVersion:'0.2',replyMode:'follow_input',revision:0,status:'disconnected',enabled:false,boundUser:null,detail:'尚未连接微信。',qr:null,lastInputAt:null,lastOutputAt:null,lastDelivery:'none'};
  private loginAbort?: AbortController;
  private qrPollAbort?: AbortController;
  private connectionAbort: AbortController | undefined;
  private loginJob?: Promise<void>;
  private connectionJob?: Promise<void>;
  private conversation: WeChatConversation | undefined;
  private mutations: Promise<unknown> = Promise.resolve();
  private outputs: Promise<unknown> = Promise.resolve();
  private pendingCode: string | undefined;
  private closed=false;
  constructor(private readonly store: WeChatStore, private readonly api: WeChatApi, private readonly factory: WeChatConversationFactory, private readonly media: WeChatMediaPorts = {}) {
    const mode=store.get<WeChatReplyMode>('replyMode');
    if(mode==='follow_input'||mode==='text'||mode==='voice')this.state.replyMode=mode;
    const auth=store.get<WeChatCredentials>('credentials');
    if(auth)this.update({status:'paused',boundUser:{userId:auth.userId,botId:auth.botId},detail:'微信连接已暂停。'});
  }
  snapshot(): WeChatSnapshot { return structuredClone(this.state); }
  private update(change: Partial<WeChatSnapshot>) {
    const next={...this.state,...change};if(JSON.stringify(next)===JSON.stringify(this.state))return;
    this.state={...next,revision:this.state.revision+1};
  }
  async restore() { if(this.store.get<boolean>('enabled'))await this.start(); }
  action(input: WeChatAction): Promise<WeChatSnapshot> {
    const job=this.mutations.then(async()=>{
      if(this.closed)throw new ManagementError('unavailable','微信连接已关闭。');
      if(input.expectedRevision!==this.state.revision)throw new ManagementError('version_conflict','连接状态刚有变化，请刷新后再试。');
      if(input.action==='set_reply_mode'){
        if(!['follow_input','text','voice'].includes(input.replyMode))throw new ManagementError('invalid_request','回复方式无效。');
        this.store.set('replyMode',input.replyMode);this.update({replyMode:input.replyMode});
      }else if(input.action==='login')await this.login();
      else if(input.action==='verify'){
        if(this.state.status!=='need_verification'||!/^\d{4,12}$/.test(input.code))throw new ManagementError('invalid_request','请填写手机上显示的验证码。');
        this.pendingCode=input.code;this.qrPollAbort?.abort();this.update({status:'scanned',detail:'正在核对验证码。'});
      }else if(input.action==='start'){await this.stop(false);await this.start();}
      else if(input.action==='stop'||input.action==='disconnect'){
        await this.stop(true);this.update({status:this.state.boundUser?'paused':'disconnected',enabled:false,qr:null,detail:this.state.boundUser?'微信连接已暂停，已派发的任务不会取消。':'扫码已暂停，可以重新连接微信。'});
        if(input.action==='disconnect'){this.store.delete('credentials');this.update({status:'disconnected',boundUser:null,detail:'已断开微信连接，本机登录凭据已移除。'});}
      }else throw new ManagementError('invalid_request','没有这个微信操作。');
      return this.snapshot();
    });this.mutations=job.catch(()=>{});return job;
  }
  private async login() {
    await this.stop(true);const abort=new AbortController();this.loginAbort=abort;
    this.update({status:'starting',enabled:false,qr:null,detail:'正在准备二维码。'});
    try{
      const qr=await this.api.qr(abort.signal);abort.signal.throwIfAborted();
      if(!validString(qr.qrcode,4096)||!validString(qr.qrcode_img_content,8192))throw new WeChatApiError('invalid_response');
      const imageDataUrl=await qrImage(qr.qrcode_img_content);abort.signal.throwIfAborted();
      const expires=Date.now()+5*60_000;
      this.update({status:'waiting_scan',detail:'请用希望与桌宠聊天或发指令的微信扫码授权机器人。',qr:{imageDataUrl,expiresAt:new Date(expires).toISOString()}});
      this.loginJob=this.pollLogin(qr.qrcode,expires,abort).catch(()=>{if(!abort.signal.aborted)this.update({status:'error',qr:null,detail:'微信登录暂未完成，请刷新二维码重试。'});});
    }catch{if(!abort.signal.aborted)this.update({status:'error',qr:null,detail:'无法取得微信二维码，请检查网络后重试。'});}
  }
  private async pollLogin(qr: string,expires: number,abort: AbortController) {
    let base=ILINK_ORIGIN,redirects=0;
    while(!abort.signal.aborted&&Date.now()<expires){
      this.qrPollAbort=new AbortController();const code=this.pendingCode;this.pendingCode=undefined;
      try{
        const result=await this.api.qrStatus(base,qr,AbortSignal.any([abort.signal,this.qrPollAbort.signal]),code);abort.signal.throwIfAborted();
        if(result.status==='confirmed'){
          if(!validString(result.bot_token,8192)||!validString(result.ilink_bot_id)||!validString(result.ilink_user_id)||!validString(result.baseurl))throw new WeChatApiError('invalid_response');
          const auth:WeChatCredentials={token:result.bot_token,botId:result.ilink_bot_id,userId:result.ilink_user_id,baseUrl:weixinOrigin(result.baseurl)};
          this.store.set('credentials',auth);this.store.set('boundAt:'+channelKey(auth),Date.now());this.update({boundUser:{userId:auth.userId,botId:auth.botId},qr:null});
          await this.start();return;
        }
        if(result.status==='expired'||result.status==='verify_code_blocked'){this.update({status:'expired',qr:null,detail:'二维码已失效，请刷新后重新扫码。'});return;}
        if(result.status==='scaned_but_redirect'){
          if(!validString(result.redirect_host)||++redirects>3)throw new WeChatApiError('invalid_response');
          base=weixinOrigin('https://'+result.redirect_host);continue;
        }
        if(result.status==='binded_redirect'){this.update({status:this.state.boundUser?'paused':'disconnected',qr:null,detail:'此机器人已有绑定；可启用本机保存的连接，或重新扫码。'});return;}
        if(result.status==='need_verifycode')this.update({status:'need_verification',detail:'请输入手机微信上显示的验证码。'});
        else if(result.status==='scaned')this.update({status:'scanned',detail:'已扫码，请在手机微信中确认授权。'});
      }catch(error){if(abort.signal.aborted)return;if(error instanceof WeChatApiError&&error.kind==='invalid_response')throw error;}
      await sleep(750,undefined,{signal:abort.signal}).catch(()=>{});
    }
    if(!abort.signal.aborted)this.update({status:'expired',qr:null,detail:'二维码已过期，请刷新。'});
  }
  private async start() {
    if(this.connectionAbort&&!this.connectionAbort.signal.aborted)return;
    const auth=this.store.get<WeChatCredentials>('credentials');if(!auth){this.update({status:'disconnected',detail:'请先扫码连接微信。'});return;}
    weixinOrigin(auth.baseUrl);const key=channelKey(auth),abort=new AbortController();this.connectionAbort=abort;
    this.store.set('enabled',true);this.update({status:'starting',enabled:true,qr:null,detail:'正在连接微信。'});
    try{this.conversation=await this.factory(key,(text,id,context)=>this.send(auth,key,text,id,abort.signal,context));}
    catch{abort.abort();this.connectionAbort=undefined;this.store.set('enabled',false);this.update({status:'error',enabled:false,detail:'微信会话未能启动，请重新启用。'});return;}
    this.connectionJob=this.pollMessages(auth,key,this.conversation,abort).catch(()=>{if(!abort.signal.aborted)this.update({status:'error',detail:'微信连接暂不可用，请重新启用或扫码。'});});
  }
  private async pollMessages(auth: WeChatCredentials,key: string,conversation: WeChatConversation,abort: AbortController) {
    let timeout=35000,failures=0;
    while(!abort.signal.aborted){
      try{
        const result=await this.api.updates(auth,this.store.get<string>('cursor:'+key)??'',abort.signal,timeout);abort.signal.throwIfAborted();
        if(result.msgs!==undefined&&!Array.isArray(result.msgs))throw new WeChatApiError('invalid_response');
        failures=0;this.update({status:'connected',detail:'已连接，仅接收绑定用户的单聊文字与语音。'});
        // Freeze before processing any item: a queued "confirm" cannot approve a card created by an earlier item in this same batch.
        const binding=conversation.capture(),replyMode=this.state.replyMode;
        for(const msg of result.msgs??[]){
          abort.signal.throwIfAborted();
          if(!msg||msg.from_user_id!==auth.userId||msg.group_id||msg.message_type!==1||msg.message_state!==2
            ||msg.to_user_id&&msg.to_user_id!==auth.botId||!validString(msg.message_id,256))continue;
          if(msg.create_time_ms!==undefined&&msg.create_time_ms<(this.store.get<number>('boundAt:'+key)??0))continue;
          const id=digest(msg.message_id);if(!this.store.claim(key,'in:'+id))continue;
          if(validString(msg.context_token,8192))this.store.set('context:'+key,msg.context_token);
          this.update({lastInputAt:new Date().toISOString()});
          const items=msg.item_list??[];
          if(!Array.isArray(items)||!items.length||items.length>16||items.some(item=>!item||(item.type!==1&&item.type!==3)||item.type===1&&typeof item.text_item?.text!=='string'||item.type===3&&(!item.voice_item||typeof item.voice_item!=='object'))||items.filter(item=>item.type===3).length>1){
            await this.send(auth,key,'请发送文字或一条语音；这条消息没有进入聊天或任务处理。','unsupported:'+id,abort.signal);this.store.finish(key,'in:'+id,'unsupported');continue;
          }
          const replyContext:WeChatReplyContext={source:items.some(item=>item.type===3)?'voice':'text',replyMode};
          let text:string;
          try{
            const parts:string[]=[];
            for(const item of items){
              if(item.type===1){parts.push(item.text_item!.text!);continue;}
              const voice=item.voice_item!;
              const transcript=typeof voice.text==='string'&&voice.text.trim()?voice.text:await this.media.transcribe?.(voice,key,abort.signal);
              abort.signal.throwIfAborted();
              if(!validString(transcript,20000)||!transcript.trim())throw Error('Invalid voice transcript');
              parts.push(transcript);
            }
            text=parts.join('\n');
            if(!text.trim()||text.length>20000||text.includes('\0'))throw Error('Invalid input');
          }catch{
            this.store.finish(key,'in:'+id,'invalid');
            if(!abort.signal.aborted)await this.send(auth,key,'这条语音或文字未能识别，没有进入聊天或派发任务。请重新发送。','transcript-error:'+id,abort.signal);
            continue;
          }
          try{await conversation.receive({text,messageId:id,replyContext,...(msg.create_time_ms!==undefined?{createdAt:msg.create_time_ms}:{})},binding,abort.signal);this.store.finish(key,'in:'+id,'handled');}
          catch{this.store.finish(key,'in:'+id,'unknown');if(!abort.signal.aborted)await this.send(auth,key,'这条消息未能处理完成，暂时没有可确认的回复。','input-error:'+id,abort.signal);}
        }
        if(validString(result.get_updates_buf,100000))this.store.set('cursor:'+key,result.get_updates_buf);
        if(Number.isFinite(result.longpolling_timeout_ms))timeout=Math.max(1000,Math.min(60000,result.longpolling_timeout_ms!));
        await sleep(250,undefined,{signal:abort.signal});
      }catch(error){
        if(abort.signal.aborted)return;
        if(error instanceof WeChatApiError&&error.kind==='expired'){this.store.set('enabled',false);this.update({status:'expired',enabled:false,detail:'微信登录已过期，请重新扫码。'});return;}
        this.update({status:'starting',detail:'微信连接暂时中断，正在重新连接；不会重复执行消息。'});
        await sleep(Math.min(30000,1000*2**Math.min(failures++,5)),undefined,{signal:abort.signal}).catch(()=>{});
      }
    }
  }
  private send(auth: WeChatCredentials,key: string,text: string,id: string,signal: AbortSignal,reply?:WeChatReplyContext): Promise<boolean> {
    const job=this.outputs.then(async()=>{
      if(signal.aborted||!this.state.enabled||channelKey(this.store.get<WeChatCredentials>('credentials')??{userId:'',botId:''})!==key)return false;
      const context=this.store.get<string>('context:'+key);if(!context){this.update({lastDelivery:'failed',detail:'暂时无法主动回复，请在微信发一句文字后查询结果。'});return false;}
      const voice=reply&&(reply.replyMode==='voice'||reply.replyMode==='follow_input'&&reply.source==='voice');
      if(voice){
        if(!this.media.sendVoice){this.update({lastDelivery:'failed',detail:'语音回复尚不可用，本次没有改用文字发送。'});return false;}
        const part='out:'+digest(id+':voice');if(this.store.seenStatus(key,part)==='accepted')return true;
        if(!this.store.claim(key,part))return false;
        try{await this.media.sendVoice(auth,context,text,randomUUID(),signal);signal.throwIfAborted();this.store.finish(key,part,'accepted');}
        catch{this.store.finish(key,part,'unknown');this.update({lastDelivery:'unknown',detail:'语音回复未确认送达，未自动重发或改用文字。'});return false;}
        this.update({lastOutputAt:new Date().toISOString(),lastDelivery:'accepted'});return true;
      }
      const chars=Array.from(text);for(let n=0;n<chars.length;n+=1500){
        signal.throwIfAborted();const part='out:'+digest(id+':'+n),old=this.store.seenStatus(key,part);
        if(old==='accepted')continue;if(!this.store.claim(key,part))return false;
        try{await this.api.send(auth,context,chars.slice(n,n+1500).join(''),randomUUID(),signal);this.store.finish(key,part,'accepted');}
        catch(error){this.store.finish(key,part,'unknown');this.update({lastDelivery:'unknown',detail:'回复尚未确认送达，请在微信主动查询；任务结果仍保留。'});return false;}
      }
      this.update({lastOutputAt:new Date().toISOString(),lastDelivery:'accepted'});return true;
    });this.outputs=job.catch(()=>{});return job;
  }
  private async stop(persist: boolean) {
    if(persist)this.store.set('enabled',false);
    this.loginAbort?.abort();this.connectionAbort?.abort();this.pendingCode=undefined;this.update({enabled:false,qr:null});
    await Promise.allSettled([this.loginJob,this.connectionJob,this.outputs]);
    await this.conversation?.close();this.conversation=undefined;this.connectionAbort=undefined;
  }
  async close() { this.closed=true;await this.mutations;await this.stop(false);this.store.close(); }
}
