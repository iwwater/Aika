import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectLines } from "./ocrText";

/**
 * OCR 结果解析与离线资源登记。
 *
 * 第一组是回归用例：真实 `eng+chi_sim` 识别结果里，同一批行在 `data.lines`、
 * `data.paragraphs[].lines`、`data.blocks[].paragraphs[].lines` 三处各出现一次。
 * 早先的实现三处都收，每行被数三遍——摘录预算被复读吃掉，模型还会看到重复内容。
 * 这里用实测到的结构形状锁住修复。
 *
 * 第二组核对随包 traineddata 的版本与哈希（FE-32 要求资源可追溯）。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures");
const PUBLIC_TESSDATA = join(HERE, "..", "..", "..", "public", "tessdata");

/** 登记表：上游 tessdata_fast 4.1.0，Apache-2.0。见 THIRD_PARTY_NOTICES.md。 */
const TRAINEDDATA_SHA256: Record<string, string> = {
  "eng.traineddata": "7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2",
  "chi_sim.traineddata": "a5fcb6f0db1e1d6d8522f39db4e848f05984669172e584e8d76b6b3141e1f730",
};

/** 实测形状：两行文本，扁平与嵌套三处指向同一批行。 */
function realWorldShape() {
  const lines = [
    { text: "今天 的 天 气 很 好\n", confidence: 94.26, words: [{ text: "今天", confidence: 94 }] },
    { text: "我 们 去 公园 散步 吧\n", confidence: 93.65, words: [{ text: "我们", confidence: 93 }] },
  ];
  const paragraphs = [{ lines }];
  return { blocks: [{ paragraphs }], paragraphs, lines, words: lines.flatMap((line) => line.words) };
}

describe("collectLines 去重（真实 tesseract 结构）", () => {
  it("扁平与嵌套指向同一批行时，每行只收一次", () => {
    const collected = collectLines(realWorldShape());
    expect(collected.map((line) => line.text)).toEqual(["今天 的 天 气 很 好", "我 们 去 公园 散步 吧"]);
    expect(collected[0].confidence).toBeCloseTo(0.9426, 4);
  });

  it("只有嵌套结构（没有扁平 lines）时仍按阅读顺序取到行", () => {
    const nested = {
      blocks: [
        { paragraphs: [{ lines: [{ text: "first", confidence: 90 }] }] },
        { paragraphs: [{ lines: [{ text: "second", confidence: 80 }] }] },
      ],
    };
    expect(collectLines(nested).map((line) => line.text)).toEqual(["first", "second"]);
  });

  it("置信度归一化到 0..1；缺失或非有限值按 0（不冒充高置信）", () => {
    const collected = collectLines({
      lines: [
        { text: "a", confidence: 120 },
        { text: "b", confidence: -5 },
        { text: "c" },
        { text: "d", confidence: Number.NaN },
      ],
    });
    expect(collected.map((line) => line.confidence)).toEqual([1, 0, 0, 0]);
  });

  it("结构不符或空文本安全降级，不猜、不编", () => {
    expect(collectLines(null)).toEqual([]);
    expect(collectLines("text")).toEqual([]);
    expect(collectLines({ lines: "nope" })).toEqual([]);
    expect(collectLines({ lines: [{ text: "   ", confidence: 99 }] })).toEqual([]);
  });
});

describe("离线 traineddata 资源登记（FE-32-F 前置）", () => {
  it("eng 与 chi_sim 在测试 fixtures 与随包 public/tessdata 下都在位，且哈希与登记一致", () => {
    for (const [name, expected] of Object.entries(TRAINEDDATA_SHA256)) {
      for (const dir of [FIXTURES, PUBLIC_TESSDATA]) {
        const path = join(dir, name);
        expect(existsSync(path), `${path} 不存在`).toBe(true);
        expect(createHash("sha256").update(readFileSync(path)).digest("hex"), `${path} 哈希不符`).toBe(expected);
      }
    }
  });
});
