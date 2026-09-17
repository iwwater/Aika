import test from 'node:test';
import assert from 'node:assert/strict';
import type { DialogueRequest, ExpressionIntent, TurnScope } from '../../contracts/index.js';
import { PRESENTATION_EMOTIONS, PRESENTATION_GESTURES, normalizePresentationIntent } from '../../contracts/presentation.js';
import { QwenDialogueProvider } from '../../providers/qwen-dialogue.js';
import { ProviderTransport } from '../../providers/transport.js';

const scope: TurnScope = { characterId: 'friend', sessionId: 'presentation', turnId: 'turn', generation: 1 };
const input: DialogueRequest = { scope, text: '今天我把一个难题解决了。',
  context: { scope, characterPrompt: '朋友', recent: [], summary: '', memories: [], perception: null, inputTokenBudget: 4096 } };
function harness(expression: ExpressionIntent) {
  const requests: { messages: { role: string; content: string }[] }[] = [];
  const reply = { text: '听起来你为这件事花了不少心思。愿意说说是怎么解决的吗？', expression };
  const provider = new QwenDialogueProvider({ endpoint: 'https://controlled.invalid/chat/completions', model: 'fixture-only',
    apiKey: () => 'fixture-only', authorizer: { async authorize() { return { async settle() {} }; } } },
  new ProviderTransport(async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(reply) } }] });
  }));
  return { provider, requests, reply };
}

test('the actual dialogue request describes the shared expression vocabulary and optional contextual gestures', async () => {
  const h = harness({ emotion: 'happy', intensity: .5, delivery: '轻快但不夸张', gesture: 'hold_star' });
  await h.provider.reply(input, new AbortController().signal);
  const system = h.requests[0]!.messages[0]!.content;
  for (const value of [...PRESENTATION_EMOTIONS, ...PRESENTATION_GESTURES]) assert.ok(system.includes(`"${value}"`), `Prompt must expose supported expression ${value}`);
  assert.match(system, /助手本轮/); assert.match(system, /null/); assert.match(system, /不必每轮/);
  assert.match(system, /"gesture":"comfort"/);
});

test('all supported non-null gestures and a quiet reply pass through the real provider adapter unchanged', async () => {
  for (const gesture of [...PRESENTATION_GESTURES, null]) {
    const expression: ExpressionIntent = { emotion: 'warm', intensity: .4, delivery: '温和、放松地说，完整保留文字', gesture };
    const h = harness(expression), result = await h.provider.reply(input, new AbortController().signal);
    assert.deepEqual(result, { scope, ...h.reply });
    assert.deepEqual(normalizePresentationIntent(result.expression), expression);
    assert.equal(h.requests.length, 1);
  }
});

test('legacy Chinese and unknown visual labels preserve the full reply and TTS delivery', async () => {
  for (const [emotion, gesture, expectedEmotion, expectedGesture] of [
    ['温柔', '捂胸口', 'warm', 'comfort'], ['未登记的情绪', '未登记的动作', 'neutral', null],
  ] as const) {
    const h = harness({ emotion, intensity: .4, delivery: '轻声解释，不截短内容', gesture });
    const result = await h.provider.reply(input, new AbortController().signal);
    assert.deepEqual(result, { scope, ...h.reply });
    const visual = normalizePresentationIntent(result.expression);
    assert.equal(visual.emotion, expectedEmotion); assert.equal(visual.gesture, expectedGesture);
    assert.equal(visual.delivery, result.expression.delivery);
  }
});
