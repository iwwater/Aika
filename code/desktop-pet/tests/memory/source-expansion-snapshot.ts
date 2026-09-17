/** Explicit, zero-network evidence runner for W0-I's pinned synthetic SQLite snapshot.
 * Run after build: node dist/tests/memory/source-expansion-snapshot.js <snapshot-dir> <output-json>
 */
import assert from 'node:assert/strict';
import {copyFileSync,readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import type {MemoryTurnInput,MemoryTurnPlan,SourceRetention} from '../../contracts/memory-lifecycle.js';
import {SqliteLifecycleMemoryPort} from '../../memory/sqlite-lifecycle-port.js';
import {contextInputUpperBound,memoryTurnInputUpperBound,summaryInputUpperBound} from '../../app/input-budgets.js';
import {fixture} from './sqlite-fixture.js';

const digest=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
export async function checkPinnedSnapshot(directory:string){
  const filename=resolve(directory,'synthetic.sqlite'),snapshotPath=resolve(directory,'complete-input.json');
  const originalHash=digest(readFileSync(filename)),inputHash=digest(readFileSync(snapshotPath));
  const full=JSON.parse(readFileSync(snapshotPath,'utf8')) as MemoryTurnInput;
  const request=full.sources.find(source=>source.id===full.currentMessageId)!;
  assert.equal(full.sources.length,43);assert.equal(full.messages.length,42);
  const scenarios=[];
  for(const mode of ['disabled','enabled','known_omission'] as const){
    const f=fixture();
    try{
      copyFileSync(filename,f.filename);let store=f.open();
      for(const source of full.sources){const actual=store.inspect(full.scope,source.id)!;assert.equal(actual.text,source.text);assert.equal(actual.version,source.version);assert.equal(actual.state,'active');assert.deepEqual(actual.sources,source.sourceVersions);assert.equal(actual.evidenceEligible,source.evidenceEligible);}
      const memory=full.sources.find(source=>source.kind==='memory')!,raw=store.inspect(full.scope,memory.id)!.sources.find(ref=>full.sources.some(source=>source.id===ref.id&&source.messageRole==='user'))!;
      const assistants=full.sources.filter(source=>source.messageRole==='assistant');
      const unrelated=full.sources.filter(source=>source.messageRole==='user'&&source.id!==raw.id&&source.id!==request.id);
      const beforeRevision=store.revision(full.scope),beforeMemory=store.inspect(full.scope,memory.id),beforeOutcome=store.lifecycle.outcome(full.scope,request.id,request.text);assert.equal(beforeOutcome,null);
      const phases:{input:MemoryTurnInput;upperBound:number;plan:MemoryTurnPlan}[]=[];
      const provider={async plan(input:MemoryTurnInput):Promise<MemoryTurnPlan>{
        assert.equal(store.revision(full.scope),beforeRevision);assert.deepEqual(store.inspect(full.scope,memory.id),beforeMemory);assert.equal(store.lifecycle.outcome(full.scope,request.id,request.text),null);
        const seen=new Set(input.sources.map(source=>source.id));
        const handles=input.sources.filter(source=>source.id===raw.id||source.id===request.id||source.messageRole==='assistant');
        const retainSources:SourceRetention[]=[];
        if(phases.length===1){
          assert.equal(input.sources.length,43);assert.equal(input.messages.length,42);
          for(const [index,source] of assistants.entries()){
            const support=source.sourceVersions!.map(ref=>({ref,record:store.inspect(full.scope,ref.id)!})).filter(item=>item.record?.message?.role==='user'&&item.record.id!==raw.id&&item.record.id!==request.id).sort((a,b)=>(b.record.logicalOrder??0)-(a.record.logicalOrder??0))[0]!;
            assert.ok(seen.has(support.ref.id));assert.ok(!source.text.includes('团子'));
            retainSources.push({source:{id:source.id,version:source.version},fragmentId:`f${index}`,start:0,end:[...source.text].length,supportSourceIds:[support.ref.id]});
          }
        }
        const plan:MemoryTurnPlan={scope:input.scope,request:'forget',reason:'Controlled discovery first; preserve verified unrelated fragments only in the complete final plan',clarification:null,
          changes:[{scope:input.scope,operationId:'controlled-expanded-delete-cat',reason:'Synthetic requested forgetting',createdAt:store.now(),operation:{type:'soft_delete',id:memory.id,expectedVersion:memory.version}}],
          suppressSources:handles.filter(source=>mode!=='known_omission'||source.id!==assistants[0]!.id).map(source=>({id:source.id,version:source.version})),retainSources};
        phases.push({input,upperBound:memoryTurnInputUpperBound(input),plan});return plan;
      }};
      const port=new SqliteLifecycleMemoryPort(store,{context:{maxRecentMessages:24,maxMemories:32,summaryLimit:8,inputTokenBudget:32768,countTokens:contextInputUpperBound,relevance:()=>1},turn:{provider,inputTokenBudget:32768,countTokens:memoryTurnInputUpperBound,...(mode==='disabled'?{}:{maxSupplementaryPlans:1})},summary:{provider:{async summarize(input){return {scope:input.scope,text:input.sources.map(source=>source.text).join('\n'),sourceVersions:input.sources.map(source=>({id:source.id,version:source.version}))};}},minMessages:4,maxMessages:4,inputTokenBudget:32768,countTokens:summaryInputUpperBound}});
      const outcome=await port.prepareTurn(full.scope,request.id,request.text,new AbortController().signal);
      assert.ok(phases.every(phase=>phase.upperBound<=32768));assert.equal(phases[0]!.input.messages.length,24);
      if(mode==='enabled'){
        assert.equal(phases.length,2);assert.equal(outcome.status,'applied',outcome.rejectionCode??'');
        assert.equal(store.inspect(full.scope,memory.id)!.state,'deleted');assert.equal(store.inspect(full.scope,raw.id)!.state,'invalidated');assert.equal(store.search(full.scope,'团子',32).length,0);
        const preserved=store.visible(full.scope,'transcript').filter(record=>record.fragment);assert.equal(preserved.length,20);
        for(const source of assistants){assert.equal(store.inspect(full.scope,source.id)!.state,'invalidated');assert.ok(preserved.some(record=>record.fragment!.parent.id===source.id&&record.text===source.text));}
        for(const source of unrelated){assert.equal(store.inspect(full.scope,source.id)!.state,'active');assert.equal(store.inspect(full.scope,source.id)!.text,source.text);}
        const summary=await port.summarizePending(full.scope,new AbortController().signal);assert.equal(summary.status,'applied');assert.ok(store.visible(full.scope,'summary').every(record=>!record.text.includes('团子')));
        store.close();store=f.open();assert.equal(store.search(full.scope,'团子',32).length,0);assert.ok(store.contextRecords(full.scope,'猫叫什么',24,32,8).recent.every(message=>!message.text.includes('团子')));
      }else{
        assert.equal(phases.length,1);assert.equal(outcome.status,'rejected');assert.equal(outcome.rejectionCode,mode==='disabled'?'unread_preservation_support':'unresolved_source_disposition');
        assert.equal(store.revision(full.scope),beforeRevision);assert.deepEqual(store.inspect(full.scope,memory.id),beforeMemory);assert.equal(store.lifecycle.outcome(full.scope,request.id,request.text),null);
        assert.equal(store.visible(full.scope,'transcript').filter(record=>record.fragment).length,0);
      }
      scenarios.push({mode,outcome,phases,firstPlanBusinessWrites:0,unrelatedUsersRetained:unrelated.every(source=>store.inspect(full.scope,source.id)!.state==='active'),preservedAssistantFragments:store.visible(full.scope,'transcript').filter(record=>record.fragment).length,restartRecallContainsTarget:store.search(full.scope,'团子',32).length>0});
    }finally{f.cleanup();}
  }
  assert.equal(digest(readFileSync(filename)),originalHash);assert.equal(digest(readFileSync(snapshotPath)),inputHash);
  return {baseRef:'808e060071893baa660dd4c77c5dfeb74013537e',codeRef:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),actualProvider:false,networkCalls:0,actualSqlite:true,originalDatabaseUnchanged:true,originalDatabaseSha256:originalHash,originalInputFileSha256:inputHash,inputBudget:32768,recentSampleLimit:24,scenarios,semanticAcceptance:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const [directory,output]=process.argv.slice(2);if(!directory||!output)throw Error('snapshot directory and evidence output required');
  const result=await checkPinnedSnapshot(resolve(directory));writeFileSync(resolve(output),JSON.stringify(result,null,2)+'\n');
  process.stdout.write(JSON.stringify(result.scenarios.map(s=>({mode:s.mode,status:s.outcome.status,code:s.outcome.rejectionCode,calls:s.phases.length,inputBytes:s.phases.map(p=>p.upperBound),preservedAssistants:s.preservedAssistantFragments})))+'\n');
}
