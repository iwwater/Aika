import test from 'node:test';
import assert from 'node:assert/strict';
import { BackendSession } from '../../app/backend-session.js';
import { MemoryMediaStore } from '../../media/store.js';
import type { BackendToDesktop } from '../../contracts/desktop-bridge.js';
import type { PerceptionResult, TurnScope } from '../../contracts/index.js';
const tick = () => new Promise<void>(r => setImmediate(r));
function deferred<T>() { let resolve!: (v: T) => void, reject!: (e: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const original = '嗯，请整理合成项目里的两条说明 <b>保留原话</b>';
const planned = '整理两条说明并返回摘要';
async function setup() {
  const { app } = await import(new URL('../../../tests/desktop/ui-harness.mjs', import.meta.url).href);
  const ui = await app({ explicitRouting: true }), output: BackendToDesktop[] = [], failures: unknown[] = [], calls: string[] = [];
  const route = deferred<'handled'>(), asr = deferred<PerceptionResult>(), media = new MemoryMediaStore();
  let uiIndex = 0, outIndex = 0, capturedScope: TurnScope | undefined, routeScope: TurnScope | undefined;
  const session = new BackendSession({ mediaStore: media,
    perception: { async perceive(input) { capturedScope = input.scope; calls.push('perception'); return asr.promise; } },
    dialogue: { async reply() { calls.push('dialogue'); throw Error('Engineering cannot call companion dialogue'); } },
    tts: { async synthesize() { calls.push('tts'); throw Error('Engineering cannot speak'); } },
    memory: { async append() { calls.push('append'); }, async context() { calls.push('context'); throw Error('No companion context'); }, async maintain() { calls.push('maintenance'); return []; }, maintenanceInput(scope) { calls.push('maintenanceInput'); return { scope, messages: [], relevantMemories: [] }; } },
  }, message => output.push(message), () => {});
  session.attachWork({ async route(scope, text) {
    routeScope = scope; calls.push('route-start'); assert.equal(text, original);
    assert.ok(output.some(m => m.channel === 'event' && (m.event.type === 'transcript' && m.event.text === original || m.event.type === 'turn' && m.event.input.kind === 'text' && m.event.input.text === original)));
    return route.promise;
  }, async action() { calls.push('action'); }, onInput() {}, async close() {} });
  const launch = (p: Promise<unknown>) => { void p.catch(e => failures.push(e)); };
  const pump = async (done: () => boolean) => {
    for (let i = 0; i < 120; i++) {
      while (uiIndex < ui.messages.length) { const m = ui.messages[uiIndex++]; if (m.name === 'desktop') launch(session.receiveLine(JSON.stringify(m.value.message))); }
      while (outIndex < output.length) launch(ui.bridge.receive(JSON.parse(JSON.stringify(output[outIndex++])), 1));
      await tick(); assert.deepEqual(failures, []); if (done() && uiIndex === ui.messages.length && outIndex === output.length) return;
    }
    assert.fail('Synthetic frontend/backend did not reach expected stage');
  };
  ui.changed(1); await pump(() => !ui.node('voice').disabled);
  const begin = async (kind: 'voice' | 'text') => {
    if (kind === 'text') { ui.node('text').value = original; ui.node('form').onsubmit({ preventDefault() {} }); await pump(() => calls.includes('route-start')); return; }
    ui.node('voice').onclick(); await pump(() => ui.harness.captureOpens === 1);
    ui.harness.openCapture({ stop() {}, async finish() { return { audio: Uint8Array.of(1, 2, 3), images: [], captureStoppedAt: new Date().toISOString() }; } });
    await pump(() => ui.node('status').textContent.includes('正在听'));
    ui.node('voice').onclick(); await pump(() => calls.includes('perception'));
  };
  const transcribe = () => asr.resolve({ scope: capturedScope!, transcript: original, modalities: [], cues: [], status: 'complete' });
  const close = async () => { route.resolve('handled'); if (capturedScope) transcribe(); ui.changed(1, 'disconnected'); await session.close(); };
  return { ui, output, calls, route, begin, transcribe, pump, close, media, scope: () => routeScope };
}
for (const kind of ['voice', 'text'] as const) test('actual UI/backend shows original ' + kind + ' while planning is pending and keeps it beside the task card', async () => {
  const f = await setup();
  try {
    await f.begin(kind);
    if (kind === 'voice') {
      assert.match(f.ui.node('status').textContent, /正在转写/);
      assert.equal(f.output.some(m => m.channel === 'event' && m.event.type === 'transcript'), false);
      f.transcribe(); await f.pump(() => f.calls.includes('route-start'));
    }
    assert.ok(f.ui.node('reply').textContent.includes(original), 'original must be visible before planning settles');
    assert.equal(f.output.some(m => m.channel === 'input_route'), false);
    const before = f.output.filter(m => m.channel === 'event').map(m => m.event);
    if (kind === 'voice') assert.ok(before.findIndex(e => e.type === 'transcript') < before.findIndex(e => e.type === 'presentation' && e.presentation.state === 'thinking'));
    assert.deepEqual(f.calls.filter(c => c !== 'perception'), ['route-start']);
    const confirmation = { id: 'synthetic-request', version: 1, phase: 'awaiting_confirmation' as const, text: planned, executor: 'harness' as const, createdAt: 'synthetic' };
    f.output.push({ channel: 'work_state', state: { sequence: 1, focus: 'work', stage: 'confirming', confirmation, requests: [confirmation], activeRequestId: confirmation.id } });
    f.route.resolve('handled'); await f.pump(() => f.output.some(m => m.channel === 'input_route'));
    assert.ok(f.ui.node('reply').textContent.includes(original)); assert.ok(!f.ui.node('reply').textContent.includes(planned));
    assert.ok(f.ui.node('work-card').textContent.includes(planned)); assert.equal(f.ui.node('work-card').hidden, false);
    assert.deepEqual(f.calls.filter(c => c !== 'perception'), ['route-start']); assert.equal(f.ui.harness.playOpens, 0);
  } finally { await f.close(); }
});
for (const ending of ['failure', 'cancel'] as const) test('confirmed ASR remains visible after planning ' + ending + ' with no companion write or stale route', async () => {
  const f = await setup();
  try {
    await f.begin('voice'); f.transcribe(); await f.pump(() => f.calls.includes('route-start'));
    assert.ok(f.ui.node('reply').textContent.includes(original));
    if (ending === 'failure') f.route.reject(Error('Synthetic planning failure'));
    else { f.ui.node('stop').onclick(); await f.pump(() => f.output.some(m => m.channel === 'capture_stop')); f.route.resolve('handled'); }
    await f.pump(() => f.media.count === 0);
    assert.ok(f.ui.node('reply').textContent.includes(original));
    assert.equal(f.output.some(m => m.channel === 'input_route'), false);
    assert.deepEqual(f.calls.filter(c => c !== 'perception'), ['route-start']);
  } finally { await f.close(); }
});
test('cancel before ASR completion suppresses late original text and planning', async () => {
  const f = await setup();
  try {
    await f.begin('voice'); f.ui.node('stop').onclick(); await f.pump(() => f.output.some(m => m.channel === 'capture_stop'));
    f.transcribe(); await f.pump(() => f.media.count === 0);
    assert.equal(f.output.some(m => m.channel === 'event' && m.event.type === 'transcript'), false);
    assert.ok(!f.ui.node('reply').textContent.includes(original)); assert.deepEqual(f.calls, ['perception']);
  } finally { await f.close(); }
});
