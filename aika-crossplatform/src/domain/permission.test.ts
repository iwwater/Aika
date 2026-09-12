import { describe, expect, it } from "vitest";
import { checkPathBoundary, paramsDigestOf } from "./permission";

describe("paramsDigestOf（RT-03）", () => {
  it("键序无关：相同参数相同摘要", () => {
    expect(paramsDigestOf({ a: 1, b: "x" })).toBe(paramsDigestOf({ b: "x", a: 1 }));
  });

  it("参数一变摘要就变（执行前比对的依据）", () => {
    expect(paramsDigestOf({ files: ["a.ts"] })).not.toBe(paramsDigestOf({ files: ["a.ts", "b.ts"] }));
  });
});

describe("checkPathBoundary（RT-03-D）", () => {
  const WS = "C:\\work\\aika";

  it("workspace 内的相对与绝对路径通过，返回规范化路径与相对目标", () => {
    const rel = checkPathBoundary(WS, "src\\main.ts");
    expect(rel.ok).toBe(true);
    expect(rel.normalized).toBe("C:\\work\\aika\\src\\main.ts");
    expect(rel.targetRel).toBe("src\\main.ts");
    expect(rel.assumedLexical).toBe(true);

    const absolute = checkPathBoundary(WS, "C:\\work\\aika\\docs\\x.md");
    expect(absolute.ok).toBe(true);
    expect(absolute.targetRel).toBe("docs\\x.md");
  });

  it("`..` 逃逸被拒绝", () => {
    expect(checkPathBoundary(WS, "..\\secret.txt").ok).toBe(false);
    expect(checkPathBoundary(WS, "src\\..\\..\\escape.txt").ok).toBe(false);
    expect(checkPathBoundary(WS, "..\\..\\other\\x").reason).toBe("escape");
  });

  it("相邻前缀被拒绝：C:\\worker 不是 C:\\work\\aika 的内部", () => {
    const result = checkPathBoundary(WS, "C:\\worker\\file.txt");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("escape");
  });

  it("换盘被拒绝", () => {
    const result = checkPathBoundary(WS, "D:\\work\\aika\\x.txt");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("outside");
  });

  it("Windows 大小写不敏感：大小写不同的同一目录内部通过", () => {
    const result = checkPathBoundary("c:\\Work\\Aika", "SRC\\Main.TS");
    expect(result.ok).toBe(true);
  });

  it("正反斜杠混用规范化后判定", () => {
    const result = checkPathBoundary("C:/work/aika", "src/../docs/x.md");
    expect(result.ok).toBe(true);
    expect(result.normalized).toBe("C:\\work\\aika\\docs\\x.md");
  });

  it("UNC：同共享内通过，跨共享拒绝", () => {
    expect(checkPathBoundary("\\\\nas\\share", "dir\\x.txt").ok).toBe(true);
    const crossShare = checkPathBoundary("\\\\nas\\share", "\\\\nas\\other\\x.txt");
    expect(crossShare.ok).toBe(false);
    expect(crossShare.reason).toBe("outside");
  });

  it("junction/reparse：realPathOf 解析后越界即拒绝；解析失败拒绝而不是猜", () => {
    // 词法上在界内，但真实路径指向别处（junction）。
    const junction = checkPathBoundary(WS, "link\\x", {
      realPathOf: (p) => (p === `${WS}\\link\\x` ? "D:\\outside\\x" : p),
    });
    expect(junction.ok).toBe(false);
    expect(junction.reason).toBe("outside");

    // 解析不出真实路径：拒绝（无法保证时不越界）。
    const unresolvable = checkPathBoundary(WS, "broken\\x", {
      realPathOf: (p) => (p.endsWith("broken\\x") ? null : p),
    });
    expect(unresolvable.ok).toBe(false);
    expect(unresolvable.reason).toBe("unresolvable");

    // 真实解析仍在界内：通过且不再标 assumedLexical。
    const resolved = checkPathBoundary(WS, "src\\x", {
      realPathOf: (p) => p,
    });
    expect(resolved.ok).toBe(true);
    expect(resolved.assumedLexical).toBeUndefined();
  });

  it("空路径拒绝", () => {
    expect(checkPathBoundary(WS, "").ok).toBe(false);
    expect(checkPathBoundary("", "x").ok).toBe(false);
  });
});
