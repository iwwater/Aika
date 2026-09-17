import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import type { TtsProvider, TurnScope } from '../contracts/index.js';
import { MemoryMediaStore } from '../media/store.js';
import { abortable, assertScope } from '../media/scope.js';
import { inspectPcmWav } from '../media/wav.js';
import { channelKey } from './store.js';
import { WeChatApi, type WeChatCredentials } from './api.js';

const CDN='https://novac2c.cdn.weixin.qq.com';
/** Candidate transport, deliberately not connected to the installed channel until format is selected. */
export function wechatAudioFileSender(media:MemoryMediaStore,tts:TtsProvider,api:WeChatApi,transport:typeof fetch=fetch){
  return async(auth:WeChatCredentials,context:string,text:string,clientId:string,signal:AbortSignal):Promise<void>=>{
    const scope:TurnScope={characterId:'companion',sessionId:'wechat-tts:'+channelKey(auth),turnId:randomUUID(),generation:1};
    let bytes:Uint8Array|undefined,key:Buffer|undefined,ciphertext:Buffer|undefined,uploadBody:Uint8Array<ArrayBuffer>|undefined;
    try{
      signal.throwIfAborted();
      if(!context||!text.trim()||text.length>20000||text.includes('\0'))throw Error('Invalid audio reply');
      const pending=tts.synthesize({scope,text,expression:{emotion:'neutral',intensity:0,delivery:'natural',gesture:null}},signal);
      // A provider which finishes after cancellation cannot leave its generated media alive.
      void pending.then(async()=>{if(signal.aborted)await media.releaseScope(scope);},()=>{});
      const result=await abortable(pending,signal);signal.throwIfAborted();assertScope(scope,result.scope);
      if(result.audio.mimeType!=='audio/wav')throw Error('Expected generated PCM WAV');
      bytes=await media.read(scope,result.audio);signal.throwIfAborted();inspectPcmWav(bytes);
      if(bytes.length>20*1024*1024)throw Error('Audio reply exceeds bounded upload');
      const size=bytes.length,md5=createHash('md5').update(bytes).digest('hex'),filekey=randomBytes(16).toString('hex');
      key=randomBytes(16);const cipher=createCipheriv('aes-128-ecb',key,null),body=cipher.update(bytes),tail=cipher.final();
      try{ciphertext=Buffer.concat([body,tail]);}finally{body.fill(0);tail.fill(0);}
      bytes.fill(0);await media.releaseScope(scope);
      const upload=await api.uploadAudioUrl(auth,{filekey,rawsize:size,rawfilemd5:md5,filesize:ciphertext.length,aeskey:key.toString('hex')},signal);
      signal.throwIfAborted();
      const full=upload.upload_full_url,param=upload.upload_param;
      if(full!==undefined&&(typeof full!=='string'||full.length>8192)||!full&&(typeof param!=='string'||!param||param.length>4096))throw Error('Invalid upload destination');
      const url=new URL(full||CDN+'/c2c/upload?encrypted_query_param='+encodeURIComponent(param!)+'&filekey='+filekey);
      if(url.origin!==CDN||url.pathname!=='/c2c/upload'||url.username||url.password||url.hash)throw Error('Invalid upload destination');
      const active=AbortSignal.any([signal,AbortSignal.timeout(20000)]);
      uploadBody=new Uint8Array(ciphertext);
      const pendingUpload=transport(url,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:uploadBody,redirect:'error',credentials:'omit',signal:active});
      void pendingUpload.then(response=>{if(active.aborted)void response.body?.cancel().catch(()=>{});},()=>{});
      const response=await abortable(pendingUpload,active);
      try{
        active.throwIfAborted();
        const downloadParam=response.headers.get('x-encrypted-param');
        if(response.status!==200||response.redirected||response.url&&new URL(response.url).href!==url.href||!downloadParam||downloadParam.length>8192)throw Error('Upload not accepted');
        await api.sendAudioFile(auth,context,{downloadParam,aesHex:key.toString('hex'),size},clientId,signal);
        signal.throwIfAborted();
      }finally{void response.body?.cancel().catch(()=>{});}
    }catch{signal.throwIfAborted();throw Error('WeChat audio file delivery unconfirmed');}
    finally{bytes?.fill(0);key?.fill(0);ciphertext?.fill(0);uploadBody?.fill(0);await media.releaseScope(scope);}
  };
}
