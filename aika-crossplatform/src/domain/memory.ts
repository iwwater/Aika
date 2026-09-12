/**
 * 长期记忆。
 * 直译自 Android `data/local/MemoryEntity.kt`，并按 M1 增加了「候选 / 已确认」状态。
 *
 * 记忆必须用户可见、可删。抽取出来的候选会立刻参与对话——否则用户不打开记忆页就等于没有记忆，
 * 拿不到「她记得」这个验收；但候选会明确标记，用户可以在记忆页保留或删除。
 */

export const MEMORY_CATEGORIES = ["日常", "偏好", "计划", "人际", "情绪"] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export const DEFAULT_MEMORY_CATEGORY: MemoryCategory = "日常";

/** pending：自动抽取、尚未经用户过目。confirmed：用户明确保留。 */
export type MemoryStatus = "pending" | "confirmed";

export interface MemoryRecord {
  id: string;
  category: MemoryCategory;
  content: string;
  status: MemoryStatus;
  createdAt: number;
  updatedAt: number;
}

/** 模型抽取出来、尚未落库的一条。 */
export interface MemoryCandidate {
  category: MemoryCategory;
  content: string;
}

export function isMemoryCategory(value: unknown): value is MemoryCategory {
  return typeof value === "string" && (MEMORY_CATEGORIES as readonly string[]).includes(value);
}

/** 创建一条记忆。内容为空时返回 null，与 Android `MemoryRepository.save` 的行为一致。 */
export function createMemory(
  content: string,
  category: MemoryCategory = DEFAULT_MEMORY_CATEGORY,
  status: MemoryStatus = "pending",
  now: number = Date.now(),
): MemoryRecord | null {
  const cleanContent = content.trim();
  if (!cleanContent) return null;
  return {
    id: crypto.randomUUID(),
    category: isMemoryCategory(category) ? category : DEFAULT_MEMORY_CATEGORY,
    content: cleanContent,
    status,
    createdAt: now,
    updatedAt: now,
  };
}

/** 注入提示词的记忆行。最近的优先，超出上限的丢掉而不是截断内容。 */
export function memoryLines(memories: readonly MemoryRecord[], limit = 12): string[] {
  return memories.slice(-limit).map((memory) => `${memory.category}：${memory.content}`);
}

/**
 * 判断两条记忆是否重复。
 * 抽取每轮都跑，不去重会很快堆出十条「喜欢咖啡」。
 */
export function isDuplicateMemory(content: string, existing: readonly MemoryRecord[]): boolean {
  const normalized = normalizeForCompare(content);
  if (!normalized) return true;
  return existing.some((memory) => normalizeForCompare(memory.content) === normalized);
}

function normalizeForCompare(content: string): string {
  return content.trim().toLowerCase().replace(/[\s，。、,.!！?？~～]/g, "");
}

/* -------------------------------------------------------------------------- */
/* LLM-03：Memory V2                                                           */
/* -------------------------------------------------------------------------- */

export const MEMORY_TYPES = ["fact", "preference", "event", "goal", "relationship"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export const MEMORY_STATUS_V2 = ["candidate", "confirmed", "superseded"] as const;
export type MemoryStatusV2 = (typeof MEMORY_STATUS_V2)[number];

/**
 * 来源与信任分级（RT-04）。
 *
 * - messages：本地用户自己的对话（可信自述，仍只能当候选、由人确认）。
 * - external-bound：已绑定外部主体的 DM——**只认证了发件人**，不证明正文里的
 *   引文/文件/Agent 结果是其本人事实。
 * - untrusted-material：群消息、转贴第三方内容、OCR/文件、Agent 输出——
 *   不可信资料，永不自动提升，也不归入本地用户画像。
 * - legacy：迁移旧记录，按原有口径兼容。
 */
export type MemorySourceKind = "messages" | "external-bound" | "untrusted-material" | "legacy" | "userEdit";

export const MEMORY_SOURCE_KINDS: readonly MemorySourceKind[] = [
  "messages", "external-bound", "untrusted-material", "legacy", "userEdit",
];

export function isMemorySourceKind(value: unknown): value is MemorySourceKind {
  return typeof value === "string" && (MEMORY_SOURCE_KINDS as readonly string[]).includes(value);
}

/**
 * 模型生成的候选一律不能自行提升为 confirmed（RT-04-A）：
 * 提升只能走人（userEdit / 管理页确认），这与 sourceKind 无关。
 */
export function mayElevateToConfirmed(byModel: boolean): boolean {
  return !byModel;
}

/**
 * 谁能进本地用户的 User Soul 画像（RT-04）。
 * 明确归属 + 经人确认：本地对话/旧数据/用户手写且状态 confirmed；
 * external-bound 与 untrusted-material 即使被人确认也**不归入本地画像**
 * （归属无法核实，保守默认），它们只作为会话内事实存在。
 */
export function mayFeedUserSoul(sourceKind: MemorySourceKind, status: MemoryStatusV2): boolean {
  if (status !== "confirmed") return false;
  return sourceKind === "messages" || sourceKind === "legacy" || sourceKind === "userEdit";
}

/**
 * 由提交来源推导候选的信任分级（RT-04）。
 * 来源字符串本身不授予权限——分组/Agent/引文/unknown 一律按不可信资料处理。
 */
export function sourceKindForOrigin(
  origin: string,
  options: { bound: boolean; isGroupConversation?: boolean; isAgentOutput?: boolean; isQuotedMaterial?: boolean } = { bound: true },
): MemorySourceKind {
  if (options.isAgentOutput || options.isQuotedMaterial || options.isGroupConversation) {
    return "untrusted-material";
  }
  if (origin === "desktop") return "messages";
  if (origin === "telegram" || origin === "feishu" || origin === "qq" || origin === "mobile") {
    return options.bound ? "external-bound" : "untrusted-material";
  }
  // environment/proactive/unknown：来源不明不自动提升。
  return "untrusted-material";
}

/**
 * 带来源的记忆。
 *
 * V1 只有「内容与状态」，回答不了三个后来一定会问的问题：这句话从哪来、
 * 还能不能当真、什么时候过期。V2 把这三件事都写成字段，并且**不伪造来源**——
 * 迁移来的旧记录 `sourceMessageIds` 一律为空，宁可来源不明，也不能编一个。
 */
export interface MemoryRecordV2 {
  schemaVersion: 2;
  id: string;
  type: MemoryType;
  content: string;
  sourceMessageIds: string[];
  sourceKind: MemorySourceKind;
  status: MemoryStatusV2;
  /** [0,1]；null 表示未知，未知不能当高置信度用。 */
  confidence: number | null;
  /** [0,1]；旧数据没有这个字段，默认 0.5。 */
  importance: number;
  createdAt: number;
  updatedAt: number;
  lastConfirmedAt: number | null;
  /** 只是「被读到」，不代表这条事实变新，也不代表它被确认。 */
  lastAccessedAt: number | null;
  validFrom: number | null;
  validUntil: number | null;
  supersedesId?: string;
}

/** 旧 category → 新 type。映射固定下来，迁移重跑才不会漂。 */
const CATEGORY_TO_TYPE: Record<MemoryCategory, MemoryType> = {
  日常: "event",
  偏好: "preference",
  计划: "goal",
  人际: "relationship",
  情绪: "fact",
};

/** 抽取候选的 category 走同一张映射表，避免两处各写一份。 */
export function memoryTypeFromCategory(category: unknown): MemoryType {
  return typeof category === "string" && isMemoryCategory(category)
    ? CATEGORY_TO_TYPE[category]
    : "fact";
}

/** 反向映射：V2 读出来给只认 category 的既有界面用。 */
const TYPE_TO_CATEGORY: Record<MemoryType, MemoryCategory> = {
  preference: "偏好",
  goal: "计划",
  relationship: "人际",
  event: "日常",
  fact: "日常",
};

export function memoryCategoryFromType(type: unknown): MemoryCategory {
  return isMemoryType(type) ? TYPE_TO_CATEGORY[type] : DEFAULT_MEMORY_CATEGORY;
}

/**
 * V2 → V1 视图。
 *
 * 界面与旧提示词路径只认 MemoryRecord；这里只做形状转换，
 * 不把 V2 才有的字段（来源、有效期）凭空补出来。
 */
export function toLegacyMemoryRecord(record: MemoryRecordV2): MemoryRecord {
  return {
    id: record.id,
    category: memoryCategoryFromType(record.type),
    content: record.content,
    status: record.status === "confirmed" ? "confirmed" : "pending",
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function isMemoryType(value: unknown): value is MemoryType {
  return typeof value === "string" && (MEMORY_TYPES as readonly string[]).includes(value);
}

export function isMemoryStatusV2(value: unknown): value is MemoryStatusV2 {
  return typeof value === "string" && (MEMORY_STATUS_V2 as readonly string[]).includes(value);
}

function clamp01(value: number, fallback = 0.5): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, 0), 1);
}

/**
 * V1 → V2。
 *
 * 幂等：同一条旧记录重复迁移得到同一结果（id、时间戳、内容都不变），
 * 因此可以在启动时反复执行。缺的来源不会补，重要性用默认值 0.5。
 */
export function migrateMemoryRecord(record: MemoryRecord): MemoryRecordV2 {
  const status: MemoryStatusV2 = record.status === "confirmed" ? "confirmed" : "candidate";
  return {
    schemaVersion: 2,
    id: record.id,
    type: CATEGORY_TO_TYPE[record.category] ?? "fact",
    content: record.content,
    sourceMessageIds: [],
    sourceKind: "legacy",
    status,
    confidence: null,
    importance: 0.5,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastConfirmedAt: status === "confirmed" ? record.updatedAt : null,
    lastAccessedAt: null,
    validFrom: null,
    validUntil: null,
  };
}

export interface CreateMemoryV2Input {
  content: string;
  type?: MemoryType;
  sourceMessageIds?: readonly string[];
  sourceKind?: MemorySourceKind;
  status?: MemoryStatusV2;
  confidence?: number | null;
  importance?: number;
  now?: number;
  id?: string;
  validFrom?: number | null;
  validUntil?: number | null;
  supersedesId?: string;
}

function newId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `mem-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** 建一条 V2 记忆。正文为空时返回 null，与 V1 的 createMemory 行为一致。 */
export function createMemoryV2(input: CreateMemoryV2Input): MemoryRecordV2 | null {
  const content = input.content.trim();
  if (!content) return null;
  const now = input.now ?? Date.now();
  return {
    schemaVersion: 2,
    id: input.id ?? newId(),
    type: isMemoryType(input.type) ? input.type : "fact",
    content,
    sourceMessageIds: [...new Set((input.sourceMessageIds ?? []).filter((id) => typeof id === "string" && id))],
    sourceKind: input.sourceKind ?? "messages",
    status: isMemoryStatusV2(input.status) ? input.status : "candidate",
    confidence: input.confidence === null || input.confidence === undefined ? null : clamp01(input.confidence, 0.5),
    importance: clamp01(input.importance ?? 0.5),
    createdAt: now,
    updatedAt: now,
    lastConfirmedAt: input.status === "confirmed" ? now : null,
    lastAccessedAt: null,
    validFrom: input.validFrom ?? null,
    validUntil: input.validUntil ?? null,
    ...(input.supersedesId ? { supersedesId: input.supersedesId } : {}),
  };
}

/** 内容指纹：删除后只留它做抑制标记，正文一个字都不留。 */
export function memoryContentHash(content: string): string {
  const normalized = normalizeForCompare(content);
  let hash = 5381;
  for (let index = 0; index < normalized.length; index += 1) {
    hash = ((hash << 5) + hash + normalized.charCodeAt(index)) | 0;
  }
  return `h${(hash >>> 0).toString(16)}`;
}

/** 判断两条记忆是否重复，沿用 V1 的去重口径。 */
export function isDuplicateMemoryV2(content: string, existing: readonly MemoryRecordV2[]): boolean {
  const normalized = normalizeForCompare(content);
  if (!normalized) return true;
  return existing.some((record) => normalizeForCompare(record.content) === normalized);
}

/** 解析抽取模型返回的候选列表，格式错误时返回空数组而不是抛错。 */
export function parseMemoryCandidates(modelText: string): MemoryCandidate[] {
  const trimmed = (modelText ?? "")
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start < 0 || end <= start) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  return parsed.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const content = typeof record.content === "string" ? record.content.trim() : "";
    if (!content) return [];
    const category = isMemoryCategory(record.category) ? record.category : DEFAULT_MEMORY_CATEGORY;
    return [{ category, content }];
  });
}
