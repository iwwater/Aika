/**
 * LLM-12 真实用量采集跑批 + LLM-10 推理模型 usage 真实轨（重建版 harness）。
 *
 * 背景：LLM-10 的真实平台 usage 验证 2026-09-12 已在 deepseek-chat 上完成
 * （REAL_TURN_VERIFICATION.md：reportedTotal PASS + curl 对照）；本 harness 把
 * 真实轨延伸到 deepseek-flash（推理模型），并用真实请求验证 LLM-12 采集链：
 * providerClient 物理尝试边界 → recorder → UsageLedgerStore → summarizeUsage（FE-26）。
 *
 * 轮次矩阵（全部真实请求）：
 * - T1~T4 foreground 问答：completed + coverage=reported + totalTokens>0；
 *   同时记录「可见回复长度 vs completionTokens」——推理模型的 reasoning token
 *   计入 completion，回复很短而 completion 很大即为证据。
 * - T5 maintenance：purpose 按调用方声明落账（采集不猜）。
 * - T6 取消：首包后 abort——DeepSeek 只在末包给 usage，取消轮应 coverage=unknown
 *   且不伪造数字（复现 REAL_TURN_VERIFICATION 在 deepseek-chat 上的发现）。
 * - T7 坏模型名：请求体级 4xx → providerClient 去掉 stream_options 重试一次 →
 *   两次物理尝试都 failed 落账（LLM-10-C 重试路径的真实演练；DeepSeek 本身
 *   接受 stream_options，因此「中转站 400 掉 stream_options」场景仍归 fixture 轨）。
 *
 * 默认不执行：仅 AIKA_REAL_LLM=1 时运行。本文件不保存 API Key。
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CompanionReply } from "../../domain/companion";
import { japanTimeLabel } from "../../domain/companion";
import type { ProviderConfig } from "../../domain/providers";
import { buildInstructions } from "../../domain/prompt";
import { computeRelationship } from "../../domain/relationship";
import { DEFAULT_CHARACTER_SOUL, DEFAULT_MODE_CONFIG } from "../../domain/soul";
import { summarizeUsage } from "../../domain/usageStats";
import type { UsageRecordV1 } from "../../domain/usageLedger";
import { streamChat, type ProviderRequestOptions } from "../providerClient";
import { createMemoryUsageLedger } from "./memoryUsageLedger";
import { createUsageLedgerRecorder } from "./usageRecorder";

const ENABLED = process.env.AIKA_REAL_LLM === "1";

function loadDotEnv(): void {
  try {
    const raw = readFileSync(new URL("../../../.env", import.meta.url), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const entry = line.trim();
      if (!entry || entry.startsWith("#")) continue;
      const eq = entry.indexOf("=");
      if (eq <= 0) continue;
      const key = entry.slice(0, eq).trim();
      const value = entry.slice(eq + 1).trim();
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // 凭证也可以只走环境变量。
  }
}

loadDotEnv();

function providerFromEnv(): ProviderConfig | null {
  const apiKey = process.env.AIKA_LLM_API_KEY;
  if (!apiKey) return null;
  return {
    id: process.env.AIKA_LLM_PROVIDER_ID ?? "env",
    name: "env",
    protocol: (process.env.AIKA_LLM_PROTOCOL as ProviderConfig["protocol"]) ?? "openai-compatible",
    baseUrl: process.env.AIKA_LLM_BASE_URL ?? "https://api.deepseek.com",
    model: process.env.AIKA_LLM_MODEL ?? "deepseek-flash",
    apiKey,
  };
}

const FOREGROUND_TURNS = [
  { id: "t1", q: "今天有点累，陪我说会儿话吧。" },
  { id: "t2", q: "最近想开始跑步，你觉得怎么坚持比较好？" },
  { id: "t3", q: "ランニングを始めたいんだけど、何かアドバイスある？" },
  { id: "t4", q: "Remind me to keep my runs short at first, okay?" },
];
const MAINTENANCE_TURN = {
  id: "m1",
  q: "把上面聊到的跑步习惯整理成一句话。",
};

const relationship = computeRelationship({ daysKnown: 14, consecutiveActiveDays: 7, totalMessageCount: 200 });
const NOW = Date.now();

function systemPrompt(): string {
  return buildInstructions(
    {
      recentTurns: [],
      memories: [],
      summary: null,
      relationship,
      currentTimeInJapan: japanTimeLabel(new Date(NOW)),
    },
    DEFAULT_CHARACTER_SOUL,
    [],
    DEFAULT_MODE_CONFIG,
  );
}

describe.skipIf(!ENABLED)("LLM-12 · 真实用量采集 + LLM-10 推理模型 usage 真实轨（deepseek-flash）", () => {
  it(
    "成功轮 coverage=reported、取消/失败轮不伪造数字、汇总可进 FE-26",
    { timeout: 900_000 },
    async () => {
      const provider = providerFromEnv();
      expect(provider, "缺少 AIKA_LLM_API_KEY 等真实 Provider 配置").not.toBeNull();
      const config = provider as ProviderConfig;

      const store = createMemoryUsageLedger();
      const recorder = createUsageLedgerRecorder({ store });

      const outcomes: Array<Record<string, unknown>> = [];

      const runTurn = async (
        turnId: string,
        question: string,
        purpose: "foreground" | "maintenance",
        hooks: { abortAfterPartial?: boolean } = {},
        modelOverride?: string,
      ): Promise<void> => {
        const entry: Record<string, unknown> = { turnId, purpose, model: modelOverride ?? config.model };
        const controller = new AbortController();
        let partials = 0;
        try {
          const base: ProviderRequestOptions = {
            requestPurpose: purpose,
            requestTurnId: turnId,
            ...(hooks.abortAfterPartial ? { signal: controller.signal } : {}),
          };
          const wired = recorder.observe({
            config: modelOverride ? { ...config, model: modelOverride } : config,
            purpose,
            turnId,
            options: base,
          });
          const reply: CompanionReply = await streamChat(
            modelOverride ? { ...config, model: modelOverride } : config,
            systemPrompt(),
            [{ role: "user", content: question }],
            () => {
              partials += 1;
              if (hooks.abortAfterPartial && partials >= 1) controller.abort();
            },
            [],
            wired,
          );
          const replyText = reply.replyText ?? reply.japaneseText;
          Object.assign(entry, {
            status: "ok",
            partials,
            replyTextLength: (replyText ?? "").length,
            replyTextPreview: (replyText ?? "").slice(0, 80),
          });
        } catch (error) {
          Object.assign(entry, {
            status: "error",
            partials,
            failure: error instanceof Error ? error.message : String(error),
          });
        }
        outcomes.push(entry);
      };

      // T1~T4 foreground
      for (const turn of FOREGROUND_TURNS) {
        await runTurn(turn.id, turn.q, "foreground");
      }
      // T5 maintenance
      await runTurn(MAINTENANCE_TURN.id, MAINTENANCE_TURN.q, "maintenance");
      // T6 首包后取消
      await runTurn("t6-cancel", "随便聊点什么吧。", "foreground", { abortAfterPartial: true });
      // T7 坏模型名（预期 400×2：原样 + 去 stream_options 重试）
      await runTurn("t7-badmodel", "hello", "foreground", {}, "deepseek-nonexistent-model");

      // 等 recorder 待写队列落盘（5 成功 + 1 取消 + 3 失败 = 9 条记录：
      // 坏模型名触发「流式→去 stream_options 流式→非流式」完整降级阶梯，各一次物理尝试）
      let rows: UsageRecordV1[] = [];
      for (let i = 0; i < 40; i += 1) {
        const page = await store.query();
        rows = (page as { records?: UsageRecordV1[] }).records ?? [];
        const hasUnfinished = rows.some((row) => row.status === "unfinished");
        if (rows.length >= 9 && !hasUnfinished) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }

      const diagnostics = recorder.diagnostics();
      const byTurn = new Map<string, UsageRecordV1[]>();
      for (const row of rows) {
        const key = row.turnId ?? "(none)";
        byTurn.set(key, [...(byTurn.get(key) ?? []), row]);
      }

      const summary = summarizeUsage(rows, { timeZone: "Asia/Shanghai" });

      // 断言集中到一个函数，证据落盘之后再跑——付费数据不能因断言失败丢失。
      const assertLedger = (): void => {
        // 成功轮 reported 且非 0；取消/失败轮 unknown 不伪造；诊断干净。
        for (const turn of [...FOREGROUND_TURNS.map((t) => t.id), MAINTENANCE_TURN.id]) {
          const records = byTurn.get(turn) ?? [];
          const terminal = records.find((row) => row.status === "completed");
          expect(terminal, `${turn} 应有 completed 终态记录`).toBeTruthy();
          expect(terminal?.coverage, `${turn} 平台应上报 usage`).toBe("reported");
          expect(terminal?.totalTokens ?? 0, `${turn} totalTokens 应 >0`).toBeGreaterThan(0);
          expect(terminal?.promptTokens ?? 0).toBeGreaterThan(0);
          expect(terminal?.completionTokens ?? 0).toBeGreaterThan(0);
          expect(terminal?.purpose, `${turn} purpose 应按调用方声明`).toBe(
            turn === MAINTENANCE_TURN.id ? "maintenance" : "foreground",
          );
        }
        const cancelRecords = byTurn.get("t6-cancel") ?? [];
        expect(cancelRecords.length).toBeGreaterThanOrEqual(1);
        expect(cancelRecords.some((row) => row.status === "cancelled"), "取消轮应落 cancelled 终态").toBe(true);
        for (const row of cancelRecords) {
          expect(row.coverage, "取消轮不得伪造 usage").toBe("unknown");
          expect(row.totalTokens).toBeNull();
        }
        const badModelRecords = byTurn.get("t7-badmodel") ?? [];
        expect(
          badModelRecords.map((row) => row.id).sort(),
          "坏模型名应走完整降级阶梯：流式→去 stream_options 流式→非流式回退，3 次物理尝试各有独立 attemptId",
        ).toHaveLength(3);
        expect(
          new Set(badModelRecords.map((row) => row.logicalRequestId)).size,
          "三次尝试属于同一逻辑请求",
        ).toBe(1);
        expect(badModelRecords.every((row) => row.status === "failed"), "三次尝试都应 failed").toBe(true);
        expect(badModelRecords.every((row) => row.coverage === "unknown"), "失败轮不得伪造 usage").toBe(true);
        expect(diagnostics.writeFailures, "台账写失败应为 0").toBe(0);
        expect(diagnostics.dropped, "台账丢弃应为 0").toBe(0);
      };

      // LLM-10 推理模型证据：completionTokens 相对可见回复长度显著偏大。
      const reasoningEvidence = outcomes
        .filter((entry) => entry.status === "ok" && typeof entry.replyTextLength === "number")
        .map((entry) => {
          const records = byTurn.get(entry.turnId as string) ?? [];
          const terminal = records.find((row) => row.status === "completed");
          return {
            turnId: entry.turnId,
            replyTextLength: entry.replyTextLength,
            completionTokens: terminal?.completionTokens ?? null,
            totalTokens: terminal?.totalTokens ?? null,
          };
        });

      let gitSha = "unknown";
      try {
        gitSha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
      } catch {
        // 非 git 环境不阻塞证据落盘。
      }

      const evidence = {
        spec: "LLM-12 + LLM-10(real extension)",
        evidenceKind: "real-usage-collection-rebuilt-harness",
        provider: { id: config.id, model: config.model, baseUrl: config.baseUrl },
        productionCodeVersion: gitSha,
        executionDate: new Date().toISOString().slice(0, 10),
        turnMatrix: "T1~T4 foreground / T5 maintenance / T6 cancel-after-first-partial / T7 bad-model(400 retry)",
        recorderDiagnostics: diagnostics,
        summarizeUsage: summary,
        reasoningEvidence,
        outcomes,
        notes: [
          "采集链全生产代码：providerClient 样本通道 → createUsageLedgerRecorder → memoryUsageLedger → summarizeUsage（FE-26 同一入口）。",
          "DeepSeek 接受 stream_options，因此「中转站 400 掉 stream_options」触发场景仍归 fixture 轨；本 harness 真实演练了「请求体级 4xx → 去 stream_options 重试 → 非流式回退」的完整降级阶梯（3 次物理尝试均 failed 落账）。",
          "取消轮 coverage=unknown 复现 REAL_TURN_VERIFICATION 在 deepseek-chat 上的发现：DeepSeek 只在末包给 usage，取消轮拿不到已烧掉的 token。",
          "费用未折算：deepseek-flash 价目由用户从控制台提供后再进价目表，汇总中金额如实显示未知（unpriced）。",
          "本文件不保存 API Key。",
        ],
        records: rows,
      };
      writeFileSync(
        new URL("../../../../docs/llm/reports/evidence/LLM_12_REAL_USAGE_DEEPSEEK_FLASH.json", import.meta.url),
        JSON.stringify(evidence, null, 2),
        "utf8",
      );

      assertLedger();
    },
  );
});
