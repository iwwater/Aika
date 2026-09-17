import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { BrowserCaptureDriver } from '../../media/browser-capture.js';
import { BrowserPlaybackDriver } from '../../media/browser-playback.js';
import type { PlaybackSample } from '../../media/playback.js';
import { CaptureError, readDeviceFailure, toDeviceFailure } from '../../media/capture-errors.js';

// Controlled browser API doubles; these tests do not open a real microphone or speaker.
function replace(name: string, value: unknown): () => void {
  const original = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  return () => { if (original) Object.defineProperty(globalThis, name, original); else Reflect.deleteProperty(globalThis, name); };
}
const options = { cameraWidth: 320, jpegQuality: .75, maxBufferedSamples: 24000 * 30 };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('browser capture stops late getUserMedia tracks after cancellation', async () => {
  let grant!: (stream: unknown) => void, stops = 0;
  const restore = replace('navigator', { mediaDevices: { getUserMedia: () => new Promise(resolve => { grant = resolve; }) } });
  const restoreAudio=replace('AudioContext',class{state='running';audioWorklet={addModule:()=>new Promise<void>(()=>{})};async resume(){}async close(){this.state='closed';}});
  try {
    const signal = new AbortController(), pending = new BrowserCaptureDriver(options).open(signal.signal);
    const rejected = assert.rejects(pending, { name: 'AbortError' }); signal.abort(); await rejected;
    grant({ getTracks: () => [{ stop() { stops++; } }, { stop() { stops++; } }] }); await tick();
    assert.equal(stops, 2);
  } finally { restoreAudio();restore(); }
});
test('browser capture setup failure closes both devices and audio context', async () => {
  let stops = 0, closes = 0;
  const tracks = [{ stop() { stops++; } }, { stop() { stops++; } }];
  const restoreNavigator = replace('navigator', { mediaDevices: { async getUserMedia() { return { getTracks: () => tracks, getAudioTracks: () => [tracks[0]], getVideoTracks: () => [tracks[1]] }; } } });
  const restoreAudio = replace('AudioContext', class { state = 'running'; audioWorklet = { async addModule() { throw new Error('worklet unavailable'); } }; async resume(){} async close() { closes++; this.state = 'closed'; } });
  try { await assert.rejects(new BrowserCaptureDriver(options).open(new AbortController().signal), /录音组件/); assert.equal(stops, 2); assert.equal(closes, 1); }
  finally { restoreNavigator(); restoreAudio(); }
});
test('camera preview failure does not discard a ready microphone', async () => {
 const h=captureEnvironment('camera_preview');
 try{const session=await new BrowserCaptureDriver(options).open(new AbortController().signal);await tick();session.stop();assert.ok(h.seen.trackStops.every(n=>n>0));}finally{h.restore();}
});

test('worklet load AbortError is a recording failure unless the turn signal was cancelled', async () => {
  let stops = 0, closes = 0;
  const tracks = [{ stop() { stops++; } }, { stop() { stops++; } }];
  const restoreNavigator = replace('navigator', { mediaDevices: { async getUserMedia() { return { getTracks: () => tracks, getAudioTracks: () => [tracks[0]], getVideoTracks: () => [tracks[1]] }; } } });
  const restoreAudio = replace('AudioContext', class {
    state = 'running';
    audioWorklet = { async addModule() { throw new DOMException('Unable to load module: PRIVATE_URI', 'AbortError'); } };
    async resume(){}
    async close() { closes++; this.state = 'closed'; }
  });
  try {
    await assert.rejects(new BrowserCaptureDriver(options).open(new AbortController().signal), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(stops, 2); assert.equal(closes, 1);
      assert.notEqual(error.name, 'AbortError');
      assert.match(error.message, /录音组件/);
      assert.doesNotMatch(error.message, /PRIVATE_URI/);
      return true;
    });
  } finally { restoreNavigator(); restoreAudio(); }
});

function captureEnvironment(failAt?: 'get_user_media' | 'audio_resume' | 'camera_preview', moduleReady = Promise.resolve()) {
  const seen = { trackStops: [0, 0], closes: 0, pauses: 0, portCloses: 0, moduleUrl: '' };
  const tracks = seen.trackStops.map((_n, index) => ({ stop() { seen.trackStops[index]!++; } }));
  const fail = (stage: typeof failAt) => { if (failAt === stage) throw new DOMException('PRIVATE_DETAIL', 'NotAllowedError'); };
  class CaptureContext {
    state = 'running'; destination = {}; sampleRate = 24000;
    audioWorklet = { async addModule(url: string | URL) { seen.moduleUrl = String(url); await moduleReady; } };
    async resume() { fail('audio_resume'); }
    async close() { seen.closes++; this.state = 'closed'; }
    createMediaStreamSource() { return { connect() {} }; }
    createGain() { return { gain: { value: 1 }, connect() {} }; }
  }
  class CaptureNode {
    port = { onmessage: null as null|((event:{data:{started:boolean}})=>void), close() { seen.portCloses++; }, postMessage() {} };
    connect() {queueMicrotask(()=>this.port.onmessage?.({data:{started:true}}));} disconnect() {}
  }
  const restores = [
    replace('navigator', { mediaDevices: { async getUserMedia(request:{audio?:boolean}) {
      if(request.audio)fail('get_user_media');
      return { getTracks: () => request.audio?[tracks[0]]:[tracks[1]], getAudioTracks: () => request.audio?[tracks[0]]:[], getVideoTracks: () => request.audio?[]:[tracks[1]] };
    } } }),
    replace('AudioContext', CaptureContext), replace('AudioWorkletNode', CaptureNode),
    replace('document', { createElement(kind: string) {
      assert.equal(kind, 'video');
      return { async play() { fail('camera_preview'); }, pause() { seen.pauses++; }, srcObject: null };
    } }),
  ];
  return { seen, restore() { restores.reverse().forEach(restore => restore()); } };
}

test('permission, audio activation and camera preview failures stay distinct and close acquired resources', async () => {
  for (const stage of ['get_user_media', 'audio_resume'] as const) {
    const h = captureEnvironment(stage);
    try {
      await assert.rejects(new BrowserCaptureDriver(options).open(new AbortController().signal), (error: unknown) => {
        assert.ok(error instanceof CaptureError);
        assert.deepEqual(error.failure, { code: stage === 'get_user_media' ? 'permission_denied' : 'capture_start_failed', stage });
        assert.doesNotMatch(error.message, /PRIVATE_DETAIL/); return true;
      });
      assert.equal(h.seen.trackStops[1],0);assert.equal(h.seen.trackStops[0],stage==='get_user_media'?0:1);
      assert.equal(h.seen.closes, 1,'parallel setup context closes even when microphone permission fails');
      if (stage !== 'get_user_media') { assert.equal(h.seen.portCloses, 1); assert.equal(h.seen.pauses,0); }
    } finally { h.restore(); }
  }
});

test('cancellation during module loading closes devices and a late load cannot reopen them', async () => {
  let complete!: () => void;
  const loaded = new Promise<void>(resolve => { complete = resolve; }), h = captureEnvironment(undefined, loaded);
  try {
    const controller = new AbortController(), opened = new BrowserCaptureDriver(options).open(controller.signal);
    const cancelled = assert.rejects(opened, { name: 'AbortError' });
    await tick(); controller.abort(); await cancelled;
    complete(); await tick();
    assert.deepEqual(h.seen.trackStops, [1, 0]); assert.equal(h.seen.closes, 1); assert.equal(h.seen.portCloses, 0);
  } finally { complete(); h.restore(); }
});

test('safe diagnostics refuse foreign fields and invalid code-stage combinations', () => {
  assert.equal(readDeviceFailure({ code: 'permission_denied', stage: 'audio_resume' }), undefined);
  assert.equal(readDeviceFailure({ code: 'capture_start_failed', stage: ['audio_resume'] }), undefined);
  assert.deepEqual(readDeviceFailure({ code: 'capture_module_failed', stage: 'audio_worklet', message: 'PRIVATE' }), { code: 'capture_module_failed', stage: 'audio_worklet' });
  assert.deepEqual(toDeviceFailure({ failure: { code: 'permission_denied', stage: 'get_user_media' } }), { code: 'device_operation_failed', stage: 'unknown' });
});

test('capture loads the configured module URL without a Blob fallback', async () => {
  const h = captureEnvironment();
  try {
    const session = await new BrowserCaptureDriver({ ...options, workletModuleUrl: 'https://pet.invalid/build/recorder-worklet.js' }).open(new AbortController().signal);
    assert.equal(h.seen.moduleUrl, 'https://pet.invalid/build/recorder-worklet.js');
    session.stop(); assert.deepEqual(h.seen.trackStops, [1, 1]);
  } finally { h.restore(); }
});

test('browser capture samples at low frequency and returns up to three frames with whole audio',async()=>{
 let now=0,poll=()=>{},stops=0,clears=0,frame=0;
 let node:{port:{onmessage:((e:unknown)=>void)|null}};
 const tracks=[{stop(){stops++;}},{stop(){stops++;}}];
 const video={videoWidth:320,videoHeight:240,currentTime:0,srcObject:null,async play(){},pause(){}};
 const restores=[replace('performance',{now:()=>now}),replace('setInterval',(f:()=>void)=>{poll=f;return 1;}),replace('clearInterval',()=>{clears++;}),
  replace('navigator',{mediaDevices:{async getUserMedia(){return {getTracks:()=>tracks,getAudioTracks:()=>[tracks[0]],getVideoTracks:()=>[tracks[1]]};}}}),
  replace('AudioContext',class{state='running';sampleRate=24000;destination={};audioWorklet={async addModule(){}};async resume(){}async close(){this.state='closed';}createMediaStreamSource(){return {connect(){}};}createGain(){return {gain:{value:1},connect(){}};}}),
  replace('AudioWorkletNode',class{constructor(){node=this;}port={onmessage:null as ((e:unknown)=>void)|null,close(){},postMessage(){assert.ok(stops>=2,'tracks stop before asynchronous drain');node.port.onmessage?.({data:{samples:Float32Array.of(.2,.3,.4),finished:true}});}};connect(){queueMicrotask(()=>node.port.onmessage?.({data:{started:true}}));}disconnect(){}}),
  replace('document',{createElement(kind:string){return kind==='video'?video:{width:0,height:0,getContext(){return {drawImage(){}};},toBlob(cb:(b:Blob)=>void){cb(new Blob([Uint8Array.of(++frame)]));}};}})];
 try{
  const session=await new BrowserCaptureDriver(options).open(new AbortController().signal);
  for(let i=1;i<=120;i++){await tick();now=i*34;video.currentTime=now/1000;poll();}
  await tick();now+=34;
  const captured=await session.finish();assert.ok(captured.images.length<=3&&captured.images.length>=2);assert.equal(captured.audio.length,44+3*2);assert.ok(clears>=1);
  const ids=captured.images.map(x=>x.bytes[0]!);assert.equal(new Set(ids).size,captured.images.length);assert.deepEqual([...ids].sort((a,b)=>a-b),ids);
  assert.equal(frame,3,'only two background encodings plus one release encoding');
 }finally{restores.reverse().forEach(f=>f());}
});

test('the deployed recorder module averages channels, retains the final tail and finishes once', () => {
  type Recorder = { process(inputs: Float32Array[][]): boolean; port: { onmessage(event: { data: string }): void } };
  const messages: { samples?: Float32Array; finished?: boolean; started?:boolean }[] = [];
  let RecorderClass!: new () => Recorder;
  class ProcessorBase { port = { onmessage: null, postMessage(value: { samples?: Float32Array; finished?: boolean; started?:boolean }) { messages.push(value); } }; }
  runInNewContext(readFileSync(new URL('../../../media/recorder-worklet.mjs', import.meta.url), 'utf8'), {
    AudioWorkletProcessor: ProcessorBase, Float32Array,
    registerProcessor(name: string, ctor: new () => Recorder) { assert.equal(name, 'pet-recorder'); RecorderClass = ctor; },
  });
  const recorder = new RecorderClass();
  const block = () => [new Float32Array(1024).fill(1), new Float32Array(1024)];
  assert.equal(recorder.process([block()]), true); assert.equal(messages.length, 1);assert.equal(messages[0]?.started,true);
  recorder.process([block()]); recorder.process([[Float32Array.of(.5, .25, -.5)]]);
  recorder.port.onmessage({ data: 'finish' }); recorder.port.onmessage({ data: 'finish' });
  assert.equal(messages.length, 4);
  assert.equal(messages[1]?.samples?.length, 2048); assert.ok(messages[1]?.samples?.every(v => v === .5));
  assert.deepEqual(Array.from(messages[2]?.samples ?? []), [.5, .25, -.5]); assert.equal(messages[3]?.finished, true);
  assert.equal(recorder.process([block()]), false); assert.equal(messages.length, 4);
});

class FakeAudioContext {
  static latest: FakeAudioContext;
  static silent = false;
  currentTime = 1; baseLatency = .01; outputLatency = .01; state = 'running'; outputTime = .9;
  closes = 0; stops = 0;
  constructor() { FakeAudioContext.latest = this; }
  async decodeAudioData() {
    const samples = new Float32Array(24000); if (!FakeAudioContext.silent) samples[2400] = .1;
    return { length: samples.length, numberOfChannels: 1, sampleRate: 24000, duration: 1, getChannelData: () => samples };
  }
  getOutputTimestamp() { return { contextTime: this.outputTime, performanceTime: performance.now() }; }
  async resume() {}
  async close() { this.closes++; this.state = 'closed'; }
  createAnalyser() { return { fftSize: 256, connect() {}, getFloatTimeDomainData(data: Float32Array) { data.fill(.1); } }; }
  createBufferSource() { return { buffer: null, onended: null, connect() {}, disconnect() {}, start() {}, stop: () => { this.stops++; } }; }
  destination = {};
}
test('browser playback waits past leading silence for the output device timeline, not graph time', async () => {
  const restoreAudio = replace('AudioContext', FakeAudioContext); let poll!: () => void;
  const restoreTimer = replace('setInterval', (callback: () => void) => { poll = callback; return 1; });
  const restoreClear = replace('clearInterval', () => {}); const events: PlaybackSample[] = [];
  try {
    const session = await new BrowserPlaybackDriver().open(Uint8Array.of(1), 'sound', event => events.push(event), new AbortController().signal);
    const device = FakeAudioContext.latest; assert.equal(events.length, 0);
    device.currentTime = 100; device.outputTime = 1.05; poll(); assert.equal(events.length, 0);
    device.outputTime = 1.2; poll(); assert.equal(events[0]?.type, 'started');
    assert.equal(events[0]?.type === 'started' ? events[0].timingBasis : '', 'audio_output_timestamp');
    assert.equal(events.some(event => event.type === 'ended'), false);
    device.outputTime = 2.1; poll(); await session.done; assert.equal(events.at(-1)?.type, 'ended'); assert.equal(device.closes, 1);
  } finally { restoreAudio(); restoreTimer(); restoreClear(); }
});
test('browser playback silence and cancellation close output instead of inventing a start', async () => {
  const restoreAudio = replace('AudioContext', FakeAudioContext); const events: PlaybackSample[] = [];
  try {
    FakeAudioContext.silent = true;
    await assert.rejects(new BrowserPlaybackDriver().open(Uint8Array.of(1), 'silent', event => events.push(event), new AbortController().signal), /only silence/);
    assert.equal(FakeAudioContext.latest.closes, 1); assert.equal(events.length, 0);
    FakeAudioContext.silent = false;
    const controller = new AbortController(), session = await new BrowserPlaybackDriver().open(Uint8Array.of(1), 'cancelled', event => events.push(event), controller.signal);
    controller.abort(); await session.done; assert.equal(FakeAudioContext.latest.closes, 1); assert.equal(events.length, 0);
  } finally { FakeAudioContext.silent = false; restoreAudio(); }
});

test('aborting delayed decode or resume closes output immediately and late preparation cannot start a source',async()=>{
 for(const phase of ['decode','resume']){
  let release!:()=>void,starts=0;const gate=new Promise<void>(resolve=>{release=resolve;});
  class DelayedContext extends FakeAudioContext {
   override async decodeAudioData(){if(phase==='decode')await gate;return super.decodeAudioData();}
   override async resume(){if(phase==='resume')await gate;}
   override createBufferSource(){return {...super.createBufferSource(),start(){starts++;}};}
  }
  const restore=replace('AudioContext',DelayedContext),controller=new AbortController();
  try{
   const opening=new BrowserPlaybackDriver().open(Uint8Array.of(1),'cancelled-prepare',()=>{},controller.signal);
   const cancelled=assert.rejects(opening,{name:'AbortError'});await tick();controller.abort();
   assert.equal(FakeAudioContext.latest.closes,1,'stop is synchronous, independent of the preparation promise');
   release();await cancelled;await tick();assert.equal(starts,0);
  }finally{release();controller.abort();restore();}
 }
});
