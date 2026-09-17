/** Local wake transport/clip ownership. Never persists or logs PCM. Device driver is injected. */
export class WakeController {
 constructor({createCapture,send,onState=()=>{},onLevel=()=>{},onWake,onFinish,onCancel=()=>{}}){Object.assign(this,{createCapture,send,onState,onLevel,onWake,onFinish,onCancel});this.generation=-1;this.sequence=0;this.run=0;this.enabled=false;this.phase='off';this.manual=false;this.playing=false;this.queue=[];this.queued=0;}
 state(phase,detail){const changed=this.phase!==phase;this.phase=phase;const value={generation:this.generation,enabled:this.enabled,phase,...(this.echoCancellation===undefined?{}:{echoCancellation:this.echoCancellation}),...(detail?{detail}:{})};this.onState(value);if(changed||detail||this.sentGeneration!==this.generation){this.sentGeneration=this.generation;this.send({channel:'wake_status',generation:this.generation,phase,...(this.echoCancellation===undefined?{}:{echoCancellation:this.echoCancellation}),...(detail?{detail}:{})});}}
 control(message){
  if(!Number.isSafeInteger(message.generation)||message.generation<=this.generation||typeof message.enabled!=='boolean')return;
  this.clear(true);this.generation=message.generation;this.settings={...message.settings};this.enabled=message.enabled;this.echoCancellation=undefined;
  if(!this.enabled){this.state('off');return;}
  const s=this.settings;if(!s||typeof s.keyword!=='string'||!/^\p{Script=Han}{2,12}$/u.test(s.keyword)||!['standard','sensitive','strict'].includes(s.sensitivity)||!Number.isInteger(s.silenceMs)||s.silenceMs<1000||s.silenceMs>3000||s.silenceMs%500!==0){this.fail();return;}
  if(this.manual)this.state('paused');else void this.open();
 }
 async open(){
  if(!this.enabled||this.manual||this.driver||this.opening)return;
  const run=++this.run,controller=new AbortController();this.abort=controller;this.opening=true;this.state('connecting');
  try{const driver=await this.createCapture({onPCM:samples=>this.pcm(run,samples),onLevel:level=>{if(this.current(run))this.onLevel(level);},onError:()=>{if(this.current(run))this.fail();}});
   if(!this.current(run)){driver.close();return;}this.driver=driver;
   const result=await driver.open(controller.signal);if(!this.current(run)){driver.close();return;}
   if(result?.echoCancellation!==true)throw Error('Echo cancellation not active');this.echoCancellation=true;
   // The driver resolves only after actual PCM. Do not infer readiness from a request acknowledgement.
   this.opening=false;this.state(this.clip?'listening':'waiting');this.flush();
  }catch(e){if(this.current(run))this.fail();}finally{if(run===this.run)this.opening=false;}
 }
 current(run){return run===this.run&&this.enabled&&!this.manual;}
 pcm(run,samples){
  if(!this.current(run)){samples?.fill?.(0);return;}
  if(!(samples instanceof Float32Array)||samples.length===0||samples.length>3200||samples.some(v=>!Number.isFinite(v))){samples?.fill?.(0);this.fail();return;}
  if(this.queued+samples.length>16000){samples.fill(0);this.fail('本地唤醒处理跟不上输入，监听已停止。请重新开启。');return;}
  this.queue.push(samples);this.queued+=samples.length;this.flush();
 }
 flush(){
  if(!this.enabled||this.manual||this.opening||this.inflight||!this.queue.length)return;
  const samples=this.queue.shift();this.queued-=samples.length;const bytes=new Uint8Array(samples.length*2),data=new DataView(bytes.buffer);
  for(let i=0;i<samples.length;i++)data.setInt16(i*2,Math.max(-32768,Math.min(32767,Math.round(samples[i]*32768))),true);
  const sequence=++this.sequence;this.inflight={sequence,samples:samples.length,run:this.run};samples.fill(0);
  let text='';for(const byte of bytes)text+=String.fromCharCode(byte);bytes.fill(0);
  this.send({channel:'wake_pcm',generation:this.generation,sequence,pcm16Base64:btoa(text)});
 }
 result(message){
  const frame=this.inflight;if(!this.enabled||this.manual||message.generation!==this.generation||!frame||frame.sequence!==message.sequence||frame.run!==this.run)return;
  this.inflight=null;
  if(message.samples!==frame.samples||typeof message.speech!=='boolean'){this.fail();return;}
  if(!this.clip&&['waiting','replying'].includes(this.phase)&&message.keyword===this.settings.keyword){
   try{const session=this.driver.beginCapture();this.clip={session,run:this.run,ready:false,silence:0,finished:false};this.state('listening');this.onWake({generation:message.generation,sequence:message.sequence});}catch{this.fail();return;}
  }else if(this.clip&&!this.clip.finished){
   this.clip.silence=message.speech?0:this.clip.silence+frame.samples/16;
   this.maybeFinish();
  }
  this.flush();
 }
 maybeFinish(){const clip=this.clip;if(!clip||clip.finished||!clip.ready||clip.silence<this.settings.silenceMs)return;clip.finished=true;this.state('submitting');this.onFinish();}
 /** The original backend capture_start takes the already-running, prebuffered clip. */
 takeCapture(){
  const clip=this.clip;if(!clip||clip.taken||clip.run!==this.run)throw Error('No pending wake clip');clip.taken=true;this.driver.authorizeCaptureCamera();
  return {finish:async()=>{const value=await clip.session.finish();if(this.clip!==clip||clip.run!==this.run){value.audio.fill(0);value.images.forEach(i=>i.bytes.fill(0));throw Error('Wake clip expired');}this.clip=null;this.state('replying');return value;},stop:()=>{clip.session.stop();if(this.clip===clip){this.clip=null;if(this.enabled&&!this.manual)this.state('waiting');}}};
 }
 captureReady(){if(this.clip){this.clip.ready=true;this.maybeFinish();}}
 get pendingCapture(){return !!this.clip&&!this.clip.taken;}
 observe({busy,playing}){this.playing=playing;if(this.manual&&!busy&&!playing){this.manual=false;if(this.enabled)void this.open();}else if(this.enabled&&!this.manual&&!this.clip&&this.phase==='replying'&&!busy&&!playing)this.state('waiting');}
 pause(){this.manual=true;this.clear(false);if(this.enabled)this.state('paused');}
 clear(cancel){const hadClip=!!this.clip;++this.run;this.abort?.abort();this.abort=null;this.driver?.close();this.driver=null;this.opening=false;this.clip?.session.stop();this.clip=null;this.queue.forEach(s=>s.fill(0));this.queue=[];this.queued=0;this.inflight=null;if(cancel&&hadClip)this.onCancel();}
 fail(detail='本地唤醒已停止，请检查麦克风和本地模块后重新开启。'){this.enabled=false;this.clear(true);this.state('error',detail);}
 error(message){if(message.generation===this.generation)this.fail();}
 disconnect(){this.enabled=false;this.manual=false;this.clear(true);this.generation=-1;this.echoCancellation=undefined;this.phase='off';this.onState({generation:-1,enabled:false,phase:'off'});}
}
