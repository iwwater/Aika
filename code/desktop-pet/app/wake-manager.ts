import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, unlink, lstat } from 'node:fs/promises';
import { ManagementError } from '../contracts/management.js';
import { WAKE_VERSION, WAKE_DEFAULT_SETTINGS, type WakeSettings, type WakeSnapshot, type WakeManagement,
  type WakeDetector, type WakeToDesktop, type WakePhase } from '../contracts/wake.js';

export function validateWakeSettings(value: unknown): WakeSettings {
  const v = value as Partial<WakeSettings> | null;
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !['keyword','sensitivity','silenceMs'].includes(k))
    || typeof v.keyword !== 'string' || !/^[\u3400-\u9fff]{2,12}$/.test(v.keyword)
    || !['standard','sensitive','strict'].includes(v.sensitivity ?? '')
    || !Number.isInteger(v.silenceMs) || v.silenceMs! < 1000 || v.silenceMs! > 3000 || v.silenceMs! % 500)
    throw new ManagementError('invalid_request','请填写2至12个汉字的唤醒词，并选择有效灵敏度和停顿时长。');
  return { keyword: v.keyword, sensitivity: v.sensitivity!, silenceMs: v.silenceMs! };
}
interface Options {
  instanceId: string; file: string; available: boolean;
  createDetector(settings: WakeSettings): Promise<WakeDetector>;
  send(message: WakeToDesktop): void;
}
/** Only the authenticated, explicit session action opens a worker/microphone. No model calls or audio files. */
export class WakeManager implements WakeManagement {
  private settings: WakeSettings = { ...WAKE_DEFAULT_SETTINGS };
  private revision = 0;
  private generation = 0;
  private enabled = false;
  private phase: WakePhase = 'off';
  private detail: string | undefined;
  private echoCancellation: boolean | undefined;
  private detector: WakeDetector | undefined;
  private lastSequence = -1;
  private flight: object | undefined;
  private epoch = 0;
  private saving = false;
  private closed = false;
  private control = Promise.resolve();
  private lastPcm = 0;
  private hit: { generation: number; sequence: number; keyword: string; at: number } | undefined;
  private watchdog: ReturnType<typeof setInterval> | undefined;
  private constructor(private readonly options: Options) {}
  static async open(options: Options): Promise<WakeManager> {
    const manager = new WakeManager(options);
    try {
      const stat=await lstat(options.file);if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077))throw Error('Unsafe wake settings');
      const saved=JSON.parse(await readFile(options.file,'utf8'));
      if(saved.version!==WAKE_VERSION||!Number.isSafeInteger(saved.revision)||saved.revision<0)throw Error('Invalid wake settings');
      manager.settings=validateWakeSettings(saved.settings);manager.revision=saved.revision;
    } catch(error) { if((error as NodeJS.ErrnoException).code!=='ENOENT') throw error; }
    return manager;
  }
  snapshot(): WakeSnapshot {
    return {version:WAKE_VERSION,instanceId:this.options.instanceId,revision:this.revision,settings:{...this.settings},available:this.options.available,
      ...(!this.options.available?{detail:'本地唤醒模型尚未就绪，按键录音仍可使用。'}:{}),
      session:{generation:this.generation,enabled:this.enabled,phase:this.phase,...(this.detail?{detail:this.detail}:{}),
        ...(this.echoCancellation===undefined?{}:{echoCancellation:this.echoCancellation})}};
  }
  private current(instanceId: string, revision: number): void {
    if(this.closed)throw new ManagementError('unavailable','语音唤醒服务已关闭。');
    if(instanceId!==this.options.instanceId||revision!==this.revision||this.saving)throw new ManagementError('version_conflict','运行会话或设置已变化，请刷新后重试。');
  }
  async save(instanceId:string, expectedRevision:number, value:unknown):Promise<WakeSnapshot>{
    this.current(instanceId,expectedRevision);const settings=validateWakeSettings(value);this.saving=true;
    const tmp=this.options.file+'.'+randomUUID()+'.next';
    try {
      await this.stop(); // Saving a preference never enables/re-enables listening.
      await writeFile(tmp,JSON.stringify({version:WAKE_VERSION,revision:this.revision+1,settings})+'\n',{flag:'wx',mode:0o600});
      await rename(tmp,this.options.file);this.settings=settings;this.revision++;return this.snapshot();
    } finally { this.saving=false;await unlink(tmp).catch(e=>{if(e.code!=='ENOENT')throw e;}); }
  }
  async enable(instanceId:string,expectedRevision:number,expectedGeneration:number,enabled:boolean):Promise<WakeSnapshot>{
    this.current(instanceId,expectedRevision);
    if(!Number.isSafeInteger(expectedGeneration)||expectedGeneration!==this.generation||typeof enabled!=='boolean')throw new ManagementError('version_conflict','监听状态已变化，请刷新后重试。');
    if(!enabled){await this.stop();return this.snapshot();}
    if(!this.options.available)throw new ManagementError('unavailable','本地唤醒模型尚未就绪。');
    if(this.enabled)return this.snapshot();
    const generation=++this.generation;this.enabled=true;this.phase='connecting';this.detail=undefined;this.echoCancellation=undefined;
    this.lastSequence=-1;this.lastPcm=Date.now();
    try {
      const detector=await this.options.createDetector({...this.settings});
      if(this.closed||!this.enabled||this.generation!==generation){await detector.close();return this.snapshot();}
      this.detector=detector;
      this.options.send({channel:'wake_control',generation,enabled:true,settings:{...this.settings}});
      this.watchdog=setInterval(()=>{if(this.enabled&&this.phase!=='paused'&&Date.now()-this.lastPcm>(this.phase==='connecting'?60000:15000))void this.fail('麦克风或本地检测停止响应，监听已关闭。');},1000);this.watchdog.unref();
    } catch { if(this.enabled&&this.generation===generation)await this.fail('本地唤醒启动失败，请检查模型或重新开启。'); }
    return this.snapshot();
  }
  private async stop():Promise<void>{
    this.hit=undefined;
    this.enabled=false;this.phase='off';this.detail=undefined;this.echoCancellation=undefined;this.generation++;this.epoch++;this.flight=undefined;
    clearInterval(this.watchdog);this.watchdog=undefined;
    const detector=this.detector;this.detector=undefined;this.control=Promise.resolve();
    this.options.send({channel:'wake_control',generation:this.generation,enabled:false,settings:{...this.settings}});
    await detector?.close();
  }
  private async fail(detail:string):Promise<void>{
    const expectedGeneration=this.generation+1;await this.stop();
    if(this.generation!==expectedGeneration||this.enabled||this.closed)return;
    this.phase='error';this.detail=detail;
    this.options.send({channel:'wake_error',generation:this.generation,detail});
  }
  /** Returns true for owned wake messages, including stale packets which are discarded without decoding. */
  consumeHit(value: unknown): string | undefined {
    const v=value as {generation?:unknown;sequence?:unknown}|null, hit=this.hit;
    if(!v||!hit||!this.enabled||this.closed||hit.generation!==this.generation||v.generation!==hit.generation||v.sequence!==hit.sequence||Date.now()-hit.at>5000)return;
    this.hit=undefined;return hit.keyword;
  }
  receive(value:unknown):boolean {
    if(!value||typeof value!=='object')return false;
    const v=value as Record<string,unknown>;
    if(v.channel!=='wake_pcm'&&v.channel!=='wake_status')return false;
    if(!this.enabled||this.closed||v.generation!==this.generation||!this.detector)return true;
    if(v.channel==='wake_status'){
      const phase=v.phase as WakePhase;
      if(!['connecting','waiting','listening','submitting','replying','paused','error','off'].includes(phase))return true;
      if(phase==='error'||phase==='off'){void this.fail(phase==='error'?'本地唤醒或回声消除不可用，监听已关闭，按键录音仍可使用。':'监听已结束，请手动重新开启。');return true;}
      if(v.echoCancellation!==undefined)this.echoCancellation=v.echoCancellation===true;
      if(['waiting','listening'].includes(phase)&&this.echoCancellation!==true){void this.fail('当前麦克风未提供回声消除，语音唤醒未开启；按键录音仍可使用。');return true;}
      if(phase!==this.phase){
        const previous=this.phase;this.phase=phase;
        const detector=this.detector;
        if(phase==='paused'){this.hit=undefined;this.epoch++;this.flight=undefined;this.control=this.control.then(()=>detector.reset());}
        else if(phase==='listening')this.control=this.control.then(()=>detector.setCapturing(true));
        else if(previous==='listening')this.control=this.control.then(()=>detector.setCapturing(false));
        this.control.catch(()=>{if(this.detector===detector&&this.enabled)void this.fail('本地检测状态重置失败，监听已关闭。');});
      }
      this.lastPcm=Date.now();return true;
    }
    if(this.phase==='paused')return true;
    if(!Number.isSafeInteger(v.sequence)||(v.sequence as number)<=this.lastSequence)return true;
    if(this.flight){void this.fail('本地音频处理来不及接收，监听已关闭；请重新开启。');return true;}
    if(typeof v.pcm16Base64!=='string'||v.pcm16Base64.length<4||v.pcm16Base64.length>8536||v.pcm16Base64.length%4||!/^[A-Za-z0-9+/]*={0,2}$/.test(v.pcm16Base64)){
      void this.fail('本地音频格式无效，监听已关闭。');return true;
    }
    const bytes=Buffer.from(v.pcm16Base64,'base64');
    if(!bytes.length||bytes.length%2||bytes.length>6400){bytes.fill(0);void this.fail('本地音频格式无效，监听已关闭。');return true;}
    const samples=new Float32Array(bytes.length/2);for(let n=0;n<samples.length;n++)samples[n]=bytes.readInt16LE(n*2)/32768;bytes.fill(0);
    const marker={},epoch=this.epoch,generation=this.generation,sequence=v.sequence as number,detector=this.detector,count=samples.length;
    this.lastSequence=sequence;this.lastPcm=Date.now();this.flight=marker;
    void this.control.then(()=>{
      if(this.epoch!==epoch||this.detector!==detector) return;
      return detector.accept(samples);
    }).then(result=>{
      if(result&&this.enabled&&this.generation===generation&&this.epoch===epoch&&this.flight===marker){
        // Release the credit before delivering its ack, including in-process transports.
        this.flight=undefined;
        if(result.keyword===this.settings.keyword&&['waiting','replying'].includes(this.phase))this.hit={generation,sequence,keyword:result.keyword,at:Date.now()};
        this.options.send({channel:'wake_result',generation,sequence,samples:count,speech:result.speech===true,
          ...(result.keyword===this.settings.keyword?{keyword:result.keyword}:{})});
      }
    }).catch(()=>{if(this.enabled&&this.generation===generation&&this.epoch===epoch)void this.fail('本地唤醒检测失败，监听已关闭。');})
      .finally(()=>{if(samples.byteLength)samples.fill(0);if(this.flight===marker)this.flight=undefined;});
    return true;
  }
  async close():Promise<void>{if(this.closed)return;this.closed=true;await this.stop();}
}
