import type { Clock } from "../time/tokens";
import type { EnvironmentEventKind } from "../../domain/environment";
import type { EnvironmentMonitor } from "./contracts";

/**
 * 模型出口摘要 DTO（FE-18，2026-09-14 修订）。
 *
 * 只含受控字段：受控 process 名、持续时间、event kind / 词表 ID、置信度和年龄。
 * **禁止** title、OCR text、图像——DTO 的存在不代表可外发：摘要授权检查由
 * FE-19/22 消费时执行，这里只保证「就算被消费，也带不出原文」。
 *
 * 年龄一律相对 monitor 单调时钟计算；过期条目不进入摘要（由 monitor.recent 的
 * TTL 语义保证），墙钟回拨不影响任何结果。
 */

export interface EnvironmentForegroundSummary {
  process: string;
  /** 当前前台周期已持续的毫秒数（按 monitor 时钟现算）。 */
  durationMs: number;
}

export interface EnvironmentEventSummary {
  kind: EnvironmentEventKind;
  /** screen_keyword / game_event 的词表 ID；其他 kind 为 null。 */
  ruleId: string | null;
  /** foreground_changed 的受控进程名；其他 kind 为 null。 */
  process: string | null;
  confidence: number;
  /** 距接收时刻的毫秒数。 */
  ageMs: number;
}

export interface EnvironmentSummary {
  foreground: EnvironmentForegroundSummary | null;
  recent: readonly EnvironmentEventSummary[];
}

/**
 * 从 monitor 构建受控摘要。
 *
 * `monitor.snapshot.foreground` 非空即代表前台 source 仍运行且状态有效——
 * source 停止/出错时 monitor 已把快照清空，这里无需重复校验。
 */
export function buildEnvironmentSummary(
  monitor: EnvironmentMonitor,
  options: { clock: Clock },
): EnvironmentSummary {
  const now = options.clock.now();
  const foregroundState = monitor.snapshot.foreground;
  const recent = monitor.recent().map((entry) => ({
    kind: entry.kind,
    ruleId: entry.ruleId,
    process: entry.process,
    confidence: entry.confidence,
    ageMs: Math.max(0, now - entry.receivedMonotonicMs),
  }));
  return {
    foreground: foregroundState
      ? { process: foregroundState.process, durationMs: Math.max(0, now - foregroundState.since) }
      : null,
    recent,
  };
}
