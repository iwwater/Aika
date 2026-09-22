import test from 'node:test';
import assert from 'node:assert/strict';
import {
  codePointLength,
  createSourceSnapshot,
  sha256,
  splitSourceBlocks,
  validateSourceInput,
} from '../../memory/character-pack-source.js';
import { CharacterPackError } from '../../contracts/character-pack.js';

test('N07-01 Source: codePointLength handles ASCII and multi-byte Unicode', () => {
  assert.equal(codePointLength('hello'), 5);
  assert.equal(codePointLength('沈砚'), 2);
  assert.equal(codePointLength('🌸🌱'), 2);
  assert.equal(codePointLength('Aika 0.7 角色提炼'), 13);
});

test('N07-01 Source: splitSourceBlocks splits on paragraph boundaries and records locators', () => {
  const doc = [
    '# 第一章 临海城',
    '',
    '沈砚住在临海城，习惯先观察再回答。他重视承诺，表达克制。',
    '',
    '## 第二章 暴雨夜',
    '',
    '原作事件：沈砚在暴雨夜把唯一的伞留给同伴，自己沿旧码头回家。',
  ].join('\n');

  const blocks = splitSourceBlocks(doc, 'src-test-1', 500);
  assert.equal(blocks.length, 2);

  const b0 = blocks[0]!;
  const b1 = blocks[1]!;

  // Block 1
  assert.equal(b0.id, 'src-test-1:b1');
  assert.equal(b0.ordinal, 0);
  assert.match(b0.text, /沈砚住在临海城/);
  assert.equal(b0.locator.chapter, '第一章 临海城');
  assert.equal(b0.locator.start, doc.indexOf('沈砚'));
  assert.ok(b0.locator.end > b0.locator.start);
  assert.equal(b0.blockHash, sha256(b0.text));

  // Block 2
  assert.equal(b1.id, 'src-test-1:b2');
  assert.equal(b1.ordinal, 1);
  assert.match(b1.text, /暴雨夜把唯一的伞留给同伴/);
  assert.equal(b1.locator.chapter, '第二章 暴雨夜');
  assert.equal(b1.blockHash, sha256(b1.text));

  // Locator maps to exact code points
  const points = [...doc];
  const slice1 = points.slice(b0.locator.start, b0.locator.end).join('').trim();
  assert.equal(slice1, b0.text);
});

test('N07-01 Source: large paragraphs are subdivided deterministically without exceeding maxCodePoints', () => {
  const longParagraph = '沈砚在旧码头观察海潮。'.repeat(30); // 330 code points
  const maxCp = 100;
  const blocks = splitSourceBlocks(longParagraph, 'src-long', maxCp);

  assert.ok(blocks.length >= 4);
  for (const block of blocks) {
    const cpLen = codePointLength(block.text);
    assert.ok(cpLen <= maxCp, `Block length ${cpLen} exceeds max ${maxCp}`);
    assert.equal(block.blockHash, sha256(block.text));
  }

  // Same text produces identical blocks (determinism)
  const blocks2 = splitSourceBlocks(longParagraph, 'src-long', maxCp);
  assert.deepEqual(blocks, blocks2);
});

test('N07-01 Source: validateSourceInput accepts .txt, .md, .markdown and rejects illegal inputs', () => {
  // Valid
  const v1 = validateSourceInput({ sourceName: 'novel.txt', text: '正文内容' });
  assert.equal(v1.sourceName, 'novel.txt');
  assert.equal(v1.byteLength, Buffer.byteLength('正文内容', 'utf8'));

  const v2 = validateSourceInput({ sourceName: 'guide.md', text: 'Markdown 说明' });
  assert.equal(v2.sourceName, 'guide.md');

  // Invalid extension
  assert.throws(
    () => validateSourceInput({ sourceName: 'payload.exe', text: 'echo hi' }),
    (err: any) => err instanceof CharacterPackError && err.code === 'invalid_request',
  );

  // Empty text
  assert.throws(
    () => validateSourceInput({ sourceName: 'empty.txt', text: '' }),
    (err: any) => err instanceof CharacterPackError && err.code === 'invalid_request',
  );

  // Path separators in filename
  assert.throws(
    () => validateSourceInput({ sourceName: '../evil.txt', text: 'data' }),
    (err: any) => err instanceof CharacterPackError && err.code === 'invalid_request',
  );
  assert.throws(
    () => validateSourceInput({ sourceName: 'sub/novel.txt', text: 'data' }),
    (err: any) => err instanceof CharacterPackError && err.code === 'invalid_request',
  );

  // File size limit
  assert.throws(
    () =>
      validateSourceInput(
        { sourceName: 'huge.txt', text: 'x'.repeat(100) },
        { acceptedExtensions: ['.txt'], maxDocumentBytes: 50, maxFilesPerImport: 10, maxBlockCodePoints: 100 },
      ),
    (err: any) => err instanceof CharacterPackError && err.code === 'source_limit_exceeded',
  );
});

test('N07-01 Source: createSourceSnapshot creates frozen snapshot with stable hashes', () => {
  const snapshot = createSourceSnapshot('src-snap-1', 'companion', {
    sourceName: 'canon.txt',
    text: '第一行事实。\n\n第二行事实。',
  });

  assert.equal(snapshot.id, 'src-snap-1');
  assert.equal(snapshot.characterId, 'companion');
  assert.equal(snapshot.sourceName, 'canon.txt');
  assert.equal(snapshot.blocks.length, 2);
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.blocks));
});
