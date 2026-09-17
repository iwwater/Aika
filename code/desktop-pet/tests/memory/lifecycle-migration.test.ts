import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fixture, scope, seed } from './sqlite-fixture.js';
import { SqliteMemoryStore } from '../../memory/sqlite-store.js';
import { COMPANION_DATABASE_ID, COMPANION_SCHEMA_VERSION } from '../../memory/database-identity.js';

function diskSnapshot(directory:string) {
  return readdirSync(directory).sort().map(name=>({name,sha256:createHash('sha256').update(readFileSync(join(directory,name))).digest('hex')}));
}
for (const version of [1,2,3]) test(`A10: old PET1 schema ${version} is rejected before modifying database or creating WAL/SHM`,t=>{
  const f=fixture();t.after(f.cleanup);
  const old=new Database(f.filename);
  old.exec(`PRAGMA application_id=1346720817; PRAGMA user_version=${version};
    CREATE TABLE characters(character_id TEXT PRIMARY KEY,prompt TEXT); INSERT INTO characters VALUES('friend','old friend'),('sweetheart','old relationship');
    CREATE TABLE memory_records(character_id TEXT,id TEXT,text TEXT); INSERT INTO memory_records VALUES('friend','old','synthetic-old-private-memory');`);
  old.close();
  const before=diskSnapshot(f.directory);
  assert.throws(()=>f.open(),/legacy_database_requires_new_path/);
  assert.deepEqual(diskSnapshot(f.directory),before);
  t.diagnostic(JSON.stringify({legacyVersion:version,before,after:diskSnapshot(f.directory),writes:0}));
});

test('A10: rejection also leaves an open old WAL database and its sidecar bytes untouched',t=>{
  const f=fixture();t.after(f.cleanup);const old=new Database(f.filename);t.after(()=>old.close());
  old.exec('PRAGMA application_id=1346720817; PRAGMA user_version=3; CREATE TABLE characters(character_id TEXT)');
  old.pragma('journal_mode=WAL');old.exec("INSERT INTO characters VALUES('friend')");
  const before=diskSnapshot(f.directory);assert.ok(before.some(file=>file.name.endsWith('-wal')));
  assert.throws(()=>f.open(),/legacy_database_requires_new_path/);assert.deepEqual(diskSnapshot(f.directory),before);
});

test('A10: same-product schema reopening preserves records, edited prompt, and the acknowledged introduction',t=>{
  const f=fixture();t.after(f.cleanup);let store=f.open();seed(store);store.setPrompt(scope(),'用户定制的性格');
  store.acknowledgeIntroduction(store.introduction()!.id);const record=store.inspect(scope(),'job'),revision=store.revision(scope());store.close();
  for(let upgrade=0;upgrade<3;upgrade++){
    store=f.open();assert.deepEqual(store.inspect(scope(),'job'),record);assert.equal(store.prompt(scope()),'用户定制的性格');
    assert.equal(store.revision(scope()),revision);assert.equal(store.introduction(),null);store.close();
  }
  const db=new Database(f.filename,{readonly:true});t.after(()=>db.close());
  assert.equal(db.pragma('application_id',{simple:true}),COMPANION_DATABASE_ID);assert.equal(db.pragma('user_version',{simple:true}),COMPANION_SCHEMA_VERSION);
  assert.deepEqual(db.prepare('SELECT character_id FROM characters').all(),[{character_id:'companion'}]);
});

test('future unsupported product schema and false companion registry reject before schema setup',t=>{
  const f=fixture();t.after(f.cleanup);f.open().close();let db=new Database(f.filename);db.pragma('user_version=999');db.close();
  let before=diskSnapshot(f.directory);assert.throws(()=>f.open(),/unsupported_database_schema/);assert.deepEqual(diskSnapshot(f.directory),before);
  db=new Database(f.filename);db.pragma(`user_version=${COMPANION_SCHEMA_VERSION}`);db.pragma('ignore_check_constraints=ON');db.prepare("UPDATE characters SET character_id='friend'").run();db.close();
  before=diskSnapshot(f.directory);assert.throws(()=>new SqliteMemoryStore(f.options),/invalid_product_registry/);assert.deepEqual(diskSnapshot(f.directory),before);
});
