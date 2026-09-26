// FIX61-01: capability-based provider resolution for the seven provider slots.
// The catalog only supplies presets and protocol capabilities; this registry never rejects a model
// by name or by a price/tariff white-list. It validates that the requested protocol can serve the
// slot, that the endpoint is an allowed origin (HTTPS or an explicit loopback HTTP), and that the
// binding carries the capability parameters the slot expects. Custom models are permitted.
import { ManagementError, type ProviderSlot } from '../contracts/management.js';

export type ProviderProtocol = 'openai-compatible' | 'gemini';

export interface SlotBinding {
  readonly adapterId: string;
  readonly protocol: ProviderProtocol;
  readonly provider: 'dashscope' | 'deepseek' | 'openai' | 'gemini' | (string & {});
  readonly endpoint: string;
  readonly model: string;
  readonly credentialRef: string;
  readonly inputTokenLimit: number;
  readonly outputTokenLimit: number;
  readonly reservationMicros: number;
  readonly inputMicrosPerToken: number;
  readonly outputMicrosPerToken: number;
  readonly thinking?: 'high';
  readonly voice?: string;
  readonly language?: string;
  readonly temperature?: number;
  readonly characterMicros?: number;
  readonly audioMicrosPerSecond?: number;
}

export interface SlotCapabilities {
  readonly temperature: boolean;
  readonly voice: boolean;
  readonly language: boolean;
  readonly audio: boolean;
}

/** Which slots each protocol is allowed to serve. A custom model on an allowed protocol is accepted. */
export const PROTOCOL_SLOTS: Record<ProviderProtocol, readonly ProviderSlot[]> = {
  'openai-compatible': ['dialogue', 'memory_turn', 'summary', 'admission', 'perception', 'asr', 'tts'],
  gemini: ['dialogue', 'memory_turn', 'summary', 'admission', 'perception'],
};

const AUDIO_SLOTS: readonly ProviderSlot[] = ['asr'];

/** Returns the binding back, normalized, or throws ManagementError on a capability mismatch. */
export function matchSlotBinding(slot: ProviderSlot, binding: SlotBinding, capabilities: SlotCapabilities): SlotBinding {
  if (!PROTOCOL_SLOTS[binding.protocol]?.includes(slot)) {
    throw new ManagementError('invalid_request', `协议 ${binding.protocol} 不支持 ${slot} 槽。`);
  }
  if (!isAllowedEndpoint(binding.endpoint)) {
    throw new ManagementError('invalid_request', '服务地址必须是 HTTPS 或显式回环 HTTP，且不能交给重定向后的其他主机。');
  }
  if (!text(binding.model)) throw new ManagementError('invalid_request', '模型名称无效。');
  if (!text(binding.credentialRef)) throw new ManagementError('invalid_request', '请选择已登记的同供应商凭据。');
  const integerAtLeast = (n: unknown, min: number) => typeof n === 'number' && Number.isSafeInteger(n) && (n as number) >= min;
  if (!integerAtLeast(binding.inputTokenLimit, slot === 'tts' || slot === 'asr' ? 0 : 1)) {
    throw new ManagementError('invalid_request', '模型用量上界无效。');
  }
  if (!integerAtLeast(binding.outputTokenLimit, slot === 'tts' || slot === 'asr' ? 0 : 1)) {
    throw new ManagementError('invalid_request', '模型用量上界无效。');
  }
  // Capability parameters must match the slot's capability flags; unknown parameters are rejected.
  if (binding.temperature !== undefined && (!capabilities.temperature || typeof binding.temperature !== 'number' || !Number.isFinite(binding.temperature) || binding.temperature < 0 || binding.temperature > 2)) {
    throw new ManagementError('invalid_request', '此模块不支持所填温度。');
  }
  if (slot === 'tts') {
    if (!text(binding.voice ?? '', 128)) throw new ManagementError('invalid_request', '请选择此型号已登记的音色。');
    if (capabilities.language ? !text(binding.language ?? '', 40) : binding.language !== undefined) {
      throw new ManagementError('invalid_request', '语言参数与此语音适配器不匹配。');
    }
  } else if (binding.voice !== undefined || binding.language !== undefined) {
    throw new ManagementError('invalid_request', '该槽不接受音色或语言参数。');
  }
  // Thought configuration is a capability of the memory_turn slot only, and only as 'high'.
  if (binding.thinking !== undefined) {
    if (slot !== 'memory_turn' || binding.thinking !== 'high') {
      throw new ManagementError('invalid_request', slot === 'memory_turn' ? '记忆槽仅支持 high 思考配置。' : '模型思考配置不受当前适配器支持。');
    }
  }
  if (AUDIO_SLOTS.includes(slot)) {
    if (!capabilities.audio || typeof binding.audioMicrosPerSecond !== 'number' || !Number.isFinite(binding.audioMicrosPerSecond) || binding.audioMicrosPerSecond < 0) {
      throw new ManagementError('invalid_request', '语音槽需要有效的音频时长费率。');
    }
  } else if (binding.audioMicrosPerSecond !== undefined) {
    throw new ManagementError('invalid_request', '该槽不接受音频时长费率。');
  }
  if (slot === 'tts' && !(typeof binding.characterMicros === 'number' && Number.isFinite(binding.characterMicros) && binding.characterMicros > 0)) {
    throw new ManagementError('invalid_request', '语音计费口径未配置。');
  }
  return Object.freeze({ ...binding });
}

/**
 * Logical provider registry. `resolve` performs capability matching and returns a descriptor the
 * production composition root (trial-backend) uses to instantiate the concrete provider for the
 * protocol. It never rejects a model by name or by a tariff white-list.
 */
export class ProviderRegistry {
  /** Pure capability check used by tests and callers before resolving. */
  static canServe(slot: ProviderSlot, protocol: ProviderProtocol): boolean {
    return PROTOCOL_SLOTS[protocol]?.includes(slot) ?? false;
  }
  /** Resolve a binding for a slot: capability match + normalization. Returns the resolved descriptor. */
  static resolve(slot: ProviderSlot, binding: SlotBinding, capabilities: SlotCapabilities): SlotBinding {
    return matchSlotBinding(slot, binding, capabilities);
  }
}

function text(value: unknown, max = 160): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f]/.test(value);
}

/** HTTPS is always allowed; HTTP is allowed only for an explicit loopback host (local ASR/LLM). */
export function isAllowedEndpoint(endpoint: unknown): boolean {
  if (typeof endpoint !== 'string' || !endpoint.trim()) return false;
  let url: URL;
  try { url = new URL(endpoint); } catch { return false; }
  if (url.protocol === 'https:') return true;
  if (url.protocol === 'http:') {
    const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
    return host === '127.0.0.1' || host === '::1' || host === 'localhost';
  }
  return false;
}
