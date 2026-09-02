import { describe, expect, it } from "vitest";
import {
  createMemory, isDuplicateMemory, memoryLines, parseMemoryCandidates,
  type MemoryRecord,
} from "./memory";
import { shouldSummarize, SUMMARY_TRIGGER_COUNT } from "./summary";

function memory(content: string): MemoryRecord {
  return createMemory(content)!;
}

describe("createMemory", () => {
  it("空内容不产生记忆", () => {
    expect(createMemory("   ")).toBeNull();
  });

  it("未知分类退回日常", () => {
    expect(createMemory("喜欢咖啡", "宇宙" as never)!.category).toBe("日常");
  });

  it("新记忆默认待确认", () => {
    expect(memory("喜欢傍晚散步").status).toBe("pending");
  });
});

describe("isDuplicateMemory", () => {
  it("忽略空白和标点后重复的不再记一遍", () => {
    const existing = [memory("喜欢傍晚散步")];
    expect(isDuplicateMemory("喜欢傍晚散步。", existing)).toBe(true);
    expect(isDuplicateMemory(" 喜欢 傍晚散步 ", existing)).toBe(true);
    expect(isDuplicateMemory("喜欢早上散步", existing)).toBe(false);
  });

  it("空内容当作重复丢弃", () => {
    expect(isDuplicateMemory("  ", [])).toBe(true);
  });
});

describe("parseMemoryCandidates", () => {
  it("解析标准数组", () => {
    expect(parseMemoryCandidates('[{"category":"偏好","content":"喜欢咖啡"}]')).toEqual([
      { category: "偏好", content: "喜欢咖啡" },
    ]);
  });

  it("容忍代码块包裹与前后多余文字", () => {
    const raw = '好的：```json\n[{"category":"计划","content":"下周面试"}]\n```';
    expect(parseMemoryCandidates(raw)[0].content).toBe("下周面试");
  });

  it("空数组和非法输出都返回空", () => {
    expect(parseMemoryCandidates("[]")).toEqual([]);
    expect(parseMemoryCandidates("我觉得没什么好记的")).toEqual([]);
    expect(parseMemoryCandidates('[{"category":"偏好"}]')).toEqual([]);
  });

  it("未知分类退回日常", () => {
    expect(parseMemoryCandidates('[{"category":"星座","content":"住在杭州"}]')[0].category).toBe("日常");
  });
});

describe("memoryLines", () => {
  it("带分类前缀，并只取最近的若干条", () => {
    const memories = Array.from({ length: 20 }, (_, index) => memory(`第${index}件事`));
    const lines = memoryLines(memories, 3);
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe("日常：第19件事");
  });
});

describe("shouldSummarize", () => {
  it("累积到阈值才压缩", () => {
    expect(shouldSummarize(SUMMARY_TRIGGER_COUNT - 1)).toBe(false);
    expect(shouldSummarize(SUMMARY_TRIGGER_COUNT)).toBe(true);
  });
});
