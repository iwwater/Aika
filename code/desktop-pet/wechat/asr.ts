import { randomUUID } from 'node:crypto';
import type { AsrProvider, TurnScope } from '../contracts/index.js';
import { MemoryMediaStore } from '../media/store.js';
import { assertScope, abortable } from '../media/scope.js';
import { inspectPcmWav } from '../media/wav.js';
import { decodeWeChatVoice } from './voice.js';
import type { WeChatVoiceItem } from './api.js';

/** The ASR provider and this adapter share one dedicated store, never desktop capture. */
export function wechatTranscriber(media: MemoryMediaStore, provider: AsrProvider, decode=decodeWeChatVoice) {
  return async (item:WeChatVoiceItem, channel:string, signal:AbortSignal):Promise<string> => {
    const scope:TurnScope={characterId:'companion',sessionId:'wechat-asr:'+channel,turnId:randomUUID(),generation:1};
    let bytes:Uint8Array|undefined;
    try {
      bytes=await decode(item,signal);signal.throwIfAborted();
      if(inspectPcmWav(bytes).durationMs>120000)throw Error('Voice duration exceeded');
      const audio=await media.put(scope,bytes,'audio/wav');bytes.fill(0);
      signal.throwIfAborted();
      const result=await abortable(provider.transcribe({scope,audio},signal),signal);
      signal.throwIfAborted();assertScope(scope,result.scope);
      return result.transcript;
    }finally{bytes?.fill(0);await media.releaseScope(scope);}
  };
}
