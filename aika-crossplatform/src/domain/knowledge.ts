/**
 * Knowledge 领域层（LLM-05）：类型、切块、词法、BM25 与安全边界。
 *
 * 索引与查询**共用**同一套词法（analyzeQuery / tokenize），不假定空格分词：
 * 中文/日文按 CJK bigram + 拉丁词边界混合切分，英文按词边界。FTS5（trigram）
 * 只做候选召回，排序与打分一律走本文件的 BM25——两处分数才可比，阈值才有意义。
 */

import type { ModeId } from "./soul";
import type { RelationshipStage } from "./relationship";

export type KnowledgeType = "character" | "world" | "oral" | "scenario";
export type KnowledgeStage = RelationshipStage;

export interface KnowledgeDocument {
  id: string;
  sourcePath: string;
  contentHash: string;
  version: number;
  characterId: string;
  type: KnowledgeType;
  tags: string[];
  /** 该文档从哪个关系阶段起可见；stage 过滤发生在 Top-K 之前。 */
  unlockStage: KnowledgeStage;
  /** 允许出现的模式白名单；缺省由 type 推导（见 modesForDocument）。 */
  allowedModes?: readonly ModeId[];
}

export interface KnowledgeChunk {
  id: string;
  documentId: string;
  section: string;
  text: string;
  order: number;
}

export interface KnowledgeQuery {
  text: string;
  characterId: string;
  stage: KnowledgeStage;
  mode: ModeId;
  limit: number;
  tokenBudget: number;
}

export interface KnowledgeCitation {
  documentId: string;
  chunkId: string;
  version: number;
  sourcePath: string;
}

export interface KnowledgeHit {
  chunk: KnowledgeChunk;
  document: KnowledgeDocument;
  /** BM25 归一化到 (0,1]；只是排序依据，不是置信概率。 */
  normalizedScore: number;
  citation: KnowledgeCitation;
}

export interface KnowledgeRetrieval {
  hits: readonly KnowledgeHit[];
  /** FTS 不可用或查询异常时的显式降级原因；正常为 null。 */
  degraded: string | null;
}

export const KNOWLEDGE_TYPES: readonly KnowledgeType[] = ["character", "world", "oral", "scenario"];
export const KNOWLEDGE_STAGES: readonly KnowledgeStage[] = ["new", "familiar", "close"];

const STAGE_RANK: Record<KnowledgeStage, number> = { new: 0, familiar: 1, close: 2 };

/**
 * **冻结**的可靠性阈值：归一化 BM25 低于它的命中按「无可靠证据」丢弃。
 * 阈值在固定语料上预先冻结——它只回答「这算不算证据」，不是概率。
 */
export const KNOWLEDGE_MIN_SCORE = 0.18;

/** 导入安全上限：只处理明确选中的小文本资源。 */
export const KNOWLEDGE_IMPORT_LIMITS = {
  maxFiles: 50,
  maxFileChars: 400_000,
  maxChunkChars: 600,
  maxChunksPerDocument: 200,
} as const;

/** type 缺省的模式白名单；显式 allowedModes 优先。 */
export function modesForDocument(doc: Pick<KnowledgeDocument, "type" | "allowedModes">): readonly ModeId[] {
  if (doc.allowedModes && doc.allowedModes.length) return doc.allowedModes;
  switch (doc.type) {
    case "oral":
      return ["companion", "oral_practice"];
    case "scenario":
      return ["companion", "scenario_practice"];
    case "character":
    case "world":
      return ["companion", "oral_practice", "scenario_practice"];
  }
}

/** 当前关系阶段能否解锁该文档。 */
export function isStageUnlocked(docStage: KnowledgeStage, queryStage: KnowledgeStage): boolean {
  return STAGE_RANK[docStage] <= STAGE_RANK[queryStage];
}

/** 纯平假名串：多为功能词 bigram，单独命中不构成「可靠证据」。 */
export function isPureHiragana(token: string): boolean {
  return /^[぀-ゟ]+$/.test(token);
}

export function isKnowledgeType(value: unknown): value is KnowledgeType {
  return typeof value === "string" && (KNOWLEDGE_TYPES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// 词法：索引与查询共用
// ---------------------------------------------------------------------------

/** 拉丁词（含数字）；CJK 交给 bigram。 */
const LATIN_WORD = /[a-z0-9][a-z0-9'-]*/g;
const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g;

/** 归一化：NFKC + 小写。切块入索引与用户查询走同一条路。 */
export function normalizeKnowledgeText(text: string): string {
  return text.normalize("NFKC").toLowerCase();
}

/**
 * 英文功能词：不承载主题，进入倒排只会稀释 IDF、让「Does she have a cat」
 * 靠一个 she 蹭出命中。索引与查询共用同一张表（LLM-05 冻结）。
 */
const LATIN_STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "to", "of", "and", "or",
  "in", "on", "at", "for", "with", "she", "he", "it", "they", "we", "you", "i",
  "does", "do", "did", "what", "how", "when", "where", "why", "who", "her", "his", "their",
]);

/** 产出索引/查询共用的 token 集合：拉丁按词（去功能词），CJK 按二元组。 */
export function tokenize(text: string): string[] {
  const normalized = normalizeKnowledgeText(text);
  const tokens = new Set<string>();
  for (const word of normalized.matchAll(LATIN_WORD)) {
    if (word[0].length >= 2 && !LATIN_STOPWORDS.has(word[0])) tokens.add(word[0]);
  }
  for (const run of normalized.matchAll(CJK_RUN)) {
    const chars = [...run[0]];
    if (chars.length === 1) {
      tokens.add(run[0]);
      continue;
    }
    for (let index = 0; index + 1 < chars.length; index += 1) {
      tokens.add(chars[index] + chars[index + 1]);
    }
  }
  return [...tokens];
}

/**
 * FTS5 MATCH 表达式的安全构造：只保留 token 字符并逐个加引号，
 * 不让用户输入引出 `*`/`NEAR`/引号闭合等操作符；异常由调用方降级，
 * 绝不扩成全库命中。
 */
export function buildMatchExpression(tokens: readonly string[]): string {
  const safe = tokens
    .map((token) => token.replace(/[^a-z0-9\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, ""))
    .filter((token) => token.length >= 3)
    .slice(0, 24);
  if (!safe.length) return "";
  return safe.map((token) => `"${token}"`).join(" OR ");
}

// ---------------------------------------------------------------------------
// BM25（与 FTS 无关的统一打分）
// ---------------------------------------------------------------------------

const BM25_K1 = 1.2;
const BM25_B = 0.75;

interface ScoredDoc {
  id: string;
  counts: Map<string, number>;
  length: number;
}

/**
 * 经典 BM25：分数越高越相关。候选为空时由调用方决定是否全量打分
 * （本地知识库是小语料，全量打分就是 FTS 不可用时的降级路径）。
 */
export function bm25Scores(
  queryTokens: readonly string[],
  docs: readonly ScoredDoc[],
  averageLength: number,
): Map<string, number> {
  const scores = new Map<string, number>();
  if (!docs.length || !queryTokens.length || averageLength <= 0) return scores;
  const documentFrequency = new Map<string, number>();
  const uniqueQueryTokens = [...new Set(queryTokens)];
  for (const token of uniqueQueryTokens) {
    let count = 0;
    for (const doc of docs) {
      if (doc.counts.has(token)) count += 1;
    }
    if (count) documentFrequency.set(token, count);
  }
  const total = docs.length;
  for (const doc of docs) {
    let score = 0;
    for (const [token, df] of documentFrequency) {
      const tf = doc.counts.get(token);
      if (!tf) continue;
      const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));
      score += idf * (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * (doc.length / averageLength)));
    }
    if (score > 0) scores.set(doc.id, score);
  }
  return scores;
}

/** BM25 → (0,1]：`1 / (1 + 1/score)` 的饱和映射，分数只用于排序与阈值。 */
export function normalizeScore(score: number): number {
  if (score <= 0) return 0;
  return score / (score + 1);
}

// ---------------------------------------------------------------------------
// 切块
// ---------------------------------------------------------------------------

function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `k${(hash >>> 0).toString(16)}${text.length.toString(36)}`;
}

export function knowledgeContentHash(text: string): string {
  return hashText(normalizeKnowledgeText(text));
}

/** 相同内容哈希仅在同一文档身份下去重（权限/元数据变化仍会激活新版本）。 */
export function documentIdentityKey(doc: { sourcePath: string; characterId: string; type: KnowledgeType }): string {
  return `${doc.characterId}::${doc.type}::${doc.sourcePath}`;
}

/** 按空行分段；超长段按句读切，不把一句话腰斩。 */
function splitParagraphs(text: string, maxChars: number): string[] {
  const paragraphs = text.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const out: string[] = [];
  for (const paragraph of paragraphs) {
    if (paragraph.length <= maxChars) {
      out.push(paragraph);
      continue;
    }
    let current = "";
    for (const sentence of paragraph.split(/(?<=[。．\.！!？\?\n])/)) {
      if (current && current.length + sentence.length > maxChars) {
        out.push(current.trim());
        current = sentence;
      } else {
        current += sentence;
      }
    }
    if (current.trim()) out.push(current.trim());
  }
  return out;
}

export interface ParsedDocument {
  sourcePath: string;
  contentHash: string;
  sections: Array<{ section: string; text: string }>;
}

/** Markdown：标题分 section；无标题的长文本整体作为一个 section。 */
export function parseMarkdownDocument(sourcePath: string, raw: string): ParsedDocument {
  const lines = raw.split(/\r?\n/);
  const sections: Array<{ section: string; text: string }> = [];
  let currentTitle = "";
  let currentBody: string[] = [];
  function flush(): void {
    const text = currentBody.join("\n").trim();
    if (text) sections.push({ section: currentTitle || "(untitled)", text });
    currentBody = [];
  }
  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      currentTitle = heading[2].trim();
      continue;
    }
    currentBody.push(line);
  }
  flush();
  const normalized = normalizeKnowledgeText(raw);
  return { sourcePath, contentHash: hashText(normalized), sections };
}

/** JSON：`[{section,text}]`、`{sections:[…]}` 或 `{title,body}` 三种形状。 */
export function parseJsonDocument(sourcePath: string, raw: string): ParsedDocument {
  const parsed = JSON.parse(raw) as unknown;
  const entries: Array<{ section: string; text: string }> = [];
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      if (item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string") {
        const record = item as { section?: unknown; text: string };
        entries.push({
          section: typeof record.section === "string" ? record.section : "(entry)",
          text: record.text,
        });
      }
    }
  } else if (parsed && typeof parsed === "object") {
    const record = parsed as { sections?: unknown; title?: unknown; body?: unknown };
    if (Array.isArray(record.sections)) {
      for (const item of record.sections) {
        if (item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string") {
          const entry = item as { section?: unknown; text: string };
          entries.push({
            section: typeof entry.section === "string" ? entry.section : "(entry)",
            text: entry.text,
          });
        }
      }
    } else if (typeof record.body === "string") {
      entries.push({
        section: typeof record.title === "string" ? record.title : "(untitled)",
        text: record.body,
      });
    }
  }
  const text = entries.map((entry) => entry.text).join("\n\n");
  return { sourcePath, contentHash: hashText(normalizeKnowledgeText(text)), sections: entries };
}

/** 切块：section 内限定尺寸；order 在文档内单调递增。 */
export function chunkParsedDocument(
  parsed: ParsedDocument,
  documentId: string,
  maxChunkChars = KNOWLEDGE_IMPORT_LIMITS.maxChunkChars,
): KnowledgeChunk[] {
  const chunks: KnowledgeChunk[] = [];
  let order = 0;
  for (const section of parsed.sections) {
    for (const piece of splitParagraphs(section.text, maxChunkChars)) {
      chunks.push({
        id: `${documentId}#c${order}`,
        documentId,
        section: section.section,
        text: piece,
        order,
      });
      order += 1;
      if (order >= KNOWLEDGE_IMPORT_LIMITS.maxChunksPerDocument) return chunks;
    }
  }
  return chunks;
}
