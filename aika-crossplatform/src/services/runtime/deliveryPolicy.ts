/**
 * 跨渠道主动投递策略（RT-06）。
 *
 * 三条硬边界：
 * - **群组永不接私人提醒**；通知不可执行任务（只是文本）。
 * - **无回复不跨平台追发**：默认一个指定渠道，投递失败/无可用渠道 → 保留
 *   待投递/失败可见，绝不自动扩大收件人。
 * - quietHours 暂缓（过期丢弃并可见）；冷却 key 含 主体+事件类型+目标 且
 *   持久化——重启不清零频控。
 */

export type DeliveryUrgency = "normal" | "important";

export interface QuietHours {
  startHour: number;
  endHour: number;
  timeZone: string;
}

export interface DeliveryPolicyConfig {
  /** 默认指定渠道：主动消息只走它。 */
  defaultChannel: string;
  /** 同 主体+事件类型+目标 的冷却时长。 */
  cooldownMs: number;
  quietHours?: QuietHours;
}

export interface DeliveryCandidate {
  /** 目标会话（已验证私聊；群会话在策略层直接拒绝私人提醒）。 */
  conversationId: string;
  principalId: string;
  isGroup: boolean;
  eventType: string;
  urgency: DeliveryUrgency;
  /** 该目标是否已被用户授权接收主动消息。 */
  targetAuthorized: boolean;
}

export interface DeliveryDecision {
  action: "deliver" | "defer" | "drop" | "deduped";
  reason?: "unauthorized-target" | "group-private-reminder" | "quiet-hours" | "cooldown" | "duplicate";
  deferUntil?: number;
}

/** 判定是否在静默时段内（按 quietHours 时区的本地小时）。 */
export function isQuietHour(now: number, quiet: QuietHours): boolean {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: quiet.timeZone, hour: "numeric", hour12: false,
    });
    const hour = Number(formatter.format(new Date(now)).replace(/[^\d]/g, "")) % 24;
    if (quiet.startHour <= quiet.endHour) {
      return hour >= quiet.startHour && hour < quiet.endHour;
    }
    // 跨午夜（如 22→7）。
    return hour >= quiet.startHour || hour < quiet.endHour;
  } catch {
    // 无时区数据：按不静默处理，但冷却/授权仍然生效。
    return false;
  }
}

/** quietHours 何时结束（毫秒时间戳；按小时粗粒度推算）。 */
export function quietHoursEnd(now: number, quiet: QuietHours): number {
  let probe = now;
  for (let hour = 0; hour < 25; hour += 1) {
    probe += 3600_000;
    if (!isQuietHour(probe, quiet)) return probe;
  }
  return now + 24 * 3600_000;
}

export interface DeliveryPolicy {
  /**
   * 判定一条主动消息：deliver / defer（quietHours）/ drop（未授权/群私提醒）/
   * deduped（同完成事件重复到达）。
   */
  evaluate(candidate: DeliveryCandidate, now: number): DeliveryDecision;
  /** 记录「已投递」：写冷却 key（主体+事件类型+目标，持久化由调用方存储）。 */
  markDelivered(candidate: DeliveryCandidate, now: number): void;
  /** 同一完成事件多次到达只允许一项 outbox。 */
  registerOutboxItem(eventKey: string, now: number): boolean;
}

export interface PersistentDeliveryState {
  cooldowns: Record<string, number>;
  outboxEvents: Record<string, number>;
}

export function createDeliveryPolicy(
  config: DeliveryPolicyConfig,
  state: PersistentDeliveryState = { cooldowns: {}, outboxEvents: {} },
): DeliveryPolicy {
  function cooldownKey(candidate: DeliveryCandidate): string {
    return [candidate.principalId, candidate.eventType, candidate.conversationId]
      .map((part) => encodeURIComponent(part))
      .join(":");
  }

  return {
    evaluate(candidate, now) {
      // 群组永不接私人提醒（AGT-05/RT-06 边界）。
      if (candidate.isGroup) {
        return { action: "drop", reason: "group-private-reminder" };
      }
      // 目标必须曾被用户授权。
      if (!candidate.targetAuthorized) {
        return { action: "drop", reason: "unauthorized-target" };
      }
      // 同一完成事件多次到达只投一项：由 registerOutboxItem 在入队时判定，
      // 这里不混用冷却键。冷却。
      const last = state.cooldowns[cooldownKey(candidate)];
      if (last !== undefined && now - last < config.cooldownMs) {
        return { action: "defer", reason: "cooldown", deferUntil: last + config.cooldownMs };
      }
      // 静默时段：important 不绕过（审批请求不误算 urgency——审批走 RT-03，不走投递）。
      if (config.quietHours && isQuietHour(now, config.quietHours)) {
        const until = quietHoursEnd(now, config.quietHours);
        if (until - now > 24 * 3600_000) {
          // 静默窗口异常过长：丢弃并可见（过期时丢弃，不追发其他渠道）。
          return { action: "drop", reason: "quiet-hours" };
        }
        return { action: "defer", reason: "quiet-hours", deferUntil: until };
      }
      return { action: "deliver" };
    },

    markDelivered(candidate, now) {
      state.cooldowns[cooldownKey(candidate)] = now;
    },

    registerOutboxItem(eventKey, now) {
      if (state.outboxEvents[eventKey] !== undefined) return false;
      state.outboxEvents[eventKey] = now;
      return true;
    },
  };
}
