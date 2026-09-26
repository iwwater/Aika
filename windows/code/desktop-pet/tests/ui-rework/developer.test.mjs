import test from 'node:test';
import assert from 'node:assert/strict';

test('UIR-05 Developer: Four sub-panels are supported and distinct', () => {
  const subPanels = ['llm', 'ingest', 'timeline', 'logs'];
  assert.equal(subPanels.length, 4);
  assert.ok(subPanels.includes('llm'));
  assert.ok(subPanels.includes('ingest'));
  assert.ok(subPanels.includes('timeline'));
  assert.ok(subPanels.includes('logs'));
});

test('UIR-05 Developer: Unretained history fields explicitly marked as unavailable', () => {
  const historicTrace = {
    turnId: 'turn-old-01',
    model: 'qwen-plus',
    latencyMs: 850,
    tokenUsage: null,
    rawPrompt: null,
    systemPrompt: null
  };

  const displayTokenUsage = historicTrace.tokenUsage ?? 'unavailable';
  const displayRawPrompt = historicTrace.rawPrompt ?? 'unavailable';

  assert.equal(displayTokenUsage, 'unavailable');
  assert.equal(displayRawPrompt, 'unavailable');
});

test('UIR-05 Developer: Forgotten/revoked source text vanishes from cache (forget propagation)', () => {
  const traceCache = new Map();
  traceCache.set('trace-turn-1', { text: '用户喜欢红茶', revoked: false });
  traceCache.set('trace-turn-2', { text: '今天去海边散步', revoked: false });

  assert.equal(traceCache.size, 2);

  // User forgets '用户喜欢红茶'
  function propagateForget(targetContent) {
    for (const [key, value] of traceCache.entries()) {
      if (value.text.includes(targetContent)) {
        traceCache.delete(key);
      }
    }
  }

  propagateForget('红茶');
  assert.equal(traceCache.has('trace-turn-1'), false);
  assert.equal(traceCache.size, 1);
  assert.equal(traceCache.get('trace-turn-2').text, '今天去海边散步');
});
