import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeTraceStore } from '../../core/trace-store.js';
import { DialoguePipeline } from '../../core/dialogue-pipeline.js';
import { TurnController } from '../../core/turn-controller.js';
import { RoleMemoryLifecycleQueue } from '../../core/memory-lifecycle-queue.js';
import { scope, message } from '../memory/sqlite-fixture.js';
import { signal, replyMessage } from '../memory/lifecycle-fixture.js';

function createTempDb(): { db: Database.Database; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'trace-test-'));
  const filename = join(dir, 'test-trace.db');
  const db = new Database(filename);
  return {
    db,
    cleanup: () => {
      try { db.close(); } catch {}
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    },
  };
}

test('N075-01 R5: DialoguePipeline instruments real production stages into RuntimeTraceStore with privacy by default', async t => {
  const { db, cleanup } = createTempDb();
  t.after(cleanup);

  const traceStore = RuntimeTraceStore.open(db);
  const controller = new TurnController();
  const events: unknown[] = [];

  const turnScope = scope('companion', 'turn-trace-1');
  const userText = '你好，这是一条包含个人隐私的消息。';
  const replyContent = '收到你的问候，很高兴陪伴你！';

  const mockDialogue = {
    async reply(req: any) {
      return {
        scope: req.scope,
        text: replyContent,
        expression: { emotion: 'happy', intensity: 0.5, delivery: '欢快', gesture: null },
      };
    },
  };

  const storedMessages: unknown[] = [];
  const mockMemory = {
    async append(sc: any, msgs: any) { storedMessages.push(...msgs); },
    async context(reqScope: any) {
      return {
        scope: reqScope,
        characterPrompt: '身份',
        recent: [],
        summary: '',
        memories: [],
        perception: null,
        inputTokenBudget: 4000,
      };
    },
  };

  const mockMediaStore = {
    async releaseScope() {},
  };

  const pipeline = new DialoguePipeline({
    dialogue: mockDialogue as any,
    memory: mockMemory as any,
    mediaStore: mockMediaStore as any,
    perception: {} as any,
    tts: {} as any,
    playback: {} as any,
    outputMode: 'text',
    traceStore,
    traceDebugOptIn: false, // Privacy default: no raw text
  }, controller, e => events.push(e));

  const { input, signal: turnSignal } = controller.begin('text', userText);

  const result = await pipeline.run(input, turnSignal);
  assert.equal(result.status, 'replied');

  // Verify trace was recorded
  const listResult = traceStore.list({ characterId: 'companion' });
  assert.equal(listResult.total, 1);
  const trace = listResult.traces[0]!;
  assert.equal(trace.turnId, input.scope.turnId);
  assert.equal(trace.status, 'ok');
  assert.ok(trace.totalElapsedMs >= 0);

  // Privacy verification: raw text must NOT appear in trace store by default
  assert.ok(!trace.userText.includes('包含个人隐私'), 'Default trace must NOT store raw user text');
  assert.ok(trace.userText.startsWith('[digest:'), 'Default trace userText must be sanitized digest');
  assert.ok(!trace.replyText.includes('很高兴陪伴你'), 'Default trace must NOT store raw reply text');
  assert.ok(trace.replyText.startsWith('[digest:'), 'Default trace replyText must be sanitized digest');

  // Verify real stages
  const stageNames = trace.stages.map(s => s.name);
  assert.ok(stageNames.includes('admission'), 'Must have admission stage');
  assert.ok(stageNames.includes('context'), 'Must have context stage');
  assert.ok(stageNames.includes('llm'), 'Must have llm stage');
  assert.ok(stageNames.includes('assistant_persist'), 'Must have assistant_persist stage');

  for (const s of trace.stages) {
    assert.ok(s.elapsedMs >= 0, `Stage ${s.name} must have non-negative elapsedMs`);
    assert.equal(s.status, 'ok');
  }
});

test('N075-01 R5: RoleMemoryLifecycleQueue appends async background stages to the same turn trace', async t => {
  const { db, cleanup } = createTempDb();
  t.after(cleanup);

  const traceStore = RuntimeTraceStore.open(db);
  const turnScope = scope('companion', 'turn-async-1');

  // 1. Initial foreground trace
  traceStore.record({
    traceId: 'tr-1',
    turnId: 'turn-async-1',
    characterId: 'companion',
    sessionId: 'session-1',
    userText: '用户提问',
    replyText: '助手回答',
    totalElapsedMs: 50,
    status: 'ok',
    stages: [
      { name: 'admission', label: '准入', elapsedMs: 5, status: 'ok' },
      { name: 'llm', label: '模型回复', elapsedMs: 45, status: 'ok' },
    ],
    createdAt: new Date().toISOString(),
  });

  // 2. Mock background memory port
  const mockPort = {
    async prepareBackgroundTurn() {
      return {
        scope: turnScope,
        request: 'none' as const,
        status: 'applied' as const,
        results: [],
        affectedIds: ['mem-new-1'],
        retrievalInvalidated: true,
        clarification: null,
      };
    },
    async foregroundContext() { throw new Error('unused'); },
    async appendAssistant() {},
    assertContextCurrent() {},
    async summarizePending() {
      return { scope: turnScope, status: 'applied' as const, summaryId: 'sum-1' };
    },
  };

  const queue = new RoleMemoryLifecycleQueue(
    mockPort as any,
    () => {},
    traceStore,
  );

  // 3. Enqueue background turn
  await queue.enqueueTurn(turnScope, 'msg-1', '用户提问');

  // 4. Trigger summary
  queue.afterConversationSaved(turnScope);
  await queue.drain();

  // 5. Verify that background stages were appended to the SAME turn trace!
  const list = traceStore.list({ characterId: 'companion' });
  assert.equal(list.total, 1);
  const updatedTrace = list.traces[0]!;
  assert.equal(updatedTrace.turnId, 'turn-async-1');

  const stageNames = updatedTrace.stages.map(s => s.name);
  assert.ok(stageNames.includes('admission'), 'Retains foreground admission');
  assert.ok(stageNames.includes('llm'), 'Retains foreground llm');
  assert.ok(stageNames.includes('memory_plan'), 'Appended background memory_plan stage');
  assert.ok(stageNames.includes('memory_commit'), 'Appended background memory_commit stage');
  assert.ok(stageNames.includes('summary'), 'Appended background summary stage');

  await queue.close();
});
