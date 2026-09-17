import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pinyin } from 'pinyin-pro';
import { PcmRing } from '../../../media/wake/buffer.js';
import { keywordTokens } from '../../../media/wake/keywords.js';
import { openWakeDetector } from '../../../media/wake/detector.js';
import { BrowserWakeCapture } from '../../../media/wake/browser-capture.js';
import { inspectPcmWav } from '../../../media/wav.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function replace(name: string, value: unknown) { const old = Object.getOwnPropertyDescriptor(globalThis, name); Object.defineProperty(globalThis, name, { value, configurable: true }); return () => { if (old) Object.defineProperty(globalThis, name, old); else Reflect.deleteProperty(globalThis, name); }; }
function environment(echo: boolean | undefined) {
  const requests: { audio: unknown; video: unknown }[] = [], pending: ((s: unknown) => void)[] = [];
  let node: Node, stops = 0, closes = 0;
  class Context {
    sampleRate = 16000; state = 'running'; destination = {};
    audioWorklet = { addModule: async () => {} };
    async resume() {} async close() { closes++; this.state = 'closed'; }
    createMediaStreamSource() { return { connect() {} }; }
    createGain() { return { gain: { value: 1 }, connect() {} }; }
  }
  class Node {
    constructor() { node = this; }
    port = { onmessage: undefined as ((e: {data: unknown}) => void) | undefined, postMessage() {}, close() {} };
    onprocessorerror: (() => void) | undefined;
    connect() {} disconnect() {}
  }
  const restore = [replace('navigator', { mediaDevices: { getUserMedia(request: {audio: unknown;video: unknown}) { requests.push(request); return new Promise(resolve => pending.push(resolve)); } } }), replace('AudioContext', Context), replace('AudioWorkletNode', Node)];
  return { requests, grant(index: number) { const track = { stop() { stops++; }, getSettings() { return { echoCancellation: echo }; }, addEventListener() {} }; pending[index]!({ getTracks: () => [track], getAudioTracks: () => [track] }); },
    pcm(samples: Float32Array) { node.port.onmessage?.({data:{samples}}); }, fail() { node.onprocessorerror?.(); }, get stops() { return stops; }, get closes() { return closes; }, restore() { restore.reverse().forEach(f => f()); } };
}
test('ring keeps only last2s, copies ownership and clears', () => {
  const ring = new PcmRing(4); ring.push(new Float32Array([1,2,3])); ring.push(new Float32Array([4,5]));
  const copy = ring.takeCopy(); assert.deepEqual([...copy], [2,3,4,5]); copy.fill(0); assert.deepEqual([...ring.takeCopy()], [2,3,4,5]); ring.clear(); assert.equal(ring.length,0);
});
test('actual pinyin dependency default error is overridden and missing model token rejected', () => {
  assert.equal(pinyin('乐正绫',{type:'array'})[0],'lè');
  const tokens = 'y 180\nuè 158\nzh 182\nèng 196\nl 129\níng 208';
  assert.equal(keywordTokens('乐正绫',tokens),'y uè zh èng l íng @乐正绫');
  assert.throws(()=>keywordTokens('乐正绫',tokens.replace('uè 158','u 158')));
  assert.throws(()=>keywordTokens('abc',tokens));
});
test('wake first real zero PCM readiness, AEC path, 2s prefix survives consumer wipe, clip finish keeps stream; camera only after activation', async () => {
  const h=environment(true); let received=0;
  const capture=new BrowserWakeCapture({onPCM:pcm=>{received++;pcm.fill(0);}});
  try {
    const ready=capture.open(new AbortController().signal);h.grant(0);await tick();assert.equal(h.requests.length,1);
    assert.deepEqual(h.requests[0],{audio:{echoCancellation:true},video:false});
    h.pcm(new Float32Array(512)); assert.deepEqual(await ready,{echoCancellation:true});
    for(let i=0;i<63;i++)h.pcm(new Float32Array(512).fill(.25));
    const clip=capture.beginCapture(); assert.equal(h.requests.length,1);capture.authorizeCaptureCamera();capture.authorizeCaptureCamera();assert.equal(h.requests.length,2);assert.equal(h.requests[1]!.audio,false);
    assert.throws(()=>capture.beginCapture());
    h.pcm(new Float32Array(512).fill(.5)); const result=await clip.finish();
    const wav=inspectPcmWav(result.audio);assert.equal(wav.data.length,(32000+512)*2);assert.equal(wav.sampleRate,16000);
    const bytes=new DataView(wav.data.buffer,wav.data.byteOffset,wav.data.byteLength);assert.ok(bytes.getInt16(0,true)>0);assert.ok(bytes.getInt16(wav.data.length-2,true)>bytes.getInt16(0,true));
    assert.equal(h.stops,0);clip.stop();assert.equal(h.stops,0);
    h.grant(1);await tick();assert.equal(h.stops,1); // late camera stops, no document/video created
    const n=received;capture.close();h.pcm(new Float32Array(512));assert.equal(received,n);assert.equal(h.stops,2);result.audio.fill(0);
  } finally {capture.close();h.restore();}
});
test('AEC unavailable rejects and releases; close while permission pending resolves rejection and kills late track', async () => {
  for(const echo of [false,undefined]) {
    const h=environment(echo),capture=new BrowserWakeCapture({onPCM:p=>p.fill(0)});
    try {const opening=capture.open(new AbortController().signal);h.grant(0);await assert.rejects(opening);assert.equal(h.stops,1);}finally{capture.close();h.restore();}
  }
  const h=environment(true),capture=new BrowserWakeCapture({onPCM:p=>p.fill(0)});
  try {const opening=capture.open(new AbortController().signal);capture.close();await assert.rejects(opening);h.grant(0);await tick();assert.equal(h.stops,1);}finally{h.restore();}
});
test('live worklet failure reports once, cancels clip and clears microphone', async () => {
  const h=environment(true);let errors=0;const capture=new BrowserWakeCapture({onPCM:p=>p.fill(0),onError:()=>{errors++;}});
  try {const opening=capture.open(new AbortController().signal);h.grant(0);await tick();h.pcm(new Float32Array(512));await opening;
    const clip=capture.beginCapture();h.fail();h.fail();await assert.rejects(clip.finish());assert.equal(errors,1);assert.equal(h.stops,1);
  }finally{capture.close();h.restore();}
});
const modelDirectory=process.env.WAKE_MODEL_DIRECTORY;
test('fixed real KWS/VAD load, actual default token vocabulary, silence negative, idempotent capture/reset, bounded accept and close', {skip:!modelDirectory}, async () => {
  const tokenFile=await readFile(join(modelDirectory!,'tokens.txt'),'utf8');assert.equal(keywordTokens('乐正绫',tokenFile),'y uè zh èng l íng @乐正绫');
  const start=performance.now(),detector=await openWakeDetector({modelDirectory:modelDirectory!,settings:{keyword:'乐正绫',sensitivity:'standard',silenceMs:1500}});
  try {
    const input=new Float32Array(512);let hits=0;
    for(let i=0;i<100;i++){const r=await detector.accept(input);if(r.keyword)hits++;assert.equal(r.speech,false);}assert.equal(hits,0);assert.equal(input.byteLength,2048);
    await detector.setCapturing(true);await detector.setCapturing(true);assert.equal((await detector.accept(input)).speech,false);await detector.setCapturing(false);await detector.reset();
    await assert.rejects(detector.accept(new Float32Array(3201)));await assert.rejects(detector.accept(new Float32Array([NaN])));
    const one=detector.accept(input);await assert.rejects(detector.accept(input));await one;
    console.log(JSON.stringify({realNativeModels:true,elapsedMs:Math.round(performance.now()-start),silenceSeconds:3.2,keywordHits:hits,devices:0,cloud:0}));
  } finally {await detector.close();}await assert.rejects(detector.accept(new Float32Array(512)));
});
