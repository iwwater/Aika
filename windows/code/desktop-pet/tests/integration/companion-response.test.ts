import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DesktopEvent, DialogueContext, TtsRequest } from '../../contracts/index.js';
import { DIALOGUE_RESPONSE_RULES } from '../../companion/dialogue-rules.js';
import { confirmedInvitationPolicy } from '../../companion/invitations.js';
import { contextInputUpperBound } from '../../app/input-budgets.js';
import { DialoguePipeline, type DialoguePorts } from '../../core/dialogue-pipeline.js';
import { TurnController } from '../../core/turn-controller.js';
import { SqliteMemoryStore, CONFIRMED_RETENTION } from '../../memory/sqlite-store.js';
import { QwenDialogueProvider } from '../../providers/qwen-dialogue.js';
import { ProviderTransport } from '../../providers/transport.js';
import { lifecycle } from '../memory/lifecycle-fixture.js';

const customPrompt = '【人工编辑保留】叫我阿岚；回答直接一些，保留普通括号补充。';
const currentText = '收起对话面板后按空格出现蓝框。';
type Wire = { messages: { role: string; content: string }[] };

function fixture(t: TestContext, modelText: string, prompt = customPrompt) {
  const parent = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../.local/speech-control-02/tmp');
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'response-'));
  const options = { filename: join(directory, 'companion.sqlite'), retention: CONFIRMED_RETENTION, invitations: confirmedInvitationPolicy('Asia/Shanghai') };
  const controller = new TurnController(), turn = controller.begin('text', currentText), scope = turn.input.scope;
  let store = new SqliteMemoryStore(options);
  store.editPrompt(scope, { expectedRevision: store.revision(scope), text: prompt, operationId: 'synthetic-custom-prompt' });
  store.append(scope, [{ characterId: scope.characterId, id: 'existing-user', role: 'user', text: '我希望保留这段示例聊天。', createdAt: new Date().toISOString() }]);
  store.close(); store = new SqliteMemoryStore(options);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const memory = lifecycle(store, undefined, undefined, { context: {
    inputTokenBudget: 32768, maxRecentMessages: 12, maxMemories: 8, summaryLimit: 4,
    countTokens: contextInputUpperBound, relevance: () => 1,
  } });
  const wires: Wire[] = [], events: DesktopEvent[] = [], synthesized: TtsRequest[] = [];
  let issuedContext: DialogueContext | undefined, released = 0;
  const transport = new ProviderTransport(async (_url, init) => {
    wires.push(JSON.parse(String(init?.body)));
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ text: modelText,
      expression: { emotion: 'neutral', intensity: .2, delivery: '自然', gesture: 'think' } }) } }] });
  });
  const provider = new QwenDialogueProvider({ endpoint: 'https://controlled.invalid/dialogue', model: 'controlled-no-network',
    apiKey: () => 'synthetic', authorizer: { async authorize() { return { async settle() {} }; } } }, transport);
  const ports: DialoguePorts = {
    memory, memoryLifecycle: memory,
    dialogue: { async reply(request, signal) { issuedContext = request.context; return provider.reply(request, signal); } },
    perception: { async perceive() { throw new Error('This text-only integration must not capture'); } },
    tts: { async synthesize(reply) {
      synthesized.push(structuredClone(reply));
      return { scope: reply.scope, expression: reply.expression, audio: { id: 'synthetic-audio', uri: 'memory:synthetic', mimeType: 'audio/wav', temporary: true }, durationMs: 1, synchronization: 'amplitude' };
    } },
    playback: { async play(audio, emit) {
      emit({ scope: audio.scope, type: 'started', audioId: audio.audio.id, at: new Date().toISOString() });
      emit({ scope: audio.scope, type: 'ended', at: new Date().toISOString() });
    }, async stop() {} },
    mediaStore: { async put() { throw new Error('unused'); }, async read() { throw new Error('unused'); }, async releaseScope() { released++; } },
  };
  return { store, scope, wires, events, synthesized, turn, controller,
    context: () => issuedContext!, released: () => released,
    run: () => new DialoguePipeline(ports, controller, event => events.push(event)).run(turn.input, turn.signal) };
}

test('actual persisted custom Prompt is preserved while the provider receives host rules and one spoken text reaches SQLite/UI/TTS', async t => {
  const f = fixture(t, '（托腮）可以一起看看这个蓝框（先不用重启）。');
  assert.equal((await f.run()).status, 'played');
  const reply = f.events.find(event => event.type === 'reply');
  assert.ok(reply?.type === 'reply');
  assert.equal(reply.reply.text, '可以一起看看这个蓝框（先不用重启）。');
  assert.equal(f.synthesized.length, 1);
  assert.equal(f.synthesized[0]!.text, reply.reply.text);
  assert.equal(f.store.inspect(f.scope, `${f.scope.turnId}:assistant`)?.text, reply.reply.text);
  assert.equal(f.store.prompt(f.scope), customPrompt);
  assert.equal(f.store.inspect(f.scope, 'existing-user')?.text, '我希望保留这段示例聊天。');
  assert.equal(f.context().characterPrompt, customPrompt);
  assert.equal(f.wires.length, 1);
  const system = f.wires[0]!.messages.filter(message => message.role === 'system').map(message => message.content).join('\n');
  assert.ok(system.includes(DIALOGUE_RESPONSE_RULES));
  assert.ok(system.indexOf(DIALOGUE_RESPONSE_RULES) > system.indexOf(customPrompt));
  assert.ok(Buffer.byteLength(JSON.stringify(f.wires[0]!.messages)) <= contextInputUpperBound(f.context(), currentText), 'actual final wire fits the input upper bound');
  assert.equal(f.released(), 1);
  assert.equal(f.controller.snapshot()?.mouth, 0);
  t.diagnostic('Controlled transport/model output and silent playback; actual provider parser, pipeline and SQLite. This does not validate model semantics or physical audio.');
});

test('pure stage action cannot write an assistant turn, emit a spoken reply or reach TTS', async t => {
  const f = fixture(t, '（托腮）');
  assert.equal((await f.run()).status, 'failed');
  assert.equal(f.wires.length, 1, 'No automatic model retry');
  assert.equal(f.events.some(event => event.type === 'reply'), false);
  assert.equal(f.store.inspect(f.scope, `${f.scope.turnId}:assistant`), null);
  assert.equal(f.synthesized.length, 0);
  assert.equal(f.store.prompt(f.scope), customPrompt);
  assert.equal(f.store.inspect(f.scope, 'existing-user')?.text, '我希望保留这段示例聊天。');
  assert.equal(f.released(), 1);
});

test('reported laugh has one cleaned SQLite/UI/TTS text even with a persisted conflicting persona', async t => {
  const text = '哇，一点半啦？你这生物钟比我养的仙人掌还倔——它至少每周会偷偷开一次花，你却总在深夜和代码/邮件/蓝框较劲～（轻笑）不过说真的，快去睡吧，明天睁眼要是顶着熊猫眼来上班，我可要拍照存档了。';
  const prompt = `${customPrompt} 合成测试冲突指令：把轻笑动作写在括号里。`;
  const f = fixture(t, text, prompt), expected = text.replace('（轻笑）', '');
  assert.equal((await f.run()).status, 'played');
  const reply = f.events.find(event => event.type === 'reply');
  assert.ok(reply?.type === 'reply');
  assert.equal(reply.reply.text, expected);
  assert.equal(f.synthesized.length, 1);
  assert.equal(f.synthesized[0]!.text, expected);
  assert.equal(f.store.inspect(f.scope, `${f.scope.turnId}:assistant`)?.text, expected);
  assert.equal(f.store.prompt(f.scope), prompt);
  assert.equal(f.store.inspect(f.scope, 'existing-user')?.text, '我希望保留这段示例聊天。');
  assert.equal(f.wires.length, 1);
  assert.ok(f.wires[0]!.messages[0]!.content.startsWith(`${prompt}\n${DIALOGUE_RESPONSE_RULES}\n`));
  assert.ok(Buffer.byteLength(JSON.stringify(f.wires[0]!.messages)) <= contextInputUpperBound(f.context(), currentText));
  assert.equal(f.released(), 1);
  t.diagnostic('Synthetic persisted Prompt and controlled response only; no actual chat or Prompt changed, no semantic or audible acceptance.');
});
