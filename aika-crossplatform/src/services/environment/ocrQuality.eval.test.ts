import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createOcrEngine } from "./ocrText";
import { matchKeywords } from "./keywordRules";

/**
 * FE-21-F 冻结识别质量验收。
 *
 * 独立验收集 120 张（60 正例：每词 12；60 负例：游戏/视频/IDE 各 20），全部为
 * 自制合成画面（来源与 sha256 见 manifest.json）。**该集合不用于调参**——调参
 * 只允许用 dev/ 30 张；评估跑生产 OCR（createOcrEngine）+ 生产词表规则。
 *
 * 门槛（SPEC 冻结）：事件级精确率 TP/(TP+FP) ≥ 95%、召回率 TP/(TP+FN) ≥ 85%；
 * 分母为零不得记 100%，按 FAIL 处理。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures");
const VALIDATION_DIR = join(FIXTURES, "validation");

const EXPECTED_RULE_ID: Record<string, string> = {
  VICTORY: "victory",
  DEFEAT: "defeat",
  PENTAKILL: "pentakill",
  Error: "error",
  Failed: "failed",
};

interface ManifestImage {
  kind: string;
  scene: string;
  rendered: string;
  expected: string | null;
  sha256: string;
}

interface EvalRecord {
  image: string;
  scene: string;
  expected: string | null;
  detected: string[];
  truePositive: boolean;
  falsePositive: boolean;
  falseNegative: boolean;
  elapsedMs: number;
}

describe("FE-21-F 冻结验收集评估（120 张，生产 OCR + 生产规则）", () => {
  it(
    "精确率 ≥95%、召回率 ≥85%，逐词/逐场景结果落盘",
    { timeout: 900_000 },
    async () => {
      const manifestPath = join(FIXTURES, "manifest.json");
      expect(existsSync(manifestPath), "fixtures/manifest.json 不存在：先运行 scripts/generate-ocr-fixtures.py").toBe(true);
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { images: Record<string, ManifestImage> };
      const validationImages = Object.entries(manifest.images)
        .filter(([path]) => path.startsWith("validation/"))
        .map(([path, meta]) => ({ path, meta }));
      expect(validationImages).toHaveLength(120);
      expect(validationImages.filter((entry) => entry.meta.expected !== null)).toHaveLength(60);
      expect(validationImages.filter((entry) => entry.meta.expected === null)).toHaveLength(60);

      const engine = createOcrEngine({ langPath: FIXTURES });
      const records: EvalRecord[] = [];
      try {
        for (const { path, meta } of validationImages) {
          const startedAt = Date.now();
          const png = readFileSync(join(FIXTURES, path)).toString("base64");
          const result = await engine.recognize(png);
          const elapsedMs = Date.now() - startedAt;
          const detected = result
            ? matchKeywords(result.text, new Map(result.words.map((word) => [word.word, word.confidence])))
              .map((match) => match.ruleId)
            : [];
          const expectedRuleId = meta.expected ? EXPECTED_RULE_ID[meta.expected] : null;
          const truePositive = expectedRuleId !== null && detected.includes(expectedRuleId);
          const falsePositive = detected.some((ruleId) => ruleId !== expectedRuleId);
          const falseNegative = expectedRuleId !== null && !detected.includes(expectedRuleId);
          records.push({
            image: path,
            scene: meta.scene,
            expected: meta.expected,
            detected,
            truePositive,
            falsePositive,
            falseNegative,
            elapsedMs,
          });
        }
      } finally {
        await engine.dispose();
      }

      const tp = records.filter((record) => record.truePositive).length;
      const fp = records.filter((record) => record.falsePositive).length;
      const fn = records.filter((record) => record.falseNegative).length;
      const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
      const recall = tp + fn === 0 ? 0 : tp / (tp + fn);

      const perWord: Record<string, { tp: number; fn: number }> = {};
      const perScene: Record<string, { tp: number; fp: number; fn: number }> = {};
      for (const record of records) {
        perWord[record.expected ?? "none"] ??= { tp: 0, fn: 0 };
        if (record.truePositive) perWord[record.expected ?? "none"].tp += 1;
        if (record.falseNegative) perWord[record.expected ?? "none"].fn += 1;
        perScene[record.scene] ??= { tp: 0, fp: 0, fn: 0 };
        if (record.truePositive) perScene[record.scene].tp += 1;
        if (record.falsePositive) perScene[record.scene].fp += 1;
        if (record.falseNegative) perScene[record.scene].fn += 1;
      }

      // 热启动单次 P95 ≤ 2000ms（FE-21-I 性能门槛）。
      const positives = records.filter((record) => record.truePositive || record.falseNegative || record.falsePositive);
      const elapsedSorted = positives.map((record) => record.elapsedMs).sort((a, b) => a - b);
      const p95 = elapsedSorted.length ? elapsedSorted[Math.min(elapsedSorted.length - 1, Math.floor(elapsedSorted.length * 0.95))] : 0;

      const report = {
        frozenSet: "fixtures/validation (120 images; synthetic-selfmade)",
        counts: { tp, fp, fn, total: records.length },
        precision,
        recall,
        precisionGate: 0.95,
        recallGate: 0.85,
        hotOcrP95Ms: p95,
        hotOcrP95GateMs: 2000,
        perWord,
        perScene,
        generatedAt: new Date().toISOString(),
      };
      const resultsDir = join(FIXTURES, "..");
      mkdirSync(resultsDir, { recursive: true });
      writeFileSync(join(FIXTURES, "eval-results.json"), JSON.stringify(report, null, 2));

      // 汇总信息留在断言消息里，失败时可直接对照 eval-results.json。
      expect(
        { precision, recall, tp, fp, fn, perWord, perScene, hotOcrP95Ms: p95 },
        `冻结集质量门槛未达标，详见 src/services/environment/fixtures/eval-results.json`,
      ).toEqual(
        expect.objectContaining({
          precision: expect.any(Number),
          recall: expect.any(Number),
        }),
      );
      expect(precision).toBeGreaterThanOrEqual(0.95);
      expect(recall).toBeGreaterThanOrEqual(0.85);
      expect(p95).toBeLessThanOrEqual(2000);
      // 分母为零时上面两个比例已是 0，不可能虚记 100%。
      expect(relative(HERE, VALIDATION_DIR)).toContain("validation");
    },
  );
});
