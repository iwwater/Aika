import { describe, expect, it } from "vitest";
import { createVoiceOutputSettings, TTS_API_KEY_SECRET, validateVoiceOutput } from "./outputSettings";
import { DEFAULT_VOICE_OUTPUT, type VoiceOutputConfig } from "./outputEngine";

/** 内存版存储 + 秘密库：只替代外部持久化，被测逻辑走生产实现。 */
function setup(initialSettings: Record<string, string> = {}, initialSecrets: Record<string, string> = {}) {
  const settings = { ...initialSettings };
  const secrets = { ...initialSecrets };
  const port = createVoiceOutputSettings({
    storage: {
      getSetting: async (key) => settings[key] ?? null,
      setSetting: async (key, value) => {
        settings[key] = value;
      },
    },
    secrets: {
      get: async (name) => secrets[name] ?? null,
      set: async (name, value) => {
        secrets[name] = value;
      },
      remove: async (name) => {
        delete secrets[name];
      },
    },
  });
  return { port, settings, secrets };
}

const FULL: VoiceOutputConfig = {
  output: "cloud-tts",
  baseUrl: "https://api.example.com/v1",
  model: "tts-1",
  voice: "alloy",
  speed: 1.2,
  apiKey: "sk-test-1234567890",
};

describe("语音输出设置端口（TTS-04-A）", () => {
  it("保存后重开读回一致；Key 只进 SecretStore，绝不进普通设置", async () => {
    const first = setup();
    await first.port.save(FULL);
    const settings = first.settings;
    expect(settings["voice.output"]).toBeDefined();
    expect(settings["voice.output"]).not.toContain("sk-test");
    // 重开：设置与秘密库都沿用于同一台机器。
    const reopened = setup(settings, first.secrets).port;
    const loaded = await reopened.load();
    // DEFAULT 里可能带其余缺省字段，逐字段断言这六项即可。
    expect(loaded.output).toBe(FULL.output);
    expect(loaded.baseUrl).toBe(FULL.baseUrl);
    expect(loaded.model).toBe(FULL.model);
    expect(loaded.voice).toBe(FULL.voice);
    expect(loaded.speed).toBe(FULL.speed);
    expect(loaded.apiKey).toBe(FULL.apiKey);
  });

  it("apiKey 为空的保存＝保持原 Key；删除是显式操作", async () => {
    const { port, secrets } = setup();
    await port.save(FULL);
    expect(secrets[TTS_API_KEY_SECRET]).toBe("sk-test-1234567890");

    await port.save({ ...FULL, apiKey: "" });
    expect(secrets[TTS_API_KEY_SECRET]).toBe("sk-test-1234567890");

    await port.removeApiKey();
    expect(secrets[TTS_API_KEY_SECRET]).toBeUndefined();
    expect((await port.load()).apiKey).toBe("");
  });

  it("校验失败直接抛错，不写任何存储", async () => {
    const { port, settings, secrets } = setup();
    await expect(port.save({ ...FULL, output: "loud" as never })).rejects.toThrow("输出链路");
    await expect(port.save({ ...FULL, speed: Number.NaN })).rejects.toThrow("语速");
    expect(settings["voice.output"]).toBeUndefined();
    expect(secrets[TTS_API_KEY_SECRET]).toBeUndefined();
  });

  it("坏设置 JSON 按默认值处理，不拦启动", async () => {
    const { port } = setup({ "voice.output": "{not-json" });
    const loaded = await port.load();
    expect(loaded.output).toBe(DEFAULT_VOICE_OUTPUT.output);
  });

  it("validateVoiceOutput 规整字段", () => {
    expect(validateVoiceOutput({ ...FULL, speed: 1.5 }).speed).toBe(1.5);
    expect(() => validateVoiceOutput({ ...FULL, speed: 0 })).toThrow();
  });
});
