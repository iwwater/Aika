import { TEXT_SLOTS } from '../providers/text-protocol.js';
import { ManagementError, type ManagedSettings, type ProviderAdapterInfo, type ProviderSelection, type ProviderSlot } from '../contracts/management.js';
import { validateTrialConfiguration, type TrialConfiguration } from '../app/trial-config.js';
import { credentialRegistry } from './credentials.js';
import { managementAdapterCatalog } from '../providers/management-catalog.js';
import type { RegisteredVoiceStore } from '../providers/registered-voices.js';

export const PROVIDER_SLOTS: readonly ProviderSlot[] = ['asr', 'dialogue', 'memory_turn', 'summary', 'perception', 'tts', 'admission'];
const ADAPTERS: Record<ProviderSlot, string> = { asr:'qwen-asr', dialogue: 'qwen-dialogue', memory_turn: 'strict-deepseek', summary: 'qwen-summary', perception: 'qwen-visual-emotion', tts: 'qwen-tts-instruct', admission: 'semantic-admission' };
export function defaultManagedSettings(base: TrialConfiguration, credentials = credentialRegistry(base)): ManagedSettings {
  const providers = Object.fromEntries(PROVIDER_SLOTS.filter(slot=>base.models[slot]).map(slot => {
    const { credentialFile, ...model } = base.models[slot]!;
    return [slot, { ...model, adapterId: TEXT_SLOTS.includes(slot as never) && model.provider === 'deepseek' ? `deepseek-${slot}` : slot === 'perception' && !base.models.asr ? 'qwen-perception' : ADAPTERS[slot], credentialRef: credentials.ref(credentialFile, model.provider),
      ...(slot === 'tts' ? { voice: 'Cherry', language: 'Chinese' } : {}) }];
  })) as ManagedSettings['providers'];
  return { providers, context: { maxRecentMessages: 24, maxMemories: 32, summaryLimit: 8, summaryMinMessages: 12, summaryMaxMessages: 24, timeoutMs: base.memory.timeoutMs } };
}
export function availableAdapters(base: TrialConfiguration, voices?: RegisteredVoiceStore): ProviderAdapterInfo[] {
  return managementAdapterCatalog(base, voices?.snapshot().voices);
}
function invalid(message = '配置字段不受当前运行方式支持。'): never { throw new ManagementError('invalid_request', message); }
function keys(value: unknown, allowed: readonly string[], required = allowed): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const names = Object.keys(value); if (names.some(name => !allowed.includes(name)) || required.some(name => !names.includes(name))) invalid();
}
const text = (value: unknown, max = 160): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f]/.test(value);
export function validateManagedSettings(value: unknown, base: TrialConfiguration, voices?: RegisteredVoiceStore, historical = false, credentials = credentialRegistry(base), draftOnly = false): ManagedSettings {
  keys(value, ['providers', 'context']); keys(value.providers, PROVIDER_SLOTS, PROVIDER_SLOTS.filter(slot=>slot!=='asr' || (!historical && !!base.models.asr)));
  keys(value.context, ['maxRecentMessages', 'maxMemories', 'summaryLimit', 'summaryMinMessages', 'summaryMaxMessages', 'timeoutMs']);
  const limits = { maxRecentMessages: [1, 200], maxMemories: [1, 200], summaryLimit: [0, 50], summaryMinMessages: [2, 200], summaryMaxMessages: [2, 200], timeoutMs: [1000, 300000] };
  for (const [key, [min, max]] of Object.entries(limits)) { const n = value.context[key]; if (!Number.isSafeInteger(n) || (n as number) < min! || (n as number) > max!) invalid('上下文参数超出当前支持范围。'); }
  if ((value.context.summaryMinMessages as number) > (value.context.summaryMaxMessages as number)) invalid('摘要触发条数不能超过摘要读取条数。');
  const adapters = availableAdapters(base, voices);
  if (historical) {
    const legacy = structuredClone(base);
    delete (legacy.models as {asr?:unknown}).asr;
    const plus=legacy.models.perception.model.includes('omni-plus');
    (legacy.models as Record<string,unknown>).perception={...legacy.models.perception,inputMicrosPerToken:plus?53:18,outputMicrosPerToken:plus?40:13.3,reservationMicros:plus?13_100_000:4_500_000};
    for (const slot of TEXT_SLOTS) (legacy.models as Record<string, unknown>)[slot] = { ...base.models[slot],
      provider: 'dashscope', model: 'qwen-plus-2025-12-01', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
      credentialFile: base.models.perception.credentialFile, inputTokenLimit: 32768, outputTokenLimit: 32768,
      inputMicrosPerToken: 0.8, outputMicrosPerToken: 2, reservationMicros: 100000 };
    for (const adapter of availableAdapters(legacy, voices)) if (!adapters.some(a => a.id === adapter.id)) adapters.push(adapter);
  }
  for (const slot of PROVIDER_SLOTS) {
    if(slot==='asr' && value.providers.asr===undefined)continue;
    const p = value.providers[slot];
    const required = ['adapterId', 'provider', 'model', 'endpoint', 'credentialRef', 'inputTokenLimit', 'outputTokenLimit', 'reservationMicros', 'inputMicrosPerToken', 'outputMicrosPerToken'];
    keys(p, [...required, 'characterMicros', 'thinking', 'voice', 'language', 'temperature', 'audioMicrosPerSecond'], required);
    const adapter = adapters.find(a => a.id === p.adapterId && a.slots.includes(slot));
    if (!adapter || adapter.provider !== p.provider || !adapter.endpoints.includes(p.endpoint as string) || !text(p.model) || !text(p.credentialRef)) invalid();
    if (!adapter.models.includes(p.model)) invalid('这个型号尚未登记适配能力和费用边界，不能应用。');
    const choice = adapter.choices?.find(c => c.configuration.model === p.model && c.configuration.endpoint === p.endpoint);
    if (!choice) invalid('型号和服务地址不匹配。');
    const pricing = choice.configuration;
    if (![p.inputTokenLimit, p.outputTokenLimit].every(n => Number.isSafeInteger(n) && (n as number) >= (slot === 'tts' || slot === 'asr' ? 0 : 1))) invalid('模型用量上界无效。');
    if (p.thinking !== pricing.thinking) invalid('思考方式必须与已登记型号一致。');
    for (const key of ['inputMicrosPerToken', 'outputMicrosPerToken', 'reservationMicros', 'characterMicros', 'audioMicrosPerSecond'] as const)
      if (p[key] !== pricing[key]) invalid('计费边界由已登记型号提供，不能在页面中自行改写。');
    if ((p.inputTokenLimit as number) > pricing.inputTokenLimit || (p.outputTokenLimit as number) > pricing.outputTokenLimit) invalid('用量范围不能超过此型号已登记的计费上界。');
    try { credentials.file(p.credentialRef, adapter.provider); } catch { invalid('请选择已登记的同供应商凭据。'); }
    if (p.temperature !== undefined && (!adapter.capabilities.temperature || typeof p.temperature !== 'number' || !Number.isFinite(p.temperature) || p.temperature < 0 || p.temperature > 2)) invalid('此模块不支持所填温度。');
    if (slot === 'tts') {
      if (!text(p.voice, 128) || !choice.voices?.some(v => v.id === p.voice)) invalid('请选择此型号已登记的音色。');
      if (voices?.snapshot().voices.some(voice => voice.voiceId === p.voice)) {
        try { voices.resolve({ voiceId: p.voice, provider: p.provider as 'dashscope', targetModel: p.model,
          endpoint: p.endpoint as string, credentialRef: p.credentialRef }); }
        catch { invalid('克隆音色与此模型、服务地址或凭据不匹配。'); }
      }
      if (adapter.capabilities.language ? !text(p.language, 40) : p.language !== undefined) invalid('语言参数与此语音适配器不匹配。');
    } else if (p.voice !== undefined || p.language !== undefined || p.characterMicros !== undefined) invalid();
    if (slot === 'perception' && !/^qwen3\.5-omni-(flash|plus)(-\d{4}-\d{2}-\d{2})?$/.test(p.model)) invalid('视频情绪需要已支持的Qwen3.5-Omni型号。');
  }
  const settings = structuredClone(value) as unknown as ManagedSettings;
  try { effectiveTrialConfiguration(base, settings, credentials, draftOnly); } catch { invalid('模型参数、调用预留或计费边界无效；额度不会自动扩大。'); }
  return settings;
}
export function effectiveTrialConfiguration(base: TrialConfiguration, settings: ManagedSettings, credentials = credentialRegistry(base), draftOnly = false): TrialConfiguration {
  const models = Object.fromEntries(PROVIDER_SLOTS.filter(slot=>settings.providers[slot]).map(slot => {
    const { adapterId: _adapter, credentialRef, voice: _voice, language: _language, temperature: _temperature, ...model } = settings.providers[slot]!;
    return [slot, { ...model, credentialFile: credentials.file(credentialRef, model.provider) }];
  })) as TrialConfiguration['models'];
  const candidate = { ...base, models, memory: { ...base.memory, timeoutMs: settings.context.timeoutMs } };
  return draftOnly ? candidate : validateTrialConfiguration(candidate);
}
