/**
 * 记忆检索的排序与过滤。
 *
 * 纯函数、无 IO：给一批记录和一句话，返回有理由的命中列表。算法版本写死在
 * `RETRIEVAL_ALGORITHM_VERSION` 里——阈值和权重会调，但每次调整都必须连版本号
 * 一起改，否则「上次还排得出来这次排不出来」就没法追溯。
 *
 * 三语是硬要求：她的记忆里中日英混着写，问题也可能是任何一种。
 * CJK 没有空格，所以按「单字 + 相邻二字组」切；拉丁文按词切。
 */

import type { MemoryRecordV2, MemoryType } from "./memory";

export const RETRIEVAL_ALGORITHM_VERSION = "lexical-bm25-v1";

/** 分数构成：相关性为主，新近与重要度只做微调。 */
export const RETRIEVAL_WEIGHTS = { relevance: 0.7, recency: 0.2, importance: 0.1 } as const;

/** recency 的半衰期。90 天：三个月前的事还记得，但不该压过昨天的。 */
export const RECENCY_HALF_LIFE_MS = 90 * 24 * 60 * 60 * 1000;

const BM25_K1 = 1.2;
const BM25_B = 0.75;
/** 归一常数：把无上界的 BM25 压进 [0,1)。 */
const RELEVANCE_SATURATION = 1.4;

export type TemporalStatus = "current" | "past";

export interface MemoryHit {
  record: MemoryRecordV2;
  score: number;
  reasons: string[];
  temporalStatus: TemporalStatus;
}

export interface MemoryQuery {
  text: string;
  now: number;
  limit: number;
  tokenBudget: number;
}

/**
 * 停用词：只留能区分话题的词。
 *
 * 「喜欢」「好き」「like」也在里面，这不是笔误——它们几乎出现在每条偏好里，
 * 留着会让「你喜欢什么」把全部偏好等权捞出来，等于没检索。
 */
const STOP_WORDS = new Set([
  "我", "你", "他", "她", "它", "们", "的", "了", "吗", "呢", "吧", "是", "在", "有", "和", "与", "就",
  "也", "都", "很", "太", "不", "没", "这", "那", "什么", "怎么", "为什么", "喜欢", "爱", "想", "说",
  "請", "请", "一下", "可以", "能", "会",
  "私", "僕", "俺", "あなた", "君", "の", "に", "を", "は", "が", "で", "と", "も", "へ", "から",
  "です", "ます", "ある", "いる", "こと", "これ", "それ", "あれ", "好き", "思う", "言う",
  "the", "a", "an", "is", "are", "was", "were", "do", "does", "did", "i", "you", "he", "she", "it",
  "we", "they", "my", "your", "to", "of", "in", "on", "at", "for", "and", "or", "but", "like", "love",
]);

const CJK_PATTERN = new RegExp(
  "[\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff]",
);
const LATIN_PATTERN = /[a-z0-9]+/g;

/** 三语分词：CJK 出单字与相邻二字组，拉丁出小写词。 */
export function tokenize(text: string): string[] {
  const source = (text ?? "").toLowerCase();
  const tokens: string[] = [];

  let cjkRun = "";
  const flushCjk = () => {
    if (!cjkRun) return;
    for (let i = 0; i < cjkRun.length; i += 1) {
      tokens.push(cjkRun[i]);
      if (i + 1 < cjkRun.length) tokens.push(cjkRun.slice(i, i + 2));
    }
    cjkRun = "";
  };

  for (const char of source) {
    if (CJK_PATTERN.test(char)) {
      cjkRun += char;
      continue;
    }
    flushCjk();
  }
  flushCjk();

  for (const match of source.matchAll(LATIN_PATTERN)) tokens.push(match[0]);
  return tokens.filter((token) => token.length > 0 && !STOP_WORDS.has(token) && token.length < 32);
}

function documentFrequency(records: readonly MemoryRecordV2[], token: string): number {
  let count = 0;
  for (const record of records) {
    if (tokenize(record.content).includes(token)) count += 1;
  }
  return count;
}

/**
 * 无索引 BM25。
 *
 * 语料就是全部记忆，量级只有几百条，全量扫比维护倒排更省心；
 * 真到了需要 FTS5 的规模，SQLite 实现会接管 relevance，这里仍用作降级路径。
 */
function bm25(
  queryTokens: readonly string[],
  docTokens: readonly string[],
  inverseDocumentFrequency: ReadonlyMap<string, number>,
  averageLength: number,
): number {
  const termFrequency = new Map<string, number>();
  for (const token of docTokens) termFrequency.set(token, (termFrequency.get(token) ?? 0) + 1);

  let score = 0;
  for (const token of new Set(queryTokens)) {
    const tf = termFrequency.get(token) ?? 0;
    if (!tf) continue;
    const idf = inverseDocumentFrequency.get(token) ?? 0;
    const denominator = tf + BM25_K1 * (1 - BM25_B + BM25_B * (docTokens.length / Math.max(averageLength, 1)));
    score += idf * ((tf * (BM25_K1 + 1)) / denominator);
  }
  return score;
}

/** 归入 [0,1)：分数越高越接近 1，但永远到不了。 */
export function saturate(score: number): number {
  if (!Number.isFinite(score) || score <= 0) return 0;
  return score / (score + RELEVANCE_SATURATION);
}

/**
 * 事实时间：recency 只能用它，不能用 lastAccessedAt。
 *
 * 「刚被读到」不代表这条事实刚发生；用访问时间会让经常被捞出来的旧事
 * 越来越新，最后挤掉真正的新事。
 */
export function factTimeOf(record: MemoryRecordV2): number {
  return record.lastConfirmedAt ?? record.validFrom ?? record.createdAt;
}

export function recencyOf(record: MemoryRecordV2, now: number, halfLifeMs = RECENCY_HALF_LIFE_MS): number {
  const age = Math.max(0, now - factTimeOf(record));
  const value = Math.pow(0.5, age / halfLifeMs);
  return Math.min(Math.max(value, 0), 1);
}

/**
 * 是否还能作为当前事实。
 *
 * - superseded 一律排除：它已经被更新的那条取代。
 * - 过期的 event 允许返回，但标 past（「去年去了北海道」仍是真事，只是已过去）。
 * - 过期的其它类型直接排除：过期的偏好或目标不该再影响现在的她。
 * - 还没生效的（validFrom 在未来）不参与。
 */
export function isEligible(record: MemoryRecordV2, now: number): boolean {
  if (record.status === "superseded") return false;
  if (record.validFrom !== null && record.validFrom > now) return false;
  if (record.validUntil !== null && record.validUntil <= now) return record.type === "event";
  return true;
}

/**
 * 只有 event 会以 past 出现（过期的其它类型、以及尚未生效的记录
 * 都被 isEligible 挡掉了），所以这里只看 validUntil。
 */
export function temporalStatusOf(record: MemoryRecordV2, now: number): TemporalStatus {
  if (record.validUntil !== null && record.validUntil <= now) return "past";
  return "current";
}

export interface RankOptions {
  weights?: Partial<typeof RETRIEVAL_WEIGHTS>;
  halfLifeMs?: number;
  /** 供外部（如 SQLite FTS）提供相关性；缺省用内置词法打分。 */
  relevanceOf?: (record: MemoryRecordV2, queryTokens: readonly string[]) => number;
}

/**
 * 检索主入口。
 *
 * 没有共同词的记录相关性为 0，直接不返回——宁可空集，也不硬塞无关记忆。
 * 排序后先按条数再按 token 预算裁，保证送进提示词的部分不会把上下文撑爆。
 */
export function rankMemories(
  records: readonly MemoryRecordV2[],
  query: MemoryQuery,
  options: RankOptions = {},
): MemoryHit[] {
  const weights = { ...RETRIEVAL_WEIGHTS, ...options.weights };
  const queryTokens = tokenize(query.text);
  if (!queryTokens.length) return [];

  const pool = records.filter((record) => isEligible(record, query.now));
  if (!pool.length) return [];

  const inverseDocumentFrequency = new Map<string, number>();
  for (const token of new Set(queryTokens)) {
    const df = documentFrequency(pool, token);
    inverseDocumentFrequency.set(token, Math.log(1 + (pool.length - df + 0.5) / (df + 0.5)));
  }

  const tokenLists = new Map<string, string[]>();
  for (const record of pool) tokenLists.set(record.id, tokenize(record.content));
  const averageLength = pool.reduce((total, record) => total + (tokenLists.get(record.id)?.length ?? 0), 0)
    / Math.max(pool.length, 1);

  const hits: MemoryHit[] = [];
  // CJK 单字太泛（「海」能匹配「海边」也能匹配「北海道」），所以只要查询里
  // 有二字以上的词，就要求文档至少命中其中一个；否则整条不算相关。
  // 这条规则是 5 个无答案问题返回空集的直接依据。
  const multiCharTokens = queryTokens.filter((token) => token.length > 1);
  for (const record of pool) {
    const docTokens = tokenLists.get(record.id) ?? [];
    if (multiCharTokens.length && !multiCharTokens.some((token) => docTokens.includes(token))) continue;
    const raw = options.relevanceOf
      ? options.relevanceOf(record, queryTokens)
      : bm25(queryTokens, docTokens, inverseDocumentFrequency, averageLength);
    const relevance = saturate(raw);
    if (relevance <= 0) continue;

    const recency = recencyOf(record, query.now, options.halfLifeMs);
    const importance = Math.min(Math.max(record.importance, 0), 1);
    const score = weights.relevance * relevance + weights.recency * recency + weights.importance * importance;

    const reasons = [`相关度 ${relevance.toFixed(2)}`];
    if (recency >= 0.5) reasons.push(`新近 ${recency.toFixed(2)}`);
    if (importance >= 0.7) reasons.push(`重要度 ${importance.toFixed(2)}`);
    if (record.status === "confirmed") reasons.push("已确认");
    if (temporalStatusOf(record, query.now) === "past") reasons.push("已过期事件");

    hits.push({ record, score, reasons, temporalStatus: temporalStatusOf(record, query.now) });
  }

  hits.sort((left, right) => (
    right.score - left.score
    || right.record.updatedAt - left.record.updatedAt
    || left.record.id.localeCompare(right.record.id)
  ));

  const selected: MemoryHit[] = [];
  let used = 0;
  for (const hit of hits) {
    if (selected.length >= query.limit) break;
    const cost = estimateHitTokens(hit.record.content);
    if (used + cost > query.tokenBudget) continue;
    used += cost;
    selected.push(hit);
  }
  return selected;
}

function estimateHitTokens(content: string): number {
  let tokens = 0;
  let latin = 0;
  for (const char of content) {
    if (CJK_PATTERN.test(char)) {
      if (latin) {
        tokens += Math.ceil(latin / 3);
        latin = 0;
      }
      tokens += 1;
      continue;
    }
    latin += 1;
  }
  if (latin) tokens += Math.ceil(latin / 3);
  return tokens;
}

/** 记忆类型到提示词里的中文标签，保持与写入时的口径一致。 */
export const MEMORY_TYPE_LABELS: Record<MemoryType, string> = {
  fact: "事实",
  preference: "偏好",
  event: "事件",
  goal: "计划",
  relationship: "人际",
};
