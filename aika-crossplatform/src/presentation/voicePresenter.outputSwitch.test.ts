import { describe, expect, it, vi } from "vitest";
import { createVoicePresenter } from "./voicePresenter";
import type { SpeechQueue } from "../services/voice/speechQueue";
import type { SpeechOutputEngine } from "../services/voice/contracts";
import type { VoiceOutputConfig } from "../services/voice/outputEngine";

/**
 * TTS-04-C：切引擎停旧队列、旧回调不覆盖新轮、实际链路/降级可见。
 * 引擎与队列全是 fake——被测的是 Presenter 的切换编排，不是合成实现。
 */

function fakeQueue(label: string) {
  const queue = {
    label,
    begin: vi.fn(),
    enqueue: vi.fn(),
    end: vi.fn(),
    setMood: vi.fn(),
    speak: vi.fn(),
    stop: vi.fn(),
    isSpeaking: () => false,
    setSpeed: vi.fn(),
  };
  return queue as unknown as SpeechQueue & { label: string; stop: ReturnType<typeof vi.fn> };
}

function fakeEngine(id: string): SpeechOutputEngine {
  return {
    id, kind: "web-speech", isAvailable: () => true,
    speak: () => undefined, stop: () => undefined,
  } as unknown as SpeechOutputEngine;
}

const CLOUD: VoiceOutputConfig = {
  output: "cloud-tts", baseUrl: "https://api.example.com/v1", model: "tts-1",
  voice: "alloy", speed: 1, apiKey: "sk-test-1234567890",
};

describe("语音输出切换（TTS-04-C）", () => {
  it("切换时停掉旧队列，新轮次走新队列，实际链路与 note 可见", () => {
    const queues = [fakeQueue("q1"), fakeQueue("q2")];
    let created = 0;
    const presenter = createVoicePresenter({
      outputEngine: fakeEngine("system-1"),
      createQueue: () => {
        const queue = queues[Math.min(created, queues.length - 1)];
        created += 1;
        return queue;
      },
      resolveOutput: (config) => config.output === "cloud-tts"
        ? { engine: fakeEngine("cloud-1"), actual: "cloud-tts", note: "云端语音合成：tts-1 · alloy", degraded: false }
        : { engine: fakeEngine("system-2"), actual: "system", note: "系统语音合成", degraded: false },
    });

    expect(created).toBe(1);
    presenter.speakMessage("m-1", "第一段话");
    expect(queues[0].speak).toHaveBeenCalled();

    presenter.applyVoiceOutput(CLOUD);
    // 旧队列收到 stop；新队列已建好。
    expect(queues[0].stop).toHaveBeenCalled();
    expect(created).toBe(2);

    const status = presenter.getSnapshot().outputStatus;
    expect(status).toMatchObject({ selected: "cloud-tts", actual: "cloud-tts", degraded: false });
    expect(status?.note).toContain("tts-1");

    // 之后的朗读走新队列。
    presenter.speakMessage("m-2", "第二段话");
    expect(queues[1].speak).toHaveBeenCalled();
    presenter.dispose();
  });

  it("点名云端但配置不全：degraded=true 持久可见，实际引擎标 system", () => {
    const presenter = createVoicePresenter({
      createQueue: () => fakeQueue("q"),
      resolveOutput: (config) => config.output === "cloud-tts" && !config.apiKey
        ? { engine: fakeEngine("system-fallback"), actual: "system", note: "云端语音合成还差API Key，这次用系统语音合成。", degraded: true }
        : { engine: fakeEngine("system-x"), actual: "system", note: "系统语音合成", degraded: false },
    });
    presenter.applyVoiceOutput({ ...CLOUD, apiKey: "" });
    const status = presenter.getSnapshot().outputStatus;
    expect(status).toMatchObject({ selected: "cloud-tts", actual: "system", degraded: true });
    expect(status?.note).toContain("API Key");
    presenter.dispose();
  });

  it("构造时应用持久化配置：重启后不会被默认 system 覆盖", () => {
    const presenter = createVoicePresenter({
      createQueue: () => fakeQueue("q"),
      resolveOutput: (config) => ({
        engine: fakeEngine(config.output === "cloud-tts" ? "cloud-1" : "system-1"),
        actual: config.output === "cloud-tts" ? "cloud-tts" : "system",
        note: config.output === "cloud-tts" ? "云端语音合成" : "系统语音合成",
        degraded: false,
      }),
      initialOutputConfig: CLOUD,
    });
    expect(presenter.getSnapshot().outputStatus).toMatchObject({ selected: "cloud-tts", actual: "cloud-tts" });
    presenter.dispose();
  });
});
