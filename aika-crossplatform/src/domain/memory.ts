/**
 * 长期记忆。
 * 直译自 Android `data/local/MemoryEntity.kt`，同时作为 M1 里 SQLite `memories` 表的结构来源。
 *
 * 记忆必须用户可见、可删：这里只保留最小字段，抽取与确认流程在 services/memory/。
 */

export const MEMORY_CATEGORIES = ["日常", "偏好", "计划", "人际", "情绪"] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export const DEFAULT_MEMORY_CATEGORY: MemoryCategory = "日常";

export interface MemoryRecord {
  id: string;
  category: MemoryCategory;
  content: string;
  createdAt: number;
  updatedAt: number;
}

/** 尚未经用户确认的抽取结果。确认后才写入 memories 表。 */
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
  now: number = Date.now(),
): MemoryRecord | null {
  const cleanContent = content.trim();
  if (!cleanContent) return null;
  return {
    id: crypto.randomUUID(),
    category: isMemoryCategory(category) ? category : DEFAULT_MEMORY_CATEGORY,
    content: cleanContent,
    createdAt: now,
    updatedAt: now,
  };
}

export function memoryLines(memories: readonly MemoryRecord[], limit = 12): string[] {
  return memories.slice(-limit).map((memory) => `${memory.category}：${memory.content}`);
}
