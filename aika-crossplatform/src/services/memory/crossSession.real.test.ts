/**
 * LLM-03-D 真实模型跨会话样本。
 *
 * 默认 **不执行**：只有显式设置 `AIKA_REAL_LLM=1` 且能解析出真实 Provider
 * 配置时才跑，避免日常测试与 CI 产生付费请求。
 *
 * Provider 配置解析顺序：
 * 1. 环境变量 `AIKA_LLM_API_KEY`（可选 `AIKA_LLM_BASE_URL` / `AIKA_LLM_MODEL` /
 *    `AIKA_LLM_PROTOCOL`）—— CI 或临时验证用。
 * 2. 标准安全存储：`%APPDATA%\com.aika.companion\aika.db`（不含 Key）+
 *    `secrets.json`（DPAPI 密文）。解密交给 PowerShell 的 ProtectedData，
 *    明文只在进程内存里，不落盘、不进日志、不进证据文件。
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { CompanionReply } from "../../domain/companion";
import { formatRetrievedSections, type AgentContext } from "../../domain/context";
import { buildInstructions } from "../../domain/prompt";
import type { ProviderConfig } from "../../domain/providers";
import { computeRelationship, deriveRelationshipSignals } from "../../domain/relationship";
import { DEFAULT_CHARACTER_SOUL, DEFAULT_MODE_CONFIG } from "../../domain/soul";
import type { MemoryRecordV2 } from "../../domain/memory";
import { streamChat } from "../providerClient";
import { createInMemoryMemoryStore } from "./memoryStore";
import { createMemoryRepository } from "./memoryRepository";
import { createMemorySource } from "./memorySource";
import { createContextAssembler } from "../context/contextAssembler";

const ENABLED = process.env.AIKA_REAL_LLM === "1";

/**
 * 读取本地 `.env`（gitignore 内），只补缺，不覆盖已有环境变量。
 * 不引入 dotenv 依赖：键值就几行，手写解析足够。
 */
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
    // 没有 .env 也能跑：凭证可以走环境变量或标准安全存储。
  }
}

loadDotEnv();

const fixture = JSON.parse(
  readFileSync(new URL("../../../../docs/llm/reports/evidence/LLM_03_RETRIEVAL_FIXTURE.json", import.meta.url), "utf8"),
) as { now: number; memories: MemoryRecordV2[] };

const NOW = fixture.now;

/** 每个样本给多语言关键词：人设是日语环境，引用中文记忆时模型可能换语言表述。 */
const SAMPLES: Array<{ id: string; query: string; keywords: string[] }> = [
  { id: "r01", query: "我平时喝咖啡的口味来着", keywords: ["浅烘焙", "浅煎り", "浅焙煎", "浅烘"] },
  { id: "r02", query: "私のお菓子の好みは甘いのと塩気どっちだったっけ", keywords: ["塩気"] },
  { id: "r03", query: "which chocolate do I prefer", keywords: ["dark chocolate", "ダーク"] },
  { id: "r04", query: "我的工作是什么来着", keywords: ["前端", "フロント", "React"] },
  { id: "r05", query: "私は朝何時に起きるんだっけ", keywords: ["7時", "七時"] },
  { id: "r06", query: "which days do I work remotely again", keywords: ["Monday", "Friday", "月曜", "金曜"] },
  { id: "r07", query: "上个周末我去了哪里来着", keywords: ["镰仓", "鎌倉"] },
  { id: "r08", query: "先月どこに出張したっけ", keywords: ["京都"] },
  { id: "r09", query: "我养的橘猫叫什么名字", keywords: ["豆豆"] },
  { id: "r10", query: "am I allergic to anything", keywords: ["peanut", "ピーナッツ", "花生"] },
];

/** 模型声称「记得」时的措辞。用来识别「没有依据却说自己记得」。 */
const CLAIM_WORDS = ["记得", "之前说过", "你提过", "你说过", "覚えて", "前に言った", "remember"];

/** 诚实的「我不记得」不是伪造：它在明确承认没有依据，而不是编一个来源。 */
const DENIAL_WORDS = [
  "没提过", "没说过", "不记得", "没听", "还没", "不知道", "没说过",
  "教えてもらってない", "聞いてない", "覚えてない", "わからない", "知らない",
  "not sure", "don't remember", "haven't told", "never told",
];

interface ResolvedProvider {
  config: ProviderConfig;
  source: "env" | "secure-storage";
}

function providerFromEnv(): ProviderConfig | null {
  const apiKey = process.env.AIKA_LLM_API_KEY;
  if (!apiKey) return null;
  return {
    id: process.env.AIKA_LLM_PROVIDER_ID ?? "env",
    name: "env",
    protocol: (process.env.AIKA_LLM_PROTOCOL as ProviderConfig["protocol"]) ?? "openai-compatible",
    baseUrl: process.env.AIKA_LLM_BASE_URL ?? "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: process.env.AIKA_LLM_MODEL ?? "qwen-plus",
    apiKey,
  };
}

function providerFromSecureStorage(): ProviderConfig | null {
  const dir = `${process.env.APPDATA ?? ""}\\com.aika.companion`;
  const dbPath = `${dir}\\aika.db`;
  const secretsPath = `${dir}\\secrets.json`;
  if (!existsSync(dbPath) || !existsSync(secretsPath)) return null;

  const db = new DatabaseSync(dbPath);
  const rows = db.prepare("SELECT value FROM settings WHERE key = 'provider'").all() as Array<{ value: string }>;
  const raw = rows[0]?.value;
  if (!raw) return null;
  const saved = JSON.parse(raw) as Omit<ProviderConfig, "apiKey">;

  const name = `provider.${saved.id}.apiKey`;
  const script = [
    "Add-Type -AssemblyName System.Security",
    `$json = Get-Content -Raw -LiteralPath '${secretsPath}' | ConvertFrom-Json`,
    `$encoded = $json.'${name}'`,
    "if (-not $encoded) { exit 3 }",
    "$cipher = [Convert]::FromBase64String($encoded)",
    "$plain = [System.Security.Cryptography.ProtectedData]::Unprotect($cipher, $null, 'CurrentUser')",
    "[Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))",
  ].join("; ");
  const apiKey = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
  }).trim();
  if (!apiKey) return null;
  return { ...saved, apiKey };
}

/**
 * 回复是否「有依据」：注入内容里任意 4 字滑窗出现在回复中即算。
 * 只查前缀会漏掉「模型只引用了句子后半段」的正常情况。
 */
function isGrounded(text: string, content: string): boolean {
  const source = content.trim();
  if (!source) return false;
  const window = Math.min(4, source.length);
  if (text.includes(source.slice(0, window))) return true;
  for (let index = 0; index + window <= source.length; index += 1) {
    if (text.includes(source.slice(index, index + window))) return true;
  }
  return false;
}

function resolveProvider(): ResolvedProvider | null {
  const fromEnv = providerFromEnv();
  if (fromEnv) return { config: fromEnv, source: "env" };
  const fromStorage = providerFromSecureStorage();
  return fromStorage ? { config: fromStorage, source: "secure-storage" } : null;
}

describe.skipIf(!ENABLED)("LLM-03-D · 真实模型跨会话样本", () => {
  it("10 个样本里至少 8 个正确引用记忆事实，且没有凭空声称记得", async () => {
    const resolved = resolveProvider();
    expect(resolved, "没有可用的真实 Provider 配置（环境变量或标准安全存储）").not.toBeNull();
    const provider = (resolved as ResolvedProvider).config;

    const store = createInMemoryMemoryStore({
      initial: { records: fixture.memories, suppressions: [], migrationVersion: 1 },
    });
    const repository = createMemoryRepository({ store, clock: () => NOW });
    const assembler = createContextAssembler({ sources: [createMemorySource(repository)] });

    const records: Array<Record<string, unknown>> = [];
    let hitCount = 0;
    const fabrications: string[] = [];
    const claimWithoutEvidence: string[] = [];
    const honestDenials: string[] = [];

    for (const sample of SAMPLES) {
      const assembled = await assembler.assemble({
        query: sample.query,
        now: NOW,
        timeZone: "Asia/Shanghai",
        characterSoul: DEFAULT_CHARACTER_SOUL,
        relationship: computeRelationship(deriveRelationshipSignals([NOW - 86_400_000, NOW], NOW)),
        mode: DEFAULT_MODE_CONFIG,
        history: [],
      });

      const context: AgentContext = assembled.context;
      const retrieved = formatRetrievedSections(context);
      const instructions = [
        buildInstructions(
          {
            recentTurns: context.recentConversation,
            memories: context.memories.map((item) => (
              item.category ? `${item.category}：${item.content}` : item.content
            )),
            summary: null,
            relationship: context.relationship,
            currentTimeInJapan: context.clock.japanTimeLabel,
          },
          DEFAULT_CHARACTER_SOUL,
          [],
          DEFAULT_MODE_CONFIG,
        ),
        retrieved,
      ].filter((block) => block.trim()).join("\n\n");

      let reply: CompanionReply;
      let failure: string | null = null;
      try {
        reply = await streamChat(
          provider,
          instructions,
          [{ role: "user", content: sample.query }],
          () => undefined,
          [],
        );
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
        records.push({ sampleId: sample.id, query: sample.query, injected: retrieved, failure });
        continue;
      }

      const text = `${reply.replyText ?? reply.japaneseText}\n${reply.translation ?? reply.chineseTranslation}`;
      const matched = sample.keywords.filter((keyword) => text.toLowerCase().includes(keyword.toLowerCase()));
      if (matched.length) hitCount += 1;

      // 「凭空记得」：说了断言词，却没有任何注入事实的片段出现在回复里，
      // 同时也不是在诚实地说「我不记得」——那是在承认没有依据，不算编造来源。
      const claims = CLAIM_WORDS.some((word) => text.includes(word));
      const denied = DENIAL_WORDS.some((word) => text.includes(word));
      const injectedSnippets = context.memories.map((item) => item.content);
      // 关键词本身就是从注入事实提炼的：模型用别的语言转述注入事实时，
      // 原文滑窗匹配不到，但关键词命中同样说明它引用的是真实依据。
      const groundedInInjected = injectedSnippets.length === 0
        ? false
        : injectedSnippets.some((content) => isGrounded(text, content)) || matched.length > 0;
      if (claims && !groundedInInjected && !denied) {
        claimWithoutEvidence.push(sample.id);
        fabrications.push(sample.id);
      }
      if (claims && denied) honestDenials.push(sample.id);

      records.push({
        sampleId: sample.id,
        query: sample.query,
        injected: retrieved,
        injectedEntries: context.memories.map((item) => ({
          content: item.content, precision: item.precision, temporal: item.temporal,
        })),
        expectedKeywords: sample.keywords,
        matchedKeywords: matched,
        replyText: reply.replyText ?? reply.japaneseText,
        translation: reply.translation ?? reply.chineseTranslation,
        mood: reply.mood,
      });
    }

    const evidence = {
      spec: "LLM-03",
      kind: "real-model-cross-session",
      provider: { protocol: provider.protocol, model: provider.model, source: (resolved as ResolvedProvider).source },
      mode: DEFAULT_MODE_CONFIG.mode,
      outputKind: "real",
      generatedAt: new Date().toISOString(),
      totals: {
        samples: SAMPLES.length,
        hits: hitCount,
        failures: records.filter((record) => record.failure).length,
        claimWithoutEvidence: claimWithoutEvidence.length,
        honestDenials: honestDenials.length,
      },
      notes: [
        "注入内容与关键词均为 fixture；回复由真实模型产生。",
        "命中判定按关键词跨语言匹配（人设是日语环境，引用中文记忆时表述可能换语言）。",
        "claimWithoutEvidence/honestDenials 只做规则筛查，不等于完整质量结论，需人工审阅。",
        "honestDenials 是模型明确说「我不记得」的情况：它没有编造来源，不算伪造。",
      ],
      honestDenials,
      records,
    };
    writeFileSync(
      new URL("../../../../docs/llm/reports/evidence/LLM_03_REAL_CROSS_SESSION.json", import.meta.url),
      `${JSON.stringify(evidence, null, 2)}\n`,
      "utf8",
    );

    expect(hitCount).toBeGreaterThanOrEqual(8);
    expect(fabrications).toEqual([]);
  }, 600_000);
});
