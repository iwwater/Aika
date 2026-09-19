import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { encode } from 'silk-wasm';
import { decodeWeChatVoice, WECHAT_VOICE_LIMITS, WeChatVoiceError } from '../../wechat/voice.js';
import type { WeChatVoiceItem } from '../../wechat/api.js';

const key = Buffer.alloc(16, 17);
const item: WeChatVoiceItem = { encode_type: 6, media: { encrypt_query_param: 'synthetic&only', aes_key: key.toString('base64') } };
const signal = () => new AbortController().signal;
const container = () => Buffer.from([2, ...Buffer.from('#!SILK_V3'), 1, 0, 9, 1, 0, 9]);
function encrypt(bytes: Uint8Array): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(bytes), cipher.final()]);
}
function transport(bytes = encrypt(container())): typeof fetch {
  return async () => new Response(new Uint8Array(bytes));
}
const fakeDecode = async () => ({ data: new Uint8Array([1, 2, 3, 4]), duration: 20 });
const isKind = (kind: WeChatVoiceError['kind']) => (error: unknown) => error instanceof WeChatVoiceError && error.kind === kind;

test('raw and hex-wrapped AES keys; exact official URL, no credentials, real WAV header and temporary cleanup', async () => {
  for (const aes_key of [key.toString('base64'), Buffer.from(key.toString('hex')).toString('base64')]) {
    let downloaded: Uint8Array | undefined, silk: Uint8Array | undefined, pcm: Uint8Array | undefined;
    const output = await decodeWeChatVoice({ ...item, media: { ...item.media, aes_key } }, signal(), {
      fetch: async (url, init) => {
        assert.equal(String(url), 'https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=synthetic%26only');
        assert.equal(init?.redirect, 'error'); assert.equal(init?.credentials, 'omit'); assert.equal(init?.headers, undefined);
        downloaded = new Uint8Array(encrypt(container())); return new Response(new ReadableStream({start(c) { c.enqueue(downloaded!); c.close(); }}));
      },
      decode: async (input, rate) => { silk = input; assert.equal(rate, 24000); pcm = new Uint8Array([1, 2, 3, 4]); return {data: pcm, duration: 20}; },
    });
    const wav = Buffer.from(output);
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF'); assert.equal(wav.readUInt32LE(24), 24000);
    assert.equal(wav.readUInt16LE(22), 1); assert.equal(wav.readUInt16LE(34), 16);
    assert.deepEqual([...wav.subarray(44)], [1, 2, 3, 4]);
    assert.ok(downloaded!.every(b => b === 0)); assert.ok(silk!.every(b => b === 0)); assert.ok(pcm!.every(b => b === 0)); output.fill(0);
  }
});

test('full_url takes priority; unreviewed origin, path, userinfo and bad key fail before network', async () => {
  let calls = 0;
  const fetch: typeof globalThis.fetch = async url => { calls++; assert.equal(String(url), 'https://novac2c.cdn.weixin.qq.com/c2c/download?x=full'); return new Response(new Uint8Array(encrypt(container()))); };
  await decodeWeChatVoice({ ...item, media: {...item.media, full_url: 'https://novac2c.cdn.weixin.qq.com/c2c/download?x=full'} }, signal(), {fetch, decode:fakeDecode});
  for (const full_url of ['https://attacker.test/c2c/download', 'http://novac2c.cdn.weixin.qq.com/c2c/download', 'https://novac2c.cdn.weixin.qq.com.attacker.test/c2c/download', 'https://secret@novac2c.cdn.weixin.qq.com/c2c/download', 'https://novac2c.cdn.weixin.qq.com/upload']) {
    await assert.rejects(decodeWeChatVoice({...item,media:{...item.media,full_url}}, signal(), {fetch}), isKind('invalid_media'));
  }
  await assert.rejects(decodeWeChatVoice({...item,media:{...item.media,aes_key:'bad secret'}},signal(),{fetch}), isKind('invalid_media'));
  assert.equal(calls, 1);
});

test('header and streaming byte limits; redirect and HTTP errors do not read response body', async () => {
  for (const response of [new Response(null,{status:302,headers:{location:'https://attacker.test'}}), new Response(null,{status:503})]) {
    await assert.rejects(decodeWeChatVoice(item,signal(),{fetch:async()=>response}), isKind('download'));
  }
  await assert.rejects(decodeWeChatVoice(item,signal(),{fetch:async()=>new Response(null,{headers:{'content-length':String(WECHAT_VOICE_LIMITS.downloadBytes+1)}})}),isKind('limit'));
  const huge = new Uint8Array(WECHAT_VOICE_LIMITS.downloadBytes+1).fill(1);
  await assert.rejects(decodeWeChatVoice(item,signal(),{fetch:async()=>new Response(new ReadableStream({start(c){c.enqueue(huge);c.close();}}))}),isKind('limit'));
  assert.ok(huge.every(b=>b===0));
});

test('bad padding, truncated/invalid SILK containers and unsupported codec never enter decoder', async () => {
  let decodes=0;
  const decode=async()=>{decodes++; return fakeDecode();};
  const badPadding=encrypt(container()); badPadding.fill(0);
  for (const bytes of [badPadding, encrypt(Buffer.from('not silk')), encrypt(container().subarray(0,15)), encrypt(Buffer.from([2,...Buffer.from('#!SILK_V3'),255,127,1]))]) {
    await assert.rejects(decodeWeChatVoice(item,signal(),{fetch:transport(bytes),decode}),isKind('decode'));
  }
  await assert.rejects(decodeWeChatVoice({...item,encode_type:7},signal(),{fetch:transport(),decode}),isKind('invalid_media'));
  await assert.rejects(decodeWeChatVoice({...item,playtime:120001},signal(),{fetch:transport(),decode}),isKind('limit'));
  assert.equal(decodes,0);
});

test('empty, odd and over-limit PCM are rejected and cleared; codec error text is redacted', async () => {
  for (const length of [0, 3, WECHAT_VOICE_LIMITS.pcmBytes+2]) {
    const data = new Uint8Array(length).fill(8);
    await assert.rejects(decodeWeChatVoice(item,signal(),{fetch:transport(),decode:async()=>({data,duration:1})}),isKind(length>WECHAT_VOICE_LIMITS.pcmBytes?'limit':'decode'));
    assert.ok(data.every(b=>b===0));
  }
  await assert.rejects(decodeWeChatVoice(item,signal(),{fetch:transport(),decode:async()=>{throw new Error('private key URL transcript');}}), e => e instanceof Error && e.message==='wechat_voice_decode');
});

test('pre-cancel does no I/O; late decoder result is rejected and cleared, next request isolated', async () => {
  const cancelled = new AbortController(); cancelled.abort(new Error('private reason'));
  await assert.rejects(decodeWeChatVoice(item,cancelled.signal,{fetch:async()=>{throw new Error('must not fetch');}}),isKind('cancelled'));
  const controller=new AbortController();
  let complete!: (v:{data:Uint8Array;duration:number})=>void;
  let started!: ()=>void; const ready=new Promise<void>(r=>started=r);
  let owned:Uint8Array|undefined;
  const pending=decodeWeChatVoice(item,controller.signal,{fetch:transport(),decode:input=>{owned=input;started();return new Promise(r=>complete=r);}});
  await ready; controller.abort(); await assert.rejects(pending,isKind('cancelled'));
  assert.ok(owned!.every(b=>b===0));
  const late=new Uint8Array([1,2]);complete({data:late,duration:20});await new Promise(r=>setImmediate(r));assert.deepEqual([...late],[0,0]);
  const next=await decodeWeChatVoice(item,signal(),{fetch:transport(),decode:fakeDecode}); assert.equal(next.length,48);next.fill(0);
});

test('deadline covers stalled download and decode; late fetch body is cancelled', async () => {
  let finish!:(v:Response)=>void;
  const pending=decodeWeChatVoice(item,signal(),{timeoutMs:10,fetch:()=>new Promise(r=>finish=r)});
  await assert.rejects(pending,isKind('timeout'));
  let discarded=false;finish(new Response(new ReadableStream({cancel(){discarded=true;}})));
  await new Promise(r=>setImmediate(r)); assert.ok(discarded);
  await assert.rejects(decodeWeChatVoice(item,signal(),{timeoutMs:10,fetch:transport(),decode:()=>new Promise(()=>{})}),isKind('timeout'));
  let bodyCancelled=false;
  await assert.rejects(decodeWeChatVoice(item,signal(),{timeoutMs:10,fetch:async()=>new Response(new ReadableStream({cancel(){bodyCancelled=true;}}))}),isKind('timeout'));
  assert.ok(bodyCancelled);
});

test('synthetic tone uses real silk-wasm encode, encrypted transport and production worker decode, without device/model/network', async () => {
  const pcm = Buffer.alloc(24000/5*2);
  for(let i=0;i<pcm.length/2;i++)pcm.writeInt16LE(Math.round(3000*Math.sin(2*Math.PI*440*i/24000)),i*2);
  const encoded=await encode(pcm,24000);pcm.fill(0);
  try {
    const start=performance.now();
    const output=await decodeWeChatVoice(item,signal(),{fetch:transport(encrypt(encoded.data))});
    const audio=Buffer.from(output);
    assert.ok(audio.length>44); assert.ok(audio.subarray(44).some(b=>b!==0));
    assert.equal(audio.readUInt32LE(40),audio.length-44);
    process.stdout.write(JSON.stringify({syntheticCodec:true,elapsedMs:Math.round(performance.now()-start),silkBytes:encoded.data.length,wavBytes:audio.length,sampleRate:audio.readUInt32LE(24),devices:0,models:0,network:0})+'\n');
    output.fill(0);audio.fill(0);
    const cancelled=new AbortController();
    await assert.rejects(decodeWeChatVoice(item,cancelled.signal,{fetch:async()=>{
      setTimeout(()=>cancelled.abort(),1);
      return new Response(new Uint8Array(encrypt(encoded.data)));
    }}),isKind('cancelled'));
  } finally {encoded.data.fill(0);}
});
