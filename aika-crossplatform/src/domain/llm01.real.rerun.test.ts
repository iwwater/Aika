/**
 * LLM-01 真实模型复测 runner（重建版）。
 *
 * 背景：原始 30 场景 REAL RUN 在 qwen-plus 上执行（证据 LLM_01_REAL_QWEN_SAMPLES.json），
 * 六条质量失败待修；原始运行器脚本未入库，本文件按证据 JSON 忠实重建：
 * 每条样本沿用原始 originalInput / modeConfig / history / allowedActionIds，
 * 走生产 buildInstructions + streamChat，不做任何记忆注入（LLM-01 是纯 Prompt/模式质量）。
 *
 * 默认不执行：仅 AIKA_REAL_LLM=1 时运行，避免日常测试与 CI 产生付费请求。
 * 断言只覆盖协议层（完整 ReplyEnvelope：replyText/translation/mood）；
 * 质量初筛只做规则标记并全部落进证据文件，最终质量结论需人工审阅输出，
 * 不把「协议 30/30」等同于质量通过。
 *
 * 与原始运行的口径差异（如实声明）：
 * 1. 运行器为重建版，非原始脚本；relationship 信号沿用 LLM-03-D 的单日近似。
 * 2. 模型由 qwen-plus 换为 deepseek-flash（推理模型，reasoning_content 不进正文）。
 * 3. 单条执行耗时未逐条采集，仅记录整轮。
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CompanionReply } from "./companion";
import { japanTimeLabel } from "./companion";
import type { ProviderConfig } from "./providers";
import { buildInstructions } from "./prompt";
import { computeRelationship, deriveRelationshipSignals } from "./relationship";
import { DEFAULT_CHARACTER_SOUL } from "./soul";
import type { Sticker } from "./stickers";
import type { ModeConfig } from "./soul";
import { streamChat } from "../services/providerClient";

const ENABLED = process.env.AIKA_REAL_LLM === "1";

function loadDotEnv(): void {
  try {
    const raw = readFileSync(new URL("../../.env", import.meta.url), "utf8");
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
    // 没有 .env 也能跑：凭证可以走环境变量。
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

interface OriginSample {
  id: string;
  mode: string;
  originalInput: string;
  modeConfig: Record<string, unknown>;
  history: unknown[];
  allowedActionIds: string[];
  inputRef: string;
}

interface EvidenceFile {
  spec: string;
  provider: { id: string; model: string; baseUrl: string };
  samples: Array<OriginSample & Record<string, unknown>>;
}

function loadOriginSamples(): EvidenceFile {
  return JSON.parse(
    readFileSync(
      new URL("../../../docs/llm/reports/evidence/LLM_01_REAL_QWEN_SAMPLES.json", import.meta.url),
      "utf8",
    ),
  ) as EvidenceFile;
}

/** 质量初筛：只标记，不下结论。模式对应原报告的六条失败类型。 */
const SELF_ACTION_WORDS = [
  "给自己倒", "倒了一杯", "倒了一", "注いだ", "淹れた", "コーヒーを入れた", "入れたて",
  "泡了茶", "泡好", "窗帘", "カーテン", "拉起袖", "袖子", "递咖啡", "コーヒーを渡し",
];
const PRONOUNCE_WORDS = ["发音", "発音", "pronunciation", "アウトプット"];
const PERSIST_WORDS = ["记下了", "记住了", "记在", "書き留め", "メモした", "覚えたよ", "もう覚え"];
const KANA = /[\u3040-\u309F\u30A0-\u30FF]/;

function screen(text: string): string[] {
  const flags: string[] = [];
  if (SELF_ACTION_WORDS.some((word) => text.includes(word))) flags.push("selfActionClaim");
  if (PRONOUNCE_WORDS.some((word) => text.includes(word))) flags.push("pronunciationPromise");
  if (PERSIST_WORDS.some((word) => text.includes(word))) flags.push("persistenceImplication");
  if (KANA.test(text)) flags.push("containsKana");
  return flags;
}

describe.skipIf(!ENABLED)("LLM-01 · 真实模型复测（deepseek-flash，重建 runner）", () => {
  it(
    "30 个场景协议层全部返回完整 ReplyEnvelope，质量初筛落证据",
    { timeout: 900_000 },
    async () => {
      const provider = providerFromEnv();
      expect(provider, "缺少 AIKA_LLM_API_KEY 等真实 Provider 配置").not.toBeNull();
      const config = provider as ProviderConfig;

      const origin = loadOriginSamples();
      expect(origin.samples).toHaveLength(30);

      const now = Date.now();
      const relationship = computeRelationship(
        deriveRelationshipSignals([now - 86_400_000, now], now),
      );

      const records: Array<Record<string, unknown>> = [];
      let protocolFailures = 0;

      // 并发 3：推理模型单条 10~30s，串行会拖过 15 分钟预算。
      const queue = origin.samples.map((sample, index) => ({ sample, index }));
      const results = new Map<number, Record<string, unknown>>();
      const worker = async (): Promise<void> => {
        for (;;) {
          const item = queue.shift();
          if (!item) return;
          const { sample } = item;
          const record: Record<string, unknown> = {
            id: sample.id,
            mode: sample.mode,
            inputRef: sample.inputRef,
            originalInput: sample.originalInput,
            modeConfig: sample.modeConfig,
            history: sample.history,
            allowedActionIds: sample.allowedActionIds,
          };
          // 原始证据只记录了贴纸 id；manifest 为空，file/when 用合成占位并在证据 notes 里声明。
          const stickers: Sticker[] = sample.allowedActionIds.map((id) => ({
            id,
            file: `${id}.webp`,
            when: `复测合成条目（原运行提供 ${id} 清单）：想眨眼卖萌的时候用`,
          }));
          const instructions = buildInstructions(
            {
              recentTurns: [],
              memories: [],
              summary: null,
              relationship,
              currentTimeInJapan: japanTimeLabel(new Date(now)),
            },
            DEFAULT_CHARACTER_SOUL,
            stickers,
            sample.modeConfig as unknown as ModeConfig,
          );
          try {
            let partials = 0;
            const reply: CompanionReply = await streamChat(
              config,
              instructions,
              [{ role: "user", content: sample.originalInput }],
              () => {
                partials += 1;
              },
              sample.allowedActionIds,
            );
            const replyText = reply.replyText ?? reply.japaneseText;
            const translation = reply.translation ?? reply.chineseTranslation;
            // 协议门禁：正文/翻译/语气三者齐才算完整 ReplyEnvelope。
            const protocolComplete = Boolean(replyText?.trim()) && Boolean(translation?.trim()) && Boolean(reply.mood);
            if (!protocolComplete) protocolFailures += 1;
            const screened = screen(`${replyText ?? ""}\n${translation ?? ""}`);
            Object.assign(record, {
              status: protocolComplete ? "pass" : "protocolFail",
              streamPartials: partials,
              mood: reply.mood,
              replyText,
              translation,
              sticker: reply.sticker ?? null,
              memoryCandidateCount: reply.memoryCandidates?.length ?? 0,
              actionCount: reply.actions?.length ?? 0,
              actions: reply.actions ?? [],
              qualityScreens: screened,
            });
          } catch (error) {
            protocolFailures += 1;
            Object.assign(record, {
              status: "error",
              failure: error instanceof Error ? error.message : String(error),
              qualityScreens: [],
            });
          }
          results.set(item.index, record);
        }
      };
      await Promise.all([worker(), worker(), worker()]);

      records.push(...[...results.keys()].sort((a, b) => a - b).map((index) => results.get(index) as Record<string, unknown>));

      let gitSha = "unknown";
      try {
        gitSha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
      } catch {
        // 非 git 环境不阻塞证据落盘。
      }

      const evidence = {
        spec: "LLM-01",
        evidenceKind: "real-model-rerun-rebuilt-runner",
        provider: { id: config.id, model: config.model, baseUrl: config.baseUrl },
        productionCodeVersion: gitSha,
        executionDate: new Date().toISOString().slice(0, 10),
        originEvidence: "LLM_01_REAL_QWEN_SAMPLES.json",
        protocolVerdict: protocolFailures === 0 ? "pass" : "fail",
        protocolReason:
          protocolFailures === 0
            ? `30/30 返回完整 replyText/translation/mood${origin.samples.some((s) => s.allowedActionIds.length) ? "（含贴纸清单样本）" : ""}`
            : `${protocolFailures} 条未返回完整 ReplyEnvelope`,
        qualityConclusion: "REVIEW REQUIRED：初筛只做规则标记，六条历史失败是否复现需人工审阅 records 全部输出",
        notes: [
          "运行器为按证据重建版（原脚本未入库）；relationship 用 LLM-03-D 的单日信号近似，now 为本轮运行时刻——非逐字节复刻原运行。",
          "模型由 qwen-plus 换为 deepseek-flash（推理模型；reasoning_content 不进正文，正文仍按 ReplyEnvelopeV1 解析）。",
          "每条样本沿用原始 originalInput/modeConfig/history/allowedActionIds；companion-10 继续提供 wink 贴纸清单。",
          "贴纸清单：原证据只记录 id；public/stickers/manifest.json 为空，file/when 为合成占位，不影响 LLM-01 文本协议与六条质量检查点。",
          "qualityScreens：selfActionClaim/pronunciationPromise/persistenceImplication/containsKana 只是规则初筛，误报漏报都可能，结论以人工审阅为准。",
          "本文件不保存 API Key。",
        ],
        records,
      };
      writeFileSync(
        new URL("../../../docs/llm/reports/evidence/LLM_01_REAL_DEEPSEEK_FLASH_SAMPLES.json", import.meta.url),
        JSON.stringify(evidence, null, 2),
        "utf8",
      );

      expect(protocolFailures, "存在协议失败样本，详见证据文件 records").toBe(0);
    },
  );
});
