import { restrictPrivatePathSync } from '../core/platform-files.js';
import { randomUUID } from 'node:crypto';
import { open, unlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { RegisteredVoiceStore } from '../providers/registered-voices.js';
import { MINIMAX_TTS_ENDPOINT } from '../providers/minimax-tts.js';
import { VoiceEnrollment, EnrollmentError, enrollmentCost, validateEnrollmentBinding, type EnrollmentBinding, type EnrollmentModel, type EnrollmentReceipt } from '../providers/voice-enrollment.js';
import { VoiceReferenceStore, privateDirectory, privateJson, privateRead, referenceId, requireLive, sha256 } from './voice-reference-store.js';

export type VoiceSetupPhase = 'prepared' | 'cloning' | 'clone_ready' | 'activating' | 'registered' | 'failed' | 'unknown' | 'cancelled';
export interface VoiceSetupOperation extends EnrollmentBinding {
  operationId: string; revision: number; phase: VoiceSetupPhase; referenceId: string; label: string; configRevision: number; voiceId: string; text: string;
  cloneUpperBoundMicros: number; activationUpperBoundMicros: number; createdAt: string; updatedAt: string;
  errorCode: string | null; retryAvailable?: boolean; demoAvailable: boolean; activationAvailable: boolean; cloneReceipt: EnrollmentReceipt | null; activationReceipt: EnrollmentReceipt | null;
}
export interface VoiceSetupOptions {
  directory: string; references: VoiceReferenceStore; registry: RegisteredVoiceStore; enrollment: VoiceEnrollment;
  isCurrent: (binding: EnrollmentBinding, configRevision: number) => boolean | Promise<boolean>;
}
export class VoiceSetupError extends Error {
  constructor(readonly code: 'invalid_request' | 'version_conflict' | 'configuration_changed' | 'confirmation_required' | 'operation_unavailable' | 'invalid_operation') { super(code); }
}
const phases: VoiceSetupPhase[]=['prepared','cloning','clone_ready','activating','registered','failed','unknown','cancelled'];
const clone = <T>(value:T):T => structuredClone(value);
function safeReceipt(value: EnrollmentReceipt|null): void {
  if(value===null)return;
  if(!value||typeof value!=='object'||Object.keys(value).sort().join()!==['voiceId','requestId','characters','actualMicros'].sort().join()
    || !/^[A-Za-z][A-Za-z0-9_-]{7,127}$/.test(value.voiceId)
    || (value.requestId!==null&&(typeof value.requestId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(value.requestId)))
    || (value.characters!==null&&(!Number.isSafeInteger(value.characters)||value.characters<0))
    || (value.actualMicros!==null&&(!Number.isSafeInteger(value.actualMicros)||value.actualMicros<0)))throw new VoiceSetupError('invalid_operation');
}
/** Durable single-backend workflow. Entering a cloud stage is saved before network access.
 * Interrupted/unknown stages cannot be retried; no UI supplied voice ID is ever accepted. */
export class VoiceSetupService {
  private closed = false;
  private closing: Promise<void> | undefined;
  private readonly lifetime = new AbortController();
  private readonly active = new Map<string,{controller:AbortController;done:Promise<VoiceSetupOperation>}>();
  private constructor(private readonly options:VoiceSetupOptions){}
  static async open(options:VoiceSetupOptions):Promise<VoiceSetupService>{
    const directory=await privateDirectory(options.directory);return new VoiceSetupService({...options,directory});
  }
  private file(id:string):string{referenceId(id);return join(this.options.directory,id+'.json');}
  private async save(op:VoiceSetupOperation):Promise<void>{op.updatedAt=new Date().toISOString();await privateJson(this.file(op.operationId),op);}
  private async read(id:string):Promise<VoiceSetupOperation>{
    await privateDirectory(this.options.directory);
    let op:VoiceSetupOperation;
    try { op=JSON.parse((await privateRead(this.file(id),16384)).toString()); } catch {throw new VoiceSetupError('invalid_operation');}
    const keys=['operationId','revision','phase','referenceId','label','targetModel','credentialRef','endpoint','configRevision','voiceId','text','cloneUpperBoundMicros','activationUpperBoundMicros','createdAt','updatedAt','errorCode','demoAvailable','activationAvailable','cloneReceipt','activationReceipt'];
    if(!op||Object.keys(op).filter(key=>key!=='retryAvailable').sort().join()!==keys.sort().join()||op.operationId!==id||!Number.isSafeInteger(op.revision)||op.revision<1||!phases.includes(op.phase)
      ||!Number.isSafeInteger(op.configRevision)||op.configRevision<0||typeof op.label!=='string'||!op.label.trim()||op.label.length>120||/[\u0000-\u001f\u007f]/.test(op.label)
      ||typeof op.text!=='string'||!op.text.trim()||[...op.text].length>1000||!/^Voice[a-f0-9]{32}$/.test(op.voiceId)
      ||typeof op.demoAvailable!=='boolean'||typeof op.activationAvailable!=='boolean'||(op.errorCode!==null&&!/^[a-z_]{1,64}$/.test(op.errorCode))
      ||!Number.isFinite(Date.parse(op.createdAt))||!Number.isFinite(Date.parse(op.updatedAt)))throw new VoiceSetupError('invalid_operation');
    if(op.retryAvailable!==undefined&&typeof op.retryAvailable!=='boolean')throw new VoiceSetupError('invalid_operation');
    op.retryAvailable ??= false;
    if(op.retryAvailable&&(op.phase!=='failed'||op.errorCode!=='provider_not_enabled'))throw new VoiceSetupError('invalid_operation');
    referenceId(op.referenceId);validateEnrollmentBinding(op);
    if(op.cloneUpperBoundMicros!==enrollmentCost(op.targetModel,op.text)||op.activationUpperBoundMicros!==enrollmentCost(op.targetModel,op.text,true))throw new VoiceSetupError('invalid_operation');
    safeReceipt(op.cloneReceipt);safeReceipt(op.activationReceipt);
    if((op.cloneReceipt&&op.cloneReceipt.voiceId!==op.voiceId)||(op.activationReceipt&&op.activationReceipt.voiceId!==op.voiceId)
      ||(['clone_ready','activating','registered'].includes(op.phase)&&!op.cloneReceipt)||(op.phase==='registered'&&!op.activationReceipt))throw new VoiceSetupError('invalid_operation');
    return op;
  }
  async get(id:string):Promise<VoiceSetupOperation>{
    const op=await this.read(id);
    // Read-only recovery projection; never assume an interrupted stage is safe to replay.
    if(!this.active.has(id)&&['cloning','activating'].includes(op.phase)){op.phase='unknown';op.errorCode='interrupted';}
    return clone(op);
  }
  async list():Promise<VoiceSetupOperation[]>{
    return Promise.all((await readdir(this.options.directory)).filter(f=>/^[a-f0-9]{32}\.json$/.test(f)).map(f=>this.get(f.slice(0,-5))));
  }
  async prepare(input:{referenceId:string;label:string;targetModel:EnrollmentModel;credentialRef:string;configRevision:number;text:string},signal:AbortSignal):Promise<VoiceSetupOperation>{
    if(this.closed)throw new VoiceSetupError('operation_unavailable');
    signal=AbortSignal.any([signal,this.lifetime.signal]);requireLive(signal);
    if(!input||Object.keys(input).sort().join()!==['referenceId','label','targetModel','credentialRef','configRevision','text'].sort().join()
      ||typeof input.label!=='string'||!input.label.trim()||input.label.length>120||/[\u0000-\u001f\u007f]/.test(input.label)
      ||!Number.isSafeInteger(input.configRevision)||input.configRevision<0||typeof input.text!=='string')throw new VoiceSetupError('invalid_request');
    const binding:EnrollmentBinding={targetModel:input.targetModel,credentialRef:input.credentialRef,endpoint:MINIMAX_TTS_ENDPOINT};
    validateEnrollmentBinding(binding);const upper=enrollmentCost(input.targetModel,input.text);
    if(!await this.options.isCurrent(binding,input.configRevision))throw new VoiceSetupError('configuration_changed');
    await this.options.references.get(input.referenceId);requireLive(signal);
    const now=new Date().toISOString(), op:VoiceSetupOperation={...binding,operationId:sha256(JSON.stringify([input.referenceId,input.label.trim(),input.targetModel,input.credentialRef,input.configRevision,input.text,binding.endpoint])).slice(0,32),revision:1,phase:'prepared',referenceId:input.referenceId,
      label:input.label.trim(),configRevision:input.configRevision,voiceId:'Voice'+randomUUID().replaceAll('-',''),text:input.text,
      cloneUpperBoundMicros:upper,activationUpperBoundMicros:upper+9900000,createdAt:now,updatedAt:now,errorCode:null,retryAvailable:false,demoAvailable:false,activationAvailable:false,cloneReceipt:null,activationReceipt:null};
    return this.locked(op.operationId,async()=>{
      try{return await this.get(op.operationId);}catch(error){
        try{await privateRead(this.file(op.operationId),16384);}catch(readError){if((readError as NodeJS.ErrnoException).code==='ENOENT'){requireLive(signal);await this.save(op);return clone(op);}}
        throw error;
      }
    });
  }
  confirm(input:{operationId:string;expectedRevision:number;costConsent:boolean},signal:AbortSignal):Promise<VoiceSetupOperation>{
    if(this.closed)return Promise.reject(new VoiceSetupError('operation_unavailable'));
    if(!input||input.costConsent!==true)return Promise.reject(new VoiceSetupError('confirmation_required'));
    if(Object.keys(input).sort().join()!==['operationId','expectedRevision','costConsent'].sort().join()||!Number.isSafeInteger(input.expectedRevision))return Promise.reject(new VoiceSetupError('invalid_request'));
    if(this.active.has(input.operationId))return Promise.reject(new VoiceSetupError('operation_unavailable'));
    const controller=new AbortController(), combined=AbortSignal.any([signal,controller.signal,this.lifetime.signal]);
    const done=this.run(input,combined).finally(()=>this.active.delete(input.operationId));
    this.active.set(input.operationId,{controller,done});return done;
  }
  private async locked<T>(id:string,action:()=>Promise<T>):Promise<T>{
    const path=this.file(id)+'.lock';await privateDirectory(this.options.directory);
    let lock;
    try{lock=await open(path,'wx',0o600);}catch{throw new VoiceSetupError('operation_unavailable');}
    try{return await action();}finally{await lock.close();await unlink(path);}
  }
  private async sampleWrite(id:string,kind:'demo'|'activation',bytes:Uint8Array):Promise<void>{
    const file=join(this.options.directory,id+'-'+kind+'.audio'),h=await open(file,'wx',0o600);
    try{restrictPrivatePathSync(file);await h.writeFile(bytes);await h.sync();}finally{await h.close();}
  }
  private async run(input:{operationId:string;expectedRevision:number},signal:AbortSignal):Promise<VoiceSetupOperation>{
    return this.locked(input.operationId,async()=>{
      requireLive(signal);const op=await this.read(input.operationId);
      if(op.revision!==input.expectedRevision)throw new VoiceSetupError('version_conflict');
      if(!['prepared','clone_ready'].includes(op.phase))throw new VoiceSetupError('operation_unavailable');
      if(!await this.options.isCurrent(op,op.configRevision))throw new VoiceSetupError('configuration_changed');
      const activation=op.phase==='clone_ready';
      const beforePaid=async()=>{requireLive(signal);if(!await this.options.isCurrent(op,op.configRevision))throw new EnrollmentError('invalid_request');requireLive(signal);};
      const reference=await this.options.references.read(op.referenceId);
      try{
        requireLive(signal);op.retryAvailable=false;op.phase=activation?'activating':'cloning';op.revision++;await this.save(op);
        if(activation){
          const result=await this.options.enrollment.activate({binding:op,voiceId:op.voiceId,text:op.text,operationId:op.operationId+':activation',beforePaid},signal);
          try{
            requireLive(signal);if(!await this.options.isCurrent(op,op.configRevision))throw new VoiceSetupError('configuration_changed');requireLive(signal);
            op.activationReceipt=result.receipt;await this.sampleWrite(op.operationId,'activation',result.audio);op.activationAvailable=true;
            requireLive(signal);if(!await this.options.isCurrent(op,op.configRevision))throw new VoiceSetupError('configuration_changed');requireLive(signal);
            // A success receipt and an intact reference are both needed before local registration.
            await this.options.registry.register(this.options.registry.snapshot().revision,{voiceId:op.voiceId,label:op.label,provider:'dashscope',endpoint:op.endpoint,targetModel:op.targetModel,
              credentialRef:op.credentialRef,referenceSha256:reference.metadata.sha256,createdAt:new Date().toISOString()});
            op.phase='registered';
          }finally{result.audio.fill(0);}
        }else{
          const result=await this.options.enrollment.clone({binding:op,reference:reference.metadata,bytes:reference.bytes,voiceId:op.voiceId,text:op.text,operationId:op.operationId+':clone',beforePaid},signal);
          try{
            requireLive(signal);if(!await this.options.isCurrent(op,op.configRevision))throw new VoiceSetupError('configuration_changed');requireLive(signal);
            op.cloneReceipt=result.receipt;
            if(result.demo){await this.sampleWrite(op.operationId,'demo',result.demo);op.demoAvailable=true;}
            op.phase='clone_ready';
          }finally{result.demo?.fill(0);}
        }
        op.revision++;await this.save(op);return clone(op);
      }catch(error){
        if(['cloning','activating'].includes(op.phase)){
          op.phase=error instanceof EnrollmentError&&!error.outcomeUnknown?'failed':'unknown';
          op.retryAvailable=error instanceof EnrollmentError&&error.retrySafe&&op.phase==='failed'&&error.code==='provider_not_enabled';
          op.errorCode=error instanceof EnrollmentError?error.code:error instanceof VoiceSetupError?error.code:signal.aborted?'cancelled':'local_failure';
          op.revision++;await this.save(op);return clone(op);
        }
        throw error;
      }finally{reference.bytes.fill(0);}
    });
  }
  /** Explicit, zero-network preparation after a proven unexecuted permission rejection. */
  async retry(input:{operationId:string;expectedRevision:number},signal:AbortSignal):Promise<VoiceSetupOperation>{
    if(this.closed)throw new VoiceSetupError('operation_unavailable');
    signal=AbortSignal.any([signal,this.lifetime.signal]);requireLive(signal);
    if(!input||Object.keys(input).sort().join()!==['operationId','expectedRevision'].sort().join()||!Number.isSafeInteger(input.expectedRevision))throw new VoiceSetupError('invalid_request');
    return this.locked(input.operationId,async()=>{
      const previous=await this.read(input.operationId);
      if(previous.revision!==input.expectedRevision)throw new VoiceSetupError('version_conflict');
      if(previous.phase!=='failed'||previous.errorCode!=='provider_not_enabled'||previous.retryAvailable!==true)throw new VoiceSetupError('operation_unavailable');
      if(!await this.options.isCurrent(previous,previous.configRevision))throw new VoiceSetupError('configuration_changed');requireLive(signal);
      const operationId=sha256(JSON.stringify(['explicit-retry',previous.operationId,previous.revision])).slice(0,32);
      try{return await this.get(operationId);}catch(error){
        try{await privateRead(this.file(operationId),16384);throw error;}catch(readError){if((readError as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      }
      const activation=previous.cloneReceipt!==null,now=new Date().toISOString();
      const next:VoiceSetupOperation={...previous,operationId,revision:1,phase:activation?'clone_ready':'prepared',voiceId:activation?previous.voiceId:'Voice'+randomUUID().replaceAll('-',''),
        errorCode:null,retryAvailable:false,activationReceipt:null,activationAvailable:false,demoAvailable:false,createdAt:now,updatedAt:now};
      if(activation&&previous.demoAvailable){
        const sample=await this.sample(previous.operationId,'demo');
        try{requireLive(signal);await this.sampleWrite(operationId,'demo',sample.bytes);next.demoAvailable=true;}finally{sample.bytes.fill(0);}
      }
      requireLive(signal);await this.save(next);return clone(next);
    });
  }
  close():Promise<void>{
    if(this.closing)return this.closing;
    this.closed=true;this.lifetime.abort();
    const running=[...this.active.values()];
    running.forEach(item=>item.controller.abort());
    this.closing=Promise.allSettled(running.map(item=>item.done)).then(()=>{});
    return this.closing;
  }
  async cancel(id:string):Promise<VoiceSetupOperation>{
    const active=this.active.get(id);
    if(active){active.controller.abort();try{return await active.done;}catch{return this.get(id);}}
    return this.locked(id,async()=>{
      const op=await this.read(id);
      if(['prepared','clone_ready'].includes(op.phase)){op.phase='cancelled';op.errorCode='cancelled';op.revision++;await this.save(op);}
      return this.get(id);
    });
  }
  async sample(id:string,kind:'demo'|'activation'):Promise<{bytes:Uint8Array;mime:'audio/mpeg'|'audio/wav'}>{
    if(!['demo','activation'].includes(kind))throw new VoiceSetupError('invalid_request');
    const op=await this.get(id);
    if(!(kind==='demo'?op.demoAvailable:op.activationAvailable))throw new VoiceSetupError('operation_unavailable');
    return{bytes:await privateRead(join(this.options.directory,id+'-'+kind+'.audio'),20*1024*1024),mime:kind==='demo'?'audio/mpeg':'audio/wav'};
  }
}
