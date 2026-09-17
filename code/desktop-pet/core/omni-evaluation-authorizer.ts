import { readFile } from 'node:fs/promises';
import { EvaluationBudget, type BudgetEntry, type BudgetState } from './evaluation-budget.js';
import type { CallAuthorizer, CallOutcome, CallRequest } from '../providers/transport.js';

export const OMNI_EVALUATION_MODEL = 'qwen3.5-omni-flash-2026-03-15';
export const OMNI_EVALUATION_ENDPOINT = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
export const OMNI_EVALUATION_PREFIX = 'W0-I:B-OMNI-SEVEN-EMOTION-01:';
export const OMNI_EVALUATION_CASES = Object.freeze(Array.from({length:14},(_,i)=>
  (i%2?['av','audio']:['audio','av']).map(condition=>`s${String(i+1).padStart(2,'0')}-${condition}`)).flat());
const integer = (v:unknown):v is number => typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;

/** Beijing list-price estimate from returned modality token counts; never a bill receipt. */
export function omniUsageMicros(usage:unknown):number|null {
  if(!usage||typeof usage!=='object')return null;
  const u=usage as Record<string,unknown>, input=u.prompt_tokens,output=u.completion_tokens;
  if(!integer(input)||!integer(output)||output>512)return null;
  const details=u.prompt_tokens_details as Record<string,unknown>|undefined;
  if(!details||!integer(details.audio_tokens)||details.audio_tokens>input)return null;
  const completed=u.completion_tokens_details as Record<string,unknown>|undefined;
  if(completed?.audio_tokens!==undefined&&completed.audio_tokens!==0)return null;
  // Non-audio input 2.2, audio input 18, text output 13.3 micro-CNY/token.
  return Math.ceil(((input-details.audio_tokens)*22+details.audio_tokens*180+output*133)/10);
}

/** One fixed sequence, original account only, no configuration mutation or automatic recovery. */
export class OmniEvaluationAuthorizer implements CallAuthorizer {
  private next=0;
  private pending=false;
  private halted=false;
  private readonly budget:EvaluationBudget;
  private readonly reviewedUnknown:ReadonlyMap<string,string>;
  constructor(private readonly ledgerFile:string,private readonly batchId:string,
    reviewedUnknown:readonly BudgetEntry[],private readonly reservationMicros=100_000) {
    if(!batchId||!Number.isSafeInteger(reservationMicros)||reservationMicros<=0||reservationMicros>5_000_000)
      throw new Error('Invalid explicit evaluation budget');
    this.budget=new EvaluationBudget(ledgerFile,batchId,60_000_000);
    this.reviewedUnknown=new Map(reviewedUnknown.map(e=>[e.operationId,JSON.stringify(e)]));
  }
  async authorize(request:CallRequest,signal:AbortSignal) {
    signal.throwIfAborted();
    if(this.halted||this.pending||this.next>=OMNI_EVALUATION_CASES.length)throw new Error('Evaluation stopped or out of sequence');
    if(request.operation!=='perception'||request.model!==OMNI_EVALUATION_MODEL||request.endpoint!==OMNI_EVALUATION_ENDPOINT||
      request.scope.characterId!=='companion'||request.scope.sessionId!=='omni-seven-emotion-evaluation'||request.scope.generation!==1||
      request.scope.turnId!==OMNI_EVALUATION_CASES[this.next])throw new Error('Evaluation request differs from frozen case');
    this.pending=true;
    const operationId=OMNI_EVALUATION_PREFIX+request.scope.turnId;
    try {
      // readFile deliberately fails if the original account has disappeared.
      const state=JSON.parse(await readFile(this.ledgerFile,'utf8')) as BudgetState;
      if(state.batchId!==this.batchId||state.limitMicros!==60_000_000||state.blocked||!Array.isArray(state.entries))throw new Error('Original account is not ready');
      if(state.entries.some(e=>e.status==='reserved'||(e.status==='unknown'&&this.reviewedUnknown.get(e.operationId)!==JSON.stringify(e))))
        throw new Error('Outstanding or unreviewed account entry');
      const prior=state.entries.filter(e=>e.operationId.startsWith(OMNI_EVALUATION_PREFIX));
      if(prior.length!==this.next)throw new Error('Evaluation already attempted; do not replay');
      await this.budget.reserve(operationId,request.model,this.reservationMicros,{operationIdPrefix:OMNI_EVALUATION_PREFIX,limitMicros:5_000_000,maxCalls:28});
      this.next++;
    } catch(error) {this.halted=true;this.pending=false;throw error;}
    let settled=false;
    return {settle:async(outcome:CallOutcome)=>{
      if(settled)throw new Error('Evaluation permit already settled');
      settled=true;
      const cost=outcome.status==='success'?omniUsageMicros(outcome.usage):null;
      try {await this.budget.settle(operationId,cost);}
      finally {this.pending=false;if(outcome.status!=='success'||cost===null||cost>this.reservationMicros)this.halted=true;}
      if(this.halted)throw new Error('Evaluation stopped after failed or unknown settlement');
    }};
  }
}
