/**
 * 后台写回。
 *
 * 抽取与落库不该挡在回复前面，所以它们排进队列、异步执行；
 * 但「异步」不等于「可以悄悄丢」——存储写失败要重试，重试次数用尽才放弃，
 * 并把最后一次错误交给调用方记录。
 *
 * 重试的是同一批候选：重复执行必须得到同样的结果，因此 upsert 前会先过
 * 去重与抑制标记，重放不会把删掉的记忆复活、也不会堆出重复条目。
 */

import { createMemoryV2, memoryTypeFromCategory, type MemoryCandidate, type MemoryRecordV2 } from "../../domain/memory";
import type { MemoryRepository } from "./memoryRepository";

export interface WritebackJob {
  /** 抽取出来的候选；已去重后可以带来源消息 id。 */
  candidates: readonly MemoryCandidate[];
  sourceMessageIds: readonly string[];
  now?: number;
}

export interface WritebackResult {
  attempted: number;
  written: number;
  failed: number;
  errors: string[];
}

export interface MemoryWritebackOptions {
  repository: MemoryRepository;
  maxAttempts?: number;
  onError?: (error: unknown, job: WritebackJob) => void;
}

export interface MemoryWriteback {
  enqueue(job: WritebackJob): void;
  flush(): Promise<WritebackResult>;
  pending(): number;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createMemoryWriteback(options: MemoryWritebackOptions): MemoryWriteback {
  const maxAttempts = options.maxAttempts ?? 3;
  const queue: Array<{ job: WritebackJob; attempts: number }> = [];
  let flushing = false;

  async function write(job: WritebackJob): Promise<number> {
    const now = job.now ?? Date.now();
    const records: MemoryRecordV2[] = [];
    for (const candidate of job.candidates) {
      const record = createMemoryV2({
        content: candidate.content,
        type: memoryTypeFromCategory(candidate.category),
        sourceMessageIds: job.sourceMessageIds,
        sourceKind: "messages",
        status: "candidate",
        now,
      });
      if (record) records.push(record);
    }
    if (!records.length) return 0;
    await options.repository.upsert(records);
    return records.length;
  }

  return {
    enqueue(job: WritebackJob): void {
      if (!job.candidates.length) return;
      queue.push({ job, attempts: 0 });
    },

    async flush(): Promise<WritebackResult> {
      if (flushing) return { attempted: 0, written: 0, failed: 0, errors: [] };
      flushing = true;
      const result: WritebackResult = { attempted: 0, written: 0, failed: 0, errors: [] };
      try {
        while (queue.length) {
          const item = queue.shift();
          if (!item) break;
          item.attempts += 1;
          result.attempted += 1;
          try {
            result.written += await write(item.job);
          } catch (error) {
            if (item.attempts < maxAttempts) {
              queue.push(item);
              // 同一批立刻再试通常还是失败，交给下一次 flush（下一轮对话）。
              break;
            }
            result.failed += 1;
            result.errors.push(messageOf(error));
            options.onError?.(error, item.job);
          }
        }
      } finally {
        flushing = false;
      }
      return result;
    },

    pending(): number {
      return queue.length;
    },
  };
}
