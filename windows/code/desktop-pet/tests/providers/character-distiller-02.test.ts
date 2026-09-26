import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { CharacterDistiller } from '../../providers/character-distiller.js';
import { CharacterPackDraftStore } from '../../memory/character-pack-store.js';
import { createSourceSnapshot } from '../../memory/character-pack-source.js';
import type { EndpointConfig, ProviderOperation, JsonRecord } from '../../providers/transport.js';
import { ProviderTransport } from '../../providers/transport.js';
import type { TurnScope } from '../../contracts/index.js';
import type { ResolvedBinding } from '../../contracts/provider-source.js';
import { CharacterPackError } from '../../contracts/character-pack.js';

class MockTransport extends ProviderTransport {
  constructor(private readonly responder: (body: JsonRecord) => { text: string }) {
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

function makeMockResolvedBinding(): ResolvedBinding {
  return {
    bindingId: 'bind-distill-test',
    bindingRevision: 1,
    capabilityId: 'dialogue',
    contractVersion: '0.9.0',
    packageId: 'normal',
    adapterId: 'aika-distiller',
    adapterVersion: '1.0.0',
    sourceId: 'src-cloud',
    sourceConfigRevision: 1,
    deployment: 'remote-api',
    modelProfileId: 'mp-test',
    modelProfileRevision: 1,
    nativeModelId: 'mock-model-0.7',
    nativeVoiceId: null,
    effectiveParameters: { endpoint: 'https://binding.example.com/v1' },
    credentialRef: 'cred-key-1',
    sideEffect: 'none',
    limits: {
      maxConcurrentCalls: 2,
      maxQueueDepth: 10,
      startupTimeoutMs: 5000,
      callTimeoutMs: 10000,
      maxMemoryMb: null,
      maxGpuDevices: null,
    },
    instanceKey: 'inst-test',
  };
}

test('N07-02 Distiller: consumes 0.65 ResolvedBinding and executes distillation', async () => {
  const binding = makeMockResolvedBinding();
  const keyResolver = (ref: string) => (ref === 'cred-key-1' ? 'secret-token-xyz' : '');

  const src = createSourceSnapshot('src-b', 'companion', {
    sourceName: 'story.txt',
    text: '沈砚住在临海城。',
  });

  const validModelJson = JSON.stringify({
    schemaVersion: '0.7-draft-1',
    character: { name: '沈砚', soul: '稳重' },
    canonFacts: [
      {
        id: 'cf-1',
        text: '沈砚住在临海城。',
        status: 'explicit',
        evidenceIds: [src.blocks[0]!.id],
      },
    ],
    gaps: [],
  });

  const transport = new MockTransport(() => ({ text: validModelJson }));
  const distiller = new CharacterDistiller(
    { binding, keyResolver },
    { transport },
  );

  const draft = await distiller.distill(
    { characterId: 'companion', sources: [src] },
    new AbortController().signal,
  );

  assert.equal(draft.status, 'validated');
  assert.equal(draft.payload.character.name, '沈砚');
  assert.equal(draft.payload.canonFacts[0]!.status, 'explicit');
});

test('N07-02 Distiller: enforces cutoffPoint and rejects facts from post-cutoff chapters', async () => {
  const doc = [
    '# 第一章 启程',
    '',
    '沈砚在临海城生活。',
    '',
    '# 第二章 暴雨',
    '',
    '暴雨之夜沈砚留伞沿码头离开。',
    '',
    '# 第三章 远行（此章在截止点之后）',
    '',
    '沈砚多年后前往王都。（超出截止点）',
  ].join('\n');

  const src = createSourceSnapshot('src-novel', 'companion', {
    sourceName: 'novel.txt',
    text: doc,
  });

  // Source blocks:
  // src-novel:b1 -> 第一章
  // src-novel:b2 -> 第二章
  // src-novel:b3 -> 第三章

  // Model returns a fact citing block b3 which is in 第三章, but cutoff is 第二章!
  const postCutoffModelJson = JSON.stringify({
    schemaVersion: '0.7-draft-1',
    character: { name: '沈砚', soul: '稳重' },
    canonFacts: [
      {
        id: 'cf-ch1',
        text: '沈砚在临海城生活。',
        status: 'explicit',
        evidenceIds: [src.blocks[0]!.id],
      },
      {
        id: 'cf-ch3',
        text: '沈砚多年后前往王都。',
        status: 'explicit',
        evidenceIds: [src.blocks[2]!.id], // Post-cutoff block!
      },
    ],
    gaps: [],
  });

  const transport = new MockTransport(() => ({ text: postCutoffModelJson }));
  const distiller = new CharacterDistiller(
    {
      endpoint: 'https://test.example.com',
      model: 'test',
      apiKey: () => 'key',
      authorizer: { async authorize() { return { async settle() {} }; } },
    },
    { transport },
  );

  const draft = await distiller.distill(
    {
      characterId: 'companion',
      sources: [src],
      cutoffPoint: '第二章', // Cutoff at Chapter 2!
    },
    new AbortController().signal,
  );

  assert.equal(draft.status, 'rejected');
  assert.equal(draft.validation.valid, false);
  assert.ok(
    draft.validation.errors.some(e => e.includes('超出剧情截止点 ("第二章")')),
  );
});

test('N07-02 Distiller: rejects invalid fact status classification', async () => {
  const src = createSourceSnapshot('src-s', 'companion', {
    sourceName: 'story.txt',
    text: '沈砚住在临海城。',
  });

  const invalidStatusModelJson = JSON.stringify({
    schemaVersion: '0.7-draft-1',
    character: { name: '沈砚', soul: '稳重' },
    canonFacts: [
      {
        id: 'cf-1',
        text: '沈砚住在临海城。',
        status: 'invalid_status_type', // Invalid status!
        evidenceIds: [src.blocks[0]!.id],
      },
    ],
    gaps: [],
  });

  const transport = new MockTransport(() => ({ text: invalidStatusModelJson }));
  const distiller = new CharacterDistiller(
    {
      endpoint: 'https://test.example.com',
      model: 'test',
      apiKey: () => 'key',
      authorizer: { async authorize() { return { async settle() {} }; } },
    },
    { transport },
  );

  const draft = await distiller.distill(
    { characterId: 'companion', sources: [src] },
    new AbortController().signal,
  );

  assert.equal(draft.status, 'rejected');
  assert.ok(draft.validation.errors.some(e => e.includes('status "invalid_status_type" 无效')));
});

test('N07-02 Distiller: distillFromSourceRefs coordinates fetch, store import, and distillation', async () => {
  const db = new Database(':memory:');
  const store = await CharacterPackDraftStore.open(db);

  const validModelJson = JSON.stringify({
    schemaVersion: '0.7-draft-1',
    character: { name: '沈砚', soul: '内敛重诺' },
    canonFacts: [
      {
        id: 'f1',
        text: '沈砚在临海城生活。',
        status: 'explicit',
        evidenceIds: [], // will fill dynamically below
      },
    ],
    gaps: [],
  });

  let capturedPrompt = '';
  const transport = new MockTransport(body => {
    capturedPrompt = JSON.stringify(body);
    // Find the block ID generated in prompt
    const blockMatch = /(src-[0-9a-fA-F-]+:b\d+)/.exec(capturedPrompt);
    const blockId = blockMatch ? blockMatch[1] : 'src-fallback:b1';

    return {
      text: JSON.stringify({
        schemaVersion: '0.7-draft-1',
        character: { name: '沈砚', soul: '内敛重诺' },
        canonFacts: [
          {
            id: 'f1',
            text: '沈砚在临海城生活。',
            status: 'explicit',
            evidenceIds: [blockId],
          },
        ],
        gaps: ['早年经历未知'],
      }),
    };
  });

  const distiller = new CharacterDistiller(
    {
      endpoint: 'https://test.example.com',
      model: 'test',
      apiKey: () => 'key',
      authorizer: { async authorize() { return { async settle() {} }; } },
    },
    { transport, store },
  );

  const draft = await distiller.distillFromSourceRefs(
    {
      characterId: 'companion',
      characterName: '沈砚',
      sourceRefs: [
        {
          kind: 'text',
          uri: 'ref-1',
          title: 'intro.txt',
          text: '沈砚在临海城生活，行事低调。',
        },
      ],
      cutoffPoint: '临海城',
    },
    new AbortController().signal,
  );

  assert.equal(draft.status, 'validated');
  assert.equal(draft.payload.character.name, '沈砚');
  assert.equal(draft.payload.canonFacts[0]!.status, 'explicit');
  assert.equal(draft.payload.gaps[0], '早年经历未知');

  // Verify stored in DB
  const stored = store.getDraft(draft.id);
  assert.ok(stored);
  assert.equal(stored!.status, 'validated');
});
