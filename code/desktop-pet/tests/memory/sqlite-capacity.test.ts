import test from 'node:test';
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { fixture, scope, message, change, NOW } from './sqlite-fixture.js';

test('A13: actual 300000000 UTF-8 bytes in the single companion hit the configured boundary; next 4 bytes evict the oldest',t=>{
  const f=fixture();t.after(f.cleanup);const store=f.open();
  const text='x'.repeat(30_000_000);
  for(let index=0;index<10;index++) {
    const role='companion';
    store.append(scope(role),[message(`raw-${index}`,text,role,new Date(Date.parse(NOW)+index*1000).toISOString())]);
    if(index===0) assert.equal(store.apply(change({type:'add',id:'keep',text:'必须独立保留的重要记忆',sourceIds:['raw-0']},'keep')).status,'applied');
  }
  assert.equal(store.transcriptBytes(),300_000_000);
  store.append(scope('companion'),[message('emoji','🙂','companion','2026-09-06T12:01:00Z')]);
  assert.equal(store.transcriptBytes(),270_000_004);
  assert.equal(store.inspect(scope(),'raw-0')!.state,'expired');
  assert.equal(store.search(scope(),'重要记忆',10).length,1);
  assert.equal(store.inspect(scope('companion'),'emoji')!.text,'🙂');
  t.diagnostic(`real_boundary_bytes=300000000 after_eviction_bytes=${store.transcriptBytes()} database_file_bytes=${statSync(f.filename).size}`);
});
