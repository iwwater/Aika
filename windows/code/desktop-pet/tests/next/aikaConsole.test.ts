// NEXT-07: Aika console presenter semantics (fake ports) plus one production wiring test
// that proves the fake-based tests did not hide an assembly mistake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { TurnScope } from '../../contracts/index.js';
import { nextScope, tick } from './harness.js';
import { NextTurnPort } from '../../core/turn-port.js';
import { offlinePorts } from './harness.js';
import { AikaTimelineRecorder, AikaTimelineStore } from '../../management/aika-timeline.js';
import { AikaProfileStore, defaultAikaProfile } from '../../management/aika-profile.js';
import { aikaManagement, aikaRoute } from '../../management/aika-routes.js';
import { AikaConsolePresenter } from '../../management/aika-console.js';
import type { AikaChatEvent, AikaConsolePorts } from '../../management/aika-console.js';

function presenterPorts(options: {
  submit?: (text: string) => Promise<TurnScope>;
  timeline?: { items: never[]; nextCursor?: string };
} = {}) {
  const listeners = new Set<(event: import('../../core/turn-port.js').TurnPortEvent) => void>();
  const calls = { submit: [] as string[], cancel: 0, saves: 0 };
  let gated: ((value: unknown) => void) | undefined;
  const scope = nextScope('turn-1');
  const turnPort = {
    subscribe(listener: (event: import('../../core/turn-port.js').TurnPortEvent) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    emit: (event: import('../../core/turn-port.js').TurnPortEvent) => { for (const listener of [...listeners]) listener(event); },
    get listenerCount() { return listeners.size; },
    async submit(text: string) {
      calls.submit.push(text);
      const eventScope = options.submit ? await options.submit(text) : scope;
      return eventScope;
    },
    cancel() { calls.cancel++; },
    settle() { gated?.(undefined); }
  };
  const ports: AikaConsolePorts = {
    profile: {
      load: async () => ({ revision: 3, profile: defaultAikaProfile(), providers: [] }),
      save: async (expectedRevision, profile, providers) => {
        calls.saves++;
        if (profile.displayName === '触发失败') throw new Error('保存失败：配置已被其他窗口更新。');
        return { revision: expectedRevision + 1, profile, providers: providers.filter(p => !('apiKey' in p)) };
      }
    },
    timeline: {
      list: async query => (options.timeline ? { ...options.timeline } : { items: [] })
    },
    // FIX61-02: the production port gained a discovery surface. These cases do not exercise it, so the
    // stub reports "nothing discovered"; the discovery behaviour itself is covered by fix61-02 tests.
    discovery: {
      load: async () => null,
      saveSource: async () => null,
      discover: async () => []
    },
    turn: turnPort,
    voice: { available: () => false }
  };
  return { ports, turnPort, calls, setGate: (fn: (value: unknown) => void) => { gated = fn; } };
}

test('07-A config goes through the ports; failures are visible and key material is stripped', async () => {
  const { ports, calls } = presenterPorts();
  const presenter = new AikaConsolePresenter(ports);
  await presenter.load();
  assert.equal(presenter.state.profileRevision, 3);
  assert.equal(presenter.state.profile!.displayName, 'Aika');

  await presenter.saveProfile({ schemaVersion: 1, id: 'aika', displayName: 'Aika·改', systemPrompt: '新的设定。' }, [{ id: 'p1', protocol: 'openai-compatible', endpoint: 'https://x', model: 'm', credentialRef: 'ref-1', credentialConfigured: true }]);
  assert.equal(calls.saves, 1);
  assert.equal(presenter.state.lastError, null);
  assert.ok(presenter.state.providers.every(provider => !('apiKey' in provider)), 'only credentialRef/configured reach the state');

  await assert.rejects(presenter.saveProfile({ schemaVersion: 1, id: 'aika', displayName: '触发失败', systemPrompt: 'x' }, []));
  assert.match(presenter.state.lastError ?? '', /保存失败/, 'save failure is visible to the user');
});

test('07-B send issues exactly one submit; state follows the production terminal; failure allows resend', async () => {
  const pending: ((scope: TurnScope) => void)[] = [];
  const { ports, calls } = presenterPorts({
    submit: async () => new Promise<TurnScope>(done => pending.push(done))
  });
  const presenter = new AikaConsolePresenter(ports);
  presenter.subscribe();
  await assert.rejects(presenter.sendText('   '), /不能为空/);

  const first = presenter.sendText('问题一');
  await assert.rejects(presenter.sendText('并发第二条'), /已有进行中的回复/);
  assert.equal(calls.submit.length, 1, 'concurrent send refused before a second command');
  assert.equal(presenter.state.turnStatus, 'sending');

  pending[0]!(nextScope('turn-1'));
  await first;
  presenter.handleTurnEvent({ scope: nextScope('turn-1'), sequence: 2, type: 'terminal', status: 'completed' });
  assert.equal(presenter.state.turnStatus, 'completed');
  assert.equal(presenter.state.sending, false);

  // A failed terminal shows the error and allows a fresh send.
  const second = presenter.sendText('问题二');
  pending[1]!(nextScope('turn-2'));
  const scope2 = await second;
  presenter.handleTurnEvent({ scope: scope2, sequence: 2, type: 'terminal', status: 'failed', errorCode: 'provider_down' });
  assert.equal(presenter.state.turnStatus, 'failed');
  assert.match(presenter.state.lastError ?? '', /provider_down/);
  const third = presenter.sendText('问题三');
  pending[2]!(nextScope('turn-3'));
  await third;
  assert.equal(calls.submit.length, 3);

  presenter.cancel();
  assert.equal(calls.cancel, 1, 'cancel reaches the port');
});

test('07-C switching sessions ignores stale results; dispose removes every listener', async () => {
  const { ports, turnPort } = presenterPorts();
  const presenter = new AikaConsolePresenter(ports);
  presenter.subscribe();
  presenter.setSession('session-b');
  presenter.handleTurnEvent({ scope: nextScope('turn-old', 1, 'session-a'), sequence: 2, type: 'terminal', status: 'completed' });
  assert.equal(presenter.state.turnStatus, 'idle', 'stale session results never overwrite the current view');
  presenter.handleTurnEvent({ scope: nextScope('turn-new', 1, 'session-b'), sequence: 2, type: 'terminal', status: 'completed' });
  assert.equal(presenter.state.turnStatus, 'completed');

  assert.equal(turnPort.listenerCount, 1);
  presenter.dispose();
  assert.equal(turnPort.listenerCount, 0, 'dispose unsubscribes');
  presenter.handleTurnEvent({ scope: nextScope('turn-new-2', 1, 'session-b'), sequence: 2, type: 'terminal', status: 'failed' });
  assert.equal(presenter.state.turnStatus, 'completed', 'disposed presenter stops reacting');
});

test('07-D timeline pages through cursors, shows partial statuses and hides redacted text', async () => {
  const redacted = { eventId: 'e3', scope: nextScope('t3', 1, 'session-b'), kind: 'userMessage' as const, messageId: 't3:user' };
  const pages: { items: AikaChatEvent[]; nextCursor?: string }[] = [
    { items: [{ eventId: 'e1', scope: nextScope('t1', 1, 'session-b'), kind: 'userMessage', messageId: 't1:user', text: '第一条' }, { eventId: 'e2', scope: nextScope('t2', 1, 'session-b'), kind: 'assistantTerminal', messageId: 't2:assistant', text: '部分回答', status: 'cancelled' }], nextCursor: 'c1' },
    { items: [redacted] }
  ];
  let pageIndex = 0;
  const { ports } = presenterPorts();
  const portsWithPaging: AikaConsolePorts = { ...ports, timeline: { list: async () => pages[pageIndex++] ?? { items: [] } } };
  const presenter = new AikaConsolePresenter(portsWithPaging);
  await presenter.loadTimeline();
  assert.equal(presenter.state.timeline.length, 2);
  const cancelled = presenter.state.timeline.find(item => item.status === 'cancelled');
  assert.ok(cancelled, 'cancelled status is displayed');
  await presenter.loadMoreTimeline();
  assert.equal(presenter.state.timeline.length, 3);
  const hidden = presenter.state.timeline.find(item => item.eventId === 'e3');
  assert.equal(hidden!.text, undefined, 'redacted text is absent after refresh');
});

test('07-E missing voice backend reports unavailable, never fake-enabled', () => {
  const { ports } = presenterPorts();
  const presenter = new AikaConsolePresenter(ports);
  assert.equal(presenter.state.voiceStatus, 'unavailable');
});

test('07-F production wiring: real stores + real turn port + recorder through the presenter', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'next-console-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  const profileFile = resolve(dir, 'aika-profile.json');
  const timelineFile = resolve(dir, 'timeline.sqlite');
  const profileStore = await AikaProfileStore.open(profileFile);
  const timelineStore = await AikaTimelineStore.open(timelineFile);
  const scope = nextScope('wired-turn', 1, 'wired-session');
  const turnPort = new NextTurnPort(offlinePorts(async request => ({ scope: request.scope, text: `关于${request.text}的回答。`, expression: { emotion: 'neutral', intensity: 0, delivery: '', gesture: null } })));
  const recorder = new AikaTimelineRecorder(turnPort, timelineStore);
  const stopRecorder = recorder.start();
  const management = aikaManagement(profileStore, timelineStore);

  const ports: AikaConsolePorts = {
    profile: {
      load: async () => ({ revision: management.profile().revision, profile: management.profile().profile, providers: [] }),
      save: async (expectedRevision, profile, providers) => {
        const saved = await management.saveProfile(expectedRevision, profile, providers);
        return { revision: saved.revision, profile: saved.profile, providers: saved.providers };
      }
    },
    timeline: { list: query => management.timeline(query) as never },
    discovery: { load: async () => null, saveSource: async () => null, discover: async () => [] },
    turn: { submit: text => turnPort.submit({ text }), cancel: () => turnPort.cancel(), subscribe: listener => turnPort.subscribe(listener) },
    voice: { available: () => false }
  };
  const presenter = new AikaConsolePresenter(ports);
  presenter.subscribe();
  await presenter.load();

  await presenter.saveProfile({ schemaVersion: 1, id: 'aika', displayName: 'Aika', systemPrompt: '接线测试设定。' }, []);
  const written = JSON.parse(await readFile(profileFile, 'utf8'));
  assert.equal(written.profile.systemPrompt, '接线测试设定。', 'the real store file received the save');

  const submitted = await presenter.sendText('接线问题');
  await new Promise<void>(done => {
    const unsubscribe = turnPort.subscribe(event => { if (event.type === 'terminal' && event.scope.turnId === submitted.turnId) { unsubscribe(); done(); } });
  });
  for (let i = 0; i < 10 && presenter.state.turnStatus === 'sending'; i++) await tick();
  assert.equal(presenter.state.turnStatus, 'completed', 'the real turn reached the presenter state');

  await presenter.loadTimeline();
  assert.deepEqual(presenter.state.timeline.map(item => item.kind), ['userMessage', 'assistantTerminal'], 'the real timeline recorded both sides');
  assert.equal(presenter.state.timeline[0]!.text, '接线问题');
  stopRecorder();
  profileStore.close();
  timelineStore.close();
});

test('route layer: aikaRoute serves profile and timeline from the real management adapter', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'next-routes-'));
  const profileStore = await AikaProfileStore.open(resolve(dir, 'aika-profile.json'));
  const timelineStore = await AikaTimelineStore.open(resolve(dir, 'timeline.sqlite'));
  const management = aikaManagement(profileStore, timelineStore);
  t.after(async () => { profileStore.close(); timelineStore.close(); await rm(dir, { recursive: true, force: true }); });
  await profileStore.save(0, defaultAikaProfile(), []);
  await timelineStore.append({ schemaVersion: 1, eventId: 'e1', scope: nextScope('t1', 1, 'session-r'), sequence: 1, occurredAt: '2026-09-20T00:00:00.000Z', kind: 'userMessage', messageId: 't1:user', text: '路由可见' });

  const profile = await aikaRoute('GET', management, '/api/aika/profile', new URLSearchParams(), async () => ({}));
  assert.equal((profile as { profile: { displayName: string } }).profile.displayName, 'Aika');
  const saved = await aikaRoute('PUT', management, '/api/aika/profile', new URLSearchParams(), async () => ({ expectedRevision: 1, profile: { schemaVersion: 1, id: 'aika', displayName: 'Aika·路由', systemPrompt: '路由设定。' }, providers: [{ id: 'p', protocol: 'gemini', endpoint: 'https://x', model: 'm', credentialRef: 'r', credentialConfigured: false }] }));
  assert.equal((saved as { profile: { displayName: string } }).profile.displayName, 'Aika·路由');
  const page = await aikaRoute('GET', management, '/api/aika/timeline', new URLSearchParams([['sessionId', 'session-r'], ['limit', '20']]), async () => ({})) as { items: { text?: string }[] };
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0]!.text, '路由可见');
  await assert.rejects(aikaRoute('GET', management, '/api/aika/timeline', new URLSearchParams([['sessionId', 's'], ['limit', '999']]), async () => ({})), /limit/);
});
