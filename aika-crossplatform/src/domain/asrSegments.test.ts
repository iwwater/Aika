import { describe, expect, it } from "vitest";
import { createAsrSegmentReorderer } from "./asrSegments";

describe("createAsrSegmentReorderer", () => {
  it("等待缺失的前段，按原始音频序号释放乱序结果", () => {
    const reorderer = createAsrSegmentReorderer<{ sequence: number; text: string }>();

    expect(reorderer.push({ sequence: 2, text: "。" })).toEqual([]);
    expect(reorderer.push({ sequence: 0, text: "今天" })).toEqual([
      { sequence: 0, text: "今天" },
    ]);
    expect(reorderer.push({ sequence: 1, text: "累了" })).toEqual([
      { sequence: 1, text: "累了" },
      { sequence: 2, text: "。" },
    ]);
  });

  it("重复或迟到的旧结果不会再次释放", () => {
    const reorderer = createAsrSegmentReorderer<{ sequence: number; text: string }>();
    expect(reorderer.push({ sequence: 0, text: "旧" })).toHaveLength(1);
    expect(reorderer.push({ sequence: 0, text: "旧" })).toEqual([]);
  });

  it("打断后允许下一组从第一个到达的序号重新开始", () => {
    const reorderer = createAsrSegmentReorderer<{ sequence: number; text: string }>();
    reorderer.push({ sequence: 0, text: "旧轮" });
    reorderer.reset(null);

    expect(reorderer.push({ sequence: 7, text: "新轮" })).toEqual([
      { sequence: 7, text: "新轮" },
    ]);
    expect(reorderer.push({ sequence: 6, text: "迟到旧轮" })).toEqual([]);
  });
});
