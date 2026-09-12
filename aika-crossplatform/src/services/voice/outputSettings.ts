/**
 * 语音输出设置端口（TTS-04）。
 *
 * 结构字段（output/baseUrl/model/voice/speed）进普通设置；API Key 单独存
 * SecretStore（桌面 = DPAPI secrets.json；浏览器 = 显式标注未加密的本地存储）。
 * **Key 永远不进设置 JSON，也不进 Trace**：设置导出/备份拿不到它。
 *
 * 保存语义：apiKey 为空 = 保持已保存的 Key 不动；删除是显式操作（removeApiKey）。
 * 校验失败或写秘密/写设置失败都直接抛错——调用方不得只切内存。
 */

import { SETTING_KEYS } from "../storage/contracts";
import { DEFAULT_VOICE_OUTPUT, type VoiceOutput, type VoiceOutputConfig } from "./outputEngine";

/** SecretStore 里的独立命名；不与 Provider Key 混用。 */
export const TTS_API_KEY_SECRET = "tts.cloud.apiKey";

export interface VoiceOutputSettingsPort {
  /** 读出完整配置（含从 SecretStore 取回的 Key；没有则为空串）。 */
  load(): Promise<VoiceOutputConfig>;
  /** 校验 + 持久化。apiKey 为空表示保持原 Key；成功返回才允许切换内存状态。 */
  save(next: VoiceOutputConfig): Promise<void>;
  /** 显式删除已保存的 Key。 */
  removeApiKey(): Promise<void>;
}

export interface VoiceOutputSettingsDeps {
  storage: {
    getSetting(key: string): Promise<string | null>;
    setSetting(key: string, value: string): Promise<void>;
  };
  secrets: {
    get(name: string): Promise<string | null>;
    set(name: string, value: string): Promise<void>;
    remove(name: string): Promise<void>;
  };
}

const OUTPUTS: readonly VoiceOutput[] = ["auto", "cloud-tts", "system"];

function isFiniteSpeed(speed: unknown): speed is number {
  return typeof speed === "number" && Number.isFinite(speed) && speed > 0;
}

/** 校验并规整：非法输入抛错，绝不把半份配置写进存储。 */
export function validateVoiceOutput(input: VoiceOutputConfig): VoiceOutputConfig {
  if (!OUTPUTS.includes(input.output)) {
    throw new Error(`未知的语音输出链路：${String(input.output)}`);
  }
  if (!isFiniteSpeed(input.speed)) {
    throw new Error("语速必须是正数");
  }
  const config: VoiceOutputConfig = {
    output: input.output,
    baseUrl: String(input.baseUrl ?? ""),
    model: String(input.model ?? ""),
    voice: String(input.voice ?? ""),
    speed: input.speed,
    apiKey: String(input.apiKey ?? ""),
  };
  return config;
}

export function createVoiceOutputSettings(deps: VoiceOutputSettingsDeps): VoiceOutputSettingsPort {
  async function load(): Promise<VoiceOutputConfig> {
    const config: VoiceOutputConfig = { ...DEFAULT_VOICE_OUTPUT };
    const raw = await deps.storage.getSetting(SETTING_KEYS.voiceOutput);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Partial<VoiceOutputConfig>;
        if (parsed.output && OUTPUTS.includes(parsed.output)) config.output = parsed.output;
        if (typeof parsed.baseUrl === "string") config.baseUrl = parsed.baseUrl;
        if (typeof parsed.model === "string") config.model = parsed.model;
        if (typeof parsed.voice === "string") config.voice = parsed.voice;
        if (isFiniteSpeed(parsed.speed)) config.speed = parsed.speed;
      } catch {
        // 坏记录按默认配置处理，不让启动失败。
      }
    }
    const key = await deps.secrets.get(TTS_API_KEY_SECRET);
    config.apiKey = key ?? "";
    return config;
  }

  return {
    load,

    async save(next: VoiceOutputConfig): Promise<void> {
      const valid = validateVoiceOutput(next);
      // 先写秘密再写设置：写设置成功即整体成功；中途失败抛错，内存不切。
      if (valid.apiKey.trim()) {
        await deps.secrets.set(TTS_API_KEY_SECRET, valid.apiKey.trim());
      }
      // Key 不进普通设置：结构化字段之外一律丢弃。
      await deps.storage.setSetting(SETTING_KEYS.voiceOutput, JSON.stringify({
        output: valid.output,
        baseUrl: valid.baseUrl,
        model: valid.model,
        voice: valid.voice,
        speed: valid.speed,
      }));
    },

    async removeApiKey(): Promise<void> {
      await deps.secrets.remove(TTS_API_KEY_SECRET);
    },
  };
}
