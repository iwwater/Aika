import type { EndpointConfig, JsonRecord } from './transport.js';

export const DEEPSEEK_FLASH_MODEL = 'deepseek-flash';
export const DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/chat/completions';
export const TEXT_SLOTS = ['dialogue', 'summary', 'admission'] as const;
/** Provider-specific JSON dialect; never send Qwen thinking parameters to DeepSeek. */
export function textJsonProtocol(config: EndpointConfig): JsonRecord {
  if (config.endpoint === DEEPSEEK_ENDPOINT) {
    if (config.model !== DEEPSEEK_FLASH_MODEL) throw new Error('Unregistered DeepSeek text model');
    return { stream: false, thinking: { type: 'disabled' }, response_format: { type: 'json_object' } };
  }
  return { stream: false, enable_thinking: false, response_format: { type: 'json_object' } };
}
export function deepseekFlashModel(credentialFile: string) {
  return { provider: 'deepseek' as const, model: DEEPSEEK_FLASH_MODEL, endpoint: DEEPSEEK_ENDPOINT, credentialFile,
    inputTokenLimit: 32768, outputTokenLimit: 393216, inputMicrosPerToken: 2, outputMicrosPerToken: 8,
    reservationMicros: 3211264 };
}
