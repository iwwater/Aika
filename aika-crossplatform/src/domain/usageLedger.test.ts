import { describe, expect, it } from "vitest";
import { resolveUsageCoverage, USAGE_LEGACY_SCOPE } from "./usageLedger";

describe("resolveUsageCoverage（LLM-12-B）", () => {
  it("三个字段都有 → reported", () => {
    expect(resolveUsageCoverage({ promptTokens: 10, completionTokens: 20, totalTokens: 30 })).toBe("reported");
  });

  it("total 是两分项相加的结果也算 reported——相加是算术不是估计", () => {
    expect(resolveUsageCoverage({ promptTokens: 10, completionTokens: 20, totalTokens: 30 })).toBe("reported");
  });

  it("只收到 total → partial：保留 total，不拆分", () => {
    expect(resolveUsageCoverage({ promptTokens: null, completionTokens: null, totalTokens: 30 })).toBe("partial");
  });

  it("缺一个分项 → partial", () => {
    expect(resolveUsageCoverage({ promptTokens: 10, completionTokens: null, totalTokens: null })).toBe("partial");
  });

  it("全缺 → unknown", () => {
    expect(resolveUsageCoverage({ promptTokens: null, completionTokens: null, totalTokens: null })).toBe("unknown");
  });

  it("显式 0 是已上报的数字，不是 unknown", () => {
    expect(resolveUsageCoverage({ promptTokens: 0, completionTokens: 0, totalTokens: 0 })).toBe("reported");
  });
});

describe("常量（LLM-12-D）", () => {
  it("legacy 是无 scope 记录的保留分组名，不与主体混算", () => {
    expect(USAGE_LEGACY_SCOPE).toBe("legacy");
  });
});
