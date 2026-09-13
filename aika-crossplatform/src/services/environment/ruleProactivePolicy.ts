import type { EnvironmentEvent } from "../../domain/environment";
import type {
  ProactiveDecision,
  ProactivePolicy,
  ProactivePolicyInput,
} from "./contracts";

/**
 * 生产 ProactivePolicy（FE-22）。
 *
 * 只回答「这个事件值不值得说」；「现在能不能说」由 canSend 终审（presenter）。
 * 纯函数：不写存储、不发请求、不起定时器、无隐藏计数——持续时长与窗口计数由
 * 显式输入提供（presenter 的 remember 环形缓冲聚合）。
 *
 * 阈值（2026-09-13/14 修订冻结，改动需同步 fixture 并记录理由）：
 * - game_event（结算类）：confidence ≥0.8 直接候选 trigger。
 * - 弱信号（foreground_changed / screen_keyword）：sustainedMs ≥30000 且
 *   60 秒窗口内出现 ≥2 次（两次相同事件是否累计由去重后的聚合结果决定——
 *   monitor 已丢掉去重窗口内的重复，这里看不到被丢弃的事件）。
 * - userBusy 未知（null）一律 ignore；busy=true 仅允许结算类候选。
 */

export const GAME_EVENT_CONFIDENCE_THRESHOLD = 0.8;
export const WEAK_SUSTAINED_MS = 30_000;
export const WEAK_OCCURRENCES_IN_WINDOW = 2;
export const WEAK_WINDOW_MS = 60_000;

/** 结算类游戏事件（PRD PRO-03：victory/defeat 为陪伴触发；pentakill 同类）。 */
const SETTLE_EVENTS = new Set(["victory", "defeat", "pentakill"]);

export type ProactiveDecisionReason =
  | "busy-unknown"
  | "busy-true-non-settle"
  | "confidence-below-threshold"
  | "kind-not-actionable"
  | "weak-signal-below-threshold"
  | `game-result:${string}`
  | `weak:${string}`;

export interface RuleProactivePolicyConfig {
  gameConfidenceThreshold?: number;
  weakSustainedMs?: number;
  weakOccurrencesInWindow?: number;
  weakWindowMs?: number;
}

export function createRuleProactivePolicy(
  config: RuleProactivePolicyConfig = {},
): ProactivePolicy {
  const gameThreshold = config.gameConfidenceThreshold ?? GAME_EVENT_CONFIDENCE_THRESHOLD;
  const weakSustainedMs = config.weakSustainedMs ?? WEAK_SUSTAINED_MS;
  const weakOccurrences = config.weakOccurrencesInWindow ?? WEAK_OCCURRENCES_IN_WINDOW;
  const weakWindowMs = config.weakWindowMs ?? WEAK_WINDOW_MS;

  return {
    evaluate(input: ProactivePolicyInput): ProactiveDecision {
      const { event, userBusy, sustainedMs, occurrencesInWindow } = input;
      if (userBusy === null) {
        return { action: "ignore", reason: "busy-unknown" };
      }
      const payload = event.payload;
      if (payload.kind === "game_event") {
        if (!SETTLE_EVENTS.has(payload.event)) {
          return { action: "ignore", reason: "kind-not-actionable" };
        }
        if (event.confidence < gameThreshold) {
          return { action: "ignore", reason: "confidence-below-threshold" };
        }
        if (userBusy === false) {
          // 可观测的非打扰状态：结算候选照常。
          return { action: "trigger", reason: `game-result:${payload.event}` };
        }
        // busy=true：仅允许这类结算候选（其余弱信号在下方被拦）。
        return { action: "trigger", reason: `game-result:${payload.event}` };
      }
      if (payload.kind === "foreground_changed" || payload.kind === "screen_keyword") {
        if (userBusy === true) {
          return { action: "ignore", reason: "busy-true-non-settle" };
        }
        const inWindow = sustainedMs <= weakWindowMs;
        if (sustainedMs >= weakSustainedMs && occurrencesInWindow >= weakOccurrences && inWindow) {
          return {
            action: "trigger",
            reason: `weak:${payload.kind === "foreground_changed" ? "long-session" : payload.kind}`,
          };
        }
        // 未达门槛先记住：弱信号要靠缓冲累计次数/时长。
        return { action: "remember", reason: "weak-signal-below-threshold" };
      }
      // notification / idle_changed：本版不可动作，只作背景。
      return { action: "ignore", reason: "kind-not-actionable" };
    },
  };
}

/** 供测试与诊断：从事件提取受控摘要键（kind + 词表 ID/进程名不外发，仅计数用）。 */
export function eventAggregationKey(event: EnvironmentEvent): string {
  const payload = event.payload;
  switch (payload.kind) {
    case "screen_keyword":
      return `screen_keyword:${payload.keyword}`;
    case "game_event":
      return `game_event:${payload.event}`;
    case "foreground_changed":
      return "foreground_changed";
    case "notification":
      return "notification";
    case "idle_changed":
      return "idle_changed";
  }
}
