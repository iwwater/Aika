import { describe, expect, it } from "vitest";
import {
  createOutputEngine, DEFAULT_VOICE_OUTPUT, missingCloudTtsField, type VoiceOutputConfig,
} from "./outputEngine";

const complete: VoiceOutputConfig = {
  ...DEFAULT_VOICE_OUTPUT,
  output: "auto",
  baseUrl: "https://api.example.com/v1",
  model: "tts-x",
  voice: "shimmer",
  speed: 1,
  apiKey: "sk-test",
};

describe("missingCloudTtsField", () => {
  it("填全了返回空串", () => {
    expect(missingCloudTtsField(complete)).toBe("");
  });

  it("按顺序报第一个缺的，一次只让用户补一样东西", () => {
    expect(missingCloudTtsField({ ...complete, baseUrl: "  " })).toBe("API 地址");
    expect(missingCloudTtsField({ ...complete, model: "" })).toBe("模型名称");
    expect(missingCloudTtsField({ ...complete, voice: "" })).toBe("音色");
    expect(missingCloudTtsField({ ...complete, apiKey: "" })).toBe("API Key");
  });
});

describe("createOutputEngine", () => {
  it("默认是系统合成：云端每句都要钱，不能因为碰巧填过 Key 就自己开起来", () => {
    expect(DEFAULT_VOICE_OUTPUT.output).toBe("system");
    const resolved = createOutputEngine({ ...complete, output: "system" });
    expect(resolved.engine.kind).toBe("web-speech");
    expect(resolved.degraded).toBe(false);
  });

  it("点名要系统合成时，配置填全了也不去用云端", () => {
    expect(createOutputEngine({ ...complete, output: "system" }).engine.kind).toBe("web-speech");
  });

  it("auto：配好了就用云端", () => {
    const resolved = createOutputEngine(complete);
    expect(resolved.engine.kind).toBe("cloud-tts");
    expect(resolved.degraded).toBe(false);
    expect(resolved.note).toContain("tts-x");
    expect(resolved.note).toContain("shimmer");
  });

  it("auto：没配好安静地用系统合成，用户没点名要，不算降级", () => {
    const resolved = createOutputEngine({ ...complete, apiKey: "" });
    expect(resolved.engine.kind).toBe("web-speech");
    expect(resolved.degraded).toBe(false);
    expect(resolved.note).toContain("API Key");
  });

  it("点名要云端却没配好：退回系统合成，而且必须标成降级", () => {
    // 悄悄降级的结果是用户以为「慢一点」和新音色已经生效了，实际上还在用系统语音包
    const resolved = createOutputEngine({ ...complete, output: "cloud-tts", voice: "" });
    expect(resolved.engine.kind).toBe("web-speech");
    expect(resolved.degraded).toBe(true);
    expect(resolved.note).toContain("音色");
  });

  it("点名要云端且配好了就用云端", () => {
    const resolved = createOutputEngine({ ...complete, output: "cloud-tts" });
    expect(resolved.engine.kind).toBe("cloud-tts");
    expect(resolved.degraded).toBe(false);
  });

  it("云端引擎的 isAvailable 跟着配置走", () => {
    const resolved = createOutputEngine({ ...complete, output: "cloud-tts" });
    expect(resolved.engine.isAvailable()).toBe(true);
  });
});
