import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CharacterPackStore } from '../../memory/character-pack-store.js';
import { productionPairing } from '../../contracts/character-pack.js';

function createTempDb(): { db: Database.Database; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'timeline-latest-test-'));
  const filename = join(dir, 'test-timeline.db');
  const db = new Database(filename);
  return {
    db,
    cleanup: () => {
      try { db.close(); } catch {}
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    },
  };
}

test('N075-01 R9: getSnapshot selects the LATEST N companion timeline events in chronological order', async t => {
  const { db, cleanup } = createTempDb();
  t.after(cleanup);

  const store = await CharacterPackStore.open(db);
  const pairing = productionPairing('companion', 'test-inst');

  // Insert 10 events with sequential timestamps from 10:01 to 10:10
  for (let i = 1; i <= 10; i++) {
    const minute = String(i).padStart(2, '0');
    store.appendCompanionEvent({
      userId: pairing.userId,
      characterId: pairing.characterId,
      characterInstanceId: pairing.characterInstanceId,
      sessionId: 'session-1',
      turnId: `turn-${i}`,
      userText: `User event ${i}`,
      assistantText: `Assistant event ${i}`,
      createdAt: `2026-09-01T10:${minute}:00.000Z`,
    });
  }

  // Request snapshot with maxCompanionEvents: 3
  const snapshot = await store.getSnapshot(pairing, { maxCompanionEvents: 3 });

  assert.equal(snapshot.companionTimeline.length, 3, 'Must return exactly 3 events');

  // Verify that the LATEST 3 events (8, 9, 10) were selected, NOT the oldest (1, 2, 3)!
  const texts = snapshot.companionTimeline.map(e => e.userText);
  assert.deepEqual(
    texts,
    ['User event 8', 'User event 9', 'User event 10'],
    'Must select the latest 3 events in forward chronological order',
  );

  // Verify timestamps are strictly increasing
  const times = snapshot.companionTimeline.map(e => new Date(e.createdAt).getTime());
  assert.ok(times[0]! < times[1]! && times[1]! < times[2]!, 'Returned events must maintain chronological order');
});
