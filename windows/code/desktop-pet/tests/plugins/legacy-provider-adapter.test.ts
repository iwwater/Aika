import test from 'node:test';
import assert from 'node:assert/strict';
import type { TrialConfiguration } from '../../app/trial-config.js';
import { LegacyProviderRuntimeAdapter } from '../../plugins/legacy-provider-adapter.js';

test('N075-01 R7: LegacyProviderRuntimeAdapter maps TrialConfiguration slots onto ProviderRuntime', () => {
  const mockConfig = {
    version: 1,
    phaseId: 'phase-test',
    purpose: 'smoke-text',
    projectRoot: 'F:\\AIVoice\\Aika-Next\\windows\\code\\desktop-pet',
    sourceRevision: '1',
    runtimeFiles: {},
    database: ':memory:',
    limitMicros: null,
    budgetMode: 'unlimited',
    models: {
      dialogue: {
        provider: 'dashscope',
        protocol: 'openai-compatible',
        model: 'qwen-plus',
        endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        credentialFile: 'credentials/key.txt',
        inputTokenLimit: 32768,
        outputTokenLimit: 8192,
        inputMicrosPerToken: 0.8,
        outputMicrosPerToken: 2.0,
        reservationMicros: 100000,
      },
      memory_turn: {
        provider: 'deepseek',
        protocol: 'openai-compatible',
        model: 'deepseek-chat',
        endpoint: 'https://api.deepseek.com/v1',
        credentialFile: 'credentials/deepseek.txt',
        inputTokenLimit: 65536,
        outputTokenLimit: 8192,
        inputMicrosPerToken: 1.0,
        outputMicrosPerToken: 2.0,
        reservationMicros: 60000,
      },
      tts: {
        provider: 'dashscope',
        protocol: 'openai-compatible',
        model: 'cosyvoice-v1',
        endpoint: 'https://dashscope.aliyuncs.com/api/v1/tts',
        credentialFile: 'credentials/key.txt',
        inputTokenLimit: 0,
        outputTokenLimit: 0,
        inputMicrosPerToken: 0,
        outputMicrosPerToken: 0,
        reservationMicros: 50000,
      },
    } as any,
    memory: { mode: 'strict', scheduling: 'semantic-admission', timeoutMs: 30000 },
  } as unknown as TrialConfiguration;

  const authorizer = { async authorize() { return { async settle() {} }; } };
  const keys: Record<string, string> = {
    'credentials/key.txt': 'sk-ali-12345',
    'credentials/deepseek.txt': 'sk-ds-67890',
  };

  const adapter = new LegacyProviderRuntimeAdapter(
    mockConfig,
    authorizer,
    ref => () => keys[ref ?? ''] ?? 'fallback-key',
  );

  // 1. Verify underlying ProviderRuntime has registered the bindings
  const dialogueBinding = adapter.resolveOperationBinding('dialogue');
  assert.equal(dialogueBinding.bindingId, 'legacy.dialogue');
  assert.equal(dialogueBinding.nativeModelId, 'qwen-plus');
  assert.equal(dialogueBinding.adapterId, 'legacy.openai.adapter');
  assert.ok(dialogueBinding.instanceKey.includes('legacy.dialogue'));

  const memoryBinding = adapter.resolveOperationBinding('memory_turn');
  assert.equal(memoryBinding.bindingId, 'legacy.memory_turn');
  assert.equal(memoryBinding.nativeModelId, 'deepseek-chat');

  const ttsBinding = adapter.resolveOperationBinding('tts');
  assert.equal(ttsBinding.bindingId, 'legacy.tts');
  assert.equal(ttsBinding.nativeModelId, 'cosyvoice-v1');
  assert.equal(ttsBinding.nativeVoiceId, 'Cherry');

  // 2. Verify EndpointConfig mapping
  const dialogueConfig = adapter.getEndpointConfig('dialogue');
  assert.equal(dialogueConfig.model, 'qwen-plus');
  assert.equal(dialogueConfig.endpoint, 'https://dashscope.aliyuncs.com/compatible-mode/v1');
  assert.equal(dialogueConfig.apiKey(), 'sk-ali-12345');

  const memoryConfig = adapter.getEndpointConfig('memory_turn');
  assert.equal(memoryConfig.model, 'deepseek-chat');
  assert.equal(memoryConfig.endpoint, 'https://api.deepseek.com/v1');
  assert.equal(memoryConfig.apiKey(), 'sk-ds-67890');

  // 3. Verify unconfigured slot throws error from ProviderRuntime resolution
  assert.throws(
    () => adapter.getEndpointConfig('asr'),
    (err: any) => err.category === 'dependency_unsatisfied' || /not registered/i.test(err.message),
  );
});
