import { describe, expect, it } from "vitest";
import { samplesFor } from "./audio";
import { createVadSegmenter, DEFAULT_VAD_SETTINGS, type VadEvent } from "./vadSegmenter";

/** Silero v5 一帧是 512 个采样，16 kHz 下正好 32 毫秒。 */
const FRAME = 512;

/** 按帧喂一串概率，收集全部事件。 */
function run(probabilities: number[], settings = DEFAULT_VAD_SETTINGS): VadEvent[] {
  const segmenter = createVadSegmenter(settings);
  const events: VadEvent[] = [];
  probabilities.forEach((probability, index) => {
    events.push(...segmenter.push(probability, index * FRAME, (index + 1) * FRAME));
  });
  return events;
}

function repeat(value: number, frames: number): number[] {
  return Array.from({ length: frames }, () => value);
}

describe("createVadSegmenter", () => {
  it("安静时什么都不发生", () => {
    expect(run(repeat(0.05, 40))).toEqual([]);
  });

  it("持续说话触发一次 speech-start", () => {
    const events = run([...repeat(0.05, 5), ...repeat(0.9, 20)]);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("speech-start");
  });

  it("太短的声音不算开口：咳嗽、敲键盘都挡掉", () => {
    // 一帧 32 毫秒，minSpeechMs 是 120，两帧不够
    expect(run([...repeat(0.05, 5), 0.9, 0.9, ...repeat(0.02, 20)])).toEqual([]);
  });

  it("说完一段停下来会切出 speech-end", () => {
    const events = run([...repeat(0.9, 20), ...repeat(0.02, 20)]);
    expect(events.map((event) => event.type)).toEqual(["speech-start", "speech-end"]);
  });

  it("回补：段首比实际开口更早，第一个字才不会丢", () => {
    const leadingSilence = 10;
    const events = run([...repeat(0.05, leadingSilence), ...repeat(0.9, 20), ...repeat(0.02, 20)]);
    const start = events[0];
    expect(start.type).toBe("speech-start");
    // 开口在第 10 帧，回补 220 毫秒之后段首必须更靠前
    expect(start.startSample).toBeLessThan(leadingSilence * FRAME);
    expect(start.startSample).toBe(leadingSilence * FRAME - samplesFor(DEFAULT_VAD_SETTINGS.prerollMs));
  });

  it("段末多留一点静音，最后一个辅音不被切掉", () => {
    const events = run([...repeat(0.9, 20), ...repeat(0.02, 20)]);
    const end = events[1];
    if (end.type !== "speech-end") throw new Error("应该是 speech-end");
    // 静音从第 20 帧开始，段尾要比它更靠后
    expect(end.endSample).toBe(20 * FRAME + samplesFor(DEFAULT_VAD_SETTINGS.tailMs));
  });

  it("回滞区：概率在阈值附近抖动不会把一句话切成碎片", () => {
    // 0.4 落在 endProbability(0.35) 和 startProbability(0.5) 之间
    const events = run([...repeat(0.9, 8), ...repeat(0.4, 8), ...repeat(0.9, 8), ...repeat(0.02, 20)]);
    expect(events.map((event) => event.type)).toEqual(["speech-start", "speech-end"]);
  });

  it("句中短停顿不切段：那是换气，不是说完了", () => {
    // silenceMs 是 380，8 帧只有 256 毫秒
    const events = run([...repeat(0.9, 10), ...repeat(0.02, 8), ...repeat(0.9, 10), ...repeat(0.02, 20)]);
    expect(events.map((event) => event.type)).toEqual(["speech-start", "speech-end"]);
  });

  it("真的说完两段就切两次", () => {
    const events = run([
      ...repeat(0.9, 10), ...repeat(0.02, 20),
      ...repeat(0.9, 10), ...repeat(0.02, 20),
    ]);
    expect(events.map((event) => event.type)).toEqual([
      "speech-start", "speech-end", "speech-start", "speech-end",
    ]);
  });

  it("一直说不停时按上限切开，识别不能永远等不到结果", () => {
    const settings = { ...DEFAULT_VAD_SETTINGS, maxSegmentMs: 1000 };
    const events = run(repeat(0.9, 60), settings);
    expect(events.filter((event) => event.type === "speech-end").length).toBeGreaterThanOrEqual(1);
  });

  it("段首段尾对得上，切出来的区间是递增的", () => {
    const events = run([...repeat(0.05, 10), ...repeat(0.9, 20), ...repeat(0.02, 20)]);
    const end = events[1];
    if (end.type !== "speech-end") throw new Error("应该是 speech-end");
    expect(end.endSample).toBeGreaterThan(end.startSample);
  });

  it("reset 之后回到静默状态", () => {
    const segmenter = createVadSegmenter();
    repeat(0.9, 20).forEach((probability, index) => {
      segmenter.push(probability, index * FRAME, (index + 1) * FRAME);
    });
    expect(segmenter.isSpeaking()).toBe(true);
    segmenter.reset();
    expect(segmenter.isSpeaking()).toBe(false);
  });

  it("段首不会算成负数", () => {
    const events = run(repeat(0.9, 20));
    expect(events[0].startSample).toBe(0);
  });
});
