import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import type { TurnScope, MemoryChange } from '../contracts/index.js';
import { DEFAULT_MEMORY_DYNAMICS_POLICY, type MemoryDynamicsTraits, type MemoryDynamicsState, type MemoryPolicyVersion, type MemoryPolicySave, type MemoryPolicyRollback } from '../contracts/memory-dynamics.js';
import type { SourceVersion } from '../contracts/memory-lifecycle.js';
import type { MemoryRecord } from './ledger.js';
import type { SqliteMemoryStore } from './sqlite-store.js';
import { evolve, reinforceActivity, reinforcementDay, unit } from './dynamics.js';
import { policyParameters } from './dynamics-policy.js';
import { bindScope, timestamp, sameScope, MemoryRuleError } from './scope.js';

const emptyTraits = (): MemoryDynamicsTraits => ({ category:'unassessed', importance:0, evidenceSources:[], emotion:{status:'missing',intensity:null,sources:[],observation:null} });
interface Anchor { record_id:string; record_version:number; anchor_at:string; activation:number; emotion:number; traits_json:string; lineage_json:string }
interface PolicyRow { revision:number; effective_at:string; policy_json:string; restored_from:number|null }
const signature = (value:unknown):string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const scopeFor = (characterId:TurnScope['characterId']):TurnScope => ({characterId,sessionId:'dynamics',turnId:'dynamics',generation:0});

/** Additive component tables in the admitted PET2/schema4 database, sharing business transactions. */
export class SqliteMemoryDynamics {
  constructor(private readonly db:Database.Database, private readonly store:SqliteMemoryStore) {
    db.transaction(()=>{
      db.exec(`CREATE TABLE IF NOT EXISTS memory_dynamics_component(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL);
        INSERT OR IGNORE INTO memory_dynamics_component VALUES(1,1);`);
      const component=db.prepare('SELECT version FROM memory_dynamics_component WHERE singleton=1').get() as {version:number};
      if(component.version!==1)throw new MemoryRuleError('unsupported_dynamics_schema');
      db.exec(`CREATE TABLE IF NOT EXISTS memory_dynamics_policy(revision INTEGER PRIMARY KEY,effective_at TEXT NOT NULL,policy_json TEXT NOT NULL,restored_from INTEGER);
        CREATE TABLE IF NOT EXISTS memory_dynamics_anchor(character_id TEXT NOT NULL,record_id TEXT NOT NULL,record_version INTEGER NOT NULL,
          anchor_at TEXT NOT NULL,activation REAL NOT NULL,emotion REAL NOT NULL,traits_json TEXT NOT NULL,lineage_json TEXT NOT NULL,
          PRIMARY KEY(character_id,record_id),FOREIGN KEY(character_id,record_id) REFERENCES memory_records(character_id,id));
        CREATE TABLE IF NOT EXISTS memory_dynamics_reinforcement(character_id TEXT NOT NULL,lineage_id TEXT NOT NULL,day TEXT NOT NULL,message_id TEXT NOT NULL,
          PRIMARY KEY(character_id,lineage_id,day),UNIQUE(character_id,lineage_id,message_id));
        CREATE TABLE IF NOT EXISTS memory_dynamics_operations(character_id TEXT NOT NULL,operation_id TEXT NOT NULL,signature TEXT NOT NULL,result_json TEXT NOT NULL,
          PRIMARY KEY(character_id,operation_id));`);
      db.prepare('INSERT OR IGNORE INTO memory_dynamics_policy VALUES(1,?,?,NULL)').run(store.now(),JSON.stringify(DEFAULT_MEMORY_DYNAMICS_POLICY));
      this.sync(scopeFor('companion'));
    }).immediate();
  }
  history():readonly MemoryPolicyVersion[] {
    return (this.db.prepare('SELECT * FROM memory_dynamics_policy ORDER BY revision').all() as PolicyRow[]).map(row=>({revision:row.revision,effectiveAt:row.effective_at,policy:JSON.parse(row.policy_json),restoredFromRevision:row.restored_from}));
  }
  policy():MemoryPolicyVersion { return this.history().at(-1)!; }
  private anchor(scope:TurnScope,id:string):Anchor|undefined {
    bindScope(scope,scope.characterId);
    return this.db.prepare('SELECT * FROM memory_dynamics_anchor WHERE character_id=? AND record_id=?').get(scope.characterId,id) as Anchor|undefined;
  }
  private write(scope:TurnScope,record:MemoryRecord,at:string,activation:number,emotion:number,traits:MemoryDynamicsTraits,lineageIds:readonly string[]):void {
    this.db.prepare(`INSERT INTO memory_dynamics_anchor VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(character_id,record_id) DO UPDATE SET
      record_version=excluded.record_version,anchor_at=excluded.anchor_at,activation=excluded.activation,emotion=excluded.emotion,traits_json=excluded.traits_json,lineage_json=excluded.lineage_json`)
      .run(scope.characterId,record.id,record.version,at,activation,emotion,JSON.stringify(traits),JSON.stringify([...new Set(lineageIds)].sort()));
  }
  private evaluate(anchor:Anchor,at:string):{activation:number;emotion:number;traits:MemoryDynamicsTraits} {
    let cursor=timestamp(anchor.anchor_at),activation=anchor.activation,emotion=anchor.emotion;
    const end=timestamp(at),traits=JSON.parse(anchor.traits_json) as MemoryDynamicsTraits;
    if(end<cursor)throw new MemoryRuleError('dynamics_time_before_anchor');
    const policies=this.history();
    let policy=policies[0]!;
    for(const next of policies) {
      const boundary=timestamp(next.effectiveAt);
      if(boundary<=cursor){policy=next;continue;}
      if(boundary>end)break;
      const evolved=evolve({activity:activation,emotion,importance:traits.importance,stable:traits.category==='stable_profile',elapsedMs:boundary-cursor},policyParameters(policy.policy));
      activation=evolved.activity;emotion=evolved.emotion;cursor=boundary;policy=next;
    }
    const evolved=evolve({activity:activation,emotion,importance:traits.importance,stable:traits.category==='stable_profile',elapsedMs:end-cursor},policyParameters(policy.policy));
    return {activation:evolved.activity,emotion:evolved.emotion,traits};
  }
  /** Called by every business mutation within its transaction. Reads never initialize or repair rows. */
  sync(scope:TurnScope):void {
    bindScope(scope,scope.characterId);
    const rows=this.db.prepare("SELECT id FROM memory_records WHERE character_id=? AND kind='memory'").all(scope.characterId) as {id:string}[];
    const at=this.store.now();
    for(const {id} of rows) {
      const record=this.store.inspect(scope,id)!,anchor=this.anchor(scope,id);
      if(!anchor){this.write(scope,record,at,1,0,emptyTraits(),[id]);continue;}
      const traits=JSON.parse(anchor.traits_json) as MemoryDynamicsTraits;
      const evidenceInvalid=[...traits.evidenceSources,...traits.emotion.sources].some(ref=>{
        const source=this.store.inspect(scope,ref.id);
        return !source || (source.state!=='expired' && (source.state!=='active'||source.version!==ref.version||source.evidenceEligible===false));
      });
      if(anchor.record_version!==record.version || (record.state!=='active' && (traits.evidenceSources.length>0||traits.emotion.status!=='missing')) || evidenceInvalid) {
        const current=this.evaluate(anchor,at);
        // Keep the activity timeline and quota lineage; discard stale semantic/emotional claims.
        this.write(scope,record,at,current.activation,0,emptyTraits(),JSON.parse(anchor.lineage_json));
      }
    }
  }
  state(scope:TurnScope,id:string,at=this.store.now()):MemoryDynamicsState|null {
    const record=this.store.inspect(scope,id),anchor=this.anchor(scope,id);
    if(!record||record.kind!=='memory'||!anchor)return null;
    const current=this.evaluate(anchor,at),lineageIds=JSON.parse(anchor.lineage_json) as string[];
    const last=this.db.prepare(`SELECT max(day) AS day FROM memory_dynamics_reinforcement WHERE character_id=? AND lineage_id IN (SELECT value FROM json_each(?))`).get(scope.characterId,JSON.stringify(lineageIds)) as {day:string|null};
    const valid=record.state==='active'&&record.evidenceEligible!==false&&record.version===anchor.record_version;
    return {recordId:id,recordVersion:record.version,lineageIds,traits:valid?current.traits:emptyTraits(),activation:valid?current.activation:0,emotion:valid?current.emotion:0,
      halfLifeDays:current.traits.category==='stable_profile'?null:this.policy().policy.baseHalfLifeDays*(1+2*current.traits.importance),anchorAt:anchor.anchor_at,evaluatedAt:at,lastReinforcedDay:last.day,policyRevision:this.policy().revision};
  }
  private operation<T>(scope:TurnScope,id:string,payload:unknown,action:()=>T):T {
    bindScope(scope,scope.characterId);if(!id.trim())throw new MemoryRuleError('missing_operation_metadata');
    const hash=signature(payload);
    return this.db.transaction(()=>{
      const prior=this.db.prepare('SELECT signature,result_json FROM memory_dynamics_operations WHERE character_id=? AND operation_id=?').get(scope.characterId,id) as {signature:string;result_json:string}|undefined;
      if(prior){if(prior.signature!==hash)throw new MemoryRuleError('operation_id_payload_mismatch');return JSON.parse(prior.result_json) as T;}
      const result=action();
      this.db.prepare('INSERT INTO memory_dynamics_operations VALUES(?,?,?,?)').run(scope.characterId,id,hash,JSON.stringify(result));
      return result;
    }).immediate();
  }
  savePolicy(input:MemoryPolicySave):MemoryPolicyVersion {
    policyParameters(input.policy);
    return this.operation(scopeFor(input.characterId),input.operationId,{type:'savePolicy',...input},()=>this.commitPolicy(input.expectedRevision,input.policy,null));
  }
  rollbackPolicy(input:MemoryPolicyRollback):MemoryPolicyVersion {
    return this.operation(scopeFor(input.characterId),input.operationId,{type:'rollbackPolicy',...input},()=>{
      const target=this.history().find(row=>row.revision===input.targetRevision);if(!target)throw new MemoryRuleError('unknown_policy_revision');
      return this.commitPolicy(input.expectedRevision,target.policy,target.revision);
    });
  }
  private commitPolicy(expected:number,policy:MemoryPolicyVersion['policy'],restoredFrom:number|null):MemoryPolicyVersion {
    const current=this.policy(),at=this.store.now();
    if(current.revision!==expected)throw new MemoryRuleError('version_conflict');
    if(timestamp(at)<timestamp(current.effectiveAt))throw new MemoryRuleError('dynamics_clock_reversed');
    const next={revision:current.revision+1,effectiveAt:at,policy:structuredClone(policy),restoredFromRevision:restoredFrom};
    this.db.prepare('INSERT INTO memory_dynamics_policy VALUES(?,?,?,?)').run(next.revision,at,JSON.stringify(policy),restoredFrom);
    return next;
  }
  private target(scope:TurnScope,id:string,version:number):MemoryRecord {
    const record=this.store.inspect(scope,id);
    if(!record||record.kind!=='memory'||record.state!=='active'||record.evidenceEligible===false)throw new MemoryRuleError('memory_hard_gate');
    if(record.version!==version)throw new MemoryRuleError('version_conflict');return record;
  }
  private evidence(scope:TurnScope,refs:readonly SourceVersion[],record:MemoryRecord):void {
    const closure=new Set<string>(),visit=(id:string):void=>{if(closure.has(id))return;closure.add(id);for(const ref of this.store.inspect(scope,id)?.sources??[])visit(ref.id);};
    for(const ref of record.sources)visit(ref.id);
    for(const ref of refs){const source=this.store.inspect(scope,ref.id);if(!closure.has(ref.id)||!source||source.state!=='active'||source.version!==ref.version||source.evidenceEligible===false)throw new MemoryRuleError('invalid_traits_evidence');}
  }
  applyTraits(scope:TurnScope,input:{recordId:string;expectedVersion:number;traits:MemoryDynamicsTraits;operationId:string}):{recordId:string;policyRevision:number} {
    const traits=structuredClone(input.traits);
    return this.operation(scope,input.operationId,{type:'traits',scope,...input},()=>{
      const record=this.target(scope,input.recordId,input.expectedVersion);
      if(!['event','stable_profile','unassessed'].includes(traits.category)||![0,0.5,1].includes(traits.importance))throw new MemoryRuleError('invalid_traits');
      if((traits.category==='stable_profile'||traits.importance>0)&&!traits.evidenceSources.length)throw new MemoryRuleError('missing_traits_evidence');
      this.evidence(scope,traits.evidenceSources,record);
      if(!['missing','invalid','observed'].includes(traits.emotion.status))throw new MemoryRuleError('invalid_emotion_status');
      if(traits.emotion.status==='observed') {
        if(traits.emotion.intensity===null||!traits.emotion.sources.length)throw new MemoryRuleError('missing_emotion_evidence');
        unit(traits.emotion.intensity,'emotion');this.evidence(scope,traits.emotion.sources,record);
        const observation=traits.emotion.observation?.trim();
        if(!observation || /^(?:当下线索|具体不确定性|时间线索|状态线索|中性|高兴|悲伤|愤怒|恐惧|厌恶|惊讶)$/.test(observation) || !traits.emotion.sources.some(ref=>this.store.inspect(scope,ref.id)?.text.includes(observation)))throw new MemoryRuleError('unverified_emotion_intensity');
      } else if(traits.emotion.intensity!==null||traits.emotion.observation!==null)throw new MemoryRuleError('invalid_missing_emotion');
      const at=this.store.now(),anchor=this.anchor(scope,record.id)!,current=this.evaluate(anchor,at);
      let emotion=0;
      if(traits.emotion.status==='observed') {
        if(signature(traits.emotion)===signature(current.traits.emotion))emotion=current.emotion;
        else {
          const observedAt=Math.max(timestamp(this.history()[0]!.effectiveAt),...traits.emotion.sources.map(ref=>timestamp(this.store.inspect(scope,ref.id)!.createdAt)));
          emotion=this.evaluate({...anchor,anchor_at:new Date(observedAt).toISOString(),activation:0,emotion:traits.emotion.intensity!,traits_json:JSON.stringify(emptyTraits())},at).emotion;
        }
      }
      this.write(scope,record,at,traits.category==='stable_profile'?1:current.activation,emotion,traits,JSON.parse(anchor.lineage_json));
      this.db.prepare('UPDATE characters SET revision=revision+1,epoch=epoch+1 WHERE character_id=?').run(scope.characterId);
      return {recordId:record.id,policyRevision:this.policy().revision};
    });
  }
  reinforce(scope:TurnScope,input:{recordId:string;expectedVersion:number;source:SourceVersion;kind:'reiteration'|'confirmation';operationId:string}):{reinforced:boolean;day:string} {
    return this.operation(scope,input.operationId,{type:'reinforce',scope,...input},()=>{
      const record=this.target(scope,input.recordId,input.expectedVersion),source=this.store.inspect(scope,input.source.id);
      if(!source||source.state!=='active'||source.evidenceEligible===false||source.version!==input.source.version||source.message?.role!=='user'||source.origin==='manual')throw new MemoryRuleError('invalid_reinforcement_source');
      if(!['reiteration','confirmation'].includes(input.kind))throw new MemoryRuleError('invalid_reinforcement_kind');
      // Require a committed strict turn: corrected/forgotten quotes are never reinforcement.
      const outcome=this.db.prepare('SELECT scope_json,outcome_json FROM memory_turn_outcomes WHERE character_id=? AND current_message_id=?').get(scope.characterId,source.id) as {scope_json:string;outcome_json:string}|undefined;
      if(!outcome||!sameScope(JSON.parse(outcome.scope_json),scope)||JSON.parse(outcome.outcome_json).request!=='none')throw new MemoryRuleError('unconfirmed_reinforcement_turn');
      const at=this.store.now(),day=reinforcementDay(timestamp(at)),anchor=this.anchor(scope,record.id)!,lineage=JSON.parse(anchor.lineage_json) as string[];
      const used=this.db.prepare(`SELECT 1 FROM memory_dynamics_reinforcement WHERE character_id=? AND lineage_id IN (SELECT value FROM json_each(?)) AND (day=? OR message_id=?) LIMIT 1`).get(scope.characterId,JSON.stringify(lineage),day,source.id);
      if(used)return {reinforced:false,day};
      const current=this.evaluate(anchor,at);
      this.write(scope,record,at,reinforceActivity(current.activation),current.emotion,current.traits,lineage);
      for(const id of lineage)this.db.prepare('INSERT INTO memory_dynamics_reinforcement VALUES(?,?,?,?)').run(scope.characterId,id,day,source.id);
      this.db.prepare('UPDATE characters SET revision=revision+1,epoch=epoch+1 WHERE character_id=?').run(scope.characterId);
      return {reinforced:true,day};
    });
  }
  /** Only actual committed merge operations may transfer quota ancestry. */
  merged(scope:TurnScope,changes:readonly MemoryChange[]):void {
    for(const {operation:op} of changes)if(op.type==='merge') {
      const record=this.store.inspect(scope,op.replacement.id);if(!record||record.state!=='active')continue;
      const lineage=op.targets.flatMap(target=>{const row=this.anchor(scope,target.id);return row?JSON.parse(row.lineage_json) as string[]:[target.id];});
      const row=this.anchor(scope,record.id);
      const at=this.store.now(),parents=op.targets.map(target=>this.anchor(scope,target.id)).filter((item):item is Anchor=>!!item);
      const activation=parents.length?Math.max(...parents.map(parent=>this.evaluate(parent,at).activation)):1;
      if(row)this.write(scope,record,at,activation,row.emotion,JSON.parse(row.traits_json),[...lineage,record.id]);
    }
  }
}
