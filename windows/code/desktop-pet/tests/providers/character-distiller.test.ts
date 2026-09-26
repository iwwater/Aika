import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { CharacterDistiller } from '../../providers/character-distiller.js';
import { CharacterPackDraftStore } from '../../memory/character-pack-store.js';
import { createSourceSnapshot } from '../../memory/character-pack-source.js';
import type { EndpointConfig, ProviderOperation, JsonRecord } from '../../providers/transport.js';
import { ProviderTransport } from '../../providers/transport.js';
import type { TurnScope } from '../../contracts/index.js';
import { CharacterPackError } from '../../contracts/character-pack.js';

class MockTransport extends ProviderTransport {
  constructor(
    private readonly responder: (body: JsonRecord) => { text: string },
  ) {
    super();
  }

  override async request(
    _config: EndpointConfig,
    _scope: TurnScope,
    _operation: ProviderOperation,
    body: JsonRecord,
    signal: AbortSignal,
  ): Promise<JsonRecord> {
    if (signal.aborted) {
      throw new DOMException('Turn cancelled', 'AbortError');
    }
    const res = this.responder(body);
    return { text: res.text };
  }
}

function makeMockConfig(): EndpointConfig {
  return {
    endpoint: 'https://mock.example.com/v1/chat',
    model: 'mock-model',
    apiKey: () => 'mock-key',
    authorizer: {
      async authorize() {
        return { async settle() {} };
      },
    },
  };
}

test('N07-01 Distiller: produces validated draft with real evidence citations', async () => {
  const db = new Database(':memory:');
  const store = await CharacterPackDraftStore.open(db);

  const src = createSourceSnapshot('src-1', 'companion', {
    sourceName: 'story.txt',
    text: '沈砚住在临海城，习惯先观察周遭再作回应。他重视承诺。',
  });

  const validModelJson = JSON.stringify({
    schemaVersion: '0.7-draft-1',
    character: {
      name: '沈砚',
      soul: '沉静自敛、言出必践的守护者。',
    },
    canonFacts: [
      {
        id: 'cf-1',
        text: '沈砚常居临海城。',
        evidenceIds: [src.blocks[0]!.id],
      },
    ],
    gaps: [],
  });

  const transport = new MockTransport(() => ({ text: validModelJson }));
  const distiller = new CharacterDistiller(makeMockConfig(), { transport, store });

  const draft = await distiller.distill(
    {
      characterId: 'companion',
      characterName: '沈砚',
      sources: [src],
    },
    new AbortController().signal,
  );

  assert.equal(draft.status, 'validated');
  assert.equal(draft.characterId, 'companion');
  assert.equal(draft.payload.character.name, '沈砚');
  assert.equal(draft.validation.valid, true);
  assert.equal(draft.payload.canonFacts[0]!.evidenceIds[0], src.blocks[0]!.id);

  // Stored in draft store
  const stored = store.getDraft(draft.id);
  assert.ok(stored);
  assert.equal(stored!.status, 'validated');
});

test('N07-01 Distiller: handles hallucinated evidence IDs by generating rejected draft without polluting active pack', async () => {
  const db = new Database(':memory:');
  const store = await CharacterPackDraftStore.open(db);

  const src = createSourceSnapshot('src-real', 'companion', {
    sourceName: 'story.txt',
    text: '真实资料内容。',
  });

  // Model hallucinates an evidenceId not in source
  const hallucinatedModelJson = JSON.stringify({
    schemaVersion: '0.7-draft-1',
    character: { name: '沈砚', soul: '稳重' },
    canonFacts: [
      {
        id: 'cf-fake',
        text: '沈砚曾经游历东海。',
        evidenceIds: ['src-hallucinated:b99'], // Forged ID!
      },
    ],
    gaps: [],
  });

  const transport = new MockTransport(() => ({ text: hallucinatedModelJson }));
  const distiller = new CharacterDistiller(makeMockConfig(), { transport, store });

  const draft = await distiller.distill(
    {
      characterId: 'companion',
      sources: [src],
    },
    new AbortController().signal,
  );

  assert.equal(draft.status, 'rejected');
  assert.equal(draft.validation.valid, false);
  assert.ok(draft.validation.errors.some(e => e.includes('引用了未登记或伪造的证据区块 "src-hallucinated:b99"')));

  // Persisted as rejected
  const stored = store.getDraft(draft.id);
  assert.ok(stored);
  assert.equal(stored!.status, 'rejected');
});

test('N07-01 Distiller: respects throwOnRejectedDraft option', async () => {
  const src = createSourceSnapshot('src-real', 'companion', {
    sourceName: 'story.txt',
    text: '真实资料。',
  });

  const hallucinatedJson = JSON.stringify({
    schemaVersion: '0.7-draft-1',
    character: { name: '沈砚', soul: '稳重' },
    canonFacts: [{ id: 'f', text: '事实', evidenceIds: ['fake:id'] }],
    gaps: [],
  });

  const transport = new MockTransport(() => ({ text: hallucinatedJson }));
  const distiller = new CharacterDistiller(makeMockConfig(), {
    transport,
    throwOnRejectedDraft: true,
  });

  await assert.rejects(
    async () => {
      await distiller.distill(
        { characterId: 'companion', sources: [src] },
        new AbortController().signal,
      );
    },
    (err: any) => err instanceof CharacterPackError && err.code === 'validation_failed',
  );
});

test('N07-01 Distiller: abort signal cancels execution cleanly', async () => {
  const src = createSourceSnapshot('src-real', 'companion', {
    sourceName: 'story.txt',
    text: '真实资料。',
  });

  const controller = new AbortController();
  controller.abort(); // Pre-aborted

  const transport = new MockTransport(() => ({ text: '{}' }));
  const distiller = new CharacterDistiller(makeMockConfig(), { transport });

  await assert.rejects(
    async () => {
      await distiller.distill({ characterId: 'companion', sources: [src] }, controller.signal);
    },
    (err: any) => err.name === 'AbortError' || (err instanceof CharacterPackError && err.code === 'aborted'),
  );
});

test('N07-01 Distiller: handles malformed model output gracefully', async () => {
  const db = new Database(':memory:');
  const store = await CharacterPackDraftStore.open(db);

  const src = createSourceSnapshot('src-real', 'companion', {
    sourceName: 'story.txt',
    text: '真实资料。',
  });

  const transport = new MockTransport(() => ({ text: 'Sorry, I cannot help with that.' }));
  const distiller = new CharacterDistiller(makeMockConfig(), { transport, store });

  const draft = await distiller.distill(
    { characterId: 'companion', sources: [src] },
    new AbortController().signal,
  );

  assert.equal(draft.status, 'rejected');
  assert.equal(draft.validation.valid, false);
  assert.ok(draft.validation.errors.some(e => e.includes('Model did not return valid structured data')));
});
