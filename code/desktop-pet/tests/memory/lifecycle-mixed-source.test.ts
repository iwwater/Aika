import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, scope, message, change, NOW } from './sqlite-fixture.js';
import { lifecycle, none, signal } from './lifecycle-fixture.js';
import type { SqliteMemoryStore } from '../../memory/sqlite-store.js';
function seedMixed(store:SqliteMemoryStore) {
  store.append(scope(),[message('mixed','面试失败了，另外我养的猫叫团子'),message('request','请忘记那次面试失败的事情，保留猫名')]);
  store.apply(change({type:'add',id:'interview',text:'面试失败了',sourceIds:['mixed']},'interview'));
  store.apply(change({type:'add',id:'cat',text:'用户养的猫叫团子',sourceIds:['mixed']},'cat'));
  store.recordDerived(scope(),{id:'mixed-summary',kind:'summary',text:'面试失败，猫叫团子',sourceIds:['mixed'],createdAt:NOW});
}

test('evidence: legacy whole-source suppression also hides unrelated cat memory from the same source',t=>{
  const f=fixture();t.after(f.cleanup);const store=f.open();seedMixed(store);
  const result=store.apply(change({type:'soft_delete',id:'interview',expectedVersion:1},'unsafe-whole-source'),['mixed']);
  assert.equal(result.status,'applied');assert.equal(store.inspect(scope(),'cat')!.state,'deleted');assert.equal(store.search(scope(),'团子',10).length,0);
  t.diagnostic('counterexample_only: legacy_whole_source=true interview=deleted cat=deleted summary=invalidated; unacceptable collateral loss, not acceptance');
});

for(const suppression of ['explicit','inferred'] as const) test(`${suppression} suppression refuses unresolved cat-memory collateral and rolls back the entire turn across restart`,async t=>{
  const f=fixture();t.after(f.cleanup);let store=f.open();seedMixed(store);
  const port=lifecycle(store,async input=>({...none(input),request:'forget',changes:[change({type:'soft_delete',id:'interview',expectedVersion:1},'forget-interview',input.scope)],suppressSources:suppression==='explicit'?[{id:'mixed',version:1}]:[]}));
  const outcome=await port.prepareTurn(scope(),'request','请忘记那次面试失败的事情，保留猫名',signal());
  assert.equal(outcome.status,'rejected');assert.equal(outcome.results[0]!.reason,'unresolved_memory_suppression');assert.deepEqual(outcome.affectedIds,[]);
  assert.equal(store.inspect(scope(),'interview')!.state,'active');assert.equal(store.inspect(scope(),'cat')!.state,'active');assert.equal(store.inspect(scope(),'mixed-summary')!.state,'active');
  assert.equal(store.inspect(scope(),'request')!.state,'active');store.close();store=f.open();
  assert.equal(store.search(scope(),'团子',10).length,1);assert.equal(store.search(scope(),'面试',10).length,1);assert.equal(store.lifecycle.outcome(scope(),'request','请忘记那次面试失败的事情，保留猫名'),null);
  t.diagnostic(`s3_guard=${suppression} outcome=rejected restart_interview=active restart_cat=active no_partial_confirmation=true`);
});
