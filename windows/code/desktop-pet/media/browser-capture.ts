import type { CaptureDriver, CaptureSession, CapturedBytes } from './capture.js';
import { abortable, abortError, checkAbort } from './scope.js';
import { pcm16Wav } from './wav.js';
import { CaptureError, captureFailure } from './capture-errors.js';
import type { DeviceFailure } from '../contracts/desktop-bridge.js';
import { TemporalFrames } from './temporal-frames.js';

export interface CaptureDiagnostic {
  readonly phase:'microphone_request'|'microphone_granted'|'context_created'|'graph_connected'|'first_nonzero_pcm'|'worklet_ready'|'audio_resumed'|'first_pcm'|'audio_ready'|'camera_ready'|'camera_unavailable'|'stopped'|'audio_flushed';
  readonly elapsedMs:number;
  readonly firstBlockSampleCount:number;
  readonly flushedSampleCount:number;
  /** Exact leading zero mono samples observed so far. Not a silence threshold or speech detector. */
  readonly leadingZeroSampleCount?:number;
  readonly nonzeroObserved:boolean;
  readonly sampleRate?:number;
  /** Actual track setting only. Missing means unknown, never assumed false. */
  readonly echoCancellation?:boolean;
}
/** Ephemeral scalar envelope of the mono PCM already being recorded. */
export interface CaptureLevel { readonly rms:number; readonly peak:number; }
export interface BrowserCaptureOptions {
  readonly workletModuleUrl?: string | URL;
  readonly cameraWidth: number;
  readonly jpegQuality: number;
  readonly maxBufferedSamples: number;
  /** Local timing/counts only; never samples, images, transcript or device identifiers. */
  readonly onDiagnostic?: (event:CaptureDiagnostic)=>void;
  /** First real PCM (including zero), then about20Hz. Never after finish/stop/abort. No samples or persistence. */
  readonly onLevel?: (event:CaptureLevel)=>void;
  /**
   * FIX61-08 live leg: receives every mono block the worklet flushes, in recording order and before
   * finish, so 100 ms framing and the ASR bridge happen while the user is still speaking. The sink
   * must not retain the array; the driver keeps ownership of its own copy for the WAV.
   */
  readonly voiceSink?: (block:Float32Array)=>void;
  /** Reported once when the live sink stops accepting audio (backpressure or failure). */
  readonly onVoiceSinkError?: (error:unknown)=>void;
}

/** Devices are acquired only for this explicit voice turn, never during idle/text input. */
export class BrowserCaptureDriver implements CaptureDriver {
  constructor(private readonly options: BrowserCaptureOptions) {
    if (!Number.isFinite(options.cameraWidth) || options.cameraWidth <= 0 || options.jpegQuality <= 0 || options.jpegQuality > 1 || !Number.isInteger(options.maxBufferedSamples) || options.maxBufferedSamples <= 0) throw new Error('Explicit valid capture options required');
  }
  async open(signal: AbortSignal): Promise<CaptureSession> {
    checkAbort(signal);
    const startedAt=performance.now();
    let microphone:MediaStream|undefined,camera:MediaStream|undefined,context:AudioContext|undefined,recorder:AudioWorkletNode|undefined,video:HTMLVideoElement|undefined;
    let stopped=false,finishing=false,acceptFrames=true,samples=0,firstBlockSampleCount=0,failure:Error|undefined,firstPCM=false;
    let leadingZeroSampleCount:number|undefined,nonzeroObserved=false;
    let echoCancellation:boolean|undefined;
    const frames=new TemporalFrames(),blocks:Float32Array[]=[];
    let frameTimer:ReturnType<typeof setInterval>|undefined,pendingFrame=false,frameCanvas:HTMLCanvasElement|undefined,captureLastFrame:(()=>void)|undefined;
    let stage:DeviceFailure['stage']='get_user_media';
    let settleFlush:(()=>void)|undefined,rejectFlush:((error:Error)=>void)|undefined;
    let settleReady!:()=>void;
    const pcmReady=new Promise<void>(resolve=>{settleReady=resolve;});
    const diagnostic=(phase:CaptureDiagnostic['phase'])=>{try{this.options.onDiagnostic?.({phase,elapsedMs:Math.max(0,performance.now()-startedAt),firstBlockSampleCount,flushedSampleCount:samples,nonzeroObserved,
      ...(echoCancellation===undefined?{}:{echoCancellation}),...(leadingZeroSampleCount===undefined?{}:{leadingZeroSampleCount}),...(context&&Number.isFinite(context.sampleRate)&&context.sampleRate>0?{sampleRate:context.sampleRate}:{})});}catch{}};
    const stopTracks=()=>{microphone?.getTracks().forEach(t=>t.stop());microphone=undefined;camera?.getTracks().forEach(t=>t.stop());camera=undefined;};
    const stop=()=>{
      if(stopped)return;stopped=true;if(!finishing)diagnostic('stopped');acceptFrames=false;stopTracks();clearInterval(frameTimer);frames.clear();
      if(frameCanvas){frameCanvas.width=0;frameCanvas.height=0;}
      rejectFlush?.(abortError());settleReady();
      if(recorder){recorder.port.onmessage=null;recorder.port.close();recorder.disconnect();}
      if(video){video.pause();video.srcObject=null;}
      if(context&&context.state!=='closed')void context.close().catch(()=>{});
      blocks.forEach(b=>b.fill(0));blocks.length=0;signal.removeEventListener('abort',stop);
    };
    signal.addEventListener('abort',stop,{once:true});
    // Camera acquisition, preview and JPEG encoding are never awaited by audio open/finish.
    const startCamera=async()=>{
      try{
        const stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{width:{ideal:this.options.cameraWidth}}});
        if(stopped||finishing||signal.aborted){stream.getTracks().forEach(t=>t.stop());return;}
        camera=stream;if(!stream.getVideoTracks().length)throw Error('Camera track unavailable');
        video=document.createElement('video');video.muted=true;video.playsInline=true;video.srcObject=stream;
        await abortable(video.play(),signal);
        if(stopped||finishing)return;diagnostic('camera_ready');
        const preview=video;let lastTime=-1;
        const sample=(final=false)=>{
          const atMs=performance.now()-startedAt;
          if(stopped||(finishing&&!final)||pendingFrame||preview.currentTime===lastTime||!frames.due(atMs,final)||!preview.videoWidth||!preview.videoHeight)return;
          try{
            const canvas=frameCanvas??=document.createElement('canvas');canvas.width=Math.min(preview.videoWidth,this.options.cameraWidth);canvas.height=Math.max(1,Math.round(preview.videoHeight*canvas.width/preview.videoWidth));
            const paint=canvas.getContext('2d');if(!paint)throw Error('Camera canvas unavailable');
            if(!frames.reserve(atMs,final))return;lastTime=preview.currentTime;pendingFrame=true;paint.drawImage(preview,0,0,canvas.width,canvas.height);
            // Reserve the low-frequency slot before encoding; never spin on a failing frame.
            new Promise<Blob>((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(Error('Camera encoding failed')),'image/jpeg',this.options.jpegQuality))
              .then(async blob=>{const bytes=new Uint8Array(await blob.arrayBuffer());if(stopped||!acceptFrames)bytes.fill(0);else frames.add(atMs,bytes);})
              .catch(()=>{if(!stopped&&!finishing)diagnostic('camera_unavailable');})
              .finally(()=>{pendingFrame=false;});
          }catch{pendingFrame=false;clearInterval(frameTimer);camera?.getTracks().forEach(t=>t.stop());diagnostic('camera_unavailable');}
        };
        captureLastFrame=()=>sample(true);frameTimer=setInterval(sample,1000);sample();
      }catch{
        camera?.getTracks().forEach(t=>t.stop());if(video){video.pause();video.srcObject=null;}
        if(!stopped&&!finishing)diagnostic('camera_unavailable');
      }
    };
    try{
      diagnostic('microphone_request');
      const pendingMicrophone=navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false},video:false}).then(stream=>{
        if(stopped||signal.aborted){stream.getTracks().forEach(t=>t.stop());throw abortError();}
        microphone=stream;
        // Read only the actual boolean; optional diagnostics must never fail capture.
        try{const actual=stream.getAudioTracks()[0]?.getSettings?.().echoCancellation;if(typeof actual==='boolean')echoCancellation=actual;}catch{}
        diagnostic('microphone_granted');
        if(!stream.getAudioTracks().length)throw new CaptureError({code:'device_unavailable',stage:'get_user_media'});
        return stream;
      }).catch(error=>{throw captureFailure(error,'get_user_media',signal);});
      // A synchronous context-construction failure must still observe the pending device request.
      void pendingMicrophone.catch(()=>{});
      stage='unknown';context=new AudioContext();diagnostic('context_created');
      const audio=context;
      const prepareRecorder=async()=>{
        try{
          await audio.audioWorklet.addModule(this.options.workletModuleUrl??new URL('./recorder-worklet.mjs',import.meta.url));
          checkAbort(signal);if(stopped)throw abortError();diagnostic('worklet_ready');
          recorder=new AudioWorkletNode(audio,'pet-recorder',{processorOptions:{captureLevels:!!this.options.onLevel}});
          recorder.port.onmessage=(event:MessageEvent<{samples?:Float32Array;started?:boolean;sampleCount?:number;finished?:boolean;firstNonzero?:boolean;leadingZeroSampleCount?:number|null;nonzeroObserved?:boolean;level?:CaptureLevel}>)=>{
            if(stopped){event.data.samples?.fill(0);return;}
            if(event.data.leadingZeroSampleCount===null)leadingZeroSampleCount=undefined;
            if(Number.isSafeInteger(event.data.leadingZeroSampleCount)&&event.data.leadingZeroSampleCount!>=0&&event.data.leadingZeroSampleCount!<=this.options.maxBufferedSamples)leadingZeroSampleCount=event.data.leadingZeroSampleCount!;
            if(event.data.started&&!firstPCM){firstPCM=true;firstBlockSampleCount=event.data.sampleCount??0;diagnostic('first_pcm');settleReady();}
            if(event.data.firstNonzero&&!nonzeroObserved){nonzeroObserved=true;diagnostic('first_nonzero_pcm');}
            if(event.data.samples){
              samples+=event.data.samples.length;
              if(samples>this.options.maxBufferedSamples){event.data.samples.fill(0);failure=new CaptureError({code:'capture_finish_failed',stage:'capture_finish'});stop();return;}
              // Live leg first: the same mono PCM the WAV copy uses, never a second capture.
              // Forwarding stays on through the finish drain so the tail frame is never lost, and stops
              // with acceptFrames as soon as the flush completes or the turn is stopped.
              if(this.options.voiceSink&&acceptFrames&&!stopped){
                try{this.options.voiceSink(event.data.samples);}catch(error){this.options.onVoiceSinkError?.(error);}
              }
              blocks.push(event.data.samples);
            }
            const level=event.data.level;
            if(level&&!finishing&&!stopped&&!signal.aborted&&Number.isFinite(level.rms)&&Number.isFinite(level.peak)&&level.rms>=0&&level.rms<=1&&level.peak>=level.rms&&level.peak<=1){
              try{this.options.onLevel?.({rms:level.rms,peak:level.peak});}catch{/* Display callbacks never interrupt recording. */}
            }
            if(event.data.finished)settleFlush?.();
          };
          recorder.onprocessorerror=()=>{failure=new CaptureError({code:'capture_finish_failed',stage:'capture_finish'});stop();};
          const mute=audio.createGain();mute.gain.value=0;
          recorder.connect(mute);mute.connect(audio.destination);
        }catch(error){throw captureFailure(error,'audio_worklet',signal);}
      };
      const resumeAudio=async()=>{
        try{
          await audio.resume();checkAbort(signal);if(stopped)throw abortError();diagnostic('audio_resumed');
        }catch(error){throw captureFailure(error,'audio_resume',signal);}
      };
      // Only this explicitly authorized voice turn starts these independent operations.
      // No idle context, stream or sample cache; OS permission remains unavoidable.
      const connected=Promise.all([pendingMicrophone,prepareRecorder()]).then(([stream])=>{
        checkAbort(signal);if(stopped)throw abortError();
        audio.createMediaStreamSource(stream).connect(recorder!);diagnostic('graph_connected');
      });
      await abortable(Promise.all([connected,resumeAudio()]),signal);checkAbort(signal);
      await abortable(pcmReady,signal);checkAbort(signal);if(stopped)throw failure??abortError();diagnostic('audio_ready');void startCamera();
      const audioContext=context,node=recorder!;
      return {stop,finish:async():Promise<CapturedBytes>=>{
        if(failure)throw failure;if(stopped||finishing)throw Error('Capture already stopped');
        finishing=true;clearInterval(frameTimer);stopTracks();const captureStoppedAt=new Date().toISOString();diagnostic('stopped');
        // Use only the existing ready video image. Encoding races audio drain, never delays it.
        captureLastFrame?.();let selected:ReturnType<TemporalFrames['take']>=[];
        try{
          const flushed=new Promise<void>((resolve,reject)=>{settleFlush=resolve;rejectFlush=reject;});node.port.postMessage('finish');
          await abortable(flushed,signal);checkAbort(signal);if(failure)throw failure;diagnostic('audio_flushed');acceptFrames=false;selected=frames.take();
          const pcm=new Float32Array(samples);let offset=0;for(const block of blocks){pcm.set(block,offset);offset+=block.length;}
          const audio=pcm16Wav(pcm,audioContext.sampleRate);pcm.fill(0);
          return {audio,images:selected.map(frame=>({bytes:frame.bytes,mimeType:'image/jpeg'})),captureStoppedAt};
        }catch(error){selected.forEach(f=>f.bytes.fill(0));throw captureFailure(error,'capture_finish',signal);}finally{stop();}
      }};
    }catch(error){stop();throw captureFailure(error,stage,signal);}
  }
}
