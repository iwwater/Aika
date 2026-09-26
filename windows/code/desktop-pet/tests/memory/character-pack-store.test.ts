import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CharacterPackDraftStore } from '../../memory/character-pack-store.js';
import type {
  CharacterPackDraftPayload,
  DraftValidationResult,
} from '../../contracts/character-pack.js';

function createTempDb(): { db: Database.Database; filename: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'cp-store-test-'));
  const filename = join(dir, 'test-pack.db');
  const db = new Database(filename);
  return {
    db,
    filename,
    cleanup: () => {
      try {
        db.close();
      } catch {}
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    },
  };
}

test('N07-01 Store: source import is idempotent on identical content hash', async t => {
  const { db, cleanup } = createTempDb();
  t.after(cleanup);

  const store = await CharacterPackDraftStore.open(db);
  const file = {
    sourceName: 'canon.txt',
    text: '沈砚生于临海城。\n\n他自幼在码头长大，善于审时度势。',
  };

  // First import
  const r1 = await store.importSource('companion', file);
  assert.equal(r1.isDuplicate, false);
  assert.equal(r1.snapshot.characterId, 'companion');
  assert.equal(r1.snapshot.blocks.length, 2);

  // Second import of identical file
  const r2 = await store.importSource('companion', file);
  assert.equal(r2.isDuplicate, true);
  assert.equal(r2.snapshot.id, r1.snapshot.id);
  assert.equal(r2.snapshot.contentHash, r1.snapshot.contentHash);

  // Verify DB row counts
  const countSources = db.prepare('SELECT COUNT(*) as count FROM character_pack_sources').get() as { count: number };
  assert.equal(countSources.count, 1);

  const countBlocks = db.prepare('SELECT COUNT(*) as count FROM character_pack_source_blocks').get() as { count: number };
  assert.equal(countBlocks.count, 2);
});

test('N07-01 Store: batch import sources is atomic', async t => {
  const { db, cleanup } = createTempDb();
  t.after(cleanup);

  const store = await CharacterPackDraftStore.open(db);
  const files = [
    { sourceName: 'file1.txt', text: '内容一' },
    { sourceName: 'file2.md', text: '内容二' },
  ];

  const result = await store.importSources('companion', files);
  assert.equal(result.snapshots.length, 2);
  assert.equal(result.duplicates.length, 0);

  // Re-importing batch detects duplicates
  const result2 = await store.importSources('companion', files);
  assert.equal(result2.snapshots.length, 2);
  assert.equal(result2.duplicates.length, 2);
});

test('N07-01 Store: draft persistence saves validated and rejected drafts', async t => {
  const { db, cleanup } = createTempDb();
  t.after(cleanup);

  const store = await CharacterPackDraftStore.open(db);
  const s = await store.importSource('companion', {
    sourceName: 'doc.txt',
    text: '沈砚在临海城守护旧码头。',
  });

  const payload: CharacterPackDraftPayload = {
    schemaVersion: '0.7-draft-1',
    character: { name: '沈砚', soul: '沉默守护者' },
    canonFacts: [
      { id: 'f1', text: '沈砚在临海城守护旧码头。', evidenceIds: [s.snapshot.blocks[0]!.id] },
    ],
    gaps: [],
  };

  const validation: DraftValidationResult = {
    valid: true,
    errors: [],
    validatedAt: new Date().toISOString(),
  };

  const draft = await store.saveDraft({
    characterId: 'companion',
    payload,
    sourceIds: [s.snapshot.id],
    validation,
  });

  assert.equal(draft.status, 'validated');
  assert.equal(draft.characterId, 'companion');
  assert.equal(draft.payload.character.name, '沈砚');

  // Verify retrieval
  const loaded = store.getDraft(draft.id);
  assert.ok(loaded);
  assert.equal(loaded!.id, draft.id);
  assert.equal(loaded!.status, 'validated');
  assert.deepEqual(loaded!.payload, payload);

  // Save a rejected draft
  const rejectedDraft = await store.saveDraft({
    characterId: 'companion',
    payload,
    sourceIds: [s.snapshot.id],
    validation: {
      valid: false,
      errors: ['引用了伪造证据'],
      validatedAt: new Date().toISOString(),
    },
  });

  assert.equal(rejectedDraft.status, 'rejected');
  const loadedRejected = store.getDraft(rejectedDraft.id);
  assert.equal(loadedRejected!.status, 'rejected');
  assert.deepEqual(loadedRejected!.validation.errors, ['引用了伪造证据']);
});

test('N07-01 Store: failed transaction leaves no partial data in database', async t => {
  const { db, cleanup } = createTempDb();
  t.after(cleanup);

  const store = await CharacterPackDraftStore.open(db);

  // Inject a trigger that forces failure on draft insert with special keyword
  db.exec(`
    CREATE TRIGGER fail_on_boom BEFORE INSERT ON character_pack_drafts
    WHEN NEW.id LIKE '%BOOM%'
    BEGIN
      SELECT RAISE(FAIL, 'simulated_disk_failure');
    END;
  `);

  const payload: CharacterPackDraftPayload = {
    schemaVersion: '0.7-draft-1',
    character: { name: '测试', soul: '测试' },
    canonFacts: [],
    gaps: [],
  };

  await assert.rejects(
    async () => {
      await store.saveDraft({
        draftId: 'cpd-BOOM-123',
        characterId: 'companion',
        payload,
        sourceIds: [],
        validation: { valid: true, errors: [], validatedAt: '' },
      });
    },
    /simulated_disk_failure/,
  );

  // Check that no draft was inserted
  const drafts = store.listDrafts('companion');
  assert.equal(drafts.length, 0);
});

test('N07-01 Store: restart recovery reloads sources and drafts completely', async t => {
  const { db: initialDb, filename, cleanup } = createTempDb();
  t.after(cleanup);

  // 1. Initial process session
  const store1 = await CharacterPackDraftStore.open(initialDb);
  const src = await store1.importSource('companion', {
    sourceName: 'story.txt',
    text: '第一章 启程\n\n沈砚离开旧城。',
  });

  const draft = await store1.saveDraft({
    characterId: 'companion',
    payload: {
      schemaVersion: '0.7-draft-1',
      character: { name: '沈砚', soul: '决绝而内敛' },
      canonFacts: [{ id: 'f1', text: '沈砚离开旧城。', evidenceIds: [src.snapshot.blocks[0]!.id] }],
      gaps: [],
    },
    sourceIds: [src.snapshot.id],
    validation: { valid: true, errors: [], validatedAt: new Date().toISOString() },
  });

  // Close initial database connection (simulating shutdown)
  initialDb.close();

  // 2. Restarted process session
  const reopenedDb = new Database(filename);
  const store2 = await CharacterPackDraftStore.open(reopenedDb);

  // Verify source restored
  const restoredSrc = store2.getSource(src.snapshot.id);
  assert.ok(restoredSrc);
  assert.equal(restoredSrc!.sourceName, 'story.txt');
  assert.equal(restoredSrc!.contentHash, src.snapshot.contentHash);
  assert.equal(restoredSrc!.blocks.length, src.snapshot.blocks.length);
  assert.equal(restoredSrc!.blocks[0]!.id, src.snapshot.blocks[0]!.id);
  assert.equal(restoredSrc!.blocks[0]!.text, src.snapshot.blocks[0]!.text);

  // Verify draft restored
  const restoredDraft = store2.getDraft(draft.id);
  assert.ok(restoredDraft);
  assert.equal(restoredDraft!.status, 'validated');
  assert.equal(restoredDraft!.characterId, 'companion');
  assert.equal(restoredDraft!.payload.character.name, '沈砚');
  assert.deepEqual(restoredDraft!.sourceIds, [src.snapshot.id]);

  reopenedDb.close();
});

test('N07-01 Store: character isolation ensures separate namespaces', async t => {
  const { db, cleanup } = createTempDb();
  t.after(cleanup);

  const store = await CharacterPackDraftStore.open(db);

  await store.importSource('char_a', { sourceName: 'a.txt', text: '角色 A 的设定' });
  await store.importSource('char_b', { sourceName: 'b.txt', text: '角色 B 的设定' });

  const sourcesA = store.listSources('char_a');
  const sourcesB = store.listSources('char_b');

  assert.equal(sourcesA.length, 1);
  assert.equal(sourcesA[0]!.sourceName, 'a.txt');

  assert.equal(sourcesB.length, 1);
  assert.equal(sourcesB[0]!.sourceName, 'b.txt');
});
