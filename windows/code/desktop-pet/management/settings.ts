import { TEXT_SLOTS } from '../providers/text-protocol.js';
import { isAllowedEndpoint } from '../providers/slot-registry.js';
import { ManagementError, isProviderId, type ManagedSettings, type ProviderAdapterInfo, type ProviderProtocol, type ProviderSelection, type ProviderSlot } from '../contracts/management.js';
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

/**
 * FIX61-01: the user configures a model, an endpoint and a protocol — never an internal adapter id.
 * This resolver keeps a reviewed adapter only while the binding still describes that exact reviewed
 * choice; as soon as the model, endpoint or provider moves away from it, the capability-only open
 * adapter for the same slot and protocol takes over. That is what removes the model white-list
 * without silently pretending an unknown model is a reviewed preset.
 */
export function resolveSlotAdapter(slot: ProviderSlot, binding: { adapterId: string; protocol?: string; provider: string; model: string; endpoint: string }, adapters: readonly ProviderAdapterInfo[]): ProviderAdapterInfo | undefined {
  const declared = adapters.find(candidate => candidate.id === binding.adapterId && candidate.slots.includes(slot));
  const matchesReviewedChoice = !!declared && !declared.open && declared.provider === binding.provider
    && (declared.choices?.some(choice => choice.configuration.model === binding.model && choice.configuration.endpoint === binding.endpoint)
      || (declared.modelHint === binding.model && declared.endpoints.includes(binding.endpoint)));
  if (declared && (declared.open || matchesReviewedChoice)) return declared;
  const protocol = binding.protocol ?? 'openai-compatible';
  return adapters.find(candidate => candidate.open && candidate.slots.includes(slot) && protocolOf(candidate, slot) === protocol);
}

/** The wire protocol an open adapter declares; reviewed adapters ride the OpenAI-compatible wire. */
function protocolOf(adapter: ProviderAdapterInfo, slot: ProviderSlot): ProviderProtocol {
  if (adapter.id.startsWith('gemini-')) return 'gemini';
  return 'openai-compatible';
}
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
  // FIX61-01: validation normalizes the binding (protocol, adapterId), so it must work on its own copy.
  // Mutating the caller's object made a caller-held snapshot change under it — the exact class of bug the
  // "saved vs effective" split exists to prevent.
  const normalized = structuredClone(value) as unknown as ManagedSettings;
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
    if(slot==='asr' && normalized.providers.asr===undefined)continue;
    const p = normalized.providers[slot];
    const required = ['adapterId', 'provider', 'model', 'endpoint', 'credentialRef', 'inputTokenLimit', 'outputTokenLimit', 'reservationMicros', 'inputMicrosPerToken', 'outputMicrosPerToken'];
    // 'protocol' is optional on read so a settings file written before FIX61-01 still loads; it is
    // normalized to the adapter's declared protocol below and is required for every new save.
    keys(p, [...required, 'protocol', 'characterMicros', 'thinking', 'voice', 'language', 'temperature', 'audioMicrosPerSecond'], required);
    // Migration: an absent protocol keeps its previous meaning (the reviewed preset's wire protocol).
    if (p.protocol === undefined) (p as { protocol?: unknown }).protocol = 'openai-compatible';
    const declared = adapters.find(a => a.id === p.adapterId && a.slots.includes(slot));
    const adapter = resolveSlotAdapter(slot, p as { adapterId: string; protocol?: string; provider: string; model: string; endpoint: string }, adapters);
    // The binding is normalized onto the adapter that will actually serve it, so the persisted
    // configuration names the real implementation instead of a stale reviewed preset.
    if (adapter && adapter.id !== p.adapterId) (p as { adapterId: string }).adapterId = adapter.id;
    // FIX61-01: an OPEN adapter is capability-only. It serves any model on its declared protocol and any
    // registered provider identity; a REVIEWED adapter keeps its exact preset and provider binding.
    // 'reviewed' is set only while the binding still describes that exact reviewed choice, so a custom
    // model is never silently treated as a reviewed preset (and never inherits its tariff).
    const reviewed = declared && !declared.open && adapter === declared ? declared : undefined;
    const providerMatches = reviewed ? reviewed.provider === p.provider : isProviderId(p.provider);
    // Endpoint may be any HTTPS origin or an explicit loopback HTTP; the key never reaches a redirected
    // other host. Catalog endpoints are HTTPS and remain accepted.
    if (!adapter || !providerMatches || !isAllowedEndpoint(p.endpoint) || !text(p.model) || !text(p.credentialRef)) invalid();
    if (p.protocol !== 'openai-compatible' && p.protocol !== 'gemini') invalid('协议未登记。');
    // Capability boundary: this build implements audio transcription and speech synthesis only on the
    // OpenAI-compatible wire, so a Gemini binding for those slots is refused instead of silently failing.
    if (p.protocol === 'gemini' && (slot === 'asr' || slot === 'tts')) invalid('本版本的 Gemini 协议不提供语音转写或语音合成槽位。');
    // No model-name white-list: a custom model on a supported protocol is accepted. A reviewed catalog
    // choice (same model + endpoint) is still recognized for convenience, but its pricing is not forced
    // onto the request — custom pricing is validated for sanity instead.
    const choice = reviewed?.choices?.find(c => c.configuration.model === p.model && c.configuration.endpoint === p.endpoint);
    if (![p.inputTokenLimit, p.outputTokenLimit].every(n => Number.isSafeInteger(n) && (n as number) >= (slot === 'tts' || slot === 'asr' ? 0 : 1))) invalid('模型用量上界无效。');
    if (p.thinking !== undefined && slot !== 'memory_turn') invalid('此槽不支持思考配置。');
    if (slot === 'memory_turn' && p.thinking !== undefined && p.thinking !== 'high') invalid('记忆槽仅支持 high 思考配置。');
    for (const key of ['inputMicrosPerToken', 'outputMicrosPerToken', 'reservationMicros', 'characterMicros', 'audioMicrosPerSecond'] as const) {
      const value = p[key];
      if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) invalid('计费边界必须是有限非负数。');
    }
    // For a reviewed choice we still cap usage at the reviewed bound; a custom/open model is user-bounded
    // and its unknown price is reported as unknown rather than replaced by the reviewed tariff.
    if (choice && ((p.inputTokenLimit as number) > choice.configuration.inputTokenLimit || (p.outputTokenLimit as number) > choice.configuration.outputTokenLimit)) invalid('用量范围不能超过此型号已登记的计费上界。');
    // A custom endpoint keeps its own key instead of being forced onto a preset vendor's credential.
    try { credentials.file(p.credentialRef, String(reviewed ? reviewed.provider : p.provider)); } catch { invalid('请选择已登记的同供应商凭据。'); }
    if (p.temperature !== undefined && (!adapter.capabilities.temperature || typeof p.temperature !== 'number' || !Number.isFinite(p.temperature) || p.temperature < 0 || p.temperature > 2)) invalid('此模块不支持所填温度。');
    if (slot === 'tts') {
      if (!text(p.voice, 128)) invalid('请选择此型号已登记的音色。');
      if (choice?.voices && !choice.voices.some(v => v.id === p.voice)) invalid('请选择此型号已登记的音色。');
      if (voices?.snapshot().voices.some(voice => voice.voiceId === p.voice)) {
        // Registered cloned voices belong to the reviewed preset provider; a custom voice id is not
        // required to exist in that store (the selected service validates it at synthesis time).
        try { voices.resolve({ voiceId: p.voice, provider: String(reviewed ? reviewed.provider : p.provider) as 'dashscope', targetModel: p.model,
          endpoint: p.endpoint as string, credentialRef: p.credentialRef }); }
        catch { invalid('克隆音色与此模型、服务地址或凭据不匹配。'); }
      }
      if (adapter.capabilities.language ? !text(p.language, 40) : p.language !== undefined) invalid('语言参数与此语音适配器不匹配。');
    } else if (p.voice !== undefined || p.language !== undefined || p.characterMicros !== undefined) invalid();
  }
  try { effectiveTrialConfiguration(base, normalized, credentials, draftOnly); } catch { invalid('模型参数、调用预留或计费边界无效；额度不会自动扩大。'); }
  return normalized;
}
export function effectiveTrialConfiguration(base: TrialConfiguration, settings: ManagedSettings, credentials = credentialRegistry(base), draftOnly = false): TrialConfiguration {
  const models = Object.fromEntries(PROVIDER_SLOTS.filter(slot=>settings.providers[slot]).map(slot => {
    const { adapterId: _adapter, credentialRef, voice: _voice, language: _language, temperature: _temperature, ...model } = settings.providers[slot]!;
    // A reviewed preset names its own vendor; any other binding keeps the provider identity the user chose.
    const reviewed = availableAdapters(base).find(candidate => candidate.id === _adapter && candidate.slots.includes(slot));
    const credentialOwner = reviewed && !reviewed.open ? reviewed.provider : model.provider;
    return [slot, { ...model, credentialFile: credentials.file(credentialRef, String(credentialOwner)) }];
  })) as TrialConfiguration['models'];
  const candidate = { ...base, models, memory: { ...base.memory, timeoutMs: settings.context.timeoutMs } };
  return draftOnly ? candidate : validateTrialConfiguration(candidate);
}
