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
