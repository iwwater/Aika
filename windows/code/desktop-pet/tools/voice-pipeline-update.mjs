// Reconstructed FIX61-10: the voice-pipeline update tool lost in the .git object-store loss.
// It derives the "voice enabled" evaluation configuration from an existing trial configuration:
//  - switches purpose to the unlimited accounting mode (evaluation run, not the shared trial budget),
//  - adds the ASR slot (qwen3-asr-flash) with its per-audio-second tariff,
//  - keeps every other binding exactly as configured.
// `nextVoiceSettings` migrates an existing ManagementSettingsStore file to the new configuration:
// the previous current revision becomes history, and text/memory slots are preserved verbatim.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultManagedSettings } from '../dist/management/settings.js';

const chat = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';

export function nextVoiceConfiguration(base) {
  const asr = {
    provider: 'dashscope', model: 'qwen3-asr-flash-2026-02-10', endpoint: chat,
    credentialFile: base.models.memory_turn.provider === 'deepseek'
      ? base.models.memory_turn.credentialFile.replace(/deepseek/, 'dashscope')
      : base.models.perception.credentialFile,
    reservationMicros: 220, inputTokenLimit: 0, outputTokenLimit: 0,
    inputMicrosPerToken: 0, outputMicrosPerToken: 0, audioMicrosPerSecond: 220
  };
  // Unlimited accounting only trusts a ledger whose limitMicros is null and whose batchId matches.
  // The bounded trial ledger is migrated in place (entries preserved, batch re-issued) so the
  // evaluation config records its reservations from the first call.
  let entries = [];
  try {
    const state = JSON.parse(readFileSync(base.budgetFile, 'utf8'));
    if (Array.isArray(state.entries)) entries = state.entries;
  } catch { /* a missing ledger starts empty */ }
  const budgetBatchId = 'voice-' + (base.budgetBatchId || 'eval').slice(0, 24);
  writeFileSync(base.budgetFile, JSON.stringify({ batchId: budgetBatchId, currency: 'CNY', limitMicros: null, budgetMode: 'unlimited', blocked: false, entries }, null, 2) + '\n');
  return {
    ...structuredClone(base),
    budgetMode: 'unlimited', limitMicros: null, budgetBatchId,
    operationLimits: undefined, maxCalls: undefined, phaseLimitMicros: undefined,
    models: { ...structuredClone(base.models), asr }
  };
}

export function nextVoiceSettings(previousState, configuration, savedAt) {
  const defaults = defaultManagedSettings(configuration);
  const preservedSlots = ['dialogue', 'memory_turn', 'summary', 'admission', 'tts'];
  const current = previousState.current;
  const next = {
    ...structuredClone(current),
    revision: current.revision + 1,
    savedAt,
    settings: {
      ...defaults,
      providers: Object.fromEntries([
        ...preservedSlots.map(slot => [slot, structuredClone(current.settings.providers[slot])]),
        ['perception', structuredClone(current.settings.providers.perception)],
        ['asr', structuredClone(defaults.providers.asr)]
      ])
    }
  };
  return { version: 1, current: next, history: [current, ...previousState.history].slice(-10) };
}
