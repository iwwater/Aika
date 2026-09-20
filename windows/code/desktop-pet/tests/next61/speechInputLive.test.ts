// FIX61-08 08-C: the production speech input must expose live partial/final events, allow interim UI
// updates to be replaced (never appended), and still submit exactly one authoritative voice turn when
// the user releases the key. Late events from a cancelled or replaced input are filtered.
import test from 'node:test';
import assert from 'node:assert/strict';
import { NextSpeechInput } from '../../core/speech-bridge.js';
import { nextScope } from '../next/harness.js';

const segment = (index: number, text: string, revision: number, segmentId = `seg-${index}`, extra: Record<string, unknown> = {}) =>
  ({ inputSessionId: 'turn-1', segmentId, index, text, audioEndMs: (index + 1) * 1000, timeSource: 'audio' as const, revision, ...extra });

test('08-C interim renders replace text; a later revision is never appended', () => {
  const interim: { index: number; revision: number; text: string }[] = [];
  const finals: string[] = [];
  const input = new NextSpeechInput(async () => nextScope('t1'), {
    onInterim: segment => interim.push({ index: segment.index, revision: segment.revision ?? 0, text: segment.text }),
    onSegmentFinal: segment => finals.push(segment.text),
  });
  input.interim(segment(0, '你', 1));
  input.interim(segment(0, '你好', 2));
  input.interim(segment(0, '你好，', 3));
  input.final(segment(0, '你好，世界。', 4, 'seg-0', { final: true }));

  assert.deepEqual(interim.map(value => value.text), ['你', '你好', '你好，']);
  assert.deepEqual(interim.map(value => value.revision), [1, 2, 3], 'each partial carries its own revision so the UI replaces, not concatenates');
  assert.deepEqual(finals, ['你好，世界。'], 'the final snapshot is authoritative');
});

test('08-C a stale revision cannot overwrite a newer partial or a final segment', () => {
  const interim: string[] = [];
  const input = new NextSpeechInput(async () => nextScope('t1'), { onInterim: segment => interim.push(segment.text) });
  input.interim(segment(0, '你好', 5));
  input.interim(segment(0, '你', 4));
  assert.deepEqual(interim, ['你好'], 'an out-of-order revision is ignored');
  input.final(segment(0, '你好，世界。', 6));
  input.interim(segment(0, '你好，世', 7));
  assert.deepEqual(interim, ['你好'], 'a final segment is immutable');
});

test('08-C many partials and many finals still submit exactly one voice turn', async () => {
  const submissions: string[] = [];
  const finals: number[] = [];
  const input = new NextSpeechInput(async text => { submissions.push(text); return nextScope('t1'); }, {
    onSegmentFinal: () => finals.push(1),
  });
  for (let revision = 1; revision <= 12; revision++) input.interim(segment(0, '好'.repeat(revision), revision));
  input.final(segment(0, '你好，', 20));
  for (let revision = 1; revision <= 8; revision++) input.interim(segment(1, '世'.repeat(revision), revision));
  input.final(segment(1, '世界。', 30));
  await input.stop();
  await input.stop();
  assert.equal(finals.length, 2, 'both segments published a final');
  assert.deepEqual(submissions, ['你好，世界。'], 'multi-final audio still produces one turn');
});

test('08-C cancel drops interim text and every late event of the old input session', async () => {
  const submissions: string[] = [];
  const interim: string[] = [];
  const input = new NextSpeechInput(async text => { submissions.push(text); return nextScope('t1'); }, { onInterim: segment => interim.push(segment.text) });
  input.interim(segment(0, '丢弃我', 1));
  input.cancel();
  input.interim(segment(0, '迟到', 2));
  input.final(segment(0, '迟到的最终结果', 3));
  await input.stop();
  assert.deepEqual(submissions, [], 'cancelled text is never submitted');
  assert.deepEqual(interim, ['丢弃我'], 'only the pre-cancel interim was rendered');

  input.startNewInput();
  input.interim(segment(0, '新的', 1, 'seg-new'));
  input.final(segment(0, '新的输入。', 2, 'seg-new'));
  await input.stop();
  assert.deepEqual(submissions, ['新的输入。'], 'the next input session is independent');
});

test('08-C a final from a different input session cannot extend the current session', async () => {
  const submissions: string[] = [];
  const input = new NextSpeechInput(async text => { submissions.push(text); return nextScope('t1'); });
  input.final({ ...segment(0, '旧会话', 1), inputSessionId: 'turn-1' });
  input.final({ ...segment(1, '新会话', 1), inputSessionId: 'turn-2' });
  await input.stop();
  assert.deepEqual(submissions, ['新会话'], 'only one session ever submits, and it is the newest one');
});

test('08-C empty finals never submit a turn', async () => {
  const submissions: string[] = [];
  const input = new NextSpeechInput(async text => { submissions.push(text); return nextScope('t1'); });
  input.interim(segment(0, '   ', 1));
  input.final(segment(0, '   ', 2));
  await input.stop();
  assert.deepEqual(submissions, []);
});
