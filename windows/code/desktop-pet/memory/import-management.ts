import { isPrivateFileSync, restrictPrivatePathSync } from '../core/platform-files.js';
import { constants, closeSync, lstatSync, mkdirSync, openSync, rmSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type {
  MemoryImportAction, MemoryImportConfiguration, MemoryImportJob, MemoryImportManagement,
  MemoryImportSnapshot, MemoryImportSource, MemoryImportStart, MemoryImportStatus,
} from '../contracts/memory-import.js';
import type { MemoryTurnInput, MemoryTurnPlan } from '../contracts/memory-lifecycle.js';
import { discoverHistoricalSource, MemoryImportError, type HistoricalMessage, type MemoryImportFailureCode } from './import-source.js';
import type { SqliteMemoryStore } from './sqlite-store.js';
import { MemoryRuleError } from './scope.js';

const APP_ID = 0x4d494d31; // MIM1
const SCHEMA = 1;
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
};
const digest = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');

export interface MemoryImportProcessor {
  plan(input: MemoryTurnInput, signal: AbortSignal, settle: (micros: number | null) => void): Promise<MemoryTurnPlan>;
}
export interface SqliteMemoryImportOptions {
  readonly filename: string;
  readonly codexHome: string;
  readonly instanceId: string;
  readonly store: SqliteMemoryStore;
  readonly configuration: MemoryImportConfiguration;
  readonly processor: MemoryImportProcessor;
  readonly clock?: () => string;
  readonly countTokens?: (input: MemoryTurnInput) => number;
}

interface JobRow {
  id:string;operation_id:string;operation_signature:string;revision:number;character_id:string;
  source_kind:MemoryImportSource['kind'];project_name:string;source_path:string;source_fingerprint:string|null;
  status:MemoryImportStatus;created_at:string;updated_at:string;discovered_messages:number;processed_messages:number;
  skipped_messages:number;total_batches:number;completed_batches:number;imported_memories:number;estimated_calls:number;
  estimated_micros:number|null;actual_calls:number;accounted_micros:number;unknown_cost_calls:number;
  configuration_json:string;resume_check:number;
}
interface MessageRow {ordinal:number;record_id:string;inserted:number;role:HistoricalMessage['role'];created_at:string;batch_id:string|null;processed:number}
interface BatchRow {id:string;ordinal:number;status:'pending'|'running'|'failed'|'completed';current_record_id:string;message_ids_json:string;attempts:number;imported_memories:number}

function validateConfiguration(value: MemoryImportConfiguration): void {
  if (!value || !value.model.trim() || !value.endpointHost.trim() || value.concurrency !== 1 || value.currency !== 'CNY' ||
    !Number.isSafeInteger(value.batchMessages) || value.batchMessages < 1 || !Number.isSafeInteger(value.maxInputBytes) || value.maxInputBytes < 1024 ||
    !Number.isSafeInteger(value.maxOutputTokens) || value.maxOutputTokens < 1 || !Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 1 ||
    !Number.isFinite(value.inputMicrosPerToken) || value.inputMicrosPerToken < 0 || !Number.isFinite(value.outputMicrosPerToken) || value.outputMicrosPerToken < 0 ||
    !value.textExportFormat.trim() || (value.budgetMode === 'bounded' ? !Number.isSafeInteger(value.limitMicros) || value.limitMicros! < 0 : value.limitMicros !== null)) {
    throw new MemoryImportError('invalid_source_entry', 'configuration');
  }
}
function safeSource(source: MemoryImportSource): void {
  if (!source || !['codex-project','text-export'].includes(source.kind) || !source.projectName?.trim() || !source.path?.trim() ||
    source.projectName.includes('\0') || source.path.includes('\0') || !isAbsolute(source.path) || /^[a-z]+:\/\//i.test(source.path)) throw new MemoryImportError('invalid_source_entry');
}

function openDatabase(filename: string, instanceId: string): Database.Database {
  if (!isAbsolute(filename) || !instanceId.trim()) throw new Error('invalid_import_database_configuration');
  mkdirSync(dirname(filename), {recursive:true});
  let created = false;
  try {
    try {
      const stat = lstatSync(filename);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('unsafe_import_database');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const fd = openSync(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      closeSync(fd); created = true;
    }
    if (created) restrictPrivatePathSync(filename);
    if (!isPrivateFileSync(filename)) throw new Error('unsafe_import_database');
    const db = new Database(filename, {fileMustExist:true});
    try {
      const app = db.pragma('application_id', {simple:true}), version = db.pragma('user_version', {simple:true});
      const count = (db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get() as {n:number}).n;
      if (!created && (app !== APP_ID || version !== SCHEMA || count === 0)) throw new Error('foreign_import_database');
      if (created) db.transaction(() => {
        db.pragma(`application_id=${APP_ID}`); db.pragma(`user_version=${SCHEMA}`);
        db.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
          CREATE TABLE jobs(id TEXT PRIMARY KEY,operation_id TEXT NOT NULL UNIQUE,operation_signature TEXT NOT NULL,revision INTEGER NOT NULL,
            character_id TEXT NOT NULL,source_kind TEXT NOT NULL,project_name TEXT NOT NULL,source_path TEXT NOT NULL,source_fingerprint TEXT,
            status TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,discovered_messages INTEGER NOT NULL DEFAULT 0,
            processed_messages INTEGER NOT NULL DEFAULT 0,skipped_messages INTEGER NOT NULL DEFAULT 0,total_batches INTEGER NOT NULL DEFAULT 0,
            completed_batches INTEGER NOT NULL DEFAULT 0,imported_memories INTEGER NOT NULL DEFAULT 0,estimated_calls INTEGER NOT NULL DEFAULT 0,
            estimated_micros INTEGER,actual_calls INTEGER NOT NULL DEFAULT 0,accounted_micros INTEGER NOT NULL DEFAULT 0,
            unknown_cost_calls INTEGER NOT NULL DEFAULT 0,configuration_json TEXT NOT NULL,resume_check INTEGER NOT NULL DEFAULT 0);
          CREATE TABLE messages(job_id TEXT NOT NULL,ordinal INTEGER NOT NULL,record_id TEXT NOT NULL,inserted INTEGER NOT NULL,
            role TEXT NOT NULL,created_at TEXT NOT NULL,batch_id TEXT,processed INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY(job_id,ordinal),FOREIGN KEY(job_id) REFERENCES jobs(id));
          CREATE TABLE batches(job_id TEXT NOT NULL,id TEXT NOT NULL,ordinal INTEGER NOT NULL,status TEXT NOT NULL,current_record_id TEXT NOT NULL,
            message_ids_json TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,imported_memories INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY(job_id,id),UNIQUE(job_id,ordinal),FOREIGN KEY(job_id) REFERENCES jobs(id));
          CREATE TABLE failures(job_id TEXT NOT NULL,ordinal INTEGER NOT NULL,item TEXT NOT NULL,code TEXT NOT NULL,
            PRIMARY KEY(job_id,ordinal),FOREIGN KEY(job_id) REFERENCES jobs(id));`);
        db.prepare("INSERT INTO meta VALUES('store_kind','memory-import')").run();
      }).immediate();
      const stored = db.prepare("SELECT value FROM meta WHERE key='store_kind'").get() as {value:string}|undefined;
      if (stored && stored.value !== 'memory-import') throw new Error('foreign_import_database');
      db.pragma('foreign_keys=ON'); db.pragma('synchronous=FULL'); db.pragma('secure_delete=ON'); db.pragma('journal_mode=WAL');
      return db;
    } catch (error) { db.close(); throw error; }
  } catch (error) {
    if (created) rmSync(filename, {force:true});
    throw error;
  }
}

/** Durable single-worker import queue. Opening never scans a source or resumes a paid call. */
export class SqliteMemoryImportManagement implements MemoryImportManagement {
  private readonly db:Database.Database;
  private readonly clock:()=>string;
  private readonly countTokens:(input:MemoryTurnInput)=>number;
  private tail:Promise<void>=Promise.resolve();
  private readonly controllers=new Map<string,AbortController>();
  private closed=false;
  constructor(private readonly options:SqliteMemoryImportOptions) {
    validateConfiguration(options.configuration);
    if (!isAbsolute(options.codexHome) || !options.instanceId.trim()) throw new Error('invalid_import_runtime_configuration');
    this.clock=options.clock??(()=>new Date().toISOString());
    // Without the production formatter, one UTF-8 byte is treated as one upper-bound unit.
    this.countTokens=options.countTokens??(input=>Buffer.byteLength(JSON.stringify(input),'utf8'));
    this.db=openDatabase(options.filename,options.instanceId);
    // A process loss never silently repeats an external call. User resume rechecks source and checkpoints.
    this.db.transaction(()=>{
      const interrupted=this.db.prepare("SELECT id FROM jobs WHERE status IN ('discovering','running')").all() as {id:string}[];
      this.db.prepare("UPDATE batches SET status='pending' WHERE status='running'").run();
      for(const row of interrupted){
        const ordinal=(this.db.prepare('SELECT coalesce(max(ordinal),0)+1 AS n FROM failures WHERE job_id=?').get(row.id) as {n:number}).n;
        this.db.prepare('INSERT INTO failures VALUES(?,?,?,?)').run(row.id,ordinal,'job','interrupted');
        this.db.prepare("UPDATE jobs SET status='paused',revision=revision+1,updated_at=? WHERE id=?").run(this.now(),row.id);
      }
    }).immediate();
  }

  private now():string { const value=this.clock(),at=Date.parse(value);if(!Number.isFinite(at))throw new Error('invalid_clock');return new Date(at).toISOString(); }
  private assertOpen():void {if(this.closed)throw new MemoryImportError('invalid_state');}
  private failures(id:string):MemoryImportJob['failures'] {
    return this.db.prepare('SELECT item,code FROM failures WHERE job_id=? ORDER BY ordinal').all(id) as {item:string;code:string}[];
  }
  private job(row:JobRow):MemoryImportJob {
    return {id:row.id,revision:row.revision,characterId:row.character_id,source:{kind:row.source_kind,projectName:row.project_name,path:row.source_path},
      sourceFingerprint:row.source_fingerprint,status:row.status,createdAt:row.created_at,updatedAt:row.updated_at,
      discoveredMessages:row.discovered_messages,processedMessages:row.processed_messages,skippedMessages:row.skipped_messages,
      totalBatches:row.total_batches,completedBatches:row.completed_batches,importedMemories:row.imported_memories,
      estimatedCalls:row.estimated_calls,estimatedMicros:row.estimated_micros,actualCalls:row.actual_calls,
      accountedMicros:row.accounted_micros,unknownCostCalls:row.unknown_cost_calls,failures:this.failures(row.id),
      configuration:JSON.parse(row.configuration_json) as MemoryImportConfiguration};
  }
  private row(id:string):JobRow {const row=this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as JobRow|undefined;if(!row)throw new MemoryImportError('invalid_state','job');return row;}
  snapshot():MemoryImportSnapshot {
    this.assertOpen();
    const rows=this.db.prepare('SELECT * FROM jobs ORDER BY created_at DESC,id DESC').all() as JobRow[];
    return {instanceId:this.options.instanceId,configuration:structuredClone(this.options.configuration),jobs:rows.map(row=>this.job(row))};
  }
  start(input:MemoryImportStart):MemoryImportJob {
    this.assertOpen();
    if(input.instanceId!==this.options.instanceId||input.characterId!=='companion'||!input.operationId?.trim())throw new MemoryImportError('invalid_state');
    safeSource(input.source);
    const signature=digest(input),prior=this.db.prepare('SELECT * FROM jobs WHERE operation_id=?').get(input.operationId) as JobRow|undefined;
    if(prior){if(prior.operation_signature!==signature)throw new MemoryImportError('version_conflict');return this.job(prior);}
    const id=randomUUID(),now=this.now();
    this.db.prepare(`INSERT INTO jobs(id,operation_id,operation_signature,revision,character_id,source_kind,project_name,source_path,status,created_at,updated_at,configuration_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,input.operationId,signature,1,input.characterId,input.source.kind,input.source.projectName,input.source.path,'discovering',now,now,JSON.stringify(this.options.configuration));
    this.schedule(id);return this.job(this.row(id));
  }
  pause(input:MemoryImportAction):MemoryImportJob {return this.action(input,'pause');}
  resume(input:MemoryImportAction):MemoryImportJob {return this.action(input,'resume');}
  private action(input:MemoryImportAction,kind:'pause'|'resume'):MemoryImportJob {
    this.assertOpen();if(input.instanceId!==this.options.instanceId)throw new MemoryImportError('invalid_state');
    const row=this.row(input.jobId);if(row.revision!==input.expectedRevision)throw new MemoryImportError('version_conflict',row.id);
    if(kind==='pause') {
      if(!['discovering','running'].includes(row.status))throw new MemoryImportError('invalid_state',row.id);
      this.db.transaction(()=>{
        this.db.prepare("UPDATE batches SET status='pending' WHERE job_id=? AND status='running'").run(row.id);
        this.db.prepare("UPDATE jobs SET status='paused',revision=revision+1,updated_at=? WHERE id=?").run(this.now(),row.id);
      }).immediate();
      this.controllers.get(row.id)?.abort(new MemoryImportError('interrupted',row.id));
    } else {
      if(!['paused','failed'].includes(row.status))throw new MemoryImportError('invalid_state',row.id);
      if(digest(JSON.parse(row.configuration_json))!==digest(this.options.configuration))throw new MemoryImportError('version_conflict',row.id);
      const status=row.source_fingerprint===null?'discovering':'running';
      this.db.transaction(()=>{
        this.db.prepare("UPDATE batches SET status='pending' WHERE job_id=? AND status='failed'").run(row.id);
        this.db.prepare('UPDATE jobs SET status=?,resume_check=?,revision=revision+1,updated_at=? WHERE id=?').run(status,row.source_fingerprint===null?0:1,this.now(),row.id);
      }).immediate();
      this.schedule(row.id);
    }
    return this.job(this.row(row.id));
  }
  private schedule(id:string):void {
    this.tail=this.tail.catch(()=>{}).then(async()=>{if(!this.closed)await this.run(id);}).catch(()=>{});
  }
  private scope(jobId:string,batchId:string) {return {characterId:'companion' as const,sessionId:`memory-import:${jobId}`,turnId:batchId,generation:1};}
  private code(error:unknown,fallback:MemoryImportFailureCode):MemoryImportFailureCode {
    if(error instanceof MemoryImportError)return error.code;
    if(error instanceof MemoryRuleError)return 'commit_conflict';
    return fallback;
  }
  private fail(id:string,item:string,code:MemoryImportFailureCode):void {
    this.db.transaction(()=>{
      const ordinal=(this.db.prepare('SELECT coalesce(max(ordinal),0)+1 AS n FROM failures WHERE job_id=?').get(id) as {n:number}).n;
      this.db.prepare('INSERT INTO failures VALUES(?,?,?,?)').run(id,ordinal,item,code);
      this.db.prepare("UPDATE jobs SET status='failed',revision=revision+1,updated_at=? WHERE id=?").run(this.now(),id);
    }).immediate();
  }
  private async run(id:string):Promise<void> {
    let row=this.row(id);if(!['discovering','running'].includes(row.status))return;
    if(row.status==='discovering') {
      try{await this.discover(row);}catch(error){this.fail(id,error instanceof MemoryImportError?error.item:'source',this.code(error,'source_unavailable'));return;}
    }
    row=this.row(id);if(row.status!=='running'||this.closed)return;
    if(row.resume_check) {
      try{
        const snapshot=await discoverHistoricalSource({kind:row.source_kind,projectName:row.project_name,path:row.source_path},this.options.codexHome);
        if(snapshot.fingerprint!==row.source_fingerprint)throw new MemoryImportError('source_changed');
        this.db.prepare('UPDATE jobs SET resume_check=0,revision=revision+1,updated_at=? WHERE id=?').run(this.now(),id);
      }catch(error){this.fail(id,'source',this.code(error,'source_changed'));return;}
    }
    await this.process(id);
  }

  private async discover(row:JobRow):Promise<void> {
    const source={kind:row.source_kind,projectName:row.project_name,path:row.source_path} as const;
    const configuration=JSON.parse(row.configuration_json) as MemoryImportConfiguration;
    const snapshot=await discoverHistoricalSource(source,this.options.codexHome);
    if(this.row(row.id).status==='paused')return;
    const evidence=this.options.store.imports.addEvidence(this.scope(row.id,'discovery'),{jobId:row.id,sourceKind:source.kind,projectName:source.projectName,messages:snapshot.messages});
    const staged=snapshot.messages.map((message,index)=>({...message,...evidence[index]!}));
    const segments:typeof staged[]=[];let segment:typeof staged=[];
    for(const message of staged){segment.push(message);if(message.role==='user'){segments.push(segment);segment=[];}}
    const plans:{id:string;ordinal:number;current:string;ids:string[];tokens:number}[]=[],oversized:string[]=[];let chunk:typeof staged=[];
    const draft=(messages:typeof staged,ordinal:number)=>{
      const current=[...messages].reverse().find(item=>item.role==='user'&&item.inserted);
      if(!current||messages.length>configuration.batchMessages)return null;
      const id=`${row.id}:batch:${String(ordinal).padStart(6,'0')}`,scope=this.scope(row.id,id),ids=messages.map(message=>message.recordId);
      let input:MemoryTurnInput;
      try{input=this.options.store.imports.buildInput(scope,ids,current.recordId,{maxMemories:12,maxInputBytes:configuration.maxInputBytes});}
      catch(error){if(error instanceof MemoryImportError&&error.code==='invalid_source_entry')return null;throw error;}
      const tokens=this.countTokens(input);if(!Number.isSafeInteger(tokens)||tokens<0)throw new MemoryImportError('invalid_source_entry',id);
      return tokens<=configuration.maxInputBytes?{id,ordinal,current:current.recordId,ids,tokens}:null;
    };
    const flush=()=>{if(!chunk.length)return;const plan=draft(chunk,plans.length+1);if(!plan)throw new MemoryImportError('invalid_source_entry','plan');plans.push(plan);chunk=[];};
    for(let index=segments.length-1;index>=0;index--){
      let next=segments[index]!,current=next.at(-1)!;
      if(!current.inserted)continue;
      // Assistant text is optional context. Preserve it as evidence, but remove whole context
      // messages (never truncate them) until this user's source can fit by itself.
      while(next.length>1&&!draft(next,plans.length+1))next=next.slice(1);
      if(!draft(next,plans.length+1)){oversized.push(current.recordId);continue;}
      if(chunk.length&&!draft([...next,...chunk],plans.length+1))flush();
      chunk=[...next,...chunk];
    }
    flush();
    const estimated=plans.reduce((sum,plan)=>sum+Math.ceil(plan.tokens*configuration.inputMicrosPerToken+configuration.maxOutputTokens*configuration.outputMicrosPerToken),0);
    if(!Number.isSafeInteger(estimated))throw new MemoryImportError('budget_exceeded','plan');
    if(configuration.budgetMode==='bounded'&&estimated>configuration.limitMicros!)throw new MemoryImportError('budget_exceeded','plan');
    const assigned=new Set(plans.flatMap(plan=>plan.ids));
    const unresolved=new Set(oversized);
    this.db.transaction(()=>{
      this.db.prepare('DELETE FROM messages WHERE job_id=?').run(row.id);this.db.prepare('DELETE FROM batches WHERE job_id=?').run(row.id);this.db.prepare('DELETE FROM failures WHERE job_id=?').run(row.id);
      const insertMessage=this.db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?)');
      staged.forEach((message,index)=>insertMessage.run(row.id,index+1,message.recordId,message.inserted?1:0,message.role,message.createdAt,null,message.inserted&&!assigned.has(message.recordId)&&!unresolved.has(message.recordId)?1:0));
      const insertBatch=this.db.prepare('INSERT INTO batches VALUES(?,?,?,?,?,?,0,0)');
      for(const plan of plans){insertBatch.run(row.id,plan.id,plan.ordinal,'pending',plan.current,JSON.stringify(plan.ids));for(const id of plan.ids)this.db.prepare('UPDATE messages SET batch_id=? WHERE job_id=? AND record_id=?').run(plan.id,row.id,id);}
      const insertFailure=this.db.prepare('INSERT INTO failures VALUES(?,?,?,?)');
      oversized.forEach((item,index)=>insertFailure.run(row.id,index+1,item,'budget_exceeded'));
      const nonModel=(this.db.prepare('SELECT count(*) AS n FROM messages WHERE job_id=? AND inserted=1 AND processed=1').get(row.id) as {n:number}).n;
      const current=this.row(row.id),status:MemoryImportStatus=current.status==='paused'?'paused':plans.length?'running':oversized.length?'failed':'completed';
      this.db.prepare(`UPDATE jobs SET source_fingerprint=?,status=?,revision=revision+1,updated_at=?,discovered_messages=?,processed_messages=?,skipped_messages=?,
        total_batches=?,completed_batches=0,imported_memories=0,estimated_calls=?,estimated_micros=?,resume_check=0 WHERE id=?`).run(
        snapshot.fingerprint,status,this.now(),staged.length,nonModel,staged.filter(item=>!item.inserted).length,plans.length,plans.length,estimated,row.id);
    }).immediate();
  }

  private async process(id:string):Promise<void> {
    while(!this.closed){
      const job=this.row(id);if(job.status!=='running')return;
      const configuration=JSON.parse(job.configuration_json) as MemoryImportConfiguration;
      const batch=this.db.prepare("SELECT * FROM batches WHERE job_id=? AND status IN ('pending','failed') ORDER BY ordinal LIMIT 1").get(id) as BatchRow|undefined;
      if(!batch){
        const remaining=(this.db.prepare('SELECT count(*) AS n FROM messages WHERE job_id=? AND inserted=1 AND processed=0').get(id) as {n:number}).n;
        this.db.prepare("UPDATE jobs SET status=?,revision=revision+1,updated_at=? WHERE id=? AND status='running'").run(remaining?'failed':'completed',this.now(),id);return;
      }
      const scope=this.scope(id,batch.id),replay=this.options.store.imports.outcome(scope,batch.current_record_id);
      if(replay){this.completeBatch(id,batch,replay.importedMemories);continue;}
      const ids=JSON.parse(batch.message_ids_json) as string[];
      let input:MemoryTurnInput;
      try{input=this.options.store.imports.buildInput(scope,ids,batch.current_record_id,{maxMemories:12,maxInputBytes:configuration.maxInputBytes});}
      catch(error){this.fail(id,batch.id,this.code(error,'commit_conflict'));return;}
      this.db.prepare("UPDATE batches SET status='running',attempts=attempts+1 WHERE job_id=? AND id=?").run(id,batch.id);
      let settled=false;
      const settle=(micros:number|null)=>{
        if(settled)throw new MemoryImportError('commit_conflict',batch.id);settled=true;
        if(micros!==null&&(!Number.isSafeInteger(micros)||micros<0))throw new MemoryImportError('commit_conflict',batch.id);
        if(this.closed)return;
        this.db.prepare('UPDATE jobs SET actual_calls=actual_calls+1,accounted_micros=accounted_micros+?,unknown_cost_calls=unknown_cost_calls+?,revision=revision+1,updated_at=? WHERE id=?')
          .run(micros??0,micros===null?1:0,this.now(),id);
      };
      const controller=new AbortController();this.controllers.set(id,controller);let timer:ReturnType<typeof setTimeout>;
      const timeout=new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{const error=new MemoryImportError('provider_timeout',batch.id);controller.abort(error);reject(error);},configuration.timeoutMs);});
      const aborted=new Promise<never>((_resolve,reject)=>controller.signal.addEventListener('abort',()=>reject(controller.signal.reason instanceof Error?controller.signal.reason:new MemoryImportError('interrupted',batch.id)),{once:true}));
      let plan:MemoryTurnPlan;
      try{plan=await Promise.race([this.options.processor.plan(structuredClone(input),controller.signal,settle),timeout,aborted]);}
      catch(error){
        clearTimeout(timer!);this.controllers.delete(id);
        if(this.closed)return;
        if(controller.signal.aborted&&controller.signal.reason instanceof MemoryImportError&&controller.signal.reason.code==='interrupted'){
          this.db.prepare("UPDATE batches SET status='pending' WHERE job_id=? AND id=? AND status='running'").run(id,batch.id);return;
        }
        const current=this.row(id);if(current.status==='paused'){this.db.prepare("UPDATE batches SET status='pending' WHERE job_id=? AND id=? AND status='running'").run(id,batch.id);return;}
        this.db.prepare("UPDATE batches SET status='failed' WHERE job_id=? AND id=?").run(id,batch.id);
        this.fail(id,batch.id,this.code(error,'provider_failed'));return;
      }
      clearTimeout(timer!);this.controllers.delete(id);
      if(this.closed||controller.signal.aborted||this.row(id).status!=='running'){
        if(!this.closed)this.db.prepare("UPDATE batches SET status='pending' WHERE job_id=? AND id=? AND status='running'").run(id,batch.id);
        return;
      }
      try{const result=this.options.store.imports.commit(scope,input,plan);this.completeBatch(id,batch,result.importedMemories);}
      catch(error){this.db.prepare("UPDATE batches SET status='failed' WHERE job_id=? AND id=?").run(id,batch.id);this.fail(id,batch.id,this.code(error,'commit_conflict'));return;}
    }
  }
  private completeBatch(jobId:string,batch:BatchRow,imported:number):void {
    this.db.transaction(()=>{
      this.db.prepare("UPDATE batches SET status='completed',imported_memories=? WHERE job_id=? AND id=?").run(imported,jobId,batch.id);
      this.db.prepare('UPDATE messages SET processed=1 WHERE job_id=? AND batch_id=? AND inserted=1').run(jobId,batch.id);
      const counts=this.db.prepare(`SELECT (SELECT count(*) FROM batches WHERE job_id=? AND status='completed') AS completed,
        (SELECT count(*) FROM messages WHERE job_id=? AND inserted=1 AND processed=1) AS processed,
        (SELECT coalesce(sum(imported_memories),0) FROM batches WHERE job_id=?) AS imported`).get(jobId,jobId,jobId) as {completed:number;processed:number;imported:number};
      const current=this.row(jobId),done=counts.completed===current.total_batches;
      const remaining=(this.db.prepare('SELECT count(*) AS n FROM messages WHERE job_id=? AND inserted=1 AND processed=0').get(jobId) as {n:number}).n;
      this.db.prepare('UPDATE jobs SET completed_batches=?,processed_messages=?,imported_memories=?,status=?,revision=revision+1,updated_at=? WHERE id=?')
        .run(counts.completed,counts.processed,counts.imported,current.status==='paused'?'paused':done?(remaining?'failed':'completed'):'running',this.now(),jobId);
    }).immediate();
  }
  async close():Promise<void> {
    if(this.closed)return;this.closed=true;
    this.db.transaction(()=>{
      this.db.prepare("UPDATE batches SET status='pending' WHERE status='running'").run();
      this.db.prepare("UPDATE jobs SET status='paused',revision=revision+1,updated_at=? WHERE status IN ('discovering','running')").run(this.now());
    }).immediate();
    for(const [id,controller] of this.controllers)controller.abort(new MemoryImportError('interrupted',id));
    await this.tail.catch(()=>{});this.db.close();
  }
}

export const createMemoryImportManagement = (options:SqliteMemoryImportOptions):SqliteMemoryImportManagement => new SqliteMemoryImportManagement(options);
