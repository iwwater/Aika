import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CharacterPackStore } from '../../memory/character-pack-store.js';
import type {
  CharacterPackDraftPayload,
  DraftValidationResult,
  PairingScope,
} from '../../contracts/character-pack.js';
import { CharacterPackError } from '../../contracts/character-pack.js';

function createTempDb(): { db: Database.Database; filename: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'cp-activation-test-'));
  const filename = join(dir, 'test-activation.db');
  const db = new Database(filename);
  return {
    db,
    filename,
    cleanup: () => {
      try { db.close(); } catch {}
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    },
  };
}

async function seedValidDraft(
  store: CharacterPackStore,
  characterId: string,
  docName: string,
  docText: string,
  factText: string,
): Promise<{ draftId: string; sourceId: string }> {
  const src = await store.importSource(characterId, { sourceName: docName, text: docText });
  const payload: CharacterPackDraftPayload = {
    schemaVersion: '0.7-draft-1',
    character: { name: '沈砚', soul: '重诺守信的观察者' },
    canonFacts: [
      { id: 'f-1', text: factText, status: 'explicit', evidenceIds: [src.snapshot.blocks[0]!.id] },
    ],
    gaps: ['早年经历未知'],
  };
  const validation: DraftValidationResult = {
    valid: true,
    errors: [],
    validatedAt: new Date().toISOString(),
  };
  const draft = await store.saveDraft({
    characterId,
    payload,
    sourceIds: [src.snapshot.id],
    validation,
  });
  return { draftId: draft.id, sourceId: src.snapshot.id };
}

test('N07-03 Activation: previewDraft inspects draft projection without activating', async t => {
  const { db, cleanup } = createTempDb();
  t.after(cleanup);

  const store = await CharacterPackStore.open(db);
  const { draftId } = await seedValidDraft(store, 'companion', 'c1.txt', '沈砚在临海城生活。', '沈砚在临海城生活。');

  const preview = await store.previewDraft(draftId);
  assert.equal(preview.draft.id, draftId);
  assert.equal(preview.packPreview.name, '沈砚');
  assert.equal(preview.packPreview.canonTimeline.length, 1);
  assert.deepEqual(preview.warnings, []);

  // Assert nothing was actually inserted into character_packs yet
  assert.equal(store.listPacks('companion').length, 0);
});

test('N07-03 Activation: rejected draft cannot be activated', async t => {
  const { db, cleanup } = createTempDb();
  t.after(cleanup);

  const store = await CharacterPackStore.open(db);
  const rejectedDraft = await store.saveDraft({
    characterId: 'companion',
    payload: {
      schemaVersion: '0.7-draft-1',
      character: { name: '沈砚', soul: '稳重' },
      canonFacts: [],
      gaps: [],
    },
    sourceIds: [],
    validation: {
      valid: false,
      errors: ['缺少 Canon 事实'],
      validatedAt: new Date().toISOString(),
    },
  });

  await assert.rejects(
    async () => {
      await store.activateDraft({
        characterId: 'companion',
        draftId: rejectedDraft.id,
      });
    },
    (err: any) =>
      err instanceof CharacterPackError &&
      err.code === 'validation_failed' &&
      err.message.includes('草稿尚未通过校验'),
  );
});

test('N07-03 Activation: activate and upgrade atomically update instance pointer and history', async t => {
  const { db, cleanup } = createTempDb();
  t.after(cleanup);

  const store = await CharacterPackStore.open(db);

  // 1. Initial activation (v1.0)
  const d1 = await seedValidDraft(store, 'companion', 'c1.txt', '沈砚在临海城生活。', '沈砚在临海城生活。');
  const pack1 = await store.activateDraft({
    characterId: 'companion',
    draftId: d1.draftId,
    userId: 'user-alice',
    instanceId: 'inst-1',
    packVersion: 'v1.0',
  });

  assert.equal(pack1.packVersion, 'v1.0');
  assert.equal(pack1.characterId, 'companion');

  const inst1 = store.getInstance('user-alice', 'companion', 'inst-1');
  assert.ok(inst1);
  assert.equal(inst1!.activePackId, pack1.id);
  assert.equal(inst1!.activePackVersion, 'v1.0');

  // 2. Upgrade to v2.0
  const d2 = await seedValidDraft(store, 'companion', 'c2.txt', '暴雨夜沈砚留伞。', '暴雨夜沈砚留伞。');
  const pack2 = await store.activateDraft({
    characterId: 'companion',
    draftId: d2.draftId,
    userId: 'user-alice',
    instanceId: 'inst-1',
    packVersion: 'v2.0',
  });

  assert.equal(pack2.packVersion, 'v2.0');
  const instAfterUpgrade = store.getInstance('user-alice', 'companion', 'inst-1');
  assert.equal(instAfterUpgrade!.activePackId, pack2.id);
  assert.equal(instAfterUpgrade!.activePackVersion, 'v2.0');

  // Verify pack count
  assert.equal(store.listPacks('companion').length, 2);
});

test('N07-03 Activation: rollback restores previous version', async t => {
  const { db, cleanup } = createTempDb();
  t.after(cleanup);

  const store = await CharacterPackStore.open(db);

  const d1 = await seedValidDraft(store, 'companion', 'c1.txt', '事实一', '事实一');
  const pack1 = await store.activateDraft({
    characterId: 'companion',
    draftId: d1.draftId,
    userId: 'user-alice',
    instanceId: 'inst-1',
    packVersion: 'v1.0',
  });

  const d2 = await seedValidDraft(store, 'companion', 'c2.txt', '事实二', '事实二');
  await store.activateDraft({
    characterId: 'companion',
    draftId: d2.draftId,
    userId: 'user-alice',
    instanceId: 'inst-1',
    packVersion: 'v2.0',
  });

  // Rollback to v1.0
  const rolledBackPack = await store.rollback({
    characterId: 'companion',
    userId: 'user-alice',
    instanceId: 'inst-1',
    targetPackVersion: 'v1.0',
    reason: '测试版本回退',
  });

  assert.equal(rolledBackPack.id, pack1.id);
  assert.equal(rolledBackPack.packVersion, 'v1.0');

  const inst = store.getInstance('user-alice', 'companion', 'inst-1');
  assert.equal(inst!.activePackId, pack1.id);
  assert.equal(inst!.activePackVersion, 'v1.0');
});

test('N07-03 Activation: rollback CANNOT bypass source revocation', async t => {
  const { db, cleanup } = createTempDb();
  t.after(cleanup);

  const store = await CharacterPackStore.open(db);

  // v1.0 uses source 1
  const d1 = await seedValidDraft(store, 'companion', 'v1_doc.txt', '第一版资料正文', '第一版事实');
  await store.activateDraft({
    characterId: 'companion',
    draftId: d1.draftId,
    userId: 'user-alice',
    instanceId: 'inst-1',
    packVersion: 'v1.0',
  });

  // v2.0 uses source 2
  const d2 = await seedValidDraft(store, 'companion', 'v2_doc.txt', '第二版资料正文', '第二版事实');
  await store.activateDraft({
    characterId: 'companion',
    draftId: d2.draftId,
    userId: 'user-alice',
    instanceId: 'inst-1',
    packVersion: 'v2.0',
  });

  // Now source 1 is revoked! (e.g. user requested forget/revocation of that source)
  store.revokeSource('companion', d1.sourceId, '用户要求遗忘第一版来源资料');

  // Attempt to rollback to v1.0 MUST FAIL!
  await assert.rejects(
    async () => {
      await store.rollback({
        characterId: 'companion',
        userId: 'user-alice',
        instanceId: 'inst-1',
        targetPackVersion: 'v1.0',
      });
    },
    (err: any) =>
      err instanceof CharacterPackError &&
      err.code === 'version_conflict' &&
      err.message.includes('回退旧 pack 不能绕过来源撤销'),
  );
});

test('N07-03 Activation: A/B character instances are strictly isolated', async t => {
  const { db, cleanup } = createTempDb();
  t.after(cleanup);

  const store = await CharacterPackStore.open(db);

  const d1 = await seedValidDraft(store, 'companion', 'c1.txt', '沈砚设定', '沈砚设定事实');
  const pack1 = await store.activateDraft({
    characterId: 'companion',
    draftId: d1.draftId,
    userId: 'user-alice',
    instanceId: 'inst-A',
    packVersion: 'v1.0',
  });

  // Activate inst-B with pack1
  await store.activateDraft({
    characterId: 'companion',
    draftId: d1.draftId,
    userId: 'user-alice',
    instanceId: 'inst-B',
    packVersion: 'v1.0', // already exists, but instance pointer created
  }).catch(() => {
    // If packVersion exists, we can activate draft as v2 or reuse pack
  });

  // Explicitly set inst-B to point to pack1
  const d2 = await seedValidDraft(store, 'companion', 'c2.txt', '沈砚升级设定', '升级事实');
  const pack2 = await store.activateDraft({
    characterId: 'companion',
    draftId: d2.draftId,
    userId: 'user-alice',
    instanceId: 'inst-B',
    packVersion: 'v2.0',
  });

  // Verify inst-A still on v1.0 while inst-B on v2.0
  const instA = store.getInstance('user-alice', 'companion', 'inst-A');
  const instB = store.getInstance('user-alice', 'companion', 'inst-B');

  assert.equal(instA!.activePackId, pack1.id);
  assert.equal(instA!.activePackVersion, 'v1.0');

  assert.equal(instB!.activePackId, pack2.id);
  assert.equal(instB!.activePackVersion, 'v2.0');

  // Add companion timeline event to inst-A
  store.appendCompanionEvent({
    userId: 'user-alice',
    characterId: 'companion',
    characterInstanceId: 'inst-A',
    sessionId: 'sess-1',
    turnId: 'turn-1',
    userText: '你好，我是测试用户。',
    assistantText: '你好，我是沈砚。',
  });

  // Snapshot of inst-A has companion event
  const snapA = await store.getSnapshot({
    userId: 'user-alice',
    characterId: 'companion',
    characterInstanceId: 'inst-A',
  });
  assert.equal(snapA.companionTimeline.length, 1);
  assert.equal(snapA.companionTimeline[0]!.userText, '你好，我是测试用户。');

  // Snapshot of inst-B has ZERO companion events (isolated!)
  const snapB = await store.getSnapshot({
    userId: 'user-alice',
    characterId: 'companion',
    characterInstanceId: 'inst-B',
  });
  assert.equal(snapB.companionTimeline.length, 0);
});

test('N07-03 Continuity: dual timelines maintain independent ordering and cutoff filtering', async t => {
  const { db, cleanup } = createTempDb();
  t.after(cleanup);

  const store = await CharacterPackStore.open(db);

  const src = await store.importSource('companion', {
    sourceName: 'story.md',
    text: [
      '# 第一章 临海城',
      '',
      '沈砚在临海城生活。',
      '',
      '# 第二章 暴雨夜',
      '',
      '暴雨夜沈砚留伞。',
      '',
      '# 第三章 远行',
      '',
      '多年后沈砚远行。',
    ].join('\n'),
  });

  const payload: CharacterPackDraftPayload = {
    schemaVersion: '0.7-draft-1',
    character: { name: '沈砚', soul: '沉着' },
    canonFacts: [
      { id: 'f-ch1', text: '沈砚在临海城生活。', status: 'explicit', evidenceIds: [src.snapshot.blocks[0]!.id] },
      { id: 'f-ch2', text: '暴雨夜沈砚留伞。', status: 'explicit', evidenceIds: [src.snapshot.blocks[1]!.id] },
      { id: 'f-ch3', text: '多年后沈砚远行。', status: 'explicit', evidenceIds: [src.snapshot.blocks[2]!.id] },
    ],
    gaps: [],
    cutoffPoint: '第二章 暴雨夜',
  };

  const draft = await store.saveDraft({
    characterId: 'companion',
    payload,
    sourceIds: [src.snapshot.id],
    validation: { valid: true, errors: [], validatedAt: new Date().toISOString() },
  });

  await store.activateDraft({
    characterId: 'companion',
    draftId: draft.id,
    userId: 'user-1',
    instanceId: 'inst-main',
    packVersion: 'v1.0',
  });

  store.appendCompanionEvent({
    userId: 'user-1',
    characterId: 'companion',
    characterInstanceId: 'inst-main',
    sessionId: 'sess-1',
    turnId: 'turn-1',
    userText: '今晚下雨了。',
    assistantText: '出门记得带伞。',
  });

  const pairing: PairingScope = {
    userId: 'user-1',
    characterId: 'companion',
    characterInstanceId: 'inst-main',
  };

  // 1. Normal snapshot: cutoffPoint excludes Chapter 3 event
  const snapshot = await store.getSnapshot(pairing, { cutoffPoint: '第二章 暴雨夜' });

  assert.equal(snapshot.canonTimeline.length, 2);
  assert.equal(snapshot.canonTimeline[0]!.summary, '沈砚在临海城生活。');
  assert.equal(snapshot.canonTimeline[1]!.summary, '暴雨夜沈砚留伞。');

  assert.equal(snapshot.companionTimeline.length, 1);
  assert.equal(snapshot.companionTimeline[0]!.assistantText, '出门记得带伞。');

  // Timelines have different ordering keys:
  // canonTimeline has ordinal (0, 1)
  assert.equal(snapshot.canonTimeline[0]!.ordinal, 0);
  assert.equal(snapshot.canonTimeline[1]!.ordinal, 1);

  // companionTimeline has real ISO timestamp
  assert.ok(snapshot.companionTimeline[0]!.createdAt.includes('T'));
});
