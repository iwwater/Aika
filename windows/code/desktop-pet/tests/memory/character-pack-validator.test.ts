import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDraftEvidence } from '../../memory/character-pack-validator.js';
import { createSourceSnapshot } from '../../memory/character-pack-source.js';
import type { SourceSnapshot } from '../../contracts/character-pack.js';

function makeFixtureSources(): readonly SourceSnapshot[] {
  const s1 = createSourceSnapshot('src-1', 'companion', {
    sourceName: 'ch1.txt',
    text: '沈砚住在临海城，习惯先观察周遭再作回应。\n\n他在旧码头守候，无论风雨从不失约。',
  });
  const s2 = createSourceSnapshot('src-2', 'companion', {
    sourceName: 'ch2.txt',
    text: '暴雨之夜，沈砚将随身唯一的雨伞留给同行者。',
  });
  return [s1, s2];
}

test('N07-01 Validator: valid draft passes evidence and schema check', () => {
  const sources = makeFixtureSources();
  const validDraft = {
    schemaVersion: '0.7-draft-1',
    character: {
      name: '沈砚',
      soul: '沉稳克制、重诺守信的观察者。',
      evidenceIds: ['src-1:b1'],
    },
    canonFacts: [
      {
        id: 'fact-1',
        text: '沈砚常居临海城，行事习惯先观察。',
        evidenceIds: ['src-1:b1'],
      },
      {
        id: 'fact-2',
        text: '沈砚在暴雨夜将雨伞留给同伴。',
        evidenceIds: ['src-2:b1'],
      },
    ],
    gaps: ['未提及早年经历'],
  };

  const result = validateDraftEvidence(validDraft, sources);
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
  assert.ok(result.validatedAt);
});

test('N07-01 Validator: rejects invalid schemaVersion and non-object payloads', () => {
  const sources = makeFixtureSources();

  const r1 = validateDraftEvidence('not-an-object', sources);
  assert.equal(r1.valid, false);
  assert.match(r1.errors[0]!, /草稿负载必须为 JSON 对象/);

  const r2 = validateDraftEvidence({ schemaVersion: '9.9-unknown' }, sources);
  assert.equal(r2.valid, false);
  assert.ok(r2.errors.some(e => e.includes('不支持的 schemaVersion')));
});

test('N07-01 Validator: rejects missing character name or soul', () => {
  const sources = makeFixtureSources();

  const r1 = validateDraftEvidence(
    {
      schemaVersion: '0.7-draft-1',
      character: { name: '', soul: ' ' },
      canonFacts: [{ id: 'f1', text: '事实', evidenceIds: ['src-1:b1'] }],
    },
    sources,
  );
  assert.equal(r1.valid, false);
  assert.ok(r1.errors.some(e => e.includes('character.name 必须为非空字符串')));
  assert.ok(r1.errors.some(e => e.includes('character.soul 必须为非空字符串')));
});

test('N07-01 Validator: rejects ungrounded facts with empty evidenceIds', () => {
  const sources = makeFixtureSources();

  const draft = {
    schemaVersion: '0.7-draft-1',
    character: { name: '沈砚', soul: '冷静观察者' },
    canonFacts: [
      {
        id: 'fact-ungrounded',
        text: '沈砚曾经击败过恶龙。（资料中完全无依据）',
        evidenceIds: [], // Empty evidence!
      },
    ],
  };

  const result = validateDraftEvidence(draft, sources);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('无依据事实不能成为有效草稿')));
});

test('N07-01 Validator: rejects fabricated / forged evidence IDs outside source blocks', () => {
  const sources = makeFixtureSources();

  const draft = {
    schemaVersion: '0.7-draft-1',
    character: { name: '沈砚', soul: '冷静观察者' },
    canonFacts: [
      {
        id: 'fact-forged',
        text: '沈砚在暴雨夜留伞。',
        evidenceIds: ['src-1:b1', 'fake:non-existent:block'], // One real, one forged!
      },
    ],
  };

  const result = validateDraftEvidence(draft, sources);
  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some(e => e.includes('引用了未登记或伪造的证据区块 "fake:non-existent:block"')),
  );
});

test('N07-01 Validator: rejects out-of-bounds locator offsets in source block', () => {
  // Construct a snapshot with invalid/corrupted locator offsets
  const corruptedSnapshot: SourceSnapshot = {
    id: 'src-bad',
    characterId: 'companion',
    sourceName: 'bad.txt',
    contentHash: 'hash-bad',
    byteLength: 50,
    createdAt: new Date().toISOString(),
    blocks: [
      {
        id: 'src-bad:b1',
        sourceId: 'src-bad',
        ordinal: 0,
        text: '异常区块',
        blockHash: 'h',
        locator: { start: 100, end: 50 }, // start > end! Out of bounds!
      },
    ],
  };

  const draft = {
    schemaVersion: '0.7-draft-1',
    character: { name: '沈砚', soul: '冷静观察者' },
    canonFacts: [
      {
        id: 'fact-bad-loc',
        text: '事实',
        evidenceIds: ['src-bad:b1'],
      },
    ],
  };

  const result = validateDraftEvidence(draft, [corruptedSnapshot]);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('定位越界或无效')));
});
