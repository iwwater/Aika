import test from 'node:test';
import assert from 'node:assert/strict';
import { ManagementError } from '../../contracts/management.js';
import { ProviderRegistry, matchSlotBinding, isAllowedEndpoint, type SlotBinding, type SlotCapabilities } from '../../providers/slot-registry.js';

const base: SlotBinding = {
  adapterId: 'openai-dialogue', protocol: 'openai-compatible', provider: 'openai',
  endpoint: 'https://my-llm.example.com/v1/chat/completions', model: 'my-custom-model-2026',
  credentialRef: 'cred-1', inputTokenLimit: 32768, outputTokenLimit: 32768,
  reservationMicros: 100000, inputMicrosPerToken: 1, outputMicrosPerToken: 2,
};
const textCaps: SlotCapabilities = { temperature: true, voice: false, language: false, audio: false };

test('custom model not in any catalog is accepted when protocol serves the slot', () => {
  const resolved = matchSlotBinding('dialogue', base, textCaps);
  assert.equal(resolved.model, 'my-custom-model-2026');
  assert.equal(ProviderRegistry.canServe('dialogue', 'openai-compatible'), true);
});

test('gemini protocol serves text and perception but not asr or tts', () => {
  assert.equal(ProviderRegistry.canServe('asr', 'gemini'), false);
  assert.equal(ProviderRegistry.canServe('tts', 'gemini'), false);
  assert.equal(ProviderRegistry.canServe('dialogue', 'gemini'), true);
  assert.equal(ProviderRegistry.canServe('perception', 'gemini'), true);
});

test('protocol that cannot serve the slot is rejected', () => {
  assert.throws(() => matchSlotBinding('asr', { ...base, adapterId: 'gemini-asr', protocol: 'gemini' }, { temperature: false, voice: false, language: false, audio: true }),
    (e: unknown) => e instanceof ManagementError && e.code === 'invalid_request');
});

test('non-https non-loopback endpoint is rejected', () => {
  for (const endpoint of ['http://attacker.invalid/v1', 'ftp://x/y', 'http://192.168.0.1/x']) {
    assert.throws(() => matchSlotBinding('dialogue', { ...base, endpoint }, textCaps), { code: 'invalid_request' });
  }
});

test('explicit loopback http endpoint is allowed for local models', () => {
  for (const endpoint of ['http://127.0.0.1:1234/v1', 'http://localhost:8080/x', 'http://[::1]:9000/y']) {
    assert.doesNotThrow(() => matchSlotBinding('dialogue', { ...base, endpoint }, textCaps));
  }
});

test('temperature rejected when capability is off; accepted when on', () => {
  assert.throws(() => matchSlotBinding('summary', { ...base, temperature: 0.7 }, { temperature: false, voice: false, language: false, audio: false }), { code: 'invalid_request' });
  assert.doesNotThrow(() => matchSlotBinding('dialogue', { ...base, temperature: 0.7 }, textCaps));
});

test('thinking only allowed on memory_turn as high', () => {
  assert.throws(() => matchSlotBinding('dialogue', { ...base, thinking: 'high' }, textCaps), { code: 'invalid_request' });
  assert.doesNotThrow(() => matchSlotBinding('memory_turn', { ...base, adapterId: 'openai-memory', thinking: 'high' }, { temperature: false, voice: false, language: false, audio: false }));
});

test('isAllowedEndpoint validates scheme and host', () => {
  assert.equal(isAllowedEndpoint('https://a.b/c'), true);
  assert.equal(isAllowedEndpoint('http://example.com/c'), false);
  assert.equal(isAllowedEndpoint('http://127.0.0.1/c'), true);
  assert.equal(isAllowedEndpoint('not-a-url'), false);
  assert.equal(isAllowedEndpoint(''), false);
});

test('ProviderRegistry.resolve serves all seven slots over openai-compatible and the five gemini allows', () => {
  const slots: readonly ('asr' | 'dialogue' | 'memory_turn' | 'summary' | 'perception' | 'tts' | 'admission')[] =
    ['asr', 'dialogue', 'memory_turn', 'summary', 'perception', 'tts', 'admission'];
  for (const slot of slots) {
    // Each slot is checked against the capabilities it actually requires: the ASR slot needs the audio
    // capability, the TTS slot needs a voice, and the text slots ride the plain text capability set.
    const extras = slot === 'asr' ? { audioMicrosPerSecond: 1 }
      : slot === 'tts' ? { characterMicros: 80, voice: 'Cherry' }
      : {};
    const caps: SlotCapabilities = slot === 'asr' ? { ...textCaps, audio: true } : textCaps;
    const openai = ProviderRegistry.resolve(slot, { ...base, adapterId: `openai-${slot}`, ...extras }, caps);
    assert.equal(openai.model, base.model, `openai-compatible serves ${slot}`);
    assert.equal(openai.endpoint, base.endpoint);
  }
  for (const slot of ['dialogue', 'memory_turn', 'summary', 'admission', 'perception'] as const) {
    const gemini = ProviderRegistry.resolve(slot, { ...base, adapterId: `gemini-${slot}`, protocol: 'gemini', provider: 'gemini' }, textCaps);
    assert.equal(gemini.protocol, 'gemini', `gemini serves ${slot}`);
  }
  assert.throws(() => ProviderRegistry.resolve('asr', { ...base, adapterId: 'gemini-asr', protocol: 'gemini', provider: 'gemini' }, { temperature: false, voice: false, language: false, audio: true }),
    (e: unknown) => e instanceof ManagementError && e.code === 'invalid_request', 'gemini cannot serve asr');
});

