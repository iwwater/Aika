/**
 * 主动消息频率策略。
 * 直译自 Android `domain/ProactivePolicy.kt`，阈值与判定逻辑保持一致。
 *
 * 设计红线：这里只做“能不能发”，不做“该不该内疚”。
 * 任何基于用户沉默时长的加压逻辑都不属于这个文件。
 */

export const MAX_DAILY_MESSAGES = 6;
export const MIN_INTERVAL_MS = 90 * 60 * 1000;

export interface ProactiveWindow {
  /** 当前小时，0～23。 */
  hour: number;
  quietStartHour: number;
  quietEndHour: number;
}

export interface ProactiveGateInput extends ProactiveWindow {
  nowMillis: number;
  messagesToday: number;
  lastMessageAt: number | null;
  /** 用户可一键完全关闭主动消息。 */
  enabled?: boolean;
}

export function isQuietHour(hour: number, quietStartHour: number, quietEndHour: number): boolean {
  return quietStartHour < quietEndHour
    ? hour >= quietStartHour && hour < quietEndHour
    : hour >= quietStartHour || hour < quietEndHour;
}

export function canSend(input: ProactiveGateInput): boolean {
  if (input.enabled === false) return false;
  if (isQuietHour(input.hour, input.quietStartHour, input.quietEndHour)) return false;
  if (input.messagesToday >= MAX_DAILY_MESSAGES) return false;
  if (input.lastMessageAt !== null && input.nowMillis - input.lastMessageAt < MIN_INTERVAL_MS) return false;
  return true;
}
