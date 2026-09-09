import { describe, expect, it } from "vitest";
import type { SpeechOutputEngine, SpeechOutputEvents, SpeechOutputRequest } from "./contracts";
import { speechToneFor } from "../../domain/mood";
import { createSpeechQueue } from "./speechQueue";

function createFakeEngine(autoStart = true) {
  const spoken: SpeechOutputRequest[] = [];
  let pending: SpeechOutputEvents | null = null;
  let stops = 0;

  const engine: SpeechOutputEngine = {
    id: "fake",
    kind: "web-speech",
    isAvailable: () => true,
    speak(request, events = {}) {
      spoken.push(request);
      pending = events;
      if (autoStart) events.onStart?.();
    },
    stop() {
      stops += 1;
      pending = null;
    },
  };

  return {
    engine,
    spoken,
    stops: () => stops,
    finish() {
      const events = pending;
      pending = null;
      events?.onEnd?.();
    },
    start() {
      pending?.onStart?.();
    },
    fail(message: string) {
      const events = pending;
      pending = null;
      events?.onError?.(message);
    },
  };
}

describe("createSpeechQueue", () => {
  it("一句念完才念下一句", () => {
    const fake = createFakeEngine();
    const queue = createSpeechQueue(fake.engine);
    queue.speak(["おかえり。", "今日はどうだった？"]);

    expect(fake.spoken.map((request) => request.text)).toEqual(["おかえり。"]);
    fake.finish();
    expect(fake.spoken.map((request) => request.text)).toEqual(["おかえり。", "今日はどうだった？"]);
  });

  it("逐句选音色：混说的回复不会整段用一个音色", () => {
    const fake = createFakeEngine();
    const queue = createSpeechQueue(fake.engine);
    queue.speak(["うん、わかってる。", "我知道你今天很累了。", "Take your time."]);

    fake.finish();
    fake.finish();
    expect(fake.spoken.map((request) => request.language)).toEqual(["ja-JP", "zh-CN", "en-US"]);
  });

  it("念完全部才报 drained", () => {
    const fake = createFakeEngine();
    const queue = createSpeechQueue(fake.engine);
    let drained = 0;
    queue.speak(["おかえり。", "おやすみ。"], { onDrained: () => { drained += 1; } });

    fake.finish();
    expect(drained).toBe(0);
    fake.finish();
    expect(drained).toBe(1);
    expect(queue.isSpeaking()).toBe(false);
  });

  it("空数组直接 drained，不会卡在说话状态", () => {
    const fake = createFakeEngine();
    const queue = createSpeechQueue(fake.engine);
    let drained = 0;
    queue.speak([], { onDrained: () => { drained += 1; } });
    expect(drained).toBe(1);
    expect(queue.isSpeaking()).toBe(false);
  });

  it("打断之后迟到的 onEnd 不会接着念下一句", () => {
    const fake = createFakeEngine();
    const queue = createSpeechQueue(fake.engine);
    let drained = 0;
    queue.speak(["おかえり。", "今日はどうだった？"], { onDrained: () => { drained += 1; } });

    queue.stop();
    fake.finish();

    expect(fake.spoken.map((request) => request.text)).toEqual(["おかえり。"]);
    expect(drained).toBe(0);
    expect(queue.isSpeaking()).toBe(false);
  });

  it("一句念不出来时继续下一句，不让整轮哑掉", () => {
    const fake = createFakeEngine();
    const queue = createSpeechQueue(fake.engine);
    const errors: string[] = [];
    queue.speak(["おかえり。", "今日はどうだった？"], { onError: (message) => errors.push(message) });

    fake.fail("synthesis-failed");
    expect(errors).toEqual(["synthesis-failed"]);
    expect(fake.spoken.map((request) => request.text)).toEqual(["おかえり。", "今日はどうだった？"]);
  });

  it("第一句失败、第二句成功时仍报告 firstAudio 并以已播放结束", () => {
    const fake = createFakeEngine(false);
    const errors: string[] = [];
    const drained: Array<{ played: boolean; errorCount: number; sentenceCount: number }> = [];
    let starts = 0;
    const queue = createSpeechQueue(fake.engine);
    queue.speak(["おかえり。", "今日はどうだった？"], {
      onStart: () => { starts += 1; },
      onError: (message) => errors.push(message),
      onDrained: (result) => drained.push(result),
    });

    fake.fail("first-failed");
    fake.start();
    fake.finish();

    expect(errors).toEqual(["first-failed"]);
    expect(starts).toBe(1);
    expect(drained).toEqual([{ played: true, errorCount: 1, sentenceCount: 2 }]);
  });

  it("所有句子都失败时不伪装成已经播放", () => {
    const fake = createFakeEngine(false);
    const drained: Array<{ played: boolean; errorCount: number; sentenceCount: number }> = [];
    const queue = createSpeechQueue(fake.engine);
    queue.speak(["おかえり。", "今日はどうだった？"], {
      onDrained: (result) => drained.push(result),
    });

    fake.fail("first-failed");
    fake.fail("second-failed");

    expect(drained).toEqual([{ played: false, errorCount: 2, sentenceCount: 2 }]);
  });

  it("onStart 只在第一句报一次", () => {
    const fake = createFakeEngine();
    const queue = createSpeechQueue(fake.engine);
    let starts = 0;
    queue.speak(["おかえり。", "おやすみ。"], { onStart: () => { starts += 1; } });
    fake.finish();
    expect(starts).toBe(1);
  });
});

describe("流式入队", () => {
  it("第一句一到就开口，不等后面的句子", () => {
    const fake = createFakeEngine();
    const queue = createSpeechQueue(fake.engine);
    queue.begin();
    queue.enqueue(["おかえり。"]);

    expect(fake.spoken.map((request) => request.text)).toEqual(["おかえり。"]);
  });

  it("念完在等的时候来了新句子，立刻续上", () => {
    const fake = createFakeEngine();
    const queue = createSpeechQueue(fake.engine);
    queue.begin();
    queue.enqueue(["おかえり。"]);
    fake.finish();

    expect(fake.spoken).toHaveLength(1);
    queue.enqueue(["今日はどうだった？"]);
    expect(fake.spoken.map((request) => request.text)).toEqual(["おかえり。", "今日はどうだった？"]);
  });

  it("没有 end() 之前不报 drained：后面可能还在生成", () => {
    const fake = createFakeEngine();
    const queue = createSpeechQueue(fake.engine);
    let drained = 0;
    queue.begin({ onDrained: () => { drained += 1; } });
    queue.enqueue(["おかえり。"]);
    fake.finish();

    expect(drained).toBe(0);
    queue.end();
    expect(drained).toBe(1);
  });

  it("end() 时还没念完，等念完才 drained", () => {
    const fake = createFakeEngine();
    const queue = createSpeechQueue(fake.engine);
    let drained = 0;
    queue.begin({ onDrained: () => { drained += 1; } });
    queue.enqueue(["おかえり。", "おやすみ。"]);
    queue.end();

    expect(drained).toBe(0);
    fake.finish();
    expect(drained).toBe(0);
    fake.finish();
    expect(drained).toBe(1);
  });

  it("drained 只报一次", () => {
    const fake = createFakeEngine();
    const queue = createSpeechQueue(fake.engine);
    let drained = 0;
    queue.begin({ onDrained: () => { drained += 1; } });
    queue.enqueue(["おかえり。"]);
    queue.end();
    fake.finish();
    queue.end();
    expect(drained).toBe(1);
  });

  it("打断之后迟到的句子不会被念出来", () => {
    const fake = createFakeEngine();
    const queue = createSpeechQueue(fake.engine);
    queue.begin();
    queue.enqueue(["おかえり。"]);
    queue.stop();
    queue.enqueue(["今日はどうだった？"]);

    expect(fake.spoken.map((request) => request.text)).toEqual(["おかえり。"]);
  });
});

describe("语气", () => {
  it("语气比第一句先到时，第一句就按这个语气念", () => {
    // 流式里 mood 排在 JSON 最前面，正是为了赶在开口之前到手
    const fake = createFakeEngine();
    const queue = createSpeechQueue(fake.engine);

    queue.begin();
    queue.setMood("concerned");
    queue.enqueue(["大丈夫？"]);

    expect(fake.spoken[0].rate).toBe(speechToneFor("concerned").rate);
    expect(fake.spoken[0].pitch).toBe(speechToneFor("concerned").pitch);
  });

  it("没设语气时用 neutral 的取值", () => {
    const fake = createFakeEngine();
    const queue = createSpeechQueue(fake.engine);

    queue.speak(["おかえり。"]);

    expect(fake.spoken[0].rate).toBe(speechToneFor("neutral").rate);
  });

  it("上一轮的语气不留到这一轮：她刚才在担心，不代表现在还在担心", () => {
    const fake = createFakeEngine();
    const queue = createSpeechQueue(fake.engine);

    queue.begin();
    queue.setMood("concerned");
    queue.enqueue(["大丈夫？"]);
    fake.finish();

    queue.begin();
    queue.enqueue(["おかえり。"]);

    expect(fake.spoken[1].rate).toBe(speechToneFor("neutral").rate);
  });
});
