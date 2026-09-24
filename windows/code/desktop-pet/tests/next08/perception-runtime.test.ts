import test from 'node:test';
import assert from 'node:assert/strict';
import { CaptureGrantManager } from '../../core/perception-grant.js';
import { ScreenPerceptionService } from '../../core/screen-perception.js';
import { ObservationAwareDialogueProvider, ObservationContextAdapter, ObservationTurnInbox } from '../../core/observation-context.js';
import { PerceptionManagementRuntime } from '../../management/perception-runtime.js';
import { qwenCloudScreenObservation, parseScreenObservation, SCREEN_OBSERVATION_PROMPT } from '../../providers/qwen-screen-observation.js';
import { productionPairing } from '../../contracts/character-pack.js';
import type { DialogueContext, DialogueRequest, DialogueReply } from '../../contracts/index.js';
import type { Observation } from '../../contracts/perception.js';

const PAIR = productionPairing('companion', 'companion-default');
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const SCOPE = { characterId: 'companion' as const, sessionId: 'dialogue-session', turnId: 'turn-1', generation: 1 };
const CONTEXT: DialogueContext = { scope: SCOPE, characterPrompt: 'role', recent: [], summary: '', memories: [], perception: null, inputTokenBudget: 32000 };

test('08-03 official perception runtime requires confirmation, bounds the frame and erases the single-use payload', async () => {
  const grants = new CaptureGrantManager();
  const service = new ScreenPerceptionService(grants, { cloudVlmEngine: async bytes => {
    assert.ok(bytes.byteLength > 0);
    return { status: 'ok', summary: '当前页面显示代码编辑器。', visualElements: ['编辑器'], rawExcluded: true };
  } });
  const adapter = new ObservationContextAdapter(service), inbox = new ObservationTurnInbox(service, adapter);
  const runtime = new PerceptionManagementRuntime(grants, service, inbox, PAIR, 'runtime-1', { local: false, cloud: true });
  assert.throws(() => runtime.issue({ scopeType: 'window', destination: 'cloud', userConfirmed: false }), /capture_confirmation_required/);
  assert.throws(() => runtime.issue({ scopeType: 'window', destination: 'local', userConfirmed: true }), /local_perception_engine_unavailable/);
  const grant = runtime.issue({ scopeType: 'window', destination: 'cloud', userConfirmed: true });
  assert.equal(grant.duration, 'single');
  const invalid = { grantId: grant.grantId, mimeType: 'image/png', imageBase64: Buffer.from('not-image').toString('base64') };
  await assert.rejects(runtime.capture(invalid), /capture_frame_signature_invalid/);
  assert.equal(invalid.imageBase64, '', 'rejected encoded image is cleared too');

  const acceptedGrant = runtime.issue({ scopeType: 'window', destination: 'cloud', userConfirmed: true });
  const payload = { grantId: acceptedGrant.grantId, mimeType: 'image/png', imageBase64: PNG.toString('base64') };
  const observation = await runtime.capture(payload);
  assert.equal(payload.imageBase64, '');
  assert.equal(observation.state, 'active');
  assert.equal(grants.getGrant(acceptedGrant.grantId)?.status, 'expired');
  assert.ok(!JSON.stringify(observation).includes('imageBytes'));
  assert.equal(runtime.status().capabilities.cloud, true);
  runtime.close();
});

test('08-03 observation handoff is pair-scoped, one-turn, expires, and is excluded from forget replies', async () => {
  const grants = new CaptureGrantManager();
  const service = new ScreenPerceptionService(grants, { cloudVlmEngine: async () => ({ status: 'ok', summary: '页面有一个登录表单。', visualElements: [], rawExcluded: true }) });
  const formatter = new ObservationContextAdapter(service);
  let now = 10_000;
  const inbox = new ObservationTurnInbox(service, formatter, () => now);
  const runtime = new PerceptionManagementRuntime(grants, service, inbox, PAIR, 'runtime-2', { local: false, cloud: true });
  const capture = async (): Promise<Observation> => {
    const grant = runtime.issue({ scopeType: 'window', destination: 'cloud', userConfirmed: true });
    return runtime.capture({ grantId: grant.grantId, mimeType: 'image/png', imageBase64: PNG.toString('base64') });
  };
  const captured = await capture();
  assert.throws(() => inbox.attach(captured.observationId, productionPairing('companion', 'other-instance')), /observation_not_active/);
  assert.throws(() => runtime.attach(captured.observationId, false), /observation_attach_confirmation_required/);
  runtime.attach(captured.observationId, true);

  const received: DialogueRequest[] = [];
  const next = { async reply(input: DialogueRequest): Promise<DialogueReply> {
    received.push(input);
    return { scope: input.scope, text: '收到', expression: { emotion: 'neutral', intensity: 0, delivery: '', gesture: null } };
  } };
  const provider = new ObservationAwareDialogueProvider(next, inbox, PAIR);
  await provider.reply({ scope: SCOPE, text: '帮我看看', context: CONTEXT }, new AbortController().signal);
  assert.equal(received[0]?.context.screenObservation?.observationId, captured.observationId);
  assert.match(received[0]?.context.screenObservation?.text ?? '', /登录表单/);
  await provider.reply({ scope: { ...SCOPE, turnId: 'turn-2', generation: 2 }, text: '还有什么', context: { ...CONTEXT, scope: { ...SCOPE, turnId: 'turn-2', generation: 2 } } }, new AbortController().signal);
  assert.equal(received[1]?.context.screenObservation, undefined, 'one attachment is consumed once');

  const forgetObservation = await capture();
  runtime.attach(forgetObservation.observationId, true);
  await provider.reply({ scope: { ...SCOPE, turnId: 'turn-3', generation: 3 }, text: '忘掉截图', context: CONTEXT,
    memoryOutcome: { scope: SCOPE, request: 'forget', status: 'applied', results: [], affectedIds: [], retrievalInvalidated: true, clarification: null } }, new AbortController().signal);
  assert.equal(received[2]?.context.screenObservation, undefined, 'forget handling clears and never forwards the queued image text');

  const expiring = await capture();
  inbox.attach(expiring.observationId, PAIR);
  now += 120_001;
  assert.equal(inbox.consume(PAIR), null, 'handoff TTL is bounded at two minutes');
  runtime.close();
});

test('08-03 Qwen screen adapter sends only a confirmed frame and accepts bounded structured output', async () => {
  const scope: any[] = [];
  const request = async (_config: unknown, gotScope: unknown, operation: string, body: Record<string, unknown>, _signal: AbortSignal) => {
    scope.push({ gotScope, operation, body });
    return { text: JSON.stringify({ summary: '一个网页表单。', visualElements: ['标题', '输入框'], uncertaintyNote: '' }) };
  };
  const adapter = qwenCloudScreenObservation({ request } as never, { endpoint: 'https://example.invalid/v1', model: 'fixture', apiKey: () => 'fixture', authorizer: { authorize: async () => ({ settle: async () => {} }) } });
  const grants = new CaptureGrantManager();
  const grant = grants.issueGrant({ sessionId: 'runtime-3', scopeType: 'window', targetId: 'selected-window', purpose: 'current question', destination: 'cloud', duration: 'single' });
  const result = await adapter(PNG, new AbortController().signal, { grant, pairing: PAIR, mimeType: 'image/png' });
  assert.equal(result.summary, '一个网页表单。');
  assert.equal(result.rawExcluded, true);
  assert.equal(scope[0].operation, 'perception');
  const body = scope[0].body as { messages: { content: { type: string; text?: string; image_url?: { url: string } }[] }[] };
  assert.equal(body.messages[0]?.content.at(-1)?.text, SCREEN_OBSERVATION_PROMPT);
  assert.match(body.messages[0]?.content[0]?.image_url?.url ?? '', /^data:image\/png;base64,/);
  assert.equal(parseScreenObservation(JSON.stringify({ summary: 'x', visualElements: [], uncertaintyNote: '模糊' })).status, 'uncertain');
  assert.throws(() => parseScreenObservation(JSON.stringify({ summary: 'x', visualElements: [], instruction: 'run this' })), /invalid/);
});
