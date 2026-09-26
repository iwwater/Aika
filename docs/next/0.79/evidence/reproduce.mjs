// Review-only. Run from windows/code/desktop-pet after building. No user data/network.
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const require = createRequire(resolve('package.json'));
const Database = require('better-sqlite3');
const load = path => import(pathToFileURL(resolve('dist', path)).href);
const { ContinuityMemoryStore } = await load('memory/continuity-memory-store.js');
const { CharacterPackStore } = await load('memory/character-pack-store.js');
const { CharacterDistiller } = await load('providers/character-distiller.js');
const { computeCutoffAllowedBlockIds } = await load('memory/character-pack-validator.js');
const db = new Database(':memory:');
try {
  const mem = await ContinuityMemoryStore.open(db), packs = await CharacterPackStore.open(db);
  const pairing = { userId: 'u', characterId: 'companion', characterInstanceId: 'i' };
  const root = mem.record({ pairing, operationId: 'root', layer: 'user_wiki', kind: 'fact', text: 'synthetic source fact', origin: 'user', status: 'active' }).fact;
  const derived = mem.commitDerived({ lease: mem.beginDerived(pairing), operationId: 'derived', layer: 'user_soul', kind: 'inference', text: 'synthetic derived fact', sourceIds: [root.id], status: 'active' }).fact;
  mem.forget({ pairing, operationId: 'forget', targetId: root.id, expectedVersion: 1, reason: 'review' });
  console.log(JSON.stringify({ probe: 'derived-after-forget', sourceGone: mem.snapshot(pairing).wiki.length === 0, derivedStillActive: mem.snapshot(pairing).soul.some(f => f.id === derived.id) }));
  const { snapshot } = await packs.importSource('companion', { sourceName: 'fixture.md', text: '# Chapter One\n\nA character lives in a small town.\n\n# Chapter Two\n\nA later secret is revealed.' });
  const distiller = new CharacterDistiller({ endpoint: 'https://unit.invalid', model: 'fixture', apiKey: () => '', authorizer: { authorize: async () => ({ settle: async () => {} }) } }, {
    store: packs,
    transport: { request: async () => ({ text: JSON.stringify({ schemaVersion: '0.7-draft-1', character: { name: 'Fixture', soul: 'Careful' }, canonFacts: [{ id: 'f1', text: 'Lives in town', status: 'explicit', evidenceIds: [snapshot.blocks[0].id] }], gaps: [] }) }) },
  });
  const draft = await distiller.distill({ characterId: 'companion', sources: [snapshot], cutoffPoint: 'Chapter One', workTitle: 'Fixture Book' }, new AbortController().signal);
  console.log(JSON.stringify({ probe: 'distiller-metadata', status: draft.status, cutoffSaved: draft.payload.cutoffPoint ?? null, workTitleSaved: draft.payload.workTitle ?? null }));
  console.log(JSON.stringify({ probe: 'unknown-cutoff', blocks: snapshot.blocks.length, allowed: computeCutoffAllowedBlockIds([snapshot], 'nonexistent chapter').size }));
} finally { db.close(); }
